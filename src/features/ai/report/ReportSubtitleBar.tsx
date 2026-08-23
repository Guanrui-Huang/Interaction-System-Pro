import type { NarrationController } from './useNarrationController';

export function ReportSubtitleBar({ controller }: { controller: NarrationController }) {
  const cue = controller.subtitle;

  return (
    <section className="report-subtitle-bar" aria-label="讲解字幕">
      <p className="report-subtitle-bar__text">{cue}</p>
      <p className="report-subtitle-bar__status" role="status" aria-live="polite" aria-atomic="true">
        {controller.canNarrate === false ? '没有可播放的讲解页面' : controller.message}
      </p>
      {controller.error && <p className="report-subtitle-bar__error" role="alert">{controller.error}</p>}
    </section>
  );
}
