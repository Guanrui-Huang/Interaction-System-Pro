import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ATOMIC_VISUAL_KINDS, type NarrationCursor, type ReportSlide, type SlideOutline } from '../../shared/report';
import type { NarrationAudioCache } from '../features/ai/report/narration-audio-cache';
import { useNarrationController } from '../features/ai/report/useNarrationController';
import { ReportNarrationControls } from '../features/ai/report/ReportNarrationControls';
import type { AudioSegmentPlayer, PlayableSpeech } from '../features/ai/voice/audio-segment-player';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function slide(id: string, order: number, speechIds: string[]): ReportSlide {
  return {
    id, order, evidenceSnapshotId: 'snapshot-1', role: 'knowledge', layout: 'action-path', evidencePolicy: 'knowledge', title: `第 ${order + 1} 页`, takeaway: '结论', takeawayClaimIds: ['claim-1'], metrics: [], evidenceRefs: [],
    claims: [{ id: 'claim-1', text: '结论', kind: 'knowledge', evidenceRefs: [] }],
    visual: { kind: 'process-flow', provenance: 'model-knowledge', steps: [{ id: 'step', title: '步骤', detail: '说明', claimIds: ['claim-1'] }] },
    narration: speechIds.map((speechId, index) => ({ id: `${id}-segment-${index + 1}`, text: `${id} 讲解 ${index + 1}`, speechId, claimIds: ['claim-1'] })),
  };
}

function outline(item: ReportSlide, status: SlideOutline['status']): SlideOutline {
  const kind = item.visual.kind === 'data-dashboard' ? item.visual.primary.kind : item.visual.kind;
  if (!ATOMIC_VISUAL_KINDS.includes(kind)) {
    throw new Error(`Unexpected rendered outline visual kind: ${kind}`);
  }
  return {
    id: item.id,
    order: item.order,
    title: item.title,
    purpose: item.takeaway,
    role: item.role,
    layout: item.layout,
    evidencePolicy: item.evidencePolicy,
    visualKind: kind,
    evidenceKeys: [],
    status,
  };
}

class FakeCache {
  readonly requests: string[] = [];
  readonly entries = new Map<string, Promise<{ segments: ArrayBuffer[]; byteLength: number }>>();
  markPlaying = vi.fn();
  clearReport = vi.fn();
  clear = vi.fn();
  load(reportId: string, speechId: string) {
    const key = `${reportId}:${speechId}`;
    let request = this.entries.get(key);
    if (!request) {
      this.requests.push(key);
      request = Promise.resolve({ segments: [new ArrayBuffer(1)], byteLength: 1 });
      this.entries.set(key, request);
    }
    return request;
  }
}

class FakePlayer implements AudioSegmentPlayer {
  readonly play = vi.fn(async (_speech: PlayableSpeech, _options?: { offsetMs?: number }) => undefined);
  readonly pause = vi.fn(async (): Promise<void> => undefined);
  readonly resume = vi.fn(async (): Promise<void> => undefined);
  readonly stop = vi.fn(async (): Promise<void> => undefined);
  readonly enqueue = vi.fn(async () => undefined);
  position = 0;
  private listeners = new Set<() => void>();
  positionMs = () => this.position;
  onEnded(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onSegmentEnded(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  listenerCount() { return this.listeners.size; }
  finish() { for (const listener of [...this.listeners]) listener(); }
}

function setup(overrides: Partial<Parameters<typeof useNarrationController>[0]> = {}) {
  const first = slide('slide-1', 0, ['speech-1', 'speech-2']);
  const second = slide('slide-2', 1, ['speech-3']);
  const cache = new FakeCache();
  const players: FakePlayer[] = [];
  const selectSlide = vi.fn();
  const setNarrationCursor = vi.fn();
  const input: Parameters<typeof useNarrationController>[0] = {
    reportId: 'report-1',
    slides: [first, second],
    outline: [outline(first, 'ready'), outline(second, 'ready')],
    activeSlideId: 'slide-1',
    initialCursor: undefined,
    selectSlide,
    setNarrationCursor,
    cache: cache as unknown as NarrationAudioCache,
    createPlayer: () => {
      const player = new FakePlayer();
      players.push(player);
      return player;
    },
    ...overrides,
  };
  return { input, first, second, cache, players, selectSlide, setNarrationCursor };
}

it('autoplays once and prefetches the current, next segment, and next page first segment', async () => {
  const model = setup();
  const { result } = renderHook(() => useNarrationController(model.input), { reactStrictMode: true });

  await waitFor(() => expect(result.current.status).toBe('speaking'));
  expect(model.cache.requests).toEqual(['report-1:speech-1', 'report-1:speech-2', 'report-1:speech-3']);
  expect(model.players).toHaveLength(1);
  expect(model.players[0].play).toHaveBeenCalledOnce();
  expect(result.current.subtitle).toBe('slide-1 讲解 1');
});

it('skips a superseded page and never resumes its stale narration cursor', async () => {
  const model = setup();
  model.first.supersededBySlideId = model.second.id;
  model.input.initialCursor = { slideId: model.first.id, segmentId: 'slide-1-segment-2', offsetMs: 1_260 };
  model.input.activeSlideId = model.first.id;
  const { result } = renderHook(() => useNarrationController(model.input));

  await waitFor(() => expect(result.current.status).toBe('speaking'));
  expect(result.current.activeSlideId).toBe(model.second.id);
  expect(model.cache.requests).toEqual(['report-1:speech-3']);

  await act(async () => result.current.resumeAfterAnswer({
    slideId: model.first.id,
    segmentId: 'slide-1-segment-2',
    offsetMs: 1_260,
  }));

  expect(model.setNarrationCursor).toHaveBeenLastCalledWith({
    slideId: model.second.id,
    segmentId: 'slide-2-segment-1',
    offsetMs: 0,
  }, 'follow-up');
  expect(model.cache.requests).toEqual(['report-1:speech-3']);
});

it('transfers live speaking playback once to the final A to B to C replacement', async () => {
  const model = setup();
  const third = slide('slide-3', 2, ['speech-4']);
  const { result, rerender } = renderHook(
    ({ input }) => useNarrationController(input),
    { initialProps: { input: model.input } },
  );
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  const oldPlayer = model.players[0]!;
  const a = { ...model.first, supersededBySlideId: model.second.id };
  const b = { ...model.second, supersededBySlideId: third.id };

  rerender({
    input: {
      ...model.input,
      slides: [a, b, third],
      outline: [outline(a, 'ready'), outline(b, 'ready'), outline(third, 'ready')],
    },
  });

  await waitFor(() => expect(result.current.activeSlideId).toBe(third.id));
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  expect(oldPlayer.stop).toHaveBeenCalledOnce();
  expect(model.players).toHaveLength(2);
  expect(model.players[1]?.play).toHaveBeenCalledOnce();
  expect(model.selectSlide).toHaveBeenLastCalledWith(third.id);
  expect(model.setNarrationCursor).toHaveBeenLastCalledWith({
    slideId: third.id, segmentId: 'slide-3-segment-1', offsetMs: 0,
  }, 'follow-up');
});

it('releases a live-superseded paused page without restarting narration', async () => {
  const model = setup();
  const { result, rerender } = renderHook(
    ({ input }) => useNarrationController(input),
    { initialProps: { input: model.input } },
  );
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  await act(async () => result.current.pause());
  expect(result.current.status).toBe('paused');
  const oldPlayer = model.players[0]!;

  rerender({
    input: {
      ...model.input,
      slides: [{ ...model.first, supersededBySlideId: model.second.id }, model.second],
    },
  });

  await waitFor(() => expect(oldPlayer.stop).toHaveBeenCalledOnce());
  expect(result.current.status).toBe('paused');
  expect(model.players).toHaveLength(1);
  expect(model.selectSlide).not.toHaveBeenCalledWith(model.second.id);
});

it.each(['stopped', 'error', 'completed'] as const)(
  'does not restart narration when live supersession arrives after %s',
  async (terminalState) => {
    const model = setup();
    if (terminalState === 'error') {
      model.input.createPlayer = () => {
        const player = new FakePlayer();
        player.play.mockRejectedValueOnce(new Error('decode failed'));
        model.players.push(player);
        return player;
      };
    }
    const { result, rerender } = renderHook(
      ({ input }) => useNarrationController(input),
      { initialProps: { input: model.input } },
    );

    if (terminalState === 'error') {
      await waitFor(() => expect(result.current.status).toBe('error'));
    } else {
      await waitFor(() => expect(result.current.status).toBe('speaking'));
      if (terminalState === 'stopped') {
        await act(async () => result.current.stop());
        expect(result.current.message).toBe('讲解已停止');
      } else {
        act(() => model.players[0]!.finish());
        await waitFor(() => expect(model.players).toHaveLength(2));
        act(() => model.players[1]!.finish());
        await waitFor(() => expect(model.players).toHaveLength(3));
        act(() => model.players[2]!.finish());
        await waitFor(() => expect(result.current.status).toBe('completed'));
        expect(result.current.message).toBe('讲解已完成');
      }
    }
    const statusBefore = result.current.status;
    const messageBefore = result.current.message;
    const playerCount = model.players.length;
    model.selectSlide.mockClear();

    rerender({
      input: {
        ...model.input,
        slides: [{ ...model.first, supersededBySlideId: model.second.id }, model.second],
      },
    });

    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe(statusBefore);
    expect(result.current.message).toBe(messageBefore);
    expect(model.players).toHaveLength(playerCount);
    expect(model.selectSlide).not.toHaveBeenCalledWith(model.second.id);
  },
);

it('transfers live preparing narration to the replacement without letting the old load publish', async () => {
  const pendingOld = deferred<{ segments: ArrayBuffer[]; byteLength: number }>();
  const cache = {
    load: vi.fn((_reportId: string, speechId: string) => (
      speechId === 'speech-1'
        ? pendingOld.promise
        : Promise.resolve({ segments: [new ArrayBuffer(1)], byteLength: 1 })
    )),
    markPlaying: vi.fn(),
    clearReport: vi.fn(),
  };
  const model = setup({ cache: cache as unknown as NarrationAudioCache });
  const { result, rerender } = renderHook(
    ({ input }) => useNarrationController(input),
    { initialProps: { input: model.input } },
  );
  await waitFor(() => expect(cache.load).toHaveBeenCalledWith('report-1', 'speech-1', expect.any(AbortSignal)));
  expect(result.current.status).toBe('preparing');

  rerender({
    input: {
      ...model.input,
      slides: [{ ...model.first, supersededBySlideId: model.second.id }, model.second],
    },
  });

  await waitFor(() => expect(result.current.status).toBe('speaking'));
  expect(result.current.activeSlideId).toBe(model.second.id);
  expect(model.players).toHaveLength(1);
  expect(model.players[0]!.play).toHaveBeenCalledOnce();
  expect(model.selectSlide).toHaveBeenCalledWith(model.second.id);
});

it('transfers live resuming narration to the replacement exactly once', async () => {
  const model = setup({ autoplay: false });
  const { result, rerender } = renderHook(
    ({ input }) => useNarrationController(input),
    { initialProps: { input: model.input } },
  );
  let answer!: Promise<'ended' | 'cancelled' | 'failed'>;
  act(() => { answer = result.current.playFollowUpAnswer('answer-speech'); });
  await waitFor(() => expect(model.players).toHaveLength(1));
  act(() => model.players[0]!.finish());
  await act(async () => { await answer; });
  expect(result.current.status).toBe('resuming');

  rerender({
    input: {
      ...model.input,
      slides: [{ ...model.first, supersededBySlideId: model.second.id }, model.second],
    },
  });

  await waitFor(() => expect(result.current.status).toBe('speaking'));
  expect(result.current.activeSlideId).toBe(model.second.id);
  expect(model.players).toHaveLength(2);
  expect(model.players[1]!.play).toHaveBeenCalledOnce();
  expect(model.selectSlide).toHaveBeenCalledTimes(1);
});

it('ignores a semantically identical republished ready slide without duplicate narration', async () => {
  const model = setup();
  const { result, rerender } = renderHook(
    ({ input }) => useNarrationController(input),
    { initialProps: { input: model.input } },
  );
  await waitFor(() => expect(result.current.status).toBe('speaking'));

  rerender({
    input: {
      ...model.input,
      slides: [{ ...model.first }, { ...model.second }],
      outline: [{ ...outline(model.first, 'ready') }, { ...outline(model.second, 'ready') }],
    },
  });

  await act(async () => { await Promise.resolve(); });
  expect(result.current.status).toBe('speaking');
  expect(model.players).toHaveLength(1);
  expect(model.players[0]!.play).toHaveBeenCalledOnce();
});

it('keeps first-page playback stable when a screenshot-style later page exhausts and fails', async () => {
  const model = setup({ slides: [] });
  model.input.slides = [model.first];
  model.input.outline = [outline(model.first, 'ready'), outline(model.second, 'generating')];
  const { result, rerender } = renderHook(
    ({ input }) => useNarrationController(input),
    { initialProps: { input: model.input } },
  );
  await waitFor(() => expect(result.current.status).toBe('speaking'));

  rerender({
    input: {
      ...model.input,
      slides: [{ ...model.first }],
      outline: [outline(model.first, 'ready'), { ...outline(model.second, 'failed'), retryable: true }],
    },
  });

  await act(async () => { await Promise.resolve(); });
  expect(result.current.status).toBe('speaking');
  expect(result.current.activeSlideId).toBe(model.first.id);
  expect(model.players).toHaveLength(1);
  expect(model.players[0]!.play).toHaveBeenCalledOnce();
  expect(model.selectSlide).not.toHaveBeenCalled();
});

it('clears stale speaking state when a malformed update leaves no playable page', async () => {
  const model = setup();
  const { result, rerender } = renderHook(
    ({ input }) => useNarrationController(input),
    { initialProps: { input: model.input } },
  );
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  const oldPlayer = model.players[0]!;

  rerender({
    input: {
      ...model.input,
      slides: [
        { ...model.first, supersededBySlideId: 'missing-replacement' },
        { ...model.second, supersededBySlideId: 'missing-replacement' },
      ],
    },
  });

  await waitFor(() => expect(oldPlayer.stop).toHaveBeenCalledOnce());
  await waitFor(() => expect(result.current.activeSlideId).toBeUndefined());
  expect(result.current.status).toBe('completed');
  expect(result.current.message).toBe('当前没有可讲解页面');
  expect(model.players).toHaveLength(1);
});

it('waits on the current ready page when the next outlined page is still generating', async () => {
  const model = setup({ outline: [] });
  model.input.outline = [outline(model.first, 'ready'), outline(model.second, 'generating')];
  model.input.slides = [model.first];
  const { result } = renderHook(() => useNarrationController(model.input));
  await waitFor(() => expect(result.current.status).toBe('speaking'));

  act(() => model.players[0].finish());
  await waitFor(() => expect(model.players).toHaveLength(2));
  act(() => model.players[1].finish());

  await waitFor(() => expect(result.current.status).toBe('preparing'));
  expect(result.current.activeSlideId).toBe('slide-1');
  expect(result.current.message).toBe('下一页仍在生成中');
  expect(model.selectSlide).not.toHaveBeenCalledWith('slide-2');
});

it('skips a failed outlined page and continues automatic narration on the next ready page', async () => {
  const model = setup();
  const third = slide('slide-3', 2, ['speech-4']);
  model.input.slides = [model.first, third];
  model.input.outline = [
    outline(model.first, 'ready'),
    { ...outline(model.second, 'failed'), retryable: true },
    outline(third, 'ready'),
  ];
  const { result } = renderHook(() => useNarrationController(model.input));
  await waitFor(() => expect(result.current.status).toBe('speaking'));

  act(() => model.players[0]!.finish());
  await waitFor(() => expect(model.players).toHaveLength(2));
  act(() => model.players[1]!.finish());

  await waitFor(() => expect(result.current.activeSlideId).toBe(third.id));
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  expect(model.selectSlide).toHaveBeenLastCalledWith(third.id);
  expect(model.cache.requests).toContain('report-1:speech-4');
});

it('rescans and advances when a page being awaited changes from generating to failed', async () => {
  const model = setup();
  const third = slide('slide-3', 2, ['speech-4']);
  const initial = {
    ...model.input,
    slides: [model.first, third],
    outline: [
      outline(model.first, 'ready'),
      outline(model.second, 'generating'),
      outline(third, 'ready'),
    ],
  };
  const { result, rerender } = renderHook(
    ({ input }) => useNarrationController(input),
    { initialProps: { input: initial } },
  );
  await waitFor(() => expect(result.current.status).toBe('speaking'));

  act(() => model.players[0]!.finish());
  await waitFor(() => expect(model.players).toHaveLength(2));
  act(() => model.players[1]!.finish());
  await waitFor(() => expect(result.current.message).toBe('下一页仍在生成中'));

  rerender({
    input: {
      ...initial,
      outline: [
        outline(model.first, 'ready'),
        { ...outline(model.second, 'failed'), retryable: false },
        outline(third, 'ready'),
      ],
    },
  });

  await waitFor(() => expect(result.current.activeSlideId).toBe(third.id));
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  expect(model.selectSlide).toHaveBeenLastCalledWith(third.id);
});

it('restores an interrupted semantic segment at its exact recorded offset', async () => {
  const model = setup();
  const { result } = renderHook(() => useNarrationController(model.input));
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  model.players[0].position = 1_260;

  let cursor!: NarrationCursor;
  act(() => { cursor = result.current.beginInterruption('typing'); });
  expect(cursor).toEqual({ slideId: 'slide-1', segmentId: 'slide-1-segment-1', offsetMs: 1_260 });
  expect(result.current.status).toBe('typing');
  expect(model.setNarrationCursor).toHaveBeenCalledWith(cursor, 'follow-up');

  await act(async () => result.current.resumeAfterAnswer(cursor));
  await waitFor(() => expect(model.players.at(-1)?.play).toHaveBeenCalledWith(expect.anything(), { offsetMs: 1_260 }));
  expect(result.current.status).toBe('speaking');
});

it('honors explicit pause, resume, replay, jump, and stop over pending automatic transitions', async () => {
  const model = setup();
  const { result } = renderHook(() => useNarrationController(model.input));
  await waitFor(() => expect(result.current.status).toBe('speaking'));

  await act(async () => result.current.pause());
  expect(result.current.status).toBe('paused');
  await act(async () => result.current.play());
  expect(model.players[0].resume).toHaveBeenCalledOnce();
  await act(async () => result.current.replaySlide());
  expect(model.players.at(-1)?.play).toHaveBeenCalledWith(expect.anything(), { offsetMs: 0 });
  await act(async () => result.current.goToSlide('slide-2'));
  expect(model.selectSlide).toHaveBeenCalledWith('slide-2');
  expect(model.setNarrationCursor).toHaveBeenCalledWith({ slideId: 'slide-2', segmentId: 'slide-2-segment-1', offsetMs: 0 }, 'pause');
  await act(async () => result.current.stop());
  expect(result.current.status).toBe('completed');
});

it('surfaces audio failure with readable subtitles and releases audio/cache on unmount', async () => {
  const model = setup({
    createPlayer: () => {
      const player = new FakePlayer();
      player.play.mockRejectedValueOnce(new Error('decode failed'));
      model.players.push(player);
      return player;
    },
  });
  const { result, unmount } = renderHook(() => useNarrationController(model.input));

  await waitFor(() => expect(result.current.status).toBe('error'));
  expect(result.current.subtitle).toBe('slide-1 讲解 1');
  expect(result.current.error).toContain('语音未播放');
  expect(result.current.error).toContain('请阅读字幕或点击“播放讲解”重试');
  unmount();
  expect(model.cache.clearReport).toHaveBeenCalledWith('report-1');
  expect(model.players[0].stop).toHaveBeenCalled();
});

it('starts default autoplay when the first ready slide arrives after an empty knowledge snapshot', async () => {
  const model = setup({ slides: [], outline: [], activeSlideId: undefined });
  const { result, rerender } = renderHook(
    ({ input }) => useNarrationController(input),
    { initialProps: { input: model.input } },
  );
  expect(result.current.status).toBe('preparing');
  expect(model.players).toHaveLength(0);

  rerender({
    input: {
      ...model.input,
      slides: [model.first],
      outline: [outline(model.first, 'ready')],
      activeSlideId: 'slide-1',
    },
  });

  await waitFor(() => expect(result.current.status).toBe('speaking'));
  expect(model.players).toHaveLength(1);
  expect(model.players[0].play).toHaveBeenCalledOnce();
});

it('resolves follow-up answer playback only after its audio ends', async () => {
  const model = setup({ autoplay: false });
  const { result } = renderHook(() => useNarrationController(model.input));
  let completed = false;
  let answer!: Promise<'ended' | 'cancelled' | 'failed'>;
  let outcome: 'ended' | 'cancelled' | 'failed' | undefined;
  act(() => {
    answer = result.current.playFollowUpAnswer('answer-speech').then((value) => { completed = true; outcome = value; return value; });
  });
  await waitFor(() => expect(model.players).toHaveLength(1));
  expect(completed).toBe(false);
  act(() => model.players[0].finish());
  await act(async () => answer);
  expect(completed).toBe(true);
  expect(outcome).toBe('ended');
  expect(result.current.status).toBe('resuming');
});

it('releases a failed player immediately and permits a clean retry before unmount', async () => {
  const model = setup({
    createPlayer: () => {
      const player = new FakePlayer();
      if (model.players.length === 0) player.play.mockRejectedValueOnce(new Error('start failed'));
      model.players.push(player);
      return player;
    },
  });
  const { result } = renderHook(() => useNarrationController(model.input));
  await waitFor(() => expect(result.current.status).toBe('error'));

  expect(model.players[0].stop).toHaveBeenCalledOnce();
  expect(model.cache.markPlaying).toHaveBeenCalledWith('report-1', 'speech-1', false);
  expect(model.players[0].listenerCount()).toBe(0);

  await act(async () => result.current.play());
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  expect(model.players).toHaveLength(2);
  expect(model.players[1].play).toHaveBeenCalledOnce();
});

it('invalidates and aborts an in-flight preparation before entering interruption mode', async () => {
  const pending = deferred<{ segments: ArrayBuffer[]; byteLength: number }>();
  let loadSignal!: AbortSignal;
  const cache = {
    load: vi.fn((_reportId: string, _speechId: string, signal: AbortSignal) => {
      loadSignal = signal;
      return pending.promise;
    }),
    markPlaying: vi.fn(),
    clearReport: vi.fn(),
  };
  const only = slide('slide-only', 0, ['speech-only']);
  const model = setup({
    slides: [only],
    outline: [outline(only, 'ready')],
    activeSlideId: only.id,
    cache: cache as unknown as NarrationAudioCache,
  });
  const { result } = renderHook(() => useNarrationController(model.input));
  await waitFor(() => expect(cache.load).toHaveBeenCalledOnce());
  expect(result.current.status).toBe('preparing');

  act(() => { result.current.beginInterruption('typing'); });
  expect(loadSignal.aborted).toBe(true);
  expect(result.current.status).toBe('typing');

  await act(async () => {
    pending.resolve({ segments: [new ArrayBuffer(1)], byteLength: 1 });
    await pending.promise;
  });
  expect(model.players).toHaveLength(0);
  expect(result.current.status).toBe('typing');
});

it('does not auto-advance when playback ends while an explicit pause is pending', async () => {
  const pause = deferred<void>();
  const model = setup();
  const { result } = renderHook(() => useNarrationController(model.input));
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  model.players[0].pause.mockReturnValueOnce(pause.promise);

  let pauseRequest!: Promise<void>;
  act(() => { pauseRequest = result.current.pause(); });
  expect(model.players[0].pause).toHaveBeenCalledOnce();
  act(() => model.players[0].finish());
  await Promise.resolve();
  expect(model.players).toHaveLength(1);

  await act(async () => {
    pause.resolve();
    await pauseRequest;
  });
  expect(result.current.status).toBe('paused');
  expect(model.players).toHaveLength(1);
  expect(model.selectSlide).not.toHaveBeenCalled();
});

it('does not let a late pause completion overwrite a newer explicit stop', async () => {
  const pause = deferred<void>();
  const model = setup();
  const { result } = renderHook(() => useNarrationController(model.input));
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  model.players[0].pause.mockReturnValueOnce(pause.promise);

  let pauseRequest!: Promise<void>;
  act(() => { pauseRequest = result.current.pause(); });
  await act(async () => result.current.stop());
  expect(result.current.status).toBe('completed');

  await act(async () => {
    pause.resolve();
    await pauseRequest;
  });
  expect(result.current.status).toBe('completed');
  expect(model.players[0].stop).toHaveBeenCalledOnce();
});

it('does not let a late stop completion overwrite a newer replay', async () => {
  const stopping = deferred<void>();
  const model = setup();
  const { result } = renderHook(() => useNarrationController(model.input));
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  model.players[0].stop.mockReturnValueOnce(stopping.promise);

  let stopRequest!: Promise<void>;
  act(() => { stopRequest = result.current.stop(); });
  await act(async () => result.current.replaySlide());
  await waitFor(() => expect(result.current.status).toBe('speaking'));
  expect(model.players).toHaveLength(2);

  await act(async () => {
    stopping.resolve();
    await stopRequest;
  });
  expect(result.current.status).toBe('speaking');
});

it('releases an answer that ends after a newer interruption takes ownership', async () => {
  const model = setup({ autoplay: false });
  const { result } = renderHook(() => useNarrationController(model.input));
  let answer!: Promise<'ended' | 'cancelled' | 'failed'>;
  act(() => { answer = result.current.playFollowUpAnswer('answer-speech'); });
  await waitFor(() => expect(model.players).toHaveLength(1));

  act(() => { result.current.beginInterruption('typing'); });
  act(() => model.players[0].finish());
  let outcome!: 'ended' | 'cancelled' | 'failed';
  await act(async () => { outcome = await answer; });

  expect(result.current.status).toBe('typing');
  expect(model.cache.markPlaying).toHaveBeenCalledWith('report-1', 'answer-speech', false);
  expect(model.players[0].stop).toHaveBeenCalledOnce();
  expect(model.players[0].listenerCount()).toBe(0);
  expect(outcome).toBe('cancelled');
});

it('reports answer audio failure without throwing or claiming natural completion', async () => {
  const model = setup({
    autoplay: false,
    createPlayer: () => {
      const player = new FakePlayer();
      player.play.mockRejectedValueOnce(new Error('answer audio failed'));
      model.players.push(player);
      return player;
    },
  });
  const { result } = renderHook(() => useNarrationController(model.input));

  let outcome!: 'ended' | 'cancelled' | 'failed';
  await act(async () => { outcome = await result.current.playFollowUpAnswer('answer-speech'); });

  expect(outcome).toBe('failed');
  expect(result.current.status).toBe('error');
  expect(model.players[0].stop).toHaveBeenCalledOnce();
});

it('returns cancelled when a newer interruption takes ownership while answer audio is loading', async () => {
  const pending = deferred<{ segments: ArrayBuffer[]; byteLength: number }>();
  let answerSignal!: AbortSignal;
  const cache = {
    load: vi.fn((_reportId: string, _speechId: string, signal: AbortSignal) => {
      answerSignal = signal;
      return pending.promise;
    }),
    markPlaying: vi.fn(),
    clearReport: vi.fn(),
  };
  const model = setup({ autoplay: false, cache: cache as unknown as NarrationAudioCache });
  const { result } = renderHook(() => useNarrationController(model.input));

  let answer!: Promise<'ended' | 'cancelled' | 'failed'>;
  act(() => { answer = result.current.playFollowUpAnswer('answer-speech'); });
  await waitFor(() => expect(cache.load).toHaveBeenCalledOnce());
  act(() => { result.current.beginInterruption('typing'); });
  expect(answerSignal.aborted).toBe(true);
  await act(async () => { pending.resolve({ segments: [new ArrayBuffer(1)], byteLength: 1 }); });

  await expect(answer).resolves.toBe('cancelled');
  expect(model.players).toHaveLength(0);
});

it.each([
  ['pause', (controller: ReturnType<typeof useNarrationController>) => controller.pause()],
  ['stop', (controller: ReturnType<typeof useNarrationController>) => controller.stop()],
  ['page switch', (controller: ReturnType<typeof useNarrationController>) => controller.goToSlide('slide-2')],
  ['new interruption', (controller: ReturnType<typeof useNarrationController>) => controller.beginInterruption('typing')],
] as const)('returns cancelled when user priority takes over answer playback via %s', async (_label, takeOver) => {
  const model = setup({ autoplay: false });
  const { result } = renderHook(() => useNarrationController(model.input));
  let answer!: Promise<'ended' | 'cancelled' | 'failed'>;
  act(() => { answer = result.current.playFollowUpAnswer('answer-speech'); });
  await waitFor(() => expect(model.players).toHaveLength(1));

  await act(async () => { await takeOver(result.current); });

  await expect(answer).resolves.toBe('cancelled');
  expect(model.players[0].stop).toHaveBeenCalled();
});

it('keeps a restored cursor offset after autoplay rejection and resumes without restarting the page', async () => {
  const restored = { slideId: 'slide-1', segmentId: 'slide-1-segment-2', offsetMs: 1_260 };
  const model = setup({
    initialCursor: restored,
    createPlayer: () => {
      const player = new FakePlayer();
      if (model.players.length === 0) player.play.mockRejectedValueOnce(new DOMException('autoplay', 'NotAllowedError'));
      model.players.push(player);
      return player;
    },
  });
  const { result } = renderHook(() => useNarrationController(model.input));
  await waitFor(() => expect(result.current.status).toBe('paused'));

  expect(model.players[0].play).toHaveBeenCalledWith(expect.anything(), { offsetMs: 1_260 });
  expect(result.current.error).toBeNull();
  expect(result.current.message).toContain('语音未播放');
  expect(result.current.message).toContain('继续讲解');
  expect(model.selectSlide).not.toHaveBeenCalled();
  await act(async () => result.current.play());

  expect(model.players[1].play).toHaveBeenCalledWith(expect.anything(), { offsetMs: 1_260 });
  expect(model.selectSlide).not.toHaveBeenCalled();
});

it('focuses the recoverable continue control after autoplay policy pauses narration', async () => {
  const controller = {
    status: 'preparing' as const,
    activeSlideId: 'slide-1', subtitle: '已恢复讲解', message: '正在准备讲解', error: null,
    play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), replaySlide: vi.fn(), goToSlide: vi.fn(),
    beginInterruption: vi.fn(), playFollowUpAnswer: vi.fn(), resumeAfterAnswer: vi.fn(), stop: vi.fn(),
  };
  const { rerender } = render(<ReportNarrationControls controller={controller} />);

  rerender(<ReportNarrationControls controller={{
    ...controller, status: 'paused', message: '浏览器已阻止自动播放，请继续讲解',
  }} />);

  await waitFor(() => expect(screen.getByRole('button', { name: '继续讲解' })).toHaveFocus());
});
