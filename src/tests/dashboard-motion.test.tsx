import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import { TrendArea } from '../charts/TrendArea';
import { HealthDimensionMeter } from '../components/HealthDimensionMeter';
import { formatMotionValue, useDashboardEntrance } from '../motion/useDashboardEntrance';
import { useHealthDimensionMotion } from '../motion/useHealthDimensionMotion';

type MediaCallback = () => void | (() => void);
type MediaRegistration = {
  query: string;
  callback: MediaCallback;
  cleanup?: () => void;
  active: boolean;
};
type MockMediaContext = {
  registrations: MediaRegistration[];
  add: ReturnType<typeof vi.fn>;
  revert: ReturnType<typeof vi.fn>;
};
type MockTimeline = {
  set: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  fromTo: ReturnType<typeof vi.fn>;
  to: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  eventCallback: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};

const mediaState = vi.hoisted(() => ({
  reduced: false,
  contexts: [] as MockMediaContext[],
  scope: null as HTMLElement | null,
}));
const timelineInstances = vi.hoisted(() => [] as MockTimeline[]);

function matchesMotionQuery(query: string): boolean {
  return mediaState.reduced
    ? query === '(prefers-reduced-motion: reduce)'
    : query === '(prefers-reduced-motion: no-preference)';
}

vi.mock('gsap', () => {
  const targetList = (targets: unknown): Array<HTMLElement | SVGElement | { value: number }> => Array.isArray(targets)
    ? targets as Array<HTMLElement | SVGElement | { value: number }>
    : [targets as HTMLElement | SVGElement | { value: number }];
  const resolve = (value: unknown, index: number): unknown => typeof value === 'function' ? value(index) : value;
  const apply = (targets: unknown, vars: Record<string, unknown>) => {
    targetList(targets).forEach((target, index) => {
      if (target instanceof HTMLElement || target instanceof SVGElement) {
        const scaleX = resolve(vars.scaleX, index);
        const x = resolve(vars.x, index);
        const autoAlpha = resolve(vars.autoAlpha, index);
        const strokeDashoffset = resolve(vars.strokeDashoffset, index);
        if (scaleX !== undefined) target.style.transform = `scaleX(${scaleX})`;
        if (x !== undefined) target.style.transform = `translateX(${x}px)`;
        if (autoAlpha !== undefined) {
          target.style.opacity = String(autoAlpha);
          target.style.visibility = Number(autoAlpha) === 0 ? 'hidden' : 'visible';
        }
        if (strokeDashoffset !== undefined) target.style.setProperty('stroke-dashoffset', String(strokeDashoffset));
      } else {
        const value = resolve(vars.value, index);
        if (typeof value === 'number') target.value = value;
      }
    });
    const onUpdate = vars.onUpdate;
    if (typeof onUpdate === 'function') onUpdate();
  };
  const createTimeline = (): MockTimeline => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let endSeconds = 0;
    const positionSeconds = (position: unknown): number => typeof position === 'number' ? position : endSeconds;
    const durationSeconds = (vars: Record<string, unknown>): number => typeof vars.duration === 'number' ? vars.duration : 0;
    const schedule = (callback: () => void, seconds: number) => {
      timers.push(setTimeout(callback, seconds * 1_000));
    };
    const timeline = {} as MockTimeline;
    timeline.set = vi.fn((targets: unknown, vars: Record<string, unknown>) => {
      apply(targets, vars);
      return timeline;
    });
    timeline.from = vi.fn((_targets: unknown, vars: Record<string, unknown>, position?: unknown) => {
      endSeconds = Math.max(endSeconds, positionSeconds(position) + durationSeconds(vars));
      return timeline;
    });
    timeline.fromTo = vi.fn((targets: unknown, fromVars: Record<string, unknown>, toVars: Record<string, unknown>, position?: unknown) => {
      apply(targets, fromVars);
      const finishesAt = positionSeconds(position) + durationSeconds(toVars);
      endSeconds = Math.max(endSeconds, finishesAt);
      schedule(() => apply(targets, toVars), finishesAt);
      return timeline;
    });
    timeline.to = vi.fn((targets: unknown, vars: Record<string, unknown>, position?: unknown) => {
      const finishesAt = positionSeconds(position) + durationSeconds(vars);
      endSeconds = Math.max(endSeconds, finishesAt);
      schedule(() => apply(targets, vars), finishesAt);
      return timeline;
    });
    timeline.call = vi.fn((callback: () => void, _params?: unknown[], position?: unknown) => {
      const runsAt = positionSeconds(position);
      endSeconds = Math.max(endSeconds, runsAt);
      schedule(callback, runsAt);
      return timeline;
    });
    timeline.eventCallback = vi.fn((event: string, callback: () => void) => {
      if (event === 'onComplete') schedule(callback, endSeconds);
      return timeline;
    });
    timeline.kill = vi.fn(() => timers.forEach((timer) => clearTimeout(timer)));
    timelineInstances.push(timeline);
    return timeline;
  };

  return {
    default: {
      registerPlugin: vi.fn(),
      matchMedia: vi.fn(() => {
        const registrations: MediaRegistration[] = [];
        const context = {} as MockMediaContext;
        context.registrations = registrations;
        context.add = vi.fn((query: string, callback: MediaCallback) => {
          const registration: MediaRegistration = { query, callback, active: matchesMotionQuery(query) };
          registrations.push(registration);
          if (registration.active) {
            const cleanup = callback();
            if (cleanup) registration.cleanup = cleanup;
          }
          return context;
        });
        context.revert = vi.fn(() => registrations.forEach((registration) => {
          if (registration.active) registration.cleanup?.();
          registration.active = false;
          registration.cleanup = undefined;
        }));
        mediaState.contexts.push(context);
        return context;
      }),
      timeline: vi.fn(createTimeline),
      utils: { toArray: vi.fn((selector: string) => Array.from((mediaState.scope ?? document).querySelectorAll(selector))) },
    },
  };
});

vi.mock('@gsap/react', async () => {
  const { useEffect } = await import('react');
  return {
    useGSAP: (
      callback: () => void | (() => void),
      options: { dependencies?: readonly unknown[]; scope?: { current: HTMLElement | null } },
    ) => {
      useEffect(() => {
        mediaState.scope = options.scope?.current ?? null;
        const cleanupEffect = callback();
        mediaState.scope = null;
        return cleanupEffect;
      }, options.dependencies);
    },
  };
});

function stubReducedMotion(reduced: boolean): void {
  mediaState.reduced = reduced;
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: matchesMotionQuery(query),
  })));
}

function changeReducedMotion(reduced: boolean): void {
  mediaState.reduced = reduced;
  mediaState.contexts.forEach((context) => context.registrations.forEach((registration) => {
    const nextActive = matchesMotionQuery(registration.query);
    if (registration.active && !nextActive) {
      registration.cleanup?.();
      registration.cleanup = undefined;
      registration.active = false;
    } else if (!registration.active && nextActive) {
      const cleanupRegistration = registration.callback();
      registration.cleanup = cleanupRegistration || undefined;
      registration.active = true;
    }
  }));
}

function MotionHarness({ values, cardCount = 1 }: { values: readonly number[]; cardCount?: number }) {
  const root = useRef<HTMLDivElement>(null);
  useDashboardEntrance(root, [...values]);
  return <div ref={root} data-testid="motion-root">
    {Array.from({ length: cardCount }, (_, index) => <div data-motion-card key={index}>卡片 {index + 1}</div>)}
    {values.map((value, index) => <span key={`${value}-${index}`} data-motion-number data-motion-value={value} data-motion-format="one-decimal">{formatMotionValue(value, 'one-decimal')}</span>)}
  </div>;
}

function DimensionMotionHarness({ scores }: { scores: number[] }) {
  const root = useRef<HTMLDivElement>(null);
  useHealthDimensionMotion(root, scores);
  return <div ref={root}>
    {scores.map((score, index) => <div key={`${score}-${index}`}>
      <HealthDimensionMeter score={score} />
      <b data-dimension-score>{Math.round(score)}</b>
    </div>)}
  </div>;
}

function CombinedMotionHarness() {
  const root = useRef<HTMLDivElement>(null);
  const scores = [95, 92, 94, 95];
  useDashboardEntrance(root, ['combined']);
  useHealthDimensionMotion(root, scores);
  return <div ref={root}>
    <div data-motion-card>卡片</div>
    <span data-motion-number data-motion-value="99.8" data-motion-format="one-decimal">99.8</span>
    {scores.map((score, index) => <div key={`${score}-${index}`}>
      <HealthDimensionMeter score={score} />
      <b data-dimension-score>{score}</b>
    </div>)}
  </div>;
}

const trendPoints = [
  { date: '2026-08-01', score: 88 },
  { date: '2026-08-02', score: 92 },
  { date: '2026-08-03', score: 95 },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (SVGElement.prototype as SVGElement & { getTotalLength?: () => number }).getTotalLength;
  timelineInstances.length = 0;
  mediaState.contexts.length = 0;
  mediaState.scope = null;
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('formats counters without losing precision or grouping', () => {
  expect(formatMotionValue(43_902, 'integer')).toBe('43,902');
  expect(formatMotionValue(99.8, 'one-decimal')).toBe('99.8');
  expect(formatMotionValue(3.78, 'two-decimal')).toBe('3.78');
});

it('renders final values immediately for reduced motion', () => {
  stubReducedMotion(true);
  render(<MotionHarness values={[99.8]} />);
  expect(screen.getByText('99.8')).toBeInTheDocument();
  expect(screen.getByText('99.8').parentElement).toHaveAttribute('data-motion-complete', 'true');
});

it('falls back to final page values when matchMedia is unavailable', () => {
  vi.stubGlobal('matchMedia', undefined);
  render(<MotionHarness values={[99.8]} />);
  expect(screen.getByText('99.8')).toBeInTheDocument();
  expect(screen.getByText('99.8').parentElement).toHaveAttribute('data-motion-complete', 'true');
});

it('recreates the scoped lifecycle when dependencies change', () => {
  stubReducedMotion(false);
  const { rerender } = render(<MotionHarness values={[42]} />);
  const firstTimeline = timelineInstances.at(-1)!;
  const firstMediaContext = mediaState.contexts.at(-1)!;
  rerender(<MotionHarness values={[43]} />);
  expect(firstMediaContext.revert).toHaveBeenCalledTimes(1);
  expect(firstTimeline.kill).toHaveBeenCalledTimes(1);
  expect(mediaState.contexts).toHaveLength(2);
  expect(mediaState.contexts.flatMap((context) => context.registrations)).toHaveLength(4);
});

it('reverts the GSAP match-media context on unmount', () => {
  stubReducedMotion(true);
  const { unmount } = render(<MotionHarness values={[99.8]} />);
  const mediaContext = mediaState.contexts.at(-1)!;
  unmount();
  expect(mediaContext.revert).toHaveBeenCalledTimes(1);
});

it('kills the active page timeline on unmount', () => {
  stubReducedMotion(false);
  const { unmount } = render(<MotionHarness values={[99.8]} />);
  const activeTimeline = timelineInstances.at(-1)!;
  unmount();
  expect(activeTimeline.kill).toHaveBeenCalledTimes(1);
});

it('synchronously replaces production-like final counter text with formatted zero before tweens run', () => {
  vi.useFakeTimers();
  stubReducedMotion(false);
  render(<MotionHarness values={[99.8, 43_902]} />);

  expect(screen.getByTestId('motion-root').querySelectorAll('[data-motion-number]')).toHaveLength(2);
  expect(Array.from(screen.getByTestId('motion-root').querySelectorAll('[data-motion-number]'), (node) => node.textContent)).toEqual(['0.0', '0.0']);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
});

it('keeps a Health-like zero-counter root and a multi-counter root incomplete until the shared 1.25 second endpoint', () => {
  vi.useFakeTimers();
  stubReducedMotion(false);
  const zeroCounter = render(<MotionHarness values={[]} cardCount={3} />);
  const multiCounter = render(<MotionHarness values={Array.from({ length: 10 }, (_, index) => index + 0.5)} cardCount={5} />);
  const roots = [
    zeroCounter.container.querySelector<HTMLElement>('[data-testid="motion-root"]')!,
    multiCounter.container.querySelector<HTMLElement>('[data-testid="motion-root"]')!,
  ];

  const [zeroCounterTimeline, multiCounterTimeline] = timelineInstances.slice(-2);
  expect([zeroCounterTimeline, multiCounterTimeline].every((timeline) => timeline!.call.mock.calls.some((call) => call[2] === 1.25))).toBe(true);
  const lastCounterTween = multiCounterTimeline!.to.mock.calls.at(-1)!;
  expect(Number(lastCounterTween[2]) + Number(lastCounterTween[1].duration)).toBeCloseTo(1.25);
  const cardEntrance = multiCounterTimeline!.from.mock.calls[1]!;
  expect(Number(cardEntrance[2]) + Number(cardEntrance[1].duration) + Number(cardEntrance[1].stagger) * 4).toBeLessThanOrEqual(1.25);
  expect(roots.map((root) => root.dataset.motionComplete)).toEqual(['false', 'false']);
  act(() => vi.advanceTimersByTime(1_249));
  expect(roots.map((root) => root.dataset.motionComplete)).toEqual(['false', 'false']);
  act(() => vi.advanceTimersByTime(1));
  expect(roots.map((root) => root.dataset.motionComplete)).toEqual(['true', 'true']);
});

it('resets completion and counters when motion preference changes from reduce to no-preference', () => {
  vi.useFakeTimers();
  stubReducedMotion(true);
  render(<MotionHarness values={[99.8]} />);
  const root = screen.getByTestId('motion-root');

  expect(root).toHaveAttribute('data-motion-complete', 'true');
  expect(root.querySelector('[data-motion-number]')).toHaveTextContent('99.8');
  act(() => changeReducedMotion(false));
  expect(root).toHaveAttribute('data-motion-complete', 'false');
  expect(root.querySelector('[data-motion-number]')).toHaveTextContent('0.0');
  act(() => vi.advanceTimersByTime(1_249));
  expect(root).toHaveAttribute('data-motion-complete', 'false');
  act(() => vi.advanceTimersByTime(1));
  expect(root).toHaveAttribute('data-motion-complete', 'true');
  expect(root.querySelector('[data-motion-number]')).toHaveTextContent('99.8');
});

it('scopes page counters to the supplied root', () => {
  vi.useFakeTimers();
  stubReducedMotion(false);
  render(<div>
    <span data-testid="outside-counter" data-motion-number data-motion-value="77.7" data-motion-format="one-decimal">77.7</span>
    <MotionHarness values={[99.8]} />
  </div>);

  expect(screen.getByTestId('outside-counter')).toHaveTextContent('77.7');
  expect(screen.getByTestId('motion-root').querySelector('[data-motion-number]')).toHaveTextContent('0.0');
});

it('owns separate page and dimension timelines when both hooks share one root', () => {
  vi.useFakeTimers();
  stubReducedMotion(false);
  const { unmount } = render(<CombinedMotionHarness />);
  const [pageTimeline, dimensionTimeline] = timelineInstances;

  expect(pageTimeline).toBeDefined();
  expect(dimensionTimeline).toBeDefined();
  expect(pageTimeline).not.toBe(dimensionTimeline);
  unmount();
  expect(pageTimeline!.kill).toHaveBeenCalledTimes(1);
  expect(dimensionTimeline!.kill).toHaveBeenCalledTimes(1);
});

it('initializes production score text at zero before no-preference tweens run', () => {
  vi.useFakeTimers();
  stubReducedMotion(false);
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const { container } = render(<DimensionMotionHarness scores={[95, 92, 94, 95]} />);

  expect(Array.from(container.querySelectorAll('[data-dimension-score]')).map((node) => node.textContent)).toEqual(['0', '0', '0', '0']);
  width.mockRestore();
  vi.useRealTimers();
});

it('animates each shared dimension fill and tip to the production endpoint and kills the timeline on cleanup', () => {
  vi.useFakeTimers();
  stubReducedMotion(false);
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const scores = [95, 92, 94, 95];
  const { container, unmount } = render(<DimensionMotionHarness scores={scores} />);

  const [animatingFill] = Array.from(container.querySelectorAll<HTMLElement>('[data-dimension-fill]'));
  const [animatingTip] = Array.from(container.querySelectorAll<HTMLElement>('[data-dimension-tip]'));
  expect(animatingFill).toHaveStyle({ willChange: 'transform' });
  expect(animatingTip).toHaveStyle({ willChange: 'transform' });

  vi.runAllTimers();
  expect(Array.from(container.querySelectorAll('[data-dimension-score]')).map((node) => node.textContent)).toEqual(['95', '92', '94', '95']);
  const [firstFill] = Array.from(container.querySelectorAll<HTMLElement>('[data-dimension-fill]'));
  const [firstTip] = Array.from(container.querySelectorAll<HTMLElement>('[data-dimension-tip]'));
  expect(firstFill?.style.transform).toBe('');
  expect(firstFill?.style.willChange).toBe('');
  expect(firstFill?.parentElement).toHaveStyle({ '--dimension-score': '95%' });
  expect(firstTip?.style.transform).toBe('');
  expect(firstTip?.style.willChange).toBe('');
  expect(width).toHaveBeenCalledTimes(4);
  expect(vi.mocked(gsap.timeline).mock.results.at(-1)?.value.to).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ stagger: 0.07 }),
    0,
  );
  expect(container.firstElementChild).toHaveAttribute('data-health-dimension-motion-complete', 'true');

  unmount();
  expect(vi.mocked(gsap.timeline).mock.results.at(-1)?.value.kill).toHaveBeenCalledTimes(1);
  width.mockRestore();
  vi.useRealTimers();
});

it('removes transient dimension compositor hints when an active animation unmounts', () => {
  stubReducedMotion(false);
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const { container, unmount } = render(<DimensionMotionHarness scores={[95, 92, 94, 95]} />);
  const fill = container.querySelector<HTMLElement>('[data-dimension-fill]')!;
  const tip = container.querySelector<HTMLElement>('[data-dimension-tip]')!;

  expect(fill.style.willChange).toBe('transform');
  expect(tip.style.willChange).toBe('transform');
  unmount();
  expect(fill.style.willChange).toBe('');
  expect(tip.style.willChange).toBe('');
  width.mockRestore();
});

it('renders shared dimension endpoints immediately when reduced motion is requested', () => {
  stubReducedMotion(true);
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const { container } = render(<DimensionMotionHarness scores={[95, 92, 94, 95]} />);

  expect(Array.from(container.querySelectorAll('[data-dimension-score]')).map((node) => node.textContent)).toEqual(['95', '92', '94', '95']);
  expect(container.querySelector('[data-health-dimension-meter]')).toHaveStyle({ '--dimension-score': '95%' });
  expect(container.querySelector('[data-dimension-tip]')).not.toHaveAttribute('style');
  expect(container.querySelector<HTMLElement>('[data-dimension-fill]')?.style.willChange).toBe('');
  expect(container.querySelector<HTMLElement>('[data-dimension-tip]')?.style.willChange).toBe('');
  expect(container.firstElementChild).toHaveAttribute('data-health-dimension-motion-complete', 'true');
  width.mockRestore();
});

it('falls back to final shared dimension positions when matchMedia is unavailable', () => {
  vi.stubGlobal('matchMedia', undefined);
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const { container } = render(<DimensionMotionHarness scores={[95, 92, 94, 95]} />);

  expect(Array.from(container.querySelectorAll('[data-dimension-score]')).map((node) => node.textContent)).toEqual(['95', '92', '94', '95']);
  expect(container.firstElementChild).toHaveAttribute('data-health-dimension-motion-complete', 'true');
  width.mockRestore();
});

it('choreographs the shared trend line before its left-to-right area reveal and cleans up', () => {
  stubReducedMotion(false);
  const getTotalLength = vi.fn(() => 420);
  Object.defineProperty(SVGElement.prototype, 'getTotalLength', { configurable: true, value: getTotalLength });
  const { container, unmount } = render(<TrendArea ariaLabel="motion trend" points={trendPoints} metric={{ label: '得分', unit: '分', value: (point) => point.score }} />);
  const timeline = timelineInstances.at(-1)!;
  const revealRect = container.querySelector<SVGRectElement>('.trend-reveal-clip')!;
  const strokePaths = Array.from(container.querySelectorAll<SVGPathElement>('.trend-glow, .trend-line'));

  expect(getTotalLength).toHaveBeenCalledTimes(2);
  expect(strokePaths).toHaveLength(2);
  strokePaths.forEach((path) => {
    expect(path).toHaveAttribute('stroke-dasharray', '420');
    expect(path).toHaveAttribute('stroke-dashoffset', '420');
  });

  const [strokeTargets, strokeVars, strokePosition] = timeline.to.mock.calls[0]!;
  expect(Array.isArray(strokeTargets)).toBe(true);
  expect(strokeVars).toEqual(expect.objectContaining({ strokeDashoffset: 0, duration: 1.05 }));
  expect(strokePosition).toBe(.2);

  const [clipTarget, clipFromVars, clipToVars, clipPosition] = timeline.fromTo.mock.calls[0]!;
  expect(clipTarget).toBe(revealRect);
  expect(clipFromVars).toEqual({ scaleX: 0, transformOrigin: 'left center' });
  expect(clipToVars).toEqual(expect.objectContaining({ scaleX: 1, transformOrigin: 'left center', duration: 1.05 }));
  expect(clipPosition).toBe(.27);

  const [pointTargets, pointVars, pointPosition] = timeline.from.mock.calls[0]!;
  expect(Array.isArray(pointTargets)).toBe(true);
  expect(pointVars).toEqual(expect.objectContaining({ autoAlpha: 0, duration: .22, stagger: .03 }));
  expect(pointPosition).toBe(1.24);
  expect(revealRect.style.transform).toBe('scaleX(0)');

  const mediaContext = mediaState.contexts.at(-1)!;
  unmount();
  expect(mediaContext.revert).toHaveBeenCalledTimes(1);
  expect(timeline.kill).toHaveBeenCalledTimes(1);
});

it('renders the complete shared trend immediately for reduced motion', () => {
  stubReducedMotion(true);
  const { container } = render(<TrendArea ariaLabel="reduced trend" points={trendPoints} metric={{ label: '得分', unit: '分', value: (point) => point.score }} />);

  expect(timelineInstances).toHaveLength(0);
  expect(container.querySelector<SVGPathElement>('.trend-line')).toHaveAttribute('stroke-dashoffset', '0');
  expect(container.querySelector<SVGRectElement>('.trend-reveal-clip')?.style.transform).toBe('');
  expect(container.querySelector<SVGCircleElement>('.trend-current-dot')?.style.visibility).toBe('');
});

it('restores the measured stroke length when motion preference changes from reduce to no-preference', () => {
  stubReducedMotion(true);
  const getTotalLength = vi.fn(() => 420);
  Object.defineProperty(SVGElement.prototype, 'getTotalLength', { configurable: true, value: getTotalLength });
  const { container } = render(<TrendArea ariaLabel="preference trend" points={trendPoints} metric={{ label: '得分', unit: '分', value: (point) => point.score }} />);
  const strokePaths = Array.from(container.querySelectorAll<SVGPathElement>('.trend-glow, .trend-line'));

  strokePaths.forEach((path) => expect(path).toHaveAttribute('stroke-dashoffset', '0'));
  act(() => changeReducedMotion(false));

  strokePaths.forEach((path) => expect(path).toHaveAttribute('stroke-dashoffset', '420'));
  const timeline = timelineInstances.at(-1)!;
  const [strokeTargets, strokeVars, strokePosition] = timeline.to.mock.calls[0]!;
  expect(strokeTargets).toHaveLength(2);
  expect(strokeTargets[0]).toBe(strokePaths[0]);
  expect(strokeTargets[1]).toBe(strokePaths[1]);
  expect(strokeVars).toEqual(expect.objectContaining({ strokeDashoffset: 0, duration: 1.05 }));
  expect(strokePosition).toBe(.2);
});
