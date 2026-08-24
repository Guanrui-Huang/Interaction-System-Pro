import { useEffect, useMemo, useState } from 'react';
import type { ReportSlide } from '../../../../shared/report';

export type ReportRevealModule =
  | 'heading'
  | 'metrics'
  | 'primary'
  | `support-${number}`
  | 'evidence';

export const METRIC_CARD_CLEAR_DURATION_MS = 340;
export const METRIC_CARD_REVEAL_STAGGER_MS = 80;
export const MAX_METRIC_CARD_STAGGER_INDEX = 7;
const BASE_PRIMARY_REVEAL_GAP_MS = 420;

export function metricCardClearDurationMs(metricCount: number): number {
  const count = Math.max(0, Math.floor(metricCount));
  if (count === 0) return 0;
  return METRIC_CARD_CLEAR_DURATION_MS
    + Math.min(count - 1, MAX_METRIC_CARD_STAGGER_INDEX) * METRIC_CARD_REVEAL_STAGGER_MS;
}

export function primaryRevealGapForMetricCount(metricCount: number): number {
  return Math.max(BASE_PRIMARY_REVEAL_GAP_MS, metricCardClearDurationMs(metricCount));
}

const gapBeforeModule = (module: ReportRevealModule, summaryMetricCount: number): number => {
  if (module === 'metrics') return 320;
  if (module === 'primary') return primaryRevealGapForMetricCount(summaryMetricCount);
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
  const summaryMetricCount = slide?.visual.kind === 'data-dashboard' ? slide.visual.summaryMetrics.length : 0;
  const revealKey = slideId ? `${slideId}:${planKey}` : '';
  const reduced = reducedMotionRequested();
  const [revealState, setRevealState] = useState(() => ({
    key: revealKey,
    visibleCount: immediate || reduced ? plan.length : Math.min(1, plan.length),
  }));
  const visibleCount = immediate || reduced
    ? plan.length
    : revealState.key === revealKey
      ? Math.min(revealState.visibleCount, plan.length)
      : Math.min(1, plan.length);

  useEffect(() => {
    if (!slideId) {
      setRevealState({ key: '', visibleCount: 0 });
      return undefined;
    }

    if (immediate || reduced) {
      setRevealState({ key: revealKey, visibleCount: plan.length });
      onComplete(slideId);
      return undefined;
    }

    setRevealState((current) => (
      current.key === revealKey
        ? current
        : { key: revealKey, visibleCount: Math.min(1, plan.length) }
    ));
    let cancelled = false;
    let elapsed = 0;
    const timers = plan.slice(1).map((module, index) => {
      elapsed += gapBeforeModule(module, summaryMetricCount);
      return window.setTimeout(() => {
        if (cancelled) return;
        const nextCount = index + 2;
        setRevealState((current) => (
          current.key === revealKey
            ? { key: revealKey, visibleCount: nextCount }
            : current
        ));
        if (nextCount === plan.length) onComplete(slideId);
      }, elapsed);
    });

    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [immediate, onComplete, plan.length, planKey, reduced, revealKey, slideId, summaryMetricCount]);

  const revealedModules = useMemo(
    () => new Set<ReportRevealModule>(plan.slice(0, visibleCount)),
    [planKey, plan, visibleCount],
  );

  return {
    revealedModules,
    progressive: Boolean(slide && !immediate && !reduced),
  };
}
