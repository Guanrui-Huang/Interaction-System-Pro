import type { VisualSpec } from '../../../../../shared/report';
import type { ReportRevealModule } from '../useReportModuleReveal';
import { AtomicVisualRenderer } from './AtomicVisualRenderer';
import { DataDashboardVisual } from './DataDashboardVisual';
import { ReportVisualIcon } from './ReportVisualIcon';

export type VisualMode = 'canvas' | 'thumbnail';

function AtomicKpiCanvas({ visual }: { visual: Extract<VisualSpec, { kind: 'kpi-grid' }> }) {
  return (
    <div
      className="report-data-dashboard report-data-dashboard--atomic-kpi"
      data-support-count="0"
      data-support-slots="2"
      data-summary-columns="1"
      data-summary-rows="0"
    >
      <div className="report-data-dashboard__metrics report-data-dashboard__metrics--empty" data-dashboard-slot="metrics" aria-hidden="true" />
      <section className="report-data-dashboard__primary" data-dashboard-slot="primary" data-panel-kind="kpi-grid" aria-label="关键指标">
        <div className="report-data-dashboard__panel-label">
          <ReportVisualIcon kind="kpi-grid" />
          <span>指标总览</span>
        </div>
        <AtomicVisualRenderer visual={visual} mode="canvas" />
      </section>
      <div className="report-data-dashboard__support" data-dashboard-slot="support" aria-label="辅助图">
        {[0, 1].map((index) => (
          <section
            className="report-data-dashboard__support-empty"
            key={index}
            data-dashboard-support-slot={index}
            data-dashboard-support-empty="true"
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  );
}

export function VisualRenderer({
  visual,
  mode,
  revealedModules,
}: {
  visual: VisualSpec;
  mode: VisualMode;
  revealedModules?: ReadonlySet<ReportRevealModule>;
}) {
  const content = visual.kind === 'data-dashboard'
    ? <DataDashboardVisual visual={visual} mode={mode} revealedModules={revealedModules} />
    : visual.kind === 'kpi-grid' && mode === 'canvas'
      ? <AtomicKpiCanvas visual={visual} />
    : <AtomicVisualRenderer visual={visual} mode={mode} />;
  return <div className={`report-visual-renderer report-visual-renderer--${mode}`} data-visual-kind={visual.kind}>{content}</div>;
}
