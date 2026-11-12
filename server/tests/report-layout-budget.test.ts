import { describe, expect, it } from 'vitest';
import type { ReportEvidenceBundle } from '../src/domain/report-evidence';
import { paginateLargeScreenOutlines } from '../src/domain/report-layout-budget';

const metricKeys = [
  'processedM3',
  'informationCount',
  'complianceRate',
  'healthScore',
  'qualityScore',
  'flowScore',
  'energyScore',
  'carbonSourceScore',
  'tn',
  'ammonia',
];

type MetricFixture = {
  label?: string;
  unit?: string;
  values?: Array<number | undefined>;
};

function evidenceFor(
  keys: readonly string[],
  options: {
    scopeMetrics?: readonly string[];
    metricFixtures?: Record<string, MetricFixture>;
    assistantProfile?: ReportEvidenceBundle['assistantProfile'];
    userCorrections?: ReportEvidenceBundle['userCorrections'];
  } = {},
): ReportEvidenceBundle {
  const seriesLength = Math.max(
    2,
    ...keys.map((key) => options.metricFixtures?.[key]?.values?.length ?? 0),
  );
  return {
    snapshotId: 'layout-budget',
    analysis: {
      scope: {
        modules: ['overview', 'health', 'water-quality'],
        metrics: [...(options.scopeMetrics ?? keys)],
        dateRange: { from: '2026-08-01', to: '2026-08-02' },
        sampleCount: seriesLength,
        granularity: 'daily',
      },
      definitions: keys.map((key, index) => ({
        key,
        label: options.metricFixtures?.[key]?.label ?? `指标 ${index + 1}`,
        unit: options.metricFixtures?.[key]?.unit ?? '分',
      })),
      series: Array.from({ length: seriesLength }, (_, seriesIndex) => ({
        date: `2026-08-0${seriesIndex + 1}`,
        values: Object.fromEntries(
          keys.flatMap((key, keyIndex) => {
            const fixtureValues = options.metricFixtures?.[key]?.values;
            const value = fixtureValues && seriesIndex < fixtureValues.length
              ? fixtureValues[seriesIndex]
              : 80 + keyIndex + seriesIndex;
            return value === undefined ? [] : [[key, value]];
          }),
        ),
      })),
      aggregates: Object.fromEntries(keys.map((key, index) => {
        const values = (options.metricFixtures?.[key]?.values ?? [80 + index, 81 + index])
          .filter((value): value is number => Number.isFinite(value));
        const latest = values.at(-1) ?? 81 + index;
        const first = values[0] ?? latest;
        const min = Math.min(...values, latest);
        const max = Math.max(...values, latest);
        return [key, {
          min,
          max,
          average: values.reduce((sum, value) => sum + value, 0) / values.length,
          latest,
          changeRate: first === 0 ? null : (latest - first) / first,
        }];
      })),
      thresholdBreaches: [],
      correlations: [],
      alerts: [],
    },
    knowledge: [],
    assistantProfile: options.assistantProfile,
    userCorrections: options.userCorrections,
  } as unknown as ReportEvidenceBundle;
}

const evidence = evidenceFor(metricKeys);

const outline = {
  title: '完整指标解释',
  purpose: '解释全部指标',
  role: 'answer' as const,
  layout: 'visual-focus' as const,
  visualKind: 'kpi-grid' as const,
  evidenceKeys: metricKeys,
  evidencePolicy: 'data' as const,
};

describe('paginateLargeScreenOutlines', () => {
  it('backfills omitted analyzed metrics onto compatible metric-report pages before balancing', () => {
    const pages = paginateLargeScreenOutlines([
      { ...outline, evidenceKeys: metricKeys.slice(0, 4) },
    ], evidence);

    expect(pages.map(({ evidenceKeys }) => evidenceKeys)).toEqual([
      metricKeys.slice(0, 5),
      metricKeys.slice(5),
    ]);
    expect(pages.flatMap(({ evidenceKeys }) => evidenceKeys)).toEqual(metricKeys);
  });

  it('balances ten metrics across pages without dropping or duplicating keys', () => {
    const pages = paginateLargeScreenOutlines([outline], evidence);

    expect(pages.map(({ evidenceKeys }) => evidenceKeys)).toEqual([
      metricKeys.slice(0, 5),
      metricKeys.slice(5),
    ]);
    expect(pages.flatMap(({ evidenceKeys }) => evidenceKeys)).toEqual(metricKeys);
    expect(pages.map(({ title }) => title)).toEqual([
      '完整指标解释（1/2）',
      '完整指标解释（2/2）',
    ]);
  });

  it('does not treat four columns as a four-metric page limit', () => {
    const sixMetricKeys = metricKeys.slice(0, 6);
    const pages = paginateLargeScreenOutlines([
      { ...outline, evidenceKeys: sixMetricKeys },
    ], evidenceFor(sixMetricKeys));

    expect(pages).toHaveLength(1);
    expect(pages[0]!.evidenceKeys).toEqual(sixMetricKeys);
  });

  it('keeps minimum chart cardinality when balancing comparison and radar pages', () => {
    const comparisonKeys = metricKeys.slice(0, 9);
    const comparison = paginateLargeScreenOutlines([
      { ...outline, visualKind: 'comparison-bars', evidenceKeys: comparisonKeys },
    ], evidenceFor(comparisonKeys));
    expect(comparison.map(({ evidenceKeys }) => evidenceKeys.length)).toEqual([5, 4]);

    const radarKeys = metricKeys.slice(0, 8);
    const radar = paginateLargeScreenOutlines([
      { ...outline, visualKind: 'radar', evidenceKeys: radarKeys },
    ], evidenceFor(radarKeys));
    expect(radar.map(({ evidenceKeys }) => evidenceKeys.length)).toEqual([4, 4]);
  });

  it('rejects omitted analyzed metrics when no compatible metric-report page can represent them', () => {
    expect(() => paginateLargeScreenOutlines([
      { ...outline, visualKind: 'health-ring', evidenceKeys: ['healthScore'] },
    ], evidence)).toThrow('REPORT_OUTLINE_INVALID');
  });

  it('covers every scoped metric key even when the descriptor source is not excel', () => {
    const correctionKey = 'user-correction:processedM3';
    const pages = paginateLargeScreenOutlines([
      { ...outline, evidenceKeys: ['processedM3'] },
    ], evidenceFor(['processedM3'], {
      scopeMetrics: ['processedM3', correctionKey],
      userCorrections: [{
        key: correctionKey,
        evidenceKey: 'processedM3',
        value: 98,
        unit: 'm3',
        statement: '用户补录处理量',
        provenance: 'user-provided-unverified',
        sourceSlideId: 'slide-1',
        sourceEvidenceSnapshotId: 'layout-budget',
        createdAt: '2026-08-22T00:00:00.000Z',
      }],
    }));

    expect(pages).toHaveLength(1);
    expect(pages[0]!.evidenceKeys).toEqual(['processedM3', correctionKey]);
  });

  it('rejects scope metrics that do not resolve to metric evidence', () => {
    expect(() => paginateLargeScreenOutlines([
      { ...outline, evidenceKeys: ['processedM3'] },
    ], evidenceFor(['processedM3'], {
      scopeMetrics: ['processedM3', 'assistant-profile'],
      assistantProfile: {
        key: 'assistant-profile',
        assistantName: '智慧水务 AI 助手',
        capabilities: ['报告'],
        limitations: ['仅供参考'],
      },
    }))).toThrow('REPORT_OUTLINE_INVALID');
  });

  it('keeps the comparison-bars same-unit compatibility guard during coverage backfill', () => {
    expect(() => paginateLargeScreenOutlines([
      { ...outline, visualKind: 'comparison-bars', evidenceKeys: ['processedM3'] },
    ], evidenceFor(['processedM3', 'complianceRate'], {
      metricFixtures: {
        processedM3: { unit: 'm3' },
        complianceRate: { unit: '%' },
      },
    }))).toThrow('REPORT_OUTLINE_INVALID');
  });

  it('keeps the radar score-like compatibility guard during coverage backfill', () => {
    expect(() => paginateLargeScreenOutlines([
      { ...outline, visualKind: 'radar', evidenceKeys: ['healthScore'] },
    ], evidenceFor(['healthScore', 'processedM3'], {
      metricFixtures: {
        healthScore: { unit: '分' },
        processedM3: { unit: 'm3' },
      },
    }))).toThrow('REPORT_OUTLINE_INVALID');
  });

  it('keeps the trend minimum-points compatibility guard during coverage backfill', () => {
    expect(() => paginateLargeScreenOutlines([
      { ...outline, visualKind: 'trend-line', evidenceKeys: ['processedM3'] },
    ], evidenceFor(['processedM3', 'informationCount'], {
      metricFixtures: {
        processedM3: { values: [80, 81] },
        informationCount: { values: [42, undefined] },
      },
    }))).toThrow('REPORT_OUTLINE_INVALID');
  });
});
