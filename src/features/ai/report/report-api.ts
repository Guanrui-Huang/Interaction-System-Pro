import { isAiErrorCode, type AiErrorCode } from '../../../../shared/ai';
import type {
  CreateReportRequest,
  CreateReportResponse,
  ReportJobSnapshot,
  FollowUpRequest,
  FollowUpResponse,
  UpdateReportSessionRequest,
} from '../../../../shared/report';
import {
  createReportRequestSchema,
  createReportResponseSchema,
  clarificationSubmissionSchema,
  followUpRequestSchema,
  followUpResponseSchema,
  opaqueIdSchema,
  reportJobSnapshotSchema,
  updateReportSessionRequestSchema,
} from '../../../../shared/report-schema';

const REPORT_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  MISSING_CONFIGURATION: '汇报服务尚未完成配置，请联系管理员。',
  UPSTREAM_TIMEOUT: '汇报生成超时，请稍后重试。',
  UPSTREAM_HTTP: '汇报服务暂时不可用，请稍后重试。',
  MALFORMED_RESPONSE: '汇报服务返回了无法识别的数据，请稍后重试。',
  EMPTY_ANSWER: '汇报服务未返回有效内容，请调整问题后重试。',
  INVALID_REQUEST: '汇报请求无效，请返回 AI 助手重新提问。',
  NO_EVIDENCE: '当前数据无法支持这份汇报，请调整问题后重试。',
  REPORT_NOT_FOUND: '汇报不存在或已过期，请重新生成。',
  REPORT_EXPIRED: '汇报不存在或已过期，请重新生成。',
  REPORT_CAPACITY: '当前汇报任务较多，请稍后重试。',
  REPORT_EVENT_GAP: '汇报更新需要重新同步。',
  REPORT_CANCELLED: '汇报已取消，请重新生成。',
  REPORT_STALE_TURN: '较早的追问结果已失效，请重新提问。',
};

export class ReportClientError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message = REPORT_ERROR_MESSAGES[code],
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ReportClientError';
  }
}

function reportPath(reportId: string): string {
  const parsed = opaqueIdSchema.safeParse(reportId);
  if (!parsed.success || parsed.data !== reportId) {
    throw new ReportClientError('INVALID_REQUEST');
  }
  return `/api/ai/reports/${encodeURIComponent(reportId)}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
}

async function fetchReport(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ReportClientError('UPSTREAM_HTTP');
  }
}

export async function reportErrorFromResponse(response: Response): Promise<ReportClientError> {
  const body = await readJson(response);
  const code = typeof body === 'object' && body !== null && 'code' in body
    ? (body as { code?: unknown }).code
    : undefined;
  if (isAiErrorCode(code)) return new ReportClientError(code, REPORT_ERROR_MESSAGES[code], response.status);
  return new ReportClientError('MALFORMED_RESPONSE', REPORT_ERROR_MESSAGES.MALFORMED_RESPONSE, response.status);
}

export function toReportClientError(error: unknown): ReportClientError {
  if (error instanceof ReportClientError) return error;
  return new ReportClientError('UPSTREAM_HTTP');
}

export function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function startReport(input: CreateReportRequest, signal: AbortSignal): Promise<CreateReportResponse> {
  const request = createReportRequestSchema.safeParse(input);
  if (!request.success) throw new ReportClientError('INVALID_REQUEST');
  const response = await fetchReport('/api/ai/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request.data),
    signal,
  });
  if (!response.ok) throw await reportErrorFromResponse(response);
  const parsed = createReportResponseSchema.safeParse(await readJson(response));
  if (!parsed.success || parsed.data.reportId !== parsed.data.snapshot.reportId) {
    throw new ReportClientError('MALFORMED_RESPONSE');
  }
  return parsed.data;
}

export async function restoreReport(reportId: string, signal: AbortSignal): Promise<ReportJobSnapshot> {
  const response = await fetchReport(reportPath(reportId), { signal });
  if (!response.ok) throw await reportErrorFromResponse(response);
  const parsed = reportJobSnapshotSchema.safeParse(await readJson(response));
  if (!parsed.success || parsed.data.reportId !== reportId) throw new ReportClientError('MALFORMED_RESPONSE');
  return parsed.data;
}

export async function submitReportClarification(
  reportId: string,
  clarificationId: string,
  answer: string,
  signal: AbortSignal,
): Promise<void> {
  const submission = clarificationSubmissionSchema.safeParse({ clarificationId, answer });
  if (!submission.success) throw new ReportClientError('INVALID_REQUEST');
  const response = await fetchReport(`${reportPath(reportId)}/clarifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submission.data),
    signal,
  });
  if (!response.ok) throw await reportErrorFromResponse(response);
}

export async function updateReportSession(
  reportId: string,
  update: UpdateReportSessionRequest,
  signal: AbortSignal,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const parsed = updateReportSessionRequestSchema.safeParse(update);
  if (!parsed.success) throw new ReportClientError('INVALID_REQUEST');
  const response = await fetchReport(`${reportPath(reportId)}/session`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed.data),
    keepalive: options.keepalive ?? false,
    signal,
  });
  if (!response.ok) throw await reportErrorFromResponse(response);
}

export async function cancelReport(reportId: string, signal: AbortSignal): Promise<void> {
  const response = await fetchReport(reportPath(reportId), { method: 'DELETE', signal });
  if (!response.ok) throw await reportErrorFromResponse(response);
}

export async function retryReportSlide(reportId: string, slideId: string, signal: AbortSignal): Promise<void> {
  const parsedSlideId = opaqueIdSchema.safeParse(slideId);
  if (!parsedSlideId.success || parsedSlideId.data !== slideId) throw new ReportClientError('INVALID_REQUEST');
  const response = await fetchReport(`${reportPath(reportId)}/slides/${encodeURIComponent(slideId)}/retries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  });
  if (!response.ok) throw await reportErrorFromResponse(response);
}

export async function followUpReport(
  reportId: string,
  input: FollowUpRequest,
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<FollowUpResponse> {
  const request = followUpRequestSchema.safeParse(input);
  if (!request.success || !idempotencyKey.trim() || idempotencyKey.includes(',')) {
    throw new ReportClientError('INVALID_REQUEST');
  }
  const response = await fetchReport(`${reportPath(reportId)}/follow-ups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(request.data),
    signal,
  });
  if (!response.ok) throw await reportErrorFromResponse(response);
  const parsed = followUpResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new ReportClientError('MALFORMED_RESPONSE');
  return parsed.data;
}
