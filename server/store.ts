import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, defaults, dayKey, preview, type Settings } from './config.js';
import { migrateV2, migrateV3, migrateV4 } from './migrations.js';

export interface Source {
  id: string;
  type: 'youtube' | 'email' | 'rss';
  feed_url: string;
  delivery_mode: 'immediate' | 'digest';
  summary_mode: 'off' | 'manual' | 'auto';
  summary_notify: number;
  summary_consent: string;
  summary_since: number;
  summary_content: 'feed' | 'captions';
  name: string;
  channel: string;
  sender: string;
  subject: string;
  enabled: number;
  notify: number;
  generation: number;
  initialized: number;
  boundary: number;
  epoch: string;
  baseline: number;
  next_check: number;
  last_success: number | null;
  error: string;
  coverage: string;
  deleted: number;
  created: number;
}
export interface Item {
  id: string;
  key: string;
  kind: 'youtube' | 'email' | 'rss' | 'digest' | 'summary';
  title: string;
  author: string;
  url: string;
  text: string;
  published: number | null;
  received: number | null;
  discovered: number;
  expired: number;
}
export interface Job {
  id: string;
  kind: 'source' | 'mailbox' | 'body' | 'probe';
  resource: string;
  generation: number;
  payload: string;
  status: string;
  attempt: number;
  available: number;
  token: string;
  lease: number;
  error: string;
  result: string;
  created: number;
}
export interface Delivery {
  mode: 'immediate' | 'digest' | 'digest_part';
  batch_id: string;
  part_id: string;
  id: string;
  item_id: string;
  destination: string;
  status: string;
  snapshot: string;
  attempt: number;
  available: number;
  token: string;
  lease: number;
  error: string;
  created: number;
  sent: number | null;
  resolution: string;
}
export interface Incoming {
  key: string;
  kind: Item['kind'];
  title: string;
  author: string;
  url: string;
  text: string;
  published?: number | null;
  received?: number | null;
}
export interface Cursor {
  epoch: string;
  uid: number;
  blocked: number;
}
type Row = Record<string, string | number | null>;
const DAY = 86_400_000;
export const retryDelay = (attempt: number) =>
  [60_000, 300_000, 900_000, 3_600_000][Math.min(attempt - 1, 3)];

export class Store {
  db: DatabaseSync;
  constructor(
    public dir: string,
    mode: 'demo' | 'live' = 'live',
    public now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'feedrelay.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = this.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
    if (version > 4) {
      this.db.close();
      throw new AppError('DATABASE_NEWER_THAN_APP');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '', sender TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0, notify INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1, initialized INTEGER NOT NULL DEFAULT 0,
        boundary INTEGER NOT NULL DEFAULT 0, epoch TEXT NOT NULL DEFAULT '', baseline INTEGER NOT NULL DEFAULT 0, next_check INTEGER NOT NULL DEFAULT 0,
        last_success INTEGER, error TEXT NOT NULL DEFAULT '', coverage TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS source_identity ON sources(type,channel,sender,subject) WHERE deleted=0;
      CREATE TABLE IF NOT EXISTS mailbox_cursors (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, uid INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL, url TEXT NOT NULL, text TEXT NOT NULL,
        published INTEGER, received INTEGER, discovered INTEGER NOT NULL, expired INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS source_items (source_id TEXT REFERENCES sources(id), item_id TEXT REFERENCES items(id), generation INTEGER NOT NULL, PRIMARY KEY(source_id,item_id));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, resource TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL, token TEXT NOT NULL DEFAULT '', lease INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs(kind,resource) WHERE status IN ('pending','running','retry_wait');
      CREATE INDEX IF NOT EXISTS due_job ON jobs(status,available);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, item_id TEXT UNIQUE NOT NULL REFERENCES items(id), destination TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        snapshot TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL, token TEXT NOT NULL DEFAULT '', lease INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, sent INTEGER, resolution TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS due_delivery ON deliveries(status,available);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, n INTEGER NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, code TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS attempts_day ON attempts(day);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL, code TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, token TEXT NOT NULL, until INTEGER NOT NULL);
    `);
    const existingMode = this.get<Row>('SELECT value FROM meta WHERE key=?', 'mode')?.value;
    if (existingMode && existingMode !== mode) {
      this.db.close();
      throw new AppError('DEMO_LIVE_DATABASE_MISMATCH');
    }
    try {
      migrateV2(this.db);
      migrateV3(this.db);
      migrateV4(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'mode', mode);
    this.run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'settings', JSON.stringify(defaults));
  }
  all<T = Row>(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  settings(): Settings {
    return {
      ...defaults,
      ...JSON.parse(
        this.get<Row>('SELECT value FROM meta WHERE key=?', 'settings')!.value as string,
      ),
    };
  }
  setSettings(settings: Settings) {
    this.run('UPDATE meta SET value=? WHERE key=?', JSON.stringify(settings), 'settings');
    this.event('settings', 'default');
  }
  event(action: string, resource: string, code = '') {
    this.run(
      'INSERT INTO events(at,action,resource,code) VALUES (?,?,?,?)',
      this.now(),
      action,
      resource,
      code,
    );
  }
  source(id: string) {
    const s = this.get<Source>('SELECT * FROM sources WHERE id=? AND deleted=0', id);
    if (!s) throw new AppError('SOURCE_NOT_FOUND', 404);
    return s;
  }
  sources() {
    return this.all<Source>(
      `SELECT s.*, (SELECT count(*) FROM source_items si JOIN deliveries d ON d.item_id=si.item_id WHERE si.source_id=s.id AND d.status IN ('pending','retry_wait','unknown','digest_wait')) AS backlog FROM sources s WHERE deleted=0 ORDER BY created DESC`,
    );
  }
  createSource(input: {
    type: Source['type'];
    name: string;
    channel?: string;
    sender?: string;
    subject?: string;
    feed_url?: string;
    delivery_mode?: Source['delivery_mode'];
  }) {
    const id = randomUUID();
    try {
      this.run(
        'INSERT INTO sources(id,type,name,channel,sender,subject,created,feed_url,delivery_mode) VALUES (?,?,?,?,?,?,?,?,?)',
        id,
        input.type,
        input.name,
        input.channel || '',
        input.sender || '',
        input.subject || '',
        this.now(),
        input.feed_url || '',
        input.delivery_mode || 'immediate',
      );
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new AppError('SOURCE_ALREADY_EXISTS', 409);
      throw e;
    }
    this.event('source_created', id);
    return this.source(id);
  }
  toggle(id: string, enabled: boolean, notify: boolean, mode = 'new_only') {
    return this.tx(() => {
      const s = this.source(id);
      if (!enabled && s.type === 'email')
        this.run(
          'UPDATE sources SET boundary=COALESCE((SELECT uid FROM mailbox_cursors WHERE id=1),boundary) WHERE id=?',
          id,
        );
      if (enabled && s.type === 'email' && mode === 'catch_up' && s.initialized)
        this.run('UPDATE mailbox_cursors SET uid=MIN(uid,?) WHERE id=1', s.boundary);
      this.run(
        `UPDATE sources SET enabled=?,notify=?,generation=generation+1,next_check=?,error='',initialized=CASE WHEN ?=1 AND ?='new_only' THEN 0 ELSE initialized END,baseline=CASE WHEN ?=1 AND ?='new_only' THEN 0 ELSE baseline END WHERE id=?`,
        +enabled,
        +notify,
        this.now(),
        +enabled,
        mode,
        +enabled,
        mode,
        id,
      );
      this.cancelSourceJobs(s);
      if (enabled && s.type === 'email')
        this.run('DELETE FROM mailbox_cursors WHERE id=1 AND blocked=1');
      this.cancelOrphans();
      this.event(enabled ? 'source_resumed' : 'source_paused', id, mode);
      return this.source(id);
    });
  }
  edit(id: string, input: { name: string; subject: string }) {
    try {
      this.tx(() => {
        const s = this.source(id);
        this.run(
          `UPDATE sources SET name=?,subject=?,enabled=0,generation=generation+1,initialized=0,baseline=0 WHERE id=?`,
          input.name,
          input.subject,
          id,
        );
        this.cancelSourceJobs(s);
        this.cancelOrphans();
        this.event('source_edited', id);
      });
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new AppError('SOURCE_ALREADY_EXISTS', 409);
      throw e;
    }
    return this.source(id);
  }
  changeDeliveryMode(id: string, mode: Source['delivery_mode']) {
    this.source(id);
    this.run('UPDATE sources SET delivery_mode=? WHERE id=?', mode, id);
    this.event('delivery_mode_changed', id, mode);
    return this.source(id);
  }
  private cancelSourceJobs(s: Source) {
    this.run(
      "UPDATE sources SET summary_mode='off',summary_notify=0,summary_consent='' WHERE id=?",
      s.id,
    );
    for (const row of this.all<{ output_item: string }>(
      'SELECT output_item FROM summaries WHERE source_id=?',
      s.id,
    ))
      if (row.output_item) this.expireItem(row.output_item);
    this.run(
      "UPDATE summaries SET status='cancelled',error='SUMMARY_CONSENT_REVOKED',input='',result='',material='',token='',lease=0 WHERE source_id=? AND status<>'expired'",
      s.id,
    );
    this.run(
      `UPDATE jobs SET status='cancelled',token='',lease=0 WHERE (resource=? OR (?='email' AND kind='mailbox')) AND status IN ('pending','running','retry_wait')`,
      s.id,
      s.type,
    );
  }
  deleteSource(id: string, erase: boolean) {
    this.tx(() => {
      const s = this.source(id);
      this.run(
        'UPDATE sources SET enabled=0,deleted=1,notify=0,generation=generation+1 WHERE id=?',
        id,
      );
      this.cancelSourceJobs(s);
      this.cancelOrphans();
      if (erase) {
        this.run(
          "UPDATE sources SET name='',channel='',sender='',subject='',feed_url='' WHERE id=?",
          id,
        );
        this.run("UPDATE jobs SET payload='{}',result='' WHERE resource=?", id);
        for (const job of this.all<Job>("SELECT * FROM jobs WHERE kind='body'")) {
          const payload = JSON.parse(job.payload);
          if (!payload.rules?.some((r: { id: string }) => r.id === id)) continue;
          payload.rules = payload.rules.filter((r: { id: string }) => r.id !== id);
          this.run(
            "UPDATE jobs SET payload=?,status=CASE WHEN ? THEN 'cancelled' ELSE status END,token=CASE WHEN ? THEN '' ELSE token END,result='' WHERE id=?",
            payload.rules.length ? JSON.stringify(payload) : '{}',
            +!payload.rules.length,
            +!payload.rules.length,
            job.id,
          );
        }
        const items = this.all<{ item_id: string }>(
          'SELECT item_id FROM source_items WHERE source_id=?',
          id,
        );
        this.run('DELETE FROM source_items WHERE source_id=?', id);
        for (const item of items)
          if (
            !this.get(
              'SELECT 1 FROM source_items si JOIN sources s ON s.id=si.source_id WHERE si.item_id=? AND s.deleted=0',
              item.item_id,
            )
          )
            this.expireItem(item.item_id, true);
      }
      this.run('DELETE FROM meta WHERE key=?', `feed:${id}`);
      this.event('source_deleted', id, erase ? 'erase' : 'keep_history');
    });
  }
  private cancelOrphans() {
    this.run(
      `UPDATE deliveries SET status='cancelled',snapshot='',error='SOURCE_DISABLED' WHERE mode<>'digest_part' AND status IN ('pending','retry_wait','digest_wait') AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id=deliveries.item_id AND i.key LIKE 'test:%') AND NOT EXISTS (SELECT 1 FROM source_items si JOIN sources s ON s.id=si.source_id WHERE si.item_id=deliveries.item_id AND s.enabled=1 AND s.notify=1 AND s.deleted=0)`,
    );
    this.run(
      `UPDATE deliveries SET status='cancelled',snapshot='',error='DIGEST_MEMBER_DISABLED' WHERE mode='digest_part' AND status IN ('pending','retry_wait') AND EXISTS(SELECT 1 FROM deliveries member WHERE member.part_id=deliveries.id AND NOT EXISTS(SELECT 1 FROM source_items si JOIN sources s ON s.id=si.source_id WHERE si.item_id=member.item_id AND s.enabled=1 AND s.notify=1 AND s.deleted=0))`,
    );
    this.run(
      `UPDATE items SET text='' WHERE kind='digest' AND id IN (SELECT item_id FROM deliveries WHERE mode='digest_part' AND status='cancelled')`,
    );
  }
  enqueue(kind: Job['kind'], resource: string, generation = 0, payload: object = {}) {
    const id = randomUUID();
    this.run(
      `INSERT OR IGNORE INTO jobs(id,kind,resource,generation,payload,available,created) VALUES (?,?,?,?,?,?,?)`,
      id,
      kind,
      resource,
      generation,
      JSON.stringify(payload),
      this.now(),
      this.now(),
    );
    return this.get<Job>(
      `SELECT * FROM jobs WHERE kind=? AND resource=? AND status IN ('pending','running','retry_wait')`,
      kind,
      resource,
    )!;
  }
  schedule() {
    this.tx(() => {
      const settings = this.settings();
      let mail = false;
      for (const s of this.all<Source>(
        'SELECT * FROM sources WHERE enabled=1 AND deleted=0 AND next_check<=?',
        this.now(),
      )) {
        if (s.type === 'email') mail = true;
        else this.enqueue('source', s.id, s.generation);
        const interval =
          (s.type === 'email' ? settings.mailMinutes : settings.youtubeMinutes) * 60_000;
        this.run(
          'UPDATE sources SET next_check=? WHERE id=?',
          this.now() + interval + Math.floor(Math.random() * interval * 0.05),
          s.id,
        );
      }
      if (mail && !this.get<Cursor>('SELECT * FROM mailbox_cursors WHERE id=1')?.blocked)
        this.enqueue('mailbox', 'default');
    });
  }
  claimJob() {
    return this.tx(() => {
      this.run(
        `UPDATE jobs SET status=CASE WHEN attempt>=5 THEN 'failed' ELSE 'retry_wait' END,available=?,token='',lease=0,error='LEASE_EXPIRED' WHERE status='running' AND lease<=?`,
        this.now(),
        this.now(),
      );
      const j = this.get<Job>(
        `SELECT * FROM jobs WHERE status IN ('pending','retry_wait') AND available<=? AND attempt<5 ORDER BY available,created LIMIT 1`,
        this.now(),
      );
      if (!j) return;
      const token = randomUUID();
      this.run(
        `UPDATE jobs SET status='running',attempt=attempt+1,token=?,lease=? WHERE id=?`,
        token,
        this.now() + 120_000,
        j.id,
      );
      return this.get<Job>('SELECT * FROM jobs WHERE id=?', j.id)!;
    });
  }
  validJob(j: Job) {
    return !!this.get(
      `SELECT 1 FROM jobs WHERE id=? AND token=? AND status='running' AND lease>?`,
      j.id,
      j.token,
      this.now(),
    );
  }
  finishJob(j: Job, error?: AppError, result: object = {}) {
    this.tx(() => {
      if (!this.validJob(j)) return;
      const status = !error
        ? 'succeeded'
        : error.retryable && j.attempt < 5
          ? 'retry_wait'
          : 'failed';
      this.run(
        'UPDATE jobs SET status=?,error=?,result=?,available=?,lease=0,token=? WHERE id=?',
        status,
        error?.code || '',
        JSON.stringify(result),
        this.now() + Math.max(retryDelay(j.attempt), error?.retryAfter || 0),
        '',
        j.id,
      );
      if (j.kind === 'source' && error)
        this.run(
          'UPDATE sources SET error=? WHERE id=? AND generation=?',
          error.code,
          j.resource,
          j.generation,
        );
      if (j.kind === 'mailbox' && error)
        this.run(
          `UPDATE sources SET error=? WHERE type='email' AND enabled=1 AND deleted=0`,
          error.code,
        );
    });
  }
  put(incoming: Incoming, sources: Source[], notify: boolean, destination: string) {
    let item = this.get<Item>('SELECT * FROM items WHERE key=?', incoming.key);
    if (!item) {
      const id = randomUUID();
      this.run(
        'INSERT INTO items(id,key,kind,title,author,url,text,published,received,discovered) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id,
        incoming.key,
        incoming.kind,
        preview(incoming.title, 300),
        preview(incoming.author, 200),
        incoming.url,
        incoming.text,
        incoming.published ?? null,
        incoming.received ?? null,
        this.now(),
      );
      item = this.get<Item>('SELECT * FROM items WHERE id=?', id)!;
    } else if (!item.expired)
      this.run(
        'UPDATE items SET title=?,author=?,text=?,published=?,url=? WHERE id=?',
        preview(incoming.title, 300),
        preview(incoming.author, 200),
        incoming.text,
        incoming.published ?? null,
        incoming.url,
        item.id,
      );
    for (const s of sources)
      this.run(
        'INSERT INTO source_items VALUES (?,?,?) ON CONFLICT(source_id,item_id) DO UPDATE SET generation=excluded.generation',
        s.id,
        item.id,
        s.generation,
      );
    if (notify && !item.expired) {
      const text = `${preview(incoming.title, 300)}\n${preview(incoming.author, 200)}\n${incoming.received ? '收件' : '发布'}：${new Date(incoming.received || incoming.published || this.now()).toISOString()}\n\n${preview(incoming.text)}\n\n${incoming.url || (incoming.kind === 'email' ? '请在邮箱查看原文' : '来源未提供原文链接')}`;
      const eligible = sources.flatMap((s) => {
        const live = this.get<Source>(
          'SELECT * FROM sources WHERE id=? AND enabled=1 AND notify=1 AND deleted=0',
          s.id,
        );
        return live ? [live] : [];
      });
      const mode =
        eligible.length && eligible.every((s) => s.delivery_mode === 'digest')
          ? 'digest'
          : 'immediate';
      this.run(
        'INSERT OR IGNORE INTO deliveries(id,item_id,destination,snapshot,available,created,mode,status) VALUES (?,?,?,?,?,?,?,?)',
        randomUUID(),
        item.id,
        destination,
        text,
        this.now(),
        this.now(),
        mode,
        mode === 'digest' ? 'digest_wait' : 'pending',
      );
    }
    return item;
  }
  claimDelivery(destination: string) {
    return this.tx(() => {
      this.run(
        `UPDATE deliveries SET status='unknown',error='SEND_INTERRUPTED',lease=0,token='' WHERE status='sending' AND lease<=?`,
        this.now(),
      );
      this.run(
        `UPDATE attempts SET status='unknown',code='SEND_INTERRUPTED' WHERE status='sending' AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id=attempts.delivery_id AND d.status='sending')`,
      );
      this.run(
        `UPDATE deliveries SET status='failed',error='DESTINATION_CHANGED' WHERE destination<>? AND status IN ('pending','retry_wait','digest_wait')`,
        destination,
      );
      this.cancelOrphans();
      const settings = this.settings(),
        day = dayKey(this.now(), settings.timezone);
      if (
        Number(this.get<Row>('SELECT count(*) AS n FROM attempts WHERE day=?', day)!.n) >=
        settings.dailyLimit
      )
        return;
      const d = this.get<Delivery>(
        `SELECT * FROM deliveries WHERE status IN ('pending','retry_wait') AND available<=? AND attempt<5 ORDER BY created LIMIT 1`,
        this.now(),
      );
      if (!d) return;
      const token = randomUUID();
      this.run(
        `UPDATE deliveries SET status='sending',token=?,lease=?,attempt=attempt+1 WHERE id=?`,
        token,
        this.now() + 60_000,
        d.id,
      );
      this.run(
        'INSERT INTO attempts(id,delivery_id,n,day,at,status) VALUES (?,?,?,?,?,?)',
        token,
        d.id,
        d.attempt + 1,
        day,
        this.now(),
        'sending',
      );
      return this.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.id)!;
    });
  }
  finishDelivery(
    d: Delivery,
    outcome: {
      status: 'sent' | 'failed' | 'unknown' | 'retry_wait';
      code?: string;
      retryAfter?: number;
    },
  ) {
    this.tx(() => {
      if (
        !this.get(
          'SELECT 1 FROM deliveries WHERE id=? AND token=? AND status=? AND lease>?',
          d.id,
          d.token,
          'sending',
          this.now(),
        )
      )
        return;
      const status = outcome.status === 'retry_wait' && d.attempt >= 5 ? 'failed' : outcome.status;
      this.run(
        'UPDATE deliveries SET status=?,error=?,available=?,sent=?,lease=0,token=? WHERE id=?',
        status,
        outcome.code || '',
        this.now() + Math.max(retryDelay(d.attempt), outcome.retryAfter || 0),
        status === 'sent' ? this.now() : null,
        '',
        d.id,
      );
      this.run(
        'UPDATE attempts SET status=?,code=? WHERE id=?',
        status,
        outcome.code || '',
        d.token,
      );
    });
  }
  resolveDelivery(id: string, action: 'retry' | 'acknowledge', destination: string) {
    this.tx(() => {
      const d = this.get<Delivery>('SELECT * FROM deliveries WHERE id=?', id);
      if (!d || !['failed', 'unknown'].includes(d.status))
        throw new AppError('DELIVERY_NOT_RESOLVABLE', 409);
      if (action === 'retry') {
        if (d.part_id) throw new AppError('RESOLVE_DIGEST_PART', 409);
        if (!d.snapshot || this.get<Item>('SELECT * FROM items WHERE id=?', d.item_id)?.expired)
          throw new AppError('CONTENT_EXPIRED', 409);
        if (
          !this.get(
            'SELECT 1 FROM source_items si JOIN sources s ON s.id=si.source_id WHERE si.item_id=? AND s.enabled=1 AND s.notify=1 AND s.deleted=0',
            d.item_id,
          ) &&
          !this.get("SELECT 1 FROM items WHERE id=? AND key LIKE 'test:%'", d.item_id)
        )
          throw new AppError('SOURCE_DISABLED', 409);
        if (
          d.mode === 'digest_part' &&
          this.get(
            `SELECT 1 FROM deliveries m WHERE m.part_id=? AND NOT EXISTS(SELECT 1 FROM source_items si JOIN sources s ON s.id=si.source_id WHERE si.item_id=m.item_id AND s.enabled=1 AND s.notify=1 AND s.deleted=0)`,
            id,
          )
        )
          throw new AppError('SOURCE_DISABLED', 409);
        this.run(
          `UPDATE deliveries SET status=?,destination=?,attempt=0,available=?,error='',resolution='manual_retry' WHERE id=?`,
          d.mode === 'digest' ? 'digest_wait' : 'pending',
          destination,
          this.now(),
          id,
        );
      } else
        this.run(
          `UPDATE deliveries SET status='sent',resolution='user_acknowledged',error='' WHERE id=?`,
          id,
        );
      this.event('delivery_' + action, id, d.error);
    });
  }
  leaseWorker(token: string) {
    return this.tx(() => {
      this.run('INSERT OR IGNORE INTO locks VALUES (?,?,?)', 'worker', token, 0);
      return (
        Number(
          this.run(
            `UPDATE locks SET token=?,until=? WHERE name='worker' AND (until<=? OR token=?)`,
            token,
            this.now() + 120_000,
            this.now(),
            token,
          ).changes,
        ) === 1
      );
    });
  }
  releaseWorker(token: string) {
    this.run(`DELETE FROM locks WHERE name='worker' AND token=?`, token);
  }
  private expireItem(id: string, eraseMetadata = false) {
    for (const summary of this.all<{ id: string; output_item: string }>(
      'SELECT id,output_item FROM summaries WHERE item_id=?',
      id,
    )) {
      this.run(
        "UPDATE summaries SET input='',result='',material='',status='expired',error='CONTENT_EXPIRED',token='',lease=0 WHERE id=?",
        summary.id,
      );
      if (summary.output_item) this.expireItem(summary.output_item, eraseMetadata);
    }
    const parent = this.get<{ item_id: string }>(
      'SELECT p.item_id FROM deliveries d JOIN deliveries p ON p.id=d.part_id WHERE d.item_id=?',
      id,
    );
    if (parent && parent.item_id !== id) this.expireItem(parent.item_id, eraseMetadata);
    this.run(
      `UPDATE items SET text='',expired=1,title=CASE WHEN ? THEN '' ELSE title END,author=CASE WHEN ? THEN '' ELSE author END,url=CASE WHEN ? THEN '' ELSE url END WHERE id=?`,
      +eraseMetadata,
      +eraseMetadata,
      +eraseMetadata,
      id,
    );
    this.run(
      `UPDATE deliveries SET snapshot='',status=CASE WHEN status IN ('pending','retry_wait','digest_wait') THEN 'failed' ELSE status END,error=CASE WHEN status IN ('pending','retry_wait','digest_wait') THEN 'CONTENT_EXPIRED' ELSE error END WHERE item_id=?`,
      id,
    );
  }
  cleanup() {
    this.tx(() => {
      const settings = this.settings();
      for (const i of this.all<Item>(
        'SELECT * FROM items WHERE expired=0 AND discovered<?',
        this.now() - Math.min(settings.mailDays, settings.itemDays) * DAY,
      )) {
        if (
          i.discovered <
          this.now() - (i.kind === 'email' ? settings.mailDays : settings.itemDays) * DAY
        )
          this.expireItem(i.id);
      }
      for (const i of this.all<Item>(
        'SELECT * FROM items WHERE discovered<?',
        this.now() - settings.itemDays * DAY,
      ))
        this.expireItem(i.id, true);
      this.run('DELETE FROM events WHERE at<?', this.now() - 30 * DAY);
      this.run(
        `DELETE FROM jobs WHERE created<? AND status IN ('succeeded','cancelled')`,
        this.now() - 30 * DAY,
      );
      this.run(
        `UPDATE jobs SET payload='{}',result='' WHERE created<? AND status='failed'`,
        this.now() - 30 * DAY,
      );
      this.run(
        `DELETE FROM deliveries WHERE created<? AND mode='digest' AND (status IN ('sent','cancelled') OR (status='batched' AND EXISTS(SELECT 1 FROM deliveries p WHERE p.id=deliveries.part_id AND p.status IN ('sent','cancelled'))))`,
        this.now() - 90 * DAY,
      );
      this.run(
        `DELETE FROM source_items WHERE item_id IN (SELECT id FROM items WHERE discovered<? AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.item_id=items.id AND d.status NOT IN ('sent','cancelled')))`,
        this.now() - 90 * DAY,
      );
      this.run(
        `DELETE FROM deliveries WHERE created<? AND status IN ('sent','cancelled') AND NOT EXISTS(SELECT 1 FROM deliveries m WHERE m.part_id=deliveries.id)`,
        this.now() - 90 * DAY,
      );
      this.run(
        "DELETE FROM summaries WHERE created<? AND status<>'running'",
        this.now() - 90 * DAY,
      );
      this.run(
        `DELETE FROM items WHERE discovered<? AND NOT EXISTS (SELECT 1 FROM source_items WHERE item_id=items.id) AND NOT EXISTS (SELECT 1 FROM deliveries WHERE item_id=items.id)`,
        this.now() - 90 * DAY,
      );
      this.run('DELETE FROM attempts WHERE at<?', this.now() - 90 * DAY);
      this.run(
        `DELETE FROM digest_batches WHERE created<? AND NOT EXISTS(SELECT 1 FROM deliveries WHERE batch_id=digest_batches.id)`,
        this.now() - 90 * DAY,
      );
    });
  }
  stats() {
    const day = dayKey(this.now(), this.settings().timezone);
    return {
      sources: this.get<Row>('SELECT count(*) n FROM sources WHERE deleted=0')!.n,
      items: this.get<Row>(
        "SELECT count(*) n FROM items WHERE expired=0 AND kind NOT IN ('digest','summary')",
      )!.n,
      pending: this.get<Row>(
        `SELECT count(*) n FROM deliveries WHERE status IN ('pending','retry_wait','digest_wait')`,
      )!.n,
      unknown: this.get<Row>(`SELECT count(*) n FROM deliveries WHERE status='unknown'`)!.n,
      sent: this.get<Row>(`SELECT count(*) n FROM deliveries WHERE status='sent'`)!.n,
      today: this.get<Row>('SELECT count(*) n FROM attempts WHERE day=?', day)!.n,
      heartbeat: this.get<Row>('SELECT value FROM meta WHERE key=?', 'heartbeat')?.value || null,
    };
  }
  close() {
    this.db.close();
  }
}
