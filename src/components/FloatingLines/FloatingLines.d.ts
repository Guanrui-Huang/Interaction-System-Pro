import type { CSSProperties, ReactElement } from 'react';

export type FloatingLinesWave = 'top' | 'middle' | 'bottom';

export interface FloatingLinesWavePosition {
  x?: number;
  y?: number;
  rotate?: number;
}

export interface FloatingLinesProps {
  linesGradient?: readonly string[];
  enabledWaves?: readonly FloatingLinesWave[];
  lineCount?: number | readonly number[];
  lineDistance?: number | readonly number[];
  topWavePosition?: FloatingLinesWavePosition;
  middleWavePosition?: FloatingLinesWavePosition;
  bottomWavePosition?: FloatingLinesWavePosition;
  animationSpeed?: number;
  interactive?: boolean;
  bendRadius?: number;
  bendStrength?: number;
  mouseDamping?: number;
  parallax?: boolean;
  parallaxStrength?: number;
  mixBlendMode?: CSSProperties['mixBlendMode'];
}

export default function FloatingLines(props: FloatingLinesProps): ReactElement;
