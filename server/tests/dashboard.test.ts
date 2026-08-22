import request from 'supertest';
import { expect, it } from 'vitest';
import { createServer } from '../src/app';
import { loadWorkbook } from '../src/data/workbook';
import { calculateHealth } from '../src/domain/health';
import { HEALTH_WEIGHTS } from '../../shared/dashboard';
import { calculateReadingHealth } from '../../shared/health';

it('calculates the approved weighted health score', () => {
  const dataset = loadWorkbook('data/智慧污水处理厂_演示数据.xlsx');
  const latest = dataset.daily.at(-1)!;
  expect(calculateHealth(dataset.daily).score).toBe(calculateReadingHealth(latest).score);
  expect(calculateHealth(dataset.daily).weights).toBe(HEALTH_WEIGHTS);
});

it('returns dashboard data without legacy presentation types', async () => {
  const app = createServer();
  const [overview, quality, energy] = await Promise.all([
    request(app).get('/api/dashboard/overview'),
    request(app).get('/api/dashboard/water-quality'),
    request(app).get('/api/dashboard/energy'),
  ]);
  expect(overview.status).toBe(200);
  expect(quality.body.metrics.tn.threshold).toBe(3);
  expect(energy.body.trend).toHaveLength(366);
});
