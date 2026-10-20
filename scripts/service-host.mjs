import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'dotenv';
import { hostedEnvironment, loadEnvironment, rotatingLog, paths } from './hosting.mjs';
import { dailyBackup } from './maintenance.mjs';

const configFile = resolve(process.argv[2]);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const dir = dirname(configFile);
const pidFile = join(dir, 'host.pid');
const stopFile = join(dir, 'stop');
mkdirSync(dir, { recursive: true, mode: 0o700 });
if (existsSync(stopFile)) process.exit(0);
if (existsSync(pidFile)) {
  const old = Number(readFileSync(pidFile, 'utf8'));
  try { process.kill(old, 0); throw new Error('HOST_ALREADY_RUNNING'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  unlinkSync(pidFile);
}
writeFileSync(pidFile, String(process.pid), { flag: 'wx', mode: 0o600 });
process.chdir(config.root);
const log = rotatingLog(join(dir, 'service.log'));
const env = hostedEnvironment(loadEnvironment(config.root, process.env, parse));
env.PATH = `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${env.PATH || ''}`;
const { entry, data } = paths(config.root, env);
let stopping = false, backupTask;
const child = spawn(process.execPath, [entry], { cwd: config.root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
child.stdout.on('data', log);
child.stderr.on('data', log);
let awake;
if (config.keepAwake && process.platform === 'darwin') {
  awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  awake.on('error', () => log('KEEP_AWAKE_FAILED\n'));
}
const stop = () => {
  if (stopping) return;
  stopping = true;
  // IPC provides the same graceful shutdown on Windows, where SIGTERM is forceful.
  if (child.connected) child.send('feedrelay:stop', () => {});
  else child.kill();
};
const poll = setInterval(() => { if (existsSync(stopFile)) stop(); }, 500);
const backUp = () => {
  if (stopping || backupTask || !config.backupDays || !existsSync(join(data, 'feedrelay.sqlite'))) return;
  backupTask = dailyBackup(data, join(data, 'backups', 'automatic'), config.backupDays)
    .then(saved => { if (saved) log('AUTOMATIC_BACKUP_SAVED\n'); })
    .catch(() => log('AUTOMATIC_BACKUP_FAILED\n'))
    .finally(() => { backupTask = undefined; });
};
const backupTimer = setInterval(backUp, 60 * 60_000);
const firstBackup = setTimeout(backUp, 30_000);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('error', () => log('SERVICE_CHILD_START_FAILED\n'));
child.on('close', async code => {
  clearInterval(poll); clearInterval(backupTimer); clearTimeout(firstBackup);
  await backupTask;
  awake?.kill();
  if (existsSync(pidFile) && readFileSync(pidFile, 'utf8') === String(process.pid)) unlinkSync(pidFile);
  process.exitCode = stopping ? 0 : (code || 1);
});
