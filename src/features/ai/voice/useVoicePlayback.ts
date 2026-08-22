import { useCallback, useEffect, useRef, useState } from 'react';
import {
  VOICE_MAX_AUDIO_SEGMENT_BYTES,
  VOICE_MAX_AUDIO_TOTAL_BYTES,
  VOICE_MAX_SYNTHESIS_SEGMENTS,
  VOICE_ERROR_CODES,
  type SynthesisServerMessage,
  type VoiceErrorCode,
} from '../../../../shared/voice';
import { createAudioSegmentPlayer, type AudioSegmentPlayer } from './audio-segment-player';

const SYNTHESIS_PATH = '/api/voice/synthesize';
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

export const MAX_SYNTHESIS_SEGMENTS = VOICE_MAX_SYNTHESIS_SEGMENTS;
export const MAX_AUDIO_SEGMENT_BYTES = VOICE_MAX_AUDIO_SEGMENT_BYTES;
export const MAX_AUDIO_TOTAL_BYTES = VOICE_MAX_AUDIO_TOTAL_BYTES;

type VoiceSocketEvent = { data?: unknown };

export type VoicePlaybackSocket = {
  readyState: number;
  binaryType: BinaryType;
  send(data: string): void;
  close(): void;
  onopen: ((event: VoiceSocketEvent) => void) | null;
  onmessage: ((event: VoiceSocketEvent) => void) | null;
  onerror: ((event: VoiceSocketEvent) => void) | null;
  onclose: ((event: VoiceSocketEvent) => void) | null;
};

export type VoicePlaybackStatus = 'idle' | 'preparing' | 'speaking' | 'paused' | 'error';

export type VoicePlaybackProgress = {
  completed: number;
  total: number;
};

export type VoicePlaybackDependencies = {
  socket?: VoicePlaybackSocket;
  player?: AudioSegmentPlayer;
  createWebSocket?: (url: string) => VoicePlaybackSocket;
  createPlayer?: () => AudioSegmentPlayer;
};

export type UseVoicePlaybackOptions = {
  dependencies?: VoicePlaybackDependencies;
};

export type VoicePlaybackResult = {
  status: VoicePlaybackStatus;
  progress: VoicePlaybackProgress;
  errorCode: VoiceErrorCode | null;
  play(reportId: string, speechId: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
};

type PlaybackSession = {
  socket: VoicePlaybackSocket;
  player: AudioSegmentPlayer;
  unsubscribe: () => void;
  activeIndex: number | null;
  chunks: Uint8Array[];
  segmentBytes: number;
  totalBytes: number;
  completed: number;
  total: number;
  nextIndex: number;
  requestSent: boolean;
  ready: boolean;
  serverCompleted: boolean;
  intentionallyClosed: boolean;
  closed: boolean;
  userPaused: boolean;
};

function defaultDependencies(): Required<Pick<VoicePlaybackDependencies, 'createWebSocket' | 'createPlayer'>> {
  return {
    createWebSocket: (url) => new WebSocket(url) as unknown as VoicePlaybackSocket,
    createPlayer: createAudioSegmentPlayer,
  };
}

function synthesisUrl(): string {
  const url = new URL(SYNTHESIS_PATH, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function isVoiceErrorCode(value: unknown): value is VoiceErrorCode {
  return typeof value === 'string' && (VOICE_ERROR_CODES as readonly string[]).includes(value);
}

function parseControlMessage(data: unknown): SynthesisServerMessage | undefined {
  if (typeof data !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.type === 'ready') {
    return Number.isSafeInteger(message.segmentCount) && Number(message.segmentCount) > 0
      && Number(message.segmentCount) <= MAX_SYNTHESIS_SEGMENTS
      ? { type: 'ready', segmentCount: Number(message.segmentCount) }
      : undefined;
  }
  if (message.type === 'segment-start' || message.type === 'segment-end') {
    return Number.isSafeInteger(message.index) && Number(message.index) >= 0
      ? { type: message.type, index: Number(message.index) }
      : undefined;
  }
  if (message.type === 'completed') return { type: 'completed' };
  if (message.type === 'error' && isVoiceErrorCode(message.code) && typeof message.message === 'string') {
    return { type: 'error', code: message.code, message: message.message };
  }
  return undefined;
}

function binaryChunk(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

function joinChunks(chunks: readonly Uint8Array[], byteLength: number): ArrayBuffer {
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

export function useVoicePlayback(options: UseVoicePlaybackOptions = {}): VoicePlaybackResult {
  const dependenciesRef = useRef<VoicePlaybackDependencies>({
    ...defaultDependencies(),
    ...options.dependencies,
  });
  const oneShotSocketRef = useRef(options.dependencies?.socket);
  const oneShotPlayerRef = useRef(options.dependencies?.player);
  const mountedRef = useRef(true);
  const sessionRef = useRef<PlaybackSession | null>(null);
  const playGenerationRef = useRef(0);
  const [status, setStatus] = useState<VoicePlaybackStatus>('idle');
  const [progress, setProgress] = useState<VoicePlaybackProgress>({ completed: 0, total: 0 });
  const [errorCode, setErrorCode] = useState<VoiceErrorCode | null>(null);

  const setIfMounted = useCallback((callback: () => void) => {
    if (mountedRef.current) callback();
  }, []);

  const isActive = useCallback((session: PlaybackSession): boolean => (
    sessionRef.current === session && !session.closed
  ), []);

  const releaseSession = useCallback(async (session: PlaybackSession, sendCancel: boolean) => {
    if (session.closed) return;
    session.closed = true;
    session.intentionallyClosed = true;
    try {
      session.unsubscribe();
    } catch {
      // Cleanup must continue even if an injected listener misbehaves.
    }
    try {
      if (sendCancel && session.socket.readyState === SOCKET_OPEN) {
        try {
          session.socket.send(JSON.stringify({ type: 'cancel' }));
        } catch {
          // The socket can close between readyState and send.
        }
      }
      session.socket.onopen = null;
      session.socket.onmessage = null;
      session.socket.onerror = null;
      session.socket.onclose = null;
      if (session.socket.readyState !== SOCKET_CLOSED) session.socket.close();
    } catch {
      // Socket cleanup failures must never skip player cleanup.
    } finally {
      try {
        await session.player.stop();
      } catch {
        // Playback cleanup is best-effort and must remain no-throw.
      }
      if (sessionRef.current === session) sessionRef.current = null;
    }
  }, []);

  const fail = useCallback((session: PlaybackSession, code: VoiceErrorCode) => {
    if (!isActive(session)) return;
    setIfMounted(() => {
      setStatus('error');
      setErrorCode(code);
    });
    void releaseSession(session, true).catch(() => undefined);
  }, [isActive, releaseSession, setIfMounted]);

  const completeIfReady = useCallback((session: PlaybackSession) => {
    if (!isActive(session) || !session.serverCompleted || session.total === 0
      || session.completed !== session.total) return;
    setIfMounted(() => setStatus('idle'));
    void releaseSession(session, false).catch(() => undefined);
  }, [isActive, releaseSession, setIfMounted]);

  const stopActiveSession = useCallback(async () => {
    const session = sessionRef.current;
    if (session) await releaseSession(session, true);
    setIfMounted(() => {
      setStatus('idle');
      setProgress({ completed: 0, total: 0 });
      setErrorCode(null);
    });
  }, [releaseSession, setIfMounted]);

  const stop = useCallback(async () => {
    playGenerationRef.current += 1;
    await stopActiveSession();
  }, [stopActiveSession]);

  const play = useCallback(async (rawReportId: string, rawSpeechId: string) => {
    const reportId = rawReportId.trim();
    const speechId = rawSpeechId.trim();
    const playGeneration = ++playGenerationRef.current;
    await stopActiveSession();
    if (!mountedRef.current || playGeneration !== playGenerationRef.current) return;
    if (!reportId || !speechId) {
      setStatus('error');
      setErrorCode('VOICE_ANSWER_NOT_FOUND');
      return;
    }

    const dependencies = dependenciesRef.current;
    let socket: VoicePlaybackSocket;
    let player: AudioSegmentPlayer | undefined;
    try {
      player = oneShotPlayerRef.current ?? dependencies.createPlayer!();
      oneShotPlayerRef.current = undefined;
      socket = oneShotSocketRef.current ?? dependencies.createWebSocket!(synthesisUrl());
      oneShotSocketRef.current = undefined;
    } catch {
      try {
        await player?.stop();
      } catch {
        // A partially constructed player is best-effort cleanup.
      }
      if (!mountedRef.current || playGeneration !== playGenerationRef.current) return;
      setIfMounted(() => {
        setStatus('error');
        setErrorCode('VOICE_UNSUPPORTED');
      });
      return;
    }

    if (!mountedRef.current || playGeneration !== playGenerationRef.current) {
      try {
        if (socket.readyState !== SOCKET_CLOSED) socket.close();
      } catch {
        // Stale construction cleanup is best-effort.
      } finally {
        try {
          await player.stop();
        } catch {
          // Stale construction cleanup is best-effort.
        }
      }
      return;
    }

    const session: PlaybackSession = {
      socket,
      player,
      unsubscribe: () => undefined,
      activeIndex: null,
      chunks: [],
      segmentBytes: 0,
      totalBytes: 0,
      completed: 0,
      total: 0,
      nextIndex: 0,
      requestSent: false,
      ready: false,
      serverCompleted: false,
      intentionallyClosed: false,
      closed: false,
      userPaused: false,
    };
    sessionRef.current = session;
    socket.binaryType = 'arraybuffer';
    setStatus('preparing');
    setProgress({ completed: 0, total: 0 });
    setErrorCode(null);

    session.unsubscribe = player.onSegmentEnded(() => {
      if (!isActive(session)) return;
      session.completed = Math.min(session.completed + 1, session.total);
      setIfMounted(() => {
        setProgress({ completed: session.completed, total: session.total });
      });
      completeIfReady(session);
    });

    const sendRequest = () => {
      if (!isActive(session) || session.requestSent || socket.readyState !== SOCKET_OPEN) return;
      session.requestSent = true;
      try {
        socket.send(JSON.stringify({ type: 'synthesize', reportId, speechId }));
      } catch {
        fail(session, 'VOICE_UPSTREAM_UNAVAILABLE');
      }
    };

    socket.onopen = sendRequest;
    socket.onerror = () => fail(session, 'VOICE_UPSTREAM_UNAVAILABLE');
    socket.onclose = () => {
      if (!isActive(session) || session.intentionallyClosed) return;
      if (!session.serverCompleted) {
        fail(session, 'VOICE_UPSTREAM_UNAVAILABLE');
      }
    };
    socket.onmessage = (event) => {
      if (!isActive(session)) return;
      const chunk = binaryChunk(event.data);
      if (chunk) {
        if (session.activeIndex === null || chunk.byteLength === 0) {
          fail(session, 'VOICE_INVALID_AUDIO');
          return;
        }
        if (chunk.byteLength > MAX_AUDIO_SEGMENT_BYTES - session.segmentBytes
          || chunk.byteLength > MAX_AUDIO_TOTAL_BYTES - session.totalBytes) {
          fail(session, 'VOICE_INVALID_AUDIO');
          return;
        }
        try {
          session.chunks.push(chunk.slice());
        } catch {
          fail(session, 'VOICE_INVALID_AUDIO');
          return;
        }
        session.segmentBytes += chunk.byteLength;
        session.totalBytes += chunk.byteLength;
        return;
      }

      const message = parseControlMessage(event.data);
      if (!message) {
        fail(session, 'VOICE_INVALID_AUDIO');
        return;
      }
      if (message.type === 'error') {
        fail(session, message.code);
        return;
      }
      if (message.type === 'ready') {
        if (session.ready || session.activeIndex !== null) {
          fail(session, 'VOICE_INVALID_AUDIO');
          return;
        }
        session.ready = true;
        session.total = message.segmentCount;
        setIfMounted(() => setProgress({ completed: 0, total: session.total }));
        return;
      }
      if (message.type === 'segment-start') {
        if (!session.ready || session.activeIndex !== null || message.index !== session.nextIndex
          || message.index >= session.total) {
          fail(session, 'VOICE_INVALID_AUDIO');
          return;
        }
        session.activeIndex = message.index;
        session.chunks = [];
        session.segmentBytes = 0;
        return;
      }
      if (message.type === 'segment-end') {
        if (session.activeIndex !== message.index || session.chunks.length === 0) {
          fail(session, 'VOICE_INVALID_AUDIO');
          return;
        }
        let bytes: ArrayBuffer;
        try {
          bytes = joinChunks(session.chunks, session.segmentBytes);
        } catch {
          fail(session, 'VOICE_INVALID_AUDIO');
          return;
        }
        session.activeIndex = null;
        session.chunks = [];
        session.segmentBytes = 0;
        session.nextIndex += 1;
        let enqueuePromise: Promise<void>;
        try {
          enqueuePromise = player.enqueue(bytes);
        } catch {
          fail(session, 'VOICE_INVALID_AUDIO');
          return;
        }
        void enqueuePromise.then(() => {
          if (isActive(session) && !session.userPaused) setIfMounted(() => setStatus('speaking'));
        }).catch(() => fail(session, 'VOICE_INVALID_AUDIO'));
        return;
      }
      if (!session.ready || session.activeIndex !== null || session.nextIndex !== session.total) {
        fail(session, 'VOICE_INVALID_AUDIO');
        return;
      }
      session.serverCompleted = true;
      completeIfReady(session);
    };

    if (socket.readyState !== SOCKET_CONNECTING && socket.readyState !== SOCKET_OPEN) {
      fail(session, 'VOICE_UPSTREAM_UNAVAILABLE');
      return;
    }
    sendRequest();
  }, [completeIfReady, fail, isActive, setIfMounted, stopActiveSession]);

  const pause = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || !isActive(session)) return;
    session.userPaused = true;
    try {
      await session.player.pause();
      if (isActive(session)) setIfMounted(() => setStatus('paused'));
    } catch {
      fail(session, 'VOICE_UPSTREAM_UNAVAILABLE');
    }
  }, [fail, isActive, setIfMounted]);

  const resume = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || !isActive(session)) return;
    session.userPaused = false;
    try {
      await session.player.resume();
      if (isActive(session)) setIfMounted(() => setStatus('speaking'));
    } catch {
      fail(session, 'VOICE_UPSTREAM_UNAVAILABLE');
    }
  }, [fail, isActive, setIfMounted]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      playGenerationRef.current += 1;
      const session = sessionRef.current;
      if (session) void releaseSession(session, true).catch(() => undefined);
    };
  }, [releaseSession]);

  return { status, progress, errorCode, play, pause, resume, stop };
}
