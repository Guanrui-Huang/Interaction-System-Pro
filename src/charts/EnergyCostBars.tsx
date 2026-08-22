import { useGSAP } from '@gsap/react';
import { scaleBand, scaleLinear, select } from 'd3';
import gsap from 'gsap';
import { useId, useRef } from 'react';
import type { EnergyCostMetric } from '../features/dashboard/energy-periods';
import { formatMoney, formatNumber } from '../features/dashboard/energy-formatters';
import { CHART_THEME } from './chart-theme';

gsap.registerPlugin(useGSAP);

type EnergyBarDatum = {
  series: 'consumption' | 'cost';
  value: number | null;
  unit: string;
  ratio: number | null;
};
type RenderableEnergyBarDatum = EnergyBarDatum & { value: number; ratio: number };

const seriesFor = (item: EnergyCostMetric): EnergyBarDatum[] => [
  { series: 'consumption', ...item.consumption },
  { series: 'cost', ...item.cost },
];
const isRenderableBar = (item: EnergyBarDatum): item is RenderableEnergyBarDatum => item.value !== null && item.ratio !== null;
const labelFor = (item: EnergyBarDatum) => {
  if (item.value === null) return { value: '--', unit: '' };
  if (item.unit !== '元') return { value: formatNumber(item.value), unit: item.unit };
  const [value, unit] = formatMoney(item.value).split(' ');
  return { value, unit };
};

export function EnergyCostBars({ values }: { values: EnergyCostMetric[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const instanceId = useId().replace(/:/g, '');

  useGSAP(() => {
    const svg = select(svgRef.current);
    const width = 900;
    const height = 330;
    const padding = { top: 42, right: 20, bottom: 60, left: 24 };
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('aria-label', '能耗与对应费用柱状图');
    if (!values.length) {
      svg.append('text').attr('x', width / 2).attr('y', height / 2).attr('text-anchor', 'middle').attr('fill', CHART_THEME.axis).attr('font-size', 14).text('当前周期暂无数据');
      return;
    }

    const consumptionGradientId = `energy-consumption-gradient-${instanceId}`;
    const costGradientId = `energy-cost-gradient-${instanceId}`;
    const glowId = `energy-cost-glow-${instanceId}`;
    const defs = svg.append('defs');
    const consumptionGradient = defs.append('linearGradient').attr('id', consumptionGradientId).attr('x1', '0').attr('y1', '1').attr('x2', '0').attr('y2', '0');
    consumptionGradient.append('stop').attr('offset', '0%').attr('stop-color', CHART_THEME.bars[0].start);
    consumptionGradient.append('stop').attr('offset', '100%').attr('stop-color', CHART_THEME.bars[0].end);
    const costGradient = defs.append('linearGradient').attr('id', costGradientId).attr('x1', '0').attr('y1', '1').attr('x2', '0').attr('y2', '0');
    costGradient.append('stop').attr('offset', '0%').attr('stop-color', CHART_THEME.bars[1].start);
    costGradient.append('stop').attr('offset', '100%').attr('stop-color', CHART_THEME.bars[1].end);
    defs.append('filter').attr('id', glowId).attr('x', '-30%').attr('y', '-25%').attr('width', '160%').attr('height', '160%').append('feGaussianBlur').attr('stdDeviation', 3);

    const x = scaleBand().domain(values.map((item) => item.label)).range([padding.left, width - padding.right]).padding(.28);
    const inner = scaleBand().domain(['consumption', 'cost']).range([0, x.bandwidth()]).padding(.2);
    const y = scaleLinear().domain([0, 1]).range([height - padding.bottom, padding.top]);
    const groups = svg.append('g').selectAll('g').data(values).join('g')
      .attr('class', 'energy-cost-group')
      .attr('data-metric', (item) => item.key)
      .attr('transform', (item) => `translate(${x(item.label) ?? 0},0)`);
    const geometry = (item: RenderableEnergyBarDatum) => {
      const ratio = Number.isFinite(item.ratio) ? item.ratio : 0;
      return {
        x: inner(item.series) ?? 0,
        y: y(ratio),
        width: inner.bandwidth(),
        height: height - padding.bottom - y(ratio),
      };
    };

    const glows = groups.selectAll('rect.energy-cost-bar-glow').data((item) => seriesFor(item).filter(isRenderableBar)).join('rect')
      .attr('class', 'energy-cost-bar-glow')
      .attr('data-series', (item) => item.series)
      .attr('x', (item) => geometry(item).x)
      .attr('y', (item) => geometry(item).y)
      .attr('width', (item) => geometry(item).width)
      .attr('height', (item) => geometry(item).height)
      .attr('rx', 5)
      .attr('fill', (item) => `url(#${item.series === 'consumption' ? consumptionGradientId : costGradientId})`)
      .attr('filter', `url(#${glowId})`)
      .attr('opacity', .24);

    const bars = groups.selectAll('rect.energy-cost-bar').data((item) => seriesFor(item).filter(isRenderableBar)).join('rect')
      .attr('class', 'energy-cost-bar')
      .attr('data-series', (item) => item.series)
      .attr('x', (item) => geometry(item).x)
      .attr('y', (item) => geometry(item).y)
      .attr('width', (item) => geometry(item).width)
      .attr('height', (item) => geometry(item).height)
      .attr('rx', 5)
      .attr('fill', (item) => `url(#${item.series === 'consumption' ? consumptionGradientId : costGradientId})`)
      .attr('filter', null);

    const labels = groups.selectAll('text.energy-cost-value').data(seriesFor).join('text')
      .attr('class', (item) => `energy-cost-value energy-cost-value--${item.series}`)
      .attr('data-series', (item) => item.series)
      .attr('x', (item) => (inner(item.series) ?? 0) + inner.bandwidth() / 2)
      .attr('y', (item) => isRenderableBar(item) ? Math.max(18, y(item.ratio) - 24) : 18)
      .attr('text-anchor', 'middle')
      .attr('fill', (item) => item.series === 'consumption' ? '#bdeeff' : '#bfffe9')
      .attr('font-size', 14);
    labels.each(function renderLabel(item) {
      const label = select(this);
      const display = labelFor(item);
      label.selectAll('*').remove();
      label.append('tspan').attr('class', 'energy-cost-value__number').attr('x', label.attr('x')).text(display.value);
      label.append('tspan').attr('class', 'energy-cost-value__unit').attr('x', label.attr('x')).attr('dy', '1.1em').text(display.unit ? ` ${display.unit}` : '');
    });

    values.forEach((item) => {
      const center = (x(item.label) ?? 0) + x.bandwidth() / 2;
      svg.append('text').attr('x', center).attr('y', height - 30).attr('text-anchor', 'middle').attr('fill', '#d7e9f1').attr('font-size', 14).text(item.label);
    });

    const renderFinal = () => {
      glows.attr('transform', null).style('opacity', null).style('visibility', null).style('transform', null).style('transform-origin', null);
      bars.attr('transform', null).style('opacity', null).style('visibility', null).style('transform', null).style('transform-origin', null);
      labels.attr('transform', null).style('opacity', null).style('visibility', null).style('transform', null).style('transform-origin', null);
    };
    if (typeof window.matchMedia !== 'function') {
      renderFinal();
      return undefined;
    }
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: reduce)', renderFinal);
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
      timeline.from([...glows.nodes(), ...bars.nodes()], {
        scaleY: 0,
        transformOrigin: '50% 100%',
        duration: .55,
        stagger: .025,
      }, .35)
        .from(labels.nodes(), { autoAlpha: 0, y: 6, duration: .22 }, .88)
        .eventCallback('onComplete', renderFinal);
      return () => timeline.kill();
    });
    return () => mm.revert();
  }, { scope: svgRef, dependencies: [instanceId, values], revertOnUpdate: true });

  return <svg ref={svgRef} className="d3-chart energy-cost-bars" role="img" aria-label="能耗与对应费用柱状图" />;
}
