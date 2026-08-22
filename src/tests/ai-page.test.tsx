import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AiPage } from '../features/ai/AiPage';

const voiceHarness = vi.hoisted(() => ({
  onFinal: undefined as ((text: string) => void) | undefined,
  play: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  stopPlayback: vi.fn(),
  startRecognition: vi.fn(),
  stopRecognition: vi.fn(),
  cancelRecognition: vi.fn(),
}));

vi.mock('../features/ai/voice/useVoicePlayback', () => ({
  useVoicePlayback: () => ({
    status: 'idle',
    progress: { completed: 0, total: 0 },
    errorCode: null,
    play: voiceHarness.play,
    pause: voiceHarness.pause,
    resume: voiceHarness.resume,
    stop: voiceHarness.stopPlayback,
  }),
}));

vi.mock('../features/ai/voice/useVoiceRecognition', () => ({
  useVoiceRecognition: ({ onFinal }: { onFinal?: (text: string) => void } = {}) => {
    voiceHarness.onFinal = onFinal;
    return {
      status: 'idle',
      confirmedText: '',
      interimText: '',
      elapsedMs: 0,
      errorCode: null,
      start: voiceHarness.startRecognition,
      stop: voiceHarness.stopRecognition,
      cancel: voiceHarness.cancelRecognition,
    };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  voiceHarness.onFinal = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('does not expose a legacy PPTX action or link from the AI launch workspace', () => {
  render(<AiPage originPage="energy" onClose={vi.fn()} onStartReport={vi.fn()} />);
  const legacyPattern = /pptx|\.pptx|下载/u;
  expect(screen.queryByRole('button', { name: legacyPattern })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: legacyPattern })).not.toBeInTheDocument();
});

it('submits one trimmed text launch without calling the legacy synchronous endpoint', async () => {
  const onStartReport = vi.fn();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(<AiPage originPage="energy" onClose={vi.fn()} onStartReport={onStartReport} />);
  await user.type(screen.getByLabelText('请输入需要分析的问题'), '  分析吨水电耗 ');
  await user.click(screen.getByRole('button', { name: '生成动态汇报' }));
  expect(onStartReport).toHaveBeenCalledOnce();
  expect(onStartReport).toHaveBeenCalledWith({ question: '分析吨水电耗', page: 'energy' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('routes a final voice transcript through the same trimmed launch boundary once', () => {
  const onStartReport = vi.fn();
  render(<AiPage originPage="water-quality" onClose={vi.fn()} onStartReport={onStartReport} />);
  act(() => {
    voiceHarness.onFinal?.('  分析总氮趋势  ');
    voiceHarness.onFinal?.('分析总氮趋势');
  });
  expect(onStartReport).toHaveBeenCalledOnce();
  expect(onStartReport).toHaveBeenCalledWith({ question: '分析总氮趋势', page: 'water-quality' });
});

it('keeps empty input in the assistant with an actionable error', async () => {
  const onStartReport = vi.fn();
  const user = userEvent.setup();
  render(<AiPage originPage="overview" onClose={vi.fn()} onStartReport={onStartReport} />);

  await user.type(screen.getByLabelText('请输入需要分析的问题'), '   ');
  await user.click(screen.getByRole('button', { name: '生成动态汇报' }));

  expect(screen.getByRole('alert')).toHaveTextContent('请输入需要分析的问题。');
  expect(onStartReport).not.toHaveBeenCalled();
});

it('cancels voice activity and closes with Escape', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<AiPage originPage="overview" onClose={onClose} onStartReport={vi.fn()} />);

  expect(screen.getByRole('button', { name: '关闭 AI 助手' })).toHaveFocus();
  await user.keyboard('{Escape}');

  expect(voiceHarness.cancelRecognition).toHaveBeenCalled();
  expect(voiceHarness.stopPlayback).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});
