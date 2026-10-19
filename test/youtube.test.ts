import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { channel, fixture } from './helpers.js';
import { AppError, readConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import {
  channelInput,
  channelId,
  channelFromHtml,
  resolveChannel,
  resolveDemoChannel,
  youtubeTransport,
  DEMO_CHANNEL,
} from '../server/youtube.js';
import { previewImport } from '../server/portable.js';

const page = (id = channel) =>
  `<html><head><link href="https://www.youtube.com/channel/${id}" rel="canonical"><meta content="${id}" itemprop="identifier"></head><body><a href="https://www.youtube.com/channel/UC${'b'.repeat(22)}">Another channel</a></body></html>`;

test('YT-H01: channel URLs, handles, tabs and share parameters normalize without accepting arbitrary URLs', () => {
  for (const input of [
    '@MeiTouJun',
    'https://www.youtube.com/@MeiTouJun',
    'https://m.youtube.com/@MeiTouJun/videos?si=share',
    'https://youtube.com/@MeiTouJun/shorts/',
    'https://youtube.com/%40MeiTouJun?sub_confirmation=1',
  ])
    assert.equal(channelInput(input), '@MeiTouJun');
  assert.equal(channelInput('https://www.youtube.com/@%E9%A2%91%E9%81%93%E5%90%8D'), '@频道名');
  assert.equal(channelId(`https://youtube.com/channel/${channel}`), channel);
  for (const input of [
    'https://youtube.com.evil.test/@abc',
    'http://youtube.com/@abc',
    'https://user@youtube.com/@abc',
    'https://youtube.com:8080/@abc',
    'https://youtube.com/@abc?url=https://evil.test',
    'https://youtube.com/@abc%2Fbad',
    'https://youtube.com/@abc#bad',
    'https://youtube.com/watch?v=abcdefghijk',
    'https://youtube.com/@abc/%',
    '@abc/def',
    '@hello world',
    '@a\\bad',
    'https://youtube.com/%GG',
    'MeiTouJun',
  ])
    assert.throws(() => channelInput(input), /INVALID_CHANNEL/, input);
  assert.throws(() => channelId('@MeiTouJun'), /CHANNEL_ID_REQUIRED/);
});

test('YT-H02: resolve document canonical metadata, including YouTube body placement; recommendations and scripts cannot become IDs', () => {
  assert.equal(channelFromHtml(page()), channel);
  assert.equal(
    channelFromHtml(page().replace('<head>', '<head></head><body>').replace('</head><body>', '')),
    channel,
  );
  assert.equal(
    channelFromHtml(
      `<head><meta property="og:url" content="https://www.youtube.com/channel/${channel}"/></head>`,
    ),
    channel,
  );
  assert.throws(
    () =>
      channelFromHtml(
        `<html><head></head><body><meta itemprop="identifier" content="${channel}"><script>{"channelId":"${channel}"}</script></body></html>`,
      ),
    /CHANNEL_RESOLUTION_FAILED/,
  );
  assert.throws(
    () =>
      channelFromHtml(
        page().replace(
          '</head>',
          `<meta property="og:url" content="https://www.youtube.com/channel/UC${'c'.repeat(22)}"></head>`,
        ),
      ),
    /CHANNEL_RESOLUTION_FAILED/,
  );
  assert.throws(
    () => channelFromHtml('<head><title>Consent</title></head>'),
    /CHANNEL_RESOLUTION_FAILED/,
  );
});

test('YT-H02: handle resolution is bounded, anonymous, no redirects and canonical input needs no network', async () => {
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://www.youtube.com/@MeiTouJun');
    assert.equal(options!.redirect, 'manual');
    assert.equal(options!.method, 'GET');
    assert.ok(options!.signal);
    assert.equal(new Headers(options!.headers).has('Cookie'), false);
    assert.equal(new Headers(options!.headers).has('Authorization'), false);
    return new Response(page());
  };
  assert.equal(await resolveChannel(channel, request), channel);
  assert.equal(calls, 0);
  assert.equal(await resolveChannel('https://www.youtube.com/@MeiTouJun', request), channel);
  assert.equal(calls, 1);
  for (const [status, code] of [
    [404, 'CHANNEL_NOT_FOUND'],
    [429, 'YOUTUBE_RATE_LIMITED'],
    [403, 'YOUTUBE_ACCESS_BLOCKED'],
    [302, 'YOUTUBE_ACCESS_BLOCKED'],
  ] as const)
    await assert.rejects(
      resolveChannel(
        '@MeiTouJun',
        async () =>
          new Response('blocked', { status, headers: { Location: 'http://127.0.0.1/private' } }),
      ),
      new RegExp(code),
    );
  await assert.rejects(
    resolveChannel('@MeiTouJun', async () => {
      throw new Error('network including private details');
    }),
    /YOUTUBE_NETWORK_ERROR/,
  );
  await assert.rejects(
    resolveChannel('@MeiTouJun', async () => new Response('x'.repeat(4_000_001))),
    /CHANNEL_RESPONSE_TOO_LARGE/,
  );
  await assert.rejects(
    resolveChannel('@MeiTouJun', async () => new Response('<head></head>')),
    /CHANNEL_RESOLUTION_FAILED/,
  );
});

test('YT-H03: explicit proxy only tunnels to YouTube and dispatcher cannot fetch arbitrary origins', async (t) => {
  let target = '';
  const server = createServer();
  server.on('connect', (request, socket) => {
    target = request.url!;
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const proxy = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = youtubeTransport(proxy);
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
  });
  assert.throws(() => client.request('http://127.0.0.1/secret'), /YOUTUBE_REQUEST_BLOCKED/);
  assert.throws(
    () => client.request('https://www.youtube.com/', { method: 'POST' }),
    /YOUTUBE_REQUEST_BLOCKED/,
  );
  await assert.rejects(resolveChannel('@MeiTouJun', client.request), /YOUTUBE_NETWORK_ERROR/);
  assert.equal(target, 'www.youtube.com:443');
  for (const value of [
    'socks5://127.0.0.1:1080',
    'http://user:secret@localhost',
    'http://localhost/path',
  ])
    assert.throws(
      () => readConfig({ FEEDRELAY_DEMO: '1', YOUTUBE_PROXY_URL: value }),
      /INVALID_YOUTUBE_PROXY/,
    );
});

test('YT-H04: authenticated add awaits resolution, stores only canonical ID paused and deduplicates aliases', async (t) => {
  let calls = 0;
  const f = fixture(t, {
    resolveChannel: async (input) => {
      calls++;
      assert.equal(channelInput(input), '@fixture');
      return channel;
    },
  });
  const server = createApp(f.store, f.config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  let cookie = '',
    csrf = '';
  const call = async (path: string, body: object) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        Origin: f.config.origin,
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (response.headers.getSetCookie().length)
      cookie = response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    return response;
  };
  const source = {
    type: 'youtube',
    name: 'Handle channel',
    channel: 'https://www.youtube.com/@fixture',
  };
  assert.equal((await call('/sources', source)).status, 401);
  assert.equal(calls, 0);
  csrf = (await (await call('/login', { password: 'demo' })).json()).csrf;
  const response = await call('/sources', source);
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal(saved.channel, channel);
  assert.equal(saved.enabled, 0);
  assert.equal(saved.notify, 0);
  assert.equal(saved.initialized, 0);
  assert.equal(f.store.get('SELECT count(*) n FROM jobs')!.n, 0);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0);
  assert.equal(
    (await (await call('/sources', { ...source, channel: '@fixture' })).json()).error,
    'SOURCE_ALREADY_EXISTS',
  );
  f.engine.adapters.resolveChannel = async () => {
    throw new AppError('CHANNEL_NOT_FOUND', 502);
  };
  assert.equal((await call('/sources', { ...source, name: 'failed' })).status, 502);
  assert.equal(f.store.sources().length, 1);
  assert.throws(
    () => previewImport(f.store, { format: 'feedrelay.sources', version: 1, sources: [source] }),
    /CHANNEL_ID_REQUIRED/,
  );
});

test('YT-H05: demo handles are explicitly synthetic; no real handle network or implicit subscription', async (t) => {
  assert.equal(await resolveDemoChannel('https://youtube.com/@feedrelay-demo'), DEMO_CHANNEL);
  await assert.rejects(resolveDemoChannel('@MeiTouJun'), /DEMO_CHANNEL_HANDLE/);
  const f = fixture(t);
  const id = await f.engine.adapters.resolveChannel('@feedrelay-demo');
  const s = f.store.createSource({ type: 'youtube', name: '合成示例', channel: id });
  assert.equal(s.enabled, 0);
  assert.equal(f.store.get('SELECT count(*) n FROM jobs')!.n, 0);
});
