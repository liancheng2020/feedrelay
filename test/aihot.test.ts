import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Aihot, dailyMessages } from '../server/aihot.js';
import { fixture } from './helpers.js';

const report = (date: string) => ({ report: { date,
  sections: [{ items: [{ title: '新模型发布', summary: '支持更长上下文。' }] }],
  flashes: [{ title: '开发工具更新' }],
} });

test('AH-01: formatting validates edition, deduplicates and splits without losing content', () => {
  assert.throws(() => dailyMessages(report('2026-10-15'), '2026-10-16'), /NOT_PUBLISHED/);
  const data = report('2026-10-16');
  data.report.sections[0].items.push(data.report.sections[0].items[0]);
  const text = dailyMessages(data, '2026-10-16').join('\n');
  assert.equal(text.match(/新模型发布/g)?.length, 1);
  assert.match(text, /2\. 开发工具更新/);
  assert.match(text, /来源：AIHOT/);
  const long = { report: { date: '2026-10-16', sections: [{ items: Array.from({ length: 8 }, (_, i) => ({ title: `新闻${i}`, summary: '文'.repeat(1000) })) }] } };
  const parts = dailyMessages(long, '2026-10-16');
  assert(parts.length > 1);
  assert(parts.every((p) => Array.from(p).length < 3900));
  assert(parts.join('').includes('新闻7'));
});

test('AH-02: first enable after 10 starts tomorrow, before 10 does not fetch, restart does not duplicate', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const a = new Aihot(f.store, async () => { calls++; return Response.json(report('2026-10-17')); });
  assert.equal(a.configure(true).startDate, '2026-10-17');
  await a.cycle('demo');
  assert.equal(calls, 0);
  f.advance(21 * 3600000); // 09:00 next day in Shanghai
  await a.cycle('demo');
  assert.equal(calls, 0);
  f.advance(3600000);
  await a.cycle('demo');
  const delivery = f.store.claimDelivery('demo')!;
  assert(delivery);
  f.store.finishDelivery(delivery, { status: 'unknown' });
  assert.equal(f.store.claimDelivery('demo'), undefined);
  f.store.resolveDelivery(delivery.id, 'retry', 'demo');
  const retry = f.store.claimDelivery('demo')!;
  f.store.finishDelivery(retry, { status: 'sent' });
  const restarted = new Aihot(f.store, async () => { throw Error('must not fetch again'); });
  await restarted.cycle('demo');
  assert.equal(calls, 1);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
});

test('AH-03: stale report and upstream throttle retry later; disabling cancels queued parts', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const a = new Aihot(f.store, async () => {
    calls++;
    if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '7200' } });
    return Response.json(report(calls === 2 ? '2026-10-16' : '2026-10-17'));
  });
  a.configure(true);
  f.advance(22 * 3600000);
  await a.cycle('demo');
  f.advance(3600000);
  await a.cycle('demo');
  assert.equal(calls, 1);
  f.advance(3600000);
  await a.cycle('demo');
  assert.equal(a.describe().error, 'AIHOT_NOT_PUBLISHED');
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0);
  f.advance(3600000);
  await a.cycle('demo');
  a.configure(false);
  assert.equal(f.store.claimDelivery('demo'), undefined);
});

test('AC2: quiet editions use only upstream lead; empty editions wait and malformed responses fail validation', () => {
  const quiet = { report: { date: '2026-10-26', sections: [], flashes: [],
    lead: { title: '今日安静，无大事发生', leadParagraph: '本统计时段没有新的 AI 大事。' } } };
  const messages = dailyMessages(quiet, '2026-10-26');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /今日安静，无大事发生\n本统计时段没有新的 AI 大事。/);
  assert.match(messages[0], /https:\/\/aihot.news\/daily\/2026-10-26/);
  assert.throws(() => dailyMessages({ report: { date: '2026-10-26', sections: [], flashes: [] } }, '2026-10-26'), /NOT_PUBLISHED/);
  for (const data of [null, [], {}, { report: null },
    { report: { date: 'invalid', sections: [] } },
    { report: { date: '2026-10-26', sections: [null] } },
    { report: { date: '2026-10-26', sections: [{ items: {} }] } },
    { report: { date: '2026-10-26', sections: [], flashes: {} } },
    { report: { date: '2026-10-26', sections: [{ items: [{ title: 'x', summary: 1 }] }] } },
  ]) assert.throws(() => dailyMessages(data, '2026-10-26'), /AIHOT_INVALID_REPORT/);
});

test('AC2: persisted finite backoff recovers network, JSON and empty-report failures once per day', async t => {
  const f = fixture(t);
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    if (calls === 1) throw Error('offline');
    if (calls === 2) return new Response('{');
    if (calls === 3) return Response.json({ report: { date: '2026-10-17', sections: [], flashes: [] } });
    return Response.json(report('2026-10-17'));
  };
  let a = new Aihot(f.store, request); a.configure(true); f.advance(22 * 3600000);
  for (const [index, code] of ['AIHOT_FETCH_FAILED', 'AIHOT_INVALID_REPORT', 'AIHOT_NOT_PUBLISHED', ''].entries()) {
    await a.cycle('demo');
    assert.equal(a.describe().error, code);
    assert.equal(a.describe().checkDate, '2026-10-17');
    await a.cycle('demo'); assert.equal(calls, index + 1);
    if (code) {
      assert(a.describe().nextCheck > f.now());
      f.advance(a.describe().nextCheck - f.now());
      a = new Aihot(f.store, request);
    }
  }
  assert.equal(f.store.get('SELECT count(*) n FROM digest_batches')!.n, 1);
  assert.equal(a.describe().lastDate, '2026-10-17');
});

test('AC2: Retry-After HTTP date survives restart and network retries are capped per day', async t => {
  const f = fixture(t);
  const a = new Aihot(f.store, async () => new Response('', { status: 503,
    headers: { 'Retry-After': new Date(f.now() + 7200000).toUTCString() } }));
  a.configure(true); f.advance(22 * 3600000); await a.cycle('demo');
  assert.equal(a.describe().nextCheck, f.now() + 7200000);
  const b = new Aihot(f.store, async () => { throw Error('offline'); });
  for (let i = 1; i < 12; i++) {
    f.advance(b.describe().nextCheck - f.now()); await b.cycle('demo');
  }
  assert.equal(b.describe().failures, 12);
  assert.equal(b.describe().nextCheck, Date.parse('2026-10-18T02:00:00Z'));
});

for (const change of ['disable', 'reconfigure', 'destination', 'midnight', 'abort'] as const) {
  test(`AC2: in-flight ${change} fences stale writes and deliveries`, async t => {
    const f = fixture(t);
    let release!: () => void, calls = 0, destination = 'demo';
    const controller = new AbortController();
    const a = new Aihot(f.store, async () => {
      calls++; await new Promise<void>(r => { release = r; });
      return Response.json(report('2026-10-17'));
    });
    a.configure(true); f.advance(22 * 3600000);
    const work = a.cycle(destination, controller.signal, () => destination);
    await a.cycle(destination); assert.equal(calls, 1);
    if (change === 'disable' || change === 'reconfigure') a.configure(false);
    if (change === 'reconfigure') a.configure(true);
    if (change === 'destination') destination = 'other';
    if (change === 'midnight') f.advance(14 * 3600000);
    if (change === 'abort') controller.abort();
    release(); await work;
    assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0);
    assert.equal(a.describe().error, '');
    if (change === 'abort') assert.equal(a.describe().nextCheck, 0);
  });
}

test('AC2: before 10 does not fetch or relabel yesterday errors as today; oversized body is cancelled', async t => {
  const f = fixture(t); let cancelled = false, calls = 0;
  const a = new Aihot(f.store, async () => {
    calls++;
    return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(256001)); }, cancel() { cancelled = true; } }));
  });
  a.configure(true); f.advance(22 * 3600000); await a.cycle('demo');
  assert.equal(a.describe().error, 'AIHOT_RESPONSE_TOO_LARGE'); assert.equal(cancelled, true);
  f.advance(23 * 3600000); await a.cycle('demo');
  assert.equal(calls, 1); assert.equal(a.describe().checkDate, '2026-10-17');
  assert.equal(a.describe().lastDate, '');
});
