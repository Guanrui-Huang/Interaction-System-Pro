// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import playwrightConfig from '../../playwright.config';
import viteConfig from '../../vite.config';

const root = resolve('.');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  packageManager?: string;
  engines?: { node?: string };
  scripts: Record<string, string>;
};
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

it('declares exact pnpm and Node runtime metadata plus explicit E2E scripts', () => {
  expect(packageJson.packageManager).toBe('pnpm@11.16.0');
  expect(packageJson.engines?.node).toBe('^20.19.0 || >=22.12.0');
  expect(packageJson.scripts).toEqual(expect.objectContaining({
    'serve:e2e': expect.stringContaining('pnpm run build'),
    'serve:e2e:express': expect.any(String),
    'test:e2e': 'playwright test',
    'test:e2e:mocked': 'playwright test --project=mocked',
    'test:e2e:integration': 'playwright test --project=integration',
  }));
  expect(Object.values(packageJson.scripts).join('\n')).not.toMatch(/\bnpm run/);
});

it('separates mocked and integration Playwright projects behind one built Express server', () => {
  const projects = playwrightConfig.projects ?? [];
  expect(projects.map((project) => project.name)).toEqual(['mocked', 'integration']);
  expect(projects.find((project) => project.name === 'mocked')?.testMatch).toEqual('dashboard.spec.ts');
  expect(projects.find((project) => project.name === 'integration')?.testMatch).toEqual('integration.spec.ts');
  expect(playwrightConfig.webServer).toEqual(expect.objectContaining({
    command: 'pnpm exec tsc -b && pnpm exec vite build && pnpm exec tsx e2e/server.ts',
    url: 'http://127.0.0.1:4173/api/health',
  }));
  expect(String(playwrightConfig.webServer && 'command' in playwrightConfig.webServer
    ? playwrightConfig.webServer.command
    : '')).toContain('pnpm exec');
});

it('keeps the exact Stitch ignore and documents pnpm, one-origin deployment and E2E boundaries', () => {
  const ignoreLines = read('.gitignore').split(/\r?\n/).filter(Boolean);
  expect(ignoreLines.filter((line) => line.includes('stitch_project_11671430195625544636'))).toEqual([
    '/stitch_project_11671430195625544636/',
  ]);

  const readme = read('README.md');
  for (const contract of [
    'corepack enable',
    'pnpm install --frozen-lockfile',
    'pnpm run dev',
    'pnpm run serve:e2e',
    'pnpm run test:e2e:mocked',
    'pnpm run test:e2e:integration',
    'DEEPSEEK_MODEL',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8787',
  ]) {
    expect(readme).toContain(contract);
  }
  expect(readme).not.toMatch(/\bnpm install/);
  expect(read('server/.env.example')).toContain('DEEPSEEK_MODEL=deepseek-chat');
});

it('keeps example credentials inert and excludes ignored worktrees from Vitest', () => {
  const example = read('server/.env.example');
  expect(example).toContain('DEEPSEEK_API_KEY=your-deepseek-api-key');
  expect(example).toContain('DEEPSEEK_MODEL=deepseek-chat');
  expect(example).toContain('DASHSCOPE_API_KEY=your-dashscope-api-key');
  expect(example).toContain('DASHSCOPE_WORKSPACE_ID=your-workspace-id');
  expect(example).toContain('QWEN_OMNI_MODEL=qwen3.5-omni-flash-realtime');
  expect(example).toContain('DASHSCOPE_TTS_MODEL=qwen-audio-3.0-tts-plus');
  expect(example).toContain('DASHSCOPE_TTS_VOICE=longanlingxin');
  expect(example).not.toContain('ALIYUN_NLS_');
  expect(example).not.toMatch(/\bLTAI[0-9A-Za-z]{12,}\b|\b(?:sk|rk)-[0-9A-Za-z_-]{16,}\b/u);
  expect(viteConfig.test?.exclude).toContain('.worktrees/**');
});
