import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { backup } from 'node:sqlite';
import { fixture, incoming } from './helpers.js';
import { AppError, readConfig } from '../server/config.js';
import {
  CAPTION_SCOPE,
  MAX_CAPTION_TEXT,
  parseCaption,
  captionEvidence,
  captionProcess,
  timeLabel,
  createCaptionAdapter,
} from '../server/captions.js';
import { type SummaryRow } from '../server/summary.js';
import { MODEL_ENDPOINT, type SummaryInput } from '../server/deepseek.js';
import { Store } from '../server/store.js';

const id = 'abcdefghijk';
const raw = (text = '字幕描述付款状态需要重新查询。') => ({
  videoId: id,
  language: 'zh-Hans',
  kind: 'manual',
  duration: 120,
  cues: [{ start: 10000, duration: 3000, text }],
});
const output = (input: SummaryInput, locator = '[00:10]') => ({
  summary: {
    overview: { oneLiner: '根据字幕核对状态。' },
    keyPoints: [
      {
        title: '状态核对',
        summary: '应重新核对状态。',
        evidence: { quote: input.text.split('] ')[1].split('\n')[0].slice(0, 100), locator },
      },
    ],
  },
});
function setup(t: Parameters<typeof fixture>[0], mode = 'manual', notify = true) {
  const f = fixture(t),
    source = f.source(),
    service = f.engine.summaries;
  service.configure({ enabled: true, maxCalls: 20, maxCostCny: 10, confirmed: true });
  service.authorize(source.id, mode, notify, true, 'captions');
  const item = f.store.put({ ...incoming(), text: '' }, [f.store.source(source.id)], true, 'demo');
  let downloads = 0;
  service.captions!.fetch = async () => {
    downloads++;
    return parseCaption(raw(), id);
  };
  return { ...f, source, service, item, downloads: () => downloads };
}
const modelCall = (request: typeof fetch, signal: AbortSignal) =>
  request(MODEL_ENDPOINT, {
    method: 'POST',
    signal,
    body: JSON.stringify({ model: 'demo-deepseek', max_tokens: 2600 }),
  });

test('YT-I01: captions remain optional, strict proxy config and disabled runtime do not affect feeds', async (t) => {
  const f = fixture(t);
  assert.equal(createCaptionAdapter({ ...f.config, demo: false }).available, false);
  for (const proxy of [
    'socks5://localhost:1080',
    'http://user:secret@localhost:1234',
    'http://localhost/x',
  ])
    assert.throws(
      () => readConfig({ FEEDRELAY_DEMO: '1', YOUTUBE_CAPTIONS_PROXY_URL: proxy }),
      /INVALID_YOUTUBE_CAPTIONS_PROXY/,
    );
  assert.equal(
    readConfig({ FEEDRELAY_DEMO: '1', YOUTUBE_CAPTIONS_PROXY_URL: 'http://127.0.0.1:1087' })
      .captions.proxy,
    'http://127.0.0.1:1087',
  );
  const source = f.source();
  f.engine.summaries.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  f.engine.summaries.captions!.available = false;
  assert.throws(
    () => f.engine.summaries.authorize(source.id, 'manual', false, true, 'captions'),
    /YOUTUBE_RUNTIME_UNAVAILABLE/,
  );
  assert.doesNotThrow(() => f.engine.summaries.authorize(source.id, 'manual', false, true, 'feed'));
  const email = f.source('email');
  assert.throws(
    () => f.engine.summaries.authorize(email.id, 'manual', false, true, 'captions'),
    /INVALID_SUMMARY_CONTENT/,
  );
});

test('YT-I02: JSON3 normalization keeps timestamps, removes adjacent rolling prefixes and rejects bad/oversized text', () => {
  assert.equal(timeLabel(3661), '01:01:01');
  const caption = parseCaption(
    {
      ...raw(),
      kind: 'automatic',
      cues: [
        { start: 1000, duration: 2000, text: 'Hello world' },
        { start: 2000, duration: 2000, text: 'Hello world again' },
        { start: 3000, duration: 2000, text: 'Hello world again' },
      ],
    },
    id,
  );
  assert.equal(caption.text, '[00:01] Hello world again');
  assert.throws(() => parseCaption(raw(''), id), /YOUTUBE_EMPTY_CAPTION/);
  assert.throws(() => parseCaption({ ...raw(), duration: 14401 }, id), /YOUTUBE_VIDEO_TOO_LONG/);
  assert.equal(
    parseCaption({ ...raw(), cues: [...raw().cues, { text: '\n' }] }, id).text,
    parseCaption(raw(), id).text,
  );
  assert.throws(
    () => parseCaption(raw('x'.repeat(MAX_CAPTION_TEXT)), id),
    /YOUTUBE_CAPTION_TOO_LONG/,
  );
  assert.throws(
    () => parseCaption({ ...raw(), cues: [{ start: -1, duration: 0, text: 'bad' }] }, id),
    /YOUTUBE_INVALID_CAPTION/,
  );
  assert.throws(
    () => parseCaption({ ...raw(), videoId: 'different11' }, id),
    /YOUTUBE_INVALID_CAPTION/,
  );
  const result = {
    oneLiner: '结论',
    points: [{ title: '标题', text: '解释', quote: 'Hello world', locator: '[00:01]' }],
  };
  assert.equal(
    captionEvidence(result, caption).points[0].url,
    `https://www.youtube.com/watch?v=${id}&t=1s`,
  );
  assert.throws(
    () =>
      captionEvidence(
        { ...result, points: [{ ...result.points[0], locator: '[00:02]' }] },
        caption,
      ),
    /SUMMARY_UNSUPPORTED_QUOTE/,
  );
  assert.throws(() => captionEvidence(result, { ...caption, text: 'changed' }), /CACHE_INVALID/);
});

test('YT-I02: contiguous caption fragments form bounded passages with literal cross-cue evidence', () => {
  const caption = parseCaption(
    {
      ...raw(),
      cues: [
        { start: 0, duration: 2000, text: 'Docker can package software' },
        { start: 2000, duration: 2000, text: 'into containers that run reliably.' },
        { start: 21000, duration: 2000, text: 'A new time window.' },
        { start: 30000, duration: 1000, text: 'A separated passage.' },
        { start: 31000, duration: 1000, text: 'x'.repeat(590) },
      ],
    },
    id,
  );
  assert.equal(
    caption.text,
    '[00:00] Docker can package software into containers that run reliably.\n\n' +
      '[00:21] A new time window.\n\n[00:30] A separated passage.\n\n[00:31] ' +
      'x'.repeat(590),
  );
  const point = {
    title: 'Containers',
    text: 'Packages software.',
    quote: 'software into containers',
    locator: '[00:00]',
  };
  assert.equal(
    captionEvidence({ oneLiner: 'Docker', points: [point] }, caption).points[0].url,
    `https://www.youtube.com/watch?v=${id}&t=0s`,
  );
  assert.throws(
    () =>
      captionEvidence(
        { oneLiner: 'Docker', points: [{ ...point, quote: 'reliably. A new time window.' }] },
        caption,
      ),
    /SUMMARY_UNSUPPORTED_QUOTE/,
  );
});

test('YT-I03: durable caption task, cache and timestamped supplement share the original summary queue', async (t) => {
  const f = setup(t),
    row = f.service.enqueue(f.item.id);
  await f.service.cycle('demo');
  const view = f.service.list(f.item.id)[0];
  assert.equal(view.status, 'succeeded');
  assert.equal(view.scope, CAPTION_SCOPE);
  assert.equal(view.caption?.language, 'zh-Hans');
  assert.equal(view.result!.points[0].url, `https://www.youtube.com/watch?v=${id}&t=10s`);
  assert.equal(f.service.enqueue(f.item.id), row);
  await f.service.cycle('demo');
  assert.equal(f.downloads(), 1);
  assert.equal(f.service.describe().calls, 1);
  const saved = f.store.get<SummaryRow>('SELECT * FROM summaries WHERE id=?', row)!;
  assert.equal(saved.input, '');
  assert.ok(saved.material);
  const message = f.store.get<{ snapshot: string }>(
    'SELECT snapshot FROM deliveries WHERE item_id=?',
    saved.output_item,
  )!.snapshot;
  assert.match(message, /1\. 原文要点/);
  assert.doesNotMatch(message, /t=10s|原文引用/);
  assert.match(message, /字幕/);
  assert.equal(
    f.store.get('SELECT status FROM deliveries WHERE item_id=?', f.item.id)!.status,
    'pending',
  );
});

test('YT-I03: failed model retry reuses cached transcript without hiding earlier costs', async (t) => {
  const f = setup(t);
  let fail = true;
  f.service.adapter.run = async (input, request, signal) => {
    await modelCall(request, signal);
    if (fail) throw new AppError('MODEL_SERVICE_FAILED');
    return output(input);
  };
  f.service.enqueue(f.item.id);
  await f.service.cycle('demo');
  fail = false;
  f.service.enqueue(f.item.id, 'manual', true);
  await f.service.cycle('demo');
  assert.equal(f.service.list(f.item.id)[0].status, 'succeeded');
  assert.equal(f.downloads(), 1);
  assert.equal(f.service.describe().calls, 2);
});

test('YT-I03: scope round trips regenerate a fresh supplement while retaining the same call ledger', async (t) => {
  const f = setup(t),
    id = f.service.enqueue(f.item.id);
  await f.service.cycle('demo');
  const previous = f.store.get<SummaryRow>('SELECT * FROM summaries WHERE id=?', id)!.output_item;
  f.service.authorize(f.source.id, 'manual', true, true, 'feed');
  f.service.authorize(f.source.id, 'manual', true, true, 'captions');
  assert.equal(f.service.enqueue(f.item.id), id);
  await f.service.cycle('demo');
  const row = f.store.get<SummaryRow>('SELECT * FROM summaries WHERE id=?', id)!;
  assert.equal(row.status, 'succeeded', row.error);
  assert.notEqual(row.output_item, previous);
  assert.equal(
    f.store.get('SELECT status FROM deliveries WHERE item_id=?', previous)!.status,
    'cancelled',
  );
  assert.equal(f.service.describe().calls, 2);
  assert.equal(f.downloads(), 2);
  f.service.authorize(f.source.id, 'off', false, true);
  f.service.captions!.available = false;
  assert.doesNotThrow(() => f.service.authorize(f.source.id, 'off', false, true, 'feed'));
  assert.doesNotThrow(() => f.service.authorize(f.source.id, 'manual', false, true, 'feed'));
});

test('YT-I04: no captions/network failure consumes no model budget and original notification still sends', async (t) => {
  for (const code of ['YOUTUBE_NO_CAPTIONS', 'YOUTUBE_NETWORK_ERROR', 'YOUTUBE_ACCESS_BLOCKED']) {
    const f = setup(t);
    f.service.captions!.fetch = async () => {
      throw new AppError(code);
    };
    f.service.enqueue(f.item.id);
    await f.engine.cycle();
    assert.equal(f.service.list(f.item.id)[0].error, code);
    assert.equal(f.service.describe().calls, 0);
    assert.equal(
      f.store.get('SELECT status FROM deliveries WHERE item_id=?', f.item.id)!.status,
      'sent',
    );
    await f.engine.cycle();
    assert.equal(f.service.list(f.item.id)[0].status, 'failed');
  }
});

test('YT-I05: long captions use bounded DeepSeek workflow and every chunk/merge/repair shares persistent budget', async (t) => {
  const f = setup(t);
  f.service.captions!.fetch = async () =>
    parseCaption(raw('较长字幕需要完整分块。'.repeat(1000)), id);
  f.service.adapter.run = async (input, request, signal) => {
    assert.ok(input.text.length > 8000);
    assert.equal(input.captions, true);
    for (let n = 0; n < 3; n++) await modelCall(request, signal);
    return output(input);
  };
  f.service.configure({ enabled: true, maxCalls: 2, maxCostCny: 1, confirmed: true });
  f.service.enqueue(f.item.id);
  await f.service.cycle('demo');
  assert.equal(f.service.list(f.item.id)[0].error, 'SUMMARY_BUDGET_EXHAUSTED');
  assert.equal(f.service.describe().calls, 2);
  f.service.configure({ enabled: true, maxCalls: 30, maxCostCny: 10, confirmed: true });
  f.service.adapter.run = async (input, request, signal) => {
    for (let n = 0; n < 13; n++) await modelCall(request, signal);
    return output(input);
  };
  f.service.enqueue(f.item.id, 'manual', true);
  await f.service.cycle('demo');
  assert.equal(f.service.list(f.item.id)[0].error, 'SUMMARY_TASK_CALL_LIMIT');
  assert.equal(f.service.describe().calls, 14);
});

test('YT-I06: changing scope cancels queued work; revocation while fetching prevents model calls/cache writes', async (t) => {
  const f = setup(t);
  const first = f.service.enqueue(f.item.id);
  f.service.authorize(f.source.id, 'manual', false, true, 'feed');
  assert.equal(f.store.get('SELECT status FROM summaries WHERE id=?', first)!.status, 'cancelled');
  f.service.authorize(f.source.id, 'manual', false, true, 'captions');
  f.service.captions!.fetch = async () => {
    f.store.toggle(f.source.id, false, false);
    return parseCaption(raw(), id);
  };
  f.service.enqueue(f.item.id);
  await f.service.cycle('demo');
  assert.equal(f.service.describe().calls, 0);
  assert.equal(f.store.get("SELECT count(*) n FROM summaries WHERE material<>''")!.n, 0);
  assert.equal(f.service.list(f.item.id)[0].current, false);
});

test('YT-I06: original content changes and expiry erase caption cache and supplemental snapshots', async (t) => {
  const f = setup(t),
    row = f.service.enqueue(f.item.id);
  await f.service.cycle('demo');
  f.store.run("UPDATE items SET text='new feed description' WHERE id=?", f.item.id);
  f.service.reconcile();
  assert.equal(f.store.get('SELECT material FROM summaries WHERE id=?', row)!.material, '');
  assert.equal(f.service.list(f.item.id)[0].status, 'cancelled');
  f.service.enqueue(f.item.id);
  await f.service.cycle('demo');
  f.advance(31 * 86400000);
  f.store.cleanup();
  assert.equal(f.store.get("SELECT count(*) n FROM summaries WHERE material<>''")!.n, 0);
});

test('YT-I06: baseline/history are not automatically extracted and scope switch affects only future auto work', async (t) => {
  const f = setup(t, 'auto');
  f.service.schedule();
  assert.equal(f.service.list(f.item.id).length, 0);
  f.advance(1000);
  const item = f.store.put(
    { ...incoming('youtube:12345678901', f.now()), text: '' },
    [f.store.source(f.source.id)],
    true,
    'demo',
  );
  f.service.schedule();
  assert.equal(f.service.list(item.id)[0].status, 'queued');
  f.service.authorize(f.source.id, 'auto', false, true, 'feed');
  f.service.schedule();
  assert.equal(f.service.list(item.id).length, 1);
  assert.equal(f.service.list(item.id)[0].status, 'cancelled');
});

test('YT-I07: v3 migration defaults to feed; v4 restore erases cached captions and disables authorization', async (t) => {
  const f = setup(t);
  f.service.enqueue(f.item.id);
  await f.service.cycle('demo');
  const path = join(f.dir, 'v4.sqlite');
  await backup(f.store.db, path);
  const target = join(f.dir, 'restored');
  const restored = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/restore.ts', path, '--confirm-stopped'],
    { env: { ...process.env, DATA_DIR: target }, encoding: 'utf8' },
  );
  assert.equal(restored.status, 0, restored.stderr);
  const db = new Store(target, 'demo');
  assert.equal(db.get('SELECT material FROM summaries')!.material, '');
  assert.equal(db.source(f.source.id).summary_mode, 'off');
  db.close();
  const v3Path = join(f.dir, 'v3');
  const old = new Store(v3Path, 'demo');
  const source = old.createSource({
    type: 'youtube',
    name: '旧频道',
    channel: 'UC' + 'x'.repeat(22),
  });
  old.db.exec(
    'ALTER TABLE sources DROP COLUMN summary_content; ALTER TABLE summaries DROP COLUMN material; PRAGMA user_version=3;',
  );
  old.close();
  const upgraded = new Store(v3Path, 'demo');
  assert.equal(upgraded.source(source.id).summary_content, 'feed');
  assert.equal(upgraded.get('PRAGMA user_version')!.user_version, 4);
  upgraded.close();
});

test('YT-I08: subprocess isolates environment, enforces output/timeout/cancellation and reports missing runtime safely', async (t) => {
  const f = fixture(t),
    helper = join(f.dir, 'fake.py');
  const runtime = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
  });
  if (runtime.status !== 0) return t.skip('local Python unavailable');
  const python = runtime.stdout.trim();
  const previousKey = process.env.DEEPSEEK_API_KEY,
    previousProxy = process.env.HTTP_PROXY;
  process.env.DEEPSEEK_API_KEY = 'synthetic-secret-must-not-leak';
  process.env.HTTP_PROXY = 'http://synthetic.invalid:9999';
  t.after(() => {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    if (previousProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previousProxy;
  });
  const contract = spawnSync(python, ['-B', '-I', 'test/youtube-captions.test.py'], {
    encoding: 'utf8',
  });
  assert.equal(contract.status, 0, contract.stderr);
  writeFileSync(
    helper,
    'import json, os, sys\nr=json.load(sys.stdin)\nprint(json.dumps({"id":r["id"],"secret":os.environ.get("DEEPSEEK_API_KEY"),"proxy":os.environ.get("HTTP_PROXY")}))\n',
  );
  const response = (await captionProcess(
    python,
    helper,
    { id },
    new AbortController().signal,
  )) as any;
  assert.equal(response.id, id);
  assert.equal(response.secret, null);
  assert.equal(response.proxy, null);
  writeFileSync(helper, 'print("x" * 2100000)\n');
  await assert.rejects(
    captionProcess(python, helper, {}, new AbortController().signal),
    /CAPTION_TOO_LARGE/,
  );
  writeFileSync(helper, 'import time\ntime.sleep(10)\n');
  await assert.rejects(
    captionProcess(python, helper, {}, new AbortController().signal, 100),
    /YOUTUBE_TIMEOUT/,
  );
  const controller = new AbortController();
  const pending = captionProcess(python, helper, {}, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /YOUTUBE_CANCELLED/);
  await assert.rejects(
    captionProcess('/no/python', helper, {}, new AbortController().signal),
    /RUNTIME_UNAVAILABLE/,
  );
});
