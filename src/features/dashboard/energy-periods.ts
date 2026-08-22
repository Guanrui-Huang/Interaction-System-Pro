import type { EnergyData } from '../../app/api';
import type { EnergyCostConfig } from '../../../shared/dashboard';

export type EnergyPeriod = 'month' | 'last-month' | 'year' | 'all';
export type EnergyCadence = 'day' | 'week' | 'month';

export const ENERGY_PERIOD_OPTIONS = [
  { key: 'month', label: '本月' },
  { key: 'last-month', label: '近一个月' },
  { key: 'year', label: '全年累计' },
  { key: 'all', label: '累计' },
] as const satisfies ReadonlyArray<{ key: EnergyPeriod; label: string }>;

export type EnergyCostMetric = {
  key: 'blower' | 'ton-water' | 'carbon-source';
  label: string;
  consumption: { value: number; unit: string; ratio: number };
  cost: { value: number | null; unit: string; ratio: number | null };
};

export type SavingsTrendPoint = { date: string; savedYuan: number };

export type EnergyConfigIssue = {
  key: keyof EnergyCostConfig;
  message: string;
};

type EnergyPeriodViewBase = {
  label: string;
  range: { start: string; end: string; dayCount: number };
  cadence: EnergyCadence;
  configIssues: EnergyConfigIssue[];
};

export type EnergyPeriodView =
  | EnergyPeriodViewBase & {
    status: 'ready';
    kpis: { savedYuan: number; savedKwh: number | null; carbonReductionKg: number };
    costMetrics: EnergyCostMetric[];
    savingsTrend: SavingsTrendPoint[];
  }
  | EnergyPeriodViewBase & {
    status: 'empty';
    message: '当前周期暂无数据';
  };

const parseDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const formatDate = (value: Date): string => value.toISOString().slice(0, 10);
const shiftDays = (value: string, amount: number): string => {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return formatDate(date);
};
const clampRatio = (value: number): number => Math.max(.12, Math.min(1, value));
const configKeys = ['electricityYuanPerKwh', 'carbonSourceYuanPerKg', 'electricitySavingsRate'] as const satisfies ReadonlyArray<keyof EnergyCostConfig>;

function validateCostConfig(config: unknown): {
  values: Record<keyof EnergyCostConfig, number | null>;
  issues: EnergyConfigIssue[];
} {
  const record = typeof config === 'object' && config !== null ? config as Record<string, unknown> : {};
  const issues: EnergyConfigIssue[] = [];
  const values = Object.fromEntries(configKeys.map((key) => {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return [key, value];
    issues.push({ key, message: `${key} 缺失或不是有限正数` });
    return [key, null];
  })) as Record<keyof EnergyCostConfig, number | null>;
  return { values, issues };
}

function periodStart(data: EnergyData, period: EnergyPeriod): string {
  const end = parseDate(data.latest.date);
  if (period === 'month') return `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-01`;
  if (period === 'last-month') return shiftDays(data.latest.date, -30);
  if (period === 'year') return `${end.getUTCFullYear()}-01-01`;
  return data.trend[0]?.date ?? data.latest.date;
}

function cadenceFor(period: EnergyPeriod): EnergyCadence {
  return period === 'year' ? 'week' : period === 'all' ? 'month' : 'day';
}

function bucketKey(date: string, cadence: EnergyCadence, firstDate: string): string {
  if (cadence === 'day') return date;
  if (cadence === 'month') return date.slice(0, 7);
  const offset = Math.floor((parseDate(date).getTime() - parseDate(firstDate).getTime()) / 86_400_000 / 7);
  return `week-${offset}`;
}

export function buildEnergyPeriodView(data: EnergyData, period: EnergyPeriod): EnergyPeriodView {
  const start = periodStart(data, period);
  const selected = data.trend.filter((point) => point.date >= start && point.date <= data.latest.date);
  const cadence = cadenceFor(period);
  const config = validateCostConfig(data.costConfig);
  const base = {
    label: ENERGY_PERIOD_OPTIONS.find((item) => item.key === period)!.label,
    range: { start, end: data.latest.date, dayCount: selected.length },
    cadence,
    configIssues: config.issues,
  };
  if (!selected.length) return { ...base, status: 'empty', message: '当前周期暂无数据' };

  const total = (key: 'savedYuan' | 'totalKwh' | 'processedM3' | 'blowerKwh' | 'carbonSourceKg' | 'carbonReductionKg') =>
    selected.reduce((sum, point) => sum + point[key], 0);
  const dayCount = selected.length;
  const totalKwh = total('totalKwh');
  const processedM3 = total('processedM3');
  const blowerKwh = total('blowerKwh');
  const carbonSourceKg = total('carbonSourceKg');
  const electricityPrice = config.values.electricityYuanPerKwh;
  const carbonSourcePrice = config.values.carbonSourceYuanPerKg;
  const savingsRate = config.values.electricitySavingsRate;
  const blowerCost = electricityPrice === null ? null : blowerKwh * electricityPrice;
  const kwhPerM3 = processedM3 > 0 ? totalKwh / processedM3 : 0;
  const yuanPerM3 = electricityPrice === null || processedM3 <= 0 ? null : totalKwh * electricityPrice / processedM3;
  const carbonCost = carbonSourcePrice === null ? null : carbonSourceKg * carbonSourcePrice;
  const groups = new Map<string, { date: string; value: number }>();
  let cumulative = 0;
  selected.forEach((point) => {
    cumulative += point.savedYuan;
    groups.set(bucketKey(point.date, cadence, start), { date: point.date, value: cumulative });
  });
  const ratio = dayCount / 366;
  const savingsTrend = Array.from(groups.values(), (item) => ({ date: item.date, savedYuan: item.value }));
  if (cadence === 'month' && savingsTrend.length) {
    savingsTrend[0] = { ...savingsTrend[0]!, date: selected[0]!.date };
    savingsTrend[savingsTrend.length - 1] = { ...savingsTrend.at(-1)!, date: selected.at(-1)!.date };
  }

  return {
    ...base,
    status: 'ready',
    kpis: {
      savedYuan: total('savedYuan'),
      savedKwh: savingsRate === null ? null : totalKwh * savingsRate,
      carbonReductionKg: total('carbonReductionKg'),
    },
    costMetrics: [
      {
        key: 'blower',
        label: '风机能耗（电耗）',
        consumption: { value: blowerKwh, unit: 'kWh', ratio: clampRatio(ratio) },
        cost: { value: blowerCost, unit: '元', ratio: blowerCost === null ? null : clampRatio(ratio) },
      },
      {
        key: 'ton-water',
        label: '吨水电耗',
        consumption: { value: kwhPerM3, unit: 'kWh/m³', ratio: clampRatio(kwhPerM3 / .55) },
        cost: { value: yuanPerM3, unit: '元/m³', ratio: yuanPerM3 === null ? null : clampRatio(yuanPerM3 / .5) },
      },
      {
        key: 'carbon-source',
        label: '药剂（碳源）消耗',
        consumption: { value: carbonSourceKg, unit: 'kg', ratio: clampRatio(ratio) },
        cost: { value: carbonCost, unit: '元', ratio: carbonCost === null ? null : clampRatio(ratio) },
      },
    ],
    savingsTrend,
  };
}
