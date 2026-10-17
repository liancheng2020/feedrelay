import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture, incoming } from './helpers.js';
import { createApp } from '../server/app.js';
import { type SummaryRow } from '../server/summary.js';
import { AppError } from '../server/config.js';
function setup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t),
    source = f.source('youtube', false),
    service = f.engine.summaries;
  service.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  const item = f.store.put(incoming(), [source], false, f.engine.destination);
  return { ...f, source, service, item };
}
test('RD-01: detail consent authorizes manual captions only; cached transcript remains authenticated and no caption request on GET', async (t) => {
  const f = setup(t);
  let fetches = 0;
  const fetch = f.service.captions!.fetch;
  f.service.captions!.fetch = async (...args) => {
    fetches++;
    return fetch(...args);
  };
  assert.equal(f.service.transcript(f.item.id), null);
  f.service.request(f.item.id, 'captions');
  assert.equal(f.store.source(f.source.id).summary_mode, 'manual');
  assert.equal(f.store.source(f.source.id).summary_notify, 0);
  await f.service.cycle(f.engine.destination);
  assert.equal(fetches, 1);
  assert.match(f.service.transcript(f.item.id)!.text, /\[00:10\]/);
  assert.equal(f.service.list(f.item.id)[0].status, 'succeeded');
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0);
});
test('RD-02: manual push of collect-only source is idempotent, frozen and never invokes the model again', async (t) => {
  const f = setup(t);
  f.service.request(f.item.id, 'feed');
  await f.service.cycle(f.engine.destination);
  const row = f.service.list(f.item.id)[0],
    calls = f.service.describe().calls;
  const first = f.service.pushLatest(f.item.id, row.id, row.revision);
  const second = f.service.pushLatest(f.item.id, row.id, row.revision);
  assert.equal(first.id, second.id);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
  const d = f.store.claimDelivery(f.engine.destination)!;
  assert(d);
  assert.match(d.snapshot, /^测试标题（模拟摘要）\n\n1\. /);
  assert.match(d.snapshot, /样例正文/);
  f.store.finishDelivery(d, { status: 'unknown', code: 'TEST_NETWORK_UNKNOWN' });
  assert.equal(f.service.pushLatest(f.item.id, row.id, row.revision).status, 'unknown');
  assert.equal(f.store.claimDelivery(f.engine.destination), undefined);
  f.store.resolveDelivery(String(first.id), 'retry', f.engine.destination);
  const retried = f.store.claimDelivery(f.engine.destination)!;
  assert.equal(retried.snapshot, d.snapshot);
  f.store.finishDelivery(retried, { status: 'sent' });
  assert.equal(f.service.describe().calls, calls);
});

test('RD-11: summary push contains only a title and numbered points, with no evidence or footer', async (t) => {
  const f = setup(t);
  f.service.request(f.item.id, 'captions');
  await f.service.cycle(f.engine.destination);
  const row = f.service.list(f.item.id)[0];
  const result = row.result!;
  result.oneLiner = '不重复发送整段概括';
  result.points = [1, 2, 3].map((n) => ({ ...result.points[0], title: `要点${n}`, text: `简洁总结${n}` }));
  f.store.run('UPDATE summaries SET result=? WHERE id=?', JSON.stringify(result), row.id);
  const updated = f.service.list(f.item.id)[0];
  const calls = f.service.describe().calls;
  f.service.pushLatest(f.item.id, updated.id, updated.revision);
  const delivery = f.store.claimDelivery(f.engine.destination)!;
  assert.equal(delivery.snapshot, '测试标题（模拟摘要）\n\n1. 要点1\n简洁总结1\n\n2. 要点2\n简洁总结2\n\n3. 要点3\n简洁总结3');
  assert.equal(f.service.describe().calls, calls);
});

test('RD-07: explicit push can replace a cancelled unsent snapshot without duplicating an active version', async (t) => {
  const f = setup(t);
  f.service.request(f.item.id, 'feed');
  await f.service.cycle(f.engine.destination);
  const row = f.service.list(f.item.id)[0],
    first = f.service.pushLatest(f.item.id, row.id, row.revision);
  f.service.authorize(f.source.id, 'manual', false, true, 'feed');
  assert.equal(
    f.store.get('SELECT status FROM deliveries WHERE id=?', first.id)!.status,
    'cancelled',
  );
  const second = f.service.pushLatest(f.item.id, row.id, row.revision);
  assert.notEqual(second.id, first.id);
  assert.equal(f.service.pushLatest(f.item.id, row.id, row.revision).id, second.id);
  assert(f.store.claimDelivery(f.engine.destination));
});
test('RD-03: changed revision, expired content, revoked consent and changed destination cannot push', async (t) => {
  const f = setup(t);
  f.service.request(f.item.id, 'feed');
  await f.service.cycle(f.engine.destination);
  const row = f.service.list(f.item.id)[0];
  assert.throws(() => f.service.pushLatest(f.item.id, row.id, 'stale'), /SUMMARY_PUSH_STALE/);
  f.service.destination = 'new-target';
  assert.throws(() => f.service.pushLatest(f.item.id, row.id, row.revision), /SUMMARY_PUSH_STALE/);
  f.service.destination = f.engine.destination;
  f.store.run('UPDATE items SET expired=1 WHERE id=?', f.item.id);
  assert.throws(() => f.service.pushLatest(f.item.id, row.id, row.revision), /SUMMARY_PUSH_STALE/);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0);
});
test('RD-04: regeneration revokes queued old snapshot, keeps usage and blocks stale clients', async (t) => {
  const f = setup(t);
  f.service.request(f.item.id, 'feed');
  await f.service.cycle(f.engine.destination);
  const old = f.service.list(f.item.id)[0],
    sent = f.service.pushLatest(f.item.id, old.id, old.revision);
  f.advance(1);
  f.service.request(f.item.id, 'feed', false, true);
  assert.equal(
    f.store.get('SELECT status FROM deliveries WHERE id=?', sent.id)!.status,
    'cancelled',
  );
  assert.throws(() => f.service.pushLatest(f.item.id, old.id, old.revision), /SUMMARY_PUSH_STALE/);
  await f.service.cycle(f.engine.destination);
  const current = f.service.list(f.item.id)[0];
  assert.notEqual(current.revision, old.revision);
  assert.equal(current.calls.length, 2);
  assert.equal(current.output, null);
  assert.throws(() => f.service.pushLatest(f.item.id, old.id, old.revision), /SUMMARY_PUSH_STALE/);
});
test('RD-05: paused/deleted source cancels manually queued summary; automatic toggle is not a bypass', async (t) => {
  const f = setup(t);
  f.service.request(f.item.id, 'feed');
  await f.service.cycle(f.engine.destination);
  const row = f.service.list(f.item.id)[0],
    output = f.service.pushLatest(f.item.id, row.id, row.revision);
  f.store.toggle(f.source.id, false, false);
  const revoked = f.store.get(
    'SELECT status,error,snapshot FROM deliveries WHERE id=?',
    output.id,
  )!;
  assert.equal(revoked.status, 'failed');
  assert.equal(revoked.error, 'CONTENT_EXPIRED');
  assert.equal(revoked.snapshot, '');
  assert.throws(() => f.service.pushLatest(f.item.id, row.id, row.revision), /SUMMARY_PUSH_STALE/);
});
test('RD-06: list/detail/push APIs expose status and current revision but require login, CSRF and confirmation', async (t) => {
  const f = setup(t),
    server = createApp(f.store, f.config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  let cookie = '',
    csrf = '';
  const api = async (path: string, body?: object) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Cookie: cookie,
        Origin: f.config.origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    return response;
  };
  assert.equal((await api(`/items/${f.item.id}`)).status, 401);
  csrf = (await (await api('/login', { password: 'demo' })).json()).csrf;
  assert.equal((await api(`/items/${f.item.id}/summary`, { content: 'feed' })).status, 400);
  assert.equal(
    (await api(`/items/${f.item.id}/summary`, { content: 'feed', confirmed: true })).status,
    202,
  );
  await f.service.cycle(f.engine.destination);
  const detail = await (await api(`/items/${f.item.id}`)).json();
  assert.equal(detail.canSummarize, true);
  assert.equal(detail.summaries[0].current, true);
  const list = await (await api('/items')).json();
  assert.equal(list.items[0].summaryStatus, 'succeeded');
  assert.equal(list.items[0].summaryError, '');
  const payload = { summaryId: detail.summaries[0].id, revision: detail.summaries[0].revision };
  assert.equal((await api(`/items/${f.item.id}/summary/push`, payload)).status, 400);
  assert.equal(
    (await api(`/items/${f.item.id}/summary/push`, { ...payload, confirmed: true })).status,
    202,
  );
  const stale = { ...payload, revision: 'old', confirmed: true };
  assert.equal((await api(`/items/${f.item.id}/summary/push`, stale)).status, 409);
  f.service.captions!.fetch = async () => {
    throw new AppError('YOUTUBE_NO_CAPTIONS');
  };
  f.service.request(f.item.id, 'captions');
  await f.service.cycle(f.engine.destination);
  const unavailable = await (await api('/items')).json();
  assert.equal(unavailable.items[0].summaryStatus, 'failed');
  assert.equal(unavailable.items[0].summaryError, 'YOUTUBE_NO_CAPTIONS');
});

test('RD-08: missing captions expose a source error, charge no model requests, and explicit retry can recover', async (t) => {
  const f = setup(t),
    fetchCaption = f.service.captions!.fetch;
  let fetches = 0;
  f.service.captions!.fetch = async (...args) => {
    fetches++;
    if (fetches < 3) throw new AppError('YOUTUBE_NO_CAPTIONS');
    return fetchCaption(...args);
  };
  f.service.request(f.item.id, 'captions');
  await f.service.cycle(f.engine.destination);
  const row = f.service.list(f.item.id)[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'YOUTUBE_NO_CAPTIONS');
  assert.equal(row.result, null);
  assert.equal(f.service.describe().calls, 0);
  await f.service.cycle(f.engine.destination);
  assert.equal(fetches, 1, 'no automatic retry or description fallback');
  f.service.request(f.item.id, 'captions', true);
  await f.service.cycle(f.engine.destination);
  assert.equal(fetches, 2);
  assert.equal(f.service.describe().calls, 0);
  f.service.request(f.item.id, 'captions', true);
  await f.service.cycle(f.engine.destination);
  assert.equal(f.service.list(f.item.id)[0].status, 'succeeded');
  assert.equal(f.service.describe().calls, 1);
  assert.equal(f.service.list(f.item.id)[0].output, null);
});
