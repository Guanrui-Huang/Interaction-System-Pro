export type QwenOmniRegion = 'cn' | 'intl';

export type QwenOmniConfig = {
  apiKey: string;
  workspaceId: string;
  region: QwenOmniRegion;
  model: string;
  baseUrl: string;
  speechModel: string;
  speechBaseUrl: string;
  speechVoice: string;
};

const required = [
  'DASHSCOPE_API_KEY',
  'DASHSCOPE_WORKSPACE_ID',
] as const;

export type QwenOmniConfigResult =
  | { success: true; data: QwenOmniConfig }
  | { success: false; missing: Array<typeof required[number]> };

function regionFrom(value: string | undefined): QwenOmniRegion {
  return value?.trim().toLowerCase() === 'intl' ? 'intl' : 'cn';
}

function defaultBaseUrl(workspaceId: string, region: QwenOmniRegion): string {
  return `wss://${workspaceDomain(workspaceId, region)}/api-ws/v1/realtime`;
}

function workspaceDomain(workspaceId: string, region: QwenOmniRegion): string {
  return region === 'intl'
    ? `${workspaceId}.ap-southeast-1.maas.aliyuncs.com`
    : `${workspaceId}.cn-beijing.maas.aliyuncs.com`;
}

function defaultSpeechBaseUrl(workspaceId: string, region: QwenOmniRegion): string {
  return `https://${workspaceDomain(workspaceId, region)}/api/v1/services/audio/tts/SpeechSynthesizer`;
}

export function getQwenOmniConfig(env: NodeJS.ProcessEnv = process.env): QwenOmniConfigResult {
  const values = Object.fromEntries(required.map((key) => [key, env[key]?.trim() ?? '']));
  const missing = required.filter((key) => !values[key]);
  if (missing.length) return { success: false, missing };

  const region = regionFrom(env.DASHSCOPE_REGION);
  const workspaceId = values.DASHSCOPE_WORKSPACE_ID;
  return {
    success: true,
    data: {
      apiKey: values.DASHSCOPE_API_KEY,
      workspaceId,
      region,
      model: env.QWEN_OMNI_MODEL?.trim() || 'qwen3.5-omni-flash-realtime',
      baseUrl: env.QWEN_OMNI_BASE_URL?.trim() || defaultBaseUrl(workspaceId, region),
      speechModel: env.DASHSCOPE_TTS_MODEL?.trim() || 'qwen-audio-3.0-tts-plus',
      speechBaseUrl: env.DASHSCOPE_TTS_BASE_URL?.trim()
        || defaultSpeechBaseUrl(workspaceId, region),
      speechVoice: env.DASHSCOPE_TTS_VOICE?.trim() || 'longanlingxin',
    },
  };
}
