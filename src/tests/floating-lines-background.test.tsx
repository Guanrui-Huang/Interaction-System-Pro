import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FloatingLinesBackground } from '../components/FloatingLinesBackground';

const floatingLinesProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../components/FloatingLines/FloatingLines.jsx', () => ({
  default: (props: Record<string, unknown>) => {
    floatingLinesProps.push(props);
    return <div data-testid="floating-lines-webgl" />;
  },
}));

afterEach(() => {
  cleanup();
  floatingLinesProps.length = 0;
  vi.unstubAllGlobals();
});

it('renders an inert background wrapper with the required WebGL defaults', () => {
  render(<FloatingLinesBackground />);

  const wrapper = screen.getByTestId('floating-lines-background');
  expect(wrapper).toHaveClass('floating-lines-background');
  expect(wrapper).toHaveAttribute('aria-hidden', 'true');
  expect(wrapper).toHaveStyle({ pointerEvents: 'none' });
  expect(floatingLinesProps).toEqual([{
    enabledWaves: ['top', 'middle', 'bottom'],
    lineCount: [10, 15, 20],
    lineDistance: [8, 6, 4],
    bendRadius: 5,
    bendStrength: -0.5,
    interactive: false,
    parallax: true,
    parallaxStrength: 0.12,
    animationSpeed: 0.35,
    linesGradient: ['#23EFB1', '#2CE4F5', '#38A9FF'],
    mixBlendMode: 'screen',
  }]);
});

it('uses the static fallback when reduced motion is preferred', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));

  render(<FloatingLinesBackground />);

  expect(screen.getByTestId('floating-lines-background')).toHaveClass('floating-lines-background');
  expect(document.querySelector('.floating-lines-background__static')).toBeInTheDocument();
  expect(screen.queryByTestId('floating-lines-webgl')).not.toBeInTheDocument();
});

it('removes the reduced-motion listener when unmounted', () => {
  const removeEventListener = vi.fn();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener,
  })));

  const { unmount } = render(<FloatingLinesBackground />);
  unmount();

  expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
});
