import { useCallback, useEffect, useRef } from 'react';
import { createAudioSegmentPlayer, type AudioSegmentPlayer } from './audio-segment-player';
import {
  voiceOutputArbiter,
  type VoiceOutputArbiter,
  type VoiceOutputLease,
} from './voice-output-arbiter';

const SYNTHESIS_PATH = '/api/voice/synthesize';
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const MAX_PROMPT_CHARS = 256;

export type PromptPlaybackSocket = {
  readyState: number;
  binaryType: BinaryType;
  send(data: string): void;
  close(): void;
  onopen: ((event: { data?: unknown }) => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onerror: ((event: { data?: unknown }) => void) | null;
  onclose: ((event: { data?: unknown }) => void) | null;
};

export type PromptPlaybackDependencies = {
  socket?: PromptPlaybackSocket;
  player?: AudioSegmentPlayer;
  createWebSocket?: (url: string) => PromptPlaybackSocket;
  createPlayer?: () => AudioSegmentPlayer;
  arbiter?: VoiceOutputArbiter;
};

export type AssistantPromptId = 'wake' | 'analysis-started';
export type AssistantPromptOptions = { question?: string };
export type AssistantPromptPlayback = {
  play(prompt: AssistantPromptId, options?: AssistantPromptOptions): Promise<void>;
  stop(): Promise<void>;
};

type PromptSession = {
  socket: PromptPlaybackSocket;
  player: AudioSegmentPlayer;
  lease: VoiceOutputLease;
  closed: boolean;
  sent: boolean;
  ready: boolean;
  activeIndex: number | null;
  nextIndex: number;
  total: number;
  serverCompleted: boolean;
  completedSegments: number;
  chunks: Uint8Array[];
  stoppedUnsubscribe: () => void;
  resolve: () => void;
  reject: (error: Error) => void;
};

function defaultDependencies(): Required<Pick<PromptPlaybackDependencies, 'createWebSocket' | 'createPlayer'>> {
  return {
    createWebSocket: (url) => new WebSocket(url) as unknown as PromptPlaybackSocket,
    createPlayer: createAudioSegmentPlayer,
  };
}

function synthesisUrl(): string {
  const url = new URL(SYNTHESIS_PATH, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function cleanQuestion(question: string): string {
  return question.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_PROMPT_CHARS);
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

function parseMessage(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function joinChunks(chunks: readonly Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return joined.buffer;
}

export function useAssistantPromptPlayback(options: { dependencies?: PromptPlaybackDependencies } = {}): AssistantPromptPlayback {
  const dependenciesRef = useRef<PromptPlaybackDependencies>({ ...defaultDependencies(), ...options.dependencies });
  const sessionRef = useRef<PromptSession | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const arbiterRef = useRef(options.dependencies?.arbiter ?? voiceOutputArbiter);

  const release = useCallback(async (session: PromptSession, sendCancel: boolean) => {
    if (session.closed) return;
    session.closed = true;
    session.stoppedUnsubscribe();
    session.socket.onopen = null;
    session.socket.onmessage = null;
    session.socket.onerror = null;
    session.socket.onclose = null;
    if (sendCancel && session.socket.readyState === SOCKET_OPEN) {
      try { session.socket.send(JSON.stringify({ type: 'cancel' })); } catch { /* best effort */ }
    }
    if (session.socket.readyState !== SOCKET_CLOSED) {
      try { session.socket.close(); } catch { /* best effort */ }
    }
    try { await session.player.stop(); } catch { /* best effort */ }
    if (sessionRef.current === session) sessionRef.current = null;
    session.lease.release();
  }, []);

  const stop = useCallback(async () => {
    generationRef.current += 1;
    const session = sessionRef.current;
    if (session) {
      await release(session, true);
      session.resolve();
    }
  }, [release]);

  const play = useCallback(async (prompt: AssistantPromptId, promptOptions: AssistantPromptOptions = {}) => {
    const generation = ++generationRef.current;
    const lease = await arbiterRef.current.acquire('prompt', async () => {
      const active = sessionRef.current;
      if (active) {
        await release(active, true);
        active.resolve();
      }
    });
    if (!lease || !lease.isCurrent() || !mountedRef.current || generation !== generationRef.current) {
      lease?.release();
      return;
    }
    const dependencies = dependenciesRef.current;
    const socket = options.dependencies?.socket ?? dependencies.createWebSocket!(synthesisUrl());
    const player = options.dependencies?.player ?? dependencies.createPlayer!();
    const request = prompt === 'analysis-started'
      ? { type: 'prompt', prompt, question: cleanQuestion(promptOptions.question ?? '') }
      : { type: 'prompt', prompt };

    await new Promise<void>((resolve, reject) => {
      const session: PromptSession = {
        socket, player, lease, closed: false, sent: false, ready: false, activeIndex: null,
        nextIndex: 0, total: 0, serverCompleted: false, completedSegments: 0, chunks: [],
        stoppedUnsubscribe: () => undefined, resolve, reject,
      };
      sessionRef.current = session;
      const finishIfReady = () => {
        if (!session.closed && session.serverCompleted && session.total > 0
          && session.completedSegments === session.total) {
          void release(session, false).then(resolve).catch(reject);
        }
      };
      session.stoppedUnsubscribe = player.onSegmentEnded(() => {
        if (session.closed) return;
        session.completedSegments = Math.min(session.total, session.completedSegments + 1);
        finishIfReady();
      });
      const fail = (message: string) => {
        if (session.closed) return;
        const error = new Error(message);
        void release(session, true).then(() => reject(error)).catch(() => reject(error));
      };
      const send = () => {
        if (session.closed || session.sent || socket.readyState !== SOCKET_OPEN) return;
        session.sent = true;
        try { socket.send(JSON.stringify(request)); } catch { fail('VOICE_UPSTREAM_UNAVAILABLE'); }
      };
      socket.binaryType = 'arraybuffer';
      socket.onopen = send;
      socket.onerror = () => fail('VOICE_UPSTREAM_UNAVAILABLE');
      socket.onclose = () => { if (!session.closed && !session.serverCompleted) fail('VOICE_UPSTREAM_UNAVAILABLE'); };
      socket.onmessage = (event) => {
        if (session.closed) return;
        const bytes = toBytes(event.data);
        if (bytes) {
          if (session.activeIndex === null) { fail('VOICE_INVALID_AUDIO'); return; }
          session.chunks.push(bytes.slice());
          return;
        }
        const message = parseMessage(event.data);
        if (!message) { fail('VOICE_INVALID_AUDIO'); return; }
        if (message.type === 'error') { fail(typeof message.code === 'string' ? message.code : 'VOICE_UPSTREAM_UNAVAILABLE'); return; }
        if (message.type === 'ready' && Number.isSafeInteger(message.segmentCount)) {
          session.ready = true;
          session.total = Number(message.segmentCount);
          return;
        }
        if (message.type === 'segment-start' && session.ready && session.activeIndex === null) {
          session.activeIndex = Number(message.index);
          session.chunks = [];
          return;
        }
        if (message.type === 'segment-end' && session.activeIndex === Number(message.index)) {
          const bytesToPlay = joinChunks(session.chunks);
          session.activeIndex = null;
          session.chunks = [];
          session.nextIndex += 1;
          void player.enqueue(bytesToPlay).catch(() => fail('VOICE_INVALID_AUDIO'));
          return;
        }
        if (message.type === 'completed' && session.ready && session.activeIndex === null) {
          session.serverCompleted = true;
          finishIfReady();
        }
      };
      if (socket.readyState === SOCKET_OPEN) send();
    });
  }, [options.dependencies, release]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      if (session) void release(session, true).catch(() => undefined);
    };
  }, [release]);

  return { play, stop };
}
