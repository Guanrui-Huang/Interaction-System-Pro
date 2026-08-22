import { useEffect, useState, type ReactElement } from 'react';
import FloatingLines from './FloatingLines/FloatingLines.jsx';
import type { FloatingLinesProps } from './FloatingLines/FloatingLines.jsx';

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

const floatingLinesProps = {
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
} satisfies FloatingLinesProps;

function useReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(reducedMotionQuery).matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const mediaQuery = window.matchMedia(reducedMotionQuery);
    const handleChange = (event: MediaQueryListEvent) => setPrefersReducedMotion(event.matches);

    setPrefersReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return prefersReducedMotion;
}

export function FloatingLinesBackground(): ReactElement {
  const prefersReducedMotion = useReducedMotion();

  return (
    <div
      aria-hidden="true"
      className="floating-lines-background"
      data-testid="floating-lines-background"
      style={{ pointerEvents: 'none' }}
    >
      {prefersReducedMotion
        ? <div className="floating-lines-background__static" />
        : <FloatingLines {...floatingLinesProps} />}
    </div>
  );
}
