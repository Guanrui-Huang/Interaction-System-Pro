import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useVoiceOutputActivity } from '../features/ai/voice/useVoiceOutputActivity';
import { createVoiceOutputArbiter } from '../features/ai/voice/voice-output-arbiter';

it('reflects real arbiter acquire and release notifications', async () => {
  const arbiter = createVoiceOutputArbiter();
  const { result } = renderHook(() => useVoiceOutputActivity(arbiter));

  expect(result.current).toBe(false);

  let lease: Awaited<ReturnType<typeof arbiter.acquire>>;
  await act(async () => {
    lease = await arbiter.acquire('prompt', async () => undefined);
  });
  expect(result.current).toBe(true);

  act(() => { lease?.release(); });
  expect(result.current).toBe(false);
});
