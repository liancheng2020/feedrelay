import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, scryptSync } from 'node:crypto';

const password = randomBytes(12).toString('base64url');
const salt = randomBytes(16).toString('hex');
const hash = `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const template = await readFile('.env.example', 'utf8');
const env = template
  .replace('ADMIN_PASSWORD_HASH=', `ADMIN_PASSWORD_HASH=${hash}`)
  .replace('SESSION_SECRET=', `SESSION_SECRET=${randomBytes(48).toString('hex')}`);
try {
  await writeFile('.env', env, { flag: 'wx', mode: 0o600 });
  console.log(
  '已创建 .env。本机模式无需登录；配置来源和推送后即可使用。\n启动：npm run build，然后 npm start。后台任务随主服务运行。',
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('已有 .env，已保留原配置。运行 npm run doctor 检查环境。');
}
