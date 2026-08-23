import type { VisualSpec } from '../../../../../shared/report';

export type ReportVisualIconKind = VisualSpec['kind'] | 'metric';
type ReportVisualIconFamily = 'water' | 'energy' | 'carbon' | 'cost' | 'health' | 'flow' | 'metric' | 'trend' | 'bars' | 'radar' | 'alert' | 'path' | 'map' | 'dashboard';

const METRIC_FAMILIES_BY_KEY: Record<string, ReportVisualIconFamily> = {
  tn: 'water',
  ammonia: 'water',
  tp: 'water',
  cod: 'water',
  ss: 'water',
  compliancerate: 'water',
  qualityscore: 'water',
  totalkwh: 'energy',
  kwhperm3: 'energy',
  blowerkwh: 'energy',
  energyscore: 'energy',
  carbonsourcekg: 'carbon',
  carbonemissionkg: 'carbon',
  carbonreductionkg: 'carbon',
  carbonsourcescore: 'carbon',
  savedyuan: 'cost',
  savedcost: 'cost',
  healthscore: 'health',
  processedm3: 'flow',
  flowscore: 'flow',
};

function normalizeMetricText(value?: string): string {
  return value?.toLocaleLowerCase().replace(/[\s\-_[\]{}()（）,，./]/g, '') ?? '';
}

function semanticMetricFamily(metricKey?: string, metricLabel?: string): ReportVisualIconFamily {
  const keyFamily = METRIC_FAMILIES_BY_KEY[normalizeMetricText(metricKey)];
  if (keyFamily) return keyFamily;

  const label = normalizeMetricText(metricLabel);
  if (['总氮', '氨氮', '总磷', '水质', '达标', 'cod', 'ss'].some((token) => label.includes(token))) return 'water';
  if (['碳源', '碳排放', '碳减排', '碳'].some((token) => label.includes(token))) return 'carbon';
  if (['能耗', '电耗', '耗电', '能源', 'kwh'].some((token) => label.includes(token))) return 'energy';
  if (['费用', '成本', '金额', '节省', '收益'].some((token) => label.includes(token))) return 'cost';
  if (['健康', '运行状态'].some((token) => label.includes(token))) return 'health';
  if (['流量', '水量', '处理量'].some((token) => label.includes(token))) return 'flow';
  return 'metric';
}

export function reportVisualLabel(kind: ReportVisualIconKind): string {
  switch (kind) {
    case 'metric':
      return '关键指标';
    case 'data-dashboard':
      return '综合分析';
    case 'trend-line':
    case 'trend-area':
      return '运行趋势';
    case 'comparison-bars':
      return '指标对比';
    case 'health-ring':
      return '健康度';
    case 'radar':
      return '多维评分';
    case 'scatter':
      return '关联分布';
    case 'alert-timeline':
      return '告警时间线';
    case 'process-flow':
      return '处理流程';
    case 'recommendation-path':
      return '建议路径';
    case 'concept-map':
      return '概念关系';
    case 'capability-map':
      return '能力地图';
    case 'kpi-grid':
      return '指标总览';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function ReportVisualIcon({ kind, metricKey, metricLabel, className = '' }: { kind: ReportVisualIconKind; metricKey?: string; metricLabel?: string; className?: string }) {
  const family: ReportVisualIconFamily = kind === 'metric'
    ? semanticMetricFamily(metricKey, metricLabel)
    : kind === 'kpi-grid'
      ? 'metric'
    : kind === 'trend-line' || kind === 'trend-area'
      ? 'trend'
      : kind === 'comparison-bars'
        ? 'bars'
        : kind === 'health-ring'
          ? 'health'
          : kind === 'radar'
            ? 'radar'
          : kind === 'alert-timeline'
            ? 'alert'
            : kind === 'process-flow' || kind === 'recommendation-path'
              ? 'path'
              : kind === 'concept-map' || kind === 'capability-map'
                ? 'map'
                : 'dashboard';

  return (
    <svg
      className={`report-visual-icon ${className}`.trim()}
      data-icon-kind={kind}
      data-icon-family={family}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {family === 'metric' && (
        <>
          <path d="M5 19V9M12 19V5M19 19v-7" />
          <path d="M3 19h18" />
        </>
      )}
      {family === 'water' && (
        <>
          <path d="M12 3.5c-2.8 3.6-5 6.3-5 9a5 5 0 0 0 10 0c0-2.7-2.2-5.4-5-9Z" />
          <path d="M9.5 14a2.7 2.7 0 0 0 2.5 1.8" />
        </>
      )}
      {family === 'energy' && <path d="m13.5 2.8-7 10.1h4.8l-.8 8.3 7-10.2h-4.8l.8-8.2Z" />}
      {family === 'carbon' && (
        <>
          <path d="M12 20V10" />
          <path d="M12 13c-4.8 0-6.5-3.1-6.5-6.2C9.8 6.8 12 9.3 12 13Z" />
          <path d="M12 16c4.2 0 6.5-2.6 6.5-6.2-4.1.1-6.5 2.3-6.5 6.2Z" />
        </>
      )}
      {family === 'cost' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="m9 8 6 8M15 8l-6 8M8.2 10.5h7.6M8.2 13.5h7.6" />
        </>
      )}
      {family === 'health' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 12 17 8M8 17h8" />
        </>
      )}
      {family === 'flow' && (
        <>
          <path d="M4 8c2.2 0 2.2 2 4.4 2S10.6 8 12.8 8s2.2 2 4.4 2S19.4 8 21 8" />
          <path d="M4 14c2.2 0 2.2 2 4.4 2s2.2-2 4.4-2 2.2 2 4.4 2 2.2-2 3.8-2" />
        </>
      )}
      {family === 'trend' && (
        <>
          <path d="m4 17 5-5 4 3 7-8" />
          <path d="M16 7h4v4" />
        </>
      )}
      {family === 'bars' && (
        <>
          <rect x="4" y="12" width="3" height="7" rx="1" />
          <rect x="10.5" y="8" width="3" height="11" rx="1" />
          <rect x="17" y="4" width="3" height="15" rx="1" />
        </>
      )}
      {family === 'radar' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 12 17 8M8 17h8" />
        </>
      )}
      {family === 'alert' && (
        <>
          <path d="M12 4 3.8 19h16.4L12 4Z" />
          <path d="M12 9v4M12 16h.01" />
        </>
      )}
      {family === 'path' && (
        <>
          <circle cx="5" cy="6" r="2" />
          <circle cx="19" cy="18" r="2" />
          <path d="M7 6h4a3 3 0 0 1 3 3v6a3 3 0 0 0 3 3" />
        </>
      )}
      {family === 'map' && (
        <>
          <circle cx="6" cy="7" r="2" />
          <circle cx="18" cy="7" r="2" />
          <circle cx="12" cy="18" r="2" />
          <path d="m8 8 3 8M16 8l-3 8M8 7h8" />
        </>
      )}
      {family === 'dashboard' && (
        <>
          <rect x="4" y="4" width="7" height="7" rx="1" />
          <rect x="13" y="4" width="7" height="4" rx="1" />
          <rect x="4" y="13" width="7" height="7" rx="1" />
          <rect x="13" y="10" width="7" height="10" rx="1" />
        </>
      )}
    </svg>
  );
}
