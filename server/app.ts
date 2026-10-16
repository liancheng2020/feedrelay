import Koa from 'koa';
import Router from '@koa/router';
import { bodyParser } from '@koa/bodyparser';
import session from 'koa-session';
import serve from 'koa-static';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  AppError,
  preview,
  verifyPassword,
  validateSettings,
  type Config,
  type Settings,
} from './config.js';
import { Store, type Item, type Delivery } from './store.js';
import { Engine } from './engine.js';
import { normalizeSource } from './adapters.js';
import { advanceDemo } from './demo.js';

const bool = (v: unknown) => {
  if (typeof v !== 'boolean') throw new AppError('INVALID_BOOLEAN');
  return v;
};
export function createApp(store: Store, config: Config, engine: Engine) {
  const app = new Koa();
  app.keys = [config.sessionSecret];
  app.proxy = false;
  app.use(async (ctx, next) => {
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.set('Referrer-Policy', 'no-referrer');
    ctx.set(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    ctx.set('Cache-Control', 'no-store');
    try {
      await next();
    } catch (error) {
      const known = error instanceof AppError;
      ctx.status = known ? error.status : (error as { status?: number }).status === 413 ? 413 : 500;
      ctx.body = {
        error: known ? error.code : ctx.status === 413 ? 'REQUEST_TOO_LARGE' : 'INTERNAL_ERROR',
      };
      if (!known) console.error(JSON.stringify({ event: 'request_error', code: 'INTERNAL_ERROR' }));
    }
  });
  app.use(
    session(
      {
        key: 'feedrelay.session',
        maxAge: 8 * 3_600_000,
        httpOnly: true,
        signed: true,
        sameSite: 'strict',
        secure: config.cookieSecure,
        renew: false,
      },
      app,
    ),
  );
  app.use(async (ctx, next) => {
    if (!ctx.path.startsWith('/api/')) return next();
    if (!['GET', 'HEAD'].includes(ctx.method)) {
      if (ctx.get('origin') !== config.origin) throw new AppError('INVALID_ORIGIN', 403);
      if (ctx.path !== '/api/login' && ctx.get('x-csrf-token') !== ctx.session?.csrf)
        throw new AppError('INVALID_CSRF', 403);
    }
    if (
      !['/api/health', '/api/session', '/api/login'].includes(ctx.path) &&
      !ctx.session?.authenticated
    )
      throw new AppError('UNAUTHORIZED', 401);
    await next();
  });
  app.use(
    bodyParser({
      enableTypes: ['json'],
      parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
      jsonLimit: '32kb',
      onError: () => {
        throw new AppError('INVALID_JSON');
      },
    }),
  );
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method)) {
      if (
        !ctx.request.body ||
        typeof ctx.request.body !== 'object' ||
        Array.isArray(ctx.request.body)
      )
        throw new AppError('INVALID_JSON');
    }
    await next();
  });
  const router = new Router();
  router.get('/api/health', (ctx) => {
    ctx.body = { ok: true };
  });
  router.get('/api/session', (ctx) => {
    ctx.session ??= {};
    ctx.session.csrf ||= randomBytes(24).toString('hex');
    ctx.body = {
      authenticated: !!ctx.session.authenticated,
      csrf: ctx.session.csrf,
      demo: config.demo,
    };
  });
  router.post('/api/login', (ctx) => {
    const failures = Number(
      store.get<{ n: number }>(
        `SELECT count(*) n FROM events WHERE action='login_failed' AND at>?`,
        store.now() - 900_000,
      )!.n,
    );
    if (failures >= 10) throw new AppError('LOGIN_RATE_LIMITED', 429);
    const password = (ctx.request.body as { password?: unknown })?.password;
    if (
      typeof password !== 'string' ||
      password.length > 256 ||
      !verifyPassword(password, config.passwordHash)
    ) {
      store.event('login_failed', 'admin');
      throw new AppError('INVALID_PASSWORD', 401);
    }
    ctx.session = { authenticated: true, csrf: randomBytes(24).toString('hex') };
    ctx.body = { csrf: ctx.session.csrf, demo: config.demo };
  });
  router.post('/api/logout', (ctx) => {
    ctx.session = null;
    ctx.body = { ok: true };
  });
  router.get('/api/overview', (ctx) => {
    ctx.body = {
      stats: store.stats(),
      settings: store.settings(),
      demo: config.demo,
      connections: {
        imap: config.demo || config.imap.enabled,
        feishu: config.demo || config.feishu.enabled,
        folder: config.imap.folder,
        recipient: config.demo
          ? '演示收件人（模拟）'
          : config.feishu.openId
            ? `${config.feishu.openId.slice(0, 6)}…${config.feishu.openId.slice(-4)}`
            : '未配置',
        app: config.feishu.appId ? '已配置' : '未配置',
      },
    };
  });
  router.get('/api/sources', (ctx) => {
    ctx.body = store.sources();
  });
  router.post('/api/sources', (ctx) => {
    const input = normalizeSource(ctx.request.body as Record<string, unknown>);
    const count = store.sources().filter((s) => s.type === input.type).length;
    if (count >= (input.type === 'email' ? 5 : 10)) throw new AppError('SOURCE_LIMIT');
    ctx.status = 201;
    ctx.body = store.createSource(input);
  });
  router.put('/api/sources/:id', (ctx) => {
    const current = store.source(String(ctx.params.id));
    const input = normalizeSource({
      ...current,
      ...(ctx.request.body as object),
      type: current.type,
      channel: current.channel,
      sender: current.sender,
    });
    ctx.body = store.edit(current.id, input);
  });
  router.post('/api/sources/:id/toggle', (ctx) => {
    const input = ctx.request.body as {
      enabled?: boolean;
      notify?: boolean;
      mode?: string;
      confirmed?: boolean;
    };
    if (input.notify && input.confirmed !== true)
      throw new AppError('DISCLOSURE_CONFIRMATION_REQUIRED');
    if (!['new_only', 'catch_up'].includes(input.mode || 'new_only'))
      throw new AppError('INVALID_RESUME_MODE');
    ctx.body = store.toggle(
      String(ctx.params.id),
      bool(input.enabled),
      bool(input.notify),
      input.mode,
    );
  });
  router.delete('/api/sources/:id', (ctx) => {
    const body = ctx.request.body as { confirmed?: boolean; erase?: boolean };
    if (body.confirmed !== true) throw new AppError('DELETE_CONFIRMATION_REQUIRED');
    store.deleteSource(String(ctx.params.id), bool(body.erase));
    ctx.body = { ok: true };
  });
  router.post('/api/sources/:id/check', (ctx) => {
    const s = store.source(String(ctx.params.id));
    const resource = s.type === 'email' && s.enabled ? 'default' : s.id;
    const recent = store.get<{ n: number }>(
      `SELECT count(*) n FROM jobs WHERE resource=? AND created>?`,
      resource,
      store.now() - 60_000,
    )!.n;
    if (recent >= 5) throw new AppError('CHECK_RATE_LIMITED', 429);
    ctx.status = 202;
    ctx.body = store.enqueue(
      !s.enabled ? 'probe' : s.type === 'email' ? 'mailbox' : 'source',
      s.type === 'email' && s.enabled ? 'default' : s.id,
      s.generation,
    );
  });
  router.get('/api/jobs', (ctx) => {
    ctx.body = store.all(
      `SELECT id,kind,resource,status,attempt,available,error,result,created FROM jobs ORDER BY created DESC LIMIT 50`,
    );
  });
  router.get('/api/items', (ctx) => {
    const page = Math.max(1, Math.min(100_000, Math.floor(Number(ctx.query.page) || 1)));
    const status = String(ctx.query.status || ''),
      source = String(ctx.query.source || '');
    const where = `WHERE (?='' OR COALESCE(d.status,'discovered')=?) AND (?='' OR EXISTS(SELECT 1 FROM source_items si WHERE si.item_id=i.id AND si.source_id=?))`;
    const params = [status, status, source, source];
    ctx.body = {
      page,
      total: store.get(
        `SELECT count(*) n FROM items i LEFT JOIN deliveries d ON d.item_id=i.id ${where}`,
        ...params,
      )!.n,
      items: store
        .all<
          Item & Partial<Delivery>
        >(`SELECT i.*,d.id AS delivery_id,d.status,d.attempt,d.error,d.sent,d.available,d.resolution FROM items i LEFT JOIN deliveries d ON d.item_id=i.id ${where} ORDER BY i.discovered DESC,i.rowid DESC LIMIT 30 OFFSET ?`, ...params, (page - 1) * 30)
        .map((i) => ({ ...i, text: preview(i.text) })),
    };
  });
  router.get('/api/items/:id', (ctx) => {
    const item = store.get<Item>('SELECT * FROM items WHERE id=?', String(ctx.params.id));
    if (!item) throw new AppError('ITEM_NOT_FOUND', 404);
    const d = store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id);
    ctx.body = {
      ...item,
      delivery: d
        ? {
            id: d.id,
            status: d.status,
            error: d.error,
            resolution: d.resolution,
            attempt: d.attempt,
            sent: d.sent,
          }
        : null,
      attempts: d
        ? store.all('SELECT n,at,status,code FROM attempts WHERE delivery_id=? ORDER BY at', d.id)
        : [],
    };
  });
  router.post('/api/deliveries/:id/resolve', (ctx) => {
    const body = ctx.request.body as { action?: string; confirmed?: boolean };
    if (body.confirmed !== true || !['retry', 'acknowledge'].includes(body.action || ''))
      throw new AppError('RETRY_CONFIRMATION_REQUIRED');
    store.resolveDelivery(
      String(ctx.params.id),
      body.action as 'retry' | 'acknowledge',
      engine.destination,
    );
    ctx.body = { ok: true };
  });
  router.put('/api/settings', (ctx) => {
    store.setSettings(validateSettings(ctx.request.body as Settings));
    ctx.body = store.settings();
  });
  router.post('/api/settings/test-feishu', (ctx) => {
    if (!config.demo && !config.feishu.enabled) throw new AppError('FEISHU_NOT_ENABLED', 503);
    if ((ctx.request.body as { confirmed?: boolean }).confirmed !== true)
      throw new AppError('SEND_CONFIRMATION_REQUIRED');
    const recent = Number(
      store.get<{ n: number }>(
        `SELECT count(*) n FROM items WHERE key LIKE 'test:%' AND discovered>?`,
        store.now() - 60_000,
      )!.n,
    );
    if (recent >= 2) throw new AppError('TEST_RATE_LIMITED', 429);
    ctx.status = 202;
    ctx.body = store.tx(() =>
      store.put(
        {
          key: `test:${randomBytes(12).toString('hex')}`,
          kind: 'email',
          title: 'FeedRelay 连接测试',
          author: 'FeedRelay',
          text: '这是一条测试消息，不包含私人邮件或视频正文。',
          url: '',
        },
        [],
        true,
        engine.destination,
      ),
    );
  });
  router.post('/api/demo/advance', (ctx) => {
    if (!config.demo) throw new AppError('NOT_FOUND', 404);
    ctx.body = { sequence: advanceDemo(store) };
  });
  app.use(router.routes()).use(router.allowedMethods());
  app.use(serve(resolve('dist/web'), { maxage: 0, hidden: false }));
  app.use(async (ctx) => {
    if (ctx.method === 'GET' && !ctx.path.startsWith('/api/')) {
      try {
        ctx.type = 'html';
        ctx.body = await readFile(resolve('dist/web/index.html'));
      } catch {
        ctx.status = 404;
        ctx.body = 'Run npm run build or use the Vite development URL.';
      }
    } else {
      ctx.status = 404;
      ctx.body = { error: 'NOT_FOUND' };
    }
  });
  return app;
}
