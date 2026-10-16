import 'dotenv/config';
import { DatabaseSync, backup } from 'node:sqlite';
import { copyFile, readFile, mkdir, rename, unlink, open, chmod, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { migrateV2 } from '../server/migrations.js';

const source = process.argv[2];
if (!source || !process.argv.includes('--confirm-stopped'))
  throw new Error(
    'Usage: npm run restore -- backup.sqlite --confirm-stopped (stop Web and Worker first)',
  );
const dir = resolve(process.env.DATA_DIR || 'data');
await mkdir(dir, { recursive: true, mode: 0o700 });
const lockPath = join(dir, 'maintenance.lock'),
  lock = await open(lockPath, 'wx', 0o600);
const temp = join(dir, `restore-${Date.now()}.sqlite`);
try {
  for (const role of ['web', 'worker']) {
    const value = await readFile(join(dir, role + '.pid'), 'utf8').catch(() => '');
    if (value) {
      try {
        process.kill(Number(value), 0);
        throw new Error('STOP_SERVICES_BEFORE_RESTORE');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
    }
  }
  await copyFile(resolve(source), temp);
  await chmod(temp, 0o600);
  const db = new DatabaseSync(temp);
  try {
    if (
      db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      ![1, 2].includes(Number(db.prepare('PRAGMA user_version').get()?.user_version))
    )
      throw new Error('INVALID_BACKUP');
    migrateV2(db);
    db.exec(
      `BEGIN IMMEDIATE; UPDATE deliveries SET status='unknown',error='RESTORED_NEEDS_REVIEW',token='',lease=0 WHERE status IN ('pending','sending','retry_wait','unknown','digest_wait'); DELETE FROM locks; UPDATE jobs SET status='retry_wait',token='',lease=0 WHERE status='running'; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);`,
    );
  } finally {
    db.close();
  }
  const target = join(dir, 'feedrelay.sqlite');
  if (
    await access(target).then(
      () => true,
      () => false,
    )
  ) {
    const old = new DatabaseSync(target, { readOnly: true }),
      previous = join(dir, `before-restore-${Date.now()}.sqlite`);
    try {
      await backup(old, previous);
      await chmod(previous, 0o600);
    } finally {
      old.close();
    }
  }
  for (const suffix of ['-wal', '-shm'])
    await unlink(target + suffix).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  await rename(temp, target);
  console.log('Restored. Pending sends require manual review; nothing will be blindly replayed.');
} finally {
  await lock.close();
  await unlink(lockPath);
  await unlink(temp).catch(() => {});
}
