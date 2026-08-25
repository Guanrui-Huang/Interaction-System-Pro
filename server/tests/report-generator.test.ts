import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REPORT_MAX_SLIDES, type ReportSlide, type SlideOutline } from '../../shared/report';
import { reportJobSnapshotSchema } from '../../shared/report-schema';
import { loadWorkbook } from '../src/data/workbook';
import { slideBindsCorrectionIntent, type ReportEvidenceBundle } from '../src/domain/report-evidence';
import {
  PersistentSafeSlideOutputError,
  ReportContentValidationError,
  UnsafeReportContentError,
} from '../src/domain/report-content-validation';
import { publicAssistantProfile } from '../src/domain/public-assistant-profile';
import { resolveReportEvidence } from '../src/domain/report-evidence-resolver';
import { DeepSeekServiceError, type DeepSeekCompletionRequest, type DeepSeekSettings } from '../src/services/deepseek-client';
import { composeSlide as productionComposeSlide } from '../src/services/intent-first-slide-composer';
import { planReport } from '../src/services/intent-first-report-planner';
import { composeEvidenceFallbackSlide } from '../src/services/report-evidence-fallback';
import { ReportGenerator } from '../src/services/report-generator';
import { planReportIntent as productionPlanReportIntent } from '../src/services/report-intent-planner';
import { ReportJobRegistry } from '../src/services/report-job-registry';

const dataset = loadWorkbook(resolve('data/智慧污水处理厂_演示数据.xlsx'));
const settings: DeepSeekSettings = { apiKey: 'test-key', baseUrl: 'https://model.invalid', model: 'test-model' };
const evidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:test',
  knowledge: [{ key: 'knowledge:0', topic: '运行预警回顾', provenance: 'model-knowledge' }],
};
const createInput = { question: '分析运行', originPage: 'overview' } as const;

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: unknown) => void;
  return {
    promise: new Promise<T>((resolvePromise, rejectPromise) => {
      resolveValue = resolvePromise;
      rejectValue = rejectPromise;
    }),
    resolve: resolveValue,
    reject: rejectValue,
  };
}

function outline(id: string, order: number): SlideOutline {
  return {
    id,
    order,
    title: order === 0 ? '近期相似运行预警回顾' : `详情 ${order + 1}`,
    purpose: `回答第 ${order + 1} 部分`,
    role: order === 0 ? 'answer' : 'evidence',
    layout: 'concept-center',
    evidencePolicy: 'knowledge',
    visualKind: 'capability-map',
    evidenceKeys: ['knowledge:0'],
    status: 'planned',
  };
}

function slide(item: SlideOutline, bundle = evidence): ReportSlide {
  const ref = {
    key: 'knowledge:0', kind: 'knowledge' as const, source: 'model-knowledge' as const,
    snapshotId: bundle.snapshotId, label: bundle.knowledge[0]?.topic ?? '运行预警回顾',
  };
  const claimId = `${item.id}-claim`;
  return {
    id: item.id,
    order: item.order,
    evidenceSnapshotId: bundle.snapshotId,
    role: item.role,
    layout: item.layout,
    evidencePolicy: item.evidencePolicy,
    title: item.title,
    takeaway: `${item.title}已完成。`,
    takeawayClaimIds: [claimId],
    claims: [{ id: claimId, text: `${item.title}已完成。`, kind: 'knowledge', evidenceRefs: [ref] }],
    visual: {
      kind: 'capability-map',
      items: [{ id: `${item.id}-item`, title: item.title, detail: item.purpose, claimIds: [claimId] }],
    },
    metrics: [],
    evidenceRefs: [ref],
    narration: [
      { id: `${item.id}-segment-1`, text: `${item.title}第一段。`, speechId: `${item.id}-draft-1`, claimIds: [claimId] },
      { id: `${item.id}-segment-2`, text: `${item.title}第二段。`, speechId: `${item.id}-draft-2`, claimIds: [claimId] },
    ],
  };
}

function correctionSlide(
  item: SlideOutline,
  bundle: ReportEvidenceBundle,
  evidenceKey: string,
): ReportSlide {
  const correction = bundle.userCorrections?.find((candidate) => candidate.evidenceKey === evidenceKey);
  const definition = bundle.analysis?.definitions.find(({ key }) => key === evidenceKey);
  if (!correction || !definition || !bundle.analysis) throw new Error('correction fixture requires bound evidence');
  const excelRef = {
    key: evidenceKey,
    kind: 'metric' as const,
    source: 'excel' as const,
    snapshotId: bundle.snapshotId,
    module: bundle.analysis.scope.modules[0]!,
    label: definition.label,
    unit: definition.unit,
    dateRange: { ...bundle.analysis.scope.dateRange },
    sampleCount: bundle.analysis.scope.sampleCount,
  };
  const correctionRef = {
    key: correction.key,
    kind: 'metric' as const,
    source: 'user-correction' as const,
    snapshotId: bundle.snapshotId,
    label: `${definition.label}（用户提供·未核验）`,
    unit: correction.unit,
  };
  const onsiteClaimId = `${item.id}-onsite`;
  const correctionClaimId = `${item.id}-correction`;
  const metrics = [
    {
      ...excelRef,
      value: bundle.analysis.aggregates[evidenceKey as keyof typeof bundle.analysis.aggregates]!.latest,
      claimIds: [onsiteClaimId],
    },
    { ...correctionRef, value: correction.value, claimIds: [correctionClaimId] },
  ];
  return {
    id: item.id,
    order: item.order,
    evidenceSnapshotId: bundle.snapshotId,
    role: item.role,
    layout: item.layout,
    evidencePolicy: 'mixed',
    title: item.title,
    takeaway: `现场原值与用户修正值并列展示，修正值 ${correction.value} ${correction.unit} 未经现场核验。`,
    takeawayClaimIds: [onsiteClaimId, correctionClaimId],
    claims: [
      { id: onsiteClaimId, text: `现场原值为 ${metrics[0]!.value} ${definition.unit}。`, kind: 'onsite-fact', evidenceRefs: [excelRef] },
      { id: correctionClaimId, text: `用户提供修正值 ${correction.value} ${correction.unit}，未经现场数据核验。`, kind: 'user-provided', evidenceRefs: [correctionRef] },
    ],
    visual: { kind: 'kpi-grid', metrics },
    metrics,
    evidenceRefs: [excelRef, correctionRef],
    narration: [{
      id: `${item.id}-segment-1`,
      text: `用户提供修正值 ${correction.value} ${correction.unit}，未经现场数据核验。`,
      speechId: `${item.id}-draft-1`,
      claimIds: [correctionClaimId],
    }],
  };
}

function correctionSourceEvidence(snapshotId: string): ReportEvidenceBundle {
  return {
    snapshotId,
    knowledge: [{ key: 'knowledge:0', topic: '总电耗修正', provenance: 'model-knowledge' }],
    analysis: {
      scope: {
        modules: ['energy'], metrics: ['totalKwh'],
        dateRange: { from: '2026-08-01', to: '2026-08-12' }, sampleCount: 2, granularity: 'daily',
      },
      definitions: [{ key: 'totalKwh', label: '总电耗', unit: 'kWh/d' }],
      series: [
        { date: '2026-08-01', values: { totalKwh: 480 } },
        { date: '2026-08-12', values: { totalKwh: 500 } },
      ],
      aggregates: { totalKwh: { min: 480, max: 500, average: 490, latest: 500, changeRate: 0.0417 } },
      thresholdBreaches: [], correlations: [], alerts: [],
    },
  };
}

function multiMetricFallbackEvidence(snapshotId: string): ReportEvidenceBundle {
  return {
    snapshotId,
    knowledge: [],
    analysis: {
      scope: {
        modules: ['energy'],
        metrics: ['totalKwh', 'kwhPerM3'],
        dateRange: { from: '2026-08-01', to: '2026-08-12' },
        sampleCount: 2,
        granularity: 'daily',
      },
      definitions: [
        { key: 'totalKwh', label: '总电耗', unit: 'kWh/d' },
        { key: 'kwhPerM3', label: '吨水电耗', unit: 'kWh/m³' },
      ],
      series: [
        { date: '2026-08-01', values: { totalKwh: 480, kwhPerM3: 0.45 } },
        { date: '2026-08-12', values: { totalKwh: 500, kwhPerM3: 0.43 } },
      ],
      aggregates: {
        totalKwh: { min: 480, max: 500, average: 490, latest: 500, changeRate: 0.0417 },
        kwhPerM3: { min: 0.43, max: 0.45, average: 0.44, latest: 0.43, changeRate: -0.0444 },
      },
      thresholdBreaches: [],
      correlations: [],
      alerts: [],
    },
  };
}
function generatorWith(overrides: {
  registry?: ReportJobRegistry;
  planReportIntent?: (...args: any[]) => Promise<any>;
  resolveReportEvidence?: (...args: any[]) => ReportEvidenceBundle;
  planReport?: (...args: any[]) => Promise<SlideOutline[]>;
  composeSlide?: (...args: any[]) => Promise<ReportSlide>;
  registerSpeech?: (reportId: string, text: string) => string;
  unregisterSpeech?: (reportId: string, speechId: string) => void;
} = {}) {
  const registry = overrides.registry ?? new ReportJobRegistry({ createId: () => 'report-1' });
  const planReportIntent = vi.fn(overrides.planReportIntent ?? (async () => ({
    kind: 'report', intents: [{ kind: 'knowledge', questionPart: '回顾预警', evidencePolicy: 'knowledge' }],
    knowledgeTopics: ['运行预警回顾'], assistantProfile: false,
  })));
  const resolveEvidence = vi.fn(overrides.resolveReportEvidence ?? (() => evidence));
  const planReportMock = vi.fn(overrides.planReport ?? (async () => [outline('page-1', 0), outline('page-2', 1)]));
  const composeSlide = vi.fn(overrides.composeSlide ?? (async (input: { outline: SlideOutline }) => slide(input.outline)));
  let speech = 0;
  const registerSpeech = vi.fn(overrides.registerSpeech ?? ((_reportId: string, _text: string) => `speech-${++speech}`));
  const unregisterSpeech = vi.fn(overrides.unregisterSpeech ?? (() => undefined));
  const generator = new ReportGenerator({
    dataset,
    registry,
    planReportIntent: planReportIntent as never,
    resolveReportEvidence: resolveEvidence as never,
    planReport: (overrides.planReport === planReport ? planReport : planReportMock) as never,
    composeSlide: composeSlide as never,
    registerSpeech,
    unregisterSpeech,
  }, { settings });
  return {
    generator, registry, planReportIntent, resolveEvidence, planReport: planReportMock, composeSlide,
    registerSpeech, unregisterSpeech,
  };
}

async function eventually(assertion: () => void, attempts = 100): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolveValue) => setImmediate(resolveValue));
    }
  }
  throw lastError;
}

async function settleWithin<T>(promise: Promise<T>, label: string, timeoutMs = 300): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function jsonCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ReportGenerator intent-first lifecycle', () => {
  it('creates an empty understanding snapshot and publishes standard events in order', async () => {
    const intentGate = deferred<any>();
    const { generator, registry } = generatorWith({ planReportIntent: () => intentGate.promise });
    const created = generator.createReport({ question: '回顾近期相似运行预警', page: 'overview' });

    expect(created).toEqual({
      reportId: 'report-1',
      snapshot: expect.objectContaining({
        status: 'generating', phase: 'understanding', clarification: null, outline: [], slides: [],
      }),
    });
    expect('bootstrapSlide' in created).toBe(false);
    intentGate.resolve({
      kind: 'report', intents: [{ kind: 'knowledge', questionPart: '回顾预警', evidencePolicy: 'knowledge' }],
      knowledgeTopics: ['运行预警回顾'], assistantProfile: false,
    });
    await generator.run(created.reportId);

    const types = (registry.replayAfter(created.reportId, 0) ?? []).map(({ type }) => type);
    expect(types.indexOf('report.outline')).toBeLessThan(types.indexOf('slide.generating'));
    expect(types.indexOf('slide.generating')).toBeLessThan(types.indexOf('slide.ready'));
    expect(types.at(-1)).toBe('report.completed');
    expect(registry.getSnapshot(created.reportId)).toMatchObject({ status: 'ready', phase: 'completed' });
  });

  it('continues clarification on the same report with memory and rejects stale IDs', async () => {
    let call = 0;
    const { generator, registry } = generatorWith({
      planReportIntent: async () => ++call === 1
        ? { kind: 'clarification', clarification: { prompt: '请确认时间范围', reason: 'ambiguous-period', suggestions: ['近 30 日'] } }
        : { kind: 'report', intents: [{ kind: 'knowledge', questionPart: '回顾', evidencePolicy: 'knowledge' }], knowledgeTopics: ['回顾'], assistantProfile: false },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await generator.run(created.reportId);
    const clarification = registry.getSnapshot(created.reportId)?.clarification;
    expect(clarification).toBeTruthy();

    const continuation = generator.answerClarification(created.reportId, {
      clarificationId: clarification!.clarificationId,
      answer: '近 30 日',
    });
    expect(() => generator.answerClarification(created.reportId, {
      clarificationId: clarification!.clarificationId,
      answer: '近 7 日',
    })).toThrow('REPORT_STALE_TURN');
    await continuation;

    expect(registry.getConversationMemory(created.reportId)?.clarifications).toEqual([
      expect.objectContaining({ answer: '近 30 日' }),
    ]);
    expect(registry.getSnapshot(created.reportId)).toMatchObject({ reportId: created.reportId, status: 'ready' });
  });

  it('accepts cancellation before outline and rejects late publications and activities', async () => {
    const intentGate = deferred<any>();
    const { generator, registry } = generatorWith({ planReportIntent: () => intentGate.promise });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    expect(registry.cancel(created.reportId)).toBe(true);
    intentGate.resolve({ kind: 'report', intents: [], knowledgeTopics: [], assistantProfile: false });
    await generator.run(created.reportId);

    expect(registry.getSnapshot(created.reportId)).toMatchObject({ status: 'cancelled', outline: [], slides: [] });
    expect(registry.publishOutline(created.reportId, [outline('late', 0)])).toBe(false);
    expect(registry.beginActivity(created.reportId, 'generation')).toBeUndefined();
    expect(registry.subscribe(created.reportId, () => undefined)).toBeUndefined();
    expect(registry.replayAfter(created.reportId, 0)?.at(-1)).toMatchObject({ type: 'report.cancelled' });
  });

  it('preserves a committed outline when cancelled before the first page publishes', async () => {
    const firstGate = deferred<ReportSlide>();
    const { generator, registry } = generatorWith({ composeSlide: () => firstGate.promise });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await eventually(() => expect(registry.getSnapshot(created.reportId)?.outline).toHaveLength(2));
    registry.cancel(created.reportId);
    firstGate.resolve(slide(outline('page-1', 0)));
    await generator.run(created.reportId);

    expect(registry.getSnapshot(created.reportId)).toMatchObject({
      status: 'cancelled', outline: [{ id: 'page-1' }, { id: 'page-2' }], slides: [],
    });
  });

  it('publishes page zero before any later composition begins', async () => {
    const firstGate = deferred<ReportSlide>();
    const started: number[] = [];
    const { generator, registry } = generatorWith({
      composeSlide: async (input: { outline: SlideOutline }) => {
        started.push(input.outline.order);
        return input.outline.order === 0 ? firstGate.promise : slide(input.outline);
      },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await eventually(() => expect(started).toEqual([0]));
    expect(registry.getSnapshot(created.reportId)?.slides).toEqual([]);
    firstGate.resolve(slide(outline('page-1', 0)));
    await generator.run(created.reportId);
    expect(started).toEqual([0, 1]);
  });

  it('limits later-page composition to exactly two in flight', async () => {
    let active = 0;
    let maximum = 0;
    const gates = new Map<number, Deferred<ReportSlide>>();
    const pages = Array.from({ length: 5 }, (_, order) => outline(`page-${order + 1}`, order));
    const { generator } = generatorWith({
      planReport: async () => pages,
      composeSlide: async (input: { outline: SlideOutline }) => {
        if (input.outline.order === 0) return slide(input.outline);
        active += 1;
        maximum = Math.max(maximum, active);
        const gate = deferred<ReportSlide>();
        gates.set(input.outline.order, gate);
        try { return await gate.promise; } finally { active -= 1; }
      },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await eventually(() => expect(gates.size).toBe(2));
    expect(maximum).toBe(2);
    for (let order = 1; order < pages.length; order += 1) {
      await eventually(() => expect(gates.has(order)).toBe(true));
      gates.get(order)!.resolve(slide(pages[order]!));
    }
    await generator.run(created.reportId);
    expect(maximum).toBe(2);
  });

  it('retries page two once without duplicate IDs, narration, or stale failure state', async () => {
    const attempts = new Map<number, number>();
    const { generator, registry } = generatorWith({
      composeSlide: async (input: { outline: SlideOutline }) => {
        const count = (attempts.get(input.outline.order) ?? 0) + 1;
        attempts.set(input.outline.order, count);
        if (input.outline.order === 1 && count === 1) throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
        return slide(input.outline);
      },
    });
    const created = generator.createReport({ question: '回顾近期相似运行预警', page: 'overview' });
    await generator.run(created.reportId);
    const snapshot = registry.getSnapshot(created.reportId)!;

    expect(attempts.get(1)).toBe(2);
    expect(snapshot.status).toBe('ready');
    expect(new Set(snapshot.slides.map(({ id }) => id)).size).toBe(2);
    const narrationIds = snapshot.slides.flatMap(({ narration }) => narration.map(({ id }) => id));
    expect(new Set(narrationIds).size).toBe(narrationIds.length);
    expect(snapshot.outline[1]).toMatchObject({ status: 'ready' });
    expect(registry.replayAfter(created.reportId, 0)?.some((event) => event.type === 'slide.failed')).toBe(false);
  });

  it('settles partial only after every planned later page settles', async () => {
    const thirdGate = deferred<ReportSlide>();
    const pages = [outline('page-1', 0), outline('page-2', 1), outline('page-3', 2)];
    const { generator, registry } = generatorWith({
      planReport: async () => pages,
      composeSlide: async (input: { outline: SlideOutline }) => {
        if (input.outline.order === 1) throw new DeepSeekServiceError('UPSTREAM_HTTP');
        if (input.outline.order === 2) return thirdGate.promise;
        return slide(input.outline);
      },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await eventually(() => expect(registry.getSnapshot(created.reportId)?.outline[1]).toMatchObject({ status: 'failed', retryable: true }));
    expect(registry.getSnapshot(created.reportId)?.status).toBe('generating');
    thirdGate.resolve(slide(pages[2]!));
    await generator.run(created.reportId);

    expect(registry.getSnapshot(created.reportId)).toMatchObject({
      status: 'partial',
      phase: 'completed',
      slides: [{ id: 'page-1' }, { id: 'page-3' }],
      outline: [{ status: 'ready' }, { status: 'failed', retryable: true }, { status: 'ready' }],
    });
  });

  it('fails the report with no fallback page when page zero fails', async () => {
    const { generator, registry } = generatorWith({
      composeSlide: async () => { throw new DeepSeekServiceError('UPSTREAM_TIMEOUT'); },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await generator.run(created.reportId);
    expect(registry.getSnapshot(created.reportId)).toMatchObject({ status: 'failed', phase: null, slides: [] });
    expect(registry.replayAfter(created.reportId, 0)).toContainEqual(expect.objectContaining({
      type: 'report.failed', code: 'UPSTREAM_TIMEOUT',
    }));
  });

  it('publishes a trusted evidence fallback after persistent model evidence-invalid output', async () => {
    const { generator, registry, composeSlide } = generatorWith({
      planReport: async () => [outline('page-1', 0)],
      composeSlide: async () => { throw new PersistentSafeSlideOutputError('REPORT_EVIDENCE_INVALID'); },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });

    await generator.run(created.reportId);

    expect(composeSlide).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot(created.reportId)).toMatchObject({
      status: 'ready',
      outline: [{ status: 'ready' }],
      slides: [{
        id: 'page-1',
        title: '知识要点分析',
        takeaway: '本页已按可信知识证据生成，关键内容见可视化。',
        visual: { kind: 'capability-map' },
        narration: [{}, {}],
      }],
    });
    expect(registry.replayAfter(created.reportId, 0)?.some((event) => event.type === 'slide.failed')).toBe(false);
  });

  it('publishes the trusted fallback for persistently malformed but safe model structure', async () => {
    const { generator, registry } = generatorWith({
      planReport: async () => [outline('page-1', 0)],
      composeSlide: async () => { throw new PersistentSafeSlideOutputError('REPORT_SLIDE_DRAFT_INVALID'); },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });

    await generator.run(created.reportId);

    expect(registry.getSnapshot(created.reportId)).toMatchObject({ status: 'ready', slides: [{ id: 'page-1' }] });
  });

  it('does not fallback for an unclassified validation error', async () => {
    const { generator, registry } = generatorWith({
      planReport: async () => [outline('page-1', 0)],
      composeSlide: async () => { throw new ReportContentValidationError('REPORT_SLIDE_DRAFT_INVALID'); },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });

    await generator.run(created.reportId);

    expect(registry.getSnapshot(created.reportId)).toMatchObject({ status: 'failed', slides: [] });
  });

  it('does not fallback for unsafe model output', async () => {
    const { generator, registry } = generatorWith({
      planReport: async () => [outline('page-1', 0)],
      composeSlide: async () => { throw new UnsafeReportContentError('REPORT_SLIDE_DRAFT_INVALID'); },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });

    await generator.run(created.reportId);

    expect(registry.getSnapshot(created.reportId)).toMatchObject({ status: 'failed', slides: [] });
  });

  it('uses only server-trusted fallback titles and omits unknown public model names', () => {
    const maliciousOutline = {
      ...outline('page-1', 0),
      title: '相关系数证明总氮升高导致氨氮升高',
    };
    const knowledgeFallback = composeEvidenceFallbackSlide(maliciousOutline, evidence);
    expect(knowledgeFallback.title).toBe('知识要点分析');
    expect(JSON.stringify(knowledgeFallback)).not.toContain(maliciousOutline.title);

    const profileEvidence: ReportEvidenceBundle = {
      snapshotId: 'evidence:unknown-profile',
      knowledge: [],
      assistantProfile: publicAssistantProfile('private-unmapped-model'),
    };
    const profileOutline: SlideOutline = {
      ...outline('identity', 0),
      title: '私有模型身份',
      visualKind: 'capability-map',
      evidenceKeys: ['assistant-profile'],
    };
    const identityFallback = composeEvidenceFallbackSlide(profileOutline, profileEvidence);
    expect(identityFallback.title).toBe('助手身份与能力');
    expect(JSON.stringify(identityFallback)).toContain(profileEvidence.assistantProfile!.assistantName);
    expect(JSON.stringify(identityFallback)).not.toContain('undefined');
    expect(JSON.stringify(identityFallback)).not.toContain('private-unmapped-model');
  });

  it('turns bound metric evidence into a substantive fallback narration', () => {
    const metricEvidence = correctionSourceEvidence('evidence:metric-fallback');
    const metricOutline: SlideOutline = {
      ...outline('metric-page', 0),
      title: '不要信任这个模型标题',
      evidencePolicy: 'data',
      visualKind: 'trend-line',
      evidenceKeys: ['totalKwh'],
    };

    const fallback = composeEvidenceFallbackSlide(metricOutline, metricEvidence);
    const narration = fallback.narration.map(({ text }) => text).join('');

    expect(fallback.title).toBe('总电耗证据概览');
    expect(fallback.takeaway).toContain('总电耗最新值为500 kWh/d');
    expect(narration).toContain('2026年8月1日至2026年8月12日');
    expect(narration).toContain('共2个样本');
    expect(narration).toContain('平均值为490 kWh/d');
    expect(narration).toContain('最低值为480 kWh/d');
    expect(narration).toContain('峰值为500 kWh/d');
    expect(narration).toContain('峰值出现在2026年8月12日');
    expect(narration).toContain('与首个样本相比上升4.17%');
    expect(narration).toContain('不能仅凭这组数据判断波动原因');
    expect(fallback.narration).toHaveLength(3);
  });

  it('uses the data context once on page zero and never on later fallback pages', () => {
    const metricEvidence = multiMetricFallbackEvidence('evidence:multi-fallback');
    const base: SlideOutline = {
      ...outline('metric-page', 0),
      evidencePolicy: 'data',
      visualKind: 'kpi-grid',
      evidenceKeys: ['totalKwh', 'kwhPerM3'],
    };

    const firstPage = composeEvidenceFallbackSlide(base, metricEvidence);
    const laterPage = composeEvidenceFallbackSlide(
      { ...base, id: 'metric-page-2', order: 1 },
      metricEvidence,
    );
    const firstNarration = firstPage.narration.map(({ text }) => text).join('');
    const laterNarration = laterPage.narration.map(({ text }) => text).join('');

    expect(firstNarration.match(/本页查看/gu)).toHaveLength(1);
    expect(firstNarration.match(/共2个样本/gu)).toHaveLength(1);
    expect(firstPage.narration[0]!.text).toContain('本页查看');
    expect(firstPage.narration.slice(1).map(({ text }) => text).join('')).not.toContain('本页查看');
    expect(laterNarration).not.toContain('本页查看');
    expect(laterNarration).not.toContain('共2个样本');
    expect(firstPage.claims).toHaveLength(2);
    expect(firstPage.claims.every(({ text }) => text.includes('共2个样本'))).toBe(true);
  });
  it('allows one provider-response retry per model stage and no retry for evidence validation', async () => {
    let intentAttempts = 0;
    let plannerAttempts = 0;
    let composerAttempts = 0;
    const { generator } = generatorWith({
      planReportIntent: async () => {
        if (++intentAttempts === 1) throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
        return { kind: 'report', intents: [{ kind: 'knowledge', questionPart: '回顾', evidencePolicy: 'knowledge' }], knowledgeTopics: ['回顾'], assistantProfile: false };
      },
      planReport: async () => {
        if (++plannerAttempts === 1) throw new DeepSeekServiceError('MALFORMED_RESPONSE');
        return [outline('page-1', 0)];
      },
      composeSlide: async (input: { outline: SlideOutline }) => {
        if (++composerAttempts === 1) throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
        return slide(input.outline);
      },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await generator.run(created.reportId);
    expect({ intentAttempts, plannerAttempts, composerAttempts }).toEqual({ intentAttempts: 2, plannerAttempts: 2, composerAttempts: 2 });

    let validations = 0;
    const failing = generatorWith({ resolveReportEvidence: () => {
      validations += 1;
      throw new Error('REPORT_EVIDENCE_INVALID');
    } });
    const failed = failing.generator.createReport({ question: '回顾预警', page: 'overview' });
    await failing.generator.run(failed.reportId);
    expect(validations).toBe(1);
    expect(failing.registry.getSnapshot(failed.reportId)).toMatchObject({ status: 'failed', slides: [] });
  });

  it('retries one malformed DeepSeek envelope at the built-in completion boundary', async () => {
    let providerCall = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      providerCall += 1;
      if (providerCall === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return jsonCompletion(JSON.stringify({
        slides: [{
          title: '回顾结论', purpose: '回顾相似预警', role: 'answer', layout: 'concept-center',
          visualKind: 'capability-map', evidenceKeys: ['knowledge:0'],
        }],
      }));
    });
    try {
      const { generator, registry } = generatorWith({
        planReport,
        composeSlide: async (input: { outline: SlideOutline }) => slide(input.outline),
      });
      const created = generator.createReport({ question: '回顾预警', page: 'overview' });
      await generator.run(created.reportId);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(registry.getSnapshot(created.reportId)?.status).toBe('ready');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('starts a fresh run when clarification is accepted synchronously from the old run event', async () => {
    const firstIntent = deferred<any>();
    let calls = 0;
    const { generator, registry, planReportIntent } = generatorWith({
      planReportIntent: async () => {
        calls += 1;
        if (calls === 1) return firstIntent.promise;
        return {
          kind: 'report', intents: [{ kind: 'knowledge', questionPart: '回顾', evidencePolicy: 'knowledge' }],
          knowledgeTopics: ['回顾'], assistantProfile: false,
        };
      },
      planReport: async () => [outline('page-1', 0)],
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    let continuation: Promise<void> | undefined;
    registry.subscribe(created.reportId, (event) => {
      if (event.type !== 'report.clarification-required') return;
      continuation = generator.answerClarification(created.reportId, {
        clarificationId: event.clarification.clarificationId,
        answer: '近 30 日',
      });
    });

    firstIntent.resolve({
      kind: 'clarification',
      clarification: { prompt: '请确认时间', reason: 'ambiguous-period', suggestions: ['近 30 日'] },
    });
    await eventually(() => expect(continuation).toBeDefined());
    await continuation;

    expect(planReportIntent).toHaveBeenCalledTimes(2);
    expect(registry.getSnapshot(created.reportId)).toMatchObject({ status: 'ready', phase: 'completed' });
    expect(registry.getConversationMemory(created.reportId)?.clarifications).toEqual([
      expect.objectContaining({ answer: '近 30 日' }),
    ]);
  });

  it('shares one network retry across a built-in stage without invoking structural repair twice', async () => {
    const prompts: string[] = [];
    let providerCall = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      prompts.push(request.messages[0]!.content);
      providerCall += 1;
      if (providerCall === 1) return jsonCompletion('{bad json');
      if (providerCall === 2) throw new TypeError('transient repair timeout');
      return jsonCompletion(JSON.stringify({
        slides: [{
          title: '回顾结论', purpose: '回顾相似预警', role: 'answer', layout: 'concept-center',
          visualKind: 'capability-map', evidenceKeys: ['knowledge:0'],
        }],
      }));
    });
    try {
      const { generator, registry } = generatorWith({
        planReport: planReport,
        composeSlide: async (input: { outline: SlideOutline }) => slide(input.outline),
      });
      const created = generator.createReport({ question: '回顾预警', page: 'overview' });
      await generator.run(created.reportId);

      expect(prompts.map((prompt) => prompt.includes('将下面内容修复为严格 JSON'))).toEqual([false, true, true]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(registry.getSnapshot(created.reportId)?.status).toBe('ready');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('runs all three production report services through an injected completion boundary', async () => {
    const completionStages: string[] = [];
    const requestCompletion = vi.fn(async ({ prompt }: DeepSeekCompletionRequest) => {
      if (prompt.includes('问题意图规划器')) {
        completionStages.push('intent-planner');
        return JSON.stringify({
          kind: 'report',
          intents: [{ kind: 'knowledge', questionPart: '污水脱氮是什么？', evidencePolicy: 'knowledge' }],
          knowledgeTopics: ['污水脱氮机制'],
          assistantProfile: false,
        });
      }
      if (prompt.includes('动态报告规划器')) {
        completionStages.push('report-planner');
        return JSON.stringify({
          slides: [{
            title: '污水脱氮的核心机制',
            purpose: '解释硝化与反硝化过程',
            role: 'knowledge',
            layout: 'concept-center',
            visualKind: 'concept-map',
            evidenceKeys: ['knowledge:0'],
          }],
        });
      }
      if (prompt.includes('单页报告撰稿器')) {
        completionStages.push('slide-composer');
        return JSON.stringify({
          title: '污水脱氮的核心机制',
          takeaway: '污水脱氮由硝化与反硝化两个环节协同完成。',
          takeawayClaimIds: ['claim-1'],
          visualKind: 'concept-map',
          evidenceKeys: ['knowledge:0'],
          claims: [{
            id: 'claim-1',
            text: '污水脱氮通过硝化和反硝化协同完成。',
            kind: 'knowledge',
            evidenceKeys: ['knowledge:0'],
          }],
          narration: [
            { text: '先介绍污水脱氮的两个核心环节。', claimIds: ['claim-1'] },
            { text: '硝化与反硝化需要协同工作。', claimIds: ['claim-1'] },
          ],
          knowledgeItems: [
            { title: '硝化', detail: '将氨氮逐步转化为硝态氮。' },
            { title: '反硝化', detail: '将硝态氮转化为氮气。' },
          ],
        });
      }
      throw new Error('unexpected completion prompt');
    });
    const registry = new ReportJobRegistry({ createId: () => 'production-services-report' });
    let speech = 0;
    const generator = new ReportGenerator({
      dataset,
      registry,
      planReportIntent: productionPlanReportIntent,
      resolveReportEvidence,
      planReport,
      composeSlide: productionComposeSlide,
      registerSpeech: () => `production-speech-${++speech}`,
      unregisterSpeech: () => undefined,
    }, { settings, requestCompletion });

    const created = generator.createReport({ question: '污水脱氮是什么？', page: 'overview' });
    await generator.run(created.reportId);

    expect(completionStages).toEqual(['intent-planner', 'report-planner', 'slide-composer']);
    expect(requestCompletion).toHaveBeenCalledTimes(3);
    expect(registry.getSnapshot(created.reportId)).toMatchObject({
      status: 'ready',
      outline: [{ title: '污水脱氮的核心机制', status: 'ready' }],
      slides: [{ title: '污水脱氮的核心机制' }],
    });
  });

  it('does not retry a slide repair transport failure before publishing trusted fallback', async () => {
    const promptKinds: string[] = [];
    const invalidDraft = {
      title: '运行预警回顾',
      takeaway: '现场最新值为 99 mg/L。',
      takeawayClaimIds: ['claim-k'],
      visualKind: 'capability-map',
      evidenceKeys: ['knowledge:0'],
      claims: [{
        id: 'claim-k', text: '现场最新值为 99 mg/L。',
        kind: 'knowledge', evidenceKeys: ['knowledge:0'],
      }],
      narration: [
        { text: '现场最新值为 99 mg/L。', claimIds: ['claim-k'] },
        { text: '这是运行知识说明。', claimIds: ['claim-k'] },
      ],
      knowledgeItems: [{ title: '运行知识', detail: '仅使用已绑定知识。' }],
    };
    const requestCompletion = vi.fn(async ({ prompt }: DeepSeekCompletionRequest) => {
      const repair = prompt.startsWith('将下面内容修复为严格 JSON');
      promptKinds.push(repair ? 'repair' : 'initial');
      if (repair) throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
      return JSON.stringify(invalidDraft);
    });
    const registry = new ReportJobRegistry({ createId: () => 'repair-timeout-report' });
    const generator = new ReportGenerator({
      dataset,
      registry,
      planReportIntent: async () => ({
        kind: 'report', intents: [{ kind: 'knowledge', questionPart: '回顾预警', evidencePolicy: 'knowledge' }],
        knowledgeTopics: ['运行预警回顾'], assistantProfile: false,
      }),
      resolveReportEvidence: () => evidence,
      planReport: async () => [outline('page-1', 0)],
      composeSlide: productionComposeSlide,
      registerSpeech: (_reportId, text) => `speech:${text}`,
      unregisterSpeech: () => undefined,
    }, { settings, requestCompletion });

    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await generator.run(created.reportId);

    expect(promptKinds).toEqual(['initial', 'repair']);
    expect(registry.getSnapshot(created.reportId)).toMatchObject({
      status: 'ready', slides: [{ title: '知识要点分析' }],
    });
  });

  it('stops narration registration immediately when the first segment cancels the report', async () => {
    let reportId = '';
    const registrations: string[] = [];
    const rolledBack: string[] = [];
    let registry!: ReportJobRegistry;
    registry = new ReportJobRegistry({ createId: () => 'report-cancel-speech' });
    const { generator } = generatorWith({
      registry,
      planReport: async () => [outline('page-1', 0)],
      registerSpeech: (_ownedReportId, text) => {
        const speechId = `speech-${registrations.length + 1}`;
        registrations.push(text);
        registry.cancel(reportId);
        return speechId;
      },
      unregisterSpeech: (_ownedReportId, speechId) => { rolledBack.push(speechId); },
    });
    ({ reportId } = generator.createReport({ question: '回顾预警', page: 'overview' }));
    await generator.run(reportId);

    expect(registrations).toEqual(['近期相似运行预警回顾第一段。']);
    expect(rolledBack).toEqual(['speech-1']);
    expect(registry.getSnapshot(reportId)).toMatchObject({ status: 'cancelled', slides: [] });
  });

  it('rolls back an exact partial narration registration without deleting ready sibling speech', async () => {
    let nextSpeech = 0;
    const liveSpeech = new Set<string>();
    const rolledBack: string[] = [];
    const { generator, registry } = generatorWith({
      registerSpeech: (_reportId, text) => {
        if (text.includes('详情 2第二段')) throw new Error('speech registration failed');
        const speechId = `speech-${++nextSpeech}`;
        liveSpeech.add(speechId);
        return speechId;
      },
      unregisterSpeech: (_reportId, speechId) => {
        rolledBack.push(speechId);
        liveSpeech.delete(speechId);
      },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await generator.run(created.reportId);

    const snapshot = registry.getSnapshot(created.reportId)!;
    expect(snapshot).toMatchObject({
      status: 'partial',
      slides: [{ id: 'page-1' }],
      outline: [{ status: 'ready' }, { status: 'failed', retryable: false }],
    });
    expect(rolledBack).toEqual(['speech-3']);
    expect(snapshot.slides[0]!.narration.every(({ speechId }) => liveSpeech.has(speechId))).toBe(true);
  });

  it('prioritizes a selected not-yet-started page when later composition begins', async () => {
    const first = deferred<ReportSlide>();
    const pages = Array.from({ length: 5 }, (_, order) => outline(`page-${order + 1}`, order));
    const started: number[] = [];
    const { generator, registry } = generatorWith({
      planReport: async () => pages,
      composeSlide: async (input: { outline: SlideOutline }) => {
        started.push(input.outline.order);
        return input.outline.order === 0 ? first.promise : slide(input.outline);
      },
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await eventually(() => expect(registry.getSnapshot(created.reportId)?.outline).toHaveLength(5));
    generator.prioritize(created.reportId, 'page-5');
    first.resolve(slide(pages[0]!));
    await generator.run(created.reportId);

    expect(started).toEqual([0, 4, 1, 2, 3]);
  });

  it('maps a route-selected ready page to the next not-yet-started page', () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-route-priority' });
    const reportId = registry.create(createInput).reportId;
    const pages = [outline('page-1', 0), outline('page-2', 1), outline('page-3', 2)];
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, pages);
    registry.publishSlide(reportId, slide(pages[0]!));
    const { generator } = generatorWith({ registry });

    expect(registry.updateSession(reportId, { activity: 'page', activeSlideId: 'page-1' })).toBe(true);
    generator.prioritize(reportId, 'page-1');

    expect(registry.getSnapshot(reportId)?.conversation.activeSlideId).toBe('page-1');
    expect(generator.getRetainedStateCountsForTesting().activeSlideIds).toBe(1);
    registry.cancel(reportId);
  });

  it('settles the exact exhausted two-page screenshot case with one final failed event', async () => {
    const attempts = new Map<number, number>();
    const { generator, registry, registerSpeech, unregisterSpeech } = generatorWith({
      composeSlide: async (input: { outline: SlideOutline }) => {
        attempts.set(input.outline.order, (attempts.get(input.outline.order) ?? 0) + 1);
        if (input.outline.order === 1) throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
        return slide(input.outline);
      },
    });
    const created = generator.createReport({ question: '回顾近期相似运行预警', page: 'overview' });
    await generator.run(created.reportId);
    const snapshot = registry.getSnapshot(created.reportId)!;
    const failedEvents = (registry.replayAfter(created.reportId, 0) ?? [])
      .filter((event) => event.type === 'slide.failed');

    expect(attempts).toEqual(new Map([[0, 1], [1, 2]]));
    expect(snapshot).toMatchObject({
      status: 'partial', phase: 'completed', slides: [{ id: 'page-1' }],
      outline: [{ status: 'ready' }, { status: 'failed', retryable: true }],
    });
    expect(new Set(snapshot.slides.map(({ id }) => id)).size).toBe(1);
    expect(new Set(snapshot.slides.flatMap(({ narration }) => narration.map(({ id }) => id))).size).toBe(2);
    expect(registerSpeech).toHaveBeenCalledTimes(2);
    expect(unregisterSpeech).not.toHaveBeenCalled();
    expect(failedEvents).toEqual([expect.objectContaining({ slideId: 'page-2', retryable: true })]);
  });

  it('routes a question-only new topic through intent and evidence before composing its first appended page', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-intent-first-append' });
    const reportId = registry.create(createInput).reportId;
    const originalOutline = outline('page-1', 0);
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [originalOutline]);
    registry.publishSlide(reportId, slide(originalOutline));
    registry.complete(reportId);
    const reservation = registry.reserveFollowUp(reportId, 'memory-turn', 'memory-turn', Promise.resolve({} as never));
    if (reservation?.kind !== 'started') throw new Error('reservation failed');
    registry.commitFollowUp(reportId, {
      ordinal: reservation.ordinal,
      signal: reservation.signal,
      response: {} as never,
      turn: {
        id: 'turn-1', question: '上一轮问了能耗', answer: '上一轮确认了鼓风能耗', citedEvidence: [],
        needsClarification: false, createdAt: '2026-08-14T00:00:00.000Z',
      },
    });
    const oldSnapshot = registry.getSnapshot(reportId)!;
    const newEvidence: ReportEvidenceBundle = {
      snapshotId: 'evidence:new-topic',
      knowledge: [{ key: 'knowledge:0', topic: '新主题证据', provenance: 'model-knowledge' }],
    };
    const firstAppended = deferred<ReportSlide>();
    const started: number[] = [];
    const { generator, planReportIntent, resolveEvidence, planReport } = generatorWith({
      registry,
      planReportIntent: async () => ({
        kind: 'report', intents: [{ kind: 'knowledge', questionPart: '继续分析新主题', evidencePolicy: 'knowledge' }],
        knowledgeTopics: ['新主题证据'], assistantProfile: false,
      }),
      resolveReportEvidence: () => newEvidence,
      planReport: async () => [outline('provider-first', 0), outline('provider-later', 1)],
      composeSlide: async (input: { outline: SlideOutline; evidence: ReportEvidenceBundle }) => {
        started.push(input.outline.order);
        const composed = slide(input.outline, input.evidence);
        return input.outline.order === 1 ? firstAppended.promise : composed;
      },
    });

    const append = generator.appendNewTopic(reportId, { question: '继续分析新主题' });
    await eventually(() => expect(started).toContain(1));
    const startedBeforeFirstReady = [...started];
    firstAppended.resolve(slide({ ...outline('provider-first', 0), id: registry.getSnapshot(reportId)!.outline[1]!.id, order: 1 }, newEvidence));
    const result = await append;

    expect(startedBeforeFirstReady).toEqual([1]);
    expect(planReportIntent).toHaveBeenCalledWith(expect.objectContaining({
      question: '继续分析新主题',
      conversation: expect.arrayContaining([
        { role: 'user', content: '上一轮问了能耗' },
        { role: 'assistant', content: '上一轮确认了鼓风能耗' },
      ]),
    }), expect.anything());
    expect(resolveEvidence).toHaveBeenCalledOnce();
    expect(planReport).toHaveBeenCalledWith(expect.objectContaining({ evidence: newEvidence }), expect.anything());
    expect(result).toMatchObject({ added: true, slideId: expect.any(String) });
    const appended = registry.getSnapshot(reportId)!;
    expect(appended.outline.map(({ order }) => order)).toEqual([0, 1, 2]);
    expect(appended.slides[0]).toEqual(oldSnapshot.slides[0]);
    expect(appended.slides.slice(1).map(({ evidenceSnapshotId }) => evidenceSnapshotId)).toEqual([
      newEvidence.snapshotId, newEvidence.snapshotId,
    ]);
    expect(registry.getEvidence(reportId, evidence.snapshotId)).toEqual(evidence);
    expect(registry.getEvidence(reportId, newEvidence.snapshotId)).toEqual(newEvidence);
  });

  it('reuses the current page snapshot when intent-first planning needs no new evidence', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-reuse-evidence' });
    const reportId = registry.create(createInput).reportId;
    const first = outline('page-1', 0);
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [first]);
    registry.publishSlide(reportId, slide(first));
    registry.complete(reportId);
    const { generator, resolveEvidence } = generatorWith({
      registry,
      planReportIntent: async () => ({
        kind: 'report', intents: [{ kind: 'knowledge', questionPart: '继续回顾预警', evidencePolicy: 'knowledge' }],
        knowledgeTopics: ['运行预警回顾'], assistantProfile: false,
      }),
      resolveReportEvidence: () => { throw new Error('resolver should not run'); },
      planReport: async () => [outline('provider-reused', 0)],
    });

    await expect(generator.appendNewTopic(reportId, { question: '继续回顾预警' }))
      .resolves.toMatchObject({ added: true, slideId: expect.any(String) });

    expect(resolveEvidence).not.toHaveBeenCalled();
    expect(registry.getSnapshot(reportId)?.slides.at(-1)?.evidenceSnapshotId).toBe(evidence.snapshotId);
  });

  it('uses the exact requested source page instead of the active or latest page', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-exact-source' });
    const reportId = registry.create(createInput).reportId;
    const oldEvidence = { ...evidence, snapshotId: 'evidence:source-old' };
    const newEvidence = {
      snapshotId: 'evidence:source-new',
      knowledge: [{ key: 'knowledge:0', topic: '新页面知识', provenance: 'model-knowledge' as const }],
    };
    const oldPage = outline('page-old', 0);
    const newPage = outline('page-new', 1);
    registry.setEvidence(reportId, oldEvidence);
    registry.setEvidence(reportId, newEvidence);
    registry.publishOutline(reportId, [oldPage, newPage]);
    registry.publishSlide(reportId, slide(oldPage, oldEvidence));
    registry.publishSlide(reportId, slide(newPage, newEvidence));
    registry.complete(reportId);
    registry.updateSession(reportId, { activity: 'page', activeSlideId: newPage.id });
    const plannedWith: string[] = [];
    const { generator } = generatorWith({
      registry,
      planReportIntent: async () => ({
        kind: 'report', intents: [{ kind: 'knowledge', questionPart: '追问旧页', evidencePolicy: 'knowledge' }],
        knowledgeTopics: ['运行预警回顾'], assistantProfile: false,
      }),
      resolveReportEvidence: () => { throw new Error('exact source evidence should be reused'); },
      planReport: async (input: { evidence: ReportEvidenceBundle }) => {
        plannedWith.push(input.evidence.snapshotId);
        return [outline('provider-exact-source', 0)];
      },
    });

    await expect(generator.appendNewTopic(reportId, {
      question: '追问旧页',
      sourceSlideId: oldPage.id,
      sourceEvidenceSnapshotId: oldEvidence.snapshotId,
    })).resolves.toMatchObject({ added: true });

    expect(plannedWith).toEqual([oldEvidence.snapshotId]);
  });

  it('creates corrected evidence for a correction page without mutating the old page snapshot', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-corrected-evidence' });
    const reportId = registry.create(createInput).reportId;
    const dataEvidence: ReportEvidenceBundle = {
      snapshotId: 'evidence:before-correction',
      knowledge: [{ key: 'knowledge:0', topic: '运行预警回顾', provenance: 'model-knowledge' }],
      analysis: {
        scope: { modules: ['energy'], metrics: ['totalKwh'], dateRange: { from: '2026-08-01', to: '2026-08-12' }, sampleCount: 2, granularity: 'daily' },
        definitions: [{ key: 'totalKwh', label: '总电耗', unit: 'kWh/d' }],
        series: [
          { date: '2026-08-01', values: { totalKwh: 480 } },
          { date: '2026-08-12', values: { totalKwh: 500 } },
        ],
        aggregates: { totalKwh: { min: 480, max: 500, average: 490, latest: 500, changeRate: 0.0417 } },
        thresholdBreaches: [], correlations: [], alerts: [],
      },
    };
    const first = outline('page-1', 0);
    registry.setEvidence(reportId, dataEvidence);
    registry.publishOutline(reportId, [first]);
    registry.publishSlide(reportId, slide(first, dataEvidence));
    registry.complete(reportId);
    const reservation = registry.reserveFollowUp(reportId, 'correction', 'correction', Promise.resolve({} as never));
    if (reservation?.kind !== 'started') throw new Error('reservation failed');
    registry.commitFollowUp(reportId, {
      ordinal: reservation.ordinal,
      signal: reservation.signal,
      response: {} as never,
      turn: {
        id: 'turn-correction', question: '总电耗修正为 495 kWh/d', answer: '已修正为 495 kWh/d',
        citedEvidence: [], needsClarification: false, createdAt: '2026-08-14T00:00:00.000Z',
      },
      correction: {
        evidenceSnapshotId: dataEvidence.snapshotId,
        evidenceKey: 'totalKwh', value: 495, unit: 'kWh/d', statement: '修正为 495 kWh/d',
        createdAt: '2026-08-14T00:00:00.000Z',
      },
    });
    const seenEvidence: ReportEvidenceBundle[] = [];
    const { generator } = generatorWith({
      registry,
      planReportIntent: async () => ({
        kind: 'report', intents: [{ kind: 'lookup', questionPart: '修正总电耗', evidencePolicy: 'data' }],
        knowledgeTopics: [], assistantProfile: false,
        analysisPlan: {
          modules: ['energy'], metrics: ['totalKwh'], dateRange: { from: '2026-08-01', to: '2026-08-12' },
          methods: ['summary'], includeAlerts: false, includeHealthWeights: false,
        },
      }),
      resolveReportEvidence: () => { throw new Error('current correction evidence should be reused'); },
      planReport: async () => [outline('provider-correction', 0)],
      composeSlide: async (input: { outline: SlideOutline; evidence: ReportEvidenceBundle }) => {
        seenEvidence.push(input.evidence);
        return correctionSlide(input.outline, input.evidence, 'totalKwh');
      },
    });

    const correction = {
      evidenceSnapshotId: dataEvidence.snapshotId,
      evidenceKey: 'totalKwh', value: 495, unit: 'kWh/d', statement: '修正为 495 kWh/d',
      createdAt: '2026-08-14T00:00:00.000Z',
    };
    const result = await generator.appendNewTopic(reportId, {
      question: '总电耗修正为 495 kWh/d',
      sourceSlideId: first.id,
      sourceEvidenceSnapshotId: dataEvidence.snapshotId,
      correction,
    });
    expect(result).toMatchObject({ added: true, slideId: expect.any(String) });

    expect(seenEvidence[0]?.snapshotId).not.toBe(dataEvidence.snapshotId);
    expect(seenEvidence[0]?.analysis).toEqual(dataEvidence.analysis);
    expect(seenEvidence[0]).toMatchObject({
      userCorrections: [{
        key: 'user-correction:totalKwh',
        evidenceKey: 'totalKwh',
        value: 495,
        unit: 'kWh/d',
        provenance: 'user-provided-unverified',
        sourceSlideId: first.id,
        sourceEvidenceSnapshotId: dataEvidence.snapshotId,
      }],
    });
    expect(registry.getEvidence(reportId, dataEvidence.snapshotId)?.analysis?.aggregates.totalKwh?.latest).toBe(500);
    const correctionPage = registry.getSnapshot(reportId)!.slides.at(-1)!;
    expect(correctionPage.evidenceSnapshotId).toBe(seenEvidence[0]?.snapshotId);
  });

  it('retries a failed appended page with the evidence snapshot selected for that append', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-append-retry-evidence' });
    const reportId = registry.create(createInput).reportId;
    const first = outline('page-1', 0);
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [first]);
    registry.publishSlide(reportId, slide(first));
    registry.complete(reportId);
    const newEvidence: ReportEvidenceBundle = {
      snapshotId: 'evidence:append-retry',
      knowledge: [{ key: 'knowledge:0', topic: '追加页新证据', provenance: 'model-knowledge' }],
    };
    let attempts = 0;
    const seenSnapshots: string[] = [];
    const composeSlide = async (input: { outline: SlideOutline; evidence: ReportEvidenceBundle }) => {
      attempts += 1;
      seenSnapshots.push(input.evidence.snapshotId);
      if (attempts <= 2) throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
      return slide(input.outline, input.evidence);
    };
    const { generator } = generatorWith({
      registry,
      planReportIntent: async () => ({
        kind: 'report', intents: [{ kind: 'knowledge', questionPart: '追加页新证据', evidencePolicy: 'knowledge' }],
        knowledgeTopics: ['追加页新证据'], assistantProfile: false,
      }),
      resolveReportEvidence: () => newEvidence,
      planReport: async () => [outline('provider-append-retry', 0)],
      composeSlide,
    });

    await expect(generator.appendNewTopic(reportId, {
      question: '追加页新证据',
      sourceSlideId: first.id,
      sourceEvidenceSnapshotId: evidence.snapshotId,
    }))
      .resolves.toEqual({ added: true });
    const failedId = registry.getSnapshot(reportId)!.outline[1]!.id;
    const reconstructed = generatorWith({ registry, composeSlide }).generator;
    reconstructed.retrySlide(reportId, failedId);
    await eventually(() => expect(registry.getSnapshot(reportId)?.outline[1]?.status).toBe('ready'));

    expect(seenSnapshots).toEqual([
      newEvidence.snapshotId,
      newEvidence.snapshotId,
      newEvidence.snapshotId,
    ]);
    expect(registry.getSnapshot(reportId)?.slides[1]?.evidenceSnapshotId).toBe(newEvidence.snapshotId);
    expect(registry.getSnapshot(reportId)?.slides[0]?.supersededBySlideId).toBeUndefined();
  });

  it('persists a failed correction append intent and supersedes its exact source only after a valid retry succeeds', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-correction-retry' });
    const reportId = registry.create(createInput).reportId;
    const sourceEvidence: ReportEvidenceBundle = {
      snapshotId: 'evidence:correction-source',
      knowledge: [],
      analysis: {
        scope: {
          modules: ['energy'], metrics: ['totalKwh'],
          dateRange: { from: '2026-08-01', to: '2026-08-12' }, sampleCount: 2, granularity: 'daily',
        },
        definitions: [{ key: 'totalKwh', label: '总电耗', unit: 'kWh/d' }],
        series: [
          { date: '2026-08-01', values: { totalKwh: 480 } },
          { date: '2026-08-12', values: { totalKwh: 500 } },
        ],
        aggregates: { totalKwh: { min: 480, max: 500, average: 490, latest: 500, changeRate: 0.0417 } },
        thresholdBreaches: [], correlations: [], alerts: [],
      },
    };
    const sourceOutline = { ...outline('source-page', 0), evidencePolicy: 'data' as const };
    registry.setEvidence(reportId, sourceEvidence);
    registry.publishOutline(reportId, [sourceOutline]);
    registry.publishSlide(reportId, {
      ...slide(sourceOutline, { ...sourceEvidence, knowledge: [{ key: 'knowledge:0', topic: '占位', provenance: 'model-knowledge' }] }),
      evidenceSnapshotId: sourceEvidence.snapshotId,
    });
    registry.complete(reportId);
    const correction = {
      evidenceSnapshotId: sourceEvidence.snapshotId,
      evidenceKey: 'totalKwh', value: 495, unit: 'kWh/d', statement: '修正为 495 kWh/d',
      createdAt: '2026-08-14T00:00:00.000Z',
    };
    let attempts = 0;
    const composeSlide = async (input: { outline: SlideOutline; evidence: ReportEvidenceBundle }) => {
      attempts += 1;
      if (attempts <= 2) throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
      return correctionSlide(input.outline, input.evidence, correction.evidenceKey);
    };
    const correctionOutline = {
      ...outline('provider-correction-retry', 0),
      title: '总电耗纠正说明',
      evidencePolicy: 'mixed' as const,
      visualKind: 'kpi-grid' as const,
      evidenceKeys: ['totalKwh', 'user-correction:totalKwh'],
    };
    const correctionOwner = registry.reserveFollowUp(
      reportId,
      'correction-retry-owner',
      'correction-retry-owner',
      Promise.resolve({} as never),
    );
    if (correctionOwner?.kind !== 'started') throw new Error('correction owner reservation failed');
    const { generator } = generatorWith({
      registry,
      planReportIntent: async () => ({
        kind: 'report', intents: [{ kind: 'lookup', questionPart: '修正总电耗', evidencePolicy: 'data' }],
        knowledgeTopics: [], assistantProfile: false,
        analysisPlan: {
          modules: ['energy'], metrics: ['totalKwh'], dateRange: { from: '2026-08-01', to: '2026-08-12' },
          methods: ['summary'], includeAlerts: false, includeHealthWeights: false,
        },
      }),
      resolveReportEvidence: () => { throw new Error('source evidence must be reused'); },
      planReport: async () => [correctionOutline],
      composeSlide,
    });

    await expect(generator.appendNewTopic(reportId, {
      question: '总电耗修正为 495 kWh/d',
      sourceSlideId: sourceOutline.id,
      sourceEvidenceSnapshotId: sourceEvidence.snapshotId,
      correction,
    }, { ordinal: correctionOwner.ordinal, signal: correctionOwner.signal })).resolves.toEqual({ added: true });
    const failedSlideId = registry.getSnapshot(reportId)!.outline[1]!.id;
    expect(registry.getSnapshot(reportId)?.outline[1]).toMatchObject({ status: 'failed', retryable: true });
    expect(registry.getSnapshot(reportId)?.slides[0]?.supersededBySlideId).toBeUndefined();
    const retryEvidence = registry.getEvidenceForSlide(reportId, failedSlideId)!;
    const correctionIntent = {
      followUpOrdinal: registry.getConversationMemory(reportId)!.latestTurnOrdinal,
      correctionSlideId: failedSlideId,
      correctionEvidenceSnapshotId: retryEvidence.snapshotId,
      sourceSlideId: sourceOutline.id,
      sourceEvidenceSnapshotId: sourceEvidence.snapshotId,
      evidenceKey: correction.evidenceKey,
      value: correction.value,
      unit: correction.unit,
      statement: correction.statement,
    };
    const validCorrectionPage = correctionSlide(
      registry.getSnapshot(reportId)!.outline[1]!,
      retryEvidence,
      correction.evidenceKey,
    );
    expect(slideBindsCorrectionIntent(validCorrectionPage, retryEvidence, correctionIntent)).toBe(true);
    expect(slideBindsCorrectionIntent({
      ...validCorrectionPage,
      metrics: validCorrectionPage.metrics.map((metric) => metric.source === 'user-correction'
        ? { ...metric, snapshotId: 'evidence:wrong-correction-snapshot' }
        : metric),
    }, retryEvidence, correctionIntent)).toBe(false);
    generatorWith({ registry, composeSlide }).generator.retrySlide(reportId, failedSlideId);
    await eventually(() => expect(registry.getSnapshot(reportId)?.outline[1]?.status).toBe('ready'));

    const retried = registry.getSnapshot(reportId)!;
    expect(retried.slides.find(({ id }) => id === sourceOutline.id)?.supersededBySlideId).toBe(failedSlideId);
    expect(retried.conversation.activeSlideId).toBe(failedSlideId);
    expect(retried.slides.filter(({ supersededBySlideId }) => supersededBySlideId === undefined).map(({ id }) => id))
      .toEqual([failedSlideId]);
    expect(attempts).toBe(3);
  });

  it('refuses an old failed correction retry after a newer follow-up takes ownership', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-stale-correction-retry' });
    const reportId = registry.create(createInput).reportId;
    const sourceEvidence = correctionSourceEvidence('evidence:stale-correction-source');
    const sourceOutline = { ...outline('stale-source-page', 0), evidencePolicy: 'data' as const };
    registry.setEvidence(reportId, sourceEvidence);
    registry.publishOutline(reportId, [sourceOutline]);
    registry.publishSlide(reportId, slide(sourceOutline, sourceEvidence));
    registry.complete(reportId);

    const correction = {
      evidenceSnapshotId: sourceEvidence.snapshotId,
      evidenceKey: 'totalKwh', value: 495, unit: 'kWh/d', statement: '修正为 495 kWh/d',
      createdAt: '2026-08-14T00:00:00.000Z',
    };
    let attempts = 0;
    const composeSlide = async (input: { outline: SlideOutline; evidence: ReportEvidenceBundle }) => {
      attempts += 1;
      if (attempts <= 2) throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
      return correctionSlide(input.outline, input.evidence, correction.evidenceKey);
    };
    const owner = registry.reserveFollowUp(reportId, 'old-correction', 'old-correction', Promise.resolve({} as never));
    if (owner?.kind !== 'started') throw new Error('old correction reservation failed');
    const { generator } = generatorWith({
      registry,
      planReport: async () => [{
        ...outline('provider-stale-correction', 0),
        title: '总电耗纠正说明',
        evidencePolicy: 'mixed' as const,
        visualKind: 'kpi-grid' as const,
        evidenceKeys: ['totalKwh', 'user-correction:totalKwh'],
      }],
      composeSlide,
    });

    await expect(generator.appendNewTopic(reportId, {
      question: '总电耗修正为 495 kWh/d',
      sourceSlideId: sourceOutline.id,
      sourceEvidenceSnapshotId: sourceEvidence.snapshotId,
      correction,
    }, { ordinal: owner.ordinal, signal: owner.signal })).resolves.toEqual({ added: true });
    const failedSlideId = registry.getSnapshot(reportId)!.outline[1]!.id;
    expect(registry.getSnapshot(reportId)?.outline[1]).toMatchObject({ status: 'failed', retryable: true });

    const newer = registry.reserveFollowUp(reportId, 'newer-follow-up', 'newer-follow-up', Promise.resolve({} as never));
    if (newer?.kind !== 'started') throw new Error('newer reservation failed');
    generatorWith({ registry, composeSlide }).generator.retrySlide(reportId, failedSlideId);
    await eventually(() => expect(registry.getSnapshot(reportId)?.outline[1])
      .toMatchObject({ status: 'failed', retryable: false }));

    const settled = registry.getSnapshot(reportId)!;
    expect(settled.slides.find(({ id }) => id === sourceOutline.id)?.supersededBySlideId).toBeUndefined();
    expect(settled.slides.some(({ id }) => id === failedSlideId)).toBe(false);
    expect(settled.conversation.activeSlideId).toBe(sourceOutline.id);
    expect(attempts).toBe(2);
  });

  it('settles only its owned appended slots when newer follow-up ownership wins during composition', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-latest-compose' });
    const reportId = registry.create(createInput).reportId;
    const first = outline('page-1', 0);
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [first]);
    registry.publishSlide(reportId, slide(first));
    registry.complete(reportId);
    const composing = deferred<ReportSlide>();
    const { generator, composeSlide } = generatorWith({
      registry,
      planReport: async () => [outline('provider-stale-compose', 0), outline('provider-stale-later', 1)],
      composeSlide: () => composing.promise,
    });
    const firstReservation = registry.reserveFollowUp(reportId, 'owned-1', 'owned-1', Promise.resolve({} as never));
    if (firstReservation?.kind !== 'started') throw new Error('first reservation failed');
    const append = generator.appendNewTopic(reportId, {
      question: '追加两页', sourceSlideId: first.id, sourceEvidenceSnapshotId: evidence.snapshotId,
    }, { ordinal: firstReservation.ordinal, signal: firstReservation.signal });
    await eventually(() => expect(composeSlide).toHaveBeenCalledOnce());
    const ownedIds = registry.getSnapshot(reportId)!.outline.slice(1).map(({ id }) => id);
    const secondReservation = registry.reserveFollowUp(reportId, 'owned-2', 'owned-2', Promise.resolve({} as never));
    if (secondReservation?.kind !== 'started') throw new Error('second reservation failed');
    composing.resolve(slide(registry.getSnapshot(reportId)!.outline[1]!));

    await expect(append).resolves.toEqual({ added: false, reason: 'stale' });
    expect(registry.getSnapshot(reportId)!.outline
      .filter(({ id }) => ownedIds.includes(id))
      .map(({ status, retryable }) => ({ status, retryable })))
      .toEqual([
        { status: 'failed', retryable: false },
        { status: 'failed', retryable: false },
      ]);
  });

  it('settles appended generating and planned slots when cancellation wins during composition', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-cancel-compose' });
    const reportId = registry.create(createInput).reportId;
    const first = outline('page-1', 0);
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [first]);
    registry.publishSlide(reportId, slide(first));
    registry.complete(reportId);
    const composing = deferred<ReportSlide>();
    const { generator, composeSlide } = generatorWith({
      registry,
      planReport: async () => [outline('provider-cancel-compose', 0), outline('provider-cancel-later', 1)],
      composeSlide: () => composing.promise,
    });
    const append = generator.appendNewTopic(reportId, {
      question: '取消中的追加页', sourceSlideId: first.id, sourceEvidenceSnapshotId: evidence.snapshotId,
    });
    await eventually(() => expect(composeSlide).toHaveBeenCalledOnce());
    const additionIds = registry.getSnapshot(reportId)!.outline.slice(1).map(({ id }) => id);

    registry.cancel(reportId);
    composing.resolve(slide(registry.getSnapshot(reportId)!.outline[1]!));

    await expect(append).resolves.toEqual({ added: false, reason: 'stale' });
    const cancelled = registry.getSnapshot(reportId)!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.outline.filter(({ id }) => additionIds.includes(id)).map(({ status, retryable }) => ({ status, retryable })))
      .toEqual([
        { status: 'failed', retryable: false },
        { status: 'failed', retryable: false },
      ]);
  });

  it('does not retain distinct evidence snapshots from repeatedly stale append plans', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-stale-evidence' });
    const reportId = registry.create(createInput).reportId;
    const first = outline('page-1', 0);
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [first]);
    registry.publishSlide(reportId, slide(first));
    registry.complete(reportId);
    let sequence = 0;
    const planning = deferred<SlideOutline[]>();
    const { generator, planReport } = generatorWith({
      registry,
      resolveReportEvidence: () => ({
        snapshotId: `evidence:stale-${++sequence}`,
        knowledge: [{ key: 'knowledge:0', topic: `stale-${sequence}`, provenance: 'model-knowledge' }],
      }),
      planReport: () => planning.promise,
      planReportIntent: async () => ({
        kind: 'report', intents: [{ kind: 'knowledge', questionPart: '新证据', evidencePolicy: 'knowledge' }],
        knowledgeTopics: ['新证据'], assistantProfile: false,
      }),
    });
    const owner = registry.reserveFollowUp(reportId, 'stale-evidence-1', 'stale-evidence-1', Promise.resolve({} as never));
    if (owner?.kind !== 'started') throw new Error('owner reservation failed');
    const append = generator.appendNewTopic(reportId, {
      question: '新证据', sourceSlideId: first.id, sourceEvidenceSnapshotId: evidence.snapshotId,
    }, { ordinal: owner.ordinal, signal: owner.signal });
    await eventually(() => expect(planReport).toHaveBeenCalledOnce());
    registry.reserveFollowUp(reportId, 'stale-evidence-2', 'stale-evidence-2', Promise.resolve({} as never));
    planning.resolve([outline('provider-stale-evidence', 0)]);

    await expect(append).resolves.toEqual({ added: false, reason: 'stale' });
    expect(registry.getEvidence(reportId, 'evidence:stale-1')).toBeUndefined();
    expect(registry.getEvidence(reportId, evidence.snapshotId)).toEqual(evidence);
  });

  it.each(['failed', 'planned'] as const)('reuses a %s slot at twelve-page capacity without rewriting ready siblings', async (targetStatus) => {
    const registry = new ReportJobRegistry({ createId: () => `report-capacity-${targetStatus}` });
    const reportId = registry.create(createInput).reportId;
    const pages = Array.from({ length: REPORT_MAX_SLIDES }, (_, order) => outline(`page-${order + 1}`, order));
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, pages);
    for (let order = 0; order < REPORT_MAX_SLIDES - 1; order += 1) {
      registry.publishSlide(reportId, slide(pages[order]!));
    }
    if (targetStatus === 'failed') {
      registry.markSlideFailed(reportId, pages.at(-1)!.id, true);
      registry.complete(reportId);
    }
    const readyBefore = registry.getSnapshot(reportId)!.slides;
    const { generator, composeSlide } = generatorWith({
      registry,
      planReport: async () => [{ ...outline('provider-new', 0), title: '新主题' }],
    });

    await expect(generator.appendNewTopic(reportId, { question: '继续分析能耗' }))
      .resolves.toMatchObject({ added: true, reason: 'merged', slideId: pages.at(-1)!.id });
    const current = registry.getSnapshot(reportId)!;
    expect(current.outline).toHaveLength(REPORT_MAX_SLIDES);
    expect(current.outline.at(-1)).toMatchObject({ id: pages.at(-1)!.id, order: REPORT_MAX_SLIDES - 1, title: '新主题', status: 'ready' });
    expect(current.slides.slice(0, -1)).toEqual(readyBefore);
    expect(composeSlide).toHaveBeenCalledWith(expect.objectContaining({
      outline: expect.objectContaining({ id: pages.at(-1)!.id, order: REPORT_MAX_SLIDES - 1 }),
    }), expect.anything());
  });

  it('does not call the planner or rewrite a report when all twelve pages are ready', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-capacity-ready' });
    const reportId = registry.create(createInput).reportId;
    const pages = Array.from({ length: REPORT_MAX_SLIDES }, (_, order) => outline(`page-${order + 1}`, order));
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, pages);
    for (const item of pages) registry.publishSlide(reportId, slide(item));
    registry.complete(reportId);
    const before = registry.getSnapshot(reportId)!;
    const { generator, planReport } = generatorWith({ registry });

    await expect(generator.appendNewTopic(reportId, { question: '继续分析能耗' }))
      .resolves.toEqual({ added: false, reason: 'capacity-full' });
    expect(planReport).not.toHaveBeenCalled();
    expect(registry.getSnapshot(reportId)).toMatchObject({
      status: before.status,
      outline: before.outline,
      slides: before.slides,
    });
  });

  it('does not replace a capacity slot that becomes ready while follow-up planning is pending', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-capacity-race' });
    const reportId = registry.create(createInput).reportId;
    const pages = Array.from({ length: REPORT_MAX_SLIDES }, (_, order) => outline(`page-${order + 1}`, order));
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, pages);
    for (let order = 0; order < REPORT_MAX_SLIDES - 1; order += 1) {
      registry.publishSlide(reportId, slide(pages[order]!));
    }
    registry.markSlideFailed(reportId, pages.at(-1)!.id, true);
    registry.complete(reportId);
    const planner = deferred<SlideOutline[]>();
    const { generator, planReport, composeSlide } = generatorWith({ registry, planReport: () => planner.promise });
    const append = generator.appendNewTopic(reportId, { question: '继续分析能耗' });
    await eventually(() => expect(planReport).toHaveBeenCalledOnce());

    registry.resetSlideForRetry(reportId, pages.at(-1)!.id);
    registry.markSlideGenerating(reportId, pages.at(-1)!.id);
    registry.publishSlide(reportId, slide(pages.at(-1)!));
    registry.complete(reportId);
    planner.resolve([{ ...outline('provider-new', 0), title: '不应覆盖' }]);

    await expect(append).resolves.toEqual({ added: false, reason: 'capacity-full' });
    expect(composeSlide).not.toHaveBeenCalled();
    expect(registry.getSnapshot(reportId)?.outline.at(-1)).toMatchObject({
      id: pages.at(-1)!.id,
      title: pages.at(-1)!.title,
      status: 'ready',
    });
  });

  it.each(['append', 'merge'] as const)('rejects stale %s output when its exact published snapshot changes synchronously', async (mode) => {
    const registry = new ReportJobRegistry({ createId: () => `report-exact-${mode}` });
    const reportId = registry.create(createInput).reportId;
    const count = mode === 'merge' ? REPORT_MAX_SLIDES : 1;
    const pages = Array.from({ length: count }, (_, order) => outline(`page-${order + 1}`, order));
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, pages);
    for (let order = 0; order < count - (mode === 'merge' ? 1 : 0); order += 1) {
      registry.publishSlide(reportId, slide(pages[order]!));
    }
    if (mode === 'merge') registry.markSlideFailed(reportId, pages.at(-1)!.id, true);
    registry.complete(reportId);
    const { generator, composeSlide } = generatorWith({
      registry,
      planReport: async () => [{ ...outline('provider-new', 0), title: '新主题' }],
    });
    let changed = false;
    registry.subscribe(reportId, (event) => {
      if (changed || event.type !== 'report.outline') return;
      const target = event.outline.at(-1);
      if (!target || target.title !== '新主题') return;
      changed = true;
      registry.mergePendingOutline(reportId, target.id, event.outline.map((item) => item.id === target.id
        ? { ...item, title: '并发替换' }
        : item));
    });

    await expect(generator.appendNewTopic(reportId, { question: '继续分析能耗' }))
      .resolves.toEqual({ added: false, reason: 'stale' });
    expect(composeSlide).not.toHaveBeenCalled();
    expect(registry.getSnapshot(reportId)?.outline.at(-1)?.title).toBe('并发替换');
  });

  it('returns stale without composition when cancellation wins during append publication', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-append-cancel' });
    const reportId = registry.create(createInput).reportId;
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [outline('page-1', 0)]);
    registry.publishSlide(reportId, slide(outline('page-1', 0)));
    registry.complete(reportId);
    const { generator, composeSlide } = generatorWith({
      registry,
      planReport: async () => [outline('provider-new', 0)],
    });
    registry.subscribe(reportId, (event) => {
      if (event.type === 'report.outline' && event.outline.length === 2) registry.cancel(reportId);
    });

    await expect(generator.appendNewTopic(reportId, { question: '继续分析能耗' }))
      .resolves.toEqual({ added: false, reason: 'stale' });
    expect(composeSlide).not.toHaveBeenCalled();
    expect(registry.getSnapshot(reportId)?.status).toBe('cancelled');
  });

  it('returns stale when newer follow-up ownership wins synchronously after append publication', async () => {
    const registry = new ReportJobRegistry({ createId: () => 'report-append-owner' });
    const reportId = registry.create(createInput).reportId;
    registry.setEvidence(reportId, evidence);
    registry.publishOutline(reportId, [outline('page-1', 0)]);
    registry.publishSlide(reportId, slide(outline('page-1', 0)));
    registry.complete(reportId);
    const first = registry.reserveFollowUp(reportId, 'first', 'first-fingerprint', Promise.resolve({} as never));
    if (first?.kind !== 'started') throw new Error('reservation failed');
    const { generator, composeSlide } = generatorWith({
      registry,
      planReport: async () => [outline('provider-new', 0)],
    });
    registry.subscribe(reportId, (event) => {
      if (event.type === 'report.outline' && event.outline.length === 2) {
        registry.reserveFollowUp(reportId, 'newer', 'newer-fingerprint', Promise.resolve({} as never));
      }
    });

    await expect(generator.appendNewTopic(
      reportId,
      { question: '继续分析能耗' },
      { ordinal: first.ordinal, signal: first.signal },
    )).resolves.toEqual({ added: false, reason: 'stale' });
    expect(composeSlide).not.toHaveBeenCalled();
    const snapshot = registry.getSnapshot(reportId)!;
    expect(reportJobSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({
      status: 'partial',
      phase: 'completed',
      outline: [
        { id: 'page-1', status: 'ready' },
        { status: 'failed', retryable: false },
      ],
    });
    expect(snapshot.outline.some(({ status }) => status === 'planned' || status === 'generating')).toBe(false);
  });

  it('removes a cancelled report waiter from the global semaphore without disturbing fairness', async () => {
    const ids = ['report-a', 'report-b', 'report-c'];
    let nextId = 0;
    const registry = new ReportJobRegistry({ createId: () => ids[nextId++]! });
    const blockers = new Map<string, Deferred<ReportSlide>>();
    const started: string[] = [];
    const { generator } = generatorWith({
      registry,
      planReport: async (input: { question: string }) => [outline(`${input.question}-first`, 0), outline(`${input.question}-later`, 1)],
      composeSlide: async (input: { outline: SlideOutline }) => {
        if (input.outline.order === 0) return slide(input.outline);
        started.push(input.outline.id);
        const gate = deferred<ReportSlide>();
        blockers.set(input.outline.id, gate);
        return gate.promise;
      },
    });
    const first = generator.createReport({ question: 'a', page: 'overview' });
    const second = generator.createReport({ question: 'b', page: 'overview' });
    await eventually(() => expect(blockers.size).toBe(2));
    const queued = generator.createReport({ question: 'c', page: 'overview' });
    const queuedRun = generator.run(queued.reportId);
    await eventually(() => expect(generator.getRetainedStateCountsForTesting().queues).toBe(1));

    try {
      registry.cancel(queued.reportId);
      await settleWithin(queuedRun, 'cancelled queued report');
      expect(generator.getRetainedStateCountsForTesting().queues).toBe(0);
      expect(started).toEqual(['a-later', 'b-later']);
    } finally {
      for (const [id, gate] of blockers) gate.resolve(slide(outline(id, 1)));
      await Promise.all([generator.run(first.reportId), generator.run(second.reportId)]);
    }
  });

  it('preserves FIFO fairness for equal-priority later pages across reports', async () => {
    const ids = ['report-block-a', 'report-block-b', 'report-older', 'report-newer'];
    let nextId = 0;
    const registry = new ReportJobRegistry({ createId: () => ids[nextId++]! });
    const blockers = new Map<string, Deferred<ReportSlide>>();
    const started: string[] = [];
    const { generator } = generatorWith({
      registry,
      planReport: async (input: { question: string }) => [
        outline(`${input.question}-first`, 0), outline(`${input.question}-later`, 1),
      ],
      composeSlide: async (input: { outline: SlideOutline }) => {
        if (input.outline.order === 0) return slide(input.outline);
        started.push(input.outline.id);
        if (!input.outline.id.startsWith('block')) return slide(input.outline);
        const gate = deferred<ReportSlide>();
        blockers.set(input.outline.id, gate);
        return gate.promise;
      },
    });
    const blockerA = generator.createReport({ question: 'block-a', page: 'overview' });
    const blockerB = generator.createReport({ question: 'block-b', page: 'overview' });
    await eventually(() => expect(blockers.size).toBe(2));
    const older = generator.createReport({ question: 'older', page: 'overview' });
    const newer = generator.createReport({ question: 'newer', page: 'overview' });
    await eventually(() => expect(generator.getRetainedStateCountsForTesting().queues).toBe(2));

    blockers.get('block-a-later')!.resolve(slide(outline('block-a-later', 1)));
    await eventually(() => expect(started).toContain('older-later'));
    expect(started.slice(0, 3)).toEqual(['block-a-later', 'block-b-later', 'older-later']);
    blockers.get('block-b-later')!.resolve(slide(outline('block-b-later', 1)));
    await Promise.all([
      generator.run(blockerA.reportId), generator.run(blockerB.reportId),
      generator.run(older.reportId), generator.run(newer.reportId),
    ]);
    expect(started.at(-1)).toBe('newer-later');
  });

  it('releases a slot when slide.generating synchronously cancels before composition', async () => {
    const ids = ['report-blocker', 'report-cancelled', 'report-sibling'];
    let nextId = 0;
    const registry = new ReportJobRegistry({ createId: () => ids[nextId++]! });
    const blocker = deferred<ReportSlide>();
    const cancelledComposer = deferred<ReportSlide>();
    const started: string[] = [];
    const { generator } = generatorWith({
      registry,
      planReport: async (input: { question: string }) => [
        outline(`${input.question}-first`, 0), outline(`${input.question}-later`, 1),
      ],
      composeSlide: async (input: { outline: SlideOutline }) => {
        if (input.outline.order === 0) return slide(input.outline);
        started.push(input.outline.id);
        if (input.outline.id === 'blocker-later') return blocker.promise;
        if (input.outline.id === 'cancelled-later') return cancelledComposer.promise;
        return slide(input.outline);
      },
    });
    const blockerReport = generator.createReport({ question: 'blocker', page: 'overview' });
    await eventually(() => expect(started).toEqual(['blocker-later']));
    const cancelledReport = generator.createReport({ question: 'cancelled', page: 'overview' });
    registry.subscribe(cancelledReport.reportId, (event) => {
      if (event.type === 'slide.generating' && event.slideId === 'cancelled-later') {
        registry.cancel(cancelledReport.reportId);
      }
    });
    await eventually(() => expect(registry.getSnapshot(cancelledReport.reportId)?.status).toBe('cancelled'));
    const sibling = generator.createReport({ question: 'sibling', page: 'overview' });

    try {
      await settleWithin(generator.run(sibling.reportId), 'sibling after synchronous cancellation');
      expect(started).toEqual(['blocker-later', 'sibling-later']);
    } finally {
      blocker.resolve(slide(outline('blocker-later', 1)));
      cancelledComposer.resolve(slide(outline('cancelled-later', 1)));
      await Promise.all([generator.run(blockerReport.reportId), generator.run(cancelledReport.reportId)]);
    }
  });

  it('removes queued waiters on absolute TTL ownership loss', async () => {
    let now = 0;
    let nextId = 0;
    const registry = new ReportJobRegistry({
      now: () => now, absoluteTtlMs: 2, createId: () => `report-ttl-${++nextId}`,
    });
    const blockers = new Map<string, Deferred<ReportSlide>>();
    const { generator } = generatorWith({
      registry,
      planReport: async (input: { question: string }) => [outline(`${input.question}-first`, 0), outline(`${input.question}-later`, 1)],
      composeSlide: async (input: { outline: SlideOutline }) => {
        if (input.outline.order === 0) return slide(input.outline);
        const gate = deferred<ReportSlide>();
        blockers.set(input.outline.id, gate);
        return gate.promise;
      },
    });
    generator.createReport({ question: 'a', page: 'overview' });
    generator.createReport({ question: 'b', page: 'overview' });
    await eventually(() => expect(blockers.size).toBe(2));
    const queued = generator.createReport({ question: 'c', page: 'overview' });
    const queuedRun = generator.run(queued.reportId);
    await eventually(() => expect(generator.getRetainedStateCountsForTesting().queues).toBe(1));

    now = 3;
    registry.sweep();
    await settleWithin(queuedRun, 'expired queued report');
    expect(generator.getRetainedStateCountsForTesting().queues).toBe(0);
    for (const [id, gate] of blockers) gate.resolve(slide(outline(id, 1)));
  });

  it('removes an evicted inactive waiter and disposes all remaining waiters', async () => {
    let nextId = 0;
    const registry = new ReportJobRegistry({ maxEntries: 3, createId: () => `report-evict-${++nextId}` });
    const beginActivity = vi.spyOn(registry, 'beginActivity');
    const blockers = new Map<string, Deferred<ReportSlide>>();
    const { generator } = generatorWith({
      registry,
      planReport: async (input: { question: string }) => [outline(`${input.question}-first`, 0), outline(`${input.question}-later`, 1)],
      composeSlide: async (input: { outline: SlideOutline }) => {
        if (input.outline.order === 0) return slide(input.outline);
        const gate = deferred<ReportSlide>();
        blockers.set(input.outline.id, gate);
        return gate.promise;
      },
    });
    generator.createReport({ question: 'a', page: 'overview' });
    generator.createReport({ question: 'b', page: 'overview' });
    await eventually(() => expect(blockers.size).toBe(2));
    const queued = generator.createReport({ question: 'c', page: 'overview' });
    const queuedRun = generator.run(queued.reportId);
    await eventually(() => expect(generator.getRetainedStateCountsForTesting().queues).toBe(1));
    const queuedSignal = beginActivity.mock.results.find((result, index) => (
      beginActivity.mock.calls[index]?.[0] === queued.reportId && result.type === 'return'
    ))?.value as AbortSignal;
    registry.endActivity(queued.reportId, 'generation', queuedSignal);
    registry.create({ question: 'replacement', originPage: 'overview' });

    await settleWithin(queuedRun, 'evicted queued report');
    expect(generator.getRetainedStateCountsForTesting().queues).toBe(0);
    generator.dispose();
    expect(generator.getRetainedStateCountsForTesting()).toEqual({
      contexts: 0, activeSlideIds: 0, evidenceBindings: 0, queues: 0, runs: 0,
    });
    for (const [id, gate] of blockers) gate.resolve(slide(outline(id, 1)));
  });

  it('disposes active work idempotently without retaining handles or allowing late side effects', async () => {
    const composer = deferred<ReportSlide>();
    const { generator, registry, composeSlide, registerSpeech, unregisterSpeech } = generatorWith({
      planReport: async () => [outline('page-1', 0)],
      composeSlide: () => composer.promise,
    });
    const created = generator.createReport({ question: '回顾预警', page: 'overview' });
    await eventually(() => expect(composeSlide).toHaveBeenCalledOnce());
    const run = generator.run(created.reportId);
    const publishSlide = vi.spyOn(registry, 'publishSlide');

    generator.dispose();
    generator.dispose();

    expect(generator.getRetainedStateCountsForTesting()).toEqual({
      contexts: 0, activeSlideIds: 0, evidenceBindings: 0, queues: 0, runs: 0,
    });
    expect(registry.getSnapshot(created.reportId)?.status).toBe('cancelled');
    expect(() => generator.createReport({ question: '新报告', page: 'overview' })).toThrow('REPORT_GENERATOR_DISPOSED');
    composer.resolve(slide(outline('page-1', 0)));
    await settleWithin(run, 'disposed active run');
    expect(registerSpeech).not.toHaveBeenCalled();
    expect(unregisterSpeech).not.toHaveBeenCalled();
    expect(publishSlide).not.toHaveBeenCalled();
  });
});
