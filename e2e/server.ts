import express from 'express';
import { EventEmitter } from 'node:events';
import { type Server } from 'node:http';
import { resolve } from 'node:path';
import type { AiErrorCode } from '../shared/ai';
import type { BusinessPage } from '../shared/dashboard';
import type {
  FollowUpResponse,
  ReportEvent,
  ReportSlide,
  SlideOutline,
  UpdateReportSessionRequest,
} from '../shared/report';
import { createServer, startLocalServer } from '../server/src/app';
import type { AnalysisMetricKey } from '../server/src/domain/analysis-plan';
import { resolveReportEvidence } from '../server/src/domain/report-evidence-resolver';
import { loadWorkbook } from '../server/src/data/workbook';
import {
  DeepSeekServiceError,
  type DeepSeekCompletionRequest,
} from '../server/src/services/deepseek-client';
import { ReportFollowUpService } from '../server/src/services/report-follow-up';
import { ReportGenerator } from '../server/src/services/report-generator';
import { planReportIntent } from '../server/src/services/report-intent-planner';
import {
  ReportJobRegistry,
  type FollowUpOwnership,
} from '../server/src/services/report-job-registry';
import { planReport } from '../server/src/services/intent-first-report-planner';
import { composeSlide } from '../server/src/services/intent-first-slide-composer';
import { attachVoiceWebSocketGateway } from '../server/src/services/voice/gateway';
import { SpeechAnswerRegistry } from '../server/src/services/voice/speech-answer-registry';

const port = 4173;
const distDirectory = resolve('dist');
const dataset = loadWorkbook(resolve('data/智慧污水处理厂_演示数据.xlsx'));
const providerSettings = {
  apiKey: 'e2e-only-key',
  baseUrl: 'https://provider.invalid/private-e2e',
  model: 'deepseek-v4-flash',
};
const sensitiveMarker = /e2e-only-key|https:\/\/provider\.invalid\/private-e2e|deepseek-v4-flash|E2E_(?:ACCESS_KEY|ACCESS_SECRET|APP_KEY|TOKEN)_MUST_NOT_LEAK|Bearer\s+|智慧污水处理厂_演示数据\.xlsx|(?:^|\s)[A-Za-z]:[\\/]|\/Users\//u;

type HarnessState = {
  providerCallKinds: string[];
  completionCallKinds: Array<'intent-planner' | 'report-planner' | 'slide-composer'>;
  emittedSequences: number[];
  slideAttempts: Record<string, number>;
  slideAttemptOutcomes: Record<string, Array<'failed' | 'ready'>>;
  activeSubscriptions: number;
  followUpOrdinals: number[];
  speechOwnershipChecks: number;
  appliedSessionUpdates: UpdateReportSessionRequest[];
  cleanupCounts: { speech: number; subscriptions: number };
  sensitiveLeakCount: number;
};

type VoiceState = {
  recognitionSessions: number;
  pcmFrames: number;
  synthesisRequests: number;
  speechIds: string[];
  synthesisSessions: Array<{ speechId: string }>;
  segmentIndexes: number[];
  cancellationCount: number;
  sensitiveLeakCount: number;
};

const state: HarnessState = {
  providerCallKinds: [],
  completionCallKinds: [],
  emittedSequences: [],
  slideAttempts: {},
  slideAttemptOutcomes: {},
  activeSubscriptions: 0,
  followUpOrdinals: [],
  speechOwnershipChecks: 0,
  appliedSessionUpdates: [],
  cleanupCounts: { speech: 0, subscriptions: 0 },
  sensitiveLeakCount: 0,
};

const voiceState: VoiceState = {
  recognitionSessions: 0,
  pcmFrames: 0,
  synthesisRequests: 0,
  speechIds: [],
  synthesisSessions: [],
  segmentIndexes: [],
  cancellationCount: 0,
  sensitiveLeakCount: 0,
};

function recordEvent(before: number, reportId: string, registry: ReportJobRegistry): void {
  const after = registry.peekSnapshot(reportId)?.lastSequence ?? before;
  for (let sequence = before + 1; sequence <= after; sequence += 1) {
    state.emittedSequences.push(sequence);
  }
}

class E2eReportRegistry extends ReportJobRegistry {
  readonly reportIds = new Set<string>();

  override create(input: { question: string; originPage: BusinessPage }) {
    const snapshot = super.create(input);
    this.reportIds.add(snapshot.reportId);
    return snapshot;
  }

  override reserveFollowUp(reportId: string, idempotencyKey: string, fingerprint: string, promise: Promise<FollowUpResponse>) {
    const reservation = super.reserveFollowUp(reportId, idempotencyKey, fingerprint, promise);
    if (reservation?.kind === 'started') state.followUpOrdinals.push(reservation.ordinal);
    return reservation;
  }

  override publishOutline(reportId: string, outline: SlideOutline[], ownership?: FollowUpOwnership): boolean {
    const before = this.peekSnapshot(reportId)?.lastSequence ?? 0;
    const published = super.publishOutline(reportId, outline, ownership);
    recordEvent(before, reportId, this);
    return published;
  }

  override markSlideGenerating(reportId: string, slideId: string): boolean {
    const before = this.peekSnapshot(reportId)?.lastSequence ?? 0;
    const published = super.markSlideGenerating(reportId, slideId);
    recordEvent(before, reportId, this);
    return published;
  }

  override publishSlide(reportId: string, slide: ReportSlide): boolean {
    const before = this.peekSnapshot(reportId)?.lastSequence ?? 0;
    const published = super.publishSlide(reportId, slide);
    recordEvent(before, reportId, this);
    return published;
  }

  override markSlideFailed(reportId: string, slideId: string, retryable: boolean): boolean {
    const before = this.peekSnapshot(reportId)?.lastSequence ?? 0;
    const published = super.markSlideFailed(reportId, slideId, retryable);
    recordEvent(before, reportId, this);
    return published;
  }

  override complete(reportId: string, forcedStatus?: 'ready' | 'partial'): boolean {
    const before = this.peekSnapshot(reportId)?.lastSequence ?? 0;
    const published = super.complete(reportId, forcedStatus);
    recordEvent(before, reportId, this);
    return published;
  }

  override fail(reportId: string, code: AiErrorCode): boolean {
    const before = this.peekSnapshot(reportId)?.lastSequence ?? 0;
    const published = super.fail(reportId, code);
    recordEvent(before, reportId, this);
    return published;
  }

  override subscribe(reportId: string, subscriber: (event: ReportEvent) => void): (() => void) | undefined {
    const unsubscribe = super.subscribe(reportId, subscriber);
    if (!unsubscribe) return undefined;
    state.activeSubscriptions += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      unsubscribe();
      state.activeSubscriptions = Math.max(0, state.activeSubscriptions - 1);
      state.cleanupCounts.subscriptions += 1;
    };
  }

  override updateSession(reportId: string, update: UpdateReportSessionRequest): boolean {
    const applied = super.updateSession(reportId, update);
    if (applied) {
      state.appliedSessionUpdates.push({
        ...update,
        ...(update.narrationCursor ? { narrationCursor: { ...update.narrationCursor } } : {}),
      });
    }
    return applied;
  }
}

let nextSpeechId = 0;
let nextSynthesisSegmentIndex = 0;
const pendingSynthesisSpeechIds: string[] = [];
const e2eTokenPrefix = 'E2E_TOKEN_MUST_NOT_LEAK:';

class E2eSpeechAnswerRegistry extends SpeechAnswerRegistry {
  private readonly owners = new Map<string, string>();

  constructor() {
    super({ createId: () => `speech-${++nextSpeechId}` });
  }

  override register(reportId: string, answer: string): string {
    const speechId = super.register(reportId, answer);
    this.owners.set(speechId, reportId);
    return speechId;
  }

  override get(reportId: string, speechId: string): string | undefined {
    state.speechOwnershipChecks += 1;
    voiceState.synthesisRequests += 1;
    voiceState.speechIds.push(speechId);
    nextSynthesisSegmentIndex = 0;
    const answer = this.owners.get(speechId) === reportId ? super.get(reportId, speechId) : undefined;
    if (answer !== undefined) pendingSynthesisSpeechIds.push(speechId);
    return answer;
  }

  override remove(reportId: string, speechId: string): boolean {
    const removed = super.remove(reportId, speechId);
    if (removed) {
      this.owners.delete(speechId);
      state.cleanupCounts.speech += 1;
    }
    return removed;
  }

  override removeReport(reportId: string): void {
    const owned = [...this.owners]
      .filter(([, owner]) => owner === reportId)
      .map(([speechId]) => speechId);
    super.removeReport(reportId);
    for (const speechId of owned) this.owners.delete(speechId);
    state.cleanupCounts.speech += owned.length;
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const workbookDateRange = { from: '2026-07-29', to: '2026-08-09' } as const;

function promptValue(prompt: string, prefix: string, nextPrefix: string): string {
  const start = prompt.indexOf(prefix);
  if (start < 0) return '';
  const valueStart = start + prefix.length;
  const end = prompt.indexOf(`\n${nextPrefix}`, valueStart);
  return prompt.slice(valueStart, end < 0 ? undefined : end);
}

function intentResponse(question: string): unknown {
  if (question === '污水脱氮是什么？') {
    return {
      kind: 'report',
      intents: [{ kind: 'knowledge', questionPart: question, evidencePolicy: 'knowledge' }],
      knowledgeTopics: ['污水脱氮的硝化与反硝化机制'],
      assistantProfile: false,
    };
  }
  if (question === '你是什么模型？') {
    return {
      kind: 'report',
      intents: [{ kind: 'identity', questionPart: question, evidencePolicy: 'knowledge' }],
      knowledgeTopics: [],
      assistantProfile: true,
    };
  }
  if (question === '这个怎么样？') {
    return {
      kind: 'clarification',
      clarification: {
        prompt: '请明确要分析的对象',
        reason: 'ambiguous-subject',
        suggestions: ['分析总氮'],
      },
    };
  }

  const mixed = question === '总氮是什么，目前是否达标？';
  const clarified = question.includes('这个怎么样？') && question.includes('分析总氮');
  const energyRise = question === '为什么最近能耗升高？';
  const retryCase = question === '第二页瞬时失败后恢复' || question === '第二页持续失败';
  const metrics = mixed || clarified
    ? ['tn']
    : energyRise
      ? ['kwhPerM3', 'blowerKwh']
      : retryCase
        ? ['tn', 'blowerKwh']
        : ['tn', 'kwhPerM3', 'blowerKwh', 'carbonSourceKg'];
  const hasWaterQuality = metrics.includes('tn');
  const hasEnergy = metrics.some((metric) => metric !== 'tn');
  return {
    kind: 'report',
    intents: mixed
      ? [
          { kind: 'knowledge', questionPart: '总氮是什么', evidencePolicy: 'knowledge' },
          { kind: 'lookup', questionPart: '目前是否达标', evidencePolicy: 'data' },
        ]
      : [{ kind: energyRise ? 'diagnosis' : 'trend', questionPart: question, evidencePolicy: 'data' }],
    knowledgeTopics: mixed ? ['总氮指标含义'] : [],
    assistantProfile: false,
    analysisPlan: {
      modules: [
        ...(hasWaterQuality ? ['water-quality'] : []),
        ...(hasEnergy ? ['energy'] : []),
      ],
      metrics,
      dateRange: workbookDateRange,
      methods: energyRise ? ['trend', 'comparison', 'summary'] : ['trend', 'summary'],
      includeAlerts: false,
      includeHealthWeights: false,
    },
  };
}

type ModelOutline = Pick<
  SlideOutline,
  'order' | 'title' | 'purpose' | 'role' | 'layout' | 'visualKind' | 'evidenceKeys'
>;

function reportPlanResponse(question: string): { slides: Array<Omit<ModelOutline, 'order'>> } {
  if (question === '污水脱氮是什么？') {
    return { slides: [{
      title: '污水脱氮的核心机制',
      purpose: '解释硝化与反硝化如何去除含氮污染物',
      role: 'knowledge', layout: 'concept-center', visualKind: 'concept-map', evidenceKeys: ['knowledge:0'],
    }] };
  }
  if (question === '你是什么模型？') {
    return { slides: [{
      title: '智慧水务 AI 助手',
      purpose: '说明公开模型身份、能力与边界',
      role: 'answer', layout: 'concept-center', visualKind: 'capability-map', evidenceKeys: ['assistant-profile'],
    }] };
  }
  if (question === '总氮是什么，目前是否达标？') {
    return { slides: [
      {
        title: '总氮含义与现场达标判断',
        purpose: '同时解释总氮含义并核验现场数据',
        role: 'answer', layout: 'dual-evidence', visualKind: 'kpi-grid', evidenceKeys: ['knowledge:0', 'tn'],
      },
      {
        title: '总氮现场证据',
        purpose: '展示同一 Excel 证据快照中的总氮变化',
        role: 'evidence', layout: 'visual-focus', visualKind: 'trend-line', evidenceKeys: ['tn'],
      },
    ] };
  }
  if (question.includes('这个怎么样？') && question.includes('分析总氮')) {
    return { slides: [{
      title: '总氮现场判断',
      purpose: '根据用户澄清核验总氮现场数据',
      role: 'answer', layout: 'visual-focus', visualKind: 'trend-line', evidenceKeys: ['tn'],
    }] };
  }
  if (question === '为什么最近能耗升高？') {
    return { slides: [
      {
        title: '近期能耗升高的联动判断',
        purpose: '判断近期能耗升高是否与鼓风系统同向变化',
        role: 'answer', layout: 'diagnostic-overview', visualKind: 'trend-line', evidenceKeys: ['kwhPerM3', 'blowerKwh'],
      },
      {
        title: '能耗变化的联动证据',
        purpose: '对齐单位水量电耗与鼓风能耗的变化证据',
        role: 'cause', layout: 'dual-evidence', visualKind: 'trend-area', evidenceKeys: ['kwhPerM3', 'blowerKwh'],
      },
    ] };
  }
  if (question === '第二页瞬时失败后恢复' || question === '第二页持续失败') {
    const transient = question === '第二页瞬时失败后恢复';
    return { slides: [
      {
        title: '首屏判断',
        purpose: '首屏在后续页面重试期间保持可用',
        role: 'answer', layout: 'visual-focus', visualKind: 'trend-line', evidenceKeys: ['tn'],
      },
      {
        title: transient ? '第二页自动恢复' : '第二页证据',
        purpose: transient ? '第一次失败后由服务端自动重试并恢复' : '两次自动尝试耗尽后保留首屏',
        role: 'evidence', layout: 'visual-focus', visualKind: 'trend-area', evidenceKeys: ['blowerKwh'],
      },
    ] };
  }
  if (question === '取消正在生成的汇报') {
    return { slides: [{
      title: '取消前的现场判断',
      purpose: '用于验证取消后不发布迟到页面',
      role: 'answer', layout: 'visual-focus', visualKind: 'trend-line', evidenceKeys: ['tn'],
    }] };
  }
  return { slides: [
    {
      title: question === '并发语音文本校验' ? '并发语音能耗校验' : '能耗联动趋势',
      purpose: '核验单位水量电耗与鼓风能耗的同日变化',
      role: 'answer', layout: 'visual-focus', visualKind: 'trend-line', evidenceKeys: ['kwhPerM3', 'blowerKwh'],
    },
    {
      title: question === '并发语音文本校验' ? '并发语音水质校验' : '异常页证据复核',
      purpose: '对齐总氮与碳源投加的日期和样本',
      role: 'evidence', layout: 'visual-focus', visualKind: 'trend-area', evidenceKeys: ['tn', 'carbonSourceKg'],
    },
  ] };
}

function parseComposerOutline(prompt: string): ModelOutline {
  const line = prompt.split('\n').find((candidate) => candidate.startsWith('outline: '));
  if (!line) throw new Error('missing composer outline');
  return JSON.parse(line.slice('outline: '.length)) as ModelOutline;
}

type ComposerEvidence = {
  analysis?: {
    scope: {
      dateRange: { from: string; to: string };
      sampleCount: number;
    };
  };
};

function parseComposerEvidence(prompt: string): ComposerEvidence {
  const line = prompt.split('\n').find((candidate) => candidate.startsWith('referencedEvidence: '));
  if (!line) throw new Error('missing composer evidence');
  return JSON.parse(line.slice('referencedEvidence: '.length)) as ComposerEvidence;
}

function slideDraftResponse(outline: ModelOutline, evidence: ComposerEvidence): unknown {
  const identity = outline.evidenceKeys.length === 1 && outline.evidenceKeys[0] === 'assistant-profile';
  const knowledgeKeys = outline.evidenceKeys.filter((key) => key.startsWith('knowledge:'));
  const onsiteKeys = outline.evidenceKeys.filter((key) => !key.startsWith('knowledge:') && key !== 'assistant-profile');
  const claims = identity
    ? [{
        id: 'identity-claim',
        text: '公开模型名称为 DeepSeek v4-flash。',
        kind: 'knowledge',
        evidenceKeys: ['assistant-profile'],
      }]
    : [
        ...(knowledgeKeys.length ? [{
          id: 'knowledge-claim',
          text: outline.title === '污水脱氮的核心机制'
            ? '污水脱氮通过硝化和反硝化协同完成。'
            : '总氮用于综合反映水中含氮物质水平。',
          kind: 'knowledge',
          evidenceKeys: knowledgeKeys,
        }] : []),
        ...(onsiteKeys.length ? [{
          id: 'onsite-claim',
          text: `${outline.purpose}，结论仅依据同一 Excel 证据快照。`,
          kind: 'onsite-fact',
          evidenceKeys: onsiteKeys,
        }] : []),
      ];
  const claimIds = claims.map(({ id }) => id);
  const scope = evidence.analysis?.scope;
  const reportOpening = outline.order === 0 && onsiteKeys.length > 0 && scope
    ? `本页查看${scope.dateRange.from}至${scope.dateRange.to}的相关指标，共${scope.sampleCount}个样本。`
    : '';
  const takeaway = identity
    ? '公开模型名称为 DeepSeek v4-flash。'
    : knowledgeKeys.length && onsiteKeys.length
      ? '总氮含义与现场达标判断应分别依据模型知识和 Excel 证据。'
      : `${outline.title}已按问题所需证据生成。`;
  return {
    title: outline.title,
    takeaway,
    takeawayClaimIds: claimIds,
    visualKind: outline.visualKind,
    evidenceKeys: outline.evidenceKeys,
    claims,
    narration: identity
      ? [
          { text: '我是智慧水务 AI 助手，公开模型名称是 DeepSeek v4-flash。', claimIds },
          { text: '我可以解释运营知识，并基于受限证据分析现场数据。', claimIds },
        ]
      : [
          { text: `${reportOpening}${outline.title}从问题意图出发展开讲解。`, claimIds },
          {
            text: outline.title.startsWith('并发语音')
              ? '下面说明本页已绑定的指标。'
              : onsiteKeys.length
              ? `${outline.purpose}，下面直接说明相关指标结论。`
              : '本页内容来自模型知识，不声称现场数值。',
            claimIds,
          },
        ],
    ...(identity ? {
      knowledgeItems: [
        { title: '运营知识解释', detail: '解释污水处理与运营管理知识。' },
        { title: '现场数据分析', detail: '现场结论仅基于已提供的受限证据。' },
      ],
    } : outline.visualKind === 'concept-map' ? {
      knowledgeItems: [
        { title: '硝化', detail: '将氨氮逐步转化为硝态氮。' },
        { title: '反硝化', detail: '将硝态氮转化为氮气。' },
      ],
    } : {}),
  };
}

const mockReportCompletion = async ({ prompt }: DeepSeekCompletionRequest): Promise<string> => {
  let stage: HarnessState['completionCallKinds'][number];
  if (prompt.includes('问题意图规划器')) stage = 'intent-planner';
  else if (prompt.includes('动态报告规划器')) stage = 'report-planner';
  else if (prompt.includes('单页报告撰稿器')) stage = 'slide-composer';
  else throw new Error('unexpected report completion prompt');

  state.providerCallKinds.push(stage);
  state.completionCallKinds.push(stage);
  if (sensitiveMarker.test(prompt)) state.sensitiveLeakCount += 1;

  if (stage === 'intent-planner') {
    await pause(20);
    return JSON.stringify(intentResponse(promptValue(prompt, '用户问题：', '来源页面')));
  }
  if (stage === 'report-planner') {
    await pause(35);
    return JSON.stringify(reportPlanResponse(promptValue(prompt, 'question: ', 'originPage:')));
  }

  const outline = parseComposerOutline(prompt);
  const attemptKey = outline.title;
  state.slideAttempts[attemptKey] = (state.slideAttempts[attemptKey] ?? 0) + 1;
  const attempt = state.slideAttempts[attemptKey]!;
  const transientFailure = outline.title === '第二页自动恢复' && attempt === 1;
  const exhaustedFailure = outline.title === '第二页证据';
  if (transientFailure || exhaustedFailure) {
    state.slideAttemptOutcomes[attemptKey] = [
      ...(state.slideAttemptOutcomes[attemptKey] ?? []),
      'failed',
    ];
    throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
  }
  await pause(outline.title.includes('第二页') ? 80 : 55);
  state.slideAttemptOutcomes[attemptKey] = [
    ...(state.slideAttemptOutcomes[attemptKey] ?? []),
    'ready',
  ];
  return JSON.stringify(slideDraftResponse(outline, parseComposerEvidence(prompt)));
};

function followUpQuestion(prompt: string): string {
  const line = prompt.split('\n').find((candidate) => candidate.startsWith('userQuestion: '));
  if (!line) return '';
  try {
    const value: unknown = JSON.parse(line.slice('userQuestion: '.length));
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function followUpContext(prompt: string): { intentCorrections?: Array<{ to?: { kind?: string; key?: string } }> } {
  const line = prompt.split('\n').find((candidate) => candidate.startsWith('followUpContext: '));
  if (!line) return {};
  try {
    const value: unknown = JSON.parse(line.slice('followUpContext: '.length));
    return value && typeof value === 'object' ? value as ReturnType<typeof followUpContext> : {};
  } catch {
    return {};
  }
}

function firstCitedKey(prompt: string): AnalysisMetricKey {
  const question = followUpQuestion(prompt);
  if (question.includes('鼓风')) return 'blowerKwh';
  if (question.includes('碳源')) return 'carbonSourceKg';
  if (question.includes('电耗') || question.includes('能耗')) return 'kwhPerM3';
  const retainedTarget = followUpContext(prompt).intentCorrections?.at(-1)?.to;
  if (retainedTarget?.kind === 'evidence' && retainedTarget.key === 'blowerKwh') return 'blowerKwh';
  return 'tn';
}

const speechAnswers = new E2eSpeechAnswerRegistry();
let nextReportId = 0;
const reportRegistry = new E2eReportRegistry({
  createId: () => `report-e2e-${++nextReportId}`,
  removeSpeechForReport: (reportId) => speechAnswers.removeReport(reportId),
});

const reportGenerator = new ReportGenerator({
  dataset,
  registry: reportRegistry,
  planReportIntent,
  resolveReportEvidence,
  planReport,
  composeSlide,
  registerSpeech: (reportId, text) => speechAnswers.register(reportId, text),
  unregisterSpeech: (reportId, speechId) => { speechAnswers.remove(reportId, speechId); },
}, { settings: providerSettings, requestCompletion: mockReportCompletion });

let nextTurnId = 0;
const reportFollowUpService = new ReportFollowUpService({
  registry: reportRegistry,
  settings: providerSettings,
  requestCompletion: async ({ prompt }) => {
    state.providerCallKinds.push('follow-up');
    if (sensitiveMarker.test(prompt)) state.sensitiveLeakCount += 1;
    await pause(30);
    const key = firstCitedKey(prompt);
    const question = followUpQuestion(prompt);
    return JSON.stringify({
      answer: key === 'blowerKwh'
        ? '已按鼓风机能耗重新对齐当前页证据。'
        : '该结论只引用当前页可核验的工作簿证据。',
      citedEvidenceKeys: [key],
      needsClarification: false,
      ...(question === '我问的是鼓风机，不是总电耗' ? {
        intentCorrection: {
          from: { kind: 'evidence', key: 'totalKwh' },
          to: { kind: 'evidence', key: 'blowerKwh' },
        },
      } : {}),
    });
  },
  registerSpeech: (reportId, text) => speechAnswers.register(reportId, text),
  unregisterSpeech: (reportId, speechId) => { speechAnswers.remove(reportId, speechId); },
  appendNewTopic: (reportId, topic, ownership) => reportGenerator.appendNewTopic(reportId, topic, ownership),
  createTurnId: () => `turn-e2e-${++nextTurnId}`,
  now: () => new Date('2026-08-13T00:00:00.000Z'),
});

let synthesisMode: 'pending-last' | 'complete-all' = 'pending-last';
let synthesisTokenDelayMs = 0;

class E2eRecognitionSdk extends EventEmitter {
  private transcriptSent = false;
  private completed = false;

  defaultStartParams() { return {}; }
  async start() {}

  sendAudio(bytes: Buffer) {
    voiceState.pcmFrames += 1;
    if (sensitiveMarker.test(bytes.toString('utf8'))) voiceState.sensitiveLeakCount += 1;
    if (!this.transcriptSent) {
      this.transcriptSent = true;
      this.emit('changed', JSON.stringify({ payload: { result: '为什么' } }));
    }
    return true;
  }

  async close() {
    if (this.completed) return;
    this.completed = true;
    if (this.transcriptSent) {
      this.emit('end', JSON.stringify({ payload: { index: 0, result: '为什么' } }));
    }
    this.emit('completed', '{}');
  }

  shutdown() {
    if (!this.completed) this.emit('completed', '{}');
    this.completed = true;
  }
}

class E2eSynthesisSdk extends EventEmitter {
  private completed = false;
  private cancelled = false;

  constructor(
    private readonly segmentIndex: number,
    private readonly speechId: string,
  ) { super(); }

  defaultStartParams() { return {}; }

  async start(input: { text?: unknown }) {
    if (typeof input.text === 'string' && sensitiveMarker.test(input.text)) {
      voiceState.sensitiveLeakCount += 1;
    }
    voiceState.synthesisSessions.push({ speechId: this.speechId });
    queueMicrotask(() => {
      if (this.cancelled) return;
      this.emit('data', Buffer.from(`E2E_SPEECH:${this.speechId}`));
      if (this.segmentIndex === 0 || synthesisMode === 'complete-all') {
        this.completed = true;
        this.emit('completed', '{}');
      }
    });
  }

  shutdown() {
    if (!this.completed && !this.cancelled) {
      this.cancelled = true;
      voiceState.cancellationCount += 1;
    }
  }
}

function resetState(): void {
  for (const reportId of reportRegistry.reportIds) reportRegistry.cancel(reportId);
  reportRegistry.reportIds.clear();
  state.providerCallKinds.length = 0;
  state.completionCallKinds.length = 0;
  state.emittedSequences.length = 0;
  state.slideAttempts = {};
  state.slideAttemptOutcomes = {};
  state.activeSubscriptions = 0;
  state.followUpOrdinals.length = 0;
  state.speechOwnershipChecks = 0;
  state.appliedSessionUpdates.length = 0;
  state.cleanupCounts = { speech: 0, subscriptions: 0 };
  state.sensitiveLeakCount = 0;
  voiceState.recognitionSessions = 0;
  voiceState.pcmFrames = 0;
  voiceState.synthesisRequests = 0;
  voiceState.speechIds.length = 0;
  voiceState.synthesisSessions.length = 0;
  voiceState.segmentIndexes.length = 0;
  voiceState.cancellationCount = 0;
  voiceState.sensitiveLeakCount = 0;
  nextSynthesisSegmentIndex = 0;
  pendingSynthesisSpeechIds.length = 0;
  synthesisMode = 'pending-last';
  synthesisTokenDelayMs = 0;
}

function publicState(): HarnessState {
  return {
    providerCallKinds: [...state.providerCallKinds],
    completionCallKinds: [...state.completionCallKinds],
    emittedSequences: [...state.emittedSequences],
    slideAttempts: { ...state.slideAttempts },
    slideAttemptOutcomes: Object.fromEntries(
      Object.entries(state.slideAttemptOutcomes).map(([slideId, outcomes]) => [slideId, [...outcomes]]),
    ),
    activeSubscriptions: state.activeSubscriptions,
    followUpOrdinals: [...state.followUpOrdinals],
    speechOwnershipChecks: state.speechOwnershipChecks,
    appliedSessionUpdates: state.appliedSessionUpdates.map((update) => ({
      ...update,
      ...(update.narrationCursor ? { narrationCursor: { ...update.narrationCursor } } : {}),
    })),
    cleanupCounts: { ...state.cleanupCounts },
    sensitiveLeakCount: state.sensitiveLeakCount + voiceState.sensitiveLeakCount,
  };
}

const app = createServer({
  dataset,
  reportRegistry,
  reportGenerator,
  reportFollowUpService,
  speechAnswerRegistry: speechAnswers,
  reportHeartbeatMs: 100,
});

app.get('/__e2e/report-state', (_request, response) => { response.json(publicState()); });
app.post('/__e2e/report-state', (_request, response) => { response.json(publicState()); });
app.post('/__e2e/voice-state', (_request, response) => {
  response.json({
    ...voiceState,
    speechIds: [...voiceState.speechIds],
    synthesisSessions: voiceState.synthesisSessions.map((session) => ({ ...session })),
    segmentIndexes: [...voiceState.segmentIndexes],
  });
});
app.post('/__e2e/reset', (_request, response) => {
  resetState();
  response.json({ status: 'reset' });
});
app.post('/__e2e/voice-mode', (request, response) => {
  const tokenDelayMs = request.body?.tokenDelayMs ?? 0;
  if (
    request.body?.synthesis !== 'complete-all'
    || !Number.isInteger(tokenDelayMs)
    || tokenDelayMs < 0
    || tokenDelayMs > 100
  ) {
    response.status(400).json({ status: 'invalid-mode' });
    return;
  }
  synthesisMode = 'complete-all';
  synthesisTokenDelayMs = tokenDelayMs;
  response.json({ status: 'configured' });
});

app.use(express.static(distDirectory));
app.use((request, response, next) => {
  if (request.method !== 'GET' || !request.accepts('html')) {
    next();
    return;
  }
  response.sendFile(resolve(distDirectory, 'index.html'), (error) => {
    if (error) next(error);
  });
});
app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  // The E2E server can receive a final navigation after Playwright has begun
  // tearing down its page. Keep that expected static miss local and quiet.
  response.status(404).end();
});

let detachVoiceGateway: () => void = () => undefined;
let listener: Server;
listener = startLocalServer(app, {
  port,
  attachVoiceGateway: (server) => {
    detachVoiceGateway = attachVoiceWebSocketGateway(server, {
      config: {
        success: true,
        data: {
          accessKeyId: 'E2E_ACCESS_KEY_MUST_NOT_LEAK',
          accessKeySecret: 'E2E_ACCESS_SECRET_MUST_NOT_LEAK',
          appKey: 'E2E_APP_KEY_MUST_NOT_LEAK',
          gateway: 'wss://voice.invalid/ws/v1',
          voice: 'e2e-voice',
        },
      },
      speechAnswers,
      reportRegistry,
      tokenManager: {
        getToken: async () => {
          const speechId = pendingSynthesisSpeechIds.shift();
          // The duplicate-text test can hold concurrent requests here after each
          // request has captured its own identity but before either SDK starts.
          if (speechId && synthesisTokenDelayMs > 0) await pause(synthesisTokenDelayMs);
          return {
            value: speechId ? `${e2eTokenPrefix}${speechId}` : 'E2E_TOKEN_MUST_NOT_LEAK',
            expiresAtMs: Number.MAX_SAFE_INTEGER,
          };
        },
      } as never,
      createRecognitionSdk: (() => {
        voiceState.recognitionSessions += 1;
        return new E2eRecognitionSdk();
      }) as never,
      createSynthesisSdk: ((_settings: unknown, token: string) => {
        if (!token.startsWith(e2eTokenPrefix)) throw new Error('missing E2E synthesis token identity');
        const speechId = token.slice(e2eTokenPrefix.length);
        if (!speechId) throw new Error('missing E2E synthesis speech identity');
        const index = nextSynthesisSegmentIndex++;
        voiceState.segmentIndexes.push(index);
        return new E2eSynthesisSdk(index, speechId);
      }) as never,
    });
  },
  log: () => {
    process.stdout.write(`Built Express E2E server: http://127.0.0.1:${port}\n`);
  },
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  reportGenerator.dispose();
  for (const reportId of reportRegistry.reportIds) reportRegistry.cancel(reportId);
  detachVoiceGateway();
  listener.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
