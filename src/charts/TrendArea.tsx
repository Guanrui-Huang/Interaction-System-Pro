import { useGSAP } from '@gsap/react';
import { area, curveMonotoneX, extent, line, scaleLinear, scaleTime, select, timeFormat } from 'd3';
import gsap from 'gsap';
import { useId, useRef } from 'react';
import { CHART_THEME } from './chart-theme';

gsap.registerPlugin(useGSAP);

export type TrendPoint = { date: string };
export type TrendMetric<T extends TrendPoint> = { label: string; unit: string; value: (point: T) => number; threshold?: number; color?: string };

export function TrendArea<T extends TrendPoint>({ points, metric, ariaLabel, layout = 'wide' }: {
  points: T[];
  metric: TrendMetric<T>;
  ariaLabel?: string;
  layout?: 'wide' | 'panel';
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const instanceId = useId().replace(/:/g, '');
  const label = ariaLabel ?? `${metric.label}趋势图`;

  useGSAP(() => {
    const svg = select(svgRef.current);
    const width = 1000;
    const height = layout === 'panel' ? 500 : 340;
    const padding = layout === 'panel'
      ? { top: 22, right: 18, bottom: 40, left: 88 }
      : { top: 18, right: 16, bottom: 34, left: 42 };
    const data = points.map((point) => ({ ...point, time: new Date(`${point.date}T00:00:00`) })).filter((point) => Number.isFinite(metric.value(point)) && !Number.isNaN(point.time.getTime()));
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('data-layout', layout).attr('preserveAspectRatio', layout === 'wide' ? 'none' : 'xMidYMid meet').attr('role', 'img').attr('aria-label', label);
    if (!data.length) { svg.append('text').attr('x', width / 2).attr('y', height / 2).attr('text-anchor', 'middle').attr('fill', CHART_THEME.axis).attr('font-size', 14).text('暂无有效趋势数据'); return; }
    const values = data.map(metric.value);
    const domainValues = metric.threshold === undefined ? values : [...values, metric.threshold];
    const [minValue = 0, maxValue = 1] = extent(domainValues);
    const yPadding = Math.max((maxValue - minValue) * .35, 1);
    const x = scaleTime().domain(extent(data, (item) => item.time) as [Date, Date]).range([padding.left, width - padding.right]);
    const y = scaleLinear().domain([Math.max(0, minValue - yPadding), maxValue + yPadding]).nice().range([height - padding.bottom, padding.top]);
    const lineGradientId = `trend-line-gradient-${instanceId}`;
    const areaGradientId = `trend-area-gradient-${instanceId}`;
    const glowId = `trend-glow-filter-${instanceId}`;
    const revealId = `trend-reveal-${instanceId}`;
    const primaryColor = metric.color ?? CHART_THEME.trend.start;
    const secondaryColor = metric.color ?? CHART_THEME.trend.end;
    const defs = svg.append('defs');
    defs.append('linearGradient').attr('id', lineGradientId).attr('x1', '0%').attr('y1', '0%').attr('x2', '100%').attr('y2', '0%')
      .selectAll('stop').data([{ offset: '0%', color: primaryColor }, { offset: '100%', color: secondaryColor }]).join('stop')
      .attr('offset', (item) => item.offset).attr('stop-color', (item) => item.color);
    const areaGradient = defs.append('linearGradient').attr('id', areaGradientId).attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
    areaGradient.append('stop').attr('offset', '0%').attr('stop-color', primaryColor).attr('stop-opacity', .32);
    areaGradient.append('stop').attr('offset', '100%').attr('stop-color', secondaryColor).attr('stop-opacity', 0);
    defs.append('filter').attr('id', glowId).attr('x', '-20%').attr('y', '-30%').attr('width', '140%').attr('height', '160%')
      .append('feGaussianBlur').attr('stdDeviation', 5);
    const revealPadding = 12;
    const revealRect = defs.append('clipPath').attr('id', revealId).append('rect')
      .attr('class', 'trend-reveal-clip')
      .attr('data-reveal-axis', 'x')
      .attr('x', padding.left - revealPadding)
      .attr('y', 0)
      .attr('width', width - padding.left - padding.right + revealPadding * 2)
      .attr('height', height);
    const plot = svg.append('g').attr('class', 'trend-plot').attr('transform', 'translate(0, 0)');
    y.ticks(4).forEach((tick) => {
      plot.append('line').attr('x1', padding.left).attr('x2', width - padding.right).attr('y1', y(tick)).attr('y2', y(tick)).attr('stroke', 'rgba(153, 213, 233, .12)').attr('stroke-dasharray', '3 5');
      plot.append('text').attr('class', 'trend-y-tick-label').attr('data-axis', 'y').attr('x', padding.left - 8).attr('y', y(tick) + 4).attr('text-anchor', 'end').attr('fill', CHART_THEME.axis).attr('font-size', 14).text(tick);
    });
    if (metric.threshold !== undefined) {
      plot.append('line').attr('class', 'trend-threshold').attr('x1', padding.left).attr('x2', width - padding.right).attr('y1', y(metric.threshold)).attr('y2', y(metric.threshold)).attr('stroke', CHART_THEME.trend.alert).attr('stroke-width', 1.4).attr('stroke-dasharray', '5 5');
      plot.append('text').attr('class', 'trend-threshold-label').attr('x', width - padding.right).attr('y', y(metric.threshold) - 7).attr('text-anchor', 'end').attr('fill', CHART_THEME.trend.alert).attr('font-size', 14).text(`阈值 ${metric.threshold} ${metric.unit}`);
    }
    const chartArea = area<typeof data[number]>().x((item) => x(item.time)).y0(height - padding.bottom).y1((item) => y(metric.value(item))).curve(curveMonotoneX);
    const chartLine = line<typeof data[number]>().x((item) => x(item.time)).y((item) => y(metric.value(item))).curve(curveMonotoneX);
    const linePath = chartLine(data) ?? '';
    plot.append('path').datum(data).attr('class', 'trend-area-fill').attr('d', chartArea).attr('fill', `url(#${areaGradientId})`).attr('clip-path', `url(#${revealId})`);
    const glowPath = plot.append('path').attr('class', 'trend-glow').attr('d', linePath).attr('stroke-dashoffset', 0).attr('fill', 'none').attr('stroke', `url(#${lineGradientId})`).attr('stroke-width', 14).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round').attr('opacity', .22).attr('filter', `url(#${glowId})`);
    const primaryPath = plot.append('path').attr('class', 'trend-line').attr('d', linePath).attr('stroke-dashoffset', 0).attr('fill', 'none').attr('stroke', `url(#${lineGradientId})`).attr('stroke-width', 4).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
    if (metric.threshold !== undefined) {
      data.filter((item) => Number.isFinite(metric.value(item)) && metric.value(item) > metric.threshold!).forEach((item) => {
        const value = metric.value(item);
        plot.append('circle').attr('class', 'trend-alert-halo').attr('cx', x(item.time)).attr('cy', y(value)).attr('r', 10).attr('fill', CHART_THEME.trend.alert).attr('opacity', .22).attr('clip-path', `url(#${revealId})`);
        plot.append('circle').attr('class', 'trend-alert-dot').attr('cx', x(item.time)).attr('cy', y(value)).attr('r', 4.5).attr('fill', CHART_THEME.trend.alert).attr('stroke', CHART_THEME.trend.alert).attr('stroke-width', 1.5).attr('clip-path', `url(#${revealId})`).attr('aria-label', `Alert value: ${value} ${metric.unit}`);
      });
    }
    const latest = data.at(-1)!;
    plot.append('circle').attr('class', 'trend-current-halo').attr('cx', x(latest.time)).attr('cy', y(metric.value(latest))).attr('r', 10).attr('fill', primaryColor).attr('opacity', .22).attr('clip-path', `url(#${revealId})`);
    plot.append('circle').attr('class', 'trend-current-dot').attr('data-terminal', 'true').attr('cx', x(latest.time)).attr('cy', y(metric.value(latest))).attr('r', 5).attr('fill', '#e8fffb').attr('stroke', primaryColor).attr('stroke-width', 2).attr('clip-path', `url(#${revealId})`);
    const labels = [data[0], data[Math.floor(data.length / 2)], latest];
    labels.forEach((item) => plot.append('text').attr('x', x(item.time)).attr('y', height - 10).attr('text-anchor', item === data[0] ? 'start' : item === latest ? 'end' : 'middle').attr('fill', CHART_THEME.axis).attr('font-size', 14).text(timeFormat('%m/%d')(item.time)));

    const strokeNodes = [glowPath.node(), primaryPath.node()].filter((node): node is SVGPathElement => node !== null);
    const strokeLengths = strokeNodes.map((node) => {
      const measuredLength = typeof node.getTotalLength === 'function' ? node.getTotalLength() : 1;
      return Number.isFinite(measuredLength) && measuredLength > 0 ? measuredLength : 1;
    });
    const prepareStrokeReveal = () => strokeNodes.forEach((node, index) => {
      const drawableLength = strokeLengths[index]!;
      node.style.removeProperty('stroke-dashoffset');
      node.setAttribute('stroke-dasharray', String(drawableLength));
      node.setAttribute('stroke-dashoffset', String(drawableLength));
    });
    prepareStrokeReveal();
    const pointNodes = plot.selectAll<SVGElement, unknown>('.trend-alert-halo, .trend-alert-dot, .trend-current-halo, .trend-current-dot').nodes();
    const renderFinal = () => {
      strokeNodes.forEach((node) => {
        node.setAttribute('stroke-dashoffset', '0');
        node.style.removeProperty('stroke-dashoffset');
      });
      revealRect.style('transform', null).style('transform-origin', null);
      pointNodes.forEach((node) => {
        node.style.removeProperty('opacity');
        node.style.removeProperty('visibility');
      });
    };
    if (typeof window.matchMedia !== 'function') {
      renderFinal();
      return undefined;
    }
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: reduce)', renderFinal);
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      prepareStrokeReveal();
      const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
      timeline.to(strokeNodes, { strokeDashoffset: 0, duration: 1.05 }, .2)
        .fromTo(revealRect.node(), { scaleX: 0, transformOrigin: 'left center' }, { scaleX: 1, transformOrigin: 'left center', duration: 1.05 }, .27)
        .from(pointNodes, { autoAlpha: 0, duration: .22, stagger: .03 }, 1.24);
      return () => timeline.kill();
    });
    return () => mm.revert();
  }, { scope: svgRef, dependencies: [instanceId, label, layout, metric, points], revertOnUpdate: true });

  return <svg ref={svgRef} className={`d3-chart trend-area trend-area--${layout}`} role="img" aria-label={label} data-point-count={points.length} />;
}
