import { expect, it } from 'vitest';
import type { BoundClaim } from '../../shared/report';
import { bindAtomicReportVisual } from '../src/domain/report-content-validation';
import type { ReportEvidenceBundle } from '../src/domain/report-evidence';

const scoreKeys = ['qualityScore', 'energyScore', 'flowScore'] as const;
const dateRange = { from: '2026-08-01', to: '2026-08-02' } as const;

const bundle: ReportEvidenceBundle = {
  snapshotId: 'evidence:radar-binding',
  knowledge: [],
  analysis: {
    scope: { modules: ['health'], metrics: [...scoreKeys], dateRange, sampleCount: 2, granularity: 'daily' },
    definitions: [
      { key: 'qualityScore', label: '出水水质得分', unit: '分' },
      { key: 'energyScore', label: '电耗得分', unit: '分' },
      { key: 'flowScore', label: '水量波动得分', unit: '分' },
    ],
    series: [
      { date: '2026-08-01', values: { qualityScore: 94, energyScore: 86, flowScore: 78 } },
      { date: '2026-08-02', values: { qualityScore: 95, energyScore: 90, flowScore: 81 } },
    ],
    aggregates: {
      qualityScore: { min: 94, max: 95, average: 94.5, latest: 95, changeRate: 0.01 },
      energyScore: { min: 86, max: 90, average: 88, latest: 90, changeRate: 0.04 },
      flowScore: { min: 78, max: 81, average: 79.5, latest: 81, changeRate: 0.03 },
    },
    thresholdBreaches: [],
    correlations: [],
    alerts: [],
  },
};

const claims: BoundClaim[] = scoreKeys.map((key, index) => ({
  id: `claim-${index + 1}`,
  text: `${key} 当前得分已绑定现场证据。`,
  kind: 'onsite-fact',
  evidenceRefs: [{
    key,
    kind: 'metric',
    source: 'excel',
    snapshotId: bundle.snapshotId,
    module: 'health',
    label: key,
    unit: '分',
    dateRange,
    sampleCount: 2,
  }],
}));

it('binds score radar axes to a shared 100-point maximum', () => {
  const visual = bindAtomicReportVisual('radar', scoreKeys, bundle, undefined, 'radar-slide', claims);

  expect(visual.kind).toBe('radar');
  if (visual.kind !== 'radar') return;
  expect(visual.axes.map((axis) => axis.value)).toEqual([95, 90, 81]);
  expect(visual.axes.map((axis) => axis.maximum)).toEqual([100, 100, 100]);
});
