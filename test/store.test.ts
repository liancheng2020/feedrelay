import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import {
  hashPassword,
  verifyPassword,
  validateSettings,
  defaults,
  dayKey,
  AppError,
} from '../server/config.js';
import { fixture, incoming, channel } from './helpers.js';

test('password hashing and settings boundaries', () => {
  const hash = hashPassword('test-password');
  assert(verifyPassword('test-password', hash));
  assert(!verifyPassword('no', hash));
  assert(!verifyPassword('x', 'malformed'));
  assert.throws(() => validateSettings({ ...defaults, dailyLimit: 0 }));
  assert.throws(() => validateSettings({ ...defaults, timezone: 'invalid' }));
  assert.deepEqual(
    validateSettings({ ...defaults, secret: 'ignored' } as typeof defaults),
    defaults,
  );
  assert.equal(dayKey(Date.parse('2026-10-15T16:01:00Z'), 'Asia/Shanghai'), '2026-10-16');
});
test('sources default disabled and reject duplicate identities', (t) => {
  const f = fixture(t),
    s = f.store.createSource({ type: 'youtube', name: '频道', channel });
  assert.equal(s.enabled, 0);
  assert.equal(s.notify, 0);
  assert.throws(
    () => f.store.createSource({ type: 'youtube', name: '另一个名称', channel }),
    /SOURCE_ALREADY_EXISTS/,
  );
});
test('item, source link and outbox commit atomically', (t) => {
  const { store, source, now } = fixture(t),
    s = source();
  store.db.exec(
    "CREATE TRIGGER reject_send BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'test failure'); END;",
  );
  assert.throws(() => store.tx(() => store.put(incoming('test:a', now()), [s], true, 'demo')));
  assert.equal(store.get('SELECT count(*) n FROM items')!.n, 0);
  assert.equal(store.get('SELECT count(*) n FROM source_items')!.n, 0);
});
test('one item and delivery despite duplicate associations', (t) => {
  const { store, source, now } = fixture(t),
    s = source();
  store.tx(() => {
    store.put(incoming('a', now()), [s], true, 'demo');
    store.put(incoming('a', now()), [s], true, 'demo');
  });
  assert.equal(store.get('SELECT count(*) n FROM items')!.n, 1);
  assert.equal(store.get('SELECT count(*) n FROM deliveries')!.n, 1);
});
test('expired job lease fences the old worker', (t) => {
  const { store, source, advance } = fixture(t),
    s = source();
  store.enqueue('source', s.id, s.generation);
  const first = store.claimJob()!;
  advance(121000);
  const second = store.claimJob()!;
  assert.notEqual(first.token, second.token);
  store.finishJob(first);
  assert(store.validJob(second));
  store.finishJob(second);
});
test('worker ownership is exclusive until release/expiry', (t) => {
  const { store, advance } = fixture(t);
  assert(store.leaseWorker('a'));
  assert(!store.leaseWorker('b'));
  advance(121000);
  assert(store.leaseWorker('b'));
  store.releaseWorker('a');
  assert(!store.leaseWorker('a'));
});
test('separate SQLite connections cannot claim the same job or send', (t) => {
  const f = fixture(t),
    other = new Store(f.dir, 'demo', f.now);
  t.after(() => other.close());
  const s = f.source();
  f.store.enqueue('source', s.id, s.generation);
  assert(f.store.claimJob());
  assert.equal(other.claimJob(), undefined);
  f.store.put(incoming('a', f.now()), [s], true, 'demo');
  assert(f.store.claimDelivery('demo'));
  assert.equal(other.claimDelivery('demo'), undefined);
});
test('job retries stop at five attempts', (t) => {
  const { store, source, advance } = fixture(t),
    s = source();
  store.enqueue('source', s.id, s.generation);
  for (let i = 0; i < 5; i++) {
    store.finishJob(store.claimJob()!, new AppError('NETWORK', 502, true));
    advance(4000000);
  }
  assert.equal(store.get('SELECT status FROM jobs')!.status, 'failed');
  assert.equal(store.claimJob(), undefined);
});
test('interrupted send becomes unknown, never automatic retry', (t) => {
  const { store, source, now, advance } = fixture(t),
    s = source();
  store.put(incoming('a', now()), [s], true, 'demo');
  const d = store.claimDelivery('demo')!;
  advance(61000);
  assert.equal(store.claimDelivery('demo'), undefined);
  assert.equal(store.get('SELECT status FROM deliveries')!.status, 'unknown');
  store.finishDelivery(d, { status: 'sent' });
  assert.equal(store.get('SELECT status FROM deliveries')!.status, 'unknown');
});
test('manual retry preserves history and requires active source', (t) => {
  const { store, source, now } = fixture(t),
    s = source();
  store.put(incoming('a', now()), [s], true, 'demo');
  const d = store.claimDelivery('demo')!;
  store.finishDelivery(d, { status: 'unknown', code: 'TIMEOUT' });
  store.resolveDelivery(d.id, 'retry', 'demo');
  const retry = store.claimDelivery('demo')!;
  store.finishDelivery(retry, { status: 'sent' });
  assert.equal(store.get('SELECT count(*) n FROM attempts')!.n, 2);
  assert.equal(store.all('SELECT status FROM attempts ORDER BY rowid')[0].status, 'unknown');
});
test('acknowledgement is distinct from provider acceptance', (t) => {
  const { store, source, now } = fixture(t),
    s = source();
  store.put(incoming('a', now()), [s], true, 'demo');
  const d = store.claimDelivery('demo')!;
  store.finishDelivery(d, { status: 'unknown' });
  store.resolveDelivery(d.id, 'acknowledge', 'demo');
  const result = store.get('SELECT * FROM deliveries')!;
  assert.equal(result.resolution, 'user_acknowledged');
  assert.equal(result.sent, null);
});
test('daily limit retains backlog and resets on next local day', (t) => {
  const { store, source, now, advance } = fixture(t),
    s = source();
  store.setSettings({ ...defaults, dailyLimit: 1 });
  for (const key of ['a', 'b']) store.put(incoming(key, now()), [s], true, 'demo');
  store.finishDelivery(store.claimDelivery('demo')!, { status: 'sent' });
  assert.equal(store.claimDelivery('demo'), undefined);
  assert.equal(store.get("SELECT count(*) n FROM deliveries WHERE status='pending'")!.n, 1);
  advance(86400000);
  assert(store.claimDelivery('demo'));
});
test('delivery retries stop at five and honor retry-after', (t) => {
  const { store, source, now, advance } = fixture(t);
  store.put(incoming('a', now()), [source()], true, 'demo');
  for (let n = 0; n < 5; n++) {
    const d = store.claimDelivery('demo')!;
    assert(d);
    store.finishDelivery(d, { status: 'retry_wait', retryAfter: 3600000 });
    assert.equal(store.claimDelivery('demo'), undefined);
    advance(4000000);
  }
  assert.equal(store.get('SELECT status FROM deliveries')!.status, 'failed');
  assert.equal(store.get('SELECT count(*) n FROM attempts')!.n, 5);
});
test('pause cancels orphan queue, deletion clears exclusive content', (t) => {
  const { store, source, now } = fixture(t),
    s = source();
  const i = store.put(incoming('a', now()), [s], true, 'demo');
  store.toggle(s.id, false, false);
  assert.equal(store.get('SELECT status FROM deliveries')!.status, 'cancelled');
  store.deleteSource(s.id, true);
  const item = store.get('SELECT * FROM items WHERE id=?', i.id)!;
  assert.equal(item.text, '');
  assert.equal(item.title, '');
});
test('shared source association prevents premature erasure', (t) => {
  const { store, source, now } = fixture(t),
    s = source(),
    other = source('email');
  store.put(incoming('a', now()), [s, other], true, 'demo');
  store.deleteSource(s.id, true);
  assert.equal(store.get('SELECT expired FROM items')!.expired, 0);
});
test('changed destination blocks queued sends', (t) => {
  const { store, source, now } = fixture(t);
  store.put(incoming('a', now()), [source()], true, 'old');
  assert.equal(store.claimDelivery('new'), undefined);
  assert.equal(store.get('SELECT error FROM deliveries')!.error, 'DESTINATION_CHANGED');
});
test('retention clears private snapshots even for unresolved sends', (t) => {
  const { store, source, now, advance } = fixture(t),
    s = source('email');
  store.put({ ...incoming('mail:a', now()), kind: 'email' }, [s], true, 'demo');
  const d = store.claimDelivery('demo')!;
  store.finishDelivery(d, { status: 'unknown' });
  advance(8 * 86400000);
  store.cleanup();
  assert.equal(store.get('SELECT text FROM items')!.text, '');
  assert.equal(store.get('SELECT snapshot FROM deliveries')!.snapshot, '');
  assert.throws(() => store.resolveDelivery(d.id, 'retry', 'demo'), /CONTENT_EXPIRED/);
});
test('demo database cannot be accidentally reused as live data', (t) => {
  const { dir } = fixture(t);
  assert.throws(() => new Store(dir, 'live'), /DEMO_LIVE_DATABASE_MISMATCH/);
});
test('online backup includes WAL, restore quarantines sends', (t) => {
  const { dir, store, source, now } = fixture(t);
  store.put(incoming('a', now()), [source()], true, 'demo');
  const env = { ...process.env, DATA_DIR: dir },
    path = join(dir, 'snapshot.sqlite');
  const back = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', path], {
    env,
    encoding: 'utf8',
  });
  assert.equal(back.status, 0, back.stderr);
  const copy = new DatabaseSync(path, { readOnly: true });
  assert.equal(copy.prepare('SELECT count(*) n FROM items').get()!.n, 1);
  copy.close();
  const restoredDir = join(dir, 'restored'),
    restore = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/restore.ts', path, '--confirm-stopped'],
      { env: { ...env, DATA_DIR: restoredDir }, encoding: 'utf8' },
    );
  assert.equal(restore.status, 0, restore.stderr);
  const result = new DatabaseSync(join(restoredDir, 'feedrelay.sqlite'), { readOnly: true });
  assert.equal(result.prepare('SELECT status FROM deliveries').get()!.status, 'unknown');
  assert.equal(
    result.prepare('SELECT error FROM deliveries').get()!.error,
    'RESTORED_NEEDS_REVIEW',
  );
  result.close();
});
