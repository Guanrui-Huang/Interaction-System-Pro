import { z } from 'zod';
import {
  ATOMIC_VISUAL_KINDS,
  EVIDENCE_POLICIES,
  REPORT_MAX_SLIDES,
  SLIDE_LAYOUTS,
  SLIDE_ROLES,
  type AtomicDataVisualSpec,
  type AtomicVisualKind,
  type AtomicVisualSpec,
  type BoundClaim,
  type BoundMetric,
  type ReportEvidenceRef,
  type SlideOutline,
  type VisualSpec,
} from '../../../shared/report';
import { ANALYSIS_METRICS, type AnalysisMetricKey } from './analysis-plan';
import { redactAnalysisText, type AnalysisEvidence } from './analysis-evidence';
import {
  matchMetricAliases,
  METRIC_ALIASES,
  type MetricAliasCatalog,
} from './metric-aliases';
import type { ReportEvidenceBundle } from './report-evidence';
import {
  planDataDashboardVisual,
  type AtomicDataVisualPlan,
  type VisualEvidenceCandidate,
} from './report-visual-planner';
import { StructuredModelOutputShapeError } from '../services/structured-model-output';

export type ModelReportPlan = {
  slides: Array<{
    title: string;
    purpose: string;
    role: typeof SLIDE_ROLES[number];
    layout: typeof SLIDE_LAYOUTS[number];
    visualKind: AtomicVisualKind;
    evidenceKeys: string[];
  }>;
};

export type ModelSlideDraft = {
  title: string;
  takeaway: string;
  takeawayClaimIds: string[];
  visualKind: AtomicVisualKind;
  evidenceKeys: string[];
  claims: Array<{
    id: string;
    text: string;
    kind: 'knowledge' | 'onsite-fact' | 'hypothesis' | 'user-provided';
    evidenceKeys: string[];
  }>;
  narration: Array<{ text: string; claimIds: string[] }>;
  knowledgeItems?: Array<{ title: string; detail: string }>;
};

export class ReportContentValidationError extends Error {
  constructor(readonly code: 'REPORT_OUTLINE_INVALID' | 'REPORT_SLIDE_DRAFT_INVALID' | 'REPORT_EVIDENCE_INVALID') {
    super(code);
    this.name = 'ReportContentValidationError';
  }
}

export class UnsafeReportContentError extends ReportContentValidationError {
  constructor(code: 'REPORT_OUTLINE_INVALID' | 'REPORT_SLIDE_DRAFT_INVALID') {
    super(code);
    this.name = 'UnsafeReportContentError';
  }
}

export class PersistentSafeSlideOutputError extends ReportContentValidationError {
  constructor(code: 'REPORT_SLIDE_DRAFT_INVALID' | 'REPORT_EVIDENCE_INVALID') {
    super(code);
    this.name = 'PersistentSafeSlideOutputError';
  }
}

const modelText = z.string().trim().min(1).max(500);
const evidenceKey = z.string().trim().min(1).max(200);
const modelPlanSlideSchema = z.object({
  title: modelText,
  purpose: modelText,
  role: z.enum(SLIDE_ROLES),
  layout: z.enum(SLIDE_LAYOUTS),
  visualKind: z.enum(ATOMIC_VISUAL_KINDS),
  evidenceKeys: z.array(evidenceKey).max(20),
}).strict();
const modelReportPlanSchema = z.object({
  slides: z.array(modelPlanSlideSchema).min(1).max(REPORT_MAX_SLIDES),
}).strict();

const modelClaimSchema = z.object({
  id: modelText,
  text: modelText,
  kind: z.enum(['knowledge', 'onsite-fact', 'hypothesis', 'user-provided']),
  evidenceKeys: z.array(evidenceKey).max(20),
}).strict();
const modelSlideDraftSchema = z.object({
  title: modelText,
  takeaway: modelText,
  takeawayClaimIds: z.array(modelText).min(1).max(20),
  visualKind: z.enum(ATOMIC_VISUAL_KINDS),
  evidenceKeys: z.array(evidenceKey).max(20),
  claims: z.array(modelClaimSchema).min(1).max(20),
  narration: z.array(z.object({
    text: modelText,
    claimIds: z.array(modelText).min(1).max(20),
  }).strict()).min(2).max(4),
  knowledgeItems: z.array(z.object({ title: modelText, detail: modelText }).strict()).min(1).max(12).optional(),
}).strict();

function structuralIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`);
}

function parseJsonStructure<T>(content: string, schema: z.ZodType<T>): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new StructuredModelOutputShapeError(['response: invalid JSON']);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new StructuredModelOutputShapeError(structuralIssues(parsed.error));
  return parsed.data;
}

export function parseModelReportPlanStructure(content: string): ModelReportPlan {
  return parseJsonStructure(content, modelReportPlanSchema);
}

export function parseModelSlideDraftStructure(content: string): ModelSlideDraft {
  return parseJsonStructure(content, modelSlideDraftSchema);
}

function fail(code: ReportContentValidationError['code']): never {
  throw new ReportContentValidationError(code);
}

function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

const ENV_ASSIGNMENT_PATTERN = /(?:^|[^\p{L}\p{N}_])[A-Z][A-Z0-9_]{1,63}\s*[:=]\s*\S+/u;
const PROVIDER_TOKEN_PATTERN = /(?:\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[0-9A-Za-z]{20,}\b|\bgithub_pat_[0-9A-Za-z_]{20,}\b|\bglpat-[0-9A-Za-z_-]{16,}\b|\bxox[baprs]-[0-9A-Za-z-]{10,}\b|\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b)/u;
const PRIVATE_CONNECTION_PATTERN = /(?:\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|file):\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;
const DOT_ENV_PATH_PATTERN = /(?:^|[\s"'`(])(?:\.{1,2}[\\/])?(?:[^\s"'`()]+[\\/])*\.env(?:\.[0-9A-Za-z_-]+)?\b/u;
const EXECUTABLE_TEXT_PATTERN = /(?:<\s*\/?\s*[a-z][^>]*>|\bon[a-z]{2,32}\s*=|(?:javascript|vbscript)\s*:|data\s*:\s*text\/html(?:[;,]|$)|\b(?:eval|document\.cookie|window\.location)\s*\()/iu;

function canonicalSafetyText(value: string): string {
  let canonical = value.normalize('NFKC');
  for (let pass = 0; pass <= value.length; pass += 1) {
    const decoded = canonical
      .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hex: string) => {
        const codePoint = Number.parseInt(hex, 16);
        return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : _match;
      })
      .replace(/\\u([0-9a-f]{4})/giu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/\\x([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .normalize('NFKC');
    if (decoded === canonical) return decoded;
    canonical = decoded;
  }
  return canonical;
}

function containsUnsafeModelText(value: string): boolean {
  const canonical = canonicalSafetyText(value);
  return ENV_ASSIGNMENT_PATTERN.test(canonical)
    || PROVIDER_TOKEN_PATTERN.test(canonical)
    || PRIVATE_CONNECTION_PATTERN.test(canonical)
    || DOT_ENV_PATH_PATTERN.test(canonical)
    || EXECUTABLE_TEXT_PATTERN.test(canonical);
}

function stripAllowedPublicValues(value: string, allowedPublicValues: readonly string[]): string {
  return allowedPublicValues.reduce((safe, allowed) => (
    allowed.trim() ? safe.split(allowed).join('[PUBLIC_PROFILE]') : safe
  ), value);
}

export function assertSafeReportContent(
  values: readonly string[],
  sensitiveValues: readonly string[],
  code: 'REPORT_OUTLINE_INVALID' | 'REPORT_SLIDE_DRAFT_INVALID',
  allowedPublicValues: readonly string[] = [],
): void {
  for (const value of values) {
    const screened = stripAllowedPublicValues(value, allowedPublicValues);
    const canonical = canonicalSafetyText(screened);
    if (
      redactAnalysisText(screened, sensitiveValues) !== screened
      || redactAnalysisText(canonical, sensitiveValues) !== canonical
      || containsUnsafeModelText(screened)
      || containsUnsafeModelText(canonical)
    ) throw new UnsafeReportContentError(code);
  }
}

type EvidenceDescriptor = {
  key: string;
  source: ReportEvidenceRef['source'];
  kind: ReportEvidenceRef['kind'];
  label: string;
  unit?: string;
  seriesPoints?: number;
};

function metricDefinition(analysis: AnalysisEvidence, key: string) {
  return analysis.definitions.find((definition) => definition.key === key);
}

function metricAggregate(analysis: AnalysisEvidence, key: string) {
  return analysis.aggregates[key as AnalysisMetricKey];
}

function isMetricKey(analysis: AnalysisEvidence, key: string): key is AnalysisMetricKey {
  return Boolean(metricDefinition(analysis, key) && metricAggregate(analysis, key));
}

function alertIndex(key: string): number | undefined {
  const match = /^alert:(\d+)$/u.exec(key);
  return match ? Number(match[1]) : undefined;
}

function healthWeightName(key: string): string | undefined {
  return /^health-weight:(.+)$/u.exec(key)?.[1];
}

type ParsedDerivation = {
  kind: 'difference' | 'percent-change' | 'share';
  operands: string[];
};

function parsedDerivation(key: string): ParsedDerivation | undefined {
  const [kind, first, second, extra] = key.split(':');
  if (extra !== undefined) return undefined;
  if (kind === 'percent-change' && first && second === undefined) return { kind, operands: [first] };
  if ((kind === 'difference' || kind === 'share') && first && second) return { kind, operands: [first, second] };
  return undefined;
}

function descriptorFor(key: string, bundle: ReportEvidenceBundle): EvidenceDescriptor | undefined {
  const analysis = bundle.analysis;
  if (analysis && isMetricKey(analysis, key)) {
    const definition = metricDefinition(analysis, key)!;
    return {
      key,
      source: 'excel',
      kind: 'metric',
      label: definition.label,
      unit: definition.unit,
      seriesPoints: analysis.series.filter(({ values }) => Number.isFinite(values[key])).length,
    };
  }
  if (analysis) {
    const alert = alertIndex(key);
    if (alert !== undefined && analysis.alerts[alert]) {
      return { key, source: 'excel', kind: 'alert', label: analysis.alerts[alert].metric };
    }
    const weightName = healthWeightName(key);
    if (
      weightName !== undefined
      && typeof analysis.healthWeights?.[weightName as keyof NonNullable<AnalysisEvidence['healthWeights']>] === 'number'
    ) {
      return { key, source: 'excel', kind: 'health-weight', label: `${weightName}权重`, unit: '%' };
    }
    const derivation = parsedDerivation(key);
    if (derivation && derivation.operands.every((operand) => isMetricKey(analysis, operand))) {
      const first = metricDefinition(analysis, derivation.operands[0]!)!;
      return {
        key,
        source: 'excel',
        kind: 'metric',
        label: `${derivation.kind}(${derivation.operands.join(',')})`,
        unit: derivation.kind === 'difference' ? first.unit : '%',
      };
    }
  }
  const knowledge = bundle.knowledge.find((item) => item.key === key);
  if (knowledge) return { key, source: 'model-knowledge', kind: 'knowledge', label: knowledge.topic };
  if (key === 'assistant-profile' && bundle.assistantProfile) {
    return { key, source: 'assistant-profile', kind: 'knowledge', label: bundle.assistantProfile.assistantName };
  }
  const correction = bundle.userCorrections?.find((item) => item.key === key);
  if (correction) {
    const original = bundle.analysis?.definitions.find((definition) => definition.key === correction.evidenceKey);
    return {
      key,
      source: 'user-correction',
      kind: 'metric',
      label: `${original?.label ?? correction.evidenceKey}（用户提供·未核验）`,
      unit: correction.unit,
    };
  }
  return undefined;
}

export function reportEvidenceCatalog(bundle: ReportEvidenceBundle): EvidenceDescriptor[] {
  const result: EvidenceDescriptor[] = [];
  if (bundle.analysis) {
    for (const definition of bundle.analysis.definitions) {
      const descriptor = descriptorFor(definition.key, bundle);
      if (descriptor) result.push(descriptor);
    }
    bundle.analysis.alerts.forEach((_alert, index) => {
      const descriptor = descriptorFor(`alert:${index}`, bundle);
      if (descriptor) result.push(descriptor);
    });
    for (const key of Object.keys(bundle.analysis.healthWeights ?? {})) {
      const descriptor = descriptorFor(`health-weight:${key}`, bundle);
      if (descriptor) result.push(descriptor);
    }
  }
  for (const knowledge of bundle.knowledge) {
    const descriptor = descriptorFor(knowledge.key, bundle);
    if (descriptor) result.push(descriptor);
  }
  if (bundle.assistantProfile) result.push(descriptorFor('assistant-profile', bundle)!);
  for (const correction of bundle.userCorrections ?? []) {
    const descriptor = descriptorFor(correction.key, bundle);
    if (descriptor) result.push(descriptor);
  }
  return result;
}

export function isKnownReportEvidenceKey(key: string, bundle: ReportEvidenceBundle): boolean {
  return descriptorFor(key, bundle) !== undefined;
}

export function deriveEvidencePolicy(
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
): typeof EVIDENCE_POLICIES[number] {
  const descriptors = keys.map((key) => descriptorFor(key, bundle));
  if (descriptors.some((descriptor) => descriptor === undefined)) fail('REPORT_EVIDENCE_INVALID');
  const hasExcel = descriptors.some((descriptor) => descriptor!.source === 'excel');
  const hasKnowledge = descriptors.some((descriptor) => descriptor!.source !== 'excel');
  if (hasExcel && hasKnowledge) return 'mixed';
  if (hasExcel) return 'data';
  return 'knowledge';
}

function directMetricKeys(keys: readonly string[], bundle: ReportEvidenceBundle): AnalysisMetricKey[] {
  if (!bundle.analysis) return [];
  return keys.filter((key): key is AnalysisMetricKey => isMetricKey(bundle.analysis!, key));
}

function metricLikeKeys(keys: readonly string[], bundle: ReportEvidenceBundle): string[] {
  return keys.filter((key) => {
    const descriptor = descriptorFor(key, bundle);
    return (descriptor?.source === 'excel' || descriptor?.source === 'user-correction')
      && (descriptor.kind === 'metric' || descriptor.kind === 'health-weight');
  });
}

function comparableMetricUnit(keys: readonly string[], bundle: ReportEvidenceBundle): string | undefined {
  const units = metricLikeKeys(keys, bundle)
    .map((key) => descriptorFor(key, bundle)?.unit?.trim())
    .filter((unit): unit is string => Boolean(unit));
  if (units.length < 2 || units.length !== metricLikeKeys(keys, bundle).length) return undefined;
  return units.every((unit) => unit === units[0]) ? units[0] : undefined;
}

function scoreLikeMetricKeys(keys: readonly string[], bundle: ReportEvidenceBundle): string[] {
  return metricLikeKeys(keys, bundle).filter((key) => isScoreLike(key, bundle));
}

function assertVisualEvidenceCompatibility(
  visualKind: AtomicVisualKind,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
  code: 'REPORT_OUTLINE_INVALID' | 'REPORT_EVIDENCE_INVALID',
): void {
  const descriptors = keys.map((key) => descriptorFor(key, bundle));
  if (!keys.length || !distinct(keys) || descriptors.some((descriptor) => descriptor === undefined)) fail(code);
  const metrics = metricLikeKeys(keys, bundle);
  const directMetrics = directMetricKeys(keys, bundle);
  const alerts = descriptors.filter((descriptor) => descriptor?.kind === 'alert');
  const modelKnowledge = descriptors.filter((descriptor) => descriptor?.source === 'model-knowledge');
  const profiles = descriptors.filter((descriptor) => descriptor?.source === 'assistant-profile');

  if (profiles.length) {
    if (keys.length !== 1 || keys[0] !== 'assistant-profile' || visualKind !== 'capability-map') fail(code);
    return;
  }
  switch (visualKind) {
    case 'kpi-grid':
    case 'comparison-bars':
    case 'radar':
      if (!metrics.length) fail(code);
      return;
    case 'health-ring':
      if (metrics.length !== 1) fail(code);
      return;
    case 'trend-line':
    case 'trend-area':
      if (!directMetrics.length || directMetrics.some((key) => (
        bundle.analysis!.series.filter(({ values }) => Number.isFinite(values[key])).length < 2
      ))) fail(code);
      return;
    case 'scatter':
      if (directMetrics.length !== 2) fail(code);
      return;
    case 'alert-timeline':
      if (!alerts.length || descriptors.some((descriptor) => descriptor?.source === 'excel' && descriptor.kind !== 'alert')) fail(code);
      return;
    case 'process-flow':
    case 'recommendation-path':
    case 'concept-map':
      if (!modelKnowledge.length) fail(code);
      return;
    case 'capability-map':
      if (!modelKnowledge.length) fail(code);
      return;
  }
}

function assertAtomicVisualSafety(
  visualKind: AtomicVisualKind,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
  code: 'REPORT_OUTLINE_INVALID' | 'REPORT_EVIDENCE_INVALID',
): void {
  assertVisualEvidenceCompatibility(visualKind, keys, bundle, code);
  const metrics = metricLikeKeys(keys, bundle);
  switch (visualKind) {
    case 'comparison-bars':
      if (metrics.length < 2 || !comparableMetricUnit(keys, bundle)) fail(code);
      return;
    case 'radar': {
      const scoreLikeKeys = scoreLikeMetricKeys(keys, bundle);
      if (scoreLikeKeys.length < 3 || scoreLikeKeys.length !== metrics.length) fail(code);
      return;
    }
    case 'scatter':
      if (pairedSampleCount(keys, bundle) < 3) fail(code);
      return;
    default:
      return;
  }
}

export function validateModelReportPlan(
  plan: ModelReportPlan,
  bundle: ReportEvidenceBundle,
  sensitiveValues: readonly string[],
): Array<Omit<SlideOutline, 'id' | 'order' | 'status'>> {
  const purposes = plan.slides.map(({ purpose }) => normalized(purpose));
  const titles = plan.slides.map(({ title }) => normalized(title));
  if (!distinct(purposes) || !distinct(titles)) fail('REPORT_OUTLINE_INVALID');

  return plan.slides.map((slide) => {
    assertSafeReportContent([slide.title, slide.purpose], sensitiveValues, 'REPORT_OUTLINE_INVALID');
    assertVisualEvidenceCompatibility(slide.visualKind, slide.evidenceKeys, bundle, 'REPORT_OUTLINE_INVALID');
    let evidencePolicy: typeof EVIDENCE_POLICIES[number];
    try {
      evidencePolicy = deriveEvidencePolicy(slide.evidenceKeys, bundle);
    } catch {
      fail('REPORT_OUTLINE_INVALID');
    }
    return {
      title: slide.title,
      purpose: slide.purpose,
      role: slide.role,
      layout: slide.layout,
      visualKind: slide.visualKind,
      evidenceKeys: [...slide.evidenceKeys],
      evidencePolicy,
    };
  });
}

function evidenceRefFor(key: string, bundle: ReportEvidenceBundle): ReportEvidenceRef {
  const descriptor = descriptorFor(key, bundle);
  if (!descriptor) fail('REPORT_EVIDENCE_INVALID');
  const base = {
    key,
    kind: descriptor.kind,
    source: descriptor.source,
    snapshotId: bundle.snapshotId,
    label: descriptor.label,
  } as const;
  if (descriptor.source === 'user-correction') {
    return { ...base, unit: descriptor.unit, dateRange: undefined, sampleCount: undefined };
  }
  if (descriptor.source !== 'excel') return base;
  const analysis = bundle.analysis!;
  const alert = alertIndex(key);
  if (alert !== undefined) {
    const item = analysis.alerts[alert]!;
    return { ...base, module: 'alerts', dateRange: { from: item.date, to: item.date }, sampleCount: 1 };
  }
  const weightName = healthWeightName(key);
  if (weightName !== undefined) {
    return {
      ...base,
      module: 'health',
      unit: '%',
      dateRange: { ...analysis.scope.dateRange },
      sampleCount: analysis.scope.sampleCount,
    };
  }
  const derivation = parsedDerivation(key);
  const metricKey = (derivation?.operands[0] ?? key) as AnalysisMetricKey;
  const definition = metricDefinition(analysis, metricKey)!;
  return {
    ...base,
    module: ANALYSIS_METRICS[metricKey].module,
    unit: descriptor.unit ?? definition.unit,
    dateRange: { ...analysis.scope.dateRange },
    sampleCount: analysis.scope.sampleCount,
  };
}

export function reportEvidenceRefsFor(
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
): ReportEvidenceRef[] {
  return keys.map((key) => evidenceRefFor(key, bundle));
}

const DERIVATIONS = {
  difference: (left: number, right: number) => left - right,
  'percent-change': (first: number, latest: number) => first === 0 ? null : ((latest - first) / Math.abs(first)) * 100,
  share: (part: number, total: number) => total === 0 ? null : (part / total) * 100,
} as const;

type UnclaimedBoundMetric = Omit<BoundMetric, 'claimIds'>;

function metricFor(key: string, bundle: ReportEvidenceBundle): UnclaimedBoundMetric {
  const correction = bundle.userCorrections?.find((item) => item.key === key);
  if (correction) {
    if (!Number.isFinite(correction.value)) fail('REPORT_EVIDENCE_INVALID');
    return { ...evidenceRefFor(key, bundle), value: correction.value };
  }
  const analysis = bundle.analysis;
  if (!analysis) fail('REPORT_EVIDENCE_INVALID');
  if (isMetricKey(analysis, key)) {
    const aggregate = metricAggregate(analysis, key)!;
    const definition = metricDefinition(analysis, key)!;
    if (!Number.isFinite(aggregate.latest) || (definition.limit !== undefined && !Number.isFinite(definition.limit))) {
      fail('REPORT_EVIDENCE_INVALID');
    }
    return {
      ...evidenceRefFor(key, bundle),
      value: aggregate.latest,
      ...(definition.limit === undefined ? {} : {
        limit: definition.limit,
        status: aggregate.latest <= definition.limit ? '达标' : '关注',
      }),
    };
  }
  const weightName = healthWeightName(key);
  if (weightName !== undefined) {
    const weight = analysis.healthWeights?.[weightName as keyof NonNullable<AnalysisEvidence['healthWeights']>];
    if (weight === undefined || !Number.isFinite(weight)) fail('REPORT_EVIDENCE_INVALID');
    return { ...evidenceRefFor(key, bundle), value: weight * 100 };
  }
  const derivation = parsedDerivation(key);
  if (!derivation || !derivation.operands.every((operand) => isMetricKey(analysis, operand))) fail('REPORT_EVIDENCE_INVALID');
  let value: number | null;
  if (derivation.kind === 'percent-change') {
    const metricKey = derivation.operands[0]! as AnalysisMetricKey;
    const values = analysis.series.flatMap(({ values: row }) => {
      const item = row[metricKey];
      return Number.isFinite(item) ? [item as number] : [];
    });
    const first = values.at(0);
    const latest = values.at(-1);
    value = first === undefined || latest === undefined ? null : DERIVATIONS['percent-change'](first, latest);
  } else {
    const values = derivation.operands.map((operand) => metricAggregate(analysis, operand)!.latest);
    value = DERIVATIONS[derivation.kind](values[0]!, values[1]!);
  }
  if (value === null || !Number.isFinite(value)) fail('REPORT_EVIDENCE_INVALID');
  return { ...evidenceRefFor(key, bundle), value, derivation };
}

export function boundMetricsForReport(
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
  claims: readonly BoundClaim[],
): BoundMetric[] {
  return metricLikeKeys(keys, bundle).map((key) => ({
    ...metricFor(key, bundle),
    claimIds: claimIdsForEvidenceKey(key, claims),
  }));
}

function claimIdsForEvidenceKey(key: string, claims: readonly BoundClaim[]): string[] {
  const claimIds = claims.filter((claim) => claim.evidenceRefs.some((ref) => ref.key === key)).map(({ id }) => id);
  if (!claimIds.length) fail('REPORT_EVIDENCE_INVALID');
  return claimIds;
}

function knowledgeVisualClaimIds(keys: readonly string[], claims: readonly BoundClaim[]): string[] {
  const knowledgeKeys = new Set(keys);
  const claimIds = claims.filter((claim) => claim.evidenceRefs.some((ref) => (
    knowledgeKeys.has(ref.key) && ref.source !== 'excel'
  ))).map(({ id }) => id);
  if (!claimIds.length) fail('REPORT_EVIDENCE_INVALID');
  return claimIds;
}

export function bindAtomicReportVisual(
  kind: AtomicVisualKind,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
  knowledgeItems: readonly { title: string; detail: string }[] | undefined,
  slideId: string,
  claims: readonly BoundClaim[],
): AtomicVisualSpec {
  assertAtomicVisualSafety(kind, keys, bundle, 'REPORT_EVIDENCE_INVALID');
  const metrics = boundMetricsForReport(keys, bundle, claims);
  const directMetrics = directMetricKeys(keys, bundle);
  const analysis = bundle.analysis;
  switch (kind) {
    case 'kpi-grid': return { kind, metrics };
    case 'comparison-bars': return { kind, items: metrics };
    case 'health-ring': return { kind, metric: metrics[0]! };
    case 'radar':
      return {
        kind,
        axes: metrics.map((metric) => ({
          key: metric.key,
          label: metric.label,
          value: metric.value,
          maximum: Math.max(metric.value, metric.limit ?? metric.value, 1),
          unit: metric.unit ?? '',
          snapshotId: metric.snapshotId,
          claimIds: [...metric.claimIds],
        })),
      };
    case 'trend-line':
    case 'trend-area':
      return {
        kind,
        series: directMetrics.map((key) => {
          const definition = metricDefinition(analysis!, key)!;
          return {
            key,
            label: definition.label,
            unit: definition.unit,
            snapshotId: bundle.snapshotId,
            claimIds: claimIdsForEvidenceKey(key, claims),
            points: analysis!.series.flatMap(({ date, values }) => (
              Number.isFinite(values[key]) ? [{ label: date, value: values[key] as number }] : []
            )),
          };
        }),
      };
    case 'scatter': {
      const [xKey, yKey] = directMetrics;
      const points = analysis!.series.flatMap(({ date, values }) => {
        const x = values[xKey!];
        const y = values[yKey!];
        return Number.isFinite(x) && Number.isFinite(y) ? [{ label: date, x: x as number, y: y as number }] : [];
      });
      if (!points.length) fail('REPORT_EVIDENCE_INVALID');
      const xClaimIds = claimIdsForEvidenceKey(xKey!, claims);
      const yClaimIds = claimIdsForEvidenceKey(yKey!, claims);
      const pointClaimIds = [...new Set([...xClaimIds, ...yClaimIds])];
      return {
        kind,
        x: { ...evidenceRefFor(xKey!, bundle), claimIds: xClaimIds },
        y: { ...evidenceRefFor(yKey!, bundle), claimIds: yClaimIds },
        points: points.map((point) => ({ ...point, claimIds: [...pointClaimIds] })),
        caveat: '统计关联不等于因果关系',
      };
    }
    case 'alert-timeline': {
      const items = keys.flatMap((key) => {
        const index = alertIndex(key);
        const alert = index === undefined ? undefined : analysis?.alerts[index];
        return alert ? [{
          id: key,
          date: alert.date,
          level: alert.level,
          label: alert.metric,
          detail: `${alert.reason} ${alert.recommendation}`.trim(),
          snapshotId: bundle.snapshotId,
          claimIds: claimIdsForEvidenceKey(key, claims),
        }] : [];
      });
      if (!items.length) fail('REPORT_EVIDENCE_INVALID');
      return { kind, items };
    }
    case 'process-flow':
    case 'recommendation-path': {
      if (!knowledgeItems?.length) fail('REPORT_EVIDENCE_INVALID');
      const claimIds = knowledgeVisualClaimIds(keys, claims);
      return {
        kind,
        provenance: 'model-knowledge',
        steps: knowledgeItems.map((item, index) => ({
          id: `${slideId}-step-${index + 1}`,
          ...item,
          claimIds: [...claimIds],
        })),
      };
    }
    case 'concept-map': {
      if (!knowledgeItems?.length) fail('REPORT_EVIDENCE_INVALID');
      const claimIds = knowledgeVisualClaimIds(keys, claims);
      const nodes = knowledgeItems.map((item, index) => ({
        id: `${slideId}-node-${index + 1}`,
        title: item.title,
        detail: item.detail,
        claimIds: [...claimIds],
      }));
      return {
        kind,
        nodes,
        edges: nodes.slice(1).map((node, index) => ({
          from: nodes[index]!.id,
          to: node.id,
          claimIds: [...claimIds],
        })),
      };
    }
    case 'capability-map': {
      if (!knowledgeItems?.length) fail('REPORT_EVIDENCE_INVALID');
      const claimIds = knowledgeVisualClaimIds(keys, claims);
      return {
        kind,
        items: knowledgeItems.map((item, index) => ({
          id: `${slideId}-capability-${index + 1}`,
          ...item,
          claimIds: [...claimIds],
        })),
      };
    }
  }
}

function metricPointCount(key: string, bundle: ReportEvidenceBundle): number {
  const analysis = bundle.analysis;
  if (!analysis || !isMetricKey(analysis, key)) return 1;
  return analysis.series.filter(({ values }) => Number.isFinite(values[key])).length;
}

function pairedSampleCount(keys: readonly string[], bundle: ReportEvidenceBundle): number {
  const analysis = bundle.analysis;
  if (!analysis) return 0;
  const directMetrics = directMetricKeys(keys, bundle);
  if (!directMetrics.length) return 0;
  return analysis.series.filter(({ values }) => directMetrics.every((key) => Number.isFinite(values[key]))).length;
}

function isScoreLike(key: string, bundle: ReportEvidenceBundle): boolean {
  const descriptor = descriptorFor(key, bundle);
  if (descriptor?.unit === '分' || descriptor?.unit === '%') return true;
  if (/Score$/u.test(key)) return true;
  const analysis = bundle.analysis;
  const definition = analysis ? metricDefinition(analysis, key) : undefined;
  return definition?.unit === '分' || definition?.unit === '%';
}

function visualCandidates(keys: readonly string[], bundle: ReportEvidenceBundle): VisualEvidenceCandidate[] {
  const pairedCount = pairedSampleCount(keys, bundle);
  return keys.flatMap((key): VisualEvidenceCandidate[] => {
    const descriptor = descriptorFor(key, bundle);
    if (!descriptor || descriptor.kind === 'knowledge') return [];
    if (descriptor.kind === 'alert') {
      return [{ key, kind: 'alert', pointCount: 1, pairedSampleCount: 0, scoreLike: false }];
    }
    return [{
      key,
      kind: descriptor.kind,
      unit: descriptor.unit,
      pointCount: metricPointCount(key, bundle),
      pairedSampleCount: pairedCount,
      scoreLike: isScoreLike(key, bundle),
    }];
  });
}

function isDataVisualKind(kind: AtomicVisualKind): kind is AtomicDataVisualPlan['kind'] {
  return !['kpi-grid', 'process-flow', 'recommendation-path', 'concept-map', 'capability-map'].includes(kind);
}

function bindAtomicDataVisual(
  plan: AtomicDataVisualPlan,
  bundle: ReportEvidenceBundle,
  slideId: string,
  claims: readonly BoundClaim[],
): AtomicDataVisualSpec {
  const visual = bindAtomicReportVisual(plan.kind, plan.evidenceKeys, bundle, undefined, slideId, claims);
  if (['kpi-grid', 'process-flow', 'recommendation-path', 'concept-map', 'capability-map'].includes(visual.kind)) {
    fail('REPORT_EVIDENCE_INVALID');
  }
  return visual as AtomicDataVisualSpec;
}

function compatibleDataPlan(plan: AtomicDataVisualPlan, bundle: ReportEvidenceBundle): boolean {
  if (!isDataVisualKind(plan.kind)) return false;
  try {
    assertAtomicVisualSafety(plan.kind, plan.evidenceKeys, bundle, 'REPORT_EVIDENCE_INVALID');
    return true;
  } catch {
    return false;
  }
}

function safeAtomicFallbackKind(keys: readonly string[], bundle: ReportEvidenceBundle): AtomicVisualKind | undefined {
  if (!metricLikeKeys(keys, bundle).length) return undefined;
  try {
    assertVisualEvidenceCompatibility('kpi-grid', keys, bundle, 'REPORT_EVIDENCE_INVALID');
    return 'kpi-grid';
  } catch {
    return undefined;
  }
}

export function bindReportVisual(
  kind: AtomicVisualKind,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
  knowledgeItems: readonly { title: string; detail: string }[] | undefined,
  slideId: string,
  claims: readonly BoundClaim[],
): VisualSpec {
  if (['process-flow', 'recommendation-path', 'concept-map', 'capability-map'].includes(kind)) {
    return bindAtomicReportVisual(kind, keys, bundle, knowledgeItems, slideId, claims);
  }
  const plan = planDataDashboardVisual(kind, visualCandidates(keys, bundle));
  if (plan && compatibleDataPlan(plan.primary, bundle)) {
    try {
      const primary = bindAtomicDataVisual(plan.primary, bundle, slideId, claims);
      return {
        kind: 'data-dashboard',
        summaryMetrics: boundMetricsForReport(plan.summaryKeys, bundle, claims),
        primary,
        supporting: plan.supporting
          .filter((item) => compatibleDataPlan(item, bundle))
          .flatMap((item) => {
            try {
              return [bindAtomicDataVisual(item, bundle, slideId, claims)];
            } catch {
              return [];
            }
          }),
      };
    } catch {
      // Fall through to the safe atomic path below.
    }
  }
  try {
    return bindAtomicReportVisual(kind, keys, bundle, knowledgeItems, slideId, claims);
  } catch (error) {
    if (!(error instanceof ReportContentValidationError) || error.code !== 'REPORT_EVIDENCE_INVALID') throw error;
    const fallbackKind = safeAtomicFallbackKind(keys, bundle);
    if (!fallbackKind || fallbackKind === kind) throw error;
    return bindAtomicReportVisual(fallbackKind, keys, bundle, knowledgeItems, slideId, claims);
  }
}

const NUMERIC_TOKEN_PATTERN = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?%?/gu;
const MEASUREMENT_UNIT_PATTERN = /(?:mg\/L|kg\/L|g\/L|ppm|ppb|kWh(?:\/(?:d|m³))?|kgCO₂e(?:\/m³)?|m³(?:\/d)?|kg(?:\/d)?|元\/d|条\/d|%|吨(?!水))/gu;
const DECIMAL_DIGIT_PATTERN = /\p{Decimal_Number}/u;
const ONSITE_LANGUAGE_PATTERN = /(?:本厂|现场|当前|最新|样本|预警|达标|超标|运行数据)/u;
const HYPOTHESIS_LANGUAGE_PATTERN = /(?:可能|假设|推测|尚待|待验证|不确定|或许|需.{0,8}验证|不能确认)/u;
const POSITIVE_CHANGE_PATTERN = /(?:升高|上升|增长|增加|涨幅|提升)/u;
const NEGATIVE_CHANGE_PATTERN = /(?:降幅|下降|降低|减少|下滑|回落)/u;
const CAUSAL_ASSERTION_PATTERN = /(?:导致|造成|引起|引发|致使|使(?!用)|驱动|推动|带来|归因于|促使|决定了|(?:是|为).{0,16}(?:主因|根因|原因|诱因)|(?:主因|根因|原因|诱因)(?:是|为)|(?:说明|表明|证明).{0,32}(?:导致|造成|引起|引发|驱动|推动|带来|主因|根因|原因|因果)|\b(?:cause[ds]?|causal|drives?|driver|root\s+cause|results?\s+in|due\s+to|because\s+of)\b)/iu;
const NEGATED_CAUSAL_PATTERN = /(?:(?:不能|无法|不足以|不代表|并不|不等于|尚不能|不可).{0,16}(?:证明|说明|表明|构成|代表|推断|确认)?.{0,12}(?:因果|原因|主因|根因)|(?:correlation|association).{0,16}(?:does\s+not|cannot|isn['’]?t).{0,12}(?:caus|prove))/iu;
const ALTERNATE_MODEL_PROVIDER_PATTERN = /(?:\b(?:gpt(?:-[\w.]+)?|openai|claude|anthropic|gemini|qwen|llama|mistral|deepseek|ernie|chatglm|moonshot|kimi)\b|通义千问|文心一言|讯飞星火|智谱清言|腾讯混元)/iu;
const IDENTITY_ASSERTION_PATTERNS = [
  /(?:我|本助手|该助手|这个助手|智慧水务\s*(?:AI\s*)?助手)(?:是)?由\s*([^，。！？；;,.!?]{1,80}?)\s*(?:驱动|支持|提供)/giu,
  /(?:我|本助手|该助手|这个助手|智慧水务\s*(?:AI\s*)?助手)(?:基于|使用|采用)\s*([^，。！？；;,.!?]{1,80}?)\s*(?:模型|大模型|引擎)/giu,
  /(?:powered|supported)\s+by\s+([^，。！？；;,.!?]{1,80})/giu,
] as const;

function normalizedSemanticText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function hasUntrustedIdentityAssertion(value: string, publicName: string | undefined): boolean {
  const trusted = publicName ? normalized(publicName) : '';
  for (const pattern of IDENTITY_ASSERTION_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const asserted = match[1] ? normalized(match[1]) : '';
      if (!asserted || asserted !== trusted) return true;
    }
  }
  return false;
}

function assertAssistantIdentityBoundToProfile(
  value: string,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
): void {
  const usesProfile = keys.includes('assistant-profile');
  const publicName = usesProfile ? bundle.assistantProfile?.publicModelName : undefined;
  const assistantName = bundle.assistantProfile?.assistantName;
  const withoutPublicName = publicName ? value.split(publicName).join('') : value;
  const identityStatement = /(?:(?:公开|当前|本助手|该助手|我的|所用|使用的).{0,10}模型(?:显示)?(?:名称|名)?\s*(?:是|为|[:：])|(?:公开模型名称|current\s+model|model\s+name)\s*(?:is|是|为|[:：]))/iu.test(value);
  const assistantSubjectPattern = /(?:我|本助手|该助手|这个助手|智慧水务\s*(?:AI\s*)?助手)/iu;
  const assistantScopedProvider = assistantSubjectPattern.test(value)
    && ALTERNATE_MODEL_PROVIDER_PATTERN.test(value);
  const assistantScoped = assistantSubjectPattern.test(value)
    || Boolean(assistantName && value.includes(assistantName));
  const identityRelation = /(?:由.{1,80}(?:驱动|支持|提供)|(?:基于|使用|采用).{1,80}(?:模型|大模型|引擎)|(?:底层|底座|核心)?(?:模型|大模型|引擎).{0,10}(?:是|为|采用|[:：]))/iu.test(value);
  if (
    hasUntrustedIdentityAssertion(value, publicName)
    || (!usesProfile && assistantScopedProvider)
    || (assistantScoped && identityRelation && (!usesProfile || !publicName || !value.includes(publicName)))
    || (identityStatement && (!usesProfile || !publicName || !value.includes(publicName)))
    || (usesProfile && (
      ALTERNATE_MODEL_PROVIDER_PATTERN.test(withoutPublicName)
    ))
  ) fail('REPORT_SLIDE_DRAFT_INVALID');
}

const CLAIM_METRIC_ALIASES: MetricAliasCatalog = Object.freeze(Object.fromEntries(
  (Object.keys(ANALYSIS_METRICS) as AnalysisMetricKey[]).map((key) => [
    key,
    Object.freeze([...new Set([key, ANALYSIS_METRICS[key].label, ...METRIC_ALIASES[key]])]),
  ]),
) as Record<AnalysisMetricKey, readonly string[]>);

function namedMetricKeys(textValue: string): AnalysisMetricKey[] {
  return matchMetricAliases(textValue, CLAIM_METRIC_ALIASES, { asciiWordBoundaries: true });
}

function metricKeysForClaimEvidence(keys: readonly string[], bundle: ReportEvidenceBundle): Set<AnalysisMetricKey> {
  const allowed = new Set<AnalysisMetricKey>();
  const analysis = bundle.analysis;
  if (!analysis) return allowed;
  for (const key of keys) {
    if (isMetricKey(analysis, key)) allowed.add(key);
    for (const operand of parsedDerivation(key)?.operands ?? []) {
      if (isMetricKey(analysis, operand)) allowed.add(operand);
    }
    const alert = alertIndex(key);
    if (alert !== undefined) {
      for (const metricKey of namedMetricKeys(analysis.alerts[alert]?.metric ?? '')) allowed.add(metricKey);
    }
  }
  return allowed;
}

function thresholdBreachesForEvidence(keys: readonly string[], bundle: ReportEvidenceBundle) {
  const allowed = metricKeysForClaimEvidence(keys, bundle);
  return bundle.analysis?.thresholdBreaches.filter(({ metric }) => allowed.has(metric)) ?? [];
}

function correlationsForEvidence(keys: readonly string[], bundle: ReportEvidenceBundle) {
  const allowed = metricKeysForClaimEvidence(keys, bundle);
  return bundle.analysis?.correlations.filter(({ left, right }) => allowed.has(left) && allowed.has(right)) ?? [];
}

function statesBoundAlertReason(value: string, keys: readonly string[], bundle: ReportEvidenceBundle): boolean {
  const alertKeys = keys.map(alertIndex).filter((index): index is number => index !== undefined);
  return alertKeys.length > 0 && alertKeys.every((index) => {
    const reason = bundle.analysis?.alerts[index]?.reason.trim();
    if (!reason || !value.includes(reason)) return false;
    const allowedReasonPhrases = [
      `原因为${reason}`,
      `原因是${reason}`,
      `原因：${reason}`,
      `原因:${reason}`,
    ];
    let remainder = value;
    for (const phrase of allowedReasonPhrases) remainder = remainder.replace(phrase, '');
    remainder = remainder.replace(reason, '');
    return !CAUSAL_ASSERTION_PATTERN.test(remainder);
  });
}

function hasUnboundCausalAssertion(
  value: string,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
): boolean {
  return value.split(/[。！？；，,;\n]|但是|然而|不过|但|却/u).some((clause) => (
    CAUSAL_ASSERTION_PATTERN.test(clause)
    && !NEGATED_CAUSAL_PATTERN.test(clause)
    && !statesBoundAlertReason(clause, keys, bundle)
  ));
}

type OnsiteStatusWord = '达标' | '超标' | '不达标' | '关注';

function onsiteStatusWords(textValue: string): OnsiteStatusWord[] {
  const statuses = new Set<OnsiteStatusWord>();
  let remaining = normalizedSemanticText(textValue);
  if (remaining.includes('不达标')) {
    statuses.add('不达标');
    remaining = remaining.replace(/不达标/gu, '');
  }
  if (/超标(?!率)/u.test(remaining)) statuses.add('超标');
  if (/(?:高于|超过|超出).{0,12}(?:限值|阈值|标准)/u.test(remaining)) statuses.add('超标');
  if (remaining.includes('关注')) statuses.add('关注');
  if (/达标(?!率)/u.test(remaining)) statuses.add('达标');
  return [...statuses];
}

type OnsiteStatusSubject = {
  metricKeys: AnalysisMetricKey[];
  matches: (status: OnsiteStatusWord) => boolean;
};

function statusSubjectsForEvidence(
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
): OnsiteStatusSubject[] {
  const analysis = bundle.analysis;
  if (!analysis) return [];
  return keys.flatMap((key): OnsiteStatusSubject[] => {
    if (isMetricKey(analysis, key)) {
      const aggregate = metricAggregate(analysis, key)!;
      const definition = metricDefinition(analysis, key)!;
      return [{
        metricKeys: [key],
        matches: (status) => {
          if (definition.limit === undefined) return false;
          if (status === '达标') return aggregate.latest <= definition.limit;
          if (status === '超标' || status === '不达标') return aggregate.latest > definition.limit;
          return metricFor(key, bundle).status === '关注';
        },
      }];
    }
    const alert = alertIndex(key);
    const item = alert === undefined ? undefined : analysis.alerts[alert];
    if (!item) return [];
    const level = normalizedSemanticText(item.level);
    return [{
      metricKeys: namedMetricKeys(item.metric),
      matches: (status) => level.includes(normalizedSemanticText(status)),
    }];
  });
}

function assertMetricSemanticsBoundToEvidence(
  textValue: string,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
  validateStatus: boolean,
): void {
  const allowedMetricKeys = metricKeysForClaimEvidence(keys, bundle);
  const named = namedMetricKeys(textValue);
  if (named.some((key) => !allowedMetricKeys.has(key))) fail('REPORT_EVIDENCE_INVALID');
  if (!validateStatus) return;

  for (const clause of textValue.split(/[。！？；;\n]/u)) {
    const pairedLimits = clause.match(
      /(.{1,30}?)(?:与|和|、)(.{1,30}?)(?:的)?(?:限值|阈值|标准)\s*分别(?:为|是|[:：])?\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*(?:mg\/L|kg\/L|g\/L|ppm|ppb|kWh(?:\/(?:d|m³))?|kgCO₂e(?:\/m³)?|m³(?:\/d)?|kg(?:\/d)?|元\/d|条\/d|%|吨))?\s*(?:与|和|、)\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/u,
    );
    if (pairedLimits) {
      const leftMetric = namedMetricKeys(pairedLimits[1] ?? '')[0];
      const rightMetric = namedMetricKeys(pairedLimits[2] ?? '')[0];
      const leftLimit = leftMetric && bundle.analysis ? metricDefinition(bundle.analysis, leftMetric)?.limit : undefined;
      const rightLimit = rightMetric && bundle.analysis ? metricDefinition(bundle.analysis, rightMetric)?.limit : undefined;
      if (
        leftLimit === undefined
        || rightLimit === undefined
        || !sameDisplayedNumber(pairedLimits[3] ?? '', leftLimit)
        || !sameDisplayedNumber(pairedLimits[4] ?? '', rightLimit)
      ) fail('REPORT_EVIDENCE_INVALID');
    }

    const pairedStatistics = clause.match(
      /(平均值|均值|最新值|当前值|现值|峰值|最高值|最大值|最低值|最小值)\s*(?:与|和|、)\s*(平均值|均值|最新值|当前值|现值|峰值|最高值|最大值|最低值|最小值)\s*分别(?:为|是|[:：])?\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*(?:mg\/L|kg\/L|g\/L|ppm|ppb|kWh(?:\/(?:d|m³))?|kgCO₂e(?:\/m³)?|m³(?:\/d)?|kg(?:\/d)?|元\/d|条\/d|%|吨))?\s*(?:与|和|、)\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/u,
    );
    if (!pairedStatistics) continue;
    const namedInClause = namedMetricKeys(clause);
    const scopedKeys = namedInClause.length
      ? keys.filter((key) => {
          const represented = metricKeysForClaimEvidence([key], bundle);
          return namedInClause.some((metric) => represented.has(metric));
        })
      : [...keys];
    const aggregates = metricAggregatesForEvidence(scopedKeys.length ? scopedKeys : keys, bundle);
    const valuesForRole = (role: string): number[] => {
      if (role === '平均值' || role === '均值') return aggregates.map(({ average }) => average);
      if (role === '最新值' || role === '当前值' || role === '现值') {
        return aggregates.map(({ latest }) => latest);
      }
      if (role === '峰值' || role === '最高值' || role === '最大值') {
        return aggregates.map(({ max }) => max);
      }
      return aggregates.map(({ min }) => min);
    };
    if (
      !valuesForRole(pairedStatistics[1] ?? '').some((value) => sameDisplayedNumber(pairedStatistics[3] ?? '', value))
      || !valuesForRole(pairedStatistics[2] ?? '').some((value) => sameDisplayedNumber(pairedStatistics[4] ?? '', value))
    ) fail('REPORT_EVIDENCE_INVALID');
  }

  const allBreaches = thresholdBreachesForEvidence(keys, bundle);
  const allDates = textValue.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
  const pointDateText = textValue.replace(
    /\b\d{4}-\d{2}-\d{2}\b\s*(?:至|到|~|～|—)\s*\b\d{4}-\d{2}-\d{2}\b/gu,
    '',
  );
  const pointDates = pointDateText.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
  const hasLimitBreachLanguage = /(?:高于|超过|超出).{0,12}(?:限值|阈值|标准)/u.test(textValue);
  if (hasLimitBreachLanguage && pointDates.some((date) => !allBreaches.some((breach) => breach.date === date))) {
    fail('REPORT_EVIDENCE_INVALID');
  }

  for (const statement of textValue.split(/[。！？；;\n]/u)) {
    if (!/(?:高于|超过|超出).{0,24}(?:限值|阈值|标准)/u.test(statement)) continue;
    const namedInStatement = namedMetricKeys(statement);
    const relevantMetrics = namedInStatement.length ? namedInStatement : [...allowedMetricKeys];
    const breaches = allBreaches.filter(({ metric }) => relevantMetrics.includes(metric));
    const dates = statement.replace(
      /\b\d{4}-\d{2}-\d{2}\b\s*(?:至|到|~|～|—)\s*\b\d{4}-\d{2}-\d{2}\b/gu,
      '',
    ).match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
    if (dates.some((date) => !breaches.some((breach) => breach.date === date))) {
      fail('REPORT_EVIDENCE_INVALID');
    }
  }

  for (const clause of textValue.split(/[。！？；;，,\n]/u)) {
    const statuses = onsiteStatusWords(clause).filter((status) => status === '超标' || status === '不达标');
    if (!statuses.length) continue;
    const namedInClause = namedMetricKeys(clause);
    const relevantKeys = namedInClause.length ? namedInClause : [...allowedMetricKeys];
    const breaches = thresholdBreachesForEvidence(keys, bundle)
      .filter(({ metric }) => relevantKeys.includes(metric));
    const countMatches = [
      ...clause.matchAll(/(?:共有|共计|累计|有|发生|出现)?\s*(\d+)\s*(?:次\s*(?:超标|不达标)|个\s*(?:超标|不达标)(?:日|点|记录|样本))/gu),
      ...clause.matchAll(/(?:超标|不达标)(?:日|点|记录|样本)?.{0,12}?(\d+)\s*(?:次|个)/gu),
    ];
    if (countMatches.some((match) => Number(match[1]) !== breaches.length)) {
      fail('REPORT_EVIDENCE_INVALID');
    }
    const dates = clause.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
    const describesPeriod = /(?:监测期|期间|历史|截至|范围)/u.test(clause)
      || /\b\d{4}-\d{2}-\d{2}\b\s*(?:至|到|~|～|—)\s*\b\d{4}-\d{2}-\d{2}\b/u.test(clause);
    const clauseHasBreachLanguage = statuses.length > 0
      || /(?:高于|超过|超出).{0,12}(?:限值|阈值|标准)/u.test(clause);
    if (
      !describesPeriod
      && clauseHasBreachLanguage
      && dates.some((date) => !breaches.some((breach) => breach.date === date))
    ) {
      fail('REPORT_EVIDENCE_INVALID');
    }
    if (!describesPeriod && dates.some((date) => !breaches.some((breach) => breach.date === date))) {
      fail('REPORT_EVIDENCE_INVALID');
    }
  }

  const allSubjects = statusSubjectsForEvidence(keys, bundle);
  for (const clause of textValue.split(/[。！？；;，,\n]/u)) {
    const statuses = onsiteStatusWords(clause);
    if (!statuses.length) continue;
    const namedInClause = namedMetricKeys(clause);
    const subjects = namedInClause.length
      ? allSubjects.filter((subject) => subject.metricKeys.some((key) => namedInClause.includes(key)))
      : allSubjects;
    const historicalBreach = (status: OnsiteStatusWord): boolean => {
      if (
        (status !== '超标' && status !== '不达标')
        || !(
          /(?:曾|监测期|期间|历史|出现|发生|共有|有\s*\d+\s*(?:次|个)|\d+\s*(?:次|个))/u.test(clause)
          || (hasLimitBreachLanguage && allDates.some((date) => allBreaches.some((breach) => breach.date === date)))
        )
      ) return false;
      const relevantMetrics = namedInClause.length ? namedInClause : [...allowedMetricKeys];
      return bundle.analysis?.thresholdBreaches.some(({ metric }) => (
        allowedMetricKeys.has(metric) && relevantMetrics.includes(metric)
      )) ?? false;
    };
    if (
      !subjects.length
      || statuses.some((status) => !historicalBreach(status) && subjects.some((subject) => !subject.matches(status)))
    ) {
      fail('REPORT_EVIDENCE_INVALID');
    }
  }
}

function decimalPlaces(token: string): number {
  const mantissa = token.replace(/%$/u, '').split(/[eE]/u)[0]!;
  return mantissa.split('.')[1]?.length ?? 0;
}

function sameDisplayedNumber(token: string, evidenceValue: number): boolean {
  const numeric = Number(token.replace(/%$/u, ''));
  if (!Number.isFinite(numeric) || !Number.isFinite(evidenceValue)) return false;
  const precision = Math.min(decimalPlaces(token), 4);
  return Object.is(Number(numeric.toFixed(precision)), Number(evidenceValue.toFixed(precision)));
}

function hasNonAsciiDecimalDigit(value: string): boolean {
  return [...value].some((character) => (
    DECIMAL_DIGIT_PATTERN.test(character) && !/[0-9]/u.test(character)
  ));
}

function allowedEvidenceNumbers(keys: readonly string[], bundle: ReportEvidenceBundle): number[] {
  const values: number[] = [];
  const analysis = bundle.analysis;
  for (const key of keys) {
    const correction = bundle.userCorrections?.find((item) => item.key === key);
    if (correction) values.push(correction.value);
  }
  if (!analysis) return values;
  for (const key of keys) {
    const alert = alertIndex(key);
    if (alert !== undefined) continue;
    if (metricLikeKeys([key], bundle).length) {
      const metric = metricFor(key, bundle);
      values.push(metric.value);
      if (metric.limit !== undefined) values.push(metric.limit);
      const derivation = parsedDerivation(key);
      if (!derivation && isMetricKey(analysis, key)) {
        const aggregate = metricAggregate(analysis, key)!;
        values.push(aggregate.min, aggregate.max, aggregate.average, aggregate.latest);
        if (aggregate.changeRate !== null) values.push(aggregate.changeRate, aggregate.changeRate * 100);
        for (const row of analysis.series) {
          const item = row.values[key];
          if (Number.isFinite(item)) values.push(item as number);
        }
      }
    }
  }
  return values;
}

function allowedEvidenceDates(keys: readonly string[], bundle: ReportEvidenceBundle): Set<string> {
  const dates = new Set(reportEvidenceRefsFor(keys, bundle).flatMap((ref) => (
    ref.dateRange ? [ref.dateRange.from, ref.dateRange.to] : []
  )));
  const analysis = bundle.analysis;
  if (!analysis) return dates;
  const selectedKeys = new Set(keys.flatMap((key) => [key, ...(parsedDerivation(key)?.operands ?? [])]));
  for (const row of analysis.series) {
    if ([...selectedKeys].some((key) => Number.isFinite(row.values[key as AnalysisMetricKey]))) {
      dates.add(row.date);
    }
  }
  for (const breach of analysis.thresholdBreaches) {
    if (selectedKeys.has(breach.metric)) dates.add(breach.date);
  }
  return dates;
}

function localizedEvidenceDates(value: string, allowedDates: ReadonlySet<string>): string[] {
  const matches = [...value.matchAll(/\b(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/gu)];
  for (const match of matches) {
    const year = match[1]!;
    const month = match[2]!.padStart(2, '0');
    const day = match[3]?.padStart(2, '0');
    const valid = day
      ? allowedDates.has(`${year}-${month}-${day}`)
      : [...allowedDates].some((date) => date.startsWith(`${year}-${month}-`));
    if (!valid) fail('REPORT_EVIDENCE_INVALID');
  }
  return matches.map(([matched]) => matched);
}

function isoEvidenceMonths(value: string, allowedDates: ReadonlySet<string>): string[] {
  const months = value.match(/\b\d{4}-\d{2}(?!-\d{2})\b/gu) ?? [];
  if (months.some((month) => ![...allowedDates].some((date) => date.startsWith(`${month}-`)))) {
    fail('REPORT_EVIDENCE_INVALID');
  }
  return months;
}

function evidencedChangeRates(keys: readonly string[], bundle: ReportEvidenceBundle): number[] {
  const analysis = bundle.analysis;
  if (!analysis) return [];
  return keys.flatMap((key) => {
    if (parsedDerivation(key) || !isMetricKey(analysis, key)) return [];
    const changeRate = metricAggregate(analysis, key)?.changeRate;
    return changeRate === null || changeRate === undefined
      ? []
      : [changeRate, changeRate * 100];
  });
}

function rawEvidencedChangeRates(keys: readonly string[], bundle: ReportEvidenceBundle): number[] {
  const analysis = bundle.analysis;
  if (!analysis) return [];
  return keys.flatMap((key) => {
    if (parsedDerivation(key) || !isMetricKey(analysis, key)) return [];
    const changeRate = metricAggregate(analysis, key)?.changeRate;
    return changeRate === null || changeRate === undefined ? [] : [changeRate];
  });
}

function evidencedPercentageMeasurements(keys: readonly string[], bundle: ReportEvidenceBundle): number[] {
  const values: number[] = [];
  const analysis = bundle.analysis;
  for (const key of keys) {
    const correction = bundle.userCorrections?.find((item) => item.key === key);
    if (correction?.unit === '%') values.push(correction.value);
    if (!analysis || parsedDerivation(key)) continue;
    if (isMetricKey(analysis, key) && metricDefinition(analysis, key)?.unit === '%') {
      const aggregate = metricAggregate(analysis, key)!;
      values.push(aggregate.min, aggregate.max, aggregate.average, aggregate.latest);
      for (const row of analysis.series) {
        const value = row.values[key];
        if (Number.isFinite(value)) values.push(value as number);
      }
    }
  }
  return values;
}

function evidencedPercentagePointChanges(keys: readonly string[], bundle: ReportEvidenceBundle): number[] {
  const analysis = bundle.analysis;
  if (!analysis) return [];
  return keys.flatMap((key) => {
    if (!isMetricKey(analysis, key) || metricDefinition(analysis, key)?.unit !== '%') return [];
    const values = analysis.series
      .map((row) => row.values[key])
      .filter((value): value is number => Number.isFinite(value));
    const first = values.at(0);
    const last = values.at(-1);
    return first === undefined || last === undefined ? [] : [last - first];
  });
}

function assertPercentagePointsBoundToEvidence(
  textValue: string,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
): void {
  const changes = evidencedPercentagePointChanges(keys, bundle);
  for (const match of textValue.matchAll(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*个百分点/gu)) {
    const token = match[0].match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)/u)?.[0] ?? '';
    const index = match.index ?? 0;
    const context = textValue.slice(Math.max(0, index - 20), index + match[0].length + 12);
    const positive = changes.some((change) => change >= 0 && sameDisplayedNumber(token, change));
    const negativeSigned = changes.some((change) => change < 0 && sameDisplayedNumber(token, change));
    const negativeMagnitude = NEGATIVE_CHANGE_PATTERN.test(context)
      && changes.some((change) => change < 0 && sameDisplayedNumber(token, Math.abs(change)));
    if (!positive && !negativeSigned && !negativeMagnitude) fail('REPORT_EVIDENCE_INVALID');
    if (POSITIVE_CHANGE_PATTERN.test(context) && !positive) fail('REPORT_EVIDENCE_INVALID');
    if (NEGATIVE_CHANGE_PATTERN.test(context) && !negativeSigned && !negativeMagnitude) {
      fail('REPORT_EVIDENCE_INVALID');
    }
  }
}

function assertPercentagesBoundToChangeRates(
  textValue: string,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
): void {
  const rates = rawEvidencedChangeRates(keys, bundle);
  const measurements = evidencedPercentageMeasurements(keys, bundle);
  for (const match of textValue.matchAll(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)%/gu)) {
    const token = match[0];
    const numeric = Number(token.slice(0, -1));
    const context = textValue.slice(Math.max(0, (match.index ?? 0) - 20), (match.index ?? 0) + token.length + 12);
    const positiveWording = POSITIVE_CHANGE_PATTERN.test(context);
    const negativeWording = NEGATIVE_CHANGE_PATTERN.test(context);
    const before = textValue.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0);
    const matchesMeasurement = measurements.some((value) => sameDisplayedNumber(token, value));
    const endpointMeasurement = matchesMeasurement && /(?:从|由|至|到)\s*$/u.test(before);
    const directlyDescribesChange = /(?:升高|上升|增长|增加|涨幅|提升|降幅|下降|降低|减少|下滑|回落)(?:率|了|为|约|达到|达|至|到|\s|：|:)*$/u.test(before);
    if (
      matchesMeasurement
      && (endpointMeasurement || !directlyDescribesChange)
    ) continue;
    const positive = rates.some((rate) => rate >= 0 && sameDisplayedNumber(token, rate * 100));
    const negativeSigned = rates.some((rate) => rate < 0 && sameDisplayedNumber(token, rate * 100));
    const negativeMagnitude = numeric >= 0
      && NEGATIVE_CHANGE_PATTERN.test(context)
      && rates.some((rate) => rate < 0 && sameDisplayedNumber(token, Math.abs(rate * 100)));
    if (!positive && !negativeSigned && !negativeMagnitude) fail('REPORT_EVIDENCE_INVALID');
    if (positiveWording && !positive) fail('REPORT_EVIDENCE_INVALID');
    if (negativeWording && !negativeSigned && !negativeMagnitude) {
      fail('REPORT_EVIDENCE_INVALID');
    }
    if (numeric >= 0 && !positive && !negativeMagnitude) fail('REPORT_EVIDENCE_INVALID');
  }
}

function metricAggregatesForEvidence(keys: readonly string[], bundle: ReportEvidenceBundle) {
  const analysis = bundle.analysis;
  if (!analysis) return [];
  return [...metricKeysForClaimEvidence(keys, bundle)].flatMap((key) => {
    const aggregate = metricAggregate(analysis, key);
    return aggregate ? [aggregate] : [];
  });
}

function metricLimitsForEvidence(keys: readonly string[], bundle: ReportEvidenceBundle): number[] {
  const analysis = bundle.analysis;
  if (!analysis) return [];
  const metricKeys = metricKeysForClaimEvidence(keys, bundle);
  return [
    ...[...metricKeys].flatMap((key) => {
      const limit = metricDefinition(analysis, key)?.limit;
      return limit === undefined ? [] : [limit];
    }),
    ...thresholdBreachesForEvidence(keys, bundle).map(({ limit }) => limit),
  ];
}

/** Returns undefined for an ordinary measurement, otherwise whether the typed fact is evidenced. */
function typedNumericVerdict(
  textValue: string,
  token: string,
  index: number,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
): boolean | undefined {
  const before = textValue.slice(Math.max(0, index - 32), index);
  const after = textValue.slice(index + token.length, index + token.length + 32);
  const clauseStart = Math.max(
    textValue.lastIndexOf('。', index - 1),
    textValue.lastIndexOf('！', index - 1),
    textValue.lastIndexOf('？', index - 1),
    textValue.lastIndexOf('；', index - 1),
    textValue.lastIndexOf('，', index - 1),
    textValue.lastIndexOf(';', index - 1),
    textValue.lastIndexOf(',', index - 1),
    textValue.lastIndexOf('\n', index - 1),
  );
  const endings = ['。', '！', '？', '；', '，', ';', ',', '\n']
    .map((delimiter) => textValue.indexOf(delimiter, index + token.length))
    .filter((position) => position >= 0);
  const clauseEnd = endings.length ? Math.min(...endings) : textValue.length;
  const clause = textValue.slice(clauseStart + 1, clauseEnd);
  const namedInClause = namedMetricKeys(clause);
  const scopedKeys = namedInClause.length
    ? keys.filter((key) => {
        const represented = metricKeysForClaimEvidence([key], bundle);
        return namedInClause.some((metric) => represented.has(metric));
      })
    : [...keys];
  const roleKeys = scopedKeys.length ? scopedKeys : [...keys];
  const matches = (values: readonly number[]) => values.some((value) => sameDisplayedNumber(token, value));

  if (/^\s*个百分点/u.test(after)) {
    return matches(evidencedPercentagePointChanges(keys, bundle).map((value) => Math.abs(value)))
      || matches(evidencedPercentagePointChanges(keys, bundle));
  }
  if (/(?:相关系数|相关性系数|\br\s*[=:：])[^0-9，。！？；;]{0,16}$/iu.test(before)) {
    return correlationsForEvidence(roleKeys, bundle).some(({ coefficient }) => sameDisplayedNumber(token, coefficient));
  }

  const breachCountSuffix = /^\s*(?:次(?:\s*(?:超标|不达标)|.{0,24}(?:高于|超过|超出).{0,12}(?:限值|阈值|标准))|个\s*(?:超标|不达标)(?:日|点|记录|样本)|天\s*(?:超标|不达标|高于|超过|超出))/u.test(after);
  const breachCountPrefix = (
    /(?:超标|不达标)(?:日|点|记录|样本|次数|天数)?(?:为|有|共|共计|累计|[:：])?\s*$/u.test(before)
    || /(?:高于|超过|超出).{0,16}(?:限值|阈值|标准)(?:的)?次数(?:为|是|[:：])?\s*$/u.test(before)
  ) && /^\s*(?:次|个|天)/u.test(after);
  if (breachCountSuffix || breachCountPrefix) {
    return sameDisplayedNumber(token, thresholdBreachesForEvidence(roleKeys, bundle).length);
  }

  const sampleCountSuffix = /^\s*(?:个\s*)?(?:现场)?(?:样本|数据点|采样点)|^\s*(?:天|日)(?:数据|监测)|^\s*(?:条(?:记录|预警)|次采样)/u.test(after);
  const sampleCountPrefix = /(?:样本|数据点|采样点|监测天数|记录数)(?:数|量)?(?:为|有|共|共计|累计|[:：])?\s*$/u.test(before);
  if (sampleCountSuffix || sampleCountPrefix) {
    if (/(?:相关系数|相关性系数|\br\s*[=:：])/iu.test(clause)) {
      return correlationsForEvidence(roleKeys, bundle)
        .some(({ samples }) => sameDisplayedNumber(token, samples));
    }
    return reportEvidenceRefsFor(keys, bundle)
      .some(({ sampleCount }) => sampleCount !== undefined && sameDisplayedNumber(token, sampleCount));
  }

  const limitBefore = /(?:限值|阈值|标准)(?:为|是|达到|达|[:：])?\s*$/u.test(before);
  const limitAfter = /^\s*(?:mg\/L|kg\/L|g\/L|ppm|ppb|kWh(?:\/(?:d|m³))?|kgCO₂e(?:\/m³)?|m³(?:\/d)?|kg(?:\/d)?|元\/d|条\/d|%|吨)?\s*(?:的)?(?:限值|阈值|标准)/u.test(after);
  if (limitBefore || limitAfter) {
    return matches(metricLimitsForEvidence(roleKeys, bundle));
  }

  const breaches = thresholdBreachesForEvidence(roleKeys, bundle);
  if (/(?:超标值)(?:为|是|达到|达|[:：])?\s*$/u.test(before)) {
    return breaches.some(({ value }) => sameDisplayedNumber(token, value));
  }

  const aggregates = metricAggregatesForEvidence(roleKeys, bundle);
  if (/(?:峰值|最高值|最大值)(?:为|是|达到|达|[:：])?\s*$/u.test(before)) {
    return matches([...aggregates.map(({ max }) => max), ...breaches.map(({ value }) => value)]);
  }
  if (/(?:最低值|最小值)(?:为|是|达到|达|[:：])?\s*$/u.test(before)) {
    return matches(aggregates.map(({ min }) => min));
  }
  if (/(?:平均值|均值)(?:为|是|达到|达|[:：])?\s*$/u.test(before)) {
    return matches(aggregates.map(({ average }) => average));
  }
  if (/(?:最新值|当前值|现值)(?:为|是|达到|达|[:：])?\s*$/u.test(before)) {
    return matches(aggregates.map(({ latest }) => latest));
  }
  return undefined;
}

function isEvidencedDeclineMagnitude(
  textValue: string,
  token: string,
  index: number,
  changeRates: readonly number[],
): boolean {
  const numeric = Number(token.replace(/%$/u, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return false;
  const before = textValue.slice(Math.max(0, index - 16), index);
  const after = textValue.slice(index + token.length, index + token.length + 8);
  const declineWording = /(?:降幅|下降|降低|减少|下滑|回落)(?:率|了|为|约|达到|达|至|到|\s|：|:)*$/u.test(before)
    || /^(?:\s|%|个百分点)*的?(?:降幅|下降|降低|减少|下滑|回落)/u.test(after);
  return declineWording && changeRates
    .filter((rate) => rate < 0)
    .some((rate) => sameDisplayedNumber(token, Math.abs(rate)));
}

function assertNumbersBoundToEvidence(textValue: string, keys: readonly string[], bundle: ReportEvidenceBundle): void {
  if (hasNonAsciiDecimalDigit(textValue)) fail('REPORT_EVIDENCE_INVALID');
  assertPercentagesBoundToChangeRates(textValue, keys, bundle);
  assertPercentagePointsBoundToEvidence(textValue, keys, bundle);
  const refs = reportEvidenceRefsFor(keys, bundle);
  const allowedDates = allowedEvidenceDates(keys, bundle);
  const dates = textValue.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
  if (dates.some((date) => !allowedDates.has(date))) fail('REPORT_EVIDENCE_INVALID');
  const localizedDates = localizedEvidenceDates(textValue, allowedDates);
  const isoMonths = isoEvidenceMonths(textValue, allowedDates);
  const changeRates = evidencedChangeRates(keys, bundle);
  const allowedUnits = new Set([
    ...refs.flatMap((ref) => ref.unit ? [ref.unit] : []),
    ...(changeRates.length ? ['%'] : []),
  ]);
  const units = textValue.match(MEASUREMENT_UNIT_PATTERN) ?? [];
  if (units.some((unit) => !allowedUnits.has(unit))) fail('REPORT_EVIDENCE_INVALID');

  const withoutLocalizedDates = localizedDates.reduce((text, date) => text.split(date).join(''), textValue);
  const protectedText = isoMonths.reduce((text, month) => text.split(month).join(''), withoutLocalizedDates)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, '')
    .replace(/第\s*\d+\s*(?:步|页|项|点)/gu, '');
  const allowed = allowedEvidenceNumbers(keys, bundle);
  const tokens = [...protectedText.matchAll(NUMERIC_TOKEN_PATTERN)];
  if (tokens.some((match) => {
    const token = match[0];
    const index = match.index ?? 0;
    // Percentage tokens have already passed the stricter, wording-aware
    // measurement/change-rate validation above. Avoid applying the generic
    // numeric matcher a second time with narrower decline phrasing rules.
    if (token.endsWith('%')) return false;
    const typedVerdict = typedNumericVerdict(protectedText, token, index, keys, bundle);
    if (typedVerdict !== undefined) return !typedVerdict;
    return !allowed.some((value) => sameDisplayedNumber(token, value))
      && !isEvidencedDeclineMagnitude(protectedText, token, index, changeRates);
  })) fail('REPORT_EVIDENCE_INVALID');
}

function assertNoOnsiteNumericSmuggling(
  value: string,
  allowedPublicValues: readonly string[],
): void {
  const screened = stripAllowedPublicValues(value, allowedPublicValues);
  if (hasNonAsciiDecimalDigit(screened)) fail('REPORT_EVIDENCE_INVALID');
  const hasNumeric = NUMERIC_TOKEN_PATTERN.test(screened);
  NUMERIC_TOKEN_PATTERN.lastIndex = 0;
  MEASUREMENT_UNIT_PATTERN.lastIndex = 0;
  const hasUnit = MEASUREMENT_UNIT_PATTERN.test(screened);
  MEASUREMENT_UNIT_PATTERN.lastIndex = 0;
  if (hasUnit || (hasNumeric && ONSITE_LANGUAGE_PATTERN.test(screened))) fail('REPORT_EVIDENCE_INVALID');
}

function publicProfileValues(bundle: ReportEvidenceBundle, keys: readonly string[]): string[] {
  if (!keys.includes('assistant-profile') || !bundle.assistantProfile?.publicModelName) return [];
  return [bundle.assistantProfile.publicModelName];
}

function validateClaimText(
  kind: ModelSlideDraft['claims'][number]['kind'],
  textValue: string,
  keys: readonly string[],
  bundle: ReportEvidenceBundle,
  allowedPublicValues: readonly string[],
): void {
  const refs = reportEvidenceRefsFor(keys, bundle);
  const excelKeys = refs.filter(({ source }) => source === 'excel').map(({ key }) => key);
  const correctionKeys = refs.filter(({ source }) => source === 'user-correction').map(({ key }) => key);
  if (excelKeys.length) assertMetricSemanticsBoundToEvidence(textValue, excelKeys, bundle, kind === 'onsite-fact');
  if (kind === 'onsite-fact') {
    if (!excelKeys.length || excelKeys.length !== keys.length) fail('REPORT_EVIDENCE_INVALID');
    if (hasUnboundCausalAssertion(textValue, excelKeys, bundle)) fail('REPORT_EVIDENCE_INVALID');
    assertNumbersBoundToEvidence(textValue, excelKeys, bundle);
    return;
  }
  if (kind === 'user-provided') {
    if (!correctionKeys.length || correctionKeys.length !== keys.length) fail('REPORT_EVIDENCE_INVALID');
    if (!/(?:用户提供|用户修正|用户更正)/u.test(textValue) || !/(?:未核验|未经.{0,8}核验|无法核验)/u.test(textValue)) {
      fail('REPORT_EVIDENCE_INVALID');
    }
    assertNumbersBoundToEvidence(textValue, correctionKeys, bundle);
    return;
  }
  if (kind === 'knowledge' && excelKeys.length) fail('REPORT_EVIDENCE_INVALID');
  if (correctionKeys.length) fail('REPORT_EVIDENCE_INVALID');
  if (kind === 'hypothesis' && !HYPOTHESIS_LANGUAGE_PATTERN.test(textValue)) fail('REPORT_EVIDENCE_INVALID');
  if (excelKeys.length) assertNumbersBoundToEvidence(textValue, excelKeys, bundle);
  else assertNoOnsiteNumericSmuggling(textValue, allowedPublicValues);
}

export function validateModelSlideDraft(input: {
  draft: ModelSlideDraft;
  outline: SlideOutline;
  bundle: ReportEvidenceBundle;
  sensitiveValues: readonly string[];
}): {
  evidencePolicy: typeof EVIDENCE_POLICIES[number];
  pageEvidenceRefs: ReportEvidenceRef[];
  claims: BoundClaim[];
} {
  const { draft, outline, bundle, sensitiveValues } = input;
  const allowedPublicValues = publicProfileValues(bundle, outline.evidenceKeys);
  assertSafeReportContent([
    draft.title,
    draft.takeaway,
    ...draft.claims.map(({ text }) => text),
    ...draft.narration.map(({ text }) => text),
    ...(draft.knowledgeItems?.flatMap(({ title, detail }) => [title, detail]) ?? []),
  ], sensitiveValues, 'REPORT_SLIDE_DRAFT_INVALID', allowedPublicValues);

  if (
    draft.visualKind !== outline.visualKind
    || draft.evidenceKeys.length !== outline.evidenceKeys.length
    || draft.evidenceKeys.some((key, index) => key !== outline.evidenceKeys[index])
    || !distinct(draft.evidenceKeys)
  ) fail('REPORT_SLIDE_DRAFT_INVALID');
  assertVisualEvidenceCompatibility(draft.visualKind, draft.evidenceKeys, bundle, 'REPORT_EVIDENCE_INVALID');
  const evidencePolicy = deriveEvidencePolicy(draft.evidenceKeys, bundle);
  if (evidencePolicy !== outline.evidencePolicy) fail('REPORT_EVIDENCE_INVALID');

  const claimIds = draft.claims.map(({ id }) => id);
  if (!distinct(claimIds)) fail('REPORT_SLIDE_DRAFT_INVALID');
  const knownClaims = new Set(claimIds);
  if (
    !distinct(draft.takeawayClaimIds)
    || draft.takeawayClaimIds.some((id) => !knownClaims.has(id))
    || draft.narration.some(({ claimIds: refs }) => !distinct(refs) || refs.some((id) => !knownClaims.has(id)))
  ) fail('REPORT_SLIDE_DRAFT_INVALID');

  const pageKeys = new Set(draft.evidenceKeys);
  for (const value of [
    draft.title,
    ...(draft.knowledgeItems?.flatMap(({ title, detail }) => [title, detail]) ?? []),
  ]) {
    assertAssistantIdentityBoundToProfile(value, draft.evidenceKeys, bundle);
  }
  const claims = draft.claims.map((claim): BoundClaim => {
    if (!distinct(claim.evidenceKeys) || claim.evidenceKeys.some((key) => !pageKeys.has(key))) fail('REPORT_EVIDENCE_INVALID');
    const claimPublicValues = publicProfileValues(bundle, claim.evidenceKeys);
    assertAssistantIdentityBoundToProfile(claim.text, claim.evidenceKeys, bundle);
    validateClaimText(claim.kind, claim.text, claim.evidenceKeys, bundle, claimPublicValues);
    const derivationKeys = claim.evidenceKeys.map(parsedDerivation).filter((item): item is ParsedDerivation => item !== undefined);
    return {
      id: claim.id,
      text: claim.text,
      kind: claim.kind,
      evidenceRefs: reportEvidenceRefsFor(claim.evidenceKeys, bundle),
      ...(derivationKeys.length === 1 ? { derivation: derivationKeys[0] } : {}),
    };
  });
  const claimById = new Map(draft.claims.map((claim) => [claim.id, claim]));
  const validateBoundCopy = (value: string, ids: readonly string[]) => {
    const selected = ids.map((id) => claimById.get(id)!);
    const keys = [...new Set(selected.flatMap((claim) => claim.evidenceKeys))];
    const numericKeys = keys.filter((key) => {
      const source = descriptorFor(key, bundle)?.source;
      return source === 'excel' || source === 'user-correction';
    });
    assertAssistantIdentityBoundToProfile(value, keys, bundle);
    const includesOnsiteFact = selected.some(({ kind }) => kind === 'onsite-fact');
    if (includesOnsiteFact && hasUnboundCausalAssertion(value, numericKeys, bundle)) {
      fail('REPORT_EVIDENCE_INVALID');
    }
    if (numericKeys.length) {
      assertMetricSemanticsBoundToEvidence(value, numericKeys, bundle, includesOnsiteFact);
      assertNumbersBoundToEvidence(value, numericKeys, bundle);
    }
    else assertNoOnsiteNumericSmuggling(value, allowedPublicValues);
  };
  validateBoundCopy(draft.takeaway, draft.takeawayClaimIds);
  for (const narration of draft.narration) validateBoundCopy(narration.text, narration.claimIds);

  if (draft.knowledgeItems) {
    for (const item of draft.knowledgeItems) {
      const copy = `${item.title}\n${item.detail}`;
      const visualExcelKeys = draft.evidenceKeys
        .filter((key) => descriptorFor(key, bundle)?.source === 'excel');
      if (visualExcelKeys.length && hasUnboundCausalAssertion(copy, visualExcelKeys, bundle)) {
        fail('REPORT_EVIDENCE_INVALID');
      }
      assertNoOnsiteNumericSmuggling(copy, allowedPublicValues);
    }
  }
  return {
    evidencePolicy,
    pageEvidenceRefs: reportEvidenceRefsFor(draft.evidenceKeys, bundle),
    claims,
  };
}

export function deepFreezeReportValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreezeReportValue(nested, seen);
  return Object.freeze(value);
}
