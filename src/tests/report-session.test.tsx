import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReportEvent, ReportJobSnapshot, ReportSlide } from '../../shared/report';
import { restoreReport, startReport, submitReportClarification } from '../features/ai/report/report-api';
import { reduceReportEvent, useReportSession } from '../features/ai/report/useReportSession';

const REPORT_ID = '00000000-0000-4000-8000-000000000001';

function slideFixture(id = 'slide-1', order = 0): ReportSlide {
  const metric = {
    key: `metric-${id}`,
    kind: 'metric' as const,
    source: 'excel' as const, snapshotId: 'snapshot-1', claimIds: ['claim-1'],
    module: 'water-quality' as const,
    label: '总氮',
    unit: 'mg/L',
    value: 2.4,
  };
  const evidenceRef = {
    key: metric.key,
    kind: metric.kind,
    source: metric.source,
    snapshotId: metric.snapshotId,
    module: metric.module,
    label: metric.label,
    unit: metric.unit,
  };
  return {
    id,
    order,
    evidenceSnapshotId: 'snapshot-1', role: 'answer', layout: 'visual-focus', evidencePolicy: 'data',
    title: `页面 ${order + 1}`,
    takeaway: '总氮保持稳定。',
    takeawayClaimIds: ['claim-1'],
    claims: [{ id: 'claim-1', text: '总氮保持稳定。', kind: 'onsite-fact', evidenceRefs: [evidenceRef] }],
    visual: { kind: 'kpi-grid', metrics: [metric] },
    metrics: [metric],
    evidenceRefs: [evidenceRef],
    narration: [
      { id: `${id}-segment-1`, text: '第一段讲解。', speechId: `${id}-speech-1`, claimIds: ['claim-1'] },
      { id: `${id}-segment-2`, text: '第二段讲解。', speechId: `${id}-speech-2`, claimIds: ['claim-1'] },
    ],
  };
}

function snapshotFixture(lastSequence = 0, status: ReportJobSnapshot['status'] = 'generating'): ReportJobSnapshot {
  const first = slideFixture();
  const second = slideFixture('slide-2', 1);
  const settled = status === 'ready' || status === 'partial';
  return {
    reportId: REPORT_ID,
    question: '分析总氮趋势',
    originPage: 'water-quality',
    scope: {
      modules: ['water-quality'],
      metrics: ['tn'],
      dateRange: { from: '2026-07-01', to: '2026-07-31' },
      sampleCount: 31,
      granularity: 'daily',
    },
    status,
    phase: status === 'generating' ? 'understanding' : status === 'ready' || status === 'partial' ? 'completed' : null,
    clarification: null,
    outline: [
      { id: 'slide-1', order: 0, title: '页面 1', purpose: '说明总氮', role: 'answer', layout: 'visual-focus', evidencePolicy: 'data', visualKind: 'kpi-grid', evidenceKeys: ['metric-slide-1'], status: 'ready' },
      { id: 'slide-2', order: 1, title: '页面 2', purpose: '说明趋势', role: 'evidence', layout: 'split-insight', evidencePolicy: 'data', visualKind: 'kpi-grid', evidenceKeys: ['metric-slide-2'], status: status === 'ready' ? 'ready' : status === 'partial' ? 'failed' : 'planned', ...(status === 'partial' ? { retryable: true } : {}) },
    ],
    slides: status === 'ready' ? [first, second] : [first],
    conversation: {
      originalQuestion: '分析总氮趋势',
      turns: [],
      compactSummary: '',
      activeSlideId: 'slide-1',
    },
    createdAt: '2026-08-12T00:00:00.000Z',
    expiresAt: '2026-08-12T01:00:00.000Z',
    lastSequence,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function openEventStream(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function eventStream(events: ReportEvent[]): Response {
  const payload = events.map((event) => `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(payload)); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

function terminalSnapshot(status: 'failed' | 'cancelled', lastSequence = 0): ReportJobSnapshot {
  return {
    ...snapshotFixture(lastSequence),
    status,
    phase: null,
    clarification: null,
    outline: [],
    slides: [],
    conversation: { originalQuestion: '分析总氮趋势', turns: [], compactSummary: '' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

it('ignores duplicate and older events by sequence', () => {
  const ready = { type: 'slide.ready', sequence: 4, slide: slideFixture('slide-2', 1) } as const;
  const current = snapshotFixture(3);
  const state = reduceReportEvent(reduceReportEvent(current, ready), ready);
  const afterOlder = reduceReportEvent(state, { type: 'slide.generating', sequence: 2, slideId: 'slide-2', order: 1 });

  expect(afterOlder).toBe(state);
  expect(state.lastSequence).toBe(4);
  expect(state.slides.filter(({ id }) => id === 'slide-2')).toHaveLength(1);
  expect(state.outline.find(({ id }) => id === 'slide-2')?.status).toBe('ready');
});

it('reduces a republished ready slide as supersession metadata without restarting generation', () => {
  const current = reduceReportEvent(snapshotFixture(3), {
    type: 'slide.ready', sequence: 4, slide: slideFixture('slide-2', 1),
  });
  const old = current.slides.find(({ id }) => id === 'slide-1')!;
  const superseded = reduceReportEvent(current, {
    type: 'slide.ready', sequence: 5, slide: { ...old, supersededBySlideId: 'slide-2' },
  });

  expect(superseded.status).toBe(current.status);
  expect(superseded.phase).toBe(current.phase);
  expect(superseded.outline.find(({ id }) => id === old.id)?.status).toBe('ready');
  expect(superseded.slides.find(({ id }) => id === old.id)?.supersededBySlideId).toBe('slide-2');
});

it('tracks intent-first generation phases and clarification lifecycle events', () => {
  const initial = { ...snapshotFixture(0), slides: [], outline: [] } as ReportJobSnapshot;
  const understanding = reduceReportEvent(initial, {
    type: 'report.state-changed',
    sequence: 1,
    status: 'generating',
    phase: 'understanding',
    clarification: null,
  } as never);
  const clarification = reduceReportEvent(understanding, {
    type: 'report.clarification-required',
    sequence: 2,
    clarification: {
      clarificationId: 'clarification-1',
      prompt: '请明确需要分析的指标。',
      reason: 'ambiguous-subject',
      suggestions: ['总氮'],
    },
  } as never);

  expect(understanding).toMatchObject({ status: 'generating', phase: 'understanding', clarification: null });
  expect(clarification).toMatchObject({
    status: 'awaiting-clarification',
    phase: null,
    clarification: { clarificationId: 'clarification-1' },
  });
});

it('rejects an invalid success payload before returning it to React', async () => {
  const invalid = {
    ...snapshotFixture(),
    scope: { ...snapshotFixture().scope, dateRange: { from: '2026-02-30', to: '2026-03-01' } },
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(invalid)));

  await expect(restoreReport(REPORT_ID, new AbortController().signal)).rejects.toMatchObject({
    code: 'MALFORMED_RESPONSE',
  });
});

it('maps a REST network failure to the shared upstream error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('private network detail')));

  await expect(startReport(
    { question: '分析总氮趋势', page: 'water-quality' },
    new AbortController().signal,
  )).rejects.toMatchObject({ code: 'UPSTREAM_HTTP' });
});

it('posts the clarification ID and trimmed answer through the intent-first endpoint', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);

  await submitReportClarification(REPORT_ID, 'clarification-1', '分析总氮', new AbortController().signal);

  expect(fetchMock).toHaveBeenCalledWith(`/api/ai/reports/${REPORT_ID}/clarifications`, expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ clarificationId: 'clarification-1', answer: '分析总氮' }),
  }));
});

it('aborts an older clarification submission before sending a newer answer', async () => {
  const pendingSignals: AbortSignal[] = [];
  const awaiting = {
    ...snapshotFixture(),
    status: 'awaiting-clarification' as const,
    phase: null,
    clarification: { clarificationId: 'clarification-1', prompt: '请明确指标', reason: 'ambiguous-subject' as const, suggestions: [] },
    slides: [],
    outline: [],
  };
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/events')) return Promise.resolve(openEventStream());
    if (String(input).endsWith('/clarifications')) {
      pendingSignals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    }
    return Promise.resolve(jsonResponse(awaiting));
  }));
  const { result, unmount } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.snapshot?.clarification?.clarificationId).toBe('clarification-1'));

  act(() => { void result.current.submitClarification('clarification-1', '先分析总氮'); });
  await waitFor(() => expect(pendingSignals).toHaveLength(1));
  act(() => { void result.current.submitClarification('clarification-1', '改为分析鼓风能耗'); });
  await waitFor(() => expect(pendingSignals).toHaveLength(2));
  expect(pendingSignals[0]?.aborted).toBe(true);
  unmount();
  expect(pendingSignals[1]?.aborted).toBe(true);
});

it('reconnects the event stream immediately after a clarification is accepted', async () => {
  let eventConnections = 0;
  const awaiting = {
    ...snapshotFixture(),
    status: 'awaiting-clarification' as const,
    phase: null,
    clarification: { clarificationId: 'clarification-1', prompt: '请明确指标', reason: 'ambiguous-subject' as const, suggestions: [] },
    slides: [],
    outline: [],
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/events')) {
      eventConnections += 1;
      return openEventStream();
    }
    if (url.endsWith('/clarifications')) return new Response(null, { status: 204 });
    return jsonResponse(awaiting);
  }));
  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.snapshot?.status).toBe('awaiting-clarification'));
  await waitFor(() => expect(eventConnections).toBe(1));

  await act(async () => {
    await result.current.submitClarification('clarification-1', '分析总氮');
  });

  await waitFor(() => expect(eventConnections).toBe(2));
  expect(result.current.phase).toBe('connected');
});

it('recovers from an SSE connection that ends mid-event without showing a malformed response', async () => {
  let eventConnections = 0;
  let restoreCount = 0;
  const partial = new TextEncoder().encode(
    'id: 1\ndata: {"type":"slide.generating","sequence":1,"slideId":"slide-1"',
  );
  const interrupted = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(partial);
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/events')) {
      eventConnections += 1;
      return eventConnections === 1 ? interrupted : openEventStream();
    }
    restoreCount += 1;
    return jsonResponse(snapshotFixture(restoreCount > 1 ? 1 : 0));
  }));

  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));

  await waitFor(() => expect(eventConnections).toBe(2), { timeout: 2_000 });
  expect(restoreCount).toBeGreaterThanOrEqual(2);
  expect(result.current.error).toBeNull();
  expect(result.current.phase).toBe('connected');
});

it('starts one report per launch token under StrictMode', async () => {
  const snapshot = snapshotFixture();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/reports')) return jsonResponse({ reportId: REPORT_ID, snapshot }, { status: 202 });
    if (url.endsWith('/events')) return openEventStream();
    return jsonResponse(snapshot);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { result } = renderHook(() => useReportSession({
    launch: { token: 'launch-strict-1', question: '分析总氮趋势', page: 'water-quality' },
  }), { reactStrictMode: true });

  await waitFor(() => expect(result.current.snapshot?.reportId).toBe(REPORT_ID));
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/reports'))).toHaveLength(1);
});

it('aborts an in-flight create when exit is requested', async () => {
  let createSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    createSignal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      createSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  }));
  const onExit = vi.fn();
  const { result } = renderHook(() => useReportSession({
    launch: { token: 'launch-abort-1', question: '分析总氮趋势', page: 'water-quality' },
    onExit,
  }));

  await waitFor(() => expect(createSignal).toBeDefined());
  act(() => result.current.exit());

  expect(createSignal?.aborted).toBe(true);
  expect(onExit).toHaveBeenCalledOnce();
});

it('fetches a snapshot after an event gap before reconnecting from the new sequence', async () => {
  const snapshots = [snapshotFixture(3), snapshotFixture(7)];
  let restoreCount = 0;
  let eventCount = 0;
  const eventHeaders: HeadersInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/events')) {
      eventCount += 1;
      eventHeaders.push(init?.headers ?? {});
      return eventCount === 1
        ? jsonResponse({ code: 'REPORT_EVENT_GAP', message: 'safe' }, { status: 409 })
        : openEventStream();
    }
    return jsonResponse(snapshots[Math.min(restoreCount++, snapshots.length - 1)]);
  }));

  renderHook(() => useReportSession({ reportId: REPORT_ID }));

  await waitFor(() => expect(eventCount).toBe(2), { timeout: 2_000 });
  expect(restoreCount).toBeGreaterThanOrEqual(2);
  expect(new Headers(eventHeaders[1]).get('Last-Event-ID')).toBe('7');
});

it('coalesces narration cursor updates for 500ms and flushes before a page change', async () => {
  vi.useFakeTimers();
  const patches: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/events')) return openEventStream();
    if (url.endsWith('/session')) {
      patches.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    return jsonResponse(snapshotFixture());
  }));
  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  act(() => {
    result.current.setNarrationCursor({ slideId: 'slide-1', segmentId: 'slide-1-segment-1', offsetMs: 100 });
    result.current.setNarrationCursor({ slideId: 'slide-1', segmentId: 'slide-1-segment-1', offsetMs: 300 });
  });
  expect(patches).toHaveLength(0);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(patches).toEqual([expect.objectContaining({
    activity: 'narration',
    narrationCursor: expect.objectContaining({ offsetMs: 300 }),
  })]);

  act(() => {
    result.current.setNarrationCursor({ slideId: 'slide-1', segmentId: 'slide-1-segment-2', offsetMs: 50 });
    result.current.selectSlide('slide-2');
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(patches.slice(1)).toEqual([
    expect.objectContaining({ activity: 'narration' }),
    { activity: 'page', activeSlideId: 'slide-2' },
  ]);
});

it('ignores a stale restore response after switching report IDs', async () => {
  let resolveFirst!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  const secondSnapshot = { ...snapshotFixture(2), reportId: '00000000-0000-4000-8000-000000000002' };
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('000000000001')) return first;
    if (url.endsWith('/events')) return Promise.resolve(openEventStream());
    return Promise.resolve(jsonResponse(secondSnapshot));
  });
  vi.stubGlobal('fetch', fetchMock);
  const { result, rerender } = renderHook(
    ({ reportId }) => useReportSession({ reportId }),
    { initialProps: { reportId: REPORT_ID } },
  );

  rerender({ reportId: secondSnapshot.reportId });
  await waitFor(() => expect(result.current.snapshot?.reportId).toBe(secondSnapshot.reportId));
  await act(async () => {
    resolveFirst(jsonResponse(snapshotFixture(9)));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(result.current.snapshot?.reportId).toBe(secondSnapshot.reportId);
});

it('uses exponential reconnect backoff capped at 5s and resets it on manual retry', async () => {
  vi.useFakeTimers();
  let eventConnections = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/events')) {
      eventConnections += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return jsonResponse(snapshotFixture());
  }));
  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  const flushPromises = async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  };

  await act(flushPromises);
  expect(eventConnections).toBe(1);
  for (const delay of [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(delay - 1);
      await flushPromises();
    });
    const beforeReconnect = eventConnections;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flushPromises();
    });
    expect(eventConnections).toBe(beforeReconnect + 1);
  }

  const beforeManualRetry = eventConnections;
  act(() => result.current.retryConnection());
  await act(flushPromises);
  expect(eventConnections).toBe(beforeManualRetry + 1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(249);
    await flushPromises();
  });
  expect(eventConnections).toBe(beforeManualRetry + 1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
  });
  expect(eventConnections).toBe(beforeManualRetry + 2);
});

it('flushes pending narration on pause, follow-up start and pagehide boundaries', async () => {
  const patches: unknown[] = [];
  const patchKeepalive: Array<boolean | undefined> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/events')) return openEventStream();
    if (url.endsWith('/session')) {
      patches.push(JSON.parse(String(init?.body)));
      patchKeepalive.push(init?.keepalive);
      return new Response(null, { status: 204 });
    }
    return jsonResponse(snapshotFixture());
  }));
  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  const cursor = { slideId: 'slide-1', segmentId: 'slide-1-segment-1', offsetMs: 100 };

  act(() => result.current.setNarrationCursor(cursor, 'pause'));
  act(() => result.current.setNarrationCursor({ ...cursor, offsetMs: 200 }, 'follow-up'));
  act(() => {
    result.current.setNarrationCursor({ ...cursor, offsetMs: 300 });
    window.dispatchEvent(new Event('pagehide'));
  });

  await waitFor(() => expect(patches).toEqual([
    expect.objectContaining({ activity: 'narration', narrationCursor: expect.objectContaining({ offsetMs: 100 }) }),
    expect.objectContaining({ activity: 'narration', narrationCursor: expect.objectContaining({ offsetMs: 200 }) }),
    expect.objectContaining({ activity: 'narration', narrationCursor: expect.objectContaining({ offsetMs: 300 }) }),
  ]));
  expect(patchKeepalive).toEqual([false, false, true]);
});

it('waits for a pending narration flush before patching a page change', async () => {
  let resolveNarration!: () => void;
  const narrationFinished = new Promise<void>((resolve) => { resolveNarration = resolve; });
  const patchActivities: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/events')) return openEventStream();
    if (url.endsWith('/session')) {
      const body = JSON.parse(String(init?.body)) as { activity: string };
      patchActivities.push(body.activity);
      if (body.activity === 'narration') await narrationFinished;
      return new Response(null, { status: 204 });
    }
    return jsonResponse(snapshotFixture());
  }));
  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());

  act(() => {
    result.current.setNarrationCursor({
      slideId: 'slide-1', segmentId: 'slide-1-segment-1', offsetMs: 400,
    });
    result.current.selectSlide('slide-2');
  });
  await waitFor(() => expect(patchActivities).toEqual(['narration']));

  resolveNarration();
  await waitFor(() => expect(patchActivities).toEqual(['narration', 'page']));
});

it('retries a failed create once for the same launch token under StrictMode', async () => {
  const snapshot = snapshotFixture();
  let creates = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/reports')) {
      creates += 1;
      return creates === 1
        ? jsonResponse({ code: 'REPORT_CAPACITY', message: 'safe' }, { status: 503 })
        : jsonResponse({ reportId: REPORT_ID, snapshot }, { status: 202 });
    }
    if (url.endsWith('/events')) return openEventStream();
    return jsonResponse(snapshot);
  }));
  const { result } = renderHook(() => useReportSession({
    launch: { token: 'launch-retry-1', question: '分析总氮趋势', page: 'water-quality' },
  }), { reactStrictMode: true });
  await waitFor(() => expect(result.current.error?.code).toBe('REPORT_CAPACITY'));

  act(() => {
    result.current.retryConnection();
    result.current.retryConnection();
  });

  await waitFor(() => expect(result.current.snapshot?.reportId).toBe(REPORT_ID));
  expect(creates).toBe(2);
});

it('retries an initial restore after an upstream failure', async () => {
  let restores = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/events')) return openEventStream();
    restores += 1;
    return restores === 1
      ? jsonResponse({ code: 'UPSTREAM_HTTP', message: 'safe' }, { status: 502 })
      : jsonResponse(snapshotFixture());
  }));
  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.error?.code).toBe('UPSTREAM_HTTP'));

  act(() => result.current.retryConnection());

  await waitFor(() => expect(result.current.snapshot?.reportId).toBe(REPORT_ID));
  expect(restores).toBe(2);
});

it('serializes rapid cursor boundary flushes so the latest cursor wins', async () => {
  let resolveFirst!: () => void;
  const firstFinished = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const startedOffsets: number[] = [];
  let serverOffset = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/events')) return openEventStream();
    if (url.endsWith('/session')) {
      const update = JSON.parse(String(init?.body)) as { narrationCursor: { offsetMs: number } };
      startedOffsets.push(update.narrationCursor.offsetMs);
      if (update.narrationCursor.offsetMs === 100) await firstFinished;
      serverOffset = update.narrationCursor.offsetMs;
      return new Response(null, { status: 204 });
    }
    return jsonResponse(snapshotFixture());
  }));
  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  const cursor = { slideId: 'slide-1', segmentId: 'slide-1-segment-1' };

  act(() => {
    result.current.setNarrationCursor({ ...cursor, offsetMs: 100 }, 'pause');
    result.current.setNarrationCursor({ ...cursor, offsetMs: 200 }, 'follow-up');
  });
  await waitFor(() => expect(startedOffsets).toEqual([100]));

  resolveFirst();
  await waitFor(() => expect(startedOffsets).toEqual([100, 200]));
  expect(serverOffset).toBe(200);
});

it('keeps a pagehide cursor PATCH alive through immediate unmount', async () => {
  let pagehideSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/events')) return Promise.resolve(openEventStream());
    if (url.endsWith('/session')) {
      pagehideSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }
    return Promise.resolve(jsonResponse(snapshotFixture()));
  }));
  const { result, unmount } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());

  act(() => {
    result.current.setNarrationCursor({
      slideId: 'slide-1', segmentId: 'slide-1-segment-1', offsetMs: 550,
    });
    window.dispatchEvent(new Event('pagehide'));
  });
  unmount();

  await waitFor(() => expect(pagehideSignal).toBeDefined());
  expect(pagehideSignal?.aborted).toBe(false);
});

it('still aborts an ordinary pending session PATCH on unmount', async () => {
  let ordinarySignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/events')) return Promise.resolve(openEventStream());
    if (url.endsWith('/session')) {
      ordinarySignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }
    return Promise.resolve(jsonResponse(snapshotFixture()));
  }));
  const { result, unmount } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());

  act(() => result.current.setNarrationCursor({
    slideId: 'slide-1', segmentId: 'slide-1-segment-1', offsetMs: 600,
  }, 'pause'));
  await waitFor(() => expect(ordinarySignal).toBeDefined());
  unmount();

  expect(ordinarySignal?.aborted).toBe(true);
});

it('connects SSE for a restored ready snapshot so later same-report events can arrive', async () => {
  let eventConnections = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/events')) {
      eventConnections += 1;
      return openEventStream();
    }
    return jsonResponse(snapshotFixture(8, 'ready'));
  }));

  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));

  await waitFor(() => expect(eventConnections).toBe(1));
  expect(result.current.phase).toBe('ready');
});

it('removes a resolved reconnect delay abort listener', async () => {
  vi.useFakeTimers();
  const addListener = vi.spyOn(AbortSignal.prototype, 'addEventListener');
  const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/events')) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return jsonResponse(snapshotFixture());
  }));
  renderHook(() => useReportSession({ reportId: REPORT_ID }));
  const flushPromises = async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  };
  await act(flushPromises);
  const removedBefore = new Set(removeListener.mock.calls
    .filter(([type]) => type === 'abort')
    .map(([, listener]) => listener));
  const pendingListeners = addListener.mock.calls
    .filter(([type, listener]) => type === 'abort' && !removedBefore.has(listener))
    .map(([, listener]) => listener);
  expect(pendingListeners).toHaveLength(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
  });

  expect(removeListener).toHaveBeenCalledWith('abort', pendingListeners[0]);
});

it('posts one accepted retry for a failed retryable slide through the session boundary', async () => {
  const failed = snapshotFixture();
  failed.status = 'partial';
  failed.phase = 'completed';
  failed.outline[1] = { ...failed.outline[1]!, status: 'failed', retryable: true };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/events')) return openEventStream();
    if (url.endsWith('/slides/slide-2/retries')) return new Response(null, { status: 202 });
    return jsonResponse(failed);
  });
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.snapshot?.outline[1]?.status).toBe('failed'));

  await act(async () => { await result.current.retrySlide('slide-2'); });

  const retries = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/slides/slide-2/retries'));
  expect(retries).toHaveLength(1);
  expect(retries[0]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
});

it('does not replace the ready workspace with a global error when one slide retry fails', async () => {
  const failed = snapshotFixture();
  failed.status = 'partial';
  failed.phase = 'completed';
  failed.outline[1] = { ...failed.outline[1]!, status: 'failed', retryable: true };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/events')) return openEventStream();
    if (url.endsWith('/slides/slide-2/retries')) return jsonResponse({ code: 'UPSTREAM_HTTP', message: 'safe' }, { status: 502 });
    return jsonResponse(failed);
  }));
  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.snapshot?.outline[1]?.status).toBe('failed'));

  let retryError: unknown;
  await act(async () => {
    try { await result.current.retrySlide('slide-2'); } catch (caught) { retryError = caught; }
  });

  expect(retryError).toMatchObject({ code: 'UPSTREAM_HTTP' });
  expect(result.current.error).toBeNull();
  expect(result.current.snapshot?.slides[0]?.id).toBe('slide-1');
});

it('reduces report.failed to terminal failed even when a ready page was previously published', () => {
  const failed = reduceReportEvent(snapshotFixture(4), {
    type: 'report.failed', sequence: 5, code: 'UPSTREAM_HTTP',
  });

  expect(failed).toMatchObject({ status: 'failed', phase: null, clarification: null, lastSequence: 5 });
});

it('keeps a ready first page and local retry state for slide.failed followed by partial completion', async () => {
  const initial = {
    ...snapshotFixture(4),
    phase: 'generating-slides' as const,
    outline: snapshotFixture(4).outline.map((item) => item.id === 'slide-2' ? { ...item, status: 'generating' as const } : item),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/events')) return eventStream([
      { type: 'slide.failed', sequence: 5, slideId: 'slide-2', retryable: true },
      { type: 'report.completed', sequence: 6, status: 'partial' },
    ]);
    return jsonResponse(initial);
  }));

  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));

  await waitFor(() => expect(result.current.snapshot?.status).toBe('partial'));
  expect(result.current.phase).toBe('ready');
  expect(result.current.error).toBeNull();
  expect(result.current.snapshot?.slides.map(({ id }) => id)).toEqual(['slide-1']);
  expect(result.current.snapshot?.outline[1]).toMatchObject({ status: 'failed', retryable: true });
});

it('shows an actionable global error when report.failed arrives before the first page', async () => {
  const initial = {
    ...snapshotFixture(0),
    phase: 'generating-first-slide' as const,
    outline: snapshotFixture(0).outline.map((item) => ({ ...item, status: 'planned' as const })),
    slides: [],
    conversation: { originalQuestion: '分析总氮趋势', turns: [], compactSummary: '' },
  };
  let eventSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/events')) {
      eventSignal = init?.signal as AbortSignal;
      return eventStream([{ type: 'report.failed', sequence: 1, code: 'NO_EVIDENCE' }]);
    }
    return jsonResponse(initial);
  }));

  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));

  await waitFor(() => expect(result.current.error?.code).toBe('NO_EVIDENCE'));
  expect(result.current.snapshot?.status).toBe('failed');
  expect(result.current.phase).toBe('error');
  expect(eventSignal?.aborted).toBe(true);
});

it('keeps report.failed terminal and global when it arrives after a ready page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/events')) {
      return eventStream([{ type: 'report.failed', sequence: 5, code: 'UPSTREAM_HTTP' }]);
    }
    return jsonResponse(snapshotFixture(4));
  }));

  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));

  await waitFor(() => expect(result.current.error?.code).toBe('UPSTREAM_HTTP'));
  expect(result.current.snapshot?.status).toBe('failed');
  expect(result.current.snapshot?.status).not.toBe('partial');
  expect(result.current.phase).toBe('error');
});

it.each([
  ['failed', 'EMPTY_ANSWER'],
  ['cancelled', 'REPORT_CANCELLED'],
] as const)('restores terminal %s snapshots without opening SSE', async (status, code) => {
  let eventConnections = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/events')) {
      eventConnections += 1;
      return openEventStream();
    }
    return jsonResponse(terminalSnapshot(status));
  }));

  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));

  await waitFor(() => expect(result.current.error?.code).toBe(code));
  expect(result.current.phase).toBe('error');
  expect(result.current.snapshot?.status).toBe(status);
  expect(eventConnections).toBe(0);
});

it('treats live report.cancelled as terminal and stops the active stream', async () => {
  const initial = {
    ...snapshotFixture(0),
    phase: 'understanding' as const,
    outline: [],
    slides: [],
    conversation: { originalQuestion: '分析总氮趋势', turns: [], compactSummary: '' },
  };
  let eventSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/events')) {
      eventSignal = init?.signal as AbortSignal;
      return eventStream([{ type: 'report.cancelled', sequence: 1 }]);
    }
    return jsonResponse(initial);
  }));

  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));

  await waitFor(() => expect(result.current.error?.code).toBe('REPORT_CANCELLED'));
  expect(result.current.snapshot?.status).toBe('cancelled');
  expect(result.current.phase).toBe('error');
  expect(eventSignal?.aborted).toBe(true);
});

it.each([
  ['failed', 'EMPTY_ANSWER'],
  ['cancelled', 'REPORT_CANCELLED'],
] as const)('recognizes a terminal %s snapshot restored after a dropped connection without reconnecting SSE', async (status, code) => {
  let restores = 0;
  let eventConnections = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/events')) {
      eventConnections += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    restores += 1;
    return jsonResponse(restores === 1 ? snapshotFixture(0) : terminalSnapshot(status, 1));
  }));

  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));

  await waitFor(() => expect(result.current.error?.code).toBe(code));
  expect(result.current.snapshot?.status).toBe(status);
  expect(result.current.phase).toBe('error');
  expect(eventConnections).toBe(1);
});

it.each(['resolve', 'reject'] as const)('ignores a stale clarification A %s after clarification B replaces it', async (outcome) => {
  let settle!: (response?: Response) => void;
  let reject!: (error: unknown) => void;
  const pending = new Promise<Response>((resolve, onReject) => {
    settle = (response = new Response(null, { status: 204 })) => resolve(response);
    reject = onReject;
  });
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const awaitingA = {
    ...terminalSnapshot('cancelled'),
    status: 'awaiting-clarification' as const,
    clarification: { clarificationId: 'clarification-a', prompt: '请明确 A', reason: 'ambiguous-subject' as const, suggestions: [] },
  };
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/events')) return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    if (url.endsWith('/clarifications')) return pending;
    return Promise.resolve(jsonResponse(awaitingA));
  }));
  const { result } = renderHook(() => useReportSession({ reportId: REPORT_ID }));
  await waitFor(() => expect(result.current.snapshot?.clarification?.clarificationId).toBe('clarification-a'));

  let submission!: Promise<void>;
  act(() => { submission = result.current.submitClarification('clarification-a', '分析 A'); });
  await waitFor(() => expect(streamController).toBeDefined());
  const replacement: ReportEvent = {
    type: 'report.clarification-required',
    sequence: 1,
    clarification: { clarificationId: 'clarification-b', prompt: '请明确 B', reason: 'ambiguous-period', suggestions: [] },
  };
  act(() => streamController.enqueue(new TextEncoder().encode(`id: 1\ndata: ${JSON.stringify(replacement)}\n\n`)));
  await waitFor(() => expect(result.current.snapshot?.clarification?.clarificationId).toBe('clarification-b'));

  if (outcome === 'resolve') settle();
  else reject(new TypeError('stale private failure'));
  await expect(submission).resolves.toBeUndefined();
  expect(result.current.snapshot?.clarification?.clarificationId).toBe('clarification-b');
  expect(result.current.error).toBeNull();
});
