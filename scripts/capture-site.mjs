import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { Store } from '../dist/server/store.js';
import { readConfig } from '../dist/server/config.js';
import { Engine } from '../dist/server/engine.js';
import { seedDemo, demoAdapters } from '../dist/server/demo.js';

const dir = await mkdtemp(join(tmpdir(), 'feedrelay-public-capture-'));
const config = readConfig({ FEEDRELAY_DEMO: '1', DATA_DIR: dir });
const store = new Store(dir, 'demo');
seedDemo(store);
store.run("UPDATE sources SET name=replace(name,' · 样例','')");
store.run("UPDATE items SET author=replace(author,' · 样例','')");
store.run("UPDATE items SET text='本文为官网界面示例内容。\n\n关注执行边界、持久化状态和可回查证据。没有完整资料时，不用标题猜测全文。' WHERE kind IN ('email','youtube')");
store.run("UPDATE deliveries SET status='sent',error='',sent=created");
const sampleText = 'Agent 的可靠性来自清晰的执行边界。对外发送、写入和删除等操作，应当保留明确的授权与记录。\n\n评估需要贴近实际任务。除了检查回答，还要检查任务是否完成、引用是否可核对，以及失败时能否解释原因。\n\n长流程应保存关键状态。服务重启后从已确认的位置继续，不重复执行结果不确定的外部操作。';
const featured = store.get("SELECT id FROM items WHERE kind='email' ORDER BY rowid LIMIT 1");
store.run('UPDATE items SET title=?,text=?,author=? WHERE id=?', '本周 AI 简报：Agent 开发的三个重点', sampleText, 'AI 工程周刊', featured.id);
store.run("UPDATE sources SET name='AI 工程周刊' WHERE type='email'");
const engine = new Engine(store, config, demoAdapters(store, config));
engine.summaries.configure({ enabled: true, maxCalls: 30, maxCostCny: 1, confirmed: true });
for (const source of store.sources()) engine.summaries.authorize(source.id, 'manual', false, true, 'feed');
const items = store.all("SELECT id,kind FROM items WHERE kind IN ('youtube','email','rss')");
for (const item of items) {
  engine.summaries.enqueue(item.id, 'manual');
  await engine.cycle();
}
const email = items.find(item => item.kind === 'email');
store.run('UPDATE summaries SET result=? WHERE item_id=? AND status=?', JSON.stringify({
  oneLiner: '可靠的 Agent，需要执行边界、任务评估和可恢复的流程。',
  points: [
    { title: '先界定执行边界', text: '发送、写入和删除等外部操作需要明确授权，并留下可核查记录。', quote: '对外发送、写入和删除等操作，应当保留明确的授权与记录。', locator: '原文第1段' },
    { title: '评估任务，而不只是回答', text: '同时检查任务完成情况、引用依据和失败原因，让评估贴近实际使用。', quote: '除了检查回答，还要检查任务是否完成、引用是否可核对，以及失败时能否解释原因。', locator: '原文第2段' },
    { title: '让流程可以恢复', text: '保存关键状态，避免重启后重复执行结果不确定的操作。', quote: '服务重启后从已确认的位置继续，不重复执行结果不确定的外部操作。', locator: '原文第3段' },
  ],
}), email.id, 'succeeded');
await engine.stop();
store.close();

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [resolve('dist/server/main.js')], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, SYSTEMROOT: process.env.SYSTEMROOT,
    DOTENV_CONFIG_PATH: join(dir, 'absent.env'), FEEDRELAY_DEMO: '1', AUTH_MODE: 'local',
    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin, DATA_DIR: dir },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let log = '';
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', () => {});
const exited = once(child, 'exit');
let browser;
try {
  for (let n = 0; !log.includes('FeedRelay API:') && n < 150; n++) await new Promise(resolve => setTimeout(resolve, 100));
  if (!log.includes('FeedRelay API:')) throw new Error('CAPTURE_SERVER_FAILED');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
  await page.route('**/api/session', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), demo: false } });
  });
  await page.route('**/api/overview', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), demo: false } });
  });
  await page.route('https://**', route => route.abort());
  const output = resolve('site/public/images');
  await mkdir(output, { recursive: true });
  await page.goto(origin);
  await page.getByRole('heading', { name: '最新更新', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(output, 'workspace.png') });
  await page.locator('.updates-table-wrap').screenshot({ path: join(output, 'hero.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.updates-table tbody tr').first().screenshot({ path: join(output, 'hero-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto(`${origin}/#items/${email.id}`);
  await page.getByRole('region', { name: 'AI摘要', exact: true }).getByText('已生成', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'summary.png') });
  await page.route('**/api/digests', async route => {
    const response = await route.fetch();
    const rows = await response.json();
    const batch = rows.find(row => row.parts.length);
    await route.fulfill({ response, json: [0, 1, 2].map(n => ({ ...batch, id: `public-${n}`, slot: `aihot:${n}`, cutoff: Date.now() - n * 86400_000,
      timezone: 'Asia/Shanghai', total_parts: 1, parts: [{ ...batch.parts[0], status: 'sent', error: '', resolution: '' }] })) });
  });
  await page.route('**/api/aihot', route => route.fulfill({ json: { enabled: true, startDate: '2026-10-20', nextCheck: 0, lastDate: '2026-10-20', error: '' } }));
  await page.goto(`${origin}/#digests`);
  await page.getByRole('heading', { name: '每日日报', exact: true }).waitFor();
  await page.locator('.digest-list article').first().waitFor();
  await page.screenshot({ path: join(output, 'daily.png') });
  console.log('Public screenshots captured from isolated synthetic data; summary copy is an authored example.');
} finally {
  await browser?.close();
  if (child.connected) child.send('feedrelay:stop');
  else child.kill();
  await exited;
  await rm(dir, { recursive: true, force: true });
}
