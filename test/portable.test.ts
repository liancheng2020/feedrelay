import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { exportSources, previewImport, applyImport } from '../server/portable.js';
import { fixture, channel, incoming } from './helpers.js';
const bundle = (sources: unknown[]) => ({ format: 'feedrelay.sources', version: 1, sources });
const yt = (suffix = 'a') => ({
  type: 'youtube',
  name: '导入频道',
  channel: 'UC' + suffix.repeat(22),
  delivery_mode: 'digest',
});
test('export is allowlisted and excludes RSS URLs by default', (t) => {
  const f = fixture(t);
  f.source();
  f.source('email');
  f.store.createSource({ type: 'rss', name: '公开RSS', feed_url: 'https://example.com/feed' });
  const data = exportSources(f.store);
  assert.equal(data.omittedRss, 1);
  assert.equal(data.sources.length, 2);
  const text = JSON.stringify(data);
  for (const forbidden of [
    'snapshot',
    'password',
    'secret',
    'generation',
    'next_check',
    'enabled',
    'notify',
    'baseline',
  ])
    assert(!text.includes(forbidden));
  assert.equal(exportSources(f.store, true).sources.length, 3);
});
test('preview never writes; apply creates paused sources and skips duplicates', (t) => {
  const f = fixture(t),
    data = bundle([yt(), yt()]);
  const plan = previewImport(f.store, data);
  assert.equal(f.store.sources().length, 0);
  assert.equal(plan.rows[1].duplicate, true);
  assert.deepEqual(applyImport(f.store, data, plan.hash, false), { imported: 1, skipped: 1 });
  const s = f.store.sources()[0];
  assert.equal(s.enabled, 0);
  assert.equal(s.notify, 0);
  assert.equal(s.initialized, 0);
  assert.equal(s.delivery_mode, 'digest');
  assert.deepEqual(applyImport(f.store, data, plan.hash, false), { imported: 0, skipped: 2 });
  assert.equal(f.store.get('SELECT count(*) n FROM jobs')!.n, 0);
});
test('invalid fields, credential imports, unsupported accounts and excess sources fail', (t) => {
  const f = fixture(t);
  for (const row of [
    { ...yt(), password: 'synthetic' },
    { ...yt(), enabled: '1' },
    { type: 'email', name: '邮件', sender: 'n@example.com', account_ref: 'other' },
    { type: 'rss', name: '私有', feed_url: 'https://127.0.0.1/a' },
  ])
    assert.throws(() => previewImport(f.store, bundle([row])));
  assert.throws(
    () => previewImport(f.store, { ...bundle([]), SESSION_SECRET: 'synthetic' }),
    /INVALID_IMPORT/,
  );
  assert.throws(
    () =>
      previewImport(
        f.store,
        bundle(Array.from({ length: 11 }, (_, n) => yt(String.fromCharCode(97 + n)))),
      ),
    /SOURCE_LIMIT/,
  );
  assert.equal(f.store.sources().length, 0);
});
test('import rejects changed preview and requires public-URL confirmation', (t) => {
  const f = fixture(t),
    data = bundle([{ type: 'rss', name: '公开', feed_url: 'https://example.com/feed' }]),
    plan = previewImport(f.store, data);
  assert.throws(() => applyImport(f.store, data, 'bad', true), /IMPORT_PREVIEW_CHANGED/);
  assert.throws(() => applyImport(f.store, data, plan.hash, false), /PUBLIC_FEED_CONFIRMATION/);
  assert.equal(applyImport(f.store, data, plan.hash, true).imported, 1);
});
test('a failed import rolls back prior inserts and audit events', (t) => {
  const f = fixture(t),
    data = bundle([yt('a'), yt('b')]),
    plan = previewImport(f.store, data);
  f.store.db.exec(
    `CREATE TRIGGER reject_second BEFORE INSERT ON sources WHEN NEW.channel='UC${'b'.repeat(22)}' BEGIN SELECT RAISE(ABORT,'injected'); END;`,
  );
  assert.throws(() => applyImport(f.store, data, plan.hash, false));
  assert.equal(f.store.sources().length, 0);
  assert.equal(f.store.get('SELECT count(*) n FROM events')!.n, 0);
});
test('v1 schema migrates without losing sources, delivery or settings', (t) => {
  const f = fixture(t),
    s = f.source();
  const item = f.store.put(incoming('legacy', f.now()), [s], true, 'demo');
  // Recreate the exact v1 table shape from the candidate's default-valued columns.
  f.store.db.exec(
    `DROP TABLE summaries; DROP TABLE model_calls; ALTER TABLE sources DROP COLUMN summary_content; ALTER TABLE sources DROP COLUMN summary_mode; ALTER TABLE sources DROP COLUMN summary_notify; ALTER TABLE sources DROP COLUMN summary_consent; ALTER TABLE sources DROP COLUMN summary_since;`,
  );
  f.store.db.exec(
    `BEGIN; DROP INDEX source_identity; ALTER TABLE sources DROP COLUMN feed_url; ALTER TABLE sources DROP COLUMN delivery_mode; CREATE UNIQUE INDEX source_identity ON sources(type,channel,sender,subject) WHERE deleted=0; DROP INDEX digest_members; ALTER TABLE deliveries DROP COLUMN mode; ALTER TABLE deliveries DROP COLUMN batch_id; ALTER TABLE deliveries DROP COLUMN part_id; DROP TABLE digest_batches; UPDATE meta SET value='{"timezone":"Asia/Shanghai","youtubeMinutes":15,"mailMinutes":5,"dailyLimit":50,"mailDays":7,"itemDays":30}' WHERE key='settings'; PRAGMA user_version=1; COMMIT;`,
  );
  const backup = join(f.dir, 'v1.sqlite');
  f.store.run("INSERT INTO meta VALUES ('weixin_account','synthetic-encrypted-state')");
  f.store.run("INSERT INTO meta VALUES ('weixin_pair','synthetic-encrypted-pair')");
  const saved = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', backup], {
    env: { ...process.env, DATA_DIR: f.dir },
    encoding: 'utf8',
  });
  assert.equal(saved.status, 0, saved.stderr);
  const destination = join(f.dir, 'v1-restored');
  const restored = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/restore.ts', backup, '--confirm-stopped'],
    { env: { ...process.env, DATA_DIR: destination }, encoding: 'utf8' },
  );
  assert.equal(restored.status, 0, restored.stderr);
  const fromBackup = new Store(destination, 'demo', f.now);
  t.after(() => fromBackup.close());
  assert.equal(fromBackup.get('PRAGMA user_version')!.user_version, 5);
  assert.equal(
    fromBackup.get("SELECT count(*) n FROM meta WHERE key IN ('weixin_account','weixin_pair')")!.n,
    0,
  );
  assert.equal(fromBackup.get('SELECT status FROM deliveries')!.status, 'unknown');
  const upgraded = new Store(f.dir, 'demo', f.now);
  t.after(() => upgraded.close());
  assert.equal(upgraded.get('PRAGMA user_version')!.user_version, 5);
  assert.equal(upgraded.source(s.id).channel, channel);
  assert.equal(upgraded.source(s.id).delivery_mode, 'immediate');
  assert.equal(
    upgraded.get('SELECT mode FROM deliveries WHERE item_id=?', item.id)!.mode,
    'immediate',
  );
  assert.equal(upgraded.settings().digestTime, '10:30');
});
