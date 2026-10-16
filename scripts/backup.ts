import 'dotenv/config';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, access, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const source = resolve(process.env.DATA_DIR || 'data', 'feedrelay.sqlite');
const destination = resolve(process.argv[2] || `backups/feedrelay-${Date.now()}.sqlite`);
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
await access(destination).then(
  () => {
    throw new Error('BACKUP_ALREADY_EXISTS');
  },
  () => {},
);
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, destination);
  await chmod(destination, 0o600);
  console.log(`Backup saved: ${destination}. Treat it as private data.`);
} finally {
  db.close();
}
