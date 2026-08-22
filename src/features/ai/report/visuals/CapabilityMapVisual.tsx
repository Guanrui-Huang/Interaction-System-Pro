import type { VisualSpec } from '../../../../../shared/report';
import type { VisualMode } from './VisualRenderer';
import { VisualDataTable, VisualFrame } from './visual-utils';

type CapabilityMapSpec = Extract<VisualSpec, { kind: 'capability-map' }>;

export function CapabilityMapVisual({ visual, mode }: { visual: CapabilityMapSpec; mode: VisualMode }) {
  return (
    <VisualFrame ariaLabel={`能力地图：${visual.items.map((item) => item.title).join('、')}`} table={<VisualDataTable label="能力地图数据表" rows={visual.items.map((item) => ({ label: item.title, value: item.detail }))} />}>
      <div className={`report-capability-map report-capability-map--${mode}`}>
        {visual.items.map((item) => <article className="report-capability-map__item" key={item.id}><strong>{item.title}</strong><p>{item.detail}</p></article>)}
      </div>
    </VisualFrame>
  );
}
