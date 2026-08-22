import { useEffect, useRef, useState } from 'react';

export type ReportThinkingTimeProps = {
  pending?: boolean;
  startedAtMs?: number;
  durationMs?: number;
  interrupted?: boolean;
  now?: () => number;
};

const defaultNow = () => globalThis.performance.now();
const completedSeconds = (durationMs: number) => Math.max(1, Math.round(Math.max(0, durationMs) / 1_000));
const pendingSeconds = (startedAtMs: number, nowMs: number) => (
  Math.max(1, Math.floor(Math.max(0, nowMs - startedAtMs) / 1_000) + 1)
);

export function ReportThinkingTime({
  pending = false,
  startedAtMs,
  durationMs,
  interrupted = false,
  now = defaultNow,
}: ReportThinkingTimeProps) {
  const fallbackStartRef = useRef<number | null>(startedAtMs ?? null);
  const wasPendingRef = useRef(pending);
  const [, setTick] = useState(0);

  if (startedAtMs !== undefined) fallbackStartRef.current = startedAtMs;
  else if (pending && !wasPendingRef.current) fallbackStartRef.current = now();

  const start = fallbackStartRef.current ?? now();
  const seconds = pending ? pendingSeconds(start, now()) : null;

  useEffect(() => {
    wasPendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    if (!pending) return undefined;
    const timer = globalThis.setInterval(() => {
      setTick((current) => current + 1);
    }, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [pending]);

  const text = pending
    ? `思考 ${seconds}s ›`
    : interrupted
      ? durationMs === undefined ? '思考中断' : `思考中断 · ${completedSeconds(durationMs)}s`
      : durationMs === undefined ? null : `思考 ${completedSeconds(durationMs)}s ›`;
  const announcement = pending ? 'AI 正在思考' : interrupted ? 'AI 思考中断' : null;

  return text
    ? (
      <li className="report-conversation__thinking">
        <span aria-hidden="true">{text}</span>
        {announcement ? (
          <span className="sr-only" role="status" aria-live="polite">
            {announcement}
          </span>
        ) : null}
      </li>
    )
    : null;
}
