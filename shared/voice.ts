export const VOICE_ERROR_CODES = [
  'VOICE_NOT_CONFIGURED',
  'VOICE_PERMISSION_DENIED',
  'VOICE_UNSUPPORTED',
  'VOICE_UPSTREAM_AUTH',
  'VOICE_UPSTREAM_TIMEOUT',
  'VOICE_UPSTREAM_UNAVAILABLE',
  'VOICE_INVALID_AUDIO',
  'VOICE_NO_SPEECH',
  'VOICE_ANSWER_NOT_FOUND',
  'VOICE_LIMIT_EXCEEDED',
] as const;

export type VoiceErrorCode = typeof VOICE_ERROR_CODES[number];

export const VOICE_TEXT_SEGMENT_MAX_CHARS = 280;
export const VOICE_MAX_SYNTHESIS_SEGMENTS = 64;
export const VOICE_MAX_AUDIO_SEGMENT_BYTES = 4 * 1024 * 1024;
export const VOICE_MAX_AUDIO_TOTAL_BYTES = 32 * 1024 * 1024;
export const VOICE_MAX_SPEECH_ANSWER_CHARS = VOICE_TEXT_SEGMENT_MAX_CHARS
  * VOICE_MAX_SYNTHESIS_SEGMENTS;
export const VOICE_DEEPSEEK_MAX_OUTPUT_TOKENS = 8_192;
export const VOICE_OPAQUE_ID_MAX_CHARS = 256;
export const VOICE_ERROR_MESSAGE_MAX_CHARS = 1_024;

export const VOICE_ERROR_MESSAGES: Record<VoiceErrorCode, string> = {
  VOICE_NOT_CONFIGURED: '未配置百炼语音服务，请在 server/.env 中填写百炼 API Key 和 Workspace ID。',
  VOICE_PERMISSION_DENIED: '麦克风权限被拒绝，请在浏览器站点设置中允许麦克风。',
  VOICE_UNSUPPORTED: '当前浏览器不支持语音采集，请使用最新版 Chrome 或 Edge。',
  VOICE_UPSTREAM_AUTH: '百炼语音服务鉴权失败，请检查 server/.env 中的百炼凭证。',
  VOICE_UPSTREAM_TIMEOUT: '百炼语音服务响应超时，请稍后重试。',
  VOICE_UPSTREAM_UNAVAILABLE: '百炼语音服务暂不可用，您仍可使用文字提问。',
  VOICE_INVALID_AUDIO: '录音格式无效，请重新开始录音。',
  VOICE_NO_SPEECH: '没有识别到有效语音，请重试。',
  VOICE_ANSWER_NOT_FOUND: '语音答案已过期，请重新生成 AI 分析。',
  VOICE_LIMIT_EXCEEDED: '单次录音最长 60 秒，请缩短问题后重试。',
};

export type RecognitionClientMessage =
  | { type: 'start'; format: 'pcm'; sampleRate: 16000 }
  | { type: 'stop' };

export type RecognitionServerMessage =
  | { type: 'ready' }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'completed'; text: string }
  | { type: 'error'; code: VoiceErrorCode; message: string };

export type SynthesisClientMessage =
  | { type: 'synthesize'; reportId: string; speechId: string }
  | { type: 'cancel' };

export type SynthesisServerMessage =
  | { type: 'ready'; segmentCount: number }
  | { type: 'segment-start'; index: number }
  | { type: 'segment-end'; index: number }
  | { type: 'completed' }
  | { type: 'error'; code: VoiceErrorCode; message: string };
