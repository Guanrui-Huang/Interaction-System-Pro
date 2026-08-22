import type {
  AnalysisModule,
} from '../../../shared/ai';
import type {
  ConversationSnapshot,
  ConversationTurn,
  ClarificationRequest,
  ReportSlide,
  NarrationCursor,
} from '../../../shared/report';
import { redactAnalysisText } from './analysis-evidence';
import type { ReportEvidenceBundle } from './report-evidence';

export type ConfirmedFact = {
  evidenceSnapshotId: string;
  evidenceKey: string;
  value: number;
  unit: string;
  dateRange: { from: string; to: string };
  sampleCount: number;
  formula?: 'difference' | 'percent-change' | 'share';
};

export type UserCorrection = {
  evidenceSnapshotId?: string;
  evidenceKey: string;
  value: number;
  unit: string;
  statement: string;
  createdAt: string;
};

export type IntentTarget =
  | { kind: 'evidence'; key: string }
  | { kind: 'module'; key: AnalysisModule };

export type IntentCorrection = {
  from: IntentTarget;
  to: IntentTarget;
  statement: string;
  createdAt: string;
};

export type ConversationMemory = {
  originalQuestion: string;
  turns: ConversationTurn[];
  compactSummary: string;
  activeSlideId?: string;
  narrationCursor?: NarrationCursor;
  factLedger: ConfirmedFact[];
  userCorrections: UserCorrection[];
  intentCorrections: IntentCorrection[];
  unresolvedIntents: string[];
  clarifications: Array<{
    clarificationId: string;
    prompt: string;
    answer: string;
  }>;
  latestTurnOrdinal: number;
};

export type FollowUpContext = {
  originalQuestion: string;
  activeSlideId: string;
  currentEvidenceSnapshotId: string;
  interruptedSegmentId?: string;
  narrationOffsetMs?: number;
  currentSlide: {
    id: string;
    title: string;
    takeaway: string;
    evidenceRefs: Array<Omit<ReportSlide['evidenceRefs'][number], 'snapshotId'>>;
    metrics: Array<Omit<ReportSlide['metrics'][number], 'snapshotId'>>;
    narration: Array<{ id: string; text: string }>;
  };
  previousTurn?: ConversationTurn;
  recentTurns: ConversationTurn[];
  compactSummary: string;
  factLedger: ConfirmedFact[];
  userCorrections: UserCorrection[];
  intentCorrections: IntentCorrection[];
  unresolvedIntents: string[];
  evidence: unknown;
};

type CreateMemoryInput = {
  originalQuestion: string;
  evidenceSnapshotId?: string;
  turns?: ConversationTurn[];
  compactSummary?: string;
  activeSlideId?: string;
  narrationCursor?: NarrationCursor;
  factLedger?: ConfirmedFact[];
  userCorrections?: UserCorrection[];
  intentCorrections?: IntentCorrection[];
  unresolvedIntents?: string[];
  clarifications?: ConversationMemory['clarifications'];
  latestTurnOrdinal?: number;
};

const RECENT_TURN_COUNT = 6;
const COMPACTION_THRESHOLD = 12;
const SUMMARY_CHARACTER_LIMIT = 8_000;

function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (nested: unknown, seen = new WeakSet<object>()): void => {
    if (!nested || typeof nested !== 'object' || seen.has(nested)) return;
    seen.add(nested);
    for (const value of Object.values(nested)) freeze(value, seen);
    Object.freeze(nested);
  };
  freeze(copy);
  return copy;
}

function safeText(value: string): string {
  return redactAnalysisText(value).slice(0, SUMMARY_CHARACTER_LIMIT);
}

function safeTurn(turn: ConversationTurn): ConversationTurn {
  return {
    ...turn,
    question: safeText(turn.question),
    answer: safeText(turn.answer),
  };
}

export function createConversationMemory(input: CreateMemoryInput): ConversationMemory {
  return frozenCopy({
    originalQuestion: input.originalQuestion,
    turns: input.turns ?? [],
    compactSummary: input.compactSummary ?? '',
    ...(input.activeSlideId === undefined ? {} : { activeSlideId: input.activeSlideId }),
    ...(input.narrationCursor === undefined ? {} : { narrationCursor: input.narrationCursor }),
    factLedger: input.factLedger ?? [],
    userCorrections: input.userCorrections ?? [],
    intentCorrections: input.intentCorrections ?? [],
    unresolvedIntents: input.unresolvedIntents ?? [],
    clarifications: input.clarifications ?? [],
    latestTurnOrdinal: input.latestTurnOrdinal ?? 0,
  });
}

export function appendClarificationAnswer(
  memory: ConversationMemory,
  clarification: ClarificationRequest,
  answer: string,
): ConversationMemory {
  return createConversationMemory({
    ...memory,
    compactSummary: safeText([
      memory.compactSummary,
      `澄清问题：${clarification.prompt}`,
      `用户回答：${answer}`,
    ].filter(Boolean).join('\n')),
    unresolvedIntents: memory.unresolvedIntents.filter((intent) => intent !== clarification.prompt),
    clarifications: [
      ...memory.clarifications,
      { clarificationId: clarification.clarificationId, prompt: clarification.prompt, answer },
    ],
  });
}

export function appendConversationTurn(
  memory: ConversationMemory,
  turn: ConversationTurn,
  options: {
    facts?: ConfirmedFact[];
    correction?: UserCorrection;
    intentCorrection?: IntentCorrection;
    unresolvedIntents?: string[];
  } = {},
): ConversationMemory {
  const mergedFacts = [...memory.factLedger];
  for (const fact of options.facts ?? []) {
    const index = mergedFacts.findIndex(({ evidenceKey, evidenceSnapshotId }) => (
      evidenceKey === fact.evidenceKey && evidenceSnapshotId === fact.evidenceSnapshotId
    ));
    if (index === -1) mergedFacts.push(fact);
    else mergedFacts[index] = fact;
  }
  for (const correction of memory.userCorrections) {
    if (correction.evidenceSnapshotId === undefined) continue;
    const index = mergedFacts.findIndex(({ evidenceKey, evidenceSnapshotId }) => (
      evidenceKey === correction.evidenceKey
      && correction.evidenceSnapshotId === evidenceSnapshotId
    ));
    if (index !== -1) {
      mergedFacts[index] = {
        ...mergedFacts[index]!,
        value: correction.value,
        unit: correction.unit,
      };
    }
  }
  let next = createConversationMemory({
    ...memory,
    turns: [...memory.turns, turn],
    factLedger: mergedFacts,
    unresolvedIntents: options.unresolvedIntents ?? memory.unresolvedIntents,
  });
  if (options.correction) next = applyUserCorrection(next, options.correction);
  if (options.intentCorrection) next = applyIntentCorrection(next, options.intentCorrection);
  return next;
}

export function applyIntentCorrection(
  memory: ConversationMemory,
  correction: IntentCorrection,
): ConversationMemory {
  return createConversationMemory({
    ...memory,
    intentCorrections: [
      ...memory.intentCorrections.filter(({ from }) => (
        from.kind !== correction.from.kind || from.key !== correction.from.key
      )),
      correction,
    ],
  });
}

export function applyUserCorrection(
  memory: ConversationMemory,
  correction: UserCorrection,
): ConversationMemory {
  const correctedFacts = memory.factLedger.map((existing) => (
    correction.evidenceSnapshotId !== undefined
    && existing.evidenceKey === correction.evidenceKey
    && correction.evidenceSnapshotId === existing.evidenceSnapshotId
  )
    ? { ...existing, value: correction.value, unit: correction.unit }
    : existing);
  const userCorrections = [
    ...memory.userCorrections.filter((existing) => !(
      existing.evidenceKey === correction.evidenceKey
      && existing.evidenceSnapshotId === correction.evidenceSnapshotId
    )),
    correction,
  ];
  return createConversationMemory({
    ...memory,
    factLedger: correctedFacts,
    userCorrections,
  });
}

export function compactConversation(memory: ConversationMemory): ConversationMemory {
  if (memory.turns.length <= COMPACTION_THRESHOLD) return createConversationMemory(memory);
  const compactedTurns = memory.turns.slice(0, -RECENT_TURN_COUNT);
  const compactedText = compactedTurns
    .map(({ question, answer }) => `用户：${safeText(question)}\n回答：${safeText(answer)}`)
    .join('\n');
  const compactSummary = safeText([
    memory.compactSummary,
    compactedText,
  ].filter(Boolean).join('\n'));
  return createConversationMemory({
    ...memory,
    turns: memory.turns.slice(-RECENT_TURN_COUNT),
    compactSummary,
  });
}

function safeContextValue(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(safeContextValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'snapshotId')
      .map(([key, nested]) => [key, safeContextValue(nested)]));
  }
  return value;
}

function withoutSnapshotId<T extends { snapshotId: string }>(value: T): Omit<T, 'snapshotId'> {
  const { snapshotId: _snapshotId, ...publicValue } = value;
  return publicValue;
}

function serverEvidenceForContext(bundle: ReportEvidenceBundle): unknown {
  return {
    ...(bundle.analysis ? { analysis: safeContextValue(bundle.analysis) } : {}),
    knowledge: safeContextValue(bundle.knowledge),
    ...(bundle.assistantProfile ? { assistantProfile: safeContextValue(bundle.assistantProfile) } : {}),
    ...(bundle.userCorrections?.length ? { userCorrections: safeContextValue(bundle.userCorrections) } : {}),
  };
}

export function buildFollowUpContext(
  memory: ConversationMemory,
  currentSlide: ReportSlide,
  evidenceBundle: ReportEvidenceBundle,
): FollowUpContext {
  const cursor = memory.narrationCursor?.slideId === currentSlide.id
    ? memory.narrationCursor
    : undefined;
  const recentTurns = memory.turns.slice(-RECENT_TURN_COUNT).map(safeTurn);
  return frozenCopy({
    originalQuestion: safeText(memory.originalQuestion),
    activeSlideId: currentSlide.id,
    currentEvidenceSnapshotId: currentSlide.evidenceSnapshotId,
    ...(cursor ? {
      interruptedSegmentId: cursor.segmentId,
      narrationOffsetMs: cursor.offsetMs,
    } : {}),
    currentSlide: {
      id: currentSlide.id,
      title: safeText(currentSlide.title),
      takeaway: safeText(currentSlide.takeaway),
      evidenceRefs: currentSlide.evidenceRefs.map(withoutSnapshotId),
      metrics: currentSlide.metrics.map(withoutSnapshotId),
      narration: currentSlide.narration.map(({ id, text }) => ({ id, text: safeText(text) })),
    },
    ...(recentTurns.at(-1) ? { previousTurn: recentTurns.at(-1) } : {}),
    recentTurns,
    compactSummary: safeText(memory.compactSummary),
    factLedger: memory.factLedger.filter(({ evidenceSnapshotId }) => (
      evidenceSnapshotId === currentSlide.evidenceSnapshotId
    )),
    userCorrections: [
      ...memory.userCorrections.filter(({ evidenceSnapshotId }) => (
        evidenceSnapshotId !== undefined && evidenceSnapshotId === currentSlide.evidenceSnapshotId
      )),
      ...(evidenceBundle.userCorrections ?? []).map((correction) => ({
        evidenceSnapshotId: currentSlide.evidenceSnapshotId,
        evidenceKey: correction.evidenceKey,
        value: correction.value,
        unit: correction.unit,
        statement: correction.statement,
        createdAt: correction.createdAt,
      })),
    ].filter((correction, index, corrections) => corrections.findIndex((candidate) => (
      candidate.evidenceSnapshotId === correction.evidenceSnapshotId
      && candidate.evidenceKey === correction.evidenceKey
      && candidate.value === correction.value
      && candidate.unit === correction.unit
    )) === index).map((correction) => ({
      ...correction,
      statement: safeText(correction.statement),
    })),
    intentCorrections: memory.intentCorrections.map((correction) => ({
      ...correction,
      statement: safeText(correction.statement),
    })),
    unresolvedIntents: memory.unresolvedIntents.map(safeText),
    evidence: serverEvidenceForContext(evidenceBundle),
  });
}

export function publicConversationSnapshot(memory: ConversationMemory): ConversationSnapshot {
  return frozenCopy({
    originalQuestion: memory.originalQuestion,
    turns: memory.turns,
    compactSummary: memory.compactSummary,
    ...(memory.activeSlideId === undefined ? {} : { activeSlideId: memory.activeSlideId }),
    ...(memory.narrationCursor === undefined ? {} : { narrationCursor: memory.narrationCursor }),
  });
}

export function updateConversationCursor(
  memory: ConversationMemory,
  update: { activeSlideId?: string; narrationCursor?: NarrationCursor },
): ConversationMemory {
  const activeSlideChanged = update.activeSlideId !== undefined
    && update.activeSlideId !== memory.activeSlideId;
  return createConversationMemory({
    ...memory,
    ...(update.activeSlideId === undefined ? {} : { activeSlideId: update.activeSlideId }),
    narrationCursor: update.narrationCursor ?? (activeSlideChanged ? undefined : memory.narrationCursor),
  });
}
