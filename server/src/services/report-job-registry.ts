import { randomUUID } from 'node:crypto';
import type { AiErrorCode, AnalysisScope } from '../../../shared/ai';
import {
  REPORT_MAX_SLIDES,
  type ConversationTurn,
  type FollowUpResponse,
  type ClarificationRequest,
  type ReportEvent,
  type ReportJobSnapshot,
  type ReportSlide,
  type SlideOutline,
  type ReportPhase,
  type UpdateReportSessionRequest,
} from '../../../shared/report';
import type { BusinessPage } from '../../../shared/dashboard';
import {
  appendClarificationAnswer,
  appendConversationTurn,
  applyUserCorrection,
  compactConversation,
  createConversationMemory,
  publicConversationSnapshot,
  updateConversationCursor,
  type ConfirmedFact,
  type ConversationMemory,
  type IntentCorrection,
  type UserCorrection,
} from '../domain/conversation-memory';
import { deepFreezeReportValue } from '../domain/report-content-validation';
import {
  correctionEvidenceForIntent,
  slideBindsCorrectionIntent,
  type CorrectionSupersessionIntent,
  type ReportEvidenceBundle,
} from '../domain/report-evidence';

export const REPORT_SLIDING_TTL_MS = 30 * 60 * 1_000;
export const REPORT_ABSOLUTE_TTL_MS = 2 * 60 * 60 * 1_000;
export const MAX_REPORT_JOBS = 32;
export const REPORT_REPLAY_CAPACITY = 256;

export type ReportActivity = 'generation' | 'sse' | 'narration' | 'follow-up';
type ReportSubscriber = (event: ReportEvent) => void;
type PendingDelivery = { event: ReportEvent; subscribers: ReportSubscriber[] };

export type ReportJobRegistryOptions = {
  slidingTtlMs?: number;
  absoluteTtlMs?: number;
  maxEntries?: number;
  replayCapacity?: number;
  now?: () => number;
  createId?: () => string;
  removeSpeechForReport?: (reportId: string) => void;
  createAbortController?: () => AbortController;
};

type ReportRecord = {
  snapshot: ReportJobSnapshot;
  memory: ConversationMemory;
  evidence: Map<string, ReportEvidenceBundle>;
  evidenceSnapshotBySlideId: Map<string, string>;
  correctionSupersessionBySlideId: Map<string, CorrectionSupersessionIntent>;
  events: ReportEvent[];
  sequence: number;
  subscribers: Set<ReportSubscriber>;
  deliveryQueue: PendingDelivery[];
  delivering: boolean;
  activities: Record<ReportActivity, number>;
  idempotency: Map<string, { fingerprint: string; promise: Promise<FollowUpResponse> }>;
  abortControllers: Set<AbortController>;
  latestFollowUpSignal?: AbortSignal;
  speechRemoved: boolean;
  ownershipLossNotified: boolean;
  createdAtMs: number;
  lastActiveAtMs: number;
  absoluteExpiresAtMs: number;
};

export type FollowUpReservation =
  | { kind: 'existing'; promise: Promise<FollowUpResponse> }
  | { kind: 'conflict' }
  | { kind: 'started'; ordinal: number; signal: AbortSignal };

export type FollowUpCommit = {
  ordinal: number;
  signal: AbortSignal;
  turn: ConversationTurn;
  response: FollowUpResponse;
  facts?: ConfirmedFact[];
  correction?: UserCorrection;
  intentCorrection?: IntentCorrection;
  unresolvedIntents?: string[];
};

export type FollowUpOwnership = {
  ordinal: number;
  signal: AbortSignal;
};

type PublicEventInput =
  | { type: 'report.outline'; outline: SlideOutline[] }
  | { type: 'report.state-changed'; status: ReportJobSnapshot['status']; phase: ReportPhase | null; clarification: ClarificationRequest | null }
  | { type: 'report.clarification-required'; clarification: ClarificationRequest }
  | { type: 'slide.generating'; slideId: string; order: number }
  | { type: 'slide.ready'; slide: ReportSlide }
  | { type: 'slide.failed'; slideId: string; retryable: boolean }
  | { type: 'report.completed'; status: 'ready' | 'partial' }
  | { type: 'report.failed'; code: AiErrorCode }
  | { type: 'report.cancelled' };

type InternalMutation =
  | { type: 'internal.evidence'; evidence: ReportEvidenceBundle }
  | {
      type: 'internal.outline-evidence';
      outline: SlideOutline[];
      evidence: ReportEvidenceBundle;
      slideIds: string[];
      mergeSlideId?: string;
      correctionSupersession?: CorrectionSupersessionIntent;
    }
  | { type: 'internal.retry-slide'; slideId: string }
  | { type: 'internal.merge-outline'; slideId: string; outline: SlideOutline[] }
  | { type: 'internal.session'; update: UpdateReportSessionRequest }
  | { type: 'internal.accept-clarification'; clarificationId: string; answer: string };

type RegistryMutation = PublicEventInput | InternalMutation;

const EMPTY_SCOPE: AnalysisScope = {
  modules: [],
  metrics: [],
  dateRange: { from: '1970-01-01', to: '1970-01-01' },
  sampleCount: 0,
  granularity: 'daily',
};

function cloneFrozen<T>(value: T): T {
  return deepFreezeReportValue(structuredClone(value));
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function activityCount(record: ReportRecord): number {
  return Object.values(record.activities).reduce((sum, count) => sum + count, 0);
}

function withoutRetryable(outline: SlideOutline): SlideOutline {
  const { retryable: _retryable, ...rest } = outline;
  return rest;
}

function outlineMetadata(outline: SlideOutline): Omit<SlideOutline, 'status' | 'retryable'> {
  const { status: _status, retryable: _retryable, ...metadata } = outline;
  return metadata;
}

function isTerminalStatus(status: ReportJobSnapshot['status']): boolean {
  return status === 'failed' || status === 'cancelled';
}

function assertOutlineShape(outline: readonly SlideOutline[]): void {
  if (
    outline.length === 0
    || outline.length > REPORT_MAX_SLIDES
    || new Set(outline.map(({ id }) => id)).size !== outline.length
    || outline.some((item, index) => item.order !== index)
  ) throw new Error('REPORT_OUTLINE_INVALID');
}

export class ReportJobRegistry {
  private readonly entries = new Map<string, ReportRecord>();
  private readonly ownershipLossSubscribers = new Set<(reportId: string) => void>();
  private readonly controllerActivities = new WeakMap<AbortController, ReportActivity>();
  private readonly slidingTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly maxEntries: number;
  private readonly replayCapacity: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly removeSpeechForReport: (reportId: string) => void;
  private readonly createAbortController: () => AbortController;

  constructor(options: ReportJobRegistryOptions = {}) {
    this.slidingTtlMs = options.slidingTtlMs ?? REPORT_SLIDING_TTL_MS;
    this.absoluteTtlMs = options.absoluteTtlMs ?? REPORT_ABSOLUTE_TTL_MS;
    this.maxEntries = options.maxEntries ?? MAX_REPORT_JOBS;
    this.replayCapacity = options.replayCapacity ?? REPORT_REPLAY_CAPACITY;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.removeSpeechForReport = options.removeSpeechForReport ?? (() => undefined);
    this.createAbortController = options.createAbortController ?? (() => new AbortController());
  }

  create(input: { question: string; originPage: BusinessPage }): ReportJobSnapshot {
    const now = this.now();
    this.sweep(now);
    if (this.entries.size >= this.maxEntries) this.evictOldestInactive();
    if (this.entries.size >= this.maxEntries) throw new Error('REPORT_CAPACITY');

    const reportId = this.allocateId();
    const expiresAtMs = Math.min(now + this.slidingTtlMs, now + this.absoluteTtlMs);
    const memory = createConversationMemory({
      originalQuestion: input.question,
    });
    const snapshot = cloneFrozen<ReportJobSnapshot>({
      reportId,
      question: input.question,
      originPage: input.originPage,
      scope: EMPTY_SCOPE,
      status: 'generating',
      phase: 'understanding',
      clarification: null,
      outline: [],
      slides: [],
      conversation: publicConversationSnapshot(memory),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      lastSequence: 0,
    });
    this.entries.set(reportId, {
      snapshot,
      memory,
      evidence: new Map(),
      evidenceSnapshotBySlideId: new Map(),
      correctionSupersessionBySlideId: new Map(),
      events: [],
      sequence: 0,
      subscribers: new Set(),
      deliveryQueue: [],
      delivering: false,
      activities: { generation: 0, sse: 0, narration: 0, 'follow-up': 0 },
      idempotency: new Map(),
      abortControllers: new Set(),
      speechRemoved: false,
      ownershipLossNotified: false,
      createdAtMs: now,
      lastActiveAtMs: now,
      absoluteExpiresAtMs: now + this.absoluteTtlMs,
    });
    return cloneFrozen(snapshot);
  }

  getSnapshot(reportId: string): ReportJobSnapshot | undefined {
    const record = this.activeRecord(reportId, true);
    return record ? cloneFrozen(record.snapshot) : undefined;
  }

  peekSnapshot(reportId: string): ReportJobSnapshot | undefined {
    const record = this.activeRecord(reportId, false);
    return record ? cloneFrozen(record.snapshot) : undefined;
  }

  setEvidence(reportId: string, evidence: ReportEvidenceBundle): boolean {
    return this.publish(reportId, { type: 'internal.evidence', evidence });
  }

  publishOutlineWithEvidence(
    reportId: string,
    outline: SlideOutline[],
    evidence: ReportEvidenceBundle,
    slideIds: string[],
    ownership?: FollowUpOwnership,
    correctionSupersession?: CorrectionSupersessionIntent,
  ): boolean {
    return this.publish(reportId, {
      type: 'internal.outline-evidence',
      outline,
      evidence,
      slideIds,
      ...(correctionSupersession ? { correctionSupersession } : {}),
    }, ownership);
  }

  mergePendingOutlineWithEvidence(
    reportId: string,
    slideId: string,
    outline: SlideOutline[],
    evidence: ReportEvidenceBundle,
    ownership?: FollowUpOwnership,
    correctionSupersession?: CorrectionSupersessionIntent,
  ): boolean {
    return this.publish(reportId, {
      type: 'internal.outline-evidence',
      outline,
      evidence,
      slideIds: [slideId],
      mergeSlideId: slideId,
      ...(correctionSupersession ? { correctionSupersession } : {}),
    }, ownership);
  }

  setPhase(reportId: string, phase: Exclude<ReportPhase, 'completed'>): boolean {
    const status = this.peekSnapshot(reportId)?.status;
    if (status !== 'generating' && status !== 'ready' && status !== 'partial') return false;
    return this.publish(reportId, {
      type: 'report.state-changed',
      status: 'generating',
      phase,
      clarification: null,
    });
  }

  requireClarification(reportId: string, clarification: ClarificationRequest): boolean {
    const changed = this.publish(reportId, {
      type: 'report.state-changed',
      status: 'awaiting-clarification',
      phase: null,
      clarification,
    });
    if (!changed) return false;
    return this.publish(reportId, { type: 'report.clarification-required', clarification });
  }

  acceptClarification(reportId: string, clarificationId: string, answer: string): boolean {
    return this.publish(reportId, { type: 'internal.accept-clarification', clarificationId, answer });
  }

  getEvidence(reportId: string, snapshotId: string): ReportEvidenceBundle | undefined {
    const record = this.activeRecord(reportId, true);
    const evidence = record?.evidence.get(snapshotId);
    return evidence ? cloneFrozen(evidence) : undefined;
  }

  getEvidenceForSlide(reportId: string, slideId: string): ReportEvidenceBundle | undefined {
    const record = this.activeRecord(reportId, true);
    const snapshotId = record?.evidenceSnapshotBySlideId.get(slideId);
    const evidence = snapshotId ? record?.evidence.get(snapshotId) : undefined;
    return evidence ? cloneFrozen(evidence) : undefined;
  }

  getConversationMemory(reportId: string): ConversationMemory | undefined {
    const record = this.activeRecord(reportId, true);
    return record ? cloneFrozen(record.memory) : undefined;
  }

  reserveFollowUp(
    reportId: string,
    idempotencyKey: string,
    fingerprint: string,
    promise: Promise<FollowUpResponse>,
  ): FollowUpReservation | undefined {
    const record = this.activeRecord(reportId, true);
    if (!record || isTerminalStatus(record.snapshot.status)) return undefined;
    const existing = record.idempotency.get(idempotencyKey);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? { kind: 'existing', promise: existing.promise }
        : { kind: 'conflict' };
    }
    const controller = this.createAbortController();
    record.activities['follow-up'] += 1;
    record.abortControllers.add(controller);
    this.controllerActivities.set(controller, 'follow-up');
    record.idempotency.set(idempotencyKey, { fingerprint, promise });
    const ordinal = record.memory.latestTurnOrdinal + 1;
    record.latestFollowUpSignal = controller.signal;
    record.memory = createConversationMemory({ ...record.memory, latestTurnOrdinal: ordinal });
    return { kind: 'started', ordinal, signal: controller.signal };
  }

  isLatestFollowUp(reportId: string, ordinal: number, signal: AbortSignal): boolean {
    const record = this.activeRecord(reportId, false);
    return Boolean(record && this.hasFollowUpOwnership(record, { ordinal, signal }));
  }

  commitFollowUp(reportId: string, input: FollowUpCommit): boolean {
    const record = this.activeRecord(reportId, true);
    if (!record || !this.isLatestFollowUp(reportId, input.ordinal, input.signal)) return false;
    let memory = appendConversationTurn(record.memory, input.turn, {
      ...(input.facts === undefined ? {} : { facts: input.facts }),
      ...(input.correction === undefined ? {} : { correction: input.correction }),
      ...(input.intentCorrection === undefined ? {} : { intentCorrection: input.intentCorrection }),
      ...(input.unresolvedIntents === undefined ? {} : { unresolvedIntents: input.unresolvedIntents }),
    });
    memory = compactConversation(memory);
    const snapshot = cloneFrozen({
      ...record.snapshot,
      conversation: publicConversationSnapshot(memory),
    });
    record.memory = memory;
    record.snapshot = snapshot;
    return true;
  }

  settleFollowUp(
    reportId: string,
    idempotencyKey: string,
    promise: Promise<FollowUpResponse>,
    signal: AbortSignal,
    succeeded: boolean,
  ): void {
    const record = this.entries.get(reportId);
    if (record && !succeeded && record.idempotency.get(idempotencyKey)?.promise === promise) {
      record.idempotency.delete(idempotencyKey);
    }
    this.endActivity(reportId, 'follow-up', signal);
  }

  publishOutline(reportId: string, outline: SlideOutline[], ownership?: FollowUpOwnership): boolean {
    return this.publish(reportId, { type: 'report.outline', outline }, ownership);
  }

  mergePendingOutline(
    reportId: string,
    slideId: string,
    outline: SlideOutline[],
    ownership?: FollowUpOwnership,
  ): boolean {
    return this.publish(reportId, { type: 'internal.merge-outline', slideId, outline }, ownership);
  }

  markSlideGenerating(reportId: string, slideId: string): boolean {
    const order = this.peekSnapshot(reportId)?.outline.find(({ id }) => id === slideId)?.order;
    return order === undefined ? false : this.publish(reportId, { type: 'slide.generating', slideId, order });
  }

  publishSlide(
    reportId: string,
    slide: ReportSlide,
    ownership?: FollowUpOwnership,
  ): boolean {
    return this.publish(reportId, { type: 'slide.ready', slide }, ownership);
  }

  settleOwnedSlides(
    reportId: string,
    additions: readonly SlideOutline[],
    evidenceSnapshotId: string,
  ): boolean {
    const record = this.activeRecord(reportId, false);
    if (!record || isTerminalStatus(record.snapshot.status)) return false;
    const owned = new Map(additions.map((item) => [item.id, item]));
    for (const addition of additions) {
      const current = record.snapshot.outline.find(({ id }) => id === addition.id);
      if (!current) return false;
      if (record.evidenceSnapshotBySlideId.get(addition.id) !== evidenceSnapshotId) return false;
      if (!equal(outlineMetadata(current), outlineMetadata(addition))) return false;
    }
    const nextOutline = record.snapshot.outline.map((item) => {
      if (!owned.has(item.id) || item.status === 'ready' || item.status === 'failed') return item;
      return { ...item, status: 'failed' as const, retryable: false };
    });
    if (equal(nextOutline, record.snapshot.outline)) return true;
    for (const item of record.snapshot.outline) {
      if (owned.has(item.id) && (item.status === 'planned' || item.status === 'generating')) {
        record.evidenceSnapshotBySlideId.delete(item.id);
        record.correctionSupersessionBySlideId.delete(item.id);
      }
    }
    record.snapshot = cloneFrozen({ ...record.snapshot, outline: nextOutline });
    this.pruneEvidence(record, undefined, true);
    this.emit(record, [{ type: 'report.outline', outline: cloneFrozen(nextOutline) }]);
    return true;
  }

  markSlideSuperseded(reportId: string, slideId: string, correctionSlideId: string): boolean {
    const snapshot = this.peekSnapshot(reportId);
    const oldSlide = snapshot?.slides.find(({ id }) => id === slideId);
    const correctionSlide = snapshot?.slides.find(({ id }) => id === correctionSlideId);
    if (
      !oldSlide
      || !correctionSlide
      || slideId === correctionSlideId
      || correctionSlide.order <= oldSlide.order
    ) return false;
    return this.publish(reportId, {
      type: 'slide.ready',
      slide: { ...oldSlide, supersededBySlideId: correctionSlideId },
    });
  }

  markSlideFailed(reportId: string, slideId: string, retryable: boolean): boolean {
    return this.publish(reportId, { type: 'slide.failed', slideId, retryable });
  }

  resetSlideForRetry(reportId: string, slideId: string): boolean {
    const record = this.activeRecord(reportId, false);
    const status = record?.snapshot.status;
    if (!record || (status !== 'ready' && status !== 'partial')) return false;
    const correctionIntent = record.correctionSupersessionBySlideId.get(slideId);
    if (correctionIntent && correctionIntent.followUpOrdinal !== record.memory.latestTurnOrdinal) {
      this.publish(reportId, { type: 'slide.failed', slideId, retryable: false });
      return false;
    }
    return this.publish(reportId, { type: 'internal.retry-slide', slideId });
  }

  complete(reportId: string, forcedStatus?: 'ready' | 'partial'): boolean {
    const record = this.activeRecord(reportId, false);
    if (
      !record
      || record.snapshot.status !== 'generating'
      || record.snapshot.outline.length === 0
      || record.snapshot.slides.length === 0
      || record.snapshot.outline.some(({ status }) => status !== 'ready' && status !== 'failed')
    ) return false;
    const status = forcedStatus ?? (record.snapshot.outline.length > 0
      && record.snapshot.outline.every(({ status: slideStatus }) => slideStatus === 'ready')
      ? 'ready'
      : 'partial');
    const phaseChanged = this.publish(reportId, {
      type: 'report.state-changed',
      status,
      phase: 'completed',
      clarification: null,
    });
    const completed = this.publish(reportId, { type: 'report.completed', status });
    return phaseChanged || completed;
  }

  fail(reportId: string, code: AiErrorCode): boolean {
    const record = this.entries.get(reportId);
    if (!record || isTerminalStatus(record.snapshot.status)) return false;
    const failed = this.publish(reportId, { type: 'report.failed', code });
    if (failed) {
      this.cleanup(record, reportId);
      this.notifyOwnershipLoss(reportId, record);
    }
    return failed;
  }

  subscribe(reportId: string, subscriber: (event: ReportEvent) => void): (() => void) | undefined {
    const record = this.activeRecord(reportId, true);
    if (!record || record.snapshot.status === 'cancelled') return undefined;
    record.subscribers.add(subscriber);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      record.subscribers.delete(subscriber);
    };
  }

  subscribeOwnershipLoss(subscriber: (reportId: string) => void): () => void {
    this.ownershipLossSubscribers.add(subscriber);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.ownershipLossSubscribers.delete(subscriber);
    };
  }

  replayAfter(reportId: string, lastSequence: number): ReportEvent[] | null | undefined {
    const record = this.activeRecord(reportId, true);
    if (!record) return undefined;
    const firstAvailable = record.events[0]?.sequence;
    if (firstAvailable !== undefined && lastSequence < firstAvailable - 1) return null;
    return record.events
      .filter(({ sequence }) => sequence > lastSequence)
      .map((event) => cloneFrozen(event));
  }

  updateSession(reportId: string, update: UpdateReportSessionRequest): boolean {
    if (!this.activeRecord(reportId, true)) return false;
    return this.publish(reportId, { type: 'internal.session', update });
  }

  beginActivity(reportId: string, activity: ReportActivity): AbortSignal | undefined {
    const record = this.activeRecord(reportId, true);
    if (
      !record
      || record.snapshot.status === 'cancelled'
      || (record.snapshot.status === 'failed' && activity !== 'sse')
    ) return undefined;
    const controller = this.createAbortController();
    record.activities[activity] += 1;
    record.abortControllers.add(controller);
    this.controllerActivities.set(controller, activity);
    return controller.signal;
  }

  endActivity(reportId: string, activity: ReportActivity, signal: AbortSignal): void {
    const record = this.entries.get(reportId);
    if (!record) return;
    let matched: AbortController | undefined;
    for (const controller of record.abortControllers) {
      if (controller.signal === signal && this.controllerActivities.get(controller) === activity) {
        matched = controller;
        break;
      }
    }
    if (!matched) return;
    record.abortControllers.delete(matched);
    record.activities[activity] = Math.max(0, record.activities[activity] - 1);
    this.sweep();
  }

  cancel(reportId: string): boolean {
    const record = this.entries.get(reportId);
    if (!record) return false;
    if (isTerminalStatus(record.snapshot.status)) return true;
    const settledOutline = record.snapshot.outline.map((item) => (
      item.status === 'planned' || item.status === 'generating'
        ? { ...item, status: 'failed' as const, retryable: false }
        : item
    ));
    if (!equal(settledOutline, record.snapshot.outline)) {
      record.snapshot = cloneFrozen({ ...record.snapshot, outline: settledOutline });
    }
    this.publish(reportId, { type: 'report.cancelled' });
    this.cleanup(record, reportId);
    this.notifyOwnershipLoss(reportId, record);
    return true;
  }

  sweep(now = this.now()): number {
    let removed = 0;
    for (const [reportId, record] of this.entries) {
      if (this.isExpired(record, now)) {
        this.remove(reportId, record);
        removed += 1;
      }
    }
    return removed;
  }

  private publish(reportId: string, mutation: RegistryMutation, ownership?: FollowUpOwnership): boolean {
    const record = this.activeRecord(reportId, false);
    if (!record || isTerminalStatus(record.snapshot.status)) return false;
    if (ownership && !this.hasFollowUpOwnership(record, ownership)) return false;
    const previous = record.snapshot;
    const next = this.reduce(record, mutation);
    if (!next) return false;

    record.snapshot = cloneFrozen(next);
    const eventInputs: PublicEventInput[] = [];
    if (mutation.type === 'internal.retry-slide') {
      eventInputs.push(
        {
          type: 'report.state-changed',
          status: next.status,
          phase: next.phase,
          clarification: next.clarification,
        },
        { type: 'report.outline', outline: cloneFrozen(next.outline) },
      );
    } else if (
      mutation.type === 'internal.merge-outline'
      || mutation.type === 'internal.outline-evidence'
      || mutation.type === 'report.outline'
    ) {
      if (
        previous.status !== next.status
        || previous.phase !== next.phase
        || !equal(previous.clarification, next.clarification)
      ) {
        eventInputs.push({
          type: 'report.state-changed',
          status: next.status,
          phase: next.phase,
          clarification: next.clarification,
        });
      }
      eventInputs.push({ type: 'report.outline', outline: cloneFrozen(next.outline) });
    } else if (mutation.type === 'internal.accept-clarification') {
      eventInputs.push({
        type: 'report.state-changed',
        status: 'generating',
        phase: 'understanding',
        clarification: null,
      });
    } else if (mutation.type.startsWith('internal.')) {
      return true;
    } else if (mutation.type === 'slide.ready') {
      eventInputs.push(mutation);
      const automaticallySuperseded = next.slides.find((slide) => {
        if (slide.supersededBySlideId !== mutation.slide.id) return false;
        const previousSlide = previous.slides.find(({ id }) => id === slide.id);
        return previousSlide?.supersededBySlideId === undefined;
      });
      if (automaticallySuperseded) {
        eventInputs.push({ type: 'slide.ready', slide: automaticallySuperseded });
      }
    } else {
      eventInputs.push(mutation as PublicEventInput);
    }

    this.emit(record, eventInputs);
    return true;
  }

  private emit(record: ReportRecord, eventInputs: readonly PublicEventInput[]): void {
    const subscribers = [...record.subscribers];
    for (const eventInput of eventInputs) {
      record.sequence += 1;
      const event = cloneFrozen({ ...eventInput, sequence: record.sequence } as ReportEvent);
      record.events.push(event);
      if (record.events.length > this.replayCapacity) {
        record.events.splice(0, record.events.length - this.replayCapacity);
      }
      record.snapshot = cloneFrozen({ ...record.snapshot, lastSequence: record.sequence });
      record.deliveryQueue.push({ event, subscribers });
    }
    this.flushDeliveries(record);
  }

  private flushDeliveries(record: ReportRecord): void {
    if (record.delivering) return;
    record.delivering = true;
    try {
      while (record.deliveryQueue.length > 0) {
        const delivery = record.deliveryQueue.shift()!;
        for (const subscriber of delivery.subscribers) {
          try {
            subscriber(cloneFrozen(delivery.event));
          } catch {
            // A broken client must not block the reducer or other subscribers.
          }
        }
      }
    } finally {
      record.delivering = false;
    }
  }

  private hasFollowUpOwnership(record: ReportRecord, ownership: FollowUpOwnership): boolean {
    return !isTerminalStatus(record.snapshot.status)
      && !ownership.signal.aborted
      && record.memory.latestTurnOrdinal === ownership.ordinal
      && record.latestFollowUpSignal === ownership.signal;
  }

  private reduce(record: ReportRecord, mutation: RegistryMutation): ReportJobSnapshot | undefined {
    const snapshot = record.snapshot;
    switch (mutation.type) {
      case 'internal.evidence': {
        const existing = record.evidence.get(mutation.evidence.snapshotId);
        if (existing) {
          if (equal(existing, mutation.evidence)) return undefined;
          throw new Error('REPORT_EVIDENCE_IMMUTABLE');
        }
        record.evidence.set(mutation.evidence.snapshotId, cloneFrozen(mutation.evidence));
        this.pruneEvidence(record, mutation.evidence.snapshotId);
        return { ...snapshot, scope: mutation.evidence.analysis?.scope ?? snapshot.scope };
      }
      case 'internal.outline-evidence': {
        const existing = record.evidence.get(mutation.evidence.snapshotId);
        if (existing && !equal(existing, mutation.evidence)) throw new Error('REPORT_EVIDENCE_IMMUTABLE');
        if (
          mutation.slideIds.length === 0
          || new Set(mutation.slideIds).size !== mutation.slideIds.length
          || mutation.slideIds.some((slideId) => !mutation.outline.some(({ id }) => id === slideId))
        ) throw new Error('REPORT_EVIDENCE_BINDING_INVALID');
        const correctionIntent = mutation.correctionSupersession;
        if (correctionIntent) {
          const sourceSlide = snapshot.slides.find(({ id }) => id === correctionIntent.sourceSlideId);
          const correctionOutline = mutation.outline.find(({ id }) => id === correctionIntent.correctionSlideId);
          if (
            correctionIntent.followUpOrdinal !== record.memory.latestTurnOrdinal
            || !mutation.slideIds.includes(correctionIntent.correctionSlideId)
            || correctionIntent.correctionEvidenceSnapshotId !== mutation.evidence.snapshotId
            || !sourceSlide
            || sourceSlide.evidenceSnapshotId !== correctionIntent.sourceEvidenceSnapshotId
            || sourceSlide.supersededBySlideId !== undefined
            || !correctionOutline
            || correctionOutline.order <= sourceSlide.order
            || !correctionEvidenceForIntent(mutation.evidence, correctionIntent)
          ) throw new Error('REPORT_CORRECTION_BINDING_INVALID');
        }
        const next = this.reduce(record, mutation.mergeSlideId
          ? { type: 'internal.merge-outline', slideId: mutation.mergeSlideId, outline: mutation.outline }
          : { type: 'report.outline', outline: mutation.outline });
        if (!next) return undefined;
        if (!existing) record.evidence.set(mutation.evidence.snapshotId, cloneFrozen(mutation.evidence));
        for (const slideId of mutation.slideIds) {
          record.evidenceSnapshotBySlideId.set(slideId, mutation.evidence.snapshotId);
          record.correctionSupersessionBySlideId.delete(slideId);
        }
        if (correctionIntent) {
          record.correctionSupersessionBySlideId.set(
            correctionIntent.correctionSlideId,
            cloneFrozen(correctionIntent),
          );
        }
        this.pruneEvidence(record, mutation.evidence.snapshotId, true);
        return { ...next, scope: mutation.evidence.analysis?.scope ?? next.scope };
      }
      case 'report.state-changed':
        return snapshot.status === mutation.status
          && snapshot.phase === mutation.phase
          && equal(snapshot.clarification, mutation.clarification)
          ? undefined
          : { ...snapshot, status: mutation.status, phase: mutation.phase, clarification: mutation.clarification };
      case 'report.clarification-required':
        return snapshot.status === 'awaiting-clarification'
          && equal(snapshot.clarification, mutation.clarification)
          ? snapshot
          : undefined;
      case 'report.outline': {
        assertOutlineShape(mutation.outline);
        for (let index = 0; index < snapshot.outline.length; index += 1) {
          const current = snapshot.outline[index];
          const incoming = mutation.outline[index];
          if (!current || !incoming || !equal(outlineMetadata(current), outlineMetadata(incoming))) {
            throw new Error('REPORT_OUTLINE_IMMUTABLE');
          }
        }
        const normalized = mutation.outline.map((item, index) => snapshot.outline[index] ?? item);
        if (equal(snapshot.outline, normalized)) return undefined;
        return {
          ...snapshot,
          status: 'generating',
          phase: snapshot.phase === null || snapshot.phase === 'completed' ? 'generating-slides' : snapshot.phase,
          clarification: null,
          outline: normalized,
        };
      }
      case 'slide.generating': {
        const current = snapshot.outline.find(({ id }) => id === mutation.slideId);
        if (!current) throw new Error('REPORT_SLIDE_NOT_FOUND');
        if (current.status === 'ready' || current.status === 'generating') return undefined;
        return {
          ...snapshot,
          status: 'generating',
          phase: snapshot.phase === null || snapshot.phase === 'completed' ? 'generating-slides' : snapshot.phase,
          clarification: null,
          outline: snapshot.outline.map((item) => item.id === mutation.slideId
            ? { ...withoutRetryable(item), status: 'generating' }
            : item),
        };
      }
      case 'slide.ready': {
        const boundSnapshotId = record.evidenceSnapshotBySlideId.get(mutation.slide.id);
        if (boundSnapshotId === undefined) {
          // Legacy/manual publishers do not own the generator transaction. The ready page still
          // records an exact binding; retries never infer one from a sibling page.
          record.evidenceSnapshotBySlideId.set(mutation.slide.id, mutation.slide.evidenceSnapshotId);
        } else if (boundSnapshotId !== mutation.slide.evidenceSnapshotId) {
          throw new Error('REPORT_EVIDENCE_BINDING_INVALID');
        }
        const existing = snapshot.slides.find(({ id }) => id === mutation.slide.id);
        if (existing) {
          if (equal(existing, mutation.slide)) return undefined;
          const { supersededBySlideId: _existingSuperseded, ...existingContent } = existing;
          const { supersededBySlideId, ...incomingContent } = mutation.slide;
          const supersessionTarget = supersededBySlideId === undefined
            ? undefined
            : snapshot.slides.find(({ id }) => id === supersededBySlideId);
          if (
            existing.supersededBySlideId !== undefined
            || supersededBySlideId === undefined
            || !supersessionTarget
            || supersessionTarget.order <= existing.order
            || !equal(existingContent, incomingContent)
          ) throw new Error('REPORT_SLIDE_IMMUTABLE');
          return {
            ...snapshot,
            slides: snapshot.slides.map((item) => item.id === mutation.slide.id
              ? cloneFrozen(mutation.slide)
              : item),
          };
        }
        const outline = snapshot.outline.find(({ id }) => id === mutation.slide.id);
        if (!outline) throw new Error('REPORT_SLIDE_NOT_FOUND');
        if (outline.order !== mutation.slide.order) throw new Error('REPORT_SLIDE_IMMUTABLE');
        const correctionIntent = record.correctionSupersessionBySlideId.get(mutation.slide.id);
        const correctionEvidence = correctionIntent
          ? record.evidence.get(mutation.slide.evidenceSnapshotId)
          : undefined;
        const correctionSource = correctionIntent
          ? snapshot.slides.find(({ id }) => id === correctionIntent.sourceSlideId)
          : undefined;
        if (correctionIntent && (
          correctionIntent.followUpOrdinal !== record.memory.latestTurnOrdinal
          || !correctionEvidence
          || !correctionSource
          || correctionSource.evidenceSnapshotId !== correctionIntent.sourceEvidenceSnapshotId
          || correctionSource.order >= mutation.slide.order
          || correctionSource.supersededBySlideId !== undefined
          || !slideBindsCorrectionIntent(mutation.slide, correctionEvidence, correctionIntent)
        )) throw new Error('REPORT_CORRECTION_BINDING_INVALID');
        if (correctionIntent && correctionEvidence) {
          const correction = correctionEvidenceForIntent(correctionEvidence, correctionIntent)!;
          record.memory = applyUserCorrection(record.memory, {
            evidenceSnapshotId: correctionEvidence.snapshotId,
            evidenceKey: correction.evidenceKey,
            value: correction.value,
            unit: correction.unit,
            statement: correction.statement,
            createdAt: correction.createdAt,
          });
          record.memory = updateConversationCursor(record.memory, { activeSlideId: mutation.slide.id });
          record.correctionSupersessionBySlideId.delete(mutation.slide.id);
        } else if (!record.memory.activeSlideId && mutation.slide.order === 0) {
          record.memory = updateConversationCursor(record.memory, { activeSlideId: mutation.slide.id });
        }
        const nextSlides = [...snapshot.slides, cloneFrozen(mutation.slide)].map((slide) => (
          correctionIntent && slide.id === correctionIntent.sourceSlideId
            ? cloneFrozen({ ...slide, supersededBySlideId: mutation.slide.id })
            : slide
        )).sort((a, b) => a.order - b.order);
        return {
          ...snapshot,
          status: 'generating',
          phase: snapshot.phase === null || snapshot.phase === 'completed' ? 'generating-slides' : snapshot.phase,
          clarification: null,
          outline: snapshot.outline.map((item) => item.id === mutation.slide.id
            ? { ...withoutRetryable(item), status: 'ready' }
            : item),
          slides: nextSlides,
          conversation: publicConversationSnapshot(record.memory),
        };
      }
      case 'slide.failed': {
        const current = snapshot.outline.find(({ id }) => id === mutation.slideId);
        if (!current) throw new Error('REPORT_SLIDE_NOT_FOUND');
        if (current.status === 'ready') return undefined;
        if (current.status === 'failed' && current.retryable === mutation.retryable) return undefined;
        if (!mutation.retryable) record.correctionSupersessionBySlideId.delete(mutation.slideId);
        return {
          ...snapshot,
          outline: snapshot.outline.map((item) => item.id === mutation.slideId
            ? { ...item, status: 'failed', retryable: mutation.retryable }
            : item),
        };
      }
      case 'internal.retry-slide': {
        const current = snapshot.outline.find(({ id }) => id === mutation.slideId);
        if (!current || current.status !== 'failed' || current.retryable !== true) return undefined;
        return {
          ...snapshot,
          status: 'generating',
          phase: 'generating-slides',
          clarification: null,
          outline: snapshot.outline.map((item) => item.id === mutation.slideId
            ? { ...withoutRetryable(item), status: 'planned' }
            : item),
        };
      }
      case 'internal.merge-outline': {
        assertOutlineShape(mutation.outline);
        if (mutation.outline.length !== snapshot.outline.length) throw new Error('REPORT_OUTLINE_IMMUTABLE');
        const target = snapshot.outline.find(({ id }) => id === mutation.slideId);
        if (!target || (target.status !== 'planned' && target.status !== 'failed')) {
          throw new Error('REPORT_OUTLINE_IMMUTABLE');
        }
        const normalized = mutation.outline.map((incoming, index) => {
          const current = snapshot.outline[index];
          if (!current || current.id !== incoming.id || current.order !== incoming.order) {
            throw new Error('REPORT_OUTLINE_IMMUTABLE');
          }
          if (current.id !== mutation.slideId && !equal(current, incoming)) {
            throw new Error('REPORT_OUTLINE_IMMUTABLE');
          }
          return current.id === mutation.slideId
            ? { ...withoutRetryable(incoming), status: 'planned' as const }
            : current;
        });
        if (equal(snapshot.outline, normalized)) return undefined;
        return {
          ...snapshot,
          status: 'generating',
          phase: snapshot.phase === null || snapshot.phase === 'completed' ? 'generating-slides' : snapshot.phase,
          clarification: null,
          outline: normalized,
        };
      }
      case 'report.completed': {
        const last = record.events.at(-1);
        if (last?.type === 'report.completed' && last.status === mutation.status) return undefined;
        return { ...snapshot, status: mutation.status, phase: 'completed', clarification: null };
      }
      case 'report.failed': {
        const last = record.events.at(-1);
        if (snapshot.status === 'failed' && last?.type === 'report.failed' && last.code === mutation.code) return undefined;
        return { ...snapshot, status: 'failed', phase: null, clarification: null };
      }
      case 'internal.session': {
        const { activeSlideId, narrationCursor } = mutation.update;
        const activeSlide = activeSlideId === undefined ? undefined : snapshot.slides.find(({ id }) => id === activeSlideId);
        if (activeSlideId !== undefined && !activeSlide) return undefined;
        const effectiveActiveSlideId = activeSlideId ?? snapshot.conversation.activeSlideId;
        const activeSlideChanged = activeSlideId !== undefined
          && activeSlideId !== snapshot.conversation.activeSlideId;
        const effectiveCursor = narrationCursor ?? (activeSlideChanged ? undefined : snapshot.conversation.narrationCursor);
        if (effectiveCursor) {
          const cursorSlide = snapshot.slides.find(({ id }) => id === effectiveCursor.slideId);
          if (
            !cursorSlide
            || effectiveCursor.slideId !== effectiveActiveSlideId
            || !cursorSlide.narration.some(({ id }) => id === effectiveCursor.segmentId)
          ) return undefined;
        }
        if (activeSlideId === undefined && narrationCursor === undefined) return snapshot;
        const memory = updateConversationCursor(record.memory, {
          ...(activeSlideId === undefined ? {} : { activeSlideId }),
          ...(effectiveCursor === undefined ? {} : { narrationCursor: effectiveCursor }),
        });
        const conversation = publicConversationSnapshot(memory);
        if (equal(snapshot.conversation, conversation)) return snapshot;
        record.memory = memory;
        return { ...snapshot, conversation };
      }
      case 'internal.accept-clarification': {
        const clarification = snapshot.clarification;
        if (
          snapshot.status !== 'awaiting-clarification'
          || !clarification
          || clarification.clarificationId !== mutation.clarificationId
        ) return undefined;
        record.memory = appendClarificationAnswer(record.memory, clarification, mutation.answer);
        return {
          ...snapshot,
          status: 'generating',
          phase: 'understanding',
          clarification: null,
          conversation: publicConversationSnapshot(record.memory),
        };
      }
      case 'report.cancelled':
        return snapshot.status === 'cancelled'
          ? undefined
          : { ...snapshot, status: 'cancelled', phase: null, clarification: null };
    }
  }

  private pruneEvidence(record: ReportRecord, keepSnapshotId?: string, removeAllUnreferenced = false): void {
    const limit = REPORT_MAX_SLIDES + 1;
    const referenced = new Set([
      ...record.evidenceSnapshotBySlideId.values(),
      ...record.snapshot.slides.map(({ evidenceSnapshotId }) => evidenceSnapshotId),
      ...(keepSnapshotId ? [keepSnapshotId] : []),
    ]);
    for (const snapshotId of record.evidence.keys()) {
      if (!removeAllUnreferenced && record.evidence.size <= limit) break;
      if (!referenced.has(snapshotId)) record.evidence.delete(snapshotId);
    }
  }

  private activeRecord(reportId: string, touch: boolean): ReportRecord | undefined {
    const now = this.now();
    const record = this.entries.get(reportId);
    if (!record) return undefined;
    if (this.isExpired(record, now)) {
      this.remove(reportId, record);
      return undefined;
    }
    if (touch) this.touch(record, now);
    return record;
  }

  private touch(record: ReportRecord, now: number): void {
    record.lastActiveAtMs = now;
    const expiresAtMs = Math.min(now + this.slidingTtlMs, record.absoluteExpiresAtMs);
    record.snapshot = cloneFrozen({ ...record.snapshot, expiresAt: new Date(expiresAtMs).toISOString() });
  }

  private isExpired(record: ReportRecord, now: number): boolean {
    if (now > record.absoluteExpiresAtMs) return true;
    return activityCount(record) === 0 && now > record.lastActiveAtMs + this.slidingTtlMs;
  }

  private evictOldestInactive(): void {
    let candidate: [string, ReportRecord] | undefined;
    for (const entry of this.entries) {
      if (activityCount(entry[1]) !== 0) continue;
      if (!candidate || entry[1].createdAtMs < candidate[1].createdAtMs) candidate = entry;
    }
    if (candidate) this.remove(candidate[0], candidate[1]);
  }

  private remove(reportId: string, record: ReportRecord): void {
    this.cleanup(record, reportId);
    record.idempotency.clear();
    this.entries.delete(reportId);
    this.notifyOwnershipLoss(reportId, record);
  }

  private notifyOwnershipLoss(reportId: string, record: ReportRecord): void {
    if (record.ownershipLossNotified) return;
    record.ownershipLossNotified = true;
    for (const subscriber of [...this.ownershipLossSubscribers]) {
      try {
        subscriber(reportId);
      } catch {
        // A lifecycle observer must not block registry cleanup or other observers.
      }
    }
  }

  private cleanup(record: ReportRecord, reportId: string): void {
    for (const controller of record.abortControllers) controller.abort();
    record.abortControllers.clear();
    record.latestFollowUpSignal = undefined;
    record.activities = { generation: 0, sse: 0, narration: 0, 'follow-up': 0 };
    record.subscribers.clear();
    record.idempotency.clear();
    if (!record.speechRemoved) {
      record.speechRemoved = true;
      this.removeSpeechForReport(reportId);
    }
  }

  private allocateId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const reportId = this.createId();
      if (!this.entries.has(reportId)) return reportId;
    }
    throw new Error('REPORT_ID_COLLISION');
  }
}
