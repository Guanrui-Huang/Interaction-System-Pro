import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useReportSlideMotion } from '../features/ai/report/useReportSlideMotion';

const motionCapture = vi.hoisted(() => ({
  scopes: [] as Element[],
  targets: [] as Element[][],
}));

vi.mock('gsap', () => ({
  default: {
    context: vi.fn((callback: () => void, scope: Element) => {
      motionCapture.scopes.push(scope);
      callback();
      return { revert: vi.fn() };
    }),
    timeline: vi.fn(() => {
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  motionCapture.scopes.length = 0;
  motionCapture.targets.length = 0;
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
