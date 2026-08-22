import { describe, expect, it, vi } from 'vitest';
import { ATOMIC_VISUAL_KINDS } from '../../shared/report';
import type { AnalysisEvidence } from '../src/domain/analysis-evidence';
import type { AnalysisMetricKey } from '../src/domain/analysis-plan';
import type { ReportEvidenceBundle } from '../src/domain/report-evidence';
import type { DeepSeekCompletionRequest } from '../src/services/deepseek-client';
import {
  REPORT_PLANNER_TIMEOUT_MS,
  planReport,
  type ReportPlanningDependencies,
} from '../src/services/intent-first-report-planner';

const settings = {
  apiKey: 'planner-secret-key',
  baseUrl: 'https://deepseek.test/private',
  model: 'private-planner-model',
};

const analysis: AnalysisEvidence = {
  scope: {
    modules: ['water-quality'],
    metrics: ['tn'],
    dateRange: { from: '2026-08-01', to: '2026-08-31' },
    sampleCount: 31,
    granularity: 'daily',
  },
  definitions: [{ key: 'tn', label: '总氮（TN）', unit: 'mg/L', limit: 3 }],
  series: [
    { date: '2026-08-01', values: { tn: 2.2 } },
    { date: '2026-08-31', values: { tn: 2.4 } },
  ],
  aggregates: { tn: { min: 2.2, max: 2.4, average: 2.3, latest: 2.4, changeRate: 0.0909 } },
  thresholdBreaches: [],
  correlations: [],
  alerts: [{ date: '2026-08-15', metric: '总氮（TN）', level: '关注', reason: '短时波动', recommendation: '复核进水负荷' }],
};

const knowledgeEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:knowledge',
  knowledge: [{ key: 'knowledge:0', topic: '污水脱氮', provenance: 'model-knowledge' }],
};
const dataEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:data',
  analysis,
  knowledge: [],
};
const mixedEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:mixed',
  analysis,
  knowledge: [{ key: 'knowledge:0', topic: '总氮机理', provenance: 'model-knowledge' }],
};
const identityEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:identity',
  knowledge: [],
  assistantProfile: {
    key: 'assistant-profile',
    assistantName: '智慧水务 AI 助手',
    publicModelName: 'DeepSeek v4-flash',
    capabilities: ['解释污水处理知识'],
    limitations: ['现场结论只引用已提供证据'],
  },
};
const denseMetricKeys: AnalysisMetricKey[] = [
  'processedM3',
  'informationCount',
  'complianceRate',
  'healthScore',
  'qualityScore',
  'flowScore',
  'energyScore',
  'carbonSourceScore',
  'tn',
];
const denseEvidence: ReportEvidenceBundle = {
  snapshotId: 'evidence:dense',
  analysis: {
    scope: {
      modules: ['overview', 'health', 'water-quality'],
      metrics: denseMetricKeys,
      dateRange: { from: '2026-08-01', to: '2026-08-31' },
      sampleCount: 31,
      granularity: 'daily',
    },
    definitions: denseMetricKeys.map((key, index) => ({
      key,
      label: `指标 ${index + 1}`,
      unit: '分',
    })),
    series: [
      { date: '2026-08-01', values: Object.fromEntries(denseMetricKeys.map((key, index) => [key, 80 + index])) },
      { date: '2026-08-31', values: Object.fromEntries(denseMetricKeys.map((key, index) => [key, 81 + index])) },
    ],
    aggregates: Object.fromEntries(denseMetricKeys.map((key, index) => [key, {
      min: 80 + index,
      max: 81 + index,
      average: 80.5 + index,
      latest: 81 + index,
      changeRate: 1 / (80 + index),
    }])),
    thresholdBreaches: [],
    correlations: [],
    alerts: [],
  },
  knowledge: [],
};

const knowledgePage = {
  title: '脱氮原理',
  purpose: '直接解释脱氮机制',
  role: 'answer',
  layout: 'concept-center',
  visualKind: 'concept-map',
  evidenceKeys: ['knowledge:0'],
};

function input(evidence: ReportEvidenceBundle, question = '污水脱氮是什么？') {
  return { question, originPage: 'overview' as const, evidence };
}

function providerSequence(...responses: Array<unknown | string | Error>): ReportPlanningDependencies & {
  requestCompletion: ReturnType<typeof vi.fn>;
} {
  const requestCompletion = vi.fn(async (_request: DeepSeekCompletionRequest) => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === 'string') return response;
    return JSON.stringify(response ?? { slides: [] });
  });
  return {
    settings,
    requestCompletion,
    createSlideId: (order) => `server-slide-${order}`,
  };
}

function provider(response: unknown) {
  return providerSequence(response);
}

describe('planReport', () => {
  it('plans an actually simple report as one zero-based page', async () => {
    const result = await planReport(input(knowledgeEvidence), provider({ slides: [knowledgePage] }));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'server-slide-0',
      order: 0,
      role: 'answer',
      layout: 'concept-center',
      visualKind: 'concept-map',
      evidencePolicy: 'knowledge',
      status: 'planned',
    });
  });

  it('derives mixed evidence policy instead of trusting the model', async () => {
    const result = await planReport(input(mixedEvidence, '总氮是什么，目前是否达标？'), provider({
      slides: [{
        title: '总氮现状与机理',
        purpose: '回答当前状态并解释机理',
        role: 'answer',
        layout: 'split-insight',
        visualKind: 'kpi-grid',
        evidenceKeys: ['tn', 'knowledge:0'],
      }],
    }));

    expect(result[0]).toMatchObject({ evidencePolicy: 'mixed', evidenceKeys: ['tn', 'knowledge:0'] });
  });

  it('plans identity only from assistant-profile evidence', async () => {
    const result = await planReport(input(identityEvidence, '你是什么模型？'), provider({
      slides: [{
        title: '助手身份与能力',
        purpose: '直接回答身份与边界',
        role: 'answer',
        layout: 'concept-center',
        visualKind: 'capability-map',
        evidenceKeys: ['assistant-profile'],
      }],
    }));

    expect(result[0]).toMatchObject({ evidencePolicy: 'knowledge', evidenceKeys: ['assistant-profile'] });
  });

  it('repairs an identity outline that mixes model knowledge with the trusted profile', async () => {
    const evidence: ReportEvidenceBundle = {
      ...identityEvidence,
      knowledge: [{ key: 'knowledge:0', topic: 'model_identity', provenance: 'model-knowledge' }],
    };
    const dependency = providerSequence({ slides: [{
      title: '模型身份说明',
      purpose: '回答模型身份',
      role: 'answer',
      layout: 'concept-center',
      visualKind: 'concept-map',
      evidenceKeys: ['knowledge:0', 'assistant-profile'],
    }] }, { slides: [{
      title: '助手身份与能力',
      purpose: '回答模型身份',
      role: 'answer',
      layout: 'concept-center',
      visualKind: 'capability-map',
      evidenceKeys: ['assistant-profile'],
    }] });

    await expect(planReport(input(evidence, '你是什么模型？'), dependency)).resolves.toMatchObject([
      { visualKind: 'capability-map', evidenceKeys: ['assistant-profile'] },
    ]);
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
    for (const [request] of dependency.requestCompletion.mock.calls) {
      expect(request.prompt).toContain('身份页必须使用 capability-map');
      expect(request.prompt).toContain('evidenceKeys 必须精确为 ["assistant-profile"]');
    }
  });

  it('allows capability-map for ordinary model knowledge', async () => {
    const result = await planReport(input(knowledgeEvidence), provider({
      slides: [{
        ...knowledgePage,
        title: '脱氮能力路径',
        purpose: '解释通用脱氮能力',
        visualKind: 'capability-map',
      }],
    }));

    expect(result[0]).toMatchObject({
      evidencePolicy: 'knowledge',
      visualKind: 'capability-map',
      evidenceKeys: ['knowledge:0'],
    });
  });

  it('repairs duplicate or redundant pages once', async () => {
    const dependency = providerSequence({ slides: [
      knowledgePage,
      { ...knowledgePage, title: '脱氮概念补充', visualKind: 'process-flow' },
    ] }, { slides: [knowledgePage] });

    await expect(planReport(input(knowledgeEvidence), dependency)).resolves.toHaveLength(1);
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
    expect(dependency.requestCompletion.mock.calls[1]![0].prompt).toContain('语义约束');
  });

  it('rejects unsupported visual and evidence combinations after one repair', async () => {
    const invalid = { slides: [{
      title: '预警趋势',
      purpose: '把单条预警伪装成趋势',
      role: 'evidence',
      layout: 'visual-focus',
      visualKind: 'trend-line',
      evidenceKeys: ['alert:0'],
    }] };
    const dependency = providerSequence(invalid, invalid);

    await expect(planReport(input(dataEvidence, '回顾预警'), dependency))
      .rejects.toThrow('REPORT_OUTLINE_INVALID');
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
    for (const [request] of dependency.requestCompletion.mock.calls) {
      expect(request.prompt).toContain('scatter 必须且只能绑定 2 个 Excel metric');
      expect(request.prompt).toContain('health-ring 必须且只能绑定 1 个 metric');
      expect(request.prompt).toContain('alert-timeline 的 Excel 证据只能是 alert');
    }
  });

  it('requires one to twelve useful pages', async () => {
    const empty = providerSequence({ slides: [] }, { slides: [knowledgePage] });
    await expect(planReport(input(knowledgeEvidence), empty)).resolves.toHaveLength(1);
    expect(empty.requestCompletion).toHaveBeenCalledTimes(2);

    const tooMany = providerSequence(
      { slides: Array.from({ length: 13 }, (_, index) => ({ ...knowledgePage, title: `第 ${index + 1} 页` })) },
      { slides: Array.from({ length: 13 }, (_, index) => ({ ...knowledgePage, title: `修复 ${index + 1}` })) },
    );
    await expect(planReport(input(knowledgeEvidence), tooMany)).rejects.toThrow('REPORT_OUTLINE_INVALID');
    expect(tooMany.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('repairs one structural response exactly once', async () => {
    const dependency = providerSequence('{bad json', { slides: [knowledgePage] });

    await expect(planReport(input(knowledgeEvidence), dependency)).resolves.toHaveLength(1);
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
    expect(dependency.requestCompletion.mock.calls[1]![0].prompt).toContain('{bad json');
  });

  it('fails after one structural repair and never makes a third provider call', async () => {
    const dependency = providerSequence('{bad json', '{still bad');

    await expect(planReport(input(knowledgeEvidence), dependency)).rejects.toThrow('REPORT_OUTLINE_INVALID');
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('rejects sensitive or executable output immediately without repair', async () => {
    for (const unsafeTitle of [
      `模型配置 ${settings.model}`,
      'DEEPSEEK_API_KEY=leaked-value',
      '<script>alert(1)</script>',
      'data:text/html,hello',
      'onerror\t=alert(1)',
    ]) {
      const dependency = provider({ slides: [{ ...knowledgePage, title: unsafeTitle }] });
      await expect(planReport(input(knowledgeEvidence), dependency))
        .rejects.toThrow('REPORT_OUTLINE_INVALID');
      expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
    }
  });

  it('does not repair a structurally invalid response that already contains sensitive output', async () => {
    const dependency = providerSequence(
      JSON.stringify({ ...knowledgePage, rawHtml: '<script>alert(1)</script>' }),
      { slides: [knowledgePage] },
    );

    await expect(planReport(input(knowledgeEvidence), dependency))
      .rejects.toThrow('REPORT_OUTLINE_INVALID');
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
  });

  it('uses JSON mode and redacts private settings, paths and environment assignments from both prompts', async () => {
    const dependency = providerSequence('{bad json', { slides: [knowledgePage] });
    await planReport(input(
      knowledgeEvidence,
      `读取 /private/plant.xlsx；DEEPSEEK_API_KEY=value；${settings.apiKey}`,
    ), dependency);

    for (const [request] of dependency.requestCompletion.mock.calls as Array<[DeepSeekCompletionRequest]>) {
      expect(request.responseFormat).toEqual({ type: 'json_object' });
      expect(request.prompt).toContain(`"visualKind":"${ATOMIC_VISUAL_KINDS.join('|')}"`);
      expect(request.prompt).not.toContain(`"visualKind":"${[...ATOMIC_VISUAL_KINDS, 'data-dashboard'].join('|')}"`);
      expect(request.prompt).not.toContain(settings.apiKey);
      expect(request.prompt).not.toContain(settings.baseUrl);
      expect(request.prompt).not.toContain(settings.model);
      expect(request.prompt).not.toContain('/private/plant.xlsx');
      expect(request.prompt).not.toContain('DEEPSEEK_API_KEY');
      expect(request.prompt).not.toContain('AnalysisEvidence');
    }
  });

  it('keeps model planning atomic while instructing chart-first data pages', async () => {
    const dependency = provider({ slides: [{
      title: '总氮趋势',
      purpose: '展示总氮趋势',
      role: 'answer',
      layout: 'visual-focus',
      visualKind: 'trend-area',
      evidenceKeys: ['tn'],
    }] });

    await planReport(input(dataEvidence, '总氮趋势如何？'), dependency);
    const prompt = dependency.requestCompletion.mock.calls[0]![0].prompt;
    expect(prompt).toContain(`"visualKind":"${ATOMIC_VISUAL_KINDS.join('|')}"`);
    expect(prompt).not.toContain(`"visualKind":"${[...ATOMIC_VISUAL_KINDS, 'data-dashboard'].join('|')}"`);
    expect(prompt).toContain('现场数据页采用图表优先：有至少两个时间点时优先 trend-area/trend-line；有至少两个同单位可比值时优先 comparison-bars；得分或百分比可使用 health-ring/radar。');
    expect(prompt).toContain('只在证据无法形成趋势、比较、评分、关联或告警图时选择 kpi-grid。不要返回 data-dashboard；组合图表由服务端根据不可变证据生成。');
    expect(prompt).toContain('目标画布为 1920×1080');
    expect(prompt).toContain('所有相关指标必须在某一页出现');
    expect(prompt).toContain('不得依赖页面滚动');
  });

  it('backfills omitted analyzed metrics onto paginated metric-report pages', async () => {
    const result = await planReport(
      input(denseEvidence, '请完整解释所有现场指标'),
      provider({
        slides: [{
          title: '完整指标解释',
          purpose: '解释全部指标',
          role: 'answer',
          layout: 'visual-focus',
          visualKind: 'kpi-grid',
          evidenceKeys: denseMetricKeys.slice(0, 4),
        }],
      }),
    );

    expect(result.map(({ evidenceKeys }) => evidenceKeys)).toEqual([
      denseMetricKeys.slice(0, 5),
      denseMetricKeys.slice(5),
    ]);
    expect(result.flatMap(({ evidenceKeys }) => evidenceKeys)).toEqual(denseMetricKeys);
  });

  it('rejects plans that omit analyzed metrics when no compatible metric-report page can represent them', async () => {
    await expect(planReport(
      input(denseEvidence, '请完整解释所有现场指标'),
      provider({
        slides: [{
          title: '健康评分',
          purpose: '概览单项健康评分',
          role: 'answer',
          layout: 'visual-focus',
          visualKind: 'health-ring',
          evidenceKeys: ['healthScore'],
        }],
      }),
    )).rejects.toThrow('REPORT_OUTLINE_INVALID');
  });

  it('preserves the report max slides failure after pagination expands dense pages', async () => {
    const denseSlides = Array.from({ length: 7 }, (_, index) => ({
      title: `密集指标页 ${index + 1}`,
      purpose: `解释密集指标页 ${index + 1}`,
      role: 'answer' as const,
      layout: 'visual-focus' as const,
      visualKind: 'kpi-grid' as const,
      evidenceKeys: denseMetricKeys,
    }));

    await expect(planReport(
      input(denseEvidence, '请逐页展示完整指标'),
      provider({ slides: denseSlides }),
    )).rejects.toThrow('REPORT_OUTLINE_INVALID');
  });

  it('allows enough time for real outline planning responses', async () => {
    const dependency = provider({ slides: [knowledgePage] });
    await planReport(input(knowledgeEvidence), dependency);

    expect(REPORT_PLANNER_TIMEOUT_MS).toBe(30_000);
    expect(dependency.requestCompletion).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
  });
});
