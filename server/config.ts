import 'dotenv/config';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DateTime } from 'luxon';

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
export function readConfig(env = process.env, fileExists = existsSync) {
  const demo = env.FEEDRELAY_DEMO === '1';
  const production = env.NODE_ENV ? env.NODE_ENV === 'production' : !demo;
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AppError('INVALID_PORT');
  const authMode = env.AUTH_MODE || (demo ? 'password' : 'local');
  if (!['local', 'password'].includes(authMode)) throw new AppError('INVALID_AUTH_MODE');
  const pushChannel = env.PUSH_CHANNEL || 'weixin';
  if (!['feishu', 'weixin'].includes(pushChannel)) throw new AppError('INVALID_PUSH_CHANNEL');
  const origin = new URL(
    env.APP_ORIGIN ||
      (production ? `http://localhost:${port}` : 'http://localhost:5183'),
  ).origin;
  if (!/^https?:\/\//.test(origin)) throw new AppError('INVALID_APP_ORIGIN');
  if (demo && env.HOST && !['127.0.0.1', 'localhost'].includes(env.HOST))
    throw new AppError('DEMO_LOOPBACK_ONLY');
  const model = env.DEEPSEEK_MODEL || 'deepseek-flash';
  // Conservative peak/cache-miss estimate, verified 2026-10-20; not a provider bill.
  const defaultPrices = model === 'deepseek-flash' ? [2, 8] : [0, 0];
  const defaultPython = resolve('.cache/youtube-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = env.YOUTUBE_CAPTIONS_PYTHON
    ? resolve(env.YOUTUBE_CAPTIONS_PYTHON)
    : !demo && fileExists(defaultPython) ? defaultPython : '';
  const config = {
    demo,
    authMode: authMode as 'local' | 'password',
    production,
    origin,
    host: env.HOST || '127.0.0.1',
    port,
    dataDir: resolve(env.DATA_DIR || (demo ? 'data-demo' : 'data')),
    passwordHash: demo ? hashPassword('demo') : env.ADMIN_PASSWORD_HASH || '',
    sessionSecret: demo
      ? 'feedrelay-local-demo-session-not-for-production'
      : env.SESSION_SECRET || '',
    cookieSecure: enabled(env.COOKIE_SECURE, origin.startsWith('https://')),
    embedWorker: demo || enabled(env.EMBED_WORKER, true),
    pushChannel: (demo ? 'feishu' : pushChannel) as 'feishu' | 'weixin',
    youtubeProxy: httpProxy(env.YOUTUBE_PROXY_URL || '', 'INVALID_YOUTUBE_PROXY'),
    imap: {
      enabled: enabled(env.IMAP_ENABLED, !!(env.IMAP_HOST || env.IMAP_USER || env.IMAP_PASSWORD)),
      host: env.IMAP_HOST || '',
      port: Number(env.IMAP_PORT || 993),
      user: env.IMAP_USER || '',
      password: env.IMAP_PASSWORD || '',
      folder: env.IMAP_FOLDER || 'INBOX',
    },
    feishu: {
      enabled: enabled(env.FEISHU_ENABLED, pushChannel === 'feishu' && !!(env.FEISHU_APP_ID || env.FEISHU_APP_SECRET || env.FEISHU_OPEN_ID)),
      appId: env.FEISHU_APP_ID || '',
      secret: env.FEISHU_APP_SECRET || '',
      openId: env.FEISHU_OPEN_ID || '',
    },
    deepseek: {
      enabled: enabled(env.DEEPSEEK_ENABLED, !!env.DEEPSEEK_API_KEY),
      apiKey: env.DEEPSEEK_API_KEY || '',
      model,
      inputPrice: Number(env.DEEPSEEK_INPUT_CNY_PER_MILLION || defaultPrices[0]),
      outputPrice: Number(env.DEEPSEEK_OUTPUT_CNY_PER_MILLION || defaultPrices[1]),
    },
    captions: {
      enabled: enabled(env.YOUTUBE_CAPTIONS_ENABLED, !!python),
      python,
      proxy: httpProxy(env.YOUTUBE_CAPTIONS_PROXY_URL ?? env.YOUTUBE_PROXY_URL ?? '', 'INVALID_YOUTUBE_CAPTIONS_PROXY'),
      asr: env.YOUTUBE_ASR_ENABLED === '1',
      model: resolve(env.YOUTUBE_ASR_MODEL || '.cache/asr-model'),
    },
  };
  if (!['feishu', 'weixin'].includes(config.pushChannel))
    throw new AppError('INVALID_PUSH_CHANNEL');
  if (!demo && config.captions.enabled && !config.captions.python)
    throw new AppError('INVALID_YOUTUBE_CAPTIONS_CONFIG');
  if (
    !demo &&
    config.deepseek.enabled &&
    (!config.deepseek.apiKey ||
      !/^[a-zA-Z0-9._-]{1,80}$/.test(config.deepseek.model) ||
      ![config.deepseek.inputPrice, config.deepseek.outputPrice].every(
        (n) => Number.isFinite(n) && n > 0 && n <= 10000,
      ))
  )
    throw new AppError('INVALID_DEEPSEEK_CONFIG');
  if (!demo && ((config.authMode === 'password' && !verifyHash(config.passwordHash)) || config.sessionSecret.length < 32))
    throw new AppError('RUN_NPM_SETUP_FIRST');
  if (config.authMode === 'local' && (
    !['127.0.0.1', '::1'].includes(config.host) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.origin).hostname)
  )) throw new AppError('LOCAL_ACCESS_LOOPBACK_ONLY');
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
    !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.origin).hostname) &&
    (!config.cookieSecure || !config.origin.startsWith('https://'))
  )
    throw new AppError('PUBLIC_HTTPS_REQUIRED');
  return config;
}
const verifyHash = (hash: string) => /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash);
const enabled = (value: string | undefined, fallback: boolean) => value ? value === '1' : fallback;
function httpProxy(value: string, code: string) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new AppError(code);
  }
}
export type Config = ReturnType<typeof readConfig>;
export const defaults = {
  timezone: 'Asia/Shanghai',
  youtubeMinutes: 15,
  mailMinutes: 5,
  dailyLimit: 50,
  mailDays: 7,
  itemDays: 30,
  digestTime: '10:30',
};
export type Settings = typeof defaults;
export function validateSettings(input: Settings) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.digestTime))
    throw new AppError('INVALID_DIGEST_TIME');
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
    if (!DateTime.now().setZone(input.timezone).isValid) throw new Error('INVALID_TIMEZONE');
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
