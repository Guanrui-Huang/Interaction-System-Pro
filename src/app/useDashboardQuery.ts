import { useCallback, useEffect, useRef, useState } from 'react';
import type { BusinessPage } from '../../shared/dashboard';
import { getDashboard } from './api';

type DashboardQueryState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: null; error: Error };

export type DashboardQueryResult<T> = DashboardQueryState<T> & { retry: () => void };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('DASHBOARD_DATA_UNAVAILABLE');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

export function useDashboardQuery<T>(path: BusinessPage, preserveDataOnRefresh = false): DashboardQueryResult<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DashboardQueryState<T>>({ status: 'loading', data: null, error: null });
  const activeController = useRef<AbortController | null>(null);
  const latestRequest = useRef(0);

  const retry = useCallback(() => {
    activeController.current?.abort();
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    const requestId = ++latestRequest.current;
    const controller = new AbortController();
    activeController.current?.abort();
    activeController.current = controller;
    setState(current => preserveDataOnRefresh && current.status === 'success'
      ? current : { status: 'loading', data: null, error: null });

    void getDashboard<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted && requestId === latestRequest.current) {
          setState({ status: 'success', data, error: null });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error) || requestId !== latestRequest.current) {
          return;
        }
        setState({ status: 'error', data: null, error: asError(error) });
      });

    return () => {
      controller.abort();
      if (activeController.current === controller) {
        activeController.current = null;
      }
    };
  }, [attempt, path, preserveDataOnRefresh]);

  return { ...state, retry };
}
