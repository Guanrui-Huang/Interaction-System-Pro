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

const evidence = {
  snapshotId: 'layout-budget',
  analysis: {
    scope: {
      modules: ['overview', 'health', 'water-quality'],
      metrics: metricKeys,
      dateRange: { from: '2026-08-01', to: '2026-08-02' },
      sampleCount: 2,
      granularity: 'daily',
    },
    definitions: metricKeys.map((key, index) => ({
      key,
      label: `指标 ${index + 1}`,
      unit: '分',
    })),
    series: [
      { date: '2026-08-01', values: Object.fromEntries(metricKeys.map((key, index) => [key, 80 + index])) },
      { date: '2026-08-02', values: Object.fromEntries(metricKeys.map((key, index) => [key, 81 + index])) },
    ],
    aggregates: Object.fromEntries(metricKeys.map((key, index) => [key, {
      min: 80 + index,
      max: 81 + index,
      average: 80.5 + index,
      latest: 81 + index,
      changeRate: 1 / (80 + index),
    }])),
    thresholdBreaches: [],
    correlations: [],
    alerts: [],
  },
  knowledge: [],
} as unknown as ReportEvidenceBundle;

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
    const pages = paginateLargeScreenOutlines([
      { ...outline, evidenceKeys: metricKeys.slice(0, 6) },
    ], evidence);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.evidenceKeys).toEqual(metricKeys.slice(0, 6));
  });

  it('keeps minimum chart cardinality when balancing comparison and radar pages', () => {
    const comparison = paginateLargeScreenOutlines([
      { ...outline, visualKind: 'comparison-bars', evidenceKeys: metricKeys.slice(0, 9) },
    ], evidence);
    expect(comparison.map(({ evidenceKeys }) => evidenceKeys.length)).toEqual([5, 4]);

    const radar = paginateLargeScreenOutlines([
      { ...outline, visualKind: 'radar', evidenceKeys: metricKeys.slice(0, 7) },
    ], evidence);
    expect(radar.map(({ evidenceKeys }) => evidenceKeys.length)).toEqual([4, 3]);
  });
});
