import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NarrationCursor,
  ReportSlide,
  SlideOutline,
} from '../../../../shared/report';
import {
  createAudioSegmentPlayer,
  type AudioSegmentPlayer,
} from '../voice/audio-segment-player';
import { NarrationAudioCache } from './narration-audio-cache';
import { finalReplacementFor, playableReportSlides } from './report-playback';

const AUDIO_FALLBACK_MESSAGE = '语音未播放：讲解音频暂时无法播放，请阅读字幕或点击“播放讲解”重试';

export type NarrationStatus =
  | 'preparing'
  | 'speaking'
  | 'paused'
  | 'interrupting'
  | 'listening'
  | 'typing'
  | 'answering'
  | 'resuming'
  | 'completed'
  | 'error';

export type FollowUpPlaybackResult = 'ended' | 'cancelled' | 'failed';

export type UseNarrationControllerInput = {
  reportId: string;
  slides: ReportSlide[];
  outline: SlideOutline[];
  activeSlideId?: string;
  initialCursor?: NarrationCursor;
  selectSlide(slideId: string): void;
  setNarrationCursor(cursor: NarrationCursor, boundary?: 'progress' | 'pause' | 'follow-up'): void;
  autoplay?: boolean;
  cache?: NarrationAudioCache;
  createPlayer?: () => AudioSegmentPlayer;
};

export type NarrationController = {
  status: NarrationStatus;
  canNarrate?: boolean;
  activeSlideId?: string;
  subtitle: string;
  message: string;
  error: string | null;
  play(): Promise<void>;
  pause(): Promise<void>;
  replaySlide(): Promise<void>;
  goToSlide(slideId: string): Promise<void>;
  beginInterruption(mode: 'listening' | 'typing'): NarrationCursor;
  playFollowUpAnswer(speechId: string): Promise<FollowUpPlaybackResult>;
  resumeAfterAnswer(cursor: NarrationCursor): Promise<void>;
  stop(): Promise<void>;
};

type ActivePlayback = {
  player: AudioSegmentPlayer;
  speechId: string;
  unsubscribe: () => void;
  kind: 'narration' | 'answer';
  operation: number;
  ended: boolean;
  settle?: (result: FollowUpPlaybackResult) => void;
};

function sortedSlides(slides: readonly ReportSlide[]): ReportSlide[] {
  return [...slides].sort((left, right) => left.order - right.order);
}

function sortedOutline(outline: readonly SlideOutline[]): SlideOutline[] {
  return [...outline].sort((left, right) => left.order - right.order);
}

function nextNarrationItem(
  input: Pick<UseNarrationControllerInput, 'slides' | 'outline'>,
  currentSlideId: string,
): SlideOutline | undefined {
  const outline = sortedOutline(input.outline);
  const itemIndex = outline.findIndex(({ id }) => id === currentSlideId);
  return outline.slice(itemIndex + 1).find((item) => {
    if (item.status === 'failed') return false;
    if (item.status !== 'ready') return true;
    const slide = input.slides.find(({ id }) => id === item.id);
    return !slide || slide.supersededBySlideId === undefined;
  });
}

function playableCursor(
  input: Pick<UseNarrationControllerInput, 'slides'>,
  cursor: NarrationCursor | undefined,
): NarrationCursor | undefined {
  if (!cursor) return undefined;
  const slide = finalReplacementFor(input.slides, cursor.slideId);
  if (!slide) return undefined;
  if (slide.id === cursor.slideId && slide.narration.some(({ id }) => id === cursor.segmentId)) return cursor;
  const segment = slide.narration[0];
  return segment ? { slideId: slide.id, segmentId: segment.id, offsetMs: 0 } : undefined;
}

function firstCursor(input: UseNarrationControllerInput): NarrationCursor | undefined {
  const slides = sortedSlides(input.slides);
  const requested = playableCursor(input, input.initialCursor);
  if (requested) return requested;
  const slide = finalReplacementFor(slides, input.activeSlideId)
    ?? playableReportSlides(slides)[0];
  const segment = slide?.narration[0];
  return slide && segment ? { slideId: slide.id, segmentId: segment.id, offsetMs: 0 } : undefined;
}

function isAutoplayPolicyError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotAllowedError';
}

export function useNarrationController(input: UseNarrationControllerInput): NarrationController {
  const inputRef = useRef(input);
  inputRef.current = input;
  const cacheRef = useRef<NarrationAudioCache | null>(null);
  if (!cacheRef.current) cacheRef.current = input.cache ?? new NarrationAudioCache();
  const createPlayerRef = useRef(input.createPlayer ?? createAudioSegmentPlayer);
  createPlayerRef.current = input.createPlayer ?? createAudioSegmentPlayer;
  const cursorRef = useRef<NarrationCursor | undefined>(firstCursor(input));
  const playbackRef = useRef<ActivePlayback | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const operationRef = useRef(0);
  const mountedRef = useRef(false);
  const waitingForSlideRef = useRef<string | null>(null);
  const [status, setStatus] = useState<NarrationStatus>('preparing');
  const statusRef = useRef<NarrationStatus>(status);
  statusRef.current = status;
  const [activeSlideId, setActiveSlideId] = useState(cursorRef.current?.slideId);
  const [subtitle, setSubtitle] = useState('');
  const [message, setMessage] = useState('正在准备讲解');
  const [error, setError] = useState<string | null>(null);

  const releasePlayback = useCallback(async (result: FollowUpPlaybackResult = 'cancelled') => {
    const active = playbackRef.current;
    playbackRef.current = null;
    if (!active) return;
    active.settle?.(result);
    try { active.unsubscribe(); } catch { /* cleanup continues */ }
    cacheRef.current!.markPlaying(inputRef.current.reportId, active.speechId, false);
    try { await active.player.stop(); } catch { /* cleanup continues */ }
  }, []);

  const cursorParts = useCallback((cursor: NarrationCursor) => {
    const slide = inputRef.current.slides.find(({ id }) => id === cursor.slideId);
    const segmentIndex = slide?.narration.findIndex(({ id }) => id === cursor.segmentId) ?? -1;
    const segment = segmentIndex >= 0 ? slide!.narration[segmentIndex] : undefined;
    return { slide, segment, segmentIndex };
  }, []);

  const prefetchAround = useCallback((slide: ReportSlide, segmentIndex: number, signal: AbortSignal) => {
    const current = inputRef.current;
    const nextSegment = slide.narration[segmentIndex + 1];
    if (nextSegment) {
      void cacheRef.current!.load(current.reportId, nextSegment.speechId, signal).catch(() => undefined);
    }
    const nextItem = nextNarrationItem(current, slide.id);
    const nextSlide = nextItem?.status === 'ready'
      ? finalReplacementFor(current.slides, nextItem.id)
      : undefined;
    const firstNextSegment = nextSlide?.narration[0];
    if (firstNextSegment) {
      void cacheRef.current!.load(current.reportId, firstNextSegment.speechId, signal).catch(() => undefined);
    }
  }, []);

  const startCursorRef = useRef<(cursor: NarrationCursor, boundary?: 'progress' | 'pause' | 'follow-up') => Promise<void>>(
    async () => undefined,
  );
  const advanceRef = useRef<() => Promise<void>>(async () => undefined);

  const startCursor = useCallback(async (
    cursor: NarrationCursor,
    boundary: 'progress' | 'pause' | 'follow-up' = 'progress',
  ) => {
    const safeCursor = playableCursor(inputRef.current, cursor);
    if (!safeCursor) {
      setStatus('error');
      setError('讲解位置已失效，请重新选择页面');
      return;
    }
    cursor = safeCursor;
    const operation = ++operationRef.current;
    waitingForSlideRef.current = null;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    await releasePlayback();
    if (!mountedRef.current || operation !== operationRef.current) return;
    const { slide, segment, segmentIndex } = cursorParts(cursor);
    if (!slide || !segment) {
      setStatus('error');
      setError('讲解位置已失效，请重新选择页面');
      return;
    }

    cursorRef.current = { ...cursor, offsetMs: Math.max(0, Math.round(cursor.offsetMs)) };
    setActiveSlideId(slide.id);
    setSubtitle(segment.text);
    setError(null);
    setStatus('preparing');
    setMessage(`正在准备第 ${slide.order + 1} 页讲解`);
    inputRef.current.setNarrationCursor(cursorRef.current, boundary);

    const audioPromise = cacheRef.current!.load(inputRef.current.reportId, segment.speechId, controller.signal);
    prefetchAround(slide, segmentIndex, controller.signal);
    try {
      const audio = await audioPromise;
      if (!mountedRef.current || operation !== operationRef.current || controller.signal.aborted) return;
      const player = createPlayerRef.current();
      const active: ActivePlayback = {
        player,
        speechId: segment.speechId,
        kind: 'narration',
        operation,
        ended: false,
        unsubscribe: () => undefined,
      };
      active.unsubscribe = player.onEnded(() => {
        if (playbackRef.current !== active) return;
        if (active.operation !== operationRef.current) {
          active.ended = true;
          return;
        }
        cacheRef.current!.markPlaying(inputRef.current.reportId, active.speechId, false);
        playbackRef.current = null;
        active.unsubscribe();
        void active.player.stop().catch(() => undefined);
        void advanceRef.current();
      });
      playbackRef.current = active;
      cacheRef.current!.markPlaying(inputRef.current.reportId, segment.speechId, true);
      await player.play(audio, { offsetMs: cursorRef.current.offsetMs });
      if (!mountedRef.current || operation !== operationRef.current || playbackRef.current !== active) return;
      setStatus('speaking');
      setMessage(`正在讲解第 ${slide.order + 1} 页`);
    } catch (caught) {
      if (!mountedRef.current || operation !== operationRef.current || controller.signal.aborted) return;
      await releasePlayback();
      if (!mountedRef.current || operation !== operationRef.current) return;
      if (isAutoplayPolicyError(caught)) {
        setStatus('paused');
        setError(null);
        setMessage('语音未播放：浏览器已阻止自动播放，请点击“继续讲解”恢复');
        return;
      }
      setStatus('error');
      setError(AUDIO_FALLBACK_MESSAGE);
      setMessage('讲解音频加载失败');
    }
  }, [cursorParts, prefetchAround, releasePlayback]);
  startCursorRef.current = startCursor;

  const advance = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || !mountedRef.current) return;
    const { slide, segmentIndex } = cursorParts(cursor);
    if (!slide || segmentIndex < 0) return;
    const nextSegment = slide.narration[segmentIndex + 1];
    if (nextSegment) {
      await startCursorRef.current({ slideId: slide.id, segmentId: nextSegment.id, offsetMs: 0 });
      return;
    }

    const current = inputRef.current;
    const nextItem = nextNarrationItem(current, slide.id);
    if (!nextItem) {
      setStatus('completed');
      setMessage('讲解已完成');
      return;
    }
    const nextSlide = nextItem.status === 'ready'
      ? finalReplacementFor(current.slides, nextItem.id)
      : undefined;
    const firstSegment = nextSlide?.narration[0];
    if (!nextSlide || !firstSegment) {
      waitingForSlideRef.current = nextItem.id;
      setStatus('preparing');
      setMessage(nextItem.status === 'planned' || nextItem.status === 'generating'
        ? '下一页仍在生成中'
        : '下一页暂时无法讲解');
      return;
    }
    current.selectSlide(nextSlide.id);
    await startCursorRef.current({ slideId: nextSlide.id, segmentId: firstSegment.id, offsetMs: 0 }, 'pause');
  }, [cursorParts]);
  advanceRef.current = advance;

  const play = useCallback(async () => {
    const active = playbackRef.current;
    if (status === 'paused' && active?.kind === 'narration') {
      if (active.ended) {
        await releasePlayback();
        const cursor = cursorRef.current ?? firstCursor(inputRef.current);
        if (cursor) await startCursorRef.current(cursor, 'pause');
        return;
      }
      const operation = ++operationRef.current;
      loadAbortRef.current?.abort();
      active.operation = operation;
      try {
        await active.player.resume();
        if (mountedRef.current && operation === operationRef.current && playbackRef.current === active) {
          setStatus('speaking');
          setMessage('讲解已继续');
        }
      } catch {
        if (!mountedRef.current || operation !== operationRef.current) return;
        await releasePlayback();
        if (!mountedRef.current || operation !== operationRef.current) return;
        setStatus('error');
        setError(AUDIO_FALLBACK_MESSAGE);
      }
      return;
    }
    const cursor = cursorRef.current ?? firstCursor(inputRef.current);
    if (cursor) await startCursorRef.current(cursor, 'pause');
  }, [releasePlayback, status]);

  const pause = useCallback(async () => {
    const operation = ++operationRef.current;
    loadAbortRef.current?.abort();
    waitingForSlideRef.current = null;
    const active = playbackRef.current;
    if (!active) {
      if (mountedRef.current && operation === operationRef.current) setStatus('paused');
      return;
    }
    if (active.kind === 'answer') {
      await releasePlayback('cancelled');
      if (mountedRef.current && operation === operationRef.current) {
        setStatus('paused');
        setMessage('讲解已暂停');
      }
      return;
    }
    try {
      await active.player.pause();
      if (!mountedRef.current || operation !== operationRef.current || playbackRef.current !== active) return;
      const cursor = cursorRef.current;
      if (cursor && active.kind === 'narration') {
        const paused = { ...cursor, offsetMs: Math.max(0, Math.round(active.player.positionMs())) };
        cursorRef.current = paused;
        inputRef.current.setNarrationCursor(paused, 'pause');
      }
      if (active.ended) await releasePlayback();
      if (!mountedRef.current || operation !== operationRef.current) return;
      setStatus('paused');
      setMessage('讲解已暂停');
    } catch {
      if (!mountedRef.current || operation !== operationRef.current) return;
      setStatus('error');
      setError(AUDIO_FALLBACK_MESSAGE);
    }
  }, [releasePlayback]);

  const replaySlide = useCallback(async () => {
    const cursor = cursorRef.current;
    const slide = cursor ? inputRef.current.slides.find(({ id }) => id === cursor.slideId) : undefined;
    const segment = slide?.narration[0];
    if (slide && segment) {
      await startCursorRef.current({ slideId: slide.id, segmentId: segment.id, offsetMs: 0 }, 'pause');
    }
  }, []);

  const goToSlide = useCallback(async (slideId: string) => {
    const slide = finalReplacementFor(inputRef.current.slides, slideId);
    const ready = inputRef.current.outline.find(({ id }) => id === slide?.id)?.status === 'ready';
    const segment = slide?.narration[0];
    if (!slide || !segment || !ready) return;
    inputRef.current.selectSlide(slide.id);
    await startCursorRef.current({ slideId: slide.id, segmentId: segment.id, offsetMs: 0 }, 'pause');
  }, []);

  const beginInterruption = useCallback((mode: 'listening' | 'typing'): NarrationCursor => {
    operationRef.current += 1;
    loadAbortRef.current?.abort();
    waitingForSlideRef.current = null;
    setStatus('interrupting');
    const active = playbackRef.current;
    const current = cursorRef.current ?? firstCursor(inputRef.current);
    const cursor = current
      ? { ...current, offsetMs: active?.kind === 'narration' ? Math.max(0, Math.round(active.player.positionMs())) : current.offsetMs }
      : { slideId: '', segmentId: '', offsetMs: 0 };
    cursorRef.current = cursor;
    inputRef.current.setNarrationCursor(cursor, 'follow-up');
    if (active?.kind === 'answer') void releasePlayback('cancelled');
    else if (active) void active.player.pause().catch(() => undefined);
    setStatus(mode);
    setMessage(mode === 'listening' ? '正在聆听追问' : '正在输入追问');
    return cursor;
  }, []);

  const playFollowUpAnswer = useCallback(async (speechId: string): Promise<FollowUpPlaybackResult> => {
    const operation = ++operationRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    await releasePlayback();
    if (!mountedRef.current || operation !== operationRef.current) return 'cancelled';
    setStatus('answering');
    setMessage('正在播放追问回答');
    try {
      const audio = await cacheRef.current!.load(inputRef.current.reportId, speechId, controller.signal);
      if (!mountedRef.current || operation !== operationRef.current) return 'cancelled';
      const player = createPlayerRef.current();
      let settle!: (result: FollowUpPlaybackResult) => void;
      const ended = new Promise<FollowUpPlaybackResult>((resolve) => { settle = resolve; });
      const active: ActivePlayback = {
        player,
        speechId,
        kind: 'answer',
        operation,
        ended: false,
        unsubscribe: () => undefined,
        settle,
      };
      active.unsubscribe = player.onEnded(() => {
        if (playbackRef.current !== active) return;
        if (active.operation !== operationRef.current) {
          active.ended = true;
          cacheRef.current!.markPlaying(inputRef.current.reportId, speechId, false);
          playbackRef.current = null;
          active.unsubscribe();
          active.settle?.('cancelled');
          void active.player.stop().catch(() => undefined);
          return;
        }
        cacheRef.current!.markPlaying(inputRef.current.reportId, speechId, false);
        playbackRef.current = null;
        active.unsubscribe();
        active.settle?.('ended');
        void active.player.stop().catch(() => undefined);
        setStatus('resuming');
        setMessage('追问回答已结束，可继续原讲解');
      });
      playbackRef.current = active;
      cacheRef.current!.markPlaying(inputRef.current.reportId, speechId, true);
      await player.play(audio);
      return await ended;
    } catch {
      if (!controller.signal.aborted && mountedRef.current && operation === operationRef.current) {
        await releasePlayback();
        if (!mountedRef.current || operation !== operationRef.current) return 'cancelled';
        setStatus('error');
        setError('追问回答音频不可用，请阅读文字回答');
        return 'failed';
      }
      return 'cancelled';
    }
  }, [releasePlayback]);

  const resumeAfterAnswer = useCallback(async (cursor: NarrationCursor) => {
    setStatus('resuming');
    setMessage('正在恢复原讲解');
    const safeCursor = playableCursor(inputRef.current, cursor);
    if (!safeCursor) return;
    inputRef.current.selectSlide(safeCursor.slideId);
    await startCursorRef.current(safeCursor, 'follow-up');
  }, []);

  const stop = useCallback(async () => {
    const operation = ++operationRef.current;
    loadAbortRef.current?.abort();
    waitingForSlideRef.current = null;
    await releasePlayback();
    if (mountedRef.current && operation === operationRef.current) {
      setStatus('completed');
      setMessage('讲解已停止');
    }
  }, [releasePlayback]);

  useEffect(() => {
    if (!waitingForSlideRef.current || status !== 'preparing') return;
    const nextId = waitingForSlideRef.current;
    const item = input.outline.find(({ id }) => id === nextId);
    const slide = input.slides.find(({ id }) => id === nextId);
    const segment = slide?.narration[0];
    if (item?.status === 'ready' && slide && segment) {
      waitingForSlideRef.current = null;
      input.selectSlide(slide.id);
      void startCursorRef.current({ slideId: slide.id, segmentId: segment.id, offsetMs: 0 }, 'pause');
      return;
    }
    const currentSlideId = cursorRef.current?.slideId;
    const nextItem = currentSlideId ? nextNarrationItem(input, currentSlideId) : undefined;
    if (!item || item.status === 'failed' || slide?.supersededBySlideId || nextItem?.id !== nextId) {
      waitingForSlideRef.current = null;
      void advanceRef.current();
    }
  }, [input.outline, input.selectSlide, input.slides, status]);

  useEffect(() => {
    const current = cursorRef.current;
    const safeCursor = playableCursor(inputRef.current, current);
    if (!current || safeCursor?.slideId === current.slideId) return;
    const liveStatus = statusRef.current;
    const transfer = safeCursor !== undefined && (
      liveStatus === 'preparing'
      || liveStatus === 'speaking'
      || liveStatus === 'resuming'
    );
    const operation = ++operationRef.current;
    loadAbortRef.current?.abort();
    waitingForSlideRef.current = null;
    cursorRef.current = undefined;
    void (async () => {
      await releasePlayback();
      if (!mountedRef.current || operation !== operationRef.current) return;
      const latestCursor = playableCursor(inputRef.current, current);
      if (!transfer || !latestCursor) {
        setSubtitle('');
        if (!latestCursor) {
          setActiveSlideId(undefined);
          setStatus('completed');
          setMessage('当前没有可讲解页面');
          return;
        }
        if (liveStatus === 'paused') {
          setStatus('paused');
          setMessage('当前页已被更正，请选择更正页后继续讲解');
        }
        return;
      }
      inputRef.current.selectSlide(latestCursor.slideId);
      await startCursorRef.current(latestCursor, 'follow-up');
    })();
  }, [input.slides, releasePlayback]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      loadAbortRef.current?.abort();
      void releasePlayback();
      cacheRef.current!.clearReport(inputRef.current.reportId);
    };
  }, [input.reportId, releasePlayback]);

  const autoplayStartedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current || autoplayStartedRef.current || input.autoplay === false) return;
    const cursor = cursorRef.current ?? firstCursor(inputRef.current);
    if (!cursor) return;
    autoplayStartedRef.current = true;
    cursorRef.current = cursor;
    void startCursorRef.current(cursor);
  }, [input.activeSlideId, input.autoplay, input.slides]);

  useEffect(() => () => {
    autoplayStartedRef.current = false;
  }, [input.reportId]);

  return {
    status,
    canNarrate: playableReportSlides(input.slides).some(({ narration }) => narration.length > 0),
    activeSlideId,
    subtitle,
    message,
    error,
    play,
    pause,
    replaySlide,
    goToSlide,
    beginInterruption,
    playFollowUpAnswer,
    resumeAfterAnswer,
    stop,
  };
}
