import type { SlideOutline } from '../../../../shared/report';
import { ReportVisualIcon, type ReportVisualIconKind } from './visuals/ReportVisualIcon';

type PendingMode = 'canvas' | 'thumbnail';

const dashboardKinds = new Set<SlideOutline['visualKind']>([
  'trend-line',
  'trend-area',
  'comparison-bars',
  'health-ring',
  'radar',
  'scatter',
]);

function PendingBlocks({ count, className }: { count: number; className: string }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <span key={index} />)}
    </div>
  );
}

function PendingPanel({
  className,
  surfaceClassName,
  module,
  supportSlot,
}: {
  className: string;
  surfaceClassName: string;
  module: string;
  supportSlot?: number;
}) {
  return (
    <section
      className={className}
      data-pending-module={module}
      data-dashboard-slot={module === 'primary' ? 'primary' : undefined}
      data-dashboard-support-slot={supportSlot}
    >
      <div className="report-pending-slide__panel-cap" />
      <div className={surfaceClassName}>
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function PendingMetricCards({ count }: { count: number }) {
  return (
    <div className="report-pending-slide__metrics" data-pending-module="metrics" data-dashboard-slot="metrics">
      {Array.from({ length: count }, (_, index) => (
        <section className="report-pending-slide__metric" key={index}>
          <div className="report-pending-slide__metric-cap" />
          <div className="report-pending-slide__metric-body">
            <span />
            <span />
          </div>
        </section>
      ))}
    </div>
  );
}

export function ReportPendingSlideView({ outline, mode }: { outline?: SlideOutline; mode: PendingMode }) {
  const layout = outline?.layout ?? 'visual-focus';
  const dashboard = outline ? dashboardKinds.has(outline.visualKind) : true;
  const canvasGeometry = dashboard ? 'dashboard' : layout;
  const metadataIconKind: ReportVisualIconKind = dashboard ? 'data-dashboard' : (outline?.visualKind ?? 'metric');
  const geometryClass = mode === 'canvas'
    ? ` report-canvas-geometry-shell report-canvas-geometry-shell--${canvasGeometry}`
    : '';

  return (
    <section
      className={`report-pending-slide report-pending-slide--${mode} report-pending-slide--layout-${layout}${dashboard ? ' report-pending-slide--visual-data-dashboard' : ' report-pending-slide--visual-atomic'}${geometryClass}`}
      data-slide-id={outline?.id ?? 'pending-report'}
      data-slide-mode={mode}
      data-slide-state="pending"
      data-canvas-geometry={mode === 'canvas' ? canvasGeometry : undefined}
      role={mode === 'canvas' ? 'region' : undefined}
      aria-label={mode === 'canvas' ? (outline ? `待完成页面：${outline.title}` : '待完成汇报页面') : undefined}
      aria-hidden={mode === 'thumbnail' || undefined}
    >
      <div className="report-pending-slide__guide" aria-hidden="true" />
      <header className="report-pending-slide__heading">
        {outline && (
          <p>
            <ReportVisualIcon kind={metadataIconKind} />
            <span>{String(outline.order + 1).padStart(2, '0')}</span> / LIVE REPORT
          </p>
        )}
        {outline ? (
          <h2>{outline.title}</h2>
        ) : (
          <PendingBlocks count={1} className="report-pending-slide__title-placeholder" />
        )}
        <PendingBlocks count={2} className="report-pending-slide__takeaway" />
      </header>
      <div className="report-pending-slide__visual" aria-hidden="true">
        {dashboard && <PendingMetricCards count={4} />}
        <PendingPanel
          className={`report-pending-slide__panel report-pending-slide__panel--primary${dashboard ? ' report-pending-slide__dashboard-panel' : ''}`}
          module="primary"
          surfaceClassName={dashboard ? 'report-pending-slide__panel-body report-pending-slide__panel-body--dashboard' : 'report-pending-slide__panel-body report-pending-slide__panel-body--atomic'}
        />
        {dashboard && (
          <div className="report-pending-slide__support" data-dashboard-slot="support">
            <PendingPanel
              className="report-pending-slide__panel report-pending-slide__dashboard-panel"
              module="support-1"
              supportSlot={0}
              surfaceClassName="report-pending-slide__panel-body report-pending-slide__panel-body--support"
            />
            <PendingPanel
              className="report-pending-slide__panel report-pending-slide__dashboard-panel"
              module="support-2"
              supportSlot={1}
              surfaceClassName="report-pending-slide__panel-body report-pending-slide__panel-body--support"
            />
          </div>
        )}
        {!dashboard && (
          <PendingPanel
            className="report-pending-slide__panel report-pending-slide__panel--context"
            module="context"
            surfaceClassName="report-pending-slide__panel-body report-pending-slide__panel-body--context"
          />
        )}
      </div>
      {mode === 'canvas' && (
        <div className="report-pending-slide__evidence" data-pending-module="evidence" aria-hidden="true">
          <span />
        </div>
      )}
    </section>
  );
}
