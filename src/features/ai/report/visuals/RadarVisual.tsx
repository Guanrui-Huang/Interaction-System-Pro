import { curveLinearClosed, lineRadial, scaleLinear } from 'd3';
import type { VisualSpec } from '../../../../../shared/report';
import { formatReportNumber, VisualDataTable, VisualFrame } from './visual-utils';

type RadarSpec = Extract<VisualSpec, { kind: 'radar' }>;
const SIZE = 360;
const CENTER = SIZE / 2;
const RADIUS = 138;
const LABEL_RADIUS = 1.18;
const LABEL_EDGE_INSET = 18;

function getRadarLabelPlacement(index: number, axesLength: number) {
  const angle = index * Math.PI * 2 / axesLength;
  const x = CENTER + Math.sin(angle) * RADIUS * LABEL_RADIUS;
  const y = CENTER - Math.cos(angle) * RADIUS * LABEL_RADIUS;
  if (x >= SIZE - LABEL_EDGE_INSET) return { x: SIZE - LABEL_EDGE_INSET, y, textAnchor: 'end' as const };
  if (x <= LABEL_EDGE_INSET) return { x: LABEL_EDGE_INSET, y, textAnchor: 'start' as const };
  return { x, y, textAnchor: 'middle' as const };
}

export function RadarVisual({ visual }: { visual: RadarSpec }) {
  const angle = (index: number) => index * Math.PI * 2 / visual.axes.length;
  const point = (index: number, ratio: number) => ({ x: CENTER + Math.sin(angle(index)) * RADIUS * ratio, y: CENTER - Math.cos(angle(index)) * RADIUS * ratio });
  const data = visual.axes.map((axis, index) => ({ angle: angle(index), radius: scaleLinear().domain([0, axis.maximum || 1]).range([0, RADIUS])(axis.value) }));
  const path = lineRadial<{ angle: number; radius: number }>()
    .angle((item) => item.angle)
    .radius((item) => item.radius)
    .curve(curveLinearClosed);
  return (
    <VisualFrame ariaLabel={`运行维度雷达：${visual.axes.map((axis) => `${axis.label} ${formatReportNumber(axis.value)}`).join('，')}`} table={<VisualDataTable label="运行维度数据表" rows={visual.axes.map((axis) => ({ label: axis.label, value: formatReportNumber(axis.value), unit: axis.unit }))} />}>
      <svg className="report-chart report-chart--radar" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        {[.25, .5, .75, 1].map((level) => <polygon key={level} className="report-radar__grid" points={visual.axes.map((_axis, index) => { const p = point(index, level); return `${p.x},${p.y}`; }).join(' ')} />)}
        {visual.axes.map((axis, index) => {
          const end = point(index, 1);
          const label = getRadarLabelPlacement(index, visual.axes.length);
          return <g key={axis.key}><line className="report-radar__spoke" x1={CENTER} y1={CENTER} x2={end.x} y2={end.y} /><text className="report-chart__axis-label" x={label.x} y={label.y} textAnchor={label.textAnchor}>{axis.label}</text></g>;
        })}
        <g transform={`translate(${CENTER} ${CENTER})`}><path className="report-radar__shape" d={path(data) ?? undefined} />{data.map((item, index) => <circle className="report-chart__point" key={visual.axes[index]?.key} cx={Math.sin(item.angle) * item.radius} cy={-Math.cos(item.angle) * item.radius} r="4" />)}</g>
      </svg>
    </VisualFrame>
  );
}
