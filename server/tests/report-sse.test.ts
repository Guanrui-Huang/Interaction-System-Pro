// @vitest-environment node

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlideOutline } from '../../shared/report';
import { createServer, startLocalServer } from '../src/app';
import type { ReportGenerator } from '../src/services/report-generator';
import { ReportJobRegistry } from '../src/services/report-job-registry';

const REPORT_ID = '00000000-0000-4000-8000-000000000001';
const servers: ReturnType<typeof startLocalServer>[] = [];
const controllers: AbortController[] = [];

function outline(id = 'page-1', order = 0): SlideOutline {
  return {
    id, order, title: `第 ${order + 1} 页`, purpose: '解释', role: 'answer', layout: 'concept-center',
    evidencePolicy: 'knowledge', visualKind: 'capability-map', evidenceKeys: ['knowledge:0'], status: 'planned',
  };
}

function registryWithOutline(options: ConstructorParameters<typeof ReportJobRegistry>[0] = {}) {
  const registry = new ReportJobRegistry({ createId: () => REPORT_ID, ...options });
  const snapshot = registry.create({ question: '分析', originPage: 'overview' });
  registry.setPhase(snapshot.reportId, 'planning');
  registry.publishOutline(snapshot.reportId, [outline()]);
  return registry;
}

async function listen(registry: ReportJobRegistry, heartbeatMs = 15_000) {
  const generator = {
    dependencies: { registry }, createReport: vi.fn(), run: vi.fn(), answerClarification: vi.fn(),
    prioritize: vi.fn(), retrySlide: vi.fn(), appendNewTopic: vi.fn(),
  } as unknown as ReportGenerator;
  const server = startLocalServer(
    createServer({ reportRegistry: registry, reportGenerator: generator, reportHeartbeatMs: heartbeatMs }),
    { port: 0, log: () => undefined },
  );
  servers.push(server);
  if (!server.listening) await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readFrames(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = '';
  while (frames.length < count) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    frames.push(...parts);
  }
  await reader.cancel();
  return frames.slice(0, count);
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveValue) => {
    if (!server.listening) return resolveValue();
    server.close(() => resolveValue());
    server.closeAllConnections?.();
  })));
});

describe('report SSE API', () => {
  it('frames intent-first state and outline events with sequence IDs', async () => {
    const registry = registryWithOutline();
    const expected = registry.replayAfter(REPORT_ID, 0)!;
    const origin = await listen(registry);
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${origin}/api/ai/reports/${REPORT_ID}/events`, { signal: controller.signal });
    const frames = await readFrames(response, expected.length);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(frames.map((frame) => JSON.parse(frame.split('data: ')[1]!))).toEqual(expected);
  });

  it('replays only events after Last-Event-ID', async () => {
    const registry = registryWithOutline();
    registry.setPhase(REPORT_ID, 'generating-first-slide');
    const origin = await listen(registry);
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${origin}/api/ai/reports/${REPORT_ID}/events`, {
      signal: controller.signal,
      headers: { 'Last-Event-ID': '1' },
    });
    const expected = registry.replayAfter(REPORT_ID, 1)!;
    const frames = await readFrames(response, expected.length);
    expect(frames.map((frame) => Number(/^id: (\d+)/u.exec(frame)?.[1]))).toEqual(expected.map(({ sequence }) => sequence));
  });

  it('rejects new subscriptions after cancellation while GET remains restorable', async () => {
    const registry = registryWithOutline();
    registry.cancel(REPORT_ID);
    const origin = await listen(registry);
    const events = await fetch(`${origin}/api/ai/reports/${REPORT_ID}/events`);
    const snapshot = await fetch(`${origin}/api/ai/reports/${REPORT_ID}`);
    expect(events.status).toBe(409);
    expect(await events.json()).toMatchObject({ code: 'REPORT_CANCELLED' });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ status: 'cancelled' });
  });

  it('emits cancellation to an active stream before closing it', async () => {
    const registry = registryWithOutline();
    const origin = await listen(registry);
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${origin}/api/ai/reports/${REPORT_ID}/events`, { signal: controller.signal });
    await readFrames(response, registry.replayAfter(REPORT_ID, 0)!.length);
    registry.cancel(REPORT_ID);
    expect(registry.replayAfter(REPORT_ID, 0)?.at(-1)).toMatchObject({ type: 'report.cancelled' });
  });

  it('returns REPORT_EVENT_GAP when the requested event is no longer retained', async () => {
    const registry = registryWithOutline({ replayCapacity: 2 });
    registry.setPhase(REPORT_ID, 'generating-first-slide');
    registry.markSlideGenerating(REPORT_ID, 'page-1');
    registry.markSlideFailed(REPORT_ID, 'page-1', true);
    const origin = await listen(registry);
    const response = await fetch(`${origin}/api/ai/reports/${REPORT_ID}/events`, {
      headers: { 'Last-Event-ID': '0' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'REPORT_EVENT_GAP' });
  });

  it('validates Last-Event-ID and rejects a future sequence safely', async () => {
    const registry = registryWithOutline();
    const origin = await listen(registry);
    for (const lastEventId of ['-1', '1.5', '01', '999']) {
      const response = await fetch(`${origin}/api/ai/reports/${REPORT_ID}/events`, {
        headers: { 'Last-Event-ID': lastEventId },
      });
      expect(response.status).toBe(lastEventId === '999' ? 409 : 400);
      expect(await response.json()).toMatchObject({
        code: lastEventId === '999' ? 'REPORT_EVENT_GAP' : 'INVALID_REQUEST',
      });
    }
  });

  it('emits a heartbeat and releases the SSE activity exactly once on close', async () => {
    const registry = registryWithOutline();
    const begin = vi.spyOn(registry, 'beginActivity');
    const end = vi.spyOn(registry, 'endActivity');
    const origin = await listen(registry, 10);
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${origin}/api/ai/reports/${REPORT_ID}/events`, {
      headers: { 'Last-Event-ID': String(registry.getSnapshot(REPORT_ID)!.lastSequence) },
      signal: controller.signal,
    });
    const frames = await readFrames(response, 1);
    controller.abort();
    await new Promise<void>((resolveValue) => setTimeout(resolveValue, 20));

    expect(frames).toEqual([': heartbeat']);
    expect(begin).toHaveBeenCalledWith(REPORT_ID, 'sse');
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(REPORT_ID, 'sse', expect.any(AbortSignal));
  });
});
