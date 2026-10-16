import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { fixture, channel } from './helpers.js';

test('API auth, Origin, CSRF, disclosure and source lifecycle', async (t) => {
  const f = fixture(t),
    server = createApp(f.store, f.config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = '',
    csrf = '';
  async function request(
    path: string,
    method = 'GET',
    data?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(url + '/api' + path, {
      method,
      headers: {
        Origin: f.config.origin,
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    return response;
  }
  assert.equal((await request('/sources')).status, 401);
  assert.equal(
    (await request('/login', 'POST', { password: 'demo' }, { Origin: 'https://evil.test' })).status,
    403,
  );
  const login = await request('/login', 'POST', { password: 'demo' });
  assert.equal(login.status, 200);
  csrf = (await login.json()).csrf;
  assert.equal(
    (
      await request(
        '/sources',
        'POST',
        { type: 'youtube', name: '频道', channel },
        { 'X-CSRF-Token': '' },
      )
    ).status,
    403,
  );
  const created = await request('/sources', 'POST', { type: 'youtube', name: '频道', channel });
  assert.equal(created.status, 201);
  const source = await created.json();
  assert.equal(source.enabled, 0);
  assert.equal(
    (await request(`/sources/${source.id}/toggle`, 'POST', { enabled: true, notify: true })).status,
    400,
  );
  assert.equal(
    (
      await request(`/sources/${source.id}/toggle`, 'POST', {
        enabled: true,
        notify: true,
        confirmed: true,
      })
    ).status,
    200,
  );
  assert.equal((await request('/items?page=1.2')).status, 200);
  const overview = JSON.stringify(await (await request('/overview')).json());
  assert(!overview.includes(f.config.sessionSecret));
  assert(!overview.includes('passwordHash'));
  assert(!overview.includes('openId'));
  assert.equal(
    (await request(`/sources/${source.id}`, 'DELETE', { confirmed: true, erase: true })).status,
    200,
  );
  assert.equal((await (await request('/sources')).json()).length, 0);
});
