import { ReportNarrationActions } from './ReportNarrationActions';
import { ReportSubtitleBar } from './ReportSubtitleBar';
import type { NarrationController } from './useNarrationController';

export function ReportNarrationControls({ controller }: { controller: NarrationController }) {
  return (
    <div className="report-narration-controls">
      <ReportNarrationActions controller={controller} />
      <ReportSubtitleBar controller={controller} />
    </div>
  );
}
