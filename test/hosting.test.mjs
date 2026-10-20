import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'dotenv';
import { servicePlan, hostedEnvironment, loadEnvironment, rotatingLog, winQuote } from '../scripts/hosting.mjs';
import { dailyBackup } from '../scripts/maintenance.mjs';

function temp(t, cleanup = true) {
  const dir = mkdtempSync(join(tmpdir(), 'feedrelay host '));
  if (cleanup) t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('HOST-01: platform definitions use current-user startup, bounded restart and quoted paths', () => {
  const root = '/home/user/中文 space & 100% $path';
  const options = { root, node: '/opt/node space/node', home: '/home/user', uid: 501, user: 'DOMAIN\\test' };
  const mac = servicePlan({ ...options, platform: 'darwin' });
  assert.match(mac.content, /中文 space &amp;/);
  assert.match(mac.content, /<integer>30<\/integer>/);
  assert.equal(mac.domain, 'gui/501');
  const linux = servicePlan({ ...options, platform: 'linux' });
  assert.match(linux.content, /WantedBy=default.target/);
  assert.match(linux.content, /100%% \$\$path/);
  assert.match(linux.content, /Restart=always/);
  assert.match(linux.content, /KillMode=mixed/);
  const windows = servicePlan({ ...options, platform: 'win32' });
  assert.match(windows.content, /InteractiveToken/);
  assert.match(windows.content, /LeastPrivilege/);
  assert.match(windows.content, /ExecutionTimeLimit>PT0S/);
  assert.match(windows.content, /IgnoreNew/);
  assert.match(windows.content, /&quot;/);
  assert.equal(mac.id, windows.id);
  assert.notEqual(mac.id, servicePlan({ ...options, root: '/other', platform: 'darwin' }).id);
  assert.throws(() => servicePlan({ ...options, root: '/bad\npath', platform: 'linux' }), /INVALID_SERVICE_PATH/);
  assert.throws(() => servicePlan({ ...options, platform: 'win32', keepAwake: true }), /KEEP_AWAKE_MAC_ONLY/);
  assert.throws(() => servicePlan({ ...options, platform: 'linux', backupDays: 91 }), /INVALID_BACKUP/);
  assert.equal(winQuote('C:\\中文 space\\'), '"C:\\中文 space\\\\"');
});

test('HOST-02: hosted settings do not edit credentials or original development configuration', t => {
  const root = temp(t);
  const original = 'NODE_ENV=development\nAPP_ORIGIN=http://localhost:5183\nEMBED_WORKER=0\nSESSION_SECRET=synthetic-only\nPORT=8899\n';
  writeFileSync(join(root, '.env'), original);
  const env = loadEnvironment(root, {}, parse);
  const effective = hostedEnvironment(env);
  assert.equal(effective.APP_ORIGIN, 'http://localhost:8899');
  assert.equal(effective.NODE_ENV, 'production');
  assert.equal(effective.EMBED_WORKER, '1');
  assert.equal(effective.SESSION_SECRET, 'synthetic-only');
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), original);
  assert.throws(() => hostedEnvironment({ PORT: '0' }), /INVALID_PORT/);
});

test('HOST-03: setup is idempotent and preserves existing configuration bytes', t => {
  const root = temp(t);
  writeFileSync(join(root, '.env.example'), readFileSync('.env.example'));
  const script = resolve('scripts/setup.mjs');
  const run = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(run().status, 0);
  const original = readFileSync(join(root, '.env'), 'utf8');
  assert.match(original, /DEEPSEEK_API_KEY=/);
  assert.doesNotMatch(original, /NODE_ENV=|AUTH_MODE=|HOST=127|EMBED_WORKER=|YOUTUBE_PROXY_URL=/);
  assert.match(original, /SESSION_SECRET=[a-f0-9]{96}/);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), original);
});

test('HOST-04: logs are bounded and backups retain only owned daily snapshots', async t => {
  const root = temp(t);
  const logfile = join(root, 'logs', 'service.log');
  const log = rotatingLog(logfile, 32, 2);
  log('x'.repeat(180));
  assert.ok(statSync(logfile).size <= 32);
  assert.deepEqual(readdirSync(join(root, 'logs')).sort(), ['service.log', 'service.log.1', 'service.log.2']);
  const db = new DatabaseSync(join(root, 'feedrelay.sqlite'));
  // Release SQLite handles before temp() removes the directory; Windows locks open files.
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE example(value TEXT); INSERT INTO example VALUES (\'synthetic\');');
    const backups = join(root, 'backups');
    assert.equal(await dailyBackup(root, backups, 7, new Date('2026-10-01T10:00:00Z')), true);
    assert.equal(await dailyBackup(root, backups, 7, new Date('2026-10-01T11:00:00Z')), false);
    writeFileSync(join(backups, 'manual.sqlite'), 'keep');
    writeFileSync(join(backups, 'auto-invalid.sqlite'), 'keep');
    await dailyBackup(root, backups, 7, new Date('2026-10-09T10:00:00Z'));
    assert.equal(existsSync(join(backups, 'auto-2026-10-01.sqlite')), false);
    assert.equal(existsSync(join(backups, 'manual.sqlite')), true);
    const saved = new DatabaseSync(join(backups, 'auto-2026-10-09.sqlite'), { readOnly: true });
    try {
      assert.equal(saved.prepare('SELECT value FROM example').get().value, 'synthetic');
    } finally { saved.close(); }
  } finally { db.close(); }
});

test('HOST-05: real built server runs from a spaced path and gracefully stops through IPC', { timeout: 30_000 }, async t => {
  const root = temp(t, false);
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  mkdirSync(join(root, 'dist', 'server'), { recursive: true });
  writeFileSync(join(root, 'dist', 'server', 'main.js'), `import(${JSON.stringify(pathToFileURL(resolve('dist/server/main.js')).href)});`);
  writeFileSync(join(root, '.env'), `SESSION_SECRET=${'synthetic-test-'.repeat(4)}\nPORT=${port}\n`);
  const dir = join(root, '.cache', 'service');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ root, backupDays: 0, keepAwake: false }));
  const child = spawn(process.execPath, [resolve('scripts/service-host.mjs'), file], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP }, stdio: 'pipe',
  });
  let stopped = false, output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => { stopped = true; resolve(code); }));
  t.after(async () => { if (!stopped) child.kill(); await exited; rmSync(root, { recursive: true, force: true }); });
  let status;
  for (let n = 0; n < 100; n++) {
    try {
      const result = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, { signal: AbortSignal.timeout(500) });
      if (result.ok) { status = await result.json(); break; }
    } catch { /* Starting. */ }
    if (stopped) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(status, output + (existsSync(join(dir, 'service.log')) ? readFileSync(join(dir, 'service.log'), 'utf8') : ''));
  assert.equal(status.worker.running, true);
  writeFileSync(join(dir, 'stop'), 'stop');
  assert.equal(await exited, 0);
  assert.equal(existsSync(join(dir, 'host.pid')), false);
  assert.equal(existsSync(join(root, 'data', 'web.pid')), false);
  assert.equal(existsSync(join(root, 'data', 'worker.pid')), false);
});
