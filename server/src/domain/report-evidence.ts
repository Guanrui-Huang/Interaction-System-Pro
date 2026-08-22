import type { AnalysisEvidence } from './analysis-evidence';
import type { ReportEvidenceRef, ReportSlide } from '../../../shared/report';

export type KnowledgeContext = { key: string; topic: string; provenance: 'model-knowledge' };

export type PublicAssistantProfile = {
  key: 'assistant-profile';
  assistantName: '智慧水务 AI 助手';
  publicModelName?: string;
  capabilities: string[];
  limitations: string[];
};

export type UserCorrectionEvidence = {
  key: `user-correction:${string}`;
  evidenceKey: string;
  value: number;
  unit: string;
  statement: string;
  provenance: 'user-provided-unverified';
  sourceSlideId: string;
  sourceEvidenceSnapshotId: string;
  createdAt: string;
};

export type CorrectionSupersessionIntent = {
  followUpOrdinal: number;
  correctionSlideId: string;
  correctionEvidenceSnapshotId: string;
  sourceSlideId: string;
  sourceEvidenceSnapshotId: string;
  evidenceKey: string;
  value: number;
  unit: string;
  statement: string;
};

export type ReportEvidenceBundle = {
  snapshotId: string;
  analysis?: AnalysisEvidence;
  knowledge: KnowledgeContext[];
  assistantProfile?: PublicAssistantProfile;
  userCorrections?: UserCorrectionEvidence[];
};

export function correctionEvidenceForIntent(
  bundle: ReportEvidenceBundle,
  intent: CorrectionSupersessionIntent,
): UserCorrectionEvidence | undefined {
  if (bundle.snapshotId !== intent.correctionEvidenceSnapshotId) return undefined;
  return bundle.userCorrections?.find((correction) => (
    correction.evidenceKey === intent.evidenceKey
    && correction.value === intent.value
    && correction.unit === intent.unit
    && correction.statement === intent.statement
    && correction.sourceSlideId === intent.sourceSlideId
    && correction.sourceEvidenceSnapshotId === intent.sourceEvidenceSnapshotId
  ));
}

export function slideBindsCorrectionIntent(
  slide: ReportSlide,
  bundle: ReportEvidenceBundle,
  intent: CorrectionSupersessionIntent,
): boolean {
  const correction = correctionEvidenceForIntent(bundle, intent);
  if (
    !correction
    || slide.id !== intent.correctionSlideId
    || slide.evidenceSnapshotId !== intent.correctionEvidenceSnapshotId
  ) return false;
  const matchesCorrectionRef = (ref: ReportEvidenceRef): boolean => (
    ref.source === 'user-correction'
    && ref.kind === 'metric'
    && ref.key === correction.key
    && ref.snapshotId === intent.correctionEvidenceSnapshotId
    && ref.unit === correction.unit
    && ref.label.includes('用户提供')
    && /未.*核验/u.test(ref.label)
  );
  const hasRef = slide.evidenceRefs.some(matchesCorrectionRef);
  const hasClaim = slide.claims.some((claim) => (
    claim.kind === 'user-provided'
    && claim.text.includes('用户提供')
    && /未.*核验/u.test(claim.text)
    && claim.evidenceRefs.some(matchesCorrectionRef)
  ));
  const hasMetric = slide.metrics.some((metric) => (
    matchesCorrectionRef(metric)
    && metric.value === correction.value
  ));
  return hasRef && hasClaim && hasMetric;
}
