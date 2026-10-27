import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { AppError } from './config.js';
import { Store } from './store.js';

const ENDPOINT = 'https://aihot.news/api/v1/dailies/latest';
const ZONE = 'Asia/Shanghai';
interface State { enabled: boolean; startDate: string; nextCheck: number; lastDate: string; error: string; checkDate?: string; failures?: number; revision?: string }
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function dailyMessages(data: unknown, date: string) {
  if (!object(data) || !object(data.report)) throw new AppError('AIHOT_INVALID_REPORT');
  const report = data.report;
  if (typeof report.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(report.date) ||
    !DateTime.fromISO(report.date).isValid) throw new AppError('AIHOT_INVALID_REPORT');
  if (report.date !== date) throw new AppError('AIHOT_NOT_PUBLISHED');
  if (!Array.isArray(report.sections) || report.sections.length > 100 ||
    (report.flashes !== undefined && (!Array.isArray(report.flashes) || report.flashes.length > 100))) throw new AppError('AIHOT_INVALID_REPORT');
  const entries: unknown[] = [];
  for (const section of report.sections) {
    if (!object(section) || !Array.isArray(section.items) || section.items.length > 100 ||
      entries.length + section.items.length > 100) throw new AppError('AIHOT_INVALID_REPORT');
    entries.push(...section.items);
  }
  if (Array.isArray(report.flashes)) entries.push(...report.flashes);
  if (!entries.length && object(report.lead) && typeof report.lead.title === 'string' &&
    report.lead.title.trim() && typeof report.lead.leadParagraph === 'string' && report.lead.leadParagraph.trim())
    entries.push({ title: report.lead.title, summary: report.lead.leadParagraph });
  if (!entries.length) throw new AppError('AIHOT_NOT_PUBLISHED');
  if (entries.length > 100) throw new AppError('AIHOT_INVALID_REPORT');
  const seen = new Set<string>();
  const paragraphs: string[] = [];
  for (const entry of entries) {
    if (!object(entry) || typeof entry.title !== 'string' || !entry.title.trim() ||
      (entry.summary !== undefined && typeof entry.summary !== 'string')) throw new AppError('AIHOT_INVALID_REPORT');
    if (seen.has(entry.title)) continue;
    seen.add(entry.title);
    const text = `${paragraphs.length + 1}. ${entry.title.trim()}${entry.summary ? '\n' + entry.summary.trim() : ''}`;
    if (Array.from(text).length > 3200) throw new AppError('AIHOT_ENTRY_TOO_LONG');
    paragraphs.push(text);
  }
  const groups: string[] = [];
  for (const text of paragraphs) {
    const last = groups.at(-1);
    if (last && Array.from(last + '\n\n' + text).length <= 3200) groups[groups.length - 1] += '\n\n' + text;
    else groups.push(text);
  }
  return groups.map((text, i) => `AI 日报 · ${date}${groups.length > 1 ? ` (${i + 1}/${groups.length})` : ''}\n\n${text}\n\n来源：AIHOT\nhttps://aihot.news/daily/${date}`);
}

export class Aihot {
  private busy = false;
  constructor(private store: Store, private request: typeof fetch = fetch) {}
  describe(): State {
    const row = this.store.get<{ value: string }>("SELECT value FROM meta WHERE key='aihot'");
    return row ? JSON.parse(row.value) : { enabled: false, startDate: '', nextCheck: 0, lastDate: '', error: '' };
  }
  private save(state: State) {
    this.store.run("INSERT INTO meta VALUES ('aihot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(state));
  }
  configure(enabled: boolean) {
    return this.store.tx(() => {
      const state = this.describe();
      if (state.enabled === enabled) return state;
      const now = DateTime.fromMillis(this.store.now(), { zone: ZONE });
      this.save({ ...state, enabled, error: '', nextCheck: 0, checkDate: '', failures: 0, revision: randomUUID(),
        startDate: (now.hour >= 10 ? now.plus({ days: 1 }) : now).toISODate()! });
      if (!enabled) {
        for (const d of this.store.all<{ id: string }>("SELECT id FROM deliveries WHERE status='sending' AND batch_id IN (SELECT id FROM digest_batches WHERE slot LIKE 'aihot:%')"))
          this.store.blockContextRecovery(d.id);
        this.store.run("UPDATE deliveries SET status='cancelled',error='AIHOT_DISABLED' WHERE batch_id IN (SELECT id FROM digest_batches WHERE slot LIKE 'aihot:%') AND (status IN ('pending','retry_wait') OR (status='failed' AND error IN ('WEIXIN_CONTEXT_REJECTED','WEIXIN_NEEDS_MESSAGE')))");
      }
      this.store.event('aihot_configured', 'daily', enabled ? 'enabled' : 'disabled');
      return this.describe();
    });
  }
  async cycle(destination: string, signal?: AbortSignal, currentDestination = () => destination) {
    const state = this.describe(), now = this.store.now();
    const local = DateTime.fromMillis(now, { zone: ZONE }), date = local.toISODate()!;
    if (this.busy || signal?.aborted || destination === 'weixin:unbound' || !state.enabled || date < state.startDate || local.hour < 10 || now < state.nextCheck ||
      this.store.get('SELECT 1 FROM digest_batches WHERE slot=?', `aihot:${date}`)) return;
    const failures = (state.checkDate === date ? state.failures || 0 : 0) + 1;
    const tomorrow = local.plus({ days: 1 }).startOf('day').set({ hour: 10 }).toMillis();
    let retry = Math.min(3600000, 300000 * 2 ** Math.min(failures - 1, 4));
    let retryAfter = 0;
    const active = () => {
      const current = this.describe();
      return current.enabled && current.revision === state.revision && current.startDate === state.startDate &&
        currentDestination() === destination && DateTime.fromMillis(this.store.now(), { zone: ZONE }).toISODate() === date;
    };
    this.busy = true;
    this.save({ ...state, checkDate: date, error: '', nextCheck: now + 20000 });
    try {
      const response = await this.request(ENDPOINT, { redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': 'FeedRelay/0.3 (personal daily reader)' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
      if (!response.ok) {
        const after = response.headers.get('retry-after');
        const delay = after && /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after || '') - now;
        if (Number.isFinite(delay) && delay > 0) retryAfter = Math.min(Number.MAX_SAFE_INTEGER - now, delay);
        await response.body?.cancel();
        throw new AppError(`AIHOT_HTTP_${response.status}`);
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (!response.body) throw new AppError('AIHOT_INVALID_REPORT');
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        bytes += chunk.length;
        if (bytes > 256000) throw new AppError('AIHOT_RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
      signal?.throwIfAborted();
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AppError('AIHOT_INVALID_REPORT'); }
      const messages = dailyMessages(data, date);
      this.store.tx(() => {
        const current = this.describe();
        if (!active() || signal?.aborted ||
          this.store.get('SELECT 1 FROM digest_batches WHERE slot=?', `aihot:${date}`)) return;
        const id = randomUUID();
        this.store.run('INSERT INTO digest_batches VALUES (?,?,?,?,?,?,?)', id, `aihot:${date}`, ZONE,
          local.set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toMillis(), now, destination, messages.length);
        messages.forEach((text, index) => {
          const item = this.store.put({ key: `aihot:${date}:${index}`, kind: 'digest',
            title: `AIHOT 日报 ${date}`, author: 'AIHOT', url: `https://aihot.news/daily/${date}`, text }, [], false, destination);
          this.store.run("INSERT INTO deliveries(id,item_id,destination,snapshot,available,created,mode,batch_id) VALUES (?,?,?,?,?,?,'digest_part',?)",
            randomUUID(), item.id, destination, text, now, now, id);
        });
        this.save({ ...current, lastDate: date, error: '', failures: 0, nextCheck: tomorrow });
        this.store.event('aihot_daily_queued', id, date);
      });
    } catch (error) {
      if (!active() || this.store.get('SELECT 1 FROM digest_batches WHERE slot=?', `aihot:${date}`)) return;
      if (signal?.aborted) {
        this.save({ ...state, nextCheck: 0 });
        return;
      }
      const code = error instanceof AppError ? error.code : 'AIHOT_FETCH_FAILED';
      if (code === 'AIHOT_NOT_PUBLISHED') retry = 3600000;
      const nextCheck = Math.max(retryAfter ? now + retryAfter : 0,
        failures >= 12 ? tomorrow : Math.min(tomorrow, this.store.now() + retry));
      this.save({ ...this.describe(), checkDate: date, failures, nextCheck, error: code });
    } finally {
      this.busy = false;
    }
  }
}
