import { createHash } from 'node:crypto';
import type { DashboardDataset } from '../../../shared/dashboard';
import { buildAnalysisEvidence, redactAnalysisText } from './analysis-evidence';
import { publicAssistantProfile } from './public-assistant-profile';
import type { KnowledgeContext, ReportEvidenceBundle } from './report-evidence';
import type { ReportIntentPlan } from './report-intent';

type ReportIntent = Extract<ReportIntentPlan, { kind: 'report' }>;

export type ResolveReportEvidenceInput = {
  intent: ReportIntent;
  dataset: DashboardDataset;
  modelId: string;
};

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;

  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function selectedAlertId(alert: { date: string; metric: string; level: string; reason: string; recommendation: string }): string {
  return JSON.stringify([alert.date, alert.metric, alert.level, alert.reason, alert.recommendation]);
}

function snapshotId(input: Omit<ReportEvidenceBundle, 'snapshotId'>): string {
  const analysis = input.analysis;
  const exposedEvidence = {
    topics: input.knowledge.map(({ topic }) => topic).sort((left, right) => left.localeCompare(right)),
    metricKeys: [...(analysis?.scope.metrics ?? [])].sort((left, right) => left.localeCompare(right)),
    dateRange: analysis?.scope.dateRange ?? null,
    sampleCount: analysis?.scope.sampleCount ?? null,
    selectedAlertIds: (analysis?.alerts ?? [])
      .map(selectedAlertId)
      .sort((left, right) => left.localeCompare(right)),
    healthWeightsIncluded: analysis?.healthWeights !== undefined,
    assistantProfile: input.assistantProfile === undefined
      ? null
      : {
          key: input.assistantProfile.key,
          publicModelName: input.assistantProfile.publicModelName ?? null,
        },
  };
  const digest = createHash('sha256').update(JSON.stringify(exposedEvidence)).digest('hex');
  return `evidence:${digest}`;
}

export function resolveReportEvidence(input: ResolveReportEvidenceInput): ReportEvidenceBundle {
  const analysis = input.intent.analysisPlan === undefined
    ? undefined
    : buildAnalysisEvidence({ plan: input.intent.analysisPlan, dataset: input.dataset });
  const knowledge: KnowledgeContext[] = input.intent.knowledgeTopics.map((topic, index) => ({
    key: `knowledge:${index}`,
    topic: redactAnalysisText(topic, [input.modelId]),
    provenance: 'model-knowledge',
  }));
  const assistantProfile = input.intent.assistantProfile
    ? publicAssistantProfile(input.modelId)
    : undefined;
  const exposedEvidence = {
    analysis,
    knowledge,
    ...(assistantProfile === undefined ? {} : { assistantProfile }),
  };

  return deepFreeze({
    snapshotId: snapshotId(exposedEvidence),
    ...exposedEvidence,
  });
}
