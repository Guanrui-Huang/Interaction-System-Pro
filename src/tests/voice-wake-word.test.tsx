import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useWakeWord,
} from '../features/ai/voice/useWakeWord';
import type { VoiceBrowserDependencies } from '../features/ai/voice/useVoiceRecognition';

type Listener = (event: { data?: unknown }) => void;

class FakeBrowserWebSocket {
  readonly sent: unknown[] = [];
  readyState = 1;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;

  send(data: string | ArrayBufferLike): void {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  serverJson(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

class FakeTrack {
  stopped = false;

  stop(): void {
    this.stopped = true;
  }
}

class FakeAudioContext {
  readonly sampleRate = 48_000;
  readonly audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  readonly destination = {} as AudioDestinationNode;
  readonly source = { connect: vi.fn(), disconnect: vi.fn() };
  readonly gain = { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);

  createMediaStreamSource = vi.fn(() => this.source as unknown as MediaStreamAudioSourceNode);
  createGain = vi.fn(() => this.gain as unknown as GainNode);
}

class FakeWorkletNode {
  readonly port: { onmessage: Listener | null } = { onmessage: null };
  connect = vi.fn();
  disconnect = vi.fn();

  pcm(samples: number[]): void {
    this.port.onmessage?.({ data: new Float32Array(samples).buffer });
  }
}

function fakeWakeBrowser(socket: FakeBrowserWebSocket, options: {
  unsupported?: boolean;
  permissionError?: Error;
} = {}): VoiceBrowserDependencies & {
  context: FakeAudioContext;
  node: FakeWorkletNode;
  track: FakeTrack;
} {
  const context = new FakeAudioContext();
  const node = new FakeWorkletNode();
  const track = new FakeTrack();
  const mediaStream = { getTracks: () => [track] } as unknown as MediaStream;

  return {
    context,
    node,
    track,
    mediaDevices: options.unsupported ? undefined : {
      getUserMedia: vi.fn().mockImplementation(async () => {
        if (options.permissionError) throw options.permissionError;
        return mediaStream;
      }),
    },
    createAudioContext: options.unsupported ? undefined : () => context as unknown as AudioContext,
    createAudioWorkletNode: options.unsupported ? undefined : () => node as unknown as AudioWorkletNode,
    createWebSocket: options.unsupported ? undefined : vi.fn(() => socket),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    now: Date.now,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it('listens continuously and reports a detected wake word once', async () => {
  const socket = new FakeBrowserWebSocket();
  const onWake = vi.fn();
  const dependencies = fakeWakeBrowser(socket);
  const { result } = renderHook(() => useWakeWord({ onWake, dependencies }));

  await act(async () => result.current.start());
  expect(socket.sent).toContainEqual({ type: 'start', format: 'pcm', sampleRate: 16_000 });
  expect(result.current.status).toBe('starting');

  await act(async () => {
    socket.serverJson({ type: 'ready' });
  });
  expect(result.current.status).toBe('listening');
  dependencies.node.pcm(new Array(480).fill(0.25));
  expect(socket.sent.filter((message) => message instanceof ArrayBuffer)).toHaveLength(1);

  await act(async () => {
    socket.serverJson({ type: 'wake', keyword: '小智小智' });
  });

  expect(onWake).toHaveBeenCalledOnce();
  expect(onWake).toHaveBeenCalledWith('小智小智');
  expect(result.current.status).toBe('waking');
  expect(dependencies.track.stopped).toBe(true);
});

it('reports an unsupported browser without requesting a device', async () => {
  const socket = new FakeBrowserWebSocket();
  const { result } = renderHook(() => useWakeWord({ dependencies: fakeWakeBrowser(socket, { unsupported: true }) }));

  await act(async () => result.current.start());

  expect(result.current.status).toBe('error');
  expect(result.current.errorCode).toBe('VOICE_UNSUPPORTED');
});

it('reports a denied microphone permission', async () => {
  const socket = new FakeBrowserWebSocket();
  const { result } = renderHook(() => useWakeWord({
    dependencies: fakeWakeBrowser(socket, { permissionError: new DOMException('denied', 'NotAllowedError') }),
  }));

  await act(async () => result.current.start());

  expect(result.current.status).toBe('error');
  expect(result.current.errorCode).toBe('VOICE_PERMISSION_DENIED');
});

it('stops wake listening and returns to idle', async () => {
  const socket = new FakeBrowserWebSocket();
  const dependencies = fakeWakeBrowser(socket);
  const { result } = renderHook(() => useWakeWord({ dependencies }));

  await act(async () => result.current.start());
  await act(async () => socket.serverJson({ type: 'ready' }));
  await act(async () => result.current.stop());

  expect(result.current.status).toBe('idle');
  expect(result.current.errorCode).toBeNull();
  expect(dependencies.track.stopped).toBe(true);
});

it('ends long wake listening with a timeout error', async () => {
  vi.useFakeTimers();
  const socket = new FakeBrowserWebSocket();
  const dependencies = fakeWakeBrowser(socket);
  const { result } = renderHook(() => useWakeWord({ dependencies }));

  await act(async () => result.current.start());
  await act(async () => socket.serverJson({ type: 'ready' }));
  await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));

  expect(result.current.status).toBe('error');
  expect(result.current.errorCode).toBe('VOICE_WAKE_TIMEOUT');
  expect(dependencies.track.stopped).toBe(true);
});
