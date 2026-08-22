import type { VisualSpec } from '../../../../../shared/report';
import { formatReportNumber, VisualDataTable, VisualFrame } from './visual-utils';

type KpiGridSpec = Extract<VisualSpec, { kind: 'kpi-grid' }>;

export function KpiGridVisual({ visual }: { visual: KpiGridSpec }) {
  const label = `关键指标：${visual.metrics.map((item) => `${item.label} ${formatReportNumber(item.value)} ${item.unit ?? ''}`.trim()).join('，')}`;
  return (
    <VisualFrame ariaLabel={label} table={<VisualDataTable label="关键指标数据表" rows={visual.metrics.map((item) => ({ label: item.label, value: formatReportNumber(item.value), unit: item.unit }))} />}>
      <div className="report-kpi-grid">
        {visual.metrics.map((item) => (
          <article className="report-kpi" key={item.key}>
            <span>{item.label}</span>
            <strong data-motion-number data-final-value={item.value}>{formatReportNumber(item.value)}</strong>
            <small>{item.unit ?? '—'}</small>
            {item.status && <em>{item.status}</em>}
          </article>
        ))}
      </div>
    </VisualFrame>
  );
}
