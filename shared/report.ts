import type { AnalysisModule, AnalysisScope } from './ai';
import type { BusinessPage } from './dashboard';

export const REPORT_MAX_SLIDES = 12;
export const REPORT_STATUSES = [
  'generating', 'awaiting-clarification', 'ready', 'partial', 'failed', 'cancelled',
] as const;
export const SLIDE_STATUSES = ['planned', 'generating', 'ready', 'failed'] as const;
export const ATOMIC_VISUAL_KINDS = [
  'kpi-grid', 'trend-line', 'trend-area', 'comparison-bars', 'health-ring',
  'radar', 'scatter', 'alert-timeline', 'process-flow', 'recommendation-path',
  'concept-map', 'capability-map',
] as const;
export const VISUAL_KINDS = [...ATOMIC_VISUAL_KINDS, 'data-dashboard'] as const;
export type AtomicVisualKind = typeof ATOMIC_VISUAL_KINDS[number];
export const REPORT_PHASES = [
  'understanding', 'retrieving-evidence', 'planning', 'generating-first-slide',
  'generating-slides', 'completed',
] as const;
export type ReportPhase = typeof REPORT_PHASES[number];
export const SLIDE_ROLES = ['answer', 'evidence', 'cause', 'risk', 'knowledge', 'action'] as const;
export const SLIDE_LAYOUTS = [
  'visual-focus', 'split-insight', 'dual-evidence', 'concept-center', 'action-path', 'diagnostic-overview',
] as const;
export const EVIDENCE_POLICIES = ['knowledge', 'data', 'mixed'] as const;

/** Public follow-up citation. Deliberately excludes private evidence snapshot IDs. */
export type EvidenceRef = {
  key: string;
  kind: 'metric' | 'alert' | 'health-weight' | 'knowledge' | 'user-provided';
  source: 'excel' | 'model-knowledge' | 'user-correction';
  module?: AnalysisModule;
  label: string;
  unit?: string;
  dateRange?: { from: string; to: string };
  sampleCount?: number;
};

export type ReportEvidenceRef = {
  key: string;
  kind: 'metric' | 'alert' | 'health-weight' | 'knowledge';
  source: 'excel' | 'model-knowledge' | 'assistant-profile' | 'user-correction';
  snapshotId: string;
  module?: AnalysisModule;
  label: string;
  unit?: string;
  dateRange?: { from: string; to: string };
  sampleCount?: number;
};

export type BoundMetric = ReportEvidenceRef & {
  claimIds: string[];
  value: number;
  limit?: number;
  status?: string;
  derivation?: {
    kind: 'difference' | 'percent-change' | 'share';
    operands: string[];
  };
};

export type BoundSeries = {
  key: string;
  label: string;
  unit: string;
  snapshotId: string;
  claimIds: string[];
  points: Array<{ label: string; value: number }>;
};

export type ClaimBoundEvidenceRef = ReportEvidenceRef & {
  claimIds: string[];
};

export type AtomicVisualSpec =
  | { kind: 'kpi-grid'; metrics: BoundMetric[] }
  | { kind: 'trend-line' | 'trend-area'; series: BoundSeries[] }
  | { kind: 'comparison-bars'; items: BoundMetric[] }
  | { kind: 'health-ring'; metric: BoundMetric; target?: number }
  | { kind: 'radar'; axes: Array<{ key: string; label: string; value: number; maximum: number; unit: string; snapshotId: string; claimIds: string[] }> }
  | { kind: 'scatter'; x: ClaimBoundEvidenceRef; y: ClaimBoundEvidenceRef; points: Array<{ label: string; x: number; y: number; claimIds: string[] }>; caveat: '统计关联不等于因果关系' }
  | { kind: 'alert-timeline'; items: Array<{ id: string; date: string; level: string; label: string; detail: string; snapshotId: string; claimIds: string[] }> }
  | { kind: 'process-flow' | 'recommendation-path'; provenance: 'model-knowledge'; steps: Array<{ id: string; title: string; detail: string; claimIds: string[] }> }
  | { kind: 'concept-map'; nodes: Array<{ id: string; title: string; detail?: string; claimIds: string[] }>; edges: Array<{ from: string; to: string; label?: string; claimIds: string[] }> }
  | { kind: 'capability-map'; items: Array<{ id: string; title: string; detail: string; claimIds: string[] }> };

export type AtomicDataVisualSpec = Extract<AtomicVisualSpec, {
  kind: 'trend-line' | 'trend-area' | 'comparison-bars' | 'health-ring' | 'radar' | 'scatter' | 'alert-timeline';
}>;

export type DataDashboardVisualSpec = {
  kind: 'data-dashboard';
  summaryMetrics: BoundMetric[];
  primary: AtomicDataVisualSpec;
  supporting: AtomicDataVisualSpec[];
};

export type VisualSpec = AtomicVisualSpec | DataDashboardVisualSpec;

export type BoundClaim = {
  id: string;
  text: string;
  kind: 'knowledge' | 'onsite-fact' | 'hypothesis' | 'user-provided';
  evidenceRefs: ReportEvidenceRef[];
  derivation?: {
    kind: 'difference' | 'percent-change' | 'share';
    operands: string[];
  };
};

export type NarrationSegment = {
  id: string;
  text: string;
  speechId: string;
  claimIds: string[];
};

export type NarrationCursor = { slideId: string; segmentId: string; offsetMs: number };

export type SlideOutline = {
  id: string;
  order: number;
  title: string;
  purpose: string;
  role: typeof SLIDE_ROLES[number];
  layout: typeof SLIDE_LAYOUTS[number];
  evidencePolicy: typeof EVIDENCE_POLICIES[number];
  visualKind: AtomicVisualKind;
  evidenceKeys: string[];
  status: typeof SLIDE_STATUSES[number];
  retryable?: boolean;
};

export type ReportSlide = {
  id: string;
  order: number;
  evidenceSnapshotId: string;
  supersededBySlideId?: string;
  role: typeof SLIDE_ROLES[number];
  layout: typeof SLIDE_LAYOUTS[number];
  evidencePolicy: typeof EVIDENCE_POLICIES[number];
  title: string;
  takeaway: string;
  takeawayClaimIds: string[];
  claims: BoundClaim[];
  visual: VisualSpec;
  metrics: BoundMetric[];
  evidenceRefs: ReportEvidenceRef[];
  narration: NarrationSegment[];
};

export type ConversationTurn = {
  id: string;
  question: string;
  answer: string;
  citedEvidence: EvidenceRef[];
  needsClarification: boolean;
  createdAt: string;
  thinkingDurationMs?: number;
};

export type ConversationSnapshot = {
  originalQuestion: string;
  turns: ConversationTurn[];
  compactSummary: string;
  activeSlideId?: string;
  narrationCursor?: NarrationCursor;
};

export type ClarificationRequest = {
  clarificationId: string;
  prompt: string;
  reason: 'ambiguous-subject' | 'ambiguous-period' | 'missing-evidence-scope';
  suggestions: string[];
};

export type ClarificationSubmission = {
  clarificationId: string;
  answer: string;
};

export type ReportJobSnapshot = {
  reportId: string;
  question: string;
  originPage: BusinessPage;
  scope: AnalysisScope;
  status: typeof REPORT_STATUSES[number];
  phase: typeof REPORT_PHASES[number] | null;
  clarification: ClarificationRequest | null;
  outline: SlideOutline[];
  slides: ReportSlide[];
  conversation: ConversationSnapshot;
  createdAt: string;
  expiresAt: string;
  lastSequence: number;
};

export type ReportEvent =
  | { type: 'report.outline'; sequence: number; outline: SlideOutline[] }
  | { type: 'report.state-changed'; sequence: number; status: typeof REPORT_STATUSES[number]; phase: typeof REPORT_PHASES[number] | null; clarification: ClarificationRequest | null }
  | { type: 'report.clarification-required'; sequence: number; clarification: ClarificationRequest }
  | { type: 'slide.generating'; sequence: number; slideId: string; order: number }
  | { type: 'slide.ready'; sequence: number; slide: ReportSlide }
  | { type: 'slide.failed'; sequence: number; slideId: string; retryable: boolean }
  | { type: 'report.completed'; sequence: number; status: 'ready' | 'partial' }
  | { type: 'report.failed'; sequence: number; code: import('./ai').AiErrorCode }
  | { type: 'report.cancelled'; sequence: number };

export type CreateReportRequest = { question: string; page: BusinessPage };

export type CreateReportResponse = {
  reportId: string;
  snapshot: ReportJobSnapshot;
};

export type FollowUpRequest = {
  question: string;
  slideId: string;
  interruptedSegmentId?: string;
  narrationOffsetMs?: number;
};

export type FollowUpResponse = {
  turnId: string;
  answer: string;
  speechId: string;
  citedEvidence: EvidenceRef[];
  needsClarification: boolean;
  resumeCursor: NarrationCursor;
};

export type UpdateReportSessionRequest = {
  activity: 'page' | 'narration' | 'heartbeat';
  activeSlideId?: string;
  narrationCursor?: NarrationCursor;
};
