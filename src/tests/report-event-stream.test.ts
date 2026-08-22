import { expect, it, vi } from 'vitest';
import { connectReportEvents, ReportEventStreamError } from '../features/ai/report/report-event-stream';

function responseFromChunks(chunks: Uint8Array[], onCancel = vi.fn()): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel: onCancel,
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

it('parses a UTF-8 event split inside a multibyte character and sends Last-Event-ID', async () => {
  const event = { type: 'slide.generating', sequence: 4, slideId: '中文页', order: 0 } as const;
  const bytes = new TextEncoder().encode(`: heartbeat\n\nid: 4\ndata: ${JSON.stringify(event)}\n\n`);
  const multibyteStart = bytes.findIndex((byte) => byte > 0x7f);
  const fetchMock = vi.fn().mockResolvedValue(responseFromChunks([
    bytes.slice(0, multibyteStart + 1),
    bytes.slice(multibyteStart + 1),
  ]));
  const onEvent = vi.fn();

  await connectReportEvents('report /一', 3, {
    signal: new AbortController().signal,
    onEvent,
    fetch: fetchMock,
  });

  expect(fetchMock).toHaveBeenCalledWith('/api/ai/reports/report%20%2F%E4%B8%80/events', expect.objectContaining({
    headers: expect.objectContaining({ 'Last-Event-ID': '3' }),
  }));
  expect(onEvent).toHaveBeenCalledOnce();
  expect(onEvent).toHaveBeenCalledWith(event);
});

it('rejects an SSE record without exactly one id and one data field', async () => {
  const bytes = new TextEncoder().encode([
    'id: 1',
    'id: 1',
    'data: {"type":"slide.generating","sequence":1,"slideId":"slide-1","order":0}',
    '',
    '',
  ].join('\n'));

  await expect(connectReportEvents('report-1', 0, {
    signal: new AbortController().signal,
    onEvent: vi.fn(),
    fetch: vi.fn().mockResolvedValue(responseFromChunks([bytes])),
  })).rejects.toBeInstanceOf(ReportEventStreamError);
});

it('rejects an event whose SSE id does not match its validated sequence', async () => {
  const bytes = new TextEncoder().encode(
    'id: 9\ndata: {"type":"slide.generating","sequence":1,"slideId":"slide-1","order":0}\n\n',
  );

  await expect(connectReportEvents('report-1', 0, {
    signal: new AbortController().signal,
    onEvent: vi.fn(),
    fetch: vi.fn().mockResolvedValue(responseFromChunks([bytes])),
  })).rejects.toMatchObject({ name: 'ReportEventStreamError' });
});

it('cancels the stream reader when the connection is aborted', async () => {
  const cancelled = vi.fn();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel: cancelled,
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const controller = new AbortController();
  const connection = connectReportEvents('report-1', 0, {
    signal: controller.signal,
    onEvent: vi.fn(),
    fetch: vi.fn().mockResolvedValue(response),
  });

  await Promise.resolve();
  controller.abort();
  await expect(connection).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelled).toHaveBeenCalledOnce();
  expect(() => streamController.close()).toThrow();
});
