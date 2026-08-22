import { describe, expect, it } from 'vitest';
import {
  HEALTH_GRADE_THRESHOLDS,
  HEALTH_WEIGHTS,
  WATER_QUALITY_METRICS,
  type AlertRecord,
  type BusinessPage,
  type DailyReading,
  type DashboardDataset,
} from '../../shared/dashboard';
import { calculateReadingHealth } from '../../shared/health';
import { buildAiContext } from '../src/domain/ai-context';

function isoDay(index: number): string {
  return new Date(Date.UTC(2026, 5, index + 1)).toISOString().slice(0, 10);
}

function reading(index: number): DailyReading {
  return {
    date: isoDay(index),
    processedM3: 18_000 + index * 100,
    informationCount: 1_200 + index,
    complianceRate: 98 + index * 0.02,
    tn: 4 + index * 0.1,
    ammonia: 0.4 + index * 0.01,
    tp: 0.2 + index * 0.005,
    cod: 20 + index * 0.2,
    ss: 4 + index * 0.05,
    totalKwh: 7_000 + index * 20,
    kwhPerM3: 0.5 - index * 0.002,
    blowerKwh: 2_500 + index * 10,
    carbonEmissionKg: 520 - index,
    carbonReductionKg: 50 + index,
    savedYuan: 3_000 + index * 25,
    qualityScore: 82 + index * 0.2,
    flowScore: 84 + index * 0.15,
    energyScore: 80 + index * 0.25,
    carbonSourceKg: 360 - index,
    carbonSourceScore: 83 + index * 0.18,
  };
}

function alerts(): AlertRecord[] {
  const water = Array.from({ length: 12 }, (_, index): AlertRecord => ({
    date: isoDay(16 + index),
    metric: index % 2 ? '总氮（TN）' : 'COD',
    level: '关注',
    reason: `水质波动 ${index}`,
    recommendation: '复核曝气与进水负荷',
  }));
  const energy = Array.from({ length: 12 }, (_, index): AlertRecord => ({
    date: isoDay(16 + index),
    metric: index % 2 ? '吨水电耗' : '碳源投加',
    level: '提示',
    reason: `能耗波动 ${index}`,
    recommendation: '复核运行策略',
  }));
  return [...water, ...energy];
}

function deliberatelyShuffled<T>(items: readonly T[]): T[] {
  return items.map((_, index) => items[(index * 17) % items.length]);
}

const daily = Array.from({ length: 40 }, (_, index) => reading(index));
const dataset: DashboardDataset = {
  plantName: '智慧污水处理厂',
  daily,
  alerts: alerts(),
  health: { weights: HEALTH_WEIGHTS, ...calculateReadingHealth(daily.at(-1)!) },
};

const expectedSeriesKeys: Record<BusinessPage, string[]> = {
  overview: ['processedM3', 'complianceRate', 'healthScore', 'qualityScore', 'flowScore', 'energyScore', 'carbonSourceScore'],
  health: ['healthScore', 'qualityScore', 'flowScore', 'energyScore', 'carbonSourceScore'],
  'water-quality': ['tn', 'ammonia', 'tp', 'cod', 'ss'],
  energy: ['totalKwh', 'kwhPerM3', 'blowerKwh', 'savedYuan', 'carbonSourceKg', 'carbonEmissionKg', 'carbonReductionKg'],
};

describe('buildAiContext', () => {
  it.each(Object.entries(expectedSeriesKeys) as Array<[BusinessPage, string[]]>)('builds bounded and page-specific evidence for %s', (page, expectedKeys) => {
    const context = buildAiContext({ page, dataset });

    expect(context.page).toBe(page);
    expect(context.sourcePageName).toBeTruthy();
    expect(context.evidenceInstruction).toContain('仅使用所提供的演示证据');
    expect(context.recentSeries).toHaveLength(30);
    expect(context.recentSeries[0].date).toBe(daily[10].date);
    expect(context.recentSeries.at(-1)?.date).toBe(daily.at(-1)?.date);
    expect(Object.keys(context.recentSeries[0].values)).toEqual(expectedKeys);
    expect(Object.keys(context.aggregates)).toEqual(expectedKeys);
    expect(context.alerts.length).toBeLessThanOrEqual(10);
  });

  it('includes water units, compliance limits, aggregates and only recent water alerts', () => {
    const context = buildAiContext({ page: 'water-quality', dataset });
    const tn = context.metrics.find((metric) => metric.key === 'tn');

    expect(WATER_QUALITY_METRICS.tn.threshold).toBe(3);
    expect(tn).toMatchObject({
      label: WATER_QUALITY_METRICS.tn.label,
      unit: WATER_QUALITY_METRICS.tn.unit,
      limit: WATER_QUALITY_METRICS.tn.threshold,
      latest: daily.at(-1)?.tn,
    });
    expect(context.aggregates.tn).toEqual({
      min: daily[10].tn,
      max: daily.at(-1)?.tn,
      average: 6.45,
      latest: daily.at(-1)?.tn,
    });
    expect(context.alerts).toHaveLength(10);
    expect(context.alerts.every((alert) => ['总氮（TN）', 'COD'].includes(alert.metric))).toBe(true);
    expect(context.alerts.at(-1)?.reason).toBe('水质波动 11');
  });

  it('includes health weights, grade thresholds and a calculated 30-day score trend', () => {
    const context = buildAiContext({ page: 'health', dataset });

    expect(context.health).toEqual({
      weights: HEALTH_WEIGHTS,
      gradeThresholds: HEALTH_GRADE_THRESHOLDS,
      score: calculateReadingHealth(daily.at(-1)!).score,
      grade: calculateReadingHealth(daily.at(-1)!).grade,
    });
    expect(context.recentSeries.at(-1)?.values.healthScore).toBe(calculateReadingHealth(daily.at(-1)!).score);
    expect(context.metrics.find((metric) => metric.key === 'qualityScore')).toMatchObject({ label: '出水水质得分', unit: '分' });
  });

  it('includes energy dosage, emissions, reductions and excludes water alerts', () => {
    const context = buildAiContext({ page: 'energy', dataset });

    expect(context.metrics.find((metric) => metric.key === 'carbonSourceKg')).toMatchObject({ label: '碳源投加', unit: 'kg/d' });
    expect(context.metrics.find((metric) => metric.key === 'carbonEmissionKg')).toMatchObject({ label: '碳排放量', unit: 'kgCO₂e/d' });
    expect(context.metrics.find((metric) => metric.key === 'carbonReductionKg')).toMatchObject({ label: '碳减排量', unit: 'kgCO₂e/d' });
    expect(context.alerts).toHaveLength(10);
    expect(context.alerts.every((alert) => ['吨水电耗', '碳源投加'].includes(alert.metric))).toBe(true);
  });

  it('sorts shuffled daily readings before selecting the latest 30-day window without mutating the input', () => {
    const shuffledDaily = deliberatelyShuffled(daily);
    const inputOrder = [...shuffledDaily];
    const context = buildAiContext({
      page: 'water-quality',
      dataset: { ...dataset, daily: shuffledDaily },
    });

    expect(context.recentSeries.map((point) => point.date)).toEqual(daily.slice(-30).map((point) => point.date));
    expect(context.aggregates.tn).toEqual({
      min: daily[10].tn,
      max: daily.at(-1)?.tn,
      average: 6.45,
      latest: daily.at(-1)?.tn,
    });
    expect(context.metrics.find((metric) => metric.key === 'tn')?.latest).toBe(daily.at(-1)?.tn);
    expect(shuffledDaily).toEqual(inputOrder);
  });

  it('sorts shuffled relevant alerts before selecting the latest ten without mutating the input', () => {
    const allAlerts = alerts();
    const shuffledAlerts = deliberatelyShuffled(allAlerts);
    const inputOrder = [...shuffledAlerts];
    const expectedWaterAlerts = allAlerts
      .filter((alert) => ['总氮（TN）', 'COD'].includes(alert.metric))
      .slice(-10);
    const context = buildAiContext({
      page: 'water-quality',
      dataset: { ...dataset, alerts: shuffledAlerts },
    });

    expect(context.alerts).toEqual(expectedWaterAlerts);
    expect(context.alerts.map((alert) => alert.date)).toEqual([...context.alerts.map((alert) => alert.date)].sort());
    expect(shuffledAlerts).toEqual(inputOrder);
  });
});
