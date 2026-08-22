import { describe, expect, it } from 'vitest';
import type { EnergyData } from '../app/api';
import type { DailyReading } from '../../shared/dashboard';
import {
  buildEnergyPeriodView,
  ENERGY_PERIOD_OPTIONS,
  type EnergyPeriodView,
} from '../features/dashboard/energy-periods';

const start = new Date(Date.UTC(2025, 7, 9));
const daily: DailyReading[] = Array.from({ length: 366 }, (_, index) => {
  const date = new Date(start);
  date.setUTCDate(date.getUTCDate() + index);
  return {
    date: date.toISOString().slice(0, 10), processedM3: 2_000, informationCount: index,
    complianceRate: 99.8, tn: 2, ammonia: .4, tp: .2, cod: 20, ss: 5,
    totalKwh: 1_000, kwhPerM3: .5, blowerKwh: 400, carbonEmissionKg: 581,
    carbonReductionKg: 10, savedYuan: 100, qualityScore: 95, flowScore: 92,
    energyScore: 91, carbonSourceKg: 50, carbonSourceScore: 90,
  };
});
const data: EnergyData = {
  latest: daily.at(-1)!, trend: daily,
  costConfig: { electricityYuanPerKwh: .86, carbonSourceYuanPerKg: 4.2, electricitySavingsRate: .128 },
};

function expectReady(view: EnergyPeriodView): Extract<EnergyPeriodView, { status: 'ready' }> {
  expect(view.status).toBe('ready');
  if (view.status !== 'ready') throw new Error('Expected a ready energy-period view');
  return view;
}

describe('buildEnergyPeriodView', () => {
  it('keeps the approved selector order', () => {
    expect(ENERGY_PERIOD_OPTIONS.map((item) => item.label)).toEqual(['本月', '近一个月', '全年累计', '累计']);
  });

  it.each([
    ['month', '2026-08-01', 9, 900, 'day'],
    ['last-month', '2026-07-10', 31, 3_100, 'day'],
    ['year', '2026-01-01', 221, 22_100, 'week'],
    ['all', '2025-08-09', 366, 36_600, 'month'],
  ] as const)('aggregates %s as an inclusive range', (period, firstDate, dayCount, savedYuan, cadence) => {
    const view = expectReady(buildEnergyPeriodView(data, period));
    expect(view.range).toEqual({ start: firstDate, end: '2026-08-09', dayCount });
    expect(view.kpis.savedYuan).toBe(savedYuan);
    expect(view.kpis.savedKwh).toBe(dayCount * 1_000 * .128);
    expect(view.kpis.carbonReductionKg).toBe(dayCount * 10);
    expect(view.cadence).toBe(cadence);
    expect(view.savingsTrend.at(-1)?.savedYuan).toBe(savedYuan);
  });

  it('preserves the true cumulative boundaries while retaining monthly bucket-end values', () => {
    const view = expectReady(buildEnergyPeriodView(data, 'all'));

    expect(view.savingsTrend).toHaveLength(13);
    expect(view.savingsTrend[0]).toEqual({ date: '2025-08-09', savedYuan: 2_300 });
    expect(view.savingsTrend.at(-1)).toEqual({ date: '2026-08-09', savedYuan: 36_600 });
  });

  it('uses required metric labels and units', () => {
    const view = expectReady(buildEnergyPeriodView(data, 'month'));
    const blower = view.costMetrics.find((item) => item.key === 'blower')!;
    expect(blower.label).toBe('风机能耗（电耗）');
    expect(blower.consumption.unit).toBe('kWh');
    expect(blower.cost.unit).toBe('元');

    const tonWater = view.costMetrics.find((item) => item.key === 'ton-water')!;
    expect(tonWater.label).toBe('吨水电耗');
    expect(tonWater.consumption.unit).toBe('kWh/m³');
    expect(tonWater.cost.unit).toBe('元/m³');
    expect(tonWater.consumption.value).toBeCloseTo(.5);
    expect(tonWater.cost.value).toBeCloseTo(.43);

    const carbonSource = view.costMetrics.find((item) => item.key === 'carbon-source')!;
    expect(carbonSource.label).toBe('药剂（碳源）消耗');
    expect(carbonSource.consumption.unit).toBe('kg');
    expect(carbonSource.cost.unit).toBe('元');
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['non-finite', Number.NaN],
  ] as const)('nulls only costs affected by a %s price and reports the exact config key', (_case, electricityYuanPerKwh) => {
    const invalidElectricityPrice = {
      ...data,
      costConfig: { ...data.costConfig, electricityYuanPerKwh: electricityYuanPerKwh as number },
    };

    const view = expectReady(buildEnergyPeriodView(invalidElectricityPrice, 'month'));
    const blower = view.costMetrics.find((item) => item.key === 'blower')!;
    const tonWater = view.costMetrics.find((item) => item.key === 'ton-water')!;
    const carbonSource = view.costMetrics.find((item) => item.key === 'carbon-source')!;

    expect(blower.consumption.value).toBe(3_600);
    expect(blower.cost.value).toBeNull();
    expect(blower.cost.ratio).toBeNull();
    expect(tonWater.consumption.value).toBeCloseTo(.5);
    expect(tonWater.cost.value).toBeNull();
    expect(carbonSource.consumption.value).toBe(450);
    expect(carbonSource.cost.value).toBe(1_890);
    expect(view.configIssues).toEqual([
      expect.objectContaining({ key: 'electricityYuanPerKwh' }),
    ]);
  });

  it('nulls only saved electricity when the savings rate is not finite-positive', () => {
    const invalidSavingsRate = {
      ...data,
      costConfig: { ...data.costConfig, electricitySavingsRate: 0 },
    };

    const view = expectReady(buildEnergyPeriodView(invalidSavingsRate, 'month'));

    expect(view.kpis.savedYuan).toBe(900);
    expect(view.kpis.savedKwh).toBeNull();
    expect(view.kpis.carbonReductionKg).toBe(90);
    expect(view.costMetrics.every((metric) => metric.cost.value !== null)).toBe(true);
    expect(view.configIssues).toEqual([
      expect.objectContaining({ key: 'electricitySavingsRate' }),
    ]);
  });

  it('returns an explicit empty state instead of fabricated zero metrics', () => {
    const view = buildEnergyPeriodView({ ...data, trend: [] }, 'month');

    expect(view).toMatchObject({
      status: 'empty',
      message: '当前周期暂无数据',
      range: { start: '2026-08-01', end: '2026-08-09', dayCount: 0 },
    });
    expect('kpis' in view).toBe(false);
    expect('costMetrics' in view).toBe(false);
    expect('savingsTrend' in view).toBe(false);
  });
});
