import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fixture, incoming } from './helpers.js';
import { readConfig } from '../server/config.js';
import { Weixin, weixinBase } from '../server/weixin.js';
import { Engine } from '../server/engine.js';
import { createApp } from '../server/app.js';
import { Store, type Delivery } from '../server/store.js';
import { diagnostics } from '../server/diagnostics.js';
import { freezeDigest } from '../server/digest.js';
import { Aihot } from '../server/aihot.js';

const user = 'synthetic-user@im.wechat',
  bot = 'synthetic-bot@im.bot';
const token = 'synthetic-bot-secret',
  context = 'synthetic-context-secret';
// Reproduce encrypted legacy state using only the temporary synthetic fixture.
function legacyAccount(f: ReturnType<typeof setup>, fields: Record<string, unknown> = {}) {
  const key = createHash('sha256').update(`feedrelay-weixin:${f.config.sessionSecret}`).digest();
  const data = Buffer.from(f.store.get<{ value: string }>('SELECT value FROM meta WHERE key=?', 'weixin_account')!.value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  const account = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
  delete account.retryPolicy;
  Object.assign(account, fields);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(account)), cipher.final()]);
  f.store.run('UPDATE meta SET value=? WHERE key=?', Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'), 'weixin_account');
}
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

test('WX-04: HTTP success is not delivery success; rejection cools down even after inbound; unknown is not retried', async (t) => {
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
  assert.equal(f.service.describe().ready, false);
  f.advance(3599999);
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

test('AC1/3: hourly recovery exceeds five attempts with the same identity, then succeeds once', async t => {
  const f = setup(t);
  await f.bind();
  await f.inbound();
  const item = f.store.put(incoming(), [f.source()], true, f.service.destination);
  const read = () => f.store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id)!;
  for (let n = 1; n <= 8; n++) {
    const d = f.store.claimDelivery(f.service.destination, 24)!;
    assert.ok(d);
    f.send({ ret: -2 });
    f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
    f.service.recoverDeliveries();
    assert.equal(read().status, 'failed');
    const wait = 3600000;
    assert.equal(f.service.describe().nextRetryAt, f.now() + wait);
    f.advance(wait - 1);
    const restarted = new Weixin(f.store, f.config, f.request);
    restarted.recoverDeliveries();
    assert.equal(read().status, 'failed');
    assert.equal(restarted.describe().ready, false);
    f.advance(1);
    restarted.recoverDeliveries();
    assert.equal(restarted.describe().ready, true);
    assert.equal(read().status, 'retry_wait');
    assert.equal(read().attempt, n);
    assert.equal(read().id, d.id);
  }
  assert.equal(new Set(f.calls.filter(c => c.url.pathname.endsWith('sendmessage')).map(c => c.body.msg.client_id)).size, 1);
  const next = f.store.claimDelivery(f.service.destination, 24)!;
  assert.ok(next);
  assert.equal(next.attempt, 9);
  f.send({ ret: 0 });
  f.store.finishDelivery(next, await f.service.send(next.snapshot, next.id));
  assert.equal(read().status, 'sent');
  f.service.recoverDeliveries();
  assert.equal(f.store.claimDelivery(f.service.destination, 24), undefined);
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
  assert.equal(f.service.describe().ready, false);
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

test('AC1: needs-message requires context but legacy rejection recovers once from its original attempt time', async t => {
  const f = setup(t);
  await f.bind();
  const item = f.store.put(incoming(), [f.source()], true, f.service.destination);
  const d = f.store.claimDelivery(f.service.destination)!;
  f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id)!.error, 'WEIXIN_NEEDS_MESSAGE');
  await f.inbound(); f.service.recoverDeliveries();
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'retry_wait');
  f.store.run("UPDATE deliveries SET status='failed',error='WEIXIN_CONTEXT_REJECTED' WHERE id=?", d.id);
  f.store.run("UPDATE attempts SET code='WEIXIN_CONTEXT_REJECTED' WHERE delivery_id=?", d.id);
  f.store.run('DELETE FROM meta WHERE key=?', `weixin-context:${d.id}`);
  legacyAccount(f);
  f.service.recoverDeliveries();
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'failed');
  await f.inbound(f.now() - 1, 'stale'); f.service.recoverDeliveries();
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'failed');
  f.advance(1); await f.inbound(f.now(), 'fresh'); f.service.recoverDeliveries();
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'failed');
  f.advance(3599999); f.service.recoverDeliveries();
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

test('AC1/2: account cooldown survives reopened DB and fresh inbound, using store fake clock not wall clock', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2099-01-01') });
  const f = setup(t); await f.bind(); await f.inbound();
  f.send({ errcode: -2 });
  assert.equal((await f.service.send('synthetic', 'rejected')).status, 'failed');
  const deadline = f.now() + 3600000;
  const reopened = new Store(f.dir, 'demo', f.now);
  t.after(() => reopened.close());
  const restarted = new Weixin(reopened, f.config, f.request);
  assert.equal(restarted.describe().nextRetryAt, deadline);
  f.advance(1000); await f.inbound(f.now(), 'new-context');
  for (let n = 0; n < 3; n++) {
    await f.service.pollUpdates(); restarted.recoverDeliveries();
    assert.equal(restarted.describe().nextRetryAt, deadline);
  }
  f.advance(3598999);
  const calls = f.calls.length;
  assert.equal((await restarted.send('synthetic', 'blocked')).code, 'WEIXIN_CONTEXT_REJECTED');
  assert.equal(f.calls.length, calls);
  f.advance(1); f.send({ ret: 0 });
  assert.equal((await restarted.send('synthetic', 'recovered')).status, 'sent');
  assert.equal(restarted.describe().nextRetryAt, 0);
  f.send({ ret: -2 }); await restarted.send('synthetic', 'reject-again');
  assert.equal(restarted.describe().nextRetryAt, f.now() + 3600000);
});

test('AC1: engine rejection sends once and leaves later tasks at attempt zero; quota still gates recovery', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  const source = f.source();
  for (let n = 0; n < 5; n++) f.store.put(incoming(`youtube:queued-${n}`), [source], true, f.service.destination);
  const engine = new Engine(f.store, f.config, { feed: async () => ({ unchanged: true, items: [] }) });
  engine.weixin.request = f.request;
  t.after(() => engine.stop());
  f.store.setSettings({ ...f.store.settings(), dailyLimit: 1 });
  f.send({ ret: -2 }); await engine.cycle(); await engine.cycle();
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('sendmessage')).length, 1);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries WHERE attempt=0 AND status=\'pending\'')!.n, 4);
  assert.equal(f.store.get('SELECT count(*) n FROM attempts')!.n, 1);
  f.advance(3600000); f.send({ ret: 0 }); await engine.cycle();
  assert.equal(f.store.get('SELECT count(*) n FROM attempts')!.n, 1);
  assert.equal(f.service.describe().ready, true);
});

test('AC1/2: overdue legacy rejection expires at its created day, never recovers next day', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  const item = f.store.put(incoming(), [f.source()], true, f.service.destination);
  const d = f.store.claimDelivery(f.service.destination)!;
  f.store.finishDelivery(d, { status: 'failed', code: 'WEIXIN_CONTEXT_REJECTED' });
  legacyAccount(f);
  f.advance(20 * 3600000);
  f.store.run('INSERT INTO attempts(id,delivery_id,n,day,at,status,code) VALUES (?,?,?,?,?,?,?)',
    'later-blocked', d.id, 2, 'synthetic', f.now(), 'failed', 'WEIXIN_POLL_FAILED');
  f.service.recoverDeliveries();
  assert.equal(f.service.describe().nextRetryAt, 0);
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'cancelled');
  for (let n = 0; n < 3; n++) {
    const restarted = new Weixin(f.store, f.config, f.request);
    restarted.recoverDeliveries();
    assert.equal(restarted.describe().nextRetryAt, 0);
  }
  assert.equal(f.store.claimDelivery(f.service.destination), undefined);
});

test('AC2/3: poll failure is not a send gate; session expiry and missing context require action; diagnostics report deadline', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  const engine = new Engine(f.store, f.config);
  t.after(() => engine.stop());
  f.poll({ ret: 42 }); await assert.rejects(f.service.pollUpdates(), /POLL_FAILED/);
  assert.equal(f.service.describe().ready, true);
  assert.equal((await f.service.send('synthetic', 'poll-error')).status, 'sent');
  f.send({ ret: -2 }); await f.service.send('synthetic', 'refused');
  const push = diagnostics(engine);
  assert.equal(push.push.reason, 'WEIXIN_CONTEXT_REJECTED');
  assert.equal(push.push.nextRetryAt, f.now() + 3600000);
  assert.match(push.checks.find(c => c.id === 'push')!.detail, /可能上下文或发送限制.*下次自动重试/);
  f.advance(3600000);
  assert.match(diagnostics(engine).checks.find(c => c.id === 'push')!.detail, /待后台调度/);
  f.poll({ errcode: -14 }); await assert.rejects(f.service.pollUpdates());
  const calls = f.calls.length;
  f.advance(24 * 3600000);
  assert.equal((await f.service.send('synthetic', 'expired')).code, 'WEIXIN_SESSION_EXPIRED');
  assert.equal(f.calls.length, calls);
  assert.equal(diagnostics(engine).push.nextRetryAt, 0);
});

test('AC2: old successful response does not clear newer cooldown or session expiry', async t => {
  for (const code of [-2, -14]) {
    const f = setup(t); await f.bind(); await f.inbound();
    let release!: () => void;
    const request = f.service.request;
    f.service.request = async (url, init) => {
      if (String(url).endsWith('sendmessage')) {
        await new Promise<void>(r => { release = r; });
        return Response.json({ ret: 0 });
      }
      return request(url, init);
    };
    const old = f.service.send('synthetic', 'old');
    const other = new Weixin(f.store, f.config, f.request);
    f.send({ ret: code }); await other.send('synthetic', 'new');
    const before = other.describe();
    release(); assert.equal((await old).status, 'sent');
    assert.equal(other.describe().ready, false);
    assert.equal(other.describe().error, before.error);
    assert.equal(other.describe().nextRetryAt, before.nextRetryAt);
  }
});

test('AC1: legacy cooldown includes the latest explicit refusal even after its task is cancelled', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  const a = f.source();
  f.store.put(incoming('youtube:older-refusal'), [a], true, f.service.destination);
  const old = f.store.claimDelivery(f.service.destination)!;
  f.store.finishDelivery(old, { status: 'failed', code: 'WEIXIN_CONTEXT_REJECTED' });
  f.advance(170 * 60000);
  const b = f.store.createSource({ type: 'youtube', name: 'Recent', channel: 'UC' + 'c'.repeat(22) });
  f.store.toggle(b.id, true, true);
  f.store.put(incoming('youtube:recent-refusal'), [f.store.source(b.id)], true, f.service.destination);
  const recent = f.store.claimDelivery(f.service.destination)!;
  f.store.finishDelivery(recent, { status: 'failed', code: 'WEIXIN_CONTEXT_REJECTED' });
  f.store.toggle(b.id, true, false);
  f.advance(9 * 60000);
  legacyAccount(f);
  const calls = f.calls.length;
  assert.equal(f.service.describe().nextRetryAt, f.now() + 60000);
  assert.equal(f.service.describe().ready, false);
  assert.equal((await f.service.send('synthetic', 'new-task')).code, 'WEIXIN_CONTEXT_REJECTED');
  assert.equal(f.calls.length, calls);
  f.service.recoverDeliveries();
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', recent.id)!.status, 'cancelled');
});

test('AC1: migration skips missed hour, inbound cannot advance it; healthy legacy success stays ready', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  f.advance(8 * 60000);
  f.send({ ret: -2 }); await f.service.send('synthetic', 'refusal');
  legacyAccount(f, { retryAt: f.now() + 6 * 3600000 });
  f.advance(65 * 60000); // 13:13 Shanghai: 13:00 was missed.
  const next = Date.parse('2026-10-16T06:00:00Z');
  assert.equal(f.service.describe().nextRetryAt, next);
  await f.inbound(f.now(), 'fresh');
  assert.equal(new Weixin(f.store, f.config, f.request).describe().nextRetryAt, next);
  assert.equal(f.service.describe().ready, false);
  f.advance(next - f.now() + 5000); f.send({ ret: 0 });
  assert.equal((await f.service.send('synthetic', 'success')).status, 'sent');
  legacyAccount(f);
  assert.equal(f.service.describe().ready, true);
  assert.equal(f.service.describe().nextRetryAt, 0);
});

test('AC1: historical refusal followed by accepted success does not lock account on upgrade', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  const dItem = f.store.put(incoming(), [f.source()], true, f.service.destination);
  const d = f.store.claimDelivery(f.service.destination)!;
  f.store.finishDelivery(d, { status: 'failed', code: 'WEIXIN_CONTEXT_REJECTED' });
  f.advance(1); await f.service.send('synthetic', 'accepted');
  legacyAccount(f, { retryAt: 0, error: '' });
  assert.equal(f.service.describe().ready, true);
  assert.equal(f.service.describe().nextRetryAt, 0);
  assert.ok(dItem.id);
});

for (const initialHour of [12, 21]) {
  test(`AC1: restart during ${initialHour + 2}:00 window uses that hour after an earlier missed slot`, async t => {
    const f = setup(t); await f.bind(); await f.inbound();
    f.advance((initialHour - 12) * 3600000);
    const item = f.store.put(incoming(), [f.source()], true, f.service.destination);
    const d = f.store.claimDelivery(f.service.destination, 24)!;
    f.send({ ret: -2 }); f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
    f.advance(2 * 3600000 + 30000);
    const reopened = new Store(f.dir, 'demo', f.now); t.after(() => reopened.close());
    const restarted = new Weixin(reopened, f.config, f.request);
    restarted.recoverDeliveries();
    assert.equal(restarted.describe().ready, true);
    const retry = reopened.claimDelivery(restarted.destination, 24)!;
    assert.ok(retry); assert.equal(retry.item_id, item.id);
    f.send({ ret: 0 }); reopened.finishDelivery(retry, await restarted.send(retry.snapshot, retry.id));
    assert.equal(reopened.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'sent');
    restarted.recoverDeliveries();
    assert.equal(reopened.claimDelivery(restarted.destination, 24), undefined);
  });
}

test('AC1/2: 23:08 upgrade waits for the final midnight slot and expires when it is missed', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  f.advance(11 * 3600000 + 8 * 60000);
  const item = f.store.put(incoming(), [f.source()], true, f.service.destination);
  const d = f.store.claimDelivery(f.service.destination)!;
  f.send({ ret: -2 }); f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
  legacyAccount(f, { retryAt: f.now() + 3 * 3600000 });
  const restarted = new Weixin(f.store, f.config, f.request);
  restarted.recoverDeliveries();
  assert.equal(restarted.describe().ready, false);
  assert.equal(restarted.describe().nextRetryAt, Date.parse('2026-10-16T16:00:00Z'));
  assert.equal(f.store.claimDelivery(restarted.destination, 24), undefined);
  f.advance(53 * 60000); restarted.recoverDeliveries();
  const row = f.store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id)!;
  assert.equal(row.status, 'cancelled'); assert.equal(row.error, 'WEIXIN_DAY_EXPIRED');
  assert.equal(restarted.describe().retryDeadline, 0);
  f.advance(3600000); assert.equal(restarted.describe().nextRetryAt, 0);
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('sendmessage')).length, 1);
});

test('AC2: after the midnight window cancels blocked ready parts, not digest_wait, sent, unknown or sending', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  f.store.setSettings({ ...f.store.settings(), timezone: 'America/New_York' });
  f.advance(11 * 3600000 + 59 * 60000);
  const source = f.source();
  const ids: Record<string, string> = {};
  for (const status of ['failed', 'pending', 'unknown', 'sending', 'sent', 'digest_wait']) {
    const item = f.store.put(incoming(`youtube:midnight-${status}`, 0), [source], true, f.service.destination);
    const row = f.store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id)!;
    ids[status] = row.id;
    f.store.run('UPDATE deliveries SET status=?,mode=?,error=? WHERE id=?', status, status === 'pending' ? 'digest_part' : status === 'digest_wait' ? 'digest' : 'immediate', status === 'failed' ? 'WEIXIN_CONTEXT_REJECTED' : '', row.id);
  }
  f.send({ ret: -2 }); await f.service.send('synthetic', 'gate');
  f.service.recoverDeliveries(); f.advance(120000); f.service.recoverDeliveries();
  for (const status of Object.keys(ids)) {
    const row = f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', ids[status])!;
    assert.equal(row.status, ['failed', 'pending'].includes(status) ? 'cancelled' : status);
    if (row.status === 'cancelled') assert.equal(row.error, 'WEIXIN_DAY_EXPIRED');
  }
  // A new day's normal first send is not delayed, even with an old publication time.
  f.send({ ret: 0 });
  const fresh = f.store.put(incoming('youtube:newday', 0), [source], true, f.service.destination);
  const d = f.store.claimDelivery(f.service.destination, 24)!;
  assert.equal(d.item_id, fresh.id);
  f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
  f.service.recoverDeliveries();
  assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'sent');
});

for (const result of ['sent', 'unknown'] as const) {
  test(`AC2: crossing midnight keeps true ${result} receipt, and pre-send deadline blocks network`, async t => {
    const f = setup(t); await f.bind(); await f.inbound();
    f.advance(10 * 3600000);
    f.store.put(incoming(), [f.source()], true, f.service.destination);
    const first = f.store.claimDelivery(f.service.destination)!;
    f.send({ ret: -2 }); f.store.finishDelivery(first, await f.service.send(first.snapshot, first.id));
    f.advance(3600000 + 5000); f.service.recoverDeliveries();
    const d = f.store.claimDelivery(f.service.destination, 24)!;
    // Simulate a request begun in the last window whose result arrives after midnight.
    f.service.request = async () => { f.advance(3600000 + 60000); return Response.json(result === 'sent' ? { ret: 0 } : {}); };
    f.store.run('UPDATE deliveries SET lease=? WHERE id=?', f.now() + 2 * 3600000, d.id);
    const outcome = await f.service.send(d.snapshot, d.id);
    f.store.finishDelivery(d, outcome); f.service.recoverDeliveries();
    assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, result);
    assert.equal(f.store.claimDelivery(f.service.destination, 24), undefined);
    const calls = f.calls.length;
    assert.equal((await f.service.send(d.snapshot, d.id)).code, 'WEIXIN_DAY_EXPIRED');
    assert.equal(f.calls.length, calls);
  });
}

test('AC3: 25 context attempts include midnight but not 26; ordinary failures remain five; global fifty is shared', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  f.store.put(incoming(), [f.source()], true, f.service.destination);
  const row = f.store.get<Delivery>('SELECT * FROM deliveries')!;
  f.store.run("UPDATE deliveries SET attempt=24,error='WEIXIN_CONTEXT_REJECTED' WHERE id=?", row.id);
  const last = f.store.claimDelivery(f.service.destination, 25)!; assert.equal(last.attempt, 25);
  f.store.finishDelivery(last, { status: 'failed', code: 'WEIXIN_CONTEXT_REJECTED' });
  f.store.recoverContextDelivery(last, 25);
  assert.equal(f.store.claimDelivery(f.service.destination, 25), undefined);
  f.store.run("UPDATE deliveries SET status='retry_wait',attempt=5,error='WEIXIN_RATE_LIMITED',available=? WHERE id=?", f.now(), row.id);
  assert.equal(f.store.claimDelivery(f.service.destination, 24), undefined);
  f.store.run("UPDATE deliveries SET attempt=4,error='',available=? WHERE id=?", f.now(), row.id);
  for (let n = 1; n < 50; n++) f.store.run("INSERT INTO attempts(id,delivery_id,n,day,at,status) SELECT ?,delivery_id,1,day,at,'failed' FROM attempts LIMIT 1", `quota-${n}`);
  assert.equal(f.store.get('SELECT count(*) n FROM attempts')!.n, 50);
  assert.equal(f.store.claimDelivery(f.service.destination, 24), undefined);
});

test('AC2: restart after midnight without any deadline markers expires old ready finals before sending', async t => {
  const f = setup(t); await f.bind(); await f.inbound();
  f.advance(11 * 3600000);
  const source = f.source();
  for (const mode of ['immediate', 'digest_part']) {
    const item = f.store.put(incoming(`youtube:offline-${mode}`), [source], true, f.service.destination);
    f.store.run('UPDATE deliveries SET mode=? WHERE item_id=?', mode, item.id);
  }
  f.send({ ret: -2 }); await f.service.send('synthetic', 'old-code-refusal');
  legacyAccount(f);
  assert.equal(f.store.get("SELECT count(*) n FROM meta WHERE key LIKE 'weixin-deadline:%'")!.n, 0);
  f.advance(2 * 3600000);
  const reopened = new Store(f.dir, 'demo', f.now); t.after(() => reopened.close());
  const restarted = new Weixin(reopened, f.config, f.request);
  const d = reopened.get<Delivery>('SELECT * FROM deliveries LIMIT 1')!;
  const calls = f.calls.length;
  assert.equal((await restarted.send(d.snapshot, d.id)).code, 'WEIXIN_DAY_EXPIRED');
  restarted.recoverDeliveries();
  assert.equal(reopened.get("SELECT count(*) n FROM deliveries WHERE status='cancelled' AND error='WEIXIN_DAY_EXPIRED'")!.n, 2);
  assert.equal(restarted.describe().nextRetryAt, 0);
  assert.equal(f.calls.length, calls);
});

for (const second of [0, 30, 59, 60]) {
  test(`AC2: midnight final attempt at 00:00:${second} respects its last window and existing deadline migration`, async t => {
    const f = setup(t); await f.bind(); await f.inbound();
    f.advance(11 * 3600000 + 30 * 60000);
    const source = f.source();
    const item = f.store.put(incoming(), [source], true, f.service.destination);
    const d = f.store.claimDelivery(f.service.destination, 25)!;
    f.send({ ret: -2 }); f.store.finishDelivery(d, await f.service.send(d.snapshot, d.id));
    const midnight = Date.parse('2026-10-16T16:00:00Z');
    f.store.run('UPDATE meta SET value=? WHERE key=?', String(midnight), `weixin-deadline:${d.id}`);
    assert.equal(f.service.describe().nextRetryAt, midnight);
    f.advance(midnight + second * 1000 - f.now());
    const restarted = new Weixin(f.store, f.config, f.request);
    restarted.recoverDeliveries();
    const retry = f.store.claimDelivery(restarted.destination, 25);
    if (second < 60) {
      assert.ok(retry);
      f.send({ ret: 0 }); f.store.finishDelivery(retry, await restarted.send(retry.snapshot, retry.id));
      restarted.recoverDeliveries();
      assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.status, 'sent');
      assert.equal(f.store.claimDelivery(restarted.destination, 25), undefined);
    } else {
      assert.equal(retry, undefined);
      assert.equal(f.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!.error, 'WEIXIN_DAY_EXPIRED');
    }
  });
}
