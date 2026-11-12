import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceErrorCode } from '../../../../shared/voice';
import { Pcm16Resampler } from './pcm-resampler';
import type { VoiceBrowserDependencies, VoiceWebSocket } from './useVoiceRecognition';

const KEYWORD_PATH = '/api/voice/keyword';
const MAX_WAKE_LISTENING_MS = 10 * 60_000;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

export type WakeWordStatus = 'idle' | 'starting' | 'listening' | 'waking' | 'error';
export type WakeWordErrorCode = VoiceErrorCode | 'VOICE_WAKE_UNAVAILABLE' | 'VOICE_WAKE_TIMEOUT';
export type UseWakeWordOptions = {
  onWake?: (keyword: string) => void;
  dependencies?: VoiceBrowserDependencies;
};
export type UseWakeWordResult = {
  status: WakeWordStatus;
  errorCode: WakeWordErrorCode | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
};

type Timer = ReturnType<typeof globalThis.setTimeout>;
type WakeSession = {
  socket?: VoiceWebSocket;
  context?: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  node?: AudioWorkletNode;
  gain?: GainNode;
  resampler?: Pcm16Resampler;
  safetyTimer?: Timer;
  stopped: boolean;
  complete: boolean;
  intentionallyClosed: boolean;
  startSent: boolean;
};

function defaultDependencies(): VoiceBrowserDependencies {
  const browser = globalThis as typeof globalThis & { webkitAudioContext?: new () => AudioContext };
  const AudioContextConstructor = browser.AudioContext ?? browser.webkitAudioContext;
  return {
    mediaDevices: browser.navigator?.mediaDevices,
    createAudioContext: AudioContextConstructor ? () => new AudioContextConstructor() : undefined,
    createAudioWorkletNode: browser.AudioWorkletNode
      ? (context) => new browser.AudioWorkletNode(context, 'voice-pcm-capture')
      : undefined,
    createWebSocket: browser.WebSocket
      ? (url) => new browser.WebSocket(url) as unknown as VoiceWebSocket
      : undefined,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    now: Date.now,
  };
}

function keywordUrl(): string {
  const url = new URL(KEYWORD_PATH, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function parseMessage(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isPermissionError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'NotAllowedError' || error.name === 'SecurityError'
    : error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
}

export function useWakeWord(options: UseWakeWordOptions = {}): UseWakeWordResult {
  const dependenciesRef = useRef<VoiceBrowserDependencies>({ ...defaultDependencies(), ...options.dependencies });
  const onWakeRef = useRef(options.onWake);
  onWakeRef.current = options.onWake;
  const mountedRef = useRef(true);
  const sessionRef = useRef<WakeSession | null>(null);
  const [status, setStatus] = useState<WakeWordStatus>('idle');
  const [errorCode, setErrorCode] = useState<WakeWordErrorCode | null>(null);

  const setIfMounted = useCallback((callback: () => void) => {
    if (mountedRef.current) callback();
  }, []);

  const stopCapture = useCallback((session: WakeSession) => {
    if (session.stopped) return;
    session.stopped = true;
    const dependencies = dependenciesRef.current;
    if (session.safetyTimer !== undefined) dependencies.clearTimeout?.(session.safetyTimer);
    session.safetyTimer = undefined;
    if (session.node) session.node.port.onmessage = null;
    session.source?.disconnect();
    session.node?.disconnect();
    session.gain?.disconnect();
    for (const track of session.stream?.getTracks() ?? []) track.stop();
    void session.context?.close().catch(() => undefined);
  }, []);

  const closeSocket = useCallback((session: WakeSession) => {
    session.intentionallyClosed = true;
    if (session.socket && session.socket.readyState !== SOCKET_CLOSED) session.socket.close();
  }, []);

  const fail = useCallback((session: WakeSession, code: WakeWordErrorCode) => {
    if (sessionRef.current !== session) return;
    stopCapture(session);
    closeSocket(session);
    sessionRef.current = null;
    setIfMounted(() => { setStatus('error'); setErrorCode(code); });
  }, [closeSocket, setIfMounted, stopCapture]);

  const completeWake = useCallback((session: WakeSession, keyword: string) => {
    if (sessionRef.current !== session || session.complete) return;
    session.complete = true;
    stopCapture(session);
    closeSocket(session);
    sessionRef.current = null;
    setIfMounted(() => {
      setStatus('waking');
      setErrorCode(null);
      onWakeRef.current?.(keyword);
    });
  }, [closeSocket, setIfMounted, stopCapture]);

  const start = useCallback(async () => {
    if (sessionRef.current) return;
    const dependencies = dependenciesRef.current;
    const session: WakeSession = { stopped: false, complete: false, intentionallyClosed: false, startSent: false };
    sessionRef.current = session;
    setIfMounted(() => { setStatus('starting'); setErrorCode(null); });

    if (!dependencies.mediaDevices || !dependencies.createAudioContext
      || !dependencies.createAudioWorkletNode || !dependencies.createWebSocket) {
      fail(session, 'VOICE_UNSUPPORTED');
      return;
    }

    try {
      session.context = dependencies.createAudioContext();
      if (!session.context.audioWorklet?.addModule) { fail(session, 'VOICE_UNSUPPORTED'); return; }
      await session.context.resume();
      if (sessionRef.current !== session) return;
      session.stream = await dependencies.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (sessionRef.current !== session) { session.stream.getTracks().forEach((track) => track.stop()); return; }
      await session.context.audioWorklet.addModule('/voice-pcm-capture-worklet.js');
      if (sessionRef.current !== session) return;

      session.socket = dependencies.createWebSocket(keywordUrl());
      const sendStart = () => {
        if (sessionRef.current !== session || session.startSent || session.socket?.readyState !== SOCKET_OPEN) return;
        session.startSent = true;
        session.socket.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));
      };
      session.socket.onopen = sendStart;
      session.socket.onerror = () => fail(session, 'VOICE_WAKE_UNAVAILABLE');
      session.socket.onclose = () => {
        if (sessionRef.current !== session || session.complete || session.intentionallyClosed) return;
        fail(session, 'VOICE_WAKE_UNAVAILABLE');
      };
      session.socket.onmessage = (event) => {
        if (sessionRef.current !== session) return;
        const message = parseMessage(event.data);
        if (!message) return;
        if (message.type === 'ready') {
          session.resampler = new Pcm16Resampler(session.context!.sampleRate, 16_000);
          session.source = session.context!.createMediaStreamSource(session.stream!);
          session.node = dependencies.createAudioWorkletNode!(session.context!);
          session.gain = session.context!.createGain();
          session.gain.gain.value = 0;
          session.node.port.onmessage = (workletEvent) => {
            if (sessionRef.current !== session || session.stopped || session.socket?.readyState !== SOCKET_OPEN) return;
            if (!(workletEvent.data instanceof ArrayBuffer)) return;
            const pcm = session.resampler!.push(new Float32Array(workletEvent.data));
            if (pcm.length > 0) session.socket!.send(pcm.buffer);
          };
          session.source.connect(session.node);
          session.node.connect(session.gain);
          session.gain.connect(session.context!.destination);
          session.safetyTimer = dependencies.setTimeout?.(() => fail(session, 'VOICE_WAKE_TIMEOUT'), MAX_WAKE_LISTENING_MS);
          setIfMounted(() => setStatus('listening'));
          return;
        }
        if (message.type === 'wake' && typeof message.keyword === 'string' && message.keyword.trim()) {
          completeWake(session, message.keyword.trim());
          return;
        }
        if (message.type === 'error') {
          fail(session, typeof message.code === 'string' ? message.code as WakeWordErrorCode : 'VOICE_WAKE_UNAVAILABLE');
        }
      };
      sendStart();
    } catch (error) {
      fail(session, isPermissionError(error) ? 'VOICE_PERMISSION_DENIED' : 'VOICE_WAKE_UNAVAILABLE');
    }
  }, [completeWake, fail, setIfMounted]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (session) {
      stopCapture(session);
      closeSocket(session);
      sessionRef.current = null;
    }
    setIfMounted(() => { setStatus('idle'); setErrorCode(null); });
  }, [closeSocket, setIfMounted, stopCapture]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      if (session) { stopCapture(session); closeSocket(session); sessionRef.current = null; }
    };
  }, [closeSocket, stopCapture]);

  return { status, errorCode, start, stop, cancel: stop };
}
