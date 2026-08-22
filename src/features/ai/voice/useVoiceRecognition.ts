import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceErrorCode, RecognitionServerMessage } from '../../../../shared/voice';
import { Pcm16Resampler } from './pcm-resampler';

const RECOGNITION_PATH = '/api/voice/recognize';
const MAX_RECORDING_MS = 60_000;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

type VoiceSocketEvent = { data?: unknown };

export type VoiceWebSocket = {
  readyState: number;
  send(data: string | ArrayBufferLike): void;
  close(): void;
  onopen: ((event: VoiceSocketEvent) => void) | null;
  onmessage: ((event: VoiceSocketEvent) => void) | null;
  onerror: ((event: VoiceSocketEvent) => void) | null;
  onclose: ((event: VoiceSocketEvent) => void) | null;
};

export type VoiceBrowserDependencies = {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  createAudioContext?: () => AudioContext;
  createAudioWorkletNode?: (context: AudioContext) => AudioWorkletNode;
  createWebSocket?: (url: string) => VoiceWebSocket;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  now?: () => number;
};

export type VoiceRecognitionStatus = 'idle' | 'requesting-permission' | 'connecting' | 'recording' | 'stopping' | 'error';

export type UseVoiceRecognitionOptions = {
  onFinal?: (text: string) => void;
  dependencies?: VoiceBrowserDependencies;
};

export type VoiceRecognitionResult = {
  status: VoiceRecognitionStatus;
  confirmedText: string;
  interimText: string;
  elapsedMs: number;
  errorCode: VoiceErrorCode | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
};

type Timer = ReturnType<typeof globalThis.setTimeout>;

type RecognitionSession = {
  id: number;
  startedAt: number;
  socket?: VoiceWebSocket;
  context?: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  node?: AudioWorkletNode;
  gain?: GainNode;
  resampler?: Pcm16Resampler;
  safetyTimer?: Timer;
  elapsedTimer?: Timer;
  captureStopped: boolean;
  stopSent: boolean;
  completed: boolean;
  serverReady: boolean;
  intentionallyClosed: boolean;
  startFrameSent: boolean;
};

function defaultDependencies(): VoiceBrowserDependencies {
  const browser = globalThis as typeof globalThis & {
    webkitAudioContext?: new () => AudioContext;
  };
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
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    now: Date.now,
  };
}

function recognitionUrl(): string {
  const url = new URL(RECOGNITION_PATH, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function parseServerMessage(data: unknown): RecognitionServerMessage | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null && 'type' in value
      ? value as RecognitionServerMessage
      : undefined;
  } catch {
    return undefined;
  }
}

function isPermissionError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'NotAllowedError' || error.name === 'SecurityError'
    : error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
}

export function useVoiceRecognition(options: UseVoiceRecognitionOptions = {}): VoiceRecognitionResult {
  const dependenciesRef = useRef<VoiceBrowserDependencies>({
    ...defaultDependencies(),
    ...options.dependencies,
  });
  const onFinalRef = useRef(options.onFinal);
  onFinalRef.current = options.onFinal;
  const mountedRef = useRef(true);
  const sessionRef = useRef<RecognitionSession | null>(null);
  const nextSessionId = useRef(0);
  const [status, setStatus] = useState<VoiceRecognitionStatus>('idle');
  const [confirmedText, setConfirmedText] = useState('');
  const [interimText, setInterimText] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorCode, setErrorCode] = useState<VoiceErrorCode | null>(null);

  const setIfMounted = useCallback((callback: () => void) => {
    if (mountedRef.current) callback();
  }, []);

  const isActive = useCallback((session: RecognitionSession): boolean => sessionRef.current === session, []);

  const stopCapture = useCallback((session: RecognitionSession) => {
    if (session.captureStopped) return;
    session.captureStopped = true;
    const dependencies = dependenciesRef.current;
    if (session.safetyTimer !== undefined) dependencies.clearTimeout?.(session.safetyTimer);
    if (session.elapsedTimer !== undefined) dependencies.clearInterval?.(session.elapsedTimer);
    session.safetyTimer = undefined;
    session.elapsedTimer = undefined;
    if (session.node) session.node.port.onmessage = null;
    session.source?.disconnect();
    session.node?.disconnect();
    session.gain?.disconnect();
    for (const track of session.stream?.getTracks() ?? []) track.stop();
    void session.context?.close().catch(() => undefined);
  }, []);

  const closeSocket = useCallback((session: RecognitionSession, intentionallyClosed = true) => {
    session.intentionallyClosed ||= intentionallyClosed;
    if (session.socket && session.socket.readyState !== SOCKET_CLOSED) session.socket.close();
  }, []);

  const fail = useCallback((session: RecognitionSession, code: VoiceErrorCode) => {
    if (!isActive(session)) return;
    stopCapture(session);
    closeSocket(session);
    sessionRef.current = null;
    setIfMounted(() => {
      setStatus('error');
      setErrorCode(code);
      setElapsedMs(Math.max(0, dependenciesRef.current.now!() - session.startedAt));
    });
  }, [closeSocket, isActive, setIfMounted, stopCapture]);

  const requestStop = useCallback((session: RecognitionSession) => {
    if (!isActive(session) || session.completed) return;
    stopCapture(session);
    if (!session.serverReady) {
      closeSocket(session);
      sessionRef.current = null;
      setIfMounted(() => {
        setStatus('idle');
        setErrorCode(null);
        setElapsedMs(Math.max(0, dependenciesRef.current.now!() - session.startedAt));
      });
      return;
    }
    if (!session.stopSent && session.socket?.readyState === SOCKET_OPEN) {
      session.stopSent = true;
      session.socket.send(JSON.stringify({ type: 'stop' }));
    }
    setIfMounted(() => {
      setStatus('stopping');
      setElapsedMs(Math.max(0, dependenciesRef.current.now!() - session.startedAt));
    });
  }, [closeSocket, isActive, setIfMounted, stopCapture]);

  const complete = useCallback((session: RecognitionSession, text: string) => {
    if (!isActive(session) || session.completed) return;
    session.completed = true;
    stopCapture(session);
    closeSocket(session);
    sessionRef.current = null;
    const finalText = text.trim();
    setIfMounted(() => {
      setElapsedMs(Math.max(0, dependenciesRef.current.now!() - session.startedAt));
      setInterimText('');
      if (!finalText) {
        setStatus('error');
        setErrorCode('VOICE_NO_SPEECH');
        return;
      }
      setConfirmedText(finalText);
      setStatus('idle');
      setErrorCode(null);
      onFinalRef.current?.(finalText);
    });
  }, [closeSocket, isActive, setIfMounted, stopCapture]);

  const start = useCallback(async () => {
    if (sessionRef.current) return;
    const dependencies = dependenciesRef.current;
    const session: RecognitionSession = {
      id: ++nextSessionId.current,
      startedAt: dependencies.now!(),
      captureStopped: false,
      stopSent: false,
      completed: false,
      serverReady: false,
      intentionallyClosed: false,
      startFrameSent: false,
    };
    sessionRef.current = session;
    setIfMounted(() => {
      setStatus('requesting-permission');
      setConfirmedText('');
      setInterimText('');
      setElapsedMs(0);
      setErrorCode(null);
    });

    if (!dependencies.mediaDevices || !dependencies.createAudioContext
      || !dependencies.createAudioWorkletNode || !dependencies.createWebSocket) {
      fail(session, 'VOICE_UNSUPPORTED');
      return;
    }

    try {
      session.context = dependencies.createAudioContext();
      if (!session.context.audioWorklet?.addModule) {
        fail(session, 'VOICE_UNSUPPORTED');
        return;
      }
      await session.context.resume();
      if (!isActive(session)) return;
      session.stream = await dependencies.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!isActive(session)) {
        for (const track of session.stream.getTracks()) track.stop();
        return;
      }
      await session.context.audioWorklet.addModule('/voice-pcm-capture-worklet.js');
      if (!isActive(session)) return;

      session.socket = dependencies.createWebSocket(recognitionUrl());
      const sendStart = () => {
        if (!isActive(session) || session.startFrameSent || session.socket?.readyState !== SOCKET_OPEN) return;
        session.startFrameSent = true;
        session.socket.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));
      };
      session.socket.onopen = sendStart;
      session.socket.onerror = () => fail(session, 'VOICE_UPSTREAM_UNAVAILABLE');
      session.socket.onclose = () => {
        if (!isActive(session) || session.completed || session.intentionallyClosed) return;
        stopCapture(session);
        sessionRef.current = null;
        setIfMounted(() => {
          setStatus('error');
          setErrorCode('VOICE_UPSTREAM_UNAVAILABLE');
          setElapsedMs(Math.max(0, dependenciesRef.current.now!() - session.startedAt));
        });
      };
      session.socket.onmessage = (event) => {
        if (!isActive(session)) return;
        const message = parseServerMessage(event.data);
        if (!message) return;
        if (message.type === 'ready') {
          if (session.captureStopped) return;
          session.serverReady = true;
          session.resampler = new Pcm16Resampler(session.context!.sampleRate, 16_000);
          session.source = session.context!.createMediaStreamSource(session.stream!);
          session.node = dependencies.createAudioWorkletNode!(session.context!);
          session.gain = session.context!.createGain();
          session.gain.gain.value = 0;
          session.node.port.onmessage = (workletEvent) => {
            if (!isActive(session) || session.captureStopped || session.socket?.readyState !== SOCKET_OPEN) return;
            const data = workletEvent.data;
            if (!(data instanceof ArrayBuffer)) return;
            const pcm = session.resampler!.push(new Float32Array(data));
            if (pcm.length > 0) session.socket.send(pcm.buffer);
          };
          session.source.connect(session.node);
          session.node.connect(session.gain);
          session.gain.connect(session.context!.destination);
          session.safetyTimer = dependencies.setTimeout!(() => requestStop(session), MAX_RECORDING_MS);
          session.elapsedTimer = dependencies.setInterval!(() => {
            if (isActive(session) && !session.captureStopped) {
              setIfMounted(() => setElapsedMs(Math.max(0, dependenciesRef.current.now!() - session.startedAt)));
            }
          }, 250);
          setIfMounted(() => setStatus('recording'));
          return;
        }
        if (message.type === 'transcript') {
          setIfMounted(() => {
            if (message.final) {
              setConfirmedText((confirmed) => `${confirmed}${message.text}`);
              setInterimText('');
            } else {
              setInterimText(message.text);
            }
          });
          return;
        }
        if (message.type === 'completed') {
          complete(session, message.text);
          return;
        }
        if (message.type === 'error') {
          if (message.code === 'VOICE_LIMIT_EXCEEDED' && session.stopSent && session.captureStopped) {
            return;
          }
          fail(session, message.code);
        }
      };
      sendStart();
      setIfMounted(() => setStatus('connecting'));
    } catch (error) {
      fail(session, isPermissionError(error) ? 'VOICE_PERMISSION_DENIED' : 'VOICE_UPSTREAM_UNAVAILABLE');
    }
  }, [complete, fail, isActive, requestStop, setIfMounted, stopCapture]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (session) requestStop(session);
  }, [requestStop]);

  const cancel = useCallback(async () => {
    const session = sessionRef.current;
    if (session) {
      stopCapture(session);
      closeSocket(session);
      sessionRef.current = null;
    }
    setIfMounted(() => {
      setStatus('idle');
      setConfirmedText('');
      setInterimText('');
      setElapsedMs(0);
      setErrorCode(null);
    });
  }, [closeSocket, setIfMounted, stopCapture]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      if (session) {
        stopCapture(session);
        closeSocket(session);
        sessionRef.current = null;
      }
    };
  }, [closeSocket, stopCapture]);

  return { status, confirmedText, interimText, elapsedMs, errorCode, start, stop, cancel };
}
