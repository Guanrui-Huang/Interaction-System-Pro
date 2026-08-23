import { curveLinearClosed, lineRadial, scaleLinear } from 'd3';
import type { VisualSpec } from '../../../../../shared/report';
import { formatReportNumber, VisualDataTable, VisualFrame } from './visual-utils';

type RadarSpec = Extract<VisualSpec, { kind: 'radar' }>;
const SIZE = 360;
const CENTER = SIZE / 2;
const RADIUS = 138;
const LABEL_RADIUS = 1.18;
const LABEL_EDGE_INSET = 18;

function radarLabelPlacement(index: number, axesLength: number) {
  const angle = index * Math.PI * 2 / axesLength;
  const x = CENTER + Math.sin(angle) * RADIUS * LABEL_RADIUS;
  const y = CENTER - Math.cos(angle) * RADIUS * LABEL_RADIUS;
  const safeX = Math.max(LABEL_EDGE_INSET, Math.min(SIZE - LABEL_EDGE_INSET, x));
  const horizontal = Math.sin(angle);
  if (horizontal > .22) return { x: safeX, y, textAnchor: 'end' as const };
  if (horizontal < -.22) return { x: safeX, y, textAnchor: 'start' as const };
  return { x: safeX, y, textAnchor: 'middle' as const };
}

export function emphasizeRadarRatios(
  axes: readonly Pick<RadarSpec['axes'][number], 'value' | 'maximum'>[],
  factor = 1.8,
) {
  const ratios = axes.map(({ value, maximum }) => Math.max(0, Math.min(1, value / Math.max(maximum, 1))));
  const mean = ratios.reduce((sum, value) => sum + value, 0) / Math.max(ratios.length, 1);
  return ratios.map((ratio) => Math.max(0, Math.min(1, mean + (ratio - mean) * factor)));
}

export function RadarVisual({ visual }: { visual: RadarSpec }) {
  const angle = (index: number) => index * Math.PI * 2 / visual.axes.length;
  const point = (index: number, ratio: number) => ({ x: CENTER + Math.sin(angle(index)) * RADIUS * ratio, y: CENTER - Math.cos(angle(index)) * RADIUS * ratio });
  const emphasizedRatios = emphasizeRadarRatios(visual.axes);
  const data = visual.axes.map((axis, index) => ({
    angle: angle(index),
    radius: scaleLinear().domain([0, 1]).range([0, RADIUS])(emphasizedRatios[index] ?? 0),
    originalValue: axis.value,
    originalRatio: Math.max(0, Math.min(1, axis.value / Math.max(axis.maximum || 1, 1))),
    emphasizedRatio: emphasizedRatios[index] ?? 0,
  }));
  const path = lineRadial<{ angle: number; radius: number }>()
    .angle((item) => item.angle)
    .radius((item) => item.radius)
    .curve(curveLinearClosed);
  return (
    <VisualFrame ariaLabel={`运行维度雷达：${visual.axes.map((axis) => `${axis.label} ${formatReportNumber(axis.value)}`).join('，')}`} table={<VisualDataTable label="运行维度数据表" rows={visual.axes.map((axis) => ({ label: axis.label, value: formatReportNumber(axis.value), unit: axis.unit }))} />}>
      <svg className="report-chart report-chart--radar" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        {[.25, .5, .75, 1].map((level) => <polygon key={level} className="report-radar__grid" points={visual.axes.map((_axis, index) => { const p = point(index, level); return `${p.x},${p.y}`; }).join(' ')} />)}
        {visual.axes.map((axis, index) => {
          const outer = point(index, 1);
          const label = radarLabelPlacement(index, visual.axes.length);
          const value = point(index, emphasizedRatios[index] ?? 0);
          return (
            <g key={axis.key}>
              <line className="report-radar__spoke" x1={CENTER} y1={CENTER} x2={outer.x} y2={outer.y} />
              <text className="report-chart__axis-label" x={label.x} y={label.y} textAnchor={label.textAnchor}>{axis.label}</text>
              <text className="report-radar__axis-value" x={value.x} y={value.y - 8} textAnchor={label.textAnchor}>
                {formatReportNumber(axis.value)} {axis.unit}
              </text>
            </g>
          );
        })}
        <g transform={`translate(${CENTER} ${CENTER})`}>
          <path className="report-radar__shape" d={path(data) ?? undefined} />
          {data.map((item, index) => (
            <circle
              className="report-chart__point"
              key={visual.axes[index]?.key}
              cx={Math.sin(item.angle) * item.radius}
              cy={-Math.cos(item.angle) * item.radius}
              r="4"
              data-axis-value={item.originalValue}
              data-axis-ratio={item.originalRatio.toFixed(4)}
              data-axis-emphasized-ratio={item.emphasizedRatio.toFixed(4)}
            />
          ))}
        </g>
      </svg>
    </VisualFrame>
  );
}
