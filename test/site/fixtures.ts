import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export { expect };
export const test = base.extend<{}, { siteServer: string }>({
  siteServer: [async ({}, use) => {
    const child = spawn(process.execPath, ['scripts/preview-site.mjs'], { env: { ...process.env, SITE_PORT: '0' }, stdio: 'pipe' });
    let log = '';
    let stopped = false;
    const exited = new Promise<void>(resolve => child.once('exit', () => { stopped = true; resolve(); }));
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', () => {});
    try {
      for (let n = 0; !log.includes('FeedRelay site:') && n < 100 && !stopped; n++) await delay(50);
      const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/feedrelay\//)?.[0];
      if (!url) throw new Error('SITE_SERVER_NOT_READY');
      await use(url);
    } finally {
      if (!stopped) child.kill();
      await exited;
    }
  }, { scope: 'worker' }],
  baseURL: async ({ siteServer }, use) => { await use(siteServer); },
});
