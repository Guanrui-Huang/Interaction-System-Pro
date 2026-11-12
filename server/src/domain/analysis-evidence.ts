import type { AnalysisGranularity, AnalysisModule, AnalysisScope } from '../../../shared/ai';
import {
  HEALTH_WEIGHTS,
  type AlertRecord,
  type DailyReading,
  type DashboardDataset,
} from '../../../shared/dashboard';
import {
  ANALYSIS_METRICS,
  metricDefinitionFor,
  isAnalysisIsoDate,
  normalizeAnalysisPlan,
  type AnalysisMetricKey,
  type AnalysisPlan,
} from './analysis-plan';

export type AnalysisAggregate = {
  min: number;
  max: number;
  average: number;
  latest: number;
  changeRate: number | null;
};

export type AnalysisEvidence = {
  scope: AnalysisScope;
  definitions: Array<{ key: AnalysisMetricKey; label: string; unit: string; limit?: number; direction?: 'higher' | 'lower' }>;
  series: Array<{ date: string; values: Partial<Record<AnalysisMetricKey, number>> }>;
  aggregates: Partial<Record<AnalysisMetricKey, AnalysisAggregate>>;
  thresholdBreaches: Array<{ date: string; metric: AnalysisMetricKey; value: number; limit: number }>;
  correlations: Array<{ left: AnalysisMetricKey; right: AnalysisMetricKey; coefficient: number; samples: number }>;
  alerts: AlertRecord[];
  wphi?: { rule: string; snapshots: import('../../../shared/wphi').WphiSnapshot[] };
  healthWeights?: typeof HEALTH_WEIGHTS;
  caveat?: '统计关联不等于因果关系';
};

type AvailableDateRange = { from: string; to: string };

export class AnalysisEvidenceError extends Error {
  constructor(
    readonly code: 'NO_EVIDENCE' | 'INVALID_DATA',
    readonly availableDateRange?: AvailableDateRange,
  ) {
    super(code);
    this.name = 'AnalysisEvidenceError';
  }
}

const CORRELATION_CAVEAT = '统计关联不等于因果关系' as const;
const REDACTED_TEXT = '[已脱敏]';
const DAY_MS = 24 * 60 * 60 * 1_000;
const URL_TOKEN_PREFIX = '\u0000ANALYSIS_URL_';

type EvidenceModule = Exclude<AnalysisModule, 'alerts'>;

const ALERT_EXACT_ALIASES: Record<EvidenceModule, readonly string[]> = {
  overview: ['处理量', '达标率'],
  health: ['健康评分', '健康指数'],
  'water-quality': ['总氮', 'TN', 'NH3-N', 'TP', 'SS'],
  energy: ['电耗', '能耗', '鼓风', '碳源', '碳排放', '碳减排'],
};

function normalizeAlertMetric(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
}

function alertLabelsFor(module: EvidenceModule): ReadonlySet<string> {
  return new Set([
    ...Object.values(ANALYSIS_METRICS)
      .filter((definition) => definition.module === module)
      .map(({ label }) => label),
    ...ALERT_EXACT_ALIASES[module],
  ].map(normalizeAlertMetric));
}

const ALERT_LABELS = {
  overview: alertLabelsFor('overview'),
  health: alertLabelsFor('health'),
  'water-quality': alertLabelsFor('water-quality'),
  energy: alertLabelsFor('energy'),
} satisfies Record<EvidenceModule, ReadonlySet<string>>;

function normalizeCredentialName(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value.replace(/\+/gu, ' '));
  } catch {
    // Invalid percent escapes stay opaque and are normalized as written.
  }
  return decoded.normalize('NFKC').replace(/[^0-9A-Za-z]/gu, '').toLowerCase();
}

function isSensitiveCredentialName(value: string): boolean {
  const normalized = normalizeCredentialName(value);
  return normalized.endsWith('apikey')
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('authtoken')
    || normalized.endsWith('token')
    || normalized.endsWith('secret')
    || normalized.endsWith('password')
    || normalized.endsWith('passwd')
    || normalized.endsWith('credential');
}

function redactCredentialAssignments(value: string): string {
  return value.replace(
    /(^|[\s:：;；,，(（\[{])(["']?)([^\s:=：＝;；，,)"'\]}]{2,80})\2(\s*[:=：＝]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s；，,)"'\]}]+)/gu,
    (match, prefix: string, _quote: string, name: string) => (
      isSensitiveCredentialName(name) ? `${prefix}${REDACTED_TEXT}` : match
    ),
  );
}

function sanitizeAnalysisUrl(url: string, sensitiveValues: readonly string[]): string {
  let sanitized = url;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) sanitized = sanitized.split(sensitiveValue).join(REDACTED_TEXT);
  }
  return sanitized
    .replace(/(https?:\/\/)[^/\s@]+@/giu, `$1${REDACTED_TEXT}@`)
    .replace(/([?&#])([^=&#\s]+)=([^&#\s]*)/gu, (match, separator: string, name: string) => (
      isSensitiveCredentialName(name) ? `${separator}${name}=${REDACTED_TEXT}` : match
    ))
    .replace(/\bsk-[0-9A-Za-z_-]{8,}\b/gu, REDACTED_TEXT);
}

export function redactAnalysisText(value: string, sensitiveValues: readonly string[] = []): string {
  const protectedUrls: string[] = [];
  let redacted = value.replace(/\bhttps?:\/\/[^\s；，,)"'\]}]+/giu, (url) => {
    const token = `${URL_TOKEN_PREFIX}${protectedUrls.length}\u0000`;
    protectedUrls.push(sanitizeAnalysisUrl(url, sensitiveValues));
    return token;
  });
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) {
      redacted = redacted.split(sensitiveValue).join(REDACTED_TEXT);
    }
  }

  redacted = redacted
    .replace(/(?:[A-Za-z]:[\\/]|\\{2})[^\s；，,)"'\]}]*/gu, REDACTED_TEXT)
    .replace(/\/(?:Users|Volumes|private|var|srv|opt|tmp|home|etc|usr|System|Library|Applications|data)(?=\/|[\s；，,)"'\]}]|$)(?:\/[^\s/；，,)"'\]}]+)*/gu, REDACTED_TEXT)
    .replace(/\/(?:[^\s/；，,)"'\]}]+\/)*[^\s/；，,)"'\]}]+\.(?=[0-9A-Za-z]{1,16}\b)(?=[0-9A-Za-z]{0,15}[A-Za-z])[0-9A-Za-z]{1,16}\b/gu, REDACTED_TEXT)
    .replace(/(^|[\s:：;；,，(（\[{"'])\/(?!\/)[^\s；，,)"'\]}]*/gu, `$1${REDACTED_TEXT}`)
    .replace(/[^\s/\\；，,)"'\]}]+\.(?:xlsx|xlsm|xlsb|xls)\b/giu, REDACTED_TEXT);

  redacted = redactCredentialAssignments(redacted)
    .replace(/\b(?:DEEPSEEK_[A-Z0-9_]*|(?:[A-Z][A-Z0-9_]*_)?(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD))\b(?:\s*[:=]\s*[^\s；，,)"'\]}]*)?/giu, REDACTED_TEXT)
    .replace(/\bAuthorization\b(?:\s*:\s*[^\s；，,)"'\]}]+(?:\s+[^\s；，,)"'\]}]+)?)?/giu, REDACTED_TEXT)
    .replace(/\bBearer(?:\s+[^\s；，,)"'\]}]*)?/giu, REDACTED_TEXT)
    .replace(/\bsk-[0-9A-Za-z_-]{8,}\b/gu, REDACTED_TEXT)
    .replace(/\bUEsDB[0-9A-Za-z+/=_-]*/gu, REDACTED_TEXT);

  return redacted.replace(/\u0000ANALYSIS_URL_(\d+)\u0000/gu, (_token, index: string) => (
    protectedUrls[Number(index)] ?? REDACTED_TEXT
  ));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function roundFinite(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Number(value.toFixed(4));
  if (!Number.isFinite(rounded)) {
    return undefined;
  }
  return Object.is(rounded, -0) ? 0 : rounded;
}

function compensatedSum(values: readonly number[]): number | undefined {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    if (!Number.isFinite(next)) {
      return undefined;
    }
    correction += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    if (!Number.isFinite(correction)) {
      return undefined;
    }
    sum = next;
  }
  const result = sum + correction;
  return Number.isFinite(result) ? result : undefined;
}

function stableMean(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const scale = values.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  if (!Number.isFinite(scale)) {
    return undefined;
  }
  if (scale === 0) {
    return 0;
  }
  const normalizedSum = compensatedSum(values.map((value) => value / scale));
  if (normalizedSum === undefined) {
    return undefined;
  }
  const mean = (normalizedSum / values.length) * scale;
  return Number.isFinite(mean) ? mean : undefined;
}

function changeRate(first: number, latest: number): number | null {
  if (first === 0) {
    return null;
  }
  const difference = latest - first;
  const rate = Number.isFinite(difference)
    ? difference / first
    : latest / first - 1;
  return roundFinite(rate) ?? null;
}

function byDateAscending(left: { date: string }, right: { date: string }): number {
  return left.date.localeCompare(right.date);
}

function availableDateRange(dataset: DashboardDataset): AvailableDateRange | undefined {
  const dates = dataset.daily.map(({ date }) => date).sort((left, right) => left.localeCompare(right));
  const from = dates.at(0);
  const to = dates.at(-1);
  return from && to ? { from, to } : undefined;
}

function granularityFor(sampleCount: number): AnalysisGranularity {
  if (sampleCount <= 90) {
    return 'daily';
  }
  return sampleCount <= 180 ? 'weekly' : 'monthly';
}

function finiteValue(row: DailyReading, metric: AnalysisMetricKey): number | undefined {
  const value = ANALYSIS_METRICS[metric].read(row);
  return Number.isFinite(value) ? value : undefined;
}

function metricValues(row: DailyReading, metrics: readonly AnalysisMetricKey[]): Partial<Record<AnalysisMetricKey, number>> {
  const values: Partial<Record<AnalysisMetricKey, number>> = {};
  for (const metric of metrics) {
    const value = finiteValue(row, metric);
    if (value !== undefined) {
      const rounded = roundFinite(value);
      if (rounded !== undefined) {
        values[metric] = rounded;
      }
    }
  }
  return values;
}

function isoWeekLabel(date: string): string {
  const thursday = new Date(`${date}T00:00:00.000Z`);
  const day = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day);
  const weekYear = thursday.getUTCFullYear();
  const yearStart = new Date(0);
  yearStart.setUTCFullYear(weekYear, 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${String(weekYear).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

function aggregateSeries(
  rows: readonly DailyReading[],
  metrics: readonly AnalysisMetricKey[],
  granularity: Exclude<AnalysisGranularity, 'daily'>,
): AnalysisEvidence['series'] {
  const buckets = new Map<string, DailyReading[]>();
  for (const row of rows) {
    const label = granularity === 'weekly' ? isoWeekLabel(row.date) : row.date.slice(0, 7);
    const bucket = buckets.get(label);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(label, [row]);
    }
  }

  return Array.from(buckets, ([date, bucket]) => {
    const values: Partial<Record<AnalysisMetricKey, number>> = {};
    for (const metric of metrics) {
      const finiteValues = bucket
        .map((row) => finiteValue(row, metric))
        .filter((value): value is number => value !== undefined);
      const average = stableMean(finiteValues);
      const rounded = average === undefined ? undefined : roundFinite(average);
      if (rounded !== undefined) {
        values[metric] = rounded;
      }
    }
    return { date, values };
  });
}

function buildSeries(
  rows: readonly DailyReading[],
  metrics: readonly AnalysisMetricKey[],
  granularity: AnalysisGranularity,
): AnalysisEvidence['series'] {
  if (granularity === 'daily') {
    return rows.map((row) => ({ date: row.date, values: metricValues(row, metrics) }));
  }
  return aggregateSeries(rows, metrics, granularity);
}

function buildAggregates(
  rows: readonly DailyReading[],
  metrics: readonly AnalysisMetricKey[],
): AnalysisEvidence['aggregates'] {
  const aggregates: AnalysisEvidence['aggregates'] = {};
  for (const metric of metrics) {
    const values = rows
      .map((row) => finiteValue(row, metric))
      .filter((value): value is number => value !== undefined);
    const first = values.at(0);
    const latest = values.at(-1);
    if (first === undefined || latest === undefined) {
      continue;
    }
    let min = first;
    let max = first;
    for (const value of values.slice(1)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const roundedMin = roundFinite(min);
    const roundedMax = roundFinite(max);
    const average = stableMean(values);
    const roundedAverage = average === undefined ? undefined : roundFinite(average);
    const roundedLatest = roundFinite(latest);
    if (
      roundedMin === undefined
      || roundedMax === undefined
      || roundedAverage === undefined
      || roundedLatest === undefined
    ) {
      continue;
    }
    aggregates[metric] = {
      min: roundedMin,
      max: roundedMax,
      average: roundedAverage,
      latest: roundedLatest,
      changeRate: changeRate(first, latest),
    };
  }
  return aggregates;
}

function buildThresholdBreaches(
  rows: readonly DailyReading[],
  metrics: readonly AnalysisMetricKey[],
): AnalysisEvidence['thresholdBreaches'] {
  const breaches: AnalysisEvidence['thresholdBreaches'] = [];
  for (const row of rows) {
    for (const metric of metrics) {
      const {limit,direction} = metricDefinitionFor(metric,row);
      const value = finiteValue(row, metric);
      if (limit !== undefined && value !== undefined && (direction==='higher'?value<limit:value>limit)) {
        const rounded = roundFinite(value);
        if (rounded !== undefined && Number.isFinite(limit)) {
          breaches.push({ date: row.date, metric, value: rounded, limit });
        }
      }
    }
  }
  return breaches;
}

function alertMatchesModules(alert: AlertRecord, modules: readonly AnalysisModule[]): boolean {
  const normalizedMetric = normalizeAlertMetric(alert.metric);
  return modules.some((module) => (
    module !== 'alerts' && ALERT_LABELS[module].has(normalizedMetric)
  ));
}

function buildAlerts(
  plan: AnalysisPlan,
  dataset: DashboardDataset,
  sensitiveValues: readonly string[],
): AlertRecord[] {
  if (!plan.includeAlerts) {
    return [];
  }
  const allRequested = plan.modules.includes('alerts');
  return [...dataset.alerts]
    .sort(byDateAscending)
    .filter((alert) => (
      alert.date >= plan.dateRange.from
      && alert.date <= plan.dateRange.to
      && (allRequested || alertMatchesModules(alert, plan.modules))
    ))
    .map((alert) => ({
      date: alert.date,
      metric: redactAnalysisText(alert.metric, sensitiveValues),
      level: alert.level,
      reason: redactAnalysisText(alert.reason, sensitiveValues),
      recommendation: redactAnalysisText(alert.recommendation, sensitiveValues),
    }));
}

function pearson(
  rows: readonly DailyReading[],
  left: AnalysisMetricKey,
  right: AnalysisMetricKey,
): { coefficient: number; samples: number } | undefined {
  const pairs: Array<[number, number]> = [];
  for (const row of rows) {
    const leftValue = finiteValue(row, left);
    const rightValue = finiteValue(row, right);
    if (leftValue !== undefined && rightValue !== undefined) {
      pairs.push([leftValue, rightValue]);
    }
  }
  if (pairs.length < 3) {
    return undefined;
  }

  const leftScale = pairs.reduce((maximum, [value]) => Math.max(maximum, Math.abs(value)), 0);
  const rightScale = pairs.reduce((maximum, [, value]) => Math.max(maximum, Math.abs(value)), 0);
  if (leftScale === 0 || rightScale === 0 || !Number.isFinite(leftScale) || !Number.isFinite(rightScale)) {
    return undefined;
  }
  const scaledPairs = pairs.map(([leftValue, rightValue]) => [
    leftValue / leftScale,
    rightValue / rightScale,
  ] as const);
  const leftMean = stableMean(scaledPairs.map(([value]) => value));
  const rightMean = stableMean(scaledPairs.map(([, value]) => value));
  if (leftMean === undefined || rightMean === undefined) {
    return undefined;
  }
  const numerator = compensatedSum(scaledPairs.map(([leftValue, rightValue]) => (
    (leftValue - leftMean) * (rightValue - rightMean)
  )));
  const leftVariance = compensatedSum(scaledPairs.map(([leftValue]) => (leftValue - leftMean) ** 2));
  const rightVariance = compensatedSum(scaledPairs.map(([, rightValue]) => (rightValue - rightMean) ** 2));
  if (
    numerator === undefined
    || leftVariance === undefined
    || rightVariance === undefined
    || leftVariance <= 0
    || rightVariance <= 0
  ) {
    return undefined;
  }

  const denominator = Math.sqrt(leftVariance) * Math.sqrt(rightVariance);
  if (!Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  const coefficient = roundFinite(Math.max(-1, Math.min(1, numerator / denominator)));
  if (coefficient === undefined) {
    return undefined;
  }
  return {
    coefficient,
    samples: pairs.length,
  };
}

function buildCorrelations(
  rows: readonly DailyReading[],
  plan: AnalysisPlan,
): AnalysisEvidence['correlations'] {
  if (!plan.methods.includes('correlation')) {
    return [];
  }
  const correlations: AnalysisEvidence['correlations'] = [];
  for (let leftIndex = 0; leftIndex < plan.metrics.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plan.metrics.length; rightIndex += 1) {
      const left = plan.metrics[leftIndex]!;
      const right = plan.metrics[rightIndex]!;
      const result = pearson(rows, left, right);
      if (result) {
        correlations.push({ left, right, ...result });
      }
    }
  }
  return correlations;
}

export function buildAnalysisEvidence({
  plan,
  dataset,
  sensitiveValues = [],
}: {
  plan: AnalysisPlan;
  dataset: DashboardDataset;
  sensitiveValues?: readonly string[];
}): AnalysisEvidence {
  const normalizedPlan = normalizeAnalysisPlan(plan);
  if (
    !isAnalysisIsoDate(normalizedPlan.dateRange.from)
    || !isAnalysisIsoDate(normalizedPlan.dateRange.to)
    || normalizedPlan.dateRange.from > normalizedPlan.dateRange.to
    || dataset.daily.some(({ date }) => !isAnalysisIsoDate(date))
  ) {
    throw new AnalysisEvidenceError('INVALID_DATA');
  }
  const rows = [...dataset.daily]
    .sort(byDateAscending)
    .filter(({ date }) => date >= normalizedPlan.dateRange.from && date <= normalizedPlan.dateRange.to);
  if (rows.length === 0) {
    throw new AnalysisEvidenceError('NO_EVIDENCE', availableDateRange(dataset));
  }

  const maintenance = dataset.wphi?.config.maintenance || dataset.daily.at(-1)?.wphi?.status === 'maintenance';
  // Keep the requested scope for unavailable-metric reporting, but never bind a stale score.
  const latest=rows.at(-1)!;
  const exposedMetrics=normalizedPlan.metrics.filter(key=>!(key.endsWith('Score')&&(maintenance||latest.wphi&&!Number.isFinite(ANALYSIS_METRICS[key].read(latest)))));
  const granularity = granularityFor(rows.length);
  const correlationRequested = normalizedPlan.methods.includes('correlation');
  const evidence: AnalysisEvidence = {
    scope: {
      modules: [...normalizedPlan.modules],
      metrics: [...normalizedPlan.metrics],
      dateRange: { ...normalizedPlan.dateRange },
      sampleCount: rows.length,
      granularity,
    },
    definitions: exposedMetrics.map((key) => {
      const { label, unit,limit,direction } = metricDefinitionFor(key,latest);
      return { key, label, unit, ...(limit === undefined ? {} : { limit }),...(direction?{direction}:{}) };
    }),
    ...(latest.wphi ? {wphi:{rule:'综合得分为参与维度的算术平均；停用、检修、无冲击不计分。去除率越高越好。进水总氮为冲击基线。tn是水质阈值，tnOutWphi是WPHI运行目标，须区分。快照是所选期间末日状态；区间平均值见aggregates。',snapshots:structuredClone([{...latest.wphi,...(maintenance ? {status:'maintenance' as const,score:null,grade:null,dimensions:latest.wphi.dimensions.map(d=>({...d,score:null,grade:null,included:false,status:'maintenance' as const}))} : {})}])}} : {}),
    series: buildSeries(rows, exposedMetrics, granularity),
    aggregates: buildAggregates(rows, exposedMetrics),
    thresholdBreaches: buildThresholdBreaches(rows, exposedMetrics),
    correlations: buildCorrelations(rows, {...normalizedPlan,metrics:exposedMetrics}),
    alerts: buildAlerts(normalizedPlan, dataset, sensitiveValues),
    ...(normalizedPlan.includeHealthWeights && !dataset.wphi && !rows.some(row=>row.wphi) ? { healthWeights: { ...HEALTH_WEIGHTS } } : {}),
    ...(correlationRequested ? { caveat: CORRELATION_CAVEAT } : {}),
  };
  return deepFreeze(evidence);
}
