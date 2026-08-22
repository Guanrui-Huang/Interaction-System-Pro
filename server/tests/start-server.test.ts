import express from 'express';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createServer as createExpressServer, startLocalServer } from '../src/app';
import { startApplication } from '../src/index';
import type { ReportGenerator } from '../src/services/report-generator';
import { ReportGenerator as ReportGeneratorService } from '../src/services/report-generator';
import { ReportJobRegistry } from '../src/services/report-job-registry';

it('creates an attachable loopback HTTP server before listening', async () => {
  const app = express();
  const attachVoiceGateway = vi.fn();
  const log = vi.fn();

  const server = startLocalServer(app, { port: 0, log, attachVoiceGateway });
  await once(server, 'listening');

  expect(attachVoiceGateway).toHaveBeenCalledWith(server);
  expect(server.address()).toMatchObject({ address: '127.0.0.1' });
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/^API listening on http:\/\/127\.0\.0\.1:\d+$/));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

it('rejects a report generator wired to a different registry instance', () => {
  const reportRegistry = new ReportJobRegistry();
  const otherRegistry = new ReportJobRegistry();
  const reportGenerator = { dependencies: { registry: otherRegistry } } as ReportGenerator;

  expect(() => createExpressServer({ reportRegistry, reportGenerator })).toThrow('REPORT_DEPENDENCY_MISMATCH');
});

it('disposes report generation exactly once as soon as application shutdown starts', async () => {
  const dispose = vi.spyOn(ReportGeneratorService.prototype, 'dispose');
  const previousPort = process.env.LOCAL_SERVER_PORT;
  process.env.LOCAL_SERVER_PORT = '0';
  const server = startApplication();
  try {
    await once(server, 'listening');

    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    await closed;

    const repeatedCloseError = await new Promise<Error | undefined>((resolve) => {
      server.close((error) => resolve(error));
    });
    expect(repeatedCloseError).toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' });
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    dispose.mockRestore();
    if (previousPort === undefined) delete process.env.LOCAL_SERVER_PORT;
    else process.env.LOCAL_SERVER_PORT = previousPort;
  }
});
