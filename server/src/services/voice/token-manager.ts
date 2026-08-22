import RPCClient from '@alicloud/pop-core';
import type { AliyunNlsConfig } from './config';

export type NlsAccessToken = { value: string; expiresAtMs: number };
export type NlsTokenProvider = (config: AliyunNlsConfig) => Promise<NlsAccessToken>;
export type AliyunNlsTokenErrorCode =
  | 'ALIYUN_NLS_TOKEN_AUTH'
  | 'ALIYUN_NLS_TOKEN_UNAVAILABLE'
  | 'ALIYUN_NLS_TOKEN_RESPONSE_INVALID';

export class AliyunNlsTokenError extends Error {
  constructor(readonly code: AliyunNlsTokenErrorCode) {
    super(code);
    this.name = 'AliyunNlsTokenError';
  }
}

const POP_AUTH_CODES = new Set([
  'forbidden',
  'invalidaccesskeyid.notfound',
  'invalidaccesskeyid',
  'invalidsecuritytoken',
  'missingaccesskeyid',
  'signaturedoesnotmatch',
  'unauthorized',
]);

function popFailureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code.trim().toLowerCase() : undefined;
}

function popFailureStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ['statusCode', 'status'] as const) {
    if (typeof record[key] === 'number') return record[key];
  }
  return undefined;
}

function classifyPopFailure(error: unknown): AliyunNlsTokenErrorCode {
  const code = popFailureCode(error);
  const status = popFailureStatus(error);
  return (code !== undefined && POP_AUTH_CODES.has(code)) || status === 401 || status === 403
    ? 'ALIYUN_NLS_TOKEN_AUTH'
    : 'ALIYUN_NLS_TOKEN_UNAVAILABLE';
}

export class AliyunNlsTokenManager {
  private cached?: NlsAccessToken;
  private inFlight?: Promise<NlsAccessToken>;

  constructor(
    private readonly config: AliyunNlsConfig,
    private readonly provider: NlsTokenProvider,
    private readonly options: { now?: () => number; refreshBeforeMs?: number } = {},
  ) {}

  async getToken(forceRefresh = false): Promise<NlsAccessToken> {
    const now = (this.options.now ?? Date.now)();
    const margin = this.options.refreshBeforeMs ?? 5 * 60 * 1_000;

    if (!forceRefresh && this.cached && this.cached.expiresAtMs - now > margin) {
      return this.cached;
    }
    if (this.inFlight) return this.inFlight;

    const request = this.provider(this.config)
      .then((token) => {
        this.cached = token;
        return token;
      })
      .finally(() => {
        if (this.inFlight === request) this.inFlight = undefined;
      });
    this.inFlight = request;
    return request;
  }
}

export function createPopTokenProvider(): NlsTokenProvider {
  return async (config) => {
    const client = new RPCClient({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      endpoint: 'https://nls-meta.cn-shanghai.aliyuncs.com',
      apiVersion: '2019-02-28',
    });

    let response: { Token?: { Id?: unknown; ExpireTime?: unknown } };
    try {
      response = await client.request('CreateToken', { RegionId: 'cn-shanghai' }, { method: 'POST' });
    } catch (error) {
      throw new AliyunNlsTokenError(classifyPopFailure(error));
    }

    const id = response.Token?.Id;
    const expireTimeSeconds = response.Token?.ExpireTime;
    if (
      typeof id !== 'string'
      || id.trim().length === 0
      || typeof expireTimeSeconds !== 'number'
      || !Number.isSafeInteger(expireTimeSeconds)
      || expireTimeSeconds <= 0
    ) {
      throw new AliyunNlsTokenError('ALIYUN_NLS_TOKEN_RESPONSE_INVALID');
    }

    const expiresAtMs = expireTimeSeconds * 1_000;
    if (!Number.isFinite(expiresAtMs) || !Number.isSafeInteger(expiresAtMs)) {
      throw new AliyunNlsTokenError('ALIYUN_NLS_TOKEN_RESPONSE_INVALID');
    }

    return { value: id, expiresAtMs };
  };
}
