import { arc } from 'd3';
import { useId } from 'react';
import type { VisualSpec } from '../../../../../shared/report';
import { CHART_THEME } from '../../../../charts/chart-theme';
import { formatReportNumber, VisualDataTable, VisualFrame } from './visual-utils';

type HealthSpec = Extract<VisualSpec, { kind: 'health-ring' }>;
const ring = arc().innerRadius(70).outerRadius(86).cornerRadius(8);

export function HealthRingVisual({ visual }: { visual: HealthSpec }) {
  const reactId = useId().replace(/:/g, '');
  const maximum = Math.max(visual.target ?? 100, visual.metric.value, 1);
  const ratio = Math.max(0, Math.min(1, visual.metric.value / maximum));
  const background = ring({ innerRadius: 70, outerRadius: 86, startAngle: 0, endAngle: Math.PI * 2 });
  const foreground = ring({ innerRadius: 70, outerRadius: 86, startAngle: 0, endAngle: Math.PI * 2 * ratio });
  const rows = [{ label: visual.metric.label, value: formatReportNumber(visual.metric.value), unit: visual.metric.unit }];
  if (visual.target !== undefined) rows.push({ label: '目标值', value: formatReportNumber(visual.target), unit: visual.metric.unit });
  const gradientId = `report-ring-gradient-${reactId}`;
  return (
    <VisualFrame ariaLabel={`${visual.metric.label} ${formatReportNumber(visual.metric.value)} ${visual.metric.unit ?? ''}`.trim()} table={<VisualDataTable label={`${visual.metric.label}数据表`} rows={rows} />}>
      <div className="report-health-ring">
        <svg className="report-chart report-chart--ring" viewBox="0 0 220 220" aria-hidden="true">
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor={CHART_THEME.ring.start} />
              <stop offset="100%" stopColor={CHART_THEME.ring.end} />
            </linearGradient>
          </defs>
          <g transform="translate(110 110) rotate(-90)"><path className="report-ring__track" d={background ?? undefined} /><path className="report-ring__value" data-motion-ring d={foreground ?? undefined} fill={`url(#${gradientId})`} /></g>
        </svg>
        <div className="report-health-ring__label"><strong data-motion-number data-final-value={visual.metric.value}>{formatReportNumber(visual.metric.value)}</strong><span>{visual.metric.unit ?? '—'}</span><small>{visual.metric.label}</small></div>
      </div>
    </VisualFrame>
  );
}
