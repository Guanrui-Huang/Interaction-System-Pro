import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { useWakeWord } from '../features/ai/voice/useWakeWord';
import type { VoiceBrowserDependencies } from '../features/ai/voice/useVoiceRecognition';

const socket: {
  readyState: number;
  onopen: ((event: { data?: unknown }) => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onerror: ((event: { data?: unknown }) => void) | null;
  onclose: ((event: { data?: unknown }) => void) | null;
  send(data: string | ArrayBufferLike): void;
  close(): void;
} = {
  readyState: 1,
  onopen: null,
  onmessage: null,
  onerror: null,
  onclose: null,
  send: vi.fn(),
  close: vi.fn(),
};

const dependencies: VoiceBrowserDependencies = {
  mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)) },
  createAudioContext: () => ({
    sampleRate: 48_000,
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    createGain: () => ({ gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }),
    destination: {},
  } as unknown as AudioContext),
  createAudioWorkletNode: () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: { onmessage: null },
  } as unknown as AudioWorkletNode),
  createWebSocket: () => socket,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  now: Date.now,
};

function Wrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

it('keeps the wake callback active after StrictMode rehearsal', async () => {
  const onWake = vi.fn();
  const { result } = renderHook(() => useWakeWord({ onWake, dependencies }), { wrapper: Wrapper });

  await act(async () => result.current.start());
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }));
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'wake', keyword: '小智小智' }) }));

  expect(onWake).toHaveBeenCalledWith('小智小智');
});
