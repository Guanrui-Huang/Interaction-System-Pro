import { ANALYSIS_MODULES, type AnalysisModule } from '../../../shared/ai';
import {
  BUSINESS_PAGE_NAMES,
  type BusinessPage,
  type DashboardDataset,
} from '../../../shared/dashboard';
import {
  ANALYSIS_METHODS,
  ANALYSIS_METRICS,
  availableAnalysisMetrics,
  metricDefinitionFor,
  createDefaultAnalysisPlan,
  parseAnalysisPlan,
  type AnalysisPlan,
} from '../domain/analysis-plan';
import { redactAnalysisText } from '../domain/analysis-evidence';
import {
  DeepSeekServiceError,
  requestDeepSeekCompletion,
  type DeepSeekSettings,
} from './deepseek-client';

export const ANALYSIS_PLANNER_TIMEOUT_MS = 15_000;

const ANALYSIS_MODULE_LABELS: Record<AnalysisModule, string> = {
  overview: BUSINESS_PAGE_NAMES.overview,
  health: BUSINESS_PAGE_NAMES.health,
  'water-quality': BUSINESS_PAGE_NAMES['water-quality'],
  energy: BUSINESS_PAGE_NAMES.energy,
  alerts: '告警',
};

function availableDateRange(dataset: DashboardDataset): { from: string; to: string } | undefined {
  const dates = dataset.daily.map(({ date }) => date).sort((left, right) => left.localeCompare(right));
  const from = dates.at(0);
  const to = dates.at(-1);
  return from && to ? { from, to } : undefined;
}

function buildPlanningPrompt(input: {
  question: string;
  page: BusinessPage;
  dataset: DashboardDataset;
}): string {
  const dateRange = availableDateRange(input.dataset);
  const modules = ANALYSIS_MODULES.map((key) => `${key} (${ANALYSIS_MODULE_LABELS[key]})`);
  const metrics = availableAnalysisMetrics(input.dataset).map(key => {const definition=metricDefinitionFor(key,input.dataset.daily.at(-1));return ({
    key,
    module: definition.module,
    label: definition.label,
    unit: definition.unit,
    ...(definition.limit === undefined ? {} : { limit: definition.limit }),
    ...(definition.direction?{direction:definition.direction}:{}),
  });});

  return [
    '你是“智慧污水处理厂”的数据分析规划器。',
    '只输出一个 JSON 对象；不要输出解释、Markdown 或代码围栏。',
    `用户问题：${input.question}`,
    `来源页面（仅作为分析重点，不限制可选模块）：${input.page} (${BUSINESS_PAGE_NAMES[input.page]})`,
    `工作簿可用日期范围：${dateRange?.from ?? '无'} 至 ${dateRange?.to ?? '无'}`,
    `允许的分析模块（仅能使用 key）：${modules.join('、')}`,
    `允许的指标定义（仅能使用 key）：${JSON.stringify(metrics)}`,
    `允许的方法：${ANALYSIS_METHODS.join('、')}`,
    '输出必须严格匹配：{"modules":[...],"metrics":[...],"dateRange":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"},"methods":[...],"includeAlerts":true|false,"includeHealthWeights":true|false}。',
    '告警关系必须一致：includeAlerts=true 时 modules 必须包含 alerts；modules 包含 alerts 时 includeAlerts 必须为 true。',
    '健康指标可以在 includeHealthWeights=false 时分析；includeHealthWeights 只表示是否额外附带健康评分权重。',
    '日期范围必须在可用日期范围内；模块、指标和方法不得使用未列出的值；不得添加其他字段。',
  ].join('\n');
}

export async function planAnalysis(input: {
  question: string;
  page: BusinessPage;
  dataset: DashboardDataset;
  settings: DeepSeekSettings;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AnalysisPlan> {
  try {
    const safeQuestion = redactAnalysisText(input.question, [input.settings.apiKey]);
    const content = await requestDeepSeekCompletion({
      settings: input.settings,
      prompt: buildPlanningPrompt({ ...input, question: safeQuestion }),
      temperature: 0,
      timeoutMs: ANALYSIS_PLANNER_TIMEOUT_MS,
      fetchImpl: input.fetchImpl,
      signal: input.signal,
      responseFormat: { type: 'json_object' },
    });
    return parseAnalysisPlan(content, input.dataset);
  } catch (error) {
    if (error instanceof DeepSeekServiceError && error.code === 'MISSING_CONFIGURATION') {
      throw error;
    }
    return createDefaultAnalysisPlan(input.dataset);
  }
}
