import {
  HEALTH_WEIGHTS,
  type DailyReading,
  type HealthBreakdown,
} from '../../../shared/dashboard';
import { calculateReadingHealth } from '../../../shared/health';

export function calculateHealth(
  readings: Pick<DailyReading, 'qualityScore' | 'flowScore' | 'energyScore' | 'carbonSourceScore' | 'wphi'>[],
): HealthBreakdown {
  const latest = readings.at(-1);

  if (!latest) {
    throw new Error('HEALTH_READINGS_EMPTY');
  }

  if (latest.wphi) return { weights: HEALTH_WEIGHTS, score: latest.wphi.score,
    grade: latest.wphi.grade ?? (latest.wphi.status === 'maintenance' ? '评分暂停' : '未评分'), wphi: latest.wphi };

  return {
    weights: HEALTH_WEIGHTS,
    ...calculateReadingHealth(latest),
  };
}
