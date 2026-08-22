import { expect, it, vi } from 'vitest';
import {
  createRecognitionSession,
  synthesizeSegment,
  type RecognitionSession,
} from '../src/services/voice/nls-sessions';

type EventName = 'started' | 'changed' | 'completed' | 'closed' | 'failed' | 'begin' | 'end' | 'meta' | 'data';
type Handler = (...args: any[]) => void;

class FakeNlsSdk {
  readonly handlers = new Map<EventName, Handler[]>();
  readonly start = vi.fn(async () => undefined);
  readonly shutdown = vi.fn();
  readonly defaultStartParams = vi.fn(() => ({ provider_default: true }));

  on(event: EventName, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  emit(event: EventName, ...args: any[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

class FakeSpeechTranscription extends FakeNlsSdk {
  readonly close = vi.fn(async () => undefined);
  readonly sendAudio = vi.fn(() => true);
}

class FakeSpeechSynthesizer extends FakeNlsSdk {}

function settlementOf<T>(promise: Promise<T>) {
  return Promise.race([
    promise.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    ),
    new Promise<{ status: 'pending' }>((resolve) => {
      setImmediate(() => resolve({ status: 'pending' }));
    }),
  ]);
}

it('keeps final sentences by index and never duplicates interim text', async () => {
  const sdk = new FakeSpeechTranscription();
  const events: Array<{ text: string; final: boolean }> = [];
  const session = createRecognitionSession({
    sdk,
    onTranscript: (text, final) => events.push({ text, final }),
  });

  await session.start();
  sdk.emit('changed', JSON.stringify({ payload: { index: 1, result: '本月总' } }));
  sdk.emit('end', JSON.stringify({ payload: { index: 1, result: '本月总氮稳定' } }));
  sdk.emit('changed', JSON.stringify({ payload: { index: 2, result: '能耗' } }));
  sdk.emit('end', JSON.stringify({ payload: { index: 2, result: '能耗下降' } }));
  sdk.emit('completed', '{}');

  expect(events).toEqual([
    { text: '本月总', final: false },
    { text: '本月总氮稳定', final: true },
    { text: '能耗', final: false },
    { text: '能耗下降', final: true },
  ]);
  await expect(session.completedText).resolves.toBe('本月总氮稳定能耗下降');
});

it('uses explicit PCM recognition settings and delegates session controls', async () => {
  const sdk = new FakeSpeechTranscription();
  const session: RecognitionSession = createRecognitionSession({ sdk, onTranscript: vi.fn() });
  const audio = Buffer.from([1, 2, 3]);

  await session.start();
  expect(sdk.start).toHaveBeenCalledWith({
    provider_default: true,
    format: 'pcm',
    sample_rate: 16000,
    enable_intermediate_result: true,
    enable_punctuation_prediction: true,
    enable_inverse_text_normalization: true,
  }, true, 6000);
  expect(session.sendAudio(audio)).toBe(true);
  expect(sdk.sendAudio).toHaveBeenCalledWith(audio);
  await session.stop();
  expect(sdk.close).toHaveBeenCalledOnce();
  session.shutdown();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
  await expect(session.completedText).resolves.toBe('');
});

it('rejects recognition completion with an internal error when the SDK fails', async () => {
  const sdk = new FakeSpeechTranscription();
  const session = createRecognitionSession({ sdk, onTranscript: vi.fn() });

  sdk.emit('failed', 'provider payload containing a token');

  await expect(session.completedText).rejects.toThrow('ALIYUN_NLS_RECOGNITION_FAILED');
});

it('settles recognition start with an internal error that retains the provider failed payload as its cause', async () => {
  const sdk = new FakeSpeechTranscription();
  sdk.start.mockImplementation(() => new Promise(() => {}));
  const session = createRecognitionSession({ sdk, onTranscript: vi.fn() });
  const starting = session.start();
  const startError = starting.catch((error: unknown) => error);
  const completedError = session.completedText.catch((error: unknown) => error);
  const providerPayload = 'AUTHENTICATION_FAILED provider-token-details';

  sdk.emit('failed', providerPayload);

  for (const error of await Promise.all([startError, completedError])) {
    expect(error).toMatchObject({
      name: 'NlsSessionError',
      code: 'ALIYUN_NLS_RECOGNITION_FAILED',
      cause: providerPayload,
    });
    expect((error as Error).message).toBe('ALIYUN_NLS_RECOGNITION_FAILED');
  }
});

it('retains a raw SDK start rejection as an internal error cause without changing the outward error', async () => {
  const sdk = new FakeSpeechTranscription();
  const providerError = new Error('AUTHENTICATION_FAILED provider-token-details');
  sdk.start.mockRejectedValue(providerError);
  const session = createRecognitionSession({ sdk, onTranscript: vi.fn() });
  const starting = session.start();
  const startError = starting.catch((error: unknown) => error);
  const completedError = session.completedText.catch((error: unknown) => error);

  for (const error of await Promise.all([startError, completedError])) {
    expect(error).toMatchObject({
      name: 'NlsSessionError',
      code: 'ALIYUN_NLS_RECOGNITION_FAILED',
      cause: providerError,
    });
    expect((error as Error).message).toBe('ALIYUN_NLS_RECOGNITION_FAILED');
  }
});

it('preserves the real TaskFailed JSON string through the recognition start cause chain', async () => {
  const sdk = new FakeSpeechTranscription();
  const taskFailedJson = JSON.stringify({
    header: {
      name: 'TaskFailed',
      status: 40_000_001,
      status_text: 'Meta:ACCESS_DENIED:The token is invalid!',
    },
  });
  const providerError = new Error('ALIYUN_NLS_RECOGNITION_FAILED', { cause: taskFailedJson });
  sdk.start.mockRejectedValue(providerError);
  const session = createRecognitionSession({ sdk, onTranscript: vi.fn() });

  const error = await session.start().catch((caught: unknown) => caught);

  expect(error).toMatchObject({
    name: 'NlsSessionError',
    code: 'ALIYUN_NLS_RECOGNITION_FAILED',
    cause: providerError,
  });
  expect((error as Error).cause).toBe(providerError);
  expect(((error as Error).cause as Error).cause).toBe(taskFailedJson);
  await expect(session.completedText).rejects.toBe(error);
});

it('does not leave recognition start pending when shutdown cancels it', async () => {
  const sdk = new FakeSpeechTranscription();
  sdk.start.mockImplementation(() => new Promise(() => {}));
  const session = createRecognitionSession({ sdk, onTranscript: vi.fn() });
  const starting = session.start();
  const completed = session.completedText.then((text) => expect(text).toBe(''));

  session.shutdown();

  await expect(starting).rejects.toThrow('ALIYUN_NLS_RECOGNITION_FAILED');
  await completed;
});

it('rejects pending recognition start and completion when the SDK closes unexpectedly', async () => {
  const sdk = new FakeSpeechTranscription();
  sdk.start.mockImplementation(() => new Promise(() => {}));
  const session = createRecognitionSession({ sdk, onTranscript: vi.fn() });
  const starting = settlementOf(session.start());
  const completed = settlementOf(session.completedText);

  sdk.emit('closed');

  expect(await starting).toMatchObject({
    status: 'rejected',
    error: { name: 'NlsSessionError', code: 'ALIYUN_NLS_RECOGNITION_FAILED' },
  });
  expect(await completed).toMatchObject({
    status: 'rejected',
    error: { name: 'NlsSessionError', code: 'ALIYUN_NLS_RECOGNITION_FAILED' },
  });
});

it('ignores recognition closed after normal completion', async () => {
  const sdk = new FakeSpeechTranscription();
  const onTranscript = vi.fn();
  const session = createRecognitionSession({ sdk, onTranscript });
  sdk.emit('end', JSON.stringify({ payload: { index: 1, result: '识别完成' } }));
  sdk.emit('completed', '{}');

  await expect(session.completedText).resolves.toBe('识别完成');
  sdk.emit('closed');

  await expect(session.completedText).resolves.toBe('识别完成');
  expect(onTranscript).toHaveBeenCalledOnce();
});

it('ignores interim and final recognition events after completion', async () => {
  const sdk = new FakeSpeechTranscription();
  const onTranscript = vi.fn();
  const session = createRecognitionSession({ sdk, onTranscript });
  sdk.emit('end', JSON.stringify({ payload: { index: 1, result: '最终结果' } }));
  sdk.emit('completed', '{}');
  await expect(session.completedText).resolves.toBe('最终结果');
  onTranscript.mockClear();

  sdk.emit('changed', JSON.stringify({ payload: { index: 2, result: '迟到中间结果' } }));
  sdk.emit('end', JSON.stringify({ payload: { index: 2, result: '迟到最终结果' } }));

  expect(onTranscript).not.toHaveBeenCalled();
  await expect(session.completedText).resolves.toBe('最终结果');
});

it('ignores interim and final recognition events after failure', async () => {
  const sdk = new FakeSpeechTranscription();
  const onTranscript = vi.fn();
  const session = createRecognitionSession({ sdk, onTranscript });
  sdk.emit('failed', 'provider payload containing a token');
  await expect(session.completedText).rejects.toThrow('ALIYUN_NLS_RECOGNITION_FAILED');

  sdk.emit('changed', JSON.stringify({ payload: { index: 1, result: '迟到中间结果' } }));
  sdk.emit('end', JSON.stringify({ payload: { index: 1, result: '迟到最终结果' } }));

  expect(onTranscript).not.toHaveBeenCalled();
});

it('ignores interim and final recognition events after shutdown', async () => {
  const sdk = new FakeSpeechTranscription();
  const onTranscript = vi.fn();
  const session = createRecognitionSession({ sdk, onTranscript });
  session.shutdown();
  await expect(session.completedText).resolves.toBe('');

  sdk.emit('changed', JSON.stringify({ payload: { index: 1, result: '迟到中间结果' } }));
  sdk.emit('end', JSON.stringify({ payload: { index: 1, result: '迟到最终结果' } }));

  expect(onTranscript).not.toHaveBeenCalled();
  await expect(session.completedText).resolves.toBe('');
});

it('streams synthesis buffers in order, uses MP3 settings, and shuts down on abort', async () => {
  const sdk = new FakeSpeechSynthesizer();
  const controller = new AbortController();
  const onData = vi.fn();
  const synthesis = synthesizeSegment({
    sdk,
    text: ' 保留的片段文本 ',
    voice: 'xiaoyun',
    signal: controller.signal,
    onData,
  });

  expect(sdk.start).toHaveBeenCalledWith({
    provider_default: true,
    text: ' 保留的片段文本 ',
    voice: 'xiaoyun',
    format: 'mp3',
    sample_rate: 16000,
  }, true, 6000);
  sdk.emit('data', Buffer.from('one'));
  sdk.emit('data', Buffer.from('two'));
  controller.abort();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
  sdk.emit('completed', '{}');
  await expect(synthesis).resolves.toBeUndefined();
  expect(onData.mock.calls.map(([bytes]) => bytes.toString())).toEqual(['one', 'two']);
});

it('settles an aborted synthesis without starting a provider request', async () => {
  const sdk = new FakeSpeechSynthesizer();
  const controller = new AbortController();
  controller.abort();

  await expect(synthesizeSegment({
    sdk,
    text: '取消前不应启动',
    voice: 'xiaoyun',
    signal: controller.signal,
    onData: vi.fn(),
  })).resolves.toBeUndefined();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
  expect(sdk.start).not.toHaveBeenCalled();
});

it('settles an in-flight abort even when SDK shutdown throws', async () => {
  const sdk = new FakeSpeechSynthesizer();
  sdk.shutdown.mockImplementation(() => {
    throw new Error('raw provider shutdown failure');
  });
  const controller = new AbortController();
  const synthesis = synthesizeSegment({
    sdk,
    text: '取消进行中的合成',
    voice: 'xiaoyun',
    signal: controller.signal,
    onData: vi.fn(),
  });
  const settlement = settlementOf(synthesis);

  controller.abort();

  expect(await settlement).toEqual({ status: 'resolved', value: undefined });
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});

it('settles a pre-aborted synthesis even when SDK shutdown throws', async () => {
  const sdk = new FakeSpeechSynthesizer();
  sdk.shutdown.mockImplementation(() => {
    throw new Error('raw provider shutdown failure');
  });
  const controller = new AbortController();
  controller.abort();

  await expect(synthesizeSegment({
    sdk,
    text: '取消前不应启动',
    voice: 'xiaoyun',
    signal: controller.signal,
    onData: vi.fn(),
  })).resolves.toBeUndefined();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
  expect(sdk.start).not.toHaveBeenCalled();
});

it('rejects synthesis with an internal error when the SDK fails', async () => {
  const sdk = new FakeSpeechSynthesizer();
  const controller = new AbortController();
  const synthesis = synthesizeSegment({
    sdk,
    text: '测试',
    voice: 'xiaoyun',
    signal: controller.signal,
    onData: vi.fn(),
  });

  sdk.emit('failed', 'provider payload containing a token');

  await expect(synthesis).rejects.toThrow('ALIYUN_NLS_SYNTHESIS_FAILED');
});

it('rejects synthesis when the SDK closes before completion', async () => {
  const sdk = new FakeSpeechSynthesizer();
  const synthesis = synthesizeSegment({
    sdk,
    text: '测试',
    voice: 'xiaoyun',
    signal: new AbortController().signal,
    onData: vi.fn(),
  });
  const settlement = settlementOf(synthesis);

  sdk.emit('closed');

  expect(await settlement).toMatchObject({
    status: 'rejected',
    error: { name: 'NlsSessionError', code: 'ALIYUN_NLS_SYNTHESIS_FAILED' },
  });
});

it('ignores synthesis closed after normal completion', async () => {
  const sdk = new FakeSpeechSynthesizer();
  const synthesis = synthesizeSegment({
    sdk,
    text: '测试',
    voice: 'xiaoyun',
    signal: new AbortController().signal,
    onData: vi.fn(),
  });
  sdk.emit('completed', '{}');

  await expect(synthesis).resolves.toBeUndefined();
  sdk.emit('closed');

  await expect(synthesis).resolves.toBeUndefined();
});
