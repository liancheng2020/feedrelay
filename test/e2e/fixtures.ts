import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export { expect };
export type { Page } from '@playwright/test';

// A fresh server and database per test also isolates Playwright retries.
export const test = base.extend<{ demoServer: void; authMode: 'local' | 'password' }>({
  authMode: ['password', { option: true }],
  demoServer: [async ({ authMode }, use, info) => {
    const dir = await mkdtemp(join(tmpdir(), 'feedrelay-e2e-'));
    const child = spawn(process.execPath, [resolve('dist/server/main.js')], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME,
        DOTENV_CONFIG_PATH: join(dir, '.env'),
        NODE_ENV: 'production', FEEDRELAY_DEMO: '1', AUTH_MODE: authMode,
        HOST: '127.0.0.1', PORT: '8799', APP_ORIGIN: 'http://127.0.0.1:8799',
        DATA_DIR: dir, COOKIE_SECURE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '', stopped = false;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => { stopped = true; resolve(); });
      child.once('error', (error) => { log += error.message; stopped = true; resolve(); });
    });
    const capture = (data: Buffer) => { log = (log + data.toString()).slice(-16000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    try {
      // Wait for this process to bind, not an unrelated server on the same port.
      const deadline = Date.now() + 15000;
      while (!log.includes('FeedRelay API:')) {
        if (stopped || Date.now() >= deadline) throw new Error(`Demo server failed to start: ${log}`);
        await delay(50);
      }
      await use();
    } finally {
      if (!stopped) child.kill('SIGTERM');
      await Promise.race([exited, delay(5000)]);
      if (!stopped) { child.kill('SIGKILL'); await exited; }
      if (info.status !== info.expectedStatus)
        await info.attach('demo-server.log', { body: log, contentType: 'text/plain' });
      await rm(dir, { recursive: true, force: true });
    }
  }, { auto: true }],
});
