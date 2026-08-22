import type { VisualSpec } from '../../../../../shared/report';
import { VisualDataTable, VisualFrame } from './visual-utils';

type AlertSpec = Extract<VisualSpec, { kind: 'alert-timeline' }>;

export function AlertTimelineVisual({ visual }: { visual: AlertSpec }) {
  return (
    <VisualFrame ariaLabel={`告警时间线，共 ${visual.items.length} 条`} table={<VisualDataTable label="告警时间线数据表" rows={visual.items.map((item) => ({ label: `${item.date} ${item.label}`, value: item.level, unit: item.detail }))} />}>
      <ol className="report-alert-timeline">
        {visual.items.map((item) => <li key={item.id}><time>{item.date}</time><span>{item.level}</span><strong>{item.label}</strong></li>)}
      </ol>
    </VisualFrame>
  );
}
