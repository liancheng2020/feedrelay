import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { diagnostics } from '../server/diagnostics.js';
import { createApp } from '../server/app.js';
import { once } from 'node:events';

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
