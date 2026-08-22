import { z } from 'zod';
import { BUSINESS_PAGE_NAMES, type BusinessPage, type DashboardDataset } from '../../../shared/dashboard';
import {
  ANALYSIS_METHODS,
  ANALYSIS_METRICS,
  parseAnalysisPlan,
  type AnalysisPlan,
} from '../domain/analysis-plan';
import type { ReportIntentPlan } from '../domain/report-intent';
import { redactAnalysisText } from '../domain/analysis-evidence';
import {
  ReportContentValidationError,
  assertSafeReportContent,
} from '../domain/report-content-validation';
import {
  requestDeepSeekCompletion,
  type DeepSeekCompletionRequest,
  type DeepSeekSettings,
} from './deepseek-client';
import {
  StructuredModelOutputShapeError,
  parseStructuredModelOutput,
} from './structured-model-output';

export const REPORT_INTENT_PLANNER_TIMEOUT_MS = 30_000;

export class ReportIntentPlanningError extends Error {
  constructor(
    readonly code: 'REPORT_INTENT_INVALID',
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'ReportIntentPlanningError';
  }
}

export type CompactConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

export type ReportIntentPlanningInput = {
  question: string;
  page: BusinessPage;
  dataset: DashboardDataset;
  conversation?: readonly CompactConversationTurn[];
  signal?: AbortSignal;
};

export type ReportIntentPlanningDependencies = {
  settings: DeepSeekSettings;
  fetchImpl?: typeof fetch;
  requestCompletion?: (input: DeepSeekCompletionRequest) => Promise<string>;
};

const intentKinds = ['lookup', 'trend', 'diagnosis', 'comparison', 'knowledge', 'identity', 'recommendation'] as const;
const evidencePolicies = ['knowledge', 'data', 'mixed'] as const;
const clarificationReasons = ['ambiguous-subject', 'ambiguous-period', 'missing-evidence-scope'] as const;

const plannedQuestionIntentSchema = z.object({
  kind: z.enum(intentKinds),
  questionPart: z.string().trim().min(1),
  evidencePolicy: z.enum(evidencePolicies),
}).strict();

const modelResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('report'),
    intents: z.array(plannedQuestionIntentSchema).min(1),
    knowledgeTopics: z.array(z.string().trim().min(1)),
    assistantProfile: z.boolean(),
    analysisPlan: z.unknown().optional(),
  }).strict(),
  z.object({
    kind: z.literal('clarification'),
    clarification: z.object({
      prompt: z.string().trim().min(1),
      reason: z.enum(clarificationReasons),
      suggestions: z.array(z.string().trim().min(1)),
    }).strict(),
  }).strict(),
]);

type ModelResponse = z.infer<typeof modelResponseSchema>;

function availableDateRange(dataset: DashboardDataset): { from: string; to: string } | undefined {
  const dates = dataset.daily.map(({ date }) => date).sort((left, right) => left.localeCompare(right));
  const from = dates.at(0);
  const to = dates.at(-1);
  return from && to ? { from, to } : undefined;
}

function metricCatalog() {
  return Object.entries(ANALYSIS_METRICS).map(([key, definition]) => ({
    key,
    module: definition.module,
    label: definition.label,
    unit: definition.unit,
    ...(definition.limit === undefined ? {} : { limit: definition.limit }),
  }));
}

function responseShape(): string {
  return `{"kind":"report","intents":[{"kind":"lookup|trend|diagnosis|comparison|knowledge|identity|recommendation","questionPart":"...","evidencePolicy":"knowledge|data|mixed"}],"knowledgeTopics":["..."],"assistantProfile":true|false,"analysisPlan":{"modules":["..."],"metrics":["..."],"dateRange":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"},"methods":["${ANALYSIS_METHODS.join('|')}"],"includeAlerts":true|false,"includeHealthWeights":true|false}} 或 {"kind":"clarification","clarification":{"prompt":"...","reason":"ambiguous-subject|ambiguous-period|missing-evidence-scope","suggestions":["..."]}}`;
}

function safeContext(input: ReportIntentPlanningInput, sensitiveValues: readonly string[]) {
  return (input.conversation ?? []).map(({ role, content }) => ({
    role,
    content: redactAnalysisText(content, sensitiveValues),
  }));
}

function buildPlanningPrompt(input: ReportIntentPlanningInput, sensitiveValues: readonly string[]): string {
  const dateRange = availableDateRange(input.dataset);
  return [
    '你是智慧污水处理厂的问题意图规划器。只输出一个 JSON 对象；不要输出解释、Markdown 或代码围栏。',
    `用户问题：${redactAnalysisText(input.question, sensitiveValues)}`,
    `来源页面（仅作理解提示）：${input.page} (${BUSINESS_PAGE_NAMES[input.page]})`,
    `紧凑会话上下文：${JSON.stringify(safeContext(input, sensitiveValues))}`,
    `可用日期范围：${dateRange?.from ?? '无'} 至 ${dateRange?.to ?? '无'}`,
    `完整指标目录（只可使用 key）：${JSON.stringify(metricCatalog())}`,
    `输出必须严格匹配：${responseShape()}。`,
    '纯知识问题使用 knowledge；任何现场数值、趋势、达标、异常、费用、能耗或运行状态必须使用 data 或 mixed，并提供 analysisPlan。',
    '纯知识或身份问题必须完全省略 analysisPlan，不得返回空 analysisPlan。',
    'analysisPlan 的模块、指标、日期和方法必须只使用目录与可用日期范围内的值；不得添加字段。',
    `analysisPlan.methods 只可使用：${ANALYSIS_METHODS.join('、')}。`,
    '身份问题可设置 assistantProfile=true；不得包含私有配置、路径或凭证。',
  ].join('\n');
}

function structuralIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`);
}

function parseModelResponse(content: string): ModelResponse {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new StructuredModelOutputShapeError(['response: invalid JSON']);
  }
  const parsed = modelResponseSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new StructuredModelOutputShapeError(structuralIssues(parsed.error));
  }
  return parsed.data;
}

function invalidIntent(cause?: unknown): ReportIntentPlanningError {
  return new ReportIntentPlanningError('REPORT_INTENT_INVALID', cause === undefined ? undefined : { cause });
}

function assertSafeIntentOutput(candidate: string, sensitiveValues: readonly string[]): void {
  try {
    assertSafeReportContent([candidate], sensitiveValues, 'REPORT_SLIDE_DRAFT_INVALID');
  } catch (error) {
    if (error instanceof ReportContentValidationError) throw invalidIntent(error);
    throw error;
  }
}

function modelResponseStrings(response: ModelResponse): string[] {
  if (response.kind === 'clarification') {
    return [
      response.clarification.prompt,
      ...response.clarification.suggestions,
    ];
  }
  return [
    ...response.intents.map(({ questionPart }) => questionPart),
    ...response.knowledgeTopics,
  ];
}

function validateSemantics(result: ModelResponse, dataset: DashboardDataset): ReportIntentPlan {
  if (result.kind === 'clarification') return result;

  const needsAnalysis = result.intents.some((intent) => intent.evidencePolicy !== 'knowledge');
  let analysisPlan: AnalysisPlan | undefined;
  if (needsAnalysis && result.analysisPlan !== undefined) {
    try {
      analysisPlan = parseAnalysisPlan(JSON.stringify(result.analysisPlan), dataset);
    } catch (error) {
      throw invalidIntent(error);
    }
  }
  if (needsAnalysis && analysisPlan === undefined) {
    throw invalidIntent();
  }
  const identityOnly = result.intents.every((intent) => intent.kind === 'identity');

  return {
    kind: 'report',
    intents: result.intents,
    knowledgeTopics: identityOnly ? [] : result.knowledgeTopics,
    assistantProfile: result.assistantProfile || result.intents.some((intent) => intent.kind === 'identity'),
    ...(analysisPlan === undefined ? {} : { analysisPlan }),
  };
}

function buildRepairPrompt(input: {
  originalOutput: string;
  issues: readonly string[];
  catalog: ReturnType<typeof metricCatalog>;
  sensitiveValues: readonly string[];
}): string {
  return [
    '将下面内容修复为一个严格 JSON 对象。只修复 JSON 语法、字段结构或语义约束；不得编造现场事实或额外解释。',
    `允许的 JSON 结构：${responseShape()}。`,
    `完整指标目录（只可使用 key）：${JSON.stringify(input.catalog)}`,
    '纯知识或身份问题必须完全省略 analysisPlan，不得返回空 analysisPlan。',
    `结构问题：${JSON.stringify(input.issues.map((issue) => redactAnalysisText(issue, input.sensitiveValues)))}`,
    `原始输出：${redactAnalysisText(input.originalOutput, input.sensitiveValues)}`,
  ].join('\n');
}

export async function planReportIntent(
  input: ReportIntentPlanningInput,
  dependencies: ReportIntentPlanningDependencies,
): Promise<ReportIntentPlan> {
  const requestCompletion = dependencies.requestCompletion ?? requestDeepSeekCompletion;
  const sensitiveValues = [
    dependencies.settings.apiKey,
    dependencies.settings.baseUrl,
    dependencies.settings.model,
  ];
  const request = (prompt: string) => requestCompletion({
    settings: dependencies.settings,
    prompt,
    temperature: 0,
    timeoutMs: REPORT_INTENT_PLANNER_TIMEOUT_MS,
    fetchImpl: dependencies.fetchImpl,
    signal: input.signal,
    responseFormat: { type: 'json_object' },
  });

  const content = await request(buildPlanningPrompt(input, sensitiveValues));
  return parseStructuredModelOutput({
    content,
    parse: (candidate) => {
      assertSafeIntentOutput(candidate, sensitiveValues);
      const response = parseModelResponse(candidate);
      for (const value of modelResponseStrings(response)) assertSafeIntentOutput(value, sensitiveValues);
      try {
        return validateSemantics(response, input.dataset);
      } catch (error) {
        if (!(error instanceof ReportIntentPlanningError)) throw error;
        throw new StructuredModelOutputShapeError([
          '语义约束：data/mixed 意图必须提供与可用指标、模块、日期和分析方法一致的 analysisPlan',
        ]);
      }
    },
    repair: async (failure) => request(buildRepairPrompt({
      originalOutput: failure.content,
      issues: failure.issues,
      catalog: metricCatalog(),
      sensitiveValues,
    })),
    invalidError: () => invalidIntent(),
  });
}
