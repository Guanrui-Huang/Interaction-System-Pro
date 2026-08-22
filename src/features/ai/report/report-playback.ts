import type { ReportSlide } from '../../../../shared/report';

export function finalReplacementFor(
  slides: readonly ReportSlide[],
  slideId: string | undefined,
): ReportSlide | undefined {
  let slide = slides.find(({ id }) => id === slideId);
  const visited = new Set<string>();
  while (slide?.supersededBySlideId) {
    if (visited.has(slide.id)) return undefined;
    visited.add(slide.id);
    slide = slides.find(({ id }) => id === slide!.supersededBySlideId);
    if (!slide) return undefined;
  }
  return slide;
}

export function playableReportSlides(
  slides: readonly ReportSlide[],
): ReportSlide[] {
  return [...slides]
    .filter(({ supersededBySlideId }) => supersededBySlideId === undefined)
    .sort((left, right) => left.order - right.order);
}
