import { expect, it, vi } from 'vitest';
import {
  ReportSpeechClientError,
  loadSpeech,
  type ReportSpeechSocket,
} from '../features/ai/report/report-speech-client';

class FakeSocket implements ReportSpeechSocket {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  sent: string[] = [];
  close = vi.fn(() => { this.readyState = 3; });
  onopen: ((event: { data?: unknown }) => void) | null = null;
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  onerror: ((event: { data?: unknown }) => void) | null = null;
  onclose: ((event: { data?: unknown }) => void) | null = null;

  send(data: string) { this.sent.push(data); }
  open() { this.readyState = 1; this.onopen?.({}); }
  text(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
  binary(...bytes: number[]) { this.onmessage?.({ data: Uint8Array.from(bytes).buffer }); }
}

it('opens exactly one synthesis socket for a miss and returns strictly ordered encoded segments', async () => {
  const socket = new FakeSocket();
  const createWebSocket = vi.fn(() => socket);
  const request = loadSpeech({
    reportId: 'report-a',
    speechId: 'speech-1',
    signal: new AbortController().signal,
    createWebSocket,
  });
  socket.open();
  expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'synthesize', reportId: 'report-a', speechId: 'speech-1' });
  socket.text({ type: 'ready', segmentCount: 2 });
  socket.text({ type: 'segment-start', index: 0 });
  socket.binary(1, 2);
  socket.text({ type: 'segment-end', index: 0 });
  socket.text({ type: 'segment-start', index: 1 });
  socket.binary(3);
  socket.text({ type: 'segment-end', index: 1 });
  socket.text({ type: 'completed' });

  const speech = await request;
  expect(createWebSocket).toHaveBeenCalledOnce();
  expect(speech.byteLength).toBe(3);
  expect(speech.segments.map((segment) => [...new Uint8Array(segment)])).toEqual([[1, 2], [3]]);
  expect(socket.close).toHaveBeenCalledOnce();
});

it('rejects out-of-order, oversized, and malformed frames without returning partial audio', async () => {
  for (const invalidFrames of [
    (socket: FakeSocket) => {
      socket.text({ type: 'ready', segmentCount: 1 });
      socket.text({ type: 'segment-end', index: 0 });
    },
    (socket: FakeSocket) => {
      socket.text({ type: 'ready', segmentCount: 1 });
      socket.text({ type: 'segment-start', index: 0 });
      socket.binary(1, 2, 3, 4, 5);
    },
    (socket: FakeSocket) => socket.text({ type: 'completed' }),
  ]) {
    const socket = new FakeSocket();
    const request = loadSpeech({
      reportId: 'report-a', speechId: 'speech-1', signal: new AbortController().signal,
      createWebSocket: () => socket,
      limits: { segmentBytes: 4, totalBytes: 8 },
    });
    socket.open();
    invalidFrames(socket);
    await expect(request).rejects.toBeInstanceOf(ReportSpeechClientError);
    expect(socket.close).toHaveBeenCalledOnce();
  }
});

it('aborts a pending miss, sends cancel once, and ignores late frames', async () => {
  const controller = new AbortController();
  const socket = new FakeSocket();
  const request = loadSpeech({
    reportId: 'report-a', speechId: 'speech-1', signal: controller.signal,
    createWebSocket: () => socket,
  });
  socket.open();
  socket.text({ type: 'ready', segmentCount: 1 });
  socket.text({ type: 'segment-start', index: 0 });
  controller.abort();
  socket.binary(1, 2, 3);
  socket.text({ type: 'segment-end', index: 0 });
  socket.text({ type: 'completed' });

  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
    { type: 'synthesize', reportId: 'report-a', speechId: 'speech-1' },
    { type: 'cancel' },
  ]);
  expect(socket.close).toHaveBeenCalledOnce();
});

it('rejects empty identifiers before opening a socket', async () => {
  const createWebSocket = vi.fn(() => new FakeSocket());
  await expect(loadSpeech({
    reportId: ' ', speechId: 'speech-1', signal: new AbortController().signal, createWebSocket,
  })).rejects.toBeInstanceOf(ReportSpeechClientError);
  expect(createWebSocket).not.toHaveBeenCalled();
});

it('rejects control frames with extra keys, invalid ranges, or non-integer positions', async () => {
  const cases: Array<(socket: FakeSocket) => void> = [
    (socket) => socket.text({ type: 'ready', segmentCount: 1, extra: true }),
    (socket) => socket.text({ type: 'ready', segmentCount: -1 }),
    (socket) => socket.text({ type: 'ready', segmentCount: 1.5 }),
    (socket) => {
      socket.text({ type: 'ready', segmentCount: 1 });
      socket.text({ type: 'segment-start', index: 0, extra: true });
    },
    (socket) => {
      socket.text({ type: 'ready', segmentCount: 1 });
      socket.text({ type: 'segment-start', index: -1 });
    },
    (socket) => {
      socket.text({ type: 'ready', segmentCount: 1 });
      socket.text({ type: 'segment-start', index: 0.5 });
    },
    (socket) => {
      socket.text({ type: 'ready', segmentCount: 1 });
      socket.text({ type: 'segment-start', index: 0 });
      socket.binary(1);
      socket.text({ type: 'segment-end', index: 0, extra: true });
    },
    (socket) => {
      socket.text({ type: 'ready', segmentCount: 1 });
      socket.text({ type: 'segment-start', index: 0 });
      socket.binary(1);
      socket.text({ type: 'segment-end', index: 0 });
      socket.text({ type: 'completed', extra: true });
    },
    (socket) => socket.text({ type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE', message: 'failed', extra: true }),
    (socket) => socket.text({ type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE', message: 'x'.repeat(1_025) }),
  ];

  for (const sendInvalid of cases) {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const request = loadSpeech({
      reportId: 'report-a', speechId: 'speech-1', signal: controller.signal,
      createWebSocket: () => socket,
    });
    socket.open();
    sendInvalid(socket);
    if (socket.close.mock.calls.length === 0) controller.abort();
    await expect(request).rejects.toMatchObject({ code: 'VOICE_INVALID_AUDIO' });
    expect(socket.close).toHaveBeenCalledOnce();
  }
});
