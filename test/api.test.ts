import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { fixture, channel, incoming } from './helpers.js';

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

test('FR-08 / PG-01: updates retain time order across page sizes, filters and page boundaries', async (t) => {
  const f = fixture(t),
    source = f.source('youtube', false),
    email = f.source('email', false),
    server = createApp(f.store, f.config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const login = await fetch(url + '/login', {
    method: 'POST',
    headers: { Origin: f.config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'demo' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const base = f.now() - 100_000;
  const records = Array.from({ length: 34 }, (_, i) => {
    const time = base + (33 - i) * 1000;
    return f.store.put(incoming(`video-${i}`, time), [source], false, 'demo');
  });
  records.push(
    f.store.put(
      { ...incoming('email', f.now() + 100_000), kind: 'email', received: base + 18_500 },
      [email],
      false,
      'demo',
    ),
    f.store.put({ ...incoming('no-date'), published: null }, [source], false, 'demo'),
    f.store.put(incoming('same-time', base + 18_000), [source], false, 'demo'),
  );
  f.store.put({ ...incoming('hidden-summary'), kind: 'summary' }, [source], false, 'demo');
  const expected = records
    .map((item, index) => ({ ...item, index }))
    .sort(
      (a, b) =>
        (b.received ?? b.published ?? b.discovered) - (a.received ?? a.published ?? a.discovered) ||
        b.discovered - a.discovered ||
        b.index - a.index,
    );
  async function items(query = '') {
    const response = await fetch(url + '/items' + query, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.json();
  }
  const first = await items('?page=1'),
    second = await items('?page=2');
  assert.equal(first.total, 37);
  assert.equal(first.pageSize, 20);
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 17);
  assert.deepEqual(
    [...first.items, ...second.items].map((item: { id: string }) => item.id),
    expected.map((item) => item.id),
  );
  const filtered = await items(`?source=${source.id}&status=discovered`);
  const youtube = expected.filter((item) => item.kind === 'youtube');
  assert.equal(filtered.total, youtube.length);
  assert.deepEqual(
    filtered.items.map((item: { id: string }) => item.id),
    youtube.slice(0, 20).map((item) => item.id),
  );
  for (const size of [10, 20, 50, 100]) {
    const ids: string[] = [];
    const pages = Math.ceil(expected.length / size);
    for (let page = 1; page <= pages; page++) {
      const result = await items(`?page=${page}&pageSize=${size}`);
      assert.equal(result.page, page);
      assert.equal(result.pageSize, size);
      assert.equal(result.items.length, Math.min(size, expected.length - (page - 1) * size));
      ids.push(...result.items.map((item: { id: string }) => item.id));
    }
    assert.deepEqual(ids, expected.map((item) => item.id));
    assert.equal((await items(`?page=999&pageSize=${size}`)).page, pages);
  }
  for (const size of ['0', '-1', '30', '1000', '10.5', 'bad']) {
    const result = await items(`?pageSize=${size}`);
    assert.equal(result.pageSize, 20);
    assert.equal(result.items.length, 20);
  }
  const empty = await items('?source=missing&page=999&pageSize=10');
  assert.equal(empty.page, 1);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);
});
