import { VOICE_ERROR_MESSAGES, type VoiceErrorCode } from '../../../../shared/voice';
import type { VoicePlaybackProgress, VoicePlaybackStatus } from './useVoicePlayback';
import type { VoiceRecognitionStatus } from './useVoiceRecognition';

type RecognitionViewState = {
  status: VoiceRecognitionStatus;
  confirmedText: string;
  interimText: string;
  elapsedMs: number;
  errorCode: VoiceErrorCode | null;
};

type PlaybackViewState = {
  status: VoicePlaybackStatus;
  progress: VoicePlaybackProgress;
  errorCode: VoiceErrorCode | null;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
};

export type VoiceInteractionProps = {
  recognition: RecognitionViewState;
  playback: PlaybackViewState;
  isAnalyzing: boolean;
  isStartingRecognition?: boolean;
  onStartRecognition(): void | Promise<void>;
  onStopRecognition(): void | Promise<void>;
};

const activeRecognitionStatuses = new Set<VoiceRecognitionStatus>([
  'requesting-permission',
  'connecting',
  'recording',
  'stopping',
]);

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutesPart = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secondsPart = (seconds % 60).toString().padStart(2, '0');
  return `${minutesPart}:${secondsPart}`;
}

function statusHint(
  recognitionStatus: VoiceRecognitionStatus,
  playbackStatus: VoicePlaybackStatus,
  isAnalyzing: boolean,
): string {
  if (isAnalyzing) return '正在分析问题…';
  if (recognitionStatus === 'requesting-permission') return '正在获取麦克风权限…';
  if (recognitionStatus === 'connecting') return '正在连接语音服务…';
  if (recognitionStatus === 'recording') return '正在聆听，请说出您的问题';
  if (recognitionStatus === 'stopping') return '正在确认识别结果…';
  if (playbackStatus === 'preparing') return '正在准备语音回答…';
  if (playbackStatus === 'speaking') return '正在播放语音回答';
  if (playbackStatus === 'paused') return '语音回答已暂停';
  return 'Qwen3.5-Omni · 点击开始说话';
}

function ControlIcon({ kind }: { kind: 'pause' | 'play' | 'stop' }) {
  if (kind === 'pause') {
    return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M6.5 4.5v11M13.5 4.5v11" /></svg>;
  }
  if (kind === 'play') {
    return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m7 4.8 8 5.2-8 5.2Z" /></svg>;
  }
  return <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="5.25" y="5.25" width="9.5" height="9.5" rx="1" /></svg>;
}

function containControl(action: () => void | Promise<void>): void {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // Event handlers must not leak optional voice-control failures.
  }
}

export function VoiceInteraction({
  recognition,
  playback,
  isAnalyzing,
  isStartingRecognition = false,
  onStartRecognition,
  onStopRecognition,
}: VoiceInteractionProps) {
  const recognitionActive = activeRecognitionStatuses.has(recognition.status);
  const listening = recognition.status === 'recording';
  const voiceError = recognition.errorCode ?? playback.errorCode;
  const hint = voiceError ? VOICE_ERROR_MESSAGES[voiceError] : statusHint(recognition.status, playback.status, isAnalyzing);

  const toggleRecognition = () => {
    if (recognitionActive) {
      containControl(onStopRecognition);
    } else {
      containControl(onStartRecognition);
    }
  };

  return (
    <div className={`ai-voice-interaction${listening ? ' ai-voice-interaction--listening' : ''}`}>
      <div className={`ai-microphone${listening ? ' ai-microphone--listening' : ''}`}>
        <span aria-hidden="true" className="ai-microphone__wave ai-microphone__wave--one" />
        <span aria-hidden="true" className="ai-microphone__wave ai-microphone__wave--two" />
        <button
          aria-label={recognitionActive ? '结束语音提问' : '开始语音提问'}
          aria-pressed={listening}
          className="ai-microphone__button"
          disabled={isAnalyzing || isStartingRecognition}
          onClick={toggleRecognition}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 32 32">
            <rect x="11" y="4" width="10" height="16" rx="5" />
            <path d="M7.5 15.5v1a8.5 8.5 0 0 0 17 0v-1M16 25v4M11.5 29h9" />
          </svg>
        </button>
      </div>

      <div aria-live="polite" aria-atomic="true" className="ai-voice-transcript" role="status">
        <span className="ai-voice-transcript__confirmed">{recognition.confirmedText}</span>
        {recognition.interimText && <span className="ai-voice-transcript__interim">{recognition.interimText}</span>}
      </div>

      <div className="ai-voice-meta">
        <p
          className={`ai-interaction-zone__hint${voiceError ? ' ai-interaction-zone__hint--error' : ''}`}
          role={voiceError ? 'alert' : undefined}
        >
          {hint}
        </p>
        <time aria-label={`录音时长 ${formatElapsed(recognition.elapsedMs)}`} className="ai-voice-timer">
          {formatElapsed(recognition.elapsedMs)}
        </time>
        <span aria-hidden="true" className="ai-voice-wave">
          <i className="ai-voice-wave__bar" />
          <i className="ai-voice-wave__bar" />
          <i className="ai-voice-wave__bar" />
          <i className="ai-voice-wave__bar" />
        </span>
      </div>

      {(playback.status === 'preparing' || playback.status === 'speaking' || playback.status === 'paused') && (
        <div className="ai-voice-controls">
          <p
            aria-label="语音播放进度"
            aria-valuemax={Math.max(1, playback.progress.total)}
            aria-valuemin={0}
            aria-valuenow={playback.progress.completed}
            className="ai-voice-progress"
            role="progressbar"
          >
            已播放 {playback.progress.completed} / {playback.progress.total} 段
          </p>
          {playback.status === 'speaking' && (
            <button aria-label="暂停播报" onClick={() => containControl(playback.pause)} type="button">
              <ControlIcon kind="pause" />
            </button>
          )}
          {playback.status === 'paused' && (
            <button aria-label="继续播报" onClick={() => containControl(playback.resume)} type="button">
              <ControlIcon kind="play" />
            </button>
          )}
          <button aria-label="停止播报" onClick={() => containControl(playback.stop)} type="button">
            <ControlIcon kind="stop" />
          </button>
        </div>
      )}
    </div>
  );
}
