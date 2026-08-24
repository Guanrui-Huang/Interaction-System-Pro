import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { BoundMetric, ReportEvidenceRef, ReportSlide, VisualSpec } from '../../shared/report';
import { VISUAL_KINDS } from '../../shared/report';
import { ReportEvidenceDrawer } from '../features/ai/report/ReportEvidenceDrawer';
import { ReportSlideView } from '../features/ai/report/ReportSlideView';
import { summaryGridForMetricCount } from '../features/ai/report/visuals/DataDashboardVisual';
import { ReportVisualErrorBoundary } from '../features/ai/report/visuals/ReportVisualErrorBoundary';
import { emphasizeRadarRatios } from '../features/ai/report/visuals/RadarVisual';
import { VisualRenderer } from '../features/ai/report/visuals/VisualRenderer';

const reportStyles = readFileSync(resolve(process.cwd(), 'src/styles/ai.css'), 'utf8');

const metric = (key = 'tn', label = '总氮', value = 2.4, unit = 'mg/L'): BoundMetric => ({
  key,
  kind: 'metric',
  source: 'excel',
  snapshotId: 'snapshot-1',
  module: 'water-quality',
  label,
  unit,
  value,
  dateRange: { from: '2026-07-01', to: '2026-07-31' },
  sampleCount: 31,
  claimIds: ['claim-1'],
});

const evidence = (key = 'tn', label = '总氮', unit = 'mg/L'): ReportEvidenceRef => ({
  key,
  kind: 'metric',
  source: 'excel',
  snapshotId: 'snapshot-1',
  module: 'water-quality',
  label,
  unit,
  dateRange: { from: '2026-07-01', to: '2026-07-31' },
  sampleCount: 31,
});

function visualFixture(kind: typeof VISUAL_KINDS[number]): VisualSpec {
  switch (kind) {
    case 'kpi-grid':
      return { kind, metrics: [metric()] };
    case 'trend-line':
    case 'trend-area':
      return { kind, series: [{ key: 'tn', label: '总氮', unit: 'mg/L', snapshotId: 'snapshot-1', claimIds: ['claim-1'], points: [{ label: '07-01', value: 2.2 }, { label: '07-31', value: 2.4 }] }] };
    case 'comparison-bars':
      return { kind, items: [metric('tn', '总氮', 2.4), metric('tp', '总磷', 0.3)] };
    case 'health-ring':
      return { kind, metric: metric('health', '运行健康度', 92, '分'), target: 95 };
    case 'radar':
      return { kind, axes: [{ key: 'stable', label: '稳定性', value: 92, maximum: 100, unit: '分', snapshotId: 'snapshot-1', claimIds: ['claim-1'] }, { key: 'energy', label: '能效', value: 81, maximum: 100, unit: '分', snapshotId: 'snapshot-1', claimIds: ['claim-1'] }, { key: 'quality', label: '水质', value: 95, maximum: 100, unit: '分', snapshotId: 'snapshot-1', claimIds: ['claim-1'] }] };
    case 'scatter':
      return {
        kind,
        x: { ...evidence('flow', '处理量', 'm³/d'), claimIds: ['claim-1'] },
        y: { ...evidence('energy', '单位能耗', 'kWh/m³'), claimIds: ['claim-1'] },
        points: [{ label: '07-01', x: 2100, y: .31, claimIds: ['claim-1'] }, { label: '07-31', x: 2300, y: .28, claimIds: ['claim-1'] }],
        caveat: '统计关联不等于因果关系',
      };
    case 'alert-timeline':
      return { kind, items: [{ id: 'alert-1', date: '2026-07-18', level: '中', label: '氨氮波动', detail: '两小时内恢复。', snapshotId: 'snapshot-1', claimIds: ['claim-1'] }] };
    case 'process-flow':
    case 'recommendation-path':
      return { kind, provenance: 'model-knowledge', steps: [{ id: 'step-1', title: '复核曝气', detail: '核对风机频率与溶解氧。', claimIds: ['claim-1'] }] };
    case 'concept-map':
      return {
        kind,
        nodes: [
          { id: 'opaque-source-id', title: '进水总氮长周期波动与多因素协同控制', detail: '需结合来水负荷、水温与碳源变化综合判断', claimIds: ['claim-1'] },
          { id: 'opaque-process-id', title: '生物脱氮过程稳定性', detail: '反映硝化与反硝化协同效果', claimIds: ['claim-1'] },
          { id: 'opaque-outcome-id', title: '出水总氮达标裕度', detail: '体现最终风险缓冲空间', claimIds: ['claim-1'] },
        ],
        edges: [
          { from: 'opaque-source-id', to: 'opaque-process-id', label: '影响负荷', claimIds: ['claim-1'] },
          { from: 'opaque-process-id', to: 'opaque-outcome-id', claimIds: ['claim-1'] },
        ],
      };
    case 'capability-map':
      return { kind, items: [{ id: 'capability-1', title: '跨周期水质趋势识别与异常根因辅助判断', detail: '结合长时序变化、告警节点与运行工况识别值班人员需要复核的关键环节', claimIds: ['claim-1'] }] };
    case 'data-dashboard':
      return dataDashboardFixture();
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function dataDashboardFixture(overrides: Partial<Extract<VisualSpec, { kind: 'data-dashboard' }>> = {}): Extract<VisualSpec, { kind: 'data-dashboard' }> {
  return {
    kind: 'data-dashboard',
    summaryMetrics: [metric('tn', '总氮', 2.4), metric('ammonia', '氨氮', 0.5)],
    primary: {
      kind: 'trend-area',
      series: [{
        key: 'tn',
        label: '总氮',
        unit: 'mg/L',
        snapshotId: 'snapshot-1',
        claimIds: ['claim-1'],
        points: [{ label: '07-01', value: 2.2 }, { label: '07-31', value: 2.4 }],
      }],
    },
    supporting: [
      { kind: 'comparison-bars', items: [metric('tn', '总氮', 2.4), metric('ammonia', '氨氮', 0.5)] },
      { kind: 'health-ring', metric: metric('health', '运行健康度', 92, '分'), target: 100 },
    ],
    ...overrides,
  };
}

function slideFixture(overrides: Partial<ReportSlide> = {}): ReportSlide {
  return {
    id: 'slide-1',
    order: 0,
    evidenceSnapshotId: 'snapshot-1', role: 'answer', layout: 'visual-focus', evidencePolicy: 'data',
    title: '总氮趋势',
    takeaway: '总氮保持稳定。',
    takeawayClaimIds: ['claim-1'],
    claims: [{ id: 'claim-1', text: '总氮保持稳定。', kind: 'onsite-fact', evidenceRefs: [evidence()] }],
    visual: visualFixture('trend-line'),
    metrics: [metric()],
    evidenceRefs: [evidence()],
    narration: [
      { id: 'segment-1', text: '第一段。', speechId: 'speech-1', claimIds: ['claim-1'] },
      { id: 'segment-2', text: '第二段。', speechId: 'speech-2', claimIds: ['claim-1'] },
    ],
    ...overrides,
  };
}

it('uses the approved shared gradients and globally unique SVG IDs across report charts', () => {
  const { container } = render(<>
    <VisualRenderer visual={{
      kind: 'trend-area',
      series: [
        {
          key: 'tn',
          label: '总氮',
          unit: 'mg/L',
          snapshotId: 'snapshot-1',
          claimIds: ['claim-1'],
          points: [{ label: '07-01', value: 2.2 }, { label: '07-15', value: 2.5 }, { label: '07-31', value: 2.4 }],
        },
        {
          key: 'tp',
          label: '总磷',
          unit: 'mg/L',
          snapshotId: 'snapshot-1',
          claimIds: ['claim-1'],
          points: [{ label: '07-01', value: 0.22 }, { label: '07-15', value: 0.28 }, { label: '07-31', value: 0.25 }],
        },
      ],
    }} mode="canvas" />
    <VisualRenderer visual={visualFixture('comparison-bars')} mode="canvas" />
    <VisualRenderer visual={visualFixture('health-ring')} mode="canvas" />
  </>);

  expect(Array.from(container.querySelectorAll('linearGradient stop')).map((stop) => stop.getAttribute('stop-color')))
    .toEqual(expect.arrayContaining(['#1689DC', '#2CE4F5', '#19BFA0', '#42F0C7', '#24E4C1', '#35A9FF']));
  expect(new Set(Array.from(container.querySelectorAll('[id]')).map(({ id }) => id)).size)
    .toBe(container.querySelectorAll('[id]').length);
});

it('distinguishes multi-series trends with controlled gradients and an accessible visual legend', () => {
  const { container } = render(<VisualRenderer visual={{
    kind: 'trend-area',
    series: [
      {
        key: 'tn', label: '总氮', unit: 'mg/L', snapshotId: 'snapshot-1', claimIds: ['claim-1'],
        points: [{ label: '07-01', value: 2.2 }, { label: '07-31', value: 2.4 }],
      },
      {
        key: 'ammonia', label: '氨氮', unit: 'mg/L', snapshotId: 'snapshot-1', claimIds: ['claim-1'],
        points: [{ label: '07-01', value: 0.42 }, { label: '07-31', value: 0.5 }],
      },
      {
        key: 'tp', label: '总磷', unit: 'mg/L', snapshotId: 'snapshot-1', claimIds: ['claim-1'],
        points: [{ label: '07-01', value: 0.22 }, { label: '07-31', value: 0.25 }],
      },
    ],
  }} mode="canvas" />);

  const lineGradients = Array.from(container.querySelectorAll<SVGLinearGradientElement>('linearGradient[id^="report-trend-line-"]'));
  const stopColors = (gradient: SVGLinearGradientElement) => (
    Array.from(gradient.querySelectorAll('stop'), (stop) => stop.getAttribute('stop-color'))
  );
  expect(lineGradients.map(stopColors)).toEqual([
    ['#1689DC', '#2CE4F5'],
    ['#19BFA0', '#42F0C7'],
    ['#0A9FA8', '#47D9D1'],
  ]);
  expect(new Set(lineGradients.map(({ id }) => id)).size).toBe(lineGradients.length);

  const legend = screen.getByRole('list', { name: '趋势序列图例' });
  expect(within(legend).getByText('总氮')).toBeVisible();
  expect(within(legend).getByText('氨氮')).toBeVisible();
  expect(within(legend).getByText('总磷')).toBeVisible();
});

it('renders wide adaptive bars with stable theme diagnostics', () => {
  const items = [
    metric('qualityScore', '出水水质得分', 96, '分'),
    metric('energyScore', '电耗得分', 90, '分'),
    metric('tn', '总氮（TN）', 1.96),
    metric('ammonia', '氨氮', .38),
    metric('tp', '总磷', .29),
    metric('cod', 'COD', 22.26),
    metric('ss', '悬浮物', 6.44),
  ];
  const { container } = render(<VisualRenderer visual={{ kind: 'comparison-bars', items }} mode="canvas" />);
  const bars = [...container.querySelectorAll<SVGRectElement>('.report-chart__bar')];

  expect(bars).toHaveLength(7);
  expect(new Set(bars.map((bar) => bar.dataset.barTheme)).size).toBe(7);
  expect(Number(bars[0]?.getAttribute('width'))).toBeGreaterThan(40);
});

it('assigns different bar themes to separate carbon metrics in the same chart', () => {
  const { container } = render(<VisualRenderer visual={{
    kind: 'comparison-bars',
    items: [
      metric('carbonEmission', '碳排放量', 18.2, 't'),
      metric('carbonReduction', '碳减排量', 4.6, 't'),
    ],
  }} mode="canvas" />);
  const carbonBars = Array.from(container.querySelectorAll<SVGRectElement>('.report-chart__bar[data-metric-key]'));

  expect(carbonBars).toHaveLength(2);
  expect(carbonBars[0]?.dataset.barTheme).not.toBe(carbonBars[1]?.dataset.barTheme);
});

it('renders metric status in a dedicated card status slot', () => {
  const compliant = { ...metric('tn', '总氮', 2.4), status: '达标' };
  const { container } = render(
    <VisualRenderer visual={dataDashboardFixture({ summaryMetrics: [compliant] })} mode="canvas" />,
  );

  const card = container.querySelector('.report-data-dashboard__metric');
  expect(card?.querySelector('dt')).toHaveTextContent('总氮');
  expect(card?.querySelector('dd')).toHaveTextContent('2.4');
  expect(card?.querySelector('.report-data-dashboard__metric-status')).toHaveTextContent('达标');
});

it('uses the same seven semantic themes for trend series and fills only the primary series', () => {
  const items = [
    metric('qualityScore', '出水水质得分', 96, '分'),
    metric('energyScore', '电耗得分', 90, '分'),
    metric('tn', '总氮（TN）', 1.96),
    metric('ammonia', '氨氮', .38),
    metric('tp', '总磷', .29),
    metric('cod', 'COD', 22.26),
    metric('ss', '悬浮物', 6.44),
  ];
  const series = items.map((item) => ({
    key: item.key,
    label: item.label,
    unit: item.unit ?? '',
    snapshotId: item.snapshotId,
    claimIds: item.claimIds,
    points: [{ label: '2025-08', value: item.value * .96 }, { label: '2026-08', value: item.value }],
  }));
  const { container } = render(<VisualRenderer visual={{ kind: 'trend-area', series }} mode="canvas" />);
  const lines = [...container.querySelectorAll<SVGPathElement>('.report-chart__line[data-series-theme]')];

  expect(lines).toHaveLength(7);
  expect(new Set(lines.map((line) => line.dataset.seriesTheme)).size).toBe(7);
  expect(container.querySelectorAll('.report-chart__area')).toHaveLength(1);
});

it.each(VISUAL_KINDS)('renders registered visual %s without raw markup injection', (kind) => {
  const { container } = render(<VisualRenderer visual={visualFixture(kind)} mode="canvas" />);
  const graphics = screen.getAllByRole('img');

  expect(graphics.length).toBeGreaterThan(0);
  for (const graphic of graphics) {
    expect(graphic).toHaveAccessibleName(/.+/);
  }
  expect(container.querySelector('script, style, iframe')).toBeNull();
  expect(container.innerHTML).not.toContain('dangerouslySetInnerHTML');
});

it('renders a metric strip, one primary chart and at most two supporting charts', () => {
  const visual = visualFixture('data-dashboard');
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);

  expect(container.querySelectorAll('.report-data-dashboard__metric')).toHaveLength(2);
  expect(container.querySelectorAll('.report-data-dashboard__primary [role="img"]')).toHaveLength(1);
  expect(container.querySelectorAll('.report-data-dashboard__support [role="img"]')).toHaveLength(2);
});

it('renders atomic kpi-grid directly without empty dashboard chrome', () => {
  const { container } = render(<VisualRenderer visual={visualFixture('kpi-grid')} mode="canvas" />);

  expect(container.querySelector('.report-kpi-grid')).not.toBeNull();
  expect(container.querySelector('.report-data-dashboard--atomic-kpi')).toBeNull();
  expect(container.querySelector('[data-dashboard-support-empty]')).toBeNull();
});

it('shares one ordered palette across dashboard trend and comparison visuals without duplicate bar colors', () => {
  const visual = dataDashboardFixture({
    summaryMetrics: [
      metric('quality', '出水水质得分', 96, '分'),
      metric('energy', '电耗得分', 90, '分'),
    ],
    primary: {
      kind: 'trend-area',
      series: [
        {
          key: 'quality',
          label: '出水水质得分',
          unit: '分',
          snapshotId: 'snapshot-1',
          claimIds: ['claim-1'],
          points: [{ label: '07-01', value: 94 }, { label: '07-31', value: 96 }],
        },
        {
          key: 'energy',
          label: '电耗得分',
          unit: '分',
          snapshotId: 'snapshot-1',
          claimIds: ['claim-1'],
          points: [{ label: '07-01', value: 88 }, { label: '07-31', value: 90 }],
        },
      ],
    },
    supporting: [{
      kind: 'comparison-bars',
      items: [
        metric('quality', '出水水质得分', 96, '分'),
        metric('energy', '电耗得分', 90, '分'),
        metric('carbonEmission', '碳排放量', 18.2, 't'),
        metric('carbonReduction', '碳减排量', 4.6, 't'),
      ],
    }],
  });
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);
  const qualityLine = container.querySelector<SVGPathElement>('.report-chart__line[data-metric-key="quality"]');
  const energyLine = container.querySelector<SVGPathElement>('.report-chart__line[data-metric-key="energy"]');
  const bars = Array.from(container.querySelectorAll<SVGRectElement>('.report-chart__bar[data-metric-key]'));
  const qualityBar = container.querySelector<SVGRectElement>('.report-chart__bar[data-metric-key="quality"]');
  const energyBar = container.querySelector<SVGRectElement>('.report-chart__bar[data-metric-key="energy"]');

  expect(qualityLine?.dataset.seriesTheme).toBe(qualityBar?.dataset.barTheme);
  expect(energyLine?.dataset.seriesTheme).toBe(energyBar?.dataset.barTheme);
  expect(qualityLine?.dataset.seriesTheme).toBe('water');
  expect(energyLine?.dataset.seriesTheme).toBe('treatment');
  expect(new Set(bars.map((bar) => bar.dataset.barTheme)).size).toBe(bars.length);
});

it.each([
  { count: 7, columns: 7, rows: 1 },
  { count: 8, columns: 8, rows: 1 },
  { count: 9, columns: 5, rows: 2 },
  { count: 10, columns: 6, rows: 2 },
  { count: 11, columns: 7, rows: 2 },
  { count: 12, columns: 7, rows: 2 },
  { count: 13, columns: 8, rows: 2 },
  { count: 16, columns: 8, rows: 2 },
])('balances $count metrics as $columns columns', ({ count, columns, rows }) => {
  expect(summaryGridForMetricCount(count)).toEqual({ columns, rows });
});

it.each([
  { count: 7, columns: '7', rows: '1' },
  { count: 8, columns: '8', rows: '1' },
])('renders $count summary metrics with the balanced row layout', ({ count, columns, rows }) => {
  const metrics = Array.from({ length: count }, (_, index) => metric(`metric-${index}`, `指标 ${index + 1}`, 90 + index, '分'));
  const { container } = render(<VisualRenderer visual={dataDashboardFixture({ summaryMetrics: metrics })} mode="canvas" />);
  const dashboard = container.querySelector<HTMLElement>('.report-data-dashboard')!;
  const summary = container.querySelector<HTMLElement>('.report-data-dashboard__metrics')!;

  expect(container.querySelectorAll('.report-data-dashboard__metric')).toHaveLength(count);
  expect(summary.style.getPropertyValue('--report-summary-columns')).toBe(columns);
  expect(dashboard).toHaveAttribute('data-summary-columns', columns);
  expect(dashboard).toHaveAttribute('data-summary-rows', rows);
});

it('promotes comparison bars to the larger supporting slot', () => {
  const visual = dataDashboardFixture({
    supporting: [
      { kind: 'health-ring', metric: metric('health', '运行健康度', 92, '分'), target: 100 },
      { kind: 'comparison-bars', items: [metric('tn', '总氮', 2.4), metric('ammonia', '氨氮', 0.5)] },
    ],
  });
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);
  const panels = Array.from(container.querySelectorAll<HTMLElement>('.report-data-dashboard__support > section'));

  expect(panels.map((panel) => panel.dataset.panelKind)).toEqual(['comparison-bars', 'health-ring']);
});

it('uses large-screen chart viewboxes for bars, radar, and ring visuals', () => {
  const { container: bars } = render(<VisualRenderer visual={visualFixture('comparison-bars')} mode="canvas" />);
  const { container: radar } = render(<VisualRenderer visual={visualFixture('radar')} mode="canvas" />);
  const { container: ring } = render(<VisualRenderer visual={visualFixture('health-ring')} mode="canvas" />);

  expect(bars.querySelector('.report-chart--bars')).toHaveAttribute('viewBox', '0 0 720 320');
  expect(radar.querySelector('.report-chart--radar')).toHaveAttribute('viewBox', '0 0 360 360');
  expect(ring.querySelector('.report-chart--ring')).toHaveAttribute('viewBox', '0 0 240 240');
});

it('keeps long radar axis labels inside the viewBox by anchoring edge labels inward', () => {
  const radarWithEdgeLabels: Extract<VisualSpec, { kind: 'radar' }> = {
    kind: 'radar',
    axes: [
      { key: 'north', label: '运行稳定性综合评分', value: 92, maximum: 100, unit: '分', snapshotId: 'snapshot-1', claimIds: ['claim-1'] },
      { key: 'east', label: '曝气效率与能耗平衡能力', value: 81, maximum: 100, unit: '分', snapshotId: 'snapshot-1', claimIds: ['claim-1'] },
      { key: 'south', label: '出水达标裕度', value: 95, maximum: 100, unit: '分', snapshotId: 'snapshot-1', claimIds: ['claim-1'] },
      { key: 'west', label: '来水负荷波动适应能力', value: 88, maximum: 100, unit: '分', snapshotId: 'snapshot-1', claimIds: ['claim-1'] },
    ],
  };
  const { container } = render(<VisualRenderer visual={radarWithEdgeLabels} mode="canvas" />);
  const labels = Array.from(container.querySelectorAll<SVGTextElement>('.report-chart--radar .report-chart__axis-label'));
  const eastLabel = labels.find((label) => label.textContent === '曝气效率与能耗平衡能力');
  const westLabel = labels.find((label) => label.textContent === '来水负荷波动适应能力');
  const northLabel = labels.find((label) => label.textContent === '运行稳定性综合评分');

  expect(eastLabel).toHaveAttribute('text-anchor', 'end');
  expect(Number(eastLabel?.getAttribute('x'))).toBeLessThanOrEqual(360);
  expect(westLabel).toHaveAttribute('text-anchor', 'start');
  expect(Number(westLabel?.getAttribute('x'))).toBeGreaterThanOrEqual(0);
  expect(northLabel).toHaveAttribute('text-anchor', 'middle');
});

it.each([3, 4, 5, 6])('anchors lateral radar labels inward for %i axes', (axisCount) => {
  const visual: Extract<VisualSpec, { kind: 'radar' }> = {
    kind: 'radar',
    axes: Array.from({ length: axisCount }, (_, index) => ({
      key: `axis-${index}`,
      label: `很长的雷达维度标签-${index}`,
      value: 80 + index,
      maximum: 100,
      unit: '分',
      snapshotId: 'snapshot-1',
      claimIds: ['claim-1'],
    })),
  };
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);
  const labels = Array.from(container.querySelectorAll<SVGTextElement>('.report-chart--radar .report-chart__axis-label'));

  for (const [index, label] of labels.entries()) {
    const horizontal = Math.sin(index * Math.PI * 2 / axisCount);
    if (horizontal > .22) expect(label).toHaveAttribute('text-anchor', 'end');
    if (horizontal < -.22) expect(label).toHaveAttribute('text-anchor', 'start');
    expect(Number(label.getAttribute('x'))).toBeGreaterThanOrEqual(18);
    expect(Number(label.getAttribute('x'))).toBeLessThanOrEqual(342);
  }
});

it('keeps the health ring SVG and centered label in one sizing container', () => {
  const { container } = render(<VisualRenderer visual={visualFixture('health-ring')} mode="canvas" />);
  const healthRing = container.querySelector('.report-health-ring');

  expect(healthRing).toBeInTheDocument();
  expect(healthRing?.querySelector('.report-chart--ring')).toBeInTheDocument();
  expect(healthRing?.querySelector('.report-health-ring__label')).toBeInTheDocument();
});

it('renders radar endpoint values with original units and no center total score', () => {
  const { container } = render(<VisualRenderer visual={visualFixture('radar')} mode="canvas" />);
  const endpointValues = Array.from(container.querySelectorAll('.report-radar__axis-value'));

  expect(endpointValues).toHaveLength(3);
  expect(endpointValues.map((node) => node.textContent?.trim())).toEqual(['92 分', '81 分', '95 分']);
  expect(container.querySelector('.report-radar__score')).toBeNull();
});

it('lightly amplifies radar geometry while preserving order, equality, and valid ratios', () => {
  const emphasized = emphasizeRadarRatios([
    { value: 96, maximum: 100 },
    { value: 90, maximum: 100 },
    { value: 72, maximum: 100 },
  ]);

  expect(emphasized[0]).toBeGreaterThan(emphasized[1]!);
  expect(emphasized[1]).toBeGreaterThan(emphasized[2]!);
  expect(emphasized[0]! - emphasized[2]!).toBeGreaterThan(.24);
  expect(emphasizeRadarRatios([
    { value: 90, maximum: 100 },
    { value: 90, maximum: 100 },
    { value: 90, maximum: 100 },
  ])).toEqual([.9, .9, .9]);
  expect(emphasized.every((ratio) => ratio >= 0 && ratio <= 1)).toBe(true);
});

it('hides score units on health rings but keeps non-score units visible', () => {
  const scoreRing = render(<VisualRenderer visual={visualFixture('health-ring')} mode="canvas" />);
  const percentRing = render(<VisualRenderer visual={{
    kind: 'health-ring',
    metric: metric('load', '负荷完成率', 87, '%'),
    target: 100,
  }} mode="canvas" />);

  expect(scoreRing.container.querySelector('.report-health-ring__unit')).toBeNull();
  expect(percentRing.container.querySelector('.report-health-ring__unit')?.textContent).toBe('%');
});

it('uses distinct semantic icon families for metric cards', () => {
  const visual = dataDashboardFixture({ summaryMetrics: [
    metric('tn', '总氮', 2.4),
    metric('blowerKwh', '鼓风能耗', 128.4, 'kWh/d'),
    metric('carbon', '碳源消耗', 537.2, 'kg/d'),
    metric('savedCost', '节省费用', 18579, '元/d'),
  ] });
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);

  expect([...container.querySelectorAll('.report-data-dashboard__metric .report-visual-icon')]
    .map((icon) => icon.getAttribute('data-icon-family')))
    .toEqual(['water', 'energy', 'carbon', 'cost']);
});

it('renders one decorative metric icon inside each KPI grid card', () => {
  const visual: Extract<VisualSpec, { kind: 'kpi-grid' }> = {
    kind: 'kpi-grid',
    metrics: [
      metric('tn', '总氮', 2.4),
      metric('ammonia', '氨氮', 0.5),
      metric('tp', '总磷', 0.3),
    ],
  };
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);
  const cards = Array.from(container.querySelectorAll<HTMLElement>('.report-kpi'));

  expect(cards).toHaveLength(visual.metrics.length);
  for (const [index, card] of cards.entries()) {
    expect(card).toHaveTextContent(visual.metrics[index]!.label);
    expect(card.querySelector('[data-icon-kind="metric"]')).not.toBeNull();
  }
});

it('caps KPI grids at four columns while preserving every metric card', () => {
  const visual: Extract<VisualSpec, { kind: 'kpi-grid' }> = {
    kind: 'kpi-grid',
    metrics: [
      metric('tn', '总氮', 2.4),
      metric('ammonia', '氨氮', 0.5),
      metric('tp', '总磷', 0.3),
      metric('cod', 'COD', 28),
      metric('health', '运行健康度', 92, '分'),
    ],
  };
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);
  const grid = container.querySelector<HTMLElement>('.report-kpi-grid')!;

  expect(container.querySelectorAll('.report-kpi')).toHaveLength(5);
  expect(grid.style.getPropertyValue('--report-kpi-columns')).toBe('4');
});

it('omits empty ready dashboard modules when there are no summary metrics or supports', () => {
  const visual = dataDashboardFixture({ summaryMetrics: [], supporting: [] });
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);
  const dashboard = container.querySelector('.report-data-dashboard');

  expect(dashboard).toHaveAttribute('data-support-count', '0');
  expect(dashboard).toHaveAttribute('data-support-slots', '0');
  expect(container.querySelector('[data-dashboard-slot="metrics"]')).toBeNull();
  expect(container.querySelector('[data-dashboard-slot="support"]')).toBeNull();
  expect(container.querySelectorAll('[data-dashboard-support-empty]')).toHaveLength(0);
  expect(container.querySelectorAll('.report-data-dashboard__primary [role="img"]')).toHaveLength(1);
});

it('renders one real support without a second empty ready slot', () => {
  const visual = dataDashboardFixture({
    supporting: [{ kind: 'health-ring', metric: metric('health', '运行健康度', 92, '分'), target: 100 }],
  });
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);
  const dashboard = container.querySelector('.report-data-dashboard');

  expect(dashboard).toHaveAttribute('data-support-count', '1');
  expect(dashboard).toHaveAttribute('data-support-slots', '1');
  expect(container.querySelectorAll('[data-dashboard-support-slot]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-dashboard-support-empty]')).toHaveLength(0);
});

it('keeps actual support panels mounted across staged reveal without placeholder reflow', () => {
  const visual = dataDashboardFixture({
    supporting: [{ kind: 'health-ring', metric: metric('health', '运行健康度', 92, '分'), target: 100 }],
  });
  const { container, rerender } = render(
    <VisualRenderer visual={visual} mode="canvas" revealedModules={new Set(['heading', 'metrics', 'primary'])} />,
  );

  const supportPanel = container.querySelector<HTMLElement>('[data-dashboard-support-slot="0"]');
  expect(container.querySelector('.report-data-dashboard')).toHaveAttribute('data-support-slots', '1');
  expect(supportPanel).toHaveAttribute('data-reveal-module', 'support-0');
  expect(supportPanel).toHaveAttribute('data-reveal-visible', 'false');
  expect(container.querySelectorAll('[data-dashboard-support-empty]')).toHaveLength(0);

  rerender(<VisualRenderer visual={visual} mode="canvas" revealedModules={new Set(['heading', 'metrics', 'primary', 'support-0'])} />);

  expect(container.querySelectorAll('[data-dashboard-support-slot]')).toHaveLength(1);
  expect(container.querySelector('[data-dashboard-support-slot="0"]')).toHaveAttribute('data-reveal-visible', 'true');
});

it('renders only the primary composite chart in thumbnail mode', () => {
  const visual = visualFixture('data-dashboard');
  const { container } = render(<VisualRenderer visual={visual} mode="thumbnail" />);

  expect(container.querySelector('.report-data-dashboard__primary')).toBeTruthy();
  expect(container.querySelector('.report-data-dashboard__metrics')).toBeNull();
  expect(container.querySelector('.report-data-dashboard__support')).toBeNull();
});

it('isolates a failed child chart instead of blanking the report page', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const Broken = () => {
    throw new Error('chart failed');
  };

  render(<ReportVisualErrorBoundary label="辅助图 1"><Broken /></ReportVisualErrorBoundary>);

  expect(screen.getByRole('alert')).toHaveTextContent('辅助图 1暂时无法显示，请查看本页证据数据。');
  consoleError.mockRestore();
});

it('marks slide sections with the visual kind for composite layout CSS', () => {
  const { container } = render(<ReportSlideView
    slide={slideFixture({ visual: visualFixture('data-dashboard') })}
    mode="canvas"
    active
  />);
  const slide = container.querySelector('.report-slide');

  expect(slide).toHaveAttribute('data-visual-kind', 'data-dashboard');
  expect(slide).toHaveClass('report-slide--visual-data-dashboard');
});

it('adds restrained inline icons to the page heading, metric cards and dashboard panels', () => {
  const visual = dataDashboardFixture({
    summaryMetrics: [metric('tn'), metric('ammonia'), metric('tp'), metric('cod')],
  });
  const { container } = render(<ReportSlideView
    slide={slideFixture({ visual })}
    mode="canvas"
    active
  />);

  expect(container.querySelector('[data-icon-kind="data-dashboard"]')).not.toBeNull();
  expect(container.querySelectorAll('[data-icon-kind="metric"]')).toHaveLength(visual.summaryMetrics.length);
  expect(container.querySelector('[data-panel-kind="trend-area"] .report-visual-icon')).not.toBeNull();
  expect(container.querySelector('[data-panel-kind="comparison-bars"] .report-visual-icon')).not.toBeNull();
  for (const icon of container.querySelectorAll('.report-visual-icon')) {
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('focusable', 'false');
  }
});

it.each([
  visualFixture('concept-map') as Extract<VisualSpec, { kind: 'concept-map' }>,
  visualFixture('capability-map') as Extract<VisualSpec, { kind: 'capability-map' }>,
] as const)('renders intent-first knowledge visual $kind in canvas and thumbnail modes', (visual) => {
  const { container } = render(<><VisualRenderer visual={visual} mode="canvas" /><VisualRenderer visual={visual} mode="thumbnail" /></>);

  expect(container.querySelectorAll(`[data-visual-kind="${visual.kind}"]`)).toHaveLength(2);
  expect(container.querySelectorAll(visual.kind === 'concept-map' ? '.report-concept-map__node strong' : '.report-capability-map__item strong')).toHaveLength(
    (visual.kind === 'concept-map' ? visual.nodes.length : visual.items.length) * 2,
  );
});

it('renders every concept relationship semantically without exposing opaque node IDs', () => {
  const visual = visualFixture('concept-map') as Extract<VisualSpec, { kind: 'concept-map' }>;
  const { container } = render(<><VisualRenderer visual={visual} mode="canvas" /><VisualRenderer visual={visual} mode="thumbnail" /></>);

  expect(container.querySelector('.report-concept-map__edges')).toBeNull();
  expect(container.querySelectorAll('.report-concept-map__relation')).toHaveLength(visual.edges.length * 2);
  for (const graphic of screen.getAllByRole('img')) {
    expect(graphic).toHaveAccessibleName(/进水总氮长周期波动与多因素协同控制/);
    expect(graphic).toHaveAccessibleName(/进水总氮长周期波动与多因素协同控制 → 生物脱氮过程稳定性（影响负荷）/);
    expect(graphic).toHaveAccessibleName(/生物脱氮过程稳定性 → 出水总氮达标裕度（关联）/);
  }
  for (const table of screen.getAllByRole('table', { name: '概念关系数据表' })) {
    expect(table).toHaveTextContent('关系：进水总氮长周期波动与多因素协同控制 → 生物脱氮过程稳定性');
    expect(table).toHaveTextContent('影响负荷');
    expect(table).toHaveTextContent('关系：生物脱氮过程稳定性 → 出水总氮达标裕度');
    expect(table).toHaveTextContent('关联');
  }
  expect(screen.queryByText('opaque-source-id')).not.toBeInTheDocument();
  expect(screen.queryByText('opaque-process-id')).not.toBeInTheDocument();
  expect(screen.queryByText('opaque-outcome-id')).not.toBeInTheDocument();
});

it('renders a single concept node without inventing a relationship', () => {
  render(<VisualRenderer visual={{
    kind: 'concept-map',
    nodes: [{ id: 'only-node-id', title: '单一概念节点', detail: '暂无关联关系', claimIds: ['claim-1'] }],
    edges: [],
  }} mode="canvas" />);

  expect(screen.getByRole('img')).toHaveAccessibleName('概念关系图：单一概念节点');
  expect(screen.queryByRole('list', { name: '概念关系' })).not.toBeInTheDocument();
  expect(screen.getByRole('table', { name: '概念关系数据表' })).toHaveTextContent('单一概念节点');
});

it('preserves long capability titles and details in its accessible table in both modes', () => {
  const visual = visualFixture('capability-map') as Extract<VisualSpec, { kind: 'capability-map' }>;
  render(<><VisualRenderer visual={visual} mode="canvas" /><VisualRenderer visual={visual} mode="thumbnail" /></>);

  for (const table of screen.getAllByRole('table', { name: '能力地图数据表' })) {
    expect(table).toHaveTextContent('跨周期水质趋势识别与异常根因辅助判断');
    expect(table).toHaveTextContent('结合长时序变化、告警节点与运行工况识别值班人员需要复核的关键环节');
  }
});

it('exposes chart values in a screen-reader-only data table', () => {
  const { container } = render(<VisualRenderer visual={visualFixture('trend-line')} mode="canvas" />);

  expect(screen.getByRole('table', { name: '总氮数据表' })).toBeInTheDocument();
  expect(container.querySelector('table')?.closest('.sr-only')).not.toBeNull();
  expect(screen.getByRole('cell', { name: '2.4' })).toBeInTheDocument();
});

it('draws mixed-sign comparison bars away from a true zero baseline', () => {
  const { container } = render(<VisualRenderer visual={{
    kind: 'comparison-bars',
    items: [metric('gain', '正偏差', 6, 'mg/L'), metric('loss', '负偏差', -4, 'mg/L')],
  }} mode="canvas" />);
  const baseline = Number(container.querySelector('.report-chart__baseline')?.getAttribute('y1'));
  const [positive, negative] = Array.from(container.querySelectorAll<SVGRectElement>('.report-chart__bar'));
  const positiveY = Number(positive?.getAttribute('y'));
  const positiveHeight = Number(positive?.getAttribute('height'));
  const negativeY = Number(negative?.getAttribute('y'));
  const negativeHeight = Number(negative?.getAttribute('height'));

  expect(positiveY).toBeLessThan(baseline);
  expect(positiveY + positiveHeight).toBeCloseTo(baseline, 5);
  expect(negativeY).toBeCloseTo(baseline, 5);
  expect(negativeHeight).toBeGreaterThan(0);
});

it('draws an all-negative comparison set downward from a zero baseline', () => {
  const { container } = render(<VisualRenderer visual={{
    kind: 'comparison-bars',
    items: [metric('loss-a', '偏差 A', -2, 'mg/L'), metric('loss-b', '偏差 B', -6, 'mg/L')],
  }} mode="canvas" />);
  const baseline = Number(container.querySelector('.report-chart__baseline')?.getAttribute('y1'));
  const bars = Array.from(container.querySelectorAll<SVGRectElement>('.report-chart__bar'));

  expect(bars).toHaveLength(2);
  for (const bar of bars) {
    expect(Number(bar.getAttribute('y'))).toBeCloseTo(baseline, 5);
    expect(Number(bar.getAttribute('height'))).toBeGreaterThan(0);
  }
});

it('draws one fully visible terminal marker per trend series', () => {
  const { container } = render(<VisualRenderer visual={{
    kind: 'trend-line',
    series: [
      {
        key: 'first',
        label: '首序列',
        unit: 'mg/L',
        snapshotId: 'snapshot-1',
        claimIds: ['claim-1'],
        points: [{ label: '07-01', value: 2.1 }, { label: '07-02', value: 2.2 }],
      },
      {
        key: 'second',
        label: '缺测序列',
        unit: 'mg/L',
        snapshotId: 'snapshot-1',
        claimIds: ['claim-1'],
        points: [{ label: '07-01', value: 1.8 }, { label: '07-03', value: 2.3 }],
      },
    ],
  }} mode="canvas" />);

  const clip = container.querySelector<SVGRectElement>('clipPath rect')!;
  const clipLeft = Number(clip.getAttribute('x'));
  const clipRight = clipLeft + Number(clip.getAttribute('width'));
  const markers = Array.from(container.querySelectorAll<SVGCircleElement>('[data-terminal-point="true"]'));

  expect(markers).toHaveLength(2);
  for (const marker of markers) {
    const cx = Number(marker.getAttribute('cx'));
    const radius = Number(marker.getAttribute('r'));
    const stroke = Number(marker.getAttribute('stroke-width'));
    expect(cx - radius - stroke / 2).toBeGreaterThanOrEqual(clipLeft);
    expect(cx + radius + stroke / 2).toBeLessThanOrEqual(clipRight);
  }
  expect(markers.map((marker) => Number(marker.getAttribute('cx')))).toEqual([...markers.map((marker) => Number(marker.getAttribute('cx')))].sort((a, b) => a - b));
});

it('renders one point node per series endpoint in a three-series trend', () => {
  const { container } = render(<VisualRenderer visual={{
    kind: 'trend-line',
    series: [
      {
        key: 'first',
        label: '首序列',
        unit: 'mg/L',
        snapshotId: 'snapshot-1',
        claimIds: ['claim-1'],
        points: [{ label: '07-01', value: 2.1 }, { label: '07-02', value: 2.2 }, { label: '07-03', value: 2.4 }],
      },
      {
        key: 'second',
        label: '次序列',
        unit: 'mg/L',
        snapshotId: 'snapshot-1',
        claimIds: ['claim-1'],
        points: [{ label: '07-01', value: 1.8 }, { label: '07-02', value: 1.9 }, { label: '07-03', value: 2.0 }],
      },
      {
        key: 'third',
        label: '第三序列',
        unit: 'mg/L',
        snapshotId: 'snapshot-1',
        claimIds: ['claim-1'],
        points: [{ label: '07-01', value: 0.8 }, { label: '07-02', value: 0.9 }, { label: '07-03', value: 1.0 }],
      },
    ],
  }} mode="canvas" />);

  expect(container.querySelectorAll('.report-chart__point')).toHaveLength(3);
  expect(container.querySelectorAll('[data-terminal-point="true"]')).toHaveLength(3);
});

it('allocates unique SVG IDs when the same visual appears in canvas and thumbnails', () => {
  const visual = visualFixture('trend-area');
  const { container } = render(<><VisualRenderer visual={visual} mode="canvas" /><VisualRenderer visual={visual} mode="thumbnail" /></>);
  const ids = Array.from(container.querySelectorAll<SVGElement>('svg [id]')).map((node) => node.id);

  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  for (const reference of Array.from(container.querySelectorAll<SVGElement>('[clip-path]'))) {
    const id = reference.getAttribute('clip-path')?.match(/^url\(#(.+)\)$/)?.[1];
    expect(id && container.querySelector(`[id="${id}"]`)).not.toBeNull();
  }
});

it('always presents the fixed scatter correlation caveat', () => {
  render(<VisualRenderer visual={visualFixture('scatter')} mode="canvas" />);

  expect(screen.getByText('统计关联不等于因果关系')).toBeVisible();
});

it('keeps detailed evidence collapsed and limits it to already-bound slide data', async () => {
  const user = userEvent.setup();
  render(<ReportEvidenceDrawer slide={slideFixture()} />);

  expect(screen.queryByRole('table', { name: '证据明细' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '展开证据明细' }));
  expect(screen.getByRole('table', { name: '证据明细' })).toHaveTextContent('总氮');
  expect(screen.getByRole('table', { name: '证据明细' })).toHaveTextContent('2.4');
  expect(screen.queryByText(/工作簿|任意单元格/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '收起证据明细' }));
  expect(screen.queryByRole('table', { name: '证据明细' })).not.toBeInTheDocument();
});

it('states evidence insufficiency instead of presenting an unsupported conclusion', () => {
  render(<ReportSlideView
    slide={slideFixture({
      title: '证据不足',
      takeaway: '证据不足，无法确认该页结论。',
      visual: { kind: 'recommendation-path', provenance: 'model-knowledge', steps: [{ id: 'safe-1', title: '证据不足', detail: '请补充经过验证的数据证据。', claimIds: ['claim-1'] }] },
      metrics: [],
      evidenceRefs: [],
    })}
    mode="canvas"
    active
  />);

  expect(screen.getByText('证据不足，无法确认该页结论。')).toBeVisible();
  expect(screen.getByText('本页没有可核验的现场数据证据。')).toBeVisible();
});
