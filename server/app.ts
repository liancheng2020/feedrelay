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
import { listDigests } from './digest.js';
import { exportSources, previewImport, applyImport } from './portable.js';

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
    engine.syncDestination();
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
          : config.pushChannel === 'weixin'
            ? engine.weixin.describe().recipient || '未绑定'
            : config.feishu.openId
              ? `${config.feishu.openId.slice(0, 6)}…${config.feishu.openId.slice(-4)}`
              : '未配置',
        app: config.feishu.appId ? '已配置' : '未配置',
        channel: config.pushChannel,
        pushReady: engine.pushReady,
        weixin: engine.weixin.describe(),
      },
    };
  });
  router.get('/api/sources', (ctx) => {
    ctx.body = store.sources();
  });
  router.post('/api/sources', async (ctx) => {
    const raw = ctx.request.body as Record<string, unknown>;
    const input = normalizeSource({
      ...raw,
      ...(raw.type === 'youtube'
        ? { channel: await engine.adapters.resolveChannel(String(raw.channel || '')) }
        : {}),
    });
    if (
      input.type === 'rss' &&
      (ctx.request.body as { publicConfirmed?: boolean }).publicConfirmed !== true
    )
      throw new AppError('PUBLIC_FEED_CONFIRMATION_REQUIRED');
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
      feed_url: current.feed_url,
    });
    ctx.body = store.edit(current.id, input);
  });
  router.post('/api/sources/:id/delivery-mode', (ctx) => {
    const body = ctx.request.body as { mode?: string; confirmed?: boolean };
    if (body.confirmed !== true || !['immediate', 'digest'].includes(body.mode || ''))
      throw new AppError('MODE_CONFIRMATION_REQUIRED');
    ctx.body = store.changeDeliveryMode(String(ctx.params.id), body.mode as 'immediate' | 'digest');
  });
  router.get('/api/sources/export', (ctx) => {
    ctx.body = exportSources(store, ctx.query.includePublicFeeds === 'confirmed');
  });
  router.post('/api/sources/import-preview', (ctx) => {
    ctx.body = previewImport(store, ctx.request.body);
  });
  router.post('/api/sources/import', (ctx) => {
    const body = ctx.request.body as {
      bundle?: unknown;
      hash?: string;
      confirmed?: boolean;
      confirmedPublic?: boolean;
    };
    if (body.confirmed !== true) throw new AppError('IMPORT_CONFIRMATION_REQUIRED');
    ctx.body = applyImport(store, body.bundle, body.hash || '', body.confirmedPublic === true);
  });
  router.get('/api/digests', (ctx) => {
    ctx.body = listDigests(store);
  });
  router.get('/api/summaries/settings', (ctx) => {
    ctx.body = engine.summaries.describe();
  });
  router.put('/api/summaries/settings', (ctx) => {
    ctx.body = engine.summaries.configure(ctx.request.body);
  });
  router.post('/api/sources/:id/summary', (ctx) => {
    const b = ctx.request.body as {
      mode?: unknown;
      notify?: unknown;
      confirmed?: unknown;
      content?: unknown;
    };
    ctx.body = engine.summaries.authorize(
      String(ctx.params.id),
      b.mode,
      b.notify,
      b.confirmed,
      b.content,
    );
  });
  router.post('/api/items/:id/summary', (ctx) => {
    const b = ctx.request.body as { confirmed?: boolean; retry?: boolean };
    if (b.confirmed !== true || (b.retry !== undefined && typeof b.retry !== 'boolean'))
      throw new AppError('SUMMARY_CONFIRMATION_REQUIRED');
    ctx.status = 202;
    ctx.body = { id: engine.summaries.enqueue(String(ctx.params.id), 'manual', b.retry === true) };
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
    if (input.notify && !engine.pushReady) throw new AppError('PUSH_NOT_READY');
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
    const joins =
      'items i LEFT JOIN deliveries d ON d.item_id=i.id LEFT JOIN deliveries p ON p.id=d.part_id';
    const where = `WHERE i.kind NOT IN ('digest','summary') AND (?='' OR COALESCE(p.status,d.status,'discovered')=?) AND (?='' OR EXISTS(SELECT 1 FROM source_items si WHERE si.item_id=i.id AND si.source_id=?))`;
    const params = [status, status, source, source];
    ctx.body = {
      page,
      total: store.get(`SELECT count(*) n FROM ${joins} ${where}`, ...params)!.n,
      items: store
        .all<
          Item & Partial<Delivery>
        >(`SELECT i.*,COALESCE(p.id,d.id) AS delivery_id,COALESCE(p.status,d.status) status,COALESCE(p.attempt,d.attempt) attempt,COALESCE(p.error,d.error) error,COALESCE(p.sent,d.sent) sent,COALESCE(p.available,d.available) available,COALESCE(p.resolution,d.resolution) resolution,d.mode,d.batch_id FROM ${joins} ${where} ORDER BY COALESCE(i.received,i.published,i.discovered) DESC,i.discovered DESC,i.rowid DESC LIMIT 30 OFFSET ?`, ...params, (page - 1) * 30)
        .map((i) => ({ ...i, text: preview(i.text) })),
    };
  });
  router.get('/api/items/:id', (ctx) => {
    const item = store.get<Item>('SELECT * FROM items WHERE id=?', String(ctx.params.id));
    if (!item) throw new AppError('ITEM_NOT_FOUND', 404);
    let d = store.get<Delivery>('SELECT * FROM deliveries WHERE item_id=?', item.id);
    if (d?.part_id) d = store.get<Delivery>('SELECT * FROM deliveries WHERE id=?', d.part_id);
    ctx.body = {
      ...item,
      summaries: engine.summaries.list(item.id),
      summaryAllowed:
        engine.summaries.describe().enabled &&
        engine.summaries.describe().stamp === engine.summaries.stamp &&
        !item.expired &&
        ['youtube', 'rss', 'email'].includes(item.kind) &&
        store.all<{ id: string }>(
          "SELECT s.id FROM sources s JOIN source_items si ON si.source_id=s.id WHERE si.item_id=? AND s.enabled=1 AND s.deleted=0 AND s.summary_mode<>'off' AND s.summary_consent=?",
          item.id,
          engine.summaries.stamp,
        ).length > 0,
      delivery: d
        ? {
            id: d.id,
            mode: d.mode,
            batch_id: d.batch_id,
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
  router.post(['/api/settings/test-feishu', '/api/settings/test-push'], (ctx) => {
    if (ctx.path.endsWith('test-feishu') && config.pushChannel !== 'feishu')
      throw new AppError('INVALID_PUSH_CHANNEL');
    if (!engine.pushReady)
      throw new AppError(
        config.pushChannel === 'weixin' ? 'PUSH_NOT_READY' : 'FEISHU_NOT_ENABLED',
        503,
      );
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
  router.post('/api/weixin/pair', async (ctx) => {
    const body = ctx.request.body as { confirmed?: boolean; replace?: boolean };
    if (
      body.confirmed !== true ||
      (body.replace !== undefined && typeof body.replace !== 'boolean')
    )
      throw new AppError('WEIXIN_PAIR_CONFIRMATION_REQUIRED');
    const recent = store.get<{ n: number }>(
      "SELECT count(*) n FROM events WHERE action='weixin_pair_started' AND at>?",
      store.now() - 60000,
    )!.n;
    if (recent >= 3) throw new AppError('WEIXIN_PAIR_RATE_LIMITED', 429);
    ctx.body = await engine.weixin.begin(body.replace === true);
  });
  router.post('/api/weixin/pair/status', async (ctx) => {
    const body = ctx.request.body as { id?: unknown; code?: unknown };
    if (typeof body.id !== 'string' || (body.code !== undefined && typeof body.code !== 'string'))
      throw new AppError('WEIXIN_INVALID_PAIR_CODE');
    ctx.body = await engine.weixin.pollPair(body.id, body.code as string | undefined);
    engine.syncDestination();
  });
  router.post('/api/weixin/pair/cancel', (ctx) => {
    const body = ctx.request.body as { id?: unknown };
    if (typeof body.id !== 'string') throw new AppError('WEIXIN_PAIR_EXPIRED');
    engine.weixin.cancelPair(body.id);
    ctx.body = { ok: true };
  });
  router.post('/api/weixin/disconnect', (ctx) => {
    if ((ctx.request.body as { confirmed?: boolean }).confirmed !== true)
      throw new AppError('WEIXIN_PAIR_CONFIRMATION_REQUIRED');
    engine.weixin.disconnect();
    engine.syncDestination();
    ctx.body = { ok: true };
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
