import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { configDefaults } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    // Playwright owns browser acceptance specs; preserve Vitest's defaults while
    // preventing its filename matcher from collecting E2E and ignored audit specs.
    exclude: [...configDefaults.exclude, 'e2e/**', '.superpowers/**', '.worktrees/**'],
  }
});
