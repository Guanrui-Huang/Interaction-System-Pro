import { expect, it, beforeEach, vi } from 'vitest';
import RPCClient from '@alicloud/pop-core';
import {
  AliyunNlsTokenError,
  AliyunNlsTokenManager,
  createPopTokenProvider,
} from '../src/services/voice/token-manager';

vi.mock('@alicloud/pop-core', () => ({ default: vi.fn() }));

const config = {
  accessKeyId: 'id',
  accessKeySecret: 'secret',
  appKey: 'app',
  gateway: 'wss://nls.test/ws/v1',
  voice: 'xiaoyun',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function popResponse(token: { Id: unknown; ExpireTime: unknown }) {
  return {
    NlsRequestId: 'nls-request-id',
    RequestId: 'request-id',
    Token: {
      ...token,
      UserId: 'user-id',
    },
  };
}

beforeEach(() => {
  vi.mocked(RPCClient).mockReset();
});

it('reuses a healthy token and refreshes inside the five-minute safety window', async () => {
  let now = 1_000_000;
  const provider = vi.fn()
    .mockResolvedValueOnce({ value: 'token-1', expiresAtMs: now + 600_000 })
    .mockResolvedValueOnce({ value: 'token-2', expiresAtMs: now + 1_200_000 });
  const manager = new AliyunNlsTokenManager(config, provider, { now: () => now });

  expect((await manager.getToken()).value).toBe('token-1');
  expect((await manager.getToken()).value).toBe('token-1');
  now += 300_001;
  expect((await manager.getToken()).value).toBe('token-2');
  expect(provider).toHaveBeenCalledTimes(2);
});

it('deduplicates normal and forced callers against the same in-flight refresh', async () => {
  const first = deferred<{ value: string; expiresAtMs: number }>();
  const provider = vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue({ value: 'forced-token', expiresAtMs: Date.now() + 86_400_000 });
  const manager = new AliyunNlsTokenManager(config, provider);

  const callers = [manager.getToken(), manager.getToken(true), manager.getToken(true)];
  expect(provider).toHaveBeenCalledTimes(1);
  first.resolve({ value: 'token', expiresAtMs: Date.now() + 86_400_000 });
  await expect(Promise.all(callers)).resolves.toEqual([
    expect.objectContaining({ value: 'token' }),
    expect.objectContaining({ value: 'token' }),
    expect.objectContaining({ value: 'token' }),
  ]);

  await Promise.all([manager.getToken(true), manager.getToken(true)]);
  expect(provider).toHaveBeenCalledTimes(2);
});

it('clears a rejected refresh so the next request can retry', async () => {
  const provider = vi.fn()
    .mockRejectedValueOnce(new Error('provider failed'))
    .mockResolvedValueOnce({ value: 'retry-token', expiresAtMs: Date.now() + 86_400_000 });
  const manager = new AliyunNlsTokenManager(config, provider);

  await expect(manager.getToken()).rejects.toThrow('provider failed');
  expect((await manager.getToken()).value).toBe('retry-token');
  expect(provider).toHaveBeenCalledTimes(2);
});

it('configures CreateToken and converts valid expiry seconds to milliseconds', async () => {
  const request = vi.fn().mockResolvedValue(popResponse({
    Id: 'valid-token',
    ExpireTime: 1_527_592_757,
  }));
  vi.mocked(RPCClient).mockImplementation(() => ({ request }) as unknown as RPCClient);

  await expect(createPopTokenProvider()(config)).resolves.toEqual({
    value: 'valid-token',
    expiresAtMs: 1_527_592_757_000,
  });
  expect(RPCClient).toHaveBeenCalledWith({
    accessKeyId: 'id',
    accessKeySecret: 'secret',
    endpoint: 'https://nls-meta.cn-shanghai.aliyuncs.com',
    apiVersion: '2019-02-28',
  });
  expect(request).toHaveBeenCalledWith('CreateToken', { RegionId: 'cn-shanghai' }, { method: 'POST' });
});

it.each([
  ['missing', undefined],
  ['null', null],
  ['non-string', 123],
  ['empty', ''],
  ['whitespace-only', '   '],
])('rejects %s token ID', async (_label, id) => {
  const request = vi.fn().mockResolvedValue(popResponse({ Id: id, ExpireTime: 1_527_592_757 }));
  vi.mocked(RPCClient).mockImplementation(() => ({ request }) as unknown as RPCClient);

  await expect(createPopTokenProvider()(config)).rejects.toThrow('ALIYUN_NLS_TOKEN_RESPONSE_INVALID');
});

it.each([
  ['missing', undefined],
  ['non-number', '1527592757'],
  ['non-finite', Number.POSITIVE_INFINITY],
  ['zero', 0],
  ['negative', -1],
  ['fractional', 1_527_592_757.5],
  ['unsafe seconds', Number.MAX_SAFE_INTEGER + 1],
  ['overflowing milliseconds', Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1],
])('rejects %s expiry', async (_label, expireTime) => {
  const request = vi.fn().mockResolvedValue(popResponse({ Id: 'valid-token', ExpireTime: expireTime }));
  vi.mocked(RPCClient).mockImplementation(() => ({ request }) as unknown as RPCClient);

  await expect(createPopTokenProvider()(config)).rejects.toThrow('ALIYUN_NLS_TOKEN_RESPONSE_INVALID');
});

it('sanitizes POP request failures without exposing credentials, responses, or token values', async () => {
  const request = vi.fn().mockRejectedValue(Object.assign(
    new Error('POP response leaked id secret token-1'),
    { code: 'ETIMEDOUT' },
  ));
  vi.mocked(RPCClient).mockImplementation(() => ({ request }) as unknown as RPCClient);
  const result = createPopTokenProvider()(config);

  await expect(result).rejects.toMatchObject({
    name: 'AliyunNlsTokenError',
    code: 'ALIYUN_NLS_TOKEN_UNAVAILABLE',
  });
  await expect(result).rejects.not.toThrow('POP response leaked id secret token-1');
  expect(request).toHaveBeenCalledWith('CreateToken', { RegionId: 'cn-shanghai' }, { method: 'POST' });
});

it('classifies only a confirmed POP authentication code as a sanitized auth error', async () => {
  const request = vi.fn().mockRejectedValue({
    code: 'InvalidAccessKeyId.NotFound',
    message: 'credential id secret and response must stay private',
  });
  vi.mocked(RPCClient).mockImplementation(() => ({ request }) as unknown as RPCClient);

  const error = await createPopTokenProvider()(config).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(AliyunNlsTokenError);
  expect(error).toMatchObject({ code: 'ALIYUN_NLS_TOKEN_AUTH' });
  expect(String(error)).not.toContain('credential id secret');
});
