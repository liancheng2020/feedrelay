import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { freezeDigest } from '../server/digest.js';
import { fixture, channel, incoming } from './helpers.js';
test('v2 API import, mode confirmation, effective digest status and part resolution', async (t) => {
  const f = fixture(t),
    server = createApp(f.store, f.config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  let cookie = '',
    csrf = '';
  async function call(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: f.config.origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.headers.getSetCookie().length)
      cookie = response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    return response;
  }
  assert.equal((await call('/digests')).status, 401);
  csrf = (await (await call('/login', 'POST', { password: 'demo' })).json()).csrf;
  assert.equal(
    (
      await call('/sources', 'POST', {
        type: 'rss',
        name: 'RSS',
        feed_url: 'https://example.com/feed',
      })
    ).status,
    400,
  );
  const data = {
    format: 'feedrelay.sources',
    version: 1,
    sources: [
      { type: 'youtube', name: '频道', channel, delivery_mode: 'digest' },
      { type: 'rss', name: 'RSS', feed_url: 'https://example.com/feed' },
    ],
  };
  const plan = await (await call('/sources/import-preview', 'POST', data)).json();
  assert.equal(f.store.sources().length, 0);
  assert.equal(
    (await call('/sources/import', 'POST', { bundle: data, hash: plan.hash, confirmed: true }))
      .status,
    400,
  );
  assert.equal(
    (
      await call('/sources/import', 'POST', {
        bundle: data,
        hash: plan.hash,
        confirmed: true,
        confirmedPublic: true,
      })
    ).status,
    200,
  );
  const source = f.store.sources().find((s) => s.type === 'youtube')!;
  assert.equal(source.enabled, 0);
  assert.equal(
    (await call(`/sources/${source.id}/delivery-mode`, 'POST', { mode: 'immediate' })).status,
    400,
  );
  assert.equal((await call('/sources/export')).status, 200);
  assert.equal((await (await call('/sources/export')).json()).sources.length, 1);
  assert.equal(
    (await (await call('/sources/export?includePublicFeeds=confirmed')).json()).sources.length,
    2,
  );
  f.store.setSettings({ ...f.store.settings(), digestTime: '12:00' });
  const active = f.store.toggle(source.id, true, true);
  const original = f.store.put(incoming('queued', f.now()), [active], true, 'demo');
  freezeDigest(f.store, 'demo');
  const listed = await (await call('/items?status=pending')).json();
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].id, original.id);
  const detail = await (await call(`/items/${original.id}`)).json();
  assert.equal(detail.delivery.mode, 'digest_part');
  f.store.finishDelivery(f.store.claimDelivery('demo')!, { status: 'unknown' });
  assert.equal((await (await call('/items?status=unknown')).json()).total, 1);
  assert.equal(
    (
      await call(`/deliveries/${detail.delivery.id}/resolve`, 'POST', {
        action: 'retry',
        confirmed: true,
      })
    ).status,
    200,
  );
  assert.equal((await (await call('/digests')).json())[0].parts[0].status, 'pending');
  assert.equal(
    (await call('/settings', 'PUT', { ...f.store.settings(), digestTime: '25:00' })).status,
    400,
  );
});
