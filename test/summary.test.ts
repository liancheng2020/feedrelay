import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming } from './helpers.js';
import { Store } from '../server/store.js';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SummaryService, type SummaryRow } from '../server/summary.js';
import {
  MODEL_ENDPOINT,
  validateBrief,
  boundedModelFetch,
  createDeepSeekAdapter,
} from '../server/deepseek.js';

const result = (text = '会议于2026年10月16日召开，计划于11月发布。') => ({
  summary: {
    overview: { oneLiner: '原文描述了会议与发布计划。' },
    keyPoints: [
      {
        title: '发布计划',
        summary: '计划于11月发布。',
        evidence: { quote: text, locator: '段落1' },
      },
    ],
  },
});
function setup(t: Parameters<typeof fixture>[0], mode = 'manual', notify = false) {
  const f = fixture(t),
    s = f.source('email');
  const service = f.engine.summaries;
  service.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  service.authorize(s.id, mode, notify, true);
  const item = () =>
    f.store.put(
      {
        ...incoming(`test-item-${f.now()}`, f.now()),
        kind: 'email',
        url: '',
        text: '会议于2026年10月16日召开，计划于11月发布。',
      },
      [f.store.source(s.id)],
      true,
      'demo',
    );
  return { ...f, s, service, item };
}
const call = (request: typeof fetch, signal: AbortSignal) =>
  request(MODEL_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({
      model: 'demo-deepseek',
      messages: [{ role: 'user', content: '测试' }],
      max_tokens: 2600,
    }),
    signal,
  });

test('summary is disabled without credentials and does not block original delivery', async (t) => {
  const f = fixture(t),
    s = f.source(),
    item = f.store.put(incoming(), [s], true, 'demo');
  assert.equal(f.engine.summaries.describe().enabled, false);
  assert.throws(() => f.engine.summaries.enqueue(item.id), /SUMMARY_NOT_ENABLED/);
  await f.engine.cycle();
  assert.equal(
    f.store.get('SELECT status FROM deliveries WHERE item_id=?', item.id)!.status,
    'sent',
  );
  assert.equal(f.engine.summaries.describe().calls, 0);
});
test('explicit source consent is required; valid content cache avoids repeated calls', async (t) => {
  const f = setup(t),
    item = f.item();
  f.service.authorize(f.s.id, 'off', false, true);
  assert.throws(() => f.service.enqueue(item.id), /SOURCE_NOT_AUTHORIZED/);
  f.service.authorize(f.s.id, 'manual', false, true);
  const id = f.service.enqueue(item.id);
  await f.service.cycle('demo');
  assert.equal(f.service.list(item.id)[0].status, 'succeeded');
  assert.equal(f.service.enqueue(item.id), id);
  await f.service.cycle('demo');
  assert.equal(f.service.describe().calls, 1);
  assert.equal(f.store.get('SELECT input FROM summaries WHERE id=?', id)!.input, '');
  assert.equal(f.service.list(item.id)[0].output, null);
});
test('repair calls share the persistent request cap; failures are never free', async (t) => {
  const f = setup(t),
    item = f.item();
  f.service.configure({ enabled: true, maxCalls: 1, maxCostCny: 1, confirmed: true });
  f.service.adapter = {
    ...f.service.adapter,
    run: async (input, request, signal) => {
      await call(request, signal);
      await call(request, signal);
      return result(input.text);
    },
  };
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  assert.equal(f.service.list(item.id)[0].error, 'SUMMARY_BUDGET_EXHAUSTED');
  assert.equal(f.service.describe().calls, 1);
  f.service.enqueue(item.id, 'manual', true);
  await f.service.cycle('demo');
  assert.equal(f.service.describe().calls, 1);
});
test('cost budget is reserved before network, not refunded after success or unknown usage', async (t) => {
  const f = setup(t),
    item = f.item();
  f.service.configure({ enabled: true, maxCalls: 10, maxCostCny: 0.000001, confirmed: true });
  let network = 0;
  f.service.transport = async () => {
    network++;
    return new Response('{}');
  };
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  assert.equal(network, 0);
  assert.equal(f.service.describe().calls, 0);
  f.service.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  f.service.enqueue(item.id, 'manual', true);
  await f.service.cycle('demo');
  assert.equal(network, 1);
  assert.equal(f.service.describe().unknownUsageCalls, 1);
  assert.ok(f.service.describe().reservedCny > 0);
});
test('two database connections cannot exceed the shared call budget', async (t) => {
  const f = setup(t);
  f.service.configure({ enabled: true, maxCalls: 1, maxCostCny: 1, confirmed: true });
  const a = f.item();
  f.advance(1);
  const b = f.item();
  f.service.enqueue(a.id);
  f.service.enqueue(b.id);
  const second = new Store(f.dir, 'demo', f.now);
  t.after(() => second.close());
  const other = new SummaryService(
    second,
    f.service.adapter,
    'demo',
    f.service.transport,
    f.service.captions,
  );
  await Promise.all([f.service.cycle('demo'), other.cycle('demo')]);
  assert.equal(f.service.describe().calls, 1);
  assert.equal(f.store.get("SELECT count(*) n FROM summaries WHERE status='succeeded'")!.n, 1);
});
test('in-flight source revocation prevents result publication and further requests', async (t) => {
  const f = setup(t, 'manual', true),
    item = f.item();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  f.service.transport = async () => {
    started();
    await new Promise<void>((r) => {
      release = r;
    });
    return new Response('{}');
  };
  f.service.enqueue(item.id);
  const running = f.service.cycle('demo');
  await ready;
  f.store.toggle(f.s.id, false, false);
  release();
  await running;
  const row = f.service.list(item.id)[0];
  assert.equal(row.status, 'cancelled');
  assert.equal(row.result, null);
  assert.equal(row.output, null);
  assert.equal(f.service.describe().calls, 1);
});
test('changed original invalidates old result and content hash creates a new request', async (t) => {
  const f = setup(t),
    item = f.item();
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  f.store.run('UPDATE items SET text=? WHERE id=?', '新正文：日期已调整。', item.id);
  assert.equal(f.service.list(item.id)[0].current, false);
  f.service.reconcile();
  assert.equal(f.service.list(item.id)[0].result, null);
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  assert.equal(f.service.describe().calls, 2);
  assert.equal(f.service.list(item.id)[0].status, 'succeeded');
});
test('automatic mode excludes history and silent baselines and schedules each item once', async (t) => {
  const f = setup(t, 'auto');
  const history = f.item();
  f.advance(1);
  const next = f.item();
  f.advance(1);
  const silent = f.store.put({ ...incoming('baseline'), kind: 'email' }, [f.s], false, 'demo');
  f.service.schedule();
  assert.equal(f.service.list(history.id).length, 0);
  assert.equal(f.service.list(silent.id).length, 0);
  assert.equal(f.service.list(next.id).length, 1);
  await f.service.cycle('demo');
  f.service.schedule();
  assert.equal(f.service.list(next.id).length, 1);
  f.store.run("UPDATE items SET text='元数据变化' WHERE id=?", next.id);
  f.service.reconcile();
  f.service.schedule();
  assert.equal(f.service.list(next.id).length, 1);
});
test('oversize text is visible as failed without sending any bytes', async (t) => {
  const f = setup(t),
    item = f.item();
  f.store.run('UPDATE items SET text=? WHERE id=?', '长'.repeat(8001), item.id);
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  assert.equal(f.service.list(item.id)[0].error, 'SUMMARY_CONTENT_TOO_LONG');
  assert.equal(f.service.describe().calls, 0);
});
test('AI follow-up has an independent frozen delivery and send retry never calls a model', async (t) => {
  const f = setup(t, 'manual', true),
    item = f.item();
  f.store.changeDeliveryMode(f.s.id, 'digest');
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  const row = f.store.get<SummaryRow>('SELECT * FROM summaries')!;
  assert.ok(row.output_item);
  const output = f.store.get('SELECT * FROM deliveries WHERE item_id=?', row.output_item)!;
  assert.equal(output.mode, 'immediate');
  assert.match(String(output.snapshot), /^测试标题（模拟摘要）\n\n1\. /);
  f.store.run("UPDATE deliveries SET status='sent' WHERE item_id=?", item.id);
  const delivery = f.store.claimDelivery('demo')!;
  f.store.finishDelivery(delivery, { status: 'unknown' });
  f.store.resolveDelivery(delivery.id, 'retry', 'demo');
  assert.equal(f.store.claimDelivery('demo')!.snapshot, output.snapshot);
  assert.equal(f.service.describe().calls, 1);
});
test('disabling summary push cancels unsent supplement but retains usable web result', async (t) => {
  const f = setup(t, 'manual', true),
    item = f.item();
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  f.service.authorize(f.s.id, 'manual', false, true);
  assert.equal(f.service.list(item.id)[0].output!.status, 'cancelled');
  assert.ok(f.service.list(item.id)[0].result);
});
test('retention clears input, result and supplemental notification together', async (t) => {
  const f = setup(t, 'manual', true),
    item = f.item();
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  const output = f.store.get<SummaryRow>('SELECT * FROM summaries')!.output_item;
  f.advance(8 * 86400000);
  f.store.cleanup();
  assert.equal(f.service.list(item.id)[0].status, 'expired');
  assert.equal(f.service.list(item.id)[0].result, null);
  assert.equal(f.store.get('SELECT text FROM items WHERE id=?', output)!.text, '');
  assert.equal(
    f.store.get('SELECT snapshot FROM deliveries WHERE item_id=?', output)!.snapshot,
    '',
  );
  assert.equal(f.service.describe().calls, 1);
});
test('restart leaves expired in-flight work unknown rather than regenerating it', async (t) => {
  const f = setup(t),
    item = f.item();
  const id = f.service.enqueue(item.id);
  f.store.run(
    "UPDATE summaries SET status='running',token='old',lease=? WHERE id=?",
    f.now() + 100,
    id,
  );
  f.advance(101);
  const restarted = new SummaryService(
    f.store,
    f.service.adapter,
    'demo',
    f.service.transport,
    f.service.captions,
  );
  await restarted.cycle('demo');
  assert.equal(restarted.list(item.id)[0].status, 'unknown');
  assert.equal(restarted.describe().calls, 0);
  restarted.enqueue(item.id, 'manual', true);
  await restarted.cycle('demo');
  assert.equal(restarted.describe().calls, 1);
});
test('global stop revokes per-source consent and does not reset charged calls', async (t) => {
  const f = setup(t),
    item = f.item();
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  f.service.configure({ enabled: false, maxCalls: 10, maxCostCny: 1, confirmed: true });
  assert.equal(f.store.source(f.s.id).summary_mode, 'off');
  assert.equal(f.service.list(item.id)[0].result, null);
  f.service.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  assert.throws(() => f.service.enqueue(item.id), /SOURCE_NOT_AUTHORIZED/);
  assert.equal(f.service.describe().calls, 1);
});
test('unsupported evidence is rejected; literal quotes do not prove semantic correctness', () => {
  const text = '会议于2026年10月16日召开，计划于11月发布。';
  assert.equal(validateBrief(result(), text).points[0].quote, text);
  assert.throws(() => validateBrief(result('已于9月发布。'), text), /UNSUPPORTED_QUOTE/);
});
test('controlled model request rejects redirects, oversize responses and failed business transport', async () => {
  let redirect = '';
  await boundedModelFetch(async (_url, init) => {
    redirect = init!.redirect!;
    return new Response('{}');
  }, MODEL_ENDPOINT);
  assert.equal(redirect, 'error');
  await assert.rejects(
    () => boundedModelFetch(async () => new Response('x'.repeat(256001)), MODEL_ENDPOINT),
    /TOO_LARGE/,
  );
  await assert.rejects(
    () => boundedModelFetch(async () => new Response('{}', { status: 401 }), MODEL_ENDPOINT),
    /MODEL_AUTH_FAILED/,
  );
});
test('provider usage above the configured conservative bound disables further summaries', async (t) => {
  const f = setup(t),
    item = f.item();
  f.service.transport = async () =>
    new Response(JSON.stringify({ usage: { prompt_tokens: 1000000, completion_tokens: 1 } }));
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  assert.equal(f.service.list(item.id)[0].error, 'SUMMARY_PRICE_BOUND_EXCEEDED');
  assert.equal(f.service.describe().enabled, false);
  assert.ok(f.service.describe().reservedCny >= 1);
});
test('adapter cannot bypass the fixed endpoint or output token cap', async (t) => {
  const f = setup(t),
    item = f.item();
  f.service.adapter = {
    ...f.service.adapter,
    run: async (_input, request) => {
      await request('https://evil.example', { method: 'POST', body: '{}' });
      return result();
    },
  };
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  assert.equal(f.service.list(item.id)[0].error, 'SUMMARY_REQUEST_BLOCKED');
  assert.equal(f.service.describe().calls, 0);
  f.service.adapter = {
    ...f.service.adapter,
    run: async (_input, request) => {
      await request(MODEL_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({ model: 'demo-deepseek', max_tokens: 2601 }),
      });
      return result();
    },
  };
  f.service.enqueue(item.id, 'manual', true);
  await f.service.cycle('demo');
  assert.equal(f.service.list(item.id)[0].error, 'SUMMARY_REQUEST_BLOCKED');
  assert.equal(f.service.describe().calls, 0);
});
test('missing optional model key degrades to unavailable without breaking original subscriptions', (t) => {
  const f = fixture(t);
  f.config.demo = false;
  f.config.deepseek = {
    enabled: true,
    apiKey: '',
    model: 'test',
    inputPrice: 1,
    outputPrice: 2,
  };
  assert.equal(createDeepSeekAdapter(f.config).available, false);
});
test('v3 backup restores usage but disables model consent and clears supplemental snapshots', async (t) => {
  const f = setup(t, 'manual', true),
    item = f.item();
  f.service.enqueue(item.id);
  await f.service.cycle('demo');
  const output = f.store.get<SummaryRow>('SELECT * FROM summaries')!.output_item;
  f.advance(1);
  // A second content identity is pending at backup time.
  const other = f.store.put(
    { ...incoming('restored-pending'), kind: 'email' },
    [f.s],
    true,
    'demo',
  );
  f.service.enqueue(other.id);
  const path = join(f.dir, 'v3.sqlite'),
    target = join(f.dir, 'restored');
  const backup = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', path], {
    env: { ...process.env, DATA_DIR: f.dir },
    encoding: 'utf8',
  });
  assert.equal(backup.status, 0, backup.stderr);
  const restore = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/restore.ts', path, '--confirm-stopped'],
    { env: { ...process.env, DATA_DIR: target }, encoding: 'utf8' },
  );
  assert.equal(restore.status, 0, restore.stderr);
  const db = new Store(target, 'demo', f.now);
  t.after(() => db.close());
  const service = new SummaryService(
    db,
    f.service.adapter,
    'demo',
    f.service.transport,
    f.service.captions,
  );
  assert.equal(service.describe().enabled, false);
  assert.equal(service.describe().calls, 1);
  assert.equal(db.source(f.s.id).summary_mode, 'off');
  assert.equal(db.get('SELECT text FROM items WHERE id=?', output)!.text, '');
  assert.equal(db.get('SELECT snapshot FROM deliveries WHERE item_id=?', output)!.snapshot, '');
  await service.cycle('demo');
  assert.equal(service.describe().calls, 1);
});
test('overlapping authorized rules share a cached result instead of paying twice', async (t) => {
  const f = setup(t, 'manual');
  const second = f.store.toggle(
    f.store.createSource({ type: 'email', name: '第二规则', sender: 'other@example.com' }).id,
    true,
    true,
  );
  f.service.authorize(second.id, 'auto', false, true);
  const item = f.store.put(
    { ...incoming('shared-summary'), kind: 'email' },
    [f.s, second],
    true,
    'demo',
  );
  // An auto request binds to the second source; later manual access can reuse it.
  const id = f.service.enqueue(item.id, 'auto');
  await f.service.cycle('demo');
  assert.equal(f.service.enqueue(item.id, 'manual'), id);
  await f.service.cycle('demo');
  assert.equal(f.service.describe().calls, 1);
});
test('empty feed descriptions record a visible failure without starving later auto items', async (t) => {
  const f = setup(t, 'auto');
  f.advance(1);
  const empty = f.store.put({ ...incoming('empty-auto'), text: '' }, [f.s], true, 'demo');
  f.advance(1);
  const valid = f.item();
  f.service.schedule();
  assert.equal(f.service.list(empty.id)[0].error, 'SUMMARY_NO_CONTENT');
  assert.equal(f.service.list(valid.id)[0].status, 'queued');
  await f.service.cycle('demo');
  assert.equal(f.service.list(valid.id)[0].status, 'succeeded');
});
test('changing Feishu recipient invalidates queued and completed summary disclosure', async (t) => {
  const f = setup(t, 'manual', true),
    item = f.item();
  f.service.enqueue(item.id);
  const changed = new SummaryService(
    f.store,
    f.service.adapter,
    'another-recipient',
    f.service.transport,
  );
  await changed.cycle('another-recipient');
  assert.equal(changed.list(item.id)[0].status, 'cancelled');
  assert.equal(changed.describe().calls, 0);
  assert.throws(() => changed.enqueue(item.id), /SUMMARY_NOT_ENABLED/);
  changed.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  assert.throws(() => changed.enqueue(item.id), /SOURCE_NOT_AUTHORIZED/);
  changed.authorize(f.s.id, 'manual', true, true);
  changed.enqueue(item.id);
  await changed.cycle('another-recipient');
  assert.equal(
    f.store.get(
      "SELECT destination FROM deliveries WHERE item_id IN (SELECT output_item FROM summaries WHERE output_item<>'')",
    )!.destination,
    'another-recipient',
  );
});
