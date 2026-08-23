import { describe, expect, it } from 'vitest';
import {
  barThemeForMetric,
  chartThemesForMetrics,
  CHART_THEME,
  type BarTheme,
  type BarThemeFamily,
} from '../charts/chart-theme';

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

  it('keeps bar theme family narrowed to palette families plus typed overflow suffixes', () => {
    const baseFamily: BarTheme['family'] = 'water';
    const overflowFamily: BarTheme['family'] = 'water-2';

    expect(baseFamily).toBe('water');
    expect(overflowFamily).toBe('water-2');

    // @ts-expect-error invalid family names must not widen back to string
    const invalidFamily: BarTheme['family'] = 'made-up';
    void invalidFamily;
  });

  it.each([9, 16])('keeps every distinct metric gradient unique across %i identities', (count) => {
    const metrics = Array.from({ length: count }, (_, index) => ({
      key: `metric-${index + 1}`,
      label: `指标 ${index + 1}`,
    }));

    const themes = chartThemesForMetrics(metrics);
    const families = metrics.map(({ key }) => themes.get(key)?.family);
    const gradientPairs = metrics.map(({ key }) => {
      const theme = themes.get(key);
      return `${theme?.start}->${theme?.end}`;
    });

    expect(families.slice(0, CHART_THEME.bars.length)).toEqual(
      CHART_THEME.bars.map(({ family }) => family),
    );
    expect(new Set(families).size).toBe(metrics.length);
    expect(new Set(gradientPairs).size).toBe(metrics.length);
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
