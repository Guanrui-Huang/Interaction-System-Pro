import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useVoiceRecognition,
  type VoiceBrowserDependencies,
} from '../features/ai/voice/useVoiceRecognition';

type Listener = (event: { data?: unknown }) => void;

class FakeBrowserWebSocket {
  readonly sent: unknown[] = [];
  readyState: number;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;

  constructor(readyState = 1) {
    this.readyState = readyState;
  }

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

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.({});
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

function fakeVoiceBrowser(socket: FakeBrowserWebSocket, options: {
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
    now: Date.now,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

it('shows interim text, streams only after ready, and delivers one final transcript after stop', async () => {
  const socket = new FakeBrowserWebSocket();
  const onFinal = vi.fn();
  const dependencies = fakeVoiceBrowser(socket);
  const { result } = renderHook(() => useVoiceRecognition({ onFinal, dependencies }));

  await act(async () => result.current.start());
  expect(socket.sent).toContainEqual({ type: 'start', format: 'pcm', sampleRate: 16_000 });
  dependencies.node.pcm(new Array(480).fill(0.5));
  expect(socket.sent.some((message) => message instanceof ArrayBuffer)).toBe(false);

  await act(async () => {
    socket.serverJson({ type: 'ready' });
  });
  dependencies.node.pcm(new Array(480).fill(0.5));
  expect(socket.sent.filter((message) => message instanceof ArrayBuffer)).toHaveLength(1);

  await act(async () => {
    socket.serverJson({ type: 'transcript', text: '分析总', final: false });
  });
  expect(result.current.interimText).toBe('分析总');
  await act(async () => {
    socket.serverJson({ type: 'transcript', text: '分析总氮', final: true });
  });
  expect(result.current.confirmedText).toBe('分析总氮');
  expect(result.current.interimText).toBe('');

  await act(async () => result.current.stop());
  expect(dependencies.track.stopped).toBe(true);
  expect(socket.sent).toContainEqual({ type: 'stop' });
  expect(onFinal).not.toHaveBeenCalled();

  await act(async () => {
    socket.serverJson({ type: 'completed', text: '分析总氮' });
  });
  expect(onFinal).toHaveBeenCalledOnce();
  expect(onFinal).toHaveBeenCalledWith('分析总氮');
  expect(result.current.elapsedMs).toBeGreaterThanOrEqual(0);
});

it('recognizes and delivers a final transcript through a real StrictMode effect cycle', async () => {
  const socket = new FakeBrowserWebSocket();
  const onFinal = vi.fn();
  const dependencies = fakeVoiceBrowser(socket);
  const { result } = renderHook(() => useVoiceRecognition({ onFinal, dependencies }), { reactStrictMode: true });

  await act(async () => result.current.start());
  await act(async () => socket.serverJson({ type: 'ready' }));
  await act(async () => socket.serverJson({ type: 'transcript', text: '严格模式', final: true }));
  await act(async () => socket.serverJson({ type: 'completed', text: '严格模式提问' }));

  expect(result.current.status).toBe('idle');
  expect(result.current.confirmedText).toBe('严格模式提问');
  expect(onFinal).toHaveBeenCalledOnce();
  expect(onFinal).toHaveBeenCalledWith('严格模式提问');
});

it('reports an unsupported browser without requesting a device', async () => {
  const socket = new FakeBrowserWebSocket();
  const dependencies = fakeVoiceBrowser(socket, { unsupported: true });
  const { result } = renderHook(() => useVoiceRecognition({ dependencies }));

  await act(async () => result.current.start());

  expect(result.current.status).toBe('error');
  expect(result.current.errorCode).toBe('VOICE_UNSUPPORTED');
});

it('reports unsupported when the audio context has no worklet loader', async () => {
  const socket = new FakeBrowserWebSocket();
  const dependencies = fakeVoiceBrowser(socket);
  Object.defineProperty(dependencies.context, 'audioWorklet', { value: undefined });
  const { result } = renderHook(() => useVoiceRecognition({ dependencies }));

  await act(async () => result.current.start());

  expect(result.current.status).toBe('error');
  expect(result.current.errorCode).toBe('VOICE_UNSUPPORTED');
  expect(dependencies.mediaDevices!.getUserMedia).not.toHaveBeenCalled();
  expect(dependencies.createWebSocket).not.toHaveBeenCalled();
  expect(dependencies.context.close).toHaveBeenCalledOnce();
});

it('reports a denied microphone permission', async () => {
  const socket = new FakeBrowserWebSocket();
  const dependencies = fakeVoiceBrowser(socket, { permissionError: new DOMException('denied', 'NotAllowedError') });
  const { result } = renderHook(() => useVoiceRecognition({ dependencies }));

  await act(async () => result.current.start());

  expect(result.current.status).toBe('error');
  expect(result.current.errorCode).toBe('VOICE_PERMISSION_DENIED');
});

it('raises no-speech without submitting a final transcript', async () => {
  const socket = new FakeBrowserWebSocket();
  const onFinal = vi.fn();
  const { result } = renderHook(() => useVoiceRecognition({ onFinal, dependencies: fakeVoiceBrowser(socket) }));

  await act(async () => result.current.start());
  await act(async () => socket.serverJson({ type: 'completed', text: '  ' }));

  expect(result.current.status).toBe('error');
  expect(result.current.errorCode).toBe('VOICE_NO_SPEECH');
  expect(onFinal).not.toHaveBeenCalled();
});

it('stops capture locally after sixty seconds', async () => {
  vi.useFakeTimers();
  const socket = new FakeBrowserWebSocket();
  const dependencies = fakeVoiceBrowser(socket);
  const { result } = renderHook(() => useVoiceRecognition({ dependencies }));

  await act(async () => result.current.start());
  await act(async () => socket.serverJson({ type: 'ready' }));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));

  expect(dependencies.track.stopped).toBe(true);
  expect(socket.sent).toContainEqual({ type: 'stop' });
  expect(result.current.status).toBe('stopping');
});

it('keeps awaiting a valid completion when the server limit races with the local stopping timer', async () => {
  const socket = new FakeBrowserWebSocket();
  const onFinal = vi.fn();
  const dependencies = fakeVoiceBrowser(socket);
  const { result } = renderHook(() => useVoiceRecognition({ onFinal, dependencies }));

  await act(async () => result.current.start());
  await act(async () => socket.serverJson({ type: 'ready' }));
  await act(async () => result.current.stop());
  expect(result.current.status).toBe('stopping');

  await act(async () => socket.serverJson({
    type: 'error',
    code: 'VOICE_LIMIT_EXCEEDED',
    message: 'server timer won the race',
  }));
  expect(result.current.status).toBe('stopping');

  await act(async () => socket.serverJson({ type: 'completed', text: '保留有效转写' }));
  expect(result.current.status).toBe('idle');
  expect(onFinal).toHaveBeenCalledWith('保留有效转写');
});

it('cancels cleanly when stopped during pending microphone permission', async () => {
  const socket = new FakeBrowserWebSocket();
  const onFinal = vi.fn();
  const dependencies = fakeVoiceBrowser(socket);
  const permission = deferred<MediaStream>();
  vi.mocked(dependencies.mediaDevices!.getUserMedia).mockReturnValue(permission.promise);
  const { result } = renderHook(() => useVoiceRecognition({ onFinal, dependencies }));
  let startPromise!: Promise<void>;

  act(() => {
    startPromise = result.current.start();
  });
  await act(async () => Promise.resolve());
  await act(async () => result.current.stop());

  expect(result.current.status).toBe('idle');
  permission.resolve({ getTracks: () => [dependencies.track] } as unknown as MediaStream);
  await act(async () => startPromise);
  expect(dependencies.track.stopped).toBe(true);
  expect(dependencies.createWebSocket).not.toHaveBeenCalled();
  expect(onFinal).not.toHaveBeenCalled();
});

it('cancels cleanly when stopped during worklet loading', async () => {
  const socket = new FakeBrowserWebSocket();
  const onFinal = vi.fn();
  const dependencies = fakeVoiceBrowser(socket);
  const workletLoad = deferred<void>();
  dependencies.context.audioWorklet.addModule.mockReturnValue(workletLoad.promise);
  const { result } = renderHook(() => useVoiceRecognition({ onFinal, dependencies }));
  let startPromise!: Promise<void>;

  act(() => {
    startPromise = result.current.start();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(dependencies.context.audioWorklet.addModule).toHaveBeenCalledOnce();
  await act(async () => result.current.stop());

  expect(result.current.status).toBe('idle');
  workletLoad.resolve();
  await act(async () => startPromise);
  expect(dependencies.track.stopped).toBe(true);
  expect(dependencies.createWebSocket).not.toHaveBeenCalled();
  expect(onFinal).not.toHaveBeenCalled();
});

it('cancels cleanly when stopped while the WebSocket is connecting', async () => {
  const socket = new FakeBrowserWebSocket(0);
  const onFinal = vi.fn();
  const dependencies = fakeVoiceBrowser(socket);
  const { result } = renderHook(() => useVoiceRecognition({ onFinal, dependencies }));

  await act(async () => result.current.start());
  await act(async () => result.current.stop());
  expect(socket.readyState).toBe(3);
  socket.serverOpen();

  expect(result.current.status).toBe('idle');
  expect(socket.readyState).toBe(1);
  expect(socket.sent).toEqual([]);
  expect(dependencies.track.stopped).toBe(true);
  expect(onFinal).not.toHaveBeenCalled();
});

it('closes without sending stop when stopped after start but before server ready', async () => {
  const socket = new FakeBrowserWebSocket();
  const onFinal = vi.fn();
  const dependencies = fakeVoiceBrowser(socket);
  const { result } = renderHook(() => useVoiceRecognition({ onFinal, dependencies }));

  await act(async () => result.current.start());
  await act(async () => result.current.stop());

  expect(result.current.status).toBe('idle');
  expect(socket.readyState).toBe(3);
  expect(socket.sent).toEqual([{ type: 'start', format: 'pcm', sampleRate: 16_000 }]);
  expect(dependencies.track.stopped).toBe(true);
  expect(onFinal).not.toHaveBeenCalled();
});

it('cancels without submitting and cleans resources exactly once', async () => {
  const socket = new FakeBrowserWebSocket();
  const onFinal = vi.fn();
  const dependencies = fakeVoiceBrowser(socket);
  const { result } = renderHook(() => useVoiceRecognition({ onFinal, dependencies }));

  await act(async () => result.current.start());
  await act(async () => socket.serverJson({ type: 'ready' }));
  await act(async () => result.current.cancel());
  await act(async () => result.current.cancel());

  expect(dependencies.track.stopped).toBe(true);
  expect(dependencies.context.close).toHaveBeenCalledOnce();
  expect(socket.readyState).toBe(3);
  expect(result.current.confirmedText).toBe('');
  expect(onFinal).not.toHaveBeenCalled();
});

it('cleans up on unmount without reacting to late messages', async () => {
  const socket = new FakeBrowserWebSocket();
  const dependencies = fakeVoiceBrowser(socket);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result, unmount } = renderHook(() => useVoiceRecognition({ dependencies }));

  await act(async () => result.current.start());
  await act(async () => socket.serverJson({ type: 'ready' }));
  unmount();
  await act(async () => socket.serverJson({ type: 'completed', text: 'late text' }));

  expect(dependencies.track.stopped).toBe(true);
  expect(dependencies.context.close).toHaveBeenCalledOnce();
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

it('concatenates final chunks and preserves all confirmed subtitles when the socket closes early', async () => {
  const socket = new FakeBrowserWebSocket();
  const onFinal = vi.fn();
  const { result } = renderHook(() => useVoiceRecognition({ onFinal, dependencies: fakeVoiceBrowser(socket) }));

  await act(async () => result.current.start());
  await act(async () => socket.serverJson({ type: 'ready' }));
  await act(async () => socket.serverJson({ type: 'transcript', text: '分析', final: true }));
  await act(async () => socket.serverJson({ type: 'transcript', text: '总氮', final: true }));
  await act(async () => socket.serverJson({ type: 'transcript', text: '未确认', final: false }));
  await act(async () => socket.serverClose());

  expect(result.current.confirmedText).toBe('分析总氮');
  expect(result.current.interimText).toBe('未确认');
  expect(result.current.status).toBe('error');
  expect(result.current.errorCode).toBe('VOICE_UPSTREAM_UNAVAILABLE');
  expect(onFinal).not.toHaveBeenCalled();
});
