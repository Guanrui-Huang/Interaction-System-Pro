export type BarThemeFamily = 'water' | 'treatment' | 'flow' | 'energy' | 'analytics' | 'resource' | 'risk';

const BAR_THEMES = [
  { family: 'water', start: '#1689DC', end: '#2CE4F5' },
  { family: 'treatment', start: '#19BFA0', end: '#42F0C7' },
  { family: 'flow', start: '#0A9FA8', end: '#47D9D1' },
  { family: 'energy', start: '#1454A6', end: '#2B8CF0' },
  { family: 'analytics', start: '#6B2FB2', end: '#AA56F0' },
  { family: 'resource', start: '#A9AB45', end: '#EEEF97' },
  { family: 'risk', start: '#DB2777', end: '#F472B6' },
] as const satisfies readonly { family: BarThemeFamily; start: string; end: string }[];

const BAR_THEME_MATCHERS: readonly [BarThemeFamily, RegExp][] = [
  ['energy', /energy|power|electric|kwh|电耗|能耗|电能|鼓风/iu],
  ['resource', /phosph|\btp\b|cost|saving|fee|总磷|费用|成本|节省/iu],
  ['risk', /\bcod\b|carbon|co2|organic|碳|排放|风险/iu],
  ['analytics', /ammonia|nh3|process|氨氮|工艺|分析/iu],
  ['flow', /\bss\b|flow|volume|悬浮物|流量|水量|处理量|吨水/iu],
  ['treatment', /\btn\b|nitrogen|health|总氮|健康|达标/iu],
  ['water', /quality|water|effluent|水质|出水/iu],
];

function stableThemeIndex(value: string): number {
  let hash = 0;
  for (const character of value) hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
  return hash % BAR_THEMES.length;
}

export function barThemeForMetric(metricKey: string, metricLabel: string) {
  const source = `${metricKey} ${metricLabel}`;
  const family = BAR_THEME_MATCHERS.find(([, matcher]) => matcher.test(source))?.[0];
  return family
    ? BAR_THEMES.find((theme) => theme.family === family)!
    : BAR_THEMES[stableThemeIndex(source)]!;
}

export const CHART_THEME = {
  trend: { start: '#21F4B7', end: '#27C8FF', alert: '#FF714D' },
  ring: { start: '#24E4C1', end: '#35A9FF' },
  bars: BAR_THEMES,
  axis: '#8FA8B7',
} as const;
