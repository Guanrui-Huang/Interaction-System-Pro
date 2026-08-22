import {
  BUSINESS_PAGE_NAMES,
  HEALTH_GRADE_THRESHOLDS,
  HEALTH_WEIGHTS,
  METRIC_DEFINITIONS,
  WATER_QUALITY_METRICS,
  type AlertRecord,
  type BusinessPage,
  type DailyReading,
  type DashboardDataset,
  type HealthGrade,
} from '../../../shared/dashboard';
import { calculateReadingHealth } from '../../../shared/health';

const MAX_RECENT_ROWS = 30;
const MAX_RECENT_ALERTS = 10;

type ContextMetricKey =
  | keyof Pick<DailyReading,
    | 'processedM3'
    | 'complianceRate'
    | 'tn'
    | 'ammonia'
    | 'tp'
    | 'cod'
    | 'ss'
    | 'totalKwh'
    | 'kwhPerM3'
    | 'blowerKwh'
    | 'savedYuan'
    | 'qualityScore'
    | 'flowScore'
    | 'energyScore'
    | 'carbonSourceKg'
    | 'carbonSourceScore'
    | 'carbonEmissionKg'
    | 'carbonReductionKg'>
  | 'healthScore';

type MetricConfig = {
  key: ContextMetricKey;
  label: string;
  unit: string;
  limit?: number;
  value: (reading: DailyReading) => number;
};

export type AiContextMetric = Omit<MetricConfig, 'value'> & { latest: number };

export type AiContextAggregate = {
  min: number;
  max: number;
  average: number;
  latest: number;
};

export type AiContext = {
  page: BusinessPage;
  sourcePageName: string;
  evidenceInstruction: string;
  metrics: AiContextMetric[];
  recentSeries: Array<{ date: string; values: Record<string, number> }>;
  aggregates: Record<string, AiContextAggregate>;
  alerts: AlertRecord[];
  health?: {
    weights: typeof HEALTH_WEIGHTS;
    gradeThresholds: typeof HEALTH_GRADE_THRESHOLDS;
    score: number;
    grade: HealthGrade;
  };
  waterMetricDefinitions?: typeof WATER_QUALITY_METRICS;
};

function fieldMetric<K extends keyof DailyReading>(
  key: K,
  label: string,
  unit: string,
  limit?: number,
): MetricConfig {
  return {
    key: key as ContextMetricKey,
    label,
    unit,
    ...(limit === undefined ? {} : { limit }),
    value: (reading) => reading[key] as number,
  };
}

const healthScoreMetric: MetricConfig = {
  key: 'healthScore',
  label: '综合健康评分',
  unit: '分',
  value: (reading) => calculateReadingHealth(reading).score,
};

const healthComponentMetrics: MetricConfig[] = [
  fieldMetric('qualityScore', '出水水质得分', '分'),
  fieldMetric('flowScore', '水量波动得分', '分'),
  fieldMetric('energyScore', '电耗得分', '分'),
  fieldMetric('carbonSourceScore', '碳源消耗得分', '分'),
];

const metricsByPage: Record<BusinessPage, MetricConfig[]> = {
  overview: [
    fieldMetric('processedM3', '今日处理量', 'm³/d'),
    fieldMetric('complianceRate', '水质达标率', '%'),
    healthScoreMetric,
    ...healthComponentMetrics,
  ],
  health: [healthScoreMetric, ...healthComponentMetrics],
  'water-quality': (Object.entries(WATER_QUALITY_METRICS) as Array<[
    keyof typeof WATER_QUALITY_METRICS,
    (typeof WATER_QUALITY_METRICS)[keyof typeof WATER_QUALITY_METRICS],
  ]>).map(([key, definition]) => fieldMetric(key, definition.label, definition.unit, definition.threshold)),
  energy: [
    fieldMetric('totalKwh', '总电耗', 'kWh/d'),
    fieldMetric('kwhPerM3', METRIC_DEFINITIONS.kwhPerM3.label, METRIC_DEFINITIONS.kwhPerM3.unit),
    fieldMetric('blowerKwh', METRIC_DEFINITIONS.blowerKwh.label, METRIC_DEFINITIONS.blowerKwh.unit),
    fieldMetric('savedYuan', '节省费用', '元/d'),
    fieldMetric('carbonSourceKg', METRIC_DEFINITIONS.carbonSourceKg.label, METRIC_DEFINITIONS.carbonSourceKg.unit),
    fieldMetric('carbonEmissionKg', METRIC_DEFINITIONS.carbonEmissionKg.label, METRIC_DEFINITIONS.carbonEmissionKg.unit),
    fieldMetric('carbonReductionKg', METRIC_DEFINITIONS.carbonReductionKg.label, METRIC_DEFINITIONS.carbonReductionKg.unit),
  ],
};

const alertKeywords: Record<BusinessPage, string[]> = {
  overview: [],
  health: [],
  'water-quality': ['总氮', 'TN', '氨氮', '总磷', 'COD', '悬浮物', 'SS'],
  energy: ['电耗', '能耗', '鼓风', '碳源', '碳排放', '碳减排'],
};

function round(value: number): number {
  return Number(value.toFixed(4));
}

function isRelevantAlert(page: BusinessPage, alert: AlertRecord): boolean {
  const keywords = alertKeywords[page];
  return keywords.length === 0 || keywords.some((keyword) => alert.metric.includes(keyword));
}

function byDateAscending(left: { date: string }, right: { date: string }): number {
  return left.date.localeCompare(right.date);
}

export function buildAiContext({ page, dataset }: { page: BusinessPage; dataset: DashboardDataset }): AiContext {
  const recent = [...dataset.daily].sort(byDateAscending).slice(-MAX_RECENT_ROWS);
  const latest = recent.at(-1);

  if (!latest) {
    throw new Error('AI_CONTEXT_DATA_EMPTY');
  }

  const configs = metricsByPage[page];
  const recentSeries = recent.map((reading) => ({
    date: reading.date,
    values: Object.fromEntries(configs.map((metric) => [metric.key, round(metric.value(reading))])),
  }));
  const aggregates = Object.fromEntries(configs.map((metric) => {
    const values = recent.map(metric.value);
    return [metric.key, {
      min: round(Math.min(...values)),
      max: round(Math.max(...values)),
      average: round(values.reduce((sum, value) => sum + value, 0) / values.length),
      latest: round(values.at(-1)!),
    }];
  }));
  const currentHealth = calculateReadingHealth(latest);
  const includeHealth = page === 'overview' || page === 'health';

  return {
    page,
    sourcePageName: BUSINESS_PAGE_NAMES[page],
    evidenceInstruction: '仅使用所提供的演示证据作答；证据不足时必须明确说明无法确认，不得编造数值。',
    metrics: configs.map(({ value, ...metric }) => ({ ...metric, latest: round(value(latest)) })),
    recentSeries,
    aggregates,
    alerts: [...dataset.alerts]
      .sort(byDateAscending)
      .filter((alert) => isRelevantAlert(page, alert))
      .slice(-MAX_RECENT_ALERTS),
    ...(includeHealth ? {
      health: {
        weights: HEALTH_WEIGHTS,
        gradeThresholds: HEALTH_GRADE_THRESHOLDS,
        ...currentHealth,
      },
    } : {}),
    ...(page === 'water-quality' ? { waterMetricDefinitions: WATER_QUALITY_METRICS } : {}),
  };
}
