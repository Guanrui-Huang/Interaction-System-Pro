import { describe, expect, it } from 'vitest';
import { barThemeForMetric, CHART_THEME } from '../charts/chart-theme';

describe('report bar themes', () => {
  it('provides seven distinct gradients', () => {
    expect(CHART_THEME.bars).toHaveLength(7);
    expect(new Set(CHART_THEME.bars.map(({ family }) => family)).size).toBe(7);
    expect(new Set(CHART_THEME.bars.flatMap(({ start, end }) => [start, end])).size).toBe(14);
  });

  it('maps the common seven metrics to stable distinct families', () => {
    const metrics = [
      ['qualityScore', '出水水质得分'], ['energyScore', '电耗得分'], ['tn', '总氮（TN）'],
      ['ammonia', '氨氮'], ['tp', '总磷'], ['cod', 'COD'], ['ss', '悬浮物'],
    ] as const;
    const themes = metrics.map(([key, label]) => barThemeForMetric(key, label).family);

    expect(new Set(themes).size).toBe(7);
    expect(metrics.map(([key, label]) => barThemeForMetric(key, label).family)).toEqual(themes);
  });
});
