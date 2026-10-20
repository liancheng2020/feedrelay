// Explicit opt-in: registers a temporary current-user service with synthetic configuration only.
import { spawn } from 'node:child_process';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { servicePlan } from '../scripts/hosting.mjs';

if (process.env.FEEDRELAY_NATIVE_SERVICE_TEST !== '1') {
  console.error('仅用于隔离系统托管测试。显式设置 FEEDRELAY_NATIVE_SERVICE_TEST=1 后运行。');
  process.exit(1);
}
const root = await mkdtemp(join(tmpdir(), 'feedrelay native '));
const evidence = [];
const portProbe = createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
await cp(resolve('dist'), join(root, 'dist'), { recursive: true });
await mkdir(join(root, 'scripts'));
for (const name of ['service.mjs', 'service-host.mjs', 'hosting.mjs', 'maintenance.mjs'])
  await cp(resolve('scripts', name), join(root, 'scripts', name));
await symlink(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await writeFile(join(root, '.env'), `PORT=${port}\nSESSION_SECRET=${'synthetic-native-check-'.repeat(3)}\nPUSH_CHANNEL=feishu\nIMAP_ENABLED=0\nFEISHU_ENABLED=0\nDEEPSEEK_ENABLED=0\n`, { mode: 0o600 });
const run = command => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'scripts', 'service.mjs'), command], {
    cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP }, stdio: 'pipe', windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${command}: ${output}`)));
});
const healthy = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).worker.running;
  } catch { return false; }
};
let cleaned = false;
try {
  for (const command of ['install', 'status', 'stop', 'start', 'restart']) {
    await run(command);
    assert.equal(await healthy(), command !== 'stop');
    evidence.push(`${command}:pass`);
  }
  const oldPid = Number(await readFile(join(root, 'data', 'web.pid'), 'utf8'));
  process.kill(oldPid, 'SIGKILL');
  let recovered = false;
  for (let n = 0; n < 100; n++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const pid = Number(await readFile(join(root, 'data', 'web.pid'), 'utf8'));
      if (pid !== oldPid && await healthy()) { recovered = true; break; }
    } catch { /* System restart is pending. */ }
  }
  assert.equal(recovered, true);
  evidence.push('crash-recovery:pass');
} finally {
  try { await run('uninstall'); cleaned = true; evidence.push('uninstall:pass'); }
  catch { console.error(`临时托管未能清理，请检查：${servicePlan({ root }).name}，临时目录 ${root}`); }
  if (cleaned) await rm(root, { recursive: true, force: true });
}
const result = { platform: process.platform, at: new Date().toISOString(), evidence, cleaned };
const output = join(tmpdir(), `feedrelay-native-hosting-${Date.now()}.json`);
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, output }));
if (!cleaned) process.exitCode = 1;
