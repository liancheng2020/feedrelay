import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/site',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'test-results/site',
  use: { launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined }, trace: 'retain-on-failure' },
});
