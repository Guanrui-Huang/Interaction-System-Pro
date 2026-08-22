import type { AtomicVisualSpec } from '../../../../../shared/report';
import { AlertTimelineVisual } from './AlertTimelineVisual';
import { CapabilityMapVisual } from './CapabilityMapVisual';
import { ComparisonBarsVisual } from './ComparisonBarsVisual';
import { ConceptMapVisual } from './ConceptMapVisual';
import { HealthRingVisual } from './HealthRingVisual';
import { KpiGridVisual } from './KpiGridVisual';
import { PathVisual } from './PathVisual';
import { RadarVisual } from './RadarVisual';
import { ScatterVisual } from './ScatterVisual';
import { TrendVisual } from './TrendVisual';
import type { VisualMode } from './VisualRenderer';

export function AtomicVisualRenderer({ visual, mode }: { visual: AtomicVisualSpec; mode: VisualMode }) {
  switch (visual.kind) {
    case 'kpi-grid': return <KpiGridVisual visual={visual} />;
    case 'trend-line':
    case 'trend-area': return <TrendVisual visual={visual} />;
    case 'comparison-bars': return <ComparisonBarsVisual visual={visual} />;
    case 'health-ring': return <HealthRingVisual visual={visual} />;
    case 'radar': return <RadarVisual visual={visual} />;
    case 'scatter': return <ScatterVisual visual={visual} />;
    case 'alert-timeline': return <AlertTimelineVisual visual={visual} />;
    case 'process-flow':
    case 'recommendation-path': return <PathVisual visual={visual} />;
    case 'concept-map': return <ConceptMapVisual visual={visual} mode={mode} />;
    case 'capability-map': return <CapabilityMapVisual visual={visual} mode={mode} />;
  }
}
