import { expect, it } from 'vitest';
import { getQwenOmniConfig } from '../src/services/voice/omni-config';

it('requires only the server-side DashScope key and workspace id', () => {
  expect(getQwenOmniConfig({})).toEqual({
    success: false,
    missing: ['DASHSCOPE_API_KEY', 'DASHSCOPE_WORKSPACE_ID'],
  });
});

it('uses Qwen3.5 Omni recognition and dedicated Beijing TTS defaults', () => {
  expect(getQwenOmniConfig({
    DASHSCOPE_API_KEY: ' key ',
    DASHSCOPE_WORKSPACE_ID: ' workspace-1 ',
  })).toEqual({
    success: true,
    data: {
      apiKey: 'key',
      workspaceId: 'workspace-1',
      region: 'cn',
      model: 'qwen3.5-omni-flash-realtime',
      baseUrl: 'wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
      speechModel: 'qwen-audio-3.0-tts-plus',
      speechBaseUrl: 'https://workspace-1.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
      speechVoice: 'longanlingxin',
    },
  });
});

it('supports the Singapore workspace endpoint and explicit model or URL overrides', () => {
  expect(getQwenOmniConfig({
    DASHSCOPE_API_KEY: 'key',
    DASHSCOPE_WORKSPACE_ID: 'workspace-intl',
    DASHSCOPE_REGION: 'intl',
    QWEN_OMNI_MODEL: 'qwen3.5-omni-plus-realtime',
    QWEN_OMNI_BASE_URL: 'wss://realtime.test/ws',
    DASHSCOPE_TTS_MODEL: 'qwen-audio-3.0-tts-flash',
    DASHSCOPE_TTS_BASE_URL: 'https://tts.test/synthesize',
    DASHSCOPE_TTS_VOICE: 'longanfengyue',
  })).toEqual({
    success: true,
    data: {
      apiKey: 'key',
      workspaceId: 'workspace-intl',
      region: 'intl',
      model: 'qwen3.5-omni-plus-realtime',
      baseUrl: 'wss://realtime.test/ws',
      speechModel: 'qwen-audio-3.0-tts-flash',
      speechBaseUrl: 'https://tts.test/synthesize',
      speechVoice: 'longanfengyue',
    },
  });
});
