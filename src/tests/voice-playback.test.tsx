import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createAudioSegmentPlayer,
  type AudioSegmentPlayer,
} from '../features/ai/voice/audio-segment-player';
import { VoiceInteraction } from '../features/ai/voice/VoiceInteraction';
import {
  MAX_AUDIO_SEGMENT_BYTES,
  MAX_AUDIO_TOTAL_BYTES,
  MAX_SYNTHESIS_SEGMENTS,
  useVoicePlayback,
  type VoicePlaybackSocket,
} from '../features/ai/voice/useVoicePlayback';

type SocketListener = (event: { data?: unknown }) => void;

class FakeBrowserWebSocket implements VoicePlaybackSocket {
  readonly sent: unknown[] = [];
  binaryType: BinaryType = 'blob';
  readyState: number;
  onopen: SocketListener | null = null;
  onmessage: SocketListener | null = null;
  onerror: SocketListener | null = null;
  onclose: SocketListener | null = null;

  constructor(readyState = 1) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverJson(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverBinary(bytes: number[]): void {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }

  serverBuffer(byteLength: number): void {
    this.onmessage?.({ data: new ArrayBuffer(byteLength) });
  }

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

class FakeAudioSegmentPlayer implements AudioSegmentPlayer {
  durationMs = vi.fn(() => 0);
  readonly enqueued: number[][] = [];
  readonly listeners = new Set<() => void>();
  readonly endedListeners = new Set<() => void>();
  play = vi.fn(async (speech: { segments: ArrayBuffer[] }) => {
    this.enqueued.push(...speech.segments.map((bytes) => Array.from(new Uint8Array(bytes))));
  });
  enqueue = vi.fn(async (bytes: ArrayBuffer) => {
    this.enqueued.push(Array.from(new Uint8Array(bytes)));
  });
  pause = vi.fn(async (): Promise<void> => undefined);
  resume = vi.fn(async (): Promise<void> => undefined);
  stop = vi.fn(async (): Promise<void> => undefined);
  positionMs = vi.fn(() => 0);

  onEnded(listener: () => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  onSegmentEnded(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  endSegment(): void {
    for (const listener of this.listeners) listener();
  }
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();

  end(): void {
    this.onended?.();
  }
}

class FakePlaybackAudioContext {
  readonly destination = {} as AudioDestinationNode;
  readonly sources: FakeBufferSource[] = [];
  readonly decoded: ArrayBuffer[] = [];
  state: AudioContextState = 'running';
  currentTime = 0;
  resume = vi.fn(async () => { this.state = 'running'; });
  suspend = vi.fn(async () => { this.state = 'suspended'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => {
    this.decoded.push(bytes);
    return { duration: bytes.byteLength } as AudioBuffer;
  });
  createBufferSource = vi.fn(() => {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('decodes complete MP3 segments and starts the next source only after the previous source ends', async () => {
  const context = new FakePlaybackAudioContext();
  const player = createAudioSegmentPlayer({
    createAudioContext: () => context as unknown as AudioContext,
  });
  const ended = vi.fn();
  player.onSegmentEnded(ended);

  await player.enqueue(new Uint8Array([1, 2]).buffer);
  await player.enqueue(new Uint8Array([3, 4]).buffer);

  expect(context.decoded.map((bytes) => Array.from(new Uint8Array(bytes)))).toEqual([[1, 2], [3, 4]]);
  expect(context.sources).toHaveLength(1);
  expect(context.sources[0].start).toHaveBeenCalledOnce();

  context.sources[0].end();
  expect(ended).toHaveBeenCalledOnce();
  expect(context.sources).toHaveLength(2);
  expect(context.sources[1].start).toHaveBeenCalledOnce();

  await player.pause();
  await player.resume();
  await player.stop();
  await player.stop();

  expect(context.suspend).toHaveBeenCalledOnce();
  expect(context.resume).toHaveBeenCalledOnce();
  expect(context.sources[1].stop).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
});

it('resumes a browser-suspended audio context before starting a decoded segment', async () => {
  const context = new FakePlaybackAudioContext();
  context.state = 'suspended';
  const player = createAudioSegmentPlayer({
    createAudioContext: () => context as unknown as AudioContext,
  });

  await player.enqueue(new Uint8Array([1, 2, 3]).buffer);

  expect(context.resume).toHaveBeenCalledOnce();
  expect(context.sources[0].start).toHaveBeenCalledOnce();
});

it('does not auto-resume a suspended context when a deferred decode settles after an explicit pause', async () => {
  const context = new FakePlaybackAudioContext();
  const decode = deferred<AudioBuffer>();
  context.state = 'suspended';
  context.decodeAudioData.mockReturnValueOnce(decode.promise);
  const player = createAudioSegmentPlayer({
    createAudioContext: () => context as unknown as AudioContext,
  });

  const enqueuePromise = player.enqueue(new Uint8Array([1, 2, 3]).buffer);
  await Promise.resolve();
  await player.pause();
  decode.resolve({ duration: 1 } as AudioBuffer);
  await enqueuePromise;

  expect(context.resume).not.toHaveBeenCalled();
  expect(context.state).toBe('suspended');
});

it('plays from an exact clamped offset, reports position, and emits one speech-ended event', async () => {
  const context = new FakePlaybackAudioContext();
  const player = createAudioSegmentPlayer({
    createAudioContext: () => context as unknown as AudioContext,
  });
  const ended = vi.fn();
  player.onEnded(ended);

  await player.play({ segments: [new ArrayBuffer(2), new ArrayBuffer(3)] }, { offsetMs: 2_500 });
  expect(context.sources).toHaveLength(1);
  expect(context.sources[0].start).toHaveBeenCalledWith(0, 0.5);
  context.currentTime = 1.25;
  expect(player.positionMs()).toBe(3_750);

  context.sources[0].end();
  expect(ended).toHaveBeenCalledOnce();
  expect(player.positionMs()).toBe(5_000);
  await player.stop();
  await player.stop();
  expect(context.close).toHaveBeenCalledOnce();
});

it('pauses, resumes, stops the active source, and removes listeners exactly once', async () => {
  const context = new FakePlaybackAudioContext();
  const player = createAudioSegmentPlayer({
    createAudioContext: () => context as unknown as AudioContext,
  });
  const ended = vi.fn();
  const unsubscribe = player.onEnded(ended);
  await player.play({ segments: [new ArrayBuffer(2)] });
  await player.pause();
  await player.resume();
  unsubscribe();
  await player.stop();
  context.sources[0].end();

  expect(context.suspend).toHaveBeenCalledOnce();
  expect(context.resume).toHaveBeenCalledOnce();
  expect(context.sources[0].stop).toHaveBeenCalledOnce();
  expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
  expect(ended).not.toHaveBeenCalled();
});

it('defines explicit synthesis count and byte ceilings', () => {
  expect(MAX_SYNTHESIS_SEGMENTS).toBe(64);
  expect(MAX_AUDIO_SEGMENT_BYTES).toBe(4 * 1024 * 1024);
  expect(MAX_AUDIO_TOTAL_BYTES).toBe(32 * 1024 * 1024);
});

it('plays successfully when mounted through a real StrictMode effect cycle', async () => {
  const socket = new FakeBrowserWebSocket();
  const player = new FakeAudioSegmentPlayer();
  const { result } = renderHook(() => useVoicePlayback({
    dependencies: {
      createWebSocket: () => socket,
      createPlayer: () => player,
    },
  }), { reactStrictMode: true });

  await act(async () => result.current.play('report-1', 'speech-strict'));
  expect(socket.sent).toEqual([{ type: 'synthesize', reportId: 'report-1', speechId: 'speech-strict' }]);

  await act(async () => {
    socket.serverJson({ type: 'ready', segmentCount: 1 });
    socket.serverJson({ type: 'segment-start', index: 0 });
    socket.serverBinary([1, 2]);
    socket.serverJson({ type: 'segment-end', index: 0 });
    socket.serverJson({ type: 'completed' });
  });
  act(() => player.endSegment());

  expect(result.current.progress).toEqual({ completed: 1, total: 1 });
  expect(result.current.status).toBe('idle');
});

it('sends only the opaque speech ID, queues matching segments in order, and reports actual playback progress', async () => {
  const socket = new FakeBrowserWebSocket();
  const player = new FakeAudioSegmentPlayer();
  const { result } = renderHook(() => useVoicePlayback({ dependencies: { socket, player } }));

  await act(async () => result.current.play('report-1', 'speech-123'));

  expect(socket.binaryType).toBe('arraybuffer');
  expect(socket.sent).toEqual([{ type: 'synthesize', reportId: 'report-1', speechId: 'speech-123' }]);
  expect(JSON.stringify(socket.sent)).not.toContain('answer');

  await act(async () => {
    socket.serverJson({ type: 'ready', segmentCount: 2 });
    socket.serverJson({ type: 'segment-start', index: 0 });
    socket.serverBinary([1, 2]);
    socket.serverJson({ type: 'segment-end', index: 0 });
    socket.serverJson({ type: 'segment-start', index: 1 });
    socket.serverBinary([3, 4]);
    socket.serverJson({ type: 'segment-end', index: 1 });
  });

  await waitFor(() => expect(player.enqueued).toEqual([[1, 2], [3, 4]]));
  expect(result.current.progress).toEqual({ completed: 0, total: 2 });
  expect(result.current.status).toBe('speaking');

  await act(async () => result.current.pause());
  expect(result.current.status).toBe('paused');
  await act(async () => result.current.resume());
  expect(result.current.status).toBe('speaking');

  act(() => player.endSegment());
  expect(result.current.progress).toEqual({ completed: 1, total: 2 });
  act(() => player.endSegment());
  expect(result.current.progress).toEqual({ completed: 2, total: 2 });
  expect(result.current.status).toBe('speaking');
  expect(player.stop).not.toHaveBeenCalled();

  act(() => socket.serverJson({ type: 'completed' }));
  await waitFor(() => expect(result.current.status).toBe('idle'));
  expect(player.stop).toHaveBeenCalledOnce();
  expect(player.pause).toHaveBeenCalledOnce();
  expect(player.resume).toHaveBeenCalledOnce();
  expect(socket.sent).not.toContainEqual({ type: 'cancel' });
});

it('releases only after local playback catches up when server completion arrives first', async () => {
  const socket = new FakeBrowserWebSocket();
  const player = new FakeAudioSegmentPlayer();
  const { result } = renderHook(() => useVoicePlayback({ dependencies: { socket, player } }));

  await act(async () => result.current.play('report-1', 'speech-server-first'));
  await act(async () => {
    socket.serverJson({ type: 'ready', segmentCount: 1 });
    socket.serverJson({ type: 'segment-start', index: 0 });
    socket.serverBinary([1]);
    socket.serverJson({ type: 'segment-end', index: 0 });
    socket.serverJson({ type: 'completed' });
  });

  expect(result.current.status).toBe('speaking');
  expect(player.stop).not.toHaveBeenCalled();
  act(() => player.endSegment());
  await waitFor(() => expect(result.current.status).toBe('idle'));
  expect(player.stop).toHaveBeenCalledOnce();
});

it('keeps the playback session paused when a segment enqueue resolves late', async () => {
  const socket = new FakeBrowserWebSocket();
  const player = new FakeAudioSegmentPlayer();
  const enqueue = deferred<void>();
  player.enqueue.mockReturnValueOnce(enqueue.promise);
  const { result } = renderHook(() => useVoicePlayback({ dependencies: { socket, player } }));

  await act(async () => result.current.play('report-1', 'speech-paused-decode'));
  act(() => {
    socket.serverJson({ type: 'ready', segmentCount: 1 });
    socket.serverJson({ type: 'segment-start', index: 0 });
    socket.serverBinary([1, 2]);
    socket.serverJson({ type: 'segment-end', index: 0 });
  });
  await act(async () => result.current.pause());
  expect(result.current.status).toBe('paused');

  enqueue.resolve();
  await act(async () => enqueue.promise);
  expect(result.current.status).toBe('paused');
});

it('rejects excessive segment counts and cumulative segment bytes with a safe audio error', async () => {
  const countSocket = new FakeBrowserWebSocket();
  const countPlayer = new FakeAudioSegmentPlayer();
  const byteSocket = new FakeBrowserWebSocket();
  const bytePlayer = new FakeAudioSegmentPlayer();
  const sockets = [countSocket, byteSocket];
  const players = [countPlayer, bytePlayer];
  const { result } = renderHook(() => useVoicePlayback({
    dependencies: {
      createWebSocket: () => sockets.shift()!,
      createPlayer: () => players.shift()!,
    },
  }));

  await act(async () => result.current.play('report-1', 'speech-too-many'));
  act(() => countSocket.serverJson({ type: 'ready', segmentCount: MAX_SYNTHESIS_SEGMENTS + 1 }));
  expect(result.current.errorCode).toBe('VOICE_INVALID_AUDIO');
  expect(countPlayer.stop).toHaveBeenCalledOnce();

  await act(async () => result.current.play('report-1', 'speech-too-large'));
  act(() => {
    byteSocket.serverJson({ type: 'ready', segmentCount: 1 });
    byteSocket.serverJson({ type: 'segment-start', index: 0 });
    byteSocket.serverBuffer(Math.floor(MAX_AUDIO_SEGMENT_BYTES / 2) + 1);
    byteSocket.serverBuffer(Math.floor(MAX_AUDIO_SEGMENT_BYTES / 2) + 1);
  });
  expect(result.current.errorCode).toBe('VOICE_INVALID_AUDIO');
  expect(bytePlayer.stop).toHaveBeenCalledOnce();
  expect(bytePlayer.enqueue).not.toHaveBeenCalled();
});

it('rejects audio whose checked cumulative session bytes exceed the total ceiling', async () => {
  const socket = new FakeBrowserWebSocket();
  const player = new FakeAudioSegmentPlayer();
  player.enqueue.mockImplementation(async () => undefined);
  const { result } = renderHook(() => useVoicePlayback({ dependencies: { socket, player } }));
  const fullSegments = MAX_AUDIO_TOTAL_BYTES / MAX_AUDIO_SEGMENT_BYTES;

  await act(async () => result.current.play('report-1', 'speech-total-too-large'));
  act(() => socket.serverJson({ type: 'ready', segmentCount: fullSegments + 1 }));
  for (let index = 0; index < fullSegments; index += 1) {
    act(() => {
      socket.serverJson({ type: 'segment-start', index });
      socket.serverBuffer(MAX_AUDIO_SEGMENT_BYTES);
      socket.serverJson({ type: 'segment-end', index });
    });
  }
  act(() => {
    socket.serverJson({ type: 'segment-start', index: fullSegments });
    socket.serverBuffer(1);
  });

  expect(result.current.errorCode).toBe('VOICE_INVALID_AUDIO');
  expect(player.stop).toHaveBeenCalledOnce();
});

it('fails safely on out-of-order framing and ignores late events from an older playback session', async () => {
  const firstSocket = new FakeBrowserWebSocket();
  const secondSocket = new FakeBrowserWebSocket();
  const firstPlayer = new FakeAudioSegmentPlayer();
  const secondPlayer = new FakeAudioSegmentPlayer();
  const sockets = [firstSocket, secondSocket];
  const players = [firstPlayer, secondPlayer];
  const { result } = renderHook(() => useVoicePlayback({
    dependencies: {
      createWebSocket: () => sockets.shift()!,
      createPlayer: () => players.shift()!,
    },
  }));

  await act(async () => result.current.play('report-1', 'speech-old'));
  await act(async () => result.current.play('report-1', 'speech-new'));
  expect(firstSocket.sent).toContainEqual({ type: 'cancel' });
  expect(firstPlayer.stop).toHaveBeenCalledOnce();

  await act(async () => {
    firstSocket.serverJson({ type: 'ready', segmentCount: 1 });
    firstSocket.serverJson({ type: 'segment-start', index: 0 });
    firstSocket.serverBinary([9]);
    firstSocket.serverJson({ type: 'segment-end', index: 0 });
  });
  expect(firstPlayer.enqueued).toEqual([]);

  await act(async () => {
    secondSocket.serverJson({ type: 'ready', segmentCount: 2 });
    secondSocket.serverJson({ type: 'segment-start', index: 1 });
  });
  expect(result.current.status).toBe('error');
  expect(result.current.errorCode).toBe('VOICE_INVALID_AUDIO');
  expect(secondPlayer.stop).toHaveBeenCalledOnce();
});

it('keeps only the newest overlapping play request after asynchronous prior-session cleanup', async () => {
  const sockets: FakeBrowserWebSocket[] = [];
  const players: FakeAudioSegmentPlayer[] = [];
  const { result } = renderHook(() => useVoicePlayback({
    dependencies: {
      createWebSocket: () => {
        const socket = new FakeBrowserWebSocket();
        sockets.push(socket);
        return socket;
      },
      createPlayer: () => {
        const player = new FakeAudioSegmentPlayer();
        players.push(player);
        return player;
      },
    },
  }));

  await act(async () => Promise.all([
    result.current.play('report-1', 'speech-stale'),
    result.current.play('report-1', 'speech-newest'),
  ]));

  expect(sockets).toHaveLength(1);
  expect(players).toHaveLength(1);
  expect(sockets[0].sent).toEqual([{ type: 'synthesize', reportId: 'report-1', speechId: 'speech-newest' }]);
});

it('does not let deferred failed-construction cleanup overwrite a newer playback session', async () => {
  const staleStop = deferred<void>();
  const stalePlayer = new FakeAudioSegmentPlayer();
  stalePlayer.stop.mockReturnValueOnce(staleStop.promise);
  const activePlayer = new FakeAudioSegmentPlayer();
  const activeSocket = new FakeBrowserWebSocket();
  const players = [stalePlayer, activePlayer];
  let socketAttempt = 0;
  const { result } = renderHook(() => useVoicePlayback({
    dependencies: {
      createPlayer: () => players.shift()!,
      createWebSocket: () => {
        socketAttempt += 1;
        if (socketAttempt === 1) throw new Error('construction failed');
        return activeSocket;
      },
    },
  }));
  let stalePlay!: Promise<void>;

  act(() => { stalePlay = result.current.play('report-1', 'speech-stale-construction'); });
  await act(async () => Promise.resolve());
  await act(async () => result.current.play('report-1', 'speech-new-construction'));
  expect(activeSocket.sent).toEqual([{ type: 'synthesize', reportId: 'report-1', speechId: 'speech-new-construction' }]);

  staleStop.resolve();
  await act(async () => stalePlay);
  expect(result.current.status).toBe('preparing');
  expect(result.current.errorCode).toBeNull();
});

it('guards deferred construction cleanup after unmount', async () => {
  const stopped = deferred<void>();
  const player = new FakeAudioSegmentPlayer();
  player.stop.mockReturnValueOnce(stopped.promise);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result, unmount } = renderHook(() => useVoicePlayback({
    dependencies: {
      createPlayer: () => player,
      createWebSocket: () => { throw new Error('construction failed'); },
    },
  }));
  let playPromise!: Promise<void>;

  act(() => { playPromise = result.current.play('report-1', 'speech-unmount-construction'); });
  await act(async () => Promise.resolve());
  unmount();
  stopped.resolve();
  await act(async () => playPromise);

  expect(player.stop).toHaveBeenCalledOnce();
  expect(consoleError).not.toHaveBeenCalled();
});

it('uses optional socket/player dependencies once and creates fresh resources for repeat playback', async () => {
  const oneShotSocket = new FakeBrowserWebSocket();
  const oneShotPlayer = new FakeAudioSegmentPlayer();
  const repeatSocket = new FakeBrowserWebSocket();
  const repeatPlayer = new FakeAudioSegmentPlayer();
  const createWebSocket = vi.fn(() => repeatSocket);
  const createPlayer = vi.fn(() => repeatPlayer);
  const { result } = renderHook(() => useVoicePlayback({
    dependencies: { socket: oneShotSocket, player: oneShotPlayer, createWebSocket, createPlayer },
  }));

  await act(async () => result.current.play('report-1', 'speech-one-shot'));
  await act(async () => result.current.play('report-1', 'speech-repeat'));

  expect(oneShotSocket.sent).toContainEqual({ type: 'synthesize', reportId: 'report-1', speechId: 'speech-one-shot' });
  expect(oneShotPlayer.stop).toHaveBeenCalledOnce();
  expect(createWebSocket).toHaveBeenCalledOnce();
  expect(createPlayer).toHaveBeenCalledOnce();
  expect(repeatSocket.sent).toEqual([{ type: 'synthesize', reportId: 'report-1', speechId: 'speech-repeat' }]);
});

it('still stops the player and resolves cleanup when socket.close throws', async () => {
  const socket = new FakeBrowserWebSocket();
  const player = new FakeAudioSegmentPlayer();
  socket.close = vi.fn(() => { throw new Error('close failed'); });
  const { result } = renderHook(() => useVoicePlayback({ dependencies: { socket, player } }));

  await act(async () => result.current.play('report-1', 'speech-close-throws'));
  await act(async () => {
    await expect(result.current.stop()).resolves.toBeUndefined();
  });

  expect(socket.close).toHaveBeenCalledOnce();
  expect(player.stop).toHaveBeenCalledOnce();
  expect(result.current.status).toBe('idle');
});

it('converts a synchronous socket send failure into a safe playback error', async () => {
  const socket = new FakeBrowserWebSocket();
  socket.send = vi.fn(() => {
    throw new DOMException('socket closed', 'InvalidStateError');
  });
  const player = new FakeAudioSegmentPlayer();
  const { result } = renderHook(() => useVoicePlayback({ dependencies: { socket, player } }));

  await act(async () => result.current.play('report-1', 'speech-send-error'));

  expect(result.current.status).toBe('error');
  expect(result.current.errorCode).toBe('VOICE_UPSTREAM_UNAVAILABLE');
  expect(player.stop).toHaveBeenCalledOnce();
});

it('cancels playback idempotently on unmount and ignores later socket/player events', async () => {
  const socket = new FakeBrowserWebSocket();
  const player = new FakeAudioSegmentPlayer();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result, unmount } = renderHook(() => useVoicePlayback({ dependencies: { socket, player } }));

  await act(async () => result.current.play('report-1', 'speech-unmount'));
  unmount();
  await act(async () => {
    socket.serverJson({ type: 'ready', segmentCount: 1 });
    player.endSegment();
  });

  expect(player.stop).toHaveBeenCalledOnce();
  expect(socket.sent).toContainEqual({ type: 'cancel' });
  expect(consoleError).not.toHaveBeenCalled();
});

it('renders an accessible microphone, live subtitles, timer, and playback controls', async () => {
  const user = userEvent.setup();
  const onStartRecognition = vi.fn();
  const onStopRecognition = vi.fn();
  const pause = vi.fn();
  const resume = vi.fn();
  const stop = vi.fn();
  const { rerender } = render(
    <VoiceInteraction
      isAnalyzing={false}
      onStartRecognition={onStartRecognition}
      onStopRecognition={onStopRecognition}
      playback={{ status: 'idle', progress: { completed: 0, total: 0 }, errorCode: null, pause, resume, stop }}
      recognition={{ status: 'idle', confirmedText: '', interimText: '', elapsedMs: 0, errorCode: null }}
    />,
  );

  const microphone = screen.getByRole('button', { name: '开始语音提问' });
  expect(microphone).toHaveAttribute('aria-pressed', 'false');
  await user.click(microphone);
  expect(onStartRecognition).toHaveBeenCalledOnce();

  rerender(
    <VoiceInteraction
      isAnalyzing={false}
      onStartRecognition={onStartRecognition}
      onStopRecognition={onStopRecognition}
      playback={{ status: 'speaking', progress: { completed: 1, total: 3 }, errorCode: null, pause, resume, stop }}
      recognition={{ status: 'recording', confirmedText: '分析', interimText: '总氮趋势', elapsedMs: 65_000, errorCode: null }}
    />,
  );

  expect(screen.getByRole('button', { name: '结束语音提问' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('01:05')).toBeInTheDocument();
  const transcript = screen.getByRole('status');
  expect(transcript).toHaveAttribute('aria-live', 'polite');
  expect(transcript).toHaveTextContent('分析');
  expect(transcript).toHaveTextContent('总氮趋势');
  expect(screen.getByText('已播放 1 / 3 段')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '暂停播报' }));
  await user.click(screen.getByRole('button', { name: '停止播报' }));
  expect(pause).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();

  rerender(
    <VoiceInteraction
      isAnalyzing={false}
      onStartRecognition={onStartRecognition}
      onStopRecognition={onStopRecognition}
      playback={{ status: 'paused', progress: { completed: 1, total: 3 }, errorCode: null, pause, resume, stop }}
      recognition={{ status: 'idle', confirmedText: '分析总氮趋势', interimText: '', elapsedMs: 65_000, errorCode: null }}
    />,
  );
  await user.click(screen.getByRole('button', { name: '继续播报' }));
  expect(resume).toHaveBeenCalledOnce();
});

it('contains rejected microphone and playback control promises', async () => {
  const alreadyHandled = (message: string) => {
    const promise = Promise.reject(new Error(message));
    promise.catch(() => undefined);
    const catchSpy = vi.spyOn(promise, 'catch');
    return { promise, catchSpy };
  };
  const start = alreadyHandled('start');
  const pause = alreadyHandled('pause');
  const stop = alreadyHandled('stop');
  const user = userEvent.setup();
  const view = render(
    <VoiceInteraction
      isAnalyzing={false}
      onStartRecognition={() => start.promise}
      onStopRecognition={vi.fn()}
      playback={{
        status: 'idle',
        progress: { completed: 0, total: 0 },
        errorCode: null,
        pause: () => pause.promise,
        resume: vi.fn(),
        stop: () => stop.promise,
      }}
      recognition={{ status: 'idle', confirmedText: '', interimText: '', elapsedMs: 0, errorCode: null }}
    />,
  );

  await user.click(screen.getByRole('button', { name: '开始语音提问' }));
  expect(start.catchSpy).toHaveBeenCalled();

  view.rerender(
    <VoiceInteraction
      isAnalyzing={false}
      onStartRecognition={vi.fn()}
      onStopRecognition={vi.fn()}
      playback={{
        status: 'speaking',
        progress: { completed: 0, total: 1 },
        errorCode: null,
        pause: () => pause.promise,
        resume: vi.fn(),
        stop: () => stop.promise,
      }}
      recognition={{ status: 'idle', confirmedText: '', interimText: '', elapsedMs: 0, errorCode: null }}
    />,
  );
  await user.click(screen.getByRole('button', { name: '暂停播报' }));
  await user.click(screen.getByRole('button', { name: '停止播报' }));
  expect(pause.catchSpy).toHaveBeenCalled();
  expect(stop.catchSpy).toHaveBeenCalled();
});
