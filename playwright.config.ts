import { defineConfig } from 'playwright/test';

const dashboardUrl = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  preserveOutput: 'always',
  use: {
    baseURL: dashboardUrl,
    browserName: 'chromium',
    channel: 'chrome',
    viewport: { width: 1920, height: 1080 },
  },
  projects: [
    { name: 'mocked', testMatch: 'dashboard.spec.ts' },
    { name: 'integration', testMatch: 'integration.spec.ts' },
  ],
  webServer: {
    command: './node_modules/.bin/tsc -b && ./node_modules/.bin/vite build && ./node_modules/.bin/tsx e2e/server.ts',
    url: `${dashboardUrl}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
