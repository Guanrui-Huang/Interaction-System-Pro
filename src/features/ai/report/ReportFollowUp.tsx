import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { VOICE_ERROR_MESSAGES } from '../../../../shared/voice';
import { useVoiceRecognition } from '../voice/useVoiceRecognition';
import { ReportThinkingTime } from './ReportThinkingTime';
import type { UseReportFollowUpInput } from './useReportFollowUp';
import { useReportFollowUp } from './useReportFollowUp';

export type ReportFollowUpProps = UseReportFollowUpInput & {
  initialQuestion: string;
  initialAnswer?: string;
  initialAnswerPending?: boolean;
  initialAnswerInterrupted?: boolean;
  initialThinkingStartedAtMs?: number;
  initialThinkingDurationMs?: number;
  generationLabel?: string;
  leadingControls?: ReactNode;
};

const FEED_BOTTOM_TOLERANCE_PX = 48;

function ConversationMessage(
  { speaker, text, messageClassName, children, live }: {
    speaker: 'user' | 'assistant';
    text: string;
    messageClassName: string;
    children?: ReactNode;
    live?: 'polite';
  },
) {
  return (
    <li
      className={`report-conversation__message ${messageClassName}`}
      aria-label={speaker === 'user' ? '用户消息' : 'AI 消息'}
      {...(live ? { 'aria-live': live } : {})}
    >
      <p className="report-conversation__text">{text}</p>
      {children}
    </li>
  );
}

type IconProps = { className: string };

export function MicrophoneIcon({ className }: IconProps) {
  return (
    <svg className={`report-conversation__icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg className={`report-conversation__icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
    </svg>
  );
}

export function ReportFollowUp(props: ReportFollowUpProps) {
  const [text, setText] = useState('');
  const feedRef = useRef<HTMLOListElement>(null);
  const feedWasNearBottomRef = useRef(true);
  const model = useReportFollowUp(props);
  const recognition = useVoiceRecognition({
    onFinal: (recognized) => { void model.submitRecognizedText(recognized); },
  });
  useEffect(() => () => { void recognition.cancel(); }, [recognition.cancel]);
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed || !feedWasNearBottomRef.current) return;
    feed.scrollTop = feed.scrollHeight;
  }, [
    model.activeQuestion,
    model.failedThinkingDurationMs,
    model.history,
    model.pending,
    props.generationLabel,
    props.initialAnswer,
    props.initialAnswerPending,
    props.initialQuestion,
    props.initialThinkingStartedAtMs,
    props.initialThinkingDurationMs,
  ]);
  const listening = ['requesting-permission', 'connecting', 'recording', 'stopping'].includes(recognition.status);

  const trackFeedPosition = () => {
    const feed = feedRef.current;
    if (!feed) return;
    feedWasNearBottomRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= FEED_BOTTOM_TOLERANCE_PX;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const question = text.trim();
    if (!question) return;
    setText('');
    void model.submitText(question);
  };

  const toggleVoice = () => {
    if (listening) void recognition.stop();
    else {
      model.startListening();
      void recognition.start();
    }
  };

  return (
    <section className="report-follow-up report-conversation" aria-label="汇报对话区">
      <ol
        ref={feedRef}
        className="report-follow-up__history report-conversation__feed"
        aria-label="追问记录"
        onScroll={trackFeedPosition}
      >
        <ConversationMessage
          speaker="user"
          text={props.initialQuestion}
          messageClassName="report-conversation__message--user"
        />
        <ReportThinkingTime
          pending={props.initialAnswerPending}
          interrupted={props.initialAnswerInterrupted}
          startedAtMs={props.initialThinkingStartedAtMs}
          durationMs={props.initialAnswerPending ? undefined : props.initialThinkingDurationMs}
          now={props.now}
        />
        <ConversationMessage
          speaker="assistant"
          text={props.initialAnswerPending || props.initialAnswerInterrupted
            ? (props.generationLabel ?? '正在生成汇报')
            : (props.initialAnswer ?? props.generationLabel ?? '')}
          messageClassName="report-conversation__message--assistant"
        />
        {model.history.flatMap((turn) => [
          <ConversationMessage
            key={`${turn.id}-question`}
            speaker="user"
            text={turn.question}
            messageClassName="report-conversation__message--user"
          />,
          <ReportThinkingTime key={`${turn.id}-thinking`} durationMs={turn.thinkingDurationMs} now={props.now} />,
          <ConversationMessage
            key={`${turn.id}-answer`}
            speaker="assistant"
            text={turn.answer}
            messageClassName="report-conversation__message--assistant"
          >
            {turn.needsClarification && <p className="report-conversation__status" role="status" aria-label="需要澄清">需要澄清</p>}
            {turn.citedEvidence.length > 0 && (
              <ul className="report-conversation__evidence" aria-label="引用依据">
                {turn.citedEvidence.map((evidence) => <li key={evidence.key}>{evidence.label}</li>)}
              </ul>
            )}
            </ConversationMessage>,
        ])}
        {model.activeQuestion && (
          <ConversationMessage
            speaker="user"
            text={model.activeQuestion}
            messageClassName="report-conversation__message--user"
          />
        )}
        {model.activeQuestion && (
          <ReportThinkingTime
            pending={model.pending}
            interrupted={!model.pending && Boolean(model.error)}
            startedAtMs={model.activeThinkingStartedAtMs ?? undefined}
            durationMs={model.failedThinkingDurationMs ?? undefined}
            now={props.now}
          />
        )}
      </ol>
      <form className="report-follow-up__form report-conversation__composer" onSubmit={submit}>
        <textarea
          aria-label="输入追问"
          rows={2}
          value={text}
          onFocus={() => model.startTyping()}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="report-conversation__composer-toolbar">
          {props.leadingControls ?? null}
          <div className="report-conversation__composer-actions">
            <button type="button" aria-label="语音追问" title="语音追问" aria-pressed={listening} onClick={toggleVoice}>
              <MicrophoneIcon className="report-conversation__icon--microphone" />
            </button>
            <button type="submit" aria-label="发送追问" title="发送追问" disabled={model.pending || !text.trim()}>
              <SendIcon className="report-conversation__icon--send" />
            </button>
          </div>
        </div>
      </form>
      {recognition.errorCode && <p className="report-conversation__alert" role="alert">{VOICE_ERROR_MESSAGES[recognition.errorCode]}</p>}
      {model.error && (
        <p className="report-conversation__alert" role="alert">
          {model.error.message}
          <button type="button" onClick={() => { void model.retry(); }}>重试</button>
        </p>
      )}
      {model.canContinueOriginal && (
        <button className="report-conversation__continue" type="button" onClick={() => { void model.continueOriginal(); }}>
          继续原讲解
        </button>
      )}
    </section>
  );
}
