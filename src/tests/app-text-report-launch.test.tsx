import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WATER_QUALITY_METRICS } from '../../shared/dashboard';
import { App } from '../app/App';

const harness = vi.hoisted(() => ({
  promptPlay: vi.fn(async (): Promise<void> => undefined),
  promptStop: vi.fn(async (): Promise<void> => undefined),
  wakeStart: vi.fn(async (): Promise<void> => undefined),
  wakeStop: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('../features/ai/voice/useAssistantPromptPlayback', () => ({
  useAssistantPromptPlayback: () => ({ play: harness.promptPlay, stop: harness.promptStop }),
}));

vi.mock('../features/ai/voice/useWakeWord', () => ({
  useWakeWord: () => ({ status: 'idle', errorCode: null, start: harness.wakeStart, stop: harness.wakeStop, cancel: harness.wakeStop }),
}));

vi.mock('../components/FloatingLines/FloatingLines.jsx', () => ({ default: () => <div /> }));

const point = {
  date: '2026-08-08', processedM3: 27800, informationCount: 1300000, complianceRate: 99.8,
  tn: 2.15, ammonia: 0.42, tp: 0.28, cod: 22.4, ss: 5.8, totalKwh: 12030,
  kwhPerM3: 0.436, blowerKwh: 4812, carbonEmissionKg: 343, carbonReductionKg: 51, savedYuan: 15800,
  qualityScore: 96, flowScore: 88, energyScore: 90, carbonSourceKg: 500, carbonSourceScore: 92,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
    ok: true,
    json: async () => {
      const path = input.split('/').at(-1);
      if (path === 'water-quality') return { latest: point, trend: [point], alerts: [], metrics: WATER_QUALITY_METRICS };
      if (path === 'energy') return { latest: point, trend: [point], costConfig: { electricityYuanPerKwh: .86, carbonSourceYuanPerKg: 4.2, electricitySavingsRate: .128 } };
      return { metrics: { informationCount: 1300000, operatingDays: 366, complianceRate: 99.8 }, health: { weights: { quality: 0.4, flow: 0.2, energy: 0.25, carbonSource: 0.15 }, score: 92.3, grade: '优' }, trend: [point], latest: point, alerts: [] };
    },
  })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('launches the report immediately for text input without requesting an assistant prompt', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  await user.click(await screen.findByRole('button', { name: '唤起 AI 运营助手' }));
  await user.type(screen.getByLabelText('请输入需要分析的问题'), '分析总氮趋势');
  await user.click(screen.getByRole('button', { name: '生成动态汇报' }));

  expect(await screen.findByRole('main', { name: 'AI 动态汇报工作区' })).toBeInTheDocument();
  expect(harness.promptPlay).not.toHaveBeenCalled();
});
