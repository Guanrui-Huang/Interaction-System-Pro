import type { PublicAssistantProfile } from './report-evidence';

const PUBLIC_MODEL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'deepseek-v4-flash': 'DeepSeek v4-flash',
  'deepseek-chat': 'DeepSeek Chat',
  'deepseek-reasoner': 'DeepSeek Reasoner',
});

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;

  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

export function publicAssistantProfile(modelId: string): PublicAssistantProfile {
  const publicModelName = Object.hasOwn(PUBLIC_MODEL_NAMES, modelId)
    ? PUBLIC_MODEL_NAMES[modelId]
    : undefined;
  return deepFreeze({
    key: 'assistant-profile',
    assistantName: '智慧水务 AI 助手',
    ...(publicModelName === undefined ? {} : { publicModelName }),
    capabilities: ['解释污水处理与运营管理知识', '基于受限证据包分析现场数据'],
    limitations: ['现场数值结论仅引用已提供的证据', '不公开凭证、私有配置或本地文件路径'],
  });
}
