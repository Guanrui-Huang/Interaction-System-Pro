import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AiErrorCode } from '../../../shared/ai';
import type { ReportEvent, ReportJobSnapshot } from '../../../shared/report';
import {
  createReportRequestSchema,
  followUpRequestSchema,
  followUpResponseSchema,
  clarificationSubmissionSchema,
  opaqueIdSchema,
  updateReportSessionRequestSchema,
} from '../../../shared/report-schema';
import type { ReportGenerator } from '../services/report-generator';
import { ReportFollowUpError, type ReportFollowUpService } from '../services/report-follow-up';
import type { ReportJobRegistry } from '../services/report-job-registry';

const DEFAULT_HEARTBEAT_MS = 15_000;
const emptyBodySchema = z.union([z.undefined(), z.object({}).strict()]);

const SAFE_MESSAGES: Record<
  Extract<AiErrorCode, 'INVALID_REQUEST' | 'MALFORMED_RESPONSE' | 'REPORT_NOT_FOUND' | 'REPORT_CAPACITY' | 'REPORT_EVENT_GAP' | 'REPORT_CANCELLED'>,
  string
> = {
  INVALID_REQUEST: '请求参数无效，请检查后重试。',
  MALFORMED_RESPONSE: '汇报服务暂时无法处理该请求，请稍后重试。',
  REPORT_NOT_FOUND: '汇报不存在或已过期，请重新生成。',
  REPORT_CAPACITY: '当前汇报任务较多，请稍后重试。',
  REPORT_EVENT_GAP: '汇报更新已超出可恢复范围，请重新同步。',
  REPORT_CANCELLED: '汇报已取消，请重新生成。',
};

type SafeCode = keyof typeof SAFE_MESSAGES;

export type ReportsRouterDependencies = {
  registry: ReportJobRegistry;
  generator: ReportGenerator;
  followUpService: ReportFollowUpService;
  heartbeatMs?: number;
};

function sendError(response: Response, status: number, code: SafeCode): void {
  response.status(status).json({ code, message: SAFE_MESSAGES[code] });
}

function pathId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = opaqueIdSchema.safeParse(value);
  return parsed.success && parsed.data === value ? parsed.data : undefined;
}

function activeSnapshot(
  registry: ReportJobRegistry,
  reportId: string,
  response: Response,
  options: { allowCancelled?: boolean } = {},
): ReportJobSnapshot | undefined {
  const snapshot = registry.getSnapshot(reportId);
  if (!snapshot) {
    sendError(response, 404, 'REPORT_NOT_FOUND');
    return undefined;
  }
  if (snapshot.status === 'cancelled' && !options.allowCancelled) {
    sendError(response, 409, 'REPORT_CANCELLED');
    return undefined;
  }
  return snapshot;
}

function parseLastEventId(value: string | undefined): number | undefined {
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function writeEvent(response: Response, event: ReportEvent): void {
  response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function reportsRouter(dependencies: ReportsRouterDependencies): Router {
  const { registry, generator, followUpService } = dependencies;
  const heartbeatMs = dependencies.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const router = Router();

  router.post('/reports', (request, response) => {
    const parsed = createReportRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendError(response, 400, 'INVALID_REQUEST');
      return;
    }
    try {
      response.status(202).json(generator.createReport(parsed.data));
    } catch (error) {
      if (error instanceof Error && error.message === 'REPORT_CAPACITY') {
        sendError(response, 503, 'REPORT_CAPACITY');
        return;
      }
      sendError(response, 502, 'MALFORMED_RESPONSE');
    }
  });

  router.get('/reports/:reportId', (request, response) => {
    const reportId = pathId(request.params.reportId);
    if (!reportId) {
      sendError(response, 400, 'INVALID_REQUEST');
      return;
    }
    const snapshot = activeSnapshot(registry, reportId, response, { allowCancelled: true });
    if (snapshot) response.json(snapshot);
  });

  router.get('/reports/:reportId/events', (request, response) => {
    const reportId = pathId(request.params.reportId);
    const lastSequence = parseLastEventId(request.get('Last-Event-ID'));
    if (!reportId || lastSequence === undefined) {
      sendError(response, 400, 'INVALID_REQUEST');
      return;
    }

    const snapshot = activeSnapshot(registry, reportId, response);
    if (!snapshot) return;
    if (lastSequence > snapshot.lastSequence) {
      sendError(response, 409, 'REPORT_EVENT_GAP');
      return;
    }

    const signal = registry.beginActivity(reportId, 'sse');
    if (!signal) {
      const latest = registry.getSnapshot(reportId);
      const cancelled = latest?.status === 'cancelled';
      sendError(response, cancelled ? 409 : 404, cancelled ? 'REPORT_CANCELLED' : 'REPORT_NOT_FOUND');
      return;
    }
    const replay = registry.replayAfter(reportId, lastSequence);
    if (replay === null) {
      registry.endActivity(reportId, 'sse', signal);
      sendError(response, 409, 'REPORT_EVENT_GAP');
      return;
    }
    if (replay === undefined) {
      registry.endActivity(reportId, 'sse', signal);
      const latest = registry.getSnapshot(reportId);
      const cancelled = latest?.status === 'cancelled';
      sendError(response, cancelled ? 409 : 404, cancelled ? 'REPORT_CANCELLED' : 'REPORT_NOT_FOUND');
      return;
    }

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    for (const event of replay) writeEvent(response, event);

    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      registry.endActivity(reportId, 'sse', signal);
    };

    unsubscribe = registry.subscribe(reportId, (event) => writeEvent(response, event));
    if (!unsubscribe) {
      cleanup();
      response.end();
      return;
    }
    request.once('close', cleanup);
    signal.addEventListener('abort', () => {
      cleanup();
      if (!response.writableEnded) response.end();
    }, { once: true });
    heartbeat = setInterval(() => {
      if (response.writableEnded || response.destroyed) {
        cleanup();
        return;
      }
      const latest = registry.getSnapshot(reportId);
      if (!latest || latest.status === 'cancelled') {
        cleanup();
        response.end();
        return;
      }
      response.write(': heartbeat\n\n');
    }, heartbeatMs);
  });

  router.post('/reports/:reportId/clarifications', (request, response) => {
    const reportId = pathId(request.params.reportId);
    const parsed = clarificationSubmissionSchema.safeParse(request.body);
    if (!reportId || !parsed.success) {
      sendError(response, 400, 'INVALID_REQUEST');
      return;
    }
    const snapshot = activeSnapshot(registry, reportId, response);
    if (!snapshot) return;
    try {
      void generator.answerClarification(reportId, parsed.data).catch(() => undefined);
      response.status(202).json(registry.getSnapshot(reportId));
    } catch (error) {
      if (error instanceof Error && error.message === 'REPORT_STALE_TURN') {
        response.status(409).json({ code: 'REPORT_STALE_TURN', message: '该澄清已被更新的回答取代。' });
        return;
      }
      sendError(response, 502, 'MALFORMED_RESPONSE');
    }
  });

  router.patch('/reports/:reportId/session', (request, response) => {
    const reportId = pathId(request.params.reportId);
    const parsed = updateReportSessionRequestSchema.safeParse(request.body);
    if (!reportId || !parsed.success) {
      sendError(response, 400, 'INVALID_REQUEST');
      return;
    }
    const snapshot = activeSnapshot(registry, reportId, response);
    if (!snapshot) return;

    const { activeSlideId, narrationCursor } = parsed.data;
    for (const slideId of [activeSlideId, narrationCursor?.slideId]) {
      if (slideId === undefined) continue;
      const outline = snapshot.outline.find(({ id }) => id === slideId);
      if (!outline) {
        sendError(response, 404, 'REPORT_NOT_FOUND');
        return;
      }
      if (outline.status !== 'ready' || !snapshot.slides.some(({ id }) => id === slideId)) {
        sendError(response, 409, 'INVALID_REQUEST');
        return;
      }
    }

    const effectiveActiveSlideId = activeSlideId ?? snapshot.conversation.activeSlideId;
    if (narrationCursor) {
      const cursorSlide = snapshot.slides.find(({ id }) => id === narrationCursor.slideId);
      if (
        narrationCursor.slideId !== effectiveActiveSlideId
        || !cursorSlide?.narration.some(({ id }) => id === narrationCursor.segmentId)
      ) {
        sendError(response, 409, 'INVALID_REQUEST');
        return;
      }
    }
    if (!registry.updateSession(reportId, parsed.data)) {
      sendError(response, 409, 'INVALID_REQUEST');
      return;
    }
    if (activeSlideId) generator.prioritize(reportId, activeSlideId);
    response.status(204).end();
  });

  router.post('/reports/:reportId/slides/:slideId/retries', (request, response) => {
    const reportId = pathId(request.params.reportId);
    const slideId = pathId(request.params.slideId);
    if (!reportId || !slideId || !emptyBodySchema.safeParse(request.body).success) {
      sendError(response, 400, 'INVALID_REQUEST');
      return;
    }
    const snapshot = activeSnapshot(registry, reportId, response);
    if (!snapshot) return;
    if (snapshot.status !== 'ready' && snapshot.status !== 'partial') {
      sendError(response, 409, 'INVALID_REQUEST');
      return;
    }
    const outline = snapshot.outline.find(({ id }) => id === slideId);
    if (!outline) {
      sendError(response, 404, 'REPORT_NOT_FOUND');
      return;
    }
    if (outline.status !== 'failed' || outline.retryable !== true) {
      sendError(response, 409, 'INVALID_REQUEST');
      return;
    }
    generator.retrySlide(reportId, slideId);
    response.status(202).end();
  });

  router.post('/reports/:reportId/follow-ups', async (request, response) => {
    const reportId = pathId(request.params.reportId);
    const idempotencyKey = request.get('Idempotency-Key');
    const parsed = followUpRequestSchema.safeParse(request.body);
    if (
      !reportId
      || !parsed.success
      || idempotencyKey === undefined
      || idempotencyKey !== idempotencyKey.trim()
      || idempotencyKey.length === 0
      || idempotencyKey.includes(',')
    ) {
      sendError(response, 400, 'INVALID_REQUEST');
      return;
    }
    try {
      const result = await followUpService.answer(reportId, parsed.data, idempotencyKey);
      const validated = followUpResponseSchema.safeParse(result);
      if (!validated.success) {
        sendError(response, 502, 'MALFORMED_RESPONSE');
        return;
      }
      response.status(200).json(validated.data);
    } catch (error) {
      if (!(error instanceof ReportFollowUpError)) {
        sendError(response, 502, 'MALFORMED_RESPONSE');
        return;
      }
      switch (error.code) {
        case 'INVALID_REQUEST':
          sendError(response, 409, 'INVALID_REQUEST');
          return;
        case 'REPORT_STALE_TURN':
          response.status(409).json({ code: error.code, message: '该追问已被更新的问题取代。' });
          return;
        case 'NO_EVIDENCE':
          response.status(422).json({ code: error.code, message: '当前汇报没有足够证据回答该问题。' });
          return;
        case 'UPSTREAM_TIMEOUT':
          response.status(504).json({ code: error.code, message: '追问服务响应超时，请稍后重试。' });
          return;
        case 'REPORT_NOT_FOUND':
        case 'REPORT_EXPIRED':
        case 'REPORT_CANCELLED':
          sendError(response, 404, 'REPORT_NOT_FOUND');
          return;
        default:
          sendError(response, 502, 'MALFORMED_RESPONSE');
      }
    }
  });

  router.delete('/reports/:reportId', (request, response) => {
    const reportId = pathId(request.params.reportId);
    if (!reportId) {
      sendError(response, 400, 'INVALID_REQUEST');
      return;
    }
    registry.cancel(reportId);
    response.status(204).end();
  });

  return router;
}
