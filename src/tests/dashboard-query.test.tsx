import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { useDashboardQuery } from '../app/useDashboardQuery';

function QueryProbe() {
  const query = useDashboardQuery<{ value: string }>('overview');

  if (query.status === 'loading') return <p role="status">加载中</p>;
  if (query.status === 'error') return <button type="button" onClick={query.retry}>重试</button>;
  return <p>{query.data.value}</p>;
}

function response(value: string): Response {
  return new Response(JSON.stringify({ value }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

it('recovers from a failed dashboard request through retry', async () => {
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new Error('network down'))
    .mockResolvedValueOnce(response('已恢复'));
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<QueryProbe />);
  await user.click(await screen.findByRole('button', { name: '重试' }));

  expect(await screen.findByText('已恢复')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('aborts the superseded request and ignores its stale response', async () => {
  let resolveFirst!: (value: Response) => void;
  let resolveSecond!: (value: Response) => void;
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal as AbortSignal);
    return new Promise<Response>((resolve) => {
      if (signals.length === 1) resolveFirst = resolve;
      else resolveSecond = resolve;
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  function RetryWhileLoadingProbe() {
    const query = useDashboardQuery<{ value: string }>('overview');
    return <div><span>{query.status === 'success' ? query.data.value : query.status}</span><button type="button" onClick={query.retry}>重新请求</button></div>;
  }

  render(<RetryWhileLoadingProbe />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole('button', { name: '重新请求' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

  expect(signals[0].aborted).toBe(true);
  await act(async () => {
    resolveSecond(response('新响应'));
  });
  expect(await screen.findByText('新响应')).toBeInTheDocument();

  await act(async () => {
    resolveFirst(response('陈旧响应'));
  });
  expect(screen.queryByText('陈旧响应')).not.toBeInTheDocument();
  expect(screen.getByText('新响应')).toBeInTheDocument();
});

it('aborts on unmount without an unhandled rejection or console error', async () => {
  let requestSignal: AbortSignal | undefined;
  const unhandled = vi.fn();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  window.addEventListener('unhandledrejection', unhandled);
  vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  }));

  const { unmount } = render(<QueryProbe />);
  await waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal));
  unmount();
  await act(async () => Promise.resolve());

  expect(requestSignal?.aborted).toBe(true);
  expect(unhandled).not.toHaveBeenCalled();
  expect(consoleError).not.toHaveBeenCalled();
  window.removeEventListener('unhandledrejection', unhandled);
  consoleError.mockRestore();
});
