import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readConfig } from '../server/config.js';

const base = { SESSION_SECRET: 'synthetic-config-secret-'.repeat(3) };
const noFiles = () => false;

test('ENV-01: minimal configuration is local, production-ready and includes the worker', () => {
  const config = readConfig(base, noFiles);
  assert.equal(config.production, true);
  assert.equal(config.authMode, 'local');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.origin, 'http://localhost:8787');
  assert.equal(config.embedWorker, true);
  assert.equal(config.pushChannel, 'weixin');
  assert.equal(config.cookieSecure, false);
  assert.equal(config.deepseek.enabled, false);
  assert.equal(config.imap.enabled, false);
  assert.equal(config.feishu.enabled, false);
  assert.equal(readConfig({ ...base, PORT: '8899' }, noFiles).origin, 'http://localhost:8899');
  assert.throws(() => readConfig({ ...base, PORT: 'invalid' }, noFiles), /INVALID_PORT/);
  assert.throws(() => readConfig({}, noFiles), /RUN_NPM_SETUP_FIRST/);
});

test('ENV-02: explicit legacy settings keep priority over inferred defaults', () => {
  const config = readConfig({ ...base, NODE_ENV: 'development', APP_ORIGIN: 'http://127.0.0.1:5183',
    EMBED_WORKER: '0', PUSH_CHANNEL: 'feishu', COOKIE_SECURE: '0', DATA_DIR: 'custom-data' }, noFiles);
  assert.equal(config.production, false);
  assert.equal(config.origin, 'http://127.0.0.1:5183');
  assert.equal(config.embedWorker, false);
  assert.equal(config.pushChannel, 'feishu');
  assert.equal(config.dataDir, resolve('custom-data'));
  assert.equal(readConfig({ ...base, NODE_ENV: 'development' }, noFiles).origin, 'http://localhost:5183');
  assert.throws(() => readConfig({ ...base, HOST: '0.0.0.0' }, noFiles), /LOCAL_ACCESS_LOOPBACK_ONLY/);
});

test('ENV-03: a key enables the default model, explicit disable and custom prices remain effective', () => {
  const env = { ...base, DEEPSEEK_API_KEY: 'synthetic-key' };
  const config = readConfig(env, noFiles);
  assert.equal(config.deepseek.enabled, true);
  assert.equal(config.deepseek.model, 'deepseek-flash');
  assert.equal(config.deepseek.inputPrice, 2);
  assert.equal(config.deepseek.outputPrice, 8);
  assert.equal(readConfig({ ...env, DEEPSEEK_ENABLED: '0' }, noFiles).deepseek.enabled, false);
  assert.throws(() => readConfig({ ...env, DEEPSEEK_MODEL: 'custom-model' }, noFiles), /INVALID_DEEPSEEK_CONFIG/);
  const custom = readConfig({ ...env, DEEPSEEK_MODEL: 'custom-model',
    DEEPSEEK_INPUT_CNY_PER_MILLION: '3', DEEPSEEK_OUTPUT_CNY_PER_MILLION: '9' }, noFiles);
  assert.equal(custom.deepseek.inputPrice, 3);
  assert.equal(custom.deepseek.outputPrice, 9);
  assert.throws(() => readConfig({ ...env, DEEPSEEK_INPUT_CNY_PER_MILLION: '0' }, noFiles), /INVALID_DEEPSEEK_CONFIG/);
});

test('ENV-04: mailbox credentials infer enablement but incomplete or disabled configs stay safe', () => {
  const env = { ...base, IMAP_HOST: 'imap.example.com', IMAP_USER: 'test@example.com', IMAP_PASSWORD: 'synthetic-code' };
  const config = readConfig(env, noFiles);
  assert.equal(config.imap.enabled, true);
  assert.equal(config.imap.port, 993);
  assert.equal(config.imap.folder, 'INBOX');
  assert.equal(readConfig({ ...env, IMAP_ENABLED: '0' }, noFiles).imap.enabled, false);
  assert.throws(() => readConfig({ ...base, IMAP_USER: env.IMAP_USER }, noFiles), /INVALID_IMAP_CONFIG/);
  assert.equal(readConfig({ ...base, IMAP_ENABLED: '0', IMAP_USER: env.IMAP_USER }, noFiles).imap.enabled, false);
});

test('ENV-05: Feishu credentials are enabled only for the selected channel', () => {
  const env = { ...base, FEISHU_APP_ID: 'cli_synthetic', FEISHU_APP_SECRET: 'synthetic', FEISHU_OPEN_ID: 'ou_synthetic' };
  assert.equal(readConfig(env, noFiles).feishu.enabled, false);
  assert.equal(readConfig({ ...env, PUSH_CHANNEL: 'feishu' }, noFiles).feishu.enabled, true);
  assert.equal(readConfig({ ...env, PUSH_CHANNEL: 'feishu', FEISHU_ENABLED: '0' }, noFiles).feishu.enabled, false);
});

test('ENV-06: standard video environment is discovered without enabling audio transcription', () => {
  const expected = resolve('.cache/youtube-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const installed = (path: Parameters<typeof import('node:fs').existsSync>[0]) => String(path) === expected;
  const config = readConfig(base, installed);
  assert.equal(config.captions.enabled, true);
  assert.equal(config.captions.python, expected);
  assert.equal(config.captions.asr, false);
  assert.equal(readConfig(base, noFiles).captions.enabled, false);
  assert.equal(readConfig({ FEEDRELAY_DEMO: '1' }, installed).captions.enabled, false);
  assert.equal(readConfig({ ...base, YOUTUBE_CAPTIONS_ENABLED: '0' }, installed).captions.enabled, false);
  assert.equal(readConfig({ ...base, YOUTUBE_CAPTIONS_PYTHON: 'custom/python' }, noFiles).captions.python, resolve('custom/python'));
  assert.throws(() => readConfig({ ...base, YOUTUBE_CAPTIONS_ENABLED: '1' }, noFiles), /INVALID_YOUTUBE_CAPTIONS_CONFIG/);
});

test('ENV-07: one optional proxy covers video requests while explicit caption overrides survive', () => {
  const env = { ...base, YOUTUBE_PROXY_URL: 'http://127.0.0.1:1087' };
  const config = readConfig(env, noFiles);
  assert.equal(config.youtubeProxy, env.YOUTUBE_PROXY_URL);
  assert.equal(config.captions.proxy, env.YOUTUBE_PROXY_URL);
  assert.equal(readConfig({ ...env, YOUTUBE_CAPTIONS_PROXY_URL: '' }, noFiles).captions.proxy, '');
  assert.equal(readConfig({ ...env, YOUTUBE_CAPTIONS_PROXY_URL: 'http://127.0.0.1:1088' }, noFiles).captions.proxy, 'http://127.0.0.1:1088');
  assert.equal(readConfig(base, noFiles).youtubeProxy, '');
  assert.equal(readConfig(base, noFiles).captions.proxy, '');
});
