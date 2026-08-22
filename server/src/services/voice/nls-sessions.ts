import { SpeechSynthesizer, SpeechTranscription } from 'alibabacloud-nls';
import type { AliyunNlsConfig } from './config';

export type RecognitionSession = {
  completedText: Promise<string>;
  start(): Promise<void>;
  sendAudio(bytes: Buffer): boolean;
  stop(): Promise<void>;
  shutdown(): void;
};

export type CreateRecognitionSessionInput = {
  sdk: SpeechTranscription;
  onTranscript: (text: string, final: boolean) => void;
};

export type SynthesizeSegmentInput = {
  sdk: SpeechSynthesizer;
  text: string;
  voice: string;
  signal: AbortSignal;
  onData: (bytes: Buffer) => void;
};

type NlsPayload = { payload?: { index?: number; result?: string } };
type NlsSessionErrorCode = 'ALIYUN_NLS_RECOGNITION_FAILED' | 'ALIYUN_NLS_SYNTHESIS_FAILED';

export class NlsSessionError extends Error {
  constructor(readonly code: NlsSessionErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'NlsSessionError';
  }
}

function payload(raw: unknown): NlsPayload {
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw) as NlsPayload;
  } catch {
    return {};
  }
}

function sdkConfig(config: AliyunNlsConfig, token: string) {
  return { url: config.gateway, appkey: config.appKey, token };
}

export function createAliyunRecognitionSdk(config: AliyunNlsConfig, token: string): SpeechTranscription {
  return new SpeechTranscription(sdkConfig(config, token));
}

export function createAliyunSynthesisSdk(config: AliyunNlsConfig, token: string): SpeechSynthesizer {
  return new SpeechSynthesizer(sdkConfig(config, token));
}

export function createRecognitionSession(input: CreateRecognitionSessionInput): RecognitionSession {
  const finalSentences = new Map<number, string>();
  let resolveCompleted!: (text: string) => void;
  let rejectCompleted!: (error: Error) => void;
  const completedText = new Promise<string>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  let settled = false;
  let shutdownCalled = false;
  let rejectStarting: ((error: NlsSessionError) => void) | undefined;
  let failure: NlsSessionError | undefined;

  const reject = (cause?: unknown): NlsSessionError => {
    if (settled) return failure ?? new NlsSessionError('ALIYUN_NLS_RECOGNITION_FAILED');
    failure = new NlsSessionError('ALIYUN_NLS_RECOGNITION_FAILED', cause);
    settled = true;
    rejectCompleted(failure);
    rejectStarting?.(failure);
    rejectStarting = undefined;
    return failure;
  };
  const complete = () => {
    if (settled) return;
    settled = true;
    resolveCompleted([...finalSentences.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join(''));
  };

  input.sdk.on('changed', (raw) => {
    if (settled) return;
    input.onTranscript(payload(raw).payload?.result?.trim() ?? '', false);
  });
  input.sdk.on('end', (raw) => {
    if (settled) return;
    const event = payload(raw).payload;
    const text = event?.result?.trim();
    if (typeof event?.index === 'number' && text) {
      finalSentences.set(event.index, text);
      input.onTranscript(text, true);
    }
  });
  input.sdk.on('completed', complete);
  input.sdk.on('failed', reject);
  input.sdk.on('closed', reject);

  return {
    completedText,
    async start() {
      const failedStart = new Promise<never>((_resolve, rejectStart) => {
        rejectStarting = rejectStart;
      });
      try {
        await Promise.race([input.sdk.start({
          ...input.sdk.defaultStartParams(),
          format: 'pcm',
          sample_rate: 16000,
          enable_intermediate_result: true,
          enable_punctuation_prediction: true,
          enable_inverse_text_normalization: true,
        }, true, 6000), failedStart]);
      } catch (error) {
        throw reject(error);
      } finally {
        rejectStarting = undefined;
      }
    },
    sendAudio: (bytes) => input.sdk.sendAudio(bytes),
    async stop() {
      try {
        await Promise.race([
          input.sdk.close(),
          completedText.then(() => undefined),
        ]);
      } catch (error) {
        throw reject(error);
      }
    },
    shutdown() {
      if (shutdownCalled) return;
      shutdownCalled = true;
      try {
        input.sdk.shutdown();
      } finally {
        rejectStarting?.(new NlsSessionError('ALIYUN_NLS_RECOGNITION_FAILED'));
        rejectStarting = undefined;
        complete();
      }
    },
  };
}

export function synthesizeSegment(input: SynthesizeSegmentInput): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => input.signal.removeEventListener('abort', abort);
    const complete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new NlsSessionError('ALIYUN_NLS_SYNTHESIS_FAILED'));
    };
    const abort = () => {
      if (settled) return;
      complete();
      try {
        input.sdk.shutdown();
      } catch {
        // Cancellation is already settled; provider cleanup is best-effort.
      }
    };

    if (input.signal.aborted) {
      abort();
      return;
    }

    input.sdk.on('data', (bytes) => {
      if (!settled) input.onData(bytes as Buffer);
    });
    input.sdk.on('completed', complete);
    input.sdk.on('failed', fail);
    input.sdk.on('closed', fail);
    input.signal.addEventListener('abort', abort, { once: true });
    void input.sdk.start({
      ...input.sdk.defaultStartParams(),
      text: input.text,
      voice: input.voice,
      format: 'mp3',
      sample_rate: 16000,
    }, true, 6000).catch(fail);
  });
}
