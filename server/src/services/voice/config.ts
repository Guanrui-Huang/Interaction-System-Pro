export type AliyunNlsConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  appKey: string;
  gateway: string;
  voice: string;
};

const required = [
  'ALIYUN_NLS_ACCESS_KEY_ID',
  'ALIYUN_NLS_ACCESS_KEY_SECRET',
  'ALIYUN_NLS_APP_KEY',
] as const;

export type AliyunNlsConfigResult =
  | { success: true; data: AliyunNlsConfig }
  | { success: false; missing: Array<typeof required[number]> };

export function getAliyunNlsConfig(env: NodeJS.ProcessEnv = process.env): AliyunNlsConfigResult {
  const values = Object.fromEntries(required.map((key) => [key, env[key]?.trim() ?? '']));
  const missing = required.filter((key) => !values[key]);
  if (missing.length) return { success: false, missing };
  return {
    success: true,
    data: {
      accessKeyId: values.ALIYUN_NLS_ACCESS_KEY_ID,
      accessKeySecret: values.ALIYUN_NLS_ACCESS_KEY_SECRET,
      appKey: values.ALIYUN_NLS_APP_KEY,
      gateway: env.ALIYUN_NLS_GATEWAY?.trim() || 'wss://nls-gateway.aliyuncs.com/ws/v1',
      voice: env.ALIYUN_NLS_VOICE?.trim() || 'xiaoyun',
    },
  };
}
