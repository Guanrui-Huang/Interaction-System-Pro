import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiquidVoiceOrb } from '../features/ai/voice/LiquidVoiceOrb';
import { VoiceWakeOverlay } from '../features/ai/voice/VoiceWakeOverlay';

const recognitionHarness = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
}));

vi.mock('../features/ai/voice/useVoiceRecognition', () => ({
  useVoiceRecognition: () => ({
    status: 'idle',
    confirmedText: '',
    interimText: '',
    elapsedMs: 0,
    errorCode: null,
    start: recognitionHarness.start,
    stop: recognitionHarness.cancel,
    cancel: recognitionHarness.cancel,
  }),
}));

function makePromptPlayback() {
  return {
    play: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.stubGlobal('navigator', { ...navigator, gpu: undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('falls back without WebGPU and exposes the requested phase', async () => {
  render(<LiquidVoiceOrb phase="hearing" />);

  const orb = await screen.findByTestId('liquid-voice-orb');
  await waitFor(() => expect(orb).toHaveClass('liquid-voice-orb--fallback'));
  expect(orb).toHaveAttribute('data-phase', 'hearing');
  expect(orb.querySelector('.liquid-voice-orb__fallback')).toBeInTheDocument();
});

it('destroys the WebGPU device and cancels the animation frame on unmount', async () => {
  const destroy = vi.fn();
  const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(73);
  const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame');
  const context = {
    configure: vi.fn(),
    getCurrentTexture: vi.fn(() => ({ createView: vi.fn() })),
  };
  const device = {
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
    lost: new Promise<never>(() => undefined),
    destroy,
    createShaderModule: vi.fn(() => ({
      getCompilationInfo: vi.fn(async () => ({ messages: [] })),
    })),
    createRenderPipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({})),
    })),
    createBuffer: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(),
  };
  const adapter = { requestDevice: vi.fn(async () => device) };
  const gpu = {
    requestAdapter: vi.fn(async () => adapter),
    getPreferredCanvasFormat: vi.fn(() => 'rgba8unorm'),
  };
  vi.stubGlobal('navigator', { ...navigator, gpu });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);

  const { unmount } = render(<LiquidVoiceOrb phase="waking" />);
  await waitFor(() => expect(requestAnimationFrame).toHaveBeenCalledOnce());

  unmount();

  expect(cancelAnimationFrame).toHaveBeenCalledWith(73);
  expect(destroy).toHaveBeenCalledOnce();
});

it('renders status text before the orb in the lightweight bottom-center overlay', async () => {
  const promptPlayback = makePromptPlayback();
  render(
    <VoiceWakeOverlay
      originPage="overview"
      promptPlayback={promptPlayback}
      onStartReport={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );

  const overlay = screen.getByRole('dialog', { name: '语音交互' });
  expect(overlay).toHaveClass('voice-wake-overlay--bottom-center');
  expect(overlay.querySelector('.voice-wake-overlay__text')?.nextElementSibling)
    .toHaveAttribute('data-testid', 'liquid-voice-orb');
  expect(overlay.querySelector('.voice-breathing-ball')).not.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByTestId('liquid-voice-orb')).toHaveClass('liquid-voice-orb--fallback');
    expect(recognitionHarness.start).toHaveBeenCalledOnce();
  });
});
