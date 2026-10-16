import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8799',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  webServer: {
    command: 'node dist/server/main.js',
    url: 'http://127.0.0.1:8799/api/health',
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'production',
      FEEDRELAY_DEMO: '1',
      HOST: '127.0.0.1',
      PORT: '8799',
      APP_ORIGIN: 'http://127.0.0.1:8799',
      DATA_DIR: resolve(`.cache/e2e-${Date.now()}`),
      COOKIE_SECURE: '0',
    },
  },
});
