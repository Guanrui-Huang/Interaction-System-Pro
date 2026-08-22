import request from 'supertest';
import { calculateHealth } from '../src/domain/health';
import { createServer } from '../src/app';
import { calculateReadingHealth } from '../../shared/health';

it('calculates a per-reading health score and grade in the shared browser/server module', () => {
  expect(calculateReadingHealth({
    qualityScore: 96,
    flowScore: 88,
    energyScore: 90,
    carbonSourceScore: 92,
  })).toEqual({ score: 92.3, grade: '优' });
});

it('calculates health from quality, flow, energy and carbon-source scores', () => {
  const result = calculateHealth([{
    qualityScore: 96,
    flowScore: 88,
    energyScore: 90,
    carbonSourceScore: 92,
  }]);

  expect(result.weights).toEqual({ quality: 0.4, flow: 0.2, energy: 0.25, carbonSource: 0.15 });
  expect(result.score).toBe(92.3);
  expect(result.score).toBe(calculateReadingHealth({ qualityScore: 96, flowScore: 88, energyScore: 90, carbonSourceScore: 92 }).score);
});

it('returns an API health payload', async () => {
  const response = await request(createServer()).get('/api/health');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
});
