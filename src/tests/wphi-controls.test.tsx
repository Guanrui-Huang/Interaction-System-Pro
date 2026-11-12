import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createWphiDataset } from '../../server/src/domain/wphi-demo';
import { refreshWphiDataset } from '../../server/src/domain/wphi-dataset';
import { HealthPage } from '../features/dashboard/HealthPage';
import { WphiControls } from '../features/dashboard/WphiControls';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

it('prevents saving stale defaults before configuration loads and surfaces validation errors', async () => {
  const data = createWphiDataset();
  let finishLoad!: (value: Response) => void;
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishLoad = resolve; }))
    .mockResolvedValueOnce(response({ message: '目标值须为正数' }, 400));
  vi.stubGlobal('fetch', fetchMock);
  const onRefresh = vi.fn();
  const user = userEvent.setup();
  render(<WphiControls config={data.wphi!.config} onRefresh={onRefresh} />);
  await user.click(screen.getByText('评分配置与每日运行上报'));
  expect(screen.getByRole('button', { name: '保存评分配置' })).toBeDisabled();
  await act(async () => finishLoad(response({ config: data.wphi!.config, reading: data.wphi!.history.at(-1) })));
  const target = screen.getByRole('spinbutton', { name: '出水总氮 mg/L' });
  await user.clear(target);
  await user.type(target, '0');
  await user.click(screen.getByRole('button', { name: '保存评分配置' }));
  expect(await screen.findByText('目标值须为正数')).toBeInTheDocument();
  expect(onRefresh).not.toHaveBeenCalled();
});

it('refreshes maintenance immediately after saving while preserving the open editor and feedback', async () => {
  const data = createWphiDataset();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/dashboard/health') return response({ health: data.health, trend: data.daily.slice(-30) });
    if (init?.method === 'PUT') {
      data.wphi!.config = JSON.parse(init.body as string);
      refreshWphiDataset(data);
    }
    return response({ config: data.wphi!.config, snapshot: data.health.wphi, reading: data.wphi!.history.at(-1) });
  }));
  const editing = vi.fn();
  const user = userEvent.setup();
  render(<HealthPage onEditingChange={editing} />);
  expect(await screen.findByText('96.35')).toBeInTheDocument();
  await user.click(screen.getByText('评分配置与每日运行上报'));
  await waitFor(() => expect(screen.getByRole('button', { name: '保存评分配置' })).toBeEnabled());
  await user.click(screen.getByRole('checkbox', { name: '检修模式' }));
  await user.click(screen.getByRole('button', { name: '保存评分配置' }));
  expect(await screen.findByText('当前水厂处于【检修模式】，健康评分已主动暂停')).toBeInTheDocument();
  expect(screen.getByText('保存成功')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存评分配置' })).toBeVisible();
  expect(screen.queryByRole('img', { name: /健康指数/ })).not.toBeInTheDocument();
  expect(screen.queryByText('96.35')).not.toBeInTheDocument();
  expect(editing).toHaveBeenLastCalledWith(true);
});
