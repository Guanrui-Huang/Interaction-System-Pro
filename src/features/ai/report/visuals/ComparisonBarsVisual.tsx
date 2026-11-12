import { scaleBand, scaleLinear } from 'd3';
import { useId } from 'react';
import type { VisualSpec } from '../../../../../shared/report';
import { WPHI_DIMENSIONS } from '../../../../../shared/wphi';
import { useReportChartThemes } from './ReportChartThemeContext';
import { formatReportNumber, VisualDataTable, VisualFrame } from './visual-utils';

type ComparisonSpec = Extract<VisualSpec, { kind: 'comparison-bars' }>;
const WIDTH = 720;
const HEIGHT = 320;
const PLOT = { left: 52, right: 28, top: 34, bottom: 54 };
const wphiLabels: Record<string, string> = Object.fromEntries(Object.entries(WPHI_DIMENSIONS).map(([key,label]) => [`${key}Score`,label]));

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
  const glowFilterId = `report-comparison-glow-${reactId}`;
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
          <filter
            id={glowFilterId}
            x="-50%"
            y="-30%"
            width="200%"
            height="160%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur in="SourceGraphic" stdDeviation="4.5" />
          </filter>
        </defs>
        <line className="report-chart__baseline" x1={PLOT.left} x2={WIDTH - PLOT.right} y1={zeroY} y2={zeroY} />
        {visual.items.map((item, index) => {
          const barY = y(item.value);
          const top = Math.min(barY, zeroY);
          const barX = x(item.key);
          const barHeight = Math.abs(barY - zeroY);
          const theme = barThemes[index]!;
          return (
            <g key={item.key}>
              <rect
                className="report-chart__bar-glow"
                aria-hidden="true"
                x={barX}
                y={top}
                width={x.bandwidth()}
                height={barHeight}
                fill={theme.end}
                filter={`url(#${glowFilterId})`}
              />
              <rect
                className="report-chart__bar"
                data-motion-bar
                data-metric-key={item.key}
                data-bar-theme={theme.family}
                x={barX}
                y={top}
                width={x.bandwidth()}
                height={barHeight}
                fill={`url(#${gradientIds[index]})`}
              />
              <text
                className="report-chart__value"
                x={(barX ?? 0) + x.bandwidth() / 2}
                y={item.value >= 0 ? top - 10 : barY + 18}
                textAnchor="middle"
              >
                {formatReportNumber(item.value)}
              </text>
              <text
                className="report-chart__axis-label"
                x={(barX ?? 0) + x.bandwidth() / 2}
                y={HEIGHT - 20}
                textAnchor="middle"
              >
                {wphiLabels[item.key] ?? item.label}
              </text>
            </g>
          );
        })}
      </svg>
    </VisualFrame>
  );
}
