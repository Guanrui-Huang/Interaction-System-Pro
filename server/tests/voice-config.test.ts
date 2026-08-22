import { expect, it } from 'vitest';
import {
  VOICE_DEEPSEEK_MAX_OUTPUT_TOKENS,
  VOICE_ERROR_MESSAGES,
  VOICE_MAX_AUDIO_SEGMENT_BYTES,
  VOICE_MAX_AUDIO_TOTAL_BYTES,
  VOICE_MAX_SPEECH_ANSWER_CHARS,
  VOICE_MAX_SYNTHESIS_SEGMENTS,
  VOICE_TEXT_SEGMENT_MAX_CHARS,
} from '../../shared/voice';
import { getAliyunNlsConfig } from '../src/services/voice/config';

it('reports every missing fixed ISI credential without exposing values', () => {
  expect(getAliyunNlsConfig({})).toEqual({
    success: false,
    missing: [
      'ALIYUN_NLS_ACCESS_KEY_ID',
      'ALIYUN_NLS_ACCESS_KEY_SECRET',
      'ALIYUN_NLS_APP_KEY',
    ],
  });
  expect(VOICE_ERROR_MESSAGES.VOICE_NOT_CONFIGURED).toContain('server/.env');
});

it('trims credentials and applies the confirmed gateway and voice defaults', () => {
  expect(getAliyunNlsConfig({
    ALIYUN_NLS_ACCESS_KEY_ID: ' ak-id ',
    ALIYUN_NLS_ACCESS_KEY_SECRET: ' ak-secret ',
    ALIYUN_NLS_APP_KEY: ' app-key ',
  })).toEqual({
    success: true,
    data: {
      accessKeyId: 'ak-id',
      accessKeySecret: 'ak-secret',
      appKey: 'app-key',
      gateway: 'wss://nls-gateway.aliyuncs.com/ws/v1',
      voice: 'xiaoyun',
    },
  });
});

it('shares one bounded synthesis contract across browser, server, and DeepSeek output', () => {
  expect(VOICE_TEXT_SEGMENT_MAX_CHARS).toBe(280);
  expect(VOICE_MAX_SYNTHESIS_SEGMENTS).toBe(64);
  expect(VOICE_MAX_AUDIO_SEGMENT_BYTES).toBe(4 * 1024 * 1024);
  expect(VOICE_MAX_AUDIO_TOTAL_BYTES).toBe(32 * 1024 * 1024);
  expect(VOICE_MAX_SPEECH_ANSWER_CHARS).toBe(280 * 64);
  expect(VOICE_DEEPSEEK_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(VOICE_MAX_SPEECH_ANSWER_CHARS);
});
