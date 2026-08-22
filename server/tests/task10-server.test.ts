import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createServer } from '../src/app';
import type { ReportGenerator } from '../src/services/report-generator';
import { ReportJobRegistry } from '../src/services/report-job-registry';

it('returns the asynchronous empty report reservation from the report route', async () => {
  const registry = new ReportJobRegistry({ createId: () => '00000000-0000-4000-8000-000000000010' });
  const createReport = vi.fn((input: { question: string; page: 'energy' }) => {
    const snapshot = registry.create({ question: input.question, originPage: input.page });
    return { reportId: snapshot.reportId, snapshot };
  });
  const generator = {
    dependencies: { registry }, createReport, run: vi.fn(), answerClarification: vi.fn(),
    prioritize: vi.fn(), retrySlide: vi.fn(), appendNewTopic: vi.fn(),
  } as unknown as ReportGenerator;
  const response = await request(createServer({ reportRegistry: registry, reportGenerator: generator }))
    .post('/api/ai/reports').send({ question: 'analyze energy', page: 'energy' });
  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({
    reportId: '00000000-0000-4000-8000-000000000010',
    snapshot: { status: 'generating', phase: 'understanding', outline: [], slides: [] },
  });
  expect(response.body).not.toHaveProperty('bootstrapSlide');
  expect(createReport).toHaveBeenCalledOnce();
});
