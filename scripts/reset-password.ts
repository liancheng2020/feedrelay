import { randomBytes } from 'node:crypto';
import { readConfig } from '../server/config.js';
import { Store } from '../server/store.js';
import { AdminAuth } from '../server/auth.js';

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在本机交互终端运行，避免密码进入日志。');
const config = readConfig();
const store = new Store(config.dataDir, config.demo ? 'demo' : 'live');
try {
  const password = randomBytes(12).toString('base64url');
  new AdminAuth(store, config).setPassword(password);
  store.run("DELETE FROM events WHERE action='login_failed'");
  console.log(`管理密码已重置，所有登录已失效。新密码仅显示一次：\n${password}`);
} finally {
  store.close();
}
