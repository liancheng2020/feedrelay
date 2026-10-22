import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { diagnostics } from '../server/diagnostics.js';
import { createApp } from '../server/app.js';
import { once } from 'node:events';
import { AppError } from '../server/config.js';

test('HOST-06: diagnostics distinguish configuration, worker heartbeat and authorization', async t => {
  const f = fixture(t);
  assert.equal(diagnostics(f.engine).worker.running, false);
  const source = f.source();
  assert.equal(diagnostics(f.engine).checks.find(c => c.id === 'automatic')!.ok, false);
  f.engine.summaries.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  f.engine.summaries.authorize(source.id, 'auto', false, true);
  await f.engine.cycle();
  const status = diagnostics(f.engine);
  assert.equal(status.worker.running, true);
  assert.equal(status.checks.find(c => c.id === 'automatic')!.ok, true);
  f.advance(120_001);
  assert.equal(diagnostics(f.engine).worker.running, false);
  f.store.run("UPDATE sources SET summary_consent='' WHERE id=?", source.id);
  assert.equal(diagnostics(f.engine).checks.find(c => c.id === 'automatic')!.ok, false);
});

test('HOST-07: password-mode diagnostics remain private and health stays minimal', async t => {
  const f = fixture(t);
  const server = createApp(f.store, f.config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(base + '/api/diagnostics')).status, 401);
  assert.deepEqual(await (await fetch(base + '/api/health')).json(), { ok: true });
});

test('HOST-12: source diagnostics identify enabled failures and their active retry schedule', async t => {
  const f = fixture(t);
  const source = f.source();
  f.store.enqueue('source', source.id, source.generation);
  const job = f.store.claimJob()!;
  f.store.finishJob(job, new AppError('YOUTUBE_NETWORK_ERROR', 502, true));
  const paused = f.store.createSource({ type: 'youtube', name: 'Paused source', channel: 'UC' + 'b'.repeat(22) });
  f.store.run("UPDATE sources SET error='SOURCE_UNAVAILABLE' WHERE id=?", paused.id);
  const status = diagnostics(f.engine);
  assert.equal(status.sourceIssues.length, 1);
  assert.deepEqual(status.sourceIssues[0], {
    sourceId: source.id, name: source.name, error: 'YOUTUBE_NETWORK_ERROR', lastSuccess: null,
    status: 'retry_wait', nextCheck: f.store.get('SELECT available FROM jobs WHERE id=?', job.id)!.available,
  });
  assert.equal(status.checks.find(c => c.id === 'sources')!.detail, '1 个已启用；1 个异常');
  assert.doesNotMatch(JSON.stringify(status), /feed_url|snapshot|IMAP_PASSWORD|SESSION_SECRET/);
});

test('HOST-13: manual source check expedites the existing retry without clearing errors or resetting attempts', async t => {
  const f = fixture(t);
  const source = f.source();
  f.store.enqueue('source', source.id, source.generation);
  const job = f.store.claimJob()!;
  f.store.finishJob(job, new AppError('YOUTUBE_NETWORK_ERROR', 502, true));
  f.store.run('UPDATE jobs SET attempt=4 WHERE id=?', job.id);
  const server = createApp(f.store, { ...f.config, authMode: 'local' }, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const session = await fetch(base + '/session');
  const { csrf } = await session.json();
  const cookie = session.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const check = (token = csrf) => fetch(`${base}/sources/${source.id}/check`, { method: 'POST',
    headers: { Origin: f.config.origin, Cookie: cookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await check('')).status, 403);
  const response = await check();
  assert.equal(response.status, 202);
  const expedited = await response.json();
  assert.equal(expedited.id, job.id);
  assert.equal(expedited.status, 'pending');
  assert.equal(expedited.attempt, 4);
  assert.equal(expedited.available, f.now());
  assert.equal(f.store.source(source.id).error, 'YOUTUBE_NETWORK_ERROR');
  const running = f.store.claimJob()!;
  assert.equal(running.attempt, 5);
  const unchanged = await (await check()).json();
  assert.equal(unchanged.id, running.id);
  assert.equal(unchanged.status, 'running');
  assert.equal(unchanged.token, running.token);
  assert.equal(unchanged.lease, running.lease);
  for (let n = 0; n < 3; n++) assert.equal((await check()).status, 202);
  assert.equal((await check()).status, 429, 'reusing a job must still consume the manual request limit');
  f.advance(60_001);
  assert.equal((await check()).status, 202);
  await f.engine.execute(running);
  assert.equal(f.store.source(source.id).error, '');
  assert.equal(diagnostics(f.engine).sourceIssues.length, 0);
  assert.equal(diagnostics(f.engine).checks.find(c => c.id === 'sources')!.ok, true);
  assert.equal(f.store.all('SELECT * FROM jobs WHERE resource=?', source.id).length, 1);
});

test('HOST-15: an active retry does not postpone the next collection; recovery stays automatic', async t => {
  let offline = true;
  const f = fixture(t, { feed: async () => {
    if (offline) throw new AppError('YOUTUBE_NETWORK_ERROR', 502, true);
    return { unchanged: true, items: [] };
  } });
  const source = f.source();
  f.store.run('UPDATE sources SET initialized=1 WHERE id=?', source.id);
  f.store.schedule();
  const due = f.store.source(source.id).next_check;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const job = f.store.claimJob()!;
    assert.equal(job.attempt, attempt);
    await f.engine.execute(job);
    if (attempt < 5) {
      const available = Number(f.store.get('SELECT available FROM jobs WHERE id=?', job.id)!.available);
      f.advance(available - f.now());
      f.store.schedule();
      assert.equal(f.store.source(source.id).next_check, due);
    }
  }
  assert.equal(f.store.source(source.id).error, 'YOUTUBE_NETWORK_ERROR');
  offline = false;
  f.advance(Math.max(0, due - f.now()));
  await f.engine.cycle();
  assert.equal(f.store.source(source.id).error, '');
  assert.equal(diagnostics(f.engine).sourceIssues.length, 0);
  assert.equal(f.store.all('SELECT * FROM jobs').length, 2);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0, '304 recovery must not resend');
});

test('HOST-16: interrupted collection is visible and exhausted leases recover on the due schedule', async t => {
  const f = fixture(t);
  const source = f.source();
  f.store.schedule();
  const first = f.store.claimJob()!;
  f.advance(120_001);
  f.store.schedule();
  assert.equal(diagnostics(f.engine).sourceIssues[0].error, 'LEASE_EXPIRED');
  const resumed = f.store.claimJob()!;
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.attempt, 2);
  assert.equal(f.store.validJob(first), false);
  f.store.run('UPDATE jobs SET attempt=5 WHERE id=?', resumed.id);
  f.advance(f.store.source(source.id).next_check - f.now());
  f.store.schedule();
  assert.equal(f.store.get('SELECT status FROM jobs WHERE id=?', first.id)!.status, 'failed');
  const fresh = f.store.claimJob()!;
  assert.notEqual(fresh.id, first.id);
  await f.engine.execute(fresh);
  assert.equal(f.store.source(source.id).error, '');
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0, 'recovery preserves the silent baseline');
});
