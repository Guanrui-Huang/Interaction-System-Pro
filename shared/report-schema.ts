import { z } from 'zod';
import { ANALYSIS_GRANULARITIES, ANALYSIS_MODULES } from './ai';
import { BUSINESS_PAGES } from './dashboard';
import {
  ATOMIC_VISUAL_KINDS,
  EVIDENCE_POLICIES,
  REPORT_MAX_SLIDES,
  REPORT_PHASES,
  REPORT_STATUSES,
  SLIDE_LAYOUTS,
  SLIDE_ROLES,
  SLIDE_STATUSES,
  type AtomicDataVisualSpec,
  type AtomicVisualSpec,
  type DataDashboardVisualSpec,
  type VisualSpec,
} from './report';

const text = z.string().trim().min(1);
const finite = z.number().finite();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

export const opaqueIdSchema = text;

export const evidenceRefSchema = z.object({
  key: text,
  kind: z.enum(['metric', 'alert', 'health-weight', 'knowledge', 'user-provided']),
  source: z.enum(['excel', 'model-knowledge', 'user-correction']),
  module: z.enum(ANALYSIS_MODULES).optional(),
  label: text,
  unit: text.optional(),
  dateRange: z.object({ from: isoDate, to: isoDate }).strict().optional(),
  sampleCount: z.number().int().nonnegative().finite().optional(),
}).strict().superRefine((ref, context) => {
  if (ref.source !== 'user-correction' && ref.kind !== 'user-provided') return;
  if (
    ref.source !== 'user-correction'
    || ref.kind !== 'user-provided'
    || ref.module !== undefined
    || ref.dateRange !== undefined
    || ref.sampleCount !== undefined
    || !ref.label.includes('用户提供')
    || !ref.label.includes('未核验')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'User corrections must be explicitly unverified and must not carry Excel metadata.',
    });
  }
});

export const narrationCursorSchema = z.object({
  slideId: opaqueIdSchema,
  segmentId: opaqueIdSchema,
  offsetMs: z.number().int().nonnegative().finite(),
}).strict();

export const conversationTurnSchema = z.object({
  id: opaqueIdSchema,
  question: text,
  answer: text,
  citedEvidence: z.array(evidenceRefSchema),
  needsClarification: z.boolean(),
  createdAt: isoDateTime,
  thinkingDurationMs: z.number().finite().nonnegative().optional(),
}).strict();

export const conversationSnapshotSchema = z.object({
  originalQuestion: text,
  turns: z.array(conversationTurnSchema),
  compactSummary: z.string(),
  activeSlideId: opaqueIdSchema.optional(),
  narrationCursor: narrationCursorSchema.optional(),
}).strict();

export const analysisScopeSchema = z.object({
  modules: z.array(z.enum(ANALYSIS_MODULES)),
  metrics: z.array(text),
  dateRange: z.object({ from: isoDate, to: isoDate }).strict(),
  sampleCount: z.number().int().nonnegative().finite(),
  granularity: z.enum(ANALYSIS_GRANULARITIES),
}).strict();

const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;

export const createReportRequestSchema = z.object({
  question: z.string().trim().min(1).max(500),
  page: z.enum(BUSINESS_PAGES),
}).strict();

export const followUpRequestSchema = z.object({
  question: z.string().trim().min(1).max(500),
  slideId: opaqueIdSchema,
  interruptedSegmentId: opaqueIdSchema.optional(),
  narrationOffsetMs: z.number().int().nonnegative().finite().optional(),
}).strict().superRefine((request, context) => {
  if (request.narrationOffsetMs !== undefined && request.interruptedSegmentId === undefined) {
    context.addIssue({ code: 'custom', path: ['narrationOffsetMs'], message: 'A narration offset requires a segment.' });
  }
});

export const followUpResponseSchema = z.object({
  turnId: opaqueIdSchema,
  answer: text,
  speechId: opaqueIdSchema,
  citedEvidence: z.array(evidenceRefSchema),
  needsClarification: z.boolean(),
  resumeCursor: narrationCursorSchema,
}).strict();

export const updateReportSessionRequestSchema = z.object({
  activity: z.enum(['page', 'narration', 'heartbeat']),
  activeSlideId: opaqueIdSchema.optional(),
  narrationCursor: narrationCursorSchema.optional(),
}).strict();

export const reportEvidenceRefSchema = z.object({
  key: text,
  kind: z.enum(['metric', 'alert', 'health-weight', 'knowledge']),
  source: z.enum(['excel', 'model-knowledge', 'assistant-profile', 'user-correction']),
  snapshotId: text,
  module: z.enum(ANALYSIS_MODULES).optional(),
  label: text,
  unit: text.optional(),
  dateRange: z.object({ from: isoDate, to: isoDate }).strict().optional(),
  sampleCount: z.number().int().nonnegative().finite().optional(),
}).strict();

const claimIdsSchema = z.array(opaqueIdSchema).min(1).refine(distinct, {
  message: 'Claim IDs must be unique.',
});

export const boundMetricSchema = reportEvidenceRefSchema.extend({
  claimIds: claimIdsSchema,
  value: finite,
  limit: finite.optional(),
  status: text.optional(),
  derivation: z.object({
    kind: z.enum(['difference', 'percent-change', 'share']),
    operands: z.array(text).min(1),
  }).strict().optional(),
}).strict();

export const boundSeriesSchema = z.object({
  key: text,
  label: text,
  unit: text,
  snapshotId: text,
  claimIds: claimIdsSchema,
  points: z.array(z.object({ label: text, value: finite }).strict()).min(2),
}).strict();

const claimBoundEvidenceRefSchema = reportEvidenceRefSchema.extend({
  claimIds: claimIdsSchema,
}).strict();

const conceptMapSchema = z.object({
  kind: z.literal('concept-map'),
  nodes: z.array(z.object({
    id: opaqueIdSchema,
    title: text,
    detail: text.optional(),
    claimIds: claimIdsSchema,
  }).strict()).min(1),
  edges: z.array(z.object({
    from: opaqueIdSchema,
    to: opaqueIdSchema,
    label: text.optional(),
    claimIds: claimIdsSchema,
  }).strict()),
}).strict().superRefine((visual, context) => {
  const nodeIds = visual.nodes.map(({ id }) => id);
  if (!distinct(nodeIds)) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'Concept node IDs must be unique.' });
  }
  const known = new Set(nodeIds);
  visual.edges.forEach((edge, index) => {
    if (!known.has(edge.from) || !known.has(edge.to)) {
      context.addIssue({ code: 'custom', path: ['edges', index], message: 'Concept edges must reference known nodes.' });
    }
  });
});

export const atomicVisualSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('kpi-grid'), metrics: z.array(boundMetricSchema).min(1) }).strict(),
  z.object({ kind: z.literal('trend-line'), series: z.array(boundSeriesSchema).min(1) }).strict(),
  z.object({ kind: z.literal('trend-area'), series: z.array(boundSeriesSchema).min(1) }).strict(),
  z.object({ kind: z.literal('comparison-bars'), items: z.array(boundMetricSchema).min(2) }).strict()
    .superRefine((visual, context) => {
      const units = visual.items.map(({ unit }) => unit);
      if (units.some((unit) => unit === undefined) || new Set(units).size !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['items'],
          message: 'Comparison bars require one shared non-empty unit.',
        });
      }
    }),
  z.object({ kind: z.literal('health-ring'), metric: boundMetricSchema, target: finite.optional() }).strict()
    .superRefine((visual, context) => {
      if (visual.metric.value < 0) {
        context.addIssue({
          code: 'custom',
          path: ['metric', 'value'],
          message: 'Health ring metrics must be nonnegative.',
        });
      }
      if (visual.target !== undefined && visual.target <= 0) {
        context.addIssue({
          code: 'custom',
          path: ['target'],
          message: 'Health ring targets must be positive.',
        });
      }
    }),
  z.object({
    kind: z.literal('radar'),
    axes: z.array(z.object({
      key: text,
      label: text,
      value: finite,
      maximum: finite.positive(),
      unit: text,
      snapshotId: text,
      claimIds: claimIdsSchema,
    }).strict()).min(3).max(6),
  }).strict(),
  z.object({
    kind: z.literal('scatter'),
    x: claimBoundEvidenceRefSchema,
    y: claimBoundEvidenceRefSchema,
    points: z.array(z.object({
      label: text,
      x: finite,
      y: finite,
      claimIds: claimIdsSchema,
    }).strict()).min(1),
    caveat: z.literal('统计关联不等于因果关系'),
  }).strict(),
  z.object({
    kind: z.literal('alert-timeline'),
    items: z.array(z.object({
      id: opaqueIdSchema,
      date: isoDate,
      level: text,
      label: text,
      detail: text,
      snapshotId: text,
      claimIds: claimIdsSchema,
    }).strict()).min(1),
  }).strict(),
  z.object({
    kind: z.literal('process-flow'),
    provenance: z.literal('model-knowledge'),
    steps: z.array(z.object({
      id: opaqueIdSchema,
      title: text,
      detail: text,
      claimIds: claimIdsSchema,
    }).strict()).min(1),
  }).strict(),
  z.object({
    kind: z.literal('recommendation-path'),
    provenance: z.literal('model-knowledge'),
    steps: z.array(z.object({
      id: opaqueIdSchema,
      title: text,
      detail: text,
      claimIds: claimIdsSchema,
    }).strict()).min(1),
  }).strict(),
  conceptMapSchema,
  z.object({
    kind: z.literal('capability-map'),
    items: z.array(z.object({
      id: opaqueIdSchema,
      title: text,
      detail: text,
      claimIds: claimIdsSchema,
    }).strict()).min(1),
  }).strict(),
]);

const atomicDataVisualSpecSchema: z.ZodType<AtomicDataVisualSpec> = atomicVisualSpecSchema.refine((visual) => ![
  'kpi-grid', 'process-flow', 'recommendation-path', 'concept-map', 'capability-map',
].includes(visual.kind), { message: 'Dashboard visuals must be data charts.' }) as z.ZodType<AtomicDataVisualSpec>;

export const dataDashboardVisualSpecSchema: z.ZodType<DataDashboardVisualSpec> = z.object({
  kind: z.literal('data-dashboard'),
  summaryMetrics: z.array(boundMetricSchema).max(3),
  primary: atomicDataVisualSpecSchema.refine(() => true, { message: 'Dashboard primary must be a data chart.' }),
  supporting: z.array(
    atomicDataVisualSpecSchema.refine(() => true, { message: 'Dashboard supporting visuals must be data charts.' }),
  ).max(2),
}).strict();

export const visualSpecSchema: z.ZodType<VisualSpec> = z.union([
  atomicVisualSpecSchema,
  dataDashboardVisualSpecSchema,
]);

export const boundClaimSchema = z.object({
  id: opaqueIdSchema,
  text,
  kind: z.enum(['knowledge', 'onsite-fact', 'hypothesis', 'user-provided']),
  evidenceRefs: z.array(reportEvidenceRefSchema),
  derivation: z.object({
    kind: z.enum(['difference', 'percent-change', 'share']),
    operands: z.array(text).min(1),
  }).strict().optional(),
}).strict();

export const narrationSegmentSchema = z.object({
  id: opaqueIdSchema,
  text,
  speechId: opaqueIdSchema,
  claimIds: z.array(opaqueIdSchema).min(1),
}).strict().superRefine((segment, context) => {
  if (!distinct(segment.claimIds)) {
    context.addIssue({ code: 'custom', path: ['claimIds'], message: 'Narration claim IDs must be unique.' });
  }
});

export const slideOutlineSchema = z.object({
  id: opaqueIdSchema,
  order: z.number().int().nonnegative().finite(),
  title: text,
  purpose: text,
  role: z.enum(SLIDE_ROLES),
  layout: z.enum(SLIDE_LAYOUTS),
  evidencePolicy: z.enum(EVIDENCE_POLICIES),
  visualKind: z.enum(ATOMIC_VISUAL_KINDS),
  evidenceKeys: z.array(text),
  status: z.enum(SLIDE_STATUSES),
  retryable: z.boolean().optional(),
}).strict();

function atomicVisualEvidenceKeys(visual: AtomicVisualSpec): string[] {
  switch (visual.kind) {
    case 'kpi-grid': return visual.metrics.map(({ key }) => key);
    case 'trend-line':
    case 'trend-area': return visual.series.map(({ key }) => key);
    case 'comparison-bars': return visual.items.map(({ key }) => key);
    case 'health-ring': return [visual.metric.key];
    case 'radar': return visual.axes.map(({ key }) => key);
    case 'scatter': return [visual.x.key, visual.y.key];
    case 'alert-timeline': return visual.items.map(({ id }) => id);
    case 'process-flow':
    case 'recommendation-path':
    case 'concept-map':
    case 'capability-map': return [];
  }
}

function atomicVisualSignature(visual: AtomicVisualSpec): string {
  return `${visual.kind}:${atomicVisualEvidenceKeys(visual).sort().join(',')}`;
}

function evidenceRefIdentity(ref: z.infer<typeof reportEvidenceRefSchema>): string {
  return `${ref.snapshotId}\u0000${ref.source}\u0000${ref.key}`;
}

export const reportSlideSchema = z.object({
  id: opaqueIdSchema,
  order: z.number().int().nonnegative().finite(),
  evidenceSnapshotId: text,
  supersededBySlideId: opaqueIdSchema.optional(),
  role: z.enum(SLIDE_ROLES),
  layout: z.enum(SLIDE_LAYOUTS),
  evidencePolicy: z.enum(EVIDENCE_POLICIES),
  title: text,
  takeaway: text,
  takeawayClaimIds: z.array(opaqueIdSchema).min(1),
  claims: z.array(boundClaimSchema).min(1),
  visual: visualSpecSchema,
  metrics: z.array(boundMetricSchema).max(3),
  evidenceRefs: z.array(reportEvidenceRefSchema),
  narration: z.array(narrationSegmentSchema).min(2).max(4),
}).strict().superRefine((slide, context) => {
  const claimIds = slide.claims.map(({ id }) => id);
  if (!distinct(claimIds)) {
    context.addIssue({ code: 'custom', path: ['claims'], message: 'Claim IDs must be unique.' });
  }
  const knownClaims = new Set(claimIds);
  if (!distinct(slide.takeawayClaimIds) || slide.takeawayClaimIds.some((id) => !knownClaims.has(id))) {
    context.addIssue({ code: 'custom', path: ['takeawayClaimIds'], message: 'Takeaway claim IDs must reference unique known claims.' });
  }
  slide.narration.forEach((segment, index) => {
    if (segment.claimIds.some((id) => !knownClaims.has(id))) {
      context.addIssue({ code: 'custom', path: ['narration', index, 'claimIds'], message: 'Narration must reference known claims.' });
    }
  });

  const pageRefIds = slide.evidenceRefs.map(evidenceRefIdentity);
  if (!distinct(pageRefIds)) {
    context.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'Page evidence references must be unique.' });
  }
  if (slide.evidenceRefs.some(({ snapshotId }) => snapshotId !== slide.evidenceSnapshotId)) {
    context.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'Page evidence must use its immutable snapshot.' });
  }
  const pageRefs = new Set(pageRefIds);
  const claimById = new Map(slide.claims.map((claim) => [claim.id, claim]));
  const validateClaimIds = (ids: readonly string[], path: (string | number)[]) => {
    if (!distinct(ids) || ids.some((id) => !knownClaims.has(id))) {
      context.addIssue({ code: 'custom', path, message: 'Visual claim IDs must reference unique known claims.' });
    }
  };
  const validateKnowledgeClaimIds = (ids: readonly string[], path: (string | number)[]) => {
    validateClaimIds(ids, path);
    if (ids.some((id) => !claimById.get(id)?.evidenceRefs.some(({ source }) => (
      source === 'model-knowledge' || source === 'assistant-profile'
    )))) {
      context.addIssue({
        code: 'custom',
        path,
        message: 'Knowledge visual claims must cite model knowledge or assistant profile evidence.',
      });
    }
  };
  const validateEvidenceBinding = (
    ref: {
      key: string;
      snapshotId: string;
      source?: string;
      kind?: string;
      unit?: string;
      module?: string;
      dateRange?: unknown;
      sampleCount?: number;
      claimIds: readonly string[];
    },
    path: (string | number)[],
  ) => {
    validateClaimIds(ref.claimIds, [...path, 'claimIds']);
    const inPageLedger = slide.evidenceRefs.some((pageRef) => (
      pageRef.key === ref.key
      && pageRef.snapshotId === ref.snapshotId
      && (ref.source === undefined || pageRef.source === ref.source)
    ));
    if (ref.snapshotId !== slide.evidenceSnapshotId || !inPageLedger) {
      context.addIssue({ code: 'custom', path, message: 'Visual evidence must belong to the page snapshot ledger.' });
    }
    if (ref.claimIds.some((id) => !claimById.get(id)?.evidenceRefs.some((claimRef) => (
      claimRef.key === ref.key && claimRef.snapshotId === ref.snapshotId
    )))) {
      context.addIssue({ code: 'custom', path: [...path, 'claimIds'], message: 'Visual claim IDs must cite this evidence key.' });
    }
    if (ref.source === 'user-correction' && (
      ref.kind !== 'metric'
      || !ref.unit
      || ref.module !== undefined
      || ref.dateRange !== undefined
      || ref.sampleCount !== undefined
    )) {
      context.addIssue({
        code: 'custom',
        path,
        message: 'User corrections cannot carry inferred Excel scope metadata.',
      });
    }
  };
  const validateCorrectionRef = (
    ref: z.infer<typeof reportEvidenceRefSchema>,
    path: (string | number)[],
  ) => {
    if (ref.source === 'user-correction' && (
      ref.kind !== 'metric'
      || !ref.unit
      || ref.module !== undefined
      || ref.dateRange !== undefined
      || ref.sampleCount !== undefined
    )) {
      context.addIssue({
        code: 'custom',
        path,
        message: 'User corrections cannot carry inferred Excel scope metadata.',
      });
    }
  };
  slide.evidenceRefs.forEach((ref, index) => validateCorrectionRef(ref, ['evidenceRefs', index]));
  slide.claims.forEach((claim, claimIndex) => {
    if (claim.evidenceRefs.some((ref) => (
      ref.snapshotId !== slide.evidenceSnapshotId || !pageRefs.has(evidenceRefIdentity(ref))
    ))) {
      context.addIssue({ code: 'custom', path: ['claims', claimIndex, 'evidenceRefs'], message: 'Claim evidence must belong to the page evidence ledger.' });
    }
    claim.evidenceRefs.forEach((ref, refIndex) => validateCorrectionRef(
      ref,
      ['claims', claimIndex, 'evidenceRefs', refIndex],
    ));
    const sources = claim.evidenceRefs.map(({ source }) => source);
    if (
      (claim.kind === 'onsite-fact' && (!sources.length || sources.some((source) => source !== 'excel')))
      || (claim.kind === 'user-provided' && (!sources.length || sources.some((source) => source !== 'user-correction')))
      || (claim.kind === 'knowledge' && sources.some((source) => (
        source !== 'model-knowledge' && source !== 'assistant-profile'
      )))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['claims', claimIndex, 'kind'],
        message: 'Claim kind must match its evidence provenance.',
      });
    }
  });
  slide.metrics.forEach((metric, index) => {
    validateEvidenceBinding(metric, ['metrics', index]);
  });

  const validateVisual = (visual: z.infer<typeof visualSpecSchema>, path: (string | number)[]) => {
    switch (visual.kind) {
      case 'kpi-grid':
        visual.metrics.forEach((metric, index) => validateEvidenceBinding(metric, [...path, 'metrics', index]));
        break;
      case 'comparison-bars':
        visual.items.forEach((metric, index) => validateEvidenceBinding(metric, [...path, 'items', index]));
        break;
      case 'health-ring':
        validateEvidenceBinding(visual.metric, [...path, 'metric']);
        break;
      case 'trend-line':
      case 'trend-area':
        visual.series.forEach((series, index) => validateEvidenceBinding(series, [...path, 'series', index]));
        break;
      case 'radar':
        visual.axes.forEach((axis, index) => validateEvidenceBinding(axis, [...path, 'axes', index]));
        break;
      case 'scatter': {
        validateEvidenceBinding(visual.x, [...path, 'x']);
        validateEvidenceBinding(visual.y, [...path, 'y']);
        const coordinateClaims = new Set([...visual.x.claimIds, ...visual.y.claimIds]);
        visual.points.forEach((point, index) => {
          validateClaimIds(point.claimIds, [...path, 'points', index, 'claimIds']);
          if (point.claimIds.some((id) => !coordinateClaims.has(id))) {
            context.addIssue({
              code: 'custom',
              path: [...path, 'points', index, 'claimIds'],
              message: 'Scatter point claims must be bound to an axis.',
            });
          }
        });
        break;
      }
      case 'alert-timeline':
        visual.items.forEach((item, index) => validateEvidenceBinding({
          key: item.id,
          snapshotId: item.snapshotId,
          claimIds: item.claimIds,
        }, [...path, 'items', index]));
        break;
      case 'process-flow':
      case 'recommendation-path':
        visual.steps.forEach((step, index) => validateKnowledgeClaimIds(
          step.claimIds,
          [...path, 'steps', index, 'claimIds'],
        ));
        break;
      case 'concept-map':
        visual.nodes.forEach((node, index) => validateKnowledgeClaimIds(
          node.claimIds,
          [...path, 'nodes', index, 'claimIds'],
        ));
        visual.edges.forEach((edge, index) => validateKnowledgeClaimIds(
          edge.claimIds,
          [...path, 'edges', index, 'claimIds'],
        ));
        break;
      case 'capability-map':
        visual.items.forEach((item, index) => validateKnowledgeClaimIds(
          item.claimIds,
          [...path, 'items', index, 'claimIds'],
        ));
        break;
      case 'data-dashboard': {
        visual.summaryMetrics.forEach((metric, index) => validateEvidenceBinding(metric, [...path, 'summaryMetrics', index]));
        validateVisual(visual.primary, [...path, 'primary']);
        visual.supporting.forEach((item, index) => validateVisual(item, [...path, 'supporting', index]));
        const signatures = [visual.primary, ...visual.supporting].map(atomicVisualSignature);
        if (!distinct(signatures)) {
          context.addIssue({
            code: 'custom',
            path,
            message: 'Dashboard atomic visuals must use unique evidence signatures.',
          });
        }
        break;
      }
    }
  };

  validateVisual(slide.visual, ['visual']);
});

export const reportOutlineSchema = z.array(slideOutlineSchema).max(REPORT_MAX_SLIDES)
  .superRefine((outline, context) => {
    if (!distinct(outline.map(({ id }) => id))) {
      context.addIssue({ code: 'custom', message: 'Slide outline IDs must be unique.' });
    }
    outline.forEach((slide, index) => {
      if (slide.order !== index) {
        context.addIssue({ code: 'custom', path: [index, 'order'], message: 'Slide outline order must equal its zero-based index.' });
      }
    });
  });

export const clarificationRequestSchema = z.object({
  clarificationId: opaqueIdSchema,
  prompt: text,
  reason: z.enum(['ambiguous-subject', 'ambiguous-period', 'missing-evidence-scope']),
  suggestions: z.array(text),
}).strict();

export const clarificationSubmissionSchema = z.object({
  clarificationId: opaqueIdSchema,
  answer: z.string().trim().min(1).max(500),
}).strict();

export const reportJobSnapshotSchema = z.object({
  reportId: opaqueIdSchema,
  question: z.string().trim().min(1).max(500),
  originPage: z.enum(BUSINESS_PAGES),
  scope: analysisScopeSchema,
  status: z.enum(REPORT_STATUSES),
  phase: z.enum(REPORT_PHASES).nullable(),
  clarification: clarificationRequestSchema.nullable(),
  outline: reportOutlineSchema,
  slides: z.array(reportSlideSchema).max(REPORT_MAX_SLIDES),
  conversation: conversationSnapshotSchema,
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  lastSequence: z.number().int().nonnegative().finite(),
}).strict().superRefine((snapshot, context) => {
  const terminalWithoutPhase = ['awaiting-clarification', 'failed', 'cancelled'].includes(snapshot.status);
  if (terminalWithoutPhase && snapshot.phase !== null) {
    context.addIssue({ code: 'custom', path: ['phase'], message: 'This report state cannot have an active phase.' });
  }
  if (snapshot.status === 'generating' && (snapshot.phase === null || snapshot.phase === 'completed')) {
    context.addIssue({ code: 'custom', path: ['phase'], message: 'A generating report requires an active generation phase.' });
  }
  if (snapshot.status === 'awaiting-clarification' && snapshot.clarification === null) {
    context.addIssue({ code: 'custom', path: ['clarification'], message: 'An awaiting report requires clarification.' });
  }
  if (snapshot.status !== 'awaiting-clarification' && snapshot.clarification !== null) {
    context.addIssue({ code: 'custom', path: ['clarification'], message: 'Only an awaiting report may expose clarification.' });
  }
  if (snapshot.status === 'ready' || snapshot.status === 'partial') {
    if (snapshot.phase !== 'completed') {
      context.addIssue({ code: 'custom', path: ['phase'], message: 'A settled report requires the completed phase.' });
    }
    if (snapshot.slides.length === 0) {
      context.addIssue({ code: 'custom', path: ['slides'], message: 'A ready or partial report requires a ready page.' });
    }
  } else if (snapshot.phase === 'completed') {
    context.addIssue({ code: 'custom', path: ['phase'], message: 'Only ready or partial reports may be completed.' });
  }

  if (!distinct(snapshot.slides.map(({ id }) => id))) {
    context.addIssue({ code: 'custom', path: ['slides'], message: 'Slide IDs must be unique.' });
  }
  if (!distinct(snapshot.slides.map(({ order }) => String(order)))) {
    context.addIssue({ code: 'custom', path: ['slides'], message: 'Slide orders must be unique.' });
  }
  snapshot.slides.forEach((slide, index) => {
    const previous = snapshot.slides[index - 1];
    if ((index === 0 && slide.order !== 0) || (previous && slide.order <= previous.order)) {
      context.addIssue({
        code: 'custom',
        path: ['slides', index, 'order'],
        message: 'Published slides must start at zero and be strictly ascending.',
      });
    }
  });
  const outlineById = new Map(snapshot.outline.map((item) => [item.id, item]));
  const slideById = new Map(snapshot.slides.map((slide) => [slide.id, slide]));
  if (snapshot.slides.length > 0 && snapshot.slides.every(({ supersededBySlideId }) => supersededBySlideId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['slides'], message: 'A report must retain at least one current page.' });
  }
  snapshot.slides.forEach((slide, index) => {
    const planned = outlineById.get(slide.id);
    if (!planned || planned.order !== slide.order || planned.status !== 'ready') {
      context.addIssue({ code: 'custom', path: ['slides', index], message: 'Every slide must match a ready outline item.' });
    }
    if (slide.supersededBySlideId !== undefined) {
      const target = slideById.get(slide.supersededBySlideId);
      if (!target || target.order <= slide.order) {
        context.addIssue({
          code: 'custom',
          path: ['slides', index, 'supersededBySlideId'],
          message: 'A supersession target must be an existing later page.',
        });
      }
    }
  });
  snapshot.outline.forEach((planned, index) => {
    if (planned.status === 'ready' && !slideById.has(planned.id)) {
      context.addIssue({
        code: 'custom',
        path: ['outline', index, 'status'],
        message: 'Every ready outline item must have its matching published slide.',
      });
    }
  });

  if (snapshot.status === 'failed' && snapshot.slides.length > 0) {
    context.addIssue({ code: 'custom', path: ['slides'], message: 'Failed reports cannot publish slides.' });
  }
  if (snapshot.status === 'ready') {
    if (
      snapshot.outline.length === 0
      || snapshot.outline.some(({ status }) => status !== 'ready')
      || snapshot.slides.length !== snapshot.outline.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['outline'],
        message: 'A ready report requires every outline item to be ready and published.',
      });
    }
  }
  if (snapshot.status === 'partial') {
    const readyCount = snapshot.outline.filter(({ status }) => status === 'ready').length;
    const failedCount = snapshot.outline.filter(({ status }) => status === 'failed').length;
    const allSettled = snapshot.outline.every(({ status }) => status === 'ready' || status === 'failed');
    if (
      readyCount < 1
      || failedCount < 1
      || !allSettled
      || snapshot.slides.length !== readyCount
    ) {
      context.addIssue({
        code: 'custom',
        path: ['outline'],
        message: 'A partial report requires both ready and failed settled outline items.',
      });
    }
  }
});

const reportEventSequence = z.number().int().positive().finite();
const reportAiErrorCodeSchema = z.enum([
  'MISSING_CONFIGURATION', 'UPSTREAM_TIMEOUT', 'UPSTREAM_HTTP', 'MALFORMED_RESPONSE', 'EMPTY_ANSWER', 'INVALID_REQUEST', 'NO_EVIDENCE',
  'REPORT_NOT_FOUND', 'REPORT_EXPIRED', 'REPORT_CAPACITY', 'REPORT_EVENT_GAP', 'REPORT_CANCELLED', 'REPORT_STALE_TURN',
]);
const reportStateChangedEventSchema = z.object({
  type: z.literal('report.state-changed'),
  sequence: reportEventSequence,
  status: z.enum(REPORT_STATUSES),
  phase: z.enum(REPORT_PHASES).nullable(),
  clarification: clarificationRequestSchema.nullable(),
}).strict().superRefine((event, context) => {
  if (event.status === 'generating') {
    if (event.phase === null || event.phase === 'completed' || event.clarification !== null) {
      context.addIssue({ code: 'custom', message: 'A generating event requires an active generation phase and no clarification.' });
    }
    return;
  }
  if (event.status === 'awaiting-clarification') {
    if (event.phase !== null || event.clarification === null) {
      context.addIssue({ code: 'custom', message: 'An awaiting event requires clarification and no active phase.' });
    }
    return;
  }
  if (event.clarification !== null) {
    context.addIssue({ code: 'custom', path: ['clarification'], message: 'A settled event cannot expose clarification.' });
  }
  const completed = event.status === 'ready' || event.status === 'partial';
  if ((completed && event.phase !== 'completed') || (!completed && event.phase !== null)) {
    context.addIssue({ code: 'custom', path: ['phase'], message: 'The event phase must match its settled state.' });
  }
});
export const reportEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('report.outline'), sequence: reportEventSequence, outline: reportOutlineSchema.min(1) }).strict(),
  reportStateChangedEventSchema,
  z.object({
    type: z.literal('report.clarification-required'),
    sequence: reportEventSequence,
    clarification: clarificationRequestSchema,
  }).strict(),
  z.object({ type: z.literal('slide.generating'), sequence: reportEventSequence, slideId: opaqueIdSchema, order: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('slide.ready'), sequence: reportEventSequence, slide: reportSlideSchema }).strict(),
  z.object({ type: z.literal('slide.failed'), sequence: reportEventSequence, slideId: opaqueIdSchema, retryable: z.boolean() }).strict(),
  z.object({ type: z.literal('report.completed'), sequence: reportEventSequence, status: z.enum(['ready', 'partial']) }).strict(),
  z.object({ type: z.literal('report.failed'), sequence: reportEventSequence, code: reportAiErrorCodeSchema }).strict(),
  z.object({ type: z.literal('report.cancelled'), sequence: reportEventSequence }).strict(),
]);

export const createReportResponseSchema = z.object({
  reportId: opaqueIdSchema,
  snapshot: reportJobSnapshotSchema,
}).strict();
