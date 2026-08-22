import { describe, expect, it, vi } from 'vitest';
import type { SlideOutline } from '../../shared/report';
import type { AnalysisEvidence } from '../src/domain/analysis-evidence';
import type { ReportEvidenceBundle } from '../src/domain/report-evidence';
import { PersistentSafeSlideOutputError } from '../src/domain/report-content-validation';
import type { DeepSeekCompletionRequest } from '../src/services/deepseek-client';
import { DeepSeekServiceError } from '../src/services/deepseek-client';
import {
  composeSlide,
  type SlideComposerDependencies,
} from '../src/services/intent-first-slide-composer';

const settings = {
  apiKey: 'composer-secret-key',
  baseUrl: 'https://deepseek.test/private',
  model: 'private-composer-model',
};

const analysis: AnalysisEvidence = {
  scope: {
    modules: ['water-quality'],
    metrics: ['tn', 'ammonia'],
    dateRange: { from: '2026-08-01', to: '2026-08-31' },
    sampleCount: 31,
    granularity: 'daily',
  },
  definitions: [
    { key: 'tn', label: '总氮（TN）', unit: 'mg/L', limit: 3 },
    { key: 'ammonia', label: '氨氮', unit: 'mg/L', limit: 1.5 },
  ],
  series: [
    { date: '2026-08-01', values: { tn: 2.2, ammonia: 0.4 } },
    { date: '2026-08-31', values: { tn: 2.4, ammonia: 0.5 } },
  ],
  aggregates: {
    tn: { min: 2.2, max: 2.4, average: 2.3, latest: 2.4, changeRate: 0.0909 },
    ammonia: { min: 0.4, max: 0.5, average: 0.45, latest: 0.5, changeRate: 0.25 },
  },
  thresholdBreaches: [],
  correlations: [],
  alerts: [{ date: '2026-08-15', metric: '总氮（TN）', level: '关注', reason: '短时波动', recommendation: '复核进水负荷' }],
};

const dataEvidence: ReportEvidenceBundle = { snapshotId: 'evidence:data-v1', analysis, knowledge: [] };
const flowScoreAnalysis: AnalysisEvidence = {
  scope: {
    modules: ['health'],
    metrics: ['flowScore'],
    dateRange: { from: '2026-08-30', to: '2026-08-31' },
    sampleCount: 2,
    granularity: 'daily',
  },
  definitions: [{ key: 'flowScore', label: '水量波动得分', unit: '分' }],
  series: [
    { date: '2026-08-30', values: { flowScore: 78 } },
    { date: '2026-08-31', values: { flowScore: 80 } },
  ],
  aggregates: {
    flowScore: { min: 78, max: 80, average: 79, latest: 80, changeRate: 2 / 78 },
  },
  thresholdBreaches: [],
  correlations: [],
  alerts: [],
};
const flowScoreEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:flow-score-v1',
  analysis: flowScoreAnalysis,
  knowledge: [],
};
const energyEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:energy-v1',
  analysis: {
    scope: {
      modules: ['energy'],
      metrics: ['totalKwh', 'kwhPerM3'],
      dateRange: { from: '2026-07-10', to: '2026-08-09' },
      sampleCount: 31,
      granularity: 'daily',
    },
    definitions: [
      { key: 'totalKwh', label: '总电耗', unit: 'kWh/d' },
      { key: 'kwhPerM3', label: '吨水电耗', unit: 'kWh/m³' },
    ],
    series: [
      { date: '2026-07-10', values: { totalKwh: 12496, kwhPerM3: 0.439 } },
      { date: '2026-08-09', values: { totalKwh: 12124, kwhPerM3: 0.429 } },
    ],
    aggregates: {
      totalKwh: { min: 12124, max: 12496, average: 12310, latest: 12124, changeRate: -0.0298 },
      kwhPerM3: { min: 0.429, max: 0.439, average: 0.434, latest: 0.429, changeRate: -0.0228 },
    },
    thresholdBreaches: [],
    correlations: [{ left: 'totalKwh', right: 'kwhPerM3', coefficient: 0.9954, samples: 31 }],
    alerts: [],
  },
  knowledge: [],
};
const mixedEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:mixed-v1',
  analysis,
  knowledge: [{ key: 'knowledge:0', topic: '总氮处理机理', provenance: 'model-knowledge' }],
};
const knowledgeEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:knowledge-v1',
  knowledge: [{ key: 'knowledge:0', topic: '污水脱氮', provenance: 'model-knowledge' }],
};
const identityEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:identity-v1',
  knowledge: [],
  assistantProfile: {
    key: 'assistant-profile',
    assistantName: '智慧水务 AI 助手',
    publicModelName: 'DeepSeek v4-flash',
    capabilities: ['解释污水处理知识', '分析受限现场证据'],
    limitations: ['不公开凭证或私有配置'],
  },
};

function outline(overrides: Partial<SlideOutline> = {}): SlideOutline {
  return {
    id: 'slide-0',
    order: 0,
    title: '总氮现状',
    purpose: '直接回答当前总氮状态',
    role: 'answer',
    layout: 'split-insight',
    evidencePolicy: 'data',
    visualKind: 'kpi-grid',
    evidenceKeys: ['tn'],
    status: 'planned',
    ...overrides,
  };
}

function onsiteDraft(overrides: Record<string, unknown> = {}) {
  return {
    title: '总氮现状',
    takeaway: '总氮最新值为 2.4 mg/L。',
    takeawayClaimIds: ['claim-tn'],
    visualKind: 'kpi-grid',
    evidenceKeys: ['tn'],
    claims: [{ id: 'claim-tn', text: '总氮最新值为 2.4 mg/L。', kind: 'onsite-fact', evidenceKeys: ['tn'] }],
    narration: [
      { text: '总氮最新值为 2.4 mg/L。', claimIds: ['claim-tn'] },
      { text: '该数值来自本页绑定的现场证据。', claimIds: ['claim-tn'] },
    ],
    ...overrides,
  };
}

function providerSequence(...responses: Array<unknown | string | Error>): SlideComposerDependencies & {
  requestCompletion: ReturnType<typeof vi.fn>;
} {
  const requestCompletion = vi.fn(async (_request: DeepSeekCompletionRequest) => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === 'string') return response;
    return JSON.stringify(response ?? {});
  });
  return { settings, requestCompletion };
}

function provider(response: unknown) {
  return providerSequence(response, response);
}

describe('composeSlide', () => {
  it('binds claim values, metrics, visuals and immutable snapshot references server-side', async () => {
    const slide = await composeSlide({ outline: outline(), evidence: dataEvidence }, provider(onsiteDraft()));

    expect(slide).toMatchObject({
      id: 'slide-0',
      order: 0,
      evidenceSnapshotId: 'evidence:data-v1',
      evidencePolicy: 'data',
      visual: {
        kind: 'data-dashboard',
        summaryMetrics: [{ key: 'tn', value: 2.4, snapshotId: 'evidence:data-v1', claimIds: ['claim-tn'] }],
        primary: {
          kind: 'trend-area',
          series: [{ key: 'tn', snapshotId: 'evidence:data-v1', claimIds: ['claim-tn'] }],
        },
      },
      metrics: [{ key: 'tn', value: 2.4, snapshotId: 'evidence:data-v1', claimIds: ['claim-tn'] }],
      evidenceRefs: [{ key: 'tn', source: 'excel', snapshotId: 'evidence:data-v1' }],
      claims: [{
        id: 'claim-tn',
        kind: 'onsite-fact',
        evidenceRefs: [{ key: 'tn', source: 'excel', snapshotId: 'evidence:data-v1' }],
      }],
      narration: [{ claimIds: ['claim-tn'] }, { claimIds: ['claim-tn'] }],
    });
    expect(Object.isFrozen(slide)).toBe(true);
    expect(Object.isFrozen(slide.claims[0]!.evidenceRefs)).toBe(true);
  });

  it('composes compatible data metrics into a chart-first dashboard visual', async () => {
    const slide = await composeSlide({
      outline: outline({ visualKind: 'kpi-grid', evidenceKeys: ['tn', 'ammonia'] }),
      evidence: dataEvidence,
    }, provider(onsiteDraft({
      takeaway: '总氮最新值为 2.4 mg/L，氨氮最新值为 0.5 mg/L。',
      takeawayClaimIds: ['claim-tn', 'claim-ammonia'],
      visualKind: 'kpi-grid',
      evidenceKeys: ['tn', 'ammonia'],
      claims: [
        { id: 'claim-tn', text: '总氮最新值为 2.4 mg/L。', kind: 'onsite-fact', evidenceKeys: ['tn'] },
        { id: 'claim-ammonia', text: '氨氮最新值为 0.5 mg/L。', kind: 'onsite-fact', evidenceKeys: ['ammonia'] },
      ],
      narration: [
        { text: '先看总氮和氨氮的共同变化。', claimIds: ['claim-tn', 'claim-ammonia'] },
        { text: '最新值分别为 2.4 和 0.5 mg/L。', claimIds: ['claim-tn', 'claim-ammonia'] },
      ],
    })));

    expect(slide.visual).toMatchObject({
      kind: 'data-dashboard',
      primary: { kind: 'trend-area' },
      supporting: [{ kind: 'comparison-bars' }],
    });
    expect(slide.metrics).toHaveLength(2);
    expect(slide.evidenceRefs.map(({ key }) => key)).toEqual(['tn', 'ammonia']);
  });

  it('falls back to the requested atomic visual when a metric has only one point', async () => {
    const onePointEvidence: ReportEvidenceBundle = {
      snapshotId: 'evidence:one-point-v1',
      analysis: {
        ...analysis,
        scope: {
          ...analysis.scope,
          dateRange: { from: '2026-08-31', to: '2026-08-31' },
          sampleCount: 1,
        },
        series: [{ date: '2026-08-31', values: { tn: 2.4 } }],
      },
      knowledge: [],
    };

    const slide = await composeSlide({
      outline: outline({ visualKind: 'kpi-grid', evidenceKeys: ['tn'] }),
      evidence: onePointEvidence,
    }, provider(onsiteDraft()));

    expect(slide.visual.kind).toBe('kpi-grid');
  });

  it('degrades a mixed-unit one-point comparison fallback into a safe KPI grid', async () => {
    const onePointMixedUnitEvidence: ReportEvidenceBundle = {
      snapshotId: 'evidence:mixed-one-point-v1',
      analysis: {
        ...energyEvidence.analysis!,
        scope: {
          ...energyEvidence.analysis!.scope,
          dateRange: { from: '2026-08-09', to: '2026-08-09' },
          sampleCount: 1,
        },
        series: [{ date: '2026-08-09', values: { totalKwh: 12124, kwhPerM3: 0.429 } }],
      },
      knowledge: [],
    };

    const slide = await composeSlide({
      outline: outline({
        title: '能耗现状',
        purpose: '展示总电耗与吨水电耗现状',
        visualKind: 'comparison-bars',
        evidenceKeys: ['totalKwh', 'kwhPerM3'],
      }),
      evidence: onePointMixedUnitEvidence,
    }, provider({
      title: '能耗现状',
      takeaway: '总电耗最新值为 12124 kWh/d，吨水电耗最新值为 0.429 kWh/m³。',
      takeawayClaimIds: ['claim-total', 'claim-unit'],
      visualKind: 'comparison-bars',
      evidenceKeys: ['totalKwh', 'kwhPerM3'],
      claims: [
        { id: 'claim-total', text: '总电耗最新值为 12124 kWh/d。', kind: 'onsite-fact', evidenceKeys: ['totalKwh'] },
        { id: 'claim-unit', text: '吨水电耗最新值为 0.429 kWh/m³。', kind: 'onsite-fact', evidenceKeys: ['kwhPerM3'] },
      ],
      narration: [
        { text: '先看总电耗最新值 12124 kWh/d。', claimIds: ['claim-total'] },
        { text: '再看吨水电耗最新值 0.429 kWh/m³。', claimIds: ['claim-unit'] },
      ],
    }));

    expect(slide.visual).toMatchObject({
      kind: 'kpi-grid',
      metrics: [{ key: 'totalKwh' }, { key: 'kwhPerM3' }],
    });
  });

  it('degrades an underspecified radar fallback into a safe score visual', async () => {
    const onePointFlowScoreEvidence: ReportEvidenceBundle = {
      snapshotId: 'evidence:flow-score-one-point-v1',
      analysis: {
        ...flowScoreAnalysis,
        scope: {
          ...flowScoreAnalysis.scope,
          dateRange: { from: '2026-08-31', to: '2026-08-31' },
          sampleCount: 1,
        },
        series: [{ date: '2026-08-31', values: { flowScore: 80 } }],
        aggregates: {
          flowScore: { min: 80, max: 80, average: 80, latest: 80, changeRate: 0 },
        },
      },
      knowledge: [],
    };

    const slide = await composeSlide({
      outline: outline({
        title: '水量健康得分',
        purpose: '展示当前水量健康得分',
        visualKind: 'radar',
        evidenceKeys: ['flowScore'],
      }),
      evidence: onePointFlowScoreEvidence,
    }, provider({
      title: '水量健康得分',
      takeaway: '水量波动得分最新值为 80 分。',
      takeawayClaimIds: ['claim-score'],
      visualKind: 'radar',
      evidenceKeys: ['flowScore'],
      claims: [
        { id: 'claim-score', text: '水量波动得分最新值为 80 分。', kind: 'onsite-fact', evidenceKeys: ['flowScore'] },
      ],
      narration: [
        { text: '当前水量波动得分为 80 分。', claimIds: ['claim-score'] },
        { text: '该得分来自本页绑定的现场证据。', claimIds: ['claim-score'] },
      ],
    }));

    expect(slide.visual).toMatchObject({
      kind: 'data-dashboard',
      summaryMetrics: [{ key: 'flowScore', value: 80 }],
      primary: { kind: 'health-ring' },
      supporting: [],
    });
  });

  it('binds a user correction as explicit unverified provenance without changing Excel evidence', async () => {
    const correctionEvidence = {
      ...dataEvidence,
      snapshotId: 'evidence:correction-v1',
      userCorrections: [{
        key: 'user-correction:tn',
        evidenceKey: 'tn',
        value: 2.1,
        unit: 'mg/L',
        statement: '用户修正总氮为 2.1 mg/L',
        provenance: 'user-provided-unverified',
        sourceSlideId: 'slide-source',
        sourceEvidenceSnapshotId: dataEvidence.snapshotId,
        createdAt: '2026-08-14T00:00:00.000Z',
      }],
    } satisfies ReportEvidenceBundle;
    const correctionOutline = outline({
      evidencePolicy: 'mixed',
      visualKind: 'comparison-bars',
      evidenceKeys: ['tn', 'user-correction:tn'],
    });
    const correctionDraft = {
      title: '总氮纠正对照',
      takeaway: 'Excel 现场值为 2.4 mg/L；用户提供的 2.1 mg/L 未经现场数据核验。',
      takeawayClaimIds: ['claim-excel', 'claim-user'],
      visualKind: 'comparison-bars',
      evidenceKeys: ['tn', 'user-correction:tn'],
      claims: [
        { id: 'claim-excel', text: 'Excel 现场最新总氮为 2.4 mg/L。', kind: 'onsite-fact', evidenceKeys: ['tn'] },
        { id: 'claim-user', text: '用户提供总氮 2.1 mg/L，未经现场数据核验。', kind: 'user-provided', evidenceKeys: ['user-correction:tn'] },
      ],
      narration: [
        { text: '先看 Excel 现场值 2.4 mg/L。', claimIds: ['claim-excel'] },
        { text: '再看用户提供且未核验的 2.1 mg/L。', claimIds: ['claim-user'] },
      ],
    };

    const composed = await composeSlide(
      { outline: correctionOutline, evidence: correctionEvidence },
      provider(correctionDraft),
    );

    expect(correctionEvidence.analysis).toEqual(analysis);
    expect(composed.metrics).toEqual([
      expect.objectContaining({ key: 'tn', value: 2.4, source: 'excel' }),
      expect.objectContaining({
        key: 'user-correction:tn', value: 2.1, source: 'user-correction',
        dateRange: undefined, sampleCount: undefined,
      }),
    ]);
    expect(composed.claims[1]).toMatchObject({
      kind: 'user-provided',
      evidenceRefs: [{ source: 'user-correction', key: 'user-correction:tn' }],
    });

    await expect(composeSlide(
      { outline: correctionOutline, evidence: correctionEvidence },
      provider({
        ...correctionDraft,
        claims: correctionDraft.claims.map((claim) => claim.id === 'claim-user'
          ? { ...claim, text: '用户提供总氮 ９９９９ mg/L，未经现场数据核验。' }
          : claim),
      }),
    )).rejects.toThrow('REPORT_EVIDENCE_INVALID');
  });

  it('derives mixed page policy and validates every onsite claim against only its own evidence subset', async () => {
    const mixedOutline = outline({
      evidencePolicy: 'mixed',
      evidenceKeys: ['tn', 'knowledge:0'],
      visualKind: 'kpi-grid',
    });
    const valid = onsiteDraft({
      evidenceKeys: ['tn', 'knowledge:0'],
      claims: [
        { id: 'claim-tn', text: '总氮最新值为 2.4 mg/L。', kind: 'onsite-fact', evidenceKeys: ['tn'] },
        { id: 'claim-mechanism', text: '脱氮机理可用于解释指标变化。', kind: 'knowledge', evidenceKeys: ['knowledge:0'] },
      ],
      takeawayClaimIds: ['claim-tn', 'claim-mechanism'],
      narration: [
        { text: '先看现场总氮值。', claimIds: ['claim-tn'] },
        { text: '再结合通用脱氮机理理解。', claimIds: ['claim-mechanism'] },
      ],
    });
    const slide = await composeSlide({ outline: mixedOutline, evidence: mixedEvidence }, provider(valid));
    expect(slide.evidencePolicy).toBe('mixed');
    expect(slide.claims[1]).toMatchObject({ kind: 'knowledge', evidenceRefs: [{ source: 'model-knowledge' }] });

    const unbound = provider(onsiteDraft({
      evidenceKeys: ['tn', 'ammonia'],
      claims: [{ id: 'claim-tn', text: '氨氮最新值为 0.5 mg/L。', kind: 'onsite-fact', evidenceKeys: ['tn'] }],
    }));
    await expect(composeSlide({
      outline: outline({ evidenceKeys: ['tn', 'ammonia'] }),
      evidence: dataEvidence,
    }, unbound)).rejects.toThrow('REPORT_EVIDENCE_INVALID');
    expect(unbound.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('binds every onsite metric name and status word to that claim own evidence', async () => {
    for (const metricName of ['氨氮', 'NH3-N']) {
      const wrongMetric = provider(onsiteDraft({
        claims: [{
          id: 'claim-tn',
          text: `${metricName}最新值为 2.4 mg/L。`,
          kind: 'onsite-fact',
          evidenceKeys: ['tn'],
        }],
      }));
      await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, wrongMetric))
        .rejects.toThrow('REPORT_EVIDENCE_INVALID');
      expect(wrongMetric.requestCompletion).toHaveBeenCalledTimes(2);
    }

    for (const status of ['超标', '不达标', '关注']) {
      const wrongStatus = provider(onsiteDraft({
        claims: [{
          id: 'claim-tn',
          text: `总氮当前${status}。`,
          kind: 'onsite-fact',
          evidenceKeys: ['tn'],
        }],
      }));
      await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, wrongStatus))
        .rejects.toThrow('REPORT_EVIDENCE_INVALID');
      expect(wrongStatus.requestCompletion).toHaveBeenCalledTimes(2);
    }

    const validAliasAndStatus = provider(onsiteDraft({
      takeaway: 'TN 最新值为 2.4 mg/L，当前达标。',
      claims: [{
        id: 'claim-tn',
        text: 'TN 最新值为 2.4 mg/L，当前达标。',
        kind: 'onsite-fact',
        evidenceKeys: ['tn'],
      }],
      narration: [
        { text: 'TN 最新值为 2.4 mg/L。', claimIds: ['claim-tn'] },
        { text: '该指标当前达标。', claimIds: ['claim-tn'] },
      ],
    }));
    await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, validAliasAndStatus))
      .resolves.toMatchObject({ claims: [{ id: 'claim-tn' }] });
    expect(validAliasAndStatus.requestCompletion).toHaveBeenCalledTimes(1);
  });

  it('accepts an evidenced negative change rate as a positive decline magnitude only with decline wording', async () => {
    const declineEvidence: ReportEvidenceBundle = {
      ...dataEvidence,
      snapshotId: 'evidence:decline-v1',
      analysis: {
        ...analysis,
        series: [
          { date: '2026-08-01', values: { tn: 2.4, ammonia: 0.4 } },
          { date: '2026-08-31', values: { tn: 2.2, ammonia: 0.5 } },
        ],
        aggregates: {
          ...analysis.aggregates,
          tn: { min: 2.2, max: 2.4, average: 2.3, latest: 2.2, changeRate: -0.0833 },
        },
      },
    };
    const declineDraft = onsiteDraft({
      takeaway: '总氮从 2.4 mg/L 下降至 2.2 mg/L，降幅 8.33%。',
      claims: [{
        id: 'claim-tn',
        text: '总氮从 2.4 mg/L 下降至 2.2 mg/L，降幅 8.33%。',
        kind: 'onsite-fact',
        evidenceKeys: ['tn'],
      }],
      narration: [
        { text: '总氮从 2.4 mg/L 下降至 2.2 mg/L。', claimIds: ['claim-tn'] },
        { text: '该指标降幅为 8.33%。', claimIds: ['claim-tn'] },
      ],
    });

    await expect(composeSlide({ outline: outline(), evidence: declineEvidence }, provider(declineDraft)))
      .resolves.toMatchObject({ takeaway: expect.stringContaining('降幅 8.33%') });

    const falseIncrease = providerSequence(
      onsiteDraft({
        takeaway: '总氮升高 8.33%。',
        claims: [{ id: 'claim-tn', text: '总氮升高 8.33%。', kind: 'onsite-fact', evidenceKeys: ['tn'] }],
      }),
      onsiteDraft({
        takeaway: '总氮升高 8.33%。',
        claims: [{ id: 'claim-tn', text: '总氮升高 8.33%。', kind: 'onsite-fact', evidenceKeys: ['tn'] }],
      }),
    );
    await expect(composeSlide({ outline: outline(), evidence: declineEvidence }, falseIncrease))
      .rejects.toThrow('REPORT_EVIDENCE_INVALID');
  });

  it('binds a computed correlation coefficient only when both metric keys support the claim', async () => {
    const correlationEvidence: ReportEvidenceBundle = {
      ...dataEvidence,
      snapshotId: 'evidence:correlation-v1',
      analysis: {
        ...analysis,
        correlations: [{ left: 'tn', right: 'ammonia', coefficient: 0.9954, samples: 31 }],
      },
    };
    const correlationOutline = outline({ evidenceKeys: ['tn', 'ammonia'] });
    const correlationDraft = onsiteDraft({
      evidenceKeys: ['tn', 'ammonia'],
      takeaway: '总氮与氨氮的相关系数为 0.9954。',
      claims: [{
        id: 'claim-correlation',
        text: '总氮与氨氮的相关系数为 0.9954。',
        kind: 'onsite-fact',
        evidenceKeys: ['tn', 'ammonia'],
      }],
      takeawayClaimIds: ['claim-correlation'],
      narration: [
        { text: '总氮与氨氮的相关系数为 0.9954。', claimIds: ['claim-correlation'] },
        { text: '两个指标呈高度同步变化。', claimIds: ['claim-correlation'] },
      ],
    });

    await expect(composeSlide({ outline: correlationOutline, evidence: correlationEvidence }, provider(correlationDraft)))
      .resolves.toMatchObject({ claims: [{ evidenceRefs: [{ key: 'tn' }, { key: 'ammonia' }] }] });

    const correlationWithAveragesAndSample = onsiteDraft({
      evidenceKeys: ['tn', 'ammonia'],
      takeaway: '总氮平均为 2.3 mg/L，氨氮平均为 0.45 mg/L，相关系数为 0.9954（31 个样本）。',
      claims: [{
        id: 'claim-correlation',
        text: '总氮平均为 2.3 mg/L，氨氮平均为 0.45 mg/L，相关系数为 0.9954（31 个样本）。',
        kind: 'onsite-fact', evidenceKeys: ['tn', 'ammonia'],
      }],
      takeawayClaimIds: ['claim-correlation'],
      narration: [
        { text: '总氮平均为 2.3 mg/L，氨氮平均为 0.45 mg/L。', claimIds: ['claim-correlation'] },
        { text: '相关系数为 0.9954，样本数为 31。', claimIds: ['claim-correlation'] },
      ],
    });
    const averagesOnly = {
      ...correlationWithAveragesAndSample,
      takeaway: '总氮平均为 2.3 mg/L，氨氮平均为 0.45 mg/L。',
      claims: [{
        ...correlationWithAveragesAndSample.claims[0],
        text: '总氮平均为 2.3 mg/L，氨氮平均为 0.45 mg/L。',
      }],
      narration: [
        { text: '总氮平均为 2.3 mg/L。', claimIds: ['claim-correlation'] },
        { text: '氨氮平均为 0.45 mg/L。', claimIds: ['claim-correlation'] },
      ],
    };
    await expect(composeSlide(
      { outline: correlationOutline, evidence: correlationEvidence },
      provider(averagesOnly),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('2.3 mg/L') });
    const correlationAndSampleOnly = {
      ...correlationWithAveragesAndSample,
      takeaway: '相关系数为 0.9954（31 个样本）。',
      claims: [{
        ...correlationWithAveragesAndSample.claims[0],
        text: '相关系数为 0.9954（31 个样本）。',
      }],
      narration: [
        { text: '相关系数为 0.9954。', claimIds: ['claim-correlation'] },
        { text: '样本数为 31。', claimIds: ['claim-correlation'] },
      ],
    };
    await expect(composeSlide(
      { outline: correlationOutline, evidence: correlationEvidence },
      provider(correlationAndSampleOnly),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('31 个样本') });
    await expect(composeSlide(
      { outline: correlationOutline, evidence: correlationEvidence },
      provider(correlationWithAveragesAndSample),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('31 个样本') });

    const mismatchedCorrelationSamples: ReportEvidenceBundle = {
      ...correlationEvidence,
      analysis: {
        ...correlationEvidence.analysis!,
        correlations: [{ left: 'tn', right: 'ammonia', coefficient: 0.9954, samples: 2 }],
      },
    };
    await expect(composeSlide(
      { outline: correlationOutline, evidence: mismatchedCorrelationSamples },
      providerSequence(correlationAndSampleOnly, correlationAndSampleOnly),
    )).rejects.toThrow('REPORT_EVIDENCE_INVALID');
  });

  it('parses compact energy units without consuming following Chinese text or the metric label prefix', async () => {
    const energyOutline = outline({
      title: '能耗变化',
      purpose: '说明总电耗与吨水电耗变化',
      visualKind: 'trend-line',
      evidenceKeys: ['totalKwh', 'kwhPerM3'],
    });
    const draft = onsiteDraft({
      title: '能耗变化',
      takeaway: '总电耗与吨水电耗均下降。',
      takeawayClaimIds: ['claim-total', 'claim-specific'],
      visualKind: 'trend-line',
      evidenceKeys: ['totalKwh', 'kwhPerM3'],
      claims: [
        {
          id: 'claim-total',
          text: '总电耗由12496 kWh/d下降至12124 kWh/d，降幅约2.98%。',
          kind: 'onsite-fact',
          evidenceKeys: ['totalKwh'],
        },
        {
          id: 'claim-specific',
          text: '吨水电耗由0.439 kWh/m³下降至0.429 kWh/m³，降幅约2.28%。',
          kind: 'onsite-fact',
          evidenceKeys: ['kwhPerM3'],
        },
      ],
      narration: [
        { text: '总电耗由12496 kWh/d下降至12124 kWh/d。', claimIds: ['claim-total'] },
        { text: '吨水电耗由0.439 kWh/m³下降至0.429 kWh/m³。', claimIds: ['claim-specific'] },
      ],
    });

    await expect(composeSlide({ outline: energyOutline, evidence: energyEvidence }, provider(draft)))
      .resolves.toMatchObject({ metrics: [{ unit: 'kWh/d' }, { unit: 'kWh/m³' }] });
  });

  it('uses the longest overlapping metric alias for onsite claim binding', async () => {
    const flowOutline = outline({
      title: '水量波动得分',
      purpose: '说明当前水量波动得分',
      role: 'evidence',
      layout: 'visual-focus',
      evidencePolicy: 'data',
      visualKind: 'kpi-grid',
      evidenceKeys: ['flowScore'],
    });
    const dependency = provider({
      title: '水量波动得分',
      takeaway: '水量波动得分最新值为 80。',
      takeawayClaimIds: ['claim-flow-score'],
      visualKind: 'kpi-grid',
      evidenceKeys: ['flowScore'],
      claims: [{
        id: 'claim-flow-score',
        text: '水量波动得分最新值为 80。',
        kind: 'onsite-fact',
        evidenceKeys: ['flowScore'],
      }],
      narration: [
        { text: '水量波动得分最新值为 80。', claimIds: ['claim-flow-score'] },
        { text: '该值来自本页现场证据。', claimIds: ['claim-flow-score'] },
      ],
    });

    await expect(composeSlide({ outline: flowOutline, evidence: flowScoreEvidence }, dependency))
      .resolves.toMatchObject({
        claims: [{ id: 'claim-flow-score', evidenceRefs: [{ key: 'flowScore' }] }],
        metrics: [{ key: 'flowScore', value: 80, claimIds: ['claim-flow-score'] }],
      });
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
  });

  it('prevents knowledge claims from smuggling onsite numerics', async () => {
    const knowledgeOutline = outline({
      title: '脱氮原理',
      purpose: '解释通用机理',
      role: 'knowledge',
      layout: 'concept-center',
      evidencePolicy: 'knowledge',
      visualKind: 'concept-map',
      evidenceKeys: ['knowledge:0'],
    });
    const dependency = provider({
      title: '脱氮原理',
      takeaway: '本厂总氮为 2.4 mg/L。',
      takeawayClaimIds: ['claim-k'],
      visualKind: 'concept-map',
      evidenceKeys: ['knowledge:0'],
      claims: [{ id: 'claim-k', text: '本厂总氮为 2.4 mg/L。', kind: 'knowledge', evidenceKeys: ['knowledge:0'] }],
      narration: [
        { text: '这是现场数值。', claimIds: ['claim-k'] },
        { text: '但没有 Excel 证据。', claimIds: ['claim-k'] },
      ],
      knowledgeItems: [{ title: '总氮', detail: '本厂为 2.4 mg/L' }],
    });

    await expect(composeSlide({ outline: knowledgeOutline, evidence: knowledgeEvidence }, dependency))
      .rejects.toThrow('REPORT_EVIDENCE_INVALID');
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('screens knowledge visual items for onsite numeric smuggling on mixed pages', async () => {
    const mixedOutline = outline({
      title: '总氮现状与机理',
      purpose: '结合现场指标解释通用机理',
      role: 'knowledge',
      layout: 'concept-center',
      evidencePolicy: 'mixed',
      visualKind: 'concept-map',
      evidenceKeys: ['tn', 'knowledge:0'],
    });
    const dependency = provider({
      title: '总氮现状与机理',
      takeaway: '总氮最新值为 2.4 mg/L，可结合脱氮机理理解。',
      takeawayClaimIds: ['claim-tn', 'claim-k'],
      visualKind: 'concept-map',
      evidenceKeys: ['tn', 'knowledge:0'],
      claims: [
        { id: 'claim-tn', text: '总氮最新值为 2.4 mg/L。', kind: 'onsite-fact', evidenceKeys: ['tn'] },
        { id: 'claim-k', text: '脱氮机理可解释氮素转化过程。', kind: 'knowledge', evidenceKeys: ['knowledge:0'] },
      ],
      narration: [
        { text: '先看总氮最新值 2.4 mg/L。', claimIds: ['claim-tn'] },
        { text: '再看通用脱氮机理。', claimIds: ['claim-k'] },
      ],
      knowledgeItems: [{ title: '硝化与反硝化', detail: '本厂总氮为 99 mg/L。' }],
    });

    await expect(composeSlide({ outline: mixedOutline, evidence: mixedEvidence }, dependency))
      .rejects.toThrow('REPORT_EVIDENCE_INVALID');
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('requires hypothesis claims to use explicit uncertainty language', async () => {
    const dependency = provider(onsiteDraft({
      takeaway: '进水负荷导致波动。',
      takeawayClaimIds: ['claim-h'],
      claims: [{ id: 'claim-h', text: '进水负荷导致波动。', kind: 'hypothesis', evidenceKeys: [] }],
      narration: [
        { text: '进水负荷导致波动。', claimIds: ['claim-h'] },
        { text: '这是原因结论。', claimIds: ['claim-h'] },
      ],
    }));

    await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, dependency))
      .rejects.toThrow('REPORT_EVIDENCE_INVALID');
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('accepts an explicit hypothesis with numeric evidence while keeping it unverified', async () => {
    const dependency = provider(onsiteDraft({
      takeaway: '基于总氮 2.4 mg/L，进水负荷可能与波动有关，待验证。',
      takeawayClaimIds: ['claim-h'],
      claims: [{
        id: 'claim-h',
        text: '基于总氮 2.4 mg/L，进水负荷可能与波动有关，待验证。',
        kind: 'hypothesis',
        evidenceKeys: ['tn'],
      }],
      narration: [
        { text: '总氮最新值是 2.4 mg/L。', claimIds: ['claim-h'] },
        { text: '进水负荷可能是影响因素，仍待验证。', claimIds: ['claim-h'] },
      ],
    }));

    const slide = await composeSlide({ outline: outline(), evidence: dataEvidence }, dependency);
    expect(slide.claims[0]).toMatchObject({ kind: 'hypothesis', evidenceRefs: [{ key: 'tn' }] });
  });

  it('rejects a knowledge-kind claim that borrows Excel evidence to state an onsite value', async () => {
    const dependency = provider(onsiteDraft({
      takeaway: '这是一条知识说明。',
      claims: [{
        id: 'claim-tn',
        text: '本厂总氮最新值为 2.4 mg/L。',
        kind: 'knowledge',
        evidenceKeys: ['tn'],
      }],
      narration: [
        { text: '这是一条知识说明。', claimIds: ['claim-tn'] },
        { text: '不应被当作现场事实。', claimIds: ['claim-tn'] },
      ],
    }));

    await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, dependency))
      .rejects.toThrow('REPORT_EVIDENCE_INVALID');
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('allows only the exact trusted public name on an assistant-profile identity page', async () => {
    const identityOutline = outline({
      title: '助手身份',
      purpose: '回答模型身份与能力边界',
      role: 'answer',
      layout: 'concept-center',
      evidencePolicy: 'knowledge',
      visualKind: 'capability-map',
      evidenceKeys: ['assistant-profile'],
    });
    const identityDraft = {
      title: '助手身份',
      takeaway: '公开模型名称是 DeepSeek v4-flash。',
      takeawayClaimIds: ['claim-profile'],
      visualKind: 'capability-map',
      evidenceKeys: ['assistant-profile'],
      claims: [{
        id: 'claim-profile',
        text: '公开模型名称是 DeepSeek v4-flash。',
        kind: 'knowledge',
        evidenceKeys: ['assistant-profile'],
      }],
      narration: [
        { text: '我是智慧水务 AI 助手。', claimIds: ['claim-profile'] },
        { text: '公开模型名称是 DeepSeek v4-flash。', claimIds: ['claim-profile'] },
      ],
      knowledgeItems: [{ title: '现场分析', detail: '只使用受限证据。' }],
    };

    const slide = await composeSlide({ outline: identityOutline, evidence: identityEvidence }, provider(identityDraft));
    expect(slide.takeaway).toContain('DeepSeek v4-flash');
    expect(slide.evidenceRefs).toEqual([
      expect.objectContaining({ key: 'assistant-profile', source: 'assistant-profile', snapshotId: 'evidence:identity-v1' }),
    ]);

    const crossSource = provider({ ...identityDraft, evidenceKeys: ['assistant-profile', 'knowledge:0'] });
    await expect(composeSlide({
      outline: { ...identityOutline, evidenceKeys: ['assistant-profile', 'knowledge:0'] },
      evidence: { ...identityEvidence, knowledge: knowledgeEvidence.knowledge },
    }, crossSource)).rejects.toThrow('REPORT_EVIDENCE_INVALID');
    expect(crossSource.requestCompletion).toHaveBeenCalledTimes(2);

    const untrustedName = provider({
      ...identityDraft,
      takeaway: '公开模型名称是 Qwen private-preview。',
      claims: [{
        ...identityDraft.claims[0],
        text: '公开模型名称是 Qwen private-preview。',
      }],
    });
    await expect(composeSlide({ outline: identityOutline, evidence: identityEvidence }, untrustedName))
      .rejects.toThrow('REPORT_SLIDE_DRAFT_INVALID');
    expect(untrustedName.requestCompletion).toHaveBeenCalledTimes(2);

    for (const assertion of [
      '我由 GPT-5 驱动。',
      '我由 Claude 驱动。',
      '我由 Gemini 驱动。',
      '我由 Qwen 驱动。',
      '我由 Moonshot Kimi 驱动。',
      '本助手使用 Yi-Large 模型。',
    ]) {
      const alternateIdentity = provider({
        ...identityDraft,
        takeaway: assertion,
        claims: [{ ...identityDraft.claims[0], text: assertion }],
      });
      await expect(composeSlide({ outline: identityOutline, evidence: identityEvidence }, alternateIdentity))
        .rejects.toThrow('REPORT_SLIDE_DRAFT_INVALID');
      expect(alternateIdentity.requestCompletion).toHaveBeenCalledTimes(2);
    }

    await expect(composeSlide(
      { outline: identityOutline, evidence: identityEvidence },
      provider({
        ...identityDraft,
        takeaway: '本助手由 DeepSeek v4-flash 驱动。',
        claims: [{ ...identityDraft.claims[0], text: '本助手由 DeepSeek v4-flash 驱动。' }],
      }),
    )).resolves.toMatchObject({ takeaway: '本助手由 DeepSeek v4-flash 驱动。' });
  });

  it('rejects assistant identity assertions that cite only model knowledge on a mixed-identity report', async () => {
    const mixedIdentityEvidence: ReportEvidenceBundle = {
      ...knowledgeEvidence,
      snapshotId: 'evidence:mixed-identity-v1',
      assistantProfile: identityEvidence.assistantProfile,
    };
    const knowledgeOutline = outline({
      title: '模型知识说明',
      purpose: '解释模型相关知识',
      role: 'knowledge',
      layout: 'concept-center',
      evidencePolicy: 'knowledge',
      visualKind: 'capability-map',
      evidenceKeys: ['knowledge:0'],
    });
    const untrustedIdentityDraft = {
      title: '模型知识说明',
      takeaway: '本助手由 GPT-5 驱动。',
      takeawayClaimIds: ['claim-k'],
      visualKind: 'capability-map',
      evidenceKeys: ['knowledge:0'],
      claims: [{
        id: 'claim-k',
        text: '本助手由 GPT-5 驱动。',
        kind: 'knowledge',
        evidenceKeys: ['knowledge:0'],
      }],
      narration: [
        { text: '本助手由 GPT-5 驱动。', claimIds: ['claim-k'] },
        { text: '这是模型身份说明。', claimIds: ['claim-k'] },
      ],
      knowledgeItems: [{ title: '模型身份', detail: '本助手由 GPT-5 驱动。' }],
    };

    for (const assertion of [
      '智慧水务 AI 助手的底层引擎采用 DeepSeek。',
      '这个助手由 DeepSeek 驱动。',
      '智慧水务助手的底层引擎是 DeepSeek。',
    ]) {
      const exactAssistantNameWithoutProfile = {
        ...untrustedIdentityDraft,
        takeaway: assertion,
        claims: [{ ...untrustedIdentityDraft.claims[0], text: assertion }],
        narration: [
          { text: assertion, claimIds: ['claim-k'] },
          { text: '这是助手身份声明。', claimIds: ['claim-k'] },
        ],
        knowledgeItems: [{ title: '模型身份', detail: assertion }],
      };
      await expect(composeSlide(
        { outline: knowledgeOutline, evidence: knowledgeEvidence },
        providerSequence(exactAssistantNameWithoutProfile, exactAssistantNameWithoutProfile),
      )).rejects.toThrow('REPORT_SLIDE_DRAFT_INVALID');
    }

    await expect(composeSlide(
      { outline: knowledgeOutline, evidence: mixedIdentityEvidence },
      providerSequence(untrustedIdentityDraft, untrustedIdentityDraft),
    )).rejects.toThrow('REPORT_SLIDE_DRAFT_INVALID');

    const publicNameWithoutProfile = {
      ...untrustedIdentityDraft,
      takeaway: '公开模型名称是 DeepSeek v4-flash。',
      claims: [{
        ...untrustedIdentityDraft.claims[0],
        text: '公开模型名称是 DeepSeek v4-flash。',
      }],
    };
    await expect(composeSlide(
      { outline: knowledgeOutline, evidence: mixedIdentityEvidence },
      providerSequence(publicNameWithoutProfile, publicNameWithoutProfile),
    )).rejects.toThrow('REPORT_SLIDE_DRAFT_INVALID');

    const assistantNamedWithoutProfile = {
      ...untrustedIdentityDraft,
      takeaway: '智慧水务 AI 助手的底层引擎为 DeepSeek v4-flash。',
      claims: [{
        ...untrustedIdentityDraft.claims[0],
        text: '智慧水务 AI 助手的底层引擎为 DeepSeek v4-flash。',
      }],
    };
    await expect(composeSlide(
      { outline: knowledgeOutline, evidence: mixedIdentityEvidence },
      providerSequence(assistantNamedWithoutProfile, assistantNamedWithoutProfile),
    )).rejects.toThrow('REPORT_SLIDE_DRAFT_INVALID');

    const trustedOutline = outline({
      title: '助手身份', purpose: '回答模型身份', role: 'answer', layout: 'concept-center',
      evidencePolicy: 'knowledge', visualKind: 'capability-map', evidenceKeys: ['assistant-profile'],
    });
    const wrongCurrentModel = {
      title: '助手身份',
      takeaway: '当前模型是 Moonshot Kimi。',
      takeawayClaimIds: ['claim-profile'],
      visualKind: 'capability-map',
      evidenceKeys: ['assistant-profile'],
      claims: [{
        id: 'claim-profile', text: '当前模型是 Moonshot Kimi。',
        kind: 'knowledge', evidenceKeys: ['assistant-profile'],
      }],
      narration: [
        { text: '当前模型是 Moonshot Kimi。', claimIds: ['claim-profile'] },
        { text: '这是助手身份说明。', claimIds: ['claim-profile'] },
      ],
      knowledgeItems: [{ title: '模型身份', detail: '当前模型是 Moonshot Kimi。' }],
    };
    await expect(composeSlide(
      { outline: trustedOutline, evidence: identityEvidence },
      providerSequence(wrongCurrentModel, wrongCurrentModel),
    )).rejects.toThrow('REPORT_SLIDE_DRAFT_INVALID');
  });

  it('allows a capability map for ordinary model knowledge and binds its elements to claims', async () => {
    const knowledgeOutline = outline({
      title: '脱氮能力路径',
      purpose: '解释通用脱氮能力',
      role: 'knowledge',
      layout: 'concept-center',
      evidencePolicy: 'knowledge',
      visualKind: 'capability-map',
      evidenceKeys: ['knowledge:0'],
    });
    const draft = {
      title: '脱氮能力路径',
      takeaway: '脱氮过程需要监测与调控协同。',
      takeawayClaimIds: ['claim-k'],
      visualKind: 'capability-map',
      evidenceKeys: ['knowledge:0'],
      claims: [{
        id: 'claim-k',
        text: '脱氮过程需要监测与调控协同。',
        kind: 'knowledge',
        evidenceKeys: ['knowledge:0'],
      }],
      narration: [
        { text: '先说明监测能力。', claimIds: ['claim-k'] },
        { text: '再说明调控能力。', claimIds: ['claim-k'] },
      ],
      knowledgeItems: [{ title: '监测与调控', detail: '围绕通用脱氮流程协同。' }],
    };

    await expect(composeSlide({ outline: knowledgeOutline, evidence: knowledgeEvidence }, provider(draft)))
      .resolves.toMatchObject({
        visual: { kind: 'capability-map', items: [{ claimIds: ['claim-k'] }] },
      });
  });

  it('accepts an alert-only page without repeating global workbook metadata or unrelated units', async () => {
    const alertOutline = outline({
      id: 'slide-alert',
      order: 1,
      title: '近期相似运行预警',
      purpose: '回顾已绑定的运行预警',
      role: 'risk',
      layout: 'visual-focus',
      evidencePolicy: 'data',
      visualKind: 'alert-timeline',
      evidenceKeys: ['alert:0'],
    });
    const alertDraft = {
      title: '近期相似运行预警',
      takeaway: '2026-08-15 出现总氮关注预警。',
      takeawayClaimIds: ['claim-alert'],
      visualKind: 'alert-timeline',
      evidenceKeys: ['alert:0'],
      claims: [{
        id: 'claim-alert',
        text: '2026-08-15 出现总氮关注预警，原因为短时波动。',
        kind: 'onsite-fact',
        evidenceKeys: ['alert:0'],
      }],
      narration: [
        { text: '这条预警记录了短时波动。', claimIds: ['claim-alert'] },
        { text: '建议复核进水负荷。', claimIds: ['claim-alert'] },
      ],
    };

    const slide = await composeSlide({ outline: alertOutline, evidence: dataEvidence }, provider(alertDraft));
    expect(slide).toMatchObject({
      visual: {
        kind: 'data-dashboard',
        primary: {
          kind: 'alert-timeline',
          items: [{ id: 'alert:0', snapshotId: 'evidence:data-v1', claimIds: ['claim-alert'] }],
        },
      },
      evidencePolicy: 'data',
    });
    expect(slide.claims[0]!.evidenceRefs).toEqual([
      expect.objectContaining({
        key: 'alert:0',
        source: 'excel',
        snapshotId: 'evidence:data-v1',
        dateRange: { from: '2026-08-15', to: '2026-08-15' },
        sampleCount: 1,
      }),
    ]);
    expect(slide.evidenceRefs).toEqual(slide.claims[0]!.evidenceRefs);
    const narration = slide.narration.map(({ text }) => text).join('\n');
    expect(narration).not.toContain('2026-08-01');
    expect(narration).not.toContain('2026-08-31');
    expect(narration).not.toContain('31');
    expect(narration).not.toContain('mg/L');

    const inferredAlertCause = {
      ...alertDraft,
      takeaway: '短时波动导致总氮升高。',
      claims: [{
        ...alertDraft.claims[0],
        text: '2026-08-15 的短时波动导致总氮升高。',
      }],
    };
    await expect(composeSlide(
      { outline: alertOutline, evidence: dataEvidence },
      providerSequence(inferredAlertCause, inferredAlertCause),
    )).rejects.toThrow('REPORT_EVIDENCE_INVALID');

    const appendedCause = {
      ...alertDraft,
      takeaway: '短时波动，主因是进水冲击。',
      claims: [{
        ...alertDraft.claims[0],
        text: '2026-08-15 记录短时波动，主因是进水冲击。',
      }],
    };
    await expect(composeSlide(
      { outline: alertOutline, evidence: dataEvidence },
      providerSequence(appendedCause, appendedCause),
    )).rejects.toThrow('REPORT_EVIDENCE_INVALID');
  });

  it('binds historical breach counts, breach dates and localized evidence months on a current-status page', async () => {
    const historicalEvidence: ReportEvidenceBundle = {
      ...dataEvidence,
      snapshotId: 'evidence:historical-breach-v1',
      analysis: {
        ...analysis,
        series: [
          { date: '2026-08-02', values: { tn: 2, ammonia: 0.42 } },
          { date: '2026-08-01', values: { tn: 2.2, ammonia: 0.4 } },
          { date: '2026-08-15', values: { tn: 3.13, ammonia: 0.45 } },
          { date: '2026-08-31', values: { tn: 2.4, ammonia: 0.5 } },
        ],
        thresholdBreaches: [{ date: '2026-08-15', metric: 'tn', value: 3.13, limit: 3 }],
      },
    };
    const historicalOutline = outline({ evidenceKeys: ['tn', 'alert:0'] });
    const historicalDraft = onsiteDraft({
      evidenceKeys: ['tn', 'alert:0'],
      takeaway: '最新月份 2026-08 的总氮值为 2.4 mg/L，低于限值 3 mg/L，当前达标；监测期内有 1 次超标。',
      takeawayClaimIds: ['claim-current', 'claim-history'],
      claims: [
        {
          id: 'claim-current',
          text: '总氮最新值 2.4 mg/L，低于限值 3 mg/L，当前达标。',
          kind: 'onsite-fact',
          evidenceKeys: ['tn'],
        },
        {
          id: 'claim-history',
          text: '2026-08-01 至 2026-08-31 监测期内有 1 次超标，2026-08-15 最高值为 3.13 mg/L。',
          kind: 'onsite-fact',
          evidenceKeys: ['tn'],
        },
        {
          id: 'claim-alert',
          text: '2026-08-15 出现总氮短时波动预警。',
          kind: 'onsite-fact',
          evidenceKeys: ['alert:0'],
        },
      ],
      narration: [
        { text: '截至 2026 年 8 月，总氮最新值 2.4 mg/L，当前达标。', claimIds: ['claim-current'] },
        { text: '监测期内有 1 次超标，最高值为 3.13 mg/L。', claimIds: ['claim-history'] },
        { text: '2026-08-15 的预警记录了短时波动。', claimIds: ['claim-alert'] },
      ],
    });

    await expect(composeSlide({ outline: historicalOutline, evidence: historicalEvidence }, provider(historicalDraft)))
      .resolves.toMatchObject({ takeaway: expect.stringContaining('当前达标') });
  });

  it('rejects semantic reuse of sample counts as percentages or breach facts', async () => {
    const fabricatedPercent = onsiteDraft({
      takeaway: '总氮升高 31%。',
      claims: [{
        id: 'claim-tn', text: '总氮升高 31%。', kind: 'onsite-fact', evidenceKeys: ['tn'],
      }],
    });
    const percentProvider = providerSequence(fabricatedPercent, fabricatedPercent);
    await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, percentProvider))
      .rejects.toThrow('REPORT_EVIDENCE_INVALID');

    const historicalEvidence: ReportEvidenceBundle = {
      ...dataEvidence,
      snapshotId: 'evidence:typed-breach-v1',
      analysis: {
        ...analysis,
        series: [
          { date: '2026-08-01', values: { tn: 2.2, ammonia: 0.4 } },
          { date: '2026-08-15', values: { tn: 3.13, ammonia: 0.45 } },
          { date: '2026-08-31', values: { tn: 2.4, ammonia: 0.5 } },
        ],
        thresholdBreaches: [{ date: '2026-08-15', metric: 'tn', value: 3.13, limit: 3 }],
      },
    };
    for (const falseClaim of [
      '2026-08-01 总氮出现超标。',
      '监测期内总氮共有 31 次超标。',
      '监测期内总氮共有 31 个超标日。',
      '监测期内总氮共有 31 天超标。',
      '2026-08-01 总氮高于限值 3 mg/L。',
      '总氮限值为 2 mg/L。',
      '总氮超过 2 mg/L 限值。',
      '总氮超标值为 2 mg/L。',
      '监测期内总氮共有 2 天超标。',
      '总氮平均值和最新值分别为 2.4 mg/L 和 2.3 mg/L。',
    ]) {
      const invalid = onsiteDraft({
        takeaway: falseClaim,
        claims: [{ id: 'claim-tn', text: falseClaim, kind: 'onsite-fact', evidenceKeys: ['tn'] }],
      });
      await expect(composeSlide(
        { outline: outline(), evidence: historicalEvidence },
        providerSequence(invalid, invalid),
      )).rejects.toThrow('REPORT_EVIDENCE_INVALID');
    }

    const supportedStatisticRoles = onsiteDraft({
      takeaway: '总氮平均值和最新值分别为 2.3 mg/L 和 2.4 mg/L。',
      claims: [{
        id: 'claim-tn',
        text: '总氮平均值和最新值分别为 2.3 mg/L 和 2.4 mg/L。',
        kind: 'onsite-fact', evidenceKeys: ['tn'],
      }],
    });
    await expect(composeSlide(
      { outline: outline(), evidence: historicalEvidence },
      provider(supportedStatisticRoles),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('2.3 mg/L') });

    const multiMetricOutline = outline({ evidenceKeys: ['tn', 'ammonia'] });
    for (const wrongSubject of [
      '总氮限值为 1.5 mg/L。',
      '氨氮在监测期内共有 1 次超标。',
    ]) {
      const invalid = onsiteDraft({
        evidenceKeys: ['tn', 'ammonia'],
        takeaway: wrongSubject,
        claims: [{
          id: 'claim-multi', text: wrongSubject, kind: 'onsite-fact',
          evidenceKeys: ['tn', 'ammonia'],
        }],
        takeawayClaimIds: ['claim-multi'],
        narration: [
          { text: wrongSubject, claimIds: ['claim-multi'] },
          { text: '总氮与氨氮指标已绑定。', claimIds: ['claim-multi'] },
        ],
      });
      await expect(composeSlide(
        { outline: multiMetricOutline, evidence: historicalEvidence },
        providerSequence(invalid, invalid),
      )).rejects.toThrow('REPORT_EVIDENCE_INVALID');
    }

    const validClaimsWrongNarration = onsiteDraft({
      evidenceKeys: ['tn', 'ammonia'],
      takeaway: '总氮限值为 3 mg/L，氨氮限值为 1.5 mg/L。',
      claims: [{
        id: 'claim-multi',
        text: '总氮限值为 3 mg/L，氨氮限值为 1.5 mg/L。',
        kind: 'onsite-fact', evidenceKeys: ['tn', 'ammonia'],
      }],
      takeawayClaimIds: ['claim-multi'],
      narration: [
        { text: '总氮限值为 1.5 mg/L。', claimIds: ['claim-multi'] },
        { text: '两个指标均已绑定。', claimIds: ['claim-multi'] },
      ],
    });
    await expect(composeSlide(
      { outline: multiMetricOutline, evidence: historicalEvidence },
      providerSequence(validClaimsWrongNarration, validClaimsWrongNarration),
    )).rejects.toThrow('REPORT_EVIDENCE_INVALID');

    const tupleEvidence: ReportEvidenceBundle = {
      ...historicalEvidence,
      analysis: {
        ...historicalEvidence.analysis!,
        series: [
          { date: '2026-08-01', values: { tn: 2.2, ammonia: 1.7 } },
          { date: '2026-08-15', values: { tn: 3.13, ammonia: 0.45 } },
          { date: '2026-08-31', values: { tn: 2.4, ammonia: 0.5 } },
        ],
        thresholdBreaches: [
          { date: '2026-08-15', metric: 'tn', value: 3.13, limit: 3 },
          { date: '2026-08-01', metric: 'ammonia', value: 1.7, limit: 1.5 },
        ],
      },
    };
    for (const tupleMismatch of [
      '总氮与氨氮限值分别为 1.5 mg/L 和 3 mg/L。',
      '2026-08-01 总氮值为 3.13 mg/L，高于限值 3 mg/L。',
    ]) {
      const invalid = onsiteDraft({
        evidenceKeys: ['tn', 'ammonia'], takeaway: tupleMismatch,
        claims: [{
          id: 'claim-tuple', text: tupleMismatch, kind: 'onsite-fact',
          evidenceKeys: ['tn', 'ammonia'],
        }],
        takeawayClaimIds: ['claim-tuple'],
        narration: [
          { text: tupleMismatch, claimIds: ['claim-tuple'] },
          { text: '请逐项核对指标证据。', claimIds: ['claim-tuple'] },
        ],
      });
      await expect(composeSlide(
        { outline: multiMetricOutline, evidence: tupleEvidence },
        providerSequence(invalid, invalid),
      )).rejects.toThrow('REPORT_EVIDENCE_INVALID');
    }
    for (const supportedTuple of [
      '总氮与氨氮限值分别为 3 mg/L 和 1.5 mg/L。',
      '2026-08-15 总氮值为 3.13 mg/L，高于限值 3 mg/L。',
    ]) {
      const valid = onsiteDraft({
        evidenceKeys: ['tn', 'ammonia'], takeaway: supportedTuple,
        claims: [{
          id: 'claim-tuple', text: supportedTuple, kind: 'onsite-fact',
          evidenceKeys: ['tn', 'ammonia'],
        }],
        takeawayClaimIds: ['claim-tuple'],
        narration: [
          { text: supportedTuple, claimIds: ['claim-tuple'] },
          { text: '请逐项核对指标证据。', claimIds: ['claim-tuple'] },
        ],
      });
      await expect(composeSlide(
        { outline: multiMetricOutline, evidence: tupleEvidence },
        provider(valid),
      )).resolves.toMatchObject({ takeaway: supportedTuple });
    }

    const supportedBreach = onsiteDraft({
      takeaway: '2026-08-15 总氮值为 3.13 mg/L，高于限值 3 mg/L。',
      claims: [{
        id: 'claim-tn',
        text: '2026-08-15 总氮值为 3.13 mg/L，高于限值 3 mg/L。',
        kind: 'onsite-fact',
        evidenceKeys: ['tn'],
      }],
    });
    await expect(composeSlide(
      { outline: outline(), evidence: historicalEvidence },
      provider(supportedBreach),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('2026-08-15') });

    const supportedInlineBreachCount = onsiteDraft({
      takeaway: '监测期内有 1 次总氮超过 3 mg/L 限值。',
      claims: [{
        id: 'claim-tn', text: '监测期内有 1 次总氮超过 3 mg/L 限值。',
        kind: 'onsite-fact', evidenceKeys: ['tn'],
      }],
    });
    await expect(composeSlide(
      { outline: outline(), evidence: historicalEvidence },
      provider(supportedInlineBreachCount),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('1 次总氮') });

    const supportedPostfixedBreachCount = onsiteDraft({
      takeaway: '期间总氮浓度超过 3 mg/L 限值的次数为 1 次。',
      claims: [{
        id: 'claim-tn', text: '期间总氮浓度超过 3 mg/L 限值的次数为 1 次。',
        kind: 'onsite-fact', evidenceKeys: ['tn'],
      }],
    });
    await expect(composeSlide(
      { outline: outline(), evidence: historicalEvidence },
      provider(supportedPostfixedBreachCount),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('次数为 1 次') });

    const supportedSampleCount = onsiteDraft({
      takeaway: '监测期覆盖 31 个现场样本。',
      claims: [{
        id: 'claim-tn', text: '监测期覆盖 31 个现场样本。',
        kind: 'onsite-fact', evidenceKeys: ['tn'],
      }],
    });
    await expect(composeSlide(
      { outline: outline(), evidence: historicalEvidence },
      provider(supportedSampleCount),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('31 个现场样本') });

    const supportedCombinedCounts = onsiteDraft({
      takeaway: '监测期覆盖 31 个现场样本，其中有 1 次超标。',
      claims: [{
        id: 'claim-tn', text: '监测期覆盖 31 个现场样本，其中有 1 次超标。',
        kind: 'onsite-fact', evidenceKeys: ['tn'],
      }],
    });
    await expect(composeSlide(
      { outline: outline(), evidence: historicalEvidence },
      provider(supportedCombinedCounts),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('31 个现场样本') });
  });

  it('accepts a percentage-valued metric as a measurement rather than confusing it with change rate', async () => {
    const percentageEvidence: ReportEvidenceBundle = {
      snapshotId: 'evidence:percentage-metric-v1',
      analysis: {
        scope: {
          modules: ['overview'], metrics: ['complianceRate'],
          dateRange: { from: '2026-08-01', to: '2026-08-31' },
          sampleCount: 31, granularity: 'daily',
        },
        definitions: [{ key: 'complianceRate', label: '水质达标率', unit: '%' }],
        series: [
          { date: '2026-08-01', values: { complianceRate: 99.5 } },
          { date: '2026-08-31', values: { complianceRate: 99.8 } },
        ],
        aggregates: {
          complianceRate: { min: 99.5, max: 99.8, average: 99.65, latest: 99.8, changeRate: 0.003 },
        },
        thresholdBreaches: [], correlations: [], alerts: [],
      },
      knowledge: [],
    };
    const percentageOutline = outline({ evidenceKeys: ['complianceRate'] });
    const percentageDraft = onsiteDraft({
      takeaway: '水质达标率最新值为 99.8%。',
      claims: [{
        id: 'claim-rate', text: '水质达标率最新值为 99.8%。',
        kind: 'onsite-fact', evidenceKeys: ['complianceRate'],
      }],
      takeawayClaimIds: ['claim-rate'],
      evidenceKeys: ['complianceRate'],
      narration: [
        { text: '水质达标率最新值为 99.8%。', claimIds: ['claim-rate'] },
        { text: '该数值来自现场证据。', claimIds: ['claim-rate'] },
      ],
    });

    await expect(composeSlide(
      { outline: percentageOutline, evidence: percentageEvidence },
      provider(percentageDraft),
    )).resolves.toMatchObject({ metrics: [{ key: 'complianceRate', value: 99.8, unit: '%' }] });

    const endpointDraft = onsiteDraft({
      takeaway: '水质达标率从 99.5% 提升至 99.8%。',
      claims: [{
        id: 'claim-rate', text: '水质达标率从 99.5% 提升至 99.8%。',
        kind: 'onsite-fact', evidenceKeys: ['complianceRate'],
      }],
      takeawayClaimIds: ['claim-rate'],
      evidenceKeys: ['complianceRate'],
      narration: [
        { text: '水质达标率从 99.5% 提升至 99.8%。', claimIds: ['claim-rate'] },
        { text: '提升了 0.3 个百分点。', claimIds: ['claim-rate'] },
      ],
    });
    await expect(composeSlide(
      { outline: percentageOutline, evidence: percentageEvidence },
      provider(endpointDraft),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('99.5%') });

    const currentAndPointChange = onsiteDraft({
      takeaway: '水质达标率当前为 99.8%，较期初提升 0.3 个百分点。',
      claims: [{
        id: 'claim-rate', text: '水质达标率当前为 99.8%，较期初提升 0.3 个百分点。',
        kind: 'onsite-fact', evidenceKeys: ['complianceRate'],
      }],
      takeawayClaimIds: ['claim-rate'],
      evidenceKeys: ['complianceRate'],
      narration: [
        { text: '水质达标率当前为 99.8%。', claimIds: ['claim-rate'] },
        { text: '较期初提升 0.3 个百分点。', claimIds: ['claim-rate'] },
      ],
    });
    await expect(composeSlide(
      { outline: percentageOutline, evidence: percentageEvidence },
      provider(currentAndPointChange),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('0.3 个百分点') });
  });

  it('rejects causal onsite conclusions derived only from correlation evidence', async () => {
    const correlationEvidence: ReportEvidenceBundle = {
      ...dataEvidence,
      snapshotId: 'evidence:correlation-causality-v1',
      analysis: {
        ...analysis,
        correlations: [{ left: 'tn', right: 'ammonia', coefficient: 0.9954, samples: 31 }],
      },
    };
    const causalOutline = outline({ evidenceKeys: ['tn', 'ammonia'] });
    const causalDraft = onsiteDraft({
      evidenceKeys: ['tn', 'ammonia'],
      takeaway: '总氮与氨氮的相关系数为 0.9954，证明总氮升高导致氨氮升高。',
      claims: [{
        id: 'claim-correlation',
        text: '总氮与氨氮的相关系数为 0.9954，证明总氮升高导致氨氮升高。',
        kind: 'onsite-fact',
        evidenceKeys: ['tn', 'ammonia'],
      }],
      takeawayClaimIds: ['claim-correlation'],
      narration: [
        { text: '两个指标的相关系数为 0.9954。', claimIds: ['claim-correlation'] },
        { text: '现场相关数据不能证明因果关系。', claimIds: ['claim-correlation'] },
      ],
    });

    await expect(composeSlide(
      { outline: causalOutline, evidence: correlationEvidence },
      providerSequence(causalDraft, causalDraft),
    )).rejects.toThrow('REPORT_EVIDENCE_INVALID');

    const causalTakeaway = onsiteDraft({
      evidenceKeys: ['tn', 'ammonia'],
      takeaway: '总氮升高导致氨氮升高。',
      claims: [{
        id: 'claim-correlation',
        text: '总氮与氨氮的相关系数为 0.9954。',
        kind: 'onsite-fact',
        evidenceKeys: ['tn', 'ammonia'],
      }],
      takeawayClaimIds: ['claim-correlation'],
      narration: [
        { text: '两个指标的相关系数为 0.9954。', claimIds: ['claim-correlation'] },
        { text: '总氮升高导致氨氮升高。', claimIds: ['claim-correlation'] },
      ],
    });
    await expect(composeSlide(
      { outline: causalOutline, evidence: correlationEvidence },
      providerSequence(causalTakeaway, causalTakeaway),
    )).rejects.toThrow('REPORT_EVIDENCE_INVALID');

    for (const causalCopy of [
      '相关系数为 0.9954，说明总氮上升是氨氮上升的主因。',
      '相关系数为 0.9954，表明总氮变化驱动氨氮变化。',
      '总氮变化引发氨氮变化。',
      '不能证明因果关系。总氮变化引发氨氮变化。',
      '相关不等于因果，但总氮变化引发氨氮变化。',
      '不能证明因果关系却可确认总氮变化引发氨氮变化。',
      '总氮变化使氨氮变化。',
      '总氮变化推动氨氮变化。',
      '总氮变化带来氨氮变化。',
    ]) {
      const bypass = onsiteDraft({
        evidenceKeys: ['tn', 'ammonia'],
        takeaway: causalCopy,
        claims: [{
          id: 'claim-correlation', text: causalCopy, kind: 'onsite-fact',
          evidenceKeys: ['tn', 'ammonia'],
        }],
        takeawayClaimIds: ['claim-correlation'],
        narration: [
          { text: causalCopy, claimIds: ['claim-correlation'] },
          { text: '两个指标相关系数为 0.9954。', claimIds: ['claim-correlation'] },
        ],
      });
      await expect(composeSlide(
        { outline: causalOutline, evidence: correlationEvidence },
        providerSequence(bypass, bypass),
      )).rejects.toThrow('REPORT_EVIDENCE_INVALID');
    }

    const causalVisualCopy = onsiteDraft({
      evidenceKeys: ['tn', 'ammonia'],
      knowledgeItems: [{ title: '主因分析', detail: '总氮变化驱动氨氮变化。' }],
    });
    await expect(composeSlide(
      { outline: causalOutline, evidence: correlationEvidence },
      providerSequence(causalVisualCopy, causalVisualCopy),
    )).rejects.toThrow('REPORT_EVIDENCE_INVALID');
  });

  it('accepts real-provider decline percentages, correlation disclaimer and multi-claim narration', async () => {
    const liveEnergyEvidence: ReportEvidenceBundle = {
      ...energyEvidence,
      snapshotId: 'evidence:live-energy-copy-v1',
      analysis: {
        ...energyEvidence.analysis!,
        scope: {
          ...energyEvidence.analysis!.scope,
          dateRange: { from: '2026-07-26', to: '2026-08-09' },
          sampleCount: 15,
        },
        series: [
          { date: '2026-07-26', values: { totalKwh: 12337, kwhPerM3: 0.434 } },
          { date: '2026-08-09', values: { totalKwh: 12124, kwhPerM3: 0.429 } },
        ],
        aggregates: {
          totalKwh: { min: 12124, max: 12337, average: 12230.5, latest: 12124, changeRate: -0.0173 },
          kwhPerM3: { min: 0.429, max: 0.434, average: 0.4315, latest: 0.429, changeRate: -0.0115 },
        },
        correlations: [{ left: 'totalKwh', right: 'kwhPerM3', coefficient: 0.9952, samples: 15 }],
      },
    };
    const liveOutline = outline({
      title: '能耗总体趋势', purpose: '展示近期能耗趋势', visualKind: 'trend-line',
      evidenceKeys: ['totalKwh', 'kwhPerM3'],
    });
    const liveDraft = {
      title: '能耗总体趋势',
      takeaway: '2026-07-26至2026-08-09期间，总电耗与吨水电耗均呈下降趋势，降幅分别约为1.73%和1.15%，且两者高度相关（r=0.9952）。',
      takeawayClaimIds: ['claim-1', 'claim-2', 'claim-3'],
      visualKind: 'trend-line',
      evidenceKeys: ['totalKwh', 'kwhPerM3'],
      claims: [
        {
          id: 'claim-1',
          text: '2026-07-26至2026-08-09期间，总电耗从12337 kWh/d降至12124 kWh/d，降幅为1.73%。',
          kind: 'onsite-fact', evidenceKeys: ['totalKwh'],
        },
        {
          id: 'claim-2',
          text: '同期，吨水电耗从0.434 kWh/m³降至0.429 kWh/m³，降幅为1.15%。',
          kind: 'onsite-fact', evidenceKeys: ['kwhPerM3'],
        },
        {
          id: 'claim-3', text: '总电耗与吨水电耗的相关系数为0.9952，统计上高度相关。',
          kind: 'onsite-fact', evidenceKeys: ['totalKwh', 'kwhPerM3'],
        },
        {
          id: 'claim-4', text: '统计关联不等于因果关系。',
          kind: 'knowledge', evidenceKeys: [],
        },
      ],
      narration: [
        {
          text: '2026-07-26至2026-08-09期间，能耗总体呈下降趋势。总电耗下降1.73%，吨水电耗下降1.15%。',
          claimIds: ['claim-1', 'claim-2'],
        },
        {
          text: '总电耗从12337 kWh/d降至12124 kWh/d，吨水电耗从0.434 kWh/m³降至0.429 kWh/m³，两者变化方向一致且幅度接近。',
          claimIds: ['claim-1', 'claim-2'],
        },
        {
          text: '总电耗与吨水电耗的相关系数高达0.9952，说明二者在统计上高度相关。但需注意，统计关联不等于因果关系。',
          claimIds: ['claim-3', 'claim-4'],
        },
      ],
    };

    const noCorrelation = {
      ...liveDraft,
      takeaway: '总电耗与吨水电耗均呈下降趋势。',
      takeawayClaimIds: ['claim-1', 'claim-2'],
      claims: liveDraft.claims.filter(({ id }) => id === 'claim-1' || id === 'claim-2'),
      narration: [
        { text: '总电耗下降1.73%，吨水电耗下降1.15%。', claimIds: ['claim-1', 'claim-2'] },
        { text: '两个指标变化方向一致。', claimIds: ['claim-1', 'claim-2'] },
      ],
    };
    await expect(composeSlide(
      { outline: liveOutline, evidence: liveEnergyEvidence },
      provider(noCorrelation),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('下降趋势') });

    const noPercentages = {
      ...liveDraft,
      takeaway: '总电耗与吨水电耗均呈下降趋势，且两者统计上高度相关。',
      takeawayClaimIds: ['claim-1', 'claim-2', 'claim-3'],
      claims: liveDraft.claims.map((claim) => claim.id === 'claim-1'
        ? { ...claim, text: '总电耗从12337 kWh/d降至12124 kWh/d。' }
        : claim.id === 'claim-2'
          ? { ...claim, text: '吨水电耗从0.434 kWh/m³降至0.429 kWh/m³。' }
          : claim),
      narration: [
        { text: '总电耗与吨水电耗均呈下降趋势。', claimIds: ['claim-1', 'claim-2'] },
        { text: '两者统计上高度相关，但统计关联不等于因果关系。', claimIds: ['claim-3', 'claim-4'] },
      ],
    };
    await expect(composeSlide(
      { outline: liveOutline, evidence: liveEnergyEvidence },
      provider(noPercentages),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('高度相关') });

    await expect(composeSlide(
      { outline: liveOutline, evidence: liveEnergyEvidence },
      provider(liveDraft),
    )).resolves.toMatchObject({ takeaway: expect.stringContaining('r=0.9952') });
  });

  it('repairs one malformed structure exactly once', async () => {
    const dependency = providerSequence('{bad json', onsiteDraft());
    await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, dependency))
      .resolves.toMatchObject({ id: 'slide-0' });
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('repairs one evidence binding failure against the immutable evidence', async () => {
    const evidenceFailure = providerSequence(onsiteDraft({
      claims: [{ id: 'claim-tn', text: '总氮最新值为 99 mg/L。', kind: 'onsite-fact', evidenceKeys: ['tn'] }],
    }), onsiteDraft());
    await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, evidenceFailure))
      .resolves.toMatchObject({ id: 'slide-0' });
    expect(evidenceFailure.requestCompletion).toHaveBeenCalledTimes(2);
    expect(evidenceFailure.requestCompletion.mock.calls[1]![0].prompt).toContain('referencedEvidence');
    expect(evidenceFailure.requestCompletion.mock.calls[1]![0].prompt).toContain('语义约束');
    expect(evidenceFailure.requestCompletion.mock.calls[1]![0].prompt).toContain('onsite-fact 的 evidenceKeys 必须全部是 Excel');
    expect(evidenceFailure.requestCompletion.mock.calls[1]![0].prompt).toContain('限值必须引用同一 Excel metric');
  });

  it('rejects a persistent evidence failure after one repair', async () => {
    const invalid = onsiteDraft({
      claims: [{ id: 'claim-tn', text: '总氮最新值为 99 mg/L。', kind: 'onsite-fact', evidenceKeys: ['tn'] }],
    });
    const evidenceFailure = providerSequence(invalid, invalid);
    await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, evidenceFailure))
      .rejects.toMatchObject({
        name: 'PersistentSafeSlideOutputError', code: 'REPORT_EVIDENCE_INVALID',
      } satisfies Partial<PersistentSafeSlideOutputError>);
    expect(evidenceFailure.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('classifies a malformed repair by its own final safe failure instead of stale evidence state', async () => {
    const first = onsiteDraft({
      claims: [{ id: 'claim-tn', text: '总氮最新值为 99 mg/L。', kind: 'onsite-fact', evidenceKeys: ['tn'] }],
    });
    const dependency = providerSequence(first, '{bad json');

    await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, dependency))
      .rejects.toMatchObject({
        name: 'PersistentSafeSlideOutputError', code: 'REPORT_SLIDE_DRAFT_INVALID',
      } satisfies Partial<PersistentSafeSlideOutputError>);
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('falls back from a repair transport timeout after the first safe candidate was already rejected', async () => {
    const first = onsiteDraft({
      claims: [{ id: 'claim-tn', text: '总氮最新值为 99 mg/L。', kind: 'onsite-fact', evidenceKeys: ['tn'] }],
    });
    const dependency = providerSequence(first, new DeepSeekServiceError('UPSTREAM_TIMEOUT'));

    await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, dependency))
      .rejects.toMatchObject({
        name: 'PersistentSafeSlideOutputError', code: 'REPORT_EVIDENCE_INVALID',
      } satisfies Partial<PersistentSafeSlideOutputError>);
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('rejects security failures immediately without repair', async () => {
    for (const unsafeTitle of [
      `私有地址 ${settings.baseUrl}`,
      'data:text/html,hello',
      'onerror\t=alert(1)',
    ]) {
      const securityFailure = provider(onsiteDraft({ title: unsafeTitle }));
      await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, securityFailure))
        .rejects.toMatchObject({ name: 'UnsafeReportContentError' });
      expect(securityFailure.requestCompletion).toHaveBeenCalledTimes(1);
    }
  });

  it('does not repair a structurally invalid draft that already contains sensitive output', async () => {
    const dependency = providerSequence(
      JSON.stringify({ ...onsiteDraft(), rawHtml: '<script>alert(1)</script>' }),
      onsiteDraft(),
    );

    await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, dependency))
      .rejects.toThrow('REPORT_SLIDE_DRAFT_INVALID');
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
  });

  it('sends only safe structured evidence and no model-executable-code fields', async () => {
    const dependency = provider(onsiteDraft());
    await composeSlide({ outline: outline(), evidence: dataEvidence }, dependency);
    const request = dependency.requestCompletion.mock.calls[0]![0] as DeepSeekCompletionRequest;
    expect(request.responseFormat).toEqual({ type: 'json_object' });
    expect(request.prompt).toContain('claims');
    expect(request.prompt).toContain('"visualKind":"kpi-grid"');
    expect(request.prompt.match(/"text":"\.\.\.","claimIds":\["claim-1"\]/gu)).toHaveLength(2);
    expect(request.prompt).toContain('YYYY-MM-DD');
    expect(request.prompt).toContain('不得使用千位分隔符');
    expect(request.prompt).toContain('覆盖文本中所有现场数字与事实');
    expect(request.prompt).toContain('onsite-fact 的 evidenceKeys 必须全部是 Excel');
    expect(request.prompt).toContain('knowledge 不得包含任何现场数字、单位、日期或状态');
    expect(request.prompt).toContain('alert 只允许原样复述 reason');
    expect(request.prompt).toContain('文本点名或比较的每个指标');
    expect(request.prompt).toContain('不得自行按周、按月或按季度重算');
    expect(request.prompt).not.toContain(settings.apiKey);
    expect(request.prompt).not.toContain(settings.baseUrl);
    expect(request.prompt).not.toContain(settings.model);
    expect(request.prompt).not.toContain('rawHtml');
    expect(request.prompt).not.toContain('CSS');
  });
});
