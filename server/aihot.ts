import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { AppError } from './config.js';
import { Store } from './store.js';

const ENDPOINT = 'https://aihot.news/api/v1/dailies/latest';
const ZONE = 'Asia/Shanghai';
interface State { enabled: boolean; startDate: string; nextCheck: number; lastDate: string; error: string }
interface Entry { title: string; summary?: string }
export function dailyMessages(data: unknown, date: string) {
  const report = (data as { report?: { date?: string; sections?: { items: Entry[] }[]; flashes?: Entry[] } })?.report;
  if (report?.date !== date) throw new AppError('AIHOT_NOT_PUBLISHED');
  if (!Array.isArray(report.sections)) throw new AppError('AIHOT_INVALID_REPORT');
  const entries = [...report.sections.flatMap((s) => s.items), ...(report.flashes || [])];
  if (!entries.length || entries.length > 100) throw new AppError('AIHOT_INVALID_REPORT');
  const seen = new Set<string>();
  const paragraphs: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.title !== 'string' || !entry.title.trim() ||
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
  constructor(private store: Store, private request: typeof fetch = fetch) {}
  describe(): State {
    const row = this.store.get<{ value: string }>("SELECT value FROM meta WHERE key='aihot'");
    return row ? JSON.parse(row.value) : { enabled: false, startDate: '', nextCheck: 0, lastDate: '', error: '' };
  }
  private save(state: State) {
    this.store.run("INSERT INTO meta VALUES ('aihot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(state));
  }
  configure(enabled: boolean) {
    const state = this.describe();
    if (state.enabled === enabled) return state;
    const now = DateTime.fromMillis(this.store.now(), { zone: ZONE });
    this.save({ ...state, enabled, error: '', nextCheck: 0,
      startDate: (now.hour >= 10 ? now.plus({ days: 1 }) : now).toISODate()! });
    if (!enabled) this.store.run("UPDATE deliveries SET status='cancelled',error='AIHOT_DISABLED' WHERE batch_id IN (SELECT id FROM digest_batches WHERE slot LIKE 'aihot:%') AND status IN ('pending','retry_wait')");
    this.store.event('aihot_configured', 'daily', enabled ? 'enabled' : 'disabled');
    return this.describe();
  }
  async cycle(destination: string, signal?: AbortSignal) {
    const state = this.describe(), now = this.store.now();
    const local = DateTime.fromMillis(now, { zone: ZONE }), date = local.toISODate()!;
    if (!state.enabled || date < state.startDate || local.hour < 10 || now < state.nextCheck ||
      this.store.get('SELECT 1 FROM digest_batches WHERE slot=?', `aihot:${date}`)) return;
    let retry = 3600000;
    this.save({ ...state, nextCheck: now + retry });
    try {
      const response = await this.request(ENDPOINT, { redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': 'FeedRelay/0.3 (personal daily reader)' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
      if (!response.ok) {
        const after = response.headers.get('retry-after');
        const delay = after && /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after || '') - now;
        if (Number.isFinite(delay)) retry = Math.max(retry, delay);
        await response.body?.cancel();
        throw new AppError(`AIHOT_HTTP_${response.status}`);
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body || []) {
        bytes += chunk.length;
        if (bytes > 256000) throw new AppError('AIHOT_RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
      const messages = dailyMessages(JSON.parse(Buffer.concat(chunks).toString('utf8')), date);
      this.store.tx(() => {
        const current = this.describe();
        if (!current.enabled || current.startDate !== state.startDate || signal?.aborted ||
          DateTime.fromMillis(this.store.now(), { zone: ZONE }).toISODate() !== date ||
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
        this.save({ ...this.describe(), lastDate: date, error: '' });
        this.store.event('aihot_daily_queued', id, date);
      });
    } catch (error) {
      this.save({ ...this.describe(), nextCheck: now + retry,
        error: error instanceof AppError ? error.code : 'AIHOT_FETCH_FAILED' });
    }
  }
}
