import { useCallback, useEffect, useRef, useState } from 'react';
import type { BusinessPage } from '../../../../shared/dashboard';
import { useVoiceRecognition } from './useVoiceRecognition';
import { type AssistantPromptPlayback } from './useAssistantPromptPlayback';
import { LiquidVoiceOrb } from './LiquidVoiceOrb';
import '../voice/voice-wake.css';

export type VoiceWakeOverlayProps = {
  originPage: BusinessPage;
  promptPlayback: AssistantPromptPlayback;
  onStartReport(input: { question: string; page: BusinessPage }, options?: { skipPrompt?: boolean }): void;
  onDismiss(): void;
};

export function VoiceWakeOverlay({ originPage, promptPlayback, onStartReport, onDismiss }: VoiceWakeOverlayProps) {
  const [phase, setPhase] = useState<'waking' | 'hearing' | 'analyzing'>('waking');
  const [question, setQuestion] = useState('');
  const launchRef = useRef(false);
  const dismissedRef = useRef(false);
  const mountedRef = useRef(true);
  const playPrompt = promptPlayback.play;
  const stopPrompt = promptPlayback.stop;
  const finishPrompt = useCallback(() => {
    if (!mountedRef.current || dismissedRef.current) return;
    dismissedRef.current = true;
    onDismiss();
  }, [onDismiss]);
  const recognition = useVoiceRecognition({
    autoStop: { silenceMs: 1000 },
    onFinal: (text) => {
      const question = text.trim();
      if (!question || launchRef.current) return;
      launchRef.current = true;
      setPhase('analyzing');
      setQuestion(question);
      onStartReport({ question, page: originPage }, { skipPrompt: true });
      void recognition.cancel().catch(() => undefined);
      void playPrompt('analysis-started', { question })
        .catch(() => undefined)
        .finally(finishPrompt);
    },
  });

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    void playPrompt('wake')
      .catch(() => undefined)
      .then(() => {
        if (!active || launchRef.current) return;
        setPhase('hearing');
        return recognition.start();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      mountedRef.current = false;
      if (dismissedRef.current) return;
      void recognition.cancel().catch(() => undefined);
      void stopPrompt().catch(() => undefined);
    };
  }, [playPrompt, recognition.cancel, recognition.start, stopPrompt]);

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    void recognition.cancel().catch(() => undefined);
    void stopPrompt().catch(() => undefined);
    onDismiss();
  }, [onDismiss, recognition.cancel, stopPrompt]);

  const displayText = phase === 'waking'
    ? '诶，我在，请问有什么吩咐'
    : phase === 'hearing'
      ? (recognition.interimText || recognition.confirmedText || '正在聆听，请说出您的问题')
      : '好滴，现在我来分析…';

  return (
    <div aria-label="语音交互" aria-modal="false" className="voice-wake-overlay voice-wake-overlay--bottom-center" role="dialog">
      <div aria-live="polite" className="voice-wake-overlay__text" role="status">{displayText}</div>
      <LiquidVoiceOrb phase={phase} />
      {phase === 'analyzing' && <div className="voice-wake-overlay__question">正在分析：{question}</div>}
      <button aria-label="关闭语音交互" className="voice-wake-overlay__close" type="button" onClick={dismiss}>×</button>
    </div>
  );
}