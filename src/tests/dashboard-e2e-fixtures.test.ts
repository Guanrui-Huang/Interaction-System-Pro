import { createDashboardFixtures } from '../../e2e/dashboard-fixtures';

it('keeps E2E dashboard fixtures separated by endpoint response contract', () => {
  const fixtures = createDashboardFixtures();

  expect(fixtures.overview.metrics).toEqual({
    informationCount: 1300000,
    operatingDays: 366,
    complianceRate: 99.8,
  });
  expect(fixtures.energy.trend).toHaveLength(366);
  expect(fixtures.energy.trend[0]?.date).toBe('2025-08-09');
  expect(fixtures.energy.latest.date).toBe('2026-08-09');
  expect(fixtures['water-quality'].metrics.tn.threshold).toBe(3);
  expect(fixtures.health).not.toHaveProperty('metrics');
  expect(fixtures.energy).not.toHaveProperty('metrics');
});
