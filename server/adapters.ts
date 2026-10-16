import Parser from 'rss-parser';
import { ImapFlow, type MessageStructureObject, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import { createHash } from 'node:crypto';
import { AppError, preview, type Config } from './config.js';
import type { Incoming, Source } from './store.js';
import { feedUrl } from './rss.js';

export function channelId(input: string) {
  let id = input.trim();
  if (id.startsWith('https://')) {
    const url = new URL(id);
    if (
      !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      throw new AppError('INVALID_CHANNEL');
    id = url.pathname.replace(/^\/channel\//, '').replace(/\/$/, '');
  }
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(id))
    throw new AppError(id.includes('@') ? 'CHANNEL_HANDLE_NOT_SUPPORTED' : 'INVALID_CHANNEL');
  return id;
}
export function normalizeSource(input: Record<string, unknown>) {
  if (!['youtube', 'email', 'rss'].includes(String(input.type)))
    throw new AppError('INVALID_SOURCE_TYPE');
  const name = String(input.name || '').trim();
  if (!name || name.length > 100) throw new AppError('INVALID_SOURCE_NAME');
  const sender = String(input.sender || '')
      .trim()
      .toLowerCase(),
    subject = String(input.subject || '').trim();
  if (
    input.type === 'email' &&
    (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender) ||
      sender.length > 254 ||
      subject.length > 200)
  )
    throw new AppError('INVALID_MAIL_RULE');
  if (!['immediate', 'digest'].includes(String(input.delivery_mode || 'immediate')))
    throw new AppError('INVALID_DELIVERY_MODE');
  return {
    type: input.type as Source['type'],
    name,
    channel: input.type === 'youtube' ? channelId(String(input.channel || '')) : '',
    sender: input.type === 'email' ? sender : '',
    subject: input.type === 'email' ? subject : '',
    feed_url: input.type === 'rss' ? feedUrl(String(input.feed_url || '')) : '',
    delivery_mode: (input.delivery_mode || 'immediate') as Source['delivery_mode'],
  };
}
export function matches(
  source: Pick<Source, 'sender' | 'subject'>,
  sender: string,
  subject: string,
) {
  return (
    sender.toLowerCase() === source.sender &&
    subject.toLowerCase().includes(source.subject.toLowerCase())
  );
}
async function bounded(response: Response, limit: number) {
  if (Number(response.headers.get('content-length') || 0) > limit)
    throw new AppError('RESPONSE_TOO_LARGE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new AppError('RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
  } catch (e) {
    await response.body?.cancel().catch(() => {});
    throw e;
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function parseFeed(xml: string, channel: string): Promise<Incoming[]> {
  if (Buffer.byteLength(xml) > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new AppError('UNSAFE_FEED');
  const parser = new Parser<
    Record<string, unknown>,
    { videoId: string; channelId: string; description: string }
  >({
    customFields: {
      item: [
        ['yt:videoId', 'videoId'],
        ['yt:channelId', 'channelId'],
        ['media:group', 'media'],
      ],
    },
  });
  let feed;
  try {
    feed = await parser.parseString(xml);
  } catch {
    throw new AppError('INVALID_FEED', 502, true);
  }
  if (!Array.isArray(feed.items)) throw new AppError('INVALID_FEED', 502, true);
  return feed.items.map((item) => {
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.videoId || '') || item.channelId !== channel)
      throw new AppError('INVALID_FEED_ENTRY', 502, true);
    const media = (item as unknown as { media?: { 'media:description'?: string[] } }).media;
    return {
      key: `youtube:${item.videoId}`,
      kind: 'youtube',
      title: preview(item.title || '未命名视频', 300),
      author: preview(feed.title || '', 200),
      text: preview(
        sanitizeHtml(
          String(
            media?.['media:description']?.[0] || item.contentSnippet || item.description || '',
          ),
          { allowedTags: [], allowedAttributes: {} },
        ),
        20_000,
      ),
      url: `https://www.youtube.com/watch?v=${item.videoId}`,
      published: Number.isFinite(Date.parse(item.isoDate || item.pubDate || ''))
        ? Date.parse(item.isoDate || item.pubDate!)
        : null,
    };
  });
}
export async function fetchFeed(
  channel: string,
  cache: { etag?: string; modified?: string } = {},
  request = fetch,
) {
  let response;
  try {
    response = await request(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId(channel)}`,
      {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'User-Agent': 'FeedRelay/0.1',
          ...(cache.etag ? { 'If-None-Match': cache.etag } : {}),
          ...(cache.modified ? { 'If-Modified-Since': cache.modified } : {}),
        },
      },
    );
  } catch {
    throw new AppError('YOUTUBE_NETWORK_ERROR', 502, true);
  }
  if (response.status === 304) return { unchanged: true, items: [] as Incoming[], ...cache };
  if (!response.ok)
    throw new AppError(
      `YOUTUBE_HTTP_${response.status}`,
      502,
      response.status === 429 || response.status >= 500,
    );
  return {
    unchanged: false,
    items: await parseFeed(await bounded(response, 2_000_000), channel),
    etag: response.headers.get('etag') || '',
    modified: response.headers.get('last-modified') || '',
  };
}

export interface Envelope {
  uid: number;
  sender: string;
  subject: string;
  received: number;
  published: number | null;
}
export interface MailSession {
  epoch: string;
  upper: number;
  headers(from: number, to: number): Promise<Envelope[]>;
  body(uid: number): Promise<string>;
  close(): Promise<void>;
}
export async function cleanMailBody(text: string, html = false) {
  if (Buffer.byteLength(text) > 1_000_000) throw new AppError('MAIL_BODY_TOO_LARGE');
  const safe = html
    ? sanitizeHtml(text, {
        allowedTags: [
          'p',
          'div',
          'br',
          'h1',
          'h2',
          'h3',
          'ul',
          'ol',
          'li',
          'table',
          'tr',
          'td',
          'th',
          'strong',
          'em',
          'blockquote',
        ],
        allowedAttributes: {},
        nonTextTags: ['script', 'style', 'textarea', 'noscript', 'form', 'iframe'],
      })
    : text;
  const mail = await simpleParser(
    `Content-Type: text/${html ? 'html' : 'plain'}; charset=utf-8\r\n\r\n${safe}`,
    {
      skipImageLinks: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      maxHtmlLengthToParse: 1_000_000,
    },
  );
  if (!mail.text?.trim()) throw new AppError('MAIL_BODY_EMPTY');
  return mail.text.trim();
}
export function textPart(node: MessageStructureObject): MessageStructureObject | undefined {
  if (node.disposition?.toLowerCase() === 'attachment' || node.type === 'message/rfc822') return;
  if (node.type === 'text/plain' || node.type === 'text/html') return node;
  const candidates = (node.childNodes || [])
    .map(textPart)
    .filter((n): n is MessageStructureObject => !!n);
  return candidates.find((n) => n.type === 'text/plain') || candidates[0];
}
export async function connectMailbox(
  config: Config,
  factory = (options: ConstructorParameters<typeof ImapFlow>[0]) => new ImapFlow(options),
): Promise<MailSession> {
  if (!config.imap.enabled) throw new AppError('IMAP_NOT_ENABLED', 503);
  const client = factory({
    host: config.imap.host,
    port: 993,
    secure: true,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    socketTimeout: 20_000,
    maxLiteralSize: 1_100_000,
    maxResponseSize: 2_000_000,
    clientInfo: { name: 'FeedRelay', version: '0.1' },
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const box = await client.mailboxOpen(config.imap.folder, { readOnly: true });
    return {
      epoch: String(box.uidValidity),
      upper: Math.max(0, (box.uidNext || 1) - 1),
      async headers(from, to) {
        if (from > to) return [];
        const messages = await client.fetchAll(
          `${from}:${to}`,
          { uid: true, envelope: true, internalDate: true },
          { uid: true },
        );
        return messages
          .map((m) => ({
            uid: m.uid,
            sender: m.envelope?.from?.length === 1 ? m.envelope.from[0]?.address || '' : '',
            subject: m.envelope?.subject || '',
            received: new Date(m.internalDate || Date.now()).getTime(),
            published: m.envelope?.date ? new Date(m.envelope.date).getTime() || null : null,
          }))
          .filter((m) => m.uid >= from && m.uid <= to);
      },
      async body(uid) {
        const message = await client.fetchOne(
          String(uid),
          { uid: true, bodyStructure: true },
          { uid: true },
        );
        if (!message || !message.bodyStructure) throw new AppError('MAIL_NO_LONGER_AVAILABLE');
        const part = textPart(message.bodyStructure);
        if (!part || (part.size || 0) > 1_000_000)
          throw new AppError(part ? 'MAIL_BODY_TOO_LARGE' : 'MAIL_BODY_EMPTY');
        const download = await client.download(String(uid), part.part || 'TEXT', {
          uid: true,
          maxBytes: 1_000_001,
        });
        if (!download.content) throw new AppError('MAIL_NO_LONGER_AVAILABLE');
        let size = 0;
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of download.content) {
            size += chunk.length;
            if (size > 1_000_000) throw new AppError('MAIL_BODY_TOO_LARGE');
            chunks.push(chunk);
          }
        } finally {
          download.content.destroy();
        }
        return cleanMailBody(Buffer.concat(chunks).toString('utf8'), part.type === 'text/html');
      },
      async close() {
        await client.logout().catch(() => client.close());
      },
    };
  } catch (e) {
    client.close();
    if (e instanceof AppError) throw e;
    throw new AppError(
      (e as { authenticationFailed?: boolean }).authenticationFailed
        ? 'IMAP_AUTH_FAILED'
        : 'IMAP_CONNECTION_FAILED',
      502,
      !(e as { authenticationFailed?: boolean }).authenticationFailed,
    );
  }
}

export type SendResult = {
  status: 'sent' | 'failed' | 'unknown' | 'retry_wait';
  code?: string;
  retryAfter?: number;
};
export function destinationRef(config: Config) {
  return config.demo
    ? 'demo'
    : createHash('sha256').update(`${config.feishu.appId}:${config.feishu.openId}`).digest('hex');
}
export function feishuSender(config: Config, request = fetch, now = Date.now) {
  let token = '',
    expires = 0;
  return async (text: string, uuid: string): Promise<SendResult> => {
    if (config.demo) return { status: 'sent', code: 'DEMO_ACCEPTED' };
    if (!config.feishu.enabled) return { status: 'failed', code: 'FEISHU_NOT_ENABLED' };
    if (expires <= now()) {
      try {
        const response = await request(
          'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: config.feishu.appId, app_secret: config.feishu.secret }),
          },
        );
        const data = JSON.parse(await bounded(response, 32_000));
        if (
          !response.ok ||
          data.code !== 0 ||
          typeof data.tenant_access_token !== 'string' ||
          !Number.isFinite(data.expire)
        )
          return {
            status: response.status >= 500 || response.status === 429 ? 'retry_wait' : 'failed',
            code: 'FEISHU_AUTH_FAILED',
          };
        token = data.tenant_access_token;
        expires = now() + Math.max(0, data.expire - 60) * 1000;
      } catch {
        return { status: 'retry_wait', code: 'FEISHU_AUTH_UNAVAILABLE' };
      }
    }
    try {
      const response = await request(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            receive_id: config.feishu.openId,
            msg_type: 'text',
            content: JSON.stringify({ text: preview(text, 4000) }),
            uuid,
          }),
        },
      );
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        return {
          status: 'retry_wait',
          code: 'FEISHU_RATE_LIMIT',
          retryAfter:
            Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, seconds) * 1000 : 60_000,
        };
      }
      const data = JSON.parse(await bounded(response, 32_000));
      if (response.ok && data.code === 0) return { status: 'sent' };
      if (data.code === 99991400)
        return { status: 'retry_wait', code: 'FEISHU_RATE_LIMIT', retryAfter: 60_000 };
      if ([99991663, 99991664, 99991668].includes(data.code)) {
        expires = 0;
        return { status: 'retry_wait', code: 'FEISHU_TOKEN_EXPIRED' };
      }
      return {
        status: response.status >= 500 ? 'unknown' : 'failed',
        code: Number.isInteger(data.code) ? `FEISHU_${data.code}` : 'FEISHU_INVALID_RESPONSE',
      };
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      return {
        status: ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(
          code || '',
        )
          ? 'retry_wait'
          : 'unknown',
        code: 'FEISHU_SEND_UNCONFIRMED',
      };
    }
  };
}
