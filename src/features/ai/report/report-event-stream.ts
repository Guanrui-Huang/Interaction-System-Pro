import type { ReportEvent } from '../../../../shared/report';
import { reportEventSchema } from '../../../../shared/report-schema';
import { reportErrorFromResponse } from './report-api';

type ConnectReportEventsOptions = {
  signal: AbortSignal;
  onEvent(event: ReportEvent): void;
  onOpen?(): void;
  fetch?: typeof globalThis.fetch;
};

export class ReportEventStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportEventStreamError';
  }
}

export class ReportEventStreamInterruptedError extends ReportEventStreamError {
  constructor(message: string) {
    super(message);
    this.name = 'ReportEventStreamInterruptedError';
  }
}

function abortError(): DOMException {
  return new DOMException('The report event connection was aborted.', 'AbortError');
}

export async function connectReportEvents(
  reportId: string,
  afterSequence: number,
  options: ConnectReportEventsOptions,
): Promise<void> {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new ReportEventStreamError('Last event sequence must be a non-negative safe integer.');
  }
  if (options.signal.aborted) throw abortError();
  const fetchEvents = options.fetch ?? globalThis.fetch;
  const response = await fetchEvents(`/api/ai/reports/${encodeURIComponent(reportId)}/events`, {
    headers: {
      Accept: 'text/event-stream',
      'Last-Event-ID': String(afterSequence),
    },
    signal: options.signal,
  });
  if (!response.ok) throw await reportErrorFromResponse(response);
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
    throw new ReportEventStreamError('The report event response was not an event stream.');
  }

  options.onOpen?.();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let ids: string[] = [];
  let data: string[] = [];
  let otherFields = 0;

  const dispatch = () => {
    if (ids.length === 0 && data.length === 0 && otherFields === 0) return;
    if (ids.length !== 1 || data.length !== 1) {
      throw new ReportEventStreamError('Each report event requires exactly one id and one data field.');
    }
    if (!/^[1-9]\d*$/u.test(ids[0])) throw new ReportEventStreamError('The report event id was invalid.');
    const sequence = Number(ids[0]);
    if (!Number.isSafeInteger(sequence)) throw new ReportEventStreamError('The report event id was unsafe.');
    let value: unknown;
    try {
      value = JSON.parse(data[0]);
    } catch {
      throw new ReportEventStreamError('The report event data was not valid JSON.');
    }
    const parsed = reportEventSchema.safeParse(value);
    if (!parsed.success || parsed.data.sequence !== sequence) {
      throw new ReportEventStreamError('The report event did not match the shared contract.');
    }
    ids = [];
    data = [];
    otherFields = 0;
    options.onEvent(parsed.data);
  };

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatch();
      ids = [];
      data = [];
      otherFields = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') ids.push(value);
    else if (field === 'data') data.push(value);
    else otherFields += 1;
  };

  const consumeText = (text: string) => {
    lineBuffer += text;
    let newline = lineBuffer.indexOf('\n');
    while (newline >= 0) {
      consumeLine(lineBuffer.slice(0, newline));
      lineBuffer = lineBuffer.slice(newline + 1);
      newline = lineBuffer.indexOf('\n');
    }
  };

  let aborted = false;
  const cancelReader = () => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  options.signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consumeText(decoder.decode(value, { stream: true }));
    }
    consumeText(decoder.decode());
    if (aborted || options.signal.aborted) throw abortError();
    if (lineBuffer !== '' || ids.length > 0 || data.length > 0 || otherFields > 0) {
      throw new ReportEventStreamInterruptedError('The report event stream ended mid-event.');
    }
  } finally {
    options.signal.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }
}
