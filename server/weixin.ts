import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { DateTime } from 'luxon';
import { AppError, type Config } from './config.js';
import { type Delivery, type Store } from './store.js';
import { type SendResult } from './adapters.js';

const API = 'https://ilinkai.weixin.qq.com';
const ACCOUNT = 'weixin_account',
  PAIR = 'weixin_pair';
const baseInfo = { channel_version: '2.4.9', bot_agent: 'FeedRelay/0.3' };
const RETRY_POLICY = 3;
const localTime = (at: number) => DateTime.fromMillis(at, { zone: 'Asia/Shanghai' });
const nextHour = (at: number) => localTime(at).startOf('hour').plus({ hours: 1 }).toMillis();
const dayMidnight = (at: number) => localTime(at).startOf('day').plus({ days: 1 }).toMillis();
const dayDeadline = (at: number) => dayMidnight(at) + 60_000;
// A worker may arrive seconds after the hour, never at an arbitrary later minute.
const retrySlot = (target: number, now: number) => {
  const aligned = localTime(target).startOf('hour').toMillis() === target ? target : nextHour(target);
  if (now < aligned + 60_000) return aligned;
  const currentHour = localTime(now).startOf('hour').toMillis();
  return now < currentHour + 60_000 ? currentHour : nextHour(now);
};
interface Account {
  binding: string;
  token: string;
  bot: string;
  user: string;
  base: string;
  context: string;
  cursor: string;
  inbound: number;
  polled: number;
  accepted: number;
  error: string;
  retryAt?: number;
  rejectedAt?: number;
  rejections?: number;
  retryPolicy?: number;
}
interface Pair {
  id: string;
  qr: string;
  url: string;
  base: string;
  expires: number;
  status: string;
}
const string = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value);

export function weixinBase(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !/^ilink[a-z0-9-]*\.weixin\.qq\.com$/u.test(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new AppError('WEIXIN_UNTRUSTED_HOST');
  }
}

export class Weixin {
  private key: Buffer;
  private pairing = false;
  private controller?: AbortController;
  private loop?: Promise<void>;
  constructor(
    public store: Store,
    public config: Config,
    public request: typeof fetch = fetch,
  ) {
    this.key = createHash('sha256').update(`feedrelay-weixin:${config.sessionSecret}`).digest();
  }
  private read<T>(key: string): T | undefined {
    const row = this.store.get<{ value: string }>('SELECT value FROM meta WHERE key=?', key);
    if (!row) return;
    try {
      const data = Buffer.from(row.value, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'),
      );
    } catch {
      throw new AppError('WEIXIN_LOCAL_STATE_INVALID');
    }
  }
  private write(key: string, value: Account | Pair) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    this.store.run(
      'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'),
    );
  }
  private update(binding: string, change: (account: Account) => void) {
    this.store.tx(() => {
      const current = this.read<Account>(ACCOUNT);
      if (current?.binding !== binding) return;
      change(current);
      this.write(ACCOUNT, current);
    });
  }
  get destination() {
    try {
      const account = this.read<Account>(ACCOUNT);
      return account
        ? createHash('sha256').update(`weixin:${account.binding}`).digest('hex')
        : 'weixin:unbound';
    } catch {
      return 'weixin:unbound';
    }
  }
  private account(): Account | undefined {
    const account = this.read<Account>(ACCOUNT);
    if (!account) return account;
    if (account.retryAt && account.rejectedAt && this.store.now() >= dayDeadline(account.rejectedAt)) {
      const expiredDeadline = dayMidnight(account.rejectedAt);
      this.store.tx(() => {
        // Fence queued work before clearing an expired account gate, also on restart.
        for (const d of this.store.all<Delivery>("SELECT * FROM deliveries WHERE destination=? AND created<? AND mode IN ('immediate','digest_part') AND snapshot<>'' AND status IN ('pending','retry_wait','failed')", this.destination, expiredDeadline))
          if (d.status !== 'failed' || ['WEIXIN_CONTEXT_REJECTED', 'WEIXIN_NEEDS_MESSAGE'].includes(d.error)) this.trackDay(d, true);
        const a = this.read<Account>(ACCOUNT);
        if (a?.binding === account.binding && a.rejectedAt === account.rejectedAt) {
          a.retryAt = 0;
          a.rejectedAt = undefined;
          a.rejections = 0;
          a.retryPolicy = RETRY_POLICY;
          if (a.error === 'WEIXIN_CONTEXT_REJECTED') a.error = '';
          this.write(ACCOUNT, a);
        }
      });
      return this.account();
    }
    if (account.retryPolicy === RETRY_POLICY) {
      if (account.retryAt && this.store.now() >= account.retryAt + 60_000) {
        this.update(account.binding, a => { a.retryAt = retrySlot(a.retryAt || 0, this.store.now()); });
        return this.read<Account>(ACCOUNT);
      }
      return account;
    }
    // Upgrade legacy explicit failures once, using the durable attempt time,
    // never the time of each poll/restart. No unknown delivery is recovered.
    const last = this.store.get<{ at: number }>(
      `SELECT MAX(COALESCE((SELECT MAX(a.at) FROM attempts a WHERE a.delivery_id=d.id AND a.status='failed' AND a.code='WEIXIN_CONTEXT_REJECTED'),d.created)) at
       FROM deliveries d WHERE d.destination=? AND (d.error='WEIXIN_CONTEXT_REJECTED' OR EXISTS
         (SELECT 1 FROM attempts a WHERE a.delivery_id=d.id AND a.status='failed' AND a.code='WEIXIN_CONTEXT_REJECTED'))`,
      this.destination,
    )?.at;
    {
      this.update(account.binding, a => {
        a.retryPolicy = RETRY_POLICY;
        if (a.retryAt || (last && last > (a.accepted || 0)) || a.error === 'WEIXIN_CONTEXT_REJECTED') {
          a.rejectedAt = a.rejectedAt || last || this.store.now();
          a.rejections = a.rejections || 1;
          a.retryAt = retrySlot(nextHour(a.rejectedAt), this.store.now());
        }
      });
      return this.read<Account>(ACCOUNT);
    }
  }
  private blocked(a: Account) {
    if (a.error === 'WEIXIN_SESSION_EXPIRED') return a.error;
    if (!a.context) return 'WEIXIN_NEEDS_MESSAGE';
    if (a.rejectedAt && this.store.now() >= dayDeadline(a.rejectedAt)) return '';
    if ((a.retryAt || 0) > this.store.now()) return 'WEIXIN_CONTEXT_REJECTED';
    return '';
  }
  describe() {
    try {
      const a = this.account();
      return {
        bound: !!a,
        ready: !!a && !this.blocked(a),
        recipient: a ? `${a.user.slice(0, 4)}…${a.user.slice(-4)}` : '',
        lastInbound: a?.inbound || 0,
        lastPoll: a?.polled || 0,
        lastAccepted: a?.accepted || 0,
        error: a ? this.blocked(a) || (['WEIXIN_NETWORK_ERROR', 'WEIXIN_POLL_FAILED'].includes(a.error) ? a.error : '') : '',
        nextRetryAt: a?.retryAt && a.rejectedAt && a.retryAt < dayDeadline(a.rejectedAt) ? a.retryAt : 0,
        retryDeadline: a?.rejectedAt ? dayDeadline(a.rejectedAt) : 0,
      };
    } catch {
      return {
        bound: false,
        ready: false,
        recipient: '',
        lastInbound: 0,
        lastPoll: 0,
        lastAccepted: 0,
        error: 'WEIXIN_LOCAL_STATE_INVALID',
        nextRetryAt: 0,
        retryDeadline: 0,
      };
    }
  }
  private enabled() {
    if (this.config.demo || this.config.pushChannel !== 'weixin')
      throw new AppError('WEIXIN_NOT_ENABLED', 400);
  }
  private async call(
    base: string,
    path: string,
    options: {
      token?: string;
      body?: object;
      signal?: AbortSignal;
      timeout?: number;
    } = {},
  ) {
    const headers: Record<string, string> = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 9),
    };
    if (options.body !== undefined)
      Object.assign(headers, {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      });
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await this.request(`${weixinBase(base)}/ilink/bot/${path}`, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers,
      redirect: 'error',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.any([
        AbortSignal.timeout(options.timeout || 15000),
        options.signal || new AbortController().signal,
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        response.status === 429 ? 'WEIXIN_RATE_LIMITED' : 'WEIXIN_HTTP_ERROR',
        502,
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw new AppError('WEIXIN_INVALID_RESPONSE', 502);
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 512000) throw new AppError('WEIXIN_INVALID_RESPONSE', 502);
      chunks.push(chunk);
    }
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      return data as Record<string, any>;
    } catch {
      throw new AppError('WEIXIN_INVALID_RESPONSE', 502);
    }
  }
  private async pairView(pair: Pair) {
    return {
      id: pair.id,
      status: pair.status,
      expires: pair.expires,
      image: await QRCode.toDataURL(pair.url, { width: 240, margin: 2 }),
    };
  }
  async begin(replace = false) {
    this.enabled();
    if (this.pairing) throw new AppError('WEIXIN_PAIR_BUSY', 409);
    if (this.describe().bound && !replace)
      throw new AppError('WEIXIN_REPLACE_CONFIRMATION_REQUIRED');
    this.pairing = true;
    try {
      const old = this.read<Pair>(PAIR);
      if (old && old.expires > this.store.now()) return await this.pairView(old);
      const data = await this.call(API, 'get_bot_qrcode?bot_type=3', {
        body: { local_token_list: [] },
      });
      if (!string(data.qrcode) || !string(data.qrcode_img_content, 2048))
        throw new AppError('WEIXIN_INVALID_RESPONSE', 502);
      const url = new URL(data.qrcode_img_content);
      if (
        url.protocol !== 'https:' ||
        !/(^|\.)weixin\.qq\.com$/u.test(url.hostname) ||
        url.username ||
        url.password
      )
        throw new AppError('WEIXIN_UNTRUSTED_HOST');
      const pair: Pair = {
        id: randomUUID(),
        qr: data.qrcode,
        url: url.href,
        base: API,
        expires: this.store.now() + 120000,
        status: 'wait',
      };
      this.write(PAIR, pair);
      this.store.event('weixin_pair_started', 'default');
      return await this.pairView(pair);
    } catch (error) {
      throw error instanceof AppError ? error : new AppError('WEIXIN_NETWORK_ERROR', 502);
    } finally {
      this.pairing = false;
    }
  }
  async pollPair(id: string, code?: string) {
    this.enabled();
    if (code !== undefined && !/^\d{4,8}$/u.test(code))
      throw new AppError('WEIXIN_INVALID_PAIR_CODE');
    if (this.pairing) throw new AppError('WEIXIN_PAIR_BUSY', 409);
    const pair = this.read<Pair>(PAIR);
    if (!pair || pair.id !== id || pair.expires <= this.store.now())
      throw new AppError('WEIXIN_PAIR_EXPIRED');
    this.pairing = true;
    try {
      const data = await this.call(
        pair.base,
        `get_qrcode_status?qrcode=${encodeURIComponent(pair.qr)}${code ? `&verify_code=${encodeURIComponent(code)}` : ''}`,
        { timeout: 35000 },
      );
      if (this.read<Pair>(PAIR)?.id !== pair.id) throw new AppError('WEIXIN_PAIR_EXPIRED');
      if (data.status === 'confirmed') {
        if (
          !string(data.bot_token) ||
          /\s/u.test(data.bot_token) ||
          !string(data.ilink_bot_id, 256) ||
          !string(data.ilink_user_id, 256)
        )
          throw new AppError('WEIXIN_INVALID_RESPONSE', 502);
        const account: Account = {
          binding: randomUUID(),
          token: data.bot_token,
          bot: data.ilink_bot_id,
          user: data.ilink_user_id,
          base: weixinBase(data.baseurl || API),
          context: '',
          cursor: '',
          inbound: 0,
          polled: 0,
          accepted: 0,
          error: '',
        };
        this.store.tx(() => {
          this.write(ACCOUNT, account);
          this.store.run('DELETE FROM meta WHERE key=?', PAIR);
          this.store.event('weixin_paired', 'default');
        });
        return { id, status: 'confirmed', ...this.describe() };
      }
      if (data.status === 'scaned_but_redirect')
        pair.base = weixinBase(`https://${data.redirect_host}`);
      else if (
        ![
          'wait',
          'scaned',
          'need_verifycode',
          'expired',
          'verify_code_blocked',
          'binded_redirect',
        ].includes(data.status)
      )
        throw new AppError('WEIXIN_INVALID_RESPONSE', 502);
      if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(data.status)) {
        this.store.run('DELETE FROM meta WHERE key=?', PAIR);
        throw new AppError(
          data.status === 'binded_redirect' ? 'WEIXIN_BINDING_EXISTS' : 'WEIXIN_PAIR_EXPIRED',
        );
      }
      pair.status = data.status === 'scaned_but_redirect' ? 'scaned' : data.status;
      this.write(PAIR, pair);
      return { id, status: pair.status };
    } catch (error) {
      throw error instanceof AppError ? error : new AppError('WEIXIN_NETWORK_ERROR', 502);
    } finally {
      this.pairing = false;
    }
  }
  cancelPair(id: string) {
    if (this.read<Pair>(PAIR)?.id === id) this.store.run('DELETE FROM meta WHERE key=?', PAIR);
  }
  disconnect() {
    this.store.tx(() => {
      this.store.run('DELETE FROM meta WHERE key IN (?,?)', ACCOUNT, PAIR);
      this.store.event('weixin_disconnected', 'default');
    });
  }
  async pollUpdates(signal?: AbortSignal) {
    this.recoverDeliveries();
    const account = this.read<Account>(ACCOUNT);
    if (!account || account.error === 'WEIXIN_SESSION_EXPIRED') return;
    const data = await this.call(account.base, 'getupdates', {
      token: account.token,
      body: { get_updates_buf: account.cursor, base_info: baseInfo },
      timeout: 35000,
      signal,
    });
    if (
      (data.ret !== undefined && data.ret !== 0) ||
      (data.errcode !== undefined && data.errcode !== 0)
    ) {
      this.update(account.binding, (a) => {
        if (a.error === 'WEIXIN_SESSION_EXPIRED') return;
        a.error =
          data.ret === -14 || data.errcode === -14
            ? 'WEIXIN_SESSION_EXPIRED'
            : 'WEIXIN_POLL_FAILED';
      });
      throw new AppError('WEIXIN_POLL_FAILED', 502);
    }
    // Live getupdates responses omit ret on success; require the actual polling
    // envelope in that case. This does not relax outbound delivery acknowledgements.
    if (
      data.ret === undefined &&
      (!Array.isArray(data.msgs) || typeof data.get_updates_buf !== 'string')
    )
      throw new AppError('WEIXIN_INVALID_RESPONSE', 502);
    if (
      (data.msgs !== undefined && (!Array.isArray(data.msgs) || data.msgs.length > 2000)) ||
      (data.get_updates_buf !== undefined &&
        (typeof data.get_updates_buf !== 'string' || data.get_updates_buf.length > 100000))
    )
      throw new AppError('WEIXIN_INVALID_RESPONSE', 502);
    this.update(account.binding, (a) => {
      if (data.get_updates_buf) a.cursor = data.get_updates_buf;
      a.polled = this.store.now();
      for (const msg of data.msgs || []) {
        if (
          msg?.message_type !== 1 ||
          msg.group_id ||
          msg.from_user_id !== a.user ||
          (msg.to_user_id && msg.to_user_id !== a.bot) ||
          !string(msg.context_token) ||
          !Number.isSafeInteger(msg.create_time_ms) ||
          msg.create_time_ms <= a.inbound ||
          msg.create_time_ms > this.store.now() + 60000
        )
          continue;
        a.context = msg.context_token;
        a.inbound = msg.create_time_ms;
        if (a.error !== 'WEIXIN_SESSION_EXPIRED') a.error = '';
      }
      if (a.error === 'WEIXIN_POLL_FAILED' || a.error === 'WEIXIN_NETWORK_ERROR') a.error = '';
    });
  }
  start() {
    if (this.config.demo || this.config.pushChannel !== 'weixin' || this.loop) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.loop = (async () => {
      while (!signal.aborted) {
        try {
          await this.pollUpdates(signal);
        } catch {
          if (!signal.aborted) {
            try {
              const a = this.read<Account>(ACCOUNT);
              if (a)
                this.update(a.binding, (current) => {
                  if (!current.error) current.error = 'WEIXIN_NETWORK_ERROR';
                });
            } catch {}
          }
        }
        await delay(2000, undefined, { signal }).catch(() => {});
      }
    })();
  }
  async stop() {
    this.controller?.abort();
    await this.loop;
    this.loop = undefined;
  }
  recoverDeliveries() {
    const account = this.account();
    if (!account) return;
    const fingerprint = createHash('sha256').update(account.context).digest('hex');
    this.store.tx(() => {
      for (const d of this.store.all<Delivery>(
        "SELECT * FROM deliveries WHERE mode IN ('immediate','digest_part') AND snapshot<>'' AND (status IN ('pending','retry_wait') OR (status='failed' AND error IN ('WEIXIN_CONTEXT_REJECTED','WEIXIN_NEEDS_MESSAGE')))",
      )) {
        const hourly = d.error === 'WEIXIN_CONTEXT_REJECTED' || !!(account.retryAt && account.rejectedAt && d.destination === this.destination && d.created < dayMidnight(account.rejectedAt));
        // Derive the final task's deadline even if the worker was offline all night
        // and no previous version ever wrote a marker. This does not delay first sends.
        if (hourly || d.destination === this.destination) this.trackDay(d, hourly);
        const deadline = this.deadline(d.id);
        if (deadline && this.store.now() >= deadline) {
          this.store.run("UPDATE deliveries SET status='cancelled',error='WEIXIN_DAY_EXPIRED' WHERE id=?", d.id);
          continue;
        }
        if (d.destination !== this.destination) continue;
        const hour = this.store.get<{ value: string }>('SELECT value FROM meta WHERE key=?', `weixin-hour:${d.id}`);
        if (hour) {
          // Explicit rejection replaces generic backoff; unrelated failures retain it.
          const target = d.error === 'WEIXIN_CONTEXT_REJECTED' ? Number(hour.value) : Math.max(Number(hour.value), d.available);
          const slot = retrySlot(Math.max(target, account.retryAt || 0), this.store.now());
          this.store.run('UPDATE deliveries SET available=? WHERE id=?', slot, d.id);
          this.store.run('UPDATE meta SET value=? WHERE key=?', String(slot), `weixin-hour:${d.id}`);
        }
      }
      for (const d of this.store.all<Delivery>(
        "SELECT * FROM deliveries WHERE destination=? AND status='failed' AND error IN ('WEIXIN_CONTEXT_REJECTED','WEIXIN_NEEDS_MESSAGE') AND attempt<CASE WHEN error='WEIXIN_CONTEXT_REJECTED' THEN 25 ELSE 5 END",
        this.destination,
      )) {
        const previous = this.store.get<{ value: string }>('SELECT value FROM meta WHERE key=?', `weixin-context:${d.id}`);
        if (previous?.value === 'revoked' || this.blocked(account)) continue;
        if (d.error === 'WEIXIN_CONTEXT_REJECTED') {
          this.store.recoverContextDelivery(d, 25);
          continue;
        }
        // Legacy failures have no fingerprint. Fence them at observation time and
        // require a subsequent inbound context, rather than guessing which was used.
        if (!previous) {
          this.store.run('INSERT INTO meta VALUES (?,?)', `weixin-context:${d.id}`, fingerprint);
          continue;
        }
        if (previous.value !== fingerprint)
          this.store.recoverContextDelivery(d);
      }
      this.store.run("DELETE FROM meta WHERE key LIKE 'weixin-context:%' AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE 'weixin-context:' || d.id=meta.key AND d.status NOT IN ('sent','cancelled'))");
    });
  }
  private deadline(id: string) {
    return Number(this.store.get<{ value: string }>('SELECT value FROM meta WHERE key=?', `weixin-deadline:${id}`)?.value || 0);
  }
  private trackDay(d: Delivery, hourly: boolean) {
    this.store.run('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `weixin-deadline:${d.id}`, String(dayDeadline(d.created)));
    if (hourly) this.store.run('INSERT OR IGNORE INTO meta VALUES (?,?)', `weixin-hour:${d.id}`, String(nextHour(d.created)));
  }
  async send(text: string, uuid: string, expected = this.destination): Promise<SendResult> {
    this.enabled();
    const account = this.account();
    if (!account || expected !== this.destination)
      return { status: 'failed', code: 'WEIXIN_DESTINATION_CHANGED' };
    this.store.run("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE meta.value<>'revoked'",
      `weixin-context:${uuid}`, createHash('sha256').update(account.context).digest('hex'));
    if (this.store.get<{ value: string }>('SELECT value FROM meta WHERE key=?', `weixin-context:${uuid}`)?.value === 'revoked')
      return { status: 'failed', code: 'DELIVERY_AUTHORIZATION_REVOKED' };
    const delivery = this.store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', uuid);
    if (delivery && ['immediate', 'digest_part'].includes(delivery.mode)) this.trackDay(delivery, false);
    if (delivery && (delivery.error === 'WEIXIN_CONTEXT_REJECTED' || this.blocked(account))) this.trackDay(delivery, !!account.retryAt);
    const deadline = this.deadline(uuid);
    if (deadline && this.store.now() >= deadline) return { status: 'failed', code: 'WEIXIN_DAY_EXPIRED' };
    const hour = this.store.get<{ value: string }>('SELECT value FROM meta WHERE key=?', `weixin-hour:${uuid}`);
    if (hour && (this.store.now() < Number(hour.value) || this.store.now() >= Number(hour.value) + 60_000))
      return { status: 'failed', code: 'WEIXIN_CONTEXT_REJECTED' };
    const blocked = this.blocked(account);
    if (blocked) return { status: 'failed', code: blocked };
    if (!text.trim() || Array.from(text).length > 4000)
      return { status: 'failed', code: 'WEIXIN_MESSAGE_TOO_LONG' };
    try {
      const data = await this.call(account.base, 'sendmessage', {
        token: account.token,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: account.user,
            client_id: `feedrelay-${uuid}`,
            message_type: 2,
            message_state: 2,
            context_token: account.context,
            item_list: [{ type: 1, text_item: { text } }],
          },
          base_info: baseInfo,
        },
      });
      // The live endpoint also acknowledges text sends with message_id only.
      // Empty JSON/HTTP 200 alone remains insufficient, and errors always win.
      const messageId =
        (typeof data.message_id === 'number' &&
          Number.isInteger(data.message_id) &&
          data.message_id > 0) ||
        (typeof data.message_id === 'string' && /^[1-9]\d{0,39}$/u.test(data.message_id));
      const accepted =
        data.ret === 0 ||
        (data.ret === undefined && messageId && (data.errmsg === undefined || data.errmsg === ''));
      if (accepted && (data.errcode === undefined || data.errcode === 0)) {
        this.update(account.binding, (a) => {
          a.accepted = this.store.now();
          // An older successful request cannot erase a newer account rejection.
          if (a.rejectedAt === account.rejectedAt && a.rejections === account.rejections) {
            a.retryAt = 0;
            a.rejections = 0;
            if (a.error !== 'WEIXIN_SESSION_EXPIRED') a.error = '';
          }
        });
        return { status: 'sent' };
      }
      const code =
        data.ret === -14 || data.errcode === -14
          ? 'WEIXIN_SESSION_EXPIRED'
          : data.ret === -2 || data.errcode === -2
            ? 'WEIXIN_CONTEXT_REJECTED'
            : 'WEIXIN_SEND_REJECTED';
      if (code !== 'WEIXIN_SEND_REJECTED')
        this.update(account.binding, (a) => {
          if (code === 'WEIXIN_CONTEXT_REJECTED') {
            a.rejections = (a.rejections || 0) + 1;
            a.rejectedAt = this.store.now();
            a.retryPolicy = RETRY_POLICY;
            a.retryAt = nextHour(a.rejectedAt);
            if (a.error !== 'WEIXIN_SESSION_EXPIRED') a.error = code;
          } else a.error = code;
        });
      if (code === 'WEIXIN_CONTEXT_REJECTED' && delivery) {
        this.trackDay(delivery, true);
        this.store.run('UPDATE meta SET value=? WHERE key=?', String(nextHour(this.store.now())), `weixin-hour:${uuid}`);
      }
      const explicitError =
        (typeof data.ret === 'number' && data.ret !== 0) ||
        (typeof data.errcode === 'number' && data.errcode !== 0);
      return {
        status: explicitError ? 'failed' : 'unknown',
        code: explicitError ? code : 'WEIXIN_SEND_UNCONFIRMED',
      };
    } catch (error) {
      return {
        status:
          error instanceof AppError && error.code === 'WEIXIN_RATE_LIMITED'
            ? 'retry_wait'
            : 'unknown',
        code: error instanceof AppError ? error.code : 'WEIXIN_SEND_UNCONFIRMED',
        retryAfter: 60000,
      };
    }
  }
}
