import { describe, expect, it } from 'vitest';
import { HEALTH_WEIGHTS, type AlertRecord, type DailyReading, type DashboardDataset } from '../../shared/dashboard';
import { calculateReadingHealth } from '../../shared/health';
import {
  AnalysisEvidenceError,
  buildAnalysisEvidence,
  redactAnalysisText,
} from '../src/domain/analysis-evidence';
import { parseAnalysisPlan, type AnalysisPlan } from '../src/domain/analysis-plan';

const DAY_MS = 24 * 60 * 60 * 1_000;

function dateAt(start: string, index: number): string {
  return new Date(Date.parse(`${start}T00:00:00.000Z`) + index * DAY_MS).toISOString().slice(0, 10);
}

function reading(date: string, index: number): DailyReading {
  return {
    date,
    processedM3: 18_000 + index * 100,
    informationCount: 1_200 + index,
    complianceRate: 98 + index * 0.01,
    tn: 2 + index * 0.01,
    ammonia: 0.4 + index * 0.001,
    tp: 0.2 + index * 0.001,
    cod: 20 + index * 0.1,
    ss: 4 + index * 0.01,
    totalKwh: 7_000 + index * 20,
    kwhPerM3: 0.4 + index * 0.001,
    blowerKwh: 2_500 + index * 10,
    carbonEmissionKg: 520 - index,
    carbonReductionKg: 50 + index,
    savedYuan: 3_000 + index * 25,
    qualityScore: 82 + index * 0.02,
    flowScore: 84 + index * 0.015,
    energyScore: 80 + index * 0.025,
    carbonSourceKg: 360 - index,
    carbonSourceScore: 83 + index * 0.018,
  };
}

function datasetOf(
  count: number,
  options: {
    start?: string;
    alerts?: AlertRecord[];
    update?: (row: DailyReading, index: number) => DailyReading;
  } = {},
): DashboardDataset {
  const start = options.start ?? '2026-01-20';
  const daily = Array.from({ length: count }, (_, index) => {
    const row = reading(dateAt(start, index), index);
    return options.update?.(row, index) ?? row;
  });
  return {
    plantName: '智慧污水处理厂',
    daily,
    alerts: options.alerts ?? [],
    health: { weights: HEALTH_WEIGHTS, ...calculateReadingHealth(daily.at(-1)!) },
  };
}

function planFor(dataset: DashboardDataset, overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
  const dates = dataset.daily.map(({ date }) => date).sort((left, right) => left.localeCompare(right));
  return {
    modules: ['water-quality', 'energy'],
    metrics: ['tn', 'kwhPerM3'],
    dateRange: { from: dates[0]!, to: dates.at(-1)! },
    methods: ['trend', 'summary'],
    includeAlerts: true,
    includeHealthWeights: false,
    ...overrides,
  };
}

function containsOnlyFiniteNumbers(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(containsOnlyFiniteNumbers);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).every(containsOnlyFiniteNumbers);
  }
  return true;
}

function expectFiniteJsonEvidence(evidence: unknown): void {
  expect(containsOnlyFiniteNumbers(evidence)).toBe(true);
  expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
}

function isDeepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return true;
  }
  seen.add(value);
  return Object.isFrozen(value)
    && Object.values(value).every((nested) => isDeepFrozen(nested, seen));
}

describe('buildAnalysisEvidence', () => {
  it('does not mistake compact measurement changes for file paths while still redacting real secrets', () => {
    const measurement = '吨水电耗从0.45 kWh/m³降至0.43 kWh/m³。';

    expect(redactAnalysisText(measurement)).toBe(measurement);
    expect(redactAnalysisText('读取 /private/plant.xlsx；DEEPSEEK_API_KEY=secret'))
      .not.toContain('/private/plant.xlsx');
    expect(redactAnalysisText('读取 /private/plant.xlsx；DEEPSEEK_API_KEY=secret'))
      .not.toContain('secret');
  });

  it('aligns requested cross-module metrics to an inclusive range without mutating the dataset', () => {
    const ordered = datasetOf(200);
    const shuffledDaily = [...ordered.daily].reverse();
    const shuffledAlerts = [...ordered.alerts].reverse();
    const dataset = { ...ordered, daily: shuffledDaily, alerts: shuffledAlerts };
    const plan = planFor(dataset, {
      dateRange: { from: '2026-07-20', to: '2026-07-31' },
      includeHealthWeights: true,
    });

    const evidence = buildAnalysisEvidence({ plan, dataset });

    expect(evidence.scope).toEqual({
      modules: ['health', 'water-quality', 'energy', 'alerts'],
      metrics: ['tn', 'kwhPerM3'],
      dateRange: { from: '2026-07-20', to: '2026-07-31' },
      sampleCount: 12,
      granularity: 'daily',
    });
    expect(evidence.definitions).toEqual([
      { key: 'tn', label: '总氮（TN）', unit: 'mg/L', limit: 3 },
      { key: 'kwhPerM3', label: '吨水电耗', unit: 'kWh/m³' },
    ]);
    expect(evidence.series).toHaveLength(12);
    expect(evidence.series[0]).toEqual({
      date: '2026-07-20',
      values: expect.objectContaining({ tn: expect.any(Number), kwhPerM3: expect.any(Number) }),
    });
    expect(evidence.series.at(-1)?.date).toBe('2026-07-31');
    expect(evidence.healthWeights).toEqual(HEALTH_WEIGHTS);
    expect(evidence.healthWeights).not.toBe(HEALTH_WEIGHTS);
    expect(shuffledDaily).toEqual([...ordered.daily].reverse());
    expect(shuffledAlerts).toEqual([...ordered.alerts].reverse());
  });

  it('returns an independent deeply frozen snapshot of selected alerts and health weights', () => {
    const alert: AlertRecord = {
      date: '2026-01-20',
      metric: '总氮（TN）',
      level: '关注',
      reason: '总氮波动需复核',
      recommendation: '检查进水负荷与加药记录',
    };
    const dataset = datasetOf(3, { alerts: [alert] });
    const plan = planFor(dataset, {
      modules: ['water-quality'],
      metrics: ['tn'],
      includeHealthWeights: true,
    });

    const evidence = buildAnalysisEvidence({ plan, dataset });
    const serialized = JSON.stringify(evidence);

    expect(evidence.alerts).toEqual([alert]);
    expect(evidence.alerts[0]).not.toBe(alert);
    expect(evidence.healthWeights).toEqual(HEALTH_WEIGHTS);
    expect(evidence.healthWeights).not.toBe(HEALTH_WEIGHTS);
    expect(isDeepFrozen(evidence)).toBe(true);

    alert.reason = '数据集随后被修改';
    dataset.alerts[0]!.recommendation = '数据集建议随后被修改';
    expect(JSON.stringify(evidence)).toBe(serialized);

    expect(() => {
      evidence.alerts[0]!.reason = '调用方尝试修改快照';
    }).toThrow(TypeError);
    expect(() => {
      evidence.scope.metrics.push('ammonia');
    }).toThrow(TypeError);
    expect(JSON.stringify(evidence)).toBe(serialized);
  });

  it('derives rounded raw aggregates and returns a null change rate when the starting value is zero', () => {
    const tnValues = [0, 2, 4, 6];
    const energyValues = [1, 2, 3, 4];
    const dataset = datasetOf(4, {
      update: (row, index) => ({ ...row, tn: tnValues[index]!, kwhPerM3: energyValues[index]! }),
    });

    const evidence = buildAnalysisEvidence({ plan: planFor(dataset), dataset });

    expect(evidence.aggregates.tn).toEqual({ min: 0, max: 6, average: 3, latest: 6, changeRate: null });
    expect(evidence.aggregates.kwhPerM3).toEqual({ min: 1, max: 4, average: 2.5, latest: 4, changeRate: 3 });
  });

  it('keeps aggregate means and mixed-sign change rates finite near Number.MAX_VALUE', () => {
    const values = [1e308, 1e308, -1e308, -1e308];
    const dataset = datasetOf(values.length, {
      update: (row, index) => ({ ...row, tn: values[index]! }),
    });
    const plan = planFor(dataset, { modules: ['water-quality'], metrics: ['tn'] });

    const evidence = buildAnalysisEvidence({ plan, dataset });

    expect(evidence.aggregates.tn).toEqual({
      min: -1e308,
      max: 1e308,
      average: 0,
      latest: -1e308,
      changeRate: -2,
    });
    expectFiniteJsonEvidence(evidence);
  });

  it('canonicalizes every rounded negative zero to positive zero', () => {
    const dataset = datasetOf(3, {
      update: (row) => ({ ...row, tn: -0.000001 }),
    });
    const plan = planFor(dataset, {
      modules: ['water-quality'],
      metrics: ['tn'],
      includeAlerts: false,
    });

    const evidence = buildAnalysisEvidence({ plan, dataset });
    const numericValues = [
      ...evidence.series.map(({ values }) => values.tn),
      ...Object.values(evidence.aggregates.tn ?? {}),
    ].filter((value): value is number => typeof value === 'number');

    expect(evidence.series.every(({ values }) => values.tn === 0)).toBe(true);
    expect(numericValues.some((value) => Object.is(value, -0))).toBe(false);
  });

  it.each([
    [90, 'daily'],
    [91, 'weekly'],
    [180, 'weekly'],
    [181, 'monthly'],
  ] as const)('uses raw aligned count %i to select %s granularity', (count, granularity) => {
    const dataset = datasetOf(count, { start: '2025-12-29' });

    const evidence = buildAnalysisEvidence({ plan: planFor(dataset), dataset });

    expect(evidence.scope.sampleCount).toBe(count);
    expect(evidence.scope.granularity).toBe(granularity);
    if (granularity === 'daily') {
      expect(evidence.series).toHaveLength(count);
    } else {
      expect(evidence.series.length).toBeLessThan(count);
    }
  });

  it('uses ISO week-year labels and rounded arithmetic means for weekly buckets', () => {
    const dataset = datasetOf(91, {
      start: '2025-12-29',
      update: (row, index) => ({ ...row, tn: index + 1 / 3 }),
    });
    const plan = planFor(dataset, { modules: ['water-quality'], metrics: ['tn'] });

    const evidence = buildAnalysisEvidence({ plan, dataset });

    expect(evidence.series[0]).toEqual({ date: '2026-W01', values: { tn: 3.3333 } });
    expect(evidence.series[1]).toEqual({ date: '2026-W02', values: { tn: 10.3333 } });
  });

  it('uses setUTCFullYear semantics for validated ISO week dates in year 0099', () => {
    const dataset = datasetOf(91, { start: '0099-01-01' });
    const plan = planFor(dataset, { modules: ['water-quality'], metrics: ['tn'] });
    const validatedPlan = parseAnalysisPlan(JSON.stringify(plan), dataset);

    const evidence = buildAnalysisEvidence({ plan: validatedPlan, dataset });

    expect(evidence.series[0]?.date).toBe('0099-W01');
  });

  it('rejects year 0000 before a weekly label can be produced', () => {
    const dataset = datasetOf(91, { start: '2026-01-01' });
    dataset.daily[0] = { ...dataset.daily[0]!, date: '0000-01-01' };
    const plan = planFor(dataset, {
      modules: ['water-quality'],
      metrics: ['tn'],
      dateRange: { from: '0000-01-01', to: dataset.daily.at(-1)!.date },
      includeAlerts: false,
    });

    expect(() => parseAnalysisPlan(JSON.stringify(plan), dataset)).toThrow('ANALYSIS_PLAN_INVALID');
    expect(() => buildAnalysisEvidence({ plan, dataset })).toThrow('INVALID_DATA');
  });

  it('rejects malformed in-memory row dates before aggregation', () => {
    const dataset = datasetOf(91, { start: '2026-01-01' });
    const plan = planFor(dataset, {
      modules: ['water-quality'],
      metrics: ['tn'],
      includeAlerts: false,
    });
    dataset.daily[45] = { ...dataset.daily[45]!, date: 'not-an-iso-date' };

    let thrown: unknown;
    try {
      buildAnalysisEvidence({ plan, dataset });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AnalysisEvidenceError);
    expect(thrown).toMatchObject({
      name: 'AnalysisEvidenceError',
      code: 'INVALID_DATA',
      message: 'INVALID_DATA',
    });
  });

  it('uses YYYY-MM labels and rounded arithmetic means for monthly buckets', () => {
    const dataset = datasetOf(181, {
      start: '2026-01-01',
      update: (row, index) => ({ ...row, tn: index + 1 / 3 }),
    });
    const plan = planFor(dataset, { modules: ['water-quality'], metrics: ['tn'] });

    const evidence = buildAnalysisEvidence({ plan, dataset });

    expect(evidence.series[0]).toEqual({ date: '2026-01', values: { tn: 15.3333 } });
    expect(evidence.series.at(-1)?.date).toBe('2026-06');
  });

  it.each([
    { count: 91, start: '2026-01-05', firstBucketSize: 7, expectedLabel: '2026-W02' },
    { count: 181, start: '2026-01-01', firstBucketSize: 31, expectedLabel: '2026-01' },
  ])('keeps $expectedLabel mixed-sign bucket means finite near Number.MAX_VALUE', ({
    count,
    start,
    firstBucketSize,
    expectedLabel,
  }) => {
    const mixed = [1e308, 1e308, -1e308, -1e308];
    const dataset = datasetOf(count, {
      start,
      update: (row, index) => ({
        ...row,
        tn: index < firstBucketSize ? (mixed[index] ?? 0) : 1e308,
      }),
    });
    const plan = planFor(dataset, { modules: ['water-quality'], metrics: ['tn'] });

    const evidence = buildAnalysisEvidence({ plan, dataset });

    expect(evidence.series[0]).toEqual({ date: expectedLabel, values: { tn: 0 } });
    expectFiniteJsonEvidence(evidence);
  });

  it('retains raw breach and relevant alert dates while weekly series is aggregated', () => {
    const start = '2026-01-01';
    const alerts: AlertRecord[] = [
      { date: dateAt(start, 4), metric: '总氮（TN）', level: '关注', reason: '水质波动', recommendation: '复核水质' },
      { date: dateAt(start, 5), metric: '吨水电耗', level: '提示', reason: '能耗波动', recommendation: '复核能耗' },
      { date: dateAt(start, 6), metric: '未知指标', level: '提示', reason: '其他波动', recommendation: '复核记录' },
      { date: '2025-12-31', metric: '总氮（TN）', level: '关注', reason: '范围外', recommendation: '不应暴露' },
    ];
    const dataset = datasetOf(91, {
      start,
      alerts,
      update: (row, index) => ({ ...row, tn: index === 4 ? 4.123456 : index === 90 ? 4.5 : 2 }),
    });
    const plan = planFor(dataset, { modules: ['water-quality'], metrics: ['tn'] });

    const evidence = buildAnalysisEvidence({ plan, dataset });

    expect(evidence.scope.granularity).toBe('weekly');
    expect(evidence.thresholdBreaches).toEqual([
      { date: dateAt(start, 4), metric: 'tn', value: 4.1235, limit: 3 },
      { date: dateAt(start, 90), metric: 'tn', value: 4.5, limit: 3 },
    ]);
    expect(evidence.alerts).toEqual(alerts.slice(0, 3));
    expect(evidence.alerts[0]?.date).toBe(dateAt(start, 4));

    const allInRangeAlerts = buildAnalysisEvidence({
      plan: { ...plan, modules: ['water-quality', 'alerts'] },
      dataset,
    });
    expect(allInRangeAlerts.alerts).toEqual(alerts.slice(0, 3));
    expect(allInRangeAlerts.alerts).not.toContainEqual(alerts[3]);

    const alertsDisabled = buildAnalysisEvidence({
      plan: { ...plan, includeAlerts: false },
      dataset,
    });
    expect(alertsDisabled.alerts).toEqual([]);
  });

  it('includes every in-range alert when the supplemental alerts module is selected', () => {
    const start = '2026-02-01';
    const alerts: AlertRecord[] = [
      { date: dateAt(start, 0), metric: 'TN', level: '关注', reason: '范围前', recommendation: '不应暴露' },
      { date: dateAt(start, 1), metric: 'MASS FLOW', level: '提示', reason: '别名碰撞', recommendation: '不应泄漏' },
      { date: dateAt(start, 2), metric: ' ss ', level: '关注', reason: '精确 SS', recommendation: '复核悬浮物' },
      { date: dateAt(start, 3), metric: 'tn', level: '关注', reason: '精确 TN', recommendation: '复核总氮' },
      { date: dateAt(start, 4), metric: 'COD', level: '关注', reason: '精确 COD', recommendation: '复核 COD' },
      { date: dateAt(start, 5), metric: '总氮（TN）', level: '关注', reason: '演示名称', recommendation: '复核总氮' },
      { date: dateAt(start, 5), metric: '吨水电耗', level: '提示', reason: '能耗名称', recommendation: '复核能耗' },
      { date: dateAt(start, 6), metric: 'SS', level: '关注', reason: '范围后', recommendation: '不应暴露' },
    ];
    const dataset = datasetOf(7, { start, alerts });
    const plan = planFor(dataset, {
      modules: ['water-quality'],
      metrics: ['tn'],
      dateRange: { from: dateAt(start, 1), to: dateAt(start, 5) },
    });

    const evidence = buildAnalysisEvidence({ plan, dataset });

    expect(evidence.alerts.map(({ metric }) => metric)).toEqual([
      'MASS FLOW',
      ' ss ',
      'tn',
      'COD',
      '总氮（TN）',
      '吨水电耗',
    ]);
  });

  it('honors an alerts module even when the raw planner flag contradicts it', () => {
    const start = '2026-02-01';
    const alert: AlertRecord = {
      date: start,
      metric: '总氮（TN）',
      level: '关注',
      reason: '总氮波动',
      recommendation: '复核工艺参数',
    };
    const dataset = datasetOf(2, { start, alerts: [alert] });
    const evidence = buildAnalysisEvidence({
      plan: planFor(dataset, {
        modules: ['alerts', 'water-quality'],
        metrics: ['tn'],
        includeAlerts: false,
      }),
      dataset,
    });

    expect(evidence.scope.modules).toEqual(['water-quality', 'alerts']);
    expect(evidence.alerts).toEqual([alert]);
  });

  it('keeps health evidence available without adding weights unless explicitly requested', () => {
    const dataset = datasetOf(2);
    const evidence = buildAnalysisEvidence({
      plan: planFor(dataset, {
        modules: ['health'],
        metrics: ['qualityScore'],
        includeAlerts: false,
        includeHealthWeights: false,
      }),
      dataset,
    });

    expect(evidence.scope.modules).toEqual(['health']);
    expect(evidence.definitions).toEqual([
      { key: 'qualityScore', label: '出水水质得分', unit: '分' },
    ]);
    expect(evidence).not.toHaveProperty('healthWeights');
  });

  it('keeps the complete alert-sheet scope stable across analytical module selections', () => {
    const start = '2026-03-01';
    const alerts: AlertRecord[] = [
      { date: dateAt(start, 0), metric: '总氮（TN）', level: '关注', reason: '水质', recommendation: '复核水质' },
      { date: dateAt(start, 1), metric: '吨水电耗', level: '提示', reason: '电耗', recommendation: '复核电耗' },
      { date: dateAt(start, 2), metric: '碳源投加', level: '提示', reason: '碳源', recommendation: '复核碳源' },
      { date: dateAt(start, 3), metric: 'MASS FLOW', level: '提示', reason: '无关', recommendation: '不应泄漏' },
      { date: dateAt(start, 4), metric: '总氮（TN）', level: '关注', reason: '范围后', recommendation: '不应暴露' },
    ];
    const dataset = datasetOf(5, { start, alerts });
    const dateRange = { from: dateAt(start, 0), to: dateAt(start, 3) };
    const waterPlan = planFor(dataset, { modules: ['water-quality'], metrics: ['tn'], dateRange });
    const energyPlan = planFor(dataset, { modules: ['energy'], metrics: ['kwhPerM3'], dateRange });
    const crossModulePlan = planFor(dataset, { dateRange });

    expect(buildAnalysisEvidence({ plan: waterPlan, dataset }).alerts).toEqual(alerts.slice(0, 4));
    expect(buildAnalysisEvidence({ plan: energyPlan, dataset }).alerts).toEqual(alerts.slice(0, 4));
    expect(buildAnalysisEvidence({ plan: crossModulePlan, dataset }).alerts).toEqual(alerts.slice(0, 4));
  });

  it('computes requested Pearson pairs from raw same-date finite values only', () => {
    const dataset = datasetOf(6, {
      update: (row, index) => ({
        ...row,
        tn: index + 1,
        kwhPerM3: index === 1 ? Number.NaN : index === 4 ? (undefined as unknown as number) : (index + 1) * 2,
        blowerKwh: 20 - (index + 1) * 3,
        carbonSourceKg: 5,
      }),
    });
    const plan = planFor(dataset, {
      metrics: ['tn', 'kwhPerM3', 'blowerKwh', 'carbonSourceKg'],
      methods: ['trend', 'correlation'],
    });

    const evidence = buildAnalysisEvidence({ plan, dataset });

    expect(evidence.correlations).toEqual([
      { left: 'tn', right: 'kwhPerM3', coefficient: 1, samples: 4 },
      { left: 'tn', right: 'blowerKwh', coefficient: -1, samples: 6 },
      { left: 'kwhPerM3', right: 'blowerKwh', coefficient: -1, samples: 4 },
    ]);
    expect(evidence.correlations.some(({ left, right }) => left === 'carbonSourceKg' || right === 'carbonSourceKg')).toBe(false);
    expect(evidence.caveat).toBe('统计关联不等于因果关系');
  });

  it('omits Pearson output below three pairs or with zero variance, but keeps the exact caveat', () => {
    const twoRows = datasetOf(2);
    const constant = datasetOf(4, { update: (row, index) => ({ ...row, tn: 2, kwhPerM3: index + 1 }) });
    const correlationPlan = (dataset: DashboardDataset) => planFor(dataset, { methods: ['correlation'] });

    expect(buildAnalysisEvidence({ plan: correlationPlan(twoRows), dataset: twoRows }).correlations).toEqual([]);
    const constantEvidence = buildAnalysisEvidence({ plan: correlationPlan(constant), dataset: constant });
    expect(constantEvidence.correlations).toEqual([]);
    expect(constantEvidence.caveat).toBe('统计关联不等于因果关系');
  });

  it('rounds a non-perfect Pearson coefficient to four decimal places', () => {
    const left = [1, 2, 3, 4, 5];
    const right = [2, 1, 4, 3, 8];
    const dataset = datasetOf(5, {
      update: (row, index) => ({ ...row, tn: left[index]!, kwhPerM3: right[index]! }),
    });
    const plan = planFor(dataset, { methods: ['correlation'] });

    const evidence = buildAnalysisEvidence({ plan, dataset });

    expect(evidence.correlations).toEqual([
      { left: 'tn', right: 'kwhPerM3', coefficient: 0.8193, samples: 5 },
    ]);
  });

  it('computes finite scaled Pearson correlation for mixed-sign values near Number.MAX_VALUE', () => {
    const left = [1e308, -1e308, 5e307, -5e307];
    const right = [5e307, -5e307, 1e308, -1e308];
    const dataset = datasetOf(left.length, {
      update: (row, index) => ({ ...row, tn: left[index]!, kwhPerM3: right[index]! }),
    });
    const plan = planFor(dataset, { methods: ['correlation'] });

    const evidence = buildAnalysisEvidence({ plan, dataset });

    expect(evidence.correlations).toEqual([
      { left: 'tn', right: 'kwhPerM3', coefficient: 0.8, samples: 4 },
    ]);
    expectFiniteJsonEvidence(evidence);
  });

  it('does not calculate or add a caveat unless correlation was requested', () => {
    const dataset = datasetOf(4, {
      update: (row, index) => ({ ...row, tn: index + 1, kwhPerM3: (index + 1) * 2 }),
    });

    const evidence = buildAnalysisEvidence({ plan: planFor(dataset), dataset });

    expect(evidence.correlations).toEqual([]);
    expect(evidence).not.toHaveProperty('caveat');
  });

  it('throws a typed NO_EVIDENCE error with the available range when the inclusive range has no rows', () => {
    const dataset = datasetOf(2, { start: '2026-01-01' });
    dataset.daily[1] = { ...dataset.daily[1], date: '2026-01-10' };
    const inputOrder = [...dataset.daily];
    const plan = planFor(dataset, { dateRange: { from: '2026-01-02', to: '2026-01-09' } });

    let thrown: unknown;
    try {
      buildAnalysisEvidence({ plan, dataset });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AnalysisEvidenceError);
    expect(thrown).toMatchObject({
      name: 'AnalysisEvidenceError',
      code: 'NO_EVIDENCE',
      message: 'NO_EVIDENCE',
      availableDateRange: { from: '2026-01-01', to: '2026-01-10' },
    });
    expect(dataset.daily).toEqual(inputOrder);
  });
});
