import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../server/config.js';
import { Engine } from '../server/engine.js';
import type { Incoming } from '../server/store.js';
import type { Envelope } from '../server/adapters.js';
import { fixture, incoming } from './helpers.js';

test('YouTube first run is silent, new IDs notify, title edits do not', async (t) => {
  let data: Incoming[] = [];
  const f = fixture(t, {
      feed: async () => ({ unchanged: false, items: data, etag: '', modified: '' }),
    }),
    s = f.source();
  data = [incoming('old', f.now() - 1000)];
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 0);
  f.advance(1000);
  data = [...data, incoming('new', f.now())];
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
  data[1].title = '编辑后的标题';
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
});
test('RSS gap is visible and old unseen content stays silent', async (t) => {
  let data: Incoming[] = [];
  const f = fixture(t, { feed: async () => ({ unchanged: false, items: data }) }),
    s = f.source();
  data = [incoming('a', f.now())];
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  data = [incoming('b', f.now() + 1000)];
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  assert.equal(f.store.source(s.id).coverage, 'FEED_WINDOW_GAP');
  data = [incoming('ancient', f.now() - 86400000)];
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  assert.equal(f.store.source(s.id).coverage, 'OLD_ITEM_REAPPEARED');
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
});
test('pause during fetch fences stale result and outbox', async (t) => {
  const f = fixture(t),
    s = f.source();
  f.engine.adapters.feed = async () => {
    f.store.toggle(s.id, false, false);
    return { unchanged: false, items: [incoming('a', f.now())] };
  };
  f.store.enqueue('source', s.id, s.generation);
  await f.run();
  assert.equal(f.store.get('SELECT count(*) n FROM items')!.n, 0);
});
test('source probe never creates baseline or notifications', async (t) => {
  const f = fixture(t, { feed: async () => ({ unchanged: false, items: [incoming()] }) }),
    s = f.source();
  f.store.enqueue('probe', s.id, s.generation);
  await f.run();
  assert.equal(f.store.source(s.id).initialized, 0);
  assert.equal(f.store.get('SELECT count(*) n FROM items')!.n, 0);
});
function mailboxFixture(t: Parameters<typeof fixture>[0]) {
  let upper = 100,
    epoch = '1',
    failures = 0;
  const bodies: number[] = [];
  const envelopes: Envelope[] = [];
  const f = fixture(t, {
    mailbox: async () => ({
      get upper() {
        return upper;
      },
      get epoch() {
        return epoch;
      },
      async headers(from, to) {
        return envelopes.filter((e) => e.uid >= from && e.uid <= to);
      },
      async body(uid) {
        bodies.push(uid);
        if (failures-- > 0) throw new AppError('TEMPORARY', 502, true);
        return '只读测试正文';
      },
      async close() {},
    }),
  });
  return {
    ...f,
    bodies,
    envelopes,
    upper: (n: number) => {
      upper = n;
    },
    epoch: (n: string) => {
      epoch = n;
    },
    fail: () => {
      failures = 1;
    },
    async scan() {
      f.store.enqueue('mailbox', 'default');
      return f.run();
    },
  };
}
test('mail baseline is header-only; old Date with new UID is discovered', async (t) => {
  const f = mailboxFixture(t);
  f.source('email');
  await f.scan();
  assert.equal(f.bodies.length, 0);
  f.upper(102);
  f.envelopes.push(
    {
      uid: 101,
      sender: 'brief@example.com',
      subject: '新闻',
      received: f.now(),
      published: f.now() - 864000000,
    },
    {
      uid: 102,
      sender: 'other@example.com',
      subject: '私人邮件',
      received: f.now(),
      published: f.now(),
    },
  );
  await f.scan();
  assert.deepEqual(f.bodies, [101]);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
  assert.equal(f.store.get('SELECT uid FROM mailbox_cursors')!.uid, 102);
});
test('body failure becomes durable task before cursor advances', async (t) => {
  const f = mailboxFixture(t);
  f.source('email');
  await f.scan();
  f.upper(101);
  f.envelopes.push({
    uid: 101,
    sender: 'brief@example.com',
    subject: '新闻',
    received: f.now(),
    published: f.now(),
  });
  f.fail();
  await f.scan();
  assert.equal(
    f.store.get("SELECT count(*) n FROM jobs WHERE kind='body' AND status='pending'")!.n,
    1,
  );
  assert.equal(f.store.get('SELECT uid FROM mailbox_cursors')!.uid, 101);
  await f.run();
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
});
test('overlapping mail rules share one item and notification', async (t) => {
  const f = mailboxFixture(t),
    a = f.source('email');
  const b = f.store.createSource({
    type: 'email',
    name: '更精确规则',
    sender: a.sender,
    subject: '新闻',
  });
  f.store.toggle(b.id, true, true);
  await f.scan();
  f.upper(101);
  f.envelopes.push({
    uid: 101,
    sender: a.sender,
    subject: '新闻摘要',
    received: f.now(),
    published: null,
  });
  await f.scan();
  assert.equal(f.store.get('SELECT count(*) n FROM source_items')!.n, 2);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
});
test('UIDVALIDITY change pauses rules until explicit rebaseline', async (t) => {
  const f = mailboxFixture(t),
    s = f.source('email');
  await f.scan();
  f.epoch('2');
  await f.scan();
  assert.equal(f.store.source(s.id).enabled, 0);
  assert.equal(f.store.get('SELECT blocked FROM mailbox_cursors')!.blocked, 1);
  f.store.toggle(s.id, true, true);
  await f.scan();
  assert.equal(f.store.get('SELECT epoch FROM mailbox_cursors')!.epoch, '2');
  assert.equal(f.store.source(s.id).initialized, 1);
});
test('deleted rule cannot revive from deferred body job', async (t) => {
  const f = mailboxFixture(t),
    s = f.source('email');
  await f.scan();
  f.upper(101);
  f.envelopes.push({
    uid: 101,
    sender: s.sender,
    subject: '新闻',
    received: f.now(),
    published: null,
  });
  f.fail();
  await f.scan();
  f.store.deleteSource(s.id, true);
  assert.equal(f.store.claimJob(), undefined);
  assert.equal(f.store.get("SELECT payload FROM jobs WHERE kind='body'")!.payload, '{}');
  assert.equal(f.store.get('SELECT count(*) n FROM items')!.n, 0);
});
test('all-default demo cycle works without AI or credentials', async (t) => {
  const f = fixture(t);
  f.source();
  await f.engine.cycle();
  assert.equal(f.store.get("SELECT status FROM jobs WHERE kind='source'")!.status, 'succeeded');
  assert(f.store.stats().heartbeat);
});
test('mail pause/resume during fetch fences cursor advancement', async (t) => {
  const f = mailboxFixture(t),
    s = f.source('email');
  await f.scan();
  f.upper(101);
  f.envelopes.push({
    uid: 101,
    sender: s.sender,
    subject: '新闻',
    received: f.now(),
    published: null,
  });
  const original = f.engine.adapters.mailbox;
  let pause = true;
  f.engine.adapters.mailbox = async () => {
    const box = await original();
    return {
      ...box,
      body: async (uid) => {
        if (pause) {
          pause = false;
          f.store.toggle(s.id, false, false);
          f.store.toggle(s.id, true, true, 'catch_up');
        }
        return box.body(uid);
      },
    };
  };
  await f.scan();
  assert.equal(f.store.get('SELECT uid FROM mailbox_cursors')!.uid, 100);
  assert.equal(f.store.get('SELECT count(*) n FROM items')!.n, 0);
  await f.scan();
  assert.equal(f.store.get('SELECT count(*) n FROM items')!.n, 1);
});
test('mail catch-up rewinds shared cursor without duplicating other rules', async (t) => {
  const f = mailboxFixture(t),
    a = f.source('email');
  const b = f.store.createSource({ type: 'email', name: '其他邮件', sender: 'other@example.com' });
  f.store.toggle(b.id, true, true);
  await f.scan();
  f.store.toggle(a.id, false, false);
  f.upper(101);
  f.envelopes.push({
    uid: 101,
    sender: a.sender,
    subject: '暂停期间到达',
    received: f.now(),
    published: null,
  });
  await f.scan();
  assert.equal(f.store.get('SELECT uid FROM mailbox_cursors')!.uid, 101);
  assert.equal(f.bodies.length, 0);
  f.store.toggle(a.id, true, true, 'catch_up');
  await f.scan();
  assert.deepEqual(f.bodies, [101]);
  assert.equal(f.store.get('SELECT count(*) n FROM deliveries')!.n, 1);
});
test('changing mailbox identity requires separate state; disabling is allowed', (t) => {
  const f = fixture(t),
    config = {
      ...f.config,
      demo: false,
      imap: {
        ...f.config.imap,
        enabled: true,
        host: 'imap.163.com',
        user: 'synthetic@163.com',
        password: 'synthetic',
      },
    };
  new Engine(f.store, config);
  assert.throws(
    () => new Engine(f.store, { ...config, imap: { ...config.imap, user: 'other@163.com' } }),
    /MAILBOX_IDENTITY_CHANGED/,
  );
  assert.doesNotThrow(
    () => new Engine(f.store, { ...config, imap: { ...config.imap, enabled: false, user: '' } }),
  );
});
