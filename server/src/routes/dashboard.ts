import { Router } from 'express';
import { ENERGY_COST_CONFIG, WATER_QUALITY_METRICS, type DashboardDataset, type WaterQualityDashboardData } from '../../../shared/dashboard';
import { calculateHealth } from '../domain/health';

export function dashboardRouter(dataset: DashboardDataset): Router {
  const router = Router();

  router.get('/overview', (_request, response) => {
    const latest = dataset.daily.at(-1)!;

    response.json({
      metrics: {
        informationCount: latest.informationCount,
        operatingDays: dataset.daily.length,
        complianceRate: latest.complianceRate,
      },
      health: calculateHealth(dataset.daily),
      trend: dataset.daily.slice(-30),
    });
  });

  router.get('/health', (_request, response) => {
    response.json({ health: calculateHealth(dataset.daily), trend: dataset.daily.slice(-30) });
  });

  router.get('/water-quality', (_request, response) => {
    const payload: WaterQualityDashboardData = {
      latest: dataset.daily.at(-1)!,
      trend: dataset.daily.slice(-30),
      alerts: dataset.alerts,
      metrics: WATER_QUALITY_METRICS,
    };
    response.json(payload);
  });

  router.get('/energy', (_request, response) => {
    response.json({
      latest: dataset.daily.at(-1),
      trend: dataset.daily,
      costConfig: ENERGY_COST_CONFIG,
    });
  });

  return router;
}
