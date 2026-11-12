import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

it('does not start a listener merely because the startup module is imported', async () => {
  vi.resetModules();
  const startLocalServer = vi.fn();
  vi.doMock('../src/app', async (importOriginal) => ({
    ...await importOriginal<typeof import('../src/app')>(),
    startLocalServer,
  }));

  await import('../src/index');

  expect(startLocalServer).not.toHaveBeenCalled();
  vi.doUnmock('../src/app');
  vi.resetModules();
}, 20_000);

it('injects the one shared report registry into HTTP reports and the voice gateway', async () => {
  vi.resetModules();
  const fakeServer = new EventEmitter() as Server;
  fakeServer.close = vi.fn() as never;
  const reportGenerator = { dispose: vi.fn() };
  const createServer = vi.fn(() => ({ fake: 'app' }));
  const startLocalServer = vi.fn((_app, options) => {
    options.attachVoiceGateway?.(fakeServer);
    return fakeServer;
  });
  const attachVoiceWebSocketGateway = vi.fn(() => vi.fn());
  vi.doMock('../src/app', () => ({
    createDefaultReportGenerator: vi.fn(() => reportGenerator),
    createServer,
    loadDefaultDataset: vi.fn(() => ({ fake: 'dataset' })),
    startLocalServer,
  }));
  vi.doMock('../src/services/voice/gateway', () => ({ attachVoiceWebSocketGateway }));
  vi.doMock('../src/services/voice/config', () => ({
    getAliyunNlsConfig: vi.fn(() => ({ success: false, missing: ['ALIYUN_NLS_APP_KEY'] })),
  }));

  const { startApplication } = await import('../src/index');
  startApplication();

  expect(createServer).toHaveBeenCalledOnce();
  expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ wphiStatePath: resolve('data/wphi-settings.json') }));
  expect(attachVoiceWebSocketGateway).toHaveBeenCalledOnce();
  const httpOptions = (createServer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { reportRegistry: unknown; speechAnswerRegistry: unknown };
  const voiceOptions = (attachVoiceWebSocketGateway as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { reportRegistry: unknown; speechAnswers: unknown };
  expect(voiceOptions.reportRegistry).toBe(httpOptions.reportRegistry);
  expect(httpOptions.speechAnswerRegistry).toBe(voiceOptions.speechAnswers);
  vi.doUnmock('../src/app');
  vi.doUnmock('../src/services/voice/gateway');
  vi.doUnmock('../src/services/voice/config');
  vi.resetModules();
});

it('starts the ESM API server on loopback and loads the Excel demonstration dataset', async () => {
  const entry = resolve(process.cwd(), 'server/src/index.ts');

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: process.cwd(),
      env: { ...process.env, LOCAL_SERVER_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const listeningAddress = /API listening on http:\/\/127\.0\.0\.1:(\d+)/;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`API_START_TIMEOUT:${output}`));
    }, 12_000);

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(listeningAddress);
      if (match) {
        clearTimeout(timeout);
        child.kill();
        expect(Number(match[1])).toBeGreaterThan(0);
        resolvePromise();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!listeningAddress.test(output)) {
        clearTimeout(timeout);
        reject(new Error(`API_START_EXIT:${code}:${output}`));
      }
    });
  });
}, 15_000);
