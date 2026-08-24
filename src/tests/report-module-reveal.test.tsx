import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  BoundMetric,
  ReportEvidenceRef,
  ReportSlide,
} from '../../shared/report';
import {
  reportRevealPlan,
  useReportModuleReveal,
} from '../features/ai/report/useReportModuleReveal';

const metric = (
  key = 'tn',
  label = '总氮',
  value = 2.4,
  unit = 'mg/L',
): BoundMetric => ({
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

function dashboardSlideFixture(
  overrides: Partial<ReportSlide> = {},
): ReportSlide {
  return {
    id: 'slide-dashboard-1',
    order: 0,
    evidenceSnapshotId: 'snapshot-1',
    role: 'answer',
    layout: 'diagnostic-overview',
    evidencePolicy: 'data',
    title: '总氮与能耗诊断总览',
    takeaway: '总氮稳定，能耗存在回升信号。',
    takeawayClaimIds: ['claim-1'],
    claims: [{
      id: 'claim-1',
      text: '总氮稳定，能耗存在回升信号。',
      kind: 'onsite-fact',
      evidenceRefs: [evidence()],
    }],
    visual: {
      kind: 'data-dashboard',
      summaryMetrics: [
        metric('tn', '总氮', 2.4),
        metric('energy', '单位能耗', 0.31, 'kWh/m³'),
      ],
      primary: {
        kind: 'trend-area',
        series: [{
          key: 'tn',
          label: '总氮',
          unit: 'mg/L',
          snapshotId: 'snapshot-1',
          claimIds: ['claim-1'],
          points: [
            { label: '07-01', value: 2.2 },
            { label: '07-31', value: 2.4 },
          ],
        }],
      },
      supporting: [
        {
          kind: 'comparison-bars',
          items: [
            metric('tn', '总氮', 2.4),
            metric('ammonia', '氨氮', 0.5),
          ],
        },
        {
          kind: 'health-ring',
          metric: metric('health', '运行健康度', 92, '分'),
          target: 100,
        },
      ],
    },
    metrics: [metric()],
    evidenceRefs: [evidence()],
    narration: [{ id: 'segment-1', text: '第一段。', speechId: 'speech-1', claimIds: ['claim-1'] }],
    ...overrides,
  };
}

function atomicSlideFixture(
  overrides: Partial<ReportSlide> = {},
): ReportSlide {
  return {
    ...dashboardSlideFixture(),
    id: 'slide-atomic-1',
    layout: 'visual-focus',
    visual: {
      kind: 'trend-line',
      series: [{
        key: 'tn',
        label: '总氮',
        unit: 'mg/L',
        snapshotId: 'snapshot-1',
        claimIds: ['claim-1'],
        points: [
          { label: '07-01', value: 2.2 },
          { label: '07-31', value: 2.4 },
        ],
      }],
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('builds the reveal plan for dashboard slides in the required module order', () => {
  const dashboardSlide = dashboardSlideFixture();

  expect(reportRevealPlan(dashboardSlide)).toEqual([
    'heading',
    'metrics',
    'primary',
    'support-0',
    'support-1',
    'evidence',
  ]);
});

it('uses the atomic reveal plan for non-dashboard slides', () => {
  const atomicSlide = atomicSlideFixture();

  expect(reportRevealPlan(atomicSlide)).toEqual([
    'heading',
    'primary',
    'evidence',
  ]);
});

it('reveals dashboard modules progressively with the specified delays and completes on the final module', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })));
  const dashboardSlide = dashboardSlideFixture();
  const onComplete = vi.fn();
  const { result, unmount } = renderHook(() => useReportModuleReveal({
    slide: dashboardSlide,
    immediate: false,
    onComplete,
  }));

  expect([...result.current.revealedModules]).toEqual(['heading']);

  await act(async () => vi.advanceTimersByTimeAsync(320));
  expect(result.current.revealedModules.has('metrics')).toBe(true);

  await act(async () => vi.advanceTimersByTimeAsync(420));
  expect(result.current.revealedModules.has('primary')).toBe(true);

  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(result.current.revealedModules.has('support-0')).toBe(true);

  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(result.current.revealedModules.has('support-1')).toBe(true);

  await act(async () => vi.advanceTimersByTimeAsync(240));
  expect(result.current.revealedModules.has('evidence')).toBe(true);
  expect(onComplete).toHaveBeenCalledWith(dashboardSlide.id);
  unmount();
});

it('returns the complete reveal set immediately when immediate mode is requested', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })));
  const dashboardSlide = dashboardSlideFixture();
  const onComplete = vi.fn();
  const { result } = renderHook(() => useReportModuleReveal({
    slide: dashboardSlide,
    immediate: true,
    onComplete,
  }));

  expect([...result.current.revealedModules]).toEqual([
    'heading',
    'metrics',
    'primary',
    'support-0',
    'support-1',
    'evidence',
  ]);
  expect(result.current.progressive).toBe(false);
  expect(onComplete).toHaveBeenCalledWith(dashboardSlide.id);
});

it('returns the complete reveal set immediately when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })));
  const dashboardSlide = dashboardSlideFixture();
  const onComplete = vi.fn();
  const { result } = renderHook(() => useReportModuleReveal({
    slide: dashboardSlide,
    immediate: false,
    onComplete,
  }));

  expect([...result.current.revealedModules]).toEqual([
    'heading',
    'metrics',
    'primary',
    'support-0',
    'support-1',
    'evidence',
  ]);
  expect(result.current.progressive).toBe(false);
  expect(onComplete).toHaveBeenCalledWith(dashboardSlide.id);
});

it('cancels pending timers on unmount and does not complete afterward', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })));
  const dashboardSlide = dashboardSlideFixture();
  const onComplete = vi.fn();
  const { unmount } = renderHook(() => useReportModuleReveal({
    slide: dashboardSlide,
    immediate: false,
    onComplete,
  }));

  expect(vi.getTimerCount()).toBeGreaterThan(0);
  unmount();
  expect(vi.getTimerCount()).toBe(0);

  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(onComplete).not.toHaveBeenCalled();
});

it('switches a progressive reveal to immediate mode without leaving staged timers behind', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })));
  const dashboardSlide = dashboardSlideFixture();
  const onComplete = vi.fn();
  const { result, rerender } = renderHook(
    ({ slide, immediate }) => useReportModuleReveal({
      slide,
      immediate,
      onComplete,
    }),
    { initialProps: { slide: dashboardSlide, immediate: false } },
  );

  expect([...result.current.revealedModules]).toEqual(['heading']);
  expect(vi.getTimerCount()).toBeGreaterThan(0);

  await act(async () => vi.advanceTimersByTimeAsync(320));
  expect([...result.current.revealedModules]).toEqual(['heading', 'metrics']);

  await act(async () => {
    rerender({ slide: dashboardSlide, immediate: true });
  });

  expect([...result.current.revealedModules]).toEqual([
    'heading',
    'metrics',
    'primary',
    'support-0',
    'support-1',
    'evidence',
  ]);
  expect(result.current.progressive).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith(dashboardSlide.id);

  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(onComplete).toHaveBeenCalledTimes(1);
});

it('does not reset revealed modules when rerendered with a republished slide object that keeps the same id and plan', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })));
  const dashboardSlide = dashboardSlideFixture();
  const onComplete = vi.fn();
  const { result, rerender } = renderHook(
    ({ slide }) => useReportModuleReveal({
      slide,
      immediate: false,
      onComplete,
    }),
    { initialProps: { slide: dashboardSlide } },
  );

  await act(async () => vi.advanceTimersByTimeAsync(740));
  expect([...result.current.revealedModules]).toEqual([
    'heading',
    'metrics',
    'primary',
  ]);

  rerender({
    slide: {
      ...dashboardSlide,
      takeaway: '重新发布但保持同一 slide id 与 reveal plan。',
    },
  });

  expect([...result.current.revealedModules]).toEqual([
    'heading',
    'metrics',
    'primary',
  ]);
});
