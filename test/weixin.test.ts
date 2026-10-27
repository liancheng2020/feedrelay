import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture, incoming } from './helpers.js';
import { readConfig } from '../server/config.js';
import { Weixin, weixinBase } from '../server/weixin.js';
import { Engine } from '../server/engine.js';
import { createApp } from '../server/app.js';
import { type Delivery } from '../server/store.js';
import { freezeDigest } from '../server/digest.js';
import { Aihot } from '../server/aihot.js';

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
  assert.equal((await api('/weixin/pair', { confirmed: true })).status, 401);
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

test('AC1: fresh context recovers after restart with the same identity and bounded attempts', async t => {
  const f = setup(t);
  await f.bind();
  await f.inbound();
  const item = f.store.put(incoming(), [f.source()], true, f.service.destination);
  const read = () => f.store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id)!;
  for (let n = 1; n <= 5; n++) {
    const d = f.store.claimDelivery(f.service.destination)!;
    assert.ok(d);
    f.send({ ret: -2 });
    f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
    f.service.recoverDeliveries();
    assert.equal(read().status, 'failed');
    f.advance(3600000);
    await f.inbound(f.now(), `context-${n}`);
    const restarted = new Weixin(f.store, f.config, f.request);
    restarted.recoverDeliveries();
    assert.equal(read().status, n < 5 ? 'retry_wait' : 'failed');
    assert.equal(read().attempt, n);
    assert.equal(read().id, d.id);
  }
  assert.equal(f.store.claimDelivery(f.service.destination), undefined);
  assert.equal(new Set(f.calls.filter(c => c.url.pathname.endsWith('sendmessage')).map(c => c.body.msg.client_id)).size, 1);
});

test('AC1: new inbound before rejection finishes is not lost; worker sends exactly once after recovery', async t => {
  const f = setup(t);
  await f.bind(); await f.inbound();
  const item = f.store.put(incoming(), [f.source()], true, f.service.destination);
  const d = f.store.claimDelivery(f.service.destination)!;
  let release!: () => void;
  f.service.request = async (url, init) => {
    if (String(url).endsWith('sendmessage')) {
      await new Promise<void>(r => { release = r; });
      return Response.json({ ret: -2 });
    }
    return f.request(url, init);
  };
  const sending = f.service.send(d.snapshot, d.id);
  f.advance(1); await f.inbound(f.now(), 'new-context');
  release();
  f.store.finishDelivery(d, await sending);
  assert.equal(f.service.describe().ready, true);
  f.advance(3600000);
  const engine = new Engine(f.store, f.config, { feed: async () => ({ unchanged: true, items: [] }) });
  engine.weixin.request = f.request;
  t.after(() => engine.stop());
  await engine.cycle(); await engine.cycle();
  const result = f.store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id)!;
  assert.equal(result.status, 'sent');
  assert.equal(result.attempt, 2);
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('sendmessage')).length, 1);
});

test('AC1: needs-message and legacy failures require a subsequent valid context', async t => {
  const f = setup(t);
  await f.bind();
  const item = f.store.put(incoming(), [f.source()], true, f.service.destination);
  const d = f.store.claimDelivery(f.service.destination)!;
  f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id)!.error, 'WEIXIN_NEEDS_MESSAGE');
  await f.inbound(); f.service.recoverDeliveries();
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'retry_wait');
  f.store.run("UPDATE deliveries SET status='failed',error='WEIXIN_CONTEXT_REJECTED' WHERE id=?", d.id);
  f.store.run('DELETE FROM meta WHERE key=?', `weixin-context:${d.id}`);
  f.service.recoverDeliveries();
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'failed');
  await f.inbound(f.now() - 1, 'stale'); f.service.recoverDeliveries();
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'failed');
  f.advance(1); await f.inbound(f.now(), 'fresh'); f.service.recoverDeliveries();
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'retry_wait');
});

for (const boundary of ['unknown', 'cancelled', 'expired', 'deleted', 'source-disabled', 'generation', 'old-target'] as const) {
  test(`AC1: recovery excludes ${boundary}`, async t => {
    const f = setup(t); await f.bind(); await f.inbound();
    const source = f.source();
    const item = f.store.put(incoming(), [source], true, f.service.destination);
    const d = f.store.claimDelivery(f.service.destination)!;
    f.send({ ret: -2 }); f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
    if (boundary === 'unknown' || boundary === 'cancelled') f.store.run('UPDATE deliveries SET status=? WHERE id=?', boundary, d.id);
    if (boundary === 'expired') f.store.run('UPDATE items SET expired=1 WHERE id=?', item.id);
    if (boundary === 'deleted') f.store.deleteItem(item.id);
    if (boundary === 'source-disabled') f.store.toggle(source.id, false, false);
    if (boundary === 'generation') f.store.toggle(source.id, true, true);
    if (boundary === 'old-target') await f.bind(true);
    f.advance(3600000); await f.inbound(f.now(), 'fresh'); f.service.recoverDeliveries();
    assert.notEqual(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'retry_wait');
    assert.equal(f.store.claimDelivery(f.service.destination), undefined);
  });
}

for (const disable of [false, true]) {
  test(`AC1/2: bound but unready daily freezes safely; disabled=${disable}`, async t => {
    const f = setup(t); await f.bind();
    const engine = new Engine(f.store, f.config, { feed: async () => ({ unchanged: true, items: [] }) });
    engine.weixin.request = f.request;
    let calls = 0;
    engine.aihot = new Aihot(f.store, async () => {
      calls++;
      return Response.json({ report: { date: '2026-10-17', sections: [{ items: [{ title: 'Synthetic daily' }] }] } });
    });
    t.after(() => engine.stop());
    engine.aihot.configure(true); f.advance(22 * 3600000); await engine.cycle();
    assert.equal(calls, 1); assert.equal(f.store.get('SELECT status FROM deliveries')!.status, 'pending');
    await f.inbound(); f.send({ ret: -2 }); await engine.cycle();
    assert.equal(f.store.get('SELECT status FROM deliveries')!.status, 'failed');
    if (disable) { engine.aihot.configure(false); engine.aihot.configure(true); }
    f.advance(3600000); await f.inbound(f.now(), 'fresh'); f.send({ ret: 0 });
    await engine.cycle();
    assert.equal(f.store.get('SELECT status FROM deliveries')!.status, disable ? 'cancelled' : 'sent');
  });
}

test('AC2: unbound Weixin does not fetch daily reports', async t => {
  const f = setup(t);
  const engine = new Engine(f.store, f.config);
  engine.aihot = new Aihot(f.store, async () => { assert.fail('must not fetch'); });
  t.after(() => engine.stop());
  engine.aihot.configure(true); f.advance(22 * 3600000); await engine.cycle();
  assert.equal(f.store.get('SELECT count(*) n FROM digest_batches')!.n, 0);
});

for (const digest of [false, true]) {
  test(`AC1: revoked summary consent cannot resend retained snapshot, digest=${digest}`, async t => {
    const f = setup(t); await f.bind(); await f.inbound();
    const source = f.source();
    const summaries = f.engine.summaries;
    summaries.destination = f.service.destination;
    summaries.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
    summaries.authorize(source.id, 'auto', false, true, 'captions');
    if (digest) {
      f.store.changeDeliveryMode(source.id, 'digest');
      f.store.setSettings({ ...f.store.settings(), digestTime: '12:00' });
    }
    f.advance(1);
    const item = f.store.put(incoming(), [f.store.source(source.id)], true, f.service.destination);
    summaries.enqueue(item.id);
    await summaries.cycle(f.service.destination);
    summaries.reconcile();
    if (digest) { f.advance(86400000); freezeDigest(f.store, f.service.destination); }
    const d = f.store.claimDelivery(f.service.destination)!;
    assert.ok(d); assert.match(d.snapshot, /模拟摘要/);
    f.send({ ret: -2 }); f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
    summaries.authorize(source.id, 'off', false, true);
    f.advance(3600000); await f.inbound(f.now(), 'fresh'); f.service.recoverDeliveries();
    summaries.reconcile();
    assert.equal(f.store.claimDelivery(f.service.destination), undefined);
    assert.notEqual(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'sending');
  });
}

for (const revoke of [false, true]) {
  test(`AC1: ordinary digest recovery, member revoked=${revoke}`, async t => {
    const f = setup(t); await f.bind(); await f.inbound();
    const source = f.source(); f.store.changeDeliveryMode(source.id, 'digest');
    f.store.setSettings({ ...f.store.settings(), digestTime: '12:00' });
    f.store.put(incoming(), [f.store.source(source.id)], true, f.service.destination);
    freezeDigest(f.store, f.service.destination);
    const d = f.store.claimDelivery(f.service.destination)!;
    assert.equal(d.mode, 'digest_part');
    f.send({ ret: -2 }); f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
    if (revoke) f.store.toggle(source.id, false, false);
    f.advance(3600000); await f.inbound(f.now(), 'fresh'); f.service.recoverDeliveries();
    assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, revoke ? 'cancelled' : 'retry_wait');
    assert.equal(!!f.store.claimDelivery(f.service.destination), !revoke);
  });
}

for (const digest of [false, true]) {
  test(`AC1: notification disable and reenable never restores old failures, digest=${digest}`, async t => {
    const f = setup(t); await f.bind(); await f.inbound();
    const source = f.source();
    if (digest) {
      f.store.changeDeliveryMode(source.id, 'digest');
      f.store.setSettings({ ...f.store.settings(), digestTime: '12:00' });
    }
    f.store.put(incoming(), [f.store.source(source.id)], true, f.service.destination);
    if (digest) freezeDigest(f.store, f.service.destination);
    const d = f.store.claimDelivery(f.service.destination)!;
    f.send({ ret: -2 }); f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
    f.store.toggle(source.id, true, false);
    f.store.toggle(source.id, true, true);
    f.advance(3600000); await f.inbound(f.now(), 'fresh'); f.service.recoverDeliveries();
    assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'cancelled');
    assert.equal(f.store.claimDelivery(f.service.destination), undefined);
  });
}

test('AC1: revoking only summary push preserves analysis but cancels failed output permanently', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  const source = f.source('youtube', false), summaries = f.engine.summaries;
  summaries.destination = f.service.destination;
  summaries.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  summaries.authorize(source.id, 'manual', true, true, 'captions');
  f.advance(1);
  const item = f.store.put(incoming(), [f.store.source(source.id)], false, f.service.destination);
  summaries.enqueue(item.id); await summaries.cycle(f.service.destination);
  const row = summaries.list(item.id)[0];
  summaries.pushLatest(item.id, row.id, row.revision);
  const d = f.store.claimDelivery(f.service.destination)!;
  f.send({ ret: -2 }); f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
  summaries.authorize(source.id, 'manual', false, true, 'captions');
  summaries.authorize(source.id, 'manual', true, true, 'captions');
  f.advance(3600000); await f.inbound(f.now(), 'fresh'); f.service.recoverDeliveries();
  summaries.reconcile();
  assert.equal(summaries.list(item.id)[0].status, 'succeeded');
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'cancelled');
  assert.equal(f.store.claimDelivery(f.service.destination), undefined);
});

for (const kind of ['immediate', 'digest', 'summary', 'aihot'] as const) {
  for (const outcome of ['rejected', 'unknown', 'sent', 'before-send'] as const) {
    test(`AC1: in-flight revocation is durable, ${kind}/${outcome}`, async t => {
      const f = setup(t); await f.bind(); await f.inbound();
      const summaries = f.engine.summaries;
      let revoke!: () => void;
      if (kind === 'aihot') {
        const daily = new Aihot(f.store, async () => Response.json({ report: {
          date: '2026-10-17', sections: [{ items: [{ title: 'Synthetic daily' }] }],
        } }));
        daily.configure(true); f.advance(22 * 3600000); await daily.cycle(f.service.destination);
        revoke = () => { daily.configure(false); daily.configure(true); };
      } else {
        const source = f.source('youtube', kind !== 'summary');
        if (kind === 'summary') {
          summaries.destination = f.service.destination;
          summaries.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
          summaries.authorize(source.id, 'manual', true, true, 'captions');
          f.advance(1);
          const item = f.store.put(incoming(), [f.store.source(source.id)], false, f.service.destination);
          summaries.enqueue(item.id); await summaries.cycle(f.service.destination);
          const row = summaries.list(item.id)[0]; summaries.pushLatest(item.id, row.id, row.revision);
          revoke = () => {
            summaries.authorize(source.id, 'manual', false, true, 'captions');
            summaries.authorize(source.id, 'manual', true, true, 'captions');
          };
        } else {
          if (kind === 'digest') {
            f.store.changeDeliveryMode(source.id, 'digest');
            f.store.setSettings({ ...f.store.settings(), digestTime: '12:00' });
          }
          f.store.put(incoming(), [f.store.source(source.id)], true, f.service.destination);
          if (kind === 'digest') freezeDigest(f.store, f.service.destination);
          revoke = () => { f.store.toggle(source.id, true, false); f.store.toggle(source.id, true, true); };
        }
      }
      const d = f.store.claimDelivery(f.service.destination)!; assert.ok(d);
      let release!: () => void, sends = 0;
      f.service.request = async (url, init) => {
        if (String(url).endsWith('sendmessage')) {
          sends++;
          await new Promise<void>(r => { release = r; });
          return Response.json(outcome === 'sent' ? { ret: 0 } : outcome === 'unknown' ? {} : { ret: -2 });
        }
        return f.request(url, init);
      };
      if (outcome === 'before-send') revoke();
      const work = f.service.send(d.snapshot, d.id);
      if (outcome !== 'before-send') { revoke(); release(); }
      f.store.finishDelivery(d, await work);
      f.advance(3600000); await f.inbound(f.now(), 'fresh');
      const restarted = new Weixin(f.store, f.config, f.request);
      restarted.recoverDeliveries(); summaries.reconcile();
      assert.equal(f.store.claimDelivery(f.service.destination), undefined);
      const settled = f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!;
      assert.equal(settled.status, outcome === 'sent' || outcome === 'unknown' ? outcome : 'failed');
      assert.equal(sends, outcome === 'before-send' ? 0 : 1);
      if (outcome === 'before-send') assert.equal(settled.error, 'DELIVERY_AUTHORIZATION_REVOKED');
      if (outcome === 'rejected') {
        f.store.resolveDelivery(d.id, 'retry', f.service.destination);
        assert.equal(f.store.get('SELECT 1 FROM meta WHERE key=?', `weixin-context:${d.id}`), undefined);
        const manual = f.store.claimDelivery(f.service.destination)!;
        revoke();
        f.store.finishDelivery(manual, await restarted.send(manual.snapshot, manual.id));
        assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.error, 'DELIVERY_AUTHORIZATION_REVOKED');
      }
    });
  }
}

test('AC1: another authorized source keeps recovery valid until its last notification is revoked', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  const a = f.source();
  const b = f.store.createSource({ type: 'youtube', name: 'Other', channel: 'UC' + 'b'.repeat(22) });
  f.store.toggle(b.id, true, true);
  f.store.put(incoming(), [a, f.store.source(b.id)], true, f.service.destination);
  const d = f.store.claimDelivery(f.service.destination)!;
  f.store.toggle(a.id, true, false);
  assert.equal(f.store.get('SELECT 1 FROM meta WHERE key=?', `weixin-context:${d.id}`), undefined);
  f.send({ ret: -2 }); f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
  f.advance(3600000); await f.inbound(f.now(), 'fresh'); f.service.recoverDeliveries();
  const retry = f.store.claimDelivery(f.service.destination)!; assert.ok(retry);
  f.store.toggle(b.id, true, false); f.store.toggle(b.id, true, true);
  f.store.finishDelivery(retry, await f.service.send(retry.snapshot, retry.id));
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.error, 'DELIVERY_AUTHORIZATION_REVOKED');
});
