import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { CreateReportRequest, FollowUpResponse, ReportSlide, SlideOutline } from '../../shared/report';
import { createServer } from '../src/app';
import type { ReportEvidenceBundle } from '../src/domain/report-evidence';
import { ReportFollowUpError, type ReportFollowUpService } from '../src/services/report-follow-up';
import type { ReportGenerator } from '../src/services/report-generator';
import { ReportJobRegistry } from '../src/services/report-job-registry';

const REPORT_ID = '00000000-0000-4000-8000-000000000001';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000099';
const evidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:public-snapshot',
  knowledge: [{ key: 'knowledge:0', topic: 'provider-body-secret', provenance: 'model-knowledge' }],
};

function outline(id = 'slide-1', order = 0): SlideOutline {
  return {
    id, order, title: `第 ${order + 1} 页`, purpose: '解释', role: 'answer', layout: 'concept-center',
    evidencePolicy: 'knowledge', visualKind: 'capability-map', evidenceKeys: ['knowledge:0'], status: 'planned',
  };
}

function slide(id = 'slide-1', order = 0): ReportSlide {
  const ref = { key: 'knowledge:0', kind: 'knowledge' as const, source: 'model-knowledge' as const, snapshotId: evidence.snapshotId, label: '知识' };
  const claimId = `${id}-claim`;
  return {
    id, order, evidenceSnapshotId: evidence.snapshotId, role: 'answer', layout: 'concept-center', evidencePolicy: 'knowledge',
    title: `第 ${order + 1} 页`, takeaway: '已完成', takeawayClaimIds: [claimId],
    claims: [{ id: claimId, text: '已完成', kind: 'knowledge', evidenceRefs: [ref] }],
    visual: { kind: 'capability-map', items: [{ id: `${id}-item`, title: '分析', detail: '已完成', claimIds: [claimId] }] },
    metrics: [], evidenceRefs: [ref],
    narration: [
      { id: `${id}-segment-1`, text: '第一段', speechId: `${id}-speech-1`, claimIds: [claimId] },
      { id: `${id}-segment-2`, text: '第二段', speechId: `${id}-speech-2`, claimIds: [claimId] },
    ],
  };
}

function publishReady(registry: ReportJobRegistry, question = '分析'): string {
  const snapshot = registry.create({ question, originPage: 'overview' });
  registry.setEvidence(snapshot.reportId, evidence);
  registry.publishOutline(snapshot.reportId, [outline()]);
  registry.publishSlide(snapshot.reportId, slide());
  registry.complete(snapshot.reportId);
  return snapshot.reportId;
}

function generatorDouble(registry: ReportJobRegistry) {
  const createReport = vi.fn((input: CreateReportRequest) => {
    const snapshot = registry.create({ question: input.question, originPage: input.page });
    return { reportId: snapshot.reportId, snapshot };
  });
  const answerClarification = vi.fn((reportId: string, submission: { clarificationId: string; answer: string }) => {
    if (!registry.acceptClarification(reportId, submission.clarificationId, submission.answer)) {
      throw new Error('REPORT_STALE_TURN');
    }
    return Promise.resolve();
  });
  const retrySlide = vi.fn();
  const prioritize = vi.fn();
  return {
    generator: {
      dependencies: { registry }, createReport, run: vi.fn(), answerClarification,
      prioritize, retrySlide, appendNewTopic: vi.fn(),
    } as unknown as ReportGenerator,
    createReport,
    answerClarification,
    prioritize,
    retrySlide,
  };
}

function harness(registry = new ReportJobRegistry({ createId: () => REPORT_ID })) {
  const fake = generatorDouble(registry);
  return { registry, ...fake, app: createServer({ reportRegistry: registry, reportGenerator: fake.generator }) };
}

describe('report REST API', () => {
  it('returns 202 with only reportId and an empty understanding snapshot', async () => {
    const { app, createReport } = harness();
    const response = await request(app).post('/api/ai/reports').send({ question: '回顾预警', page: 'overview' });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      reportId: REPORT_ID,
      snapshot: expect.objectContaining({
        status: 'generating', phase: 'understanding', clarification: null, outline: [], slides: [],
      }),
    });
    expect(response.body).not.toHaveProperty('bootstrapSlide');
    expect(createReport).toHaveBeenCalledWith({ question: '回顾预警', page: 'overview' });
  });

  it('returns cancelled snapshots from GET without exposing private evidence', async () => {
    const { app, registry } = harness();
    const reportId = publishReady(registry);
    registry.cancel(reportId);
    const response = await request(app).get(`/api/ai/reports/${reportId}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reportId, status: 'cancelled', slides: [{ id: 'slide-1' }] });
    expect(JSON.stringify(response.body)).not.toMatch(/provider-body-secret|C:\/workbooks/u);
  });

  it('accepts current clarification and returns 409 REPORT_STALE_TURN for a stale ID', async () => {
    const { app, registry } = harness();
    const snapshot = registry.create({ question: '回顾预警', originPage: 'overview' });
    registry.requireClarification(snapshot.reportId, {
      clarificationId: 'clarification-1', prompt: '请确认时间', reason: 'ambiguous-period', suggestions: ['近 30 日'],
    });
    const stale = await request(app).post(`/api/ai/reports/${snapshot.reportId}/clarifications`).send({
      clarificationId: 'stale', answer: '近 7 日',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('REPORT_STALE_TURN');

    const accepted = await request(app).post(`/api/ai/reports/${snapshot.reportId}/clarifications`).send({
      clarificationId: 'clarification-1', answer: '近 30 日',
    });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ reportId: snapshot.reportId, status: 'generating', phase: 'understanding' });
  });

  it('validates report and clarification bodies with safe errors', async () => {
    const { app } = harness();
    for (const response of [
      await request(app).post('/api/ai/reports').send({ question: '', page: 'overview' }),
      await request(app).post(`/api/ai/reports/${REPORT_ID}/clarifications`).send({ clarificationId: '', answer: '' }),
      await request(app).get('/api/ai/reports/%20'),
    ]) {
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });

  it('keeps cancellation idempotent and conceals unknown IDs', async () => {
    const { app, registry } = harness();
    const reportId = publishReady(registry);
    expect((await request(app).delete(`/api/ai/reports/${reportId}`)).status).toBe(204);
    expect((await request(app).delete(`/api/ai/reports/${reportId}`)).status).toBe(204);
    expect((await request(app).delete(`/api/ai/reports/${UNKNOWN_ID}`)).status).toBe(204);
    expect(registry.getSnapshot(reportId)?.status).toBe('cancelled');
  });

  it('updates only report-owned ready narration state', async () => {
    const { app, registry, prioritize } = harness();
    const reportId = publishReady(registry);
    const response = await request(app).patch(`/api/ai/reports/${reportId}/session`).send({
      activity: 'narration', activeSlideId: 'slide-1',
      narrationCursor: { slideId: 'slide-1', segmentId: 'slide-1-segment-2', offsetMs: 42 },
    });
    expect(response.status).toBe(204);
    expect(registry.getSnapshot(reportId)?.conversation).toMatchObject({
      activeSlideId: 'slide-1', narrationCursor: { segmentId: 'slide-1-segment-2', offsetMs: 42 },
    });
    expect(prioritize).toHaveBeenCalledWith(reportId, 'slide-1');
  });

  it('returns a validated follow-up response from an intent-first fixture', async () => {
    const registry = new ReportJobRegistry({ createId: () => REPORT_ID });
    const reportId = publishReady(registry);
    const result: FollowUpResponse = {
      turnId: 'turn-1', answer: '继续解释', speechId: 'speech-answer', citedEvidence: [], needsClarification: true,
      resumeCursor: { slideId: 'slide-1', segmentId: 'slide-1-segment-1', offsetMs: 0 },
    };
    const answer = vi.fn(async () => result);
    const fake = generatorDouble(registry);
    const app = createServer({
      reportRegistry: registry,
      reportGenerator: fake.generator,
      reportFollowUpService: { answer } as unknown as ReportFollowUpService,
    });
    const response = await request(app).post(`/api/ai/reports/${reportId}/follow-ups`)
      .set('Idempotency-Key', 'turn-1').send({ question: '为什么？', slideId: 'slide-1' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
  });

  it('maps stale follow-up failures safely', async () => {
    const registry = new ReportJobRegistry({ createId: () => REPORT_ID });
    const reportId = publishReady(registry);
    const fake = generatorDouble(registry);
    const app = createServer({
      reportRegistry: registry,
      reportGenerator: fake.generator,
      reportFollowUpService: {
        answer: vi.fn(() => Promise.reject(new ReportFollowUpError('REPORT_STALE_TURN'))),
      } as unknown as ReportFollowUpService,
    });
    const response = await request(app).post(`/api/ai/reports/${reportId}/follow-ups`)
      .set('Idempotency-Key', 'turn-stale').send({ question: '为什么？', slideId: 'slide-1' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REPORT_STALE_TURN');
  });

  it('rejects retry for a terminal first-page failure but accepts a failed later page in partial state', async () => {
    const failedHarness = harness();
    const failedId = failedHarness.registry.create({ question: '分析', originPage: 'overview' }).reportId;
    failedHarness.registry.setEvidence(failedId, evidence);
    failedHarness.registry.publishOutline(failedId, [outline()]);
    failedHarness.registry.markSlideFailed(failedId, 'slide-1', true);
    failedHarness.registry.fail(failedId, 'UPSTREAM_TIMEOUT');

    const failedRetry = await request(failedHarness.app)
      .post(`/api/ai/reports/${failedId}/slides/slide-1/retries`).send({});
    expect(failedRetry.status).toBe(409);
    expect(failedRetry.body).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(failedHarness.retrySlide).not.toHaveBeenCalled();
    expect(failedHarness.registry.getSnapshot(failedId)?.status).toBe('failed');

    const partialRegistry = new ReportJobRegistry({ createId: () => REPORT_ID });
    const partialHarness = harness(partialRegistry);
    const partialId = partialRegistry.create({ question: '分析', originPage: 'overview' }).reportId;
    partialRegistry.setEvidence(partialId, evidence);
    partialRegistry.publishOutline(partialId, [outline('slide-1', 0), outline('slide-2', 1)]);
    partialRegistry.publishSlide(partialId, slide('slide-1', 0));
    partialRegistry.markSlideFailed(partialId, 'slide-2', true);
    partialRegistry.complete(partialId);

    const laterRetry = await request(partialHarness.app)
      .post(`/api/ai/reports/${partialId}/slides/slide-2/retries`).send({});
    expect(laterRetry.status).toBe(202);
    expect(partialHarness.retrySlide).toHaveBeenCalledWith(partialId, 'slide-2');
  });
});
