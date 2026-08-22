import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createServer } from '../src/app';

it('keeps retired synchronous AI query and PPTX download routes absent as JSON 404s', async () => {
  const app = createServer();
  const [query, download] = await Promise.all([
    request(app).post('/api/ai/query').send({ question: 'retired route', page: 'energy' }),
    request(app).get('/api/ai/presentations/missing.pptx'),
  ]);
  for (const response of [query, download]) {
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ code: 'NOT_FOUND', message: '接口不存在。' });
  }
});

it('does not retain legacy presentation deck exports in the dashboard contract', () => {
  const dashboardSource = readFileSync(resolve(process.cwd(), 'shared/dashboard.ts'), 'utf8');
  expect(dashboardSource).not.toMatch(/export\s+(?:type\s+)?PresentationDeck\b/u);
  expect(dashboardSource).not.toMatch(/export\s+(?:type\s+)?PresentationSlide\b/u);
});
