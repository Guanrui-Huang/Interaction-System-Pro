import express from 'express';
import { EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:http';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import {
  VOICE_MAX_SPEECH_ANSWER_CHARS,
  VOICE_TEXT_SEGMENT_MAX_CHARS,
} from '../../shared/voice';
import { ReportJobRegistry } from '../src/services/report-job-registry';
import { attachVoiceWebSocketGateway, type VoiceGatewayDependencies } from '../src/services/voice/gateway';
import { SpeechAnswerRegistry } from '../src/services/voice/speech-answer-registry';
import { AliyunNlsTokenError } from '../src/services/voice/token-manager';

const validConfig = {
  success: true as const,
  data: {
    accessKeyId: 'id',
    accessKeySecret: 'secret',
    appKey: 'app',
    gateway: 'wss://nls.test/ws/v1',
    voice: 'xiaoyun',
  },
};

const validOmniConfig = {
  success: true as const,
  data: {
    apiKey: 'dashscope-key',
    workspaceId: 'workspace-1',
    region: 'cn' as const,
    model: 'qwen3.5-omni-flash-realtime',
    baseUrl: 'wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
    speechModel: 'qwen-audio-3.0-tts-plus',
    speechBaseUrl: 'https://workspace-1.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    speechVoice: 'longanlingxin',
  },
};

function taskFailedStartError(status: number, statusText: string): Error {
  return new Error('ALIYUN_NLS_RECOGNITION_FAILED', {
    cause: JSON.stringify({
      header: {
        name: 'TaskFailed',
        status,
        status_text: statusText,
      },
    }),
  });
}

class FakeRecognitionSdk extends EventEmitter {
  audio: Buffer[] = [];
  closeCalls = 0;
  shutdownCalls = 0;

  constructor(
    private readonly startError?: Error,
    private readonly behavior: {
      startPromise?: Promise<void>;
      closePromise?: Promise<void>;
    } = {},
  ) {
    super();
  }

  defaultStartParams() { return {}; }
  async start() {
    if (this.startError) throw this.startError;
    await this.behavior.startPromise;
  }
  sendAudio(bytes: Buffer) { this.audio.push(bytes); return true; }
  async close() {
    this.closeCalls += 1;
    await this.behavior.closePromise;
  }
  shutdown() { this.shutdownCalls += 1; }
  interim(text: string) { this.emit('changed', JSON.stringify({ payload: { result: text } })); }
  final(index: number, text: string) { this.emit('end', JSON.stringify({ payload: { index, result: text } })); }
  complete() { this.emit('completed'); }
  closeUnexpectedly() { this.emit('closed'); }
}

class SdkShapedRecognitionFake {
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  audio: Buffer[] = [];
  shutdownCalls = 0;

  constructor(private readonly startError?: Error) {}

  defaultStartParams() { return {}; }
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  async start() {
    if (this.startError) throw this.startError;
  }
  sendAudio(bytes: Buffer) { this.audio.push(bytes); return true; }
  async close() {}
  shutdown() { this.shutdownCalls += 1; }
}

class FakeSynthesisSdk extends EventEmitter {
  readonly start = vi.fn(async () => undefined);
  readonly shutdown = vi.fn();

  defaultStartParams() { return { provider_default: true }; }
  data(bytes: Buffer) { this.emit('data', bytes); }
  complete() { this.emit('completed', '{}'); }
  fail(error = new Error('provider failed')) { this.emit('failed', error); }
}

type VoiceTestServer = {
  url: string;
  close: () => Promise<void>;
  detach: () => void;
  dependencies: VoiceGatewayDependencies;
};

const TEST_TIMEOUT_MS = 2_000;
const RACE_ATTEMPTS = 20;
const activeServers = new Set<VoiceTestServer>();

const voiceTest = (name: string, test: () => Promise<void>) => it(name, test, TEST_TIMEOUT_MS);

async function startVoiceTestServer(options: {
  config?: VoiceGatewayDependencies['config'];
  recognitionConfig?: NonNullable<VoiceGatewayDependencies['recognitionConfig']>;
  synthesisConfig?: NonNullable<VoiceGatewayDependencies['synthesisConfig']>;
  createRealtimeRecognitionSession?: NonNullable<VoiceGatewayDependencies['createRealtimeRecognitionSession']>;
  synthesizeSpeech?: NonNullable<VoiceGatewayDependencies['synthesizeSpeech']>;
  fakeRecognition?: FakeRecognitionSdk;
  recognitionSessions?: FakeRecognitionSdk[];
  speechAnswers?: SpeechAnswerRegistry;
  reportRegistry?: ReportJobRegistry;
  synthesisSessions?: FakeSynthesisSdk[];
  maxRecordingMs?: number;
  tokenManager?: VoiceGatewayDependencies['tokenManager'];
  timeouts?: VoiceGatewayDependencies['timeouts'];
  synthesisLimits?: VoiceGatewayDependencies['synthesisLimits'];
} = {}): Promise<VoiceTestServer> {
  const app = express();
  const server = createServer(app);
  const reportRegistry = options.reportRegistry ?? new ReportJobRegistry({ createId: () => 'report-1' });
  if (!options.reportRegistry) reportRegistry.create({ question: '测试汇报', originPage: 'overview' });
  const dependencies: VoiceGatewayDependencies = {
    config: options.config ?? validConfig,
    ...(options.recognitionConfig === undefined ? {} : { recognitionConfig: options.recognitionConfig }),
    ...(options.synthesisConfig === undefined ? {} : { synthesisConfig: options.synthesisConfig }),
    speechAnswers: options.speechAnswers ?? new SpeechAnswerRegistry({ createId: () => 'answer-1' }),
    reportRegistry,
    tokenManager: options.tokenManager
      ?? { getToken: vi.fn().mockResolvedValue({ value: 'token', expiresAtMs: Date.now() + 60_000 }) } as never,
    createRecognitionSdk: vi.fn(() => options.recognitionSessions?.shift() ?? options.fakeRecognition ?? new FakeRecognitionSdk()) as never,
    ...(options.createRealtimeRecognitionSession === undefined
      ? {}
      : { createRealtimeRecognitionSession: options.createRealtimeRecognitionSession }),
    ...(options.synthesizeSpeech === undefined
      ? {}
      : { synthesizeSpeech: options.synthesizeSpeech }),
    createSynthesisSdk: vi.fn(() => options.synthesisSessions?.shift() ?? new FakeSynthesisSdk()) as never,
    maxRecordingMs: options.maxRecordingMs,
    timeouts: options.timeouts,
    synthesisLimits: options.synthesisLimits,
  };
  const detach = attachVoiceWebSocketGateway(server, dependencies);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_MISSING');
  let closed = false;
  const voiceServer: VoiceTestServer = {
    url: `http://127.0.0.1:${address.port}`,
    dependencies,
    detach,
    close: async () => {
      if (closed) return;
      closed = true;
      activeServers.delete(voiceServer);
      detach();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
  activeServers.add(voiceServer);
  return voiceServer;
}

async function expectMessage(client: WebSocket, expected: Record<string, unknown>) {
  const [data, isBinary] = await once(client, 'message') as [WebSocket.RawData, boolean];
  expect(isBinary).toBe(false);
  expect(JSON.parse(data.toString())).toMatchObject(expected);
}

async function closeClient(client: WebSocket) {
  if (client.readyState === WebSocket.CLOSED) return;
  client.close();
  await once(client, 'close');
}

async function expectNarrationLeaseReleasedBeforeClose({
  server,
  speechId,
  synthesis,
  stop,
  verifyAfterClose,
}: {
  server: VoiceTestServer;
  speechId: string;
  synthesis: FakeSynthesisSdk;
  stop: (client: WebSocket) => void;
  verifyAfterClose?: () => void;
}) {
  const endActivity = vi.spyOn(server.dependencies.reportRegistry, 'endActivity');
  const client = new WebSocket(`${server.url.replace('http', 'ws')}/api/voice/synthesize`, { origin: server.url });
  const frames: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
  client.on('message', (data, isBinary) => frames.push({ data, isBinary }));
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId }));
  await vi.waitFor(() => expect(synthesis.start).toHaveBeenCalledOnce());
  const closed = once(client, 'close');
  stop(client);
  await closed;
  expect(endActivity).toHaveBeenCalledTimes(1);
  verifyAfterClose?.();
  expect(frames.map(({ data, isBinary }) => ({
    isBinary,
    data: isBinary ? data.toString() : JSON.parse(data.toString()),
  }))).toEqual([
    { isBinary: false, data: { type: 'ready', segmentCount: 1 } },
    { isBinary: false, data: { type: 'segment-start', index: 0 } },
  ]);
  await server.close();
  expect(endActivity).toHaveBeenCalledTimes(1);
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...activeServers].map(({ close }) => close()));
});

voiceTest('streams interim and final transcript events and completes once', async () => {
  const fakeRecognition = new FakeRecognitionSdk();
  const { url, close } = await startVoiceTestServer({ fakeRecognition });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16000 }));
  await expectMessage(client, { type: 'ready' });
  client.send(Buffer.from([0, 0, 1, 0]));
  fakeRecognition.interim('总氮');
  await expectMessage(client, { type: 'transcript', text: '总氮', final: false });
  fakeRecognition.final(1, '总氮稳定');
  await expectMessage(client, { type: 'transcript', text: '总氮稳定', final: true });
  client.send(JSON.stringify({ type: 'stop' }));
  fakeRecognition.complete();
  await expectMessage(client, { type: 'completed', text: '总氮稳定' });
  expect(fakeRecognition.audio).toEqual([Buffer.from([0, 0, 1, 0])]);
  await closeClient(client);
  await close();
});

voiceTest('uses the configured Qwen3.5 Omni realtime session while preserving the browser protocol', async () => {
  let onTranscript: ((text: string, final: boolean) => void) | undefined;
  let resolveCompleted!: (text: string) => void;
  const completedText = new Promise<string>((resolve) => {
    resolveCompleted = resolve;
  });
  const realtimeSession = {
    completedText,
    start: vi.fn(async () => undefined),
    sendAudio: vi.fn(() => true),
    stop: vi.fn(async () => undefined),
    shutdown: vi.fn(),
  };
  const createRealtimeRecognitionSession = vi.fn((input: Parameters<NonNullable<VoiceGatewayDependencies['createRealtimeRecognitionSession']>>[0]) => {
    onTranscript = input.onTranscript;
    return realtimeSession;
  });
  const { url, close, dependencies } = await startVoiceTestServer({
    recognitionConfig: validOmniConfig,
    createRealtimeRecognitionSession,
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));
  await expectMessage(client, { type: 'ready' });

  client.send(Buffer.from([0, 1, 2, 3]));
  await vi.waitFor(() => expect(realtimeSession.sendAudio).toHaveBeenCalledWith(Buffer.from([0, 1, 2, 3])));
  const interimMessage = expectMessage(client, { type: 'transcript', text: '分析今天的总氮', final: false });
  onTranscript?.('分析今天的总氮', false);
  await interimMessage;

  client.send(JSON.stringify({ type: 'stop' }));
  await vi.waitFor(() => expect(realtimeSession.stop).toHaveBeenCalledOnce());
  const finalMessage = expectMessage(client, { type: 'transcript', text: '分析今天的总氮。', final: true });
  onTranscript?.('分析今天的总氮。', true);
  await finalMessage;
  const completedMessage = expectMessage(client, { type: 'completed', text: '分析今天的总氮。' });
  resolveCompleted('分析今天的总氮。');
  await completedMessage;
  expect(createRealtimeRecognitionSession).toHaveBeenCalledWith(expect.objectContaining({
    config: validOmniConfig.data,
  }));
  expect(dependencies.createRecognitionSdk).not.toHaveBeenCalled();

  await closeClient(client);
  await close();
});

voiceTest('reports missing configuration without creating an upstream session', async () => {
  const { url, close, dependencies } = await startVoiceTestServer({ config: { success: false, missing: ['ALIYUN_NLS_APP_KEY'] } });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16000 }));
  await expectMessage(client, { type: 'error', code: 'VOICE_NOT_CONFIGURED' });
  expect(dependencies.createRecognitionSdk).not.toHaveBeenCalled();
  await closeClient(client);
  await close();
});

voiceTest('rejects invalid starts and binary audio before ready', async () => {
  const { url, close } = await startVoiceTestServer();
  const invalid = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(invalid, 'open');
  invalid.send(JSON.stringify({ type: 'start', format: 'wav', sampleRate: 44_100 }));
  await expectMessage(invalid, { type: 'error', code: 'VOICE_INVALID_AUDIO' });
  await closeClient(invalid);

  const earlyAudio = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(earlyAudio, 'open');
  earlyAudio.send(Buffer.from([0]));
  await expectMessage(earlyAudio, { type: 'error', code: 'VOICE_INVALID_AUDIO' });
  await closeClient(earlyAudio);
  await close();
});

voiceTest('gracefully completes recognized text at the recording limit while ignoring trailing browser PCM', async () => {
  const fakeRecognition = new FakeRecognitionSdk();
  const { url, close } = await startVoiceTestServer({ fakeRecognition, maxRecordingMs: 25 });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16000 }));
  await expectMessage(client, { type: 'ready' });
  fakeRecognition.final(0, '超时文本');
  await vi.waitFor(() => expect(fakeRecognition.closeCalls).toBe(1), { timeout: 1_000 });
  client.send(Buffer.from([0]));
  fakeRecognition.complete();
  await expectMessage(client, { type: 'completed', text: '超时文本' });
  await once(client, 'close');
  await close();
});

voiceTest('reports and closes immediately when recognition closes after ready', async () => {
  const fakeRecognition = new FakeRecognitionSdk();
  const { url, close } = await startVoiceTestServer({ fakeRecognition });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));
  await expectMessage(client, { type: 'ready' });

  fakeRecognition.closeUnexpectedly();

  await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE' });
  await once(client, 'close');
  await vi.waitFor(() => expect(fakeRecognition.shutdownCalls).toBe(1));
  await close();
});

voiceTest('races a hanging recognition stop against a post-ready session failure', async () => {
  for (let attempt = 0; attempt < RACE_ATTEMPTS; attempt += 1) {
    const fakeRecognition = new FakeRecognitionSdk(undefined, { closePromise: new Promise(() => undefined) });
    const { url, close } = await startVoiceTestServer({ fakeRecognition });
    const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
    await once(client, 'open');
    client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));
    await expectMessage(client, { type: 'ready' });
    client.send(JSON.stringify({ type: 'stop' }));

    fakeRecognition.closeUnexpectedly();

    await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE' });
    await once(client, 'close');
    expect(fakeRecognition.shutdownCalls).toBe(1);
    await close();
  }
});

voiceTest('reports no speech after a graceful recording-limit stop without inventing a transcript', async () => {
  const fakeRecognition = new FakeRecognitionSdk();
  const { url, close } = await startVoiceTestServer({ fakeRecognition, maxRecordingMs: 25 });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));
  await expectMessage(client, { type: 'ready' });

  await vi.waitFor(() => expect(fakeRecognition.closeCalls).toBe(1), { timeout: 1_000 });
  fakeRecognition.complete();

  await expectMessage(client, { type: 'error', code: 'VOICE_NO_SPEECH' });
  await once(client, 'close');
  expect(fakeRecognition.audio).toEqual([]);
  await close();
});

voiceTest('rejects a browser Origin other than the loopback server origin', async () => {
  const { url, close } = await startVoiceTestServer();
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: 'http://example.invalid' });
  let opened = false;
  client.once('open', () => {
    opened = true;
  });
  const terminal = new Promise<{ type: 'error' | 'close'; code?: number }>((resolve) => {
    const onError = () => {
      client.removeListener('close', onClose);
      resolve({ type: 'error' });
    };
    const onClose = (code: number) => {
      client.removeListener('error', onError);
      resolve({ type: 'close', code });
    };
    client.once('error', onError);
    client.once('close', onClose);
  });

  const result = await terminal;
  expect(opened).toBe(false);
  if (result.type === 'close') expect(result.code).toBe(1006);
  await close();
});

voiceTest('accepts only the two exact voice gateway paths', async () => {
  const { url, close } = await startVoiceTestServer();
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize/extra`, { origin: url });
  const error = new Promise<void>((resolve) => client.once('error', () => resolve()));
  const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)));
  await error;
  const code = await closed;
  expect(code).toBe(1006);
  await close();
});

voiceTest('accepts a same-origin loopback Vite proxy request even when its backend target differs', async () => {
  const { url, close } = await startVoiceTestServer();
  const frontendOrigin = 'http://127.0.0.1:5173';
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, {
    origin: frontendOrigin,
    headers: { host: '127.0.0.1:5173' },
  });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));
  await expectMessage(client, { type: 'ready' });
  await closeClient(client);
  await close();
});

voiceTest('rejects an incoming message above 64 KiB before creating a provider SDK', async () => {
  const { url, close, dependencies } = await startVoiceTestServer();
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  client.once('error', () => undefined);
  const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)));
  await once(client, 'open');
  client.send(Buffer.alloc((64 * 1024) + 1));

  await expect(closed).resolves.toBe(1009);
  expect(dependencies.createRecognitionSdk).not.toHaveBeenCalled();
  await close();
});

voiceTest('retries only a pre-ready authentication failure with a forced token refresh', async () => {
  const rejected = new FakeRecognitionSdk(new Error('AUTHENTICATION_FAILED'));
  const accepted = new FakeRecognitionSdk();
  const { url, close, dependencies } = await startVoiceTestServer({
    recognitionSessions: [rejected, accepted],
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16000 }));
  await expectMessage(client, { type: 'ready' });
  client.send(Buffer.from([4, 2]));

  await vi.waitFor(() => expect(accepted.audio).toEqual([Buffer.from([4, 2])]));
  expect(rejected.audio).toEqual([]);
  expect(dependencies.createRecognitionSdk).toHaveBeenCalledTimes(2);
  expect((dependencies.tokenManager!.getToken as ReturnType<typeof vi.fn>).mock.calls).toEqual([[false], [true]]);

  await closeClient(client);
  await close();
});

for (const [label, startError] of [
  ['WebSocket 401', new Error('Unexpected server response: 401')],
  ['WebSocket 403', new Error('Unexpected server response: 403')],
  ['nested SDK TaskFailed auth code', new Error('TaskFailed', {
    cause: { code: 'InvalidAccessKeyId.NotFound', statusCode: 403 },
  })],
  ['NLS TaskFailed 40000001 JSON', taskFailedStartError(
    40_000_001,
    'Meta:ACCESS_DENIED:The token is invalid!',
  )],
  ['NLS TaskFailed 403 JSON', taskFailedStartError(
    403,
    'Gateway:ACCESS_DENIED:The token is expired!',
  )],
] as const) {
  voiceTest(`forces exactly one token refresh for a real ${label} pre-ready auth failure`, async () => {
    const rejected = new FakeRecognitionSdk(startError);
    const accepted = new FakeRecognitionSdk();
    const { url, close, dependencies } = await startVoiceTestServer({
      recognitionSessions: [rejected, accepted],
    });
    const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
    await once(client, 'open');
    client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));

    await expectMessage(client, { type: 'ready' });
    expect(dependencies.createRecognitionSdk).toHaveBeenCalledTimes(2);
    expect((dependencies.tokenManager!.getToken as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [false],
      [true],
    ]);
    await closeClient(client);
    await close();
  });
}

for (const status of [429, 500]) {
  voiceTest(`does not retry a non-auth WebSocket HTTP ${status} start failure`, async () => {
    const rejected = new FakeRecognitionSdk(new Error(`Unexpected server response: ${status}`));
    const { url, close, dependencies } = await startVoiceTestServer({
      recognitionSessions: [rejected],
    });
    const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
    await once(client, 'open');
    client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));

    await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE' });
    await once(client, 'close');
    expect(dependencies.createRecognitionSdk).toHaveBeenCalledOnce();
    expect((dependencies.tokenManager!.getToken as ReturnType<typeof vi.fn>).mock.calls).toEqual([[false]]);
    await close();
  });
}

for (const [label, startError] of [
  ['non-auth NLS TaskFailed JSON', taskFailedStartError(40_000_005, 'TOO_MANY_REQUESTS')],
  ['non-whitelisted NLS TaskFailed 401 JSON', taskFailedStartError(401, 'INVALID_REQUEST')],
  ['malformed TaskFailed JSON', new Error('ALIYUN_NLS_RECOGNITION_FAILED', {
    cause: '{"header":{"name":"TaskFailed","status":40000001',
  })],
  ['oversized TaskFailed JSON', new Error('ALIYUN_NLS_RECOGNITION_FAILED', {
    cause: JSON.stringify({
      header: { name: 'TaskFailed', status: 40_000_001 },
      padding: 'x'.repeat((16 * 1024) + 1),
    }),
  })],
] as const) {
  voiceTest(`keeps ${label} unavailable without a token refresh`, async () => {
    const rejected = new FakeRecognitionSdk(startError);
    const { url, close, dependencies } = await startVoiceTestServer({
      recognitionSessions: [rejected],
    });
    const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
    await once(client, 'open');
    client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));

    await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE' });
    await once(client, 'close');
    expect(dependencies.createRecognitionSdk).toHaveBeenCalledOnce();
    expect((dependencies.tokenManager!.getToken as ReturnType<typeof vi.fn>).mock.calls).toEqual([[false]]);
    await close();
  });
}

voiceTest('retries an auth start rejection from an SDK-shaped fake without EventEmitter-only methods', async () => {
  const rejected = new SdkShapedRecognitionFake(new Error('AUTHENTICATION_FAILED provider-token-details'));
  const accepted = new SdkShapedRecognitionFake();
  expect('once' in rejected).toBe(false);
  expect('removeListener' in rejected).toBe(false);
  const { url, close, dependencies } = await startVoiceTestServer({
    recognitionSessions: [rejected, accepted] as never,
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));
  await expectMessage(client, { type: 'ready' });
  client.send(Buffer.from([4, 2]));

  await vi.waitFor(() => expect(accepted.audio).toEqual([Buffer.from([4, 2])]));
  expect(rejected.audio).toEqual([]);
  expect(dependencies.createRecognitionSdk).toHaveBeenCalledTimes(2);
  expect((dependencies.tokenManager!.getToken as ReturnType<typeof vi.fn>).mock.calls).toEqual([[false], [true]]);
  await closeClient(client);
  await close();
});

voiceTest('surfaces a pre-ready timeout without a forced token refresh retry', async () => {
  const timedOut = new FakeRecognitionSdk(new Error('UPSTREAM_TIMEOUT'));
  const { url, close, dependencies } = await startVoiceTestServer({ recognitionSessions: [timedOut] });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));

  await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_TIMEOUT' });
  expect(dependencies.createRecognitionSdk).toHaveBeenCalledTimes(1);
  expect((dependencies.tokenManager!.getToken as ReturnType<typeof vi.fn>).mock.calls).toEqual([[false]]);
  await once(client, 'close');
  await close();
});

voiceTest('surfaces a pre-ready unavailable failure without a forced token refresh retry', async () => {
  const unavailable = new FakeRecognitionSdk(new Error('CONNECTION_REFUSED'));
  const { url, close, dependencies } = await startVoiceTestServer({ recognitionSessions: [unavailable] });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));

  await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE' });
  expect(dependencies.createRecognitionSdk).toHaveBeenCalledTimes(1);
  expect((dependencies.tokenManager!.getToken as ReturnType<typeof vi.fn>).mock.calls).toEqual([[false]]);
  await once(client, 'close');
  await close();
});

voiceTest('does not retry a typed token transport failure as authentication', async () => {
  const getToken = vi.fn().mockRejectedValue(new AliyunNlsTokenError('ALIYUN_NLS_TOKEN_UNAVAILABLE'));
  const { url, close, dependencies } = await startVoiceTestServer({
    tokenManager: { getToken } as never,
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));

  await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE' });
  await once(client, 'close');
  expect(getToken.mock.calls).toEqual([[false]]);
  expect(dependencies.createRecognitionSdk).not.toHaveBeenCalled();
  await close();
});

voiceTest('retries one typed token authentication failure and no more', async () => {
  const getToken = vi.fn()
    .mockRejectedValueOnce(new AliyunNlsTokenError('ALIYUN_NLS_TOKEN_AUTH'))
    .mockResolvedValueOnce({ value: 'fresh-token', expiresAtMs: Date.now() + 60_000 });
  const { url, close, dependencies } = await startVoiceTestServer({
    tokenManager: { getToken } as never,
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));

  await expectMessage(client, { type: 'ready' });
  expect(getToken.mock.calls).toEqual([[false], [true]]);
  expect(dependencies.createRecognitionSdk).toHaveBeenCalledOnce();
  await closeClient(client);
  await close();
});

voiceTest('times out a never-settling token request without creating an SDK', async () => {
  const getToken = vi.fn().mockReturnValue(new Promise(() => undefined));
  const { url, close, dependencies } = await startVoiceTestServer({
    tokenManager: { getToken } as never,
    timeouts: { tokenMs: 20 },
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));

  await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_TIMEOUT' });
  await once(client, 'close');
  expect(getToken).toHaveBeenCalledOnce();
  expect(dependencies.createRecognitionSdk).not.toHaveBeenCalled();
  await close();
});

voiceTest('times out and shuts down a never-settling recognition start', async () => {
  const fakeRecognition = new FakeRecognitionSdk(undefined, { startPromise: new Promise(() => undefined) });
  const { url, close } = await startVoiceTestServer({
    fakeRecognition,
    timeouts: { recognitionStartMs: 20 },
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));

  await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_TIMEOUT' });
  await once(client, 'close');
  expect(fakeRecognition.shutdownCalls).toBe(1);
  await close();
});

voiceTest('times out and shuts down a never-settling recognition stop', async () => {
  const fakeRecognition = new FakeRecognitionSdk(undefined, { closePromise: new Promise(() => undefined) });
  const { url, close } = await startVoiceTestServer({
    fakeRecognition,
    timeouts: { recognitionStopMs: 20 },
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));
  await expectMessage(client, { type: 'ready' });
  client.send(JSON.stringify({ type: 'stop' }));

  await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_TIMEOUT' });
  await once(client, 'close');
  expect(fakeRecognition.closeCalls).toBe(1);
  expect(fakeRecognition.shutdownCalls).toBe(1);
  await close();
});

voiceTest('cleans up a recognition session once after browser disconnect', async () => {
  const fakeRecognition = new FakeRecognitionSdk();
  const { url, close } = await startVoiceTestServer({ fakeRecognition });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/recognize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16000 }));
  await expectMessage(client, { type: 'ready' });
  await closeClient(client);
  await vi.waitFor(() => expect(fakeRecognition.shutdownCalls).toBe(1), { timeout: 1_000 });
  await close();
  expect(fakeRecognition.shutdownCalls).toBe(1);
});

voiceTest('rejects unknown and expired synthesis answers without creating an SDK', async () => {
  let now = 0;
  const speechAnswers = new SpeechAnswerRegistry({
    ttlMs: 1,
    now: () => now,
    createId: () => 'expired-answer',
  });
  const expiredSpeechId = speechAnswers.register('report-1', '已过期的回答');
  now = 2;
  const { url, close, dependencies } = await startVoiceTestServer({ speechAnswers });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  await once(client, 'open');

  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId: 'missing-answer' }));
  await expectMessage(client, { type: 'error', code: 'VOICE_ANSWER_NOT_FOUND' });
  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId: expiredSpeechId }));
  await expectMessage(client, { type: 'error', code: 'VOICE_ANSWER_NOT_FOUND' });

  expect(dependencies.createSynthesisSdk).not.toHaveBeenCalled();
  await closeClient(client);
  await close();
});

voiceTest('rejects cross-report and expired-report synthesis with one ownership-safe response', async () => {
  const ids = ['report-a', 'report-b'];
  let now = 0;
  const reportRegistry = new ReportJobRegistry({
    createId: () => ids.shift()!,
    now: () => now,
    slidingTtlMs: 1,
  });
  reportRegistry.create({ question: 'A', originPage: 'overview' });
  reportRegistry.create({ question: 'B', originPage: 'overview' });
  const speechAnswers = new SpeechAnswerRegistry({ createId: () => 'protected-speech', now: () => now });
  const speechId = speechAnswers.register('report-a', '受保护讲解文本');
  const { url, close, dependencies } = await startVoiceTestServer({ reportRegistry, speechAnswers });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  await once(client, 'open');

  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-b', speechId }));
  await expectMessage(client, {
    type: 'error',
    code: 'VOICE_ANSWER_NOT_FOUND',
    message: '语音答案已过期，请重新生成 AI 分析。',
  });

  now = 2;
  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-a', speechId }));
  await expectMessage(client, {
    type: 'error',
    code: 'VOICE_ANSWER_NOT_FOUND',
    message: '语音答案已过期，请重新生成 AI 分析。',
  });
  expect(dependencies.createSynthesisSdk).not.toHaveBeenCalled();
  await closeClient(client);
  await close();
});

voiceTest('requires strict non-empty report and speech identifiers', async () => {
  const { url, close, dependencies } = await startVoiceTestServer();
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  await once(client, 'open');

  for (const invalid of [
    { type: 'synthesize', reportId: '', speechId: 'answer-1' },
    { type: 'synthesize', reportId: 'report-1', speechId: '   ' },
    { type: 'synthesize', reportId: 'report-1', speechId: 'answer-1', text: '不得上传' },
  ]) {
    client.send(JSON.stringify(invalid));
    await expectMessage(client, { type: 'error', code: 'VOICE_INVALID_AUDIO' });
  }

  expect(dependencies.createSynthesisSdk).not.toHaveBeenCalled();
  await closeClient(client);
  await close();
});

voiceTest('streams registry-backed answer segments as ordered MP3 frames', async () => {
  const answer = `${'甲'.repeat(279)}。${'乙'.repeat(3)}`;
  const speechAnswers = new SpeechAnswerRegistry({ createId: () => 'answer-1' });
  const speechId = speechAnswers.register('report-1', answer);
  const first = new FakeSynthesisSdk();
  const second = new FakeSynthesisSdk();
  const { url, close, dependencies } = await startVoiceTestServer({
    speechAnswers,
    synthesisSessions: [first, second],
  });
  const endActivity = vi.spyOn(dependencies.reportRegistry, 'endActivity');
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  const frames: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
  client.on('message', (data, isBinary) => frames.push({ data, isBinary }));
  await once(client, 'open');
  const closed = once(client, 'close');

  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId }));
  await vi.waitFor(() => expect(frames).toHaveLength(2));
  expect(first.start).toHaveBeenCalledWith({
    provider_default: true,
    text: `${'甲'.repeat(279)}。`,
    voice: 'xiaoyun',
    format: 'mp3',
    sample_rate: 16_000,
  }, true, 6000);
  first.data(Buffer.from('first-mp3'));
  await vi.waitFor(() => expect(frames).toHaveLength(3));
  first.complete();
  await vi.waitFor(() => expect(frames).toHaveLength(5));
  expect(dependencies.createSynthesisSdk).toHaveBeenCalledTimes(2);
  expect(second.start).toHaveBeenCalledWith({
    provider_default: true,
    text: '乙'.repeat(3),
    voice: 'xiaoyun',
    format: 'mp3',
    sample_rate: 16_000,
  }, true, 6000);
  second.data(Buffer.from('second-mp3'));
  await vi.waitFor(() => expect(frames).toHaveLength(6));
  second.complete();
  await vi.waitFor(() => expect(frames).toHaveLength(8));
  await closed;

  expect(first.shutdown).toHaveBeenCalledOnce();
  expect(second.shutdown).toHaveBeenCalledOnce();
  expect(endActivity).toHaveBeenCalledTimes(1);
  expect(frames.map(({ data, isBinary }) => ({
    isBinary,
    data: isBinary ? data.toString() : JSON.parse(data.toString()),
  }))).toEqual([
    { isBinary: false, data: { type: 'ready', segmentCount: 2 } },
    { isBinary: false, data: { type: 'segment-start', index: 0 } },
    { isBinary: true, data: 'first-mp3' },
    { isBinary: false, data: { type: 'segment-end', index: 0 } },
    { isBinary: false, data: { type: 'segment-start', index: 1 } },
    { isBinary: true, data: 'second-mp3' },
    { isBinary: false, data: { type: 'segment-end', index: 1 } },
    { isBinary: false, data: { type: 'completed' } },
  ]);
  await close();
});

voiceTest('streams registry-backed narration through dedicated DashScope TTS without using NLS', async () => {
  const speechAnswers = new SpeechAnswerRegistry({ createId: () => 'answer-omni' });
  const speechId = speechAnswers.register('report-1', '请逐字朗读现场结论。');
  const synthesizeSpeech = vi.fn(async ({ text }: { text: string }) => (
    Buffer.from(`tts-wav:${text}`)
  )) as unknown as NonNullable<VoiceGatewayDependencies['synthesizeSpeech']>;
  const { url, close, dependencies } = await startVoiceTestServer({
    speechAnswers,
    synthesisConfig: validOmniConfig,
    synthesizeSpeech,
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  const frames: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
  client.on('message', (data, isBinary) => frames.push({ data, isBinary }));
  await once(client, 'open');
  const closed = once(client, 'close');

  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId }));
  await closed;

  expect(synthesizeSpeech).toHaveBeenCalledWith(expect.objectContaining({
    config: validOmniConfig.data,
    text: '请逐字朗读现场结论。',
    maxAudioBytes: expect.any(Number),
    signal: expect.any(AbortSignal),
  }));
  expect(dependencies.createSynthesisSdk).not.toHaveBeenCalled();
  expect(frames.map(({ data, isBinary }) => ({
    isBinary,
    data: isBinary ? data.toString() : JSON.parse(data.toString()),
  }))).toEqual([
    { isBinary: false, data: { type: 'ready', segmentCount: 1 } },
    { isBinary: false, data: { type: 'segment-start', index: 0 } },
    { isBinary: true, data: 'tts-wav:请逐字朗读现场结论。' },
    { isBinary: false, data: { type: 'segment-end', index: 0 } },
    { isBinary: false, data: { type: 'completed' } },
  ]);
  await close();
});

voiceTest('rejects more than 64 answer segments before creating a billable synthesis SDK', async () => {
  const oversizedAnswers = {
    get: vi.fn(() => '甲'.repeat(VOICE_MAX_SPEECH_ANSWER_CHARS + 1)),
  } as unknown as SpeechAnswerRegistry;
  const { url, close, dependencies } = await startVoiceTestServer({ speechAnswers: oversizedAnswers });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId: 'oversized-answer' }));

  await expectMessage(client, { type: 'error', code: 'VOICE_LIMIT_EXCEEDED' });
  await once(client, 'close');
  expect(dependencies.createSynthesisSdk).not.toHaveBeenCalled();
  await close();
});

voiceTest('stops synthesis before forwarding a segment beyond the server byte cap', async () => {
  const speechAnswers = new SpeechAnswerRegistry({ createId: () => 'answer-1' });
  const speechId = speechAnswers.register('report-1', '单段字节限制');
  const synthesis = new FakeSynthesisSdk();
  const { url, close, dependencies } = await startVoiceTestServer({
    speechAnswers,
    synthesisSessions: [synthesis],
    synthesisLimits: { segmentBytes: 4, totalBytes: 8 },
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  const binaryFrames: WebSocket.RawData[] = [];
  client.on('message', (data, isBinary) => {
    if (isBinary) binaryFrames.push(data);
  });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId }));
  await vi.waitFor(() => expect(synthesis.start).toHaveBeenCalledOnce());

  synthesis.data(Buffer.alloc(5));

  await expectMessage(client, { type: 'error', code: 'VOICE_LIMIT_EXCEEDED' });
  await once(client, 'close');
  expect(binaryFrames).toEqual([]);
  expect(synthesis.shutdown).toHaveBeenCalledOnce();
  expect(dependencies.createSynthesisSdk).toHaveBeenCalledOnce();
  await close();
});

voiceTest('stops before another segment when cumulative provider bytes exceed the total cap', async () => {
  const answer = `${'甲'.repeat(VOICE_TEXT_SEGMENT_MAX_CHARS)}${'乙'.repeat(VOICE_TEXT_SEGMENT_MAX_CHARS)}丙`;
  const speechAnswers = new SpeechAnswerRegistry({ createId: () => 'answer-1' });
  const speechId = speechAnswers.register('report-1', answer);
  const first = new FakeSynthesisSdk();
  const second = new FakeSynthesisSdk();
  const neverBilled = new FakeSynthesisSdk();
  const { url, close, dependencies } = await startVoiceTestServer({
    speechAnswers,
    synthesisSessions: [first, second, neverBilled],
    synthesisLimits: { segmentBytes: 4, totalBytes: 6 },
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId }));
  await vi.waitFor(() => expect(first.start).toHaveBeenCalledOnce());
  first.data(Buffer.alloc(4));
  first.complete();
  await vi.waitFor(() => expect(second.start).toHaveBeenCalledOnce());

  second.data(Buffer.alloc(3));

  await expectMessage(client, { type: 'error', code: 'VOICE_LIMIT_EXCEEDED' });
  await once(client, 'close');
  expect(dependencies.createSynthesisSdk).toHaveBeenCalledTimes(2);
  expect(neverBilled.start).not.toHaveBeenCalled();
  expect(second.shutdown).toHaveBeenCalledOnce();
  await close();
});

voiceTest('does not start or bill another segment after the prior segment exactly exhausts total bytes', async () => {
  const answer = `${'甲'.repeat(VOICE_TEXT_SEGMENT_MAX_CHARS)}乙`;
  const speechAnswers = new SpeechAnswerRegistry({ createId: () => 'answer-1' });
  const speechId = speechAnswers.register('report-1', answer);
  const first = new FakeSynthesisSdk();
  const neverStarted = new FakeSynthesisSdk();
  const { url, close, dependencies } = await startVoiceTestServer({
    speechAnswers,
    synthesisSessions: [first, neverStarted],
    synthesisLimits: { segmentBytes: 4, totalBytes: 4 },
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  const controls: Array<Record<string, unknown>> = [];
  client.on('message', (data, isBinary) => {
    if (!isBinary) controls.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  await once(client, 'open');
  const closed = once(client, 'close');
  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId }));
  await vi.waitFor(() => expect(first.start).toHaveBeenCalledOnce());
  first.data(Buffer.alloc(4));
  first.complete();

  await vi.waitFor(() => expect(controls).toContainEqual(expect.objectContaining({
    type: 'error',
    code: 'VOICE_LIMIT_EXCEEDED',
  })), { timeout: 500 });
  await closed;
  expect(dependencies.createSynthesisSdk).toHaveBeenCalledOnce();
  expect(neverStarted.start).not.toHaveBeenCalled();
  expect(controls).not.toContainEqual({ type: 'segment-start', index: 1 });
  await close();
});

voiceTest('times out and aborts a never-settling synthesis segment', async () => {
  const speechAnswers = new SpeechAnswerRegistry({ createId: () => 'answer-1' });
  const speechId = speechAnswers.register('report-1', '永不完成的合成');
  const synthesis = new FakeSynthesisSdk();
  const { url, close } = await startVoiceTestServer({
    speechAnswers,
    synthesisSessions: [synthesis],
    timeouts: { synthesisSegmentMs: 20 },
  });
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  const controls: Array<Record<string, unknown>> = [];
  client.on('message', (data, isBinary) => {
    if (!isBinary) controls.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  await once(client, 'open');
  const closed = once(client, 'close');
  client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId }));

  await vi.waitFor(() => expect(controls).toEqual([
    { type: 'ready', segmentCount: 1 },
    { type: 'segment-start', index: 0 },
    expect.objectContaining({ type: 'error', code: 'VOICE_UPSTREAM_TIMEOUT' }),
  ]));
  await closed;
  expect(synthesis.shutdown).toHaveBeenCalledOnce();
  await close();
});

voiceTest('cancels active synthesis, shuts down its SDK once, and emits no later frames', async () => {
  for (let attempt = 0; attempt < RACE_ATTEMPTS; attempt += 1) {
    const speechAnswers = new SpeechAnswerRegistry({ createId: () => 'answer-1' });
    const speechId = speechAnswers.register('report-1', '正在合成的回答');
    const synthesis = new FakeSynthesisSdk();
    const server = await startVoiceTestServer({ speechAnswers, synthesisSessions: [synthesis] });
    await expectNarrationLeaseReleasedBeforeClose({
      server,
      speechId,
      synthesis,
      stop: (client) => client.send(JSON.stringify({ type: 'cancel' })),
      verifyAfterClose: () => {
        synthesis.data(Buffer.from('late-mp3'));
        synthesis.complete();
      },
    });
    expect(synthesis.shutdown).toHaveBeenCalledOnce();
  }
});

voiceTest('fails safely for missing synthesis configuration and invalid or binary controls', async () => {
  const unavailableSpeech = new SpeechAnswerRegistry({ createId: () => 'answer-1' });
  unavailableSpeech.register('report-1', '已有但暂时无法合成的讲解');
  const notConfigured = await startVoiceTestServer({
    config: { success: false, missing: ['ALIYUN_NLS_APP_KEY'] },
    speechAnswers: unavailableSpeech,
  });
  const missingConfigClient = new WebSocket(`${notConfigured.url.replace('http', 'ws')}/api/voice/synthesize`, { origin: notConfigured.url });
  await once(missingConfigClient, 'open');
  missingConfigClient.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId: 'answer-1' }));
  await expectMessage(missingConfigClient, { type: 'error', code: 'VOICE_NOT_CONFIGURED' });
  expect(notConfigured.dependencies.createSynthesisSdk).not.toHaveBeenCalled();
  await closeClient(missingConfigClient);
  await notConfigured.close();

  const { url, close } = await startVoiceTestServer();
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'synthesize' }));
  await expectMessage(client, { type: 'error', code: 'VOICE_INVALID_AUDIO' });
  client.send(Buffer.from([0]));
  await expectMessage(client, { type: 'error', code: 'VOICE_INVALID_AUDIO' });
  await closeClient(client);
  await close();
});

voiceTest('cleans up active synthesis once after disconnect or gateway detach', async () => {
  const speechAnswers = new SpeechAnswerRegistry({ createId: () => 'answer-1' });
  const speechId = speechAnswers.register('report-1', '清理中的回答');
  const disconnected = new FakeSynthesisSdk();
  const firstServer = await startVoiceTestServer({ speechAnswers, synthesisSessions: [disconnected] });
  const firstEndActivity = vi.spyOn(firstServer.dependencies.reportRegistry, 'endActivity');
  const firstClient = new WebSocket(`${firstServer.url.replace('http', 'ws')}/api/voice/synthesize`, { origin: firstServer.url });
  await once(firstClient, 'open');
  firstClient.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId }));
  await vi.waitFor(() => expect(disconnected.start).toHaveBeenCalledOnce());
  await closeClient(firstClient);
  await vi.waitFor(() => expect(disconnected.shutdown).toHaveBeenCalledOnce());
  expect(firstEndActivity).toHaveBeenCalledTimes(1);
  await firstServer.close();
  expect(disconnected.shutdown).toHaveBeenCalledOnce();
  expect(firstEndActivity).toHaveBeenCalledTimes(1);

  const detached = new FakeSynthesisSdk();
  const secondServer = await startVoiceTestServer({ speechAnswers, synthesisSessions: [detached] });
  const secondEndActivity = vi.spyOn(secondServer.dependencies.reportRegistry, 'endActivity');
  const secondClient = new WebSocket(`${secondServer.url.replace('http', 'ws')}/api/voice/synthesize`, { origin: secondServer.url });
  await once(secondClient, 'open');
  secondClient.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId }));
  await vi.waitFor(() => expect(detached.start).toHaveBeenCalledOnce());
  secondServer.detach();
  secondServer.detach();
  await once(secondClient, 'close');
  expect(detached.shutdown).toHaveBeenCalledOnce();
  expect(secondEndActivity).toHaveBeenCalledTimes(1);
  await secondServer.close();
  expect(detached.shutdown).toHaveBeenCalledOnce();
  expect(secondEndActivity).toHaveBeenCalledTimes(1);
});

voiceTest('ends the narration lease once on provider and token failures', async () => {
  for (const failure of ['provider', 'token'] as const) {
    const speechAnswers = new SpeechAnswerRegistry({ createId: () => `answer-${failure}` });
    const speechId = speechAnswers.register('report-1', `failure-${failure}`);
    const synthesis = new FakeSynthesisSdk();
    const server = await startVoiceTestServer({
      speechAnswers,
      synthesisSessions: [synthesis],
      tokenManager: failure === 'token'
        ? { getToken: vi.fn().mockRejectedValue(new AliyunNlsTokenError('ALIYUN_NLS_TOKEN_UNAVAILABLE')) } as never
        : undefined,
    });
    const endActivity = vi.spyOn(server.dependencies.reportRegistry, 'endActivity');
    const client = new WebSocket(`${server.url.replace('http', 'ws')}/api/voice/synthesize`, { origin: server.url });
    await once(client, 'open');
    const closed = once(client, 'close');
    client.send(JSON.stringify({ type: 'synthesize', reportId: 'report-1', speechId }));
    if (failure === 'provider') {
      await vi.waitFor(() => expect(synthesis.start).toHaveBeenCalledOnce());
      synthesis.fail();
    }
    await expectMessage(client, { type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE' });
    await closed;
    expect(endActivity).toHaveBeenCalledTimes(1);
    await server.close();
    expect(endActivity).toHaveBeenCalledTimes(1);
  }
});

voiceTest('ends the narration lease once when the owning report aborts', async () => {
  for (let attempt = 0; attempt < RACE_ATTEMPTS; attempt += 1) {
    const leaseControllers: AbortController[] = [];
    const reportRegistry = new ReportJobRegistry({
      createId: () => 'report-1',
      createAbortController: () => {
        const controller = new AbortController();
        leaseControllers.push(controller);
        return controller;
      },
    });
    reportRegistry.create({ question: 'abort narration', originPage: 'overview' });
    const speechAnswers = new SpeechAnswerRegistry({ createId: () => 'answer-abort' });
    const speechId = speechAnswers.register('report-1', 'abort narration');
    const synthesis = new FakeSynthesisSdk();
    const server = await startVoiceTestServer({ reportRegistry, speechAnswers, synthesisSessions: [synthesis] });
    await expectNarrationLeaseReleasedBeforeClose({
      server,
      speechId,
      synthesis,
      stop: () => leaseControllers[0]!.abort(),
    });
    expect(synthesis.shutdown).toHaveBeenCalledOnce();
  }
});
