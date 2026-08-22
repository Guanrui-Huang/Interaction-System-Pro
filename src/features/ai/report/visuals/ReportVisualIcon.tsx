import type { VisualSpec } from '../../../../../shared/report';

export type ReportVisualIconKind = VisualSpec['kind'] | 'metric';

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

export function ReportVisualIcon({ kind, className = '' }: { kind: ReportVisualIconKind; className?: string }) {
  const family = kind === 'metric' || kind === 'kpi-grid'
    ? 'metric'
    : kind === 'trend-line' || kind === 'trend-area'
      ? 'trend'
      : kind === 'comparison-bars'
        ? 'bars'
        : kind === 'health-ring' || kind === 'radar'
          ? 'score'
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
      {family === 'score' && (
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
