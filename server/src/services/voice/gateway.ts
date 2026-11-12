import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { z } from 'zod';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  VOICE_MAX_AUDIO_SEGMENT_BYTES,
  VOICE_MAX_AUDIO_TOTAL_BYTES,
  VOICE_MAX_SYNTHESIS_SEGMENTS,
  VOICE_OPAQUE_ID_MAX_CHARS,
  VOICE_PROMPT_QUESTION_MAX_CHARS,
  VOICE_ERROR_MESSAGES,
  type AssistantPromptId,
  type VoiceErrorCode,
} from '../../../../shared/voice';
import type { AliyunNlsConfigResult } from './config';
import type { QwenOmniConfigResult } from './omni-config';
import type { KeywordSpotterHandle, KeywordSpotterStream } from './keyword-spotter';
import {
  createAliyunRecognitionSdk,
  createAliyunSynthesisSdk,
  createRecognitionSession,
  synthesizeSegment,
  type RecognitionSession,
} from './nls-sessions';
import {
  createQwenOmniRecognitionSession,
  QwenOmniRealtimeError,
} from './omni-realtime-session';
import {
  DashScopeTtsError,
  synthesizeDashScopeSpeech,
} from './dashscope-tts';
import type { SpeechAnswerRegistry } from './speech-answer-registry';
import type { ReportJobRegistry } from '../report-job-registry';
import { splitSpeechText } from './text-segmenter';
import {
  AliyunNlsTokenManager,
  AliyunNlsTokenError,
  createPopTokenProvider,
} from './token-manager';

const RECOGNITION_PATH = '/api/voice/recognize';
const SYNTHESIS_PATH = '/api/voice/synthesize';
const KEYWORD_PATH = '/api/voice/keyword';
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RECORDING_MS = 60_000;
const DEFAULT_TIMEOUTS: VoiceGatewayTimeouts = {
  tokenMs: 10_000,
  recognitionStartMs: 10_000,
  recognitionStopMs: 10_000,
  synthesisSegmentMs: 30_000,
};

const recognitionStartSchema = z.object({
  type: z.literal('start'),
  format: z.literal('pcm'),
  sampleRate: z.literal(16_000),
}).strict();
const recognitionStopSchema = z.object({ type: z.literal('stop') }).strict();
const keywordStartSchema = z.object({
  type: z.literal('start'),
  format: z.literal('pcm'),
  sampleRate: z.literal(16_000),
}).strict();
const synthesisStartSchema = z.union([
  z.object({
    type: z.literal('synthesize'),
    reportId: z.string().trim().min(1).max(VOICE_OPAQUE_ID_MAX_CHARS),
    speechId: z.string().trim().min(1).max(VOICE_OPAQUE_ID_MAX_CHARS),
  }).strict(),
  z.object({
    type: z.literal('prompt'),
    prompt: z.literal('wake'),
  }).strict(),
  z.object({
    type: z.literal('prompt'),
    prompt: z.literal('analysis-started'),
    question: z.string().trim().min(1).max(VOICE_PROMPT_QUESTION_MAX_CHARS),
  }).strict(),
]);
const synthesisCancelSchema = z.object({ type: z.literal('cancel') }).strict();

const ASSISTANT_PROMPTS: Record<AssistantPromptId, string> = {
  wake: '诶，我在，请问有什么吩咐',
  'analysis-started': '',
};

export type VoiceGatewayTimeouts = {
  tokenMs: number;
  recognitionStartMs: number;
  recognitionStopMs: number;
  synthesisSegmentMs: number;
};

export type VoiceGatewaySynthesisLimits = {
  segmentBytes: number;
  totalBytes: number;
};

export type VoiceGatewayDependencies = {
  config: AliyunNlsConfigResult;
  recognitionConfig?: QwenOmniConfigResult;
  synthesisConfig?: QwenOmniConfigResult;
  speechAnswers: SpeechAnswerRegistry;
  reportRegistry: ReportJobRegistry;
  keywordSpotter?: KeywordSpotterHandle;
  tokenManager?: AliyunNlsTokenManager;
  createRecognitionSdk: typeof createAliyunRecognitionSdk;
  createRealtimeRecognitionSession?: typeof createQwenOmniRecognitionSession;
  createSynthesisSdk: typeof createAliyunSynthesisSdk;
  synthesizeSpeech?: typeof synthesizeDashScopeSpeech;
  maxRecordingMs?: number;
  timeouts?: Partial<VoiceGatewayTimeouts>;
  synthesisLimits?: Partial<VoiceGatewaySynthesisLimits>;
  now?: () => number;
};

class VoiceGatewayError extends Error {
  constructor(readonly code: VoiceErrorCode) {
    super(code);
    this.name = 'VoiceGatewayError';
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function gatewayTimeouts(dependencies: VoiceGatewayDependencies): VoiceGatewayTimeouts {
  return {
    tokenMs: positiveDuration(dependencies.timeouts?.tokenMs, DEFAULT_TIMEOUTS.tokenMs),
    recognitionStartMs: positiveDuration(
      dependencies.timeouts?.recognitionStartMs,
      DEFAULT_TIMEOUTS.recognitionStartMs,
    ),
    recognitionStopMs: positiveDuration(
      dependencies.timeouts?.recognitionStopMs,
      DEFAULT_TIMEOUTS.recognitionStopMs,
    ),
    synthesisSegmentMs: positiveDuration(
      dependencies.timeouts?.synthesisSegmentMs,
      DEFAULT_TIMEOUTS.synthesisSegmentMs,
    ),
  };
}

function boundedBytes(value: number | undefined, hardMaximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return hardMaximum;
  return Math.min(Number(value), hardMaximum);
}

function synthesisLimits(dependencies: VoiceGatewayDependencies): VoiceGatewaySynthesisLimits {
  return {
    segmentBytes: boundedBytes(
      dependencies.synthesisLimits?.segmentBytes,
      VOICE_MAX_AUDIO_SEGMENT_BYTES,
    ),
    totalBytes: boundedBytes(
      dependencies.synthesisLimits?.totalBytes,
      VOICE_MAX_AUDIO_TOTAL_BYTES,
    ),
  };
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        onTimeout?.();
      } catch {
        // Timeout cleanup is best-effort; the public result stays typed and sanitized.
      }
      reject(new VoiceGatewayError('VOICE_UPSTREAM_TIMEOUT'));
    }, timeoutMs);

    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

function hasAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const parsedOrigin = new URL(origin);
    const parsedHost = new URL(`http://${host}`);
    return (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:')
      && isLoopback(parsedOrigin.hostname)
      && isLoopback(parsedHost.hostname)
      && parsedOrigin.host === parsedHost.host;
  } catch {
    return false;
  }
}

function parseJson(data: RawData): unknown {
  try {
    return JSON.parse(data.toString());
  } catch {
    return undefined;
  }
}

function sendJson(socket: WebSocket, message: object): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, code: VoiceErrorCode): void {
  sendJson(socket, { type: 'error', code, message: VOICE_ERROR_MESSAGES[code] });
}

const CONFIRMED_AUTH_CODES = new Set([
  'authenticationfailed',
  'authorizationfailed',
  'forbidden',
  'invalidaccesskeyid',
  'invalidaccesskeyidnotfound',
  'invalidsecuritytoken',
  'signaturedoesnotmatch',
  'unauthorized',
]);

const AUTH_HTTP_STATUS_MESSAGE = /(?:unexpected server response:\s*|http(?:\s+(?:response|status))?\s*[:=]?\s*)(401|403)\b/i;
const AUTH_CODE_MESSAGE = /(?:authentication|authorization)[ _-]?failed|invalidaccesskeyid|signaturedoesnotmatch|unauthorized/i;
const ACCESS_DENIED_MESSAGE = /(?:meta|gateway):access_denied\b/i;
const MAX_TASK_FAILED_JSON_CHARS = 16 * 1024;

function normalizedProviderCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized || undefined;
}

function isAuthStatus(value: unknown): boolean {
  return value === 401 || value === 403 || value === '401' || value === '403';
}

function isTaskFailedAuthStatus(value: unknown): boolean {
  return value === 403 || value === '403' || value === 40_000_001 || value === '40000001';
}

function isTaskFailedAuthPayload(
  value: unknown,
  seen: Set<object>,
  depth: number,
): boolean {
  if (depth > 6 || typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);

  const record = value as Record<string, unknown>;
  const headerValue = record.header;
  if (typeof headerValue !== 'object' || headerValue === null || seen.has(headerValue)) return false;
  seen.add(headerValue);
  const header = headerValue as Record<string, unknown>;
  if (normalizedProviderCode(header.name) !== 'taskfailed') return false;
  if (isTaskFailedAuthStatus(header.status ?? record.status)) return true;

  return [
    header.status_text,
    header.statusText,
    header.message,
    record.status_text,
    record.statusText,
    record.message,
  ].some((message) => typeof message === 'string' && ACCESS_DENIED_MESSAGE.test(message));
}

function isTaskFailedAuthJson(
  value: string,
  seen: Set<object>,
  depth: number,
): boolean | undefined {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  if (value.length > MAX_TASK_FAILED_JSON_CHARS) return false;
  try {
    return isTaskFailedAuthPayload(JSON.parse(value), seen, depth + 1);
  } catch {
    return false;
  }
}

function isExplicitAuthFailure(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): boolean {
  if (depth > 6) return false;
  if (typeof value === 'string') {
    const taskFailedAuth = isTaskFailedAuthJson(value, seen, depth);
    if (taskFailedAuth !== undefined) return taskFailedAuth;
    return AUTH_HTTP_STATUS_MESSAGE.test(value) || AUTH_CODE_MESSAGE.test(value);
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);

  const record = value as Record<string, unknown>;
  const providerCode = normalizedProviderCode(record.code ?? record.Code);
  if (providerCode !== undefined && CONFIRMED_AUTH_CODES.has(providerCode)) return true;
  for (const key of ['status', 'statusCode', 'httpStatus', 'httpStatusCode'] as const) {
    if (isAuthStatus(record[key])) return true;
  }
  if (value instanceof Error && (
    AUTH_HTTP_STATUS_MESSAGE.test(value.message)
    || AUTH_CODE_MESSAGE.test(value.message)
  )) return true;
  if (isExplicitAuthFailure(record.cause, seen, depth + 1)) return true;

  const response = record.response;
  if (typeof response === 'object' && response !== null && !seen.has(response)) {
    const responseRecord = response as Record<string, unknown>;
    if (isAuthStatus(responseRecord.status) || isAuthStatus(responseRecord.statusCode)) return true;
  }
  return false;
}

function errorCode(error: unknown): VoiceErrorCode {
  if (error instanceof VoiceGatewayError) return error.code;
  if (error instanceof QwenOmniRealtimeError) {
    return error.code === 'QWEN_OMNI_AUTH'
      ? 'VOICE_UPSTREAM_AUTH'
      : 'VOICE_UPSTREAM_UNAVAILABLE';
  }
  if (error instanceof DashScopeTtsError) {
    return error.code === 'DASHSCOPE_TTS_AUTH'
      ? 'VOICE_UPSTREAM_AUTH'
      : 'VOICE_UPSTREAM_UNAVAILABLE';
  }
  if (error instanceof AliyunNlsTokenError) {
    return error.code === 'ALIYUN_NLS_TOKEN_AUTH'
      ? 'VOICE_UPSTREAM_AUTH'
      : 'VOICE_UPSTREAM_UNAVAILABLE';
  }
  if (isExplicitAuthFailure(error)) return 'VOICE_UPSTREAM_AUTH';
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  if (typeof current === 'string') messages.push(current);
  const details = messages.join(' ').toUpperCase();
  if (details.includes('TIMEOUT') || details.includes('TIMED OUT')) return 'VOICE_UPSTREAM_TIMEOUT';
  return 'VOICE_UPSTREAM_UNAVAILABLE';
}

function closeSocket(socket: WebSocket, code = 1000): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code);
  }
}

function destroyUpgrade(socket: Socket): void {
  socket.destroy();
}

function attachRecognitionSocket(
  socket: WebSocket,
  dependencies: VoiceGatewayDependencies,
  tokenManager: AliyunNlsTokenManager | undefined,
): () => void {
  type State = 'awaiting-start' | 'starting' | 'ready' | 'stopping' | 'closed';

  let state: State = 'awaiting-start';
  let recognition: RecognitionSession | undefined;
  let recordingTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let cleaned = false;
  let completionStarted = false;
  const timeouts = gatewayTimeouts(dependencies);

  const shutdownRecognition = (session: RecognitionSession | undefined) => {
    try {
      session?.shutdown();
    } catch {
      // Provider cleanup must not replace the sanitized gateway outcome.
    }
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state = 'closed';
    if (recordingTimer) clearTimeout(recordingTimer);
    recordingTimer = undefined;
    shutdownRecognition(recognition);
    recognition = undefined;
    socket.removeAllListeners('message');
    socket.removeListener('close', cleanup);
    socket.removeListener('error', cleanup);
  };

  const failRecognition = (error: unknown) => {
    if (cleaned) return;
    cleanup();
    sendError(socket, errorCode(error));
    closeSocket(socket, 1011);
  };

  const completeRecognition = async () => {
    if (completionStarted || state === 'closed' || !recognition) return;
    completionStarted = true;
    state = 'stopping';
    if (recordingTimer) clearTimeout(recordingTimer);
    recordingTimer = undefined;

    const activeRecognition = recognition;
    try {
      const text = await withTimeout((async () => {
        await activeRecognition.stop();
        return activeRecognition.completedText;
      })(), timeouts.recognitionStopMs, () => shutdownRecognition(activeRecognition));
      if (cleaned) return;
      if (text.trim()) sendJson(socket, { type: 'completed', text });
      else sendError(socket, 'VOICE_NO_SPEECH');
      closeSocket(socket);
    } catch (error) {
      failRecognition(error);
    }
  };

  const createStartedSession = async (forceRefresh: boolean): Promise<RecognitionSession> => {
    const onTranscript = (text: string, final: boolean) => {
      if (state !== 'closed' && text) sendJson(socket, { type: 'transcript', text, final });
    };
    let session: RecognitionSession;
    if (dependencies.recognitionConfig !== undefined) {
      if (!dependencies.recognitionConfig.success || !dependencies.createRealtimeRecognitionSession) {
        throw new VoiceGatewayError('VOICE_NOT_CONFIGURED');
      }
      session = dependencies.createRealtimeRecognitionSession({
        config: dependencies.recognitionConfig.data,
        onTranscript,
      });
    } else {
      if (!dependencies.config.success || !tokenManager) {
        throw new VoiceGatewayError('VOICE_NOT_CONFIGURED');
      }
      const token = await withTimeout(
        tokenManager.getToken(forceRefresh),
        timeouts.tokenMs,
      );
      const sdk = dependencies.createRecognitionSdk(dependencies.config.data, token.value);
      session = createRecognitionSession({ sdk, onTranscript });
    }
    void session.completedText.catch(() => undefined);
    recognition = session;
    await withTimeout(
      session.start(),
      timeouts.recognitionStartMs,
      () => shutdownRecognition(session),
    );
    return session;
  };

  const watchReadySessionFailure = (session: RecognitionSession) => {
    void session.completedText.catch((error: unknown) => {
      if (cleaned || recognition !== session || state !== 'ready') return;
      failRecognition(error);
    });
  };

  const startRecognition = async () => {
    const omniConfigured = dependencies.recognitionConfig?.success === true
      && dependencies.createRealtimeRecognitionSession !== undefined;
    const legacyConfigured = dependencies.recognitionConfig === undefined
      && dependencies.config.success
      && tokenManager !== undefined;
    if (!omniConfigured && !legacyConfigured) {
      sendError(socket, 'VOICE_NOT_CONFIGURED');
      return;
    }
    state = 'starting';
    try {
      try {
        await createStartedSession(false);
      } catch (error) {
        if (dependencies.recognitionConfig !== undefined || errorCode(error) !== 'VOICE_UPSTREAM_AUTH') {
          throw error;
        }
        shutdownRecognition(recognition);
        recognition = undefined;
        await createStartedSession(true);
      }
      if (cleaned) {
        shutdownRecognition(recognition);
        recognition = undefined;
        return;
      }
      state = 'ready';
      watchReadySessionFailure(recognition!);
      sendJson(socket, { type: 'ready' });
      recordingTimer = setTimeout(() => {
        timedOut = true;
        void completeRecognition();
      }, dependencies.maxRecordingMs ?? MAX_RECORDING_MS);
    } catch (error) {
      failRecognition(error);
    }
  };

  const onMessage = (data: RawData, isBinary: boolean) => {
    if (state === 'closed') return;
    if (isBinary) {
      if (state === 'ready' && recognition) {
        if (!recognition.sendAudio(Buffer.from(data as ArrayBuffer))) {
          failRecognition(new VoiceGatewayError('VOICE_UPSTREAM_UNAVAILABLE'));
        }
      } else if (state !== 'stopping') {
        sendError(socket, timedOut ? 'VOICE_LIMIT_EXCEEDED' : 'VOICE_INVALID_AUDIO');
      }
      return;
    }

    const message = parseJson(data);
    if (state === 'awaiting-start' && recognitionStartSchema.safeParse(message).success) {
      void startRecognition();
      return;
    }
    if (state === 'ready' && recognitionStopSchema.safeParse(message).success) {
      void completeRecognition();
      return;
    }
    sendError(socket, timedOut ? 'VOICE_LIMIT_EXCEEDED' : 'VOICE_INVALID_AUDIO');
  };

  socket.on('message', onMessage);
  socket.once('close', cleanup);
  socket.once('error', cleanup);
  return cleanup;
}

function attachSynthesisSocket(
  socket: WebSocket,
  dependencies: VoiceGatewayDependencies,
  tokenManager: AliyunNlsTokenManager | undefined,
): () => void {
  type State = 'awaiting-request' | 'synthesizing' | 'closed';

  let state: State = 'awaiting-request';
  let cleaned = false;
  let abortController: AbortController | undefined;
  let narrationLease: { reportId: string; signal: AbortSignal } | undefined;
  const timeouts = gatewayTimeouts(dependencies);
  const limits = synthesisLimits(dependencies);

  const releaseNarrationLease = () => {
    const lease = narrationLease;
    if (!lease) return;
    narrationLease = undefined;
    dependencies.reportRegistry.endActivity(lease.reportId, 'narration', lease.signal);
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state = 'closed';
    abortController?.abort();
    abortController = undefined;
    releaseNarrationLease();
    socket.removeAllListeners('message');
    socket.removeListener('close', cleanup);
    socket.removeListener('error', cleanup);
  };

  const runSynthesis = async (request: z.infer<typeof synthesisStartSchema>) => {
    const reportSignal = request.type === 'synthesize'
      ? dependencies.reportRegistry.beginActivity(request.reportId, 'narration')
      : undefined;
    if (reportSignal && request.type === 'synthesize') {
      narrationLease = { reportId: request.reportId, signal: reportSignal };
    }
    const answer = request.type === 'prompt'
      ? request.prompt === 'wake'
        ? ASSISTANT_PROMPTS.wake
        : `好滴，现在我来分析：${request.question.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, VOICE_PROMPT_QUESTION_MAX_CHARS)}`
      : reportSignal
        ? dependencies.speechAnswers.get(request.reportId, request.speechId)
        : undefined;
    if (answer === undefined) {
      releaseNarrationLease();
      sendError(socket, 'VOICE_ANSWER_NOT_FOUND');
      state = 'awaiting-request';
      return;
    }
    const useOmniSpeech = dependencies.synthesisConfig !== undefined;
    const omniSpeechConfig = dependencies.synthesisConfig?.success === true
      ? dependencies.synthesisConfig.data
      : undefined;
    const legacySpeechConfig = dependencies.config.success
      ? dependencies.config.data
      : undefined;
    const omniSpeechConfigured = omniSpeechConfig !== undefined
      && dependencies.synthesizeSpeech !== undefined;
    const legacySpeechConfigured = !useOmniSpeech
      && legacySpeechConfig !== undefined
      && tokenManager !== undefined;
    if (!omniSpeechConfigured && !legacySpeechConfigured) {
      releaseNarrationLease();
      sendError(socket, 'VOICE_NOT_CONFIGURED');
      state = 'awaiting-request';
      return;
    }

    abortController = new AbortController();
    const { signal } = abortController;
    const abortForReport = () => {
      abortController?.abort();
      releaseNarrationLease();
      closeSocket(socket);
    };
    reportSignal?.addEventListener('abort', abortForReport, { once: true });
    try {
      const token = legacySpeechConfigured
        ? await withTimeout(tokenManager!.getToken(false), timeouts.tokenMs)
        : undefined;
      if (signal.aborted || cleaned) return;
      const segments = splitSpeechText(answer);
      if (segments.length < 1 || segments.length > VOICE_MAX_SYNTHESIS_SEGMENTS) {
        throw new VoiceGatewayError('VOICE_LIMIT_EXCEEDED');
      }
      sendJson(socket, { type: 'ready', segmentCount: segments.length });
      let totalBytes = 0;

      for (const [index, segment] of segments.entries()) {
        if (signal.aborted || cleaned) return;
        if (totalBytes >= limits.totalBytes) {
          throw new VoiceGatewayError('VOICE_LIMIT_EXCEEDED');
        }
        sendJson(socket, { type: 'segment-start', index });
        const segmentController = new AbortController();
        let segmentBytes = 0;
        let limitExceeded = false;
        const abortSegment = () => segmentController.abort();
        signal.addEventListener('abort', abortSegment, { once: true });
        try {
          if (omniSpeechConfigured) {
            const maxAudioBytes = Math.min(limits.segmentBytes, limits.totalBytes - totalBytes);
            const bytes = await withTimeout(dependencies.synthesizeSpeech!({
              config: omniSpeechConfig!,
              text: segment,
              signal: segmentController.signal,
              maxAudioBytes,
            }), timeouts.synthesisSegmentMs, () => segmentController.abort());
            if (bytes.byteLength < 1 || bytes.byteLength > maxAudioBytes) {
              throw new VoiceGatewayError('VOICE_LIMIT_EXCEEDED');
            }
            segmentBytes = bytes.byteLength;
            totalBytes += bytes.byteLength;
            if (!signal.aborted && !segmentController.signal.aborted
              && !cleaned && socket.readyState === WebSocket.OPEN) {
              socket.send(bytes, { binary: true });
            }
          } else {
            const sdk = dependencies.createSynthesisSdk(legacySpeechConfig!, token!.value);
            try {
              await withTimeout(synthesizeSegment({
                sdk,
                text: segment,
                voice: legacySpeechConfig!.voice,
                signal: segmentController.signal,
                onData: (bytes) => {
                  if (signal.aborted || segmentController.signal.aborted || cleaned || limitExceeded) return;
                  if (
                    bytes.byteLength > limits.segmentBytes - segmentBytes
                    || bytes.byteLength > limits.totalBytes - totalBytes
                  ) {
                    limitExceeded = true;
                    segmentController.abort();
                    return;
                  }
                  segmentBytes += bytes.byteLength;
                  totalBytes += bytes.byteLength;
                  if (socket.readyState === WebSocket.OPEN) {
                    socket.send(bytes, { binary: true });
                  }
                },
              }), timeouts.synthesisSegmentMs, () => segmentController.abort());
            } catch (error) {
              if (!segmentController.signal.aborted) {
                try {
                  sdk.shutdown();
                } catch {
                  // Preserve the original typed error.
                }
              }
              throw error;
            }
            if (!segmentController.signal.aborted) {
              try {
                sdk.shutdown();
              } catch {
                // A completed provider session is already terminal.
              }
            }
          }
          if (limitExceeded) throw new VoiceGatewayError('VOICE_LIMIT_EXCEEDED');
          if (signal.aborted || cleaned) return;
        } finally {
          signal.removeEventListener('abort', abortSegment);
        }
        sendJson(socket, { type: 'segment-end', index });
      }

      if (!signal.aborted && !cleaned) {
        sendJson(socket, { type: 'completed' });
        releaseNarrationLease();
        closeSocket(socket);
      }
    } catch (error) {
      if (!signal.aborted && !cleaned) {
        releaseNarrationLease();
        sendError(socket, errorCode(error));
        closeSocket(socket, 1011);
      }
    } finally {
      reportSignal?.removeEventListener('abort', abortForReport);
      releaseNarrationLease();
    }
  };

  const onMessage = (data: RawData, isBinary: boolean) => {
    if (state === 'closed') return;
    if (isBinary) {
      sendError(socket, 'VOICE_INVALID_AUDIO');
      return;
    }
    const message = parseJson(data);
    if (state === 'awaiting-request') {
      const parsed = synthesisStartSchema.safeParse(message);
      if (parsed.success) {
        state = 'synthesizing';
        void runSynthesis(parsed.data);
        return;
      }
    }
    if (state === 'synthesizing' && synthesisCancelSchema.safeParse(message).success) {
      abortController?.abort();
      releaseNarrationLease();
      closeSocket(socket);
      return;
    }
    sendError(socket, 'VOICE_INVALID_AUDIO');
  };

  socket.on('message', onMessage);
  socket.once('close', cleanup);
  socket.once('error', cleanup);
  return cleanup;
}

function pcmBufferToFloatSamples(buffer: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(buffer.length / 2));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buffer.readInt16LE(i * 2) / 32_768;
  }
  return samples;
}

function attachKeywordSocket(
  socket: WebSocket,
  dependencies: VoiceGatewayDependencies,
): () => void {
  type State = 'awaiting-start' | 'ready' | 'closed';

  let state: State = 'awaiting-start';
  let cleaned = false;
  let stream: KeywordSpotterStream | undefined;
  const spotter = dependencies.keywordSpotter;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state = 'closed';
    stream = undefined;
    socket.removeAllListeners('message');
    socket.removeListener('close', cleanup);
    socket.removeListener('error', cleanup);
  };

  const failKeyword = (code: VoiceErrorCode) => {
    if (cleaned) return;
    cleanup();
    sendError(socket, code);
    closeSocket(socket, 1011);
  };

  const startKeywordListening = () => {
    if (!spotter) {
      failKeyword('VOICE_WAKE_UNAVAILABLE');
      return;
    }
    try {
      stream = spotter.createStream();
    } catch {
      failKeyword('VOICE_WAKE_UNAVAILABLE');
      return;
    }
    state = 'ready';
    sendJson(socket, { type: 'ready' });
  };

  const onMessage = (data: RawData, isBinary: boolean) => {
    if (state === 'closed') return;
    if (isBinary) {
      if (state !== 'ready' || !spotter || !stream) {
        sendError(socket, 'VOICE_INVALID_AUDIO');
        return;
      }
      try {
        stream.acceptWaveform({
          samples: pcmBufferToFloatSamples(Buffer.from(data as ArrayBuffer)),
          sampleRate: 16_000,
        });
        while (spotter.isReady(stream)) {
          spotter.decode(stream);
          const result = spotter.getResult(stream);
          if (result.keyword) {
            sendJson(socket, { type: 'wake', keyword: result.keyword });
            spotter.reset(stream);
          }
        }
      } catch {
        failKeyword('VOICE_WAKE_UNAVAILABLE');
      }
      return;
    }

    const message = parseJson(data);
    if (state === 'awaiting-start' && keywordStartSchema.safeParse(message).success) {
      startKeywordListening();
      return;
    }
    sendError(socket, 'VOICE_INVALID_AUDIO');
  };

  socket.on('message', onMessage);
  socket.once('close', cleanup);
  socket.once('error', cleanup);
  return cleanup;
}

export function attachVoiceWebSocketGateway(
  server: Server,
  dependencies: VoiceGatewayDependencies,
): () => void {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  const cleanups = new Set<() => void>();
  const tokenManager = dependencies.tokenManager
    ?? (dependencies.config.success
      ? new AliyunNlsTokenManager(
        dependencies.config.data,
        createPopTokenProvider(),
        { now: dependencies.now },
      )
      : undefined);

  webSocketServer.on('connection', (socket, request) => {
    let cleanup: () => void;
    if (request.url === RECOGNITION_PATH) {
      cleanup = attachRecognitionSocket(socket, dependencies, tokenManager);
    } else if (request.url === KEYWORD_PATH) {
      cleanup = attachKeywordSocket(socket, dependencies);
    } else {
      cleanup = attachSynthesisSocket(socket, dependencies, tokenManager);
    }
    cleanups.add(cleanup);
    socket.once('close', () => cleanups.delete(cleanup));
  });

  const onUpgrade = (
    request: Parameters<Server['on']>[1] extends (...args: infer Args) => unknown ? Args[0] : never,
    socket: Socket,
    head: Buffer,
  ) => {
    const path = request.url;
    if (path !== RECOGNITION_PATH && path !== SYNTHESIS_PATH && path !== KEYWORD_PATH) {
      destroyUpgrade(socket);
      return;
    }
    if (!hasAllowedOrigin(request.headers.origin, request.headers.host)) {
      destroyUpgrade(socket);
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  };

  server.on('upgrade', onUpgrade);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    server.removeListener('upgrade', onUpgrade);
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
    for (const socket of webSocketServer.clients) closeSocket(socket, 1001);
    webSocketServer.close();
  };
}
