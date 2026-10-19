import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  channelId,
  normalizeSource,
  matches,
  parseFeed,
  cleanMailBody,
  textPart,
  connectMailbox,
  feishuSender,
  fetchFeed,
} from '../server/adapters.js';
import { readConfig } from '../server/config.js';
import { channel } from './helpers.js';

test('channel input accepts only canonical IDs and hosts', () => {
  assert.equal(channelId(`https://www.youtube.com/channel/${channel}`), channel);
  for (const bad of [
    '@someone',
    'http://127.0.0.1',
    `https://evil.test/channel/${channel}`,
    `https://youtube.com/not-channel/${channel}`,
  ])
    assert.throws(() => channelId(bad));
});
test('mail rules match actual address rather than display name', () => {
  const s = normalizeSource({
    type: 'email',
    name: '新闻',
    sender: 'BRIEF@example.com',
    subject: 'Daily',
  });
  assert(matches(s, 'brief@example.com', 'Daily news'));
  assert(!matches(s, 'BRIEF@example.com <bad@example.com>', 'Daily news'));
  assert(!matches(s, 'bad@example.com', 'Daily news'));
});
test('Atom parsing reconstructs safe canonical URLs and refuses entities', async () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>频道</title><entry><id>yt:video:abcdefghijk</id><yt:videoId>abcdefghijk</yt:videoId><yt:channelId>${channel}</yt:channelId><title>测试视频</title><link href="javascript:alert(1)"/><published>2026-10-16T00:00:00Z</published></entry></feed>`;
  const items = await parseFeed(xml, channel);
  assert.equal(items[0].url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(items[0].title, '测试视频');
  await assert.rejects(
    parseFeed('<!DOCTYPE a SYSTEM "file:///etc/passwd">' + xml, channel),
    /UNSAFE_FEED/,
  );
  await assert.rejects(parseFeed(xml, 'UC' + 'b'.repeat(22)), /INVALID_FEED_ENTRY/);
});
test('YouTube fetch sends conditional request and never follows redirect', async () => {
  const result = await fetchFeed(channel, { etag: 'a' }, async (_url, init) => {
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>)['If-None-Match'], 'a');
    return new Response(null, { status: 304 });
  });
  assert(result.unchanged);
  await assert.rejects(
    fetchFeed(channel, {}, async () => new Response('', { status: 429 })),
    /YOUTUBE_HTTP_429/,
  );
});

test('YT-F01: feed 404 is retryable and releases its response body; blocked access stays distinct', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 404 });
  await assert.rejects(fetchFeed(channel, {}, async () => response), (error: any) =>
    error.code === 'YOUTUBE_FEED_NOT_READY' && error.retryable === true && error.retryAfter === 60000);
  assert.equal(cancelled, true);
  await assert.rejects(fetchFeed(channel, {}, async () => new Response('', { status: 403 })),
    (error: any) => error.code === 'YOUTUBE_HTTP_403' && !error.retryable);
});
test('HTML mail becomes inert text with no remote image or script', async () => {
  const text = await cleanMailBody(
    '<p>市场观察</p><script>secret()</script><img src="https://tracker.test/pixel"><form>password</form><p>下一段</p>',
    true,
  );
  assert(text.includes('市场观察'));
  assert(!text.includes('secret'));
  assert(!text.includes('tracker'));
  assert(!text.includes('password'));
  await assert.rejects(cleanMailBody('x'.repeat(1000001)), /MAIL_BODY_TOO_LARGE/);
});
test('MIME traversal skips attachments and nested forwarded messages', () => {
  const part = textPart({
    type: 'multipart/mixed',
    childNodes: [
      { type: 'text/plain', disposition: 'attachment', part: '1' },
      { type: 'message/rfc822', part: '2' },
      { type: 'text/html', part: '3' },
    ],
  });
  assert.equal(part?.part, '3');
});
test('IMAP SDK contract enforces readOnly, UID, body-part download only', async () => {
  const config = readConfig({
    FEEDRELAY_DEMO: '1',
    IMAP_ENABLED: '1',
    IMAP_HOST: 'imap.163.com',
    IMAP_USER: 'x@163.com',
    IMAP_PASSWORD: 'test',
  });
  const calls: string[] = [];
  const fake = {
    on() {},
    async connect() {},
    async mailboxOpen(_folder: string, options: unknown) {
      assert.deepEqual(options, { readOnly: true });
      calls.push('EXAMINE');
      return { uidValidity: 1n, uidNext: 2 };
    },
    async search() { return [1]; },
    async fetchAll(_range: string, query: unknown, opts: unknown) {
      assert.deepEqual(query, { uid: true, envelope: true, internalDate: true });
      assert.deepEqual(opts, { uid: true });
      return [
        {
          uid: 1,
          envelope: { from: [{ address: 'brief@example.com' }], subject: '新闻', date: new Date() },
        },
      ];
    },
    async fetchOne() {
      return { bodyStructure: { type: 'text/plain', part: '1', size: 20 } };
    },
    async download(uid: string, part: string, opts: unknown) {
      assert.equal(uid, '1');
      assert.equal(part, '1');
      assert.deepEqual(opts, { uid: true, maxBytes: 1000001 });
      calls.push('PART');
      return { content: Readable.from([Buffer.from('正文')]) };
    },
    async logout() {
      calls.push('LOGOUT');
    },
    close() {},
  };
  const box = await connectMailbox(
    config,
    (() => fake) as unknown as Parameters<typeof connectMailbox>[1],
  );
  assert.equal((await box.headers(1, 1))[0].sender, 'brief@example.com');
  assert.equal(await box.body(1), '正文');
  await box.close();
  assert.deepEqual(calls, ['EXAMINE', 'PART', 'LOGOUT']);
});
test('MAIL-01: missing UIDNEXT uses last sequence UID and batches sparse UIDs safely', async () => {
  const uids = Array.from({ length: 105 }, (_, i) => 1_000_000 + i * 10000);
  const fake = {
    on() {}, async connect() {}, async logout() {}, close() {},
    async mailboxOpen() { return { exists: 105, uidValidity: 1n }; },
    async fetchOne(sequence: string, query: unknown) {
      assert.equal(sequence, '105');
      assert.deepEqual(query, { uid: true });
      return { uid: uids[104] };
    },
    async search() { return [...uids].reverse(); },
    async fetchAll(range: string) {
      assert.equal(range.split(',').length, 100);
      // A message can disappear between SEARCH and FETCH; never skip the next batch.
      return range.split(',').slice(1).map((uid) => ({ uid: Number(uid) }));
    },
  };
  const box = await connectMailbox(readConfig({ FEEDRELAY_DEMO: '1', IMAP_ENABLED: '1',
    IMAP_HOST: 'imap.163.com', IMAP_USER: 'test@163.com', IMAP_PASSWORD: 'synthetic' }),
    (() => fake) as unknown as Parameters<typeof connectMailbox>[1]);
  assert.equal(box.upper, uids[104]);
  assert.equal((await box.headers(1, box.upper)).length, 99);
  assert.equal(box.scannedUpper, uids[99]);
  await box.close();
});
function realConfig() {
  return readConfig({
    FEEDRELAY_DEMO: '1',
    FEISHU_ENABLED: '1',
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'test-secret',
    FEISHU_OPEN_ID: 'ou_test',
  });
}
test('application bot uses token plus private open_id and caches token', async () => {
  const config = { ...realConfig(), demo: false };
  let calls = 0;
  const send = feishuSender(config, async (url, init) => {
    calls++;
    if (String(url).includes('/auth/'))
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    assert(String(url).includes('receive_id_type=open_id'));
    assert.equal(JSON.parse(String(init?.body)).receive_id, 'ou_test');
    return Response.json({ code: 0 });
  });
  assert.equal((await send('hello', '1')).status, 'sent');
  assert.equal((await send('again', '2')).status, 'sent');
  assert.equal(calls, 3);
});
test('send timeout and HTTP 5xx become unknown rather than blind retry', async () => {
  for (const outcome of ['timeout', 'server']) {
    const send = feishuSender({ ...realConfig(), demo: false }, async (url) => {
      if (String(url).includes('/auth/'))
        return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 });
      if (outcome === 'timeout') throw new Error('timeout');
      return Response.json({ code: 1 }, { status: 500 });
    });
    assert.equal((await send('x', '1')).status, 'unknown');
  }
});
test('rate limit honors valid retry-after, malformed values are bounded', async () => {
  const send = feishuSender({ ...realConfig(), demo: false }, async (url) =>
    String(url).includes('/auth/')
      ? Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 })
      : new Response('', { status: 429, headers: { 'retry-after': 'not-a-number' } }),
  );
  const result = await send('x', '1');
  assert.equal(result.status, 'retry_wait');
  assert.equal(result.retryAfter, 60000);
});
test('HTTP 200 business failure is not success, auth failures never send content', async () => {
  let calls = 0;
  const send = feishuSender({ ...realConfig(), demo: false }, async (url) => {
    calls++;
    return String(url).includes('/auth/')
      ? Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 })
      : Response.json({ code: 230013 });
  });
  assert.equal((await send('x', '1')).status, 'failed');
  assert.equal(calls, 2);
  calls = 0;
  const blocked = feishuSender({ ...realConfig(), demo: false }, async () => {
    calls++;
    return Response.json({ code: 10003 });
  });
  assert.equal((await blocked('private', '1')).status, 'failed');
  assert.equal(calls, 1);
});
