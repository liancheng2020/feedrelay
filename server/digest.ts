import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { Store, type Delivery, type Source } from './store.js';

export interface DigestBatch {
  id: string;
  slot: string;
  timezone: string;
  cutoff: number;
  created: number;
  destination: string;
  total_parts: number;
}
export function digestSlot(now: number, zone: string, clock: string) {
  const [hour, minute] = clock.split(':').map(Number);
  const local = DateTime.fromMillis(now, { zone });
  const onDay = (day: DateTime) => {
    const time = DateTime.fromObject(
      { year: day.year, month: day.month, day: day.day, hour, minute },
      { zone },
    );
    return time.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0];
  };
  let due = onDay(local);
  if (due.toMillis() > now) due = onDay(local.minus({ days: 1 }));
  return {
    slot: `${zone}:${clock}:${due.toISODate()}`,
    cutoff: due.toMillis(),
    label: due.toFormat('yyyy-LL-dd HH:mm ZZZZ'),
  };
}
export function freezeDigest(store: Store, destination: string) {
  const settings = store.settings(),
    due = digestSlot(store.now(), settings.timezone, settings.digestTime);
  return store.tx(() => {
    if (store.get('SELECT 1 FROM digest_batches WHERE slot=?', due.slot)) return;
    if (
      !store.get(
        "SELECT 1 FROM sources WHERE delivery_mode='digest' AND enabled=1 AND notify=1 AND deleted=0",
      ) &&
      !store.get("SELECT 1 FROM deliveries WHERE status='digest_wait'")
    )
      return;
    const members = store.all<Delivery>(
      `SELECT d.* FROM deliveries d JOIN items i ON i.id=d.item_id WHERE d.mode='digest' AND d.status='digest_wait' AND d.created<=? AND d.destination=? AND i.expired=0 AND EXISTS(SELECT 1 FROM source_items si JOIN sources s ON s.id=si.source_id WHERE si.item_id=d.item_id AND s.enabled=1 AND s.notify=1 AND s.deleted=0) ORDER BY d.created,d.id LIMIT 500`,
      due.cutoff,
      destination,
    );
    const groups: Delivery[][] = [];
    let current: Delivery[] = [],
      length = 0;
    for (const member of members) {
      const size = Array.from(member.snapshot).length + 12;
      if (!member.snapshot || size > 3300) {
        store.run(
          "UPDATE deliveries SET status='failed',error='DIGEST_ENTRY_TOO_LONG' WHERE id=?",
          member.id,
        );
        continue;
      }
      if (current.length && (length + size > 3300 || current.length >= 10)) {
        groups.push(current);
        current = [];
        length = 0;
      }
      current.push(member);
      length += size;
    }
    if (current.length) groups.push(current);
    const id = randomUUID();
    store.run(
      'INSERT INTO digest_batches VALUES (?,?,?,?,?,?,?)',
      id,
      due.slot,
      settings.timezone,
      due.cutoff,
      store.now(),
      destination,
      groups.length,
    );
    groups.forEach((group, index) => {
      const text =
        `FeedRelay 日报 · ${due.label}\n${index + 1}/${groups.length} 分片 · 原文预览，非 AI 摘要\n\n` +
        group.map((m, n) => `${n + 1}. ${m.snapshot}`).join('\n\n---\n\n');
      const sources = store.all<Source>(
        `SELECT DISTINCT s.* FROM sources s JOIN source_items si ON s.id=si.source_id JOIN deliveries d ON d.item_id=si.item_id WHERE d.id IN (${group.map(() => '?').join(',')}) AND s.enabled=1 AND s.notify=1 AND s.deleted=0`,
        ...group.map((m) => m.id),
      );
      const item = store.put(
        {
          key: `digest:${id}:${index + 1}`,
          kind: 'digest',
          title: `日报 ${due.label} · ${index + 1}/${groups.length}`,
          author: 'FeedRelay',
          text,
          url: '',
        },
        sources,
        false,
        destination,
      );
      const part = randomUUID();
      store.run(
        `INSERT INTO deliveries(id,item_id,destination,snapshot,available,created,mode,batch_id) VALUES (?,?,?,?,?,?,'digest_part',?)`,
        part,
        item.id,
        destination,
        text,
        store.now(),
        store.now(),
        id,
      );
      for (const member of group)
        store.run(
          "UPDATE deliveries SET status='batched',batch_id=?,part_id=?,snapshot='' WHERE id=?",
          id,
          part,
          member.id,
        );
    });
    store.event('digest_frozen', id, String(members.length));
    return id;
  });
}
export function listDigests(store: Store) {
  return store
    .all<DigestBatch>('SELECT * FROM digest_batches ORDER BY created DESC,rowid DESC LIMIT 30')
    .map((batch) => ({
      id: batch.id,
      slot: batch.slot,
      timezone: batch.timezone,
      cutoff: batch.cutoff,
      created: batch.created,
      total_parts: batch.total_parts,
      parts: store.all<{
        id: string;
        item_id: string;
        status: string;
        error: string;
        attempt: number;
        resolution: string;
      }>(
        `SELECT id,item_id,status,error,attempt,resolution FROM deliveries WHERE batch_id=? AND mode='digest_part' ORDER BY rowid`,
        batch.id,
      ),
      members: store.get<{ n: number }>(
        "SELECT count(*) n FROM deliveries WHERE batch_id=? AND mode='digest'",
        batch.id,
      )!.n,
    }));
}
