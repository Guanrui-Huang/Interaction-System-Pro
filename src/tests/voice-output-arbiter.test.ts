import { expect, it, vi } from 'vitest';
import { createVoiceOutputArbiter } from '../features/ai/voice/voice-output-arbiter';

it('keeps only the newest concurrent prompt claim', async () => {
  const arbiter = createVoiceOutputArbiter();
  const firstStop = vi.fn(async () => undefined);
  const secondStop = vi.fn(async () => undefined);
  const first = arbiter.acquire('prompt', firstStop);
  const second = arbiter.acquire('prompt', secondStop);
  const firstLease = await first;
  const secondLease = await second;
  expect(firstLease?.isCurrent()).toBe(false);
  expect(secondLease?.isCurrent()).toBe(true);
  expect(firstStop).toHaveBeenCalledOnce();
});

it('waits narration until the prompt lease releases', async () => {
  const arbiter = createVoiceOutputArbiter();
  const prompt = await arbiter.acquire('prompt', async () => undefined);
  const narration = arbiter.acquire('narration', async () => undefined);
  let settled = false;
  void narration.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  prompt!.release();
  const lease = await narration;
  expect(lease?.isCurrent()).toBe(true);
});

it('cancels a waiting narration claim through its abort signal', async () => {
  const arbiter = createVoiceOutputArbiter();
  const prompt = await arbiter.acquire('prompt', async () => undefined);
  const controller = new AbortController();
  const narration = arbiter.acquire('narration', async () => undefined, controller.signal);
  controller.abort();
  await expect(narration).resolves.toBeNull();
  prompt!.release();
});
