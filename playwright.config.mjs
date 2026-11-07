import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'test/e2e', testMatch: '**/*.spec.mjs', timeout: 90000, workers: 1, use: { trace: 'off' } });
