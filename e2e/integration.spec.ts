import { expect, test, type APIRequestContext, type Page } from 'playwright/test';
import type { ReportJobSnapshot } from '../shared/report';

const question = '联合分析总氮、吨水电耗、鼓风能耗与碳源投加';
const energyQuestion = '为什么最近能耗升高？';
const privateProviderSentinels = ['e2e-only-key', 'https://provider.invalid/private-e2e', 'deepseek-v4-flash'] as const;
const publicDisplayName = 'DeepSeek v4-flash';
const sensitivePattern = /E2E_(?:ACCESS_KEY|ACCESS_SECRET|APP_KEY|TOKEN)_MUST_NOT_LEAK|Bearer\s+|\.xlsx|[A-Za-z]:[\\/]|\/Users\/|\/private\//iu;
const expectedWorkbookEvidence = {
  dateRange: { from: '2026-07-29', to: '2026-08-09' },
  sampleCount: 12,
  metrics: {
    tn: { unit: 'mg/L', latest: 1.96 },
    kwhPerM3: { unit: 'kWh/m³', latest: 0.429 },
    blowerKwh: { unit: 'kWh/d', latest: 4850 },
    carbonSourceKg: { unit: 'kg/d', latest: 537.2 },
  },
} as const;

type ReportHarnessState = {
  providerCallKinds: string[];
  completionCallKinds: Array<'intent-planner' | 'report-planner' | 'slide-composer'>;
  emittedSequences: number[];
  slideAttempts: Record<string, number>;
  slideAttemptOutcomes: Record<string, Array<'failed' | 'ready'>>;
  activeSubscriptions: number;
  followUpOrdinals: number[];
  speechOwnershipChecks: number;
  appliedSessionUpdates: Array<{
    activity: string;
    narrationCursor?: { segmentId?: string };
  }>;
  cleanupCounts: { speech: number; subscriptions: number };
  sensitiveLeakCount: number;
};

type VoiceHarnessState = {
  recognitionSessions: number;
  pcmFrames: number;
  synthesisRequests: number;
  speechIds: string[];
  synthesisSessions: Array<{ speechId: string }>;
  segmentIndexes: number[];
  cancellationCount: number;
  sensitiveLeakCount: number;
};

async function reportState(request: APIRequestContext): Promise<ReportHarnessState> {
  const response = await request.post('/__e2e/report-state');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<ReportHarnessState>;
}

async function voiceHarnessState(request: APIRequestContext): Promise<VoiceHarnessState> {
  const response = await request.post('/__e2e/voice-state');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<VoiceHarnessState>;
}

async function reportSnapshot(request: APIRequestContext, reportId: string): Promise<ReportJobSnapshot> {
  const response = await request.get(`/api/ai/reports/${encodeURIComponent(reportId)}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<ReportJobSnapshot>;
}

async function createReport(request: APIRequestContext, reportQuestion: string): Promise<string> {
  const response = await request.post('/api/ai/reports', {
    data: { question: reportQuestion, page: 'overview' },
  });
  expect(response.status()).toBe(202);
  const body = await response.json() as { reportId: string };
  return body.reportId;
}

async function installBrowserVoiceFakes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const harnessWindow = window as typeof window & {
      __e2eAudioStarts?: number;
      __e2eAudioStartSpeechIds?: string[];
    };
    harnessWindow.__e2eAudioStarts = 0;
    harnessWindow.__e2eAudioStartSpeechIds = [];
    class FakeAudioWorkletNode {
      readonly port = { onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null };
      connect() { return this; }
      disconnect() {}
      emitPcm() {
        const samples = Float32Array.from({ length: 960 }, (_, index) => ((index % 20) - 10) / 10);
        this.port.onmessage?.({ data: samples.buffer } as MessageEvent<ArrayBuffer>);
      }
    }
    class FakeSource {
      buffer: AudioBuffer | null = null;
      onended: (() => void) | null = null;
      connect() { return this; }
      disconnect() {}
      start() {
        const harnessWindow = window as typeof window & {
          __e2eAudioStarts?: number;
          __e2eAudioStartSpeechIds?: string[];
        };
        harnessWindow.__e2eAudioStarts = (harnessWindow.__e2eAudioStarts ?? 0) + 1;
        const speechId = (this.buffer as AudioBuffer & { __e2eSpeechId?: string } | null)?.__e2eSpeechId;
        if (speechId) harnessWindow.__e2eAudioStartSpeechIds?.push(speechId);
        setTimeout(() => this.onended?.(), 650);
      }
      stop() { this.onended = null; }
    }
    class FakeAudioContext {
      state: AudioContextState = 'running';
      readonly destination = {} as AudioDestinationNode;
      readonly sampleRate = 48_000;
      readonly audioWorklet = { addModule: async () => undefined } as AudioWorklet;
      currentTime = 0;
      async resume() { this.state = 'running'; }
      async suspend() { this.state = 'suspended'; }
      async close() { this.state = 'closed'; }
      async decodeAudioData(bytes: ArrayBuffer) {
        const payload = new TextDecoder().decode(bytes);
        const speechId = payload.startsWith('E2E_SPEECH:') ? payload.slice('E2E_SPEECH:'.length) : undefined;
        return { duration: 0.65, ...(speechId ? { __e2eSpeechId: speechId } : {}) } as AudioBuffer;
      }
      createBufferSource() { return new FakeSource() as unknown as AudioBufferSourceNode; }
      createGain() { return { gain: { value: 1 }, connect() { return this; }, disconnect() {} } as unknown as GainNode; }
      createMediaStreamSource() {
        return {
          connect(target: FakeAudioWorkletNode) {
            setTimeout(() => target.emitPcm(), 80);
            return target;
          },
          disconnect() {},
        } as unknown as MediaStreamAudioSourceNode;
      }
    }
    const track = { stop() {} } as MediaStreamTrack;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) as MediaStream },
    });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode });
  });
}

async function waitForReadySnapshot(request: APIRequestContext, reportId: string): Promise<ReportJobSnapshot> {
  let latest: ReportJobSnapshot | undefined;
  await expect.poll(async () => {
    latest = await reportSnapshot(request, reportId);
    const allSettled = latest.outline.length > 0
      && latest.outline.every(({ status }) => status === 'ready' || status === 'failed');
    const readyCount = latest.outline.filter(({ status }) => status === 'ready').length;
    return (latest.status === 'ready' || latest.status === 'partial')
      && allSettled
      && latest.slides.length === readyCount;
  }, { timeout: 15_000 }).toBe(true);
  return latest!;
}

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__e2e/reset');
  expect(response.ok()).toBe(true);
  const voiceMode = await request.post('/__e2e/voice-mode', { data: { synthesis: 'complete-all' } });
  expect(voiceMode.ok()).toBe(true);
});

test('keeps duplicate narration text bound to each concurrent synthesis request', async ({ page, request }) => {
  const reportId = await createReport(request, '并发语音文本校验');
  const ready = await waitForReadySnapshot(request, reportId);
  const narration = ready.slides.flatMap((slide) => slide.narration);
  const duplicatePair = narration.flatMap((segment, index) => (
    narration.slice(index + 1)
      .filter((candidate) => candidate.text === segment.text && candidate.speechId !== segment.speechId)
      .slice(0, 1)
      .map((candidate) => [segment, candidate] as const)
  )).at(0);
  expect(duplicatePair, 'configured slides must exercise repeated narration text').toBeDefined();
  const speechIds = duplicatePair!.map(({ speechId }) => speechId);
  const overlapMode = await request.post('/__e2e/voice-mode', {
    data: { synthesis: 'complete-all', tokenDelayMs: 15 },
  });
  expect(overlapMode.ok()).toBe(true);

  await page.goto('/');
  const payloads = await page.evaluate(async ({ currentReportId, currentSpeechIds }) => {
    const synthesize = (speechId: string) => new Promise<string>((resolvePromise, rejectPromise) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/u, 'ws')}/api/voice/synthesize`);
      socket.binaryType = 'arraybuffer';
      socket.onerror = () => rejectPromise(new Error(`synthesis failed for ${speechId}`));
      socket.onopen = () => socket.send(JSON.stringify({
        type: 'synthesize', reportId: currentReportId, speechId,
      }));
      socket.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        socket.close();
        resolvePromise(new TextDecoder().decode(event.data));
      };
    });
    return Promise.all(currentSpeechIds.map(synthesize));
  }, { currentReportId: reportId, currentSpeechIds: speechIds });

  expect(payloads).toEqual(speechIds.map((speechId) => `E2E_SPEECH:${speechId}`));
});

test('automatically retries a transient second-page provider failure through ReportGenerator', async ({ request }) => {
  const reportId = await createReport(request, '第二页瞬时失败后恢复');
  const ready = await waitForReadySnapshot(request, reportId);
  const harness = await reportState(request);

  expect(ready.status).toBe('ready');
  expect(ready.outline).toHaveLength(2);
  expect(ready.outline.map(({ status }) => status)).toEqual(['ready', 'ready']);
  const secondPageKey = ready.outline[1]!.title;
  expect(harness.slideAttempts[secondPageKey]).toBe(2);
  expect(harness.slideAttemptOutcomes[secondPageKey]).toEqual(['failed', 'ready']);
});

test('derives partial from two exhausted second-page attempts, preserves page one and plays it', async ({ page, request }) => {
  await installBrowserVoiceFakes(page);
  const sessionUpdates: Array<Record<string, unknown>> = [];
  page.on('request', (browserRequest) => {
    if (browserRequest.method() !== 'PATCH' || !new URL(browserRequest.url()).pathname.endsWith('/session')) return;
    const body = browserRequest.postDataJSON();
    if (body && typeof body === 'object') sessionUpdates.push(body as Record<string, unknown>);
  });
  const reportId = await createReport(request, '第二页持续失败');
  const partial = await waitForReadySnapshot(request, reportId);
  const harness = await reportState(request);

  expect(partial.status).toBe('partial');
  expect(partial.slides).toHaveLength(1);
  expect(partial.slides[0]!.id).toBe(partial.outline[0]!.id);
  expect(partial.outline).toEqual([
    expect.objectContaining({ status: 'ready' }),
    expect.objectContaining({ status: 'failed', retryable: true }),
  ]);
  const secondPageKey = partial.outline[1]!.title;
  expect(harness.slideAttempts[secondPageKey]).toBe(2);
  expect(harness.slideAttemptOutcomes[secondPageKey]).toEqual(['failed', 'failed']);

  await page.goto(`/?reportId=${encodeURIComponent(reportId)}`);
  await expect(page.locator(`[data-slide-mode="canvas"][data-slide-id="${partial.slides[0]!.id}"]`)).toBeVisible();
  await page.getByRole('button', { name: '停止讲解' }).click();
  await expect(page.getByRole('button', { name: '播放讲解' })).toBeVisible();
  const audioStartsBeforeReplay = await page.evaluate(() => (
    (window as typeof window & { __e2eAudioStarts?: number }).__e2eAudioStarts ?? 0
  ));
  const sessionUpdateCursor = sessionUpdates.length;
  await page.getByRole('button', { name: '播放讲解' }).click();
  const firstSegment = partial.slides[0]!.narration[0]!;
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __e2eAudioStarts?: number }).__e2eAudioStarts ?? 0
  ))).toBeGreaterThan(audioStartsBeforeReplay);
  await expect.poll(() => sessionUpdates.slice(sessionUpdateCursor).some((update) => (
    update.activity === 'narration'
      && (update.narrationCursor as { segmentId?: string } | undefined)?.segmentId === firstSegment.id
  ))).toBe(true);
});

test('answers the exact recent-energy-rise question through production planning and Excel evidence', async ({ request }) => {
  const reportId = await createReport(request, energyQuestion);
  const ready = await waitForReadySnapshot(request, reportId);
  const harness = await reportState(request);

  expect(ready.status).toBe('ready');
  expect(ready.scope).toEqual({
    modules: ['energy'],
    metrics: ['kwhPerM3', 'blowerKwh'],
    dateRange: expectedWorkbookEvidence.dateRange,
    sampleCount: expectedWorkbookEvidence.sampleCount,
    granularity: 'daily',
  });
  expect(ready.outline.length).toBeGreaterThanOrEqual(2);
  expect(ready.outline.map(({ title }) => title).join('\n')).toMatch(/能耗/u);
  expect(ready.outline.map(({ title, purpose }) => `${title}\n${purpose}`).join('\n')).toMatch(/升高|驱动|原因/u);
  expect(new Set(ready.slides.flatMap(({ evidenceRefs }) => evidenceRefs.map(({ key }) => key)))).toEqual(
    new Set(['kwhPerM3', 'blowerKwh']),
  );
  expect(Object.fromEntries(ready.slides.flatMap(({ metrics }) => metrics).map(({ key, value }) => [key, value]))).toEqual({
    kwhPerM3: expectedWorkbookEvidence.metrics.kwhPerM3.latest,
    blowerKwh: expectedWorkbookEvidence.metrics.blowerKwh.latest,
  });
  expect(harness.completionCallKinds).toEqual(expect.arrayContaining([
    'intent-planner', 'report-planner', 'slide-composer',
  ]));
});

test('builds distinct knowledge, mixed, identity and clarified reports from the configured pipeline', async ({ page, request }) => {
  let completionCursor = 0;
  const completionDelta = async () => {
    const calls = (await reportState(request)).completionCallKinds;
    const delta = calls.slice(completionCursor);
    completionCursor = calls.length;
    return delta;
  };
  const knowledgeId = await createReport(request, '污水脱氮是什么？');
  const knowledge = await waitForReadySnapshot(request, knowledgeId);
  expect(knowledge.outline.map(({ title }) => title)).toEqual(['污水脱氮的核心机制']);
  expect(knowledge.slides).toHaveLength(1);
  expect(new Set(knowledge.slides[0]!.evidenceRefs.map(({ source }) => source))).toEqual(new Set(['model-knowledge']));
  expect(knowledge.scope.sampleCount).toBe(0);
  expect(await completionDelta()).toEqual(['intent-planner', 'report-planner', 'slide-composer']);

  const mixedId = await createReport(request, '总氮是什么，目前是否达标？');
  const mixed = await waitForReadySnapshot(request, mixedId);
  expect(mixed.outline.map(({ title }) => title)).toEqual(['总氮含义与现场达标判断', '总氮现场证据']);
  expect(new Set(mixed.slides[0]!.evidenceRefs.map(({ source }) => source))).toEqual(
    new Set(['model-knowledge', 'excel']),
  );
  const mixedNarration = mixed.slides.flatMap(({ narration }) => narration.map(({ text }) => text));
  const templateOpenings = mixedNarration.filter((text) => /本页查看[^。]*共\d+个样本/u.test(text));

  expect(templateOpenings).toHaveLength(1);
  expect(mixed.slides[0]!.narration[0]!.text).toMatch(/本页查看[^。]*共\d+个样本/u);
  expect(mixed.slides.slice(1).flatMap(({ narration }) => narration.map(({ text }) => text)).join(''))
    .not.toMatch(/本页查看|本页单位、日期范围与样本/u);
  expect(await completionDelta()).toEqual([
    'intent-planner', 'report-planner', 'slide-composer', 'slide-composer',
  ]);

  const identityId = await createReport(request, '你是什么模型？');
  const identity = await waitForReadySnapshot(request, identityId);
  expect(identity.outline.map(({ title }) => title)).toEqual(['智慧水务 AI 助手']);
  expect(identity.slides[0]).toMatchObject({
    takeaway: `公开模型名称为 ${publicDisplayName}。`,
    claims: [expect.objectContaining({ text: `公开模型名称为 ${publicDisplayName}。` })],
    narration: [expect.objectContaining({ text: `我是智慧水务 AI 助手，公开模型名称是 ${publicDisplayName}。` }), expect.anything()],
  });
  expect(JSON.stringify(identity)).not.toMatch(/(?:DEEPSEEK_MODEL|MODEL_ID|API_KEY)\s*=/u);
  expect(new Set(identity.slides[0]!.evidenceRefs.map(({ source }) => source))).toEqual(new Set(['assistant-profile']));
  expect(await completionDelta()).toEqual(['intent-planner', 'report-planner', 'slide-composer']);

  const browserLogs: string[] = [];
  const browserTargets: string[] = [];
  page.on('console', (message) => browserLogs.push(message.text()));
  page.on('request', (browserRequest) => browserTargets.push(browserRequest.url()));
  await installBrowserVoiceFakes(page);
  await page.goto(`/?reportId=${encodeURIComponent(identityId)}`);
  const identityCanvas = page.locator(`[data-slide-mode="canvas"][data-slide-id="${identity.slides[0]!.id}"]`);
  await expect(identityCanvas).toBeVisible();
  await expect(identityCanvas.getByText(publicDisplayName, { exact: false })).toBeVisible();
  const identityChannels = {
    api: JSON.stringify(identity),
    dom: await page.locator('body').innerText(),
    narration: JSON.stringify(identity.slides.flatMap(({ narration }) => narration.map(({ text }) => text))),
    observableState: JSON.stringify({
      report: await reportState(request),
      voice: await voiceHarnessState(request),
    }),
    browserLogs: browserLogs.join('\n'),
    browserRequests: browserTargets.join('\n'),
  };
  for (const [channel, observed] of Object.entries(identityChannels)) {
    for (const sentinel of privateProviderSentinels) {
      expect(observed, `${sentinel} leaked through ${channel}`).not.toContain(sentinel);
    }
  }

  const clarificationId = await createReport(request, '这个怎么样？');
  let awaiting: ReportJobSnapshot | undefined;
  await expect.poll(async () => {
    awaiting = await reportSnapshot(request, clarificationId);
    return awaiting.status;
  }).toBe('awaiting-clarification');
  expect(awaiting!.slides).toHaveLength(0);
  expect(awaiting!.outline).toHaveLength(0);
  const clarificationResponse = await request.post(`/api/ai/reports/${clarificationId}/clarifications`, {
    data: {
      clarificationId: awaiting!.clarification!.clarificationId,
      answer: '分析总氮',
    },
  });
  expect(clarificationResponse.status()).toBe(202);
  const clarified = await waitForReadySnapshot(request, clarificationId);
  expect(clarified.outline.map(({ title }) => title)).toEqual(['总氮现场判断']);
  expect(clarified.conversation.originalQuestion).toBe('这个怎么样？');
  expect(await completionDelta()).toEqual([
    'intent-planner', 'intent-planner', 'report-planner', 'slide-composer',
  ]);
});

test('cancels an in-flight configured report without publishing a late page', async ({ request }) => {
  const reportId = await createReport(request, '取消正在生成的汇报');
  const cancelledResponse = await request.delete(`/api/ai/reports/${reportId}`);
  expect(cancelledResponse.status()).toBe(204);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));

  const cancelled = await reportSnapshot(request, reportId);
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.slides).toHaveLength(0);
  expect(cancelled.phase).toBeNull();
});

test('runs the final report flow through browser, Express, workbook and deterministic providers', async ({ page, request }, testInfo) => {
  await installBrowserVoiceFakes(page);
  const browserTargets: string[] = [];
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const networkTimeline: Array<{
    kind: 'follow-up-response' | 'session-request';
    url: string;
    body?: Record<string, unknown>;
  }> = [];
  page.on('request', (browserRequest) => {
    browserTargets.push(browserRequest.url());
    if (browserRequest.method() === 'PATCH' && new URL(browserRequest.url()).pathname.endsWith('/session')) {
      const body = browserRequest.postDataJSON();
      if (body && typeof body === 'object') {
        const update = body as Record<string, unknown>;
        sessionUpdates.push(update);
        networkTimeline.push({ kind: 'session-request', url: browserRequest.url(), body: update });
      }
    }
  });
  page.on('response', (browserResponse) => {
    const url = new URL(browserResponse.url());
    if (browserResponse.request().method() === 'POST' && url.pathname.endsWith('/follow-ups')) {
      networkTimeline.push({ kind: 'follow-up-response', url: browserResponse.url() });
    }
  });

  // 1. Ask one cross-module question from the real dashboard UI.
  await page.goto('/');
  await page.getByRole('button', { name: '进入智慧中枢' }).click();
  await page.getByRole('button', { name: '唤起 AI 运营助手' }).click();
  await page.getByLabel('请输入需要分析的问题').fill(question);
  const automaticAudioStartBaseline = await page.evaluate(() => {
    const harnessWindow = window as typeof window & {
      __e2eAudioStarts?: number;
      __e2eAudioStartSpeechIds?: string[];
    };
    return {
      count: harnessWindow.__e2eAudioStarts ?? 0,
      speechIds: harnessWindow.__e2eAudioStartSpeechIds?.length ?? 0,
    };
  });
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/ai/reports'
  ));
  await page.getByRole('button', { name: '生成动态汇报' }).click();

  // 2. Transition immediately while the 202 response is in flight.
  await expect(page.getByRole('main', { name: 'AI 动态汇报工作区' })).toBeVisible();

  // 3. Consume the real 202 bootstrap response and opaque URL identity.
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(202);
  const createBody = await createResponse.json() as { reportId: string; snapshot: ReportJobSnapshot };
  const reportId = createBody.reportId;
  expect(reportId).toBeTruthy();
  expect(createBody.snapshot.reportId).toBe(reportId);
  expect(createBody.snapshot.slides).toHaveLength(0);
  expect(createBody.snapshot.outline).toHaveLength(0);
  expect(createBody.snapshot.lastSequence).toBe(0);
  await expect(page).toHaveURL(new RegExp(`reportId=${encodeURIComponent(reportId)}`));
  await expect(page.getByText('实时数据快照')).toHaveCount(0);
  await expect.poll(async () => {
    const current = await reportSnapshot(request, reportId);
    if (current.status === 'ready' || current.status === 'partial') return true;
    return current.status === 'generating'
      && current.phase !== null
      && current.phase !== 'completed';
  }).toBe(true);

  // 4. Observe the streamed outline and all composed slides from the real SSE route.
  const ready = await waitForReadySnapshot(request, reportId);
  await expect(page.locator('.report-thumbnail')).toHaveCount(ready.outline.length);
  for (const outline of ready.outline) await expect(page.getByText(outline.title, { exact: true }).first()).toBeVisible();

  // 5. Autoplay uses report-owned speech and persists narration progress.
  const firstTwoNarration = ready.slides[0]!.narration.slice(0, 2);
  const firstTwoSegments = firstTwoNarration.map(({ id }) => id);
  const firstTwoSpeechIds = firstTwoNarration.map(({ speechId }) => speechId);
  expect(firstTwoSegments).toHaveLength(2);
  expect(firstTwoSpeechIds).toHaveLength(2);
  await expect.poll(async () => {
    const observed = new Set((await voiceHarnessState(request)).synthesisSessions.map(({ speechId }) => speechId));
    return firstTwoSpeechIds.every((speechId) => observed.has(speechId));
  }, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => page.evaluate(({ from }) => {
    const harnessWindow = window as typeof window & { __e2eAudioStartSpeechIds?: string[] };
    return (harnessWindow.__e2eAudioStartSpeechIds ?? []).slice(from, from + 2);
  }, { from: automaticAudioStartBaseline.speechIds }), { timeout: 10_000 }).toEqual(firstTwoSpeechIds);
  await expect.poll(async () => (
    await page.evaluate(() => (
      (window as typeof window & { __e2eAudioStarts?: number }).__e2eAudioStarts ?? 0
    )) - automaticAudioStartBaseline.count
  ), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('button', { name: '停止讲解' })).toBeVisible();
  await expect.poll(async () => {
    const persisted = (await reportState(request)).appliedSessionUpdates
      .filter((update) => update.activity === 'narration')
      .map((update) => update.narrationCursor?.segmentId);
    const firstIndex = persisted.indexOf(firstTwoSegments[0]);
    const secondIndex = persisted.indexOf(firstTwoSegments[1]);
    return firstIndex >= 0 && secondIndex > firstIndex;
  }, { timeout: 10_000 }).toBe(true);

  // 6. Interrupt the current page with the production recognition WebSocket.
  const firstSlide = ready.slides[0]!;
  await page.locator(`[data-slide-mode="thumbnail"][data-slide-id="${firstSlide.id}"]`).locator('xpath=ancestor::li[contains(@class, "report-thumbnail")]').locator('button.report-thumbnail__select').click();
  const voiceFollowUp = page.getByRole('button', { name: '语音追问' });
  await voiceFollowUp.click();
  await expect(voiceFollowUp).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(150);
  await voiceFollowUp.click();

  // 7. The recognized “为什么” answer stays bound to the selected page.
  const history = page.getByRole('list', { name: '追问记录' });
  await expect(history).toContainText('为什么', { timeout: 10_000 });
  await expect(history).toContainText('工作簿证据');

  // 8. Switch to the anomaly page using the real directory.
  const anomaly = ready.outline.find(({ title }) => title.includes('异常')) ?? ready.outline.at(-1)!;
  await page.locator(`[data-slide-mode="thumbnail"][data-slide-id="${anomaly.id}"]`).locator('xpath=ancestor::li[contains(@class, "report-thumbnail")]').locator('button.report-thumbnail__select').click();
  await expect(page.locator(`[data-slide-mode="canvas"][data-slide-id="${anomaly.id}"]`)).toBeVisible();

  // 9. Ask how the displayed value was calculated.
  await page.getByLabel('输入追问').fill('这个数怎么算');
  await page.getByRole('button', { name: '发送追问' }).click();
  await expect(history).toContainText('这个数怎么算');

  // 10. Correct the subject and retain the correction in the same conversation.
  await page.getByLabel('输入追问').fill('我问的是鼓风机，不是总电耗');
  const correctionResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/follow-ups')
  ));
  await page.getByRole('button', { name: '发送追问' }).click();
  const correctionResponse = await correctionResponsePromise;
  const correctionReply = await correctionResponse.json() as {
    resumeCursor: { slideId: string; segmentId: string; offsetMs: number };
  };
  await expect(history).toContainText('鼓风机能耗');

  // 11. Follow-up playback semantically resumes the report cursor.
  let correctionResponseIndex = -1;
  for (let index = networkTimeline.length - 1; index >= 0; index -= 1) {
    if (networkTimeline[index]?.kind === 'follow-up-response') {
      correctionResponseIndex = index;
      break;
    }
  }
  expect(correctionResponseIndex).toBeGreaterThanOrEqual(0);
  await expect.poll(() => networkTimeline.slice(correctionResponseIndex + 1).find((event) => (
    event.kind === 'session-request'
    && JSON.stringify(event.body) === JSON.stringify({
      activity: 'narration',
      narrationCursor: correctionReply.resumeCursor,
    })
  )), { timeout: 10_000 }).toEqual(expect.objectContaining({
    kind: 'session-request',
    body: {
      activity: 'narration',
      narrationCursor: correctionReply.resumeCursor,
    },
  }));

  // 12. A later ambiguous question resolves through the retained server-only object correction.
  await page.getByLabel('输入追问').fill('那它呢？');
  const ambiguousResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/follow-ups')
  ));
  await page.getByRole('button', { name: '发送追问' }).click();
  const ambiguousResponse = await ambiguousResponsePromise;
  const ambiguousReply = await ambiguousResponse.json() as { citedEvidence: Array<{ key: string }> };
  expect(ambiguousReply.citedEvidence.map(({ key }) => key)).toEqual(['blowerKwh']);
  await expect(history).toContainText('那它呢？');
  await expect(history).toContainText('鼓风机能耗');

  const beforeRefresh = await reportSnapshot(request, reportId);
  expect(beforeRefresh.conversation.turns.map(({ question: turnQuestion }) => turnQuestion)).toEqual([
    '为什么',
    '这个数怎么算',
    '我问的是鼓风机，不是总电耗',
    '那它呢？',
  ]);
  expect(JSON.stringify(beforeRefresh)).not.toMatch(/intentCorrections|object-correction/u);
  expect(beforeRefresh.conversation.narrationCursor?.slideId).toBe(anomaly.id);

  // 13. Refresh restores the URL report, selected page, history and identical evidence.
  const evidenceBefore = JSON.stringify({ scope: beforeRefresh.scope, slides: beforeRefresh.slides });
  await page.reload();
  await expect(page.getByRole('main', { name: 'AI 动态汇报工作区' })).toBeVisible();
  await expect(history).toContainText('我问的是鼓风机，不是总电耗');
  await expect(page.locator(`[data-slide-mode="canvas"][data-slide-id="${anomaly.id}"]`)).toBeVisible();
  const afterRefresh = await reportSnapshot(request, reportId);
  expect(JSON.stringify({ scope: afterRefresh.scope, slides: afterRefresh.slides })).toBe(evidenceBefore);

  const evidenceRefs = afterRefresh.slides.flatMap(({ evidenceRefs }) => evidenceRefs);
  expect(afterRefresh.scope).toEqual({
    modules: ['water-quality', 'energy'],
    metrics: ['tn', 'kwhPerM3', 'blowerKwh', 'carbonSourceKg'],
    dateRange: expectedWorkbookEvidence.dateRange,
    sampleCount: expectedWorkbookEvidence.sampleCount,
    granularity: 'daily',
  });
  expect(Object.fromEntries(evidenceRefs.map(({ key, unit }) => [key, unit]))).toEqual(
    Object.fromEntries(Object.entries(expectedWorkbookEvidence.metrics).map(([key, value]) => [key, value.unit])),
  );
  const latestMetrics = Object.fromEntries(afterRefresh.slides
    .flatMap(({ metrics }) => metrics)
    .map(({ key, value }) => [key, value]));
  expect(latestMetrics).toEqual(Object.fromEntries(
    Object.entries(expectedWorkbookEvidence.metrics).map(([key, value]) => [key, value.latest]),
  ));
  for (const evidence of evidenceRefs) {
    expect(evidence.dateRange).toEqual(expectedWorkbookEvidence.dateRange);
    expect(evidence.sampleCount).toBe(expectedWorkbookEvidence.sampleCount);
  }
  const pageText = await page.locator('body').innerText();
  expect(pageText).toContain(expectedWorkbookEvidence.dateRange.from);
  expect(pageText).toContain(expectedWorkbookEvidence.dateRange.to);
  expect(pageText).not.toMatch(sensitivePattern);

  const harness = await reportState(request);
  expect(harness.providerCallKinds).toEqual(expect.arrayContaining([
    'intent-planner', 'report-planner', 'slide-composer', 'follow-up',
  ]));
  expect(harness.completionCallKinds).toEqual(expect.arrayContaining([
    'intent-planner', 'report-planner', 'slide-composer',
  ]));
  expect(Object.values(harness.slideAttempts)).toEqual(expect.arrayContaining([1]));
  expect(harness.followUpOrdinals).toEqual([1, 2, 3, 4]);
  expect(harness.emittedSequences.length).toBeGreaterThan(0);
  expect(harness.emittedSequences.every((sequence, index, values) => index === 0 || sequence > values[index - 1]!)).toBe(true);
  expect(harness.sensitiveLeakCount).toBe(0);

  const externalTargets = browserTargets.filter((target) => {
    const url = new URL(target);
    return !['127.0.0.1', 'localhost'].includes(url.hostname);
  });
  expect(externalTargets).toEqual([]);
  expect(browserTargets.some((target) => target.includes('/api/ai/query'))).toBe(false);
  expect(browserTargets.some((target) => /pptx|presentations/iu.test(target))).toBe(false);
  await expect(page.getByRole('button', { name: /pptx|下载/iu })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /pptx|下载/iu })).toHaveCount(0);

  await testInfo.attach('integration-dynamic-report', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: '退出汇报' }).click();
  await expect.poll(async () => (await reportState(request)).activeSubscriptions).toBe(0);
  const cleaned = await reportState(request);
  expect(cleaned.cleanupCounts.subscriptions).toBeGreaterThan(0);
  expect(cleaned.cleanupCounts.speech).toBeGreaterThan(0);
});
