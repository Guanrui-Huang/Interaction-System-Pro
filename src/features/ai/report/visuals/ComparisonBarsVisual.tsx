import { scaleBand, scaleLinear } from 'd3';
import { useId } from 'react';
import type { VisualSpec } from '../../../../../shared/report';
import { useReportChartThemes } from './ReportChartThemeContext';
import { formatReportNumber, VisualDataTable, VisualFrame } from './visual-utils';

type ComparisonSpec = Extract<VisualSpec, { kind: 'comparison-bars' }>;
const WIDTH = 720;
const HEIGHT = 320;
const PLOT = { left: 52, right: 28, top: 34, bottom: 54 };

export function ComparisonBarsVisual({ visual }: { visual: ComparisonSpec }) {
  const reactId = useId().replace(/:/g, '');
  const bandPadding = visual.items.length <= 4 ? .28 : .18;
  const barThemes = useReportChartThemes(visual.items);
  const x = scaleBand()
    .domain(visual.items.map((item) => item.key))
    .range([PLOT.left, WIDTH - PLOT.right])
    .padding(bandPadding);
  const values = visual.items.map((item) => item.value);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const y = scaleLinear().domain(minimum === maximum ? [minimum, minimum + 1] : [minimum, maximum]).nice().range([HEIGHT - PLOT.bottom, PLOT.top]);
  const zeroY = y(0);
  const gradientIds = barThemes.map((_, index) => `report-comparison-bar-${reactId}-${index}`);
  return (
    <VisualFrame
      ariaLabel={`指标对比：${visual.items.map((item) => `${item.label} ${formatReportNumber(item.value)}`).join('，')}`}
      table={<VisualDataTable label="指标对比数据表" rows={visual.items.map((item) => ({ label: item.label, value: formatReportNumber(item.value), unit: item.unit }))} />}
    >
      <svg className="report-chart report-chart--bars" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
        <defs>
          {barThemes.map((gradient, index) => (
            <linearGradient key={gradientIds[index]} id={gradientIds[index]} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor={gradient.start} />
              <stop offset="100%" stopColor={gradient.end} />
            </linearGradient>
          ))}
        </defs>
        <line className="report-chart__baseline" x1={PLOT.left} x2={WIDTH - PLOT.right} y1={zeroY} y2={zeroY} />
        {visual.items.map((item, index) => {
          const barY = y(item.value);
          const top = Math.min(barY, zeroY);
          return <g key={item.key}><rect className="report-chart__bar" data-motion-bar data-metric-key={item.key} data-bar-theme={barThemes[index]!.family} x={x(item.key)} y={top} width={x.bandwidth()} height={Math.abs(barY - zeroY)} fill={`url(#${gradientIds[index]})`} /><text className="report-chart__value" x={(x(item.key) ?? 0) + x.bandwidth() / 2} y={item.value >= 0 ? top - 10 : barY + 18} textAnchor="middle">{formatReportNumber(item.value)}</text><text className="report-chart__axis-label" x={(x(item.key) ?? 0) + x.bandwidth() / 2} y={HEIGHT - 20} textAnchor="middle">{item.label}</text></g>;
        })}
      </svg>
    </VisualFrame>
  );
}
