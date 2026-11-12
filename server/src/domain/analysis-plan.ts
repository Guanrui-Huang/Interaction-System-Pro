import { WPHI_DIMENSIONS, type WphiDimensionKey, type WphiMetrics } from '../../../shared/wphi';
import { z } from 'zod';
import {
  ANALYSIS_MODULES,
  type AnalysisModule,
} from '../../../shared/ai';
import {
  METRIC_DEFINITIONS,
  type DailyReading,
  type DashboardDataset,
} from '../../../shared/dashboard';
import { calculateReadingHealth } from '../../../shared/health';
import { isBusinessIsoDate } from './business-date';

export const ANALYSIS_METHODS = ['trend', 'comparison', 'anomaly', 'correlation', 'summary'] as const;

export type AnalysisMethod = typeof ANALYSIS_METHODS[number];

export type AnalysisMetricKey = Exclude<keyof DailyReading, 'date' | 'wphi'> | 'healthScore' | 'tnOutWphi' | `${WphiDimensionKey}Score` | keyof WphiMetrics;

export type AnalysisPlan = {
  modules: AnalysisModule[];
  metrics: AnalysisMetricKey[];
  dateRange: { from: string; to: string };
  methods: AnalysisMethod[];
  includeAlerts: boolean;
  includeHealthWeights: boolean;
};

type AnalysisMetricDefinition = {
  direction?: 'higher' | 'lower';
  module: Exclude<AnalysisModule, 'alerts'>;
  label: string;
  unit: string;
  limit?: number;
  read: (row: DailyReading) => number;
};

function fieldMetric<K extends Exclude<keyof DailyReading, 'date' | 'wphi'>>(
  module: Exclude<AnalysisModule, 'alerts'>,
  key: K,
  label: string,
  unit: string,
  limit?: number,
): AnalysisMetricDefinition {
  return {
    module,
    label,
    unit,
    ...(limit === undefined ? {} : { limit }),
    read: (row) => row.wphi && ['qualityScore','flowScore','energyScore','carbonSourceScore'].includes(key) ? NaN : row[key],
  };
}

export const ANALYSIS_METRICS: Record<AnalysisMetricKey, AnalysisMetricDefinition> = {
  tnOutWphi: {module:'health',label:'WPHI出水总氮',unit:'mg/L',read:row=>row.wphi?row.tn:NaN},
  ...Object.fromEntries(Object.entries(WPHI_DIMENSIONS).map(([key,label]) => [`${key}Score`, { module: 'health', label: `${label}得分`, unit: '分', read: (row: DailyReading) => { const d=row.wphi?.dimensions.find(d=>d.key===key); return d?.included ? d.score ?? NaN : NaN; } }])) as Record<`${WphiDimensionKey}Score`, AnalysisMetricDefinition>,
  ...Object.fromEntries(Object.entries({tnIn:['进水总氮','mg/L'],tnRemoval:['总氮去除率','%'],tnCv:['近7天出水总氮CV','%'],tnMean7:['近7天平均出水总氮','mg/L'],blowerKwhPerM3:['吨水风机能耗','kWh/m³'],carbonKgPerM3:['吨水碳源用量','kg/m³'],abnormalDays:['近30天异常天数','天'],shockDays:['近30天进水冲击天数','天']}).map(([key,[label,unit]])=>[key,{module:'health',label,unit,read:(row:DailyReading)=>row.wphi?.metrics[key as keyof WphiMetrics] ?? NaN}])) as Record<keyof WphiMetrics, AnalysisMetricDefinition>,
  processedM3: fieldMetric('overview', 'processedM3', '处理水量', 'm³/d'),
  informationCount: fieldMetric('overview', 'informationCount', '信息采集量', '条/d'),
  complianceRate: fieldMetric('overview', 'complianceRate', '水质达标率', '%'),
  healthScore: {
    module: 'health',
    label: '综合健康评分',
    unit: '分',
    read: (row) => calculateReadingHealth(row).score ?? NaN,
  },
  qualityScore: fieldMetric('health', 'qualityScore', '出水水质得分', '分'),
  flowScore: fieldMetric('health', 'flowScore', '水量波动得分', '分'),
  energyScore: fieldMetric('health', 'energyScore', '电耗得分', '分'),
  carbonSourceScore: fieldMetric('health', 'carbonSourceScore', '碳源消耗得分', '分'),
  tn: fieldMetric('water-quality', 'tn', METRIC_DEFINITIONS.tn.label, METRIC_DEFINITIONS.tn.unit, METRIC_DEFINITIONS.tn.threshold),
  ammonia: fieldMetric('water-quality', 'ammonia', METRIC_DEFINITIONS.ammonia.label, METRIC_DEFINITIONS.ammonia.unit, METRIC_DEFINITIONS.ammonia.threshold),
  tp: fieldMetric('water-quality', 'tp', METRIC_DEFINITIONS.tp.label, METRIC_DEFINITIONS.tp.unit, METRIC_DEFINITIONS.tp.threshold),
  cod: fieldMetric('water-quality', 'cod', METRIC_DEFINITIONS.cod.label, METRIC_DEFINITIONS.cod.unit, METRIC_DEFINITIONS.cod.threshold),
  ss: fieldMetric('water-quality', 'ss', METRIC_DEFINITIONS.ss.label, METRIC_DEFINITIONS.ss.unit, METRIC_DEFINITIONS.ss.threshold),
  totalKwh: fieldMetric('energy', 'totalKwh', '总电耗', 'kWh/d'),
  kwhPerM3: fieldMetric('energy', 'kwhPerM3', METRIC_DEFINITIONS.kwhPerM3.label, METRIC_DEFINITIONS.kwhPerM3.unit),
  blowerKwh: fieldMetric('energy', 'blowerKwh', METRIC_DEFINITIONS.blowerKwh.label, METRIC_DEFINITIONS.blowerKwh.unit),
  carbonSourceKg: fieldMetric('energy', 'carbonSourceKg', METRIC_DEFINITIONS.carbonSourceKg.label, METRIC_DEFINITIONS.carbonSourceKg.unit),
  carbonEmissionKg: fieldMetric('energy', 'carbonEmissionKg', METRIC_DEFINITIONS.carbonEmissionKg.label, METRIC_DEFINITIONS.carbonEmissionKg.unit),
  carbonReductionKg: fieldMetric('energy', 'carbonReductionKg', METRIC_DEFINITIONS.carbonReductionKg.label, METRIC_DEFINITIONS.carbonReductionKg.unit),
  savedYuan: fieldMetric('energy', 'savedYuan', '节省费用', '元/d'),
};

const ANALYSIS_METRIC_KEYS = Object.keys(ANALYSIS_METRICS) as [AnalysisMetricKey, ...AnalysisMetricKey[]];
export function metricDefinitionFor(key:AnalysisMetricKey, row?:DailyReading):AnalysisMetricDefinition {
  const definition=ANALYSIS_METRICS[key];
  if(!row?.wphi) return definition;
  const t=row.wphi.config.targets;
  const targets:Partial<Record<AnalysisMetricKey,number>>={tnOutWphi:t.tnOut,tnRemoval:t.tnRemoval,tnCv:t.tnCv,blowerKwh:t.blowerTotal,blowerKwhPerM3:t.blowerPerM3,carbonSourceKg:t.carbonTotal,carbonKgPerM3:t.carbonPerM3};
  return targets[key]===undefined?definition:{...definition,limit:targets[key],direction:key==='tnRemoval'?'higher':'lower'};
}
export function availableAnalysisMetrics(dataset:DashboardDataset):AnalysisMetricKey[] {
  const latest=dataset.daily.at(-1);
  return ANALYSIS_METRIC_KEYS.filter(key=>dataset.daily.some(row=>Number.isFinite(ANALYSIS_METRICS[key].read(row))))
    .filter(key=>!latest?.wphi || !key.endsWith('Score') || Number.isFinite(ANALYSIS_METRICS[key].read(latest)));
}
export const isAnalysisIsoDate = isBusinessIsoDate;

function hasUniqueItems(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const dateRangeSchema = z.object({
  from: z.string().refine(isAnalysisIsoDate),
  to: z.string().refine(isAnalysisIsoDate),
}).strict().refine(({ from, to }) => from <= to);

const analysisPlanSchema = z.object({
  modules: z.array(z.enum(ANALYSIS_MODULES)).min(1).refine(hasUniqueItems),
  metrics: z.array(z.enum(ANALYSIS_METRIC_KEYS)).min(1).refine(hasUniqueItems),
  dateRange: dateRangeSchema,
  methods: z.array(z.enum(ANALYSIS_METHODS)).min(1).refine(hasUniqueItems),
  includeAlerts: z.boolean(),
  includeHealthWeights: z.boolean(),
}).strict().superRefine(({ modules, metrics }, context) => {
  const metricModules = new Set(metrics.map((metric) => ANALYSIS_METRICS[metric].module));
  for (const metric of metrics) {
    if (!modules.includes(ANALYSIS_METRICS[metric].module)) {
      context.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: `Metric ${metric} requires module ${ANALYSIS_METRICS[metric].module}`,
      });
    }
  }
  for (const module of modules) {
    if (module !== 'alerts' && !metricModules.has(module)) {
      context.addIssue({
        code: 'custom',
        path: ['modules'],
        message: `Module ${module} requires at least one metric`,
      });
    }
  }
});

function availableDateRange(dataset: DashboardDataset): { from: string; to: string } | undefined {
  const dates = dataset.daily.map(({ date }) => date).sort((left, right) => left.localeCompare(right));
  const from = dates.at(0);
  const to = dates.at(-1);
  return from && to ? { from, to } : undefined;
}

function stripOptionalJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function invalidAnalysisPlan(): never {
  throw new Error('ANALYSIS_PLAN_INVALID');
}

export function normalizeAnalysisPlan(plan: AnalysisPlan): AnalysisPlan {
  const requestedModules = new Set<AnalysisModule>(plan.modules);
  const includeAlerts = plan.includeAlerts || requestedModules.has('alerts');
  if (includeAlerts) requestedModules.add('alerts');
  if (plan.includeHealthWeights) requestedModules.add('health');

  return {
    ...plan,
    modules: ANALYSIS_MODULES.filter((module) => requestedModules.has(module)),
    includeAlerts,
  };
}

export function parseAnalysisPlan(value: string, dataset: DashboardDataset): AnalysisPlan {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stripOptionalJsonFence(value));
  } catch {
    return invalidAnalysisPlan();
  }

  const parsed = analysisPlanSchema.safeParse(decoded);
  const available = availableDateRange(dataset);
  if (
    !parsed.success
    || !available
    || parsed.data.dateRange.from < available.from
    || parsed.data.dateRange.to > available.to
  ) {
    return invalidAnalysisPlan();
  }

  return normalizeAnalysisPlan(parsed.data);
}

export function createDefaultAnalysisPlan(dataset: DashboardDataset): AnalysisPlan {
  const dates = dataset.daily.map(({ date }) => date).sort((left, right) => left.localeCompare(right));
  const recentDates = dates.slice(-30);
  const from = recentDates.at(0);
  const to = recentDates.at(-1);
  if (!from || !to) {
    return invalidAnalysisPlan();
  }

  return {
    modules: [...ANALYSIS_MODULES],
    metrics: availableAnalysisMetrics(dataset),
    dateRange: { from, to },
    methods: ANALYSIS_METHODS.filter((method) => method !== 'correlation'),
    includeAlerts: true,
    includeHealthWeights: true,
  };
}
