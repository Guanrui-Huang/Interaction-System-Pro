import type { ReactNode } from 'react';

type ReportConversationToolbarProps = {
  activeIndex: number;
  pageCount: number;
  onPrevious: () => void;
  onNext: () => void;
  narration: ReactNode;
};

function PreviousPageIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M18 6 12 12l6 6M6 5v14" />
    </svg>
  );
}

function NextPageIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m6 6 6 6-6 6M18 5v14" />
    </svg>
  );
}

export function ReportConversationToolbar({
  activeIndex,
  pageCount,
  onPrevious,
  onNext,
  narration,
}: ReportConversationToolbarProps) {
  return (
    <div className="report-conversation__leading-controls" aria-label="页面与讲解控制">
      <button type="button" aria-label="上一页" title="上一页" disabled={activeIndex <= 0} onClick={onPrevious}>
        <PreviousPageIcon />
      </button>
      {narration}
      <button type="button" aria-label="下一页" title="下一页" disabled={activeIndex < 0 || activeIndex >= pageCount - 1} onClick={onNext}>
        <NextPageIcon />
      </button>
    </div>
  );
}
