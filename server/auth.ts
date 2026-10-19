import { createHash, randomBytes } from 'node:crypto';
import { AppError, hashPassword, verifyPassword, type Config } from './config.js';
import type { Store } from './store.js';

const key = (token: string) => createHash('sha256').update(token).digest('hex');
export class AdminAuth {
  constructor(private store: Store, private config: Config) {}

  private hash() {
    return this.store.get<{ value: string }>("SELECT value FROM meta WHERE key='admin-password'")?.value
      || this.config.passwordHash;
  }
  verify(password: unknown) {
    const failures = this.store.get<{ n: number }>(
      "SELECT count(*) n FROM events WHERE action='login_failed' AND at>?", this.store.now() - 900_000,
    )!.n;
    if (failures >= 10) throw new AppError('LOGIN_RATE_LIMITED', 429);
    if (typeof password !== 'string' || password.length > 256 || !verifyPassword(password, this.hash())) {
      this.store.event('login_failed', 'admin');
      throw new AppError('INVALID_PASSWORD', 400);
    }
  }
  issue(remember: boolean) {
    const token = randomBytes(32).toString('hex');
    const maxAge = (remember ? 30 * 24 : 8) * 3_600_000;
    const mustChangePassword = !this.config.demo && verifyPassword('admin', this.hash());
    this.store.run('DELETE FROM admin_sessions WHERE expires<=?', this.store.now());
    this.store.run('INSERT INTO admin_sessions VALUES (?,?,?)', key(token), this.store.now() + maxAge, Number(mustChangePassword));
    return { sid: token, authenticated: true, csrf: randomBytes(24).toString('hex'), maxAge, mustChangePassword };
  }
  valid(token: unknown) {
    if (typeof token !== 'string') return undefined;
    return this.store.get<{ must_change: number }>('SELECT must_change FROM admin_sessions WHERE id=? AND expires>?', key(token), this.store.now());
  }
  revoke(token: unknown) {
    if (typeof token === 'string') this.store.run('DELETE FROM admin_sessions WHERE id=?', key(token));
  }
  setPassword(password: unknown) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 16 || !password.trim())
      throw new AppError('INVALID_NEW_PASSWORD');
    if (verifyPassword(password, this.hash())) throw new AppError('PASSWORD_UNCHANGED');
    const hash = hashPassword(password);
    this.store.tx(() => {
      this.store.run("INSERT INTO meta VALUES ('admin-password',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", hash);
      this.store.run('DELETE FROM admin_sessions');
      this.store.event('admin_password_changed', 'admin');
    });
  }
}
