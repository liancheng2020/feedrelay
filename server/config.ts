import 'dotenv/config';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';

export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public retryable = false,
    public retryAfter = 0,
  ) {
    super(code);
  }
}
export const preview = (s: string, length = 400) => Array.from(s).slice(0, length).join('');
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, hash: string) {
  const [kind, salt, encoded] = hash.split(':');
  if (
    kind !== 'scrypt' ||
    !/^[a-f0-9]{32}$/.test(salt || '') ||
    !/^[a-f0-9]{128}$/.test(encoded || '')
  )
    return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(encoded, 'hex'));
}
export function readConfig(env = process.env) {
  const demo = env.FEEDRELAY_DEMO === '1';
  const origin = new URL(
    env.APP_ORIGIN ||
      (env.NODE_ENV === 'production' ? 'http://localhost:8787' : 'http://localhost:5183'),
  ).origin;
  if (!/^https?:\/\//.test(origin)) throw new AppError('INVALID_APP_ORIGIN');
  if (demo && env.HOST && !['127.0.0.1', 'localhost'].includes(env.HOST))
    throw new AppError('DEMO_LOOPBACK_ONLY');
  const config = {
    demo,
    production: env.NODE_ENV === 'production',
    origin,
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8787),
    dataDir: resolve(env.DATA_DIR || (demo ? 'data-demo' : 'data')),
    passwordHash: demo ? hashPassword('demo') : env.ADMIN_PASSWORD_HASH || '',
    sessionSecret: demo
      ? 'feedrelay-local-demo-session-not-for-production'
      : env.SESSION_SECRET || '',
    cookieSecure: env.COOKIE_SECURE === '1',
    embedWorker: demo || env.EMBED_WORKER === '1',
    imap: {
      enabled: env.IMAP_ENABLED === '1',
      host: env.IMAP_HOST || '',
      port: Number(env.IMAP_PORT || 993),
      user: env.IMAP_USER || '',
      password: env.IMAP_PASSWORD || '',
      folder: env.IMAP_FOLDER || 'INBOX',
    },
    feishu: {
      enabled: env.FEISHU_ENABLED === '1',
      appId: env.FEISHU_APP_ID || '',
      secret: env.FEISHU_APP_SECRET || '',
      openId: env.FEISHU_OPEN_ID || '',
    },
  };
  if (!demo && (!verifyHash(config.passwordHash) || config.sessionSecret.length < 32))
    throw new AppError('RUN_NPM_SETUP_FIRST');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new AppError('INVALID_PORT');
  if (
    config.imap.enabled &&
    (!config.imap.host || !config.imap.user || !config.imap.password || config.imap.port !== 993)
  )
    throw new AppError('INVALID_IMAP_CONFIG');
  if (
    config.feishu.enabled &&
    (!/^cli_[a-zA-Z0-9]+$/.test(config.feishu.appId) ||
      !config.feishu.secret ||
      !/^ou_[a-zA-Z0-9_-]+$/.test(config.feishu.openId))
  )
    throw new AppError('INVALID_FEISHU_CONFIG');
  if (
    config.production &&
    !['127.0.0.1', 'localhost'].includes(new URL(config.origin).hostname) &&
    (!config.cookieSecure || !config.origin.startsWith('https://'))
  )
    throw new AppError('PUBLIC_HTTPS_REQUIRED');
  return config;
}
const verifyHash = (hash: string) => /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash);
export type Config = ReturnType<typeof readConfig>;
export const defaults = {
  timezone: 'Asia/Shanghai',
  youtubeMinutes: 15,
  mailMinutes: 5,
  dailyLimit: 50,
  mailDays: 7,
  itemDays: 30,
};
export type Settings = typeof defaults;
export function validateSettings(input: Settings) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
  } catch {
    throw new AppError('INVALID_TIMEZONE');
  }
  for (const [key, min, max] of [
    ['youtubeMinutes', 5, 1440],
    ['mailMinutes', 5, 1440],
    ['dailyLimit', 1, 500],
    ['mailDays', 1, 30],
    ['itemDays', 1, 90],
  ] as const) {
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max)
      throw new AppError('INVALID_SETTINGS');
  }
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, input[key as keyof Settings]]),
  ) as Settings;
}
export function dayKey(now: number, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
