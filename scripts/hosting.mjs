import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const line = value => {
  if (/[\r\n\0]/.test(value)) throw new Error('INVALID_SERVICE_PATH');
  return value;
};
const unitQuote = value => '"' + line(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => '$$') + '"';
export const winQuote = value => '"' + line(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

export function servicePlan({ root, node = process.execPath, platform = process.platform, home = homedir(), uid = process.getuid?.(), user = '', keepAwake = false, backupDays = 0 }) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error('UNSUPPORTED_PLATFORM');
  if (keepAwake && platform !== 'darwin') throw new Error('KEEP_AWAKE_MAC_ONLY');
  if (!Number.isInteger(backupDays) || backupDays < 0 || backupDays > 90) throw new Error('INVALID_BACKUP_DAYS');
  root = line(root); node = line(node);
  const id = `feedrelay-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  const dir = join(root, '.cache', 'service');
  const runner = join(root, 'scripts', 'service-host.mjs');
  const config = join(dir, 'config.json');
  const args = [runner, config];
  const common = { id, root, node, dir, config, platform, keepAwake, backupDays };
  if (platform === 'darwin') {
    const label = `io.feedrelay.${id}`;
    const path = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    return { ...common, name: label, target: `gui/${uid}/${label}`, domain: `gui/${uid}`, path,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${[node, ...args].map(v => `<string>${xml(v)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>90</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>\n` };
  }
  if (platform === 'linux') {
    const name = `${id}.service`;
    return { ...common, name, path: join(home, '.config', 'systemd', 'user', name),
      content: `[Unit]\nDescription=FeedRelay personal subscription service\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nWorkingDirectory=${unitQuote(root).replace(/\$\$/g, '$')}\nExecStart=${[node, ...args].map(unitQuote).join(' ')}\nRestart=always\nRestartSec=30\nTimeoutStopSec=90\nKillMode=mixed\nUMask=0077\n\n[Install]\nWantedBy=default.target\n` };
  }
  const name = id;
  return { ...common, name, path: join(dir, 'task.xml'),
    content: `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(args.map(winQuote).join(' '))}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions>
</Task>\n` };
}

export function loadEnvironment(root, env, parse) {
  const path = join(root, '.env');
  return { ...(existsSync(path) ? parse(readFileSync(path)) : {}), ...env };
}

export function hostedEnvironment(env) {
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  return { ...env, NODE_ENV: 'production', FEEDRELAY_DEMO: '0', AUTH_MODE: 'local', HOST: '127.0.0.1',
    APP_ORIGIN: `http://localhost:${port}`, EMBED_WORKER: '1', COOKIE_SECURE: '0' };
}

// Only rotate this service's own logs. Each write is bounded even for a noisy child.
export function rotatingLog(path, maxBytes = 5 * 1024 * 1024, copies = 3) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let size = existsSync(path) ? statSync(path).size : 0;
  return chunk => {
    const buffer = Buffer.from(chunk);
    for (let offset = 0; offset < buffer.length; offset += maxBytes) {
      const part = buffer.subarray(offset, offset + maxBytes);
      if (size + part.length > maxBytes) {
        if (existsSync(`${path}.${copies}`)) unlinkSync(`${path}.${copies}`);
        for (let n = copies - 1; n >= 1; n--)
          if (existsSync(`${path}.${n}`)) renameSync(`${path}.${n}`, `${path}.${n + 1}`);
        if (existsSync(path)) renameSync(path, `${path}.1`);
        size = 0;
      }
      appendFileSync(path, part, { mode: 0o600 });
      size += part.length;
    }
  };
}

export function writePrivate(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

export function paths(root, env) {
  return { data: resolve(root, env.DATA_DIR || 'data'), entry: join(root, 'dist', 'server', 'main.js') };
}
