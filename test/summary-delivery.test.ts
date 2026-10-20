import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming } from './helpers.js';
import { AppError } from '../server/config.js';
import type { Delivery } from '../server/store.js';
import { freezeDigest } from '../server/digest.js';
import { Engine } from '../server/engine.js';
import { diagnostics } from '../server/diagnostics.js';

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

test('HOST-08: a long summary keeps its lease while other sources and ready messages continue', async t => {
  const f = setup(t);
  let release!: () => void, calls = 0;
  const original = f.service.captions!.fetch;
  f.service.captions!.fetch = async (...args) => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
    return original(...args);
  };
  t.after(() => release?.());
  await f.engine.cycle(true);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(diagnostics(f.engine).worker.summarizing, true);
  assert.equal(f.delivery().error, 'SUMMARY_REQUIRED');
  const other = f.store.createSource({ type: 'youtube', name: 'Other', channel: 'UC' + 'b'.repeat(22) });
  f.store.toggle(other.id, true, true);
  f.engine.adapters.feed = async () => ({ unchanged: false, items: [] });
  f.store.put({ ...incoming('ready-message', f.now()), title: 'Ready message' }, [f.store.source(other.id)], true, 'demo');
  const contender = new Engine(f.store, f.config, { feed: async () => { throw new Error('Second worker must not run'); } });
  await contender.cycle(true);
  await contender.stop();
  await f.engine.cycle(true);
  assert.equal(f.store.source(other.id).initialized, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /Ready message/);
  assert.equal(calls, 1);
  assert.equal(f.delivery().status, 'pending');
  release();
  await f.engine.cycle();
  await f.engine.cycle();
  assert.equal(f.delivery().status, 'sent');
  assert.equal(f.sent.length, 2);
  assert.equal(calls, 1);
});

test('HOST-11: losing the worker lease fences an in-flight summary before any model call', async t => {
  const f = setup(t);
  let release!: () => void;
  const original = f.service.captions!.fetch;
  f.service.captions!.fetch = async (...args) => {
    await new Promise<void>(resolve => { release = resolve; });
    return original(...args);
  };
  t.after(() => release?.());
  await f.engine.cycle(true);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.store.run("UPDATE locks SET token='other-worker',until=? WHERE name='worker'", f.now() + 120_000);
  release();
  await f.engine.stop();
  assert.notEqual(f.service.list(f.item.id)[0].status, 'succeeded');
  assert.equal(f.service.describe().calls, 0);
  assert.equal(f.delivery().snapshot, '');
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.get("SELECT token FROM locks WHERE name='worker'")!.token, 'other-worker');
});

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

test('SP-07: email notification toggle preserves cursor and consent; new mail summarizes before one send', async (t) => {
  const sent: string[] = [];
  let upper = 100;
  const f = fixture(t, {
    send: async (text) => { sent.push(text); return { status: 'sent' }; },
    mailbox: async () => ({ epoch: '1', upper,
      headers: async (from, to) => from <= 101 && to >= 101
        ? [{ uid: 101, sender: 'brief@example.com', subject: '新闻总结', received: f.now(), published: null }] : [],
      body: async () => '市场今日出现波动，成交量有所上升。', close: async () => {},
    }),
  });
  const s = f.source('email', false);
  f.engine.summaries.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  f.engine.summaries.authorize(s.id, 'auto', false, true);
  f.store.enqueue('mailbox', 'default');
  await f.run();
  const before = f.store.source(s.id);
  f.store.toggle(s.id, true, true);
  const after = f.store.source(s.id);
  for (const key of ['generation', 'boundary', 'initialized', 'summary_mode', 'summary_consent'] as const)
    assert.equal(after[key], before[key]);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0);
  f.advance(1);
  upper = 101;
  f.store.enqueue('mailbox', 'default');
  await f.run();
  assert.equal(f.store.get('SELECT error FROM deliveries')!.error, 'SUMMARY_REQUIRED');
  assert.equal(f.store.claimDelivery('demo'), undefined);
  await f.engine.cycle();
  assert.equal(sent.length, 0);
  assert.equal(f.store.get('SELECT status FROM summaries')!.status, 'succeeded');
  await f.engine.cycle();
  await f.engine.cycle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\n\n1\. /);
  assert.equal(f.engine.summaries.describe().calls, 1);
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
