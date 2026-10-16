import { randomUUID } from 'node:crypto';
import { AppError } from './config.js';
import { Store, type Item, type Source } from './store.js';
import {
  MODEL_ENDPOINT,
  contentHash,
  validateBrief,
  boundedModelFetch,
  type SiftAdapter,
  type SummaryInput,
  type Brief,
} from './sift.js';

export interface SummaryRow {
  id: string;
  cache_key: string;
  item_id: string;
  source_id: string;
  generation: number;
  stamp: string;
  input: string;
  scope: string;
  origin: string;
  notify: number;
  status: string;
  error: string;
  result: string;
  token: string;
  lease: number;
  created: number;
  finished: number | null;
  output_item: string;
}
interface Policy {
  enabled: boolean;
  maxCalls: number;
  maxCostCny: number;
  stamp: string;
}
const initial: Policy = { enabled: false, maxCalls: 0, maxCostCny: 0, stamp: '' };
const MAX_BODY = 8000;
const scope = (kind: string) =>
  kind === 'youtube'
    ? 'YouTube Feed 简介（非视频全文）'
    : kind === 'rss'
      ? 'RSS 提供文本（不代表网页全文）'
      : '已采集邮件正文（不含附件）';

export class SummaryService {
  constructor(
    public store: Store,
    public adapter: SiftAdapter,
    public destination: string,
    public transport: typeof fetch = fetch,
  ) {}
  get stamp() {
    return contentHash({
      title: this.adapter.stamp,
      text: this.destination,
      scope: 'summary-disclosure-1',
    });
  }
  policy(): Policy {
    const raw = this.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='summary_policy'",
    );
    return raw ? { ...initial, ...JSON.parse(raw.value) } : { ...initial };
  }
  describe() {
    const totals = this.store.get<{
      calls: number;
      reserved: number;
      actual: number;
      unknown: number;
    }>(
      `SELECT count(*) calls,COALESCE(sum(max(reserved_micro,COALESCE(actual_micro,0))),0) reserved,COALESCE(sum(actual_micro),0) actual,sum(CASE WHEN actual_micro IS NULL THEN 1 ELSE 0 END) unknown FROM model_calls`,
    )!;
    return {
      ...this.policy(),
      ready: this.adapter.available,
      unavailableReason: this.adapter.unavailableReason || '',
      currentStamp: this.stamp,
      model: this.adapter.model,
      destination: 'https://api.deepseek.com',
      calls: totals.calls,
      reservedCny: totals.reserved / 1e6,
      measuredCny: totals.actual / 1e6,
      unknownUsageCalls: totals.unknown || 0,
      inputPrice: this.adapter.inputPrice,
      outputPrice: this.adapter.outputPrice,
    };
  }
  configure(input: unknown) {
    const body = input as Partial<Policy> & { confirmed?: boolean };
    if (
      body.confirmed !== true ||
      typeof body.enabled !== 'boolean' ||
      !Number.isInteger(body.maxCalls) ||
      body.maxCalls! < 0 ||
      body.maxCalls! > 10000 ||
      !Number.isFinite(body.maxCostCny) ||
      body.maxCostCny! < 0 ||
      body.maxCostCny! > 10000 ||
      (body.enabled && (!this.adapter.available || !body.maxCalls || !body.maxCostCny))
    )
      throw new AppError('INVALID_SUMMARY_POLICY');
    this.store.tx(() => {
      this.store.run(
        "INSERT INTO meta VALUES ('summary_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify({
          enabled: body.enabled,
          maxCalls: body.maxCalls,
          maxCostCny: body.maxCostCny,
          stamp: this.stamp,
        }),
      );
      if (!body.enabled)
        this.store.run("UPDATE sources SET summary_mode='off',summary_notify=0,summary_consent=''");
      this.store.event('summary_policy_changed', 'default', body.enabled ? 'enabled' : 'disabled');
      this.reconcile();
    });
    return this.describe();
  }
  authorize(sourceId: string, mode: unknown, notify: unknown, confirmed: unknown) {
    if (
      !['off', 'manual', 'auto'].includes(String(mode)) ||
      typeof notify !== 'boolean' ||
      confirmed !== true
    )
      throw new AppError('SUMMARY_CONFIRMATION_REQUIRED');
    const source = this.store.source(sourceId);
    if (mode !== 'off' && (!source.enabled || !this.allowed()))
      throw new AppError('SUMMARY_NOT_ENABLED');
    this.store.tx(() => {
      this.store.run(
        'UPDATE sources SET summary_mode=?,summary_notify=?,summary_consent=?,summary_since=? WHERE id=?',
        mode as string,
        mode === 'off' ? 0 : +notify,
        mode === 'off' ? '' : this.stamp,
        this.store.now(),
        sourceId,
      );
      if (!notify)
        this.store.run(
          "UPDATE deliveries SET status='cancelled',snapshot='',error='SUMMARY_PUSH_REVOKED' WHERE status IN ('pending','retry_wait') AND item_id IN (SELECT output_item FROM summaries WHERE source_id=?)",
          sourceId,
        );
      this.store.event('summary_consent_changed', sourceId, String(mode));
      this.reconcile();
    });
    return this.store.source(sourceId);
  }
  private allowed() {
    const p = this.policy();
    return p.enabled && p.stamp === this.stamp && this.adapter.available;
  }
  private authorized(row: SummaryRow) {
    const source = this.store.get<Source>('SELECT * FROM sources WHERE id=?', row.source_id);
    const item = this.store.get<Item>('SELECT * FROM items WHERE id=?', row.item_id);
    return (
      this.allowed() &&
      source?.enabled &&
      !source.deleted &&
      source.summary_mode !== 'off' &&
      (row.origin !== 'auto' || source.summary_mode === 'auto') &&
      source.summary_consent === row.stamp &&
      source.generation === row.generation &&
      row.stamp === this.stamp &&
      item &&
      !item.expired &&
      contentHash({ title: item.title, text: item.text, scope: row.scope }) ===
        row.cache_key.split(':')[0]
    );
  }
  reconcile() {
    for (const row of this.store.all<SummaryRow>(
      "SELECT * FROM summaries WHERE status NOT IN ('cancelled','expired')",
    )) {
      if (this.authorized(row)) continue;
      this.store.run(
        "UPDATE summaries SET status='cancelled',error='SUMMARY_CONSENT_OR_CONTENT_CHANGED',input='',result='',token='',lease=0 WHERE id=?",
        row.id,
      );
      if (row.output_item) {
        this.store.run("UPDATE items SET text='',expired=1 WHERE id=?", row.output_item);
        this.store.run(
          "UPDATE deliveries SET snapshot='',status=CASE WHEN status IN ('pending','retry_wait') THEN 'cancelled' ELSE status END,error='SUMMARY_CONSENT_REVOKED' WHERE item_id=?",
          row.output_item,
        );
      }
    }
    this.store.run(
      "UPDATE summaries SET status='unknown',error='SUMMARY_INTERRUPTED',token='',lease=0 WHERE status='running' AND lease<=?",
      this.store.now(),
    );
    this.store.run(
      "UPDATE model_calls SET status='unknown' WHERE status='running' AND NOT EXISTS(SELECT 1 FROM summaries s WHERE s.id=model_calls.summary_id AND s.status='running')",
    );
  }
  enqueue(itemId: string, origin: 'manual' | 'auto' = 'manual', retry = false) {
    return this.store.tx(() => {
      if (!this.allowed()) throw new AppError('SUMMARY_NOT_ENABLED');
      const item = this.store.get<Item>('SELECT * FROM items WHERE id=?', itemId);
      if (!item || item.expired) throw new AppError('CONTENT_EXPIRED');
      if (!['youtube', 'email', 'rss'].includes(item.kind))
        throw new AppError('SUMMARY_NO_CONTENT');
      const cached = this.store
        .all<SummaryRow>(
          'SELECT * FROM summaries WHERE item_id=? AND stamp=? ORDER BY created DESC',
          itemId,
          this.stamp,
        )
        .find((row) => !['cancelled', 'expired'].includes(row.status) && this.authorized(row));
      const source = cached
        ? this.store.source(cached.source_id)
        : this.store.get<Source>(
            `SELECT s.* FROM sources s JOIN source_items si ON si.source_id=s.id WHERE si.item_id=? AND s.enabled=1 AND s.deleted=0 AND s.summary_mode IN (${origin === 'auto' ? "'auto'" : "'manual','auto'"}) AND s.summary_consent=? ORDER BY s.created LIMIT 1`,
            itemId,
            this.stamp,
          );
      if (!source) throw new AppError('SUMMARY_SOURCE_NOT_AUTHORIZED');
      const input = { title: item.title, text: item.text, scope: scope(item.kind) };
      const key = `${contentHash(input)}:${this.stamp}:${itemId}:${source.id}:${source.generation}`;
      const old = this.store.get<SummaryRow>('SELECT * FROM summaries WHERE cache_key=?', key);
      if (old) {
        if (
          (retry && ['failed', 'unknown'].includes(old.status)) ||
          (origin === 'manual' && old.status === 'cancelled')
        ) {
          if (item.text.length > MAX_BODY) throw new AppError('SUMMARY_CONTENT_TOO_LONG');
          if (!item.text.trim()) throw new AppError('SUMMARY_NO_CONTENT');
          this.store.run(
            "UPDATE summaries SET status='queued',error='',input=?,origin=?,notify=?,result='',finished=NULL,token='',lease=0 WHERE id=?",
            JSON.stringify(input),
            origin,
            +!!source.summary_notify,
            old.id,
          );
          this.store.event('summary_retry_confirmed', old.id);
        }
        return old.id;
      }
      const id = randomUUID();
      this.store.run(
        'INSERT INTO summaries(id,cache_key,item_id,source_id,generation,stamp,input,scope,origin,notify,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id,
        key,
        itemId,
        source.id,
        source.generation,
        this.stamp,
        JSON.stringify(input),
        input.scope,
        origin,
        +!!source.summary_notify,
        this.store.now(),
      );
      if (item.text.length > MAX_BODY)
        this.store.run(
          "UPDATE summaries SET status='failed',error='SUMMARY_CONTENT_TOO_LONG',input='' WHERE id=?",
          id,
        );
      if (!item.text.trim())
        this.store.run(
          "UPDATE summaries SET status='failed',error='SUMMARY_NO_CONTENT',input='' WHERE id=?",
          id,
        );
      this.store.event('summary_queued', id, origin);
      return id;
    });
  }
  schedule() {
    if (!this.allowed()) return;
    // Auto mode starts after consent. It does not upload the pre-existing inbox or silent baseline.
    for (const row of this.store.all<{ id: string }>(
      `SELECT DISTINCT i.id FROM items i JOIN source_items si ON si.item_id=i.id JOIN sources s ON s.id=si.source_id JOIN deliveries d ON d.item_id=i.id WHERE i.kind IN ('youtube','rss','email') AND i.expired=0 AND s.enabled=1 AND s.deleted=0 AND s.summary_mode='auto' AND s.summary_consent=? AND NOT EXISTS(SELECT 1 FROM summaries a WHERE a.item_id=i.id AND a.stamp=?) AND i.discovered>s.summary_since ORDER BY i.discovered LIMIT 100`,
      this.stamp,
      this.stamp,
    )) {
      try {
        this.enqueue(row.id, 'auto');
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
  }
  list(itemId: string) {
    return this.store
      .all<SummaryRow>(
        'SELECT * FROM summaries WHERE item_id=? ORDER BY created DESC,rowid DESC LIMIT 5',
        itemId,
      )
      .map((row) => ({
        id: row.id,
        status: row.status,
        error: row.error,
        scope: row.scope,
        created: row.created,
        finished: row.finished,
        result: row.result ? (JSON.parse(row.result) as Brief) : null,
        current: row.stamp === this.stamp && !!this.authorized(row),
        output: row.output_item
          ? this.store.get('SELECT status,error FROM deliveries WHERE item_id=?', row.output_item)
          : null,
        calls: this.store.all(
          'SELECT at,status,input_tokens,output_tokens,reserved_micro,actual_micro FROM model_calls WHERE summary_id=? ORDER BY at,rowid',
          row.id,
        ),
      }));
  }
  async cycle(destination: string) {
    if (destination !== this.destination) throw new AppError('DESTINATION_CHANGED');
    this.reconcile();
    const row = this.store.tx(() => {
      const next = this.store.get<SummaryRow>(
        "SELECT * FROM summaries WHERE status='queued' ORDER BY created,rowid LIMIT 1",
      );
      if (!next) return;
      const token = randomUUID();
      this.store.run(
        "UPDATE summaries SET status='running',token=?,lease=? WHERE id=?",
        token,
        this.store.now() + 120000,
        next.id,
      );
      return { ...next, token };
    });
    if (!row) return;
    const active = () => {
      const current = this.store.get<SummaryRow>('SELECT * FROM summaries WHERE id=?', row.id);
      if (
        !current ||
        current.status !== 'running' ||
        current.token !== row.token ||
        current.lease <= this.store.now() ||
        !this.authorized(row)
      )
        throw new AppError('SUMMARY_CONSENT_REVOKED');
    };
    let boundaryError: AppError | undefined;
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 60000);
    const revoke = setInterval(() => {
      try {
        active();
      } catch {
        controller.abort();
      }
    }, 250);
    try {
      active();
      let requests = 0;
      const guarded: typeof fetch = async (url, init) => {
        if (controller.signal.aborted) throw new AppError('SUMMARY_TIMEOUT_OR_CANCELLED');
        if (++requests > 2) throw new AppError('SUMMARY_TASK_CALL_LIMIT');
        if (
          String(url) !== MODEL_ENDPOINT ||
          init?.method !== 'POST' ||
          typeof init.body !== 'string' ||
          Buffer.byteLength(init.body) > 100000
        )
          throw new AppError('SUMMARY_REQUEST_BLOCKED');
        const body = JSON.parse(init.body);
        if (
          body.model !== this.adapter.model ||
          !Number.isInteger(body.max_tokens) ||
          body.max_tokens < 1 ||
          body.max_tokens > 2600
        )
          throw new AppError('SUMMARY_REQUEST_BLOCKED');
        const reserved = Math.ceil(
          Buffer.byteLength(init.body) * this.adapter.inputPrice +
            body.max_tokens * this.adapter.outputPrice,
        );
        const id = randomUUID();
        this.store.tx(() => {
          active();
          const p = this.policy(),
            total = this.describe();
          if (
            total.calls >= p.maxCalls ||
            Math.round(total.reservedCny * 1e6) + reserved > Math.floor(p.maxCostCny * 1e6)
          )
            throw new AppError('SUMMARY_BUDGET_EXHAUSTED');
          this.store.run(
            "INSERT INTO model_calls(id,summary_id,at,status,reserved_micro) VALUES (?,?,?,'running',?)",
            id,
            row.id,
            this.store.now(),
            reserved,
          );
        });
        try {
          const data = await boundedModelFetch(this.transport, url, {
            ...init,
            signal: AbortSignal.any([controller.signal, init?.signal || controller.signal]),
          });
          const usage = data?.usage;
          const measured =
            usage &&
            Number.isSafeInteger(usage.prompt_tokens) &&
            usage.prompt_tokens >= 0 &&
            usage.prompt_tokens <= 10000000 &&
            Number.isSafeInteger(usage.completion_tokens) &&
            usage.completion_tokens >= 0 &&
            usage.completion_tokens <= 10000000;
          const cost = measured
            ? Math.ceil(
                usage.prompt_tokens * this.adapter.inputPrice +
                  usage.completion_tokens * this.adapter.outputPrice,
              )
            : null;
          this.store.run(
            "UPDATE model_calls SET status='received',input_tokens=?,output_tokens=?,actual_micro=? WHERE id=?",
            measured ? usage.prompt_tokens : null,
            measured ? usage.completion_tokens : null,
            cost,
            id,
          );
          if (cost !== null && cost > reserved) {
            this.store.run(
              "UPDATE meta SET value=json_set(value,'$.enabled',json('false')) WHERE key='summary_policy'",
            );
            throw new AppError('SUMMARY_PRICE_BOUND_EXCEEDED');
          }
          active();
          return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          this.store.run(
            "UPDATE model_calls SET status=CASE WHEN status='running' THEN 'unknown' ELSE status END WHERE id=?",
            id,
          );
          throw error;
        }
      };
      const request: typeof fetch = async (...args) => {
        try {
          return await guarded(...args);
        } catch (error) {
          if (error instanceof AppError) boundaryError = error;
          throw error;
        }
      };
      const input = JSON.parse(row.input) as SummaryInput;
      const result = validateBrief(
        await this.adapter.run(input, request, controller.signal),
        input.text,
      );
      this.store.tx(() => {
        active();
        const source = this.store.source(row.source_id);
        let output = '';
        if (row.notify && source.summary_notify && source.notify) {
          const original = this.store.get<Item>('SELECT * FROM items WHERE id=?', row.item_id)!;
          const main =
            `AI 摘要${this.adapter.model === 'demo-sift' ? '（模拟）' : ''} · ${input.scope}\n${input.title}\n\n${result.oneLiner}\n\n` +
            result.points.map((p) => `${p.title}：${p.text}\n原文引用：${p.quote}`).join('\n\n');
          const tail = `\n\n仅供参考，请核对原文。\n`;
          const text =
            main +
            tail +
            (Array.from(main + tail + original.url).length < 3900 && original.url
              ? original.url
              : '请在 FeedRelay 或邮箱查看原文');
          const item = this.store.put(
            {
              key: `summary:${row.id}`,
              kind: 'summary',
              title: `AI 摘要 · ${input.title}`,
              author: 'Sift',
              text,
              url: '',
            },
            [source],
            false,
            destination,
          );
          output = item.id;
          this.store.run(
            'INSERT INTO deliveries(id,item_id,destination,snapshot,available,created) VALUES (?,?,?,?,?,?)',
            randomUUID(),
            item.id,
            destination,
            text,
            this.store.now(),
            this.store.now(),
          );
        }
        this.store.run(
          "UPDATE summaries SET status='succeeded',result=?,input='',finished=?,token='',lease=0,output_item=? WHERE id=?",
          JSON.stringify(result),
          this.store.now(),
          output,
          row.id,
        );
      });
    } catch (error) {
      this.store.run(
        "UPDATE summaries SET status='failed',error=?,input='',finished=?,token='',lease=0 WHERE id=? AND status='running' AND token=?",
        boundaryError?.code || (error instanceof AppError ? error.code : 'SIFT_SUMMARY_FAILED'),
        this.store.now(),
        row.id,
        row.token,
      );
    } finally {
      clearTimeout(timeout);
      clearInterval(revoke);
    }
  }
}
