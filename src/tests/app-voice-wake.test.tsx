import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WATER_QUALITY_METRICS } from '../../shared/dashboard';
import { App } from '../app/App';

const voiceHarness = vi.hoisted(() => ({
  wakeOnWake: undefined as ((keyword: string) => void) | undefined,
  wakeStart: vi.fn(),
  wakeStop: vi.fn(async () => undefined),
  wakeCancel: vi.fn(async () => undefined),
  promptPlay: vi.fn(async (): Promise<void> => undefined),
  promptStop: vi.fn(async () => undefined),
  recognitionStart: vi.fn(async () => undefined),
  recognitionStop: vi.fn(async () => undefined),
  recognitionCancel: vi.fn(async () => undefined),
  recognitionOnFinal: undefined as ((text: string) => void) | undefined,
  voiceOutputActive: false,
}));

vi.mock('../features/ai/voice/useWakeWord', () => ({
  useWakeWord: ({ onWake }: { onWake?: (keyword: string) => void } = {}) => {
    voiceHarness.wakeOnWake = onWake;
    return { status: 'listening', errorCode: null, start: voiceHarness.wakeStart, stop: voiceHarness.wakeStop, cancel: voiceHarness.wakeCancel };
  },
}));

vi.mock('../features/ai/voice/useAssistantPromptPlayback', () => ({
  useAssistantPromptPlayback: () => ({ play: voiceHarness.promptPlay, stop: voiceHarness.promptStop }),
}));

vi.mock('../features/ai/voice/useVoiceOutputActivity', () => ({
  useVoiceOutputActivity: () => voiceHarness.voiceOutputActive,
}));

vi.mock('../features/ai/voice/useVoiceRecognition', () => ({
  useVoiceRecognition: ({ onFinal }: { onFinal?: (text: string) => void } = {}) => {
    voiceHarness.recognitionOnFinal = onFinal;
    return {
      status: 'idle', confirmedText: '', interimText: '', elapsedMs: 0, errorCode: null,
      start: voiceHarness.recognitionStart, stop: voiceHarness.recognitionStop, cancel: voiceHarness.recognitionCancel,
    };
  },
}));

vi.mock('../components/FloatingLines/FloatingLines.jsx', () => ({ default: () => <div /> }));

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
      if (path === 'water-quality') return { latest: point, trend: Array.from({ length: 30 }, () => point), alerts: [], metrics: WATER_QUALITY_METRICS };
      if (path === 'energy') return { latest: point, trend: Array.from({ length: 30 }, () => point), costConfig: { electricityYuanPerKwh: .86, carbonSourceYuanPerKg: 4.2, electricitySavingsRate: .128 } };
      return { metrics: { informationCount: 1300000, operatingDays: 366, complianceRate: 99.8 }, health: { weights: { quality: 0.4, flow: 0.2, energy: 0.25, carbonSource: 0.15 }, score: 92.3, grade: '优' }, trend: Array.from({ length: 30 }, () => point), latest: point, alerts: [] };
    },
  })));
}

beforeEach(() => {
  vi.clearAllMocks();
  voiceHarness.wakeOnWake = undefined;
  voiceHarness.voiceOutputActive = false;
  stubDashboardFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('starts listening only after login and shows the breathing-ball overlay without navigation', async () => {
  const user = userEvent.setup();
  render(<App />);
  expect(voiceHarness.wakeStart).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  expect(await screen.findByRole('heading', { name: '运行总览' })).toBeInTheDocument();
  expect(voiceHarness.wakeStart).toHaveBeenCalledOnce();
  await act(async () => { voiceHarness.wakeOnWake?.('小智小智'); });
  expect(screen.getByRole('dialog', { name: '语音交互' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'AI 智慧指挥中心' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '运行总览' })).toBeInTheDocument();
  expect(voiceHarness.promptPlay).toHaveBeenCalledWith('wake');
});

it('does not create another wake session when the signed-in page changes', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  await screen.findByRole('heading', { name: '运行总览' });
  await user.click(screen.getByRole('button', { name: '健康指数得分' }));
  await screen.findByRole('heading', { name: '健康指数得分' });
  expect(voiceHarness.wakeStart).toHaveBeenCalledOnce();
});

it('suspends wake listening while assistant output is active and resumes after it stops', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<App />);
  await user.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  await screen.findByRole('heading', { name: '运行总览' });
  expect(voiceHarness.wakeStart).toHaveBeenCalledOnce();

  voiceHarness.voiceOutputActive = true;
  rerender(<App />);
  expect(voiceHarness.wakeStop).toHaveBeenCalled();

  voiceHarness.wakeStart.mockClear();
  voiceHarness.voiceOutputActive = false;
  rerender(<App />);
  expect(voiceHarness.wakeStart).toHaveBeenCalledOnce();
});

it('starts recognition only after the wake acknowledgement completes', async () => {
  const user = userEvent.setup();
  let finishWakePrompt!: () => void;
  voiceHarness.promptPlay.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWakePrompt = resolve; }));
  render(<App />);
  await user.click(screen.getByRole('button', { name: '进入智慧中枢' }));
  await screen.findByRole('heading', { name: '运行总览' });
  await act(async () => { voiceHarness.wakeOnWake?.('小智小智'); });
  expect(voiceHarness.recognitionStart).not.toHaveBeenCalled();
  await act(async () => { finishWakePrompt(); });
  expect(voiceHarness.recognitionStart).toHaveBeenCalledOnce();
});
