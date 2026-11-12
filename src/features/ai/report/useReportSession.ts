import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CreateReportRequest,
  NarrationCursor,
  ReportEvent,
  ReportJobSnapshot,
  UpdateReportSessionRequest,
} from '../../../../shared/report';
import {
  cancelReport,
  ReportClientError,
  restoreReport,
  retryReportSlide,
  startReport,
  submitReportClarification,
  toReportClientError,
  updateReportSession,
} from './report-api';
import { connectReportEvents, ReportEventStreamError, ReportEventStreamInterruptedError } from './report-event-stream';

export type ReportLaunch = CreateReportRequest & { token: string };
export type ReportSessionPhase = 'idle' | 'creating' | 'restoring' | 'connecting' | 'connected' | 'reconnecting' | 'ready' | 'error' | 'exited';
export type CursorBoundary = 'progress' | 'pause' | 'follow-up';

export type ReportSession = {
  snapshot: ReportJobSnapshot | null;
  phase: ReportSessionPhase;
  error: ReportClientError | null;
  selectSlide(slideId: string): void;
  setNarrationCursor(cursor: NarrationCursor, boundary?: CursorBoundary): void;
  retryConnection(): void;
  retrySlide(slideId: string): Promise<void>;
  submitClarification(clarificationId: string, answer: string): Promise<void>;
  exit(): void;
  playingSlideId?: string | null;
};

type UseReportSessionOptions = {
  launch?: ReportLaunch;
  reportId?: string;
  onExit?(): void;
};

type CreateLease = {
  promise: ReturnType<typeof startReport>;
  release(immediate?: boolean): void;
};

type CreateEntry = {
  controller: AbortController;
  promise: ReturnType<typeof startReport>;
  consumers: number;
  abortTimer?: ReturnType<typeof setTimeout>;
};

type SessionUpdateOptions = {
  keepalive?: boolean;
  surviveUnmount?: boolean;
};

const createEntries = new Map<string, CreateEntry>();
const RECONNECT_DELAYS = [250, 500, 1_000, 2_000, 4_000, 5_000] as const;

function terminalSnapshotError(status: ReportJobSnapshot['status']): ReportClientError | null {
  if (status === 'cancelled') return new ReportClientError('REPORT_CANCELLED');
  if (status === 'failed') return new ReportClientError('EMPTY_ANSWER');
  return null;
}

function acquireCreate(launch: ReportLaunch): CreateLease {
  let entry = createEntries.get(launch.token);
  if (!entry) {
    const controller = new AbortController();
    const promise = startReport({ question: launch.question, page: launch.page }, controller.signal);
    entry = { controller, promise, consumers: 0 };
    createEntries.set(launch.token, entry);
    const createdEntry = entry;
    void promise.catch(() => {
      if (createEntries.get(launch.token) === createdEntry) createEntries.delete(launch.token);
    });
  }
  entry.consumers += 1;
  if (entry.abortTimer) {
    clearTimeout(entry.abortTimer);
    entry.abortTimer = undefined;
  }
  let released = false;
  return {
    promise: entry.promise,
    release(immediate = false) {
      if (released) return;
      released = true;
      entry!.consumers = Math.max(0, entry!.consumers - 1);
      if (entry!.consumers !== 0) return;
      const dispose = () => {
        if (entry!.consumers !== 0) return;
        if (immediate) entry!.controller.abort();
        if (createEntries.get(launch.token) === entry) createEntries.delete(launch.token);
      };
      if (immediate) dispose();
      else entry!.abortTimer = setTimeout(() => {
        if (entry!.consumers === 0 && !entry!.controller.signal.aborted) entry!.controller.abort();
        if (createEntries.get(launch.token) === entry) createEntries.delete(launch.token);
      }, 0);
    },
  };
}

function withoutRetryable<T extends { retryable?: boolean }>(value: T): Omit<T, 'retryable'> {
  const { retryable: _retryable, ...rest } = value;
  return rest;
}

export function reduceReportEvent(snapshot: ReportJobSnapshot, event: ReportEvent): ReportJobSnapshot {
  if (event.sequence <= snapshot.lastSequence) return snapshot;
  let next: ReportJobSnapshot;
  switch (event.type) {
    case 'report.outline':
      next = { ...snapshot, status: 'generating', clarification: null, outline: event.outline };
      break;
    case 'report.state-changed':
      next = { ...snapshot, status: event.status, phase: event.phase, clarification: event.clarification };
      break;
    case 'report.clarification-required':
      next = { ...snapshot, status: 'awaiting-clarification', phase: null, clarification: event.clarification };
      break;
    case 'slide.generating':
      next = {
        ...snapshot,
        status: 'generating',
        clarification: null,
        outline: snapshot.outline.map((item) => item.id === event.slideId
          ? { ...withoutRetryable(item), status: 'generating' }
          : item),
      };
      break;
    case 'slide.ready':
      const replacingReadySlide = snapshot.slides.some(({ id }) => id === event.slide.id);
      next = {
        ...snapshot,
        status: replacingReadySlide ? snapshot.status : 'generating',
        clarification: null,
        outline: snapshot.outline.map((item) => item.id === event.slide.id
          ? { ...withoutRetryable(item), status: 'ready' }
          : item),
        slides: [...snapshot.slides.filter(({ id }) => id !== event.slide.id), event.slide]
          .sort((left, right) => left.order - right.order),
      };
      break;
    case 'slide.failed':
      next = {
        ...snapshot,
        outline: snapshot.outline.map((item) => item.id === event.slideId
          ? { ...item, status: 'failed', retryable: event.retryable }
          : item),
      };
      break;
    case 'report.completed':
      next = { ...snapshot, status: event.status, phase: 'completed', clarification: null };
      break;
    case 'report.failed':
      next = { ...snapshot, status: 'failed', phase: null, clarification: null };
      break;
    case 'report.cancelled':
      next = { ...snapshot, status: 'cancelled', phase: null, clarification: null };
      break;
  }
  return { ...next, lastSequence: event.sequence };
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
}

function replaceReportIdInUrl(reportId?: string): void {
  const url = new URL(window.location.href);
  if (reportId) url.searchParams.set('reportId', reportId);
  else url.searchParams.delete('reportId');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function useReportSession({ launch, reportId, onExit }: UseReportSessionOptions): ReportSession {
  const [snapshot, setSnapshot] = useState<ReportJobSnapshot | null>(null);
  const [phase, setPhase] = useState<ReportSessionPhase>(launch ? 'creating' : reportId ? 'restoring' : 'idle');
  const [error, setError] = useState<ReportClientError | null>(null);
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [loadRetryNonce, setLoadRetryNonce] = useState(0);
  const snapshotRef = useRef<ReportJobSnapshot | null>(null);
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const createLeaseRef = useRef<CreateLease | null>(null);
  const connectionAbortRef = useRef<AbortController | null>(null);
  const pendingCursorRef = useRef<NarrationCursor | null>(null);
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionControllersRef = useRef(new Set<AbortController>());
  const sessionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const exitedRef = useRef(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const installSnapshot = useCallback((next: ReportJobSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    if (!launch && !reportId) return;
    exitedRef.current = false;
    const generation = ++loadGenerationRef.current;
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setSnapshot(null);
    snapshotRef.current = null;
    setActiveReportId(null);
    setError(null);
    setPhase(launch ? 'creating' : 'restoring');
    const lease = launch ? acquireCreate(launch) : null;
    createLeaseRef.current = lease;
    const request = lease?.promise ?? restoreReport(reportId!, controller.signal);

    void request.then((result) => {
      const next = 'snapshot' in result ? result.snapshot : result;
      if (generation !== loadGenerationRef.current || controller.signal.aborted || exitedRef.current) return;
      installSnapshot(next);
      replaceReportIdInUrl(next.reportId);
      const terminalError = terminalSnapshotError(next.status);
      if (terminalError) {
        setError(terminalError);
        setPhase('error');
        return;
      }
      setActiveReportId(next.reportId);
      setPhase(['ready', 'partial'].includes(next.status) ? 'ready' : 'connecting');
    }).catch((caught: unknown) => {
      if (generation !== loadGenerationRef.current || controller.signal.aborted || isAbortError(caught) || exitedRef.current) return;
      setError(toReportClientError(caught));
      setPhase('error');
    });

    return () => {
      loadGenerationRef.current += 1;
      controller.abort();
      clarificationRequestRef.current?.abort();
      lease?.release();
      if (loadAbortRef.current === controller) loadAbortRef.current = null;
      if (createLeaseRef.current === lease) createLeaseRef.current = null;
    };
  }, [installSnapshot, launch?.page, launch?.question, launch?.token, loadRetryNonce, reportId]);

  useEffect(() => {
    if (!activeReportId) return;
    const controller = new AbortController();
    connectionAbortRef.current = controller;
    let attempt = 0;

    const connect = async () => {
      while (!controller.signal.aborted) {
        let receivedEvent = false;
        try {
          await connectReportEvents(activeReportId, snapshotRef.current?.lastSequence ?? 0, {
            signal: controller.signal,
            onOpen: () => setPhase(
              ['ready', 'partial'].includes(snapshotRef.current?.status ?? '') ? 'ready' : 'connected',
            ),
            onEvent: (event) => {
              receivedEvent = true;
              if (event.type === 'report.clarification-required'
                && snapshotRef.current?.clarification?.clarificationId !== event.clarification.clarificationId) {
                clarificationRequestRef.current?.abort();
              }
              setSnapshot((current) => {
                if (!current || current.reportId !== activeReportId) return current;
                const next = reduceReportEvent(current, event);
                snapshotRef.current = next;
                return next;
              });
              if (event.type === 'report.failed') {
                setError(new ReportClientError(event.code));
                setPhase('error');
                controller.abort();
              } else if (event.type === 'report.cancelled') {
                setError(new ReportClientError('REPORT_CANCELLED'));
                setPhase('error');
                controller.abort();
              } else if (event.type === 'report.completed') {
                setPhase('ready');
              }
            },
          });
        } catch (caught) {
          if (controller.signal.aborted || isAbortError(caught)) return;
          if (caught instanceof ReportEventStreamError && !(caught instanceof ReportEventStreamInterruptedError)) {
            setError(new ReportClientError('MALFORMED_RESPONSE'));
            setPhase('error');
            return;
          }
        }
        if (controller.signal.aborted) return;
        setPhase('reconnecting');
        try {
          const latest = await restoreReport(activeReportId, controller.signal);
          if (controller.signal.aborted) return;
          installSnapshot(latest);
          const terminalError = terminalSnapshotError(latest.status);
          if (terminalError) {
            setError(terminalError);
            setPhase('error');
            controller.abort();
            return;
          }
          if (['ready', 'partial'].includes(latest.status)) setPhase('ready');
        } catch (caught) {
          if (controller.signal.aborted || isAbortError(caught)) return;
          if (caught instanceof ReportClientError && caught.code !== 'UPSTREAM_HTTP' && caught.code !== 'REPORT_EVENT_GAP') {
            setError(caught);
            setPhase('error');
            return;
          }
        }
        if (receivedEvent) attempt = 0;
        const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
        attempt += 1;
        try {
          await abortableDelay(delay, controller.signal);
        } catch {
          return;
        }
      }
    };
    void connect();
    return () => {
      controller.abort();
      if (connectionAbortRef.current === controller) connectionAbortRef.current = null;
    };
  }, [activeReportId, installSnapshot, retryNonce]);

  const sendSessionUpdate = useCallback((
    update: UpdateReportSessionRequest,
    options: SessionUpdateOptions = {},
  ): Promise<void> | undefined => {
    const currentReportId = snapshotRef.current?.reportId;
    if (!currentReportId || exitedRef.current) return undefined;
    const controller = new AbortController();
    if (!options.surviveUnmount) sessionControllersRef.current.add(controller);
    const request = sessionQueueRef.current
      .catch(() => undefined)
      .then(() => updateReportSession(currentReportId, update, controller.signal, {
        keepalive: options.keepalive,
      }))
      .catch((caught: unknown) => {
        if (mountedRef.current && !controller.signal.aborted && caught instanceof ReportClientError
          && ['REPORT_NOT_FOUND', 'REPORT_EXPIRED', 'REPORT_CANCELLED'].includes(caught.code)) {
          setError(caught);
          setPhase('error');
        }
      })
      .finally(() => sessionControllersRef.current.delete(controller));
    sessionQueueRef.current = request;
    return request;
  }, []);

  const flushCursor = useCallback((options: SessionUpdateOptions = {}): Promise<void> | undefined => {
    if (cursorTimerRef.current) {
      clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
    }
    const cursor = pendingCursorRef.current;
    pendingCursorRef.current = null;
    return cursor ? sendSessionUpdate({ activity: 'narration', narrationCursor: cursor }, options) : undefined;
  }, [sendSessionUpdate]);

  const setNarrationCursor = useCallback((cursor: NarrationCursor, boundary: CursorBoundary = 'progress') => {
    pendingCursorRef.current = cursor;
    setSnapshot((current) => {
      if (!current) return current;
      const next = { ...current, conversation: { ...current.conversation, narrationCursor: cursor } };
      snapshotRef.current = next;
      return next;
    });
    if (boundary !== 'progress') {
      void flushCursor();
      return;
    }
    if (!cursorTimerRef.current) {
      cursorTimerRef.current = setTimeout(() => { void flushCursor(); }, 500);
    }
  }, [flushCursor]);

  const selectSlide = useCallback((slideId: string) => {
    void flushCursor();
    setSnapshot((current) => {
      if (!current) return current;
      const { narrationCursor: _cursor, ...conversation } = current.conversation;
      const next = { ...current, conversation: { ...conversation, activeSlideId: slideId } };
      snapshotRef.current = next;
      return next;
    });
    void sendSessionUpdate({ activity: 'page', activeSlideId: slideId });
  }, [flushCursor, sendSessionUpdate]);

  useEffect(() => {
    const flushOnPageHide = () => {
      void flushCursor({ keepalive: true, surviveUnmount: true });
    };
    window.addEventListener('pagehide', flushOnPageHide);
    return () => window.removeEventListener('pagehide', flushOnPageHide);
  }, [flushCursor]);

  const retryConnection = useCallback(() => {
    setError(null);
    if (!activeReportId) {
      loadAbortRef.current?.abort();
      createLeaseRef.current?.release(true);
      setPhase(launch ? 'creating' : 'restoring');
      setLoadRetryNonce((value) => value + 1);
      return;
    }
    connectionAbortRef.current?.abort();
    setPhase('connecting');
    setRetryNonce((value) => value + 1);
  }, [activeReportId, launch]);

  const retrySlide = useCallback(async (slideId: string): Promise<void> => {
    const current = snapshotRef.current;
    const item = current?.outline.find((candidate) => candidate.id === slideId);
    if (!current || item?.status !== 'failed' || item.retryable !== true || exitedRef.current) return;
    const controller = new AbortController();
    sessionControllersRef.current.add(controller);
    try {
      await retryReportSlide(current.reportId, slideId, controller.signal);
    } finally {
      sessionControllersRef.current.delete(controller);
    }
  }, []);

  const clarificationRequestRef = useRef<AbortController | null>(null);
  const clarificationGenerationRef = useRef(0);
  const submitClarification = useCallback(async (clarificationId: string, answer: string): Promise<void> => {
    const current = snapshotRef.current;
    if (!current || current.status !== 'awaiting-clarification' || current.clarification?.clarificationId !== clarificationId || exitedRef.current) return;
    clarificationRequestRef.current?.abort();
    const controller = new AbortController();
    clarificationRequestRef.current = controller;
    const generation = ++clarificationGenerationRef.current;
    try {
      await submitReportClarification(current.reportId, clarificationId, answer, controller.signal);
      const latest = snapshotRef.current;
      if (controller.signal.aborted
        || generation !== clarificationGenerationRef.current
        || latest?.reportId !== current.reportId
        || latest.status !== 'awaiting-clarification'
        || latest.clarification?.clarificationId !== clarificationId) return;
      setError(null);
      connectionAbortRef.current?.abort();
      setPhase('connecting');
      setRetryNonce((value) => value + 1);
    } catch (caught) {
      const latest = snapshotRef.current;
      if (controller.signal.aborted
        || generation !== clarificationGenerationRef.current
        || exitedRef.current
        || latest?.reportId !== current.reportId
        || latest.status !== 'awaiting-clarification'
        || latest.clarification?.clarificationId !== clarificationId) return;
      throw caught;
    } finally {
      if (clarificationRequestRef.current === controller) clarificationRequestRef.current = null;
    }
  }, []);

  const exit = useCallback(() => {
    if (exitedRef.current) return;
    loadGenerationRef.current += 1;
    loadAbortRef.current?.abort();
    createLeaseRef.current?.release(true);
    connectionAbortRef.current?.abort();
    clarificationRequestRef.current?.abort();
    const currentReportId = snapshotRef.current?.reportId;
    const flushed = flushCursor();
    exitedRef.current = true;
    const cancel = () => {
      if (!currentReportId) return;
      const controller = new AbortController();
      void cancelReport(currentReportId, controller.signal).catch(() => undefined);
    };
    if (flushed) void flushed.finally(cancel);
    else cancel();
    replaceReportIdInUrl();
    setPhase('exited');
    onExitRef.current?.();
  }, [flushCursor]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
      connectionAbortRef.current?.abort();
      clarificationRequestRef.current?.abort();
      for (const controller of sessionControllersRef.current) controller.abort();
    };
  }, []);

  return { snapshot, phase, error, selectSlide, setNarrationCursor, retryConnection, retrySlide, submitClarification, exit };
}
