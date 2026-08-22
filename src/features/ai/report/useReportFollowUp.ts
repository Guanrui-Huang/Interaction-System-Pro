import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConversationSnapshot,
  ConversationTurn,
  FollowUpRequest,
  FollowUpResponse,
  NarrationCursor,
} from '../../../../shared/report';
import { createIdempotencyKey as defaultCreateIdempotencyKey, followUpReport, toReportClientError } from './report-api';
import type { FollowUpPlaybackResult } from './useNarrationController';

export type ReportFollowUpNarration = {
  beginInterruption(mode: 'listening' | 'typing'): NarrationCursor;
  playFollowUpAnswer(speechId: string): Promise<FollowUpPlaybackResult>;
  resumeAfterAnswer(cursor: NarrationCursor): Promise<void>;
};

export type UseReportFollowUpInput = {
  reportId: string;
  conversation: ConversationSnapshot;
  narration: ReportFollowUpNarration;
  followUp?: typeof followUpReport;
  createIdempotencyKey?: typeof defaultCreateIdempotencyKey;
  now?: () => number;
};

type Intent = { question: string; cursor: NarrationCursor; key: string };

const elapsedMs = (start: number, end: number) => Math.max(0, Math.round(end - start));

export function useReportFollowUp(input: UseReportFollowUpInput) {
  const inputRef = useRef(input);
  inputRef.current = input;
  const [history, setHistory] = useState<ConversationTurn[]>(input.conversation.turns);
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null);
  const [activeThinkingStartedAtMs, setActiveThinkingStartedAtMs] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [failedThinkingDurationMs, setFailedThinkingDurationMs] = useState<number | null>(null);
  const [speechFailedCursor, setSpeechFailedCursor] = useState<NarrationCursor | null>(null);
  const cursorRef = useRef<NarrationCursor | null>(input.conversation.narrationCursor ?? null);
  const interruptionRef = useRef<NarrationCursor | null>(null);
  const intentRef = useRef<Intent | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const reportIdRef = useRef(input.reportId);

  useEffect(() => {
    if (reportIdRef.current !== input.reportId) {
      reportIdRef.current = input.reportId;
      generationRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      intentRef.current = null;
      interruptionRef.current = null;
      cursorRef.current = input.conversation.narrationCursor ?? null;
      setActiveQuestion(null);
      setActiveThinkingStartedAtMs(null);
      setPending(false);
      setError(null);
      setFailedThinkingDurationMs(null);
      setSpeechFailedCursor(null);
      setHistory(input.conversation.turns);
    } else {
      setHistory((current) => {
        const localById = new Map(current.map((turn) => [turn.id, turn]));
        const authoritative = input.conversation.turns.map((turn) => ({
          ...turn,
          thinkingDurationMs: turn.thinkingDurationMs ?? localById.get(turn.id)?.thinkingDurationMs,
        }));
        const authoritativeIds = new Set(input.conversation.turns.map(({ id }) => id));
        return [
          ...authoritative,
          ...current.filter(({ id }) => !authoritativeIds.has(id)),
        ];
      });
    }
    if (input.conversation.narrationCursor) cursorRef.current = input.conversation.narrationCursor;
  }, [input.conversation.narrationCursor, input.conversation.turns, input.reportId]);

  const begin = useCallback((mode: 'listening' | 'typing') => {
    if (interruptionRef.current) return interruptionRef.current;
    const cursor = inputRef.current.narration.beginInterruption(mode);
    cursorRef.current = cursor;
    interruptionRef.current = cursor;
    setSpeechFailedCursor(null);
    return cursor;
  }, []);

  const runIntent = useCallback(async (intent: Intent): Promise<void> => {
    const readNow = () => inputRef.current.now?.() ?? globalThis.performance.now();
    const startedAt = readNow();
    setActiveThinkingStartedAtMs(startedAt);
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const generation = ++generationRef.current;
    intentRef.current = intent;
    setActiveQuestion(intent.question);
    setPending(true);
    setError(null);
    setFailedThinkingDurationMs(null);
    setSpeechFailedCursor(null);
    const request: FollowUpRequest = {
      question: intent.question,
      slideId: intent.cursor.slideId,
      interruptedSegmentId: intent.cursor.segmentId || undefined,
      narrationOffsetMs: intent.cursor.segmentId ? intent.cursor.offsetMs : undefined,
    };
    let response: FollowUpResponse;
    try {
      response = await (inputRef.current.followUp ?? followUpReport)(
        inputRef.current.reportId, request, intent.key, controller.signal,
      );
    } catch (caught) {
      if (!mountedRef.current || generation !== generationRef.current || controller.signal.aborted) return;
      setPending(false);
      setFailedThinkingDurationMs(elapsedMs(startedAt, readNow()));
      setActiveThinkingStartedAtMs(null);
      setError(toReportClientError(caught));
      return;
    }
    if (!mountedRef.current || generation !== generationRef.current || controller.signal.aborted) return;
    const turn: ConversationTurn = {
      id: response.turnId,
      question: intent.question,
      answer: response.answer,
      citedEvidence: response.citedEvidence,
      needsClarification: response.needsClarification,
      createdAt: new Date().toISOString(),
      thinkingDurationMs: elapsedMs(startedAt, readNow()),
    };
    setHistory((current) => [...current.filter(({ id }) => id !== turn.id), turn]);
    setActiveQuestion(null);
    setActiveThinkingStartedAtMs(null);
    setPending(false);
    setFailedThinkingDurationMs(null);
    const playback = await inputRef.current.narration.playFollowUpAnswer(response.speechId);
    if (!mountedRef.current || generation !== generationRef.current) return;
    if (playback === 'failed') {
      setSpeechFailedCursor(response.resumeCursor);
      return;
    }
    if (playback === 'ended') await inputRef.current.narration.resumeAfterAnswer(response.resumeCursor);
  }, []);

  const submit = useCallback((question: string, mode: 'typing' | 'listening', retryIntent?: Intent) => {
    const normalized = question.trim();
    if (!normalized) return Promise.resolve();
    const cursor = retryIntent?.cursor ?? cursorRef.current ?? begin(mode);
    const intent = retryIntent ?? {
      question: normalized,
      cursor,
      key: (inputRef.current.createIdempotencyKey ?? defaultCreateIdempotencyKey)(),
    };
    if (!retryIntent) interruptionRef.current = null;
    return runIntent(intent);
  }, [begin, runIntent]);

  const retry = useCallback(() => {
    const intent = intentRef.current;
    return intent ? submit(intent.question, 'typing', intent) : Promise.resolve();
  }, [submit]);

  const continueOriginal = useCallback(async () => {
    const cursor = speechFailedCursor;
    if (!cursor) return;
    setSpeechFailedCursor(null);
    await inputRef.current.narration.resumeAfterAnswer(cursor);
  }, [speechFailedCursor]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    intentRef.current = null;
    interruptionRef.current = null;
    setActiveQuestion(null);
    setActiveThinkingStartedAtMs(null);
    setPending(false);
    setFailedThinkingDurationMs(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      requestRef.current?.abort();
    };
  }, []);

  return {
    history,
    activeQuestion,
    activeThinkingStartedAtMs,
    pending,
    error,
    failedThinkingDurationMs,
    canContinueOriginal: Boolean(speechFailedCursor),
    startTyping: () => begin('typing'),
    startListening: () => begin('listening'),
    submitText: (question: string) => submit(question, 'typing'),
    submitRecognizedText: (question: string) => submit(question, 'listening'),
    continueOriginal,
    cancel,
    retry,
  };
}
