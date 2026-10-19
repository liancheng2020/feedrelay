import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture, incoming } from './helpers.js';
import { createApp } from '../server/app.js';

test('PS-01: manual summary pushes update original list, detail and grouped filters without duplicate rows', async (t) => {
  const f = fixture(t), s = f.source('email');
  const service = f.engine.summaries;
  service.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  service.authorize(s.id, 'manual', false, true);
  const item = f.store.put({ ...incoming(), kind: 'email' }, [f.store.source(s.id)], false, 'demo');
  service.enqueue(item.id);
  await service.cycle('demo');
  const summary = service.list(item.id)[0];
  const delivery = service.pushLatest(item.id, summary.id, summary.revision);
  f.store.run("INSERT INTO deliveries(id,item_id,destination,snapshot,available,created,status) VALUES ('old',?,'demo','old',0,0,'sent')", item.id);
  const server = createApp(f.store, f.config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const login = await fetch(base + '/login', { method: 'POST', headers: { Origin: f.config.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'demo' }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const get = async (path: string) => (await fetch(base + path, { headers: { Cookie: cookie } })).json();
  for (const [raw, grouped] of [['pending','waiting'], ['retry_wait','waiting'], ['sending','sending'], ['sent','sent'], ['unknown','attention'], ['failed','attention'], ['cancelled','unpublished']]) {
    f.store.run('UPDATE deliveries SET status=? WHERE id=?', raw, delivery.id);
    const list = await get(`/items?status=${grouped}`);
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, item.id);
    assert.equal(list.items[0].pushStatus, grouped);
    assert.equal(list.items[0].delivery_id, delivery.id);
    assert.equal((await get(`/items/${item.id}`)).delivery.status, raw);
    assert.equal((await get('/items')).total, 1);
    assert.equal((await get(`/items?status=${grouped === 'sent' ? 'unpublished' : 'sent'}`)).total, 0);
  }
});
