import { afterEach, expect, it, vi } from 'vitest';
import { getDeepSeekConfig } from '../src/config';
import { publicAssistantProfile } from '../src/domain/public-assistant-profile';

afterEach(() => {
  vi.unstubAllEnvs();
});
it('defaults the DeepSeek model to deepseek-chat', () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'unit-test-key');
  vi.stubEnv('DEEPSEEK_BASE_URL', 'https://deepseek.test');
  vi.stubEnv('DEEPSEEK_MODEL', '');

  expect(getDeepSeekConfig()).toEqual({
    apiKey: 'unit-test-key',
    baseUrl: 'https://deepseek.test',
    model: 'deepseek-chat',
  });
});

it('returns a trimmed DeepSeek model override', () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'unit-test-key');
  vi.stubEnv('DEEPSEEK_MODEL', '  deepseek-reasoner  ');

  expect(getDeepSeekConfig()).toEqual(expect.objectContaining({ model: 'deepseek-reasoner' }));
});

it('maps configured v4-flash only through the safe public assistant helper', () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'unit-test-key');
  vi.stubEnv('DEEPSEEK_MODEL', 'deepseek-v4-flash');

  const configured = getDeepSeekConfig();
  const profile = publicAssistantProfile(configured!.model);

  expect(profile).toMatchObject({
    key: 'assistant-profile',
    publicModelName: 'DeepSeek v4-flash',
  });
  expect(profile).not.toHaveProperty('modelId');
  expect(JSON.stringify(publicAssistantProfile('private-unknown-model'))).not.toContain('private-unknown-model');
});
