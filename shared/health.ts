import {
  HEALTH_GRADE_THRESHOLDS,
  HEALTH_WEIGHTS,
  type DailyReading,
  type HealthGrade,
} from './dashboard';

export type HealthScoreInput = Pick<
  DailyReading,
  'qualityScore' | 'flowScore' | 'energyScore' | 'carbonSourceScore'
> & Pick<DailyReading, 'wphi'>;

export type ReadingHealth = { score: number; grade: HealthGrade };

export function calculateReadingHealth(reading: HealthScoreInput): ReadingHealth {
  if (reading.wphi) return { score: reading.wphi.score ?? Number.NaN, grade: reading.wphi.grade ?? (reading.wphi.status === 'maintenance' ? '评分暂停' : '未评分') };
  const score = Number(
    (
      reading.qualityScore * HEALTH_WEIGHTS.quality +
      reading.flowScore * HEALTH_WEIGHTS.flow +
      reading.energyScore * HEALTH_WEIGHTS.energy +
      reading.carbonSourceScore * HEALTH_WEIGHTS.carbonSource
    ).toFixed(2),
  );

  return {
    score,
    grade: score >= HEALTH_GRADE_THRESHOLDS.excellent
      ? '优'
      : score >= HEALTH_GRADE_THRESHOLDS.good
        ? '良'
        : '关注',
  };
}
