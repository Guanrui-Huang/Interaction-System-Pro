import { createDefaultReportGenerator, createServer, loadDefaultDataset, startLocalServer } from './app';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReportJobRegistry } from './services/report-job-registry';
import { getAliyunNlsConfig } from './services/voice/config';
import { attachVoiceWebSocketGateway } from './services/voice/gateway';
import { getQwenOmniConfig } from './services/voice/omni-config';
import { createQwenOmniRecognitionSession } from './services/voice/omni-realtime-session';
import { synthesizeDashScopeSpeech } from './services/voice/dashscope-tts';
import {
  createAliyunRecognitionSdk,
  createAliyunSynthesisSdk,
} from './services/voice/nls-sessions';
import { SpeechAnswerRegistry } from './services/voice/speech-answer-registry';
import { AliyunNlsTokenManager, createPopTokenProvider } from './services/voice/token-manager';

export function getLocalServerPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = env.LOCAL_SERVER_PORT?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;

  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535
    ? port
    : undefined;
}

export function startApplication() {
  const dataset = loadDefaultDataset();
  const speechAnswers = new SpeechAnswerRegistry();
  const reportRegistry = new ReportJobRegistry({
    removeSpeechForReport: (reportId) => speechAnswers.removeReport(reportId),
  });
  const reportGenerator = createDefaultReportGenerator(dataset, reportRegistry, speechAnswers);
  const voiceConfig = getAliyunNlsConfig();
  const recognitionConfig = getQwenOmniConfig();
  const tokenManager = voiceConfig.success
    ? new AliyunNlsTokenManager(voiceConfig.data, createPopTokenProvider())
    : undefined;
  const port = getLocalServerPort();
  let detachVoiceGateway: () => void = () => undefined;

  const server = startLocalServer(
    createServer({
      dataset,
      reportRegistry,
      reportGenerator,
      speechAnswerRegistry: speechAnswers,
      staticDirectory: resolve('dist'),
    }),
    {
      ...(port === undefined ? {} : { port }),
      attachVoiceGateway: (httpServer) => {
        detachVoiceGateway = attachVoiceWebSocketGateway(httpServer, {
          config: voiceConfig,
          recognitionConfig,
          synthesisConfig: recognitionConfig,
          speechAnswers,
          reportRegistry,
          tokenManager,
          createRecognitionSdk: createAliyunRecognitionSdk,
          createRealtimeRecognitionSession: createQwenOmniRecognitionSession,
          createSynthesisSdk: createAliyunSynthesisSdk,
          synthesizeSpeech: synthesizeDashScopeSpeech,
        });
      },
    },
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      reportGenerator.dispose();
    } finally {
      detachVoiceGateway();
    }
  };
  const close = server.close.bind(server);
  server.once('close', shutdown);
  server.close = ((callback?: (error?: Error) => void) => {
    shutdown();
    return close(callback);
  }) as typeof server.close;
  return server;
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  startApplication();
}
