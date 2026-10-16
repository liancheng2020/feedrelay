import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, scryptSync } from 'node:crypto';

const password = randomBytes(15).toString('base64url');
const salt = randomBytes(16).toString('hex');
const hash = `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const template = await readFile('.env.example', 'utf8');
const env = template
  .replace('ADMIN_PASSWORD_HASH=', `ADMIN_PASSWORD_HASH=${hash}`)
  .replace('SESSION_SECRET=', `SESSION_SECRET=${randomBytes(48).toString('hex')}`);
await writeFile('.env', env, { flag: 'wx', mode: 0o600 });
console.log(
  `Created .env. Your administrator password (shown once): ${password}\nKeep it private. Mail and Feishu remain disabled until configured.\nDevelopment: set APP_ORIGIN=http://localhost:5183 and EMBED_WORKER=1 in .env.`,
);
