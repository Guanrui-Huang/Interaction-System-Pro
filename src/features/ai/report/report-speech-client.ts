import {
  VOICE_ERROR_CODES,
  VOICE_ERROR_MESSAGE_MAX_CHARS,
  VOICE_MAX_AUDIO_SEGMENT_BYTES,
  VOICE_MAX_AUDIO_TOTAL_BYTES,
  VOICE_MAX_SYNTHESIS_SEGMENTS,
  VOICE_OPAQUE_ID_MAX_CHARS,
  type SynthesisServerMessage,
  type VoiceErrorCode,
} from '../../../../shared/voice';
import type { PlayableSpeech } from '../voice/audio-segment-player';

const SYNTHESIS_PATH = '/api/voice/synthesize';
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

type SocketEvent = { data?: unknown };

export type ReportSpeechSocket = {
  readyState: number;
  binaryType: BinaryType;
  send(data: string): void;
  close(): void;
  onopen: ((event: SocketEvent) => void) | null;
  onmessage: ((event: SocketEvent) => void) | null;
  onerror: ((event: SocketEvent) => void) | null;
  onclose: ((event: SocketEvent) => void) | null;
};

export type SpeechAudio = PlayableSpeech & { byteLength: number };

export type LoadSpeechRequest = {
  reportId: string;
  speechId: string;
  signal: AbortSignal;
  createWebSocket?: (url: string) => ReportSpeechSocket;
  limits?: { segmentBytes?: number; totalBytes?: number; segments?: number };
};

export class ReportSpeechClientError extends Error {
  constructor(readonly code: VoiceErrorCode) {
    super(code);
    this.name = 'ReportSpeechClientError';
  }
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function validId(value: string): boolean {
  return value === value.trim() && value.length > 0
    && Array.from(value).length <= VOICE_OPAQUE_ID_MAX_CHARS;
}

function synthesisUrl(): string {
  const url = new URL(SYNTHESIS_PATH, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function isVoiceErrorCode(value: unknown): value is VoiceErrorCode {
  return typeof value === 'string' && (VOICE_ERROR_CODES as readonly string[]).includes(value);
}

function hasExactKeys(message: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(message);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function parseControl(data: unknown): SynthesisServerMessage | undefined {
  if (typeof data !== 'string') return undefined;
  let value: unknown;
  try { value = JSON.parse(data); } catch { return undefined; }
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as Record<string, unknown>;
  if (message.type === 'ready'
    && hasExactKeys(message, ['type', 'segmentCount'])
    && Number.isSafeInteger(message.segmentCount)
    && Number(message.segmentCount) >= 1
    && Number(message.segmentCount) <= VOICE_MAX_SYNTHESIS_SEGMENTS) {
    return { type: 'ready', segmentCount: Number(message.segmentCount) };
  }
  if ((message.type === 'segment-start' || message.type === 'segment-end')
    && hasExactKeys(message, ['type', 'index'])
    && Number.isSafeInteger(message.index)
    && Number(message.index) >= 0
    && Number(message.index) < VOICE_MAX_SYNTHESIS_SEGMENTS) {
    return { type: message.type, index: Number(message.index) };
  }
  if (message.type === 'completed' && hasExactKeys(message, ['type'])) return { type: 'completed' };
  if (message.type === 'error'
    && hasExactKeys(message, ['type', 'code', 'message'])
    && isVoiceErrorCode(message.code)
    && typeof message.message === 'string'
    && message.message.length > 0
    && Array.from(message.message).length <= VOICE_ERROR_MESSAGE_MAX_CHARS) {
    return { type: 'error', code: message.code, message: message.message };
  }
  return undefined;
}

function binaryChunk(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
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

export function loadSpeech(request: LoadSpeechRequest): Promise<SpeechAudio> {
  if (!validId(request.reportId) || !validId(request.speechId)) {
    return Promise.reject(new ReportSpeechClientError('VOICE_ANSWER_NOT_FOUND'));
  }
  if (request.signal.aborted) return Promise.reject(abortError());

  return new Promise<SpeechAudio>((resolve, reject) => {
    const segmentLimit = Math.min(request.limits?.segments ?? VOICE_MAX_SYNTHESIS_SEGMENTS, VOICE_MAX_SYNTHESIS_SEGMENTS);
    const segmentByteLimit = Math.min(request.limits?.segmentBytes ?? VOICE_MAX_AUDIO_SEGMENT_BYTES, VOICE_MAX_AUDIO_SEGMENT_BYTES);
    const totalByteLimit = Math.min(request.limits?.totalBytes ?? VOICE_MAX_AUDIO_TOTAL_BYTES, VOICE_MAX_AUDIO_TOTAL_BYTES);
    let socket: ReportSpeechSocket;
    try {
      socket = (request.createWebSocket ?? ((url) => new WebSocket(url) as unknown as ReportSpeechSocket))(synthesisUrl());
    } catch {
      reject(new ReportSpeechClientError('VOICE_UNSUPPORTED'));
      return;
    }

    let settled = false;
    let requestSent = false;
    let ready = false;
    let expectedSegments = 0;
    let nextIndex = 0;
    let activeIndex: number | null = null;
    let chunks: Uint8Array[] = [];
    let segmentBytes = 0;
    let totalBytes = 0;
    const segments: ArrayBuffer[] = [];

    const cleanup = () => {
      request.signal.removeEventListener('abort', onAbort);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { if (socket.readyState !== SOCKET_CLOSED) socket.close(); } catch { /* best effort */ }
    };
    const finishFailure = (error: unknown, cancel = true) => {
      if (settled) return;
      settled = true;
      if (cancel && requestSent && socket.readyState === SOCKET_OPEN) {
        try { socket.send(JSON.stringify({ type: 'cancel' })); } catch { /* closing */ }
      }
      cleanup();
      reject(error);
    };
    const finishSuccess = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ segments, byteLength: totalBytes });
    };
    const onAbort = () => finishFailure(abortError());
    const sendRequest = () => {
      if (settled || requestSent || socket.readyState !== SOCKET_OPEN) return;
      requestSent = true;
      try {
        socket.send(JSON.stringify({
          type: 'synthesize', reportId: request.reportId, speechId: request.speechId,
        }));
      } catch {
        finishFailure(new ReportSpeechClientError('VOICE_UPSTREAM_UNAVAILABLE'), false);
      }
    };

    request.signal.addEventListener('abort', onAbort, { once: true });
    socket.binaryType = 'arraybuffer';
    socket.onopen = sendRequest;
    socket.onerror = () => finishFailure(new ReportSpeechClientError('VOICE_UPSTREAM_UNAVAILABLE'), false);
    socket.onclose = () => finishFailure(new ReportSpeechClientError('VOICE_UPSTREAM_UNAVAILABLE'), false);
    socket.onmessage = (event) => {
      if (settled) return;
      const binary = binaryChunk(event.data);
      if (binary) {
        if (activeIndex === null || binary.byteLength === 0
          || binary.byteLength > segmentByteLimit - segmentBytes
          || binary.byteLength > totalByteLimit - totalBytes) {
          finishFailure(new ReportSpeechClientError('VOICE_INVALID_AUDIO'));
          return;
        }
        chunks.push(binary.slice());
        segmentBytes += binary.byteLength;
        totalBytes += binary.byteLength;
        return;
      }

      const control = parseControl(event.data);
      if (!control) {
        finishFailure(new ReportSpeechClientError('VOICE_INVALID_AUDIO'));
        return;
      }
      if (control.type === 'error') {
        finishFailure(new ReportSpeechClientError(control.code), false);
        return;
      }
      if (control.type === 'ready') {
        if (ready || control.segmentCount < 1 || control.segmentCount > segmentLimit) {
          finishFailure(new ReportSpeechClientError('VOICE_INVALID_AUDIO'));
          return;
        }
        ready = true;
        expectedSegments = control.segmentCount;
        return;
      }
      if (control.type === 'segment-start') {
        if (!ready || activeIndex !== null || control.index !== nextIndex || control.index >= expectedSegments) {
          finishFailure(new ReportSpeechClientError('VOICE_INVALID_AUDIO'));
          return;
        }
        activeIndex = control.index;
        chunks = [];
        segmentBytes = 0;
        return;
      }
      if (control.type === 'segment-end') {
        if (activeIndex !== control.index || chunks.length === 0) {
          finishFailure(new ReportSpeechClientError('VOICE_INVALID_AUDIO'));
          return;
        }
        segments.push(joinChunks(chunks, segmentBytes));
        activeIndex = null;
        chunks = [];
        segmentBytes = 0;
        nextIndex += 1;
        return;
      }
      if (!ready || activeIndex !== null || nextIndex !== expectedSegments || segments.length !== expectedSegments) {
        finishFailure(new ReportSpeechClientError('VOICE_INVALID_AUDIO'));
        return;
      }
      finishSuccess();
    };

    if (socket.readyState !== SOCKET_CONNECTING && socket.readyState !== SOCKET_OPEN) {
      finishFailure(new ReportSpeechClientError('VOICE_UPSTREAM_UNAVAILABLE'), false);
      return;
    }
    sendRequest();
  });
}
