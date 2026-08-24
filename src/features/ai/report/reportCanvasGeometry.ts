import type { ReportSlide, SlideOutline, VisualSpec } from '../../../../shared/report';

export type ReportCanvasGeometry = ReportSlide['layout'] | 'dashboard';

export const DASHBOARD_CAPABLE_OUTLINE_KINDS = [
  'kpi-grid',
  'trend-line',
  'trend-area',
  'comparison-bars',
  'health-ring',
  'radar',
  'scatter',
  'alert-timeline',
] as const satisfies readonly SlideOutline['visualKind'][];

const dashboardCapableOutlineKinds = new Set<SlideOutline['visualKind']>(DASHBOARD_CAPABLE_OUTLINE_KINDS);
const dashboardGeometryVisualKinds = new Set<VisualSpec['kind']>(['data-dashboard', 'kpi-grid']);

export function isDashboardCapableOutlineKind(kind: SlideOutline['visualKind']): boolean {
  return dashboardCapableOutlineKinds.has(kind);
}

export function canvasGeometryForOutline(outline: SlideOutline | undefined): ReportCanvasGeometry {
  if (!outline) return 'dashboard';
  return isDashboardCapableOutlineKind(outline.visualKind) ? 'dashboard' : outline.layout;
}

export function canvasGeometryForSlide(slide: ReportSlide): ReportCanvasGeometry {
  return dashboardGeometryVisualKinds.has(slide.visual.kind) ? 'dashboard' : slide.layout;
}
