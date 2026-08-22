import { useEffect, useRef } from 'react';
import type { NarrationController } from './useNarrationController';

function contain(action: () => void | Promise<void>): void {
  try { void Promise.resolve(action()).catch(() => undefined); } catch { /* controls stay usable */ }
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m9 6 9 6-9 6Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 6v12M15 6v12" />
    </svg>
  );
}

function ReplayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 11a8 8 0 1 1 2.3 6.2M4 5v6h6" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="7" y="7" width="10" height="10" rx="1" />
    </svg>
  );
}

export function ReportNarrationActions({ controller }: { controller: NarrationController }) {
  const continueRef = useRef<HTMLButtonElement>(null);
  const canNarrate = controller.canNarrate !== false;

  useEffect(() => {
    if (controller.status === 'paused' && controller.message.includes('浏览器已阻止自动播放')) {
      continueRef.current?.focus();
    }
  }, [controller.message, controller.status]);

  return (
    <div className="report-narration-actions">
      {!canNarrate ? (
        <button type="button" aria-label="播放讲解" title="播放讲解" disabled onClick={() => contain(controller.play)}>
          <PlayIcon />
        </button>
      ) : controller.status === 'speaking' ? (
        <button type="button" aria-label="暂停讲解" title="暂停讲解" onClick={() => contain(controller.pause)}>
          <PauseIcon />
        </button>
      ) : controller.status === 'paused' ? (
        <button ref={continueRef} type="button" aria-label="继续讲解" title="继续讲解" onClick={() => contain(controller.play)}>
          <PlayIcon />
        </button>
      ) : (
        <button type="button" aria-label="播放讲解" title="播放讲解" onClick={() => contain(controller.play)}>
          <PlayIcon />
        </button>
      )}
      <button type="button" aria-label="重播本页" title="重播本页" disabled={!canNarrate} onClick={() => contain(controller.replaySlide)}>
        <ReplayIcon />
      </button>
      <button type="button" aria-label="停止讲解" title="停止讲解" disabled={!canNarrate} onClick={() => contain(controller.stop)}>
        <StopIcon />
      </button>
    </div>
  );
}
