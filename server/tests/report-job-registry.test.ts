import { describe, expect, it, vi } from 'vitest';
import { REPORT_MAX_SLIDES, type ReportSlide, type SlideOutline } from '../../shared/report';
import {
  reportEventSchema,
  reportJobSnapshotSchema,
} from '../../shared/report-schema';
import type { ReportEvidenceBundle } from '../src/domain/report-evidence';
import {
  MAX_REPORT_JOBS,
  REPORT_ABSOLUTE_TTL_MS,
  REPORT_SLIDING_TTL_MS,
  ReportJobRegistry,
  type ReportActivity,
} from '../src/services/report-job-registry';

const MINUTE = 60_000;

const evidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:test',
  knowledge: [{ key: 'knowledge:0', topic: '污水处理', provenance: 'model-knowledge' }],
};
const newerEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:newer',
  knowledge: [{ key: 'knowledge:0', topic: '更新后的污水处理知识', provenance: 'model-knowledge' }],
};
const createInput = { question: '请分析', originPage: 'overview' as const };

function outline(id: string, order: number): SlideOutline {
  return {
    id, order, title: `第 ${order + 1} 页`, purpose: '回答问题', role: order === 0 ? 'answer' : 'evidence',
    layout: 'concept-center', evidencePolicy: 'knowledge', visualKind: 'capability-map',
    evidenceKeys: ['knowledge:0'], status: 'planned',
  };
}

function slide(id: string, order: number): ReportSlide {
  const ref = {
    key: 'knowledge:0', kind: 'knowledge' as const, source: 'model-knowledge' as const,
    snapshotId: evidence.snapshotId, label: '污水处理',
  };
  const claimId = `${id}-claim`;
  return {
    id, order, evidenceSnapshotId: evidence.snapshotId, role: order === 0 ? 'answer' : 'evidence',
    layout: 'concept-center', evidencePolicy: 'knowledge', title: `第 ${order + 1} 页`, takeaway: '已完成',
    takeawayClaimIds: [claimId],
    claims: [{ id: claimId, text: '已完成', kind: 'knowledge', evidenceRefs: [ref] }],
    visual: { kind: 'capability-map', items: [{ id: `${id}-item`, title: '分析', detail: '已完成', claimIds: [claimId] }] },
    metrics: [], evidenceRefs: [ref],
    narration: [
      { id: `${id}-segment-1`, text: '第一段', speechId: `${id}-speech-1`, claimIds: [claimId] },
      { id: `${id}-segment-2`, text: '第二段', speechId: `${id}-speech-2`, claimIds: [claimId] },
    ],
  };
}

function clockRegistry(options: ConstructorParameters<typeof ReportJobRegistry>[0] = {}) {
  let now = 0;
  let id = 0;
  const registry = new ReportJobRegistry({ now: () => now, createId: () => `report-${++id}`, ...options });
  return { registry, advance: (ms: number) => { now += ms; } };
}

function publishReady(registry: ReportJobRegistry, reportId: string): void {
  registry.setEvidence(reportId, evidence);
  registry.publishOutline(reportId, [outline('page-1', 0)]);
  registry.publishSlide(reportId, slide('page-1', 0));
  registry.complete(reportId);
}

describe('ReportJobRegistry intent-first reducer', () => {
  it('stores frozen evidence bundles by snapshot ID without replacing an existing bundle', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;

    expect(registry.setEvidence(reportId, evidence)).toBe(true);
    expect(registry.setEvidence(reportId, newerEvidence)).toBe(true);
    expect(registry.getEvidence(reportId, evidence.snapshotId)).toEqual(evidence);
    expect(registry.getEvidence(reportId, newerEvidence.snapshotId)).toEqual(newerEvidence);
    expect(Object.isFrozen(registry.getEvidence(reportId, evidence.snapshotId))).toBe(true);
    expect(() => registry.setEvidence(reportId, {
      ...evidence,
      knowledge: [{ key: 'knowledge:0', topic: '不允许覆盖', provenance: 'model-knowledge' }],
    })).toThrow('REPORT_EVIDENCE_IMMUTABLE');
    expect(registry.getEvidence(reportId, 'missing-snapshot')).toBeUndefined();
  });

  it('bounds unreferenced evidence while retaining every exact page binding', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [outline('bound-page', 0)]);
    registry.publishSlide(reportId, slide('bound-page', 0));

    const unboundIds = Array.from({ length: REPORT_MAX_SLIDES * 3 }, (_, index) => `evidence:unbound-${index}`);
    for (const [index, snapshotId] of unboundIds.entries()) {
      registry.setEvidence(reportId, {
        snapshotId,
        knowledge: [{ key: 'knowledge:0', topic: `未绑定证据 ${index}`, provenance: 'model-knowledge' }],
      });
    }

    expect(registry.getEvidenceForSlide(reportId, 'bound-page')).toEqual(evidence);
    expect(registry.getEvidence(reportId, unboundIds.at(-1)!)).toMatchObject({ snapshotId: unboundIds.at(-1) });
    const retained = [evidence.snapshotId, ...unboundIds]
      .filter((snapshotId) => registry.getEvidence(reportId, snapshotId) !== undefined);
    expect(retained).toContain(evidence.snapshotId);
    expect(retained.length).toBeLessThanOrEqual(REPORT_MAX_SLIDES + 1);
  });

  it('marks a corrected page as superseded and activates the appended correction page', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [outline('slide-old', 0), outline('slide-correction', 1)]);
    registry.publishSlide(reportId, slide('slide-old', 0));
    registry.publishSlide(reportId, slide('slide-correction', 1));
    const oldBefore = registry.getSnapshot(reportId)!.slides[0]!;

    expect(registry.markSlideSuperseded(reportId, 'slide-old', 'slide-correction')).toBe(true);
    expect(registry.updateSession(reportId, { activity: 'page', activeSlideId: 'slide-correction' })).toBe(true);

    const corrected = registry.getSnapshot(reportId)!;
    expect(corrected.slides.find(({ id }) => id === 'slide-old')).toEqual({
      ...oldBefore,
      supersededBySlideId: 'slide-correction',
    });
    expect(corrected.conversation.activeSlideId).toBe('slide-correction');
  });

  it('allows only forward acyclic supersession chains', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [outline('slide-a', 0), outline('slide-b', 1), outline('slide-c', 2)]);
    registry.publishSlide(reportId, slide('slide-a', 0));
    registry.publishSlide(reportId, slide('slide-b', 1));
    registry.publishSlide(reportId, slide('slide-c', 2));

    expect(registry.markSlideSuperseded(reportId, 'slide-b', 'slide-a')).toBe(false);
    expect(() => registry.publishSlide(reportId, {
      ...slide('slide-b', 1),
      supersededBySlideId: 'slide-a',
    })).toThrow('REPORT_SLIDE_IMMUTABLE');
    expect(registry.markSlideSuperseded(reportId, 'slide-a', 'slide-b')).toBe(true);
    expect(registry.markSlideSuperseded(reportId, 'slide-b', 'slide-c')).toBe(true);
    expect(registry.getSnapshot(reportId)?.slides.map(({ id, supersededBySlideId }) => ({ id, supersededBySlideId })))
      .toEqual([
        { id: 'slide-a', supersededBySlideId: 'slide-b' },
        { id: 'slide-b', supersededBySlideId: 'slide-c' },
        { id: 'slide-c', supersededBySlideId: undefined },
      ]);
  });

  it('creates unique empty understanding snapshots', () => {
    const { registry } = clockRegistry();
    const first = registry.create(createInput);
    const second = registry.create({ ...createInput, question: '第二个问题' });
    expect(first).toMatchObject({
      reportId: 'report-1', status: 'generating', phase: 'understanding', clarification: null,
      outline: [], slides: [], lastSequence: 0,
    });
    expect(second.reportId).toBe('report-2');
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('reduces phase, outline and page events with monotonic sequences', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    registry.setEvidence(reportId, evidence);
    registry.setPhase(reportId, 'planning');
    registry.publishOutline(reportId, [outline('page-1', 0), outline('page-2', 1)]);
    registry.setPhase(reportId, 'generating-first-slide');
    registry.markSlideGenerating(reportId, 'page-1');
    registry.publishSlide(reportId, slide('page-1', 0));
    registry.setPhase(reportId, 'generating-slides');
    registry.markSlideGenerating(reportId, 'page-2');
    registry.publishSlide(reportId, slide('page-2', 1));
    expect(registry.complete(reportId)).toBe(true);

    const events = registry.replayAfter(reportId, 0)!;
    expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.map(({ type }) => type)).toContain('report.state-changed');
    expect(events.at(-1)).toMatchObject({ type: 'report.completed', status: 'ready' });
    expect(registry.getSnapshot(reportId)).toMatchObject({ status: 'ready', phase: 'completed' });
  });

  it('does not report partial until every planned page has settled', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    registry.publishOutline(reportId, [outline('page-1', 0), outline('page-2', 1), outline('page-3', 2)]);
    registry.publishSlide(reportId, slide('page-1', 0));
    registry.markSlideFailed(reportId, 'page-2', true);
    expect(registry.complete(reportId)).toBe(false);
    expect(registry.getSnapshot(reportId)?.status).toBe('generating');
    registry.publishSlide(reportId, slide('page-3', 2));
    expect(registry.complete(reportId)).toBe(true);
    expect(registry.getSnapshot(reportId)).toMatchObject({ status: 'partial', phase: 'completed' });
  });

  it('fails safely before page zero and never invents a fallback page', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    registry.publishOutline(reportId, [outline('page-1', 0)]);
    registry.markSlideFailed(reportId, 'page-1', false);
    registry.fail(reportId, 'MALFORMED_RESPONSE');
    expect(registry.getSnapshot(reportId)).toMatchObject({ status: 'failed', phase: null, slides: [] });
  });

  it('publishes and atomically accepts clarification while rejecting stale IDs', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    const clarification = {
      clarificationId: 'clarification-1', prompt: '请确认时间范围', reason: 'ambiguous-period' as const,
      suggestions: ['近 30 日'],
    };
    expect(registry.requireClarification(reportId, clarification)).toBe(true);
    expect(registry.getSnapshot(reportId)).toMatchObject({ status: 'awaiting-clarification', phase: null, clarification });
    expect(registry.acceptClarification(reportId, 'stale', '近 7 日')).toBe(false);
    expect(registry.acceptClarification(reportId, clarification.clarificationId, '近 30 日')).toBe(true);
    expect(registry.getSnapshot(reportId)).toMatchObject({ status: 'generating', phase: 'understanding', clarification: null });
    expect(registry.getConversationMemory(reportId)?.clarifications).toEqual([
      expect.objectContaining({ clarificationId: 'clarification-1', answer: '近 30 日' }),
    ]);
  });

  it('accepts cancellation before and after outline and preserves committed state', () => {
    const { registry } = clockRegistry();
    const emptyId = registry.create(createInput).reportId;
    expect(registry.cancel(emptyId)).toBe(true);
    expect(registry.getSnapshot(emptyId)).toMatchObject({ status: 'cancelled', outline: [], slides: [] });

    const outlinedId = registry.create(createInput).reportId;
    registry.publishOutline(outlinedId, [outline('page-1', 0)]);
    expect(registry.cancel(outlinedId)).toBe(true);
    expect(registry.getSnapshot(outlinedId)).toMatchObject({ status: 'cancelled', outline: [{ id: 'page-1' }], slides: [] });
    expect(registry.publishSlide(outlinedId, slide('page-1', 0))).toBe(false);
    expect(registry.beginActivity(outlinedId, 'narration')).toBeUndefined();
    expect(registry.subscribe(outlinedId, () => undefined)).toBeUndefined();
    expect(registry.replayAfter(outlinedId, 0)?.at(-1)).toMatchObject({ type: 'report.cancelled' });
  });

  it('delivers cancellation before closing active subscribers and aborts activities once', () => {
    const removeSpeech = vi.fn();
    const { registry } = clockRegistry({ removeSpeechForReport: removeSpeech });
    const reportId = registry.create(createInput).reportId;
    const events: string[] = [];
    registry.subscribe(reportId, (event) => events.push(event.type));
    const signal = registry.beginActivity(reportId, 'generation')!;
    expect(registry.cancel(reportId)).toBe(true);
    expect(events.at(-1)).toBe('report.cancelled');
    expect(signal.aborted).toBe(true);
    expect(registry.cancel(reportId)).toBe(true);
    expect(removeSpeech).toHaveBeenCalledTimes(1);
  });

  it('keeps cancelled snapshots readable until TTL expiry', () => {
    const { registry, advance } = clockRegistry({ slidingTtlMs: 10, absoluteTtlMs: 100 });
    const reportId = registry.create(createInput).reportId;
    registry.cancel(reportId);
    expect(registry.getSnapshot(reportId)?.status).toBe('cancelled');
    advance(11);
    registry.sweep();
    expect(registry.getSnapshot(reportId)).toBeUndefined();
  });

  it('keeps failed reports terminal and rejects generation, retry, follow-up, mutation, and cancellation resurrection', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [outline('page-1', 0)]);
    registry.markSlideFailed(reportId, 'page-1', true);
    const activeGeneration = registry.beginActivity(reportId, 'generation')!;
    registry.fail(reportId, 'UPSTREAM_TIMEOUT');
    const failed = registry.getSnapshot(reportId);

    expect(activeGeneration.aborted).toBe(true);
    expect(registry.setPhase(reportId, 'generating-first-slide')).toBe(false);
    expect(registry.resetSlideForRetry(reportId, 'page-1')).toBe(false);
    expect(registry.beginActivity(reportId, 'generation')).toBeUndefined();
    expect(registry.beginActivity(reportId, 'follow-up')).toBeUndefined();
    expect(registry.reserveFollowUp(reportId, 'turn', 'fingerprint', Promise.resolve({} as never))).toBeUndefined();
    expect(registry.publishSlide(reportId, slide('page-1', 0))).toBe(false);
    expect(registry.publishOutline(reportId, [outline('page-1', 0), outline('late', 1)])).toBe(false);
    expect(registry.cancel(reportId)).toBe(true);
    expect(registry.getSnapshot(reportId)).toEqual(failed);
  });

  it('allows a retryable later page in partial state to return to generation', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [outline('page-1', 0), outline('page-2', 1)]);
    registry.publishSlide(reportId, slide('page-1', 0));
    registry.markSlideFailed(reportId, 'page-2', true);
    registry.complete(reportId);

    const beforeRetry = registry.getSnapshot(reportId)!;
    const observedSnapshots: unknown[] = [];
    registry.subscribe(reportId, () => observedSnapshots.push(registry.getSnapshot(reportId)));

    expect(beforeRetry.status).toBe('partial');
    expect(registry.resetSlideForRetry(reportId, 'page-2')).toBe(true);
    expect(registry.getSnapshot(reportId)).toMatchObject({
      status: 'generating', phase: 'generating-slides', outline: [{ status: 'ready' }, { status: 'planned' }],
    });

    const retryEvents = registry.replayAfter(reportId, beforeRetry.lastSequence)!;
    expect(retryEvents.map(({ sequence }) => sequence)).toEqual([
      beforeRetry.lastSequence + 1,
      beforeRetry.lastSequence + 2,
    ]);
    expect(retryEvents.map(({ type }) => type)).toEqual(['report.state-changed', 'report.outline']);
    expect(retryEvents.every((event) => reportEventSchema.safeParse(event).success)).toBe(true);
    expect(observedSnapshots).toHaveLength(2);
    expect(observedSnapshots.every((snapshot) => reportJobSnapshotSchema.safeParse(snapshot).success)).toBe(true);
  });

  it('publishes an appended outline as one valid sequenced transition', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    publishReady(registry, reportId);
    const beforeAppend = registry.getSnapshot(reportId)!;
    const observedSnapshots: unknown[] = [];
    registry.subscribe(reportId, () => observedSnapshots.push(registry.getSnapshot(reportId)));

    expect(registry.publishOutline(reportId, [outline('page-1', 0), outline('page-2', 1)])).toBe(true);

    expect(registry.getSnapshot(reportId)).toMatchObject({
      status: 'generating',
      phase: 'generating-slides',
      outline: [{ id: 'page-1', status: 'ready' }, { id: 'page-2', status: 'planned' }],
    });
    const appendEvents = registry.replayAfter(reportId, beforeAppend.lastSequence)!;
    expect(appendEvents.map(({ sequence }) => sequence)).toEqual([
      beforeAppend.lastSequence + 1,
      beforeAppend.lastSequence + 2,
    ]);
    expect(appendEvents.map(({ type }) => type)).toEqual(['report.state-changed', 'report.outline']);
    expect(appendEvents.every((event) => reportEventSchema.safeParse(event).success)).toBe(true);
    expect(observedSnapshots).toHaveLength(2);
    expect(observedSnapshots.every((snapshot) => reportJobSnapshotSchema.safeParse(snapshot).success)).toBe(true);
  });

  it('keeps an append event batch ahead of a synchronous subscriber mutation', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    publishReady(registry, reportId);
    const beforeAppend = registry.getSnapshot(reportId)!;
    const delivered: string[] = [];
    registry.subscribe(reportId, (event) => {
      delivered.push(event.type);
      if (event.type === 'report.state-changed' && event.status === 'generating') registry.cancel(reportId);
    });

    expect(registry.publishOutline(reportId, [outline('page-1', 0), outline('page-2', 1)])).toBe(true);

    expect(registry.replayAfter(reportId, beforeAppend.lastSequence)?.map(({ type }) => type)).toEqual([
      'report.state-changed',
      'report.outline',
      'report.cancelled',
    ]);
    expect(delivered).toEqual(['report.state-changed', 'report.outline', 'report.cancelled']);
    expect(reportJobSnapshotSchema.safeParse(registry.getSnapshot(reportId)).success).toBe(true);
  });

  it('rejects republished metadata changes and preserves every existing outline field and server state', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    const original = [outline('page-1', 0), outline('page-2', 1)];
    registry.publishOutline(reportId, original);
    registry.publishSlide(reportId, slide('page-1', 0));
    const before = registry.getSnapshot(reportId)!.outline;
    const rewritten = structuredClone(before);
    rewritten[0] = {
      ...rewritten[0]!, title: 'rewritten', purpose: 'rewritten', role: 'action', layout: 'action-path',
      evidencePolicy: 'mixed', visualKind: 'recommendation-path', evidenceKeys: ['knowledge:other'], status: 'planned',
    };

    expect(() => registry.publishOutline(reportId, [...rewritten, outline('page-3', 2)]))
      .toThrow('REPORT_OUTLINE_IMMUTABLE');
    expect(registry.getSnapshot(reportId)?.outline).toEqual(before);
  });

  it('keeps subscribers and mutations isolated by report and cleans unsubscribe once', () => {
    const { registry } = clockRegistry();
    const first = registry.create(createInput).reportId;
    const second = registry.create({ ...createInput, question: '第二份报告' }).reportId;
    const subscriber = vi.fn();
    const unsubscribe = registry.subscribe(first, subscriber)!;

    registry.publishOutline(second, [outline('second-page', 0)]);
    registry.publishOutline(first, [outline('first-page', 0)]);
    unsubscribe();
    unsubscribe();
    registry.markSlideGenerating(first, 'first-page');

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber.mock.calls[0]?.[0]).toMatchObject({ type: 'report.outline', sequence: 1 });
    expect(registry.getSnapshot(second)?.lastSequence).toBe(1);
  });

  it('uses a sliding TTL without exceeding the absolute lifetime', () => {
    const { registry, advance } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    advance(29 * MINUTE);
    expect(registry.getSnapshot(reportId)).toBeDefined();
    advance(29 * MINUTE);
    expect(registry.getSnapshot(reportId)).toBeDefined();
    advance(63 * MINUTE);
    expect(registry.getSnapshot(reportId)).toBeUndefined();
    expect(REPORT_SLIDING_TTL_MS).toBe(30 * MINUTE);
    expect(REPORT_ABSOLUTE_TTL_MS).toBe(2 * 60 * MINUTE);
  });

  it('replays only retained events and reports a replay gap', () => {
    const { registry } = clockRegistry({ replayCapacity: 2 });
    const reportId = registry.create(createInput).reportId;
    registry.publishOutline(reportId, [outline('page-1', 0)]);
    registry.markSlideGenerating(reportId, 'page-1');
    registry.markSlideFailed(reportId, 'page-1', true);

    expect(registry.replayAfter(reportId, 2)?.map(({ sequence }) => sequence)).toEqual([3]);
    expect(registry.replayAfter(reportId, 0)).toBeNull();
  });

  it('protects active leases at capacity and releases only the exact signal once', () => {
    const { registry } = clockRegistry({ maxEntries: 4 });
    const activities: ReportActivity[] = ['generation', 'sse', 'narration', 'follow-up'];
    const leases = activities.map((activity) => {
      const reportId = registry.create(createInput).reportId;
      return { reportId, activity, signal: registry.beginActivity(reportId, activity)! };
    });
    expect(() => registry.create(createInput)).toThrow('REPORT_CAPACITY');
    expect(MAX_REPORT_JOBS).toBe(32);

    const lease = leases[0]!;
    registry.endActivity(lease.reportId, lease.activity, new AbortController().signal);
    registry.endActivity(lease.reportId, lease.activity, lease.signal);
    registry.endActivity(lease.reportId, lease.activity, lease.signal);
    expect(registry.create(createInput).reportId).not.toBe(lease.reportId);
  });

  it('evicts the oldest inactive report and notifies ownership cleanup once', () => {
    const removeSpeech = vi.fn();
    const ownershipLost = vi.fn();
    const { registry, advance } = clockRegistry({ maxEntries: 2, removeSpeechForReport: removeSpeech });
    const unsubscribe = registry.subscribeOwnershipLoss(ownershipLost);
    const first = registry.create(createInput).reportId;
    advance(1);
    const second = registry.create(createInput).reportId;
    advance(1);
    const third = registry.create(createInput).reportId;

    expect(registry.getSnapshot(first)).toBeUndefined();
    expect(registry.getSnapshot(second)).toBeDefined();
    expect(registry.getSnapshot(third)).toBeDefined();
    expect(removeSpeech).toHaveBeenCalledWith(first);
    expect(ownershipLost).toHaveBeenCalledExactlyOnceWith(first);
    unsubscribe();
    unsubscribe();
  });

  it('notifies ownership loss for cancellation, expiry, and eviction without leaking after unsubscribe', () => {
    const ownershipLost = vi.fn();
    const { registry, advance } = clockRegistry({ maxEntries: 1, absoluteTtlMs: 2 });
    const unsubscribe = registry.subscribeOwnershipLoss(ownershipLost);
    const cancelled = registry.create(createInput).reportId;
    registry.cancel(cancelled);
    const evicted = registry.create(createInput).reportId;
    const expired = registry.create(createInput).reportId;
    advance(3);
    registry.sweep();

    expect(ownershipLost.mock.calls.map(([reportId]) => reportId)).toEqual([cancelled, evicted, expired]);
    unsubscribe();
    unsubscribe();
    registry.create(createInput);
    advance(3);
    registry.sweep();
    expect(ownershipLost).toHaveBeenCalledTimes(3);
  });

  it('keeps activity leases through sliding expiry but not absolute expiry', () => {
    const { registry, advance } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    const signal = registry.beginActivity(reportId, 'generation')!;
    advance(REPORT_SLIDING_TTL_MS + 1);
    registry.sweep();
    expect(registry.getSnapshot(reportId)).toBeDefined();
    advance(REPORT_ABSOLUTE_TTL_MS);
    registry.sweep();
    expect(signal.aborted).toBe(true);
    expect(registry.getSnapshot(reportId)).toBeUndefined();
  });

  it('never exposes server-only evidence, idempotency, or fact-ledger state', () => {
    const { registry } = clockRegistry();
    const reportId = registry.create(createInput).reportId;
    publishReady(registry, reportId);
    const promise = Promise.resolve({} as never);
    const reservation = registry.reserveFollowUp(reportId, 'ledger-key', 'ledger-fingerprint', promise);
    if (reservation?.kind !== 'started') throw new Error('reservation failed');
    const response = {
      turnId: 'turn-ledger', answer: 'answer', speechId: 'speech-ledger', citedEvidence: [], needsClarification: false,
      resumeCursor: { slideId: 'page-1', segmentId: 'page-1-segment-1', offsetMs: 0 },
    };
    registry.commitFollowUp(reportId, {
      ordinal: reservation.ordinal, signal: reservation.signal, response,
      turn: { id: 'turn-ledger', question: 'question', answer: 'answer', citedEvidence: [], needsClarification: false, createdAt: new Date(0).toISOString() },
      facts: [{ evidenceSnapshotId: evidence.snapshotId, evidenceKey: 'tn', value: 2.7, unit: 'mg/L', dateRange: { from: '2026-07-01', to: '2026-07-31' }, sampleCount: 31 }],
    });

    expect(registry.getConversationMemory(reportId)?.factLedger).toHaveLength(1);
    expect(JSON.stringify(registry.getSnapshot(reportId))).not.toMatch(/factLedger|idempotency|ledger-fingerprint/u);
  });
});
