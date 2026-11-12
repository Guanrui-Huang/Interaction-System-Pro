import { useGSAP } from '@gsap/react';
import { arc, select } from 'd3';
import gsap from 'gsap';
import { useId, useRef } from 'react';
import { CHART_THEME } from './chart-theme';

gsap.registerPlugin(useGSAP);

export function HealthRing({ score, size = 238, digits = 0 }: { score: number; size?: number; digits?: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const instanceId = useId().replace(/:/g, '');

  useGSAP(() => {
    const svg = select(svgRef.current);
    const center = 120;
    const radius = 88;
    const ringArc = arc<{ endAngle: number }>().innerRadius(radius - 10).outerRadius(radius).cornerRadius(8).startAngle(-Math.PI / 2);
    svg.selectAll('*').remove();
    svg.attr('viewBox', '0 0 240 240').attr('role', 'img').attr('aria-label', `健康指数 ${score.toFixed(digits)}`);
    const gradientId = `health-ring-gradient-${instanceId}`;
    const glowId = `health-ring-glow-${instanceId}`;
    const defs = svg.append('defs');
    defs.append('linearGradient').attr('id', gradientId).attr('x1', '0%').attr('x2', '100%')
      .selectAll('stop').data([{ offset: '0%', color: CHART_THEME.ring.start }, { offset: '100%', color: CHART_THEME.ring.end }]).join('stop')
      .attr('offset', (item) => item.offset).attr('stop-color', (item) => item.color);
    defs.append('filter').attr('id', glowId).attr('x', '-30%').attr('y', '-30%').attr('width', '160%').attr('height', '160%')
      .append('feGaussianBlur').attr('stdDeviation', 2);
    const group = svg.append('g').attr('transform', `translate(${center}, ${center})`);
    group.append('path').attr('d', ringArc({ endAngle: Math.PI * 1.5 }) ?? '').attr('fill', 'rgba(144, 203, 222, .13)');
    const finalScore = Math.max(0, Math.min(score, 100));
    const glowPath = group.append('path')
      .attr('class', 'health-ring-glow')
      .attr('fill', `url(#${gradientId})`)
      .attr('opacity', .34)
      .attr('filter', `url(#${glowId})`);
    const progressPath = group.append('path')
      .attr('class', 'health-ring-progress')
      .attr('fill', `url(#${gradientId})`);
    group.append('circle').attr('r', 61).attr('fill', 'rgba(8, 20, 31, .82)').attr('stroke', 'rgba(141, 229, 248, .16)');
    const scoreText = group.append('text').attr('class', 'health-ring-score').attr('data-motion-value', finalScore).attr('text-anchor', 'middle').attr('y', -2).attr('fill', '#eff8fc').attr('font-size', 48).attr('font-weight', 700);
    group.append('text').attr('text-anchor', 'middle').attr('y', 27).attr('fill', '#9eb6c4').attr('font-size', 15).attr('letter-spacing', 1).text('综合健康指数');
    const renderScore = (value: number) => {
      const renderedScore = Math.max(0, Math.min(value, finalScore));
      const path = ringArc({ endAngle: -Math.PI / 2 + Math.PI * 2 * renderedScore / 100 }) ?? '';
      glowPath.attr('d', path);
      progressPath.attr('d', path);
      scoreText.text(renderedScore.toFixed(digits));
    };
    renderScore(finalScore);

    if (typeof window.matchMedia !== 'function') return undefined;
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: reduce)', () => renderScore(finalScore));
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const state = { score: 0 };
      renderScore(state.score);
      const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
      timeline.to(state, {
        score: finalScore,
        duration: .9,
        onUpdate: () => renderScore(state.score),
      }, .25);
      return () => timeline.kill();
    });
    return () => mm.revert();
  }, { scope: svgRef, dependencies: [instanceId, score, digits], revertOnUpdate: true });

  return <svg ref={svgRef} className="d3-chart health-ring" style={{ width: size, height: size }} />;
}
