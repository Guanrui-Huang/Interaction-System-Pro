export const ANALYSIS_MODULES = ['overview', 'health', 'water-quality', 'energy', 'alerts'] as const;

export type AnalysisModule = typeof ANALYSIS_MODULES[number];

export const ANALYSIS_GRANULARITIES = ['daily', 'weekly', 'monthly'] as const;

export type AnalysisGranularity = typeof ANALYSIS_GRANULARITIES[number];

export type AnalysisScope = {
  modules: AnalysisModule[];
  metrics: string[];
  dateRange: { from: string; to: string };
  sampleCount: number;
  granularity: AnalysisGranularity;
};

export const AI_ERROR_CODES = [
  'MISSING_CONFIGURATION',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_HTTP',
  'MALFORMED_RESPONSE',
  'EMPTY_ANSWER',
  'INVALID_REQUEST',
  'NO_EVIDENCE',
  'REPORT_NOT_FOUND',
  'REPORT_EXPIRED',
  'REPORT_CAPACITY',
  'REPORT_EVENT_GAP',
  'REPORT_CANCELLED',
  'REPORT_STALE_TURN',
] as const;

export type AiErrorCode = typeof AI_ERROR_CODES[number];

export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  MISSING_CONFIGURATION: '未配置 DeepSeek API Key，请在 server/.env 中设置 DEEPSEEK_API_KEY 并重启本地服务。',
  UPSTREAM_TIMEOUT: 'DeepSeek 响应超时，请稍后重试。',
  UPSTREAM_HTTP: 'DeepSeek 服务暂不可用，请稍后重试。',
  MALFORMED_RESPONSE: 'DeepSeek 返回数据异常，请稍后重试。',
  EMPTY_ANSWER: 'DeepSeek 未返回有效答案，请调整问题后重试。',
  INVALID_REQUEST: '请求参数无效，请从业务页面重新发起分析。',
  NO_EVIDENCE: '指定日期范围内没有可分析数据，请调整时间范围后重试。',
  REPORT_NOT_FOUND: 'Report not found or expired.',
  REPORT_EXPIRED: 'Report has expired.',
  REPORT_CAPACITY: 'Report capacity is currently reached.',
  REPORT_EVENT_GAP: 'Report updates need to be resynchronized.',
  REPORT_CANCELLED: 'Report was cancelled.',
  REPORT_STALE_TURN: 'An older follow-up response is no longer current.',
};

export type AiErrorResponse = {
  code: AiErrorCode;
  message: string;
  availableDateRange?: { from: string; to: string };
};

export function isAiErrorCode(value: unknown): value is AiErrorCode {
  return typeof value === 'string' && (AI_ERROR_CODES as readonly string[]).includes(value);
}
