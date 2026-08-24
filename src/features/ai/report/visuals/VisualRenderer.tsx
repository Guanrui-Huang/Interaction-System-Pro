import type { VisualSpec } from '../../../../../shared/report';
import type { ReportRevealModule } from '../useReportModuleReveal';
import { AtomicVisualRenderer } from './AtomicVisualRenderer';
import { DataDashboardVisual } from './DataDashboardVisual';

export type VisualMode = 'canvas' | 'thumbnail';

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
    : <AtomicVisualRenderer visual={visual} mode={mode} />;
  return <div className={`report-visual-renderer report-visual-renderer--${mode}`} data-visual-kind={visual.kind}>{content}</div>;
}
