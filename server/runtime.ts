import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './config.js';
import type { Engine } from './engine.js';

export function processLock(dir: string, role: 'web' | 'worker') {
  if (existsSync(join(dir, 'maintenance.lock'))) throw new AppError('MAINTENANCE_IN_PROGRESS');
  const path = join(dir, `${role}.pid`);
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8'));
    try {
      process.kill(pid, 0);
      throw new AppError('PROCESS_ALREADY_RUNNING');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
    unlinkSync(path);
    return processLock(dir, role);
  }
  return () => {
    if (existsSync(path) && readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
  };
}
export function startLoop(engine: Engine) {
  const release = processLock(engine.config.dataDir, 'worker');
  engine.weixin.start();
  let stopped = false,
    timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    try {
      await engine.cycle(true);
    } catch {
      console.error(JSON.stringify({ event: 'worker_error', code: 'WORKER_CYCLE_FAILED' }));
    } finally {
      if (!stopped) timer = setTimeout(tick, 5000);
    }
  };
  void tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await engine.stop();
    release();
  };
}
