import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import type { BoundMetric, ReportJobSnapshot, ReportSlide, SlideOutline } from '../../shared/report';
import { ReportClientError } from '../features/ai/report/report-api';
import type { NarrationStatus } from '../features/ai/report/useNarrationController';
import { reduceReportEvent, type ReportSession } from '../features/ai/report/useReportSession';
import { ReportWorkspace } from '../features/ai/report/ReportWorkspace';

const narration = vi.hoisted(() => ({
  status: 'paused' as NarrationStatus,
  subtitle: '第一段。',
  message: '正在讲解第 1 页',
  error: null,
  play: vi.fn(),
  pause: vi.fn(),
  replaySlide: vi.fn(),
  goToSlide: vi.fn(),
  beginInterruption: vi.fn(),
  playFollowUpAnswer: vi.fn(),
  resumeAfterAnswer: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../features/ai/report/useNarrationController', () => ({
  useNarrationController: (input: { slides: ReportSlide[]; activeSlideId?: string; selectSlide(slideId: string): void }) => ({
    ...narration,
    canNarrate: input.slides.some(({ supersededBySlideId }) => supersededBySlideId === undefined),
    activeSlideId: input.activeSlideId ?? 'slide-1',
    goToSlide: (slideId: string) => {
      narration.goToSlide(slideId);
      input.selectSlide(slideId);
    },
  }),
}));

const metric = (key: string, label: string, value: number): BoundMetric => ({
  key, kind: 'metric', source: 'excel', snapshotId: 'snapshot-1', module: 'water-quality', label, unit: 'mg/L', claimIds: ['claim-1'], value,
});

function slide(id: string, order: number, title: string): ReportSlide {
  const bound = metric(`metric-${id}`, `运行指标 ${order + 1}`, order + 2.4);
  return {
    id,
    order,
    evidenceSnapshotId: 'snapshot-1', role: 'answer', layout: 'visual-focus', evidencePolicy: 'data',
    title,
    takeaway: `${title}保持稳定。`,
    takeawayClaimIds: ['claim-1'],
    claims: [{ id: 'claim-1', text: `${title}保持稳定。`, kind: 'onsite-fact', evidenceRefs: [bound] }],
    visual: { kind: 'kpi-grid', metrics: [bound] },
    metrics: [bound],
    evidenceRefs: [bound],
    narration: [
      { id: `${id}-segment-1`, text: '第一段。', speechId: `${id}-speech-1`, claimIds: ['claim-1'] },
      { id: `${id}-segment-2`, text: '第二段。', speechId: `${id}-speech-2`, claimIds: ['claim-1'] },
    ],
  };
}

function outline(id: string, order: number, title: string, status: SlideOutline['status'], retryable?: boolean): SlideOutline {
  return { id, order, title, purpose: `说明${title}`, role: 'answer', layout: 'visual-focus', evidencePolicy: 'data', visualKind: 'kpi-grid', evidenceKeys: [`metric-${id}`], status, retryable };
}

function snapshot(overrides: Partial<ReportJobSnapshot> = {}): ReportJobSnapshot {
  const slides = [slide('slide-1', 0, '总氮趋势'), slide('slide-2', 1, '能耗对比')];
  return {
    reportId: 'report-1',
    question: '分析水厂运行状态',
    originPage: 'water-quality',
    scope: { modules: ['water-quality'], metrics: ['tn'], dateRange: { from: '2026-07-01', to: '2026-07-31' }, sampleCount: 31, granularity: 'daily' },
    status: 'ready',
    phase: 'completed',
    clarification: null,
    outline: [outline('slide-1', 0, '总氮趋势', 'ready'), outline('slide-2', 1, '能耗对比', 'ready')],
    slides,
    conversation: { originalQuestion: '分析水厂运行状态', turns: [], compactSummary: '', activeSlideId: 'slide-1' },
    createdAt: '2026-08-12T00:00:00.000Z',
    expiresAt: '2026-08-12T01:00:00.000Z',
    lastSequence: 4,
    ...overrides,
  };
}

function session(snapshotValue: ReportJobSnapshot | null, overrides: Partial<ReportSession> = {}): ReportSession {
  return {
    snapshot: snapshotValue,
    phase: snapshotValue ? 'ready' : 'creating',
    error: null,
    selectSlide: vi.fn(),
    setNarrationCursor: vi.fn(),
    retryConnection: vi.fn(),
    retrySlide: vi.fn().mockResolvedValue(undefined),
    submitClarification: vi.fn().mockResolvedValue(undefined),
    exit: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('uses the same ready slide template outside the semantic thumbnail selection button', async () => {
  const user = userEvent.setup();
  const model = session(snapshot());
  const { container } = render(<ReportWorkspace session={model} />);

  expect(screen.getAllByText('总氮趋势')).toHaveLength(2);
  const firstSelection = screen.getByRole('button', { name: '第 1 页，总氮趋势，已完成' });
  expect(firstSelection).toBeEnabled();
  expect(firstSelection.querySelector('section, header')).toBeNull();
  expect(screen.getByRole('region', { name: '当前汇报页' })).toHaveAttribute('data-slide-mode', 'canvas');
  expect(container.querySelector('[data-slide-mode="thumbnail"]')?.closest('button')).toBeNull();

  await user.click(screen.getByRole('button', { name: '第 2 页，能耗对比，已完成' }));
  expect(model.selectSlide).toHaveBeenCalledWith('slide-2');
});

it('labels a superseded page, defaults to its correction, and keeps the old thumbnail inspectable', async () => {
  const user = userEvent.setup();
  const oldSlide = { ...slide('slide-1', 0, '旧结论'), supersededBySlideId: 'slide-2' };
  const correctionSlide = slide('slide-2', 1, '纠正说明');
  const corrected = snapshot({
    outline: [outline('slide-1', 0, '旧结论', 'ready'), outline('slide-2', 1, '纠正说明', 'ready')],
    slides: [oldSlide, correctionSlide],
    conversation: {
      originalQuestion: '分析水厂运行状态', turns: [], compactSummary: '', activeSlideId: 'slide-1',
      narrationCursor: { slideId: 'slide-1', segmentId: 'slide-1-segment-1', offsetMs: 800 },
    },
  });

  const model = session(corrected);
  render(<ReportWorkspace session={model} />);

  expect(screen.getByRole('button', { name: '第 1 页，旧结论，已被更正' })).toBeEnabled();
  expect(screen.getAllByText('本页结论已被更正').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByRole('region', { name: '当前汇报页' })).toHaveTextContent('纠正说明');
  expect(screen.getByRole('region', { name: '当前汇报页' })).not.toHaveTextContent('旧结论');

  await user.click(screen.getByRole('button', { name: '第 1 页，旧结论，已被更正' }));
  expect(screen.getByRole('region', { name: '当前汇报页' })).toHaveTextContent('旧结论');
  expect(screen.getByRole('region', { name: '当前汇报页' })).toHaveTextContent('本页结论已被更正');
  expect(narration.goToSlide).not.toHaveBeenCalledWith('slide-1');
  expect(screen.getByRole('button', { name: '查看更正页' })).toBeEnabled();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: '旧结论' }));
});

it('pages over the playable A to B to C sequence while retaining audit thumbnails', async () => {
  const user = userEvent.setup();
  const a = { ...slide('slide-a', 0, '结论 A'), supersededBySlideId: 'slide-b' };
  const b = { ...slide('slide-b', 1, '结论 B'), supersededBySlideId: 'slide-c' };
  const c = slide('slide-c', 2, '最终纠正 C');
  const current = snapshot({
    outline: [
      outline(a.id, a.order, a.title, 'ready'),
      outline(b.id, b.order, b.title, 'ready'),
      outline(c.id, c.order, c.title, 'ready'),
    ],
    slides: [a, b, c],
    conversation: { originalQuestion: '分析', turns: [], compactSummary: '', activeSlideId: a.id },
  });
  render(<ReportWorkspace session={session(current)} />);

  expect(screen.getByRole('region', { name: '当前汇报页' })).toHaveTextContent('最终纠正 C');
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();

  await user.click(screen.getByRole('button', { name: '第 1 页，结论 A，已被更正' }));
  expect(screen.getByRole('region', { name: '当前汇报页' })).toHaveTextContent('结论 A');
  await user.click(screen.getByRole('button', { name: '查看更正页' }));
  expect(narration.goToSlide).toHaveBeenLastCalledWith('slide-c');
});

it('shows an explicit no-current-page state and disables narration for malformed all-superseded pages', () => {
  const broken = snapshot({
    slides: [
      { ...slide('slide-1', 0, '无效页一'), supersededBySlideId: 'missing-a' },
      { ...slide('slide-2', 1, '无效页二'), supersededBySlideId: 'missing-b' },
    ],
  });
  render(<ReportWorkspace session={session(broken)} />);

  expect(screen.getByText('当前没有可播放的有效页面')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '当前汇报页' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '播放讲解' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '重播本页' })).toBeDisabled();
});

it('does not activate a generating thumbnail', async () => {
  const user = userEvent.setup();
  const current = snapshot({
    status: 'generating',
    outline: [outline('slide-1', 0, '总氮趋势', 'ready'), outline('slide-2', 1, '能耗对比', 'generating')],
    slides: [slide('slide-1', 0, '总氮趋势')],
  });
  const model = session(current);
  render(<ReportWorkspace session={model} />);

  const generating = screen.getByRole('button', { name: '第 2 页，能耗对比，生成中' });
  await user.click(generating);
  generating.focus();
  await user.keyboard('{Enter}{Space}');
  expect(model.selectSlide).not.toHaveBeenCalled();
  expect(generating).toHaveAttribute('aria-disabled', 'true');
  expect(generating).not.toBeDisabled();
  expect(generating).toHaveFocus();
  expect(generating).toHaveTextContent('生成中');
  expect(generating).not.toHaveTextContent('%');
});

it('retries a retryable failed slide only once and disables the control while accepted', async () => {
  const user = userEvent.setup();
  let resolveRetry!: () => void;
  const pendingRetry = new Promise<void>((resolve) => { resolveRetry = resolve; });
  const current = snapshot({
    status: 'partial',
    outline: [outline('slide-1', 0, '总氮趋势', 'ready'), outline('slide-2', 1, '能耗对比', 'failed', true)],
    slides: [slide('slide-1', 0, '总氮趋势')],
  });
  const model = session(current, { retrySlide: vi.fn(() => pendingRetry) });
  render(<ReportWorkspace session={model} />);

  const retry = screen.getByRole('button', { name: '重试第 2 页' });
  await user.click(retry);
  expect(model.retrySlide).toHaveBeenCalledWith('slide-2');
  expect(retry).toBeDisabled();
  await user.click(retry);
  expect(model.retrySlide).toHaveBeenCalledTimes(1);
  resolveRetry();
});

it('keeps a failed slide retry error local, visible and retryable', async () => {
  const user = userEvent.setup();
  const current = snapshot({
    status: 'partial',
    outline: [outline('slide-1', 0, '总氮趋势', 'ready'), outline('slide-2', 1, '能耗对比', 'failed', true)],
    slides: [slide('slide-1', 0, '总氮趋势')],
  });
  const retrySlide = vi.fn().mockRejectedValue(new ReportClientError('UPSTREAM_HTTP'));
  render(<ReportWorkspace session={session(current, { retrySlide })} />);

  const retry = screen.getByRole('button', { name: '重试第 2 页' });
  await user.click(retry);
  expect(await screen.findByRole('alert')).toHaveTextContent('汇报服务暂时不可用');
  expect(retry).toBeEnabled();
  expect(screen.getByRole('region', { name: '当前汇报页' })).toHaveTextContent('总氮趋势');

  await user.click(retry);
  expect(retrySlide).toHaveBeenCalledTimes(2);
});

it('keeps the ready page visible with local retry after the correct partial event sequence', () => {
  const generating = snapshot({
    status: 'generating',
    phase: 'generating-slides',
    outline: [outline('slide-1', 0, '总氮趋势', 'ready'), outline('slide-2', 1, '能耗对比', 'generating')],
    slides: [slide('slide-1', 0, '总氮趋势')],
    lastSequence: 4,
  });
  const failedPage = reduceReportEvent(generating, {
    type: 'slide.failed', sequence: 5, slideId: 'slide-2', retryable: true,
  });
  const partial = reduceReportEvent(failedPage, {
    type: 'report.completed', sequence: 6, status: 'partial',
  });

  render(<ReportWorkspace session={session(partial)} />);

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: '当前汇报页' })).toHaveTextContent('总氮趋势');
  expect(screen.getByText('生成失败')).toBeVisible();
  expect(screen.getByRole('button', { name: '重试第 2 页' })).toBeEnabled();
});

it('marks the playing page as current and preserves native keyboard activation', async () => {
  const user = userEvent.setup();
  const model = session(snapshot(), { playingSlideId: 'slide-2' });
  render(<ReportWorkspace session={model} />);

  const playing = screen.getByRole('button', { name: '第 2 页，能耗对比，正在讲解' });
  expect(playing).toHaveAttribute('aria-current', 'page');
  playing.focus();
  await user.keyboard('{Enter}');
  expect(model.selectSlide).toHaveBeenCalledWith('slide-2');
});

it('keeps previous and next controls within ready-page bounds and focuses the new canvas', async () => {
  const user = userEvent.setup();
  const first = session(snapshot());
  const { rerender } = render(<ReportWorkspace session={first} />);

  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '下一页' }));
  expect(first.selectSlide).toHaveBeenCalledWith('slide-2');

  const secondSnapshot = snapshot({ conversation: { originalQuestion: '分析水厂运行状态', turns: [], compactSummary: '', activeSlideId: 'slide-2' } });
  rerender(<ReportWorkspace session={session(secondSnapshot)} />);
  await waitFor(() => expect(screen.getByRole('heading', { name: '能耗对比' })).toHaveFocus());
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled();
});

it('moves page and narration controls from the header into the composer toolbar', () => {
  const { container } = render(<ReportWorkspace session={session(snapshot())} />);
  const header = container.querySelector('.report-header');
  const toolbar = container.querySelector('.report-conversation__composer-toolbar');

  expect(header).not.toBeNull();
  expect(toolbar).not.toBeNull();
  expect(header?.querySelector('[aria-label="上一页"]')).toBeNull();
  expect(header?.querySelector('[aria-label="播放讲解"], [aria-label="继续讲解"]')).toBeNull();

  const labels = [...toolbar!.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
  expect(labels).toEqual(['上一页', '继续讲解', '重播本页', '停止讲解', '下一页', '语音追问', '发送追问']);
  for (const button of toolbar!.querySelectorAll('button')) {
    expect(button).toHaveAttribute('title', button.getAttribute('aria-label'));
    expect(button.querySelector('svg')).not.toBeNull();
  }
});

it('renders planned skeletons and accessible narration controls without fabricating progress', () => {
  const current = snapshot({
    status: 'generating',
    outline: [outline('slide-1', 0, '总氮趋势', 'ready'), outline('slide-2', 1, '能耗对比', 'planned')],
    slides: [slide('slide-1', 0, '总氮趋势')],
  });
  render(<ReportWorkspace session={session(current)} />);

  expect(screen.getByRole('button', { name: '第 2 页，能耗对比，等待生成' })).toHaveTextContent('等待生成');
  expect(screen.getByRole('region', { name: '讲解字幕' })).toHaveTextContent('第一段。');
  expect(screen.getByRole('button', { name: '继续讲解' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重播本页' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '停止讲解' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: '讲解字幕' })).toHaveTextContent('正在讲解第 1 页');
  expect(screen.getByRole('region', { name: '汇报对话区' })).toContainElement(
    screen.getByRole('textbox', { name: '输入追问' }),
  );
  expect(screen.getByRole('button', { name: '语音追问' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '发送追问' })).toBeDisabled();
  expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
});

it('renders the larger subtitle region without the old bottom control console', () => {
  const previousStatus: NarrationStatus = narration.status;
  narration.status = 'completed' satisfies NarrationStatus;
  render(<ReportWorkspace session={session(snapshot())} />);

  const subtitle = screen.getByRole('region', { name: '讲解字幕' });
  expect(subtitle).toHaveTextContent('第一段。');
  expect(subtitle.querySelector('button')).toBeNull();
  expect(screen.getByRole('button', { name: '播放讲解' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页' })).toBeInTheDocument();
  narration.status = previousStatus;
});

it('does not render placeholder copy when the narration subtitle is empty', () => {
  const previousSubtitle = narration.subtitle;
  narration.subtitle = '';
  render(<ReportWorkspace session={session(snapshot())} />);

  expect(screen.getByRole('region', { name: '讲解字幕' })).not.toHaveTextContent('等待讲解字幕');
  narration.subtitle = previousSubtitle;
});

it('places the conversation beside the canvas and keeps the subtitle separate', () => {
  const { container, rerender } = render(<ReportWorkspace session={session(snapshot())} />);

  expect(container.querySelector('.report-workspace__chat')).toBeInTheDocument();
  expect(container.querySelector('.report-workspace__canvas')).toBeInTheDocument();
  expect(container.querySelector('.report-subtitle-bar')).toBeInTheDocument();
  expect(container.querySelector('.report-workspace__controls')).toBeNull();

  rerender(<ReportWorkspace session={session(null)} />);
  expect(container.querySelector('.report-workspace__chat')).toBeInTheDocument();
});

it('renders the original question and the first report takeaway in the conversation panel', () => {
  render(<ReportWorkspace session={session(snapshot())} />);

  const conversation = screen.getByRole('region', { name: '汇报对话区' });
  const history = screen.getByRole('list', { name: '追问记录' });
  expect(conversation).toHaveTextContent('分析水厂运行状态');
  expect(conversation).toHaveTextContent('总氮趋势保持稳定。');
  expect(within(history).getByRole('listitem', { name: '用户消息' })).toHaveTextContent('分析水厂运行状态');
  expect(within(history).getByRole('listitem', { name: 'AI 消息' })).toHaveTextContent('总氮趋势保持稳定。');
  expect(history.querySelector('.report-conversation__role')).toBeNull();
  expect(within(history).queryByText('你', { exact: true })).not.toBeInTheDocument();
  expect(within(history).queryByText('AI 汇报', { exact: true })).not.toBeInTheDocument();
});

it('uses the first valid playable slide takeaway for the initial AI conversation message', () => {
  const superseded = {
    ...slide('slide-1', 0, '过期结论'),
    takeaway: '过期结论不应进入对话。',
    supersededBySlideId: 'slide-2',
  };
  const playable = {
    ...slide('slide-2', 1, '当前结论'),
    takeaway: '当前有效结论进入对话。',
  };
  const current = snapshot({
    slides: [superseded, playable],
    outline: [
      outline(superseded.id, superseded.order, superseded.title, 'ready'),
      outline(playable.id, playable.order, playable.title, 'ready'),
    ],
    conversation: { originalQuestion: '分析水厂运行状态', turns: [], compactSummary: '', activeSlideId: superseded.id },
  });

  render(<ReportWorkspace session={session(current)} />);

  const conversation = screen.getByRole('region', { name: '汇报对话区' });
  expect(conversation).toHaveTextContent('当前有效结论进入对话。');
  expect(conversation).not.toHaveTextContent('过期结论不应进入对话。');
});

it('shows the generating state as the first AI message before a slide exists', () => {
  const current = snapshot({ status: 'generating', phase: 'planning', slides: [], outline: [] });
  render(<ReportWorkspace session={session(current)} />);

  expect(screen.getByRole('region', { name: '汇报对话区' })).toHaveTextContent('正在生成汇报');
  expect(screen.getByRole('region', { name: '汇报生成状态' })).toBeInTheDocument();
});

it('shows a clarification-pending label instead of unavailable when awaiting clarification has no playable slide', () => {
  const current = snapshot({
    status: 'awaiting-clarification',
    phase: null,
    slides: [{ ...slide('slide-1', 0, '过期结论'), supersededBySlideId: 'missing-correction' }],
    outline: [outline('slide-1', 0, '过期结论', 'ready')],
    clarification: {
      clarificationId: 'clarification-1',
      prompt: '请说明您要分析的指标。',
      reason: 'ambiguous-subject',
      suggestions: ['总氮'],
    },
    conversation: { originalQuestion: '分析水厂运行状态', turns: [], compactSummary: '', activeSlideId: 'slide-1' },
  });

  render(<ReportWorkspace session={session(current)} />);

  expect(screen.getByRole('complementary', { name: '对话侧栏' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: '汇报对话区' })).toHaveTextContent('等待补充说明后生成汇报');
  expect(screen.getByRole('region', { name: '汇报对话区' })).not.toHaveTextContent('暂无有效汇报页');
  expect(screen.getByRole('heading', { name: '请说明您要分析的指标。' })).toBeVisible();
  expect(screen.getByRole('region', { name: '汇报生成状态' })).toBeInTheDocument();
});

it('keeps the conversation in waiting state when generating has no valid playable page yet', () => {
  const current = snapshot({
    status: 'generating',
    phase: 'planning',
    slides: [{ ...slide('slide-1', 0, '过期结论'), supersededBySlideId: 'missing-correction' }],
    outline: [outline('slide-1', 0, '过期结论', 'ready')],
    conversation: { originalQuestion: '分析水厂运行状态', turns: [], compactSummary: '', activeSlideId: 'slide-1' },
  });

  render(<ReportWorkspace session={session(current)} />);

  const conversation = screen.getByRole('region', { name: '汇报对话区' });
  expect(conversation).toHaveTextContent('正在生成汇报');
  expect(conversation).not.toHaveTextContent('过期结论保持稳定。');
  expect(screen.getByRole('region', { name: '汇报生成状态' })).toBeInTheDocument();
});

it('shows an explicit unavailable label instead of a blank initial AI item when ready has no valid playable page', () => {
  const current = snapshot({
    status: 'ready',
    phase: 'completed',
    slides: [{ ...slide('slide-1', 0, '过期结论'), supersededBySlideId: 'missing-correction' }],
    outline: [outline('slide-1', 0, '过期结论', 'ready')],
    conversation: { originalQuestion: '分析水厂运行状态', turns: [], compactSummary: '', activeSlideId: 'slide-1' },
  });

  render(<ReportWorkspace session={session(current)} />);

  const conversation = screen.getByRole('region', { name: '汇报对话区' });
  expect(conversation).toHaveTextContent('暂无有效汇报页');
  expect(conversation).not.toHaveTextContent('过期结论保持稳定。');
  expect(screen.getByText('当前没有可播放的有效页面')).toBeInTheDocument();
});

it('renders restored turns without removing the original conversation context', () => {
  const current = snapshot({
    conversation: {
      originalQuestion: '分析水厂运行状态', compactSummary: '', activeSlideId: 'slide-1',
      turns: [{
        id: 'turn-1', question: '此前的问题', answer: '此前的回答', citedEvidence: [],
        needsClarification: false, createdAt: '2026-08-12T00:00:00.000Z',
      }],
    },
  });
  render(<ReportWorkspace session={session(current)} />);

  expect(screen.getByRole('region', { name: '汇报对话区' })).toHaveTextContent('此前的问题');
  expect(screen.getByRole('region', { name: '汇报对话区' })).toHaveTextContent('此前的回答');
});

it('renders restored conversation turns in the shared follow-up history', () => {
  const restored = snapshot({
    conversation: {
      originalQuestion: '分析水厂运行状态', compactSummary: '', activeSlideId: 'slide-1',
      narrationCursor: { slideId: 'slide-1', segmentId: 'slide-1-segment-2', offsetMs: 800 },
      turns: [{
        id: 'turn-restored', question: '此前的问题', answer: '此前的回答', citedEvidence: [],
        needsClarification: false,
        createdAt: '2026-08-12T00:00:00.000Z',
      }],
    },
  });
  render(<ReportWorkspace session={session(restored)} />);

  expect(screen.getByRole('list', { name: '追问记录' })).toHaveTextContent('此前的问题');
  expect(screen.getByRole('list', { name: '追问记录' })).toHaveTextContent('此前的回答');
});

it('collapses and expands the conversation through an accessible narrow-screen toggle', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(max-width: 899px)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));

  render(<ReportWorkspace session={session(snapshot())} />);

  const toggle = screen.getByRole('button', { name: '展开对话区' });
  const controlledId = toggle.getAttribute('aria-controls');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(controlledId).toBeTruthy();
  expect(document.getElementById(controlledId!)).toHaveAttribute('hidden');
  expect(screen.queryByRole('region', { name: '汇报对话区' })).not.toBeInTheDocument();

  await user.click(toggle);

  expect(toggle).toHaveAccessibleName('收起对话区');
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(document.getElementById(controlledId!)).not.toHaveAttribute('hidden');
  expect(screen.getByRole('region', { name: '汇报对话区' })).toBeInTheDocument();

  await user.click(toggle);

  expect(toggle).toHaveAccessibleName('展开对话区');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(document.getElementById(controlledId!)).toHaveAttribute('hidden');
});

it('bypasses GSAP and exposes final motion state when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const { container } = render(<ReportWorkspace session={session(snapshot())} />);

  expect(container.querySelector('[data-slide-motion-state="final"]')).not.toBeNull();
  expect(container.querySelector('[data-motion-reduced="true"]')).not.toBeNull();
});

it('keeps correction failure and retry stable under reduced motion without replaying republished ready pages', () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const source = slide('slide-1', 0, '原结论');
  const correction = slide('slide-2', 1, '纠正结论');
  const failed = snapshot({
    status: 'partial',
    phase: 'completed',
    outline: [
      outline(source.id, source.order, source.title, 'ready'),
      outline(correction.id, correction.order, correction.title, 'failed', true),
    ],
    slides: [source],
    conversation: {
      originalQuestion: '分析水厂运行状态', turns: [], compactSummary: '', activeSlideId: source.id,
    },
    lastSequence: 6,
  });
  const { rerender } = render(<ReportWorkspace session={session(failed)} />);
  expect(screen.getByRole('region', { name: '当前汇报页' })).toHaveAttribute('data-slide-id', source.id);

  const retrying = reduceReportEvent(failed, {
    type: 'slide.generating', sequence: 7, slideId: correction.id, order: correction.order,
  });
  const correctionReady = reduceReportEvent(retrying, {
    type: 'slide.ready', sequence: 8, slide: correction,
  });
  const sourceSuperseded = reduceReportEvent(correctionReady, {
    type: 'slide.ready', sequence: 9, slide: { ...source, supersededBySlideId: correction.id },
  });
  const completed = reduceReportEvent(sourceSuperseded, {
    type: 'report.completed', sequence: 10, status: 'ready',
  });

  rerender(<ReportWorkspace session={session(retrying)} />);
  rerender(<ReportWorkspace session={session(correctionReady)} />);
  expect(screen.getByRole('region', { name: '当前汇报页' })).toHaveAttribute('data-slide-id', source.id);
  rerender(<ReportWorkspace session={session(completed)} />);

  const correctedCanvas = screen.getByRole('region', { name: '当前汇报页' });
  expect(correctedCanvas).toHaveAttribute('data-slide-id', correction.id);
  expect(correctedCanvas).toHaveAttribute('data-slide-motion-state', 'final');
  expect(correctedCanvas).toHaveAttribute('data-motion-reduced', 'true');
  expect(screen.getByRole('button', { name: '第 1 页，原结论，已被更正' })).toBeVisible();

  const republished = reduceReportEvent(completed, {
    type: 'slide.ready', sequence: 11, slide: { ...correction },
  });
  rerender(<ReportWorkspace session={session(republished)} />);

  expect(screen.getByRole('region', { name: '当前汇报页' })).toBe(correctedCanvas);
  expect(correctedCanvas).toHaveAttribute('data-slide-motion-state', 'final');
});

it('preserves localized number formatting and units in the reduced-motion final state', () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const formatted = snapshot();
  const bound = metric('formatted', '累计处理量', 1234.5);
  formatted.slides[0] = { ...formatted.slides[0]!, metrics: [bound], evidenceRefs: [bound], visual: { kind: 'kpi-grid', metrics: [bound] } };
  render(<ReportWorkspace session={session(formatted)} />);

  expect(screen.getAllByText('1,234.5').length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText('mg/L').length).toBeGreaterThanOrEqual(2);
});

it('renders focused creation and restoration errors in the full workspace shell', () => {
  const creating = session(null, { phase: 'creating' });
  const { rerender } = render(<ReportWorkspace session={creating} />);
  expect(screen.getByRole('main', { name: 'AI 动态汇报工作区' })).toHaveTextContent('正在创建动态汇报');

  const error = new ReportClientError('REPORT_NOT_FOUND');
  rerender(<ReportWorkspace session={session(null, { phase: 'error', error })} />);
  expect(screen.getByRole('alert')).toHaveTextContent('汇报不存在或已过期');
  expect(screen.getByRole('button', { name: '返回 AI 提问' })).toBeInTheDocument();
});

it('shows the original launch question in the no-snapshot creating conversation shell', () => {
  render(<ReportWorkspace session={session(null, { phase: 'creating' })} launchQuestion="分析总氮趋势" />);

  const conversation = screen.getByRole('region', { name: '汇报对话区' });
  const history = screen.getByRole('list', { name: '追问记录' });
  expect(conversation).toHaveTextContent('分析总氮趋势');
  expect(conversation).toHaveTextContent('正在创建动态汇报');
  expect(within(history).getByRole('listitem', { name: '用户消息' })).toHaveTextContent('分析总氮趋势');
  expect(within(history).getByRole('listitem', { name: 'AI 消息' })).toHaveTextContent('正在创建动态汇报');
  expect(history.querySelector('.report-conversation__role')).toBeNull();
  expect(within(history).queryByText('你', { exact: true })).not.toBeInTheDocument();
  expect(within(history).queryByText('AI 汇报', { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '输入追问' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '语音追问' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '语音追问' })).toHaveAttribute('title', '语音追问');
  expect(screen.getByRole('button', { name: '发送追问' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '发送追问' })).toHaveAttribute('title', '发送追问');
});

it('switches a no-snapshot creation failure from pending to interrupted thinking', () => {
  const { rerender } = render(<ReportWorkspace
    session={session(null, { phase: 'creating' })}
    launchQuestion="分析总氮趋势"
  />);
  expect(screen.getByRole('list', { name: '追问记录' })).toHaveTextContent('思考 1s ›');

  const error = new ReportClientError('EMPTY_ANSWER');
  rerender(<ReportWorkspace
    session={session(null, { phase: 'error', error })}
    launchQuestion="分析总氮趋势"
  />);

  const history = screen.getByRole('list', { name: '追问记录' });
  expect(history).toHaveTextContent('思考中断');
  expect(history).not.toHaveTextContent('思考 1s ›');
});

it('preserves the initial thinking start across the creating shell to generating snapshot transition', () => {
  let now = 1_000;
  vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now);
  const { rerender } = render(
    <ReportWorkspace
      session={session(null, { phase: 'creating' })}
      launchQuestion="初始问题"
    />,
  );

  expect(screen.getByRole('list', { name: '追问记录' })).toHaveTextContent('思考 1s ›');

  now = 3_000;
  rerender(
    <ReportWorkspace
      session={session(snapshot({ status: 'generating', phase: 'planning', slides: [], outline: [] }))}
      launchQuestion="初始问题"
    />,
  );

  const history = screen.getByRole('list', { name: '追问记录' });
  expect(history).toHaveTextContent('思考 3s ›');
  expect(history).not.toHaveTextContent('思考 1s ›');
});

it('measures initial live report thinking from observed creation until the first playable slide', () => {
  let now = 1_000;
  vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now);
  const creatingSession = session(null, { phase: 'creating' });
  const generating = snapshot({ status: 'generating', phase: 'planning', slides: [], outline: [] });
  const ready = snapshot();
  const { rerender } = render(<ReportWorkspace session={creatingSession} launchQuestion="分析总氮趋势" />);

  expect(screen.getByRole('list', { name: '追问记录' })).toHaveTextContent('思考 1s ›');
  now = 5_000;
  rerender(<ReportWorkspace session={session(generating)} launchQuestion="分析总氮趋势" />);
  expect(screen.getByRole('list', { name: '追问记录' })).toHaveTextContent('思考 5s ›');

  now = 23_400;
  rerender(<ReportWorkspace session={session(ready)} launchQuestion="分析总氮趋势" />);

  const history = screen.getByRole('list', { name: '追问记录' });
  expect(history).toHaveTextContent('思考 22s ›');
  expect(history).toHaveTextContent('总氮趋势保持稳定。');
});

it('does not fabricate initial thinking duration for restored ready reports', () => {
  vi.spyOn(globalThis.performance, 'now').mockReturnValue(23_400);

  render(<ReportWorkspace session={session(snapshot())} />);

  expect(screen.getByRole('list', { name: '追问记录' })).not.toHaveTextContent(/思考 \d+s/u);
});

it.each([
  ['failed', new ReportClientError('EMPTY_ANSWER')],
  ['cancelled', new ReportClientError('REPORT_CANCELLED')],
] as const)('renders restored terminal %s snapshots as an actionable exit instead of generation', (status, error) => {
  const terminal = snapshot({
    status,
    phase: null,
    clarification: null,
    outline: [],
    slides: [],
    conversation: { originalQuestion: '分析水厂运行状态', turns: [], compactSummary: '' },
  });

  render(<ReportWorkspace session={session(terminal, { phase: 'error', error })} />);

  expect(screen.getByRole('alert')).toHaveTextContent(error.message);
  expect(screen.getByRole('button', { name: '返回 AI 提问' })).toBeInTheDocument();
  expect(screen.getByRole('list', { name: '追问记录' })).toHaveTextContent('思考中断');
  expect(screen.getByRole('list', { name: '追问记录' })).not.toHaveTextContent('思考 1s ›');
  expect(screen.queryByText('正在生成后续页面')).not.toBeInTheDocument();
});

it('renders the truthful server generation phase before any page is ready', () => {
  const initial = {
    ...snapshot(),
    status: 'generating',
    phase: 'understanding',
    clarification: null,
    outline: [],
    slides: [],
  } as ReportJobSnapshot;
  render(<ReportWorkspace session={session(initial)} />);

  expect(within(screen.getByRole('region', { name: '汇报生成状态' })).getByRole('status')).toHaveTextContent('正在理解问题');
  expect(screen.queryByText('实时数据快照')).not.toBeInTheDocument();
  expect(narration.play).not.toHaveBeenCalled();
});

it('does not present the empty bootstrap date sentinel as a real data range', () => {
  const empty = {
    ...snapshot(),
    status: 'generating',
    phase: 'understanding',
    scope: { modules: [], metrics: [], dateRange: { from: '1970-01-01', to: '1970-01-01' }, sampleCount: 0, granularity: 'daily' },
    outline: [],
    slides: [],
  } as ReportJobSnapshot;
  const { rerender } = render(<ReportWorkspace session={session(empty)} />);

  expect(screen.getByText('数据范围待确认')).toBeVisible();
  expect(screen.queryByText(/1970-01-01/)).not.toBeInTheDocument();

  rerender(<ReportWorkspace session={session(snapshot())} />);
  expect(screen.getByText('2026-07-01—2026-07-31')).toBeVisible();
});

it('submits the active clarification ID with the operator answer', async () => {
  const user = userEvent.setup();
  const submitClarification = vi.fn().mockResolvedValue(undefined);
  const awaiting = {
    ...snapshot(),
    status: 'awaiting-clarification',
    phase: null,
    clarification: {
      clarificationId: 'clarification-1',
      prompt: '请说明您要分析的指标。',
      reason: 'ambiguous-subject',
      suggestions: ['总氮'],
    },
    outline: [],
    slides: [],
  } as ReportJobSnapshot;
  render(<ReportWorkspace session={{ ...session(awaiting), submitClarification } as unknown as ReportSession} />);

  await user.type(screen.getByLabelText('补充说明'), '分析总氮');
  await user.click(screen.getByRole('button', { name: '继续分析' }));
  expect(submitClarification).toHaveBeenCalledWith('clarification-1', '分析总氮');
});

it.each(['resolve', 'reject'] as const)('resets clarification form state when B replaces pending A and A later %s', async (outcome) => {
  const user = userEvent.setup();
  let resolveA!: () => void;
  let rejectA!: (error: unknown) => void;
  const pendingA = new Promise<void>((resolve, reject) => { resolveA = resolve; rejectA = reject; });
  const submitClarification = vi.fn(() => pendingA);
  const clarificationSnapshot = (clarificationId: string, prompt: string): ReportJobSnapshot => ({
    ...snapshot(),
    status: 'awaiting-clarification',
    phase: null,
    clarification: { clarificationId, prompt, reason: 'ambiguous-subject', suggestions: [] },
    outline: [],
    slides: [],
    conversation: { originalQuestion: '分析水厂运行状态', turns: [], compactSummary: '' },
  });
  const { rerender } = render(<ReportWorkspace session={session(
    clarificationSnapshot('clarification-a', '请补充 A'),
    { submitClarification },
  )} />);

  await user.type(screen.getByLabelText('补充说明'), 'A 的答案');
  await user.click(screen.getByRole('button', { name: '继续分析' }));
  expect(screen.getByRole('button', { name: '正在提交' })).toBeDisabled();

  rerender(<ReportWorkspace session={session(
    clarificationSnapshot('clarification-b', '请补充 B'),
    { submitClarification },
  )} />);
  expect(screen.getByRole('heading', { name: '请补充 B' })).toBeVisible();
  expect(screen.getByLabelText('补充说明')).toHaveValue('');
  expect(screen.getByRole('button', { name: '继续分析' })).toBeDisabled();

  await act(async () => {
    if (outcome === 'resolve') resolveA();
    else rejectA(new Error('A failed'));
    await pendingA.catch(() => undefined);
  });
  expect(screen.getByRole('heading', { name: '请补充 B' })).toBeVisible();
  expect(screen.getByLabelText('补充说明')).toHaveValue('');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
