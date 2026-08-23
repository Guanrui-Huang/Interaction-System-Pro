import { describe, expect, it } from 'vitest';
import { barThemeForMetric, chartThemesForMetrics, CHART_THEME } from '../charts/chart-theme';

describe('report bar themes', () => {
  it('provides eight distinct report gradients', () => {
    expect(CHART_THEME.bars).toHaveLength(8);
    expect(new Set(CHART_THEME.bars.map(({ family }) => family)).size).toBe(8);
    expect(new Set(CHART_THEME.bars.flatMap(({ start, end }) => [start, end])).size).toBe(16);
  });

  it('allocates stable unique themes in first-seen order', () => {
    const themes = chartThemesForMetrics([
      { key: 'quality', label: '出水水质得分' },
      { key: 'energy', label: '电耗得分' },
      { key: 'carbonEmission', label: '碳排放量' },
      { key: 'carbonReduction', label: '碳减排量' },
      { key: 'quality', label: '出水水质得分' },
    ]);

    expect(themes.get('quality')?.family).toBe('water');
    expect(themes.get('energy')?.family).toBe('treatment');
    expect(themes.get('carbonEmission')?.family)
      .not.toBe(themes.get('carbonReduction')?.family);
    expect(themes.get('quality')).toEqual(CHART_THEME.bars[0]);
  });

  it('keeps every distinct metric unique after the eighth palette entry', () => {
    const metrics = [
      { key: 'metric-1', label: '指标 1' },
      { key: 'metric-2', label: '指标 2' },
      { key: 'metric-3', label: '指标 3' },
      { key: 'metric-4', label: '指标 4' },
      { key: 'metric-5', label: '指标 5' },
      { key: 'metric-6', label: '指标 6' },
      { key: 'metric-7', label: '指标 7' },
      { key: 'metric-8', label: '指标 8' },
      { key: 'metric-9', label: '指标 9' },
    ] as const;

    const themes = chartThemesForMetrics(metrics);
    const families = metrics.map(({ key }) => themes.get(key)?.family);

    expect(families.slice(0, CHART_THEME.bars.length)).toEqual(
      CHART_THEME.bars.map(({ family }) => family),
    );
    expect(new Set(families).size).toBe(metrics.length);
    expect(families[8]).not.toBe(families[0]);
    expect(themes.get('metric-9')).toEqual(chartThemesForMetrics(metrics).get('metric-9'));
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
