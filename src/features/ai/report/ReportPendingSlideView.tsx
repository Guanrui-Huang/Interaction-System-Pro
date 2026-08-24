import type { SlideOutline } from '../../../../shared/report';

type PendingMode = 'canvas' | 'thumbnail';

const dashboardKinds = new Set<SlideOutline['visualKind']>([
  'trend-line',
  'trend-area',
  'comparison-bars',
  'health-ring',
  'radar',
  'scatter',
]);

function PendingBars({ count, className }: { count: number; className: string }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <i key={index} />)}
    </div>
  );
}

export function ReportPendingSlideView({ outline, mode }: { outline?: SlideOutline; mode: PendingMode }) {
  const dashboard = outline ? dashboardKinds.has(outline.visualKind) : true;

  return (
    <section
      className={`report-pending-slide report-pending-slide--${mode}${dashboard ? ' report-pending-slide--dashboard' : ' report-pending-slide--atomic'}`}
      data-slide-id={outline?.id ?? 'pending-report'}
      data-slide-mode={mode}
      data-slide-state="pending"
      role={mode === 'canvas' ? 'region' : undefined}
      aria-label={mode === 'canvas' ? (outline ? `待完成页面：${outline.title}` : '待完成汇报页面') : undefined}
      aria-hidden={mode === 'thumbnail' || undefined}
    >
      <div className="report-pending-slide__guide" aria-hidden="true" />
      <header className="report-pending-slide__heading">
        {outline ? (
          <h2>{outline.title}</h2>
        ) : (
          <PendingBars count={1} className="report-pending-slide__title-placeholder" />
        )}
        <PendingBars count={2} className="report-pending-slide__takeaway" />
      </header>
      <div className="report-pending-slide__visual" aria-hidden="true">
        {dashboard && <PendingBars count={4} className="report-pending-slide__metrics" />}
        <div className="report-pending-slide__chart" data-pending-module="primary">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        {dashboard && (
          <div className="report-pending-slide__support">
            <div data-pending-module="support-1">
              <i />
              <i />
              <i />
            </div>
            <div data-pending-module="support-2">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>
      {mode === 'canvas' && (
        <div className="report-pending-slide__evidence" data-pending-module="evidence" aria-hidden="true">
          <i />
        </div>
      )}
    </section>
  );
}
