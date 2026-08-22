import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { METRIC_DEFINITIONS } from '../../shared/dashboard';
import type { EnergyData } from '../app/api';
import { EnergyPage } from '../features/dashboard/EnergyPage';
import { HealthPage } from '../features/dashboard/HealthPage';
import { BarTrend } from '../charts/BarTrend';
import { CHART_THEME } from '../charts/chart-theme';
import { EnergyCostBars } from '../charts/EnergyCostBars';
import { HealthRing } from '../charts/HealthRing';
import { TrendArea } from '../charts/TrendArea';
import { OverviewPage } from '../features/dashboard/OverviewPage';
import { WaterQualityPage } from '../features/dashboard/WaterQualityPage';
import { useDashboardEntrance } from '../motion/useDashboardEntrance';

const SHARED_CHART_COLORS = [
  CHART_THEME.trend.start,
  CHART_THEME.trend.end,
  CHART_THEME.ring.start,
  CHART_THEME.ring.end,
  CHART_THEME.bars[0].start,
  CHART_THEME.bars[0].end,
  CHART_THEME.bars[1].start,
  CHART_THEME.bars[1].end,
];

vi.mock('../motion/useDashboardEntrance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../motion/useDashboardEntrance')>();
  return { ...actual, useDashboardEntrance: vi.fn(actual.useDashboardEntrance) };
});

const points = Array.from({ length: 30 }, (_, index) => ({
  date: `2026-08-${String(index + 1).padStart(2, '0')}`,
  processedM3: 18200 + index * 10,
  informationCount: 1280 + index,
  complianceRate: 99.4,
  tn: METRIC_DEFINITIONS.tn.threshold - 2.8 + index * 0.02,
  ammonia: 0.72,
  tp: 0.31,
  cod: 26.4,
  ss: 5.8,
  totalKwh: 7800,
  kwhPerM3: 0.43,
  blowerKwh: 2600,
  carbonEmissionKg: 520,
  carbonReductionKg: 60,
  savedYuan: 3260 + index * 12,
  qualityScore: 96,
  flowScore: 88,
  energyScore: 92,
  carbonSourceKg: 340,
  carbonSourceScore: 90,
}));

const health = {
  score: 92.5,
  grade: '优',
  weights: { quality: 0.4, flow: 0.2, energy: 0.25, carbonSource: 0.15 },
};

const waterTrend = points.map((point, index) => ({
  ...point,
  tn: index === 12 ? METRIC_DEFINITIONS.tn.threshold + .8 : point.tn,
}));

const waterMetrics = {
  tn: { label: '总氮（TN）', unit: 'mg/L', threshold: 3 },
  ammonia: { label: '氨氮（运行）', unit: 'mg-N/L', threshold: 1.5 },
  tp: { label: '总磷', unit: 'mg/L', threshold: .5 },
  cod: { label: 'COD', unit: 'mg/L', threshold: 50 },
  ss: { label: '悬浮物', unit: 'mg/L', threshold: 10 },
};

const energyStart = new Date(Date.UTC(2025, 7, 9));
const energyTrend = Array.from({ length: 366 }, (_, index) => {
  const date = new Date(energyStart);
  date.setUTCDate(date.getUTCDate() + index);
  return {
    ...points[0]!,
    date: date.toISOString().slice(0, 10),
    processedM3: 2_000,
    totalKwh: 1_000,
    kwhPerM3: .5,
    blowerKwh: 400,
    carbonSourceKg: 50,
    carbonReductionKg: 10,
    savedYuan: 100,
  };
});

const responses: Record<string, unknown> = {
  overview: { metrics: { informationCount: 1309, operatingDays: 365, complianceRate: 99.4 }, health, trend: points },
  health: { health, trend: points },
  'water-quality': {
    latest: points.at(-1),
    trend: waterTrend,
    metrics: waterMetrics,
    alerts: [{ date: '2026-08-29', metric: '总氮（TN）', level: '关注', reason: '进水负荷短时升高', recommendation: '建议复核曝气量与碳源投加' }],
  },
  energy: {
    latest: energyTrend.at(-1)!,
    trend: energyTrend,
    costConfig: { electricityYuanPerKwh: .86, carbonSourceYuanPerKg: 4.2, electricitySavingsRate: .128 },
  },
};

function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: reduced
      ? query === '(prefers-reduced-motion: reduce)'
      : query === '(prefers-reduced-motion: no-preference)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

it('keeps the health progress arc crisp above a separate glow layer', async () => {
  stubReducedMotion(true);
  render(<HealthRing score={93} />);
  const chart = await screen.findByLabelText('健康指数 93');
  await waitFor(() => {
    expect(chart.querySelector('.health-ring-glow')).toHaveAttribute('filter');
    expect(chart.querySelector('.health-ring-progress')).not.toHaveAttribute('filter');
    expect(chart.querySelector('.health-ring-progress')?.getAttribute('fill')).toMatch(/^url\(#health-ring-gradient-/);
    expect(Array.from(chart.querySelectorAll('linearGradient[id^="health-ring-gradient-"] stop')).map((stop) => stop.getAttribute('stop-color'))).toEqual(['#24E4C1', '#35A9FF']);
    expect(chart.querySelector('.health-ring-score')).toHaveAttribute('data-motion-value', '93');
    expect(chart.querySelector('.health-ring-score')).toHaveTextContent('93');
  });
});

const dashboardPages = [
  { path: 'overview', heading: '运行总览', Component: OverviewPage },
  { path: 'health', heading: '健康指数得分', Component: HealthPage },
  { path: 'water-quality', heading: '出水水质', Component: WaterQualityPage },
  { path: 'energy', heading: '节能降耗', Component: EnergyPage },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  stubReducedMotion(true);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/').at(-1) ?? '';
    return new Response(JSON.stringify(responses[path]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

type MotionNumberExpectation = {
  value: string;
  format: 'integer' | 'one-decimal' | 'two-decimal';
  text: string;
};

const pageMotionCases = [
  {
    heading: '运行总览',
    Component: OverviewPage,
    cardCount: 5,
    numbers: [
      { value: '18490', format: 'integer', text: '18,490' },
      { value: '365', format: 'integer', text: '365' },
      { value: '99.4', format: 'one-decimal', text: '99.4' },
    ],
  },
  { heading: '健康指数得分', Component: HealthPage, cardCount: 3, numbers: [] },
  {
    heading: '出水水质',
    Component: WaterQualityPage,
    cardCount: 3,
    numbers: [
      { value: '0.7800000000000001', format: 'two-decimal', text: '0.78' },
      { value: '0.72', format: 'two-decimal', text: '0.72' },
      { value: '0.31', format: 'two-decimal', text: '0.31' },
      { value: '26.4', format: 'two-decimal', text: '26.40' },
      { value: '5.8', format: 'two-decimal', text: '5.80' },
      { value: '0.72', format: 'two-decimal', text: '0.72' },
      { value: '0.31', format: 'two-decimal', text: '0.31' },
      { value: '26.4', format: 'two-decimal', text: '26.40' },
      { value: '5.8', format: 'two-decimal', text: '5.80' },
      { value: '1', format: 'integer', text: '1' },
    ],
  },
  {
    heading: '节能降耗',
    Component: EnergyPage,
    cardCount: 5,
    numbers: [
      { value: '900', format: 'integer', text: '900' },
      { value: '1.152', format: 'two-decimal', text: '1.15' },
      { value: '0.09', format: 'two-decimal', text: '0.09' },
      { value: '900', format: 'integer', text: '900' },
    ],
  },
] as const satisfies ReadonlyArray<{
  heading: string;
  Component: () => React.JSX.Element | null;
  cardCount: number;
  numbers: readonly MotionNumberExpectation[];
}>;

it.each(pageMotionCases)('$heading exposes a completed scoped entrance with exact counter formatting', async ({ heading, Component, cardCount, numbers }) => {
  stubReducedMotion(true);
  render(<Component />);

  const pageHeading = await screen.findByRole('heading', { name: heading });
  const root = pageHeading.closest<HTMLElement>('[data-dashboard-motion-root]');
  expect(root).not.toBeNull();
  expect(root).toHaveAttribute('data-motion-complete', 'true');
  expect(root?.querySelectorAll('[data-motion-card]')).toHaveLength(cardCount);

  const motionNumbers = Array.from(root?.querySelectorAll<HTMLElement>('[data-motion-number]') ?? []);
  expect(motionNumbers).toHaveLength(numbers.length);
  motionNumbers.forEach((node, index) => {
    const expected = numbers[index]!;
    expect(Number.isFinite(Number(node.dataset.motionValue))).toBe(true);
    expect(node).toHaveAttribute('data-motion-value', expected.value);
    expect(node).toHaveAttribute('data-motion-format', expected.format);
    expect(node).toHaveTextContent(expected.text);
  });
});

it('updates energy counter values and replays the scoped entrance for period changes', async () => {
  stubReducedMotion(true);
  const user = userEvent.setup();
  render(<EnergyPage />);

  const selector = await screen.findByRole('group', { name: '节能统计周期' });
  const root = document.querySelector<HTMLElement>('[data-dashboard-motion-root]');
  expect(Array.from(root?.querySelectorAll<HTMLElement>('[data-motion-number]') ?? [], (node) => node.dataset.motionValue)).toEqual(['900', '1.152', '0.09', '900']);
  expect(vi.mocked(useDashboardEntrance).mock.calls.at(-1)?.[1]).toEqual(['success', 'month']);

  await user.click(within(selector).getByRole('button', { name: '累计' }));

  expect(Array.from(root?.querySelectorAll<HTMLElement>('[data-motion-number]') ?? [], (node) => node.dataset.motionValue)).toEqual(['3.66', '46.848', '3.66', '3.66']);
  expect(vi.mocked(useDashboardEntrance).mock.calls.at(-1)?.[1]).toEqual(['success', 'all']);
  expect(root).toHaveAttribute('data-motion-complete', 'true');
});

it.each(dashboardPages)('$heading shows an accessible failure and retry recovers', async ({ path, heading, Component }) => {
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new Error('dashboard unavailable'))
    .mockResolvedValueOnce(new Response(JSON.stringify(responses[path]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<Component />);

  expect(await screen.findByRole('alert')).toHaveTextContent('运行数据加载失败');
  expect(useDashboardEntrance).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '重新加载' }));
  expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('renders the dense overview KPIs and health ring from the dashboard API', async () => {
  render(<OverviewPage />);

  expect(await screen.findByText('今日处理量')).toBeInTheDocument();
  expect(screen.getByText('安全运行')).toBeInTheDocument();
  expect(await screen.findByText('水质达标率')).toBeInTheDocument();
  const healthRing = await screen.findByLabelText('健康指数 93');
  await waitFor(() => expect(healthRing).toBeInTheDocument());
  expect(fetch).toHaveBeenCalledWith('/api/dashboard/overview', expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it('keeps the four exact dimensions inside the overview health panel', async () => {
  render(<OverviewPage />);

  const panel = await screen.findByLabelText('系统健康指数');
  expect(within(panel).getByText('出水水质')).toBeInTheDocument();
  expect(within(panel).getByText('水量波动')).toBeInTheDocument();
  expect(within(panel).getByText('电耗')).toBeInTheDocument();
  expect(within(panel).getByText('碳源消耗')).toBeInTheDocument();
  expect(within(panel).getByText('40%')).toBeInTheDocument();
  expect(within(panel).getByText('20%')).toBeInTheDocument();
  expect(within(panel).getByText('25%')).toBeInTheDocument();
  expect(within(panel).getByText('15%')).toBeInTheDocument();
  expect(screen.queryByText('健康维度分析')).not.toBeInTheDocument();
});

it('groups the overview health ring and status for upward visual alignment', async () => {
  render(<OverviewPage />);

  const panel = await screen.findByLabelText('系统健康指数');
  const visual = panel.querySelector('.overview-health__visual');
  expect(visual).toBeInTheDocument();
  expect(visual?.querySelector('.health-ring')).toBeInTheDocument();
  expect(visual?.querySelector('.ring-status')).toHaveTextContent('优 · 运行稳态');
});

it.each([OverviewPage, HealthPage])('renders four shared animated health dimension meters', async (Page) => {
  render(<Page />);

  await screen.findByText('出水水质');
  expect(document.querySelectorAll('[data-health-dimension-meter]')).toHaveLength(4);
  expect(document.querySelectorAll('[data-dimension-fill]')).toHaveLength(4);
  expect(document.querySelectorAll('[data-dimension-tip]')).toHaveLength(4);
  expect(document.querySelectorAll('[data-dimension-score]')).toHaveLength(4);
});

it('renders the accessible 30-day health trend with the required D3 glow layers', async () => {
  render(<OverviewPage />);

  const chart = await screen.findByLabelText('近30日健康趋势图');
  await waitFor(() => {
    expect(chart).toHaveAttribute('data-layout', 'wide');
    expect(chart.querySelector('.trend-plot')).toHaveAttribute('transform', 'translate(0, 0)');
    expect(chart.querySelector('.trend-glow')).toBeInTheDocument();
    expect(chart.querySelector('.trend-glow')).toHaveAttribute('stroke-dasharray');
    expect(chart.querySelector('.trend-line')).toHaveAttribute('stroke-width', '4');
    expect(chart.querySelector('.trend-line')).toHaveAttribute('stroke-dasharray');
    expect(chart.querySelector('.trend-line')).not.toHaveAttribute('pathLength');
    expect(chart.querySelector('.trend-area-fill')).toBeInTheDocument();
    expect(chart.querySelector('.trend-current-dot')).toBeInTheDocument();
    expect(chart.querySelector('.trend-current-dot')).toHaveAttribute('data-terminal', 'true');
    const revealClip = chart.querySelector<SVGClipPathElement>('clipPath[id^="trend-reveal-"]');
    expect(revealClip).toBeInTheDocument();
    expect(revealClip?.querySelector('.trend-reveal-clip')).toHaveAttribute('data-reveal-axis', 'x');
    expect(chart.querySelector('.trend-area-fill')).toHaveAttribute('clip-path', `url(#${revealClip?.id})`);
    expect(chart.querySelector('.trend-current-dot')).toHaveAttribute('clip-path', `url(#${revealClip?.id})`);
    const revealRect = revealClip?.querySelector<SVGRectElement>('.trend-reveal-clip');
    const terminalHalo = chart.querySelector<SVGCircleElement>('.trend-current-halo');
    const revealRight = Number(revealRect?.getAttribute('x')) + Number(revealRect?.getAttribute('width'));
    const terminalRight = Number(terminalHalo?.getAttribute('cx')) + Number(terminalHalo?.getAttribute('r'));
    expect(revealRight).toBeGreaterThanOrEqual(terminalRight);
    expect(chart.querySelector('linearGradient')).toBeInTheDocument();
    expect(Array.from(chart.querySelectorAll('linearGradient[id^="trend-line-gradient-"] stop, linearGradient[id^="trend-area-gradient-"] stop')).map((stop) => stop.getAttribute('stop-color'))).toEqual([
      '#21F4B7',
      '#27C8FF',
      '#21F4B7',
      '#27C8FF',
    ]);
  });
});

it('keeps reveal definitions unique when multiple trend charts share a page', async () => {
  render(<div>
    <TrendArea ariaLabel="first trend" points={points} metric={{ label: 'first', unit: '分', value: (point) => point.qualityScore }} />
    <TrendArea ariaLabel="second trend" points={points} metric={{ label: 'second', unit: '分', value: (point) => point.energyScore }} />
  </div>);

  const charts = await Promise.all([screen.findByLabelText('first trend'), screen.findByLabelText('second trend')]);
  const revealIds = charts.map((chart) => chart.querySelector('clipPath[id^="trend-reveal-"]')?.id);
  expect(revealIds.every(Boolean)).toBe(true);
  expect(new Set(revealIds).size).toBe(2);
  charts.forEach((chart, index) => {
    expect(chart.querySelector('.trend-area-fill')).toHaveAttribute('clip-path', `url(#${revealIds[index]})`);
  });
});

it.each([
  { name: '总览健康趋势', Component: OverviewPage, label: '近30日健康趋势图' },
  { name: '总氮趋势', Component: WaterQualityPage, label: '总氮（TN）趋势图' },
  { name: '节省费用趋势', Component: EnergyPage, label: '节省费用趋势图' },
])('$name uses the shared horizontal line-and-area reveal', async ({ Component, label }) => {
  render(<Component />);

  const chart = await screen.findByLabelText(label);
  await waitFor(() => {
    const revealClip = chart.querySelector<SVGClipPathElement>('clipPath[id^="trend-reveal-"]');
    expect(revealClip).toBeInTheDocument();
    expect(revealClip?.querySelector('.trend-reveal-clip')).toHaveAttribute('data-reveal-axis', 'x');
    expect(chart.querySelector('.trend-area-fill')).toHaveAttribute('clip-path', `url(#${revealClip?.id})`);
    expect(chart.querySelector('.trend-line')).toHaveAttribute('stroke-dasharray');
    expect(chart.querySelector('.trend-line')).not.toHaveAttribute('pathLength');
  });
});

it.each([
  { name: '总氮趋势', Component: WaterQualityPage, label: '总氮（TN）趋势图' },
  { name: '节省费用趋势', Component: EnergyPage, label: '节省费用趋势图' },
])('$name keeps the real dashboard page on the shared trend gradient', async ({ Component, label }) => {
  render(<Component />);

  const chart = await screen.findByLabelText(label);
  await waitFor(() => {
    const lineStops = Array.from(chart.querySelectorAll('linearGradient[id^="trend-line-gradient-"] stop')).map((stop) => stop.getAttribute('stop-color'));
    const areaStops = Array.from(chart.querySelectorAll('linearGradient[id^="trend-area-gradient-"] stop')).map((stop) => stop.getAttribute('stop-color'));
    expect(lineStops).toEqual([CHART_THEME.trend.start, CHART_THEME.trend.end]);
    expect(areaStops).toEqual([CHART_THEME.trend.start, CHART_THEME.trend.end]);
  });
});

it('honors a supplied color in the trend line and area gradients', async () => {
  render(<TrendArea ariaLabel="自定义颜色趋势图" points={points} metric={{ label: '自定义指标', unit: '分', value: (point) => point.qualityScore, color: '#ff6b35' }} />);

  const chart = await screen.findByLabelText('自定义颜色趋势图');
  await waitFor(() => {
    const lineGradient = chart.querySelector('linearGradient[id^="trend-line-gradient"]');
    const areaGradient = chart.querySelector('linearGradient[id^="trend-area-gradient"]');
    expect(Array.from(lineGradient?.querySelectorAll('stop') ?? []).map((stop) => stop.getAttribute('stop-color'))).toEqual(['#ff6b35', '#ff6b35']);
    expect(areaGradient?.querySelector('stop')).toHaveAttribute('stop-color', '#ff6b35');
    expect(chart.querySelector('.trend-area-fill')).toHaveAttribute('fill', `url(#${areaGradient?.getAttribute('id')})`);
  });
});

it('renders the Stitch health score page with the four exact weighted dimensions', async () => {
  render(<HealthPage />);

  expect(await screen.findByRole('heading', { name: '健康指数得分' })).toBeInTheDocument();
  expect(screen.getByText('出水水质')).toBeInTheDocument();
  expect(screen.getByText('水量波动')).toBeInTheDocument();
  expect(screen.getByText('电耗')).toBeInTheDocument();
  expect(screen.getByText('碳源消耗')).toBeInTheDocument();
  expect(screen.getByText('40%')).toBeInTheDocument();
  expect(screen.getByText('20%')).toBeInTheDocument();
  expect(screen.getByText('25%')).toBeInTheDocument();
  expect(screen.getByText('15%')).toBeInTheDocument();
  expect(screen.queryByText('处理流量')).not.toBeInTheDocument();
  expect(screen.queryByText('能效水平')).not.toBeInTheDocument();
  expect(screen.queryByText('碳源投加')).not.toBeInTheDocument();
  const periodGroup = screen.getByRole('group', { name: '健康趋势周期' });
  expect(within(periodGroup).getByRole('button', { name: '30日' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(periodGroup).getByRole('button', { name: '90日' })).toHaveAttribute('aria-pressed', 'false');
  expect(within(periodGroup).getByRole('button', { name: '180日' })).toHaveAttribute('aria-pressed', 'false');
  const healthRing = await screen.findByLabelText('健康指数 93');
  await waitFor(() => expect(healthRing).toBeInTheDocument());
  expect(screen.getByLabelText('近30日健康指数柱状趋势')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith('/api/dashboard/health', expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it('renders accessible gradient bars with threshold, risk markers and unique paint IDs', async () => {
  render(<><BarTrend points={points} /><BarTrend points={points.slice(-3).map((point) => ({ ...point, qualityScore: 80, flowScore: 80, energyScore: 80, carbonSourceScore: 80 }))} /></>);

  const [healthyChart, riskChart] = await screen.findAllByLabelText('近30日健康指数柱状趋势');
  await waitFor(() => {
    expect(healthyChart.querySelector('.bar-threshold')).toHaveAttribute('stroke-dasharray', '5 5');
    expect(healthyChart.querySelector('.bar-threshold-label')).toHaveTextContent('优良线 90');
    expect(healthyChart.querySelector('.bar-trend-gradient')).toBeInTheDocument();
    expect(healthyChart.querySelector('.bar-trend-glow')).toBeInTheDocument();
    expect(healthyChart.querySelector('.bar-trend-latest')).toHaveAttribute('data-latest', 'true');
    expect(healthyChart.querySelectorAll('[data-motion-bar="true"]')).toHaveLength(30);
    expect(riskChart.querySelectorAll('[data-risk="true"]')).toHaveLength(3);
    expect(riskChart.querySelector('.bar-trend-risk-gradient')).toBeInTheDocument();
    const healthyGradient = healthyChart.querySelector('linearGradient')?.getAttribute('id');
    const riskGradient = riskChart.querySelector('linearGradient')?.getAttribute('id');
    expect(healthyGradient).toBeTruthy();
    expect(riskGradient).toBeTruthy();
    expect(healthyGradient).not.toBe(riskGradient);
  });
});

it('renders water-quality threshold and warning content from the dashboard API', async () => {
  render(<WaterQualityPage />);

  expect(await screen.findByText('总氮（TN）')).toBeInTheDocument();
  expect(screen.getByText('达标阈值 3 mg/L')).toBeInTheDocument();
  await waitFor(() => {
    const thresholdLine = screen.getByLabelText('总氮（TN）趋势图').querySelector('.trend-threshold');
    const alertDot = screen.getByLabelText('总氮（TN）趋势图').querySelector('.trend-alert-dot');
    expect(Number(thresholdLine?.getAttribute('y1'))).toBeGreaterThanOrEqual(18);
    expect(Number(thresholdLine?.getAttribute('y1'))).toBeLessThanOrEqual(306);
    expect(thresholdLine).toHaveAttribute('stroke', CHART_THEME.trend.alert);
    expect(screen.getByLabelText('总氮（TN）趋势图').querySelector('.trend-threshold-label')).toHaveAttribute('fill', CHART_THEME.trend.alert);
    expect(alertDot).toHaveAttribute('fill', CHART_THEME.trend.alert);
    expect(alertDot).toHaveAttribute('stroke', CHART_THEME.trend.alert);
  });
  expect(screen.getByText('预警日志')).toBeInTheDocument();
  expect(screen.getByText('进水负荷短时升高')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: '预警自动播放' })).toHaveAttribute('aria-live', 'polite');
  expect(fetch).toHaveBeenCalledWith('/api/dashboard/water-quality', expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it('uses API metric metadata for collaborative water-quality readings', async () => {
  render(<WaterQualityPage />);

  const collaborative = await screen.findByLabelText('协同指标');
  expect(within(collaborative).getByText('氨氮（运行）')).toBeInTheDocument();
  expect(collaborative).toHaveTextContent('mg-N/L');
});

it('renders the Task 5 water-quality content and anomaly marker from the API fixture', async () => {
  render(<WaterQualityPage />);

  expect(await screen.findByRole('heading', { name: '出水水质' })).toBeInTheDocument();
  expect(screen.getByText('实时监测中')).toBeInTheDocument();
  expect(screen.getByText('24 小时均值')).toBeInTheDocument();
  expect(document.querySelectorAll('.quality-metric-grid > div')).toHaveLength(4);
  expect(screen.getByLabelText('新增预警数量')).toHaveTextContent('1');
  await waitFor(() => expect(document.querySelectorAll('.trend-alert-dot')).toHaveLength(1));
  expect(screen.queryByRole('button', { name: '唤起 AI 运营助手' })).not.toBeInTheDocument();
});

it('updates every energy section from the selected period', async () => {
  const user = userEvent.setup();
  render(<EnergyPage />);

  const selector = await screen.findByRole('group', { name: '节能统计周期' });
  expect(within(selector).getAllByRole('button').map((button) => button.textContent)).toEqual(['本月', '近一个月', '全年累计', '累计']);
  expect(within(selector).getByRole('button', { name: '本月' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('energy-date-range')).toHaveTextContent('2026-08-01—2026-08-09');
  expect(screen.getByTestId('saved-yuan-value')).toHaveTextContent('900');

  await user.click(within(selector).getByRole('button', { name: '累计' }));

  expect(screen.getByTestId('energy-date-range')).toHaveTextContent('2025-08-09—2026-08-09');
  expect(screen.getByTestId('saved-yuan-value')).toHaveTextContent('3.66 万元');
  expect(screen.getByLabelText('能耗与对应费用柱状图')).toHaveTextContent('146,400 kWh');
  expect(screen.getByLabelText('节省费用趋势图')).toHaveAttribute('data-point-count', '13');
  expect(screen.queryByText(/优化对比|基线与 AI 控制|AI 优化控制/)).not.toBeInTheDocument();
});

it('renders consumption and cost bars with separate values and units', async () => {
  const values = [{
    key: 'blower' as const,
    label: '风机能耗（电耗）',
    consumption: { value: 4321, unit: 'kWh', ratio: .72 },
    cost: { value: 3716.06, unit: '元', ratio: .64 },
  }];
  render(<EnergyCostBars values={values} />);

  const chart = await screen.findByLabelText('能耗与对应费用柱状图');
  await waitFor(() => {
    const consumptionBar = chart.querySelector('[data-series="consumption"].energy-cost-bar');
    const consumptionLabel = chart.querySelector('.energy-cost-value--consumption');
    expect(chart.querySelectorAll('.energy-cost-bar-glow')).toHaveLength(2);
    expect(chart.querySelector('.energy-cost-bar')).not.toHaveAttribute('filter');
    expect(chart.querySelector('.energy-cost-bar-glow')).toHaveAttribute('filter');
    expect(consumptionLabel).toHaveAttribute('data-series', 'consumption');
    expect(Number(consumptionLabel?.getAttribute('x'))).toBeCloseTo(
      Number(consumptionBar?.getAttribute('x')) + Number(consumptionBar?.getAttribute('width')) / 2,
    );
    expect(consumptionLabel?.querySelectorAll('tspan')).toHaveLength(2);
    expect(chart.querySelector('.energy-cost-value--cost')?.querySelectorAll('tspan')).toHaveLength(2);
    expect(chart).toHaveTextContent('4,321 kWh');
    expect(chart).toHaveTextContent('3,716.06 元');
    expect(Array.from(chart.querySelectorAll('linearGradient stop')).map((stop) => stop.getAttribute('stop-color'))).toEqual([
      '#1689DC',
      '#2CE4F5',
      '#19BFA0',
      '#42F0C7',
    ]);
  });
  expect(screen.queryByText('AI 优化控制')).not.toBeInTheDocument();
});

it('keeps the shared dashboard chart colors aligned across rings, trends, and energy bars', async () => {
  render(<>
    <HealthRing score={93} />
    <TrendArea ariaLabel="shared colors trend" points={points} metric={{ label: 'shared colors', unit: '分', value: (point) => point.qualityScore }} />
    <EnergyCostBars values={[{
      key: 'blower' as const,
      label: '风机能耗（电耗）',
      consumption: { value: 4321, unit: 'kWh', ratio: .72 },
      cost: { value: 3716.06, unit: '元', ratio: .64 },
    }]} />
  </>);

  await screen.findByLabelText('健康指数 93');
  const colors = Array.from(document.querySelectorAll('linearGradient stop')).map((stop) => stop.getAttribute('stop-color'));
  expect(colors).toEqual(expect.arrayContaining(SHARED_CHART_COLORS));
});

it('formats large raw-yuan values as 万元 in both the KPI and cost chart', async () => {
  render(<EnergyPage />);

  expect(await screen.findByTestId('saved-yuan-value')).toHaveTextContent('900 元');
  const selector = screen.getByRole('group', { name: '节能统计周期' });
  await userEvent.click(within(selector).getByRole('button', { name: '累计' }));

  expect(screen.getByTestId('saved-yuan-value')).toHaveTextContent('3.66 万元');
  const chart = screen.getByLabelText('能耗与对应费用柱状图');
  expect(chart.querySelector('.energy-cost-value--consumption')).toHaveTextContent('146,400 kWh');
  expect(chart.querySelector('.energy-cost-value--cost')).toHaveTextContent('12.59 万元');
});

it('retains consumption, renders only affected costs as dashes, and logs the invalid config key', async () => {
  const validEnergy = responses.energy as EnergyData;
  const invalidEnergy = {
    ...validEnergy,
    costConfig: {
      ...validEnergy.costConfig,
      electricityYuanPerKwh: undefined as unknown as number,
    },
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(invalidEnergy), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  render(<EnergyPage />);

  const chart = await screen.findByLabelText('能耗与对应费用柱状图');
  await waitFor(() => expect(chart.querySelectorAll('.energy-cost-value--cost')).toHaveLength(3));
  expect(chart).toHaveTextContent('3,600 kWh');
  expect(Array.from(chart.querySelectorAll('.energy-cost-value--cost')).map((label) => label.textContent)).toEqual(['--', '--', '1,890 元']);
  expect(error).toHaveBeenCalledWith(
    'ENERGY_COST_CONFIG_INVALID',
    expect.objectContaining({ key: 'electricityYuanPerKwh' }),
  );
  error.mockRestore();
});

it('renders an explicit empty-period state without zero KPIs, bars, or a curve', async () => {
  stubReducedMotion(false);
  const emptyEnergy = { ...(responses.energy as EnergyData), trend: [] };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(emptyEnergy), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));

  render(<EnergyPage />);

  expect(await screen.findAllByText('当前周期暂无数据')).not.toHaveLength(0);
  expect(screen.getAllByTestId(/-value$/)).toHaveLength(3);
  expect(screen.getAllByTestId(/-value$/).map((value) => value.textContent?.trim())).toEqual(['--', '--', '--']);
  expect(useDashboardEntrance).not.toHaveBeenCalled();
  expect(screen.getByText('节能降耗').closest('[data-dashboard-motion-root]')).toHaveAttribute('data-motion-complete', 'true');
  expect(document.querySelectorAll('[data-motion-number]')).toHaveLength(0);
  expect(document.querySelectorAll('.energy-cost-bar')).toHaveLength(0);
  expect(document.querySelector('.energy-growth .trend-line')).not.toBeInTheDocument();
});

it('renders a safe empty state for all non-finite trend values without NaN geometry', async () => {
  render(<TrendArea ariaLabel="finite-only trend" points={[{ ...points[0], qualityScore: Number.NaN }, { ...points[1], qualityScore: Number.POSITIVE_INFINITY }]} metric={{ label: 'finite-only', unit: 'points', value: (point) => point.qualityScore }} />);
  const chart = await screen.findByLabelText('finite-only trend');
  expect(await screen.findByText('暂无有效趋势数据')).toBeInTheDocument();
  await waitFor(() => expect(Array.from(chart.querySelectorAll('*')).every((element) => Array.from(element.attributes).every((attribute) => !attribute.value.includes('NaN')))).toBe(true));
});

it('renders a finite trend path when invalid points are mixed with valid points', async () => {
  render(<TrendArea ariaLabel="mixed finite trend" points={[{ ...points[0], qualityScore: Number.NaN }, { ...points[1], qualityScore: 91 }, { ...points[2], qualityScore: Number.POSITIVE_INFINITY }, { ...points[3], qualityScore: 94 }]} metric={{ label: 'mixed', unit: 'points', value: (point) => point.qualityScore }} />);
  const chart = await screen.findByLabelText('mixed finite trend');
  await waitFor(() => { expect(chart.querySelector('.trend-line')?.getAttribute('d')).not.toContain('NaN'); expect(chart.querySelector('.trend-line')?.getAttribute('d')).toBeTruthy(); });
});
