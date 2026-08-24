import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useReportSlideMotion } from '../features/ai/report/useReportSlideMotion';

const motionCapture = vi.hoisted(() => ({
  scopes: [] as Element[],
  targets: [] as Element[][],
  completions: [] as Array<(() => void) | undefined>,
}));

vi.mock('gsap', () => ({
  default: {
    context: vi.fn((callback: () => void, scope: Element) => {
      motionCapture.scopes.push(scope);
      callback();
      return { revert: vi.fn() };
    }),
    timeline: vi.fn((options?: { onComplete?: () => void }) => {
      motionCapture.completions.push(options?.onComplete);
      const timeline = {
        fromTo: vi.fn((targets: Iterable<Element>) => {
          motionCapture.targets.push(Array.from(targets));
          return timeline;
        }),
      };
      return timeline;
    }),
  },
}));

function MotionHarness() {
  const rootRef = useRef<HTMLElement>(null);
  useReportSlideMotion(rootRef, 'data-dashboard', true, true);
  return (
    <section ref={rootRef}>
      <div data-reveal-module="primary" data-reveal-visible="true" data-testid="primary-module">
        <strong data-motion-number data-final-value="12.5">12.5</strong>
        <i data-motion-bar />
      </div>
      <div data-reveal-module="support-0" data-reveal-visible="false" data-testid="hidden-support">
        <strong data-motion-number data-final-value="92">92</strong>
        <i data-motion-ring />
      </div>
    </section>
  );
}

function MotionCallbackHarness({ onComplete }: { onComplete: () => void }) {
  const rootRef = useRef<HTMLElement>(null);
  useReportSlideMotion(rootRef, 'data-dashboard', true, true, onComplete);
  return (
    <section ref={rootRef}>
      <div data-reveal-module="primary" data-reveal-visible="true" data-testid="primary-module">
        <strong data-motion-number data-final-value="12.5">12.5</strong>
      </div>
    </section>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  motionCapture.scopes.length = 0;
  motionCapture.targets.length = 0;
  motionCapture.completions.length = 0;
  vi.clearAllMocks();
});

it('scopes GSAP targets to the revealed primary module and leaves hidden supports untouched', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  const { getByTestId } = render(<MotionHarness />);
  const primary = getByTestId('primary-module');
  const hiddenSupport = getByTestId('hidden-support');

  expect(motionCapture.scopes).toEqual([primary]);
  expect(motionCapture.targets.flat()).not.toContain(hiddenSupport.querySelector('[data-motion-number]'));
  expect(motionCapture.targets.flat()).not.toContain(hiddenSupport.querySelector('[data-motion-ring]'));
  expect(motionCapture.targets.flat()).toContain(primary.querySelector('[data-motion-number]'));
  expect(motionCapture.targets.flat()).toContain(primary.querySelector('[data-motion-bar]'));
  expect(hiddenSupport.querySelector('[data-motion-number]')).toHaveTextContent('92');
});

it('marks the slide animated only after the GSAP timeline completes', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  const onComplete = vi.fn();
  const { getByTestId } = render(<MotionCallbackHarness onComplete={onComplete} />);
  const primary = getByTestId('primary-module');

  expect(motionCapture.scopes).toEqual([primary]);
  expect(onComplete).not.toHaveBeenCalled();

  motionCapture.completions.at(-1)?.();

  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(primary.closest('[data-slide-motion-state]')).toHaveAttribute('data-slide-motion-state', 'final');
});

it('keeps the active timeline stable when rerendered with a new completion callback', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  const firstComplete = vi.fn();
  const secondComplete = vi.fn();
  const { rerender } = render(<MotionCallbackHarness onComplete={firstComplete} />);
  const completion = motionCapture.completions.at(-1);

  rerender(<MotionCallbackHarness onComplete={secondComplete} />);

  expect(motionCapture.scopes).toHaveLength(1);
  expect(motionCapture.completions).toHaveLength(1);

  completion?.();
  completion?.();

  expect(firstComplete).not.toHaveBeenCalled();
  expect(secondComplete).toHaveBeenCalledTimes(1);
});
