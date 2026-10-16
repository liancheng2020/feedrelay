import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { readConfig } from '../server/config.js';
import { Store, type Incoming } from '../server/store.js';
import { Engine, type Adapters } from '../server/engine.js';

export const channel = 'UC' + 'a'.repeat(22);
export const incoming = (key = 'youtube:abcdefghijk', time = Date.now()): Incoming => ({
  key,
  kind: 'youtube',
  title: '测试标题',
  author: '样例频道',
  text: '样例正文',
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  published: time,
});
export function fixture(t: TestContext, adapters: Partial<Adapters> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'feedrelay-'));
  let clock = Date.parse('2026-10-16T04:00:00Z');
  const config = readConfig({ FEEDRELAY_DEMO: '1', DATA_DIR: dir });
  const store = new Store(dir, 'demo', () => clock);
  const engine = new Engine(store, config, {
    feed: async () => ({ unchanged: false, items: [], etag: '', modified: '' }),
    send: async () => ({ status: 'sent' }),
    ...adapters,
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    config,
    store,
    engine,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    source(type: 'youtube' | 'email' = 'youtube', notify = true) {
      const s = store.createSource({
        type,
        name: '样例订阅',
        channel: type === 'youtube' ? channel : '',
        sender: type === 'email' ? 'brief@example.com' : '',
      });
      return store.toggle(s.id, true, notify);
    },
    async run() {
      const job = store.claimJob();
      if (!job) throw new Error('No job');
      await engine.execute(job);
      return store.get('SELECT * FROM jobs WHERE id=?', job.id)!;
    },
  };
}
