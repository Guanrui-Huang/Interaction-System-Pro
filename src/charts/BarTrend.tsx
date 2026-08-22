import { useGSAP } from '@gsap/react';
import { scaleBand, scaleLinear, select } from 'd3';
import gsap from 'gsap';
import { useId, useRef } from 'react';
import { HEALTH_GRADE_THRESHOLDS } from '../../shared/dashboard';
import { calculateReadingHealth } from '../../shared/health';
import type { DashboardPoint } from '../app/api';

gsap.registerPlugin(useGSAP);

export function BarTrend({ points }: { points: DashboardPoint[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const instanceId = useId().replace(/:/g, '');

  useGSAP(() => {
    const svg = select(svgRef.current); const width = 1600; const height = 260; const padding = { top: 28, right: 18, bottom: 36, left: 18 };
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none').attr('role', 'img').attr('aria-label', '近30日健康指数柱状趋势');
    const visible = points.slice(-30).map((point) => {
      const rawValue = calculateReadingHealth(point).score;
      return { point, value: Number.isFinite(rawValue) ? Math.max(0, Math.min(100, rawValue)) : 0 };
    });
    if (!visible.length) return;
    const x = scaleBand().domain(visible.map(({ point }) => point.date)).range([padding.left, width - padding.right]).padding(.34);
    const y = scaleLinear().domain([0, 100]).range([height - padding.bottom, padding.top]);
    const goodGradientId = `bar-trend-good-gradient-${instanceId}`;
    const riskGradientId = `bar-trend-risk-gradient-${instanceId}`;
    const glowId = `bar-trend-glow-${instanceId}`;
    const defs = svg.append('defs');
    const addGradient = (id: string, className: string, stops: Array<{ offset: string; color: string }>) => {
      defs.append('linearGradient').attr('id', id).attr('class', className).attr('x1', '0%').attr('x2', '0%').attr('y1', '100%').attr('y2', '0%')
        .selectAll('stop').data(stops).join('stop').attr('offset', (item) => item.offset).attr('stop-color', (item) => item.color);
    };
    addGradient(goodGradientId, 'bar-trend-gradient', [{ offset: '0%', color: '#1676d8' }, { offset: '100%', color: '#38e8ff' }]);
    addGradient(riskGradientId, 'bar-trend-risk-gradient', [{ offset: '0%', color: '#ff573d' }, { offset: '100%', color: '#ffbd61' }]);
    defs.append('filter').attr('id', glowId).attr('class', 'bar-trend-glow').attr('x', '-40%').attr('y', '-20%').attr('width', '180%').attr('height', '140%')
      .append('feDropShadow').attr('dx', 0).attr('dy', 0).attr('stdDeviation', 3).attr('flood-color', '#2ce4f5').attr('flood-opacity', .3);

    svg.append('line').attr('class', 'bar-baseline').attr('x1', padding.left).attr('x2', width - padding.right).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', 'rgba(161,208,227,.22)');
    svg.append('line').attr('class', 'bar-threshold').attr('x1', padding.left).attr('x2', width - padding.right).attr('y1', y(HEALTH_GRADE_THRESHOLDS.excellent)).attr('y2', y(HEALTH_GRADE_THRESHOLDS.excellent)).attr('stroke', '#7cefff').attr('stroke-width', 1.2).attr('stroke-dasharray', '5 5').attr('opacity', .85);
    svg.append('text').attr('class', 'bar-threshold-label').attr('x', width - padding.right).attr('y', y(HEALTH_GRADE_THRESHOLDS.excellent) - 8).attr('text-anchor', 'end').attr('fill', '#bcefff').attr('font-size', 14).text(`优良线 ${HEALTH_GRADE_THRESHOLDS.excellent}`);
    const bars = svg.append('g').selectAll('rect').data(visible).join('rect')
      .attr('class', ({ value }, index) => ['bar-trend-bar', value < 86 ? 'bar-trend-bar--risk' : '', index === visible.length - 1 ? 'bar-trend-latest' : ''].filter(Boolean).join(' '))
      .attr('data-motion-bar', 'true')
      .attr('data-risk', ({ value }) => value < 86 ? 'true' : 'false').attr('data-latest', (_, index) => index === visible.length - 1 ? 'true' : 'false')
      .attr('x', ({ point }) => x(point.date) ?? 0).attr('y', ({ value }) => y(value)).attr('width', x.bandwidth()).attr('height', ({ value }) => Math.max(0, height - padding.bottom - y(value))).attr('rx', 3)
      .attr('fill', ({ value }) => `url(#${value < 86 ? riskGradientId : goodGradientId})`).attr('filter', `url(#${glowId})`)
      .attr('stroke', (_, index) => index === visible.length - 1 ? '#d8f9ff' : 'none').attr('stroke-width', (_, index) => index === visible.length - 1 ? 1.5 : 0);
    visible.filter((_, index) => index % 6 === 0 || index === visible.length - 1).forEach(({ point }) => svg.append('text').attr('class', 'bar-date-tick').attr('x', (x(point.date) ?? 0) + x.bandwidth() / 2).attr('y', height - 10).attr('text-anchor', 'middle').attr('fill', '#9bb7c6').attr('font-size', 14).text(point.date.slice(5)));

    const renderFinal = () => bars
      .attr('transform', null)
      .style('transform', null)
      .style('transform-origin', null)
      .style('opacity', null)
      .style('visibility', null);
    if (typeof window.matchMedia !== 'function') {
      renderFinal();
      return undefined;
    }
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: reduce)', renderFinal);
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
      timeline.from(bars.nodes(), {
        scaleY: 0,
        transformOrigin: '50% 100%',
        duration: .5,
        stagger: .015,
      }, .3).eventCallback('onComplete', renderFinal);
      return () => {
        timeline.kill();
        renderFinal();
      };
    });
    return () => {
      mm.revert();
      renderFinal();
    };
  }, { scope: svgRef, dependencies: [instanceId, points], revertOnUpdate: true });

  return <svg ref={svgRef} className="d3-chart bar-trend" />;
}
