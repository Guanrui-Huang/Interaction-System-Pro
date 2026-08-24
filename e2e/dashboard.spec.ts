import { expect, test, type Locator, type Page, type Route, type TestInfo } from 'playwright/test';
import { ATOMIC_VISUAL_KINDS, type ConversationTurn, type CreateReportResponse, type FollowUpResponse, type ReportEvent, type ReportJobSnapshot, type ReportSlide, type SlideOutline } from '../shared/report';
import type { AnalysisMetricKey } from '../server/src/domain/analysis-plan';
import { createDashboardFixtures, type DashboardFixtures } from './dashboard-fixtures';

const REPORT_ID = 'report-mocked-dynamic';
const DATE_RANGE = { from: '2026-08-01', to: '2026-08-12' };
const dashboardFixtures = createDashboardFixtures();

function dashboardFixtureFor(url: string): DashboardFixtures[keyof DashboardFixtures] {
  const endpoint = new URL(url).pathname.split('/').at(-1);
  if (endpoint === 'overview' || endpoint === 'health' || endpoint === 'water-quality' || endpoint === 'energy') {
    return dashboardFixtures[endpoint];
  }
  throw new Error(`Unexpected dashboard endpoint: ${url}`);
}

function metric(
  key: AnalysisMetricKey,
  label: string,
  unit: string,
  value: number,
) {
  const module: NonNullable<ReportSlide['metrics'][number]['module']> = (() => {
    switch (key) {
      case 'tn':
      case 'ammonia':
      case 'tp':
      case 'cod':
      case 'ss':
        return 'water-quality';
      case 'processedM3':
      case 'informationCount':
      case 'complianceRate':
        return 'overview';
      case 'totalKwh':
      case 'kwhPerM3':
      case 'blowerKwh':
      case 'carbonSourceKg':
      case 'carbonEmissionKg':
      case 'carbonReductionKg':
      case 'savedYuan':
        return 'energy';
      case 'healthScore':
      case 'qualityScore':
      case 'flowScore':
      case 'energyScore':
      case 'carbonSourceScore':
        return 'health';
    }
  })();
  return {
    key,
    kind: 'metric' as const,
    source: 'excel' as const,
    snapshotId: 'snapshot-e2e',
    claimIds: ['claim-e2e'],
    module,
    label,
    unit,
    dateRange: DATE_RANGE,
    sampleCount: 12,
    value,
  };
}

const tn = metric('tn', '总氮', 'mg/L', 2.68);
const blower = metric('blowerKwh', '鼓风能耗', 'kWh/d', 128.4);
const largeScreenMetrics = [
  metric('qualityScore', '出水水质得分', '分', 96),
  metric('energyScore', '电耗得分', '分', 90),
  metric('tn', '总氮（TN）', 'mg/L', 1.96),
  metric('ammonia', '氨氮', 'mg/L', .38),
  metric('tp', '总磷', 'mg/L', .29),
  metric('cod', 'COD', 'mg/L', 22.26),
  metric('ss', '悬浮物', 'mg/L', 6.44),
  metric('carbonEmissionKg', '碳排放', 'kg/d', 184.6),
];
const largeScreenScoreMetrics = largeScreenMetrics.slice(0, 2);
const largeScreenCarbonMetrics = [
  largeScreenMetrics.at(-1)!,
  metric('carbonReductionKg', '碳减排', 'kg/d', 39.2),
];
const largeScreenEvidenceMetrics = [...largeScreenMetrics, largeScreenCarbonMetrics[1]!];
const largeScreenMetricKeys = largeScreenEvidenceMetrics.map(({ key }) => key);

function evidenceRef(value: typeof tn) {
  const { value: _metricValue, claimIds: _claimIds, ...evidence } = value;
  return evidence;
}

function conversationEvidenceRef(value: typeof tn) {
  const { value: _metricValue, claimIds: _claimIds, snapshotId: _snapshotId, ...evidence } = value;
  return evidence;
}

function slide(input: {
  id: string;
  order: number;
  title: string;
  takeaway: string;
  evidence: typeof tn;
}): ReportSlide {
  return {
    id: input.id,
    order: input.order,
    evidenceSnapshotId: 'snapshot-e2e', role: 'answer', layout: 'visual-focus', evidencePolicy: 'data',
    title: input.title,
    takeaway: input.takeaway,
    takeawayClaimIds: ['claim-e2e'],
    claims: [{ id: 'claim-e2e', text: input.takeaway, kind: 'onsite-fact', evidenceRefs: [evidenceRef(input.evidence)] }],
    visual: {
      kind: 'trend-line',
      series: [{
        key: input.evidence.key,
        label: input.evidence.label,
        unit: input.evidence.unit,
        snapshotId: 'snapshot-e2e', claimIds: ['claim-e2e'],
        points: [
          { label: DATE_RANGE.from, value: input.evidence.value - 0.12 },
          { label: DATE_RANGE.to, value: input.evidence.value },
        ],
      }],
    },
    metrics: [input.evidence],
    evidenceRefs: [evidenceRef(input.evidence)],
    narration: [
      { id: `${input.id}-segment-1`, text: `${input.title}第一段讲解。`, speechId: `${input.id}-speech-1`, claimIds: ['claim-e2e'] },
      { id: `${input.id}-segment-2`, text: `${input.title}第二段讲解。`, speechId: `${input.id}-speech-2`, claimIds: ['claim-e2e'] },
    ],
  };
}

const firstSlide = slide({
  id: 'first-evidence',
  order: 0,
  title: '总氮趋势证据',
  takeaway: '总氮证据已完成快速核验',
  evidence: tn,
});
const energySlide: ReportSlide = {
  id: 'energy-trend',
  order: 1,
  evidenceSnapshotId: 'snapshot-e2e',
  role: 'answer',
  layout: 'visual-focus',
  evidencePolicy: 'data',
  title: '季度水质与能效综合概览',
  takeaway: '八项水质、能效与碳指标已在同一张复合数据看板中完成展示。',
  takeawayClaimIds: ['claim-e2e'],
  claims: [{
    id: 'claim-e2e',
    text: '八项水质、能效与碳指标已在同一证据范围内完成汇总展示。',
    kind: 'onsite-fact',
    evidenceRefs: largeScreenEvidenceMetrics.map((item) => evidenceRef(item)),
  }],
  visual: {
    kind: 'data-dashboard',
    summaryMetrics: largeScreenMetrics,
    primary: {
      kind: 'trend-area',
      series: largeScreenScoreMetrics.map((item, index) => ({
        key: item.key,
        label: item.label,
        unit: item.unit ?? '分',
        snapshotId: item.snapshotId,
        claimIds: item.claimIds,
        points: [
          { label: DATE_RANGE.from, value: item.value - index - 1 },
          { label: '2026-08-06', value: item.value - index / 2 },
          { label: DATE_RANGE.to, value: item.value },
        ],
      })),
    },
    supporting: [
      { kind: 'comparison-bars', items: largeScreenScoreMetrics },
      { kind: 'comparison-bars', items: largeScreenCarbonMetrics },
    ],
  },
  metrics: [...largeScreenEvidenceMetrics],
  evidenceRefs: largeScreenEvidenceMetrics.map((item) => evidenceRef(item)),
  narration: [
    { id: 'energy-trend-segment-1', text: '先看八项摘要指标的最新得分、水质读数与碳指标。', speechId: 'energy-trend-speech-1', claimIds: ['claim-e2e'] },
    { id: 'energy-trend-segment-2', text: '再对比两项主趋势与得分、碳指标辅助条形图的联动关系。', speechId: 'energy-trend-speech-2', claimIds: ['claim-e2e'] },
  ],
};

function outlineVisualKind(slide: ReportSlide): SlideOutline['visualKind'] {
  const kind = slide.visual.kind === 'data-dashboard' ? slide.visual.primary.kind : slide.visual.kind;
  if (!ATOMIC_VISUAL_KINDS.includes(kind)) {
    throw new Error(`Unexpected rendered outline visual kind: ${kind}`);
  }
  return kind;
}

const firstOutline: SlideOutline = {
  id: firstSlide.id,
  order: 0,
  title: firstSlide.title,
  purpose: firstSlide.takeaway,
  role: firstSlide.role, layout: firstSlide.layout, evidencePolicy: firstSlide.evidencePolicy,
  visualKind: outlineVisualKind(firstSlide),
  evidenceKeys: ['tn'],
  status: 'planned',
};
const dynamicOutline: SlideOutline[] = [
  firstOutline,
  {
    id: energySlide.id,
    order: 1,
    title: energySlide.title,
    purpose: energySlide.takeaway,
    role: energySlide.role, layout: energySlide.layout, evidencePolicy: energySlide.evidencePolicy,
    visualKind: outlineVisualKind(energySlide),
    evidenceKeys: largeScreenMetricKeys,
    status: 'planned',
  },
  {
    id: 'anomaly-evidence',
    order: 2,
    title: '异常页证据复核',
    purpose: '等待可核验数据',
    role: 'evidence', layout: 'diagnostic-overview', evidencePolicy: 'data',
    visualKind: 'trend-area',
    evidenceKeys: ['tn'],
    status: 'planned',
  },
];

const knowledgeRef = {
  key: 'knowledge:0', kind: 'knowledge' as const, source: 'model-knowledge' as const,
  snapshotId: 'snapshot-e2e', label: '污水处理知识',
};
const profileRef = {
  key: 'assistant-profile', kind: 'knowledge' as const, source: 'assistant-profile' as const,
  snapshotId: 'snapshot-e2e', label: '智慧水务 AI 助手',
};

function knowledgeSlide(input: { id: string; order: number; title: string; takeaway: string }): ReportSlide {
  const claimId = `${input.id}-claim`;
  return {
    ...input,
    evidenceSnapshotId: 'snapshot-e2e', role: 'answer', layout: 'concept-center', evidencePolicy: 'knowledge',
    takeawayClaimIds: [claimId],
    claims: [{ id: claimId, text: input.takeaway, kind: 'knowledge', evidenceRefs: [knowledgeRef] }],
    visual: {
      kind: 'concept-map',
      nodes: [
        { id: `${input.id}-node-1`, title: '含氮物转化', claimIds: [claimId] },
        { id: `${input.id}-node-2`, title: '氮气释放', claimIds: [claimId] },
      ],
      edges: [{ from: `${input.id}-node-1`, to: `${input.id}-node-2`, label: '生物脱氮', claimIds: [claimId] }],
    },
    metrics: [], evidenceRefs: [knowledgeRef],
    narration: [
      { id: `${input.id}-segment-1`, text: '先说明核心机制。', speechId: `${input.id}-speech-1`, claimIds: [claimId] },
      { id: `${input.id}-segment-2`, text: '再说明应用边界。', speechId: `${input.id}-speech-2`, claimIds: [claimId] },
    ],
  };
}

function identityReportSlide(): ReportSlide {
  const claimId = 'identity-claim';
  return {
    id: 'identity-page', order: 0, evidenceSnapshotId: 'snapshot-e2e', role: 'answer',
    layout: 'concept-center', evidencePolicy: 'knowledge', title: '智慧水务 AI 助手',
    takeaway: '当前助手由 DeepSeek v4-flash 提供模型能力。', takeawayClaimIds: [claimId],
    claims: [{ id: claimId, text: '公开模型名称为 DeepSeek v4-flash。', kind: 'knowledge', evidenceRefs: [profileRef] }],
    visual: { kind: 'capability-map', items: [{ id: 'identity-capability', title: '数据分析与讲解', detail: '现场结论仅使用受限证据。', claimIds: [claimId] }] },
    metrics: [], evidenceRefs: [profileRef],
    narration: [
      { id: 'identity-segment-1', text: '我是智慧水务 AI 助手。', speechId: 'identity-speech-1', claimIds: [claimId] },
      { id: 'identity-segment-2', text: '公开模型名称是 DeepSeek v4-flash。', speechId: 'identity-speech-2', claimIds: [claimId] },
    ],
  };
}

function mixedReportSlide(): ReportSlide {
  const onsiteClaim = 'mixed-onsite';
  const knowledgeClaim = 'mixed-knowledge';
  return {
    id: 'mixed-answer', order: 0, evidenceSnapshotId: 'snapshot-e2e', role: 'answer',
    layout: 'dual-evidence', evidencePolicy: 'mixed', title: '总氮含义与现场达标判断',
    takeaway: '总氮反映含氮污染物总量；现场最新值 2.68 mg/L，按 3 mg/L 阈值判断为达标。',
    takeawayClaimIds: [knowledgeClaim, onsiteClaim],
    claims: [
      { id: knowledgeClaim, text: '总氮用于描述水中含氮污染物总量。', kind: 'knowledge', evidenceRefs: [knowledgeRef] },
      { id: onsiteClaim, text: '现场最新值 2.68 mg/L，阈值为 3 mg/L。', kind: 'onsite-fact', evidenceRefs: [evidenceRef(tn)] },
    ],
    visual: { kind: 'kpi-grid', metrics: [{ ...tn, claimIds: [onsiteClaim] }] },
    metrics: [{ ...tn, claimIds: [onsiteClaim] }], evidenceRefs: [knowledgeRef, evidenceRef(tn)],
    narration: [
      { id: 'mixed-segment-1', text: '先解释总氮含义。', speechId: 'mixed-speech-1', claimIds: [knowledgeClaim] },
      { id: 'mixed-segment-2', text: '再核验现场达标状态。', speechId: 'mixed-speech-2', claimIds: [onsiteClaim] },
    ],
  };
}

function outlineFor(slide: ReportSlide, evidenceKeys = slide.evidenceRefs.map(({ key }) => key)): SlideOutline {
  return {
    id: slide.id, order: slide.order, title: slide.title, purpose: slide.takeaway,
    role: slide.role, layout: slide.layout, evidencePolicy: slide.evidencePolicy,
    visualKind: outlineVisualKind(slide), evidenceKeys, status: 'planned',
  };
}

type MockReportScenario = {
  question: string;
  outline: SlideOutline[];
  slides: ReportSlide[];
  failure?: { slideId: string; retryable: boolean };
  clarification?: { clarificationId: string; prompt: string; reason: 'ambiguous-subject'; suggestions: string[] };
};

function scenarioFor(question: string, clarificationAnswered = false): MockReportScenario {
  if (question === '为什么最近能耗升高？') {
    const slides = [
      slide({ id: 'energy-answer', order: 0, title: '近期能耗变化的主要判断', takeaway: '鼓风能耗是近期上升的重要现场信号。', evidence: blower }),
      slide({ id: 'energy-evidence', order: 1, title: '能耗证据拆解', takeaway: '按同一数据范围拆解设备能耗。', evidence: blower }),
      slide({ id: 'energy-action', order: 2, title: '运行优化建议', takeaway: '优先核查鼓风机运行策略。', evidence: blower }),
    ];
    return { question, slides, outline: slides.map((item) => outlineFor(item)) };
  }
  if (question === '污水脱氮是什么？') {
    const slides = [knowledgeSlide({ id: 'denitrification', order: 0, title: '污水脱氮的核心机制', takeaway: '脱氮通过硝化与反硝化把含氮物转化为氮气。' })];
    return { question, slides, outline: slides.map((item) => outlineFor(item)) };
  }
  if (question === '总氮是什么，目前是否达标？') {
    const slides = [
      mixedReportSlide(),
      slide({ id: 'mixed-evidence', order: 1, title: '总氮现场证据', takeaway: '现场总氮数据来自 Excel 证据快照。', evidence: tn }),
    ];
    return { question, slides, outline: slides.map((item) => outlineFor(item)) };
  }
  if (question === '你是什么模型？') {
    const slides = [identityReportSlide()];
    return { question, slides, outline: slides.map((item) => outlineFor(item)) };
  }
  if (question === '这个怎么样？' && !clarificationAnswered) {
    return {
      question, slides: [], outline: [],
      clarification: { clarificationId: 'clarification-e2e', prompt: '请明确要分析的对象', reason: 'ambiguous-subject', suggestions: ['分析总氮'] },
    };
  }
  if (question === '这个怎么样？' && clarificationAnswered) {
    const slides = [slide({ id: 'clarified-tn', order: 0, title: '总氮现场判断', takeaway: '总氮现场数据已完成核验。', evidence: tn })];
    return { question, slides, outline: slides.map((item) => outlineFor(item)) };
  }
  if (question === '第二页瞬时失败后恢复') {
    const slides = [
      slide({ id: 'transient-first', order: 0, title: '首屏判断', takeaway: '首屏先保持可用。', evidence: tn }),
      slide({ id: 'transient-second', order: 1, title: '第二页自动恢复', takeaway: '第二次自动尝试后生成成功。', evidence: blower }),
    ];
    return { question, slides, outline: slides.map((item) => outlineFor(item)) };
  }
  if (question === '首屏综合看板') {
    const firstDashboardSlide: ReportSlide = {
      ...energySlide,
      id: 'first-dashboard',
      order: 0,
      title: '首屏综合看板',
    };
    return { question, slides: [firstDashboardSlide], outline: [outlineFor(firstDashboardSlide)] };
  }
  if (question === '第二页持续失败') {
    const first = slide({ id: 'exhausted-first', order: 0, title: '首屏判断', takeaway: '首屏在后续失败时仍可用。', evidence: tn });
    const second = slide({ id: 'exhausted-second', order: 1, title: '第二页证据', takeaway: '等待手动重试。', evidence: blower });
    return {
      question, slides: [first, second], outline: [outlineFor(first), outlineFor(second)],
      failure: { slideId: second.id, retryable: true },
    };
  }
  return { question, slides: [firstSlide, energySlide], outline: dynamicOutline, failure: { slideId: 'anomaly-evidence', retryable: true } };
}

function snapshot(overrides: Partial<ReportJobSnapshot> = {}): ReportJobSnapshot {
  return {
    reportId: REPORT_ID,
    question: '联合分析总氮与鼓风能耗',
    originPage: 'overview',
    scope: {
      modules: ['water-quality', 'energy'],
      metrics: ['tn', 'blowerKwh'],
      dateRange: DATE_RANGE,
      sampleCount: 12,
      granularity: 'daily',
    },
    status: 'generating',
    phase: 'understanding',
    clarification: null,
    outline: [],
    slides: [],
    conversation: {
      originalQuestion: '联合分析总氮与鼓风能耗',
      turns: [],
      compactSummary: '',
    },
    createdAt: '2026-08-13T00:00:00.000Z',
    expiresAt: '2026-08-13T00:30:00.000Z',
    lastSequence: 0,
    ...overrides,
  };
}

function sse(events: ReportEvent[]): string {
  return events.map((event) => `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function installBrowserAudioFake(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeSource {
      buffer: AudioBuffer | null = null;
      onended: (() => void) | null = null;
      connect() { return this; }
      disconnect() {}
      start() {}
      stop() {}
    }
    class FakeAudioContext {
      state: AudioContextState = 'running';
      readonly destination = {} as AudioDestinationNode;
      readonly sampleRate = 48_000;
      currentTime = 0;
      async resume() { this.state = 'running'; }
      async suspend() { this.state = 'suspended'; }
      async close() { this.state = 'closed'; }
      async decodeAudioData() { return { duration: 0.18 } as AudioBuffer; }
      createBufferSource() { return new FakeSource() as unknown as AudioBufferSourceNode; }
      createGain() { return { gain: { value: 1 }, connect() { return this; }, disconnect() {} } as unknown as GainNode; }
    }
    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = FakeWebSocket.CONNECTING;
      binaryType: BinaryType = 'blob';
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(_url: string) {
        setTimeout(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.(new Event('open')); }, 0);
      }
      send(data: string) {
        const request = JSON.parse(data) as { type: string };
        if (request.type !== 'synthesize') return;
        setTimeout(() => {
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'ready', segmentCount: 1 }) }));
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'segment-start', index: 0 }) }));
          this.onmessage?.(new MessageEvent('message', { data: Uint8Array.from([73, 68, 51]).buffer }));
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'segment-end', index: 0 }) }));
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'completed' }) }));
        }, 0);
      }
      close() { this.readyState = FakeWebSocket.CLOSED; }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeWebSocket });
  });
}

async function installMockReportApi(page: Page) {
  const createGate = deferred();
  const terminalGate = deferred();
  const terminalStreamReady = deferred();
  const sessionBodies: unknown[] = [];
  const retrySlideIds: string[] = [];
  const followUpRequests: Array<{ body: unknown; idempotencyKey?: string }> = [];
  const turns: ConversationTurn[] = [];
  let createRequests = 0;
  let cancelRequests = 0;
  let terminalReleased = false;
  let clarificationAnswered = false;
  let selected = scenarioFor('联合分析总氮与鼓风能耗');
  const slideAttempts: Record<string, number> = {};
  const slideAttemptOutcomes: Record<string, Array<'failed' | 'ready'>> = {};
  let cachedTerminalEvents: ReportEvent[] | undefined;

  const scopeFor = (scenario: MockReportScenario): ReportJobSnapshot['scope'] => {
    const excelRefs = scenario.slides.flatMap(({ evidenceRefs }) => evidenceRefs).filter(({ source }) => source === 'excel');
    if (excelRefs.length === 0) {
      return { modules: [], metrics: [], dateRange: { from: '1970-01-01', to: '1970-01-01' }, sampleCount: 0, granularity: 'daily' };
    }
    return snapshot().scope;
  };

  const currentSnapshot = (overrides: Partial<ReportJobSnapshot> = {}) => snapshot({
    question: selected.question,
    scope: scopeFor(selected),
    conversation: { ...snapshot().conversation, originalQuestion: selected.question },
    ...overrides,
  });

  const terminalEvents = (): ReportEvent[] => {
    if (cachedTerminalEvents) return cachedTerminalEvents;
    let sequence = 4;
    const events: ReportEvent[] = [];
    const attempt = (item: Pick<SlideOutline, 'id' | 'order'>): boolean => {
      const outcomes = slideAttemptOutcomes[item.id] ?? [];
      const transientSecond = selected.question === '第二页瞬时失败后恢复' && item.order === 1;
      const exhausted = selected.failure?.slideId === item.id;
      const maximumAttempts = transientSecond || exhausted ? 2 : 1;
      for (let number = 1; number <= maximumAttempts; number += 1) {
        slideAttempts[item.id] = (slideAttempts[item.id] ?? 0) + 1;
        const failed = exhausted || (transientSecond && number === 1);
        outcomes.push(failed ? 'failed' : 'ready');
        if (!failed) {
          slideAttemptOutcomes[item.id] = outcomes;
          return true;
        }
      }
      slideAttemptOutcomes[item.id] = outcomes;
      return false;
    };
    selected.slides.forEach((item, index) => {
      if (index > 0) events.push({ type: 'slide.generating', sequence: sequence++, slideId: item.id, order: item.order });
      if (!attempt(item)) {
        events.push({ type: 'slide.failed', sequence: sequence++, slideId: item.id, retryable: selected.failure?.retryable ?? false });
      } else {
        events.push({ type: 'slide.ready', sequence: sequence++, slide: item });
      }
    });
    const failedOutline = selected.failure
      ? selected.outline.find(({ id }) => id === selected.failure?.slideId)
      : undefined;
    if (failedOutline && !selected.slides.some(({ id }) => id === failedOutline.id)) {
      events.push({ type: 'slide.generating', sequence: sequence++, slideId: failedOutline.id, order: failedOutline.order });
      attempt(failedOutline);
      events.push({ type: 'slide.failed', sequence: sequence++, slideId: failedOutline.id, retryable: selected.failure!.retryable });
    }
    events.push({ type: 'report.completed', sequence: sequence, status: selected.failure ? 'partial' : 'ready' });
    cachedTerminalEvents = events;
    return cachedTerminalEvents;
  };

  await page.route('**/api/dashboard/**', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(dashboardFixtureFor(route.request().url())) });
  });
  await page.route('**/api/ai/reports**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === 'POST' && path === '/api/ai/reports') {
      createRequests += 1;
      const question = String((request.postDataJSON() as { question?: unknown }).question ?? '');
      selected = scenarioFor(question);
      cachedTerminalEvents = undefined;
      await createGate.promise;
      const body: CreateReportResponse = { reportId: REPORT_ID, snapshot: currentSnapshot() };
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(body) });
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/events')) {
      const after = Number(request.headers()['last-event-id'] ?? 0);
      if (selected.clarification && !clarificationAnswered) {
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: after <= 0 ? sse([
          { type: 'report.clarification-required', sequence: 1, clarification: selected.clarification },
        ]) : '' });
        return;
      }
      if (selected.question === '这个怎么样？' && clarificationAnswered && after <= 1) {
        selected = scenarioFor(selected.question, true);
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse([
          { type: 'report.state-changed', sequence: 2, status: 'generating', phase: 'understanding', clarification: null },
          { type: 'report.outline', sequence: 3, outline: selected.outline },
          { type: 'slide.generating', sequence: 4, slideId: selected.slides[0]!.id, order: 0 },
          { type: 'slide.ready', sequence: 5, slide: selected.slides[0]! },
          { type: 'report.completed', sequence: 6, status: 'ready' },
        ]) });
        return;
      }
      if (after <= 0) {
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse([
          { type: 'report.state-changed', sequence: 1, status: 'generating', phase: selected.slides.some(({ evidencePolicy }) => evidencePolicy !== 'knowledge') ? 'retrieving-evidence' : 'planning', clarification: null },
          { type: 'report.outline', sequence: 2, outline: selected.outline },
          { type: 'slide.generating', sequence: 3, slideId: selected.slides[0]!.id, order: 0 },
        ]) });
      } else if (after <= 3) {
        terminalStreamReady.resolve();
        await terminalGate.promise;
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(terminalEvents()) });
      } else {
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
      }
      return;
    }
    if (request.method() === 'PATCH' && path.endsWith('/session')) {
      sessionBodies.push(request.postDataJSON());
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/retries')) {
      retrySlideIds.push(path.split('/').at(-2)!);
      await route.fulfill({ status: 202, body: '' });
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/clarifications')) {
      clarificationAnswered = true;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/follow-ups')) {
      followUpRequests.push({
        body: request.postDataJSON(),
        idempotencyKey: request.headers()['idempotency-key'],
      });
      const turn: ConversationTurn = {
        id: `turn-${turns.length + 1}`,
        question: request.postDataJSON().question,
        answer: '只引用当前页可核验的证据。',
        citedEvidence: [conversationEvidenceRef(largeScreenMetrics[0]!)],
        needsClarification: false,
        createdAt: '2026-08-13T00:01:00.000Z',
      };
      turns.push(turn);
      const response: FollowUpResponse = {
        turnId: turn.id,
        answer: turn.answer,
        speechId: `answer-speech-${turns.length}`,
        citedEvidence: turn.citedEvidence,
        needsClarification: false,
        resumeCursor: { slideId: energySlide.id, segmentId: 'energy-trend-segment-1', offsetMs: 0 },
      };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
      return;
    }
    if (request.method() === 'GET' && path === `/api/ai/reports/${REPORT_ID}`) {
      if (selected.clarification && !clarificationAnswered) {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(currentSnapshot({
          status: 'awaiting-clarification', phase: null, clarification: selected.clarification, lastSequence: 1,
        })) });
        return;
      }
      if (!terminalReleased) {
        const first = selected.slides[0];
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(currentSnapshot({
            phase: selected.slides.some(({ evidencePolicy }) => evidencePolicy !== 'knowledge') ? 'retrieving-evidence' : 'planning',
            outline: selected.outline.map((item) => item.id === first?.id
              ? { ...item, status: 'generating' as const }
              : item),
            lastSequence: 3,
          })),
        });
        return;
      }
      const readySlides = selected.slides.filter(({ id }) => selected.failure?.slideId !== id);
      const finalOutline = selected.outline.map((item) => selected.failure?.slideId === item.id
        ? { ...item, status: 'failed' as const, retryable: selected.failure.retryable }
        : { ...item, status: 'ready' as const });
      const lastSequence = terminalEvents().at(-1)?.sequence ?? 0;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(currentSnapshot({
          status: selected.failure ? 'partial' : 'ready',
          phase: 'completed',
          outline: finalOutline,
          slides: readySlides,
          conversation: { ...currentSnapshot().conversation, turns, activeSlideId: readySlides.at(-1)?.id },
          lastSequence,
        })),
      });
      return;
    }
    if (request.method() === 'DELETE' && path === `/api/ai/reports/${REPORT_ID}`) {
      cancelRequests += 1;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.abort('failed');
  });
  return {
    createGate,
    terminalStreamReady: terminalStreamReady.promise,
    releaseTerminal() {
      terminalReleased = true;
      terminalGate.resolve();
    },
    sessionBodies,
    retrySlideIds,
    followUpRequests,
    slideAttempts,
    slideAttemptOutcomes,
    get createRequests() { return createRequests; },
    get cancelRequests() { return cancelRequests; },
  };
}

async function launchReport(page: Page): Promise<void> {
  await launchQuestion(page, '联合分析总氮与鼓风能耗');
}

async function launchQuestion(page: Page, question: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '进入智慧中枢' }).click();
  await page.getByRole('button', { name: '唤起 AI 运营助手' }).click();
  await page.getByLabel('请输入需要分析的问题').fill(question);
  await page.getByRole('button', { name: '生成动态汇报' }).click();
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
}

type StableBox = { x: number; y: number; width: number; height: number };

async function stableBox(locator: Locator): Promise<StableBox> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x, y: box!.y, width: box!.width, height: box!.height };
}

function expectStableBox(actual: StableBox, expected: StableBox, tolerance = 2): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(tolerance);
}

test('keeps eight metrics and auxiliary labels readable at 1920x1080', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installBrowserAudioFake(page);
  const api = await installMockReportApi(page);

  await launchReport(page);
  await expect(page.getByRole('main', { name: 'AI 动态汇报工作区' })).toBeVisible();
  await expect(page.getByRole('region', { name: '汇报对话区' })).toContainText('正在创建动态汇报');
  expect(api.createRequests).toBe(1);

  api.createGate.resolve();
  await expect(page).toHaveURL(new RegExp(`reportId=${REPORT_ID}`));
  await api.terminalStreamReady;
  await expect(page.getByRole('main', { name: 'AI 动态汇报工作区' })).toBeVisible();
  const rail = page.getByRole('navigation', { name: '汇报页面' });
  await expect(page.locator('[data-slide-state="pending"][data-slide-mode="canvas"]')).toBeVisible();
  await expect(rail.locator('[data-slide-state="pending"][data-slide-mode="thumbnail"]').first()).toBeVisible();
  await expect(rail.locator('[data-slide-state="pending"][data-slide-mode="thumbnail"]')).toHaveCount(3);
  await expect(page.getByText('正在生成首个页面', { exact: true })).toHaveCount(0);
  await expect(page.getByText('等待生成', { exact: true })).toHaveCount(0);
  await expect(page.getByText('生成中', { exact: true })).toHaveCount(0);

  api.releaseTerminal();
  const activeCanvas = page.locator('[data-slide-mode="canvas"]:not([data-slide-state="pending"])');
  await expect(activeCanvas).toBeVisible();
  await expect(activeCanvas.locator('[data-reveal-visible="false"]')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByRole('heading', { name: firstSlide.title })).toBeVisible();
  await expect(rail.locator('.report-thumbnail')).toHaveCount(3);
  await expect(rail.locator('[data-slide-mode="thumbnail"]:not([data-slide-state="pending"])')).toHaveCount(2);
  await expect(rail.locator(`[data-slide-mode="thumbnail"][data-slide-state="pending"][data-slide-id="${dynamicOutline[2]!.id}"]`)).toHaveCount(1);
  await expect(page.getByRole('button', { name: '第 3 页，异常页证据复核，生成失败' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '重试第 3 页' })).toBeVisible();
  await page.getByRole('button', { name: '重试第 3 页' }).click();
  expect(api.retrySlideIds).toEqual(['anomaly-evidence']);

  const energyThumbnail = page.locator(`[data-slide-mode="thumbnail"][data-slide-id="${energySlide.id}"]`);
  const energyItem = energyThumbnail.locator('xpath=ancestor::li[contains(@class, "report-thumbnail")]');
  const sequenceBox = await energyItem.locator('.report-thumbnail__sequence').boundingBox();
  expect(sequenceBox).not.toBeNull();
  await page.mouse.click(sequenceBox!.x + sequenceBox!.width / 2, sequenceBox!.y + sequenceBox!.height / 2);
  const canvas = page.locator(`[data-slide-mode="canvas"][data-slide-id="${energySlide.id}"]`);
  const dashboard = canvas.locator('.report-data-dashboard');
  await expect(canvas).toContainText(energySlide.title);
  await expect(energyThumbnail).toContainText(energySlide.title);
  await expect(page.getByRole('status').filter({ hasText: '正在讲解第 2 页' })).toBeVisible();

  const summaryMetrics = canvas.locator('.report-data-dashboard__metric');
  await expect(summaryMetrics).toHaveCount(8);
  for (const item of largeScreenMetrics) {
    const metricCard = summaryMetrics.filter({ hasText: item.label });
    await expect(metricCard).toHaveCount(1);
    await expect(metricCard).toContainText(String(item.value));
    await expect(metricCard).toContainText(item.unit);
  }
  await expect(dashboard).toHaveAttribute('data-summary-columns', '8');
  await expect(dashboard).toHaveAttribute('data-summary-rows', '1');
  await expect(canvas.locator('[data-panel-kind="trend-area"] .report-chart__point[data-terminal-point="true"]')).toHaveCount(2);
  await expect(canvas.locator('[data-icon-kind="metric"]')).toHaveCount(8);
  await expect(canvas.locator('[data-panel-kind="trend-area"] .report-visual-icon')).toHaveCount(1);
  await expect(canvas.locator('[data-panel-kind="comparison-bars"] .report-visual-icon')).toHaveCount(2);
  await expect(page.locator('.report-conversation__role')).toHaveCount(0);

  const supportKinds = await canvas.locator('.report-data-dashboard__support > section')
    .evaluateAll((panels) => panels.map((panel) => panel.getAttribute('data-panel-kind')));
  expect(supportKinds).toEqual(['comparison-bars', 'comparison-bars']);

  await page.getByLabel('输入追问').fill('这个数怎么算');
  await expect.poll(() => api.sessionBodies).toContainEqual({
    activity: 'narration',
    narrationCursor: {
      slideId: energySlide.id,
      segmentId: 'energy-trend-segment-1',
      offsetMs: expect.any(Number),
    },
  });
  await page.getByRole('button', { name: '发送追问' }).click();
  await expect.poll(() => api.followUpRequests.length).toBe(1);
  await expect(page.getByRole('list', { name: '追问记录' })).toContainText('只引用当前页可核验的证据');

  const geometry = await page.locator('.report-workspace').evaluate((workspace) => {
    const selectors = [
      '.report-header',
      '.report-thumbnail-rail',
      '.report-workspace__canvas',
      '.report-subtitle-bar',
      '.report-workspace__chat',
    ];
    const regions = Object.fromEntries(selectors.map((selector) => {
      const element = workspace.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing geometry region: ${selector}`);
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return [selector, {
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        left: box.left,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        aspectRatio: style.aspectRatio,
      }];
    }));
    return {
      regions,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geometry.regions['.report-workspace__canvas']!.aspectRatio).not.toBe('16 / 9');
  expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
  for (const region of Object.values(geometry.regions)) {
    expect(region.top).toBeGreaterThanOrEqual(-1);
    expect(region.left).toBeGreaterThanOrEqual(-1);
    expect(region.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(region.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    expect(region.bottom).toBeGreaterThan(0);
  }

  const reportGeometry = await canvas.evaluate((slide) => {
    const canvasRoot = slide.closest<HTMLElement>('.report-workspace__canvas')!;
    const subtitleBar = document.querySelector<HTMLElement>('.report-subtitle-bar')!;
    const subtitleText = subtitleBar.querySelector<HTMLElement>('.report-subtitle-bar__text')!;
    const evidenceDrawer = slide.querySelector<HTMLElement>('.report-evidence-drawer')!;
    const slideBox = slide.getBoundingClientRect();
    const canvasBox = canvasRoot.getBoundingClientRect();
    const subtitleBox = subtitleBar.getBoundingClientRect();
    const evidenceBox = evidenceDrawer.getBoundingClientRect();
    const subtitleRange = document.createRange();
    subtitleRange.selectNodeContents(subtitleText);
    const subtitleLineTops = new Set([...subtitleRange.getClientRects()].map((rect) => Math.round(rect.top)));
    const box = (element: Element | null, label: string) => {
      if (!element) throw new Error(`Missing ${label}`);
      const rect = element.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
    };
    const metricCardBounds = [...slide.querySelectorAll<HTMLElement>('.report-data-dashboard__metric')]
      .map((card) => box(card, 'metric card'));
    const barCharts = [...slide.querySelectorAll<HTMLElement>('[data-panel-kind="comparison-bars"] .report-chart--bars')]
      .map((chart) => box(chart, 'bar chart'));
    const barThemes = [...slide.querySelectorAll<HTMLElement>('.report-chart__bar[data-bar-theme]')]
      .map((bar) => bar.dataset.barTheme ?? '');
    const barValue = slide.querySelector<SVGTextElement>('.report-chart--bars .report-chart__value')!;
    const barAxisLabel = slide.querySelector<SVGTextElement>('.report-chart--bars .report-chart__axis-label')!;
    const barAxisLabelBounds = [...slide.querySelectorAll<SVGTextElement>('.report-chart--bars .report-chart__axis-label')]
      .map((label) => box(label, 'bar axis label'));
    const evidenceButton = slide.querySelector<HTMLElement>('.report-evidence-drawer > button')!;
    const metricLabel = slide.querySelector<HTMLElement>('.report-data-dashboard__metric dt')!;
    const metricValue = slide.querySelector<HTMLElement>('.report-data-dashboard__metric strong')!;
    const title = slide.querySelector<HTMLElement>('h2')!;
    const titleRange = document.createRange();
    titleRange.selectNodeContents(title);
    const titleLines = [...titleRange.getClientRects()];
    const titleLineTops = new Set(titleLines.map((rect) => Math.round(rect.top)));
    const panelBounds = [...slide.querySelectorAll<HTMLElement>('[data-panel-kind]')].map((panel) => {
      const visuals = [...panel.querySelectorAll<HTMLElement>('.report-chart, .report-health-ring')];
      if (visuals.length === 0) throw new Error(`Missing visual bounds for ${panel.dataset.panelKind}`);
      const panelBox = panel.getBoundingClientRect();
      const primaryVisualBox = visuals[0]!.getBoundingClientRect();
      return {
        kind: panel.dataset.panelKind ?? '',
        panel: { top: panelBox.top, right: panelBox.right, bottom: panelBox.bottom, left: panelBox.left },
        visual: {
          top: primaryVisualBox.top,
          right: primaryVisualBox.right,
          bottom: primaryVisualBox.bottom,
          left: primaryVisualBox.left,
        },
        actualVisuals: visuals.map((visual) => {
          const visualBox = visual.getBoundingClientRect();
          return {
            top: visualBox.top,
            right: visualBox.right,
            bottom: visualBox.bottom,
            left: visualBox.left,
          };
        }),
      };
    });
    return {
      canvasClientHeight: canvasRoot.clientHeight,
      canvasScrollHeight: canvasRoot.scrollHeight,
      slideClientHeight: (slide as HTMLElement).clientHeight,
      slideScrollHeight: (slide as HTMLElement).scrollHeight,
      slideBottom: slideBox.bottom,
      viewportHeight: document.documentElement.clientHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      metricCardBounds,
      barCharts,
      barThemes,
      barAxisLabelBounds,
      barValueFontSize: Number.parseFloat(getComputedStyle(barValue).fontSize),
      barAxisLabelFontSize: Number.parseFloat(getComputedStyle(barAxisLabel).fontSize),
      evidenceButtonBounds: box(evidenceButton, 'evidence button'),
      subtitlePosition: getComputedStyle(subtitleBar).position,
      subtitlePointerEvents: getComputedStyle(subtitleBar).pointerEvents,
      subtitleText: subtitleText.textContent ?? '',
      subtitleLineCount: subtitleLineTops.size,
      subtitleWhiteSpace: getComputedStyle(subtitleText).whiteSpace,
      subtitleColor: getComputedStyle(subtitleText).color,
      subtitleTextAlign: getComputedStyle(subtitleText).textAlign,
      subtitleTextOpacity: Number.parseFloat(getComputedStyle(subtitleText).opacity),
      canvasBounds: { left: canvasBox.left, right: canvasBox.right, top: canvasBox.top, bottom: canvasBox.bottom },
      subtitleBounds: { left: subtitleBox.left, right: subtitleBox.right, top: subtitleBox.top, bottom: subtitleBox.bottom },
      evidenceBounds: { left: evidenceBox.left, right: evidenceBox.right, top: evidenceBox.top, bottom: evidenceBox.bottom },
      subtitleCenter: (subtitleBox.left + subtitleBox.right) / 2,
      canvasCenter: (canvasBox.left + canvasBox.right) / 2,
      titleLineCount: titleLineTops.size,
      metricLabelFontSize: Number.parseFloat(getComputedStyle(metricLabel).fontSize),
      metricValueFontSize: Number.parseFloat(getComputedStyle(metricValue).fontSize),
      metricIconFamilies: [...slide.querySelectorAll<HTMLElement>('.report-data-dashboard__metric [data-icon-family]')]
        .map((icon) => icon.dataset.iconFamily)
        .filter((family): family is string => Boolean(family)),
      panelBounds,
    };
  });
  expect(reportGeometry.canvasScrollHeight).toBeLessThanOrEqual(reportGeometry.canvasClientHeight + 1);
  expect(reportGeometry.slideScrollHeight).toBeLessThanOrEqual(reportGeometry.slideClientHeight + 1);
  expect(reportGeometry.slideBottom).toBeLessThanOrEqual(reportGeometry.viewportHeight + 1);
  expect(reportGeometry.documentScrollHeight).toBeLessThanOrEqual(reportGeometry.viewportHeight + 1);
  expect(reportGeometry.metricCardBounds).toHaveLength(8);
  expect(new Set(reportGeometry.metricCardBounds.map(({ top }) => Math.round(top))).size).toBe(1);
  for (const card of reportGeometry.metricCardBounds) {
    expect(card.left).toBeGreaterThanOrEqual(reportGeometry.canvasBounds.left - 1);
    expect(card.right).toBeLessThanOrEqual(reportGeometry.canvasBounds.right + 1);
    expect(card.top).toBeGreaterThanOrEqual(reportGeometry.canvasBounds.top - 1);
    expect(card.bottom).toBeLessThanOrEqual(reportGeometry.canvasBounds.bottom + 1);
  }
  expect(reportGeometry.barCharts).toHaveLength(2);
  for (const chart of reportGeometry.barCharts) {
    expect(chart.width).toBeGreaterThanOrEqual(300);
    expect(chart.height).toBeGreaterThanOrEqual(180);
  }
  expect(reportGeometry.barAxisLabelBounds.length).toBeGreaterThan(0);
  for (const label of reportGeometry.barAxisLabelBounds) {
    expect(label.bottom).toBeLessThanOrEqual(reportGeometry.evidenceButtonBounds.top + 1);
  }
  expect(new Set(reportGeometry.barThemes).size).toBe(reportGeometry.barThemes.length);
  expect(reportGeometry.barValueFontSize).toBeGreaterThanOrEqual(18);
  expect(reportGeometry.barAxisLabelFontSize).toBeGreaterThanOrEqual(18);
  expect(reportGeometry.subtitlePosition).toBe('fixed');
  expect(reportGeometry.subtitlePointerEvents).toBe('none');
  expect(reportGeometry.subtitleText).not.toBe('等待讲解字幕');
  expect(reportGeometry.subtitleLineCount).toBe(1);
  expect(reportGeometry.subtitleWhiteSpace).toBe('nowrap');
  expect(reportGeometry.subtitleColor).toBe('rgb(255, 255, 255)');
  expect(reportGeometry.subtitleTextAlign).toBe('center');
  expect(reportGeometry.titleLineCount).toBe(1);
  expect(reportGeometry.subtitleBounds.left).toBeGreaterThanOrEqual(reportGeometry.canvasBounds.left - 1);
  expect(reportGeometry.subtitleBounds.right).toBeLessThanOrEqual(reportGeometry.canvasBounds.right + 1);
  expect(Math.abs(reportGeometry.subtitleCenter - reportGeometry.canvasCenter)).toBeLessThanOrEqual(1);
  expect(reportGeometry.subtitleTextOpacity).toBe(1);
  expect(reportGeometry.subtitleBounds.top).toBeGreaterThanOrEqual(reportGeometry.evidenceButtonBounds.top - 1);
  expect(reportGeometry.subtitleBounds.bottom).toBeLessThanOrEqual(reportGeometry.evidenceButtonBounds.bottom + 2);
  expect(reportGeometry.metricLabelFontSize).toBeGreaterThanOrEqual(15);
  expect(reportGeometry.metricValueFontSize).toBeGreaterThanOrEqual(28);
  expect(new Set(reportGeometry.metricIconFamilies).size).toBeGreaterThanOrEqual(2);
  for (const panel of reportGeometry.panelBounds) {
    for (const visual of panel.actualVisuals) {
      expect(visual.left).toBeGreaterThanOrEqual(panel.panel.left - 1);
      expect(visual.right).toBeLessThanOrEqual(panel.panel.right + 1);
      expect(visual.top).toBeGreaterThanOrEqual(panel.panel.top - 1);
      expect(visual.bottom, `${panel.kind} visual exceeds panel bottom`).toBeLessThanOrEqual(panel.panel.bottom + 1);
      expect(visual.left).toBeGreaterThanOrEqual(reportGeometry.canvasBounds.left - 1);
      expect(visual.right).toBeLessThanOrEqual(reportGeometry.canvasBounds.right + 1);
      expect(visual.top).toBeGreaterThanOrEqual(reportGeometry.canvasBounds.top - 1);
      expect(visual.bottom).toBeLessThanOrEqual(reportGeometry.canvasBounds.bottom + 1);
    }
  }
  for (let index = 0; index < reportGeometry.panelBounds.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < reportGeometry.panelBounds.length; otherIndex += 1) {
      const panel = reportGeometry.panelBounds[index]!.visual;
      const other = reportGeometry.panelBounds[otherIndex]!.visual;
      const overlap = panel.left < other.right - 1
        && panel.right > other.left + 1
        && panel.top < other.bottom - 1
        && panel.bottom > other.top + 1;
      expect(overlap, `${reportGeometry.panelBounds[index]!.kind} overlaps ${reportGeometry.panelBounds[otherIndex]!.kind}`).toBe(false);
    }
  }

  await page.getByRole('button', { name: '展开证据明细' }).click();
  await expect(page.locator('.report-subtitle-bar__text')).toHaveCSS('opacity', '0');
  await expect(page.locator('.report-subtitle-bar__status')).toHaveAttribute('role', 'status');
  await page.getByRole('button', { name: '收起证据明细' }).click();
  await expect(page.locator('.report-subtitle-bar__text')).toHaveCSS('opacity', '1');

  await page.getByRole('button', { name: '退出汇报' }).focus();
  const keyboardRegions = new Set(['header']);
  for (let index = 0; index < 40 && keyboardRegions.size < 4; index += 1) {
    await page.keyboard.press('Tab');
    const focusedRegion = await page.evaluate(() => {
      const active = document.activeElement;
      if (active?.closest('.report-thumbnail-rail')) return 'rail';
      if (active?.closest('.report-workspace__canvas')) return 'canvas';
      if (active?.closest('.report-workspace__chat')) return 'chat';
      return undefined;
    });
    if (focusedRegion) keyboardRegions.add(focusedRegion);
  }
  expect([...keyboardRegions].sort()).toEqual(['canvas', 'chat', 'header', 'rail']);

  const legacy = /pptx|\.pptx|下载/iu;
  await expect(page.getByRole('button', { name: legacy })).toHaveCount(0);
  await expect(page.getByRole('link', { name: legacy })).toHaveCount(0);
  const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
  expect(hrefs.some((href) => legacy.test(href))).toBe(false);

  await page.reload();
  await expect(page.getByRole('heading', { name: energySlide.title })).toBeVisible();
  await expect(page.getByRole('list', { name: '追问记录' })).toContainText('这个数怎么算');
  expect(api.sessionBodies.length).toBeGreaterThan(0);
  await attachScreenshot(page, testInfo, 'dynamic-report-1920x1080');
});

test('keeps pending and ready dashboard canvas geometry stable at 1920x1080', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installBrowserAudioFake(page);
  const api = await installMockReportApi(page);

  await launchQuestion(page, '首屏综合看板');
  api.createGate.resolve();
  await expect(page).toHaveURL(new RegExp(`reportId=${REPORT_ID}`));
  await api.terminalStreamReady;

  const pendingCanvas = page.locator('[data-slide-state="pending"][data-slide-mode="canvas"][data-slide-id="first-dashboard"]');
  const pendingTitle = pendingCanvas.locator('h2', { hasText: '首屏综合看板' });
  await expect(pendingCanvas).toBeVisible();
  await expect(pendingTitle).toBeVisible();
  await expect(page.getByText('正在生成首个页面', { exact: true })).toHaveCount(0);
  await expect(page.getByText('等待生成', { exact: true })).toHaveCount(0);
  await expect(page.getByText('生成中', { exact: true })).toHaveCount(0);

  const pendingCanvasBox = await stableBox(pendingCanvas);
  const pendingTitleBox = await stableBox(pendingTitle);
  const pendingSlotBoxes = await Promise.all([
    stableBox(pendingCanvas.locator('[data-dashboard-slot="metrics"]')),
    stableBox(pendingCanvas.locator('[data-dashboard-slot="primary"]')),
    stableBox(pendingCanvas.locator('[data-dashboard-support-slot="0"]')),
    stableBox(pendingCanvas.locator('[data-dashboard-support-slot="1"]')),
  ]);

  api.releaseTerminal();

  const readyCanvas = page.locator('[data-slide-mode="canvas"][data-slide-id="first-dashboard"]:not([data-slide-state="pending"])');
  const readyTitle = readyCanvas.locator('h2', { hasText: '首屏综合看板' });
  await expect(readyCanvas).toBeVisible();
  await expect(readyCanvas.locator('[data-reveal-visible="false"]')).toHaveCount(0, { timeout: 5_000 });
  await expect(readyTitle).toBeVisible();

  expectStableBox(await stableBox(readyCanvas), pendingCanvasBox);
  expectStableBox(await stableBox(readyTitle), pendingTitleBox);
  const readySlotBoxes = await Promise.all([
    stableBox(readyCanvas.locator('[data-dashboard-slot="metrics"]')),
    stableBox(readyCanvas.locator('[data-dashboard-slot="primary"]')),
    stableBox(readyCanvas.locator('[data-dashboard-support-slot="0"]')),
    stableBox(readyCanvas.locator('[data-dashboard-support-slot="1"]')),
  ]);
  for (let index = 0; index < readySlotBoxes.length; index += 1) {
    expectStableBox(readySlotBoxes[index]!, pendingSlotBoxes[index]!);
  }
});

test('keeps atomic kpi-grid slots stable when the outline falls back from dashboard planning', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installBrowserAudioFake(page);
  const api = await installMockReportApi(page);

  await launchQuestion(page, '总氮是什么，目前是否达标？');
  api.createGate.resolve();
  await expect(page).toHaveURL(new RegExp(`reportId=${REPORT_ID}`));
  await api.terminalStreamReady;

  const pendingCanvas = page.locator('[data-slide-state="pending"][data-slide-mode="canvas"][data-slide-id="mixed-answer"]');
  await expect(pendingCanvas).toBeVisible();
  const pendingSlotBoxes = await Promise.all([
    stableBox(pendingCanvas.locator('[data-dashboard-slot="metrics"]')),
    stableBox(pendingCanvas.locator('[data-dashboard-slot="primary"]')),
    stableBox(pendingCanvas.locator('[data-dashboard-support-slot="0"]')),
    stableBox(pendingCanvas.locator('[data-dashboard-support-slot="1"]')),
  ]);

  api.releaseTerminal();

  const readyCanvas = page.locator('[data-slide-mode="canvas"][data-slide-id="mixed-answer"]:not([data-slide-state="pending"])');
  await expect(readyCanvas).toBeVisible();
  await expect(readyCanvas.locator('[data-reveal-visible="false"]')).toHaveCount(0, { timeout: 5_000 });
  await expect(readyCanvas.locator('.report-data-dashboard--atomic-kpi')).toBeVisible();
  const readySlotBoxes = await Promise.all([
    stableBox(readyCanvas.locator('[data-dashboard-slot="metrics"]')),
    stableBox(readyCanvas.locator('[data-dashboard-slot="primary"]')),
    stableBox(readyCanvas.locator('[data-dashboard-support-slot="0"]')),
    stableBox(readyCanvas.locator('[data-dashboard-support-slot="1"]')),
  ]);
  for (let index = 0; index < readySlotBoxes.length; index += 1) {
    expectStableBox(readySlotBoxes[index]!, pendingSlotBoxes[index]!);
  }
});

test('keeps the mocked progressive report static under reduced motion at large-screen size', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installBrowserAudioFake(page);
  const api = await installMockReportApi(page);

  await launchReport(page);
  api.createGate.resolve();
  await expect(page).toHaveURL(new RegExp(`reportId=${REPORT_ID}`));
  await api.terminalStreamReady;

  await expect(page.getByRole('main', { name: 'AI 动态汇报工作区' })).toBeVisible();
  const rail = page.getByRole('navigation', { name: '汇报页面' });
  await expect(page.locator('[data-slide-state="pending"][data-slide-mode="canvas"]')).toBeVisible();
  await expect(rail.locator('[data-slide-state="pending"][data-slide-mode="thumbnail"]').first()).toBeVisible();
  await expect(rail.locator('[data-slide-state="pending"][data-slide-mode="thumbnail"]')).toHaveCount(3);
  await expect(page.getByText('正在生成首个页面', { exact: true })).toHaveCount(0);
  await expect(page.getByText('等待生成', { exact: true })).toHaveCount(0);
  await expect(page.getByText('生成中', { exact: true })).toHaveCount(0);

  const pendingModules = page.locator('[data-slide-state="pending"][data-slide-mode="canvas"] [data-pending-module]');
  const pendingModuleStyles = await pendingModules.evaluateAll((modules) => (
    modules.map((module) => {
      const style = getComputedStyle(module as HTMLElement);
      return {
        animationName: style.animationName,
        animationDuration: style.animationDuration,
      };
    })
  ));
  expect(pendingModuleStyles.length).toBeGreaterThan(0);
  expect(pendingModuleStyles.every(({ animationName }) => animationName === 'none')).toBe(true);

  api.releaseTerminal();

  const activeCanvas = page.locator('[data-slide-mode="canvas"]:not([data-slide-state="pending"])');
  await expect(activeCanvas).toBeVisible();
  await expect(activeCanvas).toHaveAttribute('data-motion-reduced', 'true');
  await expect(activeCanvas.locator('[data-reveal-visible="false"]')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByRole('heading', { name: firstSlide.title })).toBeVisible();
  expect(await activeCanvas.locator('[data-reveal-module]').count()).toBeGreaterThan(0);

  const moduleAnimations = await activeCanvas.locator('[data-reveal-module]').evaluateAll((modules) => (
    modules.map((module) => getComputedStyle(module as HTMLElement).animationName)
  ));
  expect(moduleAnimations.every((name) => name !== 'report-module-clear')).toBe(true);

  await attachScreenshot(page, testInfo, 'dynamic-report-1920x1080-reduced-motion');
});

const mockedIntentScenarios = [
  { question: '为什么最近能耗升高？', title: '近期能耗变化的主要判断', pages: 3, source: '现场数据快照' },
  { question: '污水脱氮是什么？', title: '污水脱氮的核心机制', pages: 1, source: '模型知识' },
  { question: '总氮是什么，目前是否达标？', title: '总氮含义与现场达标判断', pages: 2, source: '现场数据快照' },
  { question: '你是什么模型？', title: '智慧水务 AI 助手', pages: 1, source: '模型知识' },
] as const;

for (const scenario of mockedIntentScenarios) {
  test(`renders a question-specific ${scenario.pages}-page mocked report for ${scenario.question}`, async ({ page }) => {
    await installBrowserAudioFake(page);
    const api = await installMockReportApi(page);
    await launchQuestion(page, scenario.question);
    api.createGate.resolve();
    await api.terminalStreamReady;
    api.releaseTerminal();

    await expect(page.getByRole('heading', { name: scenario.title })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '汇报页面' }).locator('.report-thumbnail')).toHaveCount(scenario.pages);
    await expect(page.getByText('实时数据快照')).toHaveCount(0);
    await page.getByRole('button', { name: '展开证据明细' }).click();
    await expect(page.getByRole('table', { name: '证据明细' })).toContainText(scenario.source);
    if (scenario.question === '你是什么模型？') {
      await expect(page.locator('[data-slide-mode="canvas"]').getByText('DeepSeek v4-flash', { exact: false })).toBeVisible();
      await expect(page.locator('body')).not.toContainText(/(?:DEEPSEEK_MODEL|MODEL_ID|API_KEY)\s*=/u);
    }
    if (scenario.question === '污水脱氮是什么？') {
      await expect(page.getByRole('table', { name: '证据明细' })).not.toContainText('现场数据快照');
    }
    if (scenario.question === '总氮是什么，目前是否达标？') {
      await expect(page.getByRole('table', { name: '证据明细' })).toContainText('模型知识');
    }
  });
}

test('keeps clarification inside the report task before publishing a first page', async ({ page }) => {
  const api = await installMockReportApi(page);
  await launchQuestion(page, '这个怎么样？');
  api.createGate.resolve();
  await expect(page.getByText('请明确要分析的对象')).toBeVisible();
  await page.getByLabel('补充说明').fill('分析总氮');
  await page.getByRole('button', { name: '继续分析' }).click();
  await expect(page.getByRole('heading', { name: '总氮现场判断' })).toBeVisible();
});

test('moves a transiently failing second page from generating to ready without a manual retry', async ({ page }) => {
  const api = await installMockReportApi(page);
  await launchQuestion(page, '第二页瞬时失败后恢复');
  api.createGate.resolve();
  await api.terminalStreamReady;
  api.releaseTerminal();
  await expect.poll(() => api.slideAttempts['transient-second']).toBe(2);
  await expect.poll(() => api.slideAttemptOutcomes['transient-second']).toEqual(['failed', 'ready']);
  await expect(page.getByRole('button', { name: '重试第 2 页' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '汇报页面' })).toContainText('已完成');
});

test('keeps page one playable and exposes one retry action when second-page retries are exhausted', async ({ page }) => {
  const api = await installMockReportApi(page);
  await launchQuestion(page, '第二页持续失败');
  api.createGate.resolve();
  await api.terminalStreamReady;
  api.releaseTerminal();
  await expect.poll(() => api.slideAttempts['exhausted-second']).toBe(2);
  await expect.poll(() => api.slideAttemptOutcomes['exhausted-second']).toEqual(['failed', 'failed']);
  await expect(page.locator('[data-slide-mode="canvas"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '播放讲解' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '重试第 2 页' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /重试第/u })).toHaveCount(1);
});

test('cancels an in-flight mocked report from the workspace', async ({ page }) => {
  const api = await installMockReportApi(page);
  await launchQuestion(page, '为什么最近能耗升高？');
  api.createGate.resolve();
  await expect(page).toHaveURL(new RegExp(`reportId=${REPORT_ID}`));
  await page.getByRole('button', { name: '退出汇报' }).click();

  await expect.poll(() => api.cancelRequests).toBe(1);
  await expect(page.getByRole('main', { name: 'AI 动态汇报工作区' })).toHaveCount(0);
});
