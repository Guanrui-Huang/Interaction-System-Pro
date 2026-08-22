import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUSINESS_PAGE_NAMES, type DashboardDataset } from '../../shared/dashboard';
import {
  VOICE_DEEPSEEK_MAX_OUTPUT_TOKENS,
  VOICE_MAX_SPEECH_ANSWER_CHARS,
} from '../../shared/voice';
import {
  createDefaultAnalysisPlan,
  type AnalysisPlan,
} from '../src/domain/analysis-plan';
import { loadWorkbook } from '../src/data/workbook';
import {
  DEEPSEEK_ANSWER_TIMEOUT_MS,
  DEEPSEEK_TOTAL_TIMEOUT_MS,
  DeepSeekServiceError,
  answerQuestion,
} from '../src/services/deepseek';

const dataset = loadWorkbook(resolve('data/智慧污水处理厂_演示数据.xlsx'));
const settings = {
  apiKey: 'test-key-must-not-enter-prompt',
  baseUrl: 'https://deepseek.test',
  model: 'deepseek-reasoner-test',
};
const sortedDates = dataset.daily.map(({ date }) => date).sort((left, right) => left.localeCompare(right));
const plannedDates = sortedDates.slice(-3);
const validPlan: AnalysisPlan = {
  modules: ['water-quality', 'energy'],
  metrics: ['tn', 'kwhPerM3'],
  dateRange: { from: plannedDates[0]!, to: plannedDates.at(-1)! },
  methods: ['trend', 'correlation', 'summary'],
  includeAlerts: false,
  includeHealthWeights: false,
};
const securityPlan: AnalysisPlan = {
  ...validPlan,
  includeAlerts: true,
};

type CompletionRequest = {
  model: string;
  temperature: number;
  max_tokens?: number;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string };
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deepSeekResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

function requestAt(fetchMock: ReturnType<typeof vi.fn>, index: number): CompletionRequest {
  const call = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return JSON.parse(String(call[1]?.body)) as CompletionRequest;
}

async function flushAsyncWork(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
}

function datasetWithSecuritySentinels(): DashboardDataset {
  const outsidePlannedDate = sortedDates.at(-4)!;
  return {
    ...dataset,
    daily: dataset.daily.map((row) => ({
      ...row,
      ...(row.date === outsidePlannedDate ? { tn: 876_543.21 } : {}),
      ...(row.date === validPlan.dateRange.from ? { ammonia: 987_654.321 } : {}),
    })),
    alerts: [
      {
        date: validPlan.dateRange.from,
        metric: '总氮（TN）',
        level: '关注',
        reason: [
          '总氮波动需复核',
          '/Users/private/data/智慧污水处理厂_演示数据.xlsx',
          '路径:/srv/private/plant.xlsx',
          '另见/opt/plant/private.xlsx',
          'C:\\private\\data\\daily-report.xlsx',
          '另见D:\\vault\\private.xlsx',
          '\\\\fileserver\\private-share\\monthly-report.xlsx',
          '另见\\\\archive-server\\vault\\private.xlsx',
          '原始工作簿.xlsx',
          'DEEPSEEK_API_KEY',
          `Authorization: Bearer ${settings.apiKey}`,
        ].join('；'),
        recommendation: '建议检查进水负荷与加药记录；DEEPSEEK_BASE_URL；DEEPSEEK_MODEL；UEsDB-workbook-bytes',
      },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('answerQuestion orchestration', () => {
  it('calls planner then answer exactly once and sends only exact planned evidence to the answer', async () => {
    const secureDataset = datasetWithSecuritySentinels();
    const selectedSourceAlert = secureDataset.alerts[0]!;
    const providerAnswer = '结论：总氮与吨水电耗呈弱相关。统计关联不等于因果关系。';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(securityPlan)))
      .mockImplementationOnce(async () => {
        selectedSourceAlert.reason = '数据集在请求发出后被修改';
        return deepSeekResponse(providerAnswer);
      });
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(DEEPSEEK_TOTAL_TIMEOUT_MS - 1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let settingsReads = 0;
    const dependencies: Parameters<typeof answerQuestion>[1] = {
      fetchImpl: fetchMock as unknown as typeof fetch,
      now,
    };
    Object.defineProperty(dependencies, 'settings', {
      enumerable: true,
      get: () => {
        settingsReads += 1;
        return settings;
      },
    });

    const result = await answerQuestion(
      { question: '近三日总氮与吨水电耗是否相关？', page: 'water-quality', dataset: secureDataset },
      dependencies,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(settingsReads).toBe(1);
    expect(now).toHaveBeenCalledTimes(2);
    expect(requestAt(fetchMock, 0)).toMatchObject({
      model: settings.model,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    expect(requestAt(fetchMock, 1)).toMatchObject({
      model: settings.model,
      temperature: 0.2,
      max_tokens: VOICE_DEEPSEEK_MAX_OUTPUT_TOKENS,
    });
    expect(requestAt(fetchMock, 1)).not.toHaveProperty('response_format');

    expect(result.answer).toBe(providerAnswer);
    expect(result.analysisScope).toEqual({
      modules: ['water-quality', 'energy', 'alerts'],
      metrics: ['tn', 'kwhPerM3'],
      dateRange: validPlan.dateRange,
      sampleCount: 3,
      granularity: 'daily',
    });
    expect(result.citedMetrics).toEqual(['tn', 'kwhPerM3']);
    expect(result.analysisScope).toBe(result.evidence.scope);
    expect(result.citedMetrics).toBe(result.evidence.scope.metrics);
    expect(result.evidence.definitions).toEqual([
      { key: 'tn', label: '总氮（TN）', unit: 'mg/L', limit: 3 },
      { key: 'kwhPerM3', label: '吨水电耗', unit: 'kWh/m³' },
    ]);
    expect(result.evidence.series).toHaveLength(3);
    expect(result.evidence.caveat).toBe('统计关联不等于因果关系');
    expect(result.evidence.alerts).toHaveLength(1);
    expect(result.evidence.alerts[0]).toMatchObject({
      metric: '总氮（TN）',
      reason: expect.stringContaining('总氮波动需复核'),
      recommendation: expect.stringContaining('建议检查进水负荷与加药记录'),
    });
    expect(result.evidence.alerts[0]?.reason).not.toContain('数据集在请求发出后被修改');
    expect(result.evidence.alerts[0]?.reason).toContain('已脱敏');

    const answerPrompt = requestAt(fetchMock, 1).messages[0]!.content;
    const exactEvidence = JSON.stringify(result.evidence);
    expect(answerPrompt).toContain(`回答重点：${BUSINESS_PAGE_NAMES['water-quality']}`);
    expect(answerPrompt).not.toContain('来源页面');
    expect(answerPrompt).toContain(`AnalysisEvidence：${exactEvidence}`);
    expect(answerPrompt.match(/AnalysisEvidence：/g)).toHaveLength(1);
    expect(answerPrompt).toContain('结论、证据、风险、建议');
    expect(answerPrompt).toContain('单位');
    expect(answerPrompt).toContain('日期范围');
    expect(answerPrompt).toContain('所属模块');
    expect(answerPrompt).toContain('证据不足');
    expect(answerPrompt).toContain('无法确认');
    expect(answerPrompt).toContain('统计关联不等于因果关系');
    expect(answerPrompt).toContain('用户问题：近三日总氮与吨水电耗是否相关？');
    expect(answerPrompt).toContain('"modules":["water-quality","energy","alerts"]');
    expect(answerPrompt).toContain(`"dateRange":${JSON.stringify(validPlan.dateRange)}`);
    expect(answerPrompt).toContain('"sampleCount":3');
    expect(answerPrompt).toContain('"granularity":"daily"');

    expect(answerPrompt).not.toContain('"ammonia"');
    expect(answerPrompt).not.toContain('"processedM3"');
    expect(answerPrompt).not.toContain('876543.21');
    expect(answerPrompt).not.toContain('987654.321');
    expect(answerPrompt).toContain('总氮波动需复核');
    expect(answerPrompt).toContain('建议检查进水负荷与加药记录');
    expect(answerPrompt).not.toContain('/Users/private/data');
    expect(answerPrompt).not.toContain('/srv/private');
    expect(answerPrompt).not.toContain('/opt/plant');
    expect(answerPrompt).not.toContain('C:\\\\private');
    expect(answerPrompt).not.toContain('D:\\\\vault');
    expect(answerPrompt).not.toContain('\\\\\\\\fileserver');
    expect(answerPrompt).not.toContain('\\\\\\\\archive-server');
    expect(answerPrompt).not.toContain('.xlsx');
    expect(answerPrompt).not.toContain('UEsDB-workbook-bytes');
    expect(answerPrompt).not.toContain('DEEPSEEK_API_KEY');
    expect(answerPrompt).not.toContain('DEEPSEEK_BASE_URL');
    expect(answerPrompt).not.toContain('DEEPSEEK_MODEL');
    expect(answerPrompt).not.toContain('Authorization');
    expect(answerPrompt).not.toContain('Bearer');
    expect(answerPrompt).not.toContain(settings.apiKey);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.analysisScope)).toBe(true);
    expect(Object.isFrozen(result.citedMetrics)).toBe(true);
    expect(() => {
      result.citedMetrics.push('ammonia');
    }).toThrow(TypeError);
    expect(() => {
      result.analysisScope.modules.push('overview');
    }).toThrow(TypeError);
    expect(answerPrompt).toContain(`AnalysisEvidence：${exactEvidence}`);
  });

  it('rejects an answer above the shared speech boundary without silently truncating it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(validPlan)))
      .mockResolvedValueOnce(deepSeekResponse('甲'.repeat(VOICE_MAX_SPEECH_ANSWER_CHARS + 1)));

    await expect(answerQuestion(
      { question: '生成有界回答', page: 'overview', dataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch },
    )).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });

    expect(requestAt(fetchMock, 1)).toMatchObject({
      max_tokens: VOICE_DEEPSEEK_MAX_OUTPUT_TOKENS,
    });
  });

  it('redacts paths and secrets while byte-preserving business slashes, units, dates, and URLs in answer messages', async () => {
    const safeText = '水质/能耗；COD/TP/SS 趋势；水质/能耗/费用综合分析；mg/L；mg/L/day；kWh/m³；2026/08/01-2026/08/09；https://api.deepseek.com/v1/chat/completions';
    const question = [
      safeText,
      'https://service.example/report?access_token=url-answer-secret&view=summary',
      'https://service.example/report?client_secret=url-client-answer-secret&view=summary',
      'https://service.example/report?clientSecret=url-camel-answer-secret&client%5Fsecret=url-encoded-answer-secret',
      'https://operator:password@service.example/private',
      '/secret.txt',
      '/tmp',
      '/vault',
      '/custom',
      '/机密/报告',
      '/Users/operator/private/plant.xlsx',
      '/Volumes/Operations/plant-data.xlsm',
      '路径：/custom/tenant/report.csv',
      '紧邻中文/custom/tenant/report.csv',
      'C:\\Users\\operator\\Desktop\\daily.xlsx',
      'D:/vault/private/daily.xlsb',
      '\\\\fileserver\\private-share\\monthly.xlsx',
      '原始工作簿.xlsx',
      'DEEPSEEK_API_KEY=test-secret',
      'SERVICE_API_KEY=answer-secret',
      'API_KEY=bare-answer-api-secret',
      'SECRET=bare-answer-secret',
      'PASSWORD=bare-answer-password',
      'password=lower-answer-password',
      'api_key=lower-answer-api-secret',
      'client_secret=lower-answer-client-secret',
      'ｐａｓｓｗｏｒｄ=actualvalue123',
      '%70assword=actualvalue456',
      'ｃｌｉｅｎｔ＿ｓｅｃｒｅｔ=actualvalue789',
      'PASSWORD="actualvalue-quoted-1"',
      "api_key='actualvalue-quoted-2'",
      '{"password":"actualvalue-json-1"}',
      '{"client_secret":"actualvalue-\\"json-2"}',
      'sk-answer-secret-token',
      'Authorization: Bearer test-token',
    ].join('；');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(validPlan)))
      .mockResolvedValueOnce(deepSeekResponse('结论：证据已核验。'));

    await answerQuestion(
      { question, page: 'water-quality', dataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const messages = requestAt(fetchMock, 1).messages;
    const serializedMessages = JSON.stringify(messages);
    expect(serializedMessages).toContain(safeText);
    expect(serializedMessages).toContain('[已脱敏]');
    for (const sensitiveText of [
      '/Users/operator/private',
      '/secret.txt',
      '/tmp',
      '/vault',
      '/custom',
      '/机密/报告',
      '/Volumes/Operations',
      '/custom/tenant',
      'C:\\\\Users\\\\operator',
      'D:/vault/private',
      '\\\\\\\\fileserver',
      '原始工作簿.xlsx',
      'DEEPSEEK_API_KEY',
      'test-secret',
      'SERVICE_API_KEY',
      'answer-secret',
      'API_KEY',
      'bare-answer-api-secret',
      'SECRET',
      'bare-answer-secret',
      'PASSWORD',
      'bare-answer-password',
      'lower-answer-password',
      'lower-answer-api-secret',
      'lower-answer-client-secret',
      'actualvalue123',
      'actualvalue456',
      'actualvalue789',
      'actualvalue-',
      'actualvalue-quoted-1',
      'actualvalue-quoted-2',
      'actualvalue-json-1',
      'actualvalue-\\\\"json-2',
      'sk-answer-secret-token',
      'url-answer-secret',
      'url-client-answer-secret',
      'url-camel-answer-secret',
      'url-encoded-answer-secret',
      'operator:password',
      'Authorization',
      'Bearer',
      'test-token',
    ]) {
      expect(serializedMessages).not.toContain(sensitiveText);
    }
  });

  it('uses deterministic default evidence and still makes the answer call when planning falls back', async () => {
    const defaultPlan = createDefaultAnalysisPlan(dataset);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse('{invalid planner json'))
      .mockResolvedValueOnce(deepSeekResponse('结论：已按默认证据完成分析。'));
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(DEEPSEEK_TOTAL_TIMEOUT_MS - 1);

    const result = await answerQuestion(
      { question: '分析近期运行表现', page: 'overview', dataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch, now },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(now).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe('结论：已按默认证据完成分析。');
    expect(result.analysisScope.modules).toEqual(defaultPlan.modules);
    expect(result.analysisScope.metrics).toEqual(defaultPlan.metrics);
    expect(result.analysisScope.dateRange).toEqual(defaultPlan.dateRange);
    expect(result.citedMetrics).toEqual(defaultPlan.metrics);
    expect(requestAt(fetchMock, 1).messages[0]!.content)
      .toContain(`AnalysisEvidence：${JSON.stringify(result.evidence)}`);
  });

  it('maps NO_EVIDENCE with its available range and skips the answer call', async () => {
    const gapDataset: DashboardDataset = {
      ...dataset,
      daily: [
        { ...dataset.daily[0]!, date: '2026-01-01' },
        { ...dataset.daily[1]!, date: '2026-01-10' },
      ],
    };
    const gapPlan: AnalysisPlan = {
      modules: ['water-quality'],
      metrics: ['tn'],
      dateRange: { from: '2026-01-02', to: '2026-01-09' },
      methods: ['summary'],
      includeAlerts: false,
      includeHealthWeights: false,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(gapPlan)))
      .mockResolvedValueOnce(deepSeekResponse('此答案不应被请求。'));

    await expect(answerQuestion(
      { question: '分析空档期总氮', page: 'water-quality', dataset: gapDataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch },
    )).rejects.toMatchObject({
      name: 'DeepSeekServiceError',
      code: 'NO_EVIDENCE',
      message: 'NO_EVIDENCE',
      details: { availableDateRange: { from: '2026-01-01', to: '2026-01-10' } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('answerQuestion deadline', () => {
  it('forwards an external report cancellation signal to the active answer request', async () => {
    const controller = new AbortController();
    let answerSignal: AbortSignal | undefined;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(validPlan)))
      .mockImplementationOnce((_input: string | URL | Request, init?: RequestInit) => {
        answerSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          answerSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      });
    const pending = answerQuestion(
      { question: '分析近期关联', page: 'water-quality', dataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch, signal: controller.signal },
    );
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    await flushAsyncWork();

    expect(answerSignal?.aborted).toBe(false);
    controller.abort();

    expect(answerSignal?.aborted).toBe(true);
    await cancelled;
  });

  it('aborts a hanging answer call at the 90,000ms answer cap', async () => {
    vi.useFakeTimers();
    let answerSignal: AbortSignal | undefined;
    const now = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(101);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(validPlan)))
      .mockImplementationOnce((_input: string | URL | Request, init?: RequestInit) => {
        answerSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          answerSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      });

    const pending = answerQuestion(
      { question: '分析近期关联', page: 'water-quality', dataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch, now },
    );
    const timedOut = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    await flushAsyncWork();

    expect(DEEPSEEK_ANSWER_TIMEOUT_MS).toBe(90_000);
    expect(DEEPSEEK_TOTAL_TIMEOUT_MS).toBe(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(now).toHaveBeenCalledTimes(2);
    expect(answerSignal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(answerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(answerSignal?.aborted).toBe(true);
    await timedOut;
  });

  it('caps the answer timeout to the positive time remaining on the total deadline', async () => {
    vi.useFakeTimers();
    let answerSignal: AbortSignal | undefined;
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(105_001);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(validPlan)))
      .mockImplementationOnce((_input: string | URL | Request, init?: RequestInit) => {
        answerSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          answerSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      });

    const pending = answerQuestion(
      { question: '分析剩余时限', page: 'water-quality', dataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch, now },
    );
    const timedOut = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(now).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_998);
    expect(answerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(answerSignal?.aborted).toBe(true);
    await timedOut;
  });

  it('accounts for evidence and full prompt preparation before rejecting an exhausted deadline', async () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(validPlan)))
      .mockResolvedValueOnce(deepSeekResponse('此答案不应被请求。'));
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockImplementationOnce(() => {
        expect(stringify.mock.calls.some(([value]) => (
          Boolean(value && typeof value === 'object' && 'scope' in value)
        ))).toBe(true);
        return DEEPSEEK_TOTAL_TIMEOUT_MS;
      });

    await expect(answerQuestion(
      { question: '分析总时限', page: 'water-quality', dataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch, now },
    )).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('fails closed when an injected clock rolls backward instead of widening the budget', async () => {
    const now = vi.fn()
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(9_999);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(validPlan)))
      .mockResolvedValueOnce(deepSeekResponse('此答案不应被请求。'));

    await expect(answerQuestion(
      { question: '分析回拨时钟', page: 'water-quality', dataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch, now },
    )).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(2);
  });
});

describe('answerQuestion error compatibility', () => {
  it('returns a typed missing-configuration error without starting the planner', async () => {
    const fetchMock = vi.fn();

    await expect(answerQuestion(
      { question: '分析水质', page: 'overview', dataset },
      { settings: null, fetchImpl: fetchMock as unknown as typeof fetch },
    )).rejects.toMatchObject({ code: 'MISSING_CONFIGURATION' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an injected malformed dataset to MALFORMED_RESPONSE before the answer call', async () => {
    const malformedDataset: DashboardDataset = {
      ...dataset,
      daily: dataset.daily.map((row, index) => (
        index === 0 ? { ...row, date: '0000-01-01' } : row
      )),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(validPlan)))
      .mockResolvedValueOnce(deepSeekResponse('此答案不应被请求。'));

    await expect(answerQuestion(
      { question: '分析水质', page: 'water-quality', dataset: malformedDataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch },
    )).rejects.toMatchObject({
      name: 'DeepSeekServiceError',
      code: 'MALFORMED_RESPONSE',
      message: 'MALFORMED_RESPONSE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['non-OK response', async () => new Response('secret upstream body', { status: 429 }), 'UPSTREAM_HTTP'],
    ['non-JSON response', async () => new Response('<html>bad gateway</html>', { status: 200 }), 'MALFORMED_RESPONSE'],
    ['malformed response', async () => jsonResponse({ choices: 'not-an-array' }), 'MALFORMED_RESPONSE'],
    ['blank answer', async () => deepSeekResponse('   '), 'EMPTY_ANSWER'],
  ])('preserves %s mapping on the answer call', async (_label, answerResponse, code) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekResponse(JSON.stringify(validPlan)))
      .mockImplementationOnce(answerResponse);

    await expect(answerQuestion(
      { question: '分析水质', page: 'water-quality', dataset },
      { settings, fetchImpl: fetchMock as unknown as typeof fetch },
    )).rejects.toMatchObject({ code, message: code });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy client errors unchanged while supporting safe optional details', () => {
    const legacy = new DeepSeekServiceError('UPSTREAM_HTTP');
    const detailed = new DeepSeekServiceError('NO_EVIDENCE', {
      availableDateRange: { from: '2026-01-01', to: '2026-01-10' },
    });

    expect(legacy).toMatchObject({
      name: 'DeepSeekServiceError',
      code: 'UPSTREAM_HTTP',
      message: 'UPSTREAM_HTTP',
    });
    expect(legacy).not.toHaveProperty('details');
    expect(detailed).toMatchObject({
      name: 'DeepSeekServiceError',
      code: 'NO_EVIDENCE',
      message: 'NO_EVIDENCE',
      details: { availableDateRange: { from: '2026-01-01', to: '2026-01-10' } },
    });
  });
});
