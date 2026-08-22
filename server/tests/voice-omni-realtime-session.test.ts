import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import {
  createQwenOmniRecognitionSession,
  type QwenOmniSocket,
} from '../src/services/voice/omni-realtime-session';

const config = {
  apiKey: 'dashscope-secret',
  workspaceId: 'workspace-1',
  region: 'cn' as const,
  model: 'qwen3.5-omni-flash-realtime',
  baseUrl: 'wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
  speechModel: 'qwen3.5-omni-flash',
  speechBaseUrl: 'https://workspace-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  speechVoice: 'Tina',
};

class FakeOmniSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
  });

  send(value: string) {
    this.sent.push(JSON.parse(value) as Record<string, unknown>);
  }

  provider(event: Record<string, unknown>) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}

function createHarness() {
  const socket = new FakeOmniSocket();
  const createSocket = vi.fn(() => socket as unknown as QwenOmniSocket);
  const onTranscript = vi.fn();
  let id = 0;
  const session = createQwenOmniRecognitionSession({
    config,
    createSocket,
    createEventId: () => `event-${++id}`,
    onTranscript,
  });
  return { socket, createSocket, onTranscript, session };
}

it('configures a manual Qwen3.5 Omni transcription session without exposing the key in events', async () => {
  const { socket, createSocket, session } = createHarness();
  const starting = session.start();

  expect(createSocket).toHaveBeenCalledWith(
    'wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-flash-realtime',
    'dashscope-secret',
  );
  socket.provider({ type: 'session.created' });
  expect(socket.sent[0]).toEqual({
    event_id: 'event-1',
    type: 'session.update',
    session: {
      model: 'qwen3.5-omni-flash-realtime',
      modalities: ['text'],
      audio: { input: { format: { type: 'pcm', sample_rate: 16_000 } } },
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
      turn_detection: null,
      instructions: '你是智慧污水处理厂的实时语音入口。准确转录用户问题，不编造现场数据。',
    },
  });
  expect(JSON.stringify(socket.sent)).not.toContain('dashscope-secret');

  socket.provider({ type: 'session.updated' });
  await expect(starting).resolves.toBeUndefined();
});

it('streams PCM as Base64 and maps Omni preview and completion events to the existing contract', async () => {
  const { socket, onTranscript, session } = createHarness();
  const starting = session.start();
  socket.provider({ type: 'session.created' });
  socket.provider({ type: 'session.updated' });
  await starting;

  expect(session.sendAudio(Buffer.from([0, 1, 2, 3]))).toBe(true);
  expect(socket.sent.at(-1)).toEqual({
    event_id: 'event-2',
    type: 'input_audio_buffer.append',
    audio: 'AAECAw==',
  });
  socket.provider({
    type: 'conversation.item.input_audio_transcription.delta',
    text: '分析今天',
    stash: '的总氮',
  });

  const stopping = session.stop();
  expect(socket.sent.at(-1)).toEqual({
    event_id: 'event-3',
    type: 'input_audio_buffer.commit',
  });
  socket.provider({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '分析今天的总氮。',
  });

  await expect(stopping).resolves.toBeUndefined();
  await expect(session.completedText).resolves.toBe('分析今天的总氮。');
  expect(onTranscript.mock.calls).toEqual([
    ['分析今天的总氮', false],
    ['分析今天的总氮。', true],
  ]);
  expect(socket.sent.at(-1)).toEqual({ event_id: 'event-4', type: 'session.finish' });
  expect(socket.close).toHaveBeenCalledOnce();
});

it('classifies an upstream 403 as a typed Omni authentication failure', async () => {
  const { socket, session } = createHarness();
  const starting = session.start();
  const completion = session.completedText.catch((error: unknown) => error);

  socket.emit('unexpected-response', {}, { statusCode: 403 });

  await expect(starting).rejects.toMatchObject({
    name: 'QwenOmniRealtimeError',
    code: 'QWEN_OMNI_AUTH',
  });
  await expect(completion).resolves.toMatchObject({ code: 'QWEN_OMNI_AUTH' });
});

it('rejects an empty final transcript so the gateway can report no speech', async () => {
  const { socket, session } = createHarness();
  const starting = session.start();
  socket.provider({ type: 'session.created' });
  socket.provider({ type: 'session.updated' });
  await starting;
  const stopping = session.stop();

  socket.provider({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '   ',
  });

  await expect(stopping).resolves.toBeUndefined();
  await expect(session.completedText).resolves.toBe('');
});
