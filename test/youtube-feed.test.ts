import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readConfig, AppError } from '../server/config.js';
import { createYoutubeFeed, parseUploads } from '../server/youtube-feed.js';
import { channel, fixture, incoming } from './helpers.js';

const entry = {
  id: 'abcdefghijk', channel, title: 'Synthetic video', author: 'Synthetic channel',
  description: '<p>Public description</p>', timestamp: 1_700_000_000,
};
const raw = { channel, entries: [entry] };
const config = readConfig({ FEEDRELAY_DEMO: '1' });
const liveConfig = { ...config, demo: false, captions: { ...config.captions, python: process.execPath } };

test('YT-F03: fallback runs only on RSS 404/5xx, uses bounded isolated metadata extraction and clears validators', async () => {
  let status = 404, calls = 0;
  const signal = new AbortController().signal;
  const feed = createYoutubeFeed(liveConfig, async () => new Response(null, { status }), signal,
    async (python, helper, input, passedSignal, timeout) => {
      calls++;
      assert.equal(python, process.execPath);
      assert(helper.endsWith('youtube-uploads.py'));
      assert.equal(passedSignal, signal);
      assert.equal(timeout, 120_000);
      assert.deepEqual(input, { channel, proxy: '', node: process.execPath });
      return raw;
    });
  for (status of [404, 500, 503]) {
    const result = await feed(channel, { etag: 'old' });
    assert.equal(result.fallback, true);
    assert.equal(result.etag, '');
    assert.equal(result.items[0].published, entry.timestamp * 1000);
    assert.equal(result.items[0].text, 'Public description');
  }
  status = 304;
  assert.equal((await feed(channel)).unchanged, true);
  for (status of [403, 429]) await assert.rejects(feed(channel), new RegExp(`YOUTUBE_HTTP_${status}`));
  assert.equal(calls, 3);
  status = 404;
  await assert.rejects(createYoutubeFeed(config, async () => new Response(null, { status }), signal)(channel), /YOUTUBE_FEED_NOT_READY/);
});

test('YT-F04: wrong channel, missing dates, duplicates and empty/oversized results never establish a baseline', async () => {
  for (const value of [
    { ...raw, channel: 'other' }, { ...raw, entries: [] },
    { ...raw, entries: [entry, entry] }, { ...raw, entries: Array(16).fill(entry) },
    ...[{ channel: 'other' }, { timestamp: null }, { timestamp: Infinity },
      { timestamp: Date.now() / 1000 + 60 }, { id: '../invalid' }, { title: '' }]
      .map((change) => ({ ...raw, entries: [{ ...entry, ...change }] })),
  ]) assert.throws(() => parseUploads(value, channel), /YOUTUBE_UPLOADS_UNAVAILABLE/);
  const feed = createYoutubeFeed(liveConfig, async () => new Response(null, { status: 404 }),
    new AbortController().signal, async () => { throw new Error('private diagnostic'); });
  await assert.rejects(feed(channel), (error: unknown) => error instanceof AppError &&
    error.code === 'YOUTUBE_UPLOADS_UNAVAILABLE' && error.retryable);
});

test('YT-F05: fallback preserves known metadata, silent history and normal single delivery for new uploads', async (t) => {
  let items = [incoming('youtube:abcdefghijk', 1000)];
  const f = fixture(t, { feed: async () => ({ unchanged: false, items, fallback: true }) });
  const s = f.source();
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  assert.equal(f.store.source(s.id).initialized, 1);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0);
  items = [{ ...items[0], text: 'Different provider description' }, incoming('youtube:lmnopqrstuv', 2000)];
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  assert.equal(f.store.get('SELECT text FROM items WHERE key=?', items[0].key)!.text, '样例正文');
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0);
  items.push(incoming('youtube:wxyz1234567', f.now() + 1));
  for (let n = 0; n < 2; n++) {
    f.store.enqueue('source', s.id, s.generation);
    await f.run();
  }
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
});

test('YT-F06: Python metadata contract never downloads media and limits the upload window', () => {
  const result = spawnSync('python3', ['test/youtube-uploads.test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
