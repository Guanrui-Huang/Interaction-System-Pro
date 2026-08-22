import type { VisualSpec } from '../../../../../shared/report';
import { AtomicVisualRenderer } from './AtomicVisualRenderer';
import { DataDashboardVisual } from './DataDashboardVisual';

export type VisualMode = 'canvas' | 'thumbnail';

export function VisualRenderer({ visual, mode }: { visual: VisualSpec; mode: VisualMode }) {
  const content = visual.kind === 'data-dashboard'
    ? <DataDashboardVisual visual={visual} mode={mode} />
    : <AtomicVisualRenderer visual={visual} mode={mode} />;
  return <div className={`report-visual-renderer report-visual-renderer--${mode}`} data-visual-kind={visual.kind}>{content}</div>;
}
