import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { fixture, channel } from './helpers.js';

test('LOCAL-01: local is the default; public bind/origin require password mode', () => {
  const env = { SESSION_SECRET: 'synthetic-local-secret'.repeat(3) };
  assert.equal(readConfig(env).authMode, 'local');
  for (const HOST of ['0.0.0.0', '192.168.1.2', 'example.com'])
    assert.throws(() => readConfig({ ...env, HOST }), /LOCAL_ACCESS_LOOPBACK_ONLY/);
  for (const APP_ORIGIN of ['http://example.com', 'http://192.168.1.2'])
    assert.throws(() => readConfig({ ...env, APP_ORIGIN }), /LOCAL_ACCESS_LOOPBACK_ONLY/);
  assert.throws(() => readConfig({ ...env, AUTH_MODE: 'off' }), /INVALID_AUTH_MODE/);
  assert.throws(() => readConfig({ ...env, AUTH_MODE: 'password' }), /RUN_NPM_SETUP_FIRST/);
  assert.equal(readConfig({ ...env, HOST: '::1', APP_ORIGIN: 'http://[::1]:8787' }).authMode, 'local');
});

test('LOCAL-02: direct access retains Host, Origin, CSRF and proxy boundaries without login', async (t) => {
  const f = fixture(t), config = { ...f.config, authMode: 'local' as const };
  const server = createApp(f.store, config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  let cookie = '', csrf = '';
  const request = (path: string, data?: object, headers: Record<string, string> = {}) => fetch(base + path, {
    method: data ? 'POST' : 'GET',
    headers: { Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.equal((await request('/sources')).status, 200);
  const session = await request('/session');
  const info = await session.json();
  assert.equal(info.authenticated, true);
  assert.equal(info.authMode, 'local');
  assert.equal(info.mustChangePassword, false);
  csrf = info.csrf;
  cookie = session.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const source = { type: 'youtube', name: '本机测试来源', channel };
  assert.equal((await request('/sources', source, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await request('/sources', source, { Cookie: '' })).status, 403);
  assert.equal((await request('/sources', source)).status, 201);
  for (const name of ['Forwarded', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP'])
    assert.equal((await request('/sources', undefined, { [name]: 'untrusted' })).status, 403);
  const rawStatus = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = httpRequest(base + '/sources', { headers }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await rawStatus({ Host: 'rebind.example' }), 403);
  assert.equal((await request('/sources', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(await rawStatus({ 'Sec-Fetch-Site': 'cross-site' }), 403);
  for (const path of ['/login', '/password', '/logout'])
    assert.equal((await request(path, {})).status, 409);
  assert.equal(f.store.all('SELECT * FROM admin_sessions').length, 0);

  // A local CSRF cookie must never become a password-mode login session.
  const protectedServer = createApp(f.store, f.config, f.engine).listen(0, '127.0.0.1');
  await once(protectedServer, 'listening');
  t.after(() => { protectedServer.closeAllConnections(); protectedServer.close(); });
  const protectedUrl = `http://127.0.0.1:${(protectedServer.address() as { port: number }).port}/api/sources`;
  assert.equal((await fetch(protectedUrl, { headers: { Cookie: cookie } })).status, 401);
});
