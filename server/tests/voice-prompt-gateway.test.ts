import express from 'express';
import { once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { ReportJobRegistry } from '../src/services/report-job-registry';
import { SpeechAnswerRegistry } from '../src/services/voice/speech-answer-registry';
import { attachVoiceWebSocketGateway, type VoiceGatewayDependencies } from '../src/services/voice/gateway';

const synthesisConfig = {
  success: true as const,
  data: {
    apiKey: 'dashscope-key', workspaceId: 'workspace-1', region: 'cn' as const,
    model: 'qwen3.5-omni-flash-realtime', baseUrl: 'wss://workspace.test',
    speechModel: 'qwen-audio-3.0-tts-plus', speechBaseUrl: 'https://speech.test', speechVoice: 'longanlingxin',
  },
};

it('synthesizes the dynamic analysis acknowledgement with the user question', async () => {
  const httpServer = createServer(express());
  const synthesizeSpeech = vi.fn(async ({ text }: { text: string }) => Buffer.from(`audio:${text}`)) as never;
  const dependencies: VoiceGatewayDependencies = {
    config: { success: false, missing: ['ALIYUN_NLS_APP_KEY'] },
    synthesisConfig,
    synthesizeSpeech,
    speechAnswers: new SpeechAnswerRegistry({ createId: () => 'answer-1' }),
    reportRegistry: new ReportJobRegistry({ createId: () => 'report-1' }),
    createRecognitionSdk: vi.fn() as never,
    createSynthesisSdk: vi.fn() as never,
  };
  const detach = attachVoiceWebSocketGateway(httpServer, dependencies);
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/synthesize`, { origin: url });
  const controls: Record<string, unknown>[] = [];
  client.on('message', (data, isBinary) => { if (!isBinary) controls.push(JSON.parse(data.toString())); });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'prompt', prompt: 'analysis-started', question: '  分析总氮趋势  ' }));
  await once(client, 'close');

  expect(synthesizeSpeech).toHaveBeenCalledWith(expect.objectContaining({ text: '好滴，现在我来分析：分析总氮趋势' }));
  expect(controls).toContainEqual({ type: 'completed' });
  detach();
  await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
});
