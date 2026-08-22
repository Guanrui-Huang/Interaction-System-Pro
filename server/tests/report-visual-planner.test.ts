import { describe, expect, it } from 'vitest';
import { planDataDashboardVisual, type VisualEvidenceCandidate } from '../src/domain/report-visual-planner';

const metric = (key: string, unit: string, pointCount = 30, scoreLike = false): VisualEvidenceCandidate => ({
  key, kind: 'metric', unit, pointCount, pairedSampleCount: pointCount, scoreLike,
});

describe('planDataDashboardVisual', () => {
  it('uses a trend primary and a latest-value comparison for compatible series', () => {
    expect(planDataDashboardVisual('kpi-grid', [metric('tn', 'mg/L'), metric('ammonia', 'mg/L')]))
      .toEqual({
        summaryKeys: ['tn', 'ammonia'],
        primary: { kind: 'trend-area', evidenceKeys: ['tn', 'ammonia'] },
        supporting: [{ kind: 'comparison-bars', evidenceKeys: ['tn', 'ammonia'] }],
      });
  });

  it('adds a score ring without exceeding two supporting charts', () => {
    const result = planDataDashboardVisual('trend-line', [
      metric('tn', 'mg/L'), metric('ammonia', 'mg/L'), metric('healthScore', '分', 30, true),
    ]);
    expect(result?.primary.kind).toBe('trend-line');
    expect(result?.supporting.map(({ kind }) => kind)).toEqual(['comparison-bars', 'health-ring']);
    expect(result?.supporting).toHaveLength(2);
  });

  it('returns null when no evidence can form a chart', () => {
    expect(planDataDashboardVisual('kpi-grid', [metric('single', 'mg/L', 1)])).toBeNull();
  });

  it('never combines incompatible units in comparison bars', () => {
    const result = planDataDashboardVisual('kpi-grid', [metric('flow', 'm³/d'), metric('energy', 'kWh/d')]);
    expect(result?.supporting.some(({ kind }) => kind === 'comparison-bars')).toBe(false);
  });

  it('ignores candidates with non-finite counts at the planner boundary', () => {
    expect(planDataDashboardVisual('kpi-grid', [
      metric('valid', 'mg/L', 2),
      { key: 'nan-points', kind: 'metric', unit: 'mg/L', pointCount: Number.NaN, pairedSampleCount: 4, scoreLike: false },
      {
        key: 'infinite-pairs',
        kind: 'metric',
        unit: 'mg/L',
        pointCount: 2,
        pairedSampleCount: Number.POSITIVE_INFINITY,
        scoreLike: false,
      },
    ])).toEqual({
      summaryKeys: ['valid'],
      primary: { kind: 'trend-area', evidenceKeys: ['valid'] },
      supporting: [],
    });
  });
});
