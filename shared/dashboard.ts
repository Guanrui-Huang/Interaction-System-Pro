export type MetricDefinition = {
  label: string;
  unit: string;
  threshold?: number;
};

export const BUSINESS_PAGES = ['overview', 'health', 'water-quality', 'energy'] as const;

export type BusinessPage = typeof BUSINESS_PAGES[number];

export const BUSINESS_PAGE_NAMES: Record<BusinessPage, string> = {
  overview: '运行总览',
  health: '健康指数得分',
  'water-quality': '出水水质',
  energy: '节能降耗',
};

export type WaterMetricDefinition = MetricDefinition & { threshold: number };

export type EnergyCostConfig = {
  electricityYuanPerKwh: number;
  carbonSourceYuanPerKg: number;
  electricitySavingsRate: number;
};

export const ENERGY_COST_CONFIG: EnergyCostConfig = {
  electricityYuanPerKwh: 0.86,
  carbonSourceYuanPerKg: 4.2,
  electricitySavingsRate: 0.128,
};

export const WATER_QUALITY_METRICS = {
  tn: { label: '总氮（TN）', unit: 'mg/L', threshold: 3 },
  ammonia: { label: '氨氮', unit: 'mg/L', threshold: 1.5 },
  tp: { label: '总磷', unit: 'mg/L', threshold: 0.5 },
  cod: { label: 'COD', unit: 'mg/L', threshold: 50 },
  ss: { label: '悬浮物', unit: 'mg/L', threshold: 10 },
} as const satisfies Record<string, WaterMetricDefinition>;

export const TN_HEALTH_TARGET = 3;

export const METRIC_DEFINITIONS = {
  ...WATER_QUALITY_METRICS,
  kwhPerM3: { label: '吨水电耗', unit: 'kWh/m³' },
  blowerKwh: { label: '鼓风能耗', unit: 'kWh/d' },
  carbonSourceKg: { label: '碳源投加', unit: 'kg/d' },
  carbonEmissionKg: { label: '碳排放量', unit: 'kgCO₂e/d' },
  carbonReductionKg: { label: '碳减排量', unit: 'kgCO₂e/d' },
} as const satisfies Record<string, MetricDefinition>;

export const HEALTH_WEIGHTS = {
  quality: 0.4,
  flow: 0.2,
  energy: 0.25,
  carbonSource: 0.15,
} as const;

export const HEALTH_GRADE_THRESHOLDS = {
  excellent: 90,
  good: 75,
} as const;

export type DailyReading = {
  date: string;
  processedM3: number;
  informationCount: number;
  complianceRate: number;
  tn: number;
  ammonia: number;
  tp: number;
  cod: number;
  ss: number;
  totalKwh: number;
  kwhPerM3: number;
  blowerKwh: number;
  carbonEmissionKg: number;
  carbonReductionKg: number;
  savedYuan: number;
  qualityScore: number;
  flowScore: number;
  energyScore: number;
  carbonSourceKg: number;
  carbonSourceScore: number;
};

export type AlertLevel = '提示' | '关注';

export type AlertRecord = {
  date: string;
  metric: string;
  level: AlertLevel;
  reason: string;
  recommendation: string;
};

export type HealthWeights = typeof HEALTH_WEIGHTS;

export type HealthGrade = '优' | '良' | '关注';

export type HealthBreakdown = {
  weights: HealthWeights;
  score: number;
  grade: HealthGrade;
};

export type DashboardDataset = {
  plantName: '智慧污水处理厂';
  daily: DailyReading[];
  alerts: AlertRecord[];
  health: HealthBreakdown;
};

export type WaterQualityDashboardData = {
  latest: DailyReading;
  trend: DailyReading[];
  alerts: AlertRecord[];
  metrics: typeof WATER_QUALITY_METRICS;
};
