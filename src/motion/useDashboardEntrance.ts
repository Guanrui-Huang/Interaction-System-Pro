import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import type { DependencyList, RefObject } from 'react';

gsap.registerPlugin(useGSAP);

export type MotionNumberFormat = 'integer' | 'one-decimal' | 'two-decimal';

const PAGE_ENTRANCE_SECONDS = 1.25;
const CARD_START_SECONDS = 0.1;
const CARD_DURATION_SECONDS = 0.42;
const COUNTER_START_SECONDS = 0.2;
const COUNTER_DURATION_SECONDS = 0.75;

export function formatMotionValue(value: number, format: MotionNumberFormat): string {
  const digits = format === 'integer' ? 0 : format === 'one-decimal' ? 1 : 2;
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function useDashboardEntrance(
  root: RefObject<HTMLElement | null>,
  dependencies: DependencyList = [],
): void {
  useGSAP(() => {
    const cards = gsap.utils.toArray<HTMLElement>('[data-motion-card]');
    const counters = gsap.utils.toArray<HTMLElement>('[data-motion-number]').map((node) => ({
      node,
      end: Number(node.dataset.motionValue),
      format: (node.dataset.motionFormat ?? 'integer') as MotionNumberFormat,
    }));
    const renderFinal = () => counters.forEach(({ node, end, format }) => {
      node.textContent = formatMotionValue(end, format);
    });
    const renderZero = () => counters.forEach(({ node, format }) => {
      node.textContent = formatMotionValue(0, format);
    });
    const markComplete = () => root.current?.setAttribute('data-motion-complete', 'true');
    const markIncomplete = () => root.current?.setAttribute('data-motion-complete', 'false');
    markIncomplete();
    if (typeof window.matchMedia !== 'function') {
      renderFinal();
      markComplete();
      return;
    }
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: reduce)', () => { renderFinal(); markComplete(); });
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      markIncomplete();
      renderZero();
      const cardStagger = cards.length > 1
        ? Math.min(0.06, (PAGE_ENTRANCE_SECONDS - CARD_START_SECONDS - CARD_DURATION_SECONDS) / (cards.length - 1))
        : 0;
      const counterStagger = counters.length > 1
        ? (PAGE_ENTRANCE_SECONDS - COUNTER_START_SECONDS - COUNTER_DURATION_SECONDS) / (counters.length - 1)
        : 0;
      const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
      timeline.from(root.current, { autoAlpha: 0, y: 12, duration: 0.3 }, 0)
        .from(cards, { autoAlpha: 0, y: 14, duration: CARD_DURATION_SECONDS, stagger: cardStagger }, CARD_START_SECONDS);
      counters.forEach(({ node, end, format }, index) => {
        const state = { value: 0 };
        timeline.to(state, {
          value: end,
          duration: COUNTER_DURATION_SECONDS,
          onUpdate: () => { node.textContent = formatMotionValue(state.value, format); },
        }, COUNTER_START_SECONDS + index * counterStagger);
      });
      timeline.call(markComplete, [], PAGE_ENTRANCE_SECONDS);
      return () => timeline.kill();
    });
    return () => mm.revert();
  }, { scope: root, dependencies: [...dependencies], revertOnUpdate: true });
}
