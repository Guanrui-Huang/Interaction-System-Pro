import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { type BusinessPage } from '../../../shared/dashboard';
import { VoiceInteraction } from './voice/VoiceInteraction';
import { useVoicePlayback } from './voice/useVoicePlayback';
import { useVoiceRecognition } from './voice/useVoiceRecognition';
import '../../styles/ai.css';

export type AiPageProps = {
  originPage: BusinessPage;
  onClose(): void;
  onStartReport(launch: { question: string; page: BusinessPage }): void;
};

const suggestedQuestions = [
  '分析近 30 日总氮变化趋势',
  '计算当前碳源投加优化建议',
  '回顾近期相似运行预警',
];

function contain(action: () => void | Promise<unknown>): void {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // Optional voice cleanup must not block a report launch or dialog close.
  }
}

export function AiPage({ originPage, onClose, onStartReport }: AiPageProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const launchedRef = useRef(false);
  const launchRef = useRef<(question: string) => void>(() => undefined);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [launched, setLaunched] = useState(false);
  const playback = useVoicePlayback();
  const recognition = useVoiceRecognition({
    onFinal: (transcript) => launchRef.current(transcript),
  });

  const launch = useCallback((rawQuestion: string) => {
    const trimmed = rawQuestion.trim();
    if (!trimmed) {
      setError('请输入需要分析的问题。');
      return;
    }
    if (launchedRef.current) return;
    launchedRef.current = true;
    setLaunched(true);
    setQuestion(trimmed);
    setError('');
    contain(recognition.cancel);
    contain(playback.stop);
    onStartReport({ question: trimmed, page: originPage });
  }, [onStartReport, originPage, playback.stop, recognition.cancel]);
  launchRef.current = launch;

  const close = useCallback(() => {
    contain(recognition.cancel);
    contain(playback.stop);
    onClose();
  }, [onClose, playback.stop, recognition.cancel]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [close]);

  useEffect(() => () => {
    contain(recognition.cancel);
    contain(playback.stop);
  }, [playback.stop, recognition.cancel]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    launch(question);
  }

  const startRecognition = async () => {
    contain(playback.stop);
    try {
      await recognition.cancel();
    } catch {
      // A failed stale-session cleanup does not prevent a fresh recognition attempt.
    }
    contain(recognition.start);
  };

  return (
    <main aria-labelledby="ai-screen-title" aria-modal="true" className="ai-screen app-background" role="dialog">
      <header className="ai-screen__header">
        <div className="ai-screen__brand">
          <span aria-hidden="true" className="ai-screen__brand-icon">✦</span>
          <div>
            <h1 id="ai-screen-title">AI 智慧指挥中心</h1>
            <p>Qwen3.5-Omni 实时语音 · Excel 全模块动态汇报</p>
          </div>
        </div>
        <button ref={closeButtonRef} aria-label="关闭 AI 助手" className="ai-screen__close" type="button" onClick={close}>×</button>
      </header>

      <section className="ai-screen__content">
        <article aria-live="polite" className="ai-answer-card">
          <div aria-hidden="true" className="ai-answer-card__avatar">✦</div>
          <div className="ai-answer-card__body">
            <p className="ai-answer-card__label">AI 动态汇报</p>
            <p className="ai-answer-card__answer">输入问题后将立即进入汇报工作区，页面会随分析进度持续生成。</p>
          </div>
        </article>
        {error && <p className="ai-screen__error" role="alert">{error}</p>}
        <div className="ai-suggestions" aria-label="推荐问题">
          {suggestedQuestions.map((suggestion) => (
            <button key={suggestion} disabled={launched} type="button" onClick={() => { setQuestion(suggestion); setError(''); }}>
              <span aria-hidden="true">⌁</span>{suggestion}
            </button>
          ))}
        </div>
      </section>

      <section className="ai-interaction-zone">
        <VoiceInteraction
          isAnalyzing={launched}
          onStartRecognition={startRecognition}
          onStopRecognition={recognition.stop}
          playback={playback}
          recognition={recognition}
        />
        <form className="ai-question-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="ai-question">请输入需要分析的问题</label>
          <input
            id="ai-question"
            aria-label="请输入需要分析的问题"
            autoComplete="off"
            disabled={launched}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="例如：请综合分析本季度水质与能效"
            value={question}
          />
          <button disabled={launched} type="submit">生成动态汇报</button>
        </form>
      </section>
    </main>
  );
}
