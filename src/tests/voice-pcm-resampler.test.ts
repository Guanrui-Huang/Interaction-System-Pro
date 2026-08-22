import { expect, it } from 'vitest';
import { Pcm16Resampler } from '../features/ai/voice/pcm-resampler';

it('converts streaming 48 kHz floats to bounded 16 kHz signed PCM without resetting phase', () => {
  const resampler = new Pcm16Resampler(48_000, 16_000);

  const first = resampler.push(new Float32Array(480).fill(0.5));
  const second = resampler.push(new Float32Array(480).fill(-2));

  expect(first).toHaveLength(160);
  expect(second).toHaveLength(160);
  expect(first[0]).toBe(16_384);
  expect(second[0]).toBe(-32_768);
});

it('retains fractional phase across uneven chunks', () => {
  const resampler = new Pcm16Resampler(48_000, 16_000);

  const first = resampler.push(new Float32Array(481).fill(1));
  const second = resampler.push(new Float32Array(479).fill(1));

  expect(first).toHaveLength(161);
  expect(second).toHaveLength(159);
  expect([...first, ...second]).toHaveLength(320);
  expect([...first, ...second].every((sample) => sample === 32_767)).toBe(true);
});

it('resets its streaming state', () => {
  const resampler = new Pcm16Resampler(48_000, 16_000);
  resampler.push(new Float32Array(480).fill(0.25));
  resampler.reset();

  expect(resampler.push(new Float32Array(480).fill(-0.25))).toHaveLength(160);
});
