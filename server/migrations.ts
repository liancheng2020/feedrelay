import type { DatabaseSync } from 'node:sqlite';

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
