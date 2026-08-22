import { extent, scaleLinear } from 'd3';
import type { VisualSpec } from '../../../../../shared/report';
import { formatReportNumber, VisualDataTable, VisualFrame } from './visual-utils';

type ScatterSpec = Extract<VisualSpec, { kind: 'scatter' }>;
const WIDTH = 640;
const HEIGHT = 260;

function paddedDomain(values: number[]): [number, number] {
  const [low = 0, high = 1] = extent(values);
  const span = high - low || Math.abs(high || 1) * .2;
  return [low - span * .12, high + span * .12];
}

export function ScatterVisual({ visual }: { visual: ScatterSpec }) {
  const x = scaleLinear().domain(paddedDomain(visual.points.map((point) => point.x))).nice().range([58, WIDTH - 28]);
  const y = scaleLinear().domain(paddedDomain(visual.points.map((point) => point.y))).nice().range([HEIGHT - 48, 22]);
  return (
    <VisualFrame ariaLabel={`${visual.x.label}与${visual.y.label}散点关系`} table={<VisualDataTable label="散点数据表" rows={visual.points.flatMap((point) => [{ label: `${point.label} ${visual.x.label}`, value: formatReportNumber(point.x), unit: visual.x.unit }, { label: `${point.label} ${visual.y.label}`, value: formatReportNumber(point.y), unit: visual.y.unit }])} />}>
      <div className="report-scatter">
        <svg className="report-chart report-chart--scatter" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
          {x.ticks(5).map((tick) => <g key={`x-${tick}`}><line className="report-chart__grid" x1={x(tick)} x2={x(tick)} y1="22" y2={HEIGHT - 48} /><text className="report-chart__axis-label" x={x(tick)} y={HEIGHT - 23} textAnchor="middle">{formatReportNumber(tick)}</text></g>)}
          {y.ticks(4).map((tick) => <g key={`y-${tick}`}><line className="report-chart__grid" x1="58" x2={WIDTH - 28} y1={y(tick)} y2={y(tick)} /><text className="report-chart__axis-label" x="49" y={y(tick) + 4} textAnchor="end">{formatReportNumber(tick)}</text></g>)}
          {visual.points.map((point) => <circle className="report-scatter__point" key={point.label} cx={x(point.x)} cy={y(point.y)} r="7"><title>{`${point.label}：${visual.x.label} ${point.x}，${visual.y.label} ${point.y}`}</title></circle>)}
        </svg>
        <p className="report-scatter__caveat">{visual.caveat}</p>
      </div>
    </VisualFrame>
  );
}
