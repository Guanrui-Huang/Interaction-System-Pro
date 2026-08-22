import type { CSSProperties } from 'react';

export function HealthDimensionMeter({ score, className = '' }: { score: number; className?: string }) {
  const safeScore = Math.max(0, Math.min(100, score));
  const scoreStyle = { '--dimension-score': `${safeScore}%` } as CSSProperties;

  return <div className={`health-dimension-meter ${className}`} data-health-dimension-meter data-score={safeScore} style={scoreStyle}>
    <i data-dimension-fill />
    <span aria-hidden="true" data-dimension-tip />
  </div>;
}
