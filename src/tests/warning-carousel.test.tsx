import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen } from '@testing-library/react';
import gsap from 'gsap';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WarningCarousel } from '../components/WarningCarousel';

type MockTimeline = {
  set: ReturnType<typeof vi.fn>;
  to: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};

const timelineInstances = vi.hoisted(() => [] as MockTimeline[]);

type MockResizeObserver = {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type MotionPreferenceController = {
  mediaQuery: MediaQueryList;
  setMatches: (matches: boolean) => void;
};

const resizeObservers: MockResizeObserver[] = [];
let motionPreference: MotionPreferenceController;

vi.mock('gsap', () => ({
  default: {
    registerPlugin: vi.fn(),
    timeline: vi.fn(() => {
      const timeline = {} as MockTimeline;
      timeline.set = vi.fn((target: HTMLElement, vars: Record<string, unknown>) => {
        if (typeof vars.scrollTop === 'number') target.scrollTop = vars.scrollTop;
        return timeline;
      });
      timeline.to = vi.fn(() => timeline);
      timeline.pause = vi.fn(() => timeline);
      timeline.play = vi.fn(() => timeline);
      timeline.kill = vi.fn();
      timelineInstances.push(timeline);
      return timeline;
    }),
  },
}));

vi.mock('@gsap/react', async () => {
  const { useEffect } = await import('react');
  return {
    useGSAP: (callback: () => void | (() => void), options: { dependencies?: readonly unknown[] }) => {
      useEffect(callback, options.dependencies);
    },
  };
});

const dashboardCss = readFileSync('src/styles/dashboard.css', 'utf8');

const alerts = [
  { date: '2026-08-08', metric: '吨水电耗', level: '关注' as const, reason: '第二条原因完整显示', recommendation: '第二条建议完整显示' },
  { date: '2026-08-09', metric: '总氮（TN）', level: '提示' as const, reason: '第一条原因完整显示', recommendation: '第一条建议完整显示' },
];

function mockElementSize(initial: { clientHeight: number; scrollHeight: number }) {
  let { clientHeight, scrollHeight } = initial;
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => clientHeight);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => scrollHeight);
  return {
    update: (next: Partial<typeof initial>) => {
      clientHeight = next.clientHeight ?? clientHeight;
      scrollHeight = next.scrollHeight ?? scrollHeight;
    },
  };
}

function stubResizeObserver(): void {
  resizeObservers.length = 0;
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback;
    observe = vi.fn();
    disconnect = vi.fn();

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeObservers.push(this);
    }
  });
}

function triggerResize(observer = resizeObservers.at(-1)): void {
  if (!observer) throw new Error('Expected a ResizeObserver instance');
  act(() => observer.callback([], observer as unknown as ResizeObserver));
}

function stubReducedMotion(initialMatches: boolean): MotionPreferenceController {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    media: '(prefers-reduced-motion: reduce)',
    get matches() { return matches; },
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));
  return {
    mediaQuery,
    setMatches: (nextMatches: boolean) => {
      matches = nextMatches;
      act(() => listeners.forEach((listener) => listener({ matches: nextMatches } as MediaQueryListEvent)));
    },
  };
}

function latestTimeline(): MockTimeline {
  const timeline = timelineInstances.at(-1);
  if (!timeline) throw new Error('Expected a GSAP warning timeline');
  return timeline;
}

beforeEach(() => {
  timelineInstances.length = 0;
  vi.mocked(gsap.timeline).mockClear();
  stubResizeObserver();
  motionPreference = stubReducedMotion(false);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('renders the complete newest-first list in the active viewport', () => {
  render(<WarningCarousel alerts={alerts} />);

  const items = screen.getAllByRole('article');
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent('第一条原因完整显示');
  expect(items[1]).toHaveTextContent('第二条原因完整显示');
  expect(screen.getByRole('region', { name: '预警自动播放' })).toContainElement(items[0]!);
});

it('builds a distance-timed top-to-bottom GSAP loop only when content overflows', () => {
  mockElementSize({ clientHeight: 120, scrollHeight: 360 });
  render(<WarningCarousel alerts={alerts} />);

  const viewport = screen.getByRole('region', { name: '预警自动播放' });
  const list = viewport.querySelector('.warning-carousel__list');
  const timeline = latestTimeline();
  expect(gsap.timeline).toHaveBeenCalledWith({ repeat: -1, paused: false });
  expect(timeline.set).toHaveBeenNthCalledWith(1, viewport, { scrollTop: 0 });
  expect(timeline.to).toHaveBeenNthCalledWith(1, viewport, { scrollTop: 240, duration: 7.5, ease: 'none' });
  expect(timeline.to).toHaveBeenNthCalledWith(2, {}, { duration: 0.8 });
  expect(timeline.to).toHaveBeenNthCalledWith(3, list, { autoAlpha: 0, duration: 0.18 });
  expect(timeline.set).toHaveBeenNthCalledWith(2, viewport, { scrollTop: 0 });
  expect(timeline.to).toHaveBeenNthCalledWith(4, list, { autoAlpha: 1, duration: 0.18 });
});

it('reserves control geometry and rebuilds from true dimensions after a resize', () => {
  const size = mockElementSize({ clientHeight: 120, scrollHeight: 360 });
  render(<WarningCarousel alerts={alerts} />);
  const viewport = screen.getByRole('region', { name: '预警自动播放' });
  const firstTimeline = latestTimeline();

  expect(viewport.parentElement?.querySelector('.warning-carousel__controls')).toBeInTheDocument();
  expect(dashboardCss).toMatch(/\.warning-carousel-shell \{[^}]*grid-template-rows: 35px minmax\(0, 1fr\);/);
  expect(resizeObservers).toHaveLength(1);
  expect(resizeObservers[0]!.observe).toHaveBeenCalledWith(viewport);
  expect(resizeObservers[0]!.observe).toHaveBeenCalledWith(viewport.querySelector('.warning-carousel__list'));

  size.update({ clientHeight: 96 });
  triggerResize(resizeObservers[0]);

  const secondTimeline = latestTimeline();
  expect(firstTimeline.kill).toHaveBeenCalledTimes(1);
  expect(gsap.timeline).toHaveBeenCalledTimes(2);
  expect(secondTimeline.to).toHaveBeenNthCalledWith(1, viewport, { scrollTop: 264, duration: 7.5, ease: 'none' });
});

it('does not create a timeline when the complete list fits the viewport', () => {
  mockElementSize({ clientHeight: 360, scrollHeight: 360 });
  render(<WarningCarousel alerts={alerts} />);

  expect(gsap.timeline).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '暂停预警轮播' })).not.toBeInTheDocument();
});

it('exposes an accessible pause control and persists user pause until continued', () => {
  mockElementSize({ clientHeight: 120, scrollHeight: 360 });
  render(<WarningCarousel alerts={alerts} />);
  const viewport = screen.getByRole('region', { name: '预警自动播放' });
  const timeline = latestTimeline();
  timeline.pause.mockClear();
  timeline.play.mockClear();

  const pauseButton = screen.getByRole('button', { name: '暂停预警轮播' });
  expect(pauseButton).toHaveClass('warning-carousel__control');
  expect(pauseButton).toHaveAttribute('aria-pressed', 'false');
  expect(viewport).toHaveAttribute('aria-live', 'off');
  expect(viewport).not.toContainElement(pauseButton);

  fireEvent.click(pauseButton);
  expect(timeline.pause).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '继续预警轮播' })).toHaveAttribute('aria-pressed', 'true');
  expect(viewport).toHaveAttribute('aria-live', 'polite');

  fireEvent.mouseEnter(viewport);
  fireEvent.click(screen.getByRole('button', { name: '继续预警轮播' }));
  expect(timeline.play).not.toHaveBeenCalled();
  fireEvent.mouseLeave(viewport);
  expect(timeline.play).toHaveBeenCalledTimes(1);
  expect(viewport).toHaveAttribute('aria-live', 'off');
});

it('pauses for hover, keyboard focus, and pointer interaction, resuming after each clears', () => {
  mockElementSize({ clientHeight: 120, scrollHeight: 360 });
  render(<WarningCarousel alerts={alerts} />);
  const viewport = screen.getByRole('region', { name: '预警自动播放' });
  const timeline = latestTimeline();
  timeline.pause.mockClear();
  timeline.play.mockClear();

  fireEvent.mouseEnter(viewport);
  expect(timeline.pause).toHaveBeenCalledTimes(1);
  fireEvent.mouseLeave(viewport);
  expect(timeline.play).toHaveBeenCalledTimes(1);

  fireEvent.focus(viewport);
  expect(timeline.pause).toHaveBeenCalledTimes(2);
  fireEvent.blur(viewport);
  expect(timeline.play).toHaveBeenCalledTimes(2);

  fireEvent.pointerDown(viewport, { pointerType: 'touch' });
  expect(timeline.pause).toHaveBeenCalledTimes(3);
  fireEvent.pointerUp(viewport, { pointerType: 'touch' });
  expect(timeline.play).toHaveBeenCalledTimes(3);
});

it('keeps an active pointer pause through pointer leave until release or cancellation', () => {
  mockElementSize({ clientHeight: 120, scrollHeight: 360 });
  render(<WarningCarousel alerts={alerts} />);
  const viewport = screen.getByRole('region', { name: '预警自动播放' });
  const timeline = latestTimeline();
  const setPointerCapture = vi.fn();
  Object.defineProperty(viewport, 'setPointerCapture', { configurable: true, value: setPointerCapture });
  timeline.pause.mockClear();
  timeline.play.mockClear();

  fireEvent.pointerDown(viewport, { pointerId: 7, pointerType: 'touch' });
  expect(setPointerCapture).toHaveBeenCalledTimes(1);
  expect(timeline.pause).toHaveBeenCalledTimes(1);
  fireEvent.pointerLeave(viewport, { pointerId: 7, pointerType: 'touch' });
  expect(timeline.play).not.toHaveBeenCalled();
  fireEvent.pointerUp(viewport, { pointerId: 7, pointerType: 'touch' });
  expect(timeline.play).toHaveBeenCalledTimes(1);

  fireEvent.pointerDown(viewport, { pointerId: 8, pointerType: 'touch' });
  fireEvent.pointerLeave(viewport, { pointerId: 8, pointerType: 'touch' });
  expect(timeline.play).toHaveBeenCalledTimes(1);
  fireEvent.pointerCancel(viewport, { pointerId: 8, pointerType: 'touch' });
  expect(timeline.play).toHaveBeenCalledTimes(2);
});

it('pauses while the document is hidden and resumes when visible', () => {
  mockElementSize({ clientHeight: 120, scrollHeight: 360 });
  render(<WarningCarousel alerts={alerts} />);
  const timeline = latestTimeline();
  timeline.pause.mockClear();
  timeline.play.mockClear();

  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent(document, new Event('visibilitychange'));
  expect(timeline.pause).toHaveBeenCalledTimes(1);

  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  fireEvent(document, new Event('visibilitychange'));
  expect(timeline.play).toHaveBeenCalledTimes(1);
});

it('resets to the top, kills the old timeline, and rebuilds when alert data changes', () => {
  mockElementSize({ clientHeight: 120, scrollHeight: 360 });
  const { rerender } = render(<WarningCarousel alerts={alerts} />);
  const viewport = screen.getByRole('region', { name: '预警自动播放' });
  const firstTimeline = latestTimeline();
  viewport.scrollTop = 90;

  rerender(<WarningCarousel alerts={[{ ...alerts[0]!, date: '2026-08-10', reason: '刷新后的最新原因' }, alerts[1]!]} />);

  expect(firstTimeline.kill).toHaveBeenCalledTimes(1);
  expect(gsap.timeline).toHaveBeenCalledTimes(2);
  expect(viewport.scrollTop).toBe(0);
  expect(screen.getAllByRole('article')[0]).toHaveTextContent('刷新后的最新原因');
});

it('renders a complete manually scrollable static list for reduced motion', () => {
  mockElementSize({ clientHeight: 120, scrollHeight: 360 });
  motionPreference = stubReducedMotion(true);
  render(<WarningCarousel alerts={alerts} />);

  const viewport = screen.getByRole('region', { name: '预警自动播放' });
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(screen.getByText('第一条原因完整显示')).toBeInTheDocument();
  expect(screen.getByText('第二条原因完整显示')).toBeInTheDocument();
  expect(viewport).toHaveClass('warning-carousel--static');
  expect(gsap.timeline).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /预警轮播/ })).not.toBeInTheDocument();
  expect(dashboardCss).toMatch(/\.warning-carousel--static \{[^}]*overflow-y: auto;/);
});

it('reacts to reduced-motion changes by killing autoplay and rebuilding when motion returns', () => {
  mockElementSize({ clientHeight: 120, scrollHeight: 360 });
  render(<WarningCarousel alerts={alerts} />);
  const viewport = screen.getByRole('region', { name: '预警自动播放' });
  const firstTimeline = latestTimeline();

  motionPreference.setMatches(true);

  expect(firstTimeline.kill).toHaveBeenCalledTimes(1);
  expect(viewport).toHaveClass('warning-carousel--static');
  expect(screen.queryByRole('button', { name: /预警轮播/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole('article')).toHaveLength(2);

  motionPreference.setMatches(false);

  expect(gsap.timeline).toHaveBeenCalledTimes(2);
  expect(viewport).not.toHaveClass('warning-carousel--static');
  expect(screen.getByRole('button', { name: '暂停预警轮播' })).toBeInTheDocument();
  expect(latestTimeline().to).toHaveBeenNthCalledWith(1, viewport, { scrollTop: 240, duration: 7.5, ease: 'none' });
});

it('keeps long Chinese warning text and recommendations complete', () => {
  const reason = '进水负荷短时升高，需要立即复核曝气量、回流比与碳源投加策略，避免总氮指标继续波动。'.repeat(5);
  const recommendation = '建议值班人员完成现场复核后记录处置结果，并持续关注后续趋势变化。'.repeat(5);
  render(<WarningCarousel alerts={[{ ...alerts[1]!, reason, recommendation }]} />);

  const viewport = screen.getByRole('region', { name: '预警自动播放' });
  const item = screen.getByText(reason).closest('article');
  expect(item).toHaveClass('warning-carousel__item');
  expect(screen.getByText(recommendation)).toBeInTheDocument();
  expect(viewport).toHaveClass('warning-carousel');
  expect(dashboardCss).toMatch(/\.warning-carousel \{[^}]*overflow-y: auto;/);
  expect(dashboardCss).toMatch(/\.warning-carousel__item \{[^}]*height: auto;/);
  expect(dashboardCss).toContain('overflow-wrap: anywhere;');
});

it('cleans up the active timeline, resize observer, and motion preference listener when unmounted', () => {
  mockElementSize({ clientHeight: 120, scrollHeight: 360 });
  const { unmount } = render(<WarningCarousel alerts={alerts} />);
  const timeline = latestTimeline();
  const resizeObserver = resizeObservers[0]!;

  unmount();

  expect(timeline.kill).toHaveBeenCalledTimes(1);
  expect(resizeObserver.disconnect).toHaveBeenCalledTimes(1);
  expect(motionPreference.mediaQuery.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
});

it('renders the empty warning message without a region or timeline', () => {
  render(<WarningCarousel alerts={[]} />);

  expect(screen.getByText('暂无新增预警，当前指标运行正常。')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '预警自动播放' })).not.toBeInTheDocument();
  expect(gsap.timeline).not.toHaveBeenCalled();
});
