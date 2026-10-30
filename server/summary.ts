import { randomUUID } from 'node:crypto';
import { AppError } from './config.js';
import { Store, type Delivery, type Item, type Source } from './store.js';
import {
  MODEL_ENDPOINT,
  contentHash,
  validateBrief,
  boundedModelFetch,
  type SummaryAdapter,
  type SummaryInput,
  type Brief,
  summaryLimits,
  BriefValidationError,
} from './deepseek.js';
import {
  CAPTION_SCOPE,
  ASR_SCOPE,
  captionEvidence,
  type Caption,
  type CaptionAdapter,
} from './captions.js';

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
  material: string;
}
interface Policy {
  enabled: boolean;
  maxCalls: number;
  maxCostCny: number;
  stamp: string;
}
const initial: Policy = { enabled: false, maxCalls: 0, maxCostCny: 0, stamp: '' };
const MAX_BODY = 20000;
const scope = (kind: string) =>
  kind === 'youtube'
    ? 'YouTube Feed 简介（非视频全文）'
    : kind === 'rss'
      ? 'RSS 提供文本（不代表网页全文）'
      : '已采集邮件正文（不含附件）';

export class SummaryService {
  executionGuard?: () => void;
  private controller?: AbortController;
  cancel() {
    this.controller?.abort();
  }
  constructor(
    public store: Store,
    public adapter: SummaryAdapter,
    public destination: string,
    public transport: typeof fetch = fetch,
    public captions?: CaptionAdapter,
  ) {}
  get stamp() {
    return contentHash({
      title: this.adapter.stamp,
      text: this.destination,
      scope: `summary-disclosure-2:${this.captions?.stamp || 'no-captions'}`,
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
      captionsReady: !!this.captions?.available,
      asrReady: !!this.captions?.asrAvailable,
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
  authorize(
    sourceId: string,
    mode: unknown,
    notify: unknown,
    confirmed: unknown,
    content?: unknown,
  ) {
    if (
      !['off', 'manual', 'auto'].includes(String(mode)) ||
      typeof notify !== 'boolean' ||
      confirmed !== true
    )
      throw new AppError('SUMMARY_CONFIRMATION_REQUIRED');
    const source = this.store.source(sourceId);
    content ??= source.summary_content;
    if (
      !['feed', 'captions'].includes(String(content)) ||
      (content === 'captions' && source.type !== 'youtube')
    )
      throw new AppError('INVALID_SUMMARY_CONTENT');
    if (mode !== 'off' && content === 'captions' && !this.captions?.available)
      throw new AppError('YOUTUBE_RUNTIME_UNAVAILABLE');
    if (mode !== 'off' && (!source.enabled || !this.allowed()))
      throw new AppError('SUMMARY_NOT_ENABLED');
    this.store.tx(() => {
      this.store.run(
        'UPDATE sources SET summary_mode=?,summary_notify=?,summary_consent=?,summary_since=?,summary_content=? WHERE id=?',
        mode as string,
        mode === 'off' ? 0 : +notify,
        mode === 'off' ? '' : this.stamp,
        this.store.now(),
        content as string,
        sourceId,
      );
      if (!notify) {
        for (const d of this.store.all<{ id: string }>(
          "SELECT id FROM deliveries WHERE status='sending' AND item_id IN (SELECT output_item FROM summaries WHERE source_id=?)", sourceId,
        )) this.store.blockContextRecovery(d.id);
        this.store.run(
          "UPDATE deliveries SET status='cancelled',snapshot='',error='SUMMARY_PUSH_REVOKED' WHERE (status IN ('pending','retry_wait') OR (status='failed' AND error IN ('WEIXIN_CONTEXT_REJECTED','WEIXIN_NEEDS_MESSAGE'))) AND item_id IN (SELECT output_item FROM summaries WHERE source_id=?)",
          sourceId,
        );
      }
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
      (source.summary_content === 'captions') === (row.scope === CAPTION_SCOPE) &&
      (row.scope !== CAPTION_SCOPE || this.captions?.available) &&
      source.generation === row.generation &&
      row.stamp === this.stamp &&
      item &&
      !item.expired &&
      contentHash({ title: item.title, text: item.text, scope: row.scope }) ===
        row.cache_key.split(':')[0]
    );
  }
  reconcile() {
    for (const delivery of this.store.all<Delivery>(
      "SELECT * FROM deliveries WHERE resolution LIKE 'summary:%' AND status IN ('pending','retry_wait','digest_wait','batched')",
    )) {
      const row = this.store.get<SummaryRow>('SELECT * FROM summaries WHERE id=?', delivery.resolution.slice(8));
      if (row?.status === 'succeeded' && this.authorized(row)) continue;
      this.store.run(
        "UPDATE deliveries SET status='cancelled',error='SUMMARY_CONSENT_REVOKED' WHERE id=? OR (id=? AND status IN ('pending','retry_wait'))",
        delivery.id, delivery.part_id,
      );
    }
    for (const row of this.store.all<SummaryRow>(
      "SELECT * FROM summaries WHERE status NOT IN ('cancelled','expired')",
    )) {
      if (this.authorized(row)) continue;
      this.store.run(
        "UPDATE summaries SET status='cancelled',error='SUMMARY_CONSENT_OR_CONTENT_CHANGED',input='',result='',material='',token='',lease=0 WHERE id=?",
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
    this.store.run(
      "DELETE FROM meta WHERE key LIKE 'summary-progress:%' AND NOT EXISTS(SELECT 1 FROM summaries s WHERE 'summary-progress:' || s.id=meta.key AND s.status='running')",
    );
    this.prepareDeliveries();
  }
  request(itemId: string, content: unknown, retry = false, refresh = false) {
    if (!['feed', 'captions'].includes(String(content)))
      throw new AppError('INVALID_SUMMARY_CONTENT');
    const item = this.store.get<Item>('SELECT * FROM items WHERE id=?', itemId);
    if (!item || item.expired) throw new AppError('CONTENT_EXPIRED');
    const source = this.store.get<Source>(
      'SELECT s.* FROM sources s JOIN source_items si ON si.source_id=s.id WHERE si.item_id=? AND s.enabled=1 AND s.deleted=0 ORDER BY s.created LIMIT 1',
      itemId,
    );
    if (!source) throw new AppError('SUMMARY_SOURCE_NOT_AUTHORIZED');
    if (
      source.summary_consent !== this.stamp ||
      source.summary_mode === 'off' ||
      source.summary_content !== content
    )
      this.authorize(source.id, 'manual', false, true, content);
    return this.enqueue(itemId, 'manual', retry, refresh);
  }
  enqueue(itemId: string, origin: 'manual' | 'auto' = 'manual', retry = false, refresh = false) {
    return this.store.tx(() => {
      if (!this.allowed()) throw new AppError('SUMMARY_NOT_ENABLED');
      const item = this.store.get<Item>('SELECT * FROM items WHERE id=?', itemId);
      if (!item || item.expired) throw new AppError('CONTENT_EXPIRED');
      if (!['youtube', 'email', 'rss'].includes(item.kind))
        throw new AppError('SUMMARY_NO_CONTENT');
      const cached = this.store
        .all<SummaryRow>(
          'SELECT * FROM summaries WHERE item_id=? AND stamp=? ORDER BY created DESC,rowid DESC',
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
      const isCaption = source.summary_content === 'captions';
      const input = {
        title: item.title,
        text: item.text,
        scope: isCaption ? CAPTION_SCOPE : scope(item.kind),
      };
      const key = `${contentHash(input)}:${this.stamp}:${itemId}:${source.id}:${source.generation}`;
      const old = this.store.get<SummaryRow>('SELECT * FROM summaries WHERE cache_key=?', key);
      if (old) {
        if (origin === 'manual' && old.status === 'queued' && old.origin === 'auto')
          this.store.run("UPDATE summaries SET origin='manual' WHERE id=?", old.id);
        if (
          (retry && ['failed', 'unknown'].includes(old.status)) ||
          (refresh && old.status === 'succeeded') ||
          (origin === 'manual' && old.status === 'cancelled')
        ) {
          if (!isCaption && item.text.length > MAX_BODY)
            throw new AppError('SUMMARY_CONTENT_TOO_LONG');
          if (!isCaption && !item.text.trim()) throw new AppError('SUMMARY_NO_CONTENT');
          if (old.output_item)
            this.store.run(
              "UPDATE deliveries SET status='cancelled',snapshot='',error='SUMMARY_REPLACED' WHERE item_id=? AND status IN ('pending','retry_wait')",
              old.output_item,
            );
          this.store.run(
            "UPDATE summaries SET status='queued',error='',input=?,origin=?,notify=?,result='',finished=NULL,token='',lease=0,output_item='' WHERE id=?",
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
      if (!isCaption && item.text.length > MAX_BODY)
        this.store.run(
          "UPDATE summaries SET status='failed',error='SUMMARY_CONTENT_TOO_LONG',input='' WHERE id=?",
          id,
        );
      if (!isCaption && !item.text.trim())
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
        scope:
          row.material && (JSON.parse(row.material) as Caption).kind === 'transcribed'
            ? ASR_SCOPE
            : row.scope,
        progress:
          row.status === 'running'
            ? JSON.parse(
                this.store.get<{ value: string }>(
                  'SELECT value FROM meta WHERE key=?',
                  `summary-progress:${row.id}`,
                )?.value || 'null',
              )
            : null,
        created: row.created,
        finished: row.finished,
        result: row.result ? (JSON.parse(row.result) as Brief) : null,
        revision: this.resultRevision(row),
        caption: row.material
          ? (({ language, kind, hash }) => ({ language, kind, hash }))(
              JSON.parse(row.material) as Caption,
            )
          : null,
        current: row.stamp === this.stamp && !!this.authorized(row),
        output: this.store.get(
          'SELECT id,item_id,status,error,resolution FROM deliveries WHERE item_id=? OR (item_id=? AND resolution=?)',
          row.output_item,
          row.item_id,
          `summary:${row.id}`,
        ) || null,
        calls: this.store.all(
          'SELECT at,status,input_tokens,output_tokens,reserved_micro,actual_micro FROM model_calls WHERE summary_id=? ORDER BY at,rowid',
          row.id,
        ),
      }));
  }
  private resultRevision(row: SummaryRow) {
    return contentHash({ title: row.id, text: row.result, scope: `${row.finished}:${row.stamp}` });
  }
  transcript(itemId: string) {
    const row = this.store
      .all<SummaryRow>(
        "SELECT * FROM summaries WHERE item_id=? AND material<>'' ORDER BY created DESC,rowid DESC",
        itemId,
      )
      .find((row) => this.authorized(row));
    if (!row) return null;
    const caption = JSON.parse(row.material) as Caption;
    captionEvidence({ oneLiner: '', points: [] }, caption);
    return { language: caption.language, kind: caption.kind, text: caption.text };
  }
  private notificationText(title: string, result: Brief) {
    const text =
      `${title}${this.adapter.model === 'demo-deepseek' ? '（模拟摘要）' : ''}\n\n` +
      result.points.map((p, index) => `${index + 1}. ${p.title}\n${p.text}`).join('\n\n');
    if (Array.from(text).length > 3900) throw new AppError('SUMMARY_PUSH_TOO_LONG');
    return text;
  }
  prepareDeliveries() {
    // Keep the original delivery identity, retry state and digest membership.
    for (const delivery of this.store.all<Delivery & { title: string }>(
      `SELECT d.*,i.title FROM deliveries d JOIN items i ON i.id=d.item_id WHERE i.kind IN ('youtube','email','rss') AND i.expired=0 AND d.status IN ('pending','retry_wait','digest_wait')`,
    )) {
      const required = delivery.error === 'SUMMARY_REQUIRED' ||
        delivery.resolution.startsWith('summary:') || this.store.get(
          `SELECT 1 FROM source_items si JOIN sources s ON s.id=si.source_id WHERE si.item_id=? AND s.enabled=1 AND s.notify=1 AND s.deleted=0 AND s.summary_mode<>'off'`,
          delivery.item_id,
        );
      if (!required) continue;
      const row = this.store.all<SummaryRow>(
        'SELECT * FROM summaries WHERE item_id=? ORDER BY created DESC,rowid DESC',
        delivery.item_id,
      ).find((r) => this.authorized(r) && this.store.source(r.source_id).notify);
      let text = '';
      if (row?.status === 'succeeded' && row.result) {
        try {
          const result = JSON.parse(row.result) as Brief;
          if (row.material) captionEvidence(result, JSON.parse(row.material) as Caption);
          const next = this.notificationText(delivery.title, result);
          if (!delivery.attempt || next === delivery.snapshot) text = next;
        } catch {
          // Invalid/oversized output stays blocked rather than sending the source preview.
        }
      }
      const error = text
        ? (delivery.attempt && delivery.error !== 'SUMMARY_REQUIRED' ? delivery.error : '')
        : 'SUMMARY_REQUIRED';
      const resolution = row && text ? `summary:${row.id}` : delivery.resolution;
      if (text === delivery.snapshot && error === delivery.error && resolution === delivery.resolution) continue;
      this.store.run(
        'UPDATE deliveries SET snapshot=?,error=?,resolution=? WHERE id=?',
        text,
        error,
        resolution,
        delivery.id,
      );
    }
  }
  private queueOutput(row: SummaryRow, input: SummaryInput, result: Brief) {
    const text = this.notificationText(input.title, result);
    const original = this.store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', row.item_id);
    if (original?.snapshot === text && original.status !== 'cancelled') return row.item_id;
    if (
      row.output_item &&
      this.store.get('SELECT status FROM deliveries WHERE item_id=?', row.output_item)?.status !==
        'cancelled'
    )
      return row.output_item;
    const source = this.store.source(row.source_id);
    const item = this.store.put(
      {
        key: `summary:${row.id}:${randomUUID()}`,
        kind: 'summary',
        title: `AI 摘要 · ${input.title}`,
        author: 'DeepSeek',
        text,
        url: '',
      },
      [source],
      false,
      this.destination,
    );
    this.store.run(
      'INSERT INTO deliveries(id,item_id,destination,snapshot,available,created) VALUES (?,?,?,?,?,?)',
      randomUUID(),
      item.id,
      this.destination,
      text,
      this.store.now(),
      this.store.now(),
    );
    this.store.run('UPDATE summaries SET output_item=? WHERE id=?', item.id, row.id);
    return item.id;
  }
  pushLatest(itemId: string, summaryId: unknown, revision: unknown) {
    this.prepareDeliveries();
    return this.store.tx(() => {
      const row = this.store
        .all<SummaryRow>(
          'SELECT * FROM summaries WHERE item_id=? ORDER BY created DESC,rowid DESC',
          itemId,
        )
        .find((row) => this.authorized(row));
      if (
        !row ||
        row.id !== summaryId ||
        row.status !== 'succeeded' ||
        !row.result ||
        revision !== this.resultRevision(row)
      )
        throw new AppError('SUMMARY_PUSH_STALE', 409);
      const original = this.store.get<Item>('SELECT * FROM items WHERE id=?', itemId)!;
      const caption = row.material ? (JSON.parse(row.material) as Caption) : undefined;
      const result = JSON.parse(row.result) as Brief;
      if (caption) captionEvidence(result, caption);
      const output = this.queueOutput(
        row,
        { title: original.title, text: original.text, scope: row.scope },
        result,
      );
      this.store.event('summary_push_confirmed', output, row.id);
      return this.store.get(
        'SELECT id,item_id,status,error,resolution FROM deliveries WHERE item_id=?',
        output,
      )!;
    });
  }
  async cycle(destination: string) {
    if (destination !== this.destination) throw new AppError('DESTINATION_CHANGED');
    this.reconcile();
    const row = this.store.tx(() => {
      const next = this.store.get<SummaryRow>(
        "SELECT * FROM summaries WHERE status='queued' ORDER BY (origin='manual') DESC,created,rowid LIMIT 1",
      );
      if (!next) return;
      const token = randomUUID();
      this.store.run(
        "UPDATE summaries SET status='running',token=?,lease=? WHERE id=?",
        token,
        this.store.now() +
          (next.scope === CAPTION_SCOPE && this.captions?.asrAvailable
            ? 2160000
            : next.scope === CAPTION_SCOPE
              ? 300000
              : 120000),
        next.id,
      );
      return { ...next, token };
    });
    if (!row) return;
    const active = () => {
      this.executionGuard?.();
      const current = this.store.get<SummaryRow>('SELECT * FROM summaries WHERE id=?', row.id);
      if (
        !current ||
        current.status !== 'running' ||
        current.token !== row.token ||
        current.lease <= this.store.now() ||
        controller.signal.aborted ||
        !this.authorized(row)
      )
        throw new AppError('SUMMARY_CONSENT_REVOKED');
    };
    const isCaption = row.scope === CAPTION_SCOPE;
    const limits = summaryLimits(isCaption);
    const timeoutMs = isCaption && this.captions?.asrAvailable ? 2100000 : limits.timeoutMs;
    let boundaryError: AppError | undefined;
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), timeoutMs);
    this.controller = controller;
    let lastStage = '';
    const progress = (stage: string, percent = 0) => {
      active();
      if (stage !== lastStage) {
        this.store.event('summary_stage', row.id, stage);
        lastStage = stage;
      }
      this.store.run(
        'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        `summary-progress:${row.id}`,
        JSON.stringify({ stage, percent }),
      );
    };
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
        if (++requests > limits.maxCalls) throw new AppError('SUMMARY_TASK_CALL_LIMIT');
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
      let caption: Caption | undefined;
      if (isCaption) {
        progress('captions');
        if (!this.captions?.available) throw new AppError('YOUTUBE_RUNTIME_UNAVAILABLE');
        const item = this.store.get<Item>('SELECT * FROM items WHERE id=?', row.item_id)!;
        const videoId = item.key.match(/^youtube:([a-zA-Z0-9_-]{11})$/)?.[1];
        if (!videoId) throw new AppError('YOUTUBE_INVALID_VIDEO_ID');
        caption = row.material
          ? (JSON.parse(row.material) as Caption)
          : await this.captions.fetch(videoId, controller.signal, progress);
        active();
        if (caption.videoId !== videoId) throw new AppError('YOUTUBE_CAPTION_CACHE_INVALID');
        captionEvidence({ oneLiner: '', points: [] }, caption);
        this.store.run(
          'UPDATE summaries SET material=? WHERE id=? AND token=?',
          JSON.stringify(caption),
          row.id,
          row.token,
        );
        input.text = caption.text;
        input.captions = true;
        if (caption.kind === 'transcribed') input.scope = ASR_SCOPE;
      }
      progress('summarizing');
      let result = validateBrief(
        await this.adapter.run(input, request, controller.signal),
        input.text,
      );
      if (caption) result = captionEvidence(result, caption);
      this.store.tx(() => {
        active();
        this.store.run(
          "UPDATE summaries SET status='succeeded',result=?,input='',finished=?,token='',lease=0,output_item=? WHERE id=?",
          JSON.stringify(result),
          this.store.now(),
          '',
          row.id,
        );
      });
      this.prepareDeliveries();
    } catch (error) {
      if (error instanceof BriefValidationError)
        this.store.event('summary_validation_failed', row.id, `${error.code}:${error.field}:${error.constraint}`);
      this.store.run(
        "UPDATE summaries SET status='failed',error=?,input='',finished=?,token='',lease=0 WHERE id=? AND status='running' AND token=?",
        boundaryError?.code ||
          (error instanceof AppError ? error.code : 'SUMMARY_GENERATION_FAILED'),
        this.store.now(),
        row.id,
        row.token,
      );
    } finally {
      this.controller = undefined;
      this.store.run('DELETE FROM meta WHERE key=?', `summary-progress:${row.id}`);
      clearTimeout(timeout);
      clearInterval(revoke);
    }
  }
}
