import { expect, it, vi } from 'vitest';
import type { SpeechAudio } from '../features/ai/report/report-speech-client';
import {
  NarrationAudioCache,
  NarrationAudioCacheCapacityError,
} from '../features/ai/report/narration-audio-cache';

function audio(byteLength: number): SpeechAudio {
  return { segments: [new ArrayBuffer(byteLength)], byteLength };
}

it('deduplicates concurrent report-scoped misses and retries after a failed prefetch', async () => {
  let rejectFirst!: (error: Error) => void;
  const first = new Promise<SpeechAudio>((_resolve, reject) => { rejectFirst = reject; });
  const loader = vi.fn()
    .mockReturnValueOnce(first)
    .mockResolvedValueOnce(audio(2));
  const cache = new NarrationAudioCache({ loader });
  const signal = new AbortController().signal;

  const left = cache.load('report-a', 'speech-1', signal);
  const right = cache.load('report-a', 'speech-1', signal);
  expect(loader).toHaveBeenCalledOnce();
  rejectFirst(new Error('prefetch failed'));
  await expect(left).rejects.toThrow('prefetch failed');
  await expect(right).rejects.toThrow('prefetch failed');

  await expect(cache.load('report-a', 'speech-1', signal)).resolves.toEqual(audio(2));
  expect(loader).toHaveBeenCalledTimes(2);
});

it('uses `${reportId}:${speechId}` keys and evicts least-recently-used non-playing entries', async () => {
  const loader = vi.fn(async ({ reportId, speechId }) => audio(`${reportId}:${speechId}`.length));
  const cache = new NarrationAudioCache({ loader, maxEntries: 2, maxBytes: 100 });
  const signal = new AbortController().signal;

  await cache.load('report-a', 'same', signal);
  await cache.load('report-b', 'same', signal);
  cache.markPlaying('report-a', 'same', true);
  await cache.load('report-c', 'next', signal);
  await cache.load('report-a', 'same', signal);
  await cache.load('report-b', 'same', signal);

  expect(loader.mock.calls.map(([request]) => `${request.reportId}:${request.speechId}`)).toEqual([
    'report-a:same', 'report-b:same', 'report-c:next', 'report-b:same',
  ]);
});

it('enforces the byte budget, does not retain oversized entries, and clears by report', async () => {
  const loader = vi.fn(async ({ speechId }) => audio(Number(speechId)));
  const cache = new NarrationAudioCache({ loader, maxEntries: 8, maxBytes: 5 });
  const signal = new AbortController().signal;

  await cache.load('report-a', '3', signal);
  await cache.load('report-b', '3', signal);
  await cache.load('report-a', '3', signal);
  await cache.load('report-c', '9', signal);
  await cache.load('report-c', '9', signal);
  cache.clearReport('report-a');
  await cache.load('report-a', '3', signal);
  cache.clear();
  await cache.load('report-b', '3', signal);

  expect(loader).toHaveBeenCalledTimes(7);
  expect(cache.entryCount).toBe(1);
  expect(cache.byteLength).toBe(3);
});

it('aborts report-owned pending loads on clearReport', async () => {
  let capturedSignal!: AbortSignal;
  const loader = vi.fn(({ signal }) => {
    capturedSignal = signal;
    return new Promise<SpeechAudio>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  });
  const cache = new NarrationAudioCache({ loader });
  const request = cache.load('report-a', 'speech-1', new AbortController().signal);
  cache.clearReport('report-a');

  expect(capturedSignal.aborted).toBe(true);
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
});

it('does not abort a shared miss when only one concurrent consumer is cancelled', async () => {
  let resolveLoad!: (value: SpeechAudio) => void;
  let loaderSignal!: AbortSignal;
  const loader = vi.fn(({ signal }) => {
    loaderSignal = signal;
    return new Promise<SpeechAudio>((resolve) => { resolveLoad = resolve; });
  });
  const cache = new NarrationAudioCache({ loader });
  const cancelled = new AbortController();
  const active = new AbortController();
  const first = cache.load('report-a', 'speech-1', cancelled.signal);
  const second = cache.load('report-a', 'speech-1', active.signal);

  cancelled.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(loaderSignal.aborted).toBe(false);
  resolveLoad(audio(2));
  await expect(second).resolves.toEqual(audio(2));
  expect(loader).toHaveBeenCalledOnce();
});

it('rejects a new miss at capacity without aborting pending entries with active consumers', async () => {
  const loaderSignals: AbortSignal[] = [];
  const loader = vi.fn(({ signal }: { signal: AbortSignal }) => {
    loaderSignals.push(signal);
    return new Promise<SpeechAudio>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  });
  const cache = new NarrationAudioCache({ loader, maxEntries: 2 });
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const requests = [
    cache.load('report-a', 'speech-1', controllers[0].signal),
    cache.load('report-a', 'speech-2', controllers[1].signal),
  ];
  const settled = requests.map((request) => request.catch((error: unknown) => error));
  const third = cache.load('report-a', 'speech-3', controllers[2].signal);

  try {
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.entryCount).toBe(2);
    expect(loaderSignals).toHaveLength(2);
    expect(loaderSignals.every((signal) => !signal.aborted)).toBe(true);
    await expect(third).rejects.toBeInstanceOf(NarrationAudioCacheCapacityError);
    await expect(third).rejects.toMatchObject({
      name: 'NarrationAudioCacheCapacityError',
      code: 'NARRATION_CACHE_CAPACITY',
    });
  } finally {
    controllers.forEach((controller) => controller.abort());
    await Promise.allSettled([...settled, third]);
  }
});

it('rejects beside a playing entry, then evicts it after it becomes non-playing', async () => {
  let pendingSignal!: AbortSignal;
  const loader = vi.fn(({ speechId, signal }: { speechId: string; signal: AbortSignal }) => {
    if (speechId !== 'pending') return Promise.resolve(audio(1));
    pendingSignal = signal;
    return new Promise<SpeechAudio>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  });
  const cache = new NarrationAudioCache({ loader, maxEntries: 2 });
  const controller = new AbortController();
  await cache.load('report-a', 'completed', new AbortController().signal);
  cache.markPlaying('report-a', 'completed', true);
  const pending = cache.load('report-a', 'pending', controller.signal);
  const pendingSettled = pending.catch((error: unknown) => error);

  await expect(cache.load('report-a', 'next', new AbortController().signal)).rejects.toMatchObject({
    code: 'NARRATION_CACHE_CAPACITY',
  });
  expect(loader).toHaveBeenCalledTimes(2);
  expect(pendingSignal.aborted).toBe(false);

  cache.markPlaying('report-a', 'completed', false);
  await expect(cache.load('report-a', 'next', new AbortController().signal)).resolves.toEqual(audio(1));
  expect(loader).toHaveBeenCalledTimes(3);
  expect(pendingSignal.aborted).toBe(false);

  controller.abort();
  await pendingSettled;
});

it('aborts and removes a pending miss immediately after its final consumer cancels', async () => {
  let loaderSignal!: AbortSignal;
  const loader = vi.fn(({ signal }: { signal: AbortSignal }) => {
    loaderSignal = signal;
    return new Promise<SpeechAudio>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  });
  const cache = new NarrationAudioCache({ loader });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = cache.load('report-a', 'speech-1', firstController.signal);
  const second = cache.load('report-a', 'speech-1', secondController.signal);

  firstController.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(loaderSignal.aborted).toBe(false);
  expect(cache.entryCount).toBe(1);

  secondController.abort();
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  expect(loaderSignal.aborted).toBe(true);
  expect(cache.entryCount).toBe(0);
});

it('releases each consumer abort listener after a successful shared load', async () => {
  const cache = new NarrationAudioCache({ loader: vi.fn(async () => audio(1)) });
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, 'addEventListener');
  const remove = vi.spyOn(controller.signal, 'removeEventListener');

  await expect(cache.load('report-a', 'speech-1', controller.signal)).resolves.toEqual(audio(1));
  expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
