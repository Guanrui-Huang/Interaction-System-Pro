import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useAssistantPromptPlayback, type PromptPlaybackSocket } from '../features/ai/voice/useAssistantPromptPlayback';
import { createVoiceOutputArbiter } from '../features/ai/voice/voice-output-arbiter';

class PromptSocket implements PromptPlaybackSocket {
  readonly sent: unknown[] = [];
  readyState = 1;
  binaryType: BinaryType = 'blob';
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose: ((event: { data?: unknown }) => void) | null = null;
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; this.onclose?.({}); }
}

const player = {
  durationMs: vi.fn(() => 0),
  play: vi.fn(async () => undefined),
  enqueue: vi.fn(async () => undefined),
  pause: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  positionMs: vi.fn(() => 0),
  onEnded: vi.fn(() => () => undefined),
  onSegmentEnded: vi.fn(() => () => undefined),
};

function createFakePlayer() {
  return {
    durationMs: vi.fn(() => 0),
    play: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    positionMs: vi.fn(() => 0),
    onEnded: vi.fn(() => () => undefined),
    onSegmentEnded: vi.fn(() => () => undefined),
  };
}

it('creates only one prompt session when StrictMode starts the prompt twice concurrently', async () => {
  const arbiter = createVoiceOutputArbiter();
  const createWebSocket = vi.fn(() => new PromptSocket());
  const createPlayer = vi.fn(createFakePlayer);
  const { result } = renderHook(() => useAssistantPromptPlayback({
    dependencies: { createWebSocket, createPlayer, arbiter },
  }), { reactStrictMode: true });

  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = result.current.play('wake');
    second = result.current.play('wake');
  });
  await act(async () => Promise.resolve());

  expect(createWebSocket).toHaveBeenCalledTimes(1);
  expect(createPlayer).toHaveBeenCalledTimes(1);
  await act(async () => result.current.stop());
  await Promise.all([first, second]);
});
it('sends a dynamic analysis prompt with the trimmed user question', async () => {
  const socket = new PromptSocket();
  const { result } = renderHook(() => useAssistantPromptPlayback({ dependencies: { socket, player } }));

  await act(async () => {
    const prompt = result.current.play('analysis-started', { question: '  分析总氮趋势  ' });
    await Promise.resolve();
    expect(socket.sent).toContainEqual({ type: 'prompt', prompt: 'analysis-started', question: '分析总氮趋势' });
    await result.current.stop();
    await prompt;
  });
});
