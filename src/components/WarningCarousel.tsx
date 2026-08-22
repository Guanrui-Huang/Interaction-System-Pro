import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AlertRecord } from '../../shared/dashboard';

gsap.registerPlugin(useGSAP);

type WarningCarouselProps = {
  alerts: AlertRecord[];
};

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
const scrollPixelsPerSecond = 24;
const maxScrollDurationSeconds = 7.5;

function useReducedMotionPreference(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(reducedMotionQuery).matches);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia(reducedMotionQuery);
    const updatePreference = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    setReducedMotion(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updatePreference);
      return () => mediaQuery.removeEventListener('change', updatePreference);
    }
    mediaQuery.addListener(updatePreference);
    return () => mediaQuery.removeListener(updatePreference);
  }, []);

  return reducedMotion;
}

export function WarningCarousel({ alerts }: WarningCarouselProps) {
  const ordered = useMemo(() => [...alerts].sort((a, b) => b.date.localeCompare(a.date)), [alerts]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const geometryRef = useRef<{ clientHeight: number; scrollHeight: number } | null>(null);
  const [hoverPaused, setHoverPaused] = useState(false);
  const [focusPaused, setFocusPaused] = useState(false);
  const [pointerPaused, setPointerPaused] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [geometryRevision, setGeometryRevision] = useState(0);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const reducedMotion = useReducedMotionPreference();
  const paused = hoverPaused || focusPaused || pointerPaused || userPaused || !visible;

  useEffect(() => {
    const updateVisibility = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list || typeof ResizeObserver !== 'function') return;
    const readGeometry = () => ({ clientHeight: viewport.clientHeight, scrollHeight: viewport.scrollHeight });
    geometryRef.current = readGeometry();
    const observer = new ResizeObserver(() => {
      const nextGeometry = readGeometry();
      const previousGeometry = geometryRef.current;
      if (previousGeometry?.clientHeight === nextGeometry.clientHeight
        && previousGeometry.scrollHeight === nextGeometry.scrollHeight) return;
      geometryRef.current = nextGeometry;
      setGeometryRevision((revision) => revision + 1);
    });
    observer.observe(viewport);
    observer.observe(list);
    return () => observer.disconnect();
  }, [ordered]);

  useGSAP(() => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    timelineRef.current = null;
    setHasOverflow(false);
    if (!viewport || !list) return;

    viewport.scrollTop = 0;
    if (reducedMotion) return;

    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    geometryRef.current = { clientHeight: viewport.clientHeight, scrollHeight: viewport.scrollHeight };
    if (maxScroll === 0) return;

    setHasOverflow(true);
    const scrollDuration = Math.min(maxScroll / scrollPixelsPerSecond, maxScrollDurationSeconds);
    const timeline = gsap.timeline({ repeat: -1, paused })
      .set(viewport, { scrollTop: 0 })
      .to(viewport, { scrollTop: maxScroll, duration: scrollDuration, ease: 'none' })
      .to({}, { duration: 0.8 })
      .to(list, { autoAlpha: 0, duration: 0.18 })
      .set(viewport, { scrollTop: 0 })
      .to(list, { autoAlpha: 1, duration: 0.18 });
    timelineRef.current = timeline;

    return () => {
      timeline.kill();
      if (timelineRef.current === timeline) timelineRef.current = null;
    };
  }, { scope: viewportRef, dependencies: [ordered, reducedMotion, geometryRevision], revertOnUpdate: true });

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    if (paused) timeline.pause();
    else timeline.play();
  }, [paused]);

  const beginPointerInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (typeof event.currentTarget.setPointerCapture === 'function') event.currentTarget.setPointerCapture(event.pointerId);
    setPointerPaused(true);
  };

  const endPointerInteraction = () => setPointerPaused(false);

  if (!ordered.length) return <p className="warning-empty">暂无新增预警，当前指标运行正常。</p>;

  return <div className="warning-carousel-shell">
    <div className="warning-carousel__controls">
      {hasOverflow && !reducedMotion ? <button
        type="button"
        className="warning-carousel__control"
        aria-pressed={userPaused}
        onClick={() => setUserPaused((value) => !value)}
      >{userPaused ? '继续预警轮播' : '暂停预警轮播'}</button> : null}
    </div>
    <div
      ref={viewportRef}
      className={`warning-carousel${reducedMotion ? ' warning-carousel--static' : ''}`}
      role="region"
      aria-label="预警自动播放"
      aria-live={hasOverflow && !paused ? 'off' : 'polite'}
      tabIndex={0}
      onMouseEnter={() => setHoverPaused(true)}
      onMouseLeave={() => setHoverPaused(false)}
      onFocus={() => setFocusPaused(true)}
      onBlur={() => setFocusPaused(false)}
      onPointerDown={beginPointerInteraction}
      onPointerUp={endPointerInteraction}
      onPointerCancel={endPointerInteraction}
    >
      <div ref={listRef} className="warning-carousel__list">
        {ordered.map((alert, index) => <WarningItem key={`${alert.date}-${alert.metric}-${index}`} alert={alert} />)}
      </div>
    </div>
  </div>;
}

function WarningItem({ alert }: { alert: AlertRecord }) {
  return <article className="warning-carousel__item">
    <span className="warning-dot" />
    <div><strong>{alert.metric} · {alert.level}</strong><p>{alert.reason}</p><time>{alert.date}</time><small>{alert.recommendation}</small></div>
  </article>;
}
