import { useState, type FormEvent } from 'react';
import type { ClarificationRequest } from '../../../../shared/report';

export function ReportClarification({ request, onSubmit }: { request: ClarificationRequest; onSubmit(clarificationId: string, answer: string): Promise<void> }) {
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = answer.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request.clarificationId, trimmed);
    } catch {
      setError('补充说明暂未提交成功，请重试。');
      setSubmitting(false);
    }
  };
  return (
    <section className="report-clarification" aria-labelledby="report-clarification-title">
      <p>需要补充信息</p>
      <h2 id="report-clarification-title">{request.prompt}</h2>
      <form onSubmit={(event) => { void submit(event); }}>
        <label htmlFor="report-clarification-answer">补充说明</label>
        <textarea id="report-clarification-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} rows={3} />
        {request.suggestions.length > 0 && <div className="report-clarification__suggestions">{request.suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => setAnswer(suggestion)}>{suggestion}</button>)}</div>}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={!answer.trim() || submitting}>{submitting ? '正在提交' : '继续分析'}</button>
      </form>
    </section>
  );
}
