import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ANALYSIS_MODULES, type AiErrorCode, type AnalysisModule } from '../../../shared/ai';
import type {
  EvidenceRef,
  FollowUpRequest,
  FollowUpResponse,
  NarrationCursor,
} from '../../../shared/report';
import { followUpRequestSchema } from '../../../shared/report-schema';
import {
  buildFollowUpContext,
  type ConfirmedFact,
  type ConversationMemory,
  type IntentCorrection,
  type IntentTarget,
  type UserCorrection,
} from '../domain/conversation-memory';
import type { AnalysisMetricKey } from '../domain/analysis-plan';
import { METRIC_ALIASES } from '../domain/metric-aliases';
import {
  assertNumericClaims,
  evidenceBundleForKeys,
  evidenceRefsFor,
  isKnownEvidenceKey,
  type FollowUpEvidenceBundle,
} from '../domain/report-follow-up-validation';
import type { ReportEvidenceBundle } from '../domain/report-evidence';
import { getDeepSeekConfig } from '../config';
import {
  DeepSeekServiceError,
  requestDeepSeekCompletion,
  type DeepSeekCompletionRequest,
  type DeepSeekSettings,
} from './deepseek-client';
import type { ReportJobRegistry } from './report-job-registry';

export const REPORT_FOLLOW_UP_TIMEOUT_MS = 15_000;

const text = z.string().trim().min(1).max(2_000);
const correctionSchema = z.object({
  evidenceKey: z.string().trim().min(1),
  value: z.number().finite(),
  unit: z.string().trim().min(1),
  statement: z.string().trim().min(1).max(500),
}).strict();
const intentTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('evidence'), key: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('module'), key: z.enum(ANALYSIS_MODULES) }).strict(),
]);
const intentCorrectionSchema = z.object({
  from: intentTargetSchema,
  to: intentTargetSchema,
}).strict();
const replySchema = z.object({
  answer: text,
  citedEvidenceKeys: z.array(z.string().trim().min(1)).max(20),
  needsClarification: z.boolean(),
  correction: correctionSchema.optional(),
  intentCorrection: intentCorrectionSchema.optional(),
  newTopic: z.object({
    question: z.string().trim().min(1).max(500),
  }).strict().optional(),
}).strict();

export type NewTopicRequest = {
  question: string;
  sourceSlideId?: string;
  sourceEvidenceSnapshotId?: string;
  correction?: UserCorrection;
};

export type AppendNewTopicResult = {
  added: boolean;
  slideId?: string;
  evidenceSnapshotId?: string;
  reason?: 'capacity-full' | 'merged' | 'stale';
};

export type ReportFollowUpDependencies = {
  registry: ReportJobRegistry;
  settings?: DeepSeekSettings | null;
  requestCompletion?: (input: DeepSeekCompletionRequest) => Promise<string>;
  registerSpeech(reportId: string, text: string): string;
  unregisterSpeech(reportId: string, speechId: string): void;
  appendNewTopic(
    reportId: string,
    topic: NewTopicRequest,
    ownership?: { ordinal: number; signal: AbortSignal },
  ): Promise<AppendNewTopicResult>;
  createTurnId?: () => string;
  now?: () => Date;
};

type FollowUpErrorCode = Extract<AiErrorCode,
  | 'REPORT_NOT_FOUND'
  | 'REPORT_EXPIRED'
  | 'REPORT_CANCELLED'
  | 'REPORT_STALE_TURN'
  | 'INVALID_REQUEST'
  | 'NO_EVIDENCE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_HTTP'
  | 'MALFORMED_RESPONSE'
>;

export class ReportFollowUpError extends Error {
  constructor(readonly code: FollowUpErrorCode) {
    super(code);
    this.name = 'ReportFollowUpError';
  }
}

function providerSettings(dependencies: ReportFollowUpDependencies): DeepSeekSettings {
  const settings = dependencies.settings === undefined ? getDeepSeekConfig() : dependencies.settings;
  if (!settings) throw new ReportFollowUpError('UPSTREAM_HTTP');
  return settings;
}

function followUpEvidence(
  bundle: ReportEvidenceBundle,
  memory: ConversationMemory,
  currentSlideId: string,
): FollowUpEvidenceBundle {
  if (bundle.analysis) {
    const memoryCorrections = memory.userCorrections.filter(({ evidenceSnapshotId }) => (
      evidenceSnapshotId !== undefined && evidenceSnapshotId === bundle.snapshotId
    )).map((correction) => ({
      key: `user-correction:${correction.evidenceKey}` as const,
      evidenceKey: correction.evidenceKey,
      value: correction.value,
      unit: correction.unit,
      statement: correction.statement,
      provenance: 'user-provided-unverified' as const,
      sourceSlideId: currentSlideId,
      sourceEvidenceSnapshotId: correction.evidenceSnapshotId!,
      createdAt: correction.createdAt,
    }));
    const userCorrections = [...(bundle.userCorrections ?? []), ...memoryCorrections]
      .filter((correction, index, corrections) => corrections.findIndex((candidate) => (
        candidate.key === correction.key
        && candidate.value === correction.value
        && candidate.unit === correction.unit
      )) === index);
    return {
      snapshotId: bundle.snapshotId,
      mode: 'data',
      analysis: bundle.analysis,
      ...(userCorrections.length ? { userCorrections } : {}),
    };
  }
  return {
    snapshotId: bundle.snapshotId,
    mode: 'knowledge',
    topic: bundle.knowledge.map(({ topic }) => topic).join('、') || '助手身份与能力',
    limitation: '非现场运行数据',
  };
}

function stableDistinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function resumeCursorFor(
  request: FollowUpRequest,
  slide: { id: string; narration: Array<{ id: string }> },
  fallback?: NarrationCursor,
): NarrationCursor {
  const requestedSegment = request.interruptedSegmentId
    && slide.narration.some(({ id }) => id === request.interruptedSegmentId)
    ? request.interruptedSegmentId
    : undefined;
  if (requestedSegment) {
    return {
      slideId: slide.id,
      segmentId: requestedSegment,
      offsetMs: request.narrationOffsetMs ?? 0,
    };
  }
  if (
    fallback?.slideId === slide.id
    && slide.narration.some(({ id }) => id === fallback.segmentId)
  ) return fallback;
  return { slideId: slide.id, segmentId: slide.narration[0]!.id, offsetMs: 0 };
}

function factsFor(
  citedEvidence: readonly EvidenceRef[],
  snapshot: ReturnType<ReportJobRegistry['getSnapshot']>,
  evidenceSnapshotId: string,
): ConfirmedFact[] {
  if (!snapshot) return [];
  return citedEvidence.flatMap((ref): ConfirmedFact[] => {
    const slideMetric = snapshot.slides
      .flatMap(({ metrics }) => metrics)
      .find(({ key, snapshotId }) => key === ref.key && snapshotId === evidenceSnapshotId);
    if (
      !slideMetric
      || slideMetric.unit === undefined
      || slideMetric.dateRange === undefined
      || slideMetric.sampleCount === undefined
    ) return [];
    return [{
      evidenceSnapshotId,
      evidenceKey: slideMetric.key,
      value: slideMetric.value,
      unit: slideMetric.unit,
      dateRange: { ...slideMetric.dateRange },
      sampleCount: slideMetric.sampleCount,
      ...(slideMetric.derivation === undefined ? {} : { formula: slideMetric.derivation.kind }),
    }];
  });
}

function correctionMatchesMetric(correction: Pick<UserCorrection, 'evidenceKey' | 'unit'>, evidence: FollowUpEvidenceBundle): boolean {
  if (evidence.mode !== 'data') return false;
  const definition = evidence.analysis.definitions.find(({ key }) => key === correction.evidenceKey);
  const aggregate = evidence.analysis.aggregates[correction.evidenceKey as AnalysisMetricKey];
  return definition !== undefined && aggregate !== undefined && definition.unit === correction.unit;
}

const MODULE_ALIASES: Record<AnalysisModule, readonly string[]> = {
  overview: ['总览', '概览', 'overview'],
  health: ['健康', '健康度', 'health'],
  'water-quality': ['水质', '出水', 'water-quality'],
  energy: ['能耗', '电耗', '能源', 'energy'],
  alerts: ['告警', '报警', '预警', 'alerts'],
};

function normalizeAlias(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function targetIsAllowed(target: IntentTarget, evidence: FollowUpEvidenceBundle): boolean {
  if (target.kind === 'evidence') return target.key in METRIC_ALIASES;
  return evidence.mode === 'data' && evidence.analysis.scope.modules.includes(target.key);
}

function targetIsAvailable(target: IntentTarget, evidence: FollowUpEvidenceBundle): boolean {
  if (target.kind === 'evidence') return isKnownEvidenceKey(target.key, evidence);
  return targetIsAllowed(target, evidence);
}

function targetAliases(target: IntentTarget, evidence: FollowUpEvidenceBundle): readonly string[] {
  if (target.kind === 'module') return [target.key, ...MODULE_ALIASES[target.key]];
  const definition = evidence.mode === 'data'
    ? evidence.analysis.definitions.find(({ key }) => key === target.key)
    : undefined;
  const metricAliases = target.key in METRIC_ALIASES
    ? METRIC_ALIASES[target.key as AnalysisMetricKey]
    : [];
  return [target.key, ...(definition ? [definition.label] : []), ...metricAliases];
}

function questionMentionsTarget(question: string, target: IntentTarget, evidence: FollowUpEvidenceBundle): boolean {
  const normalized = normalizeAlias(question);
  return targetAliases(target, evidence).some((alias) => normalized.includes(normalizeAlias(alias)));
}

function validIntentCorrection(
  correction: { from: IntentTarget; to: IntentTarget },
  question: string,
  evidence: FollowUpEvidenceBundle,
): boolean {
  return (correction.from.kind !== correction.to.kind || correction.from.key !== correction.to.key)
    && targetIsAllowed(correction.from, evidence)
    && targetIsAvailable(correction.to, evidence)
    && questionMentionsTarget(question, correction.from, evidence)
    && questionMentionsTarget(question, correction.to, evidence);
}

function claimEvidenceWithCorrections(
  evidence: Extract<FollowUpEvidenceBundle, { mode: 'data' }>,
  citedEvidenceKeys: readonly string[],
  memory: ConversationMemory,
): Extract<FollowUpEvidenceBundle, { mode: 'data' }> {
  for (const correction of evidence.userCorrections ?? []) {
    if (
      citedEvidenceKeys.includes(correction.evidenceKey)
      && !citedEvidenceKeys.includes(correction.key)
    ) throw new ReportFollowUpError('MALFORMED_RESPONSE');
  }
  for (const correction of memory.userCorrections) {
    if (correction.evidenceSnapshotId === undefined) continue;
    if (correction.evidenceSnapshotId !== evidence.snapshotId) continue;
    if (!correctionMatchesMetric(correction, evidence)) throw new ReportFollowUpError('MALFORMED_RESPONSE');
  }
  return evidenceBundleForKeys(evidence, citedEvidenceKeys);
}

function evidenceWithProposedCorrection(
  evidence: Extract<FollowUpEvidenceBundle, { mode: 'data' }>,
  correction: NonNullable<z.infer<typeof replySchema>['correction']>,
  sourceSlideId: string,
): Extract<FollowUpEvidenceBundle, { mode: 'data' }> {
  return {
    ...evidence,
    userCorrections: [
      ...(evidence.userCorrections ?? []).filter(({ evidenceKey }) => evidenceKey !== correction.evidenceKey),
      {
        key: `user-correction:${correction.evidenceKey}`,
        evidenceKey: correction.evidenceKey,
        value: correction.value,
        unit: correction.unit,
        statement: correction.statement,
        provenance: 'user-provided-unverified',
        sourceSlideId,
        sourceEvidenceSnapshotId: evidence.snapshotId,
        createdAt: 'pending-validation',
      },
    ],
  };
}

function correctionEvidenceRef(
  correction: Pick<UserCorrection, 'evidenceKey' | 'unit'>,
  evidence: FollowUpEvidenceBundle,
): EvidenceRef {
  const label = evidence.mode === 'data'
    ? evidence.analysis.definitions.find(({ key }) => key === correction.evidenceKey)?.label
    : undefined;
  return {
    key: `user-correction:${correction.evidenceKey}`,
    kind: 'user-provided',
    source: 'user-correction',
    label: `${label ?? correction.evidenceKey}（用户提供·未核验）`,
    unit: correction.unit,
  };
}

function asFollowUpError(error: unknown): ReportFollowUpError {
  if (error instanceof ReportFollowUpError) return error;
  if (error instanceof DeepSeekServiceError) {
    if (error.code === 'UPSTREAM_TIMEOUT') return new ReportFollowUpError('UPSTREAM_TIMEOUT');
    if (error.code === 'UPSTREAM_HTTP') return new ReportFollowUpError('UPSTREAM_HTTP');
    return new ReportFollowUpError('MALFORMED_RESPONSE');
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (code === 'UPSTREAM_TIMEOUT') return new ReportFollowUpError(code);
    if (code === 'UPSTREAM_HTTP') return new ReportFollowUpError(code);
  }
  return new ReportFollowUpError('MALFORMED_RESPONSE');
}

export class ReportFollowUpService {
  private readonly requestCompletion: (input: DeepSeekCompletionRequest) => Promise<string>;
  private readonly createTurnId: () => string;
  private readonly now: () => Date;
  constructor(private readonly dependencies: ReportFollowUpDependencies) {
    this.requestCompletion = dependencies.requestCompletion ?? requestDeepSeekCompletion;
    this.createTurnId = dependencies.createTurnId ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date());
  }

  answer(reportId: string, request: FollowUpRequest, idempotencyKey: string): Promise<FollowUpResponse> {
    const parsedRequest = followUpRequestSchema.safeParse(request);
    if (!parsedRequest.success) return Promise.reject(new ReportFollowUpError('INVALID_REQUEST'));
    const canonicalRequest = parsedRequest.data;
    const fingerprint = JSON.stringify({
      question: canonicalRequest.question,
      slideId: canonicalRequest.slideId,
      interruptedSegmentId: canonicalRequest.interruptedSegmentId ?? null,
      narrationOffsetMs: canonicalRequest.narrationOffsetMs ?? null,
    });
    let resolveCall!: (response: FollowUpResponse) => void;
    let rejectCall!: (error: unknown) => void;
    const promise = new Promise<FollowUpResponse>((resolve, reject) => {
      resolveCall = resolve;
      rejectCall = reject;
    });
    const reservation = this.dependencies.registry.reserveFollowUp(reportId, idempotencyKey, fingerprint, promise);
    if (!reservation) {
      const failure = Promise.reject<FollowUpResponse>(new ReportFollowUpError('REPORT_NOT_FOUND'));
      return failure;
    }
    if (reservation.kind === 'existing') {
      return reservation.promise;
    }
    if (reservation.kind === 'conflict') {
      return Promise.reject(new ReportFollowUpError('INVALID_REQUEST'));
    }

    let settled = false;
    const settle = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      this.dependencies.registry.settleFollowUp(
        reportId,
        idempotencyKey,
        promise,
        reservation.signal,
        succeeded,
      );
    };
    void this.perform(reportId, canonicalRequest, reservation.ordinal, reservation.signal).then(
      (response) => {
        settle(true);
        resolveCall(response);
      },
      (error: unknown) => {
        const failure = asFollowUpError(error);
        settle(false);
        rejectCall(failure);
      },
    );
    return promise;
  }

  private async perform(
    reportId: string,
    request: FollowUpRequest,
    ordinal: number,
    signal: AbortSignal,
  ): Promise<FollowUpResponse> {
    const snapshot = this.dependencies.registry.getSnapshot(reportId);
    const memory = this.dependencies.registry.getConversationMemory(reportId);
    if (!snapshot || snapshot.status === 'cancelled' || !memory) throw new ReportFollowUpError('REPORT_NOT_FOUND');
    if (snapshot.slides.length === 0) throw new ReportFollowUpError('NO_EVIDENCE');
    const slide = snapshot.slides.find(({ id }) => id === request.slideId);
    if (!slide) throw new ReportFollowUpError('REPORT_NOT_FOUND');
    const reportEvidence = this.dependencies.registry.getEvidence(reportId, slide.evidenceSnapshotId);
    if (!reportEvidence) throw new ReportFollowUpError('NO_EVIDENCE');
    const evidence = followUpEvidence(reportEvidence, memory, slide.id);

    if (
      request.interruptedSegmentId
      && !slide.narration.some(({ id }) => id === request.interruptedSegmentId)
    ) throw new ReportFollowUpError('REPORT_NOT_FOUND');
    const baseContext = buildFollowUpContext(memory, slide, reportEvidence);
    const context = {
      ...baseContext,
      ...(request.interruptedSegmentId === undefined ? {} : {
        interruptedSegmentId: request.interruptedSegmentId,
        narrationOffsetMs: request.narrationOffsetMs ?? 0,
      }),
    };
    const settings = providerSettings(this.dependencies);
    const prompt = [
      '你是证据约束的汇报追问助手。只输出一个严格 JSON 对象，不输出 Markdown、HTML、代码或解释。',
      '回答必须仅使用 followUpContext 中的 serverEvidence；不得推测缺失事实。代词优先指向当前页，再结合上一轮和摘要。',
      '若指代同样可能，设置 needsClarification=true 并提出具体澄清问题。',
      'correction 仅用于用户明确纠正；answer 必须逐字包含 correction.statement 后才可替换事实。',
      'intentCorrections 是服务端验证过的对象/意图纠正；处理后续模糊指代时，最新一项优先于当前页和更早对话。intentCorrection 仅用于用户本轮明确说出 from 与 to。',
      '输出结构：{"answer":"...","citedEvidenceKeys":["..."],"needsClarification":false,"correction"?:{"evidenceKey":"...","value":0,"unit":"...","statement":"..."},"intentCorrection"?:{"from":{"kind":"evidence|module","key":"..."},"to":{"kind":"evidence|module","key":"..."}},"newTopic"?:{"question":"..."}}',
      `userQuestion: ${JSON.stringify(request.question)}`,
      `followUpContext: ${JSON.stringify(context)}`,
    ].join('\n');
    let content: string;
    try {
      content = await this.requestCompletion({
        settings,
        prompt,
        temperature: 0,
        timeoutMs: REPORT_FOLLOW_UP_TIMEOUT_MS,
        signal,
        responseFormat: { type: 'json_object' },
      });
    } catch (error) {
      throw asFollowUpError(error);
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(content);
    } catch {
      throw new ReportFollowUpError('MALFORMED_RESPONSE');
    }
    const parsed = replySchema.safeParse(decoded);
    if (!parsed.success || !stableDistinct(parsed.data.citedEvidenceKeys)) {
      throw new ReportFollowUpError('MALFORMED_RESPONSE');
    }
    const reply = parsed.data;
    if (
      reply.citedEvidenceKeys.some((key) => !isKnownEvidenceKey(key, evidence))
      || (!reply.needsClarification && reply.citedEvidenceKeys.length === 0)
    ) throw new ReportFollowUpError('MALFORMED_RESPONSE');
    const explicitCorrection = reply.correction
      && reply.answer.includes(reply.correction.statement)
      && reply.citedEvidenceKeys.includes(reply.correction.evidenceKey)
      && request.question.includes(String(reply.correction.value))
      && request.question.includes(reply.correction.unit)
      && correctionMatchesMetric(reply.correction, evidence);
    if (reply.correction && !explicitCorrection) {
      throw new ReportFollowUpError('MALFORMED_RESPONSE');
    }
    if (reply.intentCorrection && !validIntentCorrection(reply.intentCorrection, request.question, evidence)) {
      throw new ReportFollowUpError('MALFORMED_RESPONSE');
    }
    if (!reply.needsClarification) {
      try {
        const claimKeys = reply.correction
          ? reply.citedEvidenceKeys.map((key) => (
              key === reply.correction!.evidenceKey
                ? `user-correction:${reply.correction!.evidenceKey}`
                : key
            ))
          : reply.citedEvidenceKeys;
        if (!stableDistinct(claimKeys)) throw new ReportFollowUpError('MALFORMED_RESPONSE');
        const evidenceForClaims = evidence.mode === 'data' && reply.correction
          ? evidenceWithProposedCorrection(evidence, reply.correction, slide.id)
          : evidence;
        const claimEvidence = evidenceForClaims.mode === 'data'
          ? claimEvidenceWithCorrections(evidenceForClaims, claimKeys, memory)
          : evidence;
        assertNumericClaims(reply.answer, claimEvidence, claimKeys);
      } catch {
        throw new ReportFollowUpError('MALFORMED_RESPONSE');
      }
    }
    if (!this.dependencies.registry.isLatestFollowUp(reportId, ordinal, signal)) {
      throw new ReportFollowUpError('REPORT_STALE_TURN');
    }

    const capacityFull = reply.newTopic !== undefined
      && snapshot.outline.length >= 12
      && !snapshot.outline.some(({ status }) => status === 'planned' || status === 'failed');
    const answerText = capacityFull
      ? `${reply.answer}\n当前汇报页面已满，本次未新增页面。`
      : reply.answer;
    const citedEvidence = reply.correction
      ? reply.citedEvidenceKeys.flatMap((key) => (
          key === reply.correction!.evidenceKey
            ? [correctionEvidenceRef(reply.correction!, evidence)]
            : evidenceRefsFor([key], evidence)
        ))
      : evidenceRefsFor(reply.citedEvidenceKeys, evidence);
    const resumeCursor = resumeCursorFor(request, slide, memory.narrationCursor);
    const turnId = this.createTurnId();
    const createdAt = this.now().toISOString();
    let speechId: string;
    try {
      speechId = this.dependencies.registerSpeech(reportId, answerText);
    } catch (error) {
      throw error;
    }
    const correction: UserCorrection | undefined = reply.correction
      ? { ...reply.correction, evidenceSnapshotId: slide.evidenceSnapshotId, createdAt }
      : undefined;
    const intentCorrection: IntentCorrection | undefined = reply.intentCorrection
      ? { ...reply.intentCorrection, statement: request.question, createdAt }
      : undefined;
    const response: FollowUpResponse = {
      turnId,
      answer: answerText,
      speechId,
      citedEvidence,
      needsClarification: reply.needsClarification,
      resumeCursor,
    };
    let committed: boolean;
    try {
      committed = this.dependencies.registry.commitFollowUp(reportId, {
        ordinal,
        signal,
        turn: {
          id: turnId,
          question: request.question,
          answer: answerText,
          citedEvidence,
          needsClarification: reply.needsClarification,
          createdAt,
        },
        response,
        facts: factsFor(citedEvidence, snapshot, slide.evidenceSnapshotId),
        ...(correction === undefined ? {} : { correction }),
        ...(intentCorrection === undefined ? {} : { intentCorrection }),
        ...(reply.needsClarification ? {
          unresolvedIntents: [...memory.unresolvedIntents, request.question],
        } : {}),
      });
    } catch (error) {
      try {
        this.dependencies.unregisterSpeech(reportId, speechId);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'FOLLOW_UP_COMMIT_ROLLBACK_FAILED');
      }
      throw error;
    }
    if (!committed) {
      this.dependencies.unregisterSpeech(reportId, speechId);
      throw new ReportFollowUpError('REPORT_STALE_TURN');
    }
    const appendedTopic: NewTopicRequest | undefined = correction || reply.newTopic
      ? {
          question: correction ? request.question : reply.newTopic!.question,
          sourceSlideId: slide.id,
          sourceEvidenceSnapshotId: slide.evidenceSnapshotId,
          ...(correction ? { correction } : {}),
        }
      : undefined;
    if (appendedTopic && !(reply.newTopic && capacityFull)) {
      queueMicrotask(() => {
        void this.dependencies.appendNewTopic(reportId, appendedTopic, { ordinal, signal }).then((result) => {
          if (!this.dependencies.registry.isLatestFollowUp(reportId, ordinal, signal)) return;
          if (!correction || !result.added || !result.slideId || !result.evidenceSnapshotId) return;
          const correctionSlide = this.dependencies.registry.getSnapshot(reportId)?.slides
            .find(({ id }) => id === result.slideId);
          const correctionEvidence = this.dependencies.registry.getEvidence(reportId, result.evidenceSnapshotId);
          const boundCorrection = correctionEvidence?.userCorrections?.find((item) => (
            item.evidenceKey === correction.evidenceKey
            && item.value === correction.value
            && item.unit === correction.unit
            && item.statement === correction.statement
            && item.sourceSlideId === slide.id
            && item.sourceEvidenceSnapshotId === slide.evidenceSnapshotId
          ));
          if (
            correctionSlide?.evidenceSnapshotId !== result.evidenceSnapshotId
            || !boundCorrection
            || !correctionSlide.evidenceRefs.some((ref) => (
              ref.source === 'user-correction' && ref.key === boundCorrection.key
            ))
            || !correctionSlide.claims.some((claim) => (
              claim.kind === 'user-provided'
              && claim.evidenceRefs.some((ref) => ref.source === 'user-correction' && ref.key === boundCorrection.key)
            ))
            || !correctionSlide.metrics.some((metric) => (
              metric.source === 'user-correction'
              && metric.key === boundCorrection.key
              && metric.value === boundCorrection.value
            ))
          ) return;
          if (!this.dependencies.registry.markSlideSuperseded(reportId, slide.id, result.slideId)) return;
          this.dependencies.registry.updateSession(reportId, {
            activity: 'page',
            activeSlideId: result.slideId,
          });
        }).catch(() => {
          // Page append is best-effort after the answer and speech are atomically committed.
        });
      });
    }
    return response;
  }
}
