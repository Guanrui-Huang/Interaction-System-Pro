import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ReportSlide } from '../../../../shared/report';
import { ReportConversationToolbar } from './ReportConversationToolbar';
import { ReportClarification } from './ReportClarification';
import { MicrophoneIcon, ReportFollowUp, SendIcon } from './ReportFollowUp';
import { ReportHeader } from './ReportHeader';
import { ReportPendingSlideView } from './ReportPendingSlideView';
import { ReportThinkingTime } from './ReportThinkingTime';
import { ReportNarrationActions } from './ReportNarrationActions';
import { ReportSlideView } from './ReportSlideView';
import { ReportSubtitleBar } from './ReportSubtitleBar';
import { ReportThumbnailRail } from './ReportThumbnailRail';
import type { ReportSession } from './useReportSession';
import { useReportModuleReveal } from './useReportModuleReveal';
import { useNarrationController } from './useNarrationController';
import { finalReplacementFor, playableReportSlides } from './report-playback';

const narrowReportLayoutQuery = '(max-width: 899px)';

const elapsedMs = (start: number, end: number) => Math.max(0, Math.round(end - start));

function readPerformanceNow() {
  return globalThis.performance.now();
}

function matchesNarrowReportLayout(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(narrowReportLayoutQuery).matches;
}

function ReportConversationShell(
  {
    initialQuestion,
    message,
    interrupted = false,
    thinkingStartedAtMs,
    thinkingDurationMs,
    leadingControls,
  }: {
    initialQuestion?: string;
    message: string;
    interrupted?: boolean;
    thinkingStartedAtMs?: number;
    thinkingDurationMs?: number;
    leadingControls?: ReactNode;
  },
) {
  return (
    <section className="report-follow-up report-conversation" aria-label="汇报对话区">
      <ol className="report-follow-up__history report-conversation__feed" aria-label="追问记录">
        {initialQuestion && (
          <>
            <li className="report-conversation__message report-conversation__message--user" aria-label="用户消息">
              <p className="report-conversation__text">{initialQuestion}</p>
            </li>
            <ReportThinkingTime
              pending={!interrupted}
              interrupted={interrupted}
              startedAtMs={thinkingStartedAtMs}
              durationMs={thinkingDurationMs}
            />
          </>
        )}
        <li className="report-conversation__message report-conversation__message--assistant" aria-label="AI 消息">
          <p className="report-conversation__text">{message}</p>
        </li>
      </ol>
      <div className="report-follow-up__form report-conversation__composer">
        <textarea aria-label="输入追问" disabled tabIndex={-1} value="" placeholder="汇报创建后可继续追问" rows={2} readOnly />
        <div className="report-conversation__composer-toolbar">
          {leadingControls ?? null}
          <div className="report-conversation__composer-actions">
            <button type="button" aria-label="语音追问" title="语音追问" disabled tabIndex={-1}>
              <MicrophoneIcon className="report-conversation__icon--microphone" />
            </button>
            <button type="button" aria-label="发送追问" title="发送追问" disabled tabIndex={-1}>
              <SendIcon className="report-conversation__icon--send" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ReportWorkspace(
  { session, launchQuestion }: { session: ReportSession; launchQuestion?: string },
) {
  const animatedSlides = useRef(new Set<string>());
  const revealReportId = useRef<string | undefined>(undefined);
  const revealedSlides = useRef(new Set<string>());
  const initialTimingRef = useRef<{ question?: string; startedAt?: number; reportId?: string; frozen: boolean }>({ frozen: false });
  const conversationPanelId = useId();
  const [auditSlideId, setAuditSlideId] = useState<string>();
  const [initialThinkingStartedAtMs, setInitialThinkingStartedAtMs] = useState<number>();
  const [initialThinkingDurationMs, setInitialThinkingDurationMs] = useState<number>();
  const [conversationPanel, setConversationPanel] = useState(() => {
    const narrow = matchesNarrowReportLayout();
    return { narrow, expanded: !narrow };
  });
  const snapshot = session.snapshot;
  const narration = useNarrationController({
    reportId: snapshot?.reportId ?? 'report-pending',
    slides: snapshot?.slides ?? [],
    outline: snapshot?.outline ?? [],
    activeSlideId: snapshot?.conversation.activeSlideId,
    initialCursor: snapshot?.conversation.narrationCursor,
    selectSlide: session.selectSlide,
    setNarrationCursor: session.setNarrationCursor,
    autoplay: Boolean(snapshot && playableReportSlides(snapshot.slides).length),
  });
  const readySlides = useMemo(() => snapshot ? [...snapshot.slides].sort((left, right) => left.order - right.order) : [], [snapshot]);
  const orderedOutlines = useMemo(
    () => (snapshot ? [...snapshot.outline].sort((left, right) => left.order - right.order) : []),
    [snapshot],
  );
  const playableSlides = useMemo(() => playableReportSlides(readySlides), [readySlides]);
  const firstPlayableSlide = playableSlides[0];
  if (snapshot?.reportId && revealReportId.current !== snapshot.reportId) {
    revealReportId.current = snapshot.reportId;
    revealedSlides.current.clear();
    if (!launchQuestion) snapshot.slides.forEach(({ id }) => revealedSlides.current.add(id));
  }
  const requestedActive = narration.activeSlideId ?? snapshot?.conversation.activeSlideId;
  const automaticSlide = finalReplacementFor(readySlides, requestedActive) ?? firstPlayableSlide;
  const auditSlide = auditSlideId ? readySlides.find(({ id }) => id === auditSlideId) : undefined;
  const activeSlide = auditSlide ?? automaticSlide;
  const pendingOutline = orderedOutlines.find(({ id }) => id === requestedActive) ?? orderedOutlines[0];
  const navigationSlide = activeSlide ? finalReplacementFor(readySlides, activeSlide.id) : undefined;
  const activeIndex = navigationSlide ? playableSlides.findIndex(({ id }) => id === navigationSlide.id) : -1;
  const initialAnswerInterrupted = Boolean(
    !firstPlayableSlide
    && (
      (snapshot && ['failed', 'cancelled'].includes(snapshot.status))
      || (!snapshot && session.phase === 'error' && session.error)
    ),
  );
  const terminalError = session.error && (
    ['REPORT_NOT_FOUND', 'REPORT_EXPIRED', 'REPORT_CANCELLED'].includes(session.error.code)
    || snapshot?.status === 'failed'
    || snapshot?.status === 'cancelled'
  );
  const markAnimated = useCallback((slide: ReportSlide) => { animatedSlides.current.add(slide.id); }, []);
  const markRevealComplete = useCallback((slideId: string) => { revealedSlides.current.add(slideId); }, []);
  const reveal = useReportModuleReveal({
    slide: activeSlide,
    immediate: Boolean(activeSlide && revealedSlides.current.has(activeSlide.id)),
    onComplete: markRevealComplete,
  });
  useEffect(() => {
    if (auditSlideId && !readySlides.some(({ id }) => id === auditSlideId)) setAuditSlideId(undefined);
  }, [auditSlideId, readySlides]);
  useEffect(() => {
    const timing = initialTimingRef.current;
    if (timing.question !== launchQuestion) {
      initialTimingRef.current = { question: launchQuestion, frozen: false };
      setInitialThinkingStartedAtMs(undefined);
      setInitialThinkingDurationMs(undefined);
    }
  }, [launchQuestion]);
  useEffect(() => {
    const timing = initialTimingRef.current;
    const observingLiveCreation = Boolean(
      launchQuestion
      && !timing.frozen
      && !timing.startedAt
      && (
        (!snapshot && session.phase === 'creating')
        || (snapshot && !firstPlayableSlide && ['generating', 'awaiting-clarification'].includes(snapshot.status))
      ),
    );
    if (observingLiveCreation) {
      timing.startedAt = readPerformanceNow();
      timing.question = launchQuestion;
      setInitialThinkingStartedAtMs(timing.startedAt);
      setInitialThinkingDurationMs(undefined);
    }
    if (snapshot?.reportId && timing.startedAt !== undefined && !timing.reportId) timing.reportId = snapshot.reportId;
    if (snapshot?.reportId && timing.reportId && timing.reportId !== snapshot.reportId) {
      initialTimingRef.current = { question: launchQuestion, frozen: false };
      setInitialThinkingStartedAtMs(undefined);
      setInitialThinkingDurationMs(undefined);
      return;
    }
    if ((firstPlayableSlide || initialAnswerInterrupted) && timing.startedAt !== undefined && !timing.frozen) {
      timing.frozen = true;
      setInitialThinkingDurationMs(elapsedMs(timing.startedAt, readPerformanceNow()));
      setInitialThinkingStartedAtMs(undefined);
    }
  }, [firstPlayableSlide, initialAnswerInterrupted, launchQuestion, session.phase, snapshot]);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia(narrowReportLayoutQuery);
    const updateLayout = (event: MediaQueryListEvent) => {
      setConversationPanel({ narrow: event.matches, expanded: !event.matches });
    };
    mediaQuery.addEventListener('change', updateLayout);
    return () => mediaQuery.removeEventListener('change', updateLayout);
  }, []);
  const selectThumbnail = useCallback((slideId: string) => {
    const selected = readySlides.find(({ id }) => id === slideId);
    if (!selected) return;
    if (selected.supersededBySlideId) {
      setAuditSlideId(selected.id);
      return;
    }
    setAuditSlideId(undefined);
    void narration.goToSlide(selected.id);
  }, [narration, readySlides]);
  const showCorrection = useCallback(() => {
    if (!activeSlide?.supersededBySlideId) return;
    const correction = finalReplacementFor(readySlides, activeSlide.id);
    if (!correction || correction.id === activeSlide.id) return;
    setAuditSlideId(undefined);
    void narration.goToSlide(correction.id);
  }, [activeSlide, narration, readySlides]);
  const goToPrevious = () => {
    if (activeIndex <= 0) return;
    setAuditSlideId(undefined);
    void narration.goToSlide(playableSlides[activeIndex - 1]!.id);
  };
  const goToNext = () => {
    if (activeIndex < 0 || activeIndex >= playableSlides.length - 1) return;
    setAuditSlideId(undefined);
    void narration.goToSlide(playableSlides[activeIndex + 1]!.id);
  };
  const leadingControls = (
    <ReportConversationToolbar
      activeIndex={activeIndex}
      pageCount={playableSlides.length}
      onPrevious={goToPrevious}
      onNext={goToNext}
      narration={<ReportNarrationActions controller={narration} />}
    />
  );
  const firstReadyTakeaway = firstPlayableSlide?.takeaway;
  const initialAnswerPending = Boolean(
    snapshot
    && !firstPlayableSlide
    && ['generating', 'awaiting-clarification'].includes(snapshot.status),
  );
  const generationLabel = snapshot && !firstPlayableSlide
    ? snapshot?.status === 'generating'
      ? '正在生成汇报'
      : snapshot?.status === 'awaiting-clarification'
        ? '等待补充说明后生成汇报'
        : '暂无有效汇报页'
    : undefined;
  const followUpPanel = snapshot ? (
    <ReportFollowUp
      reportId={snapshot.reportId}
      conversation={snapshot.conversation}
      narration={narration}
      initialQuestion={snapshot.question}
      initialAnswer={firstReadyTakeaway}
      initialAnswerPending={initialAnswerPending}
      initialAnswerInterrupted={initialAnswerInterrupted}
      initialThinkingStartedAtMs={initialThinkingStartedAtMs}
      initialThinkingDurationMs={initialThinkingDurationMs}
      generationLabel={generationLabel}
      leadingControls={leadingControls}
    />
  ) : null;
  const shellChatPanel = !snapshot && (['creating', 'restoring'].includes(session.phase) || Boolean(launchQuestion))
    ? (
      <ReportConversationShell
        initialQuestion={launchQuestion}
        message={initialAnswerInterrupted
          ? (session.error?.message ?? '汇报创建中断')
          : session.phase === 'restoring'
            ? '正在恢复动态汇报'
            : '正在创建动态汇报'}
        interrupted={initialAnswerInterrupted}
        thinkingStartedAtMs={initialThinkingStartedAtMs}
        thinkingDurationMs={initialThinkingDurationMs}
        leadingControls={leadingControls}
      />
    )
    : null;
  const chatContent = followUpPanel ?? shellChatPanel;
  const chatPanel = chatContent ? (
    <aside className="report-workspace__chat" aria-label="对话侧栏">
      {conversationPanel.narrow && (
        <button
          type="button"
          className="report-workspace__chat-toggle"
          aria-expanded={conversationPanel.expanded}
          aria-controls={conversationPanelId}
          onClick={() => setConversationPanel((current) => ({ ...current, expanded: !current.expanded }))}
        >
          {conversationPanel.expanded ? '收起对话区' : '展开对话区'}
        </button>
      )}
      <div
        id={conversationPanelId}
        className="report-workspace__chat-content"
        hidden={conversationPanel.narrow && !conversationPanel.expanded}
      >
        {chatContent}
      </div>
    </aside>
  ) : null;
  let mainContent: ReactNode;

  if (session.error) {
    mainContent = (
      <section className="report-workspace__error" aria-live="assertive">
        <p role="alert">{session.error.message}</p>
        {terminalError
          ? <button type="button" onClick={session.exit}>返回 AI 提问</button>
          : <button type="button" onClick={session.retryConnection}>重试连接</button>}
      </section>
    );
  } else {
    mainContent = (
      <>
        <ReportThumbnailRail
          snapshot={snapshot}
          activeSlideId={activeSlide?.id ?? pendingOutline?.id}
          playingSlideId={session.playingSlideId ?? (narration.status === 'speaking' ? narration.activeSlideId : undefined)}
          onSelect={selectThumbnail}
          onRetry={session.retrySlide}
        />
        <section className="report-workspace__canvas" aria-label="流式汇报画布">
          {activeSlide ? (
            <>
              <ReportSlideView
                key={activeSlide.id}
                slide={activeSlide}
                mode="canvas"
                active
                animate={!animatedSlides.current.has(activeSlide.id)}
                revealedModules={reveal.progressive ? reveal.revealedModules : undefined}
                onFirstActivation={() => markAnimated(activeSlide)}
              />
              {activeSlide.supersededBySlideId && finalReplacementFor(readySlides, activeSlide.id) && (
                <button className="report-workspace__show-correction" type="button" onClick={showCorrection}>
                  查看更正页
                </button>
              )}
            </>
          ) : snapshot && snapshot.slides.length > 0 && !firstPlayableSlide && !['generating', 'awaiting-clarification'].includes(snapshot.status) ? (
            <div className="report-workspace__empty" role="status">
              <i aria-hidden="true" />
              <p>当前没有可播放的有效页面</p>
              <span>页面更正关系异常，请刷新汇报或稍后重试。</span>
            </div>
          ) : (
            <ReportPendingSlideView outline={pendingOutline} mode="canvas" />
          )}
          {snapshot?.status === 'awaiting-clarification' && snapshot.clarification && (
            <div className="report-workspace__clarification-overlay">
              <ReportClarification
                key={snapshot.clarification.clarificationId}
                request={snapshot.clarification}
                onSubmit={session.submitClarification}
              />
            </div>
          )}
        </section>
        {snapshot && <ReportSubtitleBar controller={narration} />}
        <p className="sr-only" role="status" aria-live="polite">
          {activeSlide ? `第 ${activeSlide.order + 1} 页已完成` : pendingOutline ? `第 ${pendingOutline.order + 1} 页正在生成` : '汇报页面结构已建立'}
        </p>
      </>
    );
  }

  return (
    <main className="report-workspace" aria-label="AI 动态汇报工作区">
      <ReportHeader
        snapshot={snapshot}
        phase={session.phase}
        onExit={() => { void narration.stop(); session.exit(); }}
      />
      {mainContent}
      {chatPanel}
    </main>
  );
}
