import { dirname, join, win32 } from 'node:path';
import { execFile, type ChildProcess } from 'node:child_process';

export function isolatedPythonEnvironment(home: string, python: string, platform = process.platform, environment = process.env, node = process.execPath): Record<string, string> {
  const base = { HOME: home, XDG_CONFIG_HOME: home, TMPDIR: home, LANG: 'en_US.UTF-8', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
  if (platform !== 'win32') return { ...base, PATH: `${dirname(node)}:/usr/bin:/bin` };
  const system = environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows';
  return { ...base, PATH: [win32.dirname(node), win32.dirname(python), win32.join(system, 'System32'), system].join(';'),
    SystemRoot: system, WINDIR: system, USERPROFILE: home, TEMP: home, TMP: home };
}

export function terminateProcessTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    execFile(join(system, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
      if (error) child.kill('SIGKILL');
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
