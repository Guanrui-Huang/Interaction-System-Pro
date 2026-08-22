import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSnapshot, FollowUpResponse, NarrationCursor } from '../../shared/report';
import type { VoiceErrorCode } from '../../shared/voice';
import { ReportFollowUp } from '../features/ai/report/ReportFollowUp';

let deliverFinal: ((text: string) => void) | undefined;
const recognition = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), cancel: vi.fn(),
  status: 'idle' as const, confirmedText: '', interimText: '', elapsedMs: 0,
  errorCode: null as VoiceErrorCode | null,
}));

vi.mock('../features/ai/voice/useVoiceRecognition', () => ({
  useVoiceRecognition: (options: { onFinal?(text: string): void }) => {
    deliverFinal = options.onFinal;
    return recognition;
  },
}));

const cursor: NarrationCursor = { slideId: 'slide-2', segmentId: 'segment-3', offsetMs: 1_260 };
const conversation: ConversationSnapshot = {
  originalQuestion: '分析总氮趋势', compactSummary: '', turns: [], activeSlideId: 'slide-2', narrationCursor: cursor,
};

function answer(): FollowUpResponse {
  return {
    turnId: 'turn-1', answer: '因为进水负荷增加。', speechId: 'answer-speech', citedEvidence: [],
    needsClarification: false, resumeCursor: cursor,
  };
}

function setup(overrides: { followUp?: ReturnType<typeof vi.fn>; play?: ReturnType<typeof vi.fn> } = {}) {
  const order: string[] = [];
  const followUp = overrides.followUp ?? vi.fn().mockResolvedValue(answer());
  const narration = {
    beginInterruption: vi.fn(() => { order.push('interrupt'); return cursor; }),
    playFollowUpAnswer: overrides.play ?? vi.fn(async () => { order.push('answer'); return 'ended' as const; }),
    resumeAfterAnswer: vi.fn(async () => { order.push('resume'); }),
  };
  render(<ReportFollowUp
    reportId="report-1"
    conversation={conversation}
    initialQuestion={conversation.originalQuestion}
    narration={narration}
    followUp={followUp}
    createIdempotencyKey={() => 'intent-1'}
  />);
  return { narration, followUp, order };
}

afterEach(() => {
  deliverFinal = undefined;
  vi.clearAllMocks();
});

it('pauses narration before microphone capture and submits recognized text through the shared path', async () => {
  const user = userEvent.setup();
  const model = setup();
  await user.click(screen.getByRole('button', { name: '语音追问' }));

  expect(model.narration.beginInterruption).toHaveBeenCalledWith('listening');
  expect(model.order[0]).toBe('interrupt');
  expect(recognition.start).toHaveBeenCalledOnce();
  await act(async () => deliverFinal?.('它为什么升高？'));

  expect(model.followUp).toHaveBeenCalledWith('report-1', expect.objectContaining({
    question: '它为什么升高？', slideId: 'slide-2', interruptedSegmentId: 'segment-3', narrationOffsetMs: 1_260,
  }), 'intent-1', expect.any(AbortSignal));
});

it('shows answer text, finishes answer audio, then resumes the exact returned cursor', async () => {
  const user = userEvent.setup();
  const model = setup();
  await user.click(screen.getByRole('textbox', { name: '输入追问' }));
  await user.keyboard('解释一下');
  await user.click(screen.getByRole('button', { name: '发送追问' }));

  expect(await screen.findByText('因为进水负荷增加。')).toBeVisible();
  await waitFor(() => expect(model.narration.playFollowUpAnswer).toHaveBeenCalledWith('answer-speech'));
  expect(model.narration.resumeAfterAnswer).toHaveBeenCalledWith(cursor);
  expect(model.order).toEqual(expect.arrayContaining(['answer', 'resume']));
  expect(model.order.indexOf('answer')).toBeLessThan(model.order.indexOf('resume'));
});

it('keeps readable answer text and offers continue when answer speech fails', async () => {
  const user = userEvent.setup();
  const play = vi.fn().mockResolvedValue('failed' as const);
  const model = setup({ play });
  await user.type(screen.getByRole('textbox', { name: '输入追问' }), '只显示文字也可以');
  await user.click(screen.getByRole('button', { name: '发送追问' }));

  expect(await screen.findByText('因为进水负荷增加。')).toBeVisible();
  expect(await screen.findByRole('button', { name: '继续原讲解' })).toBeEnabled();
  expect(model.narration.resumeAfterAnswer).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '继续原讲解' }));
  expect(model.narration.resumeAfterAnswer).toHaveBeenCalledWith(cursor);
});

it('does not resume or offer fallback when a user action cancels answer playback', async () => {
  const user = userEvent.setup();
  const play = vi.fn().mockResolvedValue('cancelled' as const);
  const model = setup({ play });
  await user.type(screen.getByRole('textbox', { name: '输入追问' }), '先别继续');
  await user.click(screen.getByRole('button', { name: '发送追问' }));

  expect(await screen.findByText('因为进水负荷增加。')).toBeVisible();
  await waitFor(() => expect(play).toHaveBeenCalled());
  expect(model.narration.resumeAfterAnswer).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '继续原讲解' })).not.toBeInTheDocument();
});

it('keeps text input enabled when microphone recognition is unavailable', () => {
  recognition.errorCode = 'VOICE_UNSUPPORTED';
  setup();

  expect(screen.getByRole('textbox', { name: '输入追问' })).toBeEnabled();
  expect(screen.getByRole('alert')).toBeVisible();
  recognition.errorCode = null;
});

it('keeps text input enabled when microphone permission is denied', () => {
  recognition.errorCode = 'VOICE_PERMISSION_DENIED';
  setup();

  expect(screen.getByRole('textbox', { name: '输入追问' })).toBeEnabled();
  expect(screen.getByRole('alert')).toBeVisible();
  recognition.errorCode = null;
});

it('shares one visible history between text and voice turns', async () => {
  const user = userEvent.setup();
  const followUp = vi.fn()
    .mockResolvedValueOnce({ ...answer(), turnId: 'turn-text', answer: '文字回答' })
    .mockResolvedValueOnce({ ...answer(), turnId: 'turn-voice', answer: '语音回答' });
  setup({ followUp });

  await user.type(screen.getByRole('textbox', { name: '输入追问' }), '文字问题');
  await user.click(screen.getByRole('button', { name: '发送追问' }));
  await screen.findByText('文字回答');
  await user.click(screen.getByRole('button', { name: '语音追问' }));
  await act(async () => deliverFinal?.('语音问题'));

  const history = screen.getByRole('list', { name: '追问记录' });
  expect(within(history).getAllByRole('listitem')).toHaveLength(8);
  expect(within(history).getAllByText('思考 1s ›')).toHaveLength(2);
  expect(history).toHaveTextContent('文字问题');
  expect(history).toHaveTextContent('语音问题');
});

it('cancels microphone capture when the follow-up component unmounts', () => {
  const { unmount } = render(<ReportFollowUp
    reportId="report-1"
    conversation={conversation}
    initialQuestion={conversation.originalQuestion}
    narration={{
      beginInterruption: () => cursor,
      playFollowUpAnswer: async () => 'ended',
      resumeAfterAnswer: async () => undefined,
    }}
  />);

  unmount();

  expect(recognition.cancel).toHaveBeenCalled();
});

it('renders an accessible clarification state even when the answer cites evidence', async () => {
  const user = userEvent.setup();
  const followUp = vi.fn().mockResolvedValue({
    ...answer(), needsClarification: true,
    answer: '您指的是总氮浓度还是总氮负荷？',
    citedEvidence: [{ key: 'tn', kind: 'metric', source: 'excel', label: '总氮', unit: 'mg/L' }],
  });
  setup({ followUp });
  await user.type(screen.getByRole('textbox', { name: '输入追问' }), '它为什么变化？');
  await user.click(screen.getByRole('button', { name: '发送追问' }));

  expect(await screen.findByRole('status', { name: '需要澄清' })).toHaveTextContent('需要澄清');
  expect(screen.getByRole('list', { name: '引用依据' })).toHaveTextContent('总氮');
});
