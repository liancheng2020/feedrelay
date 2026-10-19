import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Store, type Delivery } from '../server/store.js';
import { digestSlot, freezeDigest, listDigests } from '../server/digest.js';
import { fixture, incoming } from './helpers.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t);
  f.store.setSettings({ ...f.store.settings(), digestTime: '12:00' });
  const source = f.store.changeDeliveryMode(f.source().id, 'digest');
  return {
    ...f,
    source,
    put(key: string, text = '合成预览') {
      return f.store.put({ ...incoming(key, f.now()), text }, [source], true, 'demo');
    },
    parts() {
      return f.store.all<Delivery>(
        "SELECT * FROM deliveries WHERE mode='digest_part' ORDER BY rowid",
      );
    },
  };
}
test('digest freezes once, survives reopening and keeps stable content', (t) => {
  const f = setup(t),
    item = f.put('a');
  const id = freezeDigest(f.store, 'demo');
  assert(id);
  const snapshot = f.parts()[0].snapshot;
  assert.equal(freezeDigest(f.store, 'demo'), undefined);
  f.store.put({ ...incoming('a', f.now()), text: '后续修改' }, [f.source], true, 'demo');
  const reopened = new Store(f.dir, 'demo', f.now);
  t.after(() => reopened.close());
  assert.equal(freezeDigest(reopened, 'demo'), undefined);
  assert.equal(f.parts()[0].snapshot, snapshot);
  assert.equal(listDigests(f.store)[0].members, 1);
  assert.equal(f.store.stats().items, 1);
  assert.equal(
    f.store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id)!.status,
    'batched',
  );
});
test('late discovery waits for the next window regardless of publication time', (t) => {
  const f = setup(t);
  f.put('before');
  freezeDigest(f.store, 'demo');
  f.advance(1000);
  f.store.put({ ...incoming('late', f.now() - 100 * 86400000) }, [f.source], true, 'demo');
  freezeDigest(f.store, 'demo');
  assert.equal(f.store.get("SELECT count(*) n FROM deliveries WHERE status='digest_wait'")!.n, 1);
  f.advance(86400000);
  freezeDigest(f.store, 'demo');
  assert.equal(listDigests(f.store).length, 2);
  assert.equal(f.parts().length, 2);
});
test('changing source mode affects future routes only', (t) => {
  const f = setup(t);
  f.put('old-digest');
  f.store.changeDeliveryMode(f.source.id, 'immediate');
  f.put('new-immediate');
  const rows = f.store.all<Delivery>('SELECT * FROM deliveries ORDER BY rowid');
  assert.equal(rows[0].status, 'digest_wait');
  assert.equal(rows[1].status, 'pending');
  freezeDigest(f.store, 'demo');
  assert.equal(f.parts().length, 1);
});
test('overlapping rules prefer immediate and never create a second route', (t) => {
  const f = setup(t),
    other =
      f.source.type === 'email'
        ? f.source
        : f.store.createSource({ type: 'email', name: '邮件', sender: 'brief@example.com' });
  const active = f.store.toggle(other.id, true, true);
  f.store.put(incoming('overlap', f.now()), [f.source, active], true, 'demo');
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries')!.mode, 'immediate');
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
});
test('long digests split with stable IDs and failed parts retry independently', (t) => {
  const f = setup(t);
  for (let n = 0; n < 14; n++)
    f.store.put(
      {
        ...incoming('long:' + n, f.now()),
        title: '题'.repeat(300),
        author: '源'.repeat(200),
        text: '文'.repeat(400),
      },
      [f.source],
      true,
      'demo',
    );
  freezeDigest(f.store, 'demo');
  const parts = f.parts();
  assert(parts.length > 1);
  assert(parts.every((p) => Array.from(p.snapshot).length < 4000));
  const first = f.store.claimDelivery('demo')!;
  f.store.finishDelivery(first, { status: 'sent' });
  const second = f.store.claimDelivery('demo')!;
  f.store.finishDelivery(second, { status: 'unknown' });
  f.store.resolveDelivery(second.id, 'retry', 'demo');
  const next = f.store.claimDelivery('demo')!;
  assert.equal(next.id, second.id);
  f.store.finishDelivery(next, { status: 'sent' });
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', first.id)!.attempt, 1);
  assert.equal(f.store.get('SELECT count(*) n FROM attempts WHERE delivery_id=?', second.id)!.n, 2);
});
test('empty windows are recorded once without empty messages', (t) => {
  const f = setup(t);
  freezeDigest(f.store, 'demo');
  freezeDigest(f.store, 'demo');
  assert.equal(listDigests(f.store).length, 1);
  assert.equal(f.parts().length, 0);
  f.advance(3 * 86400000);
  freezeDigest(f.store, 'demo');
  assert.equal(listDigests(f.store).length, 2);
});
test('daily quota counts parts and retains unsent parts across local midnight', (t) => {
  const f = setup(t);
  f.store.setSettings({ ...f.store.settings(), dailyLimit: 1 });
  for (let n = 0; n < 14; n++)
    f.store.put(
      { ...incoming('q:' + n, f.now()), title: '题'.repeat(300), text: '文'.repeat(400) },
      [f.source],
      true,
      'demo',
    );
  freezeDigest(f.store, 'demo');
  f.store.finishDelivery(f.store.claimDelivery('demo')!, { status: 'sent' });
  assert.equal(f.store.claimDelivery('demo'), undefined);
  f.advance(86400000);
  assert(f.store.claimDelivery('demo'));
});
test('local slots handle DST gaps and repeated hours deterministically', () => {
  const fall = digestSlot(Date.parse('2026-11-01T07:00:00Z'), 'America/New_York', '01:30');
  assert.equal(fall.cutoff, Date.parse('2026-11-01T05:30:00Z'));
  const spring = digestSlot(Date.parse('2026-03-08T08:00:00Z'), 'America/New_York', '02:30');
  assert.equal(spring.cutoff, Date.parse('2026-03-08T07:30:00Z'));
  const before = digestSlot(Date.parse('2026-10-17T01:00:00Z'), 'Asia/Shanghai', '10:30');
  assert.equal(before.cutoff, Date.parse('2026-10-16T02:30:00Z'));
});
test('pausing one member cancels the whole unsent frozen part', (t) => {
  const f = setup(t);
  f.put('a');
  const email = f.store.changeDeliveryMode(
    f.source.type === 'email'
      ? f.source.id
      : f.store.toggle(
          f.store.createSource({ type: 'email', name: '邮件', sender: 'brief@example.com' }).id,
          true,
          true,
        ).id,
    'digest',
  );
  f.store.put({ ...incoming('b', f.now()), kind: 'email' }, [email], true, 'demo');
  freezeDigest(f.store, 'demo');
  f.store.toggle(email.id, false, false);
  assert.equal(f.parts()[0].status, 'cancelled');
  assert.equal(f.parts()[0].snapshot, '');
  assert.equal(f.store.claimDelivery('demo'), undefined);
});
test('member expiry clears the entire unknown part and prevents retry', (t) => {
  const f = setup(t),
    email = f.store.changeDeliveryMode(
      f.store.toggle(
        f.store.createSource({ type: 'email', name: '邮件', sender: 'brief@example.com' }).id,
        true,
        true,
      ).id,
      'digest',
    );
  f.store.put({ ...incoming('mail', f.now()), kind: 'email' }, [email], true, 'demo');
  f.put('video');
  freezeDigest(f.store, 'demo');
  const part = f.store.claimDelivery('demo')!;
  f.store.finishDelivery(part, { status: 'unknown' });
  f.advance(8 * 86400000);
  f.store.cleanup();
  assert.equal(f.parts()[0].snapshot, '');
  assert.equal(f.store.get('SELECT text FROM items WHERE id=?', part.item_id)!.text, '');
  assert.throws(() => f.store.resolveDelivery(part.id, 'retry', 'demo'), /CONTENT_EXPIRED/);
});
test('digest assembly rolls back all parts and membership on failure', (t) => {
  const f = setup(t);
  f.put('a');
  f.store.db.exec(
    "CREATE TRIGGER reject_parts BEFORE INSERT ON deliveries WHEN NEW.mode='digest_part' BEGIN SELECT RAISE(ABORT,'injected'); END;",
  );
  assert.throws(() => freezeDigest(f.store, 'demo'));
  assert.equal(listDigests(f.store).length, 0);
  assert.equal(f.parts().length, 0);
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries')!.status, 'digest_wait');
});
test('batch limit preserves excess for the next window', (t) => {
  const f = setup(t);
  f.store.tx(() => {
    for (let n = 0; n < 501; n++) f.put('item:' + n);
  });
  freezeDigest(f.store, 'demo');
  assert.equal(listDigests(f.store)[0].members, 500);
  assert.equal(f.store.get("SELECT count(*) n FROM deliveries WHERE status='digest_wait'")!.n, 1);
  f.advance(86400000);
  freezeDigest(f.store, 'demo');
  assert.equal(listDigests(f.store)[0].members, 1);
});
test('changed destination cannot silently receive an old digest backlog', (t) => {
  const f = setup(t);
  f.put('a');
  assert.equal(f.store.claimDelivery('new-target'), undefined);
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries')!.error, 'DESTINATION_CHANGED');
  freezeDigest(f.store, 'new-target');
  assert.equal(f.parts().length, 0);
});
test('v2 backup restore keeps membership and quarantines pending parts', (t) => {
  const f = setup(t);
  f.put('a');
  freezeDigest(f.store, 'demo');
  f.store.db.exec(
    `DROP TABLE summaries; DROP TABLE model_calls; ALTER TABLE sources DROP COLUMN summary_content; ALTER TABLE sources DROP COLUMN summary_mode; ALTER TABLE sources DROP COLUMN summary_notify; ALTER TABLE sources DROP COLUMN summary_consent; ALTER TABLE sources DROP COLUMN summary_since; PRAGMA user_version=2;`,
  );
  const path = join(f.dir, 'backup.sqlite');
  const back = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', path], {
    env: { ...process.env, DATA_DIR: f.dir },
    encoding: 'utf8',
  });
  assert.equal(back.status, 0, back.stderr);
  const restoredDir = join(f.dir, 'restored'),
    result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/restore.ts', path, '--confirm-stopped'],
      { env: { ...process.env, DATA_DIR: restoredDir }, encoding: 'utf8' },
    );
  assert.equal(result.status, 0, result.stderr);
  const restored = new Store(restoredDir, 'demo', f.now);
  t.after(() => restored.close());
  const batch = listDigests(restored)[0];
  assert.equal(restored.get('PRAGMA user_version')!.user_version, 5);
  assert.equal(restored.sources()[0].summary_mode, 'off');
  assert.equal(batch.members, 1);
  assert.equal(batch.parts[0].status, 'unknown');
  assert.equal(restored.claimDelivery('demo'), undefined);
  assert.equal(freezeDigest(restored, 'demo'), undefined);
});
