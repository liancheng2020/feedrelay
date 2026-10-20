import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import { servicePlan, hostedEnvironment, loadEnvironment, writePrivate, paths } from './hosting.mjs';

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const run = (command, args) => execFileSync(command, args, { stdio: 'pipe', windowsHide: true, timeout: 120_000 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const command = process.argv[2] || 'status';
const flags = process.argv.slice(3);

try {
  if (!['install', 'start', 'stop', 'restart', 'status', 'uninstall', 'plan'].includes(command) || flags.some(f => f !== '--keep-awake' && !/^--backup-days=\d+$/.test(f)))
    throw new Error('USAGE: npm run service -- install|start|stop|restart|status|uninstall|plan [--keep-awake] [--backup-days=7]');
  if (flags.length && !['install', 'plan'].includes(command)) throw new Error('FLAGS_REQUIRE_INSTALL_OR_PLAN');
  const user = process.platform === 'win32' ? run('whoami.exe', []).toString().trim() : '';
  let plan = servicePlan({ root, user, keepAwake: flags.includes('--keep-awake'), backupDays: Number(flags.find(f => f.startsWith('--backup-days='))?.split('=')[1] || 0) });
  const saved = existsSync(plan.config) ? JSON.parse(readFileSync(plan.config, 'utf8')) : null;
  if (saved && saved.root !== root) throw new Error('SERVICE_ROOT_CHANGED_REINSTALL');
  if (saved && !['install', 'plan'].includes(command)) plan = servicePlan({ ...saved, user });
  const installed = existsSync(plan.path);
  if (command === 'plan') {
    console.log(plan.content);
    console.log(`仅预览，不安装。防休眠=${plan.keepAwake}；自动备份保留=${plan.backupDays}天。`);
    process.exit(0);
  }
  if (command === 'status') {
    console.log(`平台=${process.platform}；定义=${installed ? '已安装' : '未安装'}；名称=${plan.name}`);
    if (installed) {
      const args = process.platform === 'darwin' ? ['print', plan.target] : process.platform === 'linux' ? ['--user', 'is-active', plan.name] : ['/Query', '/TN', plan.name, '/FO', 'LIST'];
      const tool = process.platform === 'darwin' ? 'launchctl' : process.platform === 'linux' ? 'systemctl' : 'schtasks.exe';
      try { console.log(run(tool, args).toString()); } catch { console.log('系统服务未运行或当前登录会话不可访问。'); }
    }
    console.log('运行 npm run doctor 检查应用和后台状态。');
    process.exit(0);
  }
  if (command !== 'install' && !saved) throw new Error('SERVICE_NOT_INSTALLED');
  const stop = async () => {
    writePrivate(join(plan.dir, 'stop'), 'stop');
    const pidFile = join(plan.dir, 'host.pid');
    for (let n = 0; n < 160 && existsSync(pidFile) && alive(Number(readFileSync(pidFile, 'utf8'))); n++) await sleep(500);
    if (process.platform === 'darwin') {
      let loaded = false;
      try { run('launchctl', ['print', plan.target]); loaded = true; } catch { /* Not loaded. */ }
      if (loaded) run('launchctl', ['bootout', plan.target]);
    } else if (process.platform === 'linux') run('systemctl', ['--user', 'stop', plan.name]);
    else {
      try { run('schtasks.exe', ['/End', '/TN', plan.name]); } catch { /* Already stopped. */ }
    }
    if (existsSync(pidFile) && alive(Number(readFileSync(pidFile, 'utf8')))) throw new Error('SERVICE_STOP_TIMEOUT');
  };
  if (['stop', 'restart', 'uninstall'].includes(command)) await stop();
  if (command === 'uninstall') {
    if (process.platform === 'linux') run('systemctl', ['--user', 'disable', plan.name]);
    if (process.platform === 'win32') run('schtasks.exe', ['/Delete', '/TN', plan.name, '/F']);
    if (installed) unlinkSync(plan.path);
    if (existsSync(plan.config)) unlinkSync(plan.config);
    if (process.platform === 'linux') run('systemctl', ['--user', 'daemon-reload']);
    console.log('已卸载托管；配置、数据、日志和备份均保留。');
  } else if (command === 'stop') {
    console.log('托管已停止，未修改配置与数据。');
  } else {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('NODE_24_REQUIRED');
    const env = hostedEnvironment(loadEnvironment(root, process.env, parse));
    const { data, entry } = paths(root, env);
    if (!existsSync(join(root, '.env')) || !existsSync(entry)) throw new Error('RUN_SETUP_AND_BUILD_FIRST');
    const { readConfig } = await import(pathToFileURL(join(root, 'dist', 'server', 'config.js')).href);
    readConfig(env);
    for (const role of ['web', 'worker']) {
      const file = join(data, `${role}.pid`);
      if (existsSync(file) && alive(Number(readFileSync(file, 'utf8')))) throw new Error('EXISTING_PROCESS_STOP_IT_FIRST');
    }
    // Fail before registering a restart loop when another application owns the port.
    const { createServer } = await import('node:net');
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new Error('PORT_IN_USE')));
      probe.listen(Number(env.PORT || 8787), '127.0.0.1', () => probe.close(resolve));
    });
    if (existsSync(join(plan.dir, 'stop'))) unlinkSync(join(plan.dir, 'stop'));
    if (command === 'install') {
      if (saved) throw new Error('SERVICE_ALREADY_INSTALLED_UNINSTALL_FIRST');
      if (installed) throw new Error('SERVICE_DEFINITION_EXISTS');
      if (process.platform === 'darwin') run('launchctl', ['print', plan.domain]);
      else if (process.platform === 'linux') run('systemctl', ['--user', 'show-environment']);
      writePrivate(plan.config, JSON.stringify({ root, node: process.execPath, keepAwake: plan.keepAwake, backupDays: plan.backupDays }));
      writePrivate(plan.path, plan.content);
      try {
        if (process.platform === 'linux') {
          run('systemctl', ['--user', 'daemon-reload']);
          run('systemctl', ['--user', 'enable', plan.name]);
        } else if (process.platform === 'win32') run('schtasks.exe', ['/Create', '/TN', plan.name, '/XML', plan.path]);
      } catch (error) {
        unlinkSync(plan.path); unlinkSync(plan.config);
        throw error;
      }
    }
    if (process.platform === 'darwin') {
      let loaded = false;
      try { run('launchctl', ['print', plan.target]); loaded = true; } catch { /* Not loaded. */ }
      run('launchctl', loaded ? ['kickstart', plan.target] : ['bootstrap', plan.domain, plan.path]);
    }
    else if (process.platform === 'linux') run('systemctl', ['--user', 'start', plan.name]);
    else run('schtasks.exe', ['/Run', '/TN', plan.name]);
    let ready = false;
    for (let n = 0; n < 30 && !ready; n++) {
      await sleep(1000);
      try {
        const r = await fetch(`http://127.0.0.1:${env.PORT || 8787}/api/diagnostics`, { signal: AbortSignal.timeout(1000) });
        ready = r.ok && (await r.json()).worker?.running === true;
      } catch { /* Wait for startup. */ }
    }
    if (!ready) throw new Error('SERVICE_NOT_READY_RUN_DOCTOR_AND_CHECK_LOGS');
    console.log(`托管已启动：http://localhost:${env.PORT || 8787}。登录系统后自动运行；休眠或关机会暂停。`);
  }
} catch (error) {
  // Never dump subprocess output, configuration or credentials on failure.
  console.error(/^[A-Z0-9_: |.=[\]<>-]+$/.test(error.message) ? error.message : 'SERVICE_COMMAND_FAILED: 检查系统托管权限、构建和 npm run doctor。');
  process.exitCode = 1;
}
