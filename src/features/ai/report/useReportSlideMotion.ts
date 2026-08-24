import gsap from 'gsap';
import { useLayoutEffect, type RefObject } from 'react';
import type { VisualSpec } from '../../../../shared/report';

type MotionRoot = HTMLElement | null;

function setFinalState(root: HTMLElement, reduced: boolean): void {
  root.dataset.slideMotionState = 'final';
  root.dataset.motionReduced = String(reduced);
  for (const node of root.querySelectorAll<HTMLElement>('[data-motion-number]')) {
    const finalValue = node.dataset.finalValue;
    if (finalValue !== undefined) node.textContent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(finalValue));
  }
}

export function useReportSlideMotion(
  rootRef: RefObject<MotionRoot>,
  visualKind: VisualSpec['kind'],
  active: boolean,
  animate = true,
  onFirstActivation?: () => void,
): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !active) return undefined;
    const reduced = typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !animate) {
      setFinalState(root, reduced);
      if (animate) onFirstActivation?.();
      return undefined;
    }

    onFirstActivation?.();
    root.dataset.slideMotionState = 'animating';
    root.dataset.motionReduced = 'false';
    const motionRoot = root.querySelector<HTMLElement>('[data-reveal-module="primary"][data-reveal-visible="true"]') ?? root;
    const context = gsap.context(() => {
      const timeline = gsap.timeline({ defaults: { ease: 'power2.out' }, onComplete: () => setFinalState(root, false) });
      const numbers = Array.from(motionRoot.querySelectorAll<HTMLElement>('[data-motion-number]'));
      if (numbers.length) timeline.fromTo(numbers, { textContent: 0 }, {
        textContent: (index: number) => Number(numbers[index]?.dataset.finalValue ?? 0),
        duration: .7,
        snap: { textContent: .01 },
      }, 0);
      const bars = motionRoot.querySelectorAll('[data-motion-bar]');
      if (bars.length) timeline.fromTo(bars, { scaleY: 0, transformOrigin: 'center bottom' }, { scaleY: 1, duration: .72, stagger: .06 }, .08);
      const reveals = motionRoot.querySelectorAll('[data-motion-reveal]');
      if (reveals.length) timeline.fromTo(reveals, { scaleX: 0, transformOrigin: 'left center' }, { scaleX: 1, duration: .9 }, .08);
      const rings = motionRoot.querySelectorAll('[data-motion-ring]');
      if (rings.length) timeline.fromTo(rings, { scale: 0, transformOrigin: 'center center' }, { scale: 1, duration: .8 }, .08);
      if (!numbers.length && !bars.length && !reveals.length && !rings.length) timeline.fromTo(motionRoot.querySelector('.report-visual__graphic'), { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: .42 }, 0);
    }, motionRoot);
    return () => context.revert();
  }, [active, animate, onFirstActivation, rootRef, visualKind]);
}
