import { useEffect, useMemo, useState } from 'react';
import type { ReportSlide } from '../../../../shared/report';

export type ReportRevealModule =
  | 'heading'
  | 'metrics'
  | 'primary'
  | `support-${number}`
  | 'evidence';

const gapBeforeModule = (module: ReportRevealModule): number => {
  if (module === 'metrics') return 320;
  if (module === 'primary') return 420;
  if (module.startsWith('support-')) return 300;
  return 240;
};

export function reportRevealPlan(slide: ReportSlide): ReportRevealModule[] {
  if (slide.visual.kind !== 'data-dashboard') {
    return ['heading', 'primary', 'evidence'];
  }

  return [
    'heading',
    ...(slide.visual.summaryMetrics.length > 0 ? ['metrics' as const] : []),
    'primary',
    ...slide.visual.supporting.map((_, index) => `support-${index}` as const),
    'evidence',
  ];
}

function reducedMotionRequested(): boolean {
  return typeof window.matchMedia !== 'function'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type UseReportModuleRevealOptions = {
  slide?: ReportSlide;
  immediate: boolean;
  onComplete(slideId: string): void;
};

export function useReportModuleReveal({
  slide,
  immediate,
  onComplete,
}: UseReportModuleRevealOptions) {
  const plan = useMemo(() => (slide ? reportRevealPlan(slide) : []), [slide]);
  const planKey = plan.join('|');
  const slideId = slide?.id;
  const reduced = reducedMotionRequested();
  const [visibleCount, setVisibleCount] = useState(() => (
    immediate || reduced ? plan.length : Math.min(1, plan.length)
  ));

  useEffect(() => {
    if (!slideId) {
      setVisibleCount(0);
      return undefined;
    }

    if (immediate || reduced) {
      setVisibleCount(plan.length);
      onComplete(slideId);
      return undefined;
    }

    setVisibleCount(Math.min(1, plan.length));
    let elapsed = 0;
    const timers = plan.slice(1).map((module, index) => {
      elapsed += gapBeforeModule(module);
      return window.setTimeout(() => {
        const nextCount = index + 2;
        setVisibleCount(nextCount);
        if (nextCount === plan.length) onComplete(slideId);
      }, elapsed);
    });

    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [immediate, onComplete, plan.length, planKey, reduced, slideId]);

  const revealedModules = useMemo(
    () => new Set<ReportRevealModule>(plan.slice(0, visibleCount)),
    [planKey, plan, visibleCount],
  );

  return {
    revealedModules,
    progressive: Boolean(slide && !immediate && !reduced),
  };
}
