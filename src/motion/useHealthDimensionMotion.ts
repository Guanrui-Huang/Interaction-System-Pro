import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import type { RefObject } from 'react';

gsap.registerPlugin(useGSAP);

export function useHealthDimensionMotion(
  root: RefObject<HTMLElement | null>,
  scores: readonly number[],
): void {
  useGSAP(() => {
    if (!root.current) return;

    const meters = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-health-dimension-meter]') ?? []);
    const fills = meters.map((meter) => meter.querySelector<HTMLElement>('[data-dimension-fill]')).filter((fill): fill is HTMLElement => fill !== null);
    const tips = meters.map((meter) => meter.querySelector<HTMLElement>('[data-dimension-tip]')).filter((tip): tip is HTMLElement => tip !== null);
    const scoreNodes = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-dimension-score]') ?? []);
    const endScores = meters.map((meter, index) => Math.max(0, Math.min(100, scores[index] ?? (Number(meter.dataset.score) || 0))));

    const clearMotionStyles = () => {
      fills.forEach((fill) => {
        fill.style.removeProperty('transform');
        fill.style.removeProperty('transform-origin');
        fill.style.removeProperty('will-change');
      });
      tips.forEach((tip) => {
        tip.style.removeProperty('left');
        tip.style.removeProperty('transform');
        tip.style.removeProperty('transform-origin');
        tip.style.removeProperty('will-change');
      });
    };
    const renderFinal = () => {
      clearMotionStyles();
      scoreNodes.forEach((node, index) => { node.textContent = String(Math.round(endScores[index] ?? 0)); });
    };
    const markComplete = () => root.current?.setAttribute('data-health-dimension-motion-complete', 'true');

    root.current?.setAttribute('data-health-dimension-motion-complete', 'false');
    if (typeof window.matchMedia !== 'function') {
      renderFinal();
      markComplete();
      return clearMotionStyles;
    }
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: reduce)', () => {
      renderFinal();
      markComplete();
      return clearMotionStyles;
    });
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      // Read every layout-dependent value before GSAP writes a transform.
      const endpointOffsets = meters.map((meter, index) => meter.clientWidth * endScores[index]! / 100);
      const states = endScores.map(() => ({ value: 0 }));
      scoreNodes.forEach((node) => { node.textContent = '0'; });
      fills.forEach((fill) => { fill.style.willChange = 'transform'; });
      tips.forEach((tip) => { tip.style.willChange = 'transform'; });
      const complete = () => {
        renderFinal();
        markComplete();
      };
      const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
      timeline.set(fills, { scaleX: 0 })
        .set(tips, { x: (index: number) => -endpointOffsets[index]!, scale: 1 })
        .to(fills, { scaleX: 1, duration: 0.62, stagger: 0.07 }, 0)
        .to(tips, { x: 0, duration: 0.62, stagger: 0.07 }, 0)
        .to(states, {
          value: (index: number) => endScores[index]!,
          duration: 0.62,
          stagger: 0.07,
          onUpdate: () => states.forEach((state, index) => { scoreNodes[index]!.textContent = String(Math.round(state.value)); }),
        }, 0)
        .to(tips, { scale: 1.45, duration: 0.12, stagger: 0.07, yoyo: true, repeat: 1 }, '>-0.04')
        .eventCallback('onComplete', complete);
      return () => {
        timeline.kill();
        clearMotionStyles();
      };
    });

    return () => {
      mm.revert();
      clearMotionStyles();
    };
  }, { scope: root, dependencies: [scores.join(',')], revertOnUpdate: true });
}
