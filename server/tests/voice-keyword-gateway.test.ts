import express from 'express';
import { once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { ReportJobRegistry } from '../src/services/report-job-registry';
import { SpeechAnswerRegistry } from '../src/services/voice/speech-answer-registry';
import { attachVoiceWebSocketGateway, type VoiceGatewayDependencies } from '../src/services/voice/gateway';

class KeywordStream {
  readonly accepted: Array<{ samples: Float32Array; sampleRate: number }> = [];
  keyword = '小智小智';
  acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void { this.accepted.push(waveform); }
  inputFinished(): void {}
}

class KeywordSpotter {
  readonly stream = new KeywordStream();
  private ready = true;
  createStream(): KeywordStream { return this.stream; }
  isReady(): boolean { return this.ready; }
  decode(): void { this.ready = false; }
  getResult(): { keyword: string } { return { keyword: this.stream.keyword }; }
  reset(): void { this.ready = false; }
}

it('accepts PCM on the keyword socket and emits a single wake event', async () => {
  const httpServer = createServer(express());
  const reportRegistry = new ReportJobRegistry({ createId: () => 'report-1' });
  const dependencies: VoiceGatewayDependencies = {
    config: { success: false, missing: ['ALIYUN_NLS_APP_KEY'] },
    speechAnswers: new SpeechAnswerRegistry({ createId: () => 'answer-1' }),
    reportRegistry,
    keywordSpotter: new KeywordSpotter(),
    createRecognitionSdk: vi.fn() as never,
    createSynthesisSdk: vi.fn() as never,
  };
  const detach = attachVoiceWebSocketGateway(httpServer, dependencies);
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/voice/keyword`, { origin: url });
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', format: 'pcm', sampleRate: 16_000 }));
  const [ready] = await once(client, 'message');
  expect(JSON.parse(ready.toString())).toEqual({ type: 'ready' });

  client.send(Buffer.from([0, 0, 1, 0]));
  const [wake] = await once(client, 'message');
  expect(JSON.parse(wake.toString())).toMatchObject({ type: 'wake', keyword: '小智小智' });

  client.close();
  await once(client, 'close');
  detach();
  await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
});
