import { createHash, randomUUID } from 'node:crypto';
import type { AiErrorCode } from '../../../shared/ai';
import type { DashboardDataset } from '../../../shared/dashboard';
import {
  REPORT_MAX_SLIDES,
  type CreateReportRequest,
  type ClarificationSubmission,
  type CreateReportResponse,
  type ReportSlide,
  type SlideOutline,
} from '../../../shared/report';
import { getDeepSeekConfig } from '../config';
import type { UserCorrection } from '../domain/conversation-memory';
import type { CorrectionSupersessionIntent, ReportEvidenceBundle } from '../domain/report-evidence';
import { resolveReportEvidence } from '../domain/report-evidence-resolver';
import type { ReportIntentPlan } from '../domain/report-intent';
import { PersistentSafeSlideOutputError, ReportContentValidationError } from '../domain/report-content-validation';
import { ReportIntentPlanningError, planReportIntent } from './report-intent-planner';
import { planReport } from './intent-first-report-planner';
import { composeSlide } from './intent-first-slide-composer';
import { composeEvidenceFallbackSlide } from './report-evidence-fallback';
import {
  DeepSeekServiceError,
  requestDeepSeekCompletion,
  type DeepSeekCompletionRequest,
  type DeepSeekSettings,
} from './deepseek-client';
import type { AppendNewTopicResult, NewTopicRequest } from './report-follow-up';
import { ReportJobRegistry, type FollowUpOwnership } from './report-job-registry';

const LATER_PAGE_CONCURRENCY = 2;
const NETWORK_ATTEMPTS = 2;
const INJECTED_MODEL_SETTINGS: DeepSeekSettings = {
  apiKey: 'injected-report-generator',
  baseUrl: 'http://127.0.0.1:0',
  model: 'injected-report-generator',
};

export type ReportGeneratorDependencies = {
  dataset: DashboardDataset;
  registry: ReportJobRegistry;
  planReportIntent: typeof planReportIntent;
  resolveReportEvidence: typeof resolveReportEvidence;
  planReport: typeof planReport;
  composeSlide: typeof composeSlide;
  registerSpeech(reportId: string, text: string): string;
  unregisterSpeech(reportId: string, speechId: string): void;
};

export type ReportGeneratorOptions = {
  settings?: DeepSeekSettings | null;
  requestCompletion?: (input: DeepSeekCompletionRequest) => Promise<string>;
};

type ReportContext = { input: CreateReportRequest };
type RunOwnership = { active: boolean; followUp?: FollowUpOwnership };
type RunHandle = { promise: Promise<void>; ownership: RunOwnership };
type CompositionResult = { ready: true } | { ready: false; error?: unknown };
type LaterWaiter = {
  reportId: string;
  signal: AbortSignal;
  ownership: RunOwnership;
  resolve(release: (() => void) | undefined): void;
};
type ModelDependencies = {
  settings: DeepSeekSettings;
  fetchImpl: typeof fetch;
  requestCompletion?: (input: DeepSeekCompletionRequest) => Promise<string>;
};

function signalBoundFetch(signal: AbortSignal): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const combined = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
    return globalThis.fetch(input, { ...init, signal: combined });
  }) as typeof fetch;
}

function retryableNetworkFailure(error: unknown): boolean {
  if (error instanceof DeepSeekServiceError) {
    return error.code === 'UPSTREAM_TIMEOUT'
      || error.code === 'UPSTREAM_HTTP'
      || error.code === 'MALFORMED_RESPONSE';
  }
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; retryable?: unknown };
  return candidate.retryable === true
    || candidate.code === 'UPSTREAM_TIMEOUT'
    || candidate.code === 'UPSTREAM_HTTP'
    || candidate.code === 'MALFORMED_RESPONSE';
}

function failureCode(error: unknown): AiErrorCode {
  if (error instanceof DeepSeekServiceError) return error.code;
  if (error instanceof ReportContentValidationError || error instanceof ReportIntentPlanningError) {
    return 'MALFORMED_RESPONSE';
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (code === 'UPSTREAM_TIMEOUT' || code === 'UPSTREAM_HTTP' || code === 'NO_EVIDENCE') return code;
  }
  return 'MALFORMED_RESPONSE';
}

function sameOutlineMetadata(left: SlideOutline, right: SlideOutline): boolean {
  return left.id === right.id
    && left.order === right.order
    && left.title === right.title
    && left.purpose === right.purpose
    && left.role === right.role
    && left.layout === right.layout
    && left.evidencePolicy === right.evidencePolicy
    && left.visualKind === right.visualKind
    && left.evidenceKeys.length === right.evidenceKeys.length
    && left.evidenceKeys.every((key, index) => key === right.evidenceKeys[index]);
}

function sameOutlineSnapshot(
  actual: readonly SlideOutline[],
  expected: readonly SlideOutline[],
): boolean {
  return actual.length === expected.length
    && actual.every((item, index) => {
      const expectedItem = expected[index];
      return Boolean(expectedItem && sameOutlineMetadata(item, expectedItem));
    });
}

function sameOutlineState(
  actual: readonly SlideOutline[],
  expected: readonly SlideOutline[],
): boolean {
  return sameOutlineSnapshot(actual, expected)
    && actual.every((item, index) => {
      const expectedItem = expected[index];
      return Boolean(expectedItem
        && item.status === expectedItem.status
        && item.retryable === expectedItem.retryable);
    });
}

function evidenceSatisfiesIntent(
  evidence: ReportEvidenceBundle | undefined,
  intent: Extract<ReportIntentPlan, { kind: 'report' }>,
): evidence is ReportEvidenceBundle {
  if (!evidence) return false;
  if (intent.assistantProfile && evidence.assistantProfile === undefined) return false;
  const topics = new Set(evidence.knowledge.map(({ topic }) => topic));
  if (!intent.knowledgeTopics.every((topic) => topics.has(topic))) return false;
  const requested = intent.analysisPlan;
  if (!requested) return true;
  const available = evidence.analysis;
  if (!available) return false;
  return requested.modules.every((module) => available.scope.modules.includes(module))
    && requested.metrics.every((metric) => available.scope.metrics.includes(metric))
    && requested.dateRange.from === available.scope.dateRange.from
    && requested.dateRange.to === available.scope.dateRange.to
    && (!requested.includeHealthWeights || available.healthWeights !== undefined);
}

function evidenceWithUserCorrection(
  evidence: ReportEvidenceBundle,
  correction: UserCorrection | undefined,
  sourceSlideId: string | undefined,
  sourceEvidenceSnapshotId: string | undefined,
): ReportEvidenceBundle {
  if (!correction) return evidence;
  if (
    !sourceSlideId
    || !sourceEvidenceSnapshotId
    || correction.evidenceSnapshotId !== sourceEvidenceSnapshotId
    || evidence.snapshotId !== sourceEvidenceSnapshotId
    || !evidence.analysis?.definitions.some(({ key, unit }) => (
      key === correction.evidenceKey && unit === correction.unit
    ))
    || !Number.isFinite(correction.value)
  ) throw new ReportContentValidationError('REPORT_EVIDENCE_INVALID');
  const overlay = {
    key: `user-correction:${correction.evidenceKey}` as const,
    evidenceKey: correction.evidenceKey,
    value: correction.value,
    unit: correction.unit,
    statement: correction.statement,
    provenance: 'user-provided-unverified' as const,
    sourceSlideId,
    sourceEvidenceSnapshotId,
    createdAt: correction.createdAt,
  };
  const digest = createHash('sha256').update(JSON.stringify({
    baseSnapshotId: evidence.snapshotId,
    correction: overlay,
  })).digest('hex');
  return {
    ...evidence,
    snapshotId: `evidence:correction:${digest}`,
    userCorrections: [
      ...(evidence.userCorrections ?? []).filter(({ evidenceKey }) => evidenceKey !== correction.evidenceKey),
      overlay,
    ],
  };
}

function correctionSupersessionFor(
  topic: NewTopicRequest,
  evidence: ReportEvidenceBundle,
  correctionSlideId: string,
  followUpOrdinal: number,
): CorrectionSupersessionIntent | undefined {
  if (
    !topic.correction
    || !topic.sourceSlideId
    || !topic.sourceEvidenceSnapshotId
    || !Number.isSafeInteger(followUpOrdinal)
    || followUpOrdinal <= 0
  ) return undefined;
  return {
    followUpOrdinal,
    correctionSlideId,
    correctionEvidenceSnapshotId: evidence.snapshotId,
    sourceSlideId: topic.sourceSlideId,
    sourceEvidenceSnapshotId: topic.sourceEvidenceSnapshotId,
    evidenceKey: topic.correction.evidenceKey,
    value: topic.correction.value,
    unit: topic.correction.unit,
    statement: topic.correction.statement,
  };
}

export class ReportGenerator {
  private readonly contexts = new Map<string, ReportContext>();
  private readonly runs = new Map<string, RunHandle>();
  private readonly activeSlideIds = new Map<string, string>();
  private readonly laterWaiters: LaterWaiter[] = [];
  private laterInFlight = 0;
  private disposed = false;
  private readonly unsubscribeOwnershipLoss: () => void;

  constructor(
    public readonly dependencies: ReportGeneratorDependencies,
    private readonly options: ReportGeneratorOptions = {},
  ) {
    this.unsubscribeOwnershipLoss = dependencies.registry.subscribeOwnershipLoss((reportId) => {
      this.releaseReportState(reportId);
    });
  }

  createReport(input: CreateReportRequest): CreateReportResponse {
    if (this.disposed) throw new Error('REPORT_GENERATOR_DISPOSED');
    const snapshot = this.dependencies.registry.create({ question: input.question, originPage: input.page });
    this.contexts.set(snapshot.reportId, { input });
    this.detach(snapshot.reportId);
    return { reportId: snapshot.reportId, snapshot };
  }

  run(reportId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.runs.get(reportId);
    if (existing) return existing.promise;
    const context = this.contexts.get(reportId);
    const snapshot = this.dependencies.registry.getSnapshot(reportId);
    if (!context || !snapshot || snapshot.status !== 'generating') return Promise.resolve();
    return this.startCycle(reportId, (ownership) => this.runInitial(reportId, context, ownership));
  }

  answerClarification(reportId: string, submission: ClarificationSubmission): Promise<void> {
    const accepted = this.dependencies.registry.acceptClarification(
      reportId,
      submission.clarificationId,
      submission.answer,
    );
    if (!accepted) throw new Error('REPORT_STALE_TURN');
    const previous = this.runs.get(reportId);
    return previous
      ? previous.promise.then(() => this.run(reportId), () => this.run(reportId))
      : this.run(reportId);
  }

  prioritize(reportId: string, slideId: string): void {
    const outline = this.dependencies.registry.getSnapshot(reportId)?.outline;
    const selected = outline?.find(({ id }) => id === slideId);
    if (!outline || !selected) return;
    const target = selected.status === 'planned'
      ? selected
      : selected.status === 'ready'
        ? outline.find((item) => item.status === 'planned' && item.order > selected.order)
          ?? outline.find((item) => item.status === 'planned')
        : undefined;
    if (target) this.activeSlideIds.set(reportId, target.id);
    else this.activeSlideIds.delete(reportId);
  }

  retrySlide(reportId: string, slideId: string): void {
    const snapshot = this.dependencies.registry.getSnapshot(reportId);
    const outline = snapshot?.outline.find(({ id }) => id === slideId);
    const evidence = this.dependencies.registry.getEvidenceForSlide(reportId, slideId);
    if (
      !snapshot
      || (snapshot.status !== 'ready' && snapshot.status !== 'partial')
      || !outline
      || !evidence
      || outline.status !== 'failed'
      || outline.retryable !== true
    ) return;
    if (!this.dependencies.registry.resetSlideForRetry(reportId, slideId)) return;
    void this.startCycle(reportId, async (ownership) => {
      const signal = this.dependencies.registry.beginActivity(reportId, 'generation');
      if (!signal) return;
      try {
        if (outline.order === 0) this.dependencies.registry.setPhase(reportId, 'generating-first-slide');
        else this.dependencies.registry.setPhase(reportId, 'generating-slides');
        await this.composeAndPublish(reportId, outline, evidence, signal, ownership, outline.order > 0);
        if (this.isActive(reportId, signal, ownership)) this.dependencies.registry.complete(reportId);
      } finally {
        this.dependencies.registry.endActivity(reportId, 'generation', signal);
      }
    });
  }

  async appendNewTopic(
    reportId: string,
    topic: NewTopicRequest,
    ownership?: FollowUpOwnership,
  ): Promise<AppendNewTopicResult> {
    const snapshot = this.dependencies.registry.getSnapshot(reportId);
    const memory = this.dependencies.registry.getConversationMemory(reportId);
    if (!snapshot || !memory || snapshot.status === 'cancelled' || snapshot.status === 'failed') {
      return { added: false };
    }
    if (
      snapshot.outline.length >= REPORT_MAX_SLIDES
      && !snapshot.outline.some(({ status }) => status === 'planned' || status === 'failed')
    ) return { added: false, reason: 'capacity-full' };
    const signal = this.dependencies.registry.beginActivity(reportId, 'generation');
    if (!signal) return { added: false };
    const runOwnership: RunOwnership = { active: true, ...(ownership ? { followUp: ownership } : {}) };
    let committedAdditions: SlideOutline[] | undefined;
    let committedEvidenceSnapshotId: string | undefined;
    let additionsSettled = false;
    try {
      const conversation = [
        ...(memory.compactSummary ? [{ role: 'assistant' as const, content: `会话摘要：${memory.compactSummary}` }] : []),
        ...memory.turns.flatMap(({ question, answer }) => [
          { role: 'user' as const, content: question },
          { role: 'assistant' as const, content: answer },
        ]),
      ];
      const intent = await this.runModelStage((modelDependencies) => this.dependencies.planReportIntent({
          question: topic.question,
          page: snapshot.originPage,
          dataset: this.dependencies.dataset,
          conversation,
          signal,
        }, modelDependencies), this.dependencies.planReportIntent === planReportIntent, signal);
      if (!this.isActive(reportId, signal, runOwnership)) return { added: false, reason: 'stale' };
      if (intent.kind === 'clarification') return { added: false };
      const sourceSlide = topic.sourceSlideId
        ? snapshot.slides.find(({ id }) => id === topic.sourceSlideId)
        : topic.correction
          ? undefined
          : snapshot.slides.find(({ id }) => id === snapshot.conversation.activeSlideId);
      if (
        (topic.sourceSlideId === undefined) !== (topic.sourceEvidenceSnapshotId === undefined)
        || (topic.sourceSlideId !== undefined && (
          !sourceSlide || sourceSlide.evidenceSnapshotId !== topic.sourceEvidenceSnapshotId
        ))
        || (topic.correction !== undefined && !sourceSlide)
      ) return { added: false };
      const sourceEvidence = sourceSlide
        ? this.dependencies.registry.getEvidence(reportId, sourceSlide.evidenceSnapshotId)
        : undefined;
      if (sourceSlide && !sourceEvidence) return { added: false };
      const resolvedEvidence = topic.correction
        ? sourceEvidence!
        : evidenceSatisfiesIntent(sourceEvidence, intent)
          ? sourceEvidence
        : this.dependencies.resolveReportEvidence({
            intent,
            dataset: this.dependencies.dataset,
            modelId: this.settings().model,
          });
      if (!this.isActive(reportId, signal, runOwnership)) return { added: false, reason: 'stale' };
      const evidence = evidenceWithUserCorrection(
        resolvedEvidence,
        topic.correction,
        topic.sourceSlideId,
        topic.sourceEvidenceSnapshotId,
      );
      const planned = await this.runModelStage((modelDependencies) => this.dependencies.planReport({
          question: topic.question,
          originPage: snapshot.originPage,
          evidence,
          signal,
        }, modelDependencies), this.dependencies.planReport === planReport, signal);
      if (!this.isActive(reportId, signal, runOwnership)) return { added: false, reason: 'stale' };
      const latest = this.dependencies.registry.getSnapshot(reportId);
      if (!latest || !this.isActive(reportId, signal, runOwnership)) {
        return { added: false, reason: 'stale' };
      }
      const candidate = planned[0];
      if (!candidate) return { added: false };
      const correctionFollowUpOrdinal = ownership?.ordinal ?? memory.latestTurnOrdinal;
      if (topic.correction && correctionFollowUpOrdinal <= 0) {
        return { added: false, reason: 'stale' };
      }

      let committedOutline: SlideOutline[];
      let additions: SlideOutline[];
      let resultReason: AppendNewTopicResult['reason'];
      let published: boolean;
      if (latest.outline.length >= REPORT_MAX_SLIDES) {
        const target = [...latest.outline].reverse()
          .find(({ status }) => status === 'failed' || status === 'planned');
        if (!target) return { added: false, reason: 'capacity-full' };
        const replacement: SlideOutline = {
          ...candidate,
          id: target.id,
          order: target.order,
          status: 'planned',
        };
        committedOutline = latest.outline.map((item) => item.id === target.id ? replacement : item);
        additions = [replacement];
        resultReason = 'merged';
        const correctionSupersession = correctionSupersessionFor(
          topic,
          evidence,
          replacement.id,
          correctionFollowUpOrdinal,
        );
        published = this.dependencies.registry.mergePendingOutlineWithEvidence(
          reportId,
          target.id,
          committedOutline,
          evidence,
          ownership,
          correctionSupersession,
        );
      } else {
        const startOrder = latest.outline.length;
        additions = planned.slice(0, REPORT_MAX_SLIDES - startOrder).map((item, index) => ({
          ...item,
          id: `follow-up-${randomUUID()}`,
          order: startOrder + index,
          status: 'planned' as const,
        }));
        if (additions.length === 0) return { added: false };
        committedOutline = [...latest.outline, ...additions];
        const correctionSupersession = correctionSupersessionFor(
          topic,
          evidence,
          additions[0]!.id,
          correctionFollowUpOrdinal,
        );
        published = this.dependencies.registry.publishOutlineWithEvidence(
          reportId,
          committedOutline,
          evidence,
          additions.map(({ id }) => id),
          ownership,
          correctionSupersession,
        );
      }
      if (!published) {
        return { added: false, reason: 'stale' };
      }
      committedAdditions = additions;
      committedEvidenceSnapshotId = evidence.snapshotId;
      if (!this.isActive(reportId, signal, runOwnership)) {
        this.settleSupersededAppend(reportId, committedOutline, additions);
        return { added: false, reason: 'stale' };
      }
      const committed = this.dependencies.registry.getSnapshot(reportId);
      if (
        !committed
        || !sameOutlineSnapshot(committed.outline, committedOutline)
        || additions.some((item) => committed.outline[item.order]?.status !== 'planned')
      ) return { added: false, reason: 'stale' };
      this.dependencies.registry.setPhase(reportId, 'generating-slides');
      if (!this.isActive(reportId, signal, runOwnership)) return { added: false, reason: 'stale' };
      const [firstAddition, ...laterAdditions] = additions;
      if (!firstAddition) return { added: false };
      await this.composeAndPublish(reportId, firstAddition, evidence, signal, runOwnership, false);
      if (!this.isActive(reportId, signal, runOwnership)) return { added: false, reason: 'stale' };
      if (laterAdditions.length > 0) {
        await this.processLaterPages(reportId, laterAdditions, evidence, signal, runOwnership);
      }
      if (!this.isActive(reportId, signal, runOwnership)) return { added: false, reason: 'stale' };
      const settled = this.dependencies.registry.getSnapshot(reportId);
      if (
        !settled
        || !sameOutlineSnapshot(settled.outline, committedOutline)
        || additions.some((item) => {
          const status = settled.outline[item.order]?.status;
          return status !== 'ready' && status !== 'failed';
        })
      ) {
        return { added: false, reason: 'stale' };
      }
      this.dependencies.registry.complete(reportId);
      if (!this.isActive(reportId, signal, runOwnership)) return { added: false, reason: 'stale' };
      const firstReady = settled.slides.some(({ id }) => id === firstAddition.id);
      additionsSettled = true;
      return {
        added: true,
        ...(firstReady ? { slideId: firstAddition.id } : {}),
        ...(firstReady ? { evidenceSnapshotId: evidence.snapshotId } : {}),
        ...(resultReason ? { reason: resultReason } : {}),
      };
    } finally {
      if (committedAdditions && committedEvidenceSnapshotId && !additionsSettled) {
        this.dependencies.registry.settleOwnedSlides(
          reportId,
          committedAdditions,
          committedEvidenceSnapshotId,
        );
        this.dependencies.registry.complete(reportId);
      }
      this.dependencies.registry.endActivity(reportId, 'generation', signal);
    }
  }

  getRetainedStateCountsForTesting(): {
    contexts: number;
    activeSlideIds: number;
    evidenceBindings: number;
    queues: number;
    runs: number;
  } {
    return {
      contexts: this.contexts.size,
      activeSlideIds: this.activeSlideIds.size,
      evidenceBindings: 0,
      queues: this.laterWaiters.length,
      runs: this.runs.size,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeOwnershipLoss();
    for (const reportId of [...this.contexts.keys()]) this.dependencies.registry.cancel(reportId);
    this.contexts.clear();
    this.activeSlideIds.clear();
    for (const handle of this.runs.values()) handle.ownership.active = false;
    for (const waiter of this.laterWaiters.splice(0)) waiter.resolve(undefined);
    this.runs.clear();
  }

  private detach(reportId: string): void {
    void this.run(reportId).catch((error: unknown) => {
      const snapshot = this.dependencies.registry.getSnapshot(reportId);
      if (!snapshot || snapshot.status === 'cancelled' || snapshot.status === 'failed') return;
      if (snapshot.slides.length === 0) this.dependencies.registry.fail(reportId, failureCode(error));
    });
  }

  private startCycle(reportId: string, execute: (ownership: RunOwnership) => Promise<void>): Promise<void> {
    const existing = this.runs.get(reportId);
    if (existing) return existing.promise;
    const ownership: RunOwnership = { active: true };
    const promise = Promise.resolve().then(() => execute(ownership)).finally(() => {
      const current = this.runs.get(reportId);
      if (current?.ownership === ownership) this.runs.delete(reportId);
    });
    this.runs.set(reportId, { promise, ownership });
    return promise;
  }

  private async runInitial(reportId: string, context: ReportContext, ownership: RunOwnership): Promise<void> {
    const signal = this.dependencies.registry.beginActivity(reportId, 'generation');
    if (!signal) return;
    try {
      this.dependencies.registry.setPhase(reportId, 'understanding');
      const memory = this.dependencies.registry.getConversationMemory(reportId);
      const clarificationContext = memory?.clarifications.flatMap(({ prompt, answer }) => [
        { role: 'assistant' as const, content: prompt },
        { role: 'user' as const, content: answer },
      ]) ?? [];
      const question = [context.input.question, ...clarificationContext
        .filter(({ role }) => role === 'user')
        .map(({ content }) => content)].join('\n');
      const intent = await this.runModelStage((modelDependencies) => this.dependencies.planReportIntent({
          question,
          page: context.input.page,
          dataset: this.dependencies.dataset,
          conversation: clarificationContext,
          signal,
        }, modelDependencies), this.dependencies.planReportIntent === planReportIntent, signal);
      if (!this.isActive(reportId, signal, ownership)) return;
      if (intent.kind === 'clarification') {
        this.dependencies.registry.requireClarification(reportId, {
          clarificationId: randomUUID(),
          ...intent.clarification,
        });
        return;
      }

      this.dependencies.registry.setPhase(reportId, intent.analysisPlan ? 'retrieving-evidence' : 'planning');
      const evidence = this.dependencies.resolveReportEvidence({
        intent,
        dataset: this.dependencies.dataset,
        modelId: this.settings().model,
      });
      if (!this.isActive(reportId, signal, ownership)) return;
      this.dependencies.registry.setPhase(reportId, 'planning');
      const outline = await this.runModelStage((modelDependencies) => this.dependencies.planReport({
          question,
          originPage: context.input.page,
          evidence,
          signal,
        }, modelDependencies), this.dependencies.planReport === planReport, signal);
      if (!this.isActive(reportId, signal, ownership)) return;
      if (!this.dependencies.registry.publishOutlineWithEvidence(
        reportId,
        outline,
        evidence,
        outline.map(({ id }) => id),
      )) return;

      const first = outline[0];
      if (!first) throw new ReportContentValidationError('REPORT_OUTLINE_INVALID');
      this.dependencies.registry.setPhase(reportId, 'generating-first-slide');
      const firstReady = await this.composeAndPublish(reportId, first, evidence, signal, ownership, false);
      if (!firstReady.ready) {
        if (this.isActive(reportId, signal, ownership)) {
          this.dependencies.registry.fail(reportId, failureCode(firstReady.error));
        }
        return;
      }
      if (!this.isActive(reportId, signal, ownership)) return;

      const remaining = outline.slice(1);
      if (remaining.length > 0) {
        this.dependencies.registry.setPhase(reportId, 'generating-slides');
        await this.processLaterPages(reportId, remaining, evidence, signal, ownership);
      }
      if (this.isActive(reportId, signal, ownership)) this.dependencies.registry.complete(reportId);
    } catch (error) {
      if (!this.isActive(reportId, signal, ownership)) return;
      const snapshot = this.dependencies.registry.getSnapshot(reportId);
      if (snapshot?.slides.length === 0) this.dependencies.registry.fail(reportId, failureCode(error));
    } finally {
      this.dependencies.registry.endActivity(reportId, 'generation', signal);
    }
  }

  private async processLaterPages(
    reportId: string,
    outlines: readonly SlideOutline[],
    evidence: ReportEvidenceBundle,
    signal: AbortSignal,
    ownership: RunOwnership,
  ): Promise<void> {
    const pending = [...outlines];
    const next = (): SlideOutline | undefined => {
      const prioritized = this.activeSlideIds.get(reportId);
      if (prioritized) {
        const index = pending.findIndex(({ id }) => id === prioritized);
        this.activeSlideIds.delete(reportId);
        if (index >= 0) return pending.splice(index, 1)[0];
      }
      return pending.shift();
    };
    const worker = async () => {
      while (pending.length > 0 && this.isActive(reportId, signal, ownership)) {
        const item = next();
        if (!item) return;
        await this.composeAndPublish(reportId, item, evidence, signal, ownership, true);
      }
    };
    await Promise.all(Array.from({ length: Math.min(LATER_PAGE_CONCURRENCY, outlines.length) }, worker));
  }

  private settleSupersededAppend(
    reportId: string,
    committedOutline: readonly SlideOutline[],
    additions: readonly SlideOutline[],
  ): void {
    let expected = committedOutline.map((item) => ({ ...item }));
    for (const addition of additions) {
      const current = this.dependencies.registry.getSnapshot(reportId);
      if (
        !current
        || current.status !== 'generating'
        || !sameOutlineState(current.outline, expected)
        || current.outline[addition.order]?.status !== 'planned'
      ) return;
      if (!this.dependencies.registry.markSlideFailed(reportId, addition.id, false)) return;
      expected = expected.map((item) => item.id === addition.id
        ? { ...item, status: 'failed' as const, retryable: false }
        : item);
    }
    const settled = this.dependencies.registry.getSnapshot(reportId);
    if (settled?.status === 'generating' && sameOutlineState(settled.outline, expected)) {
      this.dependencies.registry.complete(reportId);
    }
  }

  private async composeAndPublish(
    reportId: string,
    outline: SlideOutline,
    evidence: ReportEvidenceBundle,
    signal: AbortSignal,
    ownership: RunOwnership,
    bounded: boolean,
  ): Promise<CompositionResult> {
    const release = bounded
      ? await this.acquireLaterSlot(reportId, signal, ownership)
      : () => undefined;
    if (!release) return { ready: false };
    try {
      if (!this.isActive(reportId, signal, ownership)) return { ready: false };
      if (!this.dependencies.registry.markSlideGenerating(reportId, outline.id)) return { ready: false };
      if (!this.isActive(reportId, signal, ownership)) return { ready: false };
      const snapshot = this.dependencies.registry.getSnapshot(reportId);
      const previousTakeaway = snapshot?.slides
        .filter(({ order }) => order < outline.order)
        .sort((left, right) => right.order - left.order)[0]?.takeaway;
      try {
        const composed = await this.runModelStage((modelDependencies) => this.dependencies.composeSlide({
            outline,
            evidence,
            ...(previousTakeaway ? { previousTakeaway } : {}),
            signal,
          }, modelDependencies), this.dependencies.composeSlide === composeSlide, signal);
        if (!this.isActive(reportId, signal, ownership)) return { ready: false };
        const published = this.registerAndPublish(reportId, composed, signal, ownership);
        if (!published) return { ready: false };
        return { ready: true };
      } catch (error) {
        if (!this.isActive(reportId, signal, ownership)) return { ready: false };
        if (error instanceof PersistentSafeSlideOutputError) {
          try {
            const fallback = composeEvidenceFallbackSlide(outline, evidence);
            const published = this.registerAndPublish(reportId, fallback, signal, ownership);
            if (!published) return { ready: false };
            return { ready: true };
          } catch (fallbackError) {
            const failure = new Error('REPORT_EVIDENCE_FALLBACK_FAILED', { cause: fallbackError });
            this.dependencies.registry.markSlideFailed(reportId, outline.id, false);
            return { ready: false, error: failure };
          }
        }
        this.dependencies.registry.markSlideFailed(reportId, outline.id, retryableNetworkFailure(error));
        return { ready: false, error };
      }
    } finally {
      release();
    }
  }

  private registerAndPublish(
    reportId: string,
    slide: ReportSlide,
    signal: AbortSignal,
    ownership: RunOwnership,
  ): boolean {
    const registered: string[] = [];
    try {
      const narration: ReportSlide['narration'][number][] = [];
      for (const segment of slide.narration) {
        if (!this.isActive(reportId, signal, ownership)) throw new Error('REPORT_SLIDE_PUBLICATION_CANCELLED');
        const speechId = this.dependencies.registerSpeech(reportId, segment.text);
        registered.push(speechId);
        if (!this.isActive(reportId, signal, ownership)) throw new Error('REPORT_SLIDE_PUBLICATION_CANCELLED');
        narration.push({ ...segment, speechId });
      }
      if (!this.isActive(reportId, signal, ownership)) throw new Error('REPORT_SLIDE_PUBLICATION_CANCELLED');
      const published = this.dependencies.registry.publishSlide(
        reportId,
        { ...slide, narration },
        ownership.followUp,
      );
      if (!published) throw new Error('REPORT_SLIDE_PUBLICATION_FAILED');
      return true;
    } catch (error) {
      for (const speechId of registered.reverse()) this.dependencies.unregisterSpeech(reportId, speechId);
      if (!this.isActive(reportId, signal, ownership)) return false;
      throw error;
    }
  }

  private async runModelStage<T>(
    operation: (dependencies: ModelDependencies) => Promise<T>,
    builtIn: boolean,
    signal: AbortSignal,
  ): Promise<T> {
    const dependencies = this.modelDependencies(signal, builtIn);
    return builtIn
      ? operation(dependencies)
      : this.runNetworkStage(() => operation(dependencies), signal);
  }

  private async runNetworkStage<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < NETWORK_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (signal.aborted || !retryableNetworkFailure(error) || attempt + 1 >= NETWORK_ATTEMPTS) throw error;
      }
    }
    throw lastError;
  }

  private acquireLaterSlot(
    reportId: string,
    signal: AbortSignal,
    ownership: RunOwnership,
  ): Promise<(() => void) | undefined> {
    if (!this.isActive(reportId, signal, ownership)) return Promise.resolve(undefined);
    if (this.laterInFlight < LATER_PAGE_CONCURRENCY) {
      this.laterInFlight += 1;
      return Promise.resolve(this.laterRelease());
    }
    return new Promise((resolve) => {
      this.laterWaiters.push({ reportId, signal, ownership, resolve });
    });
  }

  private releaseLaterSlot(): void {
    this.laterInFlight = Math.max(0, this.laterInFlight - 1);
    while (this.laterWaiters.length > 0) {
      const next = this.laterWaiters.shift()!;
      if (!this.isActive(next.reportId, next.signal, next.ownership)) {
        next.resolve(undefined);
        continue;
      }
      this.laterInFlight += 1;
      next.resolve(this.laterRelease());
      break;
    }
  }

  private laterRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseLaterSlot();
    };
  }

  private isActive(reportId: string, signal: AbortSignal, ownership: RunOwnership): boolean {
    const snapshot = this.dependencies.registry.peekSnapshot(reportId);
    return !this.disposed
      && ownership.active
      && !signal.aborted
      && Boolean(snapshot && snapshot.status !== 'cancelled' && snapshot.status !== 'failed')
      && (!ownership.followUp || this.dependencies.registry.isLatestFollowUp(
        reportId,
        ownership.followUp.ordinal,
        ownership.followUp.signal,
      ));
  }

  private releaseReportState(reportId: string): void {
    const handle = this.runs.get(reportId);
    if (handle) handle.ownership.active = false;
    this.runs.delete(reportId);
    this.contexts.delete(reportId);
    this.activeSlideIds.delete(reportId);
    for (let index = this.laterWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.laterWaiters[index];
      if (waiter?.reportId !== reportId) continue;
      this.laterWaiters.splice(index, 1);
      waiter.resolve(undefined);
    }
  }

  private modelDependencies(signal: AbortSignal, requestLevelRetry: boolean): ModelDependencies {
    const dependencies: ModelDependencies = {
      settings: this.settings(),
      fetchImpl: signalBoundFetch(signal),
    };
    if (!requestLevelRetry) return dependencies;
    const requestCompletion = this.options.requestCompletion ?? requestDeepSeekCompletion;
    let retriesRemaining = NETWORK_ATTEMPTS - 1;
    return {
      ...dependencies,
      requestCompletion: async (request) => {
        try {
          return await requestCompletion(request);
        } catch (error) {
          if (
            request.transportRetry === 'disabled'
            || signal.aborted
            || !retryableNetworkFailure(error)
            || retriesRemaining <= 0
          ) throw error;
          retriesRemaining -= 1;
          return requestCompletion(request);
        }
      },
    };
  }

  private settings(): DeepSeekSettings {
    const settings = this.options.settings === undefined ? getDeepSeekConfig() : this.options.settings;
    if (settings) return settings;
    const builtIn = this.dependencies.planReportIntent === planReportIntent
      || this.dependencies.planReport === planReport
      || this.dependencies.composeSlide === composeSlide;
    if (builtIn) throw new DeepSeekServiceError('MISSING_CONFIGURATION');
    return INJECTED_MODEL_SETTINGS;
  }

}
