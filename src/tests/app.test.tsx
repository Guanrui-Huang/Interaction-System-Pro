import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { WATER_QUALITY_METRICS } from '../../shared/dashboard';
import { App } from '../app/App';

vi.mock('../components/FloatingLines/FloatingLines.jsx', () => ({
  default: () => <div />,
}));

const point = {
  date: '2026-08-08', processedM3: 27800, informationCount: 1300000, complianceRate: 99.8,
  tn: 2.15, ammonia: 0.42, tp: 0.28, cod: 22.4, ss: 5.8, totalKwh: 12030,
  kwhPerM3: 0.436, blowerKwh: 4812, carbonEmissionKg: 343, carbonReductionKg: 51, savedYuan: 15800,
  qualityScore: 96, flowScore: 88, energyScore: 90, carbonSourceKg: 500, carbonSourceScore: 92,
};

function stubDashboardFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
    ok: true,
    json: async () => {
      const path = input.split('/').at(-1);
      if (path === 'water-quality') return {
        latest: point,
        trend: Array.from({ length: 30 }, () => point),
        alerts: [],
        metrics: WATER_QUALITY_METRICS,
      };
      if (path === 'energy') return {
        latest: point,
        trend: Array.from({ length: 30 }, () => point),
        costConfig: { electricityYuanPerKwh: .86, carbonSourceYuanPerKg: 4.2, electricitySavingsRate: .128 },
      };
      return {
        metrics: { informationCount: 1300000, operatingDays: 366, complianceRate: 99.8 },
        health: { weights: { quality: 0.4, flow: 0.2, energy: 0.25, carbonSource: 0.15 }, score: 92.3, grade: '优' },
        trend: Array.from({ length: 30 }, () => point),
        latest: point,
        alerts: [],
      };
    },
  })));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('renders the Chinese dashboard brand', () => {
  render(<App />);
  expect(screen.getByText('智慧污水处理厂')).toBeInTheDocument();
});

it('enters the overview shell after the visual login action', async () => {
  const user = userEvent.setup();
  stubDashboardFetch();

  render(<App />);
  await user.click(screen.getByRole('button', { name: '进入智慧中枢' }));

  expect(screen.getByTestId('floating-lines-background')).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: '运行总览' })).toBeInTheDocument();
});

it('keeps four business navigation items and returns to the page that opened AI', async () => {
  const user = userEvent.setup();
  stubDashboardFetch();

  render(<App />);
  await user.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  const navigation = screen.getByRole('navigation', { name: '主导航' });

  expect(within(navigation).getAllByRole('button')).toHaveLength(4);
  expect(within(navigation).queryByText('AI 交互')).not.toBeInTheDocument();

  for (const page of ['运行总览', '健康指数得分', '出水水质', '节能降耗']) {
    await user.click(within(navigation).getByRole('button', { name: page }));
    expect(screen.getAllByRole('button', { name: '唤起 AI 运营助手' })).toHaveLength(1);
  }

  await user.click(screen.getByRole('button', { name: '唤起 AI 运营助手' }));

  expect(screen.getByRole('heading', { name: 'AI 智慧指挥中心' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '关闭 AI 助手' }));
  expect(await screen.findByText('累计节省费用')).toBeInTheDocument();
  expect(within(navigation).getByRole('button', { name: '节能降耗' })).toHaveAttribute('aria-current', 'page');
});

it('automatically rotates the information screens every ten seconds', async () => {
  vi.useFakeTimers();
  stubDashboardFetch();
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole('heading', { name: '运行总览' })).toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByRole('heading', { name: '健康指数得分' })).toBeInTheDocument();
});

it('pauses the carousel while AI is open and restores the originating business page', async () => {
  vi.useFakeTimers();
  stubDashboardFetch();
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole('button', { name: '节能降耗' }));
  fireEvent.click(screen.getByRole('button', { name: '唤起 AI 运营助手' }));

  expect(screen.getByRole('heading', { name: 'AI 智慧指挥中心' })).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(screen.getByRole('heading', { name: 'AI 智慧指挥中心' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '关闭 AI 助手' }));
  await act(async () => {
    await Promise.resolve();
  });
  const restoredNavigation = screen.getByRole('navigation', { name: '主导航' });
  expect(screen.getByText('累计节省费用')).toBeInTheDocument();
  expect(within(restoredNavigation).getByRole('button', { name: '节能降耗' })).toHaveAttribute('aria-current', 'page');
});

it('moves focus into the AI dialog and restores it to the shared trigger on close', async () => {
  const user = userEvent.setup();
  stubDashboardFetch();
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const trigger = screen.getByRole('button', { name: '唤起 AI 运营助手' });
  trigger.focus();
  await user.keyboard('{Enter}');

  expect(screen.getByRole('dialog', { name: 'AI 智慧指挥中心' })).toHaveAttribute('aria-modal', 'true');
  const closeButton = screen.getByRole('button', { name: '关闭 AI 助手' });
  expect(closeButton).toHaveFocus();
  await user.keyboard('{Enter}');

  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole('button', { name: '唤起 AI 运营助手' })).toHaveFocus();
});

it('closes the AI dialog with Escape and restores focus to the originating trigger', async () => {
  const user = userEvent.setup();
  stubDashboardFetch();
  render(<App />);

  await user.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  const trigger = await screen.findByRole('button', { name: '唤起 AI 运营助手' });
  await user.click(trigger);
  expect(screen.getByRole('dialog', { name: 'AI 智慧指挥中心' })).toBeInTheDocument();

  await user.keyboard('{Escape}');

  expect(screen.queryByRole('dialog', { name: 'AI 智慧指挥中心' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '唤起 AI 运营助手' })).toHaveFocus();
});

function reportSnapshot(reportId: string) {
  return {
    reportId,
    question: '分析总氮趋势',
    originPage: 'water-quality',
    scope: {
      modules: ['water-quality'], metrics: ['tn'],
      dateRange: { from: '2026-07-01', to: '2026-07-31' }, sampleCount: 31, granularity: 'daily',
    },
    status: 'generating',
    outline: [{
      id: 'slide-1', order: 0, title: '总氮趋势', purpose: '说明趋势',
      visualKind: 'kpi-grid', evidenceKeys: ['tn'], status: 'ready',
    }],
    slides: [{
      id: 'slide-1', order: 0, title: '总氮趋势', takeaway: '总氮保持稳定。',
      visual: { kind: 'kpi-grid', metrics: [{
        key: 'tn', kind: 'metric', source: 'excel', module: 'water-quality', label: '总氮', unit: 'mg/L', value: 2.4,
      }] },
      metrics: [{ key: 'tn', kind: 'metric', source: 'excel', module: 'water-quality', label: '总氮', unit: 'mg/L', value: 2.4 }],
      evidenceRefs: [{ key: 'tn', kind: 'metric', source: 'excel', module: 'water-quality', label: '总氮', unit: 'mg/L' }],
      narration: [
        { id: 'segment-1', text: '第一段。', speechId: 'speech-1' },
        { id: 'segment-2', text: '第二段。', speechId: 'speech-2' },
      ],
    }],
    conversation: { originalQuestion: '分析总氮趋势', turns: [], compactSummary: '', activeSlideId: 'slide-1' },
    createdAt: '2026-08-12T00:00:00.000Z', expiresAt: '2026-08-12T01:00:00.000Z', lastSequence: 0,
  };
}

it('restores report mode from the URL after refresh without showing demo login', async () => {
  const reportId = '00000000-0000-4000-8000-000000000001';
  window.history.replaceState(null, '', `/?reportId=${reportId}`);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/events')
    ? new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } })
    : new Response(JSON.stringify(reportSnapshot(reportId)), { headers: { 'Content-Type': 'application/json' } })));

  render(<App />);

  expect(await screen.findByRole('main', { name: 'AI 动态汇报工作区' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '进入智慧中枢' })).not.toBeInTheDocument();
});

it('switches to a creating report shell before the create request settles', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/ai/reports') return new Promise<Response>(() => {});
    const path = url.split('/').at(-1);
    if (path === 'water-quality') return {
      ok: true,
      json: async () => ({
        latest: point,
        trend: Array.from({ length: 30 }, () => point),
        alerts: [],
        metrics: WATER_QUALITY_METRICS,
      }),
    } as Response;
    if (path === 'energy') return {
      ok: true,
      json: async () => ({
        latest: point,
        trend: Array.from({ length: 30 }, () => point),
        costConfig: { electricityYuanPerKwh: .86, carbonSourceYuanPerKg: 4.2, electricitySavingsRate: .128 },
      }),
    } as Response;
    return {
      ok: true,
      json: async () => ({
        metrics: { informationCount: 1300000, operatingDays: 366, complianceRate: 99.8 },
        health: { weights: { quality: 0.4, flow: 0.2, energy: 0.25, carbonSource: 0.15 }, score: 92.3, grade: '优' },
        trend: Array.from({ length: 30 }, () => point),
        latest: point,
        alerts: [],
      }),
    } as Response;
  }));
  const { container } = render(<App />);
  await user.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  await user.click(await screen.findByRole('button', { name: '唤起 AI 运营助手' }));
  await user.type(screen.getByLabelText('请输入需要分析的问题'), '分析总氮趋势');
  await user.click(screen.getByRole('button', { name: '生成动态汇报' }));

  expect(screen.getByRole('main', { name: 'AI 动态汇报工作区' })).toHaveTextContent('正在创建动态汇报');
  expect(screen.getByRole('region', { name: '汇报对话区' })).toHaveTextContent('分析总氮趋势');
  expect(container.querySelector('.report-thumbnail-rail')).not.toBeNull();
  expect(container.querySelector('[data-slide-state="pending"][data-slide-mode="canvas"]')).not.toBeNull();
  expect(screen.queryByRole('dialog', { name: 'AI 智慧指挥中心' })).not.toBeInTheDocument();
});

it('clears reportId from the URL when leaving a restored report', async () => {
  const reportId = '00000000-0000-4000-8000-000000000001';
  window.history.replaceState(null, '', `/?reportId=${reportId}`);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/events')) return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.endsWith(reportId) && url.includes('/reports/')) return new Response(JSON.stringify(reportSnapshot(reportId)), { headers: { 'Content-Type': 'application/json' } });
    return new Response(null, { status: 204 });
  }));
  const user = userEvent.setup();
  render(<App />);

  await user.click(await screen.findByRole('button', { name: '退出汇报' }));

  expect(new URL(window.location.href).searchParams.has('reportId')).toBe(false);
  expect(screen.getByRole('heading', { name: 'AI 智慧指挥中心' })).toBeInTheDocument();
});

it('shows focused recovery UI when a restored report is expired', async () => {
  const reportId = '00000000-0000-4000-8000-000000000001';
  window.history.replaceState(null, '', `/?reportId=${reportId}`);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    code: 'REPORT_NOT_FOUND', message: 'server detail',
  }), { status: 404, headers: { 'Content-Type': 'application/json' } })));
  const user = userEvent.setup();
  render(<App />);

  expect(await screen.findByRole('alert')).toHaveTextContent('汇报不存在或已过期');
  await user.click(screen.getByRole('button', { name: '返回 AI 提问' }));

  expect(screen.getByRole('heading', { name: 'AI 智慧指挥中心' })).toBeInTheDocument();
  expect(new URL(window.location.href).searchParams.has('reportId')).toBe(false);
});
