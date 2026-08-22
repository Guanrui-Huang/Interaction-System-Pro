import type { AnalysisScope } from '../../../shared/ai';
import {
  VOICE_DEEPSEEK_MAX_OUTPUT_TOKENS,
  VOICE_MAX_SPEECH_ANSWER_CHARS,
} from '../../../shared/voice';
import {
  BUSINESS_PAGE_NAMES,
  type BusinessPage,
  type DashboardDataset,
} from '../../../shared/dashboard';
import { getDeepSeekConfig } from '../config';
import {
  AnalysisEvidenceError,
  buildAnalysisEvidence,
  redactAnalysisText,
  type AnalysisEvidence,
} from '../domain/analysis-evidence';
import { planAnalysis } from './analysis-planner';
import {
  DeepSeekServiceError,
  requestDeepSeekCompletion,
  type DeepSeekSettings,
} from './deepseek-client';

export { DeepSeekServiceError, type DeepSeekSettings } from './deepseek-client';

export type AiAnalysisResult = {
  answer: string;
  citedMetrics: string[];
  analysisScope: AnalysisScope;
  evidence: AnalysisEvidence;
};

export type AiAnswer = AiAnalysisResult;

type DeepSeekDependencies = {
  settings?: DeepSeekSettings | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
};

export const DEEPSEEK_ANSWER_TIMEOUT_MS = 90_000;
export const DEEPSEEK_TOTAL_TIMEOUT_MS = 120_000;
export const DEEPSEEK_TIMEOUT_MS = DEEPSEEK_ANSWER_TIMEOUT_MS;

function buildAnswerPrompt(input: {
  question: string;
  page: BusinessPage;
  evidence: AnalysisEvidence;
  sensitiveValues: readonly string[];
}): string {
  return [
    '你是“智慧污水处理厂”的数据分析助手。',
    `回答重点：${BUSINESS_PAGE_NAMES[input.page]}。回答重点只用于组织答案，不能替代或扩展证据。`,
    `用户问题：${redactAnalysisText(input.question, input.sensitiveValues)}`,
    '唯一可用的数据证据是下方完整且紧凑的 AnalysisEvidence；不得使用未列出的指标、记录、日期或其他数据。',
    `AnalysisEvidence：${JSON.stringify(input.evidence)}`,
    '请用简洁中文，按“结论、证据、风险、建议”组织回答。',
    '引用任何数值时，必须同时说明指标单位、证据日期范围和所属模块，并尊重样本数与数据粒度。',
    '证据不足或证据中没有所需指标时，必须明确说明“证据不足，无法确认”，不得猜测或补造。',
    '涉及相关性时必须明确说明“统计关联不等于因果关系”。',
  ].join('\n');
}

export async function answerQuestion(input: {
  question: string;
  page: BusinessPage;
  dataset: DashboardDataset;
}, dependencies: DeepSeekDependencies = {}): Promise<AiAnalysisResult> {
  const settings = Object.prototype.hasOwnProperty.call(dependencies, 'settings')
    ? dependencies.settings
    : getDeepSeekConfig();

  if (!settings) {
    throw new DeepSeekServiceError('MISSING_CONFIGURATION');
  }

  const now = dependencies.now ?? (() => globalThis.performance.now());
  const startedAt = now();
  const plan = await planAnalysis({
    question: input.question,
    page: input.page,
    dataset: input.dataset,
    settings,
    fetchImpl: dependencies.fetchImpl,
    signal: dependencies.signal,
  });

  let evidence: AnalysisEvidence;
  try {
    evidence = buildAnalysisEvidence({
      plan,
      dataset: input.dataset,
      sensitiveValues: [settings.apiKey],
    });
  } catch (error) {
    if (error instanceof AnalysisEvidenceError && error.code === 'NO_EVIDENCE') {
      throw new DeepSeekServiceError('NO_EVIDENCE', {
        availableDateRange: error.availableDateRange,
      });
    }
    if (error instanceof AnalysisEvidenceError && error.code === 'INVALID_DATA') {
      throw new DeepSeekServiceError('MALFORMED_RESPONSE');
    }
    throw error;
  }

  const prompt = buildAnswerPrompt({
    question: input.question,
    page: input.page,
    evidence,
    sensitiveValues: [settings.apiKey],
  });
  const preparedAt = now();
  const elapsedMs = Number.isFinite(startedAt)
    && Number.isFinite(preparedAt)
    && preparedAt >= startedAt
    ? preparedAt - startedAt
    : DEEPSEEK_TOTAL_TIMEOUT_MS;
  const remainingMs = DEEPSEEK_TOTAL_TIMEOUT_MS - elapsedMs;
  if (remainingMs <= 0) {
    throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
  }
  const timeoutMs = Math.min(DEEPSEEK_ANSWER_TIMEOUT_MS, remainingMs);

  const answer = await requestDeepSeekCompletion({
    settings,
    prompt,
    temperature: 0.2,
    timeoutMs,
    maxTokens: VOICE_DEEPSEEK_MAX_OUTPUT_TOKENS,
    maxOutputCharacters: VOICE_MAX_SPEECH_ANSWER_CHARS,
    fetchImpl: dependencies.fetchImpl,
    signal: dependencies.signal,
  });

  return {
    answer,
    citedMetrics: evidence.scope.metrics,
    analysisScope: evidence.scope,
    evidence,
  };
}
