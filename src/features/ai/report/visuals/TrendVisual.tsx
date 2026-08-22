import { area, curveMonotoneX, extent, line, scaleLinear, scalePoint } from 'd3';
import { useId } from 'react';
import type { BoundSeries, VisualSpec } from '../../../../../shared/report';
import { CHART_THEME } from '../../../../charts/chart-theme';
import { formatReportNumber, VisualDataTable, VisualFrame } from './visual-utils';

type TrendSpec = Extract<VisualSpec, { kind: 'trend-line' | 'trend-area' }>;
const WIDTH = 640;
const HEIGHT = 260;
const PAD = { top: 22, right: 22, bottom: 36, left: 48 };

function paletteForSeries(index: number) {
  return index === 0
    ? CHART_THEME.trend
    : CHART_THEME.bars[(index - 1) % CHART_THEME.bars.length]!;
}

function allValues(series: BoundSeries[]): number[] {
  return series.flatMap((item) => item.points.map((point) => point.value));
}

export function TrendVisual({ visual }: { visual: TrendSpec }) {
  const reactId = useId().replace(/:/g, '');
  const clipId = `report-trend-clip-${reactId}`;
  const labels = [...new Set(visual.series.flatMap((item) => item.points.map((point) => point.label)))];
  const x = scalePoint<string>().domain(labels).range([PAD.left, WIDTH - PAD.right]);
  const domain = extent(allValues(visual.series));
  const low = domain[0] ?? 0;
  const high = domain[1] ?? low + 1;
  const margin = Math.max((high - low) * .12, Math.abs(high || 1) * .04);
  const y = scaleLinear().domain([low - margin, high + margin]).nice().range([HEIGHT - PAD.bottom, PAD.top]);
  const linePath = line<{ label: string; value: number }>()
    .x((point) => x(point.label) ?? PAD.left)
    .y((point) => y(point.value))
    .curve(curveMonotoneX);
  const areaPath = area<{ label: string; value: number }>()
    .x((point) => x(point.label) ?? PAD.left)
    .y0(HEIGHT - PAD.bottom)
    .y1((point) => y(point.value))
    .curve(curveMonotoneX);
  const ariaLabel = `${visual.kind === 'trend-area' ? '面积趋势' : '折线趋势'}：${visual.series.map((item) => item.label).join('、')}`;
  const tableRows = visual.series.flatMap((item) => item.points.map((point) => ({ label: `${item.label} ${point.label}`, value: formatReportNumber(point.value), unit: item.unit })));

  return (
    <VisualFrame ariaLabel={ariaLabel} table={<VisualDataTable label={`${visual.series.map((item) => item.label).join('、')}数据表`} rows={tableRows} />}>
      {visual.series.length > 1 && (
        <ul className="report-trend__legend" aria-label="趋势序列图例">
          {visual.series.map((item, index) => {
            const palette = paletteForSeries(index);
            return (
              <li key={`${item.key}-legend`}>
                <span
                  className="report-trend__legend-swatch"
                  style={{ backgroundImage: `linear-gradient(90deg, ${palette.start}, ${palette.end})` }}
                  aria-hidden="true"
                />
                <span>{item.label}</span>
                <small>{item.unit}</small>
              </li>
            );
          })}
        </ul>
      )}
      <svg className="report-chart report-chart--trend" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
        <defs>
          <clipPath id={clipId}><rect data-motion-reveal x={PAD.left} y="0" width={WIDTH - PAD.left - PAD.right} height={HEIGHT} /></clipPath>
          {visual.series.map((item, index) => {
            const lineId = `report-trend-line-${reactId}-${index}`;
            const fillId = `report-trend-fill-${reactId}-${index}`;
            const palette = paletteForSeries(index);
            return (
              <g key={`${item.key}-defs`}>
                <linearGradient id={lineId} x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor={palette.start} />
                  <stop offset="100%" stopColor={palette.end} />
                </linearGradient>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={palette.start} stopOpacity=".35" />
                  <stop offset="1" stopColor={palette.end} stopOpacity="0" />
                </linearGradient>
              </g>
            );
          })}
        </defs>
        {y.ticks(4).map((tick) => <g key={tick}><line className="report-chart__grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} /><text className="report-chart__axis-label" x={PAD.left - 9} y={y(tick) + 4} textAnchor="end">{formatReportNumber(tick)}</text></g>)}
        {labels.map((label, index) => (index === 0 || index === labels.length - 1 || index === Math.floor(labels.length / 2)) && <text key={label} className="report-chart__axis-label" x={x(label)} y={HEIGHT - 10} textAnchor={index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'}>{label}</text>)}
        <g clipPath={`url(#${clipId})`}>
          {visual.series.map((item, index) => {
            const lineId = `report-trend-line-${reactId}-${index}`;
            const fillId = `report-trend-fill-${reactId}-${index}`;
            const palette = paletteForSeries(index);
            return <g key={item.key}>
            {visual.kind === 'trend-area' && <path className="report-chart__area" d={areaPath(item.points) ?? undefined} fill={`url(#${fillId})`} opacity={1 - index * .18} />}
            <path className="report-chart__line" data-motion-line d={linePath(item.points) ?? undefined} stroke={`url(#${lineId})`} />
            {item.points.map((point) => <circle className="report-chart__point" key={point.label} cx={x(point.label)} cy={y(point.value)} r="4" fill={palette.end} stroke={palette.start} />)}
          </g>;
          })}
        </g>
      </svg>
    </VisualFrame>
  );
}
