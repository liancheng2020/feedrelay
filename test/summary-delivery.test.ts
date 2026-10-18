import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming } from './helpers.js';
import { AppError } from '../server/config.js';
import type { Delivery } from '../server/store.js';
import { freezeDigest } from '../server/digest.js';

function setup(t: Parameters<typeof fixture>[0], mode = 'auto', digest = false) {
  const sent: string[] = [];
  const f = fixture(t, { send: async (text) => { sent.push(text); return { status: 'sent' }; } });
  const source = f.source();
  const service = f.engine.summaries;
  service.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  service.authorize(source.id, mode, false, true, 'captions');
  if (digest) {
    f.store.changeDeliveryMode(source.id, 'digest');
    f.store.setSettings({ ...f.store.settings(), digestTime: '12:00' });
  }
  f.advance(1);
  const item = f.store.put({ ...incoming(), text: '推广广告：新用户免费试用' },
    [f.store.source(source.id)], true, f.engine.destination);
  const delivery = () => f.store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id)!;
  return { ...f, source, service, item, delivery, sent };
}

test('SP-01: collection waits for complete video summary, then sends exactly one numbered message', async (t) => {
  const f = setup(t);
  const id = f.delivery().id;
  assert.equal(f.delivery().error, 'SUMMARY_REQUIRED');
  assert.equal(f.store.claimDelivery('demo'), undefined);
  let release!: () => void;
  const fetch = f.service.captions!.fetch;
  f.service.captions!.fetch = async (...args) => {
    await new Promise<void>((r) => { release = r; });
    return fetch(...args);
  };
  const work = f.engine.cycle();
  while (!release) await new Promise((r) => setImmediate(r));
  assert.equal(f.service.list(f.item.id)[0].status, 'running');
  assert.equal(f.store.claimDelivery('demo'), undefined);
  assert.deepEqual(f.sent, []);
  release();
  await work;
  assert.equal(f.delivery().id, id);
  assert.match(f.delivery().snapshot, /^测试标题（模拟摘要）\n\n1\. /);
  assert.doesNotMatch(f.delivery().snapshot, /推广广告|免费试用|原文引用|仅供参考/);
  const row = f.service.list(f.item.id)[0];
  assert.equal(f.service.pushLatest(f.item.id, row.id, row.revision).id, id);
  await f.engine.cycle();
  await f.engine.cycle();
  assert.equal(f.delivery().status, 'sent');
  assert.equal(f.sent.length, 1);
  assert.equal(f.service.pushLatest(f.item.id, row.id, row.revision).id, id);
  assert.equal(f.service.describe().calls, 1);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
});

test('SP-02: failed generation stays blocked; explicit retry releases the same notification', async (t) => {
  const f = setup(t);
  const run = f.service.adapter.run;
  f.service.adapter.run = async () => { throw new AppError('MODEL_SERVICE_FAILED'); };
  await f.engine.cycle();
  await f.engine.cycle();
  assert.equal(f.service.list(f.item.id)[0].error, 'MODEL_SERVICE_FAILED');
  assert.equal(f.delivery().snapshot, '');
  assert.deepEqual(f.sent, []);
  f.service.adapter.run = run;
  f.service.enqueue(f.item.id, 'manual', true);
  await f.engine.cycle();
  await f.engine.cycle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.delivery().status, 'sent');
});

test('SP-03: budget exhaustion and manual mode never fall back to a source description', async (t) => {
  const f = setup(t);
  f.service.configure({ enabled: true, maxCalls: 10, maxCostCny: 0.000001, confirmed: true });
  await f.engine.cycle();
  await f.engine.cycle();
  assert.equal(f.service.list(f.item.id)[0].error, 'SUMMARY_BUDGET_EXHAUSTED');
  assert.deepEqual(f.sent, []);
  const manual = setup(t, 'manual');
  await manual.engine.cycle();
  assert.equal(manual.service.list(manual.item.id).length, 0);
  assert.equal(manual.delivery().error, 'SUMMARY_REQUIRED');
  assert.deepEqual(manual.sent, []);
});

test('SP-04: daily digest excludes unfinished summaries and later includes only the ready summary', async (t) => {
  const f = setup(t, 'auto', true);
  await f.engine.cycle();
  assert.equal(f.store.get("SELECT count(*) n FROM deliveries WHERE mode='digest_part'")!.n, 0);
  assert.equal(f.delivery().status, 'digest_wait');
  f.advance(86400000);
  await f.engine.cycle();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /FeedRelay 日报/);
  assert.doesNotMatch(f.sent[0], /推广广告|免费试用|非 AI 摘要/);
  assert.equal(f.service.describe().calls, 1);
});

test('SP-05: revoking consent cancels a prepared notification without sending retained snapshots', async (t) => {
  const f = setup(t);
  await f.engine.cycle();
  const snapshot = f.delivery().snapshot;
  assert.ok(snapshot);
  f.service.authorize(f.source.id, 'off', false, true);
  assert.equal(f.delivery().status, 'cancelled');
  assert.equal(f.delivery().snapshot, snapshot);
  await f.engine.cycle();
  assert.deepEqual(f.sent, []);
});

test('SP-06: resuming a source invalidates its frozen AI digest before any send', async (t) => {
  const f = setup(t, 'auto', true);
  f.service.enqueue(f.item.id);
  await f.service.cycle('demo');
  f.advance(86400000);
  freezeDigest(f.store, 'demo');
  const part = f.store.get<Delivery>("SELECT * FROM deliveries WHERE mode='digest_part'")!;
  assert.ok(part.snapshot);
  f.store.toggle(f.source.id, true, true);
  await f.engine.cycle();
  assert.equal(f.store.get('SELECT status FROM deliveries WHERE id=?', part.id)!.status, 'cancelled');
  assert.deepEqual(f.sent, []);
});
