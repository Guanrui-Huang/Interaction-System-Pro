import {
  HEALTH_WEIGHTS,
  type DailyReading,
  type HealthBreakdown,
} from '../../../shared/dashboard';
import { calculateReadingHealth } from '../../../shared/health';

export function calculateHealth(
  readings: Pick<DailyReading, 'qualityScore' | 'flowScore' | 'energyScore' | 'carbonSourceScore'>[],
): HealthBreakdown {
  const latest = readings.at(-1);

  if (!latest) {
    throw new Error('HEALTH_READINGS_EMPTY');
  }

  return {
    weights: HEALTH_WEIGHTS,
    ...calculateReadingHealth(latest),
  };
}
