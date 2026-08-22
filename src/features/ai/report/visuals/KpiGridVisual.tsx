import type { CSSProperties } from 'react';
import type { VisualSpec } from '../../../../../shared/report';
import { ReportVisualIcon } from './ReportVisualIcon';
import { formatReportNumber, VisualDataTable, VisualFrame } from './visual-utils';

type KpiGridSpec = Extract<VisualSpec, { kind: 'kpi-grid' }>;

export function KpiGridVisual({ visual }: { visual: KpiGridSpec }) {
  const label = `关键指标：${visual.metrics.map((item) => `${item.label} ${formatReportNumber(item.value)} ${item.unit ?? ''}`.trim()).join('，')}`;
  const columns = Math.min(Math.max(visual.metrics.length, 1), 4);
  const gridStyle = {
    '--report-kpi-columns': String(columns),
  } as CSSProperties & { '--report-kpi-columns': string };

  return (
    <VisualFrame ariaLabel={label} table={<VisualDataTable label="关键指标数据表" rows={visual.metrics.map((item) => ({ label: item.label, value: formatReportNumber(item.value), unit: item.unit }))} />}>
      <div className="report-kpi-grid" style={gridStyle}>
        {visual.metrics.map((item) => (
          <article className="report-kpi" key={item.key}>
            <span className="report-kpi__label">
              <ReportVisualIcon kind="metric" />
              <span>{item.label}</span>
            </span>
            <strong data-motion-number data-final-value={item.value}>{formatReportNumber(item.value)}</strong>
            <small>{item.unit ?? '—'}</small>
            {item.status && <em>{item.status}</em>}
          </article>
        ))}
      </div>
    </VisualFrame>
  );
}
