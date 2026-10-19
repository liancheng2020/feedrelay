import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AdminAuth } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/config.js';
import { fixture } from './helpers.js';
import { Store } from '../server/store.js';
import { spawnSync } from 'node:child_process';

test('AUTH-01: 8-hour and 30-day sessions expire, survive service recreation and revoke', (t) => {
  const f = fixture(t), auth = new AdminAuth(f.store, f.config);
  auth.verify('demo');
  const short = auth.issue(false), long = auth.issue(true);
  assert.equal(short.maxAge, 8 * 3600000);
  assert.equal(long.maxAge, 30 * 86400000);
  assert(auth.valid(short.sid));
  assert(!f.store.get('SELECT id FROM admin_sessions WHERE id=?', short.sid));
  f.advance(short.maxAge);
  assert(!auth.valid(short.sid));
  assert(new AdminAuth(f.store, f.config).valid(long.sid));
  auth.revoke(long.sid);
  assert(!auth.valid(long.sid));
  const next = auth.issue(true);
  f.advance(next.maxAge);
  assert(!auth.valid(next.sid));
});

test('AUTH-02: password change validates, persists, revokes all sessions and preserves subscriptions', (t) => {
  const f = fixture(t), auth = new AdminAuth(f.store, f.config), source = f.source();
  const a = auth.issue(false), b = auth.issue(true);
  assert.throws(() => auth.setPassword('admin'), /INVALID_NEW_PASSWORD/);
  assert.throws(() => auth.setPassword('a'.repeat(7)), /INVALID_NEW_PASSWORD/);
  assert.throws(() => auth.setPassword('a'.repeat(17)), /INVALID_NEW_PASSWORD/);
  assert.throws(() => auth.setPassword(' '.repeat(8)), /INVALID_NEW_PASSWORD/);
  auth.setPassword('a'.repeat(8));
  auth.verify('a'.repeat(8));
  auth.setPassword('test-password-16');
  assert(!auth.valid(a.sid)); assert(!auth.valid(b.sid));
  assert.throws(() => auth.verify('demo'), /INVALID_PASSWORD/);
  const reopened = new Store(f.dir, 'demo');
  try { new AdminAuth(reopened, f.config).verify('test-password-16'); }
  finally { reopened.close(); }
  assert.throws(() => auth.setPassword('test-password-16'), /PASSWORD_UNCHANGED/);
  assert(f.store.get('SELECT id FROM sources WHERE id=?', source.id));
  assert(!JSON.stringify(f.store.all('SELECT * FROM events')).includes('test-password-16'));
});

test('AUTH-06: recovery command refuses non-interactive output without changing credentials', (t) => {
  const f = fixture(t), auth = new AdminAuth(f.store, f.config), session = auth.issue(false);
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/reset-password.ts'], {
    env: { ...process.env, FEEDRELAY_DEMO: '1', DATA_DIR: f.dir }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /请在本机交互终端运行/);
  assert(!result.stdout.includes('新密码'));
  auth.verify('demo');
  assert(auth.valid(session.sid));
});

test('AUTH-03: default admin requires change; failed attempts are limited', (t) => {
  const f = fixture(t), auth = new AdminAuth(f.store, { ...f.config, demo: false, passwordHash: hashPassword('admin') });
  assert.equal(auth.issue(false).mustChangePassword, true);
  for (let i = 0; i < 10; i++) assert.throws(() => auth.verify('wrong'), /INVALID_PASSWORD/);
  assert.throws(() => auth.verify('admin'), /LOGIN_RATE_LIMITED/);
  f.advance(900001);
  auth.verify('admin');
});

test('AUTH-04: API CSRF, forced change, cookie lifetime and revoked-cookie replay', async (t) => {
  const f = fixture(t);
  const config = { ...f.config, demo: false, passwordHash: hashPassword('admin') };
  const server = createApp(f.store, config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  let cookie = '', csrf = '';
  const request = (path: string, data?: unknown, token = csrf) => fetch(base + path, {
    method: data ? 'POST' : 'GET',
    headers: { Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  async function login(password: string, remember = false) {
    const response = await request('/login', { password, remember });
    assert.equal(response.status, 200);
    cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    csrf = (await response.json()).csrf;
    return response;
  }
  const first = await login('admin', true);
  assert.match(first.headers.getSetCookie().join(' '), /httponly/i);
  assert.match(first.headers.getSetCookie().join(' '), /samesite=strict/i);
  assert.equal((await (await request('/session')).json()).mustChangePassword, true);
  assert.equal((await request('/overview')).status, 403);
  assert.equal((await request('/password', { currentPassword: 'admin', newPassword: 'new-password-123' }, '')).status, 403);
  assert.equal((await request('/password', { currentPassword: 'wrong', newPassword: 'new-password-123' })).status, 400);
  assert.equal((await request('/password', { currentPassword: 'admin', newPassword: 'new-password-123' })).status, 200);
  assert.equal((await request('/overview')).status, 401);
  await login('new-password-123', true);
  assert.equal((await request('/overview')).status, 200);
  f.advance(9 * 3600000);
  assert.equal((await request('/overview')).status, 200);
  assert.equal((await request('/logout', {})).status, 200);
  assert.equal((await request('/overview')).status, 401);
  await login('new-password-123');
  f.advance(8 * 3600000);
  assert.equal((await request('/overview')).status, 401);
});
