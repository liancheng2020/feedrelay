import type { DatabaseSync } from 'node:sqlite';

export function migrateV5(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) < 5)
      db.exec(`CREATE TABLE IF NOT EXISTS admin_sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, must_change INTEGER NOT NULL DEFAULT 0);
        PRAGMA user_version=5;`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function migrateV2(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get()!.user_version as number;
    if (version >= 2) {
      db.exec('COMMIT');
      return;
    }
    db.exec(`
    ALTER TABLE sources ADD COLUMN feed_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE sources ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'immediate';
    DROP INDEX source_identity;
    CREATE UNIQUE INDEX source_identity ON sources(type,channel,sender,subject,feed_url) WHERE deleted=0;
    ALTER TABLE deliveries ADD COLUMN mode TEXT NOT NULL DEFAULT 'immediate';
    ALTER TABLE deliveries ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE deliveries ADD COLUMN part_id TEXT NOT NULL DEFAULT '';
    CREATE TABLE digest_batches(id TEXT PRIMARY KEY,slot TEXT UNIQUE NOT NULL,timezone TEXT NOT NULL,cutoff INTEGER NOT NULL,created INTEGER NOT NULL,destination TEXT NOT NULL,total_parts INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX digest_members ON deliveries(part_id);
    PRAGMA user_version=2;
    COMMIT;`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function migrateV3(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) < 3)
      db.exec(`
      ALTER TABLE sources ADD COLUMN summary_mode TEXT NOT NULL DEFAULT 'off';
      ALTER TABLE sources ADD COLUMN summary_notify INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sources ADD COLUMN summary_consent TEXT NOT NULL DEFAULT '';
      ALTER TABLE sources ADD COLUMN summary_since INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE summaries (
        id TEXT PRIMARY KEY, cache_key TEXT UNIQUE NOT NULL, item_id TEXT NOT NULL REFERENCES items(id),
        source_id TEXT NOT NULL REFERENCES sources(id), generation INTEGER NOT NULL, stamp TEXT NOT NULL,
        input TEXT NOT NULL, scope TEXT NOT NULL, origin TEXT NOT NULL, notify INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
        token TEXT NOT NULL DEFAULT '', lease INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, finished INTEGER,
        output_item TEXT NOT NULL DEFAULT '');
      CREATE INDEX summaries_item ON summaries(item_id);
      CREATE TABLE model_calls (
        id TEXT PRIMARY KEY, summary_id TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL,
        reserved_micro INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, actual_micro INTEGER);
      PRAGMA user_version=3;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function migrateV4(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) < 4)
      db.exec(`
        ALTER TABLE sources ADD COLUMN summary_content TEXT NOT NULL DEFAULT 'feed';
        ALTER TABLE summaries ADD COLUMN material TEXT NOT NULL DEFAULT '';
        PRAGMA user_version=4;
      `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
