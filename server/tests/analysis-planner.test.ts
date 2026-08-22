import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYSIS_MODULES } from '../../shared/ai';
import { BUSINESS_PAGE_NAMES } from '../../shared/dashboard';
import {
  ANALYSIS_METRICS,
  createDefaultAnalysisPlan,
} from '../src/domain/analysis-plan';
import { loadWorkbook } from '../src/data/workbook';
import {
  ANALYSIS_PLANNER_TIMEOUT_MS,
  planAnalysis,
} from '../src/services/analysis-planner';

const dataset = loadWorkbook(resolve('data/智慧污水处理厂_演示数据.xlsx'));
const settings = {
  apiKey: 'test-key-must-not-enter-prompt',
  baseUrl: 'https://deepseek.test',
  model: 'deepseek-chat',
};
const defaultPlan = createDefaultAnalysisPlan(dataset);

const moduleLabels = {
  overview: '运行总览',
  health: '健康指数得分',
  'water-quality': '出水水质',
  energy: '节能降耗',
  alerts: '告警',
} as const;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function completion(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

function invoke(fetchImpl: typeof fetch) {
  return planAnalysis({
    question: '请分析近期水质与能耗',
    page: 'water-quality',
    dataset,
    settings,
    fetchImpl,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('planAnalysis request', () => {
  it('sends a JSON-only allowlisted planning prompt and configured request body', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(_input).toBe('https://deepseek.test/chat/completions');
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      });

      const body = JSON.parse(String(init?.body)) as {
        model: string;
        temperature: number;
        response_format: { type: string };
        messages: Array<{ role: string; content: string }>;
      };
      expect(body).toMatchObject({
        model: 'deepseek-chat',
        temperature: 0,
        response_format: { type: 'json_object' },
      });
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');

      const prompt = body.messages[0].content;
      const dates = dataset.daily.map(({ date }) => date).sort();
      expect(prompt).toContain('请分析近期水质与能耗');
      expect(prompt).toContain(`water-quality (${BUSINESS_PAGE_NAMES['water-quality']})`);
      expect(prompt).toContain(dates[0]!);
      expect(prompt).toContain(dates.at(-1)!);
      expect(prompt).toContain('includeAlerts=true 时 modules 必须包含 alerts');
      expect(prompt).toContain('modules 包含 alerts 时 includeAlerts 必须为 true');
      expect(prompt).toContain('健康指标可以在 includeHealthWeights=false 时分析');
      for (const module of ANALYSIS_MODULES) {
        expect(prompt).toContain(`${module} (${moduleLabels[module]})`);
      }
      for (const [key, definition] of Object.entries(ANALYSIS_METRICS)) {
        expect(prompt).toContain(`"key":"${key}"`);
        expect(prompt).toContain(`"label":"${definition.label}"`);
        expect(prompt).toContain(`"unit":"${definition.unit}"`);
      }

      expect(prompt).not.toContain('/data/');
      expect(prompt).not.toContain('.xlsx');
      expect(prompt).not.toContain('DEEPSEEK_API_KEY');
      expect(prompt).not.toContain('DEEPSEEK_BASE_URL');
      expect(prompt).not.toContain('DEEPSEEK_MODEL');
      expect(prompt).not.toContain('Authorization');
      expect(prompt).not.toContain(settings.apiKey);
      expect(String(init?.body)).not.toContain(settings.apiKey);
      return completion(JSON.stringify(defaultPlan));
    });

    await expect(invoke(fetchMock as typeof fetch)).resolves.toEqual(defaultPlan);
  });

  it('redacts sensitive question content from the complete planner message array', async () => {
    const question = [
      '请分析水质，保留这段业务语义',
      '水质/能耗',
      'COD/TP/SS 趋势',
      '水质/能耗/费用综合分析',
      'mg/L',
      'mg/L/day',
      'kWh/m³',
      '2026/08/01-2026/08/09',
      'https://api.deepseek.com/v1/chat/completions',
      'https://service.example/report?api_key=url-secret&view=summary',
      'https://service.example/report?client_secret=url-client-secret&view=summary',
      'https://service.example/report?clientSecret=url-camel-secret&client%5Fsecret=url-encoded-secret',
      'https://operator:password@service.example/private',
      '/secret.txt',
      '/tmp',
      '/vault',
      '/custom',
      '/机密/报告',
      '/Users/operator/private/智慧污水处理厂_演示数据.xlsx',
      '/private/var/data/plant.xlsx',
      '/Volumes/Operations/plant-data.xlsm',
      '路径：/custom/tenant/report.csv',
      '紧邻中文/custom/tenant/report.csv',
      'C:\\Users\\operator\\Desktop\\daily.xlsx',
      'D:/vault/private/daily.xlsb',
      '\\\\fileserver\\private-share\\monthly.xlsx',
      '原始工作簿.xlsx',
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_BASE_URL',
      'DEEPSEEK_MODEL',
      'SERVICE_API_KEY=planner-secret',
      'API_KEY=bare-api-secret',
      'SECRET=bare-secret',
      'PASSWORD=bare-password',
      'password=lower-password',
      'api_key=lower-api-secret',
      'client_secret=lower-client-secret',
      'ｐａｓｓｗｏｒｄ=actualvalue123',
      '%70assword=actualvalue456',
      'ｃｌｉｅｎｔ＿ｓｅｃｒｅｔ=actualvalue789',
      'PASSWORD="actualvalue-quoted-1"',
      "api_key='actualvalue-quoted-2'",
      '{"password":"actualvalue-json-1"}',
      '{"client_secret":"actualvalue-\\"json-2"}',
      'sk-planner-secret-token',
      `Authorization: Bearer ${settings.apiKey}`,
    ].join('；');
    let messages: Array<{ role: string; content: string }> = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: typeof messages };
      messages = body.messages;
      return completion(JSON.stringify(defaultPlan));
    });

    await expect(planAnalysis({
      question,
      page: 'water-quality',
      dataset,
      settings,
      fetchImpl: fetchMock as typeof fetch,
    })).resolves.toEqual(defaultPlan);

    expect(messages).toEqual([{ role: 'user', content: expect.any(String) }]);
    const completeMessages = JSON.stringify(messages);
    expect(completeMessages).toContain('请分析水质，保留这段业务语义');
    for (const preservedText of [
      '水质/能耗',
      'COD/TP/SS 趋势',
      '水质/能耗/费用综合分析',
      'mg/L',
      'mg/L/day',
      'kWh/m³',
      '2026/08/01-2026/08/09',
      'https://api.deepseek.com/v1/chat/completions',
    ]) {
      expect(completeMessages).toContain(preservedText);
    }
    expect(completeMessages).toContain('[已脱敏]');
    for (const sensitiveText of [
      '/Users/operator/private',
      '/secret.txt',
      '/tmp',
      '/vault',
      '/custom',
      '/机密/报告',
      '/private/var/data',
      '/Volumes/Operations',
      '/custom/tenant',
      'C:\\\\Users\\\\operator',
      'D:/vault/private',
      '\\\\\\\\fileserver',
      '原始工作簿.xlsx',
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_BASE_URL',
      'DEEPSEEK_MODEL',
      'SERVICE_API_KEY',
      'planner-secret',
      'API_KEY',
      'bare-api-secret',
      'SECRET',
      'bare-secret',
      'PASSWORD',
      'bare-password',
      'lower-password',
      'lower-api-secret',
      'lower-client-secret',
      'actualvalue123',
      'actualvalue456',
      'actualvalue789',
      'actualvalue-',
      'actualvalue-quoted-1',
      'actualvalue-quoted-2',
      'actualvalue-json-1',
      'actualvalue-\\\\"json-2',
      'sk-planner-secret-token',
      'url-secret',
      'url-client-secret',
      'url-camel-secret',
      'url-encoded-secret',
      'operator:password',
      'Authorization',
      'Bearer',
      settings.apiKey,
    ]) {
      expect(completeMessages).not.toContain(sensitiveText);
    }
  });

  it.each([
    ['plain JSON', JSON.stringify(defaultPlan)],
    ['fenced JSON', `\n\`\`\`json\n${JSON.stringify(defaultPlan)}\n\`\`\`\n`],
  ])('parses a valid %s response through the strict analysis-plan parser', async (_label, content) => {
    const fetchImpl = vi.fn(async () => completion(content)) as typeof fetch;

    await expect(invoke(fetchImpl)).resolves.toEqual(defaultPlan);
  });
});

describe('planAnalysis fallback', () => {
  it.each([
    ['HTTP error', async () => new Response('private provider body', { status: 429 })],
    ['network error', async () => { throw new Error('socket failed'); }],
    ['non-JSON provider payload', async () => new Response('<html>bad gateway</html>', { status: 200 })],
    ['malformed provider shape', async () => jsonResponse({ choices: 'not-an-array' })],
    ['empty provider content', async () => completion('   ')],
    ['invalid plan JSON', async () => completion('{')],
    ['unknown plan field', async () => completion(JSON.stringify({ ...defaultPlan, workbookPath: '/private/data.xlsx' }))],
    ['unknown metric', async () => completion(JSON.stringify({ ...defaultPlan, metrics: [...defaultPlan.metrics, 'secretMetric'] }))],
  ])('returns the deterministic default for %s', async (_label, responder) => {
    const fetchImpl = vi.fn(responder) as unknown as typeof fetch;

    await expect(invoke(fetchImpl)).resolves.toEqual(defaultPlan);
  });

  it('does not log rejected raw plans, credentials, or local paths', async () => {
    const rawPlan = `rejected:${settings.apiKey}:/private/data/workbook.xlsx`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => completion(rawPlan)) as typeof fetch;

    await expect(invoke(fetchImpl)).resolves.toEqual(defaultPlan);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('aborts at exactly 15,000ms and returns the deterministic default', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const result = invoke(fetchMock as unknown as typeof fetch);
    expect(ANALYSIS_PLANNER_TIMEOUT_MS).toBe(15_000);
    expect(signal).toBeInstanceOf(AbortSignal);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(result).resolves.toEqual(defaultPlan);
  });

  it('forwards an external report cancellation signal to the planning request', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const pending = planAnalysis({
      question: '分析近期水质', page: 'water-quality', dataset, settings,
      fetchImpl: fetchMock as unknown as typeof fetch,
      signal: controller.signal,
    });

    expect(requestSignal?.aborted).toBe(false);
    controller.abort();

    expect(requestSignal?.aborted).toBe(true);
    await expect(pending).resolves.toEqual(defaultPlan);
  });
});
