import { describe, expect, it } from 'vitest';
import {
  AI_ERROR_CODES,
  AI_ERROR_MESSAGES,
  ANALYSIS_MODULES,
  type AiErrorResponse,
} from '../../shared/ai';
import {
  HEALTH_WEIGHTS,
  type DailyReading,
  type DashboardDataset,
} from '../../shared/dashboard';
import { calculateReadingHealth } from '../../shared/health';
import {
  ANALYSIS_METHODS,
  ANALYSIS_METRICS,
  createDefaultAnalysisPlan,
  parseAnalysisPlan,
} from '../src/domain/analysis-plan';

function isoDay(index: number): string {
  return new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10);
}

function reading(index: number): DailyReading {
  return {
    date: isoDay(index),
    processedM3: 18_000 + index * 100,
    informationCount: 1_200 + index,
    complianceRate: 98 + index * 0.02,
    tn: 2.2 + index * 0.1,
    ammonia: 0.4 + index * 0.01,
    tp: 0.2 + index * 0.005,
    cod: 20 + index * 0.2,
    ss: 4 + index * 0.05,
    totalKwh: 7_000 + index * 20,
    kwhPerM3: 0.5 - index * 0.002,
    blowerKwh: 2_500 + index * 10,
    carbonEmissionKg: 520 - index,
    carbonReductionKg: 50 + index,
    savedYuan: 3_000 + index * 25,
    qualityScore: 82 + index * 0.2,
    flowScore: 84 + index * 0.15,
    energyScore: 80 + index * 0.25,
    carbonSourceKg: 360 - index,
    carbonSourceScore: 83 + index * 0.18,
  };
}

const orderedDaily = Array.from({ length: 40 }, (_, index) => reading(index));
const shuffledDaily = [...orderedDaily].sort((left, right) => right.date.localeCompare(left.date));
const dataset: DashboardDataset = {
  plantName: '智慧污水处理厂',
  daily: shuffledDaily,
  alerts: [],
  health: { weights: HEALTH_WEIGHTS, ...calculateReadingHealth(orderedDaily.at(-1)!) },
};

const validPlan = {
  modules: ['water-quality', 'energy'],
  metrics: ['tn', 'kwhPerM3', 'blowerKwh', 'carbonSourceKg'],
  dateRange: { from: '2026-07-20', to: '2026-07-31' },
  methods: ['trend', 'correlation'],
  includeAlerts: false,
  includeHealthWeights: false,
};

describe('public AI analysis contract', () => {
  it('publishes the controlled modules and no-evidence error shape', () => {
    const response: AiErrorResponse = {
      code: 'NO_EVIDENCE',
      message: AI_ERROR_MESSAGES.NO_EVIDENCE,
      availableDateRange: { from: '2026-07-01', to: '2026-08-09' },
    };

    expect(ANALYSIS_MODULES).toEqual(['overview', 'health', 'water-quality', 'energy', 'alerts']);
    expect(AI_ERROR_CODES).toContain('NO_EVIDENCE');
    expect(response).toEqual(expect.objectContaining({
      code: 'NO_EVIDENCE',
      availableDateRange: { from: '2026-07-01', to: '2026-08-09' },
    }));
  });
});

describe('ANALYSIS_METRICS', () => {
  it('is a complete whitelist of numeric DailyReading fields plus computed healthScore', () => {
    expect(Object.entries(ANALYSIS_METRICS).filter(([, definition]) => Number.isFinite(definition.read(orderedDaily[0]!))).map(([key]) => key)).toEqual([
      'processedM3',
      'informationCount',
      'complianceRate',
      'healthScore',
      'qualityScore',
      'flowScore',
      'energyScore',
      'carbonSourceScore',
      'tn',
      'ammonia',
      'tp',
      'cod',
      'ss',
      'totalKwh',
      'kwhPerM3',
      'blowerKwh',
      'carbonSourceKg',
      'carbonEmissionKg',
      'carbonReductionKg',
      'savedYuan',
    ]);
    expect(Object.values(ANALYSIS_METRICS).every(({ label, unit }) => label.length > 0 && unit.length > 0)).toBe(true);
    expect(ANALYSIS_METRICS.tn).toMatchObject({ module: 'water-quality', limit: 3 });
    expect(ANALYSIS_METRICS.healthScore.read(orderedDaily[0])).toBe(calculateReadingHealth(orderedDaily[0]).score);
  });
});

describe('parseAnalysisPlan', () => {
  it('accepts a valid controlled cross-module plan', () => {
    expect(parseAnalysisPlan(JSON.stringify(validPlan), dataset)).toEqual(validPlan);
  });

  it('canonicalizes supplemental evidence flags into stable allowlist module order', () => {
    const supplementalPlan = {
      ...validPlan,
      modules: ['water-quality'],
      metrics: ['tn'],
      includeAlerts: true,
      includeHealthWeights: true,
    };

    expect(parseAnalysisPlan(JSON.stringify(supplementalPlan), dataset)).toEqual({
      ...supplementalPlan,
      modules: ['health', 'water-quality', 'alerts'],
    });
  });

  it('canonicalizes the reverse alerts contradiction and preserves stable module order', () => {
    const contradictoryPlan = {
      ...validPlan,
      modules: ['alerts', 'water-quality'],
      metrics: ['tn'],
      includeAlerts: false,
    };

    expect(parseAnalysisPlan(JSON.stringify(contradictoryPlan), dataset)).toEqual({
      ...contradictoryPlan,
      modules: ['water-quality', 'alerts'],
      includeAlerts: true,
    });
  });

  it('keeps health metrics valid without implicitly adding health weights', () => {
    const healthPlan = {
      ...validPlan,
      modules: ['health'],
      metrics: ['qualityScore'],
      includeHealthWeights: false,
    };

    expect(parseAnalysisPlan(JSON.stringify(healthPlan), dataset)).toEqual(healthPlan);
  });

  it('strips an optional Markdown JSON fence and nothing else', () => {
    expect(parseAnalysisPlan(`\n\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\`\n`, dataset)).toEqual(validPlan);
    expect(parseAnalysisPlan(`\`\`\`\n${JSON.stringify(validPlan)}\n\`\`\``, dataset)).toEqual(validPlan);
    expect(() => parseAnalysisPlan(`Plan:\n${JSON.stringify(validPlan)}`, dataset)).toThrow('ANALYSIS_PLAN_INVALID');
    expect(() => parseAnalysisPlan(`\`\`\`typescript\n${JSON.stringify(validPlan)}\n\`\`\``, dataset)).toThrow('ANALYSIS_PLAN_INVALID');
  });

  it.each([
    ['unknown module', { ...validPlan, modules: ['filesystem'] }],
    ['local path metric', { ...validPlan, metrics: ['/tmp/data.xlsx'] }],
    ['unknown method', { ...validPlan, methods: ['forecast'] }],
    ['unknown top-level key', { ...validPlan, workbookPath: '/tmp/data.xlsx' }],
    ['unknown nested key', { ...validPlan, dateRange: { ...validPlan.dateRange, timezone: 'UTC' } }],
    ['empty modules', { ...validPlan, modules: [] }],
    ['empty metrics', { ...validPlan, metrics: [] }],
    ['empty methods', { ...validPlan, methods: [] }],
    ['duplicate modules', { ...validPlan, modules: ['energy', 'energy'] }],
    ['duplicate metrics', { ...validPlan, metrics: ['tn', 'tn'] }],
    ['duplicate methods', { ...validPlan, methods: ['trend', 'trend'] }],
    ['module-metric mismatch', { ...validPlan, modules: ['water-quality'], metrics: ['tn', 'kwhPerM3'] }],
    ['module without a metric', { ...validPlan, modules: ['water-quality', 'energy', 'health'] }],
    ['invalid calendar date', { ...validPlan, dateRange: { from: '2026-02-30', to: '2026-07-31' } }],
    ['timestamp instead of ISO date', { ...validPlan, dateRange: { from: '2026-07-20T00:00:00Z', to: '2026-07-31' } }],
    ['reversed dates', { ...validPlan, dateRange: { from: '2026-07-31', to: '2026-07-20' } }],
    ['date before dataset range', { ...validPlan, dateRange: { from: '2026-06-30', to: '2026-07-31' } }],
    ['date after dataset range', { ...validPlan, dateRange: { from: '2026-07-20', to: '2026-08-10' } }],
  ])('rejects %s', (_name, input) => {
    expect(() => parseAnalysisPlan(JSON.stringify(input), dataset)).toThrow('ANALYSIS_PLAN_INVALID');
  });

  it.each([
    '',
    '{',
    'null',
    '[]',
    '```json\n{}',
    `${JSON.stringify(validPlan)}\n\`\`\``,
  ])('normalizes malformed planner output to ANALYSIS_PLAN_INVALID', (input) => {
    expect(() => parseAnalysisPlan(input, dataset)).toThrow('ANALYSIS_PLAN_INVALID');
  });
});

describe('createDefaultAnalysisPlan', () => {
  it('deterministically selects every module, registered metric, safe method, and latest 30 actual dates', () => {
    const inputOrder = [...dataset.daily];
    const first = createDefaultAnalysisPlan(dataset);
    const second = createDefaultAnalysisPlan(dataset);

    expect(first).toEqual(second);
    expect(first.modules).toEqual([...ANALYSIS_MODULES]);
    expect(first.metrics).toEqual(Object.entries(ANALYSIS_METRICS)
      .filter(([, definition]) => Number.isFinite(definition.read(orderedDaily[0]!)))
      .map(([key]) => key));
    expect(first.methods).toEqual(ANALYSIS_METHODS.filter((method) => method !== 'correlation'));
    expect(first.methods).not.toContain('correlation');
    expect(first.dateRange).toEqual({ from: orderedDaily[10].date, to: orderedDaily[39].date });
    expect(first.includeAlerts).toBe(true);
    expect(first.includeHealthWeights).toBe(true);
    expect(dataset.daily).toEqual(inputOrder);
  });

  it('uses the complete actual range when fewer than 30 data dates are available', () => {
    const shortDaily = [...orderedDaily.slice(0, 7)].reverse();
    const shortDataset: DashboardDataset = { ...dataset, daily: shortDaily };

    expect(createDefaultAnalysisPlan(shortDataset).dateRange).toEqual({
      from: orderedDaily[0]!.date,
      to: orderedDaily[6]!.date,
    });
  });

  it('selects the latest 30 actual dates when the calendar contains gaps', () => {
    const gappedDaily = Array.from({ length: 45 }, (_, index) => reading(index * 2)).reverse();
    const actualDates = gappedDaily.map(({ date }) => date).sort((left, right) => left.localeCompare(right));
    const gappedDataset: DashboardDataset = { ...dataset, daily: gappedDaily };

    expect(createDefaultAnalysisPlan(gappedDataset).dateRange).toEqual({
      from: actualDates.at(-30),
      to: actualDates.at(-1),
    });
  });
});
