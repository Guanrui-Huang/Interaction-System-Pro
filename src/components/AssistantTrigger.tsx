import { forwardRef } from 'react';

type AssistantTriggerProps = {
  onClick: () => void;
};

export const AssistantTrigger = forwardRef<HTMLButtonElement, AssistantTriggerProps>(function AssistantTrigger({ onClick }, ref) {
  return (
    <button ref={ref} aria-label="唤起 AI 运营助手" className="assistant-trigger" type="button" onClick={onClick}>
      <span aria-hidden="true" className="assistant-trigger__icon">✦</span>
      <span className="assistant-trigger__label">唤起 AI 运营助手</span>
      <span aria-hidden="true" className="assistant-trigger__meta">AI COPILOT</span>
      <span aria-hidden="true" className="assistant-trigger__status" />
    </button>
  );
});
