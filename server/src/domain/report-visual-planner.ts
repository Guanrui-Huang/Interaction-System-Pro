import type { AtomicVisualKind } from '../../../shared/report';

export type VisualEvidenceCandidate = {
  key: string;
  kind: 'metric' | 'health-weight' | 'alert';
  unit?: string;
  pointCount: number;
  pairedSampleCount: number;
  scoreLike: boolean;
};

export type AtomicDataVisualPlan = {
  kind: 'trend-line' | 'trend-area' | 'comparison-bars' | 'health-ring' | 'radar' | 'scatter' | 'alert-timeline';
  evidenceKeys: string[];
};

export type DataDashboardPlan = {
  summaryKeys: string[];
  primary: AtomicDataVisualPlan;
  supporting: AtomicDataVisualPlan[];
};

function signature(plan: AtomicDataVisualPlan): string {
  return `${plan.kind}:${[...plan.evidenceKeys].sort().join(',')}`;
}

function hasFiniteCounts(candidate: VisualEvidenceCandidate): boolean {
  return Number.isFinite(candidate.pointCount)
    && candidate.pointCount >= 0
    && Number.isFinite(candidate.pairedSampleCount)
    && candidate.pairedSampleCount >= 0;
}

export function planDataDashboardVisual(
  preferredKind: AtomicVisualKind,
  candidates: readonly VisualEvidenceCandidate[],
): DataDashboardPlan | null {
  const boundedCandidates = candidates.filter(hasFiniteCounts);
  const metrics = boundedCandidates.filter((item) => item.kind !== 'alert');
  const alerts = boundedCandidates.filter((item) => item.kind === 'alert');
  const plans: AtomicDataVisualPlan[] = [];
  const trendGroups = new Map<string, VisualEvidenceCandidate[]>();
  for (const item of metrics.filter(({ pointCount }) => pointCount >= 2)) {
    const unit = item.unit ?? '';
    trendGroups.set(unit, [...(trendGroups.get(unit) ?? []), item]);
  }
  for (const group of trendGroups.values()) {
    plans.push({
      kind: preferredKind === 'trend-line' ? 'trend-line' : 'trend-area',
      evidenceKeys: group.map(({ key }) => key),
    });
  }
  const comparisonGroups = new Map<string, VisualEvidenceCandidate[]>();
  for (const item of metrics) {
    const unit = item.unit?.trim();
    if (!unit) continue;
    comparisonGroups.set(unit, [...(comparisonGroups.get(unit) ?? []), item]);
  }
  for (const group of comparisonGroups.values()) {
    if (group.length >= 2) plans.push({ kind: 'comparison-bars', evidenceKeys: group.map(({ key }) => key) });
  }
  const scores = metrics.filter(({ scoreLike }) => scoreLike);
  if (scores.length >= 3) plans.push({ kind: 'radar', evidenceKeys: scores.slice(0, 6).map(({ key }) => key) });
  if (scores[0]) plans.push({ kind: 'health-ring', evidenceKeys: [scores[0].key] });
  const hasComparablePair = plans.some((plan) => (
    plan.kind === 'comparison-bars'
    && plan.evidenceKeys.length === 2
    && plan.evidenceKeys.every((key) => metrics.some((metric) => metric.key === key))
  ));
  if (!hasComparablePair && metrics.length === 2 && metrics.every(({ pairedSampleCount }) => pairedSampleCount >= 3)) {
    plans.push({ kind: 'scatter', evidenceKeys: metrics.map(({ key }) => key) });
  }
  if (alerts.length) plans.push({ kind: 'alert-timeline', evidenceKeys: alerts.map(({ key }) => key) });
  const unique = [...new Map(plans.map((plan) => [signature(plan), plan])).values()];
  if (!unique.length) return null;
  const preferred = unique.find(({ kind }) => kind === preferredKind);
  const primary = preferred ?? unique[0]!;
  const supporting = unique.filter((plan) => (
    plan.kind !== primary.kind && signature(plan) !== signature(primary)
  )).slice(0, 2);
  return {
    summaryKeys: metrics.slice(0, 3).map(({ key }) => key),
    primary,
    supporting,
  };
}
