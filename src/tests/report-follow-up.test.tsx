import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSnapshot, FollowUpResponse, NarrationCursor } from '../../shared/report';
import type { VoiceErrorCode } from '../../shared/voice';
import { ReportFollowUp } from '../features/ai/report/ReportFollowUp';
import { ReportThinkingTime } from '../features/ai/report/ReportThinkingTime';
import { useReportFollowUp } from '../features/ai/report/useReportFollowUp';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const recognition = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  cancel: vi.fn(),
  status: 'idle' as const,
  confirmedText: '',
  interimText: '',
  elapsedMs: 0,
  errorCode: null as VoiceErrorCode | null,
}));

vi.mock('../features/ai/voice/useVoiceRecognition', () => ({
  useVoiceRecognition: () => recognition,
}));

const cursor: NarrationCursor = { slideId: 'slide-2', segmentId: 'segment-3', offsetMs: 1_260 };
const conversation: ConversationSnapshot = {
  originalQuestion: '分析总氮趋势',
  compactSummary: '',
  activeSlideId: 'slide-2',
  narrationCursor: cursor,
  turns: [],
};

function response(turnId: string, answer = '因为进水负荷增加。'): FollowUpResponse {
  return {
    turnId,
    answer,
    speechId: `speech-${turnId}`,
    citedEvidence: [{ key: 'tn', kind: 'metric', source: 'excel', label: '总氮', unit: 'mg/L' }],
    needsClarification: false,
    resumeCursor: cursor,
  };
}

function setup(overrides: Partial<Parameters<typeof useReportFollowUp>[0]> & { now?: () => number } = {}) {
  const followUp = vi.fn().mockResolvedValue(response('turn-1'));
  const narration = {
    beginInterruption: vi.fn(() => cursor),
    playFollowUpAnswer: vi.fn().mockResolvedValue('ended' as const),
    resumeAfterAnswer: vi.fn().mockResolvedValue(undefined),
  };
  const input: Parameters<typeof useReportFollowUp>[0] = {
    reportId: 'report-1',
    conversation,
    narration,
    followUp,
    createIdempotencyKey: vi.fn(() => 'intent-1'),
    ...overrides,
  };
  return { input, followUp, narration };
}

function renderFollowUp(
  overrides: Partial<Parameters<typeof useReportFollowUp>[0]> = {},
  componentOverrides: Record<string, unknown> = {},
) {
  const model = setup(overrides);
  render(
    <ReportFollowUp
      {...({
        ...model.input,
        initialQuestion: model.input.conversation.originalQuestion,
        initialAnswer: '初始回答',
        ...componentOverrides,
      } as any)}
    />,
  );
  return model;
}

function renderThinkingHarness(overrides: Partial<Parameters<typeof useReportFollowUp>[0]> = {}) {
  const model = setup(overrides);

  function Harness() {
    const hook = useReportFollowUp(model.input);
    return (
      <div>
        <button type="button" onClick={() => { void hook.submitText('可取消的问题'); }}>开始</button>
        <button type="button" onClick={() => hook.cancel()}>取消</button>
        <ol aria-label="测试追问记录">
          {hook.activeQuestion && <li>{hook.activeQuestion}</li>}
          {hook.activeQuestion && (
            <ReportThinkingTime
              pending={hook.pending}
              interrupted={!hook.pending && Boolean(hook.error)}
              startedAtMs={hook.activeThinkingStartedAtMs ?? undefined}
              durationMs={hook.failedThinkingDurationMs ?? undefined}
              now={model.input.now}
            />
          )}
        </ol>
      </div>
    );
  }

  return { ...model, ...render(<Harness />) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('submits typed text with the exact interruption cursor and one idempotency key', async () => {
  const model = setup();
  const { result } = renderHook(() => useReportFollowUp(model.input));

  act(() => result.current.startTyping());
  await act(async () => result.current.submitText('它为什么升高？'));

  expect(model.narration.beginInterruption).toHaveBeenCalledWith('typing');
  expect(model.followUp).toHaveBeenCalledWith('report-1', {
    question: '它为什么升高？',
    slideId: 'slide-2',
    interruptedSegmentId: 'segment-3',
    narrationOffsetMs: 1_260,
  }, 'intent-1', expect.any(AbortSignal));
});

it('treats repeated focus as one interruption until the current intent is submitted', () => {
  const model = setup();
  const { result } = renderHook(() => useReportFollowUp(model.input));

  act(() => {
    result.current.startTyping();
    result.current.startTyping();
  });

  expect(model.narration.beginInterruption).toHaveBeenCalledTimes(1);
  expect(model.narration.beginInterruption).toHaveBeenCalledWith('typing');
});

it('keeps only the latest rapid question even when the older transport ignores abort', async () => {
  const older = deferred<FollowUpResponse>();
  const newer = deferred<FollowUpResponse>();
  const followUp = vi.fn()
    .mockImplementationOnce(() => older.promise)
    .mockImplementationOnce(() => newer.promise);
  const model = setup({ followUp, createIdempotencyKey: vi.fn()
    .mockReturnValueOnce('intent-old')
    .mockReturnValueOnce('intent-new') });
  const { result } = renderHook(() => useReportFollowUp(model.input));

  let oldRequest!: Promise<void>;
  let newRequest!: Promise<void>;
  act(() => { oldRequest = result.current.submitText('旧问题'); });
  act(() => { newRequest = result.current.submitText('新问题'); });
  await act(async () => { newer.resolve(response('turn-new', '新回答')); await newRequest; });
  await act(async () => { older.resolve(response('turn-old', '旧回答')); await oldRequest; });

  expect(result.current.history.at(-1)).toMatchObject({ question: '新问题', answer: '新回答' });
  expect(result.current.history).not.toEqual(expect.arrayContaining([expect.objectContaining({ answer: '旧回答' })]));
});

it('retries a failed intent with the same idempotency key', async () => {
  const followUp = vi.fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(response('turn-retry'));
  const model = setup({ followUp });
  const { result } = renderHook(() => useReportFollowUp(model.input));

  await act(async () => result.current.submitText('请重试'));
  expect(result.current.error).not.toBeNull();
  await act(async () => result.current.retry());

  expect(followUp).toHaveBeenCalledTimes(2);
  expect(followUp.mock.calls[0]?.[2]).toBe('intent-1');
  expect(followUp.mock.calls[1]?.[2]).toBe('intent-1');
  expect(followUp.mock.calls[1]?.[1]).toEqual(followUp.mock.calls[0]?.[1]);
  expect(followUp.mock.calls[1]?.[1]).toMatchObject({
    slideId: cursor.slideId, interruptedSegmentId: cursor.segmentId, narrationOffsetMs: cursor.offsetMs,
  });
});

it('restores the shared conversation history without creating a new turn', async () => {
  const restored = {
    ...conversation,
    turns: [{
      id: 'turn-restored', question: '已保存的问题', answer: '已保存的回答', citedEvidence: [],
      needsClarification: false,
      createdAt: '2026-08-12T00:00:00.000Z',
    }],
  };
  const model = setup({ conversation: restored });
  const { result } = renderHook(() => useReportFollowUp(model.input));

  await waitFor(() => expect(result.current.history).toEqual(restored.turns));
  expect(model.followUp).not.toHaveBeenCalled();
});

it('aborts the active follow-up request on unmount', async () => {
  let requestSignal!: AbortSignal;
  const followUp = vi.fn((_reportId, _request, _key, signal: AbortSignal) => {
    requestSignal = signal;
    return new Promise<FollowUpResponse>(() => undefined);
  });
  const model = setup({ followUp });
  const { result, unmount } = renderHook(() => useReportFollowUp(model.input));

  act(() => { void result.current.submitText('等待中的问题'); });
  await waitFor(() => expect(requestSignal).toBeDefined());
  unmount();

  expect(requestSignal.aborted).toBe(true);
});

it('cleans up the pending timer on unmount without leaving active timers or visible thinking rows', async () => {
  vi.useFakeTimers();
  let now = 1_000;
  const followUp = vi.fn(() => new Promise<FollowUpResponse>(() => undefined));
  const model = setup({ now: () => now, followUp });
  const { unmount, container } = render(
    <ReportFollowUp
      {...model.input}
      initialQuestion={model.input.conversation.originalQuestion}
      initialAnswer="初始回答"
    />,
  );

  fireEvent.change(screen.getByRole('textbox', { name: '输入追问' }), { target: { value: '等待卸载的问题' } });
  fireEvent.click(screen.getByRole('button', { name: '发送追问' }));
  expect(screen.getByText('思考 1s ›')).toBeVisible();
  expect(vi.getTimerCount()).toBeGreaterThan(0);

  unmount();
  expect(container).toBeEmptyDOMElement();
  expect(vi.getTimerCount()).toBe(0);

  now = 5_000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000);
  });
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByText('思考 5s ›')).toBeNull();
});

it('accepts a follow-up response submitted after the StrictMode effect replay', async () => {
  const model = setup();
  const { result } = renderHook(() => useReportFollowUp(model.input), { reactStrictMode: true });

  await act(async () => result.current.submitText('严格模式问题'));

  await waitFor(() => expect(result.current.history).toEqual([
    expect.objectContaining({ question: '严格模式问题', answer: '因为进水负荷增加。' }),
  ]));
  expect(model.narration.playFollowUpAnswer).toHaveBeenCalledWith('speech-turn-1');
});

it('shows the submitted user question in visible history while the follow-up request is still pending', async () => {
  const user = userEvent.setup();
  renderFollowUp({
    followUp: vi.fn(() => new Promise<FollowUpResponse>(() => undefined)),
  });

  await user.type(screen.getByRole('textbox', { name: '输入追问' }), '新的追问');
  await user.click(screen.getByRole('button', { name: '发送追问' }));

  const history = screen.getByRole('list', { name: '追问记录' });
  expect(within(history).getByText('新的追问')).toBeVisible();
  expect(within(history).getByText('思考 1s ›')).toBeVisible();
  expect(within(history).getAllByText('AI 汇报')).toHaveLength(1);
});

it('advances the active thinking time once per second and freezes the completed duration', async () => {
  vi.useFakeTimers();
  let now = 1_000;
  const request = deferred<FollowUpResponse>();
  renderFollowUp({
    now: () => now,
    followUp: vi.fn(() => request.promise),
  });

  const textbox = screen.getByRole('textbox', { name: '输入追问' });
  fireEvent.change(textbox, { target: { value: '新的追问' } });
  fireEvent.click(screen.getByRole('button', { name: '发送追问' }));

  const history = screen.getByRole('list', { name: '追问记录' });
  expect(within(history).getByText('思考 1s ›')).toBeVisible();

  now = 2_000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(within(history).getByText('思考 2s ›')).toBeVisible();

  now = 2_500;
  await act(async () => {
    request.resolve(response('turn-live'));
    await request.promise;
  });
  expect(within(history).getByText('思考 2s ›')).toBeVisible();

  now = 9_000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(within(history).getByText('思考 2s ›')).toBeVisible();
});

it('keeps the live announcement stable while the visible timer ticks and does not announce completed history rows', async () => {
  vi.useFakeTimers();
  let now = 1_000;
  const { rerender } = render(
    <ol aria-label="计时记录">
      <ReportThinkingTime pending startedAtMs={1_000} now={() => now} />
    </ol>,
  );

  const pendingRow = screen.getByText('思考 1s ›').closest('li');
  expect(pendingRow).not.toBeNull();
  expect(pendingRow?.querySelector('[aria-hidden="true"]')).toHaveTextContent('思考 1s ›');
  expect(screen.getByRole('status')).toHaveTextContent('AI 正在思考');

  now = 2_000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screen.getByText('思考 2s ›')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('AI 正在思考');

  rerender(
    <ol aria-label="计时记录">
      <ReportThinkingTime durationMs={2_400} now={() => now} />
    </ol>,
  );
  expect(screen.getByText('思考 2s ›')).toBeVisible();
  expect(screen.queryByRole('status')).toBeNull();
});

it('keeps the submitted user question visible with the error and retry action after a failed request', async () => {
  const user = userEvent.setup();
  renderFollowUp({ followUp: vi.fn().mockRejectedValue(new Error('offline')) });

  await user.type(screen.getByRole('textbox', { name: '输入追问' }), '失败后仍需保留的问题');
  await user.click(screen.getByRole('button', { name: '发送追问' }));

  const history = screen.getByRole('list', { name: '追问记录' });
  const alert = await screen.findByRole('alert');
  expect(within(history).getByText('失败后仍需保留的问题')).toBeVisible();
  expect(within(history).getByText(/思考中断 · \d+s/)).toBeVisible();
  expect(alert).toHaveTextContent('汇报服务暂时不可用，请稍后重试。');
  expect(within(alert).getByRole('button', { name: '重试' })).toBeVisible();
});

it('restarts retry thinking at 1 second immediately and advances from the new clock', async () => {
  vi.useFakeTimers();
  let now = 1_000;
  const first = deferred<FollowUpResponse>();
  const second = deferred<FollowUpResponse>();
  const followUp = vi.fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  renderFollowUp({
    now: () => now,
    followUp,
  });

  fireEvent.change(screen.getByRole('textbox', { name: '输入追问' }), { target: { value: '失败后重试的问题' } });
  fireEvent.click(screen.getByRole('button', { name: '发送追问' }));

  const history = screen.getByRole('list', { name: '追问记录' });
  expect(within(history).getByText('思考 1s ›')).toBeVisible();

  now = 4_000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(within(history).getByText('思考 4s ›')).toBeVisible();

  now = 4_500;
  await act(async () => {
    first.reject(new Error('offline'));
    await first.promise.catch(() => undefined);
  });

  const alert = screen.getByRole('alert');
  expect(within(history).getByText('思考中断 · 4s')).toBeVisible();

  now = 8_000;
  fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
  expect(within(history).queryByText('思考中断 · 4s')).toBeNull();
  expect(within(history).getByText('思考 1s ›')).toBeVisible();

  now = 9_000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(within(history).getByText('思考 2s ›')).toBeVisible();
});

it('clears the active thinking row on cancel and stops future timer-driven updates', async () => {
  vi.useFakeTimers();
  let now = 1_000;
  const followUp = vi.fn(() => new Promise<FollowUpResponse>(() => undefined));
  renderThinkingHarness({
    now: () => now,
    followUp,
  });

  fireEvent.click(screen.getByRole('button', { name: '开始' }));
  const history = screen.getByRole('list', { name: '测试追问记录' });
  expect(within(history).getByText('思考 1s ›')).toBeVisible();
  expect(followUp).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(within(history).queryByText('可取消的问题')).toBeNull();
  expect(within(history).queryByText(/思考 \d+s ›/)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);

  now = 4_000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(within(history).queryByText('思考 4s ›')).toBeNull();
});

it('stores the elapsed request duration on the completed local turn', async () => {
  let now = 1_000;
  const model = setup({ now: () => now });
  const { result } = renderHook(() => useReportFollowUp(model.input));
  let request!: Promise<void>;

  act(() => { request = result.current.submitText('耗时问题'); });
  now = 23_400;
  await act(async () => request);

  expect(result.current.history[0]?.thinkingDurationMs).toBe(22_400);
});

it('keeps completed thinking durations nonnegative when the clock moves backward', async () => {
  let now = 23_400;
  const model = setup({ now: () => now });
  const { result } = renderHook(() => useReportFollowUp(model.input));
  let request!: Promise<void>;

  act(() => { request = result.current.submitText('倒退时钟问题'); });
  now = 1_000;
  await act(async () => request);

  expect(result.current.history[0]?.thinkingDurationMs).toBe(0);
});

it('renders the completed thinking duration between the user and AI messages', () => {
  renderFollowUp({
    conversation: {
      ...conversation,
      turns: [{
        id: 'turn-timed', question: '耗时问题', answer: '耗时回答', citedEvidence: [],
        needsClarification: false, createdAt: '2026-08-22T00:00:00.000Z', thinkingDurationMs: 22_400,
      }],
    },
  });

  const history = screen.getByRole('list', { name: '追问记录' });
  expect(within(history).getByText('思考 22s ›')).toBeVisible();
  const items = [...history.querySelectorAll(':scope > li')];
  expect(items.map((item) => item.textContent)).toEqual(expect.arrayContaining([
    expect.stringContaining('耗时问题'),
    '思考 22s ›',
    expect.stringContaining('耗时回答'),
  ]));
  expect(items.findIndex((item) => item.textContent?.includes('耗时问题'))).toBeLessThan(
    items.findIndex((item) => item.textContent === '思考 22s ›'),
  );
  expect(items.findIndex((item) => item.textContent === '思考 22s ›')).toBeLessThan(
    items.findIndex((item) => item.textContent?.includes('耗时回答')),
  );
});

it('uses icon buttons with accessible names inside the composer action row', () => {
  renderFollowUp();

  const voiceButton = screen.getByRole('button', { name: '语音追问' });
  const sendButton = screen.getByRole('button', { name: '发送追问' });
  expect(voiceButton.querySelector('.report-conversation__icon--microphone')).not.toBeNull();
  expect(sendButton.querySelector('.report-conversation__icon--send')).not.toBeNull();
  expect(voiceButton).toHaveAttribute('title', '语音追问');
  expect(sendButton).toHaveAttribute('title', '发送追问');
  expect(document.querySelector('.report-conversation__composer-actions')).not.toBeNull();
});

it('keeps injected report controls on the left and question controls on the right', () => {
  renderFollowUp({}, {
    leadingControls: (
      <div className="report-conversation__leading-controls">
        <button type="button" aria-label="上一页" title="上一页"><svg /></button>
      </div>
    ),
  });

  const toolbar = document.querySelector('.report-conversation__composer-toolbar');
  expect(toolbar).not.toBeNull();
  expect(toolbar?.firstElementChild).toHaveClass('report-conversation__leading-controls');
  expect(toolbar?.lastElementChild).toHaveClass('report-conversation__composer-actions');
});

it('auto-scrolls new conversation entries when the feed was near the bottom', async () => {
  const user = userEvent.setup();
  renderFollowUp({
    followUp: vi.fn(() => new Promise<FollowUpResponse>(() => undefined)),
  });
  const feed = screen.getByRole('list', { name: '追问记录' });
  let scrollHeight = 300;
  Object.defineProperties(feed, {
    clientHeight: { configurable: true, get: () => 100 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  });
  feed.scrollTop = 160;
  fireEvent.scroll(feed);

  scrollHeight = 400;
  await user.type(screen.getByRole('textbox', { name: '输入追问' }), '靠近底部的新问题');
  await user.click(screen.getByRole('button', { name: '发送追问' }));

  await waitFor(() => expect(feed.scrollTop).toBe(400));
});

it('does not auto-scroll new conversation entries when the user has scrolled up', async () => {
  const user = userEvent.setup();
  renderFollowUp({
    followUp: vi.fn(() => new Promise<FollowUpResponse>(() => undefined)),
  });
  const feed = screen.getByRole('list', { name: '追问记录' });
  let scrollHeight = 300;
  Object.defineProperties(feed, {
    clientHeight: { configurable: true, get: () => 100 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  });
  feed.scrollTop = 151;
  fireEvent.scroll(feed);

  scrollHeight = 400;
  await user.type(screen.getByRole('textbox', { name: '输入追问' }), '浏览历史时的新问题');
  await user.click(screen.getByRole('button', { name: '发送追问' }));

  await waitFor(() => expect(within(feed).getByText('浏览历史时的新问题')).toBeVisible());
  expect(feed.scrollTop).toBe(151);
});

it('merges local and authoritative turns per report across cursor updates without duplicates', async () => {
  const model = setup();
  const { result, rerender } = renderHook(
    ({ input }) => useReportFollowUp(input),
    { initialProps: { input: model.input } },
  );
  await act(async () => result.current.submitText('本地问题'));
  expect(result.current.history).toEqual([
    expect.objectContaining({ id: 'turn-1', question: '本地问题' }),
  ]);

  rerender({
    input: {
      ...model.input,
      conversation: { ...conversation, narrationCursor: { ...cursor, offsetMs: 1_500 } },
    },
  });
  expect(result.current.history).toEqual([
    expect.objectContaining({ id: 'turn-1', question: '本地问题' }),
  ]);
  const localDuration = result.current.history[0]?.thinkingDurationMs;

  const authoritativeTurn = {
    id: 'turn-1', question: '本地问题', answer: '因为进水负荷增加。', citedEvidence: [],
    needsClarification: false,
    createdAt: '2026-08-12T00:00:00.000Z',
  };
  rerender({
    input: {
      ...model.input,
      conversation: { ...conversation, turns: [authoritativeTurn], narrationCursor: { ...cursor, offsetMs: 1_800 } },
    },
  });
  expect(result.current.history).toEqual([
    { ...authoritativeTurn, thinkingDurationMs: localDuration },
  ]);

  const otherTurn = {
    id: 'turn-other', question: '另一份报告', answer: '另一份回答', citedEvidence: [],
    needsClarification: false,
    createdAt: '2026-08-12T01:00:00.000Z',
  };
  rerender({
    input: {
      ...model.input,
      reportId: 'report-2',
      conversation: {
        originalQuestion: conversation.originalQuestion,
        compactSummary: conversation.compactSummary,
        activeSlideId: conversation.activeSlideId,
        turns: [otherTurn],
      },
    },
  });
  expect(result.current.history).toEqual([otherTurn]);

  await act(async () => result.current.submitText('新报告问题'));
  expect(model.narration.beginInterruption).toHaveBeenCalledWith('typing');
});
