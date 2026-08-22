import { describe, expect, it, vi } from 'vitest';
import { ATOMIC_VISUAL_KINDS, type EvidenceRef, type FollowUpRequest, type ReportSlide, type SlideOutline } from '../../shared/report';
import { followUpResponseSchema } from '../../shared/report-schema';
import type { FollowUpEvidenceBundle } from '../src/domain/report-follow-up-validation';
import type { ReportEvidenceBundle as PageEvidenceBundle } from '../src/domain/report-evidence';
import type { DeepSeekCompletionRequest } from '../src/services/deepseek-client';
import { ReportFollowUpError, ReportFollowUpService } from '../src/services/report-follow-up';
import { ReportJobRegistry } from '../src/services/report-job-registry';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

const evidence: FollowUpEvidenceBundle = {
  snapshotId: 'immutable-dataset-snapshot',
  mode: 'data',
  analysis: {
    scope: {
      modules: ['energy'],
      metrics: ['blowerKwh'],
      dateRange: { from: '2026-08-01', to: '2026-08-12' },
      sampleCount: 12,
      granularity: 'daily',
    },
    definitions: [{ key: 'blowerKwh', label: '鼓风能耗', unit: 'kWh' }],
    series: [
      { date: '2026-08-01', values: { blowerKwh: 120 } },
      { date: '2026-08-12', values: { blowerKwh: 128.4 } },
    ],
    aggregates: {
      blowerKwh: { min: 120, max: 128.4, average: 124.2, latest: 128.4, changeRate: 0.07 },
    },
    thresholdBreaches: [],
    correlations: [],
    alerts: [],
  },
};

const crossModuleEvidence: FollowUpEvidenceBundle = evidence.mode === 'data' ? {
  ...evidence,
  analysis: {
    ...evidence.analysis,
    scope: {
      ...evidence.analysis.scope,
      modules: ['energy', 'water-quality'],
      metrics: ['blowerKwh', 'tn'],
    },
    definitions: [
      ...evidence.analysis.definitions,
      { key: 'tn', label: '总氮', unit: 'mg/L', limit: 3 },
    ],
    series: evidence.analysis.series.map((row, index) => ({
      ...row,
      values: { ...row.values, tn: index === 0 ? 2.6 : 2.7 },
    })),
    aggregates: {
      ...evidence.analysis.aggregates,
      tn: { min: 2.6, max: 2.7, average: 2.65, latest: 2.7, changeRate: 0.0385 },
    },
    thresholdBreaches: [{ metric: 'tn', date: '2026-08-12', value: 2.7, limit: 3 }],
    alerts: [{
      date: '2026-08-12', level: '关注', metric: 'tn',
      reason: '接近阈值', recommendation: '持续观察',
    }],
  },
} : evidence;

type UnboundSlideFixture = {
  id: string;
  order: number;
  title: string;
  takeaway: string;
  visual: { kind: 'kpi-grid'; metrics: Array<EvidenceRef & { value: number }> };
  metrics: Array<EvidenceRef & { value: number }>;
  evidenceRefs: EvidenceRef[];
  narration: Array<{ id: string; text: string; speechId: string }>;
};

function slide(id = 'slide-energy', order = 0): UnboundSlideFixture {
  const metric = {
    key: 'blowerKwh',
    kind: 'metric' as const,
    source: 'excel' as const,
    module: 'energy' as const,
    label: '鼓风能耗',
    unit: 'kWh',
    dateRange: { from: '2026-08-01', to: '2026-08-12' },
    sampleCount: 12,
    value: 128.4,
  };
  return {
    id,
    order,
    title: '鼓风能耗趋势',
    takeaway: '当前页展示鼓风能耗',
    visual: { kind: 'kpi-grid', metrics: [metric] },
    metrics: [metric],
    evidenceRefs: [metric],
    narration: [
      { id: 'segment-1', text: '先看当前趋势。', speechId: `${id}-speech-1` },
      { id: 'segment-2', text: '再解释变化原因。', speechId: `${id}-speech-2` },
    ],
  };
}

function reportSlideFixture(
  legacySlide: UnboundSlideFixture,
  legacyEvidence: FollowUpEvidenceBundle,
): ReportSlide {
  const snapshotId = legacyEvidence.snapshotId;
  const claimId = `${legacySlide.id}-claim`;
  const refs = legacySlide.evidenceRefs.map((ref) => ({ ...ref, snapshotId }));
  const metrics = legacySlide.metrics.map((metric) => ({ ...metric, snapshotId, claimIds: [claimId] }));
  return {
    ...legacySlide,
    evidenceSnapshotId: snapshotId,
    role: 'answer',
    layout: 'split-insight',
    evidencePolicy: legacyEvidence.mode === 'data' ? 'data' : 'knowledge',
    takeawayClaimIds: [claimId],
    claims: [{ id: claimId, text: legacySlide.takeaway, kind: legacyEvidence.mode === 'data' ? 'onsite-fact' : 'knowledge', evidenceRefs: refs }],
    visual: legacySlide.visual.kind === 'kpi-grid' ? { kind: 'kpi-grid', metrics } : legacySlide.visual,
    metrics,
    evidenceRefs: refs,
    narration: legacySlide.narration.map((segment) => ({ ...segment, claimIds: [claimId] })),
  } as ReportSlide;
}

function outlineVisualKind(slide: ReportSlide): SlideOutline['visualKind'] {
  const kind = slide.visual.kind === 'data-dashboard' ? slide.visual.primary.kind : slide.visual.kind;
  if (!ATOMIC_VISUAL_KINDS.includes(kind)) {
    throw new Error(`Unexpected rendered outline visual kind: ${kind}`);
  }
  return kind;
}

const followUp: FollowUpRequest = {
  question: '它为什么升高？',
  slideId: 'slide-energy',
  interruptedSegmentId: 'segment-2',
  narrationOffsetMs: 1260,
};

const validReply = {
  answer: '这里的“它”指鼓风能耗，回答仅依据当前页证据。',
  citedEvidenceKeys: ['blowerKwh'],
  needsClarification: false,
};

function publishReadyFixture(
  registry: ReportJobRegistry,
  reportId: string,
  legacySlide: UnboundSlideFixture,
  legacyEvidence: FollowUpEvidenceBundle,
): void {
  const snapshotId = legacyEvidence.snapshotId;
  const activeEvidence: PageEvidenceBundle = {
    snapshotId,
    ...(legacyEvidence.mode === 'data' ? { analysis: legacyEvidence.analysis } : {}),
    knowledge: legacyEvidence.mode === 'knowledge'
      ? [{ key: 'knowledge:0', topic: legacyEvidence.topic, provenance: 'model-knowledge' }]
      : [],
  };
  const activeSlide = reportSlideFixture(legacySlide, legacyEvidence);
  const activeOutline: SlideOutline = {
    id: activeSlide.id, order: activeSlide.order, title: activeSlide.title, purpose: activeSlide.takeaway,
    role: activeSlide.role, layout: activeSlide.layout, evidencePolicy: activeSlide.evidencePolicy,
    visualKind: outlineVisualKind(activeSlide), evidenceKeys: activeSlide.evidenceRefs.map(({ key }) => key), status: 'planned',
  };
  registry.setEvidence(reportId, activeEvidence);
  registry.publishOutline(reportId, [activeOutline]);
  registry.publishSlide(reportId, activeSlide);
  registry.complete(reportId);
}

function readyReport(
  registry: ReportJobRegistry,
  reportId?: string,
  reportEvidence: FollowUpEvidenceBundle = evidence,
  question = '分析鼓风能耗',
): string {
  const reserved = registry.create({ question, originPage: 'energy' });
  if (reportId) expect(reserved.reportId).toBe(reportId);
  publishReadyFixture(registry, reserved.reportId, slide(), reportEvidence);
  registry.updateSession(reserved.reportId, {
    activity: 'narration',
    activeSlideId: 'slide-energy',
    narrationCursor: { slideId: 'slide-energy', segmentId: 'segment-2', offsetMs: 1260 },
  });
  return reserved.reportId;
}

function harness(overrides: Partial<ConstructorParameters<typeof ReportFollowUpService>[0]> = {}) {
  let nextId = 0;
  const registry = overrides.registry ?? new ReportJobRegistry({
    createId: () => `report-${++nextId}`,
  });
  const requestCompletion = overrides.requestCompletion ?? vi.fn(async () => JSON.stringify(validReply));
  const registerSpeech = overrides.registerSpeech ?? vi.fn(() => `answer-speech-${++nextId}`);
  const unregisterSpeech = overrides.unregisterSpeech ?? vi.fn();
  const appendNewTopic = overrides.appendNewTopic ?? vi.fn(async () => ({ added: true }));
  const service = new ReportFollowUpService({
    registry,
    settings: { apiKey: 'server-secret', baseUrl: 'https://provider.invalid', model: 'fake-model' },
    requestCompletion,
    registerSpeech,
    unregisterSpeech,
    appendNewTopic,
    createTurnId: () => `turn-${++nextId}`,
    now: () => new Date('2026-08-12T08:00:00.000Z'),
    ...overrides,
  });
  return { registry, service, requestCompletion, registerSpeech, unregisterSpeech, appendNewTopic };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ReportFollowUpError);
  expect((error as ReportFollowUpError).code).toBe(code);
}

describe('report follow-up service', () => {
  it('uses current slide, previous turn, compact summary and only server-held evidence for pronoun context', async () => {
    const { registry, service, requestCompletion } = harness();
    const reportId = readyReport(registry);

    await service.answer(reportId, followUp, 'pronoun-key');

    const prompt = String(vi.mocked(requestCompletion).mock.calls[0]?.[0].prompt);
    expect(prompt).toContain('鼓风能耗');
    expect(prompt).toContain('segment-2');
    expect(prompt).toContain('"currentEvidenceSnapshotId":"immutable-dataset-snapshot"');
    expect(prompt).not.toMatch(/server-secret|provider\.invalid|fake-model|[A-Z]:\\|\.env/u);
    expect(registry.getSnapshot(reportId)?.conversation.turns).toHaveLength(1);
  });

  it('provides the full immutable cross-module evidence while highlighting the current slide', async () => {
    const { registry, service, requestCompletion } = harness();
    const reportId = readyReport(
      registry,
      undefined,
      crossModuleEvidence,
      '分析 C:\\private\\plant.xlsx，DEEPSEEK_API_KEY=do-not-leak',
    );

    await service.answer(reportId, { ...followUp, question: '全厂还应关注什么？' }, 'global-evidence');

    const prompt = String(vi.mocked(requestCompletion).mock.calls[0]?.[0].prompt);
    expect(prompt).toContain('"currentSlide"');
    expect(prompt).toContain('"key":"blowerKwh"');
    expect(prompt).toContain('"key":"tn"');
    expect(prompt).toContain('"thresholdBreaches"');
    expect(prompt).toContain('"alerts"');
    expect(prompt).toContain('"currentEvidenceSnapshotId":"immutable-dataset-snapshot"');
    expect(prompt).not.toMatch(/private\\plant|do-not-leak|DEEPSEEK_API_KEY/u);
  });

  it('selects exactly the old or new evidence bundle named by the current slide', async () => {
    const requestCompletion = vi.fn(async (_input: DeepSeekCompletionRequest) => JSON.stringify(validReply));
    const { registry, service } = harness({ requestCompletion });
    const reportId = registry.create({ question: '比较新旧页面', originPage: 'energy' }).reportId;
    const oldEvidence = { ...evidence, snapshotId: 'snapshot-old' };
    const newEvidence = evidence.mode === 'data' ? {
      ...evidence,
      snapshotId: 'snapshot-new',
      analysis: {
        ...evidence.analysis,
        series: evidence.analysis.series.map((row) => ({ ...row, values: { blowerKwh: 140 } })),
        aggregates: { blowerKwh: { min: 140, max: 140, average: 140, latest: 140, changeRate: 0 } },
      },
    } : evidence;
    const oldSlide = reportSlideFixture(slide('slide-old', 0), oldEvidence);
    const newSlide = reportSlideFixture(slide('slide-new', 1), newEvidence);
    registry.setEvidence(reportId, {
      snapshotId: oldEvidence.snapshotId,
      ...(oldEvidence.mode === 'data' ? { analysis: oldEvidence.analysis } : {}),
      knowledge: [],
    });
    registry.setEvidence(reportId, {
      snapshotId: newEvidence.snapshotId,
      ...(newEvidence.mode === 'data' ? { analysis: newEvidence.analysis } : {}),
      knowledge: [],
    });
    registry.publishOutline(reportId, [oldSlide, newSlide].map((item) => ({
      id: item.id, order: item.order, title: item.title, purpose: item.takeaway, role: item.role,
      layout: item.layout, evidencePolicy: item.evidencePolicy, visualKind: outlineVisualKind(item),
      evidenceKeys: item.evidenceRefs.map(({ key }) => key), status: 'planned' as const,
    })));
    registry.publishSlide(reportId, oldSlide);
    registry.publishSlide(reportId, newSlide);
    registry.complete(reportId);

    await service.answer(reportId, { ...followUp, slideId: 'slide-old' }, 'old-snapshot');
    await service.answer(reportId, { ...followUp, slideId: 'slide-new' }, 'new-snapshot');

    const prompts = requestCompletion.mock.calls.map(([input]) => String(input.prompt));
    expect(prompts[0]).toContain('"currentEvidenceSnapshotId":"snapshot-old"');
    expect(prompts[0]).toContain('"latest":128.4');
    expect(prompts[0]).not.toContain('"latest":140');
    expect(prompts[1]).toContain('"currentEvidenceSnapshotId":"snapshot-new"');
    expect(prompts[1]).toContain('"latest":140');
    expect(prompts[1]).not.toContain('"latest":128.4');
  });

  it('returns NO_EVIDENCE when the selected slide snapshot is absent even if another bundle exists', async () => {
    const { registry, service, requestCompletion } = harness();
    const reportId = readyReport(registry);
    const current = registry.getSnapshot(reportId)!;
    const missing = structuredClone(current.slides[0]!);
    missing.id = 'slide-missing-evidence';
    missing.order = 1;
    missing.evidenceSnapshotId = 'snapshot-missing';
    missing.evidenceRefs = missing.evidenceRefs.map((ref) => ({ ...ref, snapshotId: 'snapshot-missing' }));
    missing.metrics = missing.metrics.map((metric) => ({ ...metric, snapshotId: 'snapshot-missing' }));
    missing.claims = missing.claims.map((claim) => ({
      ...claim,
      evidenceRefs: claim.evidenceRefs.map((ref) => ({ ...ref, snapshotId: 'snapshot-missing' })),
    }));
    if (missing.visual.kind === 'kpi-grid') {
      missing.visual.metrics = missing.visual.metrics.map((metric) => ({ ...metric, snapshotId: 'snapshot-missing' }));
    }
    registry.publishOutline(reportId, [...current.outline, {
      id: missing.id, order: missing.order, title: missing.title, purpose: missing.takeaway,
      role: missing.role, layout: missing.layout, evidencePolicy: missing.evidencePolicy,
      visualKind: outlineVisualKind(missing), evidenceKeys: missing.evidenceRefs.map(({ key }) => key), status: 'planned',
    }]);
    registry.publishSlide(reportId, missing);

    await expect(service.answer(reportId, {
      ...followUp,
      slideId: missing.id,
      interruptedSegmentId: missing.narration[0]!.id,
    }, 'missing-snapshot')).rejects.toMatchObject({ code: 'NO_EVIDENCE' });
    expect(requestCompletion).not.toHaveBeenCalled();
  });

  it('returns a clarification without inventing a citation when current references are equally plausible', async () => {
    const { registry, service } = harness({
      requestCompletion: vi.fn(async () => JSON.stringify({
        needsClarification: true,
        answer: '您指的是吨水电耗还是鼓风能耗？',
        citedEvidenceKeys: [],
      })),
    });
    const reportId = readyReport(registry);

    const response = await service.answer(reportId, followUp, 'clarification-key');

    expect(response.answer).toContain('吨水电耗还是鼓风能耗');
    expect(response.citedEvidence).toEqual([]);
    expect(response.needsClarification).toBe(true);
    expect(registry.getSnapshot(reportId)?.conversation.turns[0]?.needsClarification).toBe(true);
    expect(registry.getConversationMemory(reportId)?.unresolvedIntents).toEqual(['它为什么升高？']);
  });

  it('uses the request interruption cursor when it is newer than the persisted session cursor', async () => {
    const { registry, service, requestCompletion } = harness();
    const reportId = readyReport(registry);

    const response = await service.answer(reportId, {
      ...followUp,
      interruptedSegmentId: 'segment-1',
      narrationOffsetMs: 77,
    }, 'fresh-cursor');

    const prompt = String(vi.mocked(requestCompletion).mock.calls[0]?.[0].prompt);
    expect(prompt).toContain('"interruptedSegmentId":"segment-1"');
    expect(response.resumeCursor).toEqual({ slideId: 'slide-energy', segmentId: 'segment-1', offsetMs: 77 });
  });

  it('strictly rejects malformed provider JSON, unknown evidence and fabricated numeric claims', async () => {
    for (const reply of [
      '{not-json',
      JSON.stringify({ ...validReply, ignored: 'not allowed' }),
      JSON.stringify({ ...validReply, citedEvidenceKeys: ['browser-injected'] }),
      JSON.stringify({ ...validReply, answer: '鼓风能耗为 999 kWh。' }),
    ]) {
      const { registry, service } = harness({ requestCompletion: vi.fn(async () => reply) });
      const reportId = readyReport(registry);
      await expect(service.answer(reportId, followUp, `invalid-${reply.length}`)).rejects.toSatisfy((error: unknown) => {
        expectCode(error, 'MALFORMED_RESPONSE');
        return true;
      });
      expect(registry.getSnapshot(reportId)?.conversation.turns).toEqual([]);
    }
  });

  it('rejects provider-introduced object keys and corrections not stated by the user', async () => {
    const cases = [
      {
        question: '我问的是鼓风机，不是总电耗',
        intentCorrection: {
          from: { kind: 'evidence', key: 'providerInventedMetric' },
          to: { kind: 'evidence', key: 'blowerKwh' },
        },
      },
      {
        question: '请换一个对象',
        intentCorrection: {
          from: { kind: 'evidence', key: 'totalKwh' },
          to: { kind: 'evidence', key: 'blowerKwh' },
        },
      },
    ];
    for (const [index, item] of cases.entries()) {
      const { registry, service } = harness({
        requestCompletion: vi.fn(async () => JSON.stringify({ ...validReply, intentCorrection: item.intentCorrection })),
      });
      const reportId = readyReport(registry);
      await expect(service.answer(reportId, { ...followUp, question: item.question }, `invalid-intent-${index}`))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
      expect(registry.getConversationMemory(reportId)?.intentCorrections).toEqual([]);
    }
  });

  it('rejects an object-correction destination that is absent from current report evidence', async () => {
    const intentCorrection = {
      from: { kind: 'evidence', key: 'totalKwh' },
      to: { kind: 'evidence', key: 'savedYuan' },
    };
    const { registry, service } = harness({
      requestCompletion: vi.fn(async () => JSON.stringify({ ...validReply, intentCorrection })),
    });
    const reportId = readyReport(registry);

    await expect(service.answer(reportId, {
      ...followUp,
      question: '我问的是节省费用，不是总电耗',
    }, 'absent-intent-target')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    expect(registry.getConversationMemory(reportId)?.intentCorrections).toEqual([]);
    expect(registry.getSnapshot(reportId)?.conversation.turns).toEqual([]);
  });

  it('requires an explicit answer statement before a correction replaces a ledger fact', async () => {
    const correction = {
      evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement: '修正为 126.8 kWh',
    };
    const { registry, service } = harness({
      requestCompletion: vi.fn(async () => JSON.stringify({ ...validReply, correction })),
    });
    const reportId = readyReport(registry);

    await expect(service.answer(reportId, followUp, 'implicit-correction')).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'MALFORMED_RESPONSE');
      return true;
    });
    expect(registry.getConversationMemory(reportId)?.userCorrections).toEqual([]);
  });

  it('rejects corrections for health weights and derived evidence instead of applying implicit conversions', async () => {
    const healthEvidence: FollowUpEvidenceBundle = crossModuleEvidence.mode === 'data'
      ? {
        ...crossModuleEvidence,
        analysis: { ...crossModuleEvidence.analysis, healthWeights: { quality: 0.4, flow: 0.2, energy: 0.25, carbonSource: 0.15 } },
      }
      : crossModuleEvidence;
    const replies = [
      {
        answer: '质量权重修正为 35%。', citedEvidenceKeys: ['health-weight:quality'], needsClarification: false,
        correction: { evidenceKey: 'health-weight:quality', value: 35, unit: '%', statement: '修正为 35%' },
      },
      {
        answer: '变化率修正为 6%。', citedEvidenceKeys: ['percent-change:blowerKwh'], needsClarification: false,
        correction: { evidenceKey: 'percent-change:blowerKwh', value: 6, unit: '%', statement: '修正为 6%' },
      },
    ];
    const { registry, service } = harness({ requestCompletion: vi.fn(async () => JSON.stringify(replies.shift())) });
    const reportId = readyReport(registry, undefined, healthEvidence);

    await expect(service.answer(reportId, {
      ...followUp, question: '我确认质量权重修正为 35%',
    }, 'health-correction')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    await expect(service.answer(reportId, {
      ...followUp, question: '我确认变化率修正为 6%',
    }, 'derived-correction')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    expect(registry.getConversationMemory(reportId)?.userCorrections).toEqual([]);
  });

  it('accepts a user-explicit correction and gives it precedence over the cited server fact', async () => {
    const statement = '修正为 126.8 kWh';
    const { registry, service } = harness({
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        answer: `${statement}，后续按用户纠正口径回答。`,
        correction: { evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement },
      })),
    });
    const reportId = readyReport(registry);

    const response = await service.answer(
      reportId,
      { ...followUp, question: `我确认鼓风能耗${statement}` },
      'explicit-correction',
    );

    expect(response.citedEvidence).toEqual([{
      key: 'user-correction:blowerKwh',
      kind: 'user-provided',
      source: 'user-correction',
      label: '鼓风能耗（用户提供·未核验）',
      unit: 'kWh',
    }]);
    expect(followUpResponseSchema.parse(response)).toEqual(response);
    for (const source of ['excel', 'model-knowledge'] as const) {
      expect(followUpResponseSchema.safeParse({
        ...response,
        citedEvidence: response.citedEvidence.map((ref) => ({ ...ref, source })),
      }).success).toBe(false);
    }

    expect(registry.getConversationMemory(reportId)?.factLedger).toEqual([]);
    expect(registry.getConversationMemory(reportId)?.userCorrections).toEqual([
      expect.objectContaining({ evidenceKey: 'blowerKwh', value: 126.8, statement }),
    ]);
  });

  it('rejects an unverified correction statement that smuggles an unrelated numeric claim', async () => {
    const statement = '原 Excel 值为 9999 kWh，修正为 126.8 kWh';
    const { registry, service } = harness({
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        answer: `${statement}，后续按用户纠正口径回答。`,
        correction: { evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement },
      })),
    });
    const reportId = readyReport(registry);

    await expect(service.answer(
      reportId,
      { ...followUp, question: '请把鼓风能耗修正为 126.8 kWh' },
      'correction-smuggled-number',
    )).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    expect(registry.getConversationMemory(reportId)?.userCorrections).toEqual([]);
  });

  it('rejects full-width Unicode digits before correction evidence validation', async () => {
    const statement = '原 Excel 值为 ９９９９ kWh，修正为 126.8 kWh';
    const { registry, service } = harness({
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        answer: `${statement}，后续按用户纠正口径回答。`,
        correction: { evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement },
      })),
    });
    const reportId = readyReport(registry);

    await expect(service.answer(
      reportId,
      { ...followUp, question: '请把鼓风能耗修正为 126.8 kWh' },
      'correction-full-width-number',
    )).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    expect(registry.getConversationMemory(reportId)?.userCorrections).toEqual([]);
  });

  it('does not apply a legacy unscoped correction to numeric validation', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-unscoped-correction' });
    const reportId = readyReport(registry, 'report-unscoped-correction');
    const reservation = registry.reserveFollowUp(reportId, 'legacy-correction', 'legacy-correction', Promise.resolve({} as never));
    if (reservation?.kind !== 'started') throw new Error('reservation failed');
    registry.commitFollowUp(reportId, {
      ordinal: reservation.ordinal,
      signal: reservation.signal,
      response: {} as never,
      turn: {
        id: 'legacy-turn', question: '旧版未绑定修正', answer: '旧版记录', citedEvidence: [],
        needsClarification: false, createdAt: '2026-08-14T00:00:00.000Z',
      },
      correction: {
        evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement: '旧版修正',
        createdAt: '2026-08-14T00:00:00.000Z',
      },
    });
    const { service } = harness({
      registry,
      requestCompletion: vi.fn(async () => JSON.stringify({
        answer: '鼓风能耗为 128.4 kWh。', citedEvidenceKeys: ['blowerKwh'], needsClarification: false,
      })),
    });

    await expect(service.answer(reportId, followUp, 'after-unscoped-correction'))
      .resolves.toMatchObject({ answer: '鼓风能耗为 128.4 kWh。' });
  });

  it('appends a validated correction page, supersedes the old page, and makes the correction active', async () => {
    const statement = '修正为 126.8 kWh';
    let reportId = '';
    const registry = new ReportJobRegistry({ createId: () => 'report-correction-page' });
    const appendNewTopic = vi.fn(async (_ownedReportId: string, topic: Record<string, unknown>) => {
      expect(topic).toMatchObject({
        question: `我确认鼓风能耗${statement}`,
        sourceSlideId: 'slide-energy',
        sourceEvidenceSnapshotId: evidence.snapshotId,
        correction: expect.objectContaining({
          evidenceSnapshotId: evidence.snapshotId,
          evidenceKey: 'blowerKwh',
          value: 126.8,
        }),
      });
      const correctionEvidence: PageEvidenceBundle = {
        ...registry.getEvidence(reportId, evidence.snapshotId)!,
        snapshotId: 'evidence:user-correction',
        userCorrections: [{
          key: 'user-correction:blowerKwh' as const,
          evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement,
          provenance: 'user-provided-unverified' as const,
          sourceSlideId: 'slide-energy', sourceEvidenceSnapshotId: evidence.snapshotId,
          createdAt: '2026-08-12T00:00:00.000Z',
        }],
      };
      const baseCorrection = reportSlideFixture(slide('slide-correction', 1), {
        ...evidence,
        snapshotId: correctionEvidence.snapshotId,
      });
      const correctionRef = {
        key: 'user-correction:blowerKwh', kind: 'metric' as const, source: 'user-correction' as const,
        snapshotId: correctionEvidence.snapshotId, label: '鼓风能耗（用户提供·未核验）', unit: 'kWh',
      };
      const correction = {
        ...baseCorrection,
        evidenceRefs: [...baseCorrection.evidenceRefs, correctionRef],
        claims: [...baseCorrection.claims, {
          id: 'claim-user-correction', text: '用户提供鼓风能耗 126.8 kWh，未经现场数据核验。',
          kind: 'user-provided' as const, evidenceRefs: [correctionRef],
        }],
        metrics: [...baseCorrection.metrics, {
          ...correctionRef, value: 126.8, claimIds: ['claim-user-correction'],
        }],
      };
      const current = registry.getSnapshot(reportId)!;
      registry.publishOutlineWithEvidence(reportId, [...current.outline, {
        id: correction.id, order: correction.order, title: '纠正说明', purpose: correction.takeaway,
        role: correction.role, layout: correction.layout, evidencePolicy: correction.evidencePolicy,
        visualKind: outlineVisualKind(correction), evidenceKeys: correction.evidenceRefs.map(({ key }) => key), status: 'planned',
      }], correctionEvidence, [correction.id]);
      registry.publishSlide(reportId, { ...correction, title: '纠正说明' });
      registry.complete(reportId);
      return { added: true, slideId: correction.id, evidenceSnapshotId: 'evidence:user-correction' };
    });
    const { service } = harness({
      registry,
      appendNewTopic,
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        answer: `${statement}，后续按用户纠正口径回答。`,
        correction: { evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement },
      })),
    });
    reportId = readyReport(registry, 'report-correction-page');

    await service.answer(reportId, {
      ...followUp,
      question: `我确认鼓风能耗${statement}`,
    }, 'correction-page');
    await new Promise<void>((resolve) => setImmediate(resolve));

    const corrected = registry.getSnapshot(reportId)!;
    expect(appendNewTopic).toHaveBeenCalledOnce();
    expect(corrected.slides.find(({ id }) => id === 'slide-energy')).toMatchObject({
      supersededBySlideId: 'slide-correction',
    });
    expect(corrected.slides.find(({ id }) => id === 'slide-correction')?.title).toBe('纠正说明');
    expect(corrected.conversation.activeSlideId).toBe('slide-correction');
  });

  it('answers from the correction page snapshot with the unverified overlay while preserving original Excel evidence', async () => {
    const statement = '修正为 126.8 kWh';
    const registry = new ReportJobRegistry({ createId: () => 'report-correction-follow-up' });
    const reportId = readyReport(registry, 'report-correction-follow-up');
    const reservation = registry.reserveFollowUp(
      reportId,
      'seed-correction',
      'seed-correction',
      Promise.resolve({} as never),
    );
    if (reservation?.kind !== 'started') throw new Error('correction reservation failed');
    registry.commitFollowUp(reportId, {
      ordinal: reservation.ordinal,
      signal: reservation.signal,
      response: {} as never,
      turn: {
        id: 'turn-seed-correction', question: `我确认鼓风能耗${statement}`, answer: statement,
        citedEvidence: [], needsClarification: false, createdAt: '2026-08-12T00:00:00.000Z',
      },
      correction: {
        evidenceSnapshotId: evidence.snapshotId,
        evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement,
        createdAt: '2026-08-12T00:00:00.000Z',
      },
    });
    const correctionEvidence: PageEvidenceBundle = {
      ...registry.getEvidence(reportId, evidence.snapshotId)!,
      snapshotId: 'evidence:correction-follow-up',
      userCorrections: [{
        key: 'user-correction:blowerKwh', evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement,
        provenance: 'user-provided-unverified', sourceSlideId: 'slide-energy',
        sourceEvidenceSnapshotId: evidence.snapshotId, createdAt: '2026-08-12T00:00:00.000Z',
      }],
    };
    const baseCorrection = reportSlideFixture(slide('slide-correction-follow-up', 1), {
      ...evidence,
      snapshotId: correctionEvidence.snapshotId,
    });
    const correctionRef = {
      key: 'user-correction:blowerKwh', kind: 'metric' as const, source: 'user-correction' as const,
      snapshotId: correctionEvidence.snapshotId, label: '鼓风能耗（用户提供·未核验）', unit: 'kWh',
    };
    const correctionSlide: ReportSlide = {
      ...baseCorrection,
      evidenceRefs: [...baseCorrection.evidenceRefs, correctionRef],
      claims: [...baseCorrection.claims, {
        id: 'claim-current-correction', text: '用户提供鼓风能耗 126.8 kWh，未经现场数据核验。',
        kind: 'user-provided', evidenceRefs: [correctionRef],
      }],
      metrics: [...baseCorrection.metrics, {
        ...correctionRef, value: 126.8, claimIds: ['claim-current-correction'],
      }],
    };
    const current = registry.getSnapshot(reportId)!;
    registry.publishOutlineWithEvidence(reportId, [...current.outline, {
      id: correctionSlide.id, order: correctionSlide.order, title: '纠正说明', purpose: correctionSlide.takeaway,
      role: correctionSlide.role, layout: correctionSlide.layout, evidencePolicy: correctionSlide.evidencePolicy,
      visualKind: outlineVisualKind(correctionSlide), evidenceKeys: correctionSlide.evidenceRefs.map(({ key }) => key), status: 'planned',
    }], correctionEvidence, [correctionSlide.id]);
    registry.publishSlide(reportId, { ...correctionSlide, title: '纠正说明' });
    registry.complete(reportId);
    registry.markSlideSuperseded(reportId, 'slide-energy', correctionSlide.id);
    registry.updateSession(reportId, { activity: 'page', activeSlideId: correctionSlide.id });
    let providerPrompt = '';
    const requestCompletion = vi.fn(async (input: { prompt: string }) => {
      providerPrompt = input.prompt;
      return JSON.stringify({
        answer: '这个用户提供的修正值是 126.8 kWh，未经现场数据核验。',
        citedEvidenceKeys: ['user-correction:blowerKwh'],
        needsClarification: false,
      });
    });
    const { service } = harness({
      registry,
      requestCompletion,
      appendNewTopic: vi.fn(async () => ({ added: false })),
    });

    const response = await service.answer(reportId, {
      question: '这个修正值是多少？',
      slideId: correctionSlide.id,
      interruptedSegmentId: correctionSlide.narration[0]!.id,
      narrationOffsetMs: 0,
    }, 'correction-value-follow-up');

    expect(providerPrompt).toContain('user-correction:blowerKwh');
    expect(providerPrompt).toContain('126.8');
    expect(response.citedEvidence).toEqual([{
      key: 'user-correction:blowerKwh', kind: 'user-provided', source: 'user-correction',
      label: '鼓风能耗（用户提供·未核验）', unit: 'kWh',
    }]);
    expect(registry.getEvidence(reportId, evidence.snapshotId)?.analysis?.aggregates.blowerKwh?.latest).toBe(128.4);
  });

  it('does not supersede the source when the ready append lacks bound correction evidence', async () => {
    const statement = '修正为 126.8 kWh';
    let reportId = '';
    const registry = new ReportJobRegistry({ createId: () => 'report-invalid-correction-page' });
    const appendNewTopic = vi.fn(async () => {
      const unrelated = reportSlideFixture(slide('slide-unrelated', 1), evidence);
      const current = registry.getSnapshot(reportId)!;
      registry.publishOutline(reportId, [...current.outline, {
        id: unrelated.id, order: unrelated.order, title: unrelated.title, purpose: unrelated.takeaway,
        role: unrelated.role, layout: unrelated.layout, evidencePolicy: unrelated.evidencePolicy,
        visualKind: outlineVisualKind(unrelated), evidenceKeys: unrelated.evidenceRefs.map(({ key }) => key), status: 'planned',
      }]);
      registry.publishSlide(reportId, unrelated);
      registry.complete(reportId);
      return { added: true, slideId: unrelated.id, evidenceSnapshotId: evidence.snapshotId };
    });
    const { service } = harness({
      registry,
      appendNewTopic,
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        answer: `${statement}，后续按用户纠正口径回答。`,
        correction: { evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement },
      })),
    });
    reportId = readyReport(registry, 'report-invalid-correction-page');

    await service.answer(reportId, {
      ...followUp, question: `我确认鼓风能耗${statement}`,
    }, 'invalid-correction-page');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(registry.getSnapshot(reportId)?.slides.find(({ id }) => id === 'slide-energy')?.supersededBySlideId)
      .toBeUndefined();
  });

  it('does not supersede the source when a newer follow-up owns the report before correction append settles', async () => {
    const statement = '修正为 126.8 kWh';
    const appendResult = deferred<{
      added: boolean;
      slideId: string;
      evidenceSnapshotId: string;
    }>();
    const registry = new ReportJobRegistry({ createId: () => 'report-stale-correction-page' });
    const { service, appendNewTopic } = harness({
      registry,
      appendNewTopic: vi.fn(() => appendResult.promise),
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        answer: `${statement}，后续按用户纠正口径回答。`,
        correction: { evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement },
      })),
    });
    const reportId = readyReport(registry, 'report-stale-correction-page');

    await service.answer(reportId, {
      ...followUp, question: `我确认鼓风能耗${statement}`,
    }, 'stale-correction-page');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(appendNewTopic).toHaveBeenCalledOnce();

    const correctionEvidence: PageEvidenceBundle = {
      ...registry.getEvidence(reportId, evidence.snapshotId)!,
      snapshotId: 'evidence:stale-user-correction',
      userCorrections: [{
        key: 'user-correction:blowerKwh', evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement,
        provenance: 'user-provided-unverified', sourceSlideId: 'slide-energy',
        sourceEvidenceSnapshotId: evidence.snapshotId, createdAt: '2026-08-12T00:00:00.000Z',
      }],
    };
    const baseCorrection = reportSlideFixture(slide('slide-stale-correction', 1), {
      ...evidence,
      snapshotId: correctionEvidence.snapshotId,
    });
    const correctionRef = {
      key: 'user-correction:blowerKwh', kind: 'metric' as const, source: 'user-correction' as const,
      snapshotId: correctionEvidence.snapshotId, label: '鼓风能耗（用户提供·未核验）', unit: 'kWh',
    };
    const correctionSlide: ReportSlide = {
      ...baseCorrection,
      evidenceRefs: [...baseCorrection.evidenceRefs, correctionRef],
      claims: [...baseCorrection.claims, {
        id: 'claim-stale-user-correction', text: '用户提供鼓风能耗 126.8 kWh，未经现场数据核验。',
        kind: 'user-provided', evidenceRefs: [correctionRef],
      }],
      metrics: [...baseCorrection.metrics, {
        ...correctionRef, value: 126.8, claimIds: ['claim-stale-user-correction'],
      }],
    };
    const current = registry.getSnapshot(reportId)!;
    registry.publishOutlineWithEvidence(reportId, [...current.outline, {
      id: correctionSlide.id, order: correctionSlide.order, title: '纠正说明', purpose: correctionSlide.takeaway,
      role: correctionSlide.role, layout: correctionSlide.layout, evidencePolicy: correctionSlide.evidencePolicy,
      visualKind: outlineVisualKind(correctionSlide), evidenceKeys: correctionSlide.evidenceRefs.map(({ key }) => key), status: 'planned',
    }], correctionEvidence, [correctionSlide.id]);
    registry.publishSlide(reportId, { ...correctionSlide, title: '纠正说明' });
    registry.complete(reportId);
    expect(registry.reserveFollowUp(
      reportId,
      'newer-correction-key',
      'newer-correction-fingerprint',
      Promise.resolve({} as never),
    )).toMatchObject({ kind: 'started', ordinal: 2 });

    appendResult.resolve({
      added: true,
      slideId: correctionSlide.id,
      evidenceSnapshotId: correctionEvidence.snapshotId,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stale = registry.getSnapshot(reportId)!;
    expect(stale.slides.find(({ id }) => id === 'slide-energy')?.supersededBySlideId).toBeUndefined();
    expect(stale.conversation.activeSlideId).toBe('slide-energy');
  });

  it('rejects a later answer that conflicts with an explicit correction', async () => {
    const statement = '修正为 126.8 kWh';
    const requestCompletion = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        ...validReply,
        answer: `${statement}，后续按用户纠正口径回答。`,
        correction: { evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement },
      }))
      .mockResolvedValueOnce(JSON.stringify({
        ...validReply,
        answer: '鼓风能耗为 128.4 kWh。',
      }));
    const { registry, service, registerSpeech } = harness({ requestCompletion });
    const reportId = readyReport(registry);
    await service.answer(reportId, { ...followUp, question: `我确认鼓风能耗${statement}` }, 'correction-turn');

    await expect(service.answer(reportId, followUp, 'conflicting-turn')).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'MALFORMED_RESPONSE');
      return true;
    });
    expect(registry.getSnapshot(reportId)?.conversation.turns).toHaveLength(1);
    expect(registerSpeech).toHaveBeenCalledTimes(1);
  });

  it('enforces corrected numeric facts even without units and preserves unrelated keys', async () => {
    const statement = '修正为 126.8 kWh';
    const correctedReply = JSON.stringify({
      ...validReply,
      answer: `${statement}，后续按用户纠正口径回答。`,
      correction: { evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement },
    });
    const replies = [
      correctedReply,
      JSON.stringify({ ...validReply, answer: '鼓风能耗为 128.4。' }),
      JSON.stringify({ ...validReply, answer: '鼓风能耗为 126.8 mg/L。', citedEvidenceKeys: ['user-correction:blowerKwh'] }),
      JSON.stringify({ ...validReply, answer: '鼓风能耗为 126.8。', citedEvidenceKeys: ['user-correction:blowerKwh'] }),
      JSON.stringify({ ...validReply, answer: '当前证据支持继续观察。', citedEvidenceKeys: ['tn'] }),
    ];
    const requestCompletion = vi.fn(async () => replies.shift()!);
    const { registry, service, registerSpeech } = harness({ requestCompletion });
    const reportId = readyReport(registry, undefined, crossModuleEvidence);
    await service.answer(reportId, { ...followUp, question: `我确认鼓风能耗${statement}` }, 'set-correction');

    await expect(service.answer(reportId, followUp, 'old-no-unit')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    await expect(service.answer(reportId, followUp, 'wrong-unit')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    await expect(service.answer(reportId, followUp, 'corrected-exact')).resolves.toMatchObject({ answer: '鼓风能耗为 126.8。' });
    await expect(service.answer(reportId, followUp, 'cross-key')).resolves.toMatchObject({ answer: '当前证据支持继续观察。' });
    expect(registerSpeech).toHaveBeenCalledTimes(3);
    expect(registry.getConversationMemory(reportId)?.userCorrections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceSnapshotId: evidence.snapshotId,
        evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh',
      }),
    ]));
  });

  it('invalidates settled detached append ownership when a newer follow-up starts', async () => {
    const appendStarted = deferred<{ ordinal: number; signal: AbortSignal }>();
    const appendGate = deferred<void>();
    const registry = new ReportJobRegistry({ createId: () => 'newer-detached-ownership' });
    const service = new ReportFollowUpService({
      registry,
      settings: { apiKey: 'secret', baseUrl: 'https://provider.invalid', model: 'fake' },
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        newTopic: { question: '继续分析水质' },
      })),
      registerSpeech: () => 'answer-speech',
      unregisterSpeech: () => undefined,
      appendNewTopic: vi.fn(async (_reportId, _topic, ownership) => {
        if (ownership) appendStarted.resolve(ownership);
        await appendGate.promise;
        return { added: false };
      }),
    });
    const reportId = readyReport(registry, 'newer-detached-ownership', crossModuleEvidence);

    await service.answer(reportId, followUp, 'first-detached-key');
    const ownership = await appendStarted.promise;
    expect(registry.isLatestFollowUp(reportId, ownership.ordinal, ownership.signal)).toBe(true);
    const newer = registry.reserveFollowUp(reportId, 'newer-key', 'newer-fingerprint', Promise.resolve({} as never));
    expect(newer).toMatchObject({ kind: 'started', ordinal: ownership.ordinal + 1 });
    expect(registry.isLatestFollowUp(reportId, ownership.ordinal, ownership.signal)).toBe(false);
    appendGate.resolve(undefined);
  });

  it('returns the exact same pending promise and completed response for one idempotency key', async () => {
    const gate = deferred<string>();
    const { registry, service, requestCompletion, registerSpeech } = harness({
      requestCompletion: vi.fn(() => gate.promise),
    });
    const reportId = readyReport(registry);

    const first = service.answer(reportId, followUp, 'same-key');
    const concurrentRetry = service.answer(reportId, { ...followUp, question: `  ${followUp.question}  ` }, 'same-key');
    expect(concurrentRetry).toBe(first);
    gate.resolve(JSON.stringify(validReply));
    const response = await first;
    const completedRetry = service.answer(reportId, followUp, 'same-key');

    expect(completedRetry).toBe(first);
    await expect(completedRetry).resolves.toEqual(response);
    expect(requestCompletion).toHaveBeenCalledTimes(1);
    expect(registerSpeech).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot(reportId)?.conversation.turns).toHaveLength(1);
  });

  it('settles a failed idempotency reservation before an immediate catch retry', async () => {
    const requestCompletion = vi.fn()
      .mockResolvedValueOnce('{bad-json')
      .mockResolvedValueOnce(JSON.stringify(validReply));
    const { registry, service, registerSpeech } = harness({ requestCompletion });
    const reportId = readyReport(registry);

    const first = service.answer(reportId, followUp, 'immediate-retry-key');
    const response = await first.catch(() => service.answer(reportId, followUp, 'immediate-retry-key'));

    expect(response.answer).toBe(validReply.answer);
    expect(requestCompletion).toHaveBeenCalledTimes(2);
    expect(registerSpeech).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot(reportId)?.conversation.turns).toHaveLength(1);
  });

  it('rejects reuse of one idempotency key with a different canonical request', async () => {
    const gate = deferred<string>();
    const { registry, service, requestCompletion, registerSpeech } = harness({
      requestCompletion: vi.fn(() => gate.promise),
    });
    const reportId = readyReport(registry);

    const first = service.answer(reportId, followUp, 'bound-key');
    const conflicting = service.answer(reportId, { ...followUp, question: '另一个问题' }, 'bound-key');
    await expect(conflicting).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'INVALID_REQUEST');
      return true;
    });
    gate.resolve(JSON.stringify(validReply));
    const original = await first;
    await expect(service.answer(reportId, { ...followUp, slideId: 'another-slide' }, 'bound-key'))
      .rejects.toSatisfy((error: unknown) => {
        expectCode(error, 'INVALID_REQUEST');
        return true;
      });

    expect(original.answer).toBe(validReply.answer);
    expect(requestCompletion).toHaveBeenCalledTimes(1);
    expect(registerSpeech).toHaveBeenCalledTimes(1);
  });

  it('rejects a late older response before speech or turn commit', async () => {
    const older = deferred<string>();
    const requestCompletion = vi.fn(({ prompt }: { prompt: string }) => (
      prompt.includes('较早的问题') ? older.promise : Promise.resolve(JSON.stringify(validReply))
    ));
    const { registry, service, registerSpeech } = harness({ requestCompletion });
    const reportId = readyReport(registry);
    const olderRequest = service.answer(reportId, { ...followUp, question: '较早的问题' }, 'older-key');
    const newerResponse = await service.answer(reportId, { ...followUp, question: '最新的问题' }, 'newer-key');

    older.resolve(JSON.stringify(validReply));

    await expect(olderRequest).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'REPORT_STALE_TURN');
      return true;
    });
    expect(registry.getSnapshot(reportId)?.conversation.turns.map(({ id }) => id)).toEqual([newerResponse.turnId]);
    expect(registerSpeech).toHaveBeenCalledTimes(1);
  });

  it('rolls back speech when reentrant ownership loss makes commit stale', async () => {
    let service!: ReportFollowUpService;
    let reportId = '';
    const unregisterSpeech = vi.fn();
    const { registry } = harness();
    const requestCompletion = vi.fn(async () => JSON.stringify(validReply));
    const registerSpeech = vi.fn(() => {
      void service.answer(reportId, { ...followUp, question: '重入的新问题' }, 'reentrant-new');
      return 'orphan-candidate';
    });
    service = new ReportFollowUpService({
      registry,
      settings: { apiKey: 'secret', baseUrl: 'https://provider.invalid', model: 'fake' },
      requestCompletion,
      registerSpeech,
      unregisterSpeech,
      appendNewTopic: vi.fn(async () => ({ added: false })),
      createTurnId: () => 'turn-reentrant',
      now: () => new Date('2026-08-12T08:00:00.000Z'),
    });
    reportId = readyReport(registry);

    await expect(service.answer(reportId, followUp, 'reentrant-old')).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'REPORT_STALE_TURN');
      return true;
    });
    expect(unregisterSpeech).toHaveBeenCalledWith(reportId, 'orphan-candidate');
    expect(registry.getSnapshot(reportId)?.conversation.turns).toEqual([
      expect.objectContaining({ question: '重入的新问题' }),
    ]);
  });

  it('does not commit a turn when speech registration fails', async () => {
    const { registry, service } = harness({
      registerSpeech: vi.fn(() => { throw new Error('speech capacity'); }),
    });
    const reportId = readyReport(registry);

    await expect(service.answer(reportId, followUp, 'speech-failure')).rejects.toBeInstanceOf(Error);
    expect(registry.getSnapshot(reportId)?.conversation.turns).toEqual([]);
  });

  it('rejects unknown, cancelled, wrong-slide and evidence-less reports without provider calls', async () => {
    const { registry, service, requestCompletion } = harness();
    const reportId = readyReport(registry);
    const cancelledId = readyReport(registry);
    registry.cancel(cancelledId);
    const emptyId = registry.create({ question: '没有证据', originPage: 'overview' }).reportId;

    const cases: Array<[Promise<unknown>, string]> = [
      [service.answer('unknown-report', followUp, 'unknown'), 'REPORT_NOT_FOUND'],
      [service.answer(cancelledId, followUp, 'cancelled'), 'REPORT_NOT_FOUND'],
      [service.answer(reportId, { ...followUp, slideId: 'other-slide' }, 'wrong-slide'), 'REPORT_NOT_FOUND'],
      [service.answer(emptyId, { ...followUp, slideId: 'slide-energy' }, 'no-evidence'), 'NO_EVIDENCE'],
    ];
    for (const [promise, code] of cases) {
      await expect(promise).rejects.toSatisfy((error: unknown) => {
        expectCode(error, code);
        return true;
      });
    }
    expect(requestCompletion).not.toHaveBeenCalled();
  });

  it('rejects an expired report with the same safe missing code before provider access', async () => {
    let nowMs = 0;
    const registry = new ReportJobRegistry({
      now: () => nowMs,
      slidingTtlMs: 10,
      createId: () => 'expiring-report',
    });
    const { service, requestCompletion } = harness({ registry });
    const reportId = readyReport(registry);
    nowMs = 11;

    await expect(service.answer(reportId, followUp, 'expired')).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'REPORT_NOT_FOUND');
      return true;
    });
    expect(requestCompletion).not.toHaveBeenCalled();
  });

  it('maps provider timeout and appends a validated new topic through the generator boundary', async () => {
    const timeout = Object.assign(new Error('timeout'), { code: 'UPSTREAM_TIMEOUT' });
    const timed = harness({ requestCompletion: vi.fn(async () => { throw timeout; }) });
    const timedId = readyReport(timed.registry);
    await expect(timed.service.answer(timedId, followUp, 'timeout')).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'UPSTREAM_TIMEOUT');
      return true;
    });

    const appended = harness({
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        answer: '继续分析水质，页面将从同一数据快照追加。',
        newTopic: { question: '继续分析水质' },
      })),
    });
    const reportId = readyReport(appended.registry);
    await appended.service.answer(reportId, followUp, 'new-topic');
    expect(appended.appendNewTopic).toHaveBeenCalledWith(reportId, {
      question: '继续分析水质',
      sourceSlideId: 'slide-energy',
      sourceEvidenceSnapshotId: evidence.snapshotId,
    }, expect.objectContaining({ ordinal: 1, signal: expect.any(AbortSignal) }));
  });

  it('commits and caches one answer when best-effort page append rejects', async () => {
    const { registry, service, requestCompletion, registerSpeech } = harness({
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        answer: '继续分析水质。',
        newTopic: { question: '继续分析水质' },
      })),
      appendNewTopic: vi.fn(async () => { throw new Error('planner unavailable'); }),
    });
    const reportId = readyReport(registry);

    const firstPromise = service.answer(reportId, followUp, 'append-failure-key');
    const first = await firstPromise;
    const retryPromise = service.answer(reportId, followUp, 'append-failure-key');

    expect(retryPromise).toBe(firstPromise);
    await expect(retryPromise).resolves.toEqual(first);
    expect(first.answer).toBe('继续分析水质。');
    expect(requestCompletion).toHaveBeenCalledTimes(1);
    expect(registerSpeech).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot(reportId)?.conversation.turns).toHaveLength(1);
  });

  it('returns a committed response without waiting for a best-effort append', async () => {
    const appendGate = deferred<{ added: boolean }>();
    const { registry, service, appendNewTopic } = harness({
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        newTopic: { question: '继续分析水质' },
      })),
      appendNewTopic: vi.fn(() => appendGate.promise),
    });
    const reportId = readyReport(registry, undefined, crossModuleEvidence);

    const response = await service.answer(reportId, followUp, 'detached-append');

    expect(response.turnId).toBeTruthy();
    expect(registry.getSnapshot(reportId)?.conversation.turns).toHaveLength(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(appendNewTopic).toHaveBeenCalledTimes(1);
    appendGate.resolve({ added: true });
  });

  it('keeps detached append ownership valid after response settlement until cancellation or a newer turn', async () => {
    const appendGate = deferred<void>();
    const appendFinished = deferred<boolean>();
    const registry = new ReportJobRegistry({ createId: () => 'detached-ownership' });
    const service = new ReportFollowUpService({
      registry,
      settings: { apiKey: 'secret', baseUrl: 'https://provider.invalid', model: 'fake' },
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        newTopic: { question: '继续分析水质' },
      })),
      registerSpeech: () => 'answer-speech',
      unregisterSpeech: () => undefined,
      appendNewTopic: vi.fn(async (_reportId, _topic, ownership) => {
        await appendGate.promise;
        const latest = ownership !== undefined
          && registry.isLatestFollowUp('detached-ownership', ownership.ordinal, ownership.signal);
        appendFinished.resolve(latest);
        return { added: latest };
      }),
    });
    const reportId = readyReport(registry, 'detached-ownership', crossModuleEvidence);

    await service.answer(reportId, followUp, 'detached-ownership-key');
    await new Promise<void>((resolve) => setImmediate(resolve));
    appendGate.resolve(undefined);

    await expect(appendFinished.promise).resolves.toBe(true);
  });

  it('rolls back registered speech when the registry commit throws', async () => {
    const { registry, service, unregisterSpeech } = harness();
    const reportId = readyReport(registry);
    vi.spyOn(registry, 'commitFollowUp').mockImplementation(() => { throw new Error('commit failed'); });

    await expect(service.answer(reportId, followUp, 'commit-throws')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });

    expect(unregisterSpeech).toHaveBeenCalledWith(reportId, expect.stringMatching(/^answer-speech-/u));
    expect(registry.getSnapshot(reportId)?.conversation.turns).toEqual([]);
  });

  it('cancellation after response cleanup invalidates its speech without a late response race', async () => {
    const liveSpeech = new Set<string>();
    const appendGate = deferred<{ added: boolean }>();
    let reportId = '';
    const registry = new ReportJobRegistry({
      createId: () => 'cancel-after-response',
      removeSpeechForReport: () => liveSpeech.clear(),
    });
    const appendFinished = deferred<boolean>();
    const service = new ReportFollowUpService({
      registry,
      settings: { apiKey: 'secret', baseUrl: 'https://provider.invalid', model: 'fake' },
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        newTopic: { question: '继续分析水质' },
      })),
      registerSpeech: (_ownedReportId, _text) => {
        liveSpeech.add('answer-speech');
        return 'answer-speech';
      },
      unregisterSpeech: (_ownedReportId, speechId) => { liveSpeech.delete(speechId); },
      appendNewTopic: vi.fn(async (_reportId, _topic, ownership) => {
        await appendGate.promise;
        const latest = ownership !== undefined
          && registry.isLatestFollowUp(reportId, ownership.ordinal, ownership.signal);
        appendFinished.resolve(latest);
        return { added: latest };
      }),
    });
    reportId = readyReport(registry, 'cancel-after-response', crossModuleEvidence);

    const response = await service.answer(reportId, followUp, 'cancel-after-response-key');
    expect(liveSpeech.has(response.speechId)).toBe(true);
    expect(registry.cancel(reportId)).toBe(true);
    expect(liveSpeech.has(response.speechId)).toBe(false);
    appendGate.resolve({ added: false });
    await expect(appendFinished.promise).resolves.toBe(false);
  });

  it('does not retain a completed idempotent response after report cancellation', async () => {
    const { registry, service, requestCompletion } = harness();
    const reportId = readyReport(registry);
    await service.answer(reportId, followUp, 'cancelled-cache-key');

    registry.cancel(reportId);

    await expect(service.answer(reportId, followUp, 'cancelled-cache-key')).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'REPORT_NOT_FOUND');
      return true;
    });
    expect(requestCompletion).toHaveBeenCalledTimes(1);
  });

  it('states that no page was added when the report is already at capacity', async () => {
    const appendNewTopic = vi.fn(async () => ({ added: false, reason: 'capacity-full' as const }));
    const { registry, service, registerSpeech } = harness({
      requestCompletion: vi.fn(async () => JSON.stringify({
        ...validReply,
        answer: '继续分析水质。',
        newTopic: { question: '继续分析水质' },
      })),
      appendNewTopic,
    });
    const reportId = readyReport(registry);
    const additionalSlides = Array.from({ length: 11 }, (_, index) => slide(`slide-${index + 2}`, index + 1));
    const bootstrap = registry.getSnapshot(reportId)!.outline[0]!;
    registry.publishOutline(reportId, [
      bootstrap,
      ...additionalSlides.map((item) => ({
        id: item.id,
        order: item.order,
        title: item.title,
        purpose: item.takeaway,
        role: 'evidence' as const,
        layout: 'split-insight' as const,
        evidencePolicy: 'data' as const,
        visualKind: outlineVisualKind(item as ReportSlide),
        evidenceKeys: item.evidenceRefs.map(({ key }) => key),
        status: 'planned' as const,
      })),
    ]);
    for (const item of additionalSlides) registry.publishSlide(reportId, item as unknown as ReportSlide);

    const response = await service.answer(reportId, followUp, 'full-report');

    expect(response.answer).toContain('本次未新增页面');
    expect(registerSpeech).toHaveBeenCalledWith(reportId, response.answer);
    expect(registry.getSnapshot(reportId)?.conversation.turns[0]?.answer).toBe(response.answer);
    expect(appendNewTopic).not.toHaveBeenCalled();
  });
});
