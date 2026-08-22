import WebSocket from 'ws';
import type { QwenOmniConfig } from './omni-config';
import type { RecognitionSession } from './nls-sessions';

export type QwenOmniRealtimeErrorCode = 'QWEN_OMNI_AUTH' | 'QWEN_OMNI_UPSTREAM';

export class QwenOmniRealtimeError extends Error {
  constructor(readonly code: QwenOmniRealtimeErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'QwenOmniRealtimeError';
  }
}

export type QwenOmniSocket = Pick<
  WebSocket,
  'readyState' | 'send' | 'close' | 'on' | 'once' | 'removeAllListeners'
>;

export type CreateQwenOmniRecognitionSessionInput = {
  config: QwenOmniConfig;
  onTranscript: (text: string, final: boolean) => void;
  createSocket?: (url: string, apiKey: string) => QwenOmniSocket;
  createEventId?: () => string;
};

type ProviderEvent = {
  type?: unknown;
  text?: unknown;
  stash?: unknown;
  transcript?: unknown;
  error?: { code?: unknown; message?: unknown };
};

function eventId(): string {
  return `event_${crypto.randomUUID().replaceAll('-', '')}`;
}

function providerUrl(config: QwenOmniConfig): string {
  const url = new URL(config.baseUrl);
  url.searchParams.set('model', config.model);
  return url.toString();
}

function parseProviderEvent(raw: WebSocket.RawData): ProviderEvent | undefined {
  try {
    const value: unknown = JSON.parse(raw.toString());
    return typeof value === 'object' && value !== null ? value as ProviderEvent : undefined;
  } catch {
    return undefined;
  }
}

function isAuthenticationFailure(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? '');
  return /(?:401|403|auth|api[_ -]?key|forbidden|unauthor)/i.test(message);
}

function providerFailure(event: ProviderEvent): QwenOmniRealtimeError {
  const detail = [event.error?.code, event.error?.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return new QwenOmniRealtimeError(
    isAuthenticationFailure(detail) ? 'QWEN_OMNI_AUTH' : 'QWEN_OMNI_UPSTREAM',
    detail,
  );
}

function defaultSocket(url: string, apiKey: string): QwenOmniSocket {
  return new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

export function createQwenOmniRecognitionSession(
  input: CreateQwenOmniRecognitionSessionInput,
): RecognitionSession {
  let socket: QwenOmniSocket | undefined;
  let ready = false;
  let stopping = false;
  let shutdownCalled = false;
  let completedSettled = false;
  let startSettled = false;
  let resolveCompleted!: (text: string) => void;
  let rejectCompleted!: (error: Error) => void;
  let resolveStarting!: () => void;
  let rejectStarting!: (error: Error) => void;

  const completedText = new Promise<string>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const started = new Promise<void>((resolve, reject) => {
    resolveStarting = resolve;
    rejectStarting = reject;
  });

  const nextEventId = input.createEventId ?? eventId;
  const sendEvent = (event: Record<string, unknown>): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify({ event_id: nextEventId(), ...event }));
      return true;
    } catch {
      return false;
    }
  };

  const settleStartFailure = (error: Error) => {
    if (startSettled) return;
    startSettled = true;
    rejectStarting(error);
  };
  const fail = (error: Error) => {
    settleStartFailure(error);
    if (!completedSettled) {
      completedSettled = true;
      rejectCompleted(error);
    }
  };
  const finish = (text: string) => {
    if (completedSettled) return;
    completedSettled = true;
    resolveCompleted(text);
  };

  const configure = () => sendEvent({
    type: 'session.update',
    session: {
      model: input.config.model,
      modalities: ['text'],
      audio: {
        input: { format: { type: 'pcm', sample_rate: 16_000 } },
      },
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
      turn_detection: null,
      instructions: '你是智慧污水处理厂的实时语音入口。准确转录用户问题，不编造现场数据。',
    },
  });

  const onProviderMessage = (raw: WebSocket.RawData) => {
    const event = parseProviderEvent(raw);
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'session.created') {
      if (!configure()) fail(new QwenOmniRealtimeError('QWEN_OMNI_UPSTREAM'));
      return;
    }
    if (event.type === 'session.updated') {
      ready = true;
      if (!startSettled) {
        startSettled = true;
        resolveStarting();
      }
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const confirmed = typeof event.text === 'string' ? event.text : '';
      const pending = typeof event.stash === 'string' ? event.stash : '';
      const preview = `${confirmed}${pending}`.trim();
      if (preview) input.onTranscript(preview, false);
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : '';
      if (transcript) input.onTranscript(transcript, true);
      finish(transcript);
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed' || event.type === 'error') {
      fail(providerFailure(event));
    }
  };

  return {
    completedText,
    async start() {
      if (socket) return started;
      socket = (input.createSocket ?? defaultSocket)(providerUrl(input.config), input.config.apiKey);
      socket.on('message', onProviderMessage);
      socket.once('unexpected-response', (_request, response) => {
        fail(new QwenOmniRealtimeError(
          response.statusCode === 401 || response.statusCode === 403
            ? 'QWEN_OMNI_AUTH'
            : 'QWEN_OMNI_UPSTREAM',
          `Unexpected server response: ${response.statusCode}`,
        ));
      });
      socket.once('error', (error) => {
        fail(new QwenOmniRealtimeError(
          isAuthenticationFailure(error) ? 'QWEN_OMNI_AUTH' : 'QWEN_OMNI_UPSTREAM',
          error,
        ));
      });
      socket.once('close', () => {
        if (!shutdownCalled && !completedSettled) {
          fail(new QwenOmniRealtimeError('QWEN_OMNI_UPSTREAM'));
        }
      });
      return started;
    },
    sendAudio(bytes) {
      if (!ready || stopping || bytes.length === 0) return false;
      return sendEvent({
        type: 'input_audio_buffer.append',
        audio: bytes.toString('base64'),
      });
    },
    async stop() {
      if (stopping) {
        await completedText;
        return;
      }
      stopping = true;
      if (!ready || !sendEvent({ type: 'input_audio_buffer.commit' })) {
        const error = new QwenOmniRealtimeError('QWEN_OMNI_UPSTREAM');
        fail(error);
        throw error;
      }
      await completedText;
      sendEvent({ type: 'session.finish' });
      socket?.close();
    },
    shutdown() {
      if (shutdownCalled) return;
      shutdownCalled = true;
      ready = false;
      if (!completedSettled) {
        fail(new QwenOmniRealtimeError('QWEN_OMNI_UPSTREAM'));
      }
      socket?.removeAllListeners();
      socket?.close();
    },
  };
}
