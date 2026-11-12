import { render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { refreshWphiDataset } from '../../server/src/domain/wphi-dataset';
import { createWphiDataset } from '../../server/src/domain/wphi-demo';
import { HealthPage } from '../features/dashboard/HealthPage';
import { OverviewPage } from '../features/dashboard/OverviewPage';

afterEach(() => vi.unstubAllGlobals());

function serveDashboard(dataset = createWphiDataset()) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    health: dataset.health,
    trend: dataset.daily.slice(-30),
    metrics: { operatingDays: dataset.daily.length, complianceRate: dataset.daily.at(-1)!.complianceRate },
  }))));
}

it('shows the original overview layout with three operating cards, seven meters and a 30-day line chart', async () => {
  serveDashboard();
  const { container } = render(<OverviewPage />);

  expect(await screen.findByRole('heading', { name: '运行总览' })).toBeInTheDocument();
  expect(screen.getByText('今日处理量')).toBeInTheDocument();
  expect(screen.getByText('安全运行')).toBeInTheDocument();
  expect(screen.getByText('水质达标率')).toBeInTheDocument();
  expect(container.querySelectorAll('[data-health-dimension-meter]')).toHaveLength(7);
  expect(screen.getByRole('img', { name: '健康指数 96.35' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: '近30日健康趋势图' })).toBeInTheDocument();
  expect(screen.queryByText(/等权|权重/)).not.toBeInTheDocument();
});

it('shows seven health dimensions, actual CV and the confirmed ring evaluation', async () => {
  serveDashboard();
  const { container } = render(<HealthPage />);

  expect(await screen.findByRole('heading', { name: '健康指数得分' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '七维健康评估' })).toBeInTheDocument();
  expect(container.querySelectorAll('[data-health-dimension-meter]')).toHaveLength(7);
  expect(screen.getByTestId('wphi-cv')).toHaveTextContent('CV 20.00% · 目标 15%');
  expect(screen.getByText('七维度算术平均')).toBeInTheDocument();
  expect(screen.getByText('运行风险低', { exact: false })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: '健康指数 96.35' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: '近30日健康指数柱状趋势' })).toBeInTheDocument();
  expect(screen.queryByText(/等权|权重|演示数据/)).not.toBeInTheDocument();
});

it('keeps a disabled dimension visible without a meter or a zero score', async () => {
  const dataset = createWphiDataset();
  dataset.wphi!.config.enabled.effluentSafety = false;
  refreshWphiDataset(dataset);
  serveDashboard(dataset);
  const { container } = render(<HealthPage />);

  const dimensions = await screen.findByRole('region', { name: '各维度得分' });
  expect(within(dimensions).getByText('出水安全')).toBeInTheDocument();
  expect(within(dimensions).getByText('不计分')).toBeInTheDocument();
  expect(container.querySelectorAll('[data-health-dimension-meter]')).toHaveLength(6);
  expect(screen.getByText('参与维度算术平均')).toBeInTheDocument();
});

it('shows unavailable state without any score chart when every dimension is off', async () => {
  const dataset = createWphiDataset();
  const enabled = dataset.wphi!.config.enabled;
  for (const key of Object.keys(enabled) as Array<keyof typeof enabled>) enabled[key] = false;
  refreshWphiDataset(dataset);
  serveDashboard(dataset);
  render(<HealthPage />);

  expect(await screen.findByText(/暂无参与评分的维度/)).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: /健康指数/ })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '七维健康评估' })).toBeInTheDocument();
});

it('shows the maintenance status and keeps the actual values and settings available', async () => {
  const dataset = createWphiDataset();
  dataset.wphi!.config.maintenance = true;
  refreshWphiDataset(dataset);
  serveDashboard(dataset);
  render(<HealthPage />);

  expect(await screen.findByText('当前水厂处于【检修模式】，健康评分已主动暂停')).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: /健康指数/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '七维健康评估' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '实际运行值与目标' })).toBeInTheDocument();
  expect(screen.getByText('评分配置与每日运行上报')).toBeInTheDocument();
});
