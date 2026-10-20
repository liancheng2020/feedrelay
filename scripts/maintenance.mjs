import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, unlink, chmod, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function dailyBackup(data, directory, retention, now = new Date()) {
  if (!Number.isInteger(retention) || retention < 1 || retention > 90) throw new Error('INVALID_RETENTION');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const date = now.toISOString().slice(0, 10);
  const destination = join(directory, `auto-${date}.sqlite`);
  try { await lstat(destination); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = `${destination}.partial`;
  const db = new DatabaseSync(join(data, 'feedrelay.sqlite'), { readOnly: true });
  try {
    await backup(db, pending);
    await chmod(pending, 0o600);
    const { rename } = await import('node:fs/promises');
    await rename(pending, destination);
  } finally {
    db.close();
    await rm(pending, { force: true });
  }
  const cutoff = new Date(now.getTime() - retention * 86400_000).toISOString().slice(0, 10);
  for (const name of await readdir(directory)) {
    if (!/^auto-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name) || name.slice(5, 15) > cutoff) continue;
    const path = join(directory, name);
    if ((await lstat(path)).isFile()) await unlink(path);
  }
  return true;
}
