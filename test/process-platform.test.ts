import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isolatedPythonEnvironment, terminateProcessTree } from '../server/process-platform.js';

test('HOST-09: Python environment preserves required Windows paths but never inherits credentials/proxies', () => {
  const env = { SystemRoot: 'C:\\Windows', DEEPSEEK_API_KEY: 'never-inherit', HTTPS_PROXY: 'never-inherit' };
  const windows = isolatedPythonEnvironment('C:\\临时 space', 'C:\\tools space\\python.exe', 'win32', env, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(windows.PATH, 'C:\\Program Files\\nodejs;C:\\tools space;C:\\Windows\\System32;C:\\Windows');
  assert.equal(windows.TEMP, 'C:\\临时 space');
  assert.equal(windows.SystemRoot, 'C:\\Windows');
  assert.doesNotMatch(JSON.stringify(windows), /never-inherit/);
  const unix = isolatedPythonEnvironment('/tmp/private', '/usr/bin/python3', 'linux', env, '/opt/node/bin/node');
  assert.equal(unix.PATH, '/opt/node/bin:/usr/bin:/bin');
  assert.doesNotMatch(JSON.stringify(unix), /never-inherit/);
});

test('HOST-10: cancellation terminates an isolated child on the current platform', { timeout: 10_000 }, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore' });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');
  terminateProcessTree(child);
  await closed;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
