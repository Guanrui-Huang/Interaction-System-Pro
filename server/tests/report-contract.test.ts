import { describe, expect, it } from 'vitest';
import {
  clarificationSubmissionSchema,
  conversationTurnSchema,
  createReportResponseSchema,
  reportEventSchema,
  reportJobSnapshotSchema,
  reportSlideSchema,
} from '../../shared/report-schema';

const base = {
  reportId: 'report-1', question: '分析', originPage: 'overview',
  scope: { modules: [], metrics: [], dateRange: { from: '1970-01-01', to: '1970-01-01' }, sampleCount: 0, granularity: 'daily' },
  conversation: { originalQuestion: '分析', turns: [], compactSummary: '' },
  createdAt: '2026-08-14T00:00:00.000Z', expiresAt: '2026-08-14T00:30:00.000Z', lastSequence: 0,
} as const;

function planned(id = 'page-1', order = 0, status: 'planned' | 'generating' | 'ready' | 'failed' = 'planned') {
  return {
    id, order, title: '第一页', purpose: '回答', role: 'answer', layout: 'concept-center', evidencePolicy: 'knowledge',
    visualKind: 'capability-map', evidenceKeys: ['knowledge:0'], status,
  } as const;
}

const metricRef = {
  key: 'tn',
  kind: 'metric',
  source: 'excel',
  snapshotId: 'evidence:data',
  module: 'water-quality',
  label: '总氮',
  unit: 'mg/L',
  dateRange: { from: '2026-08-01', to: '2026-08-02' },
  sampleCount: 2,
  claimIds: ['claim-1'],
  value: 2.4,
} as const;

function testMetric(key: string, label: string, unit: string, value: number) {
  return { ...metricRef, key, label, unit, value };
}

const trend = {
  kind: 'trend-area',
  series: [{
    key: 'tn',
    label: '总氮',
    unit: 'mg/L',
    snapshotId: 'evidence:data',
    claimIds: ['claim-1'],
    points: [
      { label: '2026-08-01', value: 2.2 },
      { label: '2026-08-02', value: 2.4 },
    ],
  }],
} as const;

function dataSlide(
  visual: unknown,
  metrics: readonly ReturnType<typeof testMetric>[] = [metricRef],
) {
  const evidenceRefs = metrics.map((metric) => ({
    key: metric.key,
    kind: metric.kind,
    source: metric.source,
    snapshotId: metric.snapshotId,
    module: metric.module,
    label: metric.label,
    unit: metric.unit,
    dateRange: metric.dateRange,
    sampleCount: metric.sampleCount,
  }));
  return {
    id: 'page-data',
    order: 0,
    evidenceSnapshotId: 'evidence:data',
    role: 'answer',
    layout: 'visual-focus',
    evidencePolicy: 'data',
    title: '总氮趋势',
    takeaway: '总氮最新值为 2.4 mg/L。',
    takeawayClaimIds: ['claim-1'],
    claims: [{
      id: 'claim-1',
      text: '总氮最新值为 2.4 mg/L。',
      kind: 'onsite-fact',
      evidenceRefs,
    }],
    visual,
    metrics,
    evidenceRefs,
    narration: [
      { id: 'segment-1', text: '先看总氮趋势。', speechId: 'speech-1', claimIds: ['claim-1'] },
      { id: 'segment-2', text: '最新值为 2.4 mg/L。', speechId: 'speech-2', claimIds: ['claim-1'] },
    ],
  };
}

function expectMalformedDataVisualRejected(
  visual: unknown,
  metrics: readonly ReturnType<typeof testMetric>[] = [metricRef],
) {
  expect(reportSlideSchema.safeParse(dataSlide(visual, metrics)).success).toBe(false);
  expect(reportSlideSchema.safeParse(dataSlide({
    kind: 'data-dashboard',
    summaryMetrics: [],
    primary: visual,
    supporting: [],
  }, metrics)).success).toBe(false);
}

describe('intent-first server contract', () => {
  it('accepts the exact empty create response and rejects bootstrap fields', () => {
    const response = {
      reportId: 'report-1',
      snapshot: { ...base, status: 'generating', phase: 'understanding', clarification: null, outline: [], slides: [] },
    };
    expect(createReportResponseSchema.safeParse(response).success).toBe(true);
    expect(createReportResponseSchema.safeParse({ ...response, bootstrapSlide: null }).success).toBe(false);
  });

  it('accepts cancelled snapshots before and after outline publication', () => {
    expect(reportJobSnapshotSchema.safeParse({
      ...base, status: 'cancelled', phase: null, clarification: null, outline: [], slides: [],
    }).success).toBe(true);
    expect(reportJobSnapshotSchema.safeParse({
      ...base, status: 'cancelled', phase: null, clarification: null, outline: [planned()], slides: [],
    }).success).toBe(true);
  });

  it('requires completed partial reports to have every page settled and at least one ready page', () => {
    expect(reportJobSnapshotSchema.safeParse({
      ...base, status: 'partial', phase: 'completed', clarification: null,
      outline: [planned('page-1', 0, 'failed'), planned('page-2', 1, 'generating')], slides: [],
    }).success).toBe(false);
  });

  it('requires strict clarification submissions', () => {
    expect(clarificationSubmissionSchema.safeParse({ clarificationId: 'clarification-1', answer: '近 30 日' }).success).toBe(true);
    expect(clarificationSubmissionSchema.safeParse({ clarificationId: 'clarification-1', answer: '', extra: true }).success).toBe(false);
  });

  it('requires positive sequences and standard page-generating order', () => {
    expect(reportEventSchema.safeParse({ type: 'slide.generating', sequence: 1, slideId: 'page-1', order: 0 }).success).toBe(true);
    expect(reportEventSchema.safeParse({ type: 'slide.generating', sequence: 0, slideId: 'page-1', order: 0 }).success).toBe(false);
    expect(reportEventSchema.safeParse({ type: 'report.cancelled', sequence: 2 }).success).toBe(true);
  });

  it('accepts a bounded evidence-linked data dashboard visual', () => {
    const visual = {
      kind: 'data-dashboard',
      summaryMetrics: [metricRef],
      primary: trend,
      supporting: [{ kind: 'health-ring', metric: metricRef, target: 3 }],
    } as const;
    expect(reportSlideSchema.safeParse(dataSlide(visual)).success).toBe(true);
  });

  it('rejects more than two supporting dashboard visuals', () => {
    const visual = {
      kind: 'data-dashboard',
      summaryMetrics: [metricRef],
      primary: trend,
      supporting: [
        { kind: 'health-ring', metric: metricRef },
        { kind: 'health-ring', metric: metricRef },
        { kind: 'health-ring', metric: metricRef },
      ],
    } as const;
    expect(reportSlideSchema.safeParse(dataSlide(visual)).success).toBe(false);
  });

  it('rejects atomic and composite trends with fewer than two finite points per series', () => {
    expectMalformedDataVisualRejected({
      kind: 'trend-area',
      series: [{ ...trend.series[0], points: [{ label: '2026-08-02', value: 2.4 }] }],
    });
  });

  it('rejects atomic and composite comparison bars with fewer than two items or mixed units', () => {
    expectMalformedDataVisualRejected({ kind: 'comparison-bars', items: [metricRef] });

    const flow = testMetric('flow', '处理量', 'm³/d', 2_300);
    expectMalformedDataVisualRejected({
      kind: 'comparison-bars',
      items: [metricRef, flow],
    }, [metricRef, flow]);
  });

  it('rejects atomic and composite health rings with invalid metric or target ranges', () => {
    const negativeMetric = { ...metricRef, value: -0.1 };
    expectMalformedDataVisualRejected({ kind: 'health-ring', metric: negativeMetric, target: 3 }, [negativeMetric]);
    expectMalformedDataVisualRejected({ kind: 'health-ring', metric: metricRef, target: -1 });
  });

  it('rejects atomic and composite radar charts with insufficient axes or non-positive maxima', () => {
    const scoreMetrics = [
      testMetric('stability', '稳定性', '分', 92),
      testMetric('efficiency', '能效', '分', 81),
      testMetric('quality', '水质', '分', 95),
    ];
    const axes = scoreMetrics.map((metric) => ({
      key: metric.key,
      label: metric.label,
      value: metric.value,
      maximum: 100,
      unit: metric.unit,
      snapshotId: metric.snapshotId,
      claimIds: metric.claimIds,
    }));

    expectMalformedDataVisualRejected({ kind: 'radar', axes: axes.slice(0, 2) }, scoreMetrics.slice(0, 2));
    expectMalformedDataVisualRejected({
      kind: 'radar',
      axes: axes.map((axis, index) => index === 2 ? { ...axis, maximum: 0 } : axis),
    }, scoreMetrics);
  });

  it('accepts a real nonnegative thinking duration and rejects negative values', () => {
    const turn = {
      id: 'turn-1',
      question: '为什么？',
      answer: '因为负荷变化。',
      citedEvidence: [],
      needsClarification: false,
      createdAt: '2026-08-22T00:00:00.000Z',
      thinkingDurationMs: 1_250,
    };
    expect(conversationTurnSchema.safeParse(turn).success).toBe(true);
    expect(conversationTurnSchema.safeParse({ ...turn, thinkingDurationMs: -1 }).success).toBe(false);
  });
});
