import express, { type Express } from 'express';
import { createServer as createHttpServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import type { DashboardDataset } from '../../shared/dashboard';
import { loadWorkbook } from './data/workbook';
import { resolveReportEvidence } from './domain/report-evidence-resolver';
import { dashboardRouter } from './routes/dashboard';
import { reportsRouter } from './routes/reports';
import { planReportIntent } from './services/report-intent-planner';
import { ReportGenerator } from './services/report-generator';
import { ReportFollowUpService } from './services/report-follow-up';
import { ReportJobRegistry } from './services/report-job-registry';
import { planReport } from './services/intent-first-report-planner';
import { composeSlide } from './services/intent-first-slide-composer';
import { SpeechAnswerRegistry } from './services/voice/speech-answer-registry';

export type ServerOptions = {
  dataset?: DashboardDataset;
  reportRegistry?: ReportJobRegistry;
  reportGenerator?: ReportGenerator;
  reportFollowUpService?: ReportFollowUpService;
  reportHeartbeatMs?: number;
  speechAnswerRegistry?: SpeechAnswerRegistry;
  staticDirectory?: string;
};

export const LOCAL_SERVER_HOST = '127.0.0.1';
export const LOCAL_SERVER_PORT = 8787;

export function loadDefaultDataset(): DashboardDataset {
  return loadWorkbook(resolve('data/智慧污水处理厂_演示数据.xlsx'));
}

export function createDefaultReportGenerator(
  dataset: DashboardDataset,
  registry: ReportJobRegistry,
  speechAnswers: SpeechAnswerRegistry,
): ReportGenerator {
  return new ReportGenerator({
    dataset,
    registry,
    planReportIntent,
    resolveReportEvidence,
    planReport: planReport,
    composeSlide: composeSlide,
    registerSpeech: (reportId, text) => speechAnswers.register(reportId, text),
    unregisterSpeech: (reportId, speechId) => { speechAnswers.remove(reportId, speechId); },
  });
}

export function startLocalServer(
  app: Express,
  options: {
    port?: number;
    log?: (message: string) => void;
    attachVoiceGateway?: (server: Server) => void;
  } = {},
): Server {
  const port = options.port ?? LOCAL_SERVER_PORT;
  const log = options.log ?? ((message: string) => console.log(message));
  const server = createHttpServer(app);
  options.attachVoiceGateway?.(server);
  server.listen(port, LOCAL_SERVER_HOST, () => {
    const address = server.address();
    const listeningPort = typeof address === 'object' && address ? address.port : port;
    log(`API listening on http://${LOCAL_SERVER_HOST}:${listeningPort}`);
  });
  return server;
}

export function createServer(options: ServerOptions = {}): Express {
  const app = express();
  const dataset = options.dataset ?? loadDefaultDataset();
  const speechAnswers = options.speechAnswerRegistry ?? new SpeechAnswerRegistry();
  const reportRegistry = options.reportRegistry
    ?? options.reportGenerator?.dependencies.registry
    ?? new ReportJobRegistry({ removeSpeechForReport: (reportId) => speechAnswers.removeReport(reportId) });
  const reportGenerator = options.reportGenerator
    ?? createDefaultReportGenerator(dataset, reportRegistry, speechAnswers);
  if (reportGenerator.dependencies.registry !== reportRegistry) {
    throw new Error('REPORT_DEPENDENCY_MISMATCH');
  }
  const reportFollowUpService = options.reportFollowUpService ?? new ReportFollowUpService({
    registry: reportRegistry,
    registerSpeech: (reportId, text) => speechAnswers.register(reportId, text),
    unregisterSpeech: (reportId, speechId) => { speechAnswers.remove(reportId, speechId); },
    appendNewTopic: (reportId, topic, ownership) => reportGenerator.appendNewTopic(reportId, topic, ownership),
  });

  app.use(express.json());
  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' });
  });
  app.use('/api/dashboard', dashboardRouter(dataset));
  app.use('/api/ai', reportsRouter({
    registry: reportRegistry,
    generator: reportGenerator,
    followUpService: reportFollowUpService,
    ...(options.reportHeartbeatMs === undefined ? {} : { heartbeatMs: options.reportHeartbeatMs }),
  }));
  app.use('/api', (_request, response) => {
    response.status(404).json({ code: 'NOT_FOUND', message: '接口不存在。' });
  });

  if (options.staticDirectory) {
    const staticDirectory = resolve(options.staticDirectory);
    const indexFile = resolve(staticDirectory, 'index.html');
    app.use(express.static(staticDirectory));
    app.use((request, response, next) => {
      if (request.method !== 'GET' || !request.accepts('html')) {
        next();
        return;
      }
      response.sendFile(indexFile, (error) => {
        if (error) next();
      });
    });
  }

  app.use((error: unknown, request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (!request.path.startsWith('/api/')) {
      next(error);
      return;
    }
    response.status(400).json({ code: 'INVALID_REQUEST', message: '请求参数无效，请检查后重试。' });
  });

  return app;
}
