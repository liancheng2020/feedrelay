import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import type { lookup } from 'node:dns/promises';
import { feedUrl, publicAddresses, createPublicLookup, parseRss, fetchRss } from '../server/rss.js';
import { fixture } from './helpers.js';
const url = 'https://feeds.example.com/news.xml';
const resolve = (...addresses: string[]) =>
  (async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }))) as unknown as typeof lookup;
const xml = (title = '新闻') =>
  `<rss version="2.0"><channel><title>合成RSS</title><item><guid>stable-id</guid><title>${title}</title><link>https://example.com/article?id=1</link><description><![CDATA[<p>正文</p><script>bad()</script><img src="https://evil.com/x">]]></description><pubDate>Wed, 01 Jan 2020 00:00:00 GMT</pubDate></item></channel></rss>`;
test('RSS URL rejects IP encodings, credentials, private suffixes and tokens', () => {
  assert.equal(feedUrl(url), url);
  for (const bad of [
    'http://example.com/feed',
    'https://localhost/a',
    'https://127.1/a',
    'https://2130706433/a',
    'https://[::1]/a',
    'https://x.internal/a',
    'https://u:p@example.com/feed',
    url + '?token=secret',
    url + '#secret',
    'https://example.com:8443/feed',
  ])
    assert.throws(() => feedUrl(bad));
});
test('DNS blocks mixed answers, mapped IPv4 and special IPv6 ranges', async () => {
  assert.equal((await publicAddresses('example.com', resolve('1.1.1.1')))[0].address, '1.1.1.1');
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])
    await assert.rejects(
      publicAddresses('example.com', resolve('1.1.1.1', ip)),
      /RSS_PRIVATE_ADDRESS/,
    );
});
test('socket never connects when checked DNS resolves to a private address', async (t) => {
  let accepted = 0;
  const server = createServer((s) => {
    accepted++;
    s.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const socket = connect({
    host: 'rebind.example.com',
    port: (server.address() as { port: number }).port,
    lookup: createPublicLookup(resolve('127.0.0.1')),
  });
  t.after(() => socket.destroy());
  const [error] = await once(socket, 'error');
  assert.match(error.message, /RSS_PRIVATE_ADDRESS/);
  assert.equal(accepted, 0);
});
test('RSS/Atom use stable identity, inert previews and valid query permalinks', async () => {
  const first = (await parseRss(xml(), url))[0],
    edited = (await parseRss(xml('更新标题'), url))[0];
  assert.equal(first.key, edited.key);
  assert(first.url.includes('?id=1'));
  assert(!first.text.includes('bad()'));
  assert(!first.text.includes('evil.com'));
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>tag:example.com,2026:1</id><title>样例</title><link href="https://example.com/1"/><updated>2026-10-17T00:00:00Z</updated></entry></feed>`;
  assert.equal((await parseRss(atom, url)).length, 1);
});
test('missing IDs, hostile XML and oversized response fail visibly', async () => {
  await assert.rejects(
    parseRss(
      xml()
        .replace('<guid>stable-id</guid>', '')
        .replace('<link>https://example.com/article?id=1</link>', ''),
      url,
    ),
    /RSS_ENTRY_ID_REQUIRED/,
  );
  await assert.rejects(parseRss('<!DOCTYPE a><rss/>', url), /UNSAFE_FEED/);
  await assert.rejects(parseRss('<?xml version="1.0" encoding="GBK"?>' + xml(), url), /RSS_ENCODING_UNSUPPORTED/);
  await assert.rejects(parseRss('x'.repeat(2000001), url), /UNSAFE_FEED/);
});
test('redirects revalidate scheme, credentials and network boundaries', async () => {
  let calls = 0;
  await assert.rejects(
    fetchRss(url, {}, async () => {
      calls++;
      return { status: 302, headers: { location: 'https://127.0.0.1/private' }, text: '' };
    }),
    /PUBLIC_HTTPS/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    fetchRss(url, {}, async () => ({
      status: 301,
      headers: { location: 'https://feeds.example.com/again' },
      text: '',
    })),
    /RSS_REDIRECT_LIMIT/,
  );
});
test('conditional request honors 304 and retryable HTTP failures', async () => {
  const unchanged = await fetchRss(url, { etag: 'etag' }, async (_url, cache) => {
    assert.equal(cache?.etag, 'etag');
    return { status: 304, headers: {}, text: '' };
  });
  assert(unchanged.unchanged);
  await assert.rejects(
    fetchRss(url, {}, async () => ({ status: 429, headers: {}, text: '' })),
    /RSS_HTTP_429/,
  );
});
test('RSS engine baseline, old publication with new GUID and deduplication', async (t) => {
  let items = await parseRss(xml(), url);
  const f = fixture(t, { rss: async () => ({ unchanged: false, items }) });
  const s = f.store.toggle(
    f.store.createSource({ type: 'rss', name: '公开RSS', feed_url: url }).id,
    true,
    true,
  );
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0);
  items = [...items, { ...items[0], key: 'rss:new-guid', published: 0 }];
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
  f.store.enqueue('source', s.id, s.generation);
  items[0].url = 'https://example.com/updated';
  await f.run();
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
  assert.equal(f.store.get('SELECT url FROM items WHERE key=?', items[0].key)!.url, 'https://example.com/updated');
});
