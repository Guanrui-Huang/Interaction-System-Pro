import { useEffect, useMemo, useState } from 'react';
import type { ReportJobSnapshot, SlideOutline } from '../../../../shared/report';
import { ReportPendingSlideView } from './ReportPendingSlideView';
import { ReportSlideView } from './ReportSlideView';

const statusText: Record<SlideOutline['status'], string> = {
  planned: '等待生成',
  generating: '生成中',
  ready: '已完成',
  failed: '生成失败',
};

type ReportThumbnailRailProps = {
  snapshot: ReportJobSnapshot | null;
  activeSlideId?: string;
  playingSlideId?: string | null;
  onSelect(slideId: string): void;
  onRetry(slideId: string): Promise<void>;
};

export function ReportThumbnailRail({ snapshot, activeSlideId, playingSlideId, onSelect, onRetry }: ReportThumbnailRailProps) {
  const [acceptedRetries, setAcceptedRetries] = useState<Set<string>>(() => new Set());
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const outlines = useMemo(() => (snapshot ? [...snapshot.outline].sort((left, right) => left.order - right.order) : []), [snapshot]);
  const slides = useMemo(() => new Map((snapshot?.slides ?? []).map((slide) => [slide.id, slide])), [snapshot]);

  useEffect(() => {
    setAcceptedRetries((current) => {
      const next = new Set([...current].filter((id) => outlines.some((item) => item.id === id && item.status === 'failed')));
      return next.size === current.size ? current : next;
    });
    setRetryErrors((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => outlines.some((item) => item.id === id && item.status === 'failed')));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [outlines]);

  const retry = (slideId: string) => {
    if (acceptedRetries.has(slideId)) return;
    setAcceptedRetries((current) => new Set(current).add(slideId));
    setRetryErrors((current) => {
      const next = { ...current };
      delete next[slideId];
      return next;
    });
    void onRetry(slideId).catch((caught: unknown) => {
      setRetryErrors((current) => ({ ...current, [slideId]: caught instanceof Error ? caught.message : '该页重试未成功，请再次重试。' }));
      setAcceptedRetries((current) => {
        const next = new Set(current);
        next.delete(slideId);
        return next;
      });
    });
  };

  return (
    <nav className="report-thumbnail-rail" aria-label="汇报页面">
      <div className="report-thumbnail-rail__label"><span>PAGE CHANNEL</span><strong>{Math.max(1, outlines.length)} 页</strong></div>
      <ol>
        {!snapshot && (
          <li className="report-thumbnail report-thumbnail--planned">
            <div className="report-thumbnail__preview" aria-hidden="true">
              <span className="report-thumbnail__sequence">01</span>
              <ReportPendingSlideView mode="thumbnail" />
            </div>
          </li>
        )}
        {outlines.map((item) => {
          const readySlide = item.status === 'ready' ? slides.get(item.id) : undefined;
          const playing = playingSlideId === item.id;
          const superseded = readySlide?.supersededBySlideId !== undefined;
          const labelStatus = superseded ? '已被更正' : playing ? '正在讲解' : statusText[item.status];
          const selectionLabel = `第 ${item.order + 1} 页，${item.title}，${labelStatus}`;
          return (
            <li className={`report-thumbnail report-thumbnail--${item.status}${superseded ? ' report-thumbnail--superseded' : ''}${playing ? ' report-thumbnail--playing' : ''}${activeSlideId === item.id ? ' report-thumbnail--active' : ''}`} key={item.id}>
              <div className="report-thumbnail__preview" aria-hidden="true">
                <span className="report-thumbnail__sequence">{String(item.order + 1).padStart(2, '0')}</span>
                {readySlide
                  ? <ReportSlideView slide={readySlide} mode="thumbnail" active={activeSlideId === item.id} animate={false} />
                  : <ReportPendingSlideView outline={item} mode="thumbnail" />}
              </div>
              <button
                className="report-thumbnail__select"
                type="button"
                aria-label={selectionLabel}
                aria-current={playing ? 'page' : undefined}
                aria-pressed={activeSlideId === item.id}
                aria-disabled={!readySlide || undefined}
                onClick={() => { if (readySlide) onSelect(item.id); }}
              >
                <span className="sr-only">{selectionLabel}</span>
              </button>
              {item.status === 'failed' && item.retryable && (
                <button className="report-thumbnail__retry" type="button" disabled={acceptedRetries.has(item.id)} onClick={() => retry(item.id)}>重试第 {item.order + 1} 页</button>
              )}
              {retryErrors[item.id] && <p className="report-thumbnail__retry-error" role="alert">{retryErrors[item.id]}</p>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
