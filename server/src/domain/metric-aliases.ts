import { ANALYSIS_METRICS, type AnalysisMetricKey } from './analysis-plan';

export type MetricAliasCatalog = Readonly<Record<AnalysisMetricKey, readonly string[]>>;

export const METRIC_ALIASES: MetricAliasCatalog = Object.freeze({
  processedM3: Object.freeze(['处理水量', '处理量', '水量']),
  informationCount: Object.freeze(['信息采集量', '信息量']),
  complianceRate: Object.freeze(['水质达标率', '达标率']),
  healthScore: Object.freeze(['综合健康评分', '健康评分', '健康指数']),
  qualityScore: Object.freeze(['出水水质得分', '水质得分']),
  flowScore: Object.freeze(['水量波动得分', '流量得分']),
  energyScore: Object.freeze(['电耗得分', '能耗得分']),
  carbonSourceScore: Object.freeze(['碳源消耗得分']),
  tn: Object.freeze(['总氮（tn）', '总氮', 'tn']),
  ammonia: Object.freeze(['氨氮', 'nh3-n']),
  tp: Object.freeze(['总磷', 'tp']),
  cod: Object.freeze(['cod']),
  ss: Object.freeze(['悬浮物', 'ss']),
  totalKwh: Object.freeze(['总电耗']),
  kwhPerM3: Object.freeze(['吨水电耗', '单位水量电耗']),
  blowerKwh: Object.freeze(['鼓风机能耗', '鼓风能耗', '鼓风机', '鼓风']),
  carbonSourceKg: Object.freeze(['碳源投加', '碳源']),
  carbonEmissionKg: Object.freeze(['碳排放量', '碳排放']),
  carbonReductionKg: Object.freeze(['碳减排量', '碳减排']),
  savedYuan: Object.freeze(['节省费用', '节省金额']),
});

type MetricAliasCandidate = {
  metric: AnalysisMetricKey;
  alias: string;
  start: number;
  end: number;
};

function normalizeAliasText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function hasAsciiWordBoundaries(text: string, alias: string, start: number): boolean {
  if (!/^[a-z0-9_-]+$/u.test(alias)) return true;
  const before = text[start - 1];
  const after = text[start + alias.length];
  return (before === undefined || !/[a-z0-9_]/u.test(before))
    && (after === undefined || !/[a-z0-9_]/u.test(after));
}

export function matchMetricAliases(
  value: string,
  catalog: MetricAliasCatalog = METRIC_ALIASES,
  options: { asciiWordBoundaries?: boolean } = {},
): AnalysisMetricKey[] {
  const text = normalizeAliasText(value);
  const candidates = (Object.entries(catalog) as Array<[AnalysisMetricKey, readonly string[]]>)
    .flatMap(([metric, aliases]) => aliases.flatMap((rawAlias) => {
      const alias = normalizeAliasText(rawAlias);
      const matches: MetricAliasCandidate[] = [];
      let start = text.indexOf(alias);
      while (start >= 0) {
        if (!options.asciiWordBoundaries || hasAsciiWordBoundaries(text, alias, start)) {
          matches.push({ metric, alias, start, end: start + alias.length });
        }
        start = text.indexOf(alias, start + 1);
      }
      return matches;
    }))
    .sort((left, right) => (
      right.alias.length - left.alias.length
      || left.start - right.start
      || left.alias.localeCompare(right.alias)
      || left.metric.localeCompare(right.metric)
    ));

  const matched = new Set<AnalysisMetricKey>();
  const occupied: Array<{ start: number; end: number }> = [];
  for (const candidate of candidates) {
    const overlaps = occupied.some((range) => candidate.start < range.end && range.start < candidate.end);
    if (!overlaps) {
      matched.add(candidate.metric);
      occupied.push({ start: candidate.start, end: candidate.end });
    }
  }
  return (Object.keys(ANALYSIS_METRICS) as AnalysisMetricKey[]).filter((key) => matched.has(key));
}
