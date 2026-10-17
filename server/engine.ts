import { createHash, randomUUID } from 'node:crypto';
import { AppError, type Config } from './config.js';
import { Store, type Source, type Job, type Incoming, type Cursor } from './store.js';
import {
  fetchFeed,
  connectMailbox,
  destinationRef,
  feishuSender,
  matches,
  type MailSession,
  type Envelope,
  type SendResult,
} from './adapters.js';
import { fetchRss } from './rss.js';
import { freezeDigest } from './digest.js';
import { SummaryService } from './summary.js';
import { createSiftAdapter, demoModelFetch } from './sift.js';
import { createCaptionAdapter } from './captions.js';
import { resolveChannel, resolveDemoChannel, youtubeTransport } from './youtube.js';
import { Weixin } from './weixin.js';

export interface Adapters {
  resolveChannel: (input: string) => Promise<string>;
  feed: typeof fetchFeed;
  rss: typeof fetchRss;
  mailbox: () => Promise<MailSession>;
  send: (text: string, uuid: string, destination?: string) => Promise<SendResult>;
}
export class Engine {
  private owner = randomUUID();
  private busy = false;
  private stopped = false;
  private activeToken = '';
  private youtubeClient: ReturnType<typeof youtubeTransport>;
  readonly weixin: Weixin;
  adapters: Adapters;
  summaries: SummaryService;
  constructor(
    public store: Store,
    public config: Config,
    overrides: Partial<Adapters> = {},
  ) {
    const identity = createHash('sha256')
      .update(`${config.imap.host}:${config.imap.user}:${config.imap.folder}`)
      .digest('hex');
    const prior = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='mailbox_identity'",
    );
    if (!config.demo && config.imap.enabled && prior && prior.value !== identity)
      throw new AppError('MAILBOX_IDENTITY_CHANGED_USE_NEW_DATA_DIR');
    if (!config.demo && config.imap.enabled)
      store.run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'mailbox_identity', identity);
    this.weixin = new Weixin(store, config);
    this.youtubeClient = youtubeTransport(config.youtubeProxy);
    this.summaries = new SummaryService(
      store,
      createSiftAdapter(config),
      this.destination,
      config.demo ? demoModelFetch : fetch,
      createCaptionAdapter(config),
    );
    this.adapters = {
      resolveChannel: config.demo
        ? resolveDemoChannel
        : (input) => resolveChannel(input, this.youtubeClient.request),
      feed: (channel, cache) => fetchFeed(channel, cache, this.youtubeClient.request),
      rss: fetchRss,
      mailbox: () => connectMailbox(config),
      send:
        config.pushChannel === 'weixin' && !config.demo
          ? (text, uuid, destination) => this.weixin.send(text, uuid, destination)
          : feishuSender(config),
      ...overrides,
    };
  }
  get destination() {
    return this.config.pushChannel === 'weixin' && !this.config.demo
      ? this.weixin.destination
      : destinationRef(this.config);
  }
  get pushReady() {
    return (
      this.config.demo ||
      (this.config.pushChannel === 'weixin'
        ? this.weixin.describe().ready
        : this.config.feishu.enabled)
    );
  }
  syncDestination() {
    this.summaries.destination = this.destination;
  }
  async cycle() {
    if (this.busy || this.stopped || !this.store.leaseWorker(this.owner)) return;
    this.busy = true;
    this.syncDestination();
    const heartbeat = setInterval(() => {
      if (!this.store.leaseWorker(this.owner)) {
        this.stopped = true;
        return;
      }
      this.store.run(
        `UPDATE jobs SET lease=? WHERE status='running' AND token=?`,
        this.store.now() + 120_000,
        this.activeToken,
      );
    }, 30_000);
    try {
      this.store.run(
        'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        'heartbeat',
        String(this.store.now()),
      );
      this.store.cleanup();
      this.store.schedule();
      // One process owns the loop; two bounded reads avoid an unbounded catch-up burst.
      for (let n = 0; n < 2 && !this.stopped; n++) {
        const job = this.store.claimJob();
        if (job) await this.execute(job);
      }
      if (!this.stopped) freezeDigest(this.store, this.destination);
      this.summaries.reconcile();
      if (this.pushReady && !this.stopped)
        for (let n = 0; n < 5 && !this.stopped; n++) {
          const d = this.store.claimDelivery(this.destination);
          if (!d) break;
          try {
            this.store.finishDelivery(d, await this.adapters.send(d.snapshot, d.id, d.destination));
          } catch {
            this.store.finishDelivery(d, { status: 'unknown', code: 'SEND_UNCONFIRMED' });
          }
        }
      if (!this.stopped) {
        this.summaries.schedule();
        await this.summaries.cycle(this.destination);
      }
    } finally {
      clearInterval(heartbeat);
      this.store.releaseWorker(this.owner);
      this.busy = false;
    }
  }
  async stop() {
    this.stopped = true;
    await this.weixin.stop();
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
    await this.youtubeClient.close();
  }
  async execute(job: Job) {
    this.activeToken = job.token;
    try {
      if (job.kind === 'source' || job.kind === 'probe') await this.youtube(job);
      else if (job.kind === 'mailbox') await this.mailbox(job);
      else await this.retryBody(job);
    } catch (e) {
      this.store.finishJob(
        job,
        e instanceof AppError ? e : new AppError('SOURCE_UNAVAILABLE', 502, true),
      );
    } finally {
      this.activeToken = '';
    }
  }
  private async youtube(job: Job) {
    const s = this.store.source(job.resource);
    if (s.generation !== job.generation || (job.kind !== 'probe' && !s.enabled)) {
      this.store.finishJob(job);
      return;
    }
    if (s.type === 'email') {
      const mailbox = await this.adapters.mailbox();
      try {
        const sample = (
          await mailbox.headers(Math.max(1, mailbox.upper - 4), mailbox.upper)
        ).filter((e) => matches(s, e.sender, e.subject));
        this.store.finishJob(job, undefined, {
          connected: true,
          matched: sample.length,
          samples: sample.map((e) => ({
            subject: e.subject,
            sender: e.sender,
            received: e.received,
          })),
        });
      } finally {
        await mailbox.close();
      }
      return;
    }
    const cacheKey = `feed:${s.id}`;
    const cache = JSON.parse(
      this.store.get<{ value: string }>('SELECT value FROM meta WHERE key=?', cacheKey)?.value ||
        '{}',
    );
    const result =
      s.type === 'rss'
        ? await this.adapters.rss(s.feed_url, s.initialized ? cache : {})
        : await this.adapters.feed(s.channel, s.initialized ? cache : {});
    if (job.kind === 'probe') {
      this.store.finishJob(job, undefined, {
        connected: true,
        title: result.items[0]?.author || s.name,
        visible: result.items.length,
      });
      return;
    }
    this.store.tx(() => {
      if (!this.store.validJob(job)) return;
      const current = this.store.source(s.id);
      if (!current.enabled || current.generation !== s.generation) return;
      if (result.unchanged && !current.initialized)
        throw new AppError('BASELINE_NOT_AVAILABLE', 502, true);
      let coverage = '';
      if (current.initialized && !result.unchanged && current.last_success) {
        const overlap = result.items.some(
          (i) => !!this.store.get('SELECT 1 FROM items WHERE key=?', i.key),
        );
        if (result.items.length && !overlap) coverage = 'FEED_WINDOW_GAP';
      }
      for (const item of result.items) {
        const known = this.store.get('SELECT 1 FROM items WHERE key=?', item.key);
        const oldUnseen =
          s.type === 'youtube' &&
          !known &&
          item.published !== null &&
          item.published !== undefined &&
          item.published < current.baseline;
        this.store.put(
          item,
          [current],
          !known && !!current.initialized && !!current.notify && !oldUnseen,
          this.destination,
        );
        if (oldUnseen && current.initialized) coverage = 'OLD_ITEM_REAPPEARED';
      }
      this.store.run(
        `UPDATE sources SET initialized=1,baseline=CASE WHEN baseline=0 THEN ? ELSE baseline END,last_success=?,error='',coverage=? WHERE id=?`,
        this.store.now(),
        this.store.now(),
        coverage || current.coverage,
        s.id,
      );
      this.store.run(
        'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        cacheKey,
        JSON.stringify({ etag: result.etag, modified: result.modified }),
      );
    });
    this.store.finishJob(job);
  }
  private activeMail() {
    return this.store.all<Source>(
      `SELECT * FROM sources WHERE type='email' AND enabled=1 AND deleted=0`,
    );
  }
  private async mailbox(job: Job) {
    const mailbox = await this.adapters.mailbox();
    try {
      let cursor = this.store.get<Cursor>('SELECT * FROM mailbox_cursors WHERE id=1');
      if (cursor && cursor.epoch !== mailbox.epoch) {
        this.store.tx(() => {
          this.store.run('UPDATE mailbox_cursors SET blocked=1 WHERE id=1');
          this.store.run(
            `UPDATE sources SET enabled=0,generation=generation+1,error='MAILBOX_EPOCH_CHANGED',coverage='REBASELINE_REQUIRED' WHERE type='email' AND deleted=0`,
          );
        });
        throw new AppError('MAILBOX_EPOCH_CHANGED', 409);
      }
      this.store.tx(() => {
        if (!this.store.validJob(job)) return;
        if (!cursor) {
          this.store.run(
            'INSERT INTO mailbox_cursors VALUES (1,?,?,0)',
            mailbox.epoch,
            mailbox.upper,
          );
          cursor = { epoch: mailbox.epoch, uid: mailbox.upper, blocked: 0 };
        }
        for (const s of this.activeMail().filter((s) => !s.initialized))
          this.store.run(
            `UPDATE sources SET initialized=1,boundary=?,epoch=?,baseline=?,last_success=?,error='' WHERE id=? AND generation=?`,
            mailbox.upper,
            mailbox.epoch,
            this.store.now(),
            this.store.now(),
            s.id,
            s.generation,
          );
      });
      if (!cursor || cursor.blocked || !this.store.validJob(job)) {
        this.store.finishJob(job, new AppError('MAILBOX_REBASELINE_REQUIRED'));
        return;
      }
      const upper = Math.min(mailbox.upper, cursor.uid + 100);
      const headers = await mailbox.headers(cursor.uid + 1, upper);
      for (const envelope of headers) {
        if (this.stopped) throw new AppError('WORKER_STOPPING', 503, true);
        const rules = this.activeMail().filter(
          (s) =>
            s.epoch === mailbox.epoch &&
            envelope.uid > s.boundary &&
            matches(s, envelope.sender, envelope.subject),
        );
        if (!rules.length) continue;
        try {
          const text = await mailbox.body(envelope.uid);
          this.saveMail(job, mailbox.epoch, envelope, rules, text);
        } catch (error) {
          const code = error instanceof AppError ? error.code : 'MAIL_BODY_UNAVAILABLE';
          this.store.tx(() => {
            if (!this.store.validJob(job)) return;
            this.store.enqueue('body', `${mailbox.epoch}:${envelope.uid}`, 0, {
              epoch: mailbox.epoch,
              envelope,
              rules: rules.map((s) => ({ id: s.id, generation: s.generation })),
            });
            this.store.event('mail_body_deferred', String(envelope.uid), code);
          });
        }
      }
      this.store.tx(() => {
        if (!this.store.validJob(job)) return;
        this.store.run(
          'UPDATE mailbox_cursors SET uid=? WHERE id=1 AND epoch=?',
          upper,
          mailbox.epoch,
        );
        this.store.run(
          `UPDATE sources SET last_success=?,error='' WHERE type='email' AND enabled=1 AND deleted=0`,
          this.store.now(),
        );
      });
      this.store.finishJob(job, undefined, { scanned: headers.length });
    } finally {
      await mailbox.close();
    }
  }
  private saveMail(job: Job, epoch: string, e: Envelope, rules: Source[], text: string) {
    this.store.tx(() => {
      if (!this.store.validJob(job)) return;
      const current = rules.filter((s) => {
        const r = this.store.get<Source>('SELECT * FROM sources WHERE id=?', s.id);
        return !!r && r.enabled && !r.deleted && r.generation === s.generation;
      });
      if (!current.length) return;
      this.store.put(
        {
          key: `mail:default:${this.config.imap.folder}:${epoch}:${e.uid}`,
          kind: 'email',
          title: e.subject || '无主题邮件',
          author: e.sender,
          url: '',
          text,
          received: e.received,
          published: e.published,
        },
        current,
        current.some((s) => !!s.notify),
        this.destination,
      );
    });
  }
  private async retryBody(job: Job) {
    const payload = JSON.parse(job.payload) as {
      epoch: string;
      envelope: Envelope;
      rules: { id: string; generation: number }[];
    };
    const rules = payload.rules.flatMap((r) => {
      const s = this.store.get<Source>(
        'SELECT * FROM sources WHERE id=? AND enabled=1 AND deleted=0 AND generation=?',
        r.id,
        r.generation,
      );
      return s ? [s] : [];
    });
    if (!rules.length) {
      this.store.finishJob(job);
      return;
    }
    const mailbox = await this.adapters.mailbox();
    try {
      if (mailbox.epoch !== payload.epoch) throw new AppError('MAILBOX_EPOCH_CHANGED');
      this.saveMail(
        job,
        mailbox.epoch,
        payload.envelope,
        rules,
        await mailbox.body(payload.envelope.uid),
      );
      this.store.finishJob(job);
    } finally {
      await mailbox.close();
    }
  }
}
