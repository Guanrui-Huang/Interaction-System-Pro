import type { EnergyData, HealthData, OverviewData, WaterQualityData } from '../src/app/api';
import { WATER_QUALITY_METRICS, type DailyReading } from '../shared/dashboard';

export type DashboardFixtures = {
  overview: OverviewData;
  health: HealthData;
  'water-quality': WaterQualityData;
  energy: EnergyData;
};

const point: DailyReading = {
  date: '2026-08-08', processedM3: 27800, informationCount: 1300000, complianceRate: 99.8,
  tn: 2.15, ammonia: 0.42, tp: 0.28, cod: 22.4, ss: 5.8, totalKwh: 12030,
  kwhPerM3: 0.436, blowerKwh: 4812, carbonEmissionKg: 343, carbonReductionKg: 51, savedYuan: 15800,
  qualityScore: 96, flowScore: 88, energyScore: 90, carbonSourceKg: 500, carbonSourceScore: 92,
};

const trendScores = [91, 92, 90, 93, 94, 92, 91, 89, 90, 93, 94, 92, 91, 90, 84, 87, 89, 91, 93, 94, 92, 90, 89, 91, 93, 95, 94, 92, 93, 94];

export function createDashboardFixtures(): DashboardFixtures {
  const trend = trendScores.map((score, index) => ({
    ...point,
    date: new Date(Date.UTC(2026, 6, 10 + index)).toISOString().slice(0, 10),
    processedM3: point.processedM3 + index * 120,
    totalKwh: point.totalKwh + index * 48,
    savedYuan: point.savedYuan + index * 90,
    qualityScore: score + 1,
    flowScore: score - 2,
    energyScore: score,
    carbonSourceScore: score + 1,
  }));
  const energyStart = new Date(Date.UTC(2025, 7, 9));
  const energyTrend = Array.from({ length: 366 }, (_, index) => {
    const date = new Date(energyStart);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      ...point,
      date: date.toISOString().slice(0, 10),
      processedM3: 27_800 + Math.round(Math.sin(index / 20) * 700),
      totalKwh: 12_030 + Math.round(Math.cos(index / 18) * 240),
      blowerKwh: 4_812 + Math.round(Math.cos(index / 18) * 96),
      carbonSourceKg: 500 + Math.round(Math.sin(index / 22) * 18),
      carbonReductionKg: 51 + Math.round(Math.cos(index / 24) * 3),
      savedYuan: 3_400 + index * 42 + Math.round(Math.sin(index / 20) * 180),
    };
  });
  const health: HealthData['health'] = {
    weights: { quality: 0.4, flow: 0.2, energy: 0.25, carbonSource: 0.15 },
    score: 92.3,
    grade: '优',
  };

  return {
    overview: {
      metrics: { informationCount: 1300000, operatingDays: 366, complianceRate: 99.8 },
      health,
      trend,
    },
    health: { health, trend },
    'water-quality': { latest: trend.at(-1)!, trend, alerts: [], metrics: WATER_QUALITY_METRICS },
    energy: {
      latest: energyTrend.at(-1)!,
      trend: energyTrend,
      costConfig: { electricityYuanPerKwh: .86, carbonSourceYuanPerKg: 4.2, electricitySavingsRate: .128 },
    },
  };
}
