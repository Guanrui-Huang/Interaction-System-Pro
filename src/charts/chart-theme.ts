export type BarThemeFamily =
  | 'water'
  | 'treatment'
  | 'flow'
  | 'energy'
  | 'analytics'
  | 'resource'
  | 'risk'
  | 'signal';

export type OverflowBarThemeFamily = `${BarThemeFamily}-${number}`;

export type BarTheme = {
  family: BarThemeFamily | OverflowBarThemeFamily;
  start: string;
  end: string;
};

export type ChartMetricIdentity = {
  key: string;
  label: string;
};

const BAR_THEMES = [
  { family: 'water', start: '#1689DC', end: '#2CE4F5' },
  { family: 'treatment', start: '#19BFA0', end: '#42F0C7' },
  { family: 'flow', start: '#0A9FA8', end: '#47D9D1' },
  { family: 'energy', start: '#1454A6', end: '#2B8CF0' },
  { family: 'analytics', start: '#6B2FB2', end: '#AA56F0' },
  { family: 'resource', start: '#A9AB45', end: '#EEEF97' },
  { family: 'risk', start: '#DB2777', end: '#F472B6' },
  { family: 'signal', start: '#C94B31', end: '#FF714D' },
] as const satisfies readonly BarTheme[];

const BAR_THEME_MATCHERS: readonly [BarThemeFamily, RegExp][] = [
  ['signal', /alert|warning|signal|异常|告警|预警/iu],
  ['energy', /energy|power|electric|kwh|电耗|能耗|电能|鼓风/iu],
  ['resource', /phosph|\btp\b|cost|saving|fee|总磷|费用|成本|节省/iu],
  ['risk', /\bcod\b|carbon|co2|organic|碳|排放|风险/iu],
  ['analytics', /ammonia|nh3|process|氨氮|工艺|分析/iu],
  ['flow', /\bss\b|flow|volume|悬浮物|流量|水量|处理量|吨水/iu],
  ['treatment', /\btn\b|nitrogen|health|总氮|健康|达标/iu],
  ['water', /quality|water|effluent|水质|出水/iu],
];

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function shiftHexColor(hex: string, offset: number): string {
  const normalized = hex.replace('#', '');
  const channels = [0, 2, 4].map((index) => clampChannel(parseInt(normalized.slice(index, index + 2), 16) + offset));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function overflowThemeAt(index: number): BarTheme {
  const baseTheme = BAR_THEMES[index % BAR_THEMES.length]!;
  const cycle = Math.floor(index / BAR_THEMES.length);
  const offset = cycle * 18;
  return {
    family: `${baseTheme.family}-${cycle + 1}` as OverflowBarThemeFamily,
    start: shiftHexColor(baseTheme.start, offset),
    end: shiftHexColor(baseTheme.end, offset),
  };
}

function orderedThemeAt(index: number): BarTheme {
  return BAR_THEMES[index] ?? overflowThemeAt(index);
}

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

export function chartThemesForMetrics(metrics: readonly ChartMetricIdentity[]) {
  const themes = new Map<string, BarTheme>();
  for (const metric of metrics) {
    if (themes.has(metric.key)) continue;
    themes.set(metric.key, orderedThemeAt(themes.size));
  }
  return themes;
}

export const CHART_THEME = {
  trend: { start: '#21F4B7', end: '#27C8FF', alert: '#FF714D' },
  ring: { start: '#24E4C1', end: '#35A9FF' },
  bars: BAR_THEMES,
  axis: '#8FA8B7',
} as const;
