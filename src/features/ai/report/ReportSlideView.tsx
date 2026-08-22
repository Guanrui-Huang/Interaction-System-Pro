import { useEffect, useRef } from 'react';
import type { ReportSlide } from '../../../../shared/report';
import { ReportEvidenceDrawer } from './ReportEvidenceDrawer';
import { useReportSlideMotion } from './useReportSlideMotion';
import { VisualRenderer, type VisualMode } from './visuals/VisualRenderer';

type ReportSlideViewProps = {
  slide: ReportSlide;
  mode: VisualMode;
  active: boolean;
  animate?: boolean;
  onFirstActivation?(): void;
};

export function ReportSlideView({ slide, mode, active, animate = true, onFirstActivation }: ReportSlideViewProps) {
  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useReportSlideMotion(rootRef, slide.visual.kind, active && mode === 'canvas', animate, onFirstActivation);
  useEffect(() => {
    if (mode === 'canvas' && active) headingRef.current?.focus();
  }, [active, mode, slide.id]);
  const insufficient = slide.metrics.length === 0 && slide.evidenceRefs.length === 0;
  const superseded = slide.supersededBySlideId !== undefined;

  return (
    <section
      ref={rootRef}
      className={`report-slide report-slide--${mode} report-slide--layout-${slide.layout} report-slide--visual-${slide.visual.kind}${superseded ? ' report-slide--superseded' : ''}`}
      data-slide-mode={mode}
      data-slide-id={slide.id}
      data-slide-role={slide.role}
      data-visual-kind={slide.visual.kind}
      data-slide-superseded={superseded || undefined}
      {...(mode === 'canvas' ? { role: 'region', 'aria-label': '当前汇报页' } : { 'aria-hidden': true })}
    >
      <div className="report-slide__guide" aria-hidden="true" />
      <header className="report-slide__heading">
        <p><span>{String(slide.order + 1).padStart(2, '0')}</span> / LIVE REPORT</p>
        {mode === 'canvas'
          ? <h2 ref={headingRef} tabIndex={-1}>{slide.title}</h2>
          : <p className="report-slide__thumbnail-title">{slide.title}</p>}
        <div className="report-slide__takeaway">{slide.takeaway}</div>
        {superseded && <p className="report-slide__superseded" role={mode === 'canvas' ? 'status' : undefined}>本页结论已被更正</p>}
        {insufficient && <p className="report-slide__insufficient">本页没有可核验的现场数据证据。</p>}
      </header>
      <div className="report-slide__visual"><VisualRenderer visual={slide.visual} mode={mode} /></div>
      {mode === 'canvas' && <ReportEvidenceDrawer slide={slide} />}
    </section>
  );
}
