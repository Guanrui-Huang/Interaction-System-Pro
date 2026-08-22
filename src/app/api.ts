import type {
  BusinessPage,
  DailyReading,
  EnergyCostConfig,
  HealthBreakdown,
  WaterQualityDashboardData,
} from '../../shared/dashboard';

export type DashboardPoint = DailyReading;
export type DashboardHealth = HealthBreakdown;

export type OverviewData = {
  metrics: Pick<DashboardPoint, 'informationCount' | 'complianceRate'> & { operatingDays: number };
  health: DashboardHealth;
  trend: DashboardPoint[];
};

export type HealthData = { health: DashboardHealth; trend: DashboardPoint[] };
export type WaterQualityData = WaterQualityDashboardData;
export type EnergyData = {
  latest: DashboardPoint;
  trend: DashboardPoint[];
  costConfig: EnergyCostConfig;
};

export async function getDashboard<T>(path: BusinessPage, options: { signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api/dashboard/${path}`, { signal: options.signal });
  if (!response.ok) throw new Error('DASHBOARD_DATA_UNAVAILABLE');
  return response.json() as Promise<T>;
}
