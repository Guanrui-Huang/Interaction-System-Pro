import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutShell } from '../components/LayoutShell';
import type { NavigationPage } from '../components/TopNavigation';
import { AiPage } from '../features/ai/AiPage';
import { VoiceWakeOverlay } from '../features/ai/voice/VoiceWakeOverlay';
import { useAssistantPromptPlayback } from '../features/ai/voice/useAssistantPromptPlayback';
import { useVoiceOutputActivity } from '../features/ai/voice/useVoiceOutputActivity';
import { useWakeWord } from '../features/ai/voice/useWakeWord';
import { createIdempotencyKey } from '../features/ai/report/report-api';
import { ReportWorkspace } from '../features/ai/report/ReportWorkspace';
import { type ReportLaunch, useReportSession } from '../features/ai/report/useReportSession';
import { EnergyPage } from '../features/dashboard/EnergyPage';
import { HealthPage } from '../features/dashboard/HealthPage';
import { OverviewPage } from '../features/dashboard/OverviewPage';
import { WaterQualityPage } from '../features/dashboard/WaterQualityPage';
import { LoginPage } from '../features/login/LoginPage';

const showcasePages: NavigationPage[] = ['overview', 'health', 'water-quality', 'energy'];
type AppView = 'dashboard' | 'assistant' | 'report';
type ReportTarget = { launch: ReportLaunch } | { reportId: string };
type ReportStartOptions = { skipPrompt?: boolean };
type WakeOverlayState = { keyword: string };

function reportIdFromUrl(): string | undefined {
  const value = new URL(window.location.href).searchParams.get('reportId')?.trim();
  return value || undefined;
}

function ReportShell({ target, onExit }: { target: ReportTarget; onExit(): void }) {
  const session = useReportSession({
    ...('launch' in target ? { launch: target.launch } : { reportId: target.reportId }),
    onExit,
  });
  return <ReportWorkspace session={session} {...('launch' in target ? { launchQuestion: target.launch.question } : {})} />;
}

export function App() {
  const initialReportIdRef = useRef(reportIdFromUrl());
  const [entered, setEntered] = useState(Boolean(initialReportIdRef.current));
  const [activePage, setActivePage] = useState<NavigationPage>('overview');
  const [view, setView] = useState<AppView>(initialReportIdRef.current ? 'report' : 'dashboard');
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(
    initialReportIdRef.current ? { reportId: initialReportIdRef.current } : null,
  );
  const [wakeOverlay, setWakeOverlay] = useState<WakeOverlayState | null>(null);
  const assistantTriggerRef = useRef<HTMLButtonElement>(null);
  const shouldRestoreTriggerFocus = useRef(false);
  const prompts = useAssistantPromptPlayback();
  const handleWake = useCallback((keyword: string) => setWakeOverlay({ keyword }), []);
  const wake = useWakeWord({ onWake: handleWake });
  const voiceOutputActive = useVoiceOutputActivity();

  useEffect(() => {
    if (!entered || wakeOverlay || voiceOutputActive) {
      void wake.stop();
      return;
    }
    void wake.start();
    return () => { void wake.stop(); };
  }, [entered, voiceOutputActive, wakeOverlay, wake.start, wake.stop]);

  useEffect(() => {
    if (!entered || view !== 'dashboard') return;
    const carousel = window.setInterval(() => {
      setActivePage((currentPage) => {
        const currentIndex = showcasePages.indexOf(currentPage);
        return showcasePages[(currentIndex + 1) % showcasePages.length];
      });
    }, 10_000);
    return () => window.clearInterval(carousel);
  }, [activePage, entered, view]);

  useEffect(() => {
    if (view === 'dashboard' && shouldRestoreTriggerFocus.current) {
      assistantTriggerRef.current?.focus();
      shouldRestoreTriggerFocus.current = false;
    }
  }, [view]);

  const closeAssistant = () => {
    shouldRestoreTriggerFocus.current = true;
    setView('dashboard');
  };

  const startReport = useCallback((input: { question: string; page: NavigationPage }, _options: ReportStartOptions = {}) => {
    setReportTarget({ launch: { ...input, token: createIdempotencyKey() } });
    setView('report');
  }, []);

  const leaveReport = () => {
    setReportTarget(null);
    setView('assistant');
  };

  if (!entered) return <LoginPage onEnter={() => setEntered(true)} />;

  let page: React.ReactNode;
  if (view === 'report' && reportTarget) {
    page = <ReportShell target={reportTarget} onExit={leaveReport} />;
  } else if (view === 'assistant') {
    page = <AiPage originPage={activePage} onClose={closeAssistant} onStartReport={startReport} />;
  } else {
    const content = {
      overview: <OverviewPage />,
      health: <HealthPage />,
      'water-quality': <WaterQualityPage />,
      energy: <EnergyPage />,
    }[activePage];
    page = (
      <LayoutShell
        activePage={activePage}
        onNavigate={setActivePage}
        onOpenAi={() => setView('assistant')}
        assistantTriggerRef={assistantTriggerRef}
      >
        {content}
      </LayoutShell>
    );
  }

  return (
    <>
      {page}
      {wakeOverlay && (
        <VoiceWakeOverlay
          key={wakeOverlay.keyword}
          originPage={activePage}
          promptPlayback={prompts}
          onDismiss={() => setWakeOverlay(null)}
          onStartReport={startReport}
        />
      )}
    </>
  );
}
