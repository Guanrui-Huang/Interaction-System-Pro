import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { availableAnalysisMetrics, type AnalysisPlan } from '../src/domain/analysis-plan';
import { loadWorkbook } from '../src/data/workbook';
import { createWphiDataset } from '../src/domain/wphi-demo';
import {
  REPORT_INTENT_PLANNER_TIMEOUT_MS,
  ReportIntentPlanningError,
  planReportIntent,
  type ReportIntentPlanningDependencies,
} from '../src/services/report-intent-planner';
import { DeepSeekServiceError, type DeepSeekCompletionRequest } from '../src/services/deepseek-client';

const dataset = loadWorkbook(resolve('data/智慧污水处理厂_演示数据.xlsx'));
const settings = {
  apiKey: 'intent-planner-secret',
  baseUrl: 'https://deepseek.test/private',
  model: 'private-intent-model',
};
const dates = dataset.daily.map(({ date }) => date).sort();
const analysisPlan: AnalysisPlan = {
  modules: ['water-quality'],
  metrics: ['tn'],
  dateRange: { from: dates[0]!, to: dates.at(-1)! },
  methods: ['trend', 'summary'],
  includeAlerts: false,
  includeHealthWeights: false,
};

const knowledgeJson = {
  kind: 'report',
  intents: [{ kind: 'knowledge', questionPart: '污水脱氮是什么', evidencePolicy: 'knowledge' }],
  knowledgeTopics: ['污水脱氮'],
  assistantProfile: false,
};
const dataJson = {
  kind: 'report',
  intents: [{ kind: 'trend', questionPart: '最近总氮是否达标', evidencePolicy: 'data' }],
  knowledgeTopics: [],
  assistantProfile: false,
  analysisPlan,
};
const mixedJson = {
  kind: 'report',
  intents: [
    { kind: 'knowledge', questionPart: '总氮是什么', evidencePolicy: 'knowledge' },
    { kind: 'lookup', questionPart: '目前是否达标', evidencePolicy: 'data' },
  ],
  knowledgeTopics: ['总氮'],
  assistantProfile: false,
  analysisPlan,
};
const identityJson = {
  kind: 'report',
  intents: [{ kind: 'identity', questionPart: '你是什么模型', evidencePolicy: 'knowledge' }],
  knowledgeTopics: [],
  assistantProfile: true,
};
const clarificationJson = {
  kind: 'clarification',
  clarification: {
    prompt: '请说明您要分析的对象。',
    reason: 'ambiguous-subject',
    suggestions: ['总氮', '能耗'],
  },
};

function input(question: string, signal?: AbortSignal) {
  return {
    question,
    page: 'water-quality' as const,
    dataset,
    conversation: [{ role: 'user' as const, content: '此前讨论出水水质。' }],
    ...(signal === undefined ? {} : { signal }),
  };
}

function providerSequence(...responses: Array<string | Error>): ReportIntentPlanningDependencies & {
  requestCompletion: ReturnType<typeof vi.fn>;
} {
  const requestCompletion = vi.fn(async (_request: DeepSeekCompletionRequest) => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response ?? '{"kind":"report"}';
  });
  return { settings, requestCompletion };
}

function provider(value: unknown) {
  return providerSequence(JSON.stringify(value));
}

describe('planReportIntent', () => {
  it('anchors the built-in total nitrogen trend to exactly 30 calendar days through the latest record', async () => {
    const wrongYear = JSON.stringify({ ...dataJson, analysisPlan: {
      ...analysisPlan, dateRange: { from: '2025-07-11', to: '2025-08-09' },
    } });
    const dependency = providerSequence(wrongYear, wrongYear);

    await expect(planReportIntent({ ...input('分析近 30 日总氮变化趋势'), conversation: [] }, dependency)).resolves.toMatchObject({
      kind: 'report',
      analysisPlan: { metrics: ['tn'], dateRange: { from: '2026-07-11', to: '2026-08-09' } },
    });
    expect(dependency.requestCompletion).not.toHaveBeenCalled();
  });

  it('binds the carbon optimization shortcut to recent dosing, flow and water quality even if the provider cannot plan', async () => {
    const dependency = providerSequence('{bad json', '{bad json');

    await expect(planReportIntent({ ...input('计算当前碳源投加优化建议'), dataset: createWphiDataset(), conversation: [] }, dependency)).resolves.toMatchObject({
      kind: 'report',
      intents: [{ kind: 'recommendation', evidencePolicy: 'mixed' }],
      analysisPlan: {
        metrics: ['carbonSourceKg', 'carbonKgPerM3', 'processedM3', 'tn'],
        dateRange: { from: '2026-07-11', to: '2026-08-09' },
      },
    });
    expect(dependency.requestCompletion).not.toHaveBeenCalled();
  });

  it('uses the explicit relative window for other metric questions when the model invents a calendar date', async () => {
    const dependency = provider({ ...dataJson, analysisPlan: {
      ...analysisPlan, metrics: ['ammonia'], dateRange: { from: '2026-10-05', to: '2026-10-11' },
    } });

    await expect(planReportIntent(input('看一下近 7 天氨氮趋势'), dependency)).resolves.toMatchObject({
      analysisPlan: { metrics: ['ammonia'], dateRange: { from: '2026-08-03', to: '2026-08-09' } },
    });
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['pure knowledge', '污水脱氮是什么？', knowledgeJson, { kind: 'report', knowledgeTopics: ['污水脱氮'], assistantProfile: false }],
    ['data', '最近总氮是否达标？', dataJson, { kind: 'report', analysisPlan: { metrics: ['tn'] } }],
    ['mixed', '总氮是什么，目前是否达标？', mixedJson, { kind: 'report', knowledgeTopics: ['总氮'], analysisPlan: { metrics: ['tn'] } }],
    ['identity', '你是什么模型？', identityJson, { kind: 'report', assistantProfile: true }],
    ['clarification', '这个怎么样？', clarificationJson, { kind: 'clarification', clarification: { reason: 'ambiguous-subject' } }],
  ])('plans %s questions from a strict provider response', async (_label, question, response, expected) => {
    await expect(planReportIntent(input(question), provider(response))).resolves.toMatchObject(expected);
  });

  it('drops an extraneous invalid analysis plan from a pure knowledge response without touching Excel', async () => {
    const dependency = provider({
      ...knowledgeJson,
      analysisPlan: {
        modules: [], metrics: [], methods: [],
        dateRange: { from: '1900-01-01', to: '1900-01-01' },
        includeAlerts: false,
        includeHealthWeights: false,
      },
    });

    const result = await planReportIntent(input('污水脱氮是什么？'), dependency);
    expect(result).toMatchObject({ kind: 'report', knowledgeTopics: ['污水脱氮'] });
    expect(result).not.toHaveProperty('analysisPlan');
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
  });

  it('drops model-authored identity topics so only the trusted assistant profile can answer identity', async () => {
    const dependency = provider({ ...identityJson, knowledgeTopics: ['model_identity'] });

    await expect(planReportIntent(input('你是什么模型？'), dependency)).resolves.toMatchObject({
      kind: 'report', assistantProfile: true, knowledgeTopics: [],
    });
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
  });

  it('repairs malformed provider output once and includes the complete safe metric catalog', async () => {
    const dependency = providerSequence('{bad json', JSON.stringify(knowledgeJson));

    await expect(planReportIntent(input('污水脱氮是什么？'), dependency)).resolves.toMatchObject({
      kind: 'report', knowledgeTopics: ['污水脱氮'],
    });
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);

    const [first, repair] = dependency.requestCompletion.mock.calls.map(([request]) => request as DeepSeekCompletionRequest);
    for (const metric of availableAnalysisMetrics(dataset)) {
      expect(first.prompt).toContain(`"key":"${metric}"`);
      expect(repair.prompt).toContain(`"key":"${metric}"`);
    }
    for (const prompt of [first.prompt, repair.prompt]) {
      expect(prompt).toContain('"methods":["trend|comparison|anomaly|correlation|summary"]');
      expect(prompt).toContain('纯知识或身份问题必须完全省略 analysisPlan');
      expect(prompt).not.toContain('.xlsx');
      expect(prompt).not.toContain('/private');
      expect(prompt).not.toContain(settings.apiKey);
      expect(prompt).not.toContain(settings.baseUrl);
      expect(prompt).not.toContain(settings.model);
      expect(prompt).not.toContain('DEEPSEEK_API_KEY');
      expect(prompt).not.toContain('DEEPSEEK_BASE_URL');
      expect(prompt).not.toContain('DEEPSEEK_MODEL');
    }
    expect(repair.prompt).toContain('{bad json');
  });

  it('rejects sensitive malformed provider output without requesting a repair', async () => {
    const localPath = '/Users/operator/private/plant.xlsx';
    const environmentNames = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL'];
    const sensitiveOutput = [
      '{bad json',
      settings.apiKey,
      settings.baseUrl,
      settings.model,
      localPath,
      ...environmentNames,
    ].join('\n');
    const dependency = providerSequence(sensitiveOutput, JSON.stringify(knowledgeJson));

    await expect(planReportIntent(input('污水脱氮是什么？'), dependency)).rejects.toMatchObject({
      name: 'ReportIntentPlanningError', code: 'REPORT_INTENT_INVALID',
    });
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
  });

  it('rejects unicode-escaped sensitive output before it can enter a repair prompt', async () => {
    let deeplyEncodedModel = '\\u0070rivate-intent-model';
    for (let layer = 0; layer < 12; layer += 1) {
      deeplyEncodedModel = deeplyEncodedModel.replaceAll('\\', '\\u005c');
    }
    for (const encodedSecret of [
      '{bad json \\u0069ntent-planner-secret',
      '{bad json \\u0070rivate-intent-model',
      '{bad json \\u005cu0070rivate-intent-model',
      `{bad json ${deeplyEncodedModel}`,
    ]) {
      const dependency = providerSequence(encodedSecret, JSON.stringify(knowledgeJson));

      await expect(planReportIntent(input('污水脱氮是什么？'), dependency)).rejects.toMatchObject({
        name: 'ReportIntentPlanningError', code: 'REPORT_INTENT_INVALID',
      });
      expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects executable content in a structurally valid intent response without repair', async () => {
    for (const markup of ['<script>alert(1)</script>', '<article>unsafe']) {
      const escapedExecutable = JSON.stringify({
        ...knowledgeJson,
        knowledgeTopics: [markup],
      }).replaceAll('<', '\\u003c');
      const dependency = providerSequence(escapedExecutable, JSON.stringify(knowledgeJson));

      await expect(planReportIntent(input('污水脱氮是什么？'), dependency)).rejects.toMatchObject({
        name: 'ReportIntentPlanningError', code: 'REPORT_INTENT_INVALID',
      });
      expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects event-handler markup in malformed intent output without repair', async () => {
    for (const unsafe of [
      '{bad json <img src=x onerror=alert(1)>',
      '{bad json \\u003carticle>unsafe',
    ]) {
      const dependency = providerSequence(unsafe, JSON.stringify(knowledgeJson));

      await expect(planReportIntent(input('污水脱氮是什么？'), dependency)).rejects.toMatchObject({
        name: 'ReportIntentPlanningError', code: 'REPORT_INTENT_INVALID',
      });
      expect(dependency.requestCompletion).toHaveBeenCalledTimes(1);
    }
  });

  it('fails with REPORT_INTENT_INVALID after a second malformed provider response', async () => {
    const dependency = providerSequence('{bad json', '{still bad');

    await expect(planReportIntent(input('分析一下'), dependency)).rejects.toMatchObject({
      name: 'ReportIntentPlanningError', code: 'REPORT_INTENT_INVALID',
    });
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('repairs one evidence-policy semantic failure and preserves the exact intent contract', async () => {
    const dependency = providerSequence(JSON.stringify({
      ...knowledgeJson,
      intents: [{ kind: 'trend', questionPart: '近期走势', evidencePolicy: 'data' }],
    }), JSON.stringify(dataJson));

    await expect(planReportIntent(input('分析一下'), dependency)).resolves.toMatchObject({
      kind: 'report', analysisPlan: { metrics: ['tn'] },
    });
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
    expect(dependency.requestCompletion.mock.calls[1]![0].prompt).toContain('语义约束');
  });

  it('fails after one semantic repair and never makes a third provider call', async () => {
    const invalid = JSON.stringify({
      ...knowledgeJson,
      intents: [{ kind: 'trend', questionPart: '近期走势', evidencePolicy: 'data' }],
    });
    const dependency = providerSequence(invalid, invalid);

    await expect(planReportIntent(input('分析一下'), dependency)).rejects.toBeInstanceOf(ReportIntentPlanningError);
    expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it('redacts sensitive question values from the prompt', async () => {
    const dependency = provider(knowledgeJson);
    const question = `解释脱氮；${settings.apiKey}；/private/plant.xlsx；DEEPSEEK_API_KEY`;

    await planReportIntent(input(question), dependency);

    const prompt = dependency.requestCompletion.mock.calls[0]![0].prompt;
    expect(prompt).toContain('[已脱敏]');
    expect(prompt).not.toContain(settings.apiKey);
    expect(prompt).not.toContain('/private/plant.xlsx');
    expect(prompt).not.toContain('DEEPSEEK_API_KEY');
  });

  it('preserves typed DeepSeek failures and the caller abort signal', async () => {
    const controller = new AbortController();
    const upstream = new DeepSeekServiceError('UPSTREAM_TIMEOUT');
    const dependency = providerSequence(upstream);

    await expect(planReportIntent(input('分析一下', controller.signal), dependency)).rejects.toBe(upstream);
    expect(dependency.requestCompletion).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it('allows enough time for real intent planning responses', async () => {
    const dependency = provider(knowledgeJson);
    await planReportIntent(input('污水脱氮是什么？'), dependency);

    expect(REPORT_INTENT_PLANNER_TIMEOUT_MS).toBe(30_000);
    expect(dependency.requestCompletion).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
  });
});
