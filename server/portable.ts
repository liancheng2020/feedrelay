import { createHash } from 'node:crypto';
import { AppError } from './config.js';
import { normalizeSource } from './adapters.js';
import { Store, type Source } from './store.js';

type Draft = ReturnType<typeof normalizeSource>;
const fields = [
  'type',
  'name',
  'channel',
  'sender',
  'subject',
  'feed_url',
  'delivery_mode',
  'account_ref',
];
const identity = (
  s: Pick<Source, 'type' | 'channel' | 'sender' | 'subject' | 'feed_url'> | Draft,
) => JSON.stringify([s.type, s.channel, s.sender, s.subject, s.feed_url]);
export function exportSources(store: Store, includePublicFeeds = false) {
  const sources = store.sources();
  return {
    format: 'feedrelay.sources',
    version: 1,
    sources: sources
      .filter((s) => s.type !== 'rss' || includePublicFeeds)
      .map((s) => ({
        type: s.type,
        name: s.name,
        delivery_mode: s.delivery_mode,
        ...(s.type === 'youtube'
          ? { channel: s.channel }
          : s.type === 'email'
            ? { sender: s.sender, subject: s.subject, account_ref: 'default' }
            : { feed_url: s.feed_url }),
      })),
    omittedRss: includePublicFeeds ? 0 : sources.filter((s) => s.type === 'rss').length,
  };
}
export function previewImport(store: Store, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AppError('INVALID_IMPORT');
  const bundle = input as Record<string, unknown>;
  if (
    Object.keys(bundle).some((k) => !['format', 'version', 'sources', 'omittedRss'].includes(k)) ||
    bundle.format !== 'feedrelay.sources' ||
    bundle.version !== 1 ||
    !Array.isArray(bundle.sources) ||
    bundle.sources.length > 25 ||
    Buffer.byteLength(JSON.stringify(bundle)) > 30_000
  )
    throw new AppError('INVALID_IMPORT');
  const seen = new Set(store.sources().map(identity)),
    totals = { youtube: 0, email: 0, rss: 0 };
  for (const s of store.sources()) totals[s.type]++;
  const rows = bundle.sources.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AppError('INVALID_IMPORT');
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).some((k) => !fields.includes(k)) ||
      Object.values(row).some((v) => typeof v !== 'string') ||
      (row.account_ref && row.account_ref !== 'default')
    )
      throw new AppError('IMPORT_UNSUPPORTED_FIELD');
    const allowed = [
      'type',
      'name',
      'delivery_mode',
      ...(row.type === 'youtube'
        ? ['channel']
        : row.type === 'email'
          ? ['sender', 'subject', 'account_ref']
          : ['feed_url']),
    ];
    if (Object.keys(row).some((k) => !allowed.includes(k)))
      throw new AppError('IMPORT_UNSUPPORTED_FIELD');
    const source = normalizeSource(row),
      key = identity(source),
      duplicate = seen.has(key);
    seen.add(key);
    if (!duplicate && ++totals[source.type] > (source.type === 'email' ? 5 : 10))
      throw new AppError('SOURCE_LIMIT');
    return { source, duplicate };
  });
  return {
    rows,
    hash: createHash('sha256')
      .update(JSON.stringify(rows.map((r) => r.source)))
      .digest('hex'),
  };
}
export function applyImport(store: Store, input: unknown, hash: string, confirmedPublic: boolean) {
  return store.tx(() => {
    const plan = previewImport(store, input);
    if (plan.hash !== hash) throw new AppError('IMPORT_PREVIEW_CHANGED', 409);
    if (plan.rows.some((r) => r.source.type === 'rss') && !confirmedPublic)
      throw new AppError('PUBLIC_FEED_CONFIRMATION_REQUIRED');
    let imported = 0;
    for (const row of plan.rows)
      if (!row.duplicate) {
        store.createSource(row.source);
        imported++;
      }
    return { imported, skipped: plan.rows.length - imported };
  });
}
