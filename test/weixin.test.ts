import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture, incoming } from './helpers.js';
import { readConfig } from '../server/config.js';
import { Weixin, weixinBase } from '../server/weixin.js';
import { Engine } from '../server/engine.js';
import { createApp } from '../server/app.js';

const user = 'synthetic-user@im.wechat',
  bot = 'synthetic-bot@im.bot';
const token = 'synthetic-bot-secret',
  context = 'synthetic-context-secret';
function setup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t);
  const config = { ...f.config, demo: false, pushChannel: 'weixin' as const };
  const calls: { url: URL; init: RequestInit; body: any }[] = [];
  let send: unknown = { ret: 0 },
    poll: any = { ret: 0, msgs: [], get_updates_buf: 'cursor-1' };
  let pair: any = {
    status: 'confirmed',
    bot_token: token,
    ilink_bot_id: bot,
    ilink_user_id: user,
    baseurl: 'https://ilinkai.weixin.qq.com',
  };
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname.endsWith('get_bot_qrcode'))
      return Response.json({
        qrcode: 'synthetic-qr',
        qrcode_img_content: 'https://ilinkai.weixin.qq.com/synthetic-qr',
      });
    if (url.pathname.endsWith('get_qrcode_status')) return Response.json(pair);
    if (url.pathname.endsWith('getupdates')) return Response.json(poll);
    if (url.pathname.endsWith('sendmessage')) {
      if (send instanceof Error) throw send;
      if (send instanceof Response) return send;
      return Response.json(send);
    }
    throw new Error('UNEXPECTED_REQUEST');
  };
  const service = new Weixin(f.store, config, request);
  async function bind(replace = false) {
    const qr = await service.begin(replace);
    await service.pollPair(qr.id);
    return qr;
  }
  async function inbound(time = f.now(), value = context) {
    poll = {
      ret: 0,
      msgs: [
        {
          message_type: 1,
          from_user_id: user,
          to_user_id: bot,
          create_time_ms: time,
          context_token: value,
          item_list: [{ type: 1, text_item: { text: 'private text not to retain' } }],
        },
      ],
      get_updates_buf: 'cursor-2',
    };
    await service.pollUpdates();
  }
  return {
    ...f,
    config,
    calls,
    request,
    service,
    bind,
    inbound,
    send: (value: unknown) => {
      send = value;
    },
    poll: (value: unknown) => {
      poll = value;
    },
    pair: (value: unknown) => {
      pair = value;
    },
  };
}

test('WX-01: fixed trusted HTTPS hosts, anonymous QR and protocol headers; secrets never leave status', async (t) => {
  const f = setup(t);
  assert.equal(readConfig({ FEEDRELAY_DEMO: '1' }).pushChannel, 'feishu');
  assert.throws(
    () => readConfig({ FEEDRELAY_DEMO: '1', PUSH_CHANNEL: 'other' }),
    /INVALID_PUSH_CHANNEL/,
  );
  for (const host of [
    'http://ilinkai.weixin.qq.com',
    'https://ilinkai.weixin.qq.com.evil.test',
    'https://user:secret@ilinkai.weixin.qq.com',
    'https://127.0.0.1',
    'https://ilinkai.weixin.qq.com:8888',
    'https://ilinkai.weixin.qq.com/path',
  ])
    assert.throws(() => weixinBase(host));
  assert.equal(weixinBase('https://ilinkai.weixin.qq.com/'), 'https://ilinkai.weixin.qq.com');
  const qr = await f.bind();
  assert.match(qr.image, /^data:image\/png;base64,/);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), null);
  assert.equal(new Headers(f.calls[0].init.headers).get('iLink-App-Id'), 'bot');
  assert.equal(f.calls[1].init.method, 'GET');
  assert.equal(f.calls[1].init.redirect, 'error');
  assert.equal(f.service.describe().bound, true);
  assert.equal(f.service.describe().ready, false);
  assert.equal(f.service.describe().error, 'WEIXIN_NEEDS_MESSAGE');
  const encrypted = JSON.stringify(f.store.all('SELECT * FROM meta'));
  assert(!encrypted.includes(token));
  assert(!encrypted.includes(user));
  assert(!JSON.stringify(f.service.describe()).includes(token));
  const restored = new Weixin(f.store, f.config, f.request);
  assert.equal(restored.destination, f.service.destination);
  assert.equal(restored.describe().bound, true);
  await assert.rejects(f.service.begin(), /REPLACE_CONFIRMATION/);
});

test('WX-02: pairing status, verification code, trusted redirect, expiry and cancellation fence stale responses', async (t) => {
  const f = setup(t),
    qr = await f.service.begin();
  f.pair({ status: 'need_verifycode' });
  assert.equal((await f.service.pollPair(qr.id)).status, 'need_verifycode');
  await assert.rejects(f.service.pollPair(qr.id, '12bad'), /INVALID_PAIR_CODE/);
  f.pair({ status: 'scaned_but_redirect', redirect_host: 'ilinkai2.weixin.qq.com' });
  await f.service.pollPair(qr.id, '123456');
  assert.equal(f.calls.at(-1)!.url.searchParams.get('verify_code'), '123456');
  f.pair({ status: 'wait' });
  await f.service.pollPair(qr.id);
  assert.equal(f.calls.at(-1)!.url.host, 'ilinkai2.weixin.qq.com');
  f.pair({ status: 'scaned_but_redirect', redirect_host: '127.0.0.1' });
  await assert.rejects(f.service.pollPair(qr.id), /UNTRUSTED_HOST/);
  f.service.cancelPair('another-tab');
  f.pair({ status: 'wait' });
  assert.equal((await f.service.pollPair(qr.id)).status, 'wait');
  let release!: () => void;
  f.service.request = async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return Response.json({
      status: 'confirmed',
      bot_token: token,
      ilink_bot_id: bot,
      ilink_user_id: user,
    });
  };
  const pending = f.service.pollPair(qr.id);
  f.service.cancelPair(qr.id);
  release();
  await assert.rejects(pending, /PAIR_EXPIRED/);
  assert.equal(f.service.describe().bound, false);
  f.service.request = f.request;
  const expired = await f.service.begin();
  f.advance(120001);
  await assert.rejects(f.service.pollPair(expired.id), /PAIR_EXPIRED/);
});

test('WX-03: only fresh direct messages from the QR owner update persistent context; no command/model execution', async (t) => {
  const f = setup(t);
  await f.bind();
  f.poll({
    ret: 0,
    get_updates_buf: 'foreign',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'stranger',
        context_token: context,
        create_time_ms: f.now(),
      },
      {
        message_type: 1,
        from_user_id: user,
        group_id: 'a-group',
        context_token: context,
        create_time_ms: f.now(),
      },
      { message_type: 2, from_user_id: user, context_token: context, create_time_ms: f.now() },
    ],
  });
  await f.service.pollUpdates();
  assert.equal(f.service.describe().ready, false);
  await f.inbound();
  assert.equal(f.service.describe().ready, true);
  assert.equal(f.service.describe().lastInbound, f.now());
  await f.inbound(f.now() - 1000, 'old-context');
  await f.service.send('test', 'stable-id');
  const sent = f.calls.at(-1)!;
  assert.equal(sent.body.msg.to_user_id, user);
  assert.equal(sent.body.msg.context_token, context);
  assert.equal(sent.body.msg.client_id, 'feedrelay-stable-id');
  assert.equal(sent.body.msg.item_list[0].text_item.text, 'test');
  assert.equal(new Headers(sent.init.headers).get('authorization'), `Bearer ${token}`);
  assert.equal(f.store.get('SELECT count(*) n FROM model_calls')!.n, 0);
  assert(!JSON.stringify(f.store.all('SELECT * FROM meta')).includes('private text not to retain'));
});

test('WX-04: HTTP success is not delivery success, rejected context blocks sends until fresh inbound; unknown is not retried', async (t) => {
  const f = setup(t);
  await f.bind();
  await f.inbound();
  assert.equal((await f.service.send('test', 'ok')).status, 'sent');
  f.send({ ret: -2, errmsg: 'private server detail' });
  assert.equal((await f.service.send('test', 'rejected')).code, 'WEIXIN_CONTEXT_REJECTED');
  assert.equal(f.service.describe().ready, false);
  const count = f.calls.length;
  await f.service.send('test', 'blocked');
  assert.equal(f.calls.length, count);
  f.advance(1);
  await f.inbound(f.now(), 'fresh-context');
  f.send({});
  assert.equal((await f.service.send('test', 'missing-ret')).status, 'unknown');
  for (const message_id of [123, '9223372036854775801']) {
    f.send({ message_id });
    assert.equal((await f.service.send('test', 'message-id')).status, 'sent');
  }
  for (const message_id of [0, -1, '', 'bad', null, {}, 1.5]) {
    f.send({ message_id });
    assert.equal((await f.service.send('test', 'bad-message-id')).status, 'unknown');
  }
  f.send({ message_id: 123, errcode: 42 });
  assert.equal((await f.service.send('test', 'error-wins')).status, 'failed');
  f.send({ message_id: 123, ret: 42 });
  assert.equal((await f.service.send('test', 'ret-error-wins')).status, 'failed');
  f.send({ message_id: 123, errmsg: 'unexpected response' });
  assert.equal((await f.service.send('test', 'message-error')).status, 'unknown');
  f.send(new Error('private network details'));
  assert.deepEqual(
    (({ status, code }) => ({ status, code }))(await f.service.send('test', 'network')),
    { status: 'unknown', code: 'WEIXIN_SEND_UNCONFIRMED' },
  );
  f.send(new Response('busy', { status: 429 }));
  assert.equal((await f.service.send('test', 'limited')).status, 'retry_wait');
  f.send(new Response('failure', { status: 500 }));
  assert.equal((await f.service.send('test', 'server-error')).status, 'unknown');
  f.send({ ret: -14 });
  assert.equal((await f.service.send('test', 'expired')).code, 'WEIXIN_SESSION_EXPIRED');
  assert.equal(f.service.describe().ready, false);
});

test('WX-05: replacement binds a new destination; old-target tasks cannot leak, corrupt state can be cleared', async (t) => {
  const f = setup(t);
  await f.bind();
  await f.inbound();
  const before = f.service.destination;
  await f.bind(true);
  await f.inbound();
  assert.notEqual(f.service.destination, before);
  const count = f.calls.length;
  assert.equal(
    (await f.service.send('old private text', 'old', before)).code,
    'WEIXIN_DESTINATION_CHANGED',
  );
  assert.equal(f.calls.length, count);
  const wrongKey = new Weixin(f.store, { ...f.config, sessionSecret: 'another-secret' });
  assert.equal(wrongKey.describe().error, 'WEIXIN_LOCAL_STATE_INVALID');
  wrongKey.disconnect();
  assert.equal(wrongKey.describe().bound, false);
});

test('WX-06: selected Weixin uses existing delivery and attempt ledger, not Feishu; missing context leaves pending', async (t) => {
  const f = setup(t),
    engine = new Engine(f.store, f.config, {
      feed: async () => ({ unchanged: false, items: [], etag: '', modified: '' }),
    });
  engine.weixin.request = f.request;
  t.after(() => engine.stop());
  const qr = await engine.weixin.begin();
  await engine.weixin.pollPair(qr.id);
  const source = f.source();
  const item = f.store.put(incoming(), [source], true, engine.destination);
  await engine.cycle();
  assert.equal(
    f.store.get('SELECT status FROM deliveries WHERE item_id=?', item.id)!.status,
    'pending',
  );
  await f.inbound();
  await engine.cycle();
  assert.equal(
    f.store.get('SELECT status FROM deliveries WHERE item_id=?', item.id)!.status,
    'sent',
  );
  assert.equal(f.store.get('SELECT count(*) n FROM attempts')!.n, 1);
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith('sendmessage')).length, 1);
  assert(f.calls.every((c) => c.url.hostname.endsWith('.weixin.qq.com')));
});

test('WX-07: API binding and test sends require auth, Origin, CSRF and explicit confirmation; overview never returns tokens', async (t) => {
  const f = setup(t),
    engine = new Engine(f.store, f.config);
  engine.weixin.request = f.request;
  const server = createApp(f.store, f.config, engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await engine.stop();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  let cookie = '',
    csrf = '';
  async function api(path: string, body?: unknown) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: f.config.origin,
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    return response;
  }
  assert.equal((await api('/weixin/pair', { confirmed: true })).status, 403);
  const login = await api('/login', { password: 'demo' });
  csrf = (await login.json()).csrf;
  assert.equal((await api('/weixin/pair', {})).status, 400);
  const qr = await (await api('/weixin/pair', { confirmed: true })).json();
  assert.equal((await api('/settings/test-push', { confirmed: true })).status, 503);
  const paired = await (await api('/weixin/pair/status', { id: qr.id })).json();
  assert.equal(paired.status, 'confirmed');
  await f.inbound();
  assert.equal((await api('/settings/test-push', {})).status, 400);
  assert.equal((await api('/settings/test-feishu', { confirmed: true })).status, 400);
  assert.equal((await api('/settings/test-push', { confirmed: true })).status, 202);
  const overview = await (await api('/overview')).json();
  assert.equal(overview.connections.channel, 'weixin');
  assert.equal(overview.connections.pushReady, true);
  assert.equal(overview.connections.recipient, f.service.describe().recipient);
  for (const secret of [token, context, user]) assert(!JSON.stringify(overview).includes(secret));
});

test('WX-08: inbound poll aborts on shutdown and does not start in demo mode', async (t) => {
  const f = setup(t);
  await f.bind();
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  f.service.request = async (_url, init) => {
    entered();
    await new Promise<void>((_r, reject) =>
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
    return Response.json({ ret: 0, msgs: [] });
  };
  f.service.start();
  await ready;
  await f.service.stop();
  const demo = new Weixin(
    f.store,
    f.config.demo ? f.config : { ...f.config, demo: true },
    async () => {
      throw new Error('DEMO_NETWORK');
    },
  );
  demo.start();
  await demo.stop();
});

test('WX-09: live polling envelope can omit ret, but empty or malformed responses cannot refresh state', async (t) => {
  const f = setup(t);
  await f.bind();
  f.poll({
    msgs: [
      {
        message_type: 1,
        from_user_id: user,
        to_user_id: bot,
        context_token: context,
        create_time_ms: f.now(),
      },
    ],
    get_updates_buf: 'live-cursor',
    sync_buf: 'legacy',
  });
  await f.service.pollUpdates();
  assert.equal(f.service.describe().ready, true);
  f.poll({ msgs: [], get_updates_buf: 'next-cursor' });
  await f.service.pollUpdates();
  assert.equal(f.service.describe().ready, true);
  f.poll({});
  await assert.rejects(f.service.pollUpdates(), /WEIXIN_INVALID_RESPONSE/);
});
