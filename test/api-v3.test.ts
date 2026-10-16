import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { fixture, incoming } from './helpers.js';

test('v3 API requires login and separate budget, source and item consent; never exposes credentials', async (t) => {
  const f = fixture(t),
    s = f.source('email'),
    item = f.store.put({ ...incoming(), kind: 'email' }, [s], true, 'demo');
  const server = createApp(f.store, f.config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  let cookie = '',
    csrf = '';
  async function call(path: string, method = 'GET', body?: unknown) {
    const r = await fetch(base + path, {
      method,
      headers: {
        Origin: f.config.origin,
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (r.headers.getSetCookie().length)
      cookie = r.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    return r;
  }
  assert.equal((await call('/summaries/settings')).status, 401);
  csrf = (await (await call('/login', 'POST', { password: 'demo' })).json()).csrf;
  const budget = { enabled: true, maxCalls: 2, maxCostCny: 1 };
  assert.equal((await call('/summaries/settings', 'PUT', budget)).status, 400);
  assert.equal(
    (await call('/summaries/settings', 'PUT', { ...budget, confirmed: true })).status,
    200,
  );
  assert.equal((await call(`/items/${item.id}/summary`, 'POST', { confirmed: true })).status, 400);
  assert.equal(
    (await call(`/sources/${s.id}/summary`, 'POST', { mode: 'auto', notify: true })).status,
    400,
  );
  assert.equal(
    (
      await call(`/sources/${s.id}/summary`, 'POST', {
        mode: 'manual',
        notify: false,
        confirmed: true,
      })
    ).status,
    200,
  );
  assert.equal((await call(`/items/${item.id}/summary`, 'POST', {})).status, 400);
  assert.equal((await call(`/items/${item.id}/summary`, 'POST', { confirmed: true })).status, 202);
  await f.engine.summaries.cycle('demo');
  const detail = await (await call(`/items/${item.id}`)).json();
  assert.equal(detail.summaries[0].status, 'succeeded');
  assert.equal(detail.summaries[0].input, undefined);
  assert.equal((await (await call('/items')).json()).total, 1);
  const exported = await (await call('/sources/export')).json();
  assert.equal(exported.sources[0].summary_mode, undefined);
  const settings = await (await call('/summaries/settings')).json();
  assert.equal(settings.calls, 1);
  assert.equal(settings.apiKey, undefined);
  assert.equal(settings.dir, undefined);
});
