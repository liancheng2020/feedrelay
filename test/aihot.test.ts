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
