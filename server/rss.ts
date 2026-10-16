import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import Parser from 'rss-parser';
import sanitizeHtml from 'sanitize-html';
import { AppError, preview } from './config.js';
import type { Incoming } from './store.js';

export function feedUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError('INVALID_FEED_URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.href.length > 2048 ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    !url.hostname.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(url.hostname)
  )
    throw new AppError('PUBLIC_HTTPS_FEED_REQUIRED');
  return url.href;
}
export async function publicAddresses(host: string, resolve = lookup) {
  const addresses = await resolve(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(
      (a) => !ipaddr.isValid(a.address) || ipaddr.process(a.address).range() !== 'unicast',
    )
  )
    throw new AppError('RSS_PRIVATE_ADDRESS');
  return addresses;
}
// The socket uses these checked addresses, not a second DNS lookup (rebinding protection).
export function createPublicLookup(resolve = lookup): LookupFunction {
  return (host, options, callback) => {
    void publicAddresses(host, resolve).then(
      (addresses) => {
        const selected = options.family
          ? addresses.filter((a) => a.family === options.family)
          : addresses;
        if (!selected.length) return callback(new AppError('RSS_DNS_UNAVAILABLE'), '', 4);
        if (options.all) callback(null, selected);
        else callback(null, selected[0].address, selected[0].family);
      },
      (error) => callback(error, '', 4),
    );
  };
}
export const publicLookup = createPublicLookup();
interface FeedResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}
export function readPublicFeed(
  url: string,
  cache: { etag?: string; modified?: string } = {},
): Promise<FeedResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      feedUrl(url),
      {
        method: 'GET',
        rejectUnauthorized: true,
        agent: false,
        lookup: publicLookup,
        maxHeaderSize: 16_384,
        signal: AbortSignal.timeout(15_000),
        headers: {
          'User-Agent': 'FeedRelay/0.2',
          'Accept-Encoding': 'identity',
          ...(cache.etag ? { 'If-None-Match': cache.etag } : {}),
          ...(cache.modified ? { 'If-Modified-Since': cache.modified } : {}),
        },
      },
      (res) => {
        const headers = Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v || '']),
        );
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
          res.destroy();
          reject(new AppError('RSS_ENCODING_UNSUPPORTED'));
          return;
        }
        const charset = headers['content-type']?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
        if (charset && !/^(?:utf-?8|us-ascii)$/i.test(charset)) {
          res.destroy();
          reject(new AppError('RSS_ENCODING_UNSUPPORTED'));
          return;
        }
        if (Number(headers['content-length']) > 2_000_000) {
          res.destroy();
          reject(new AppError('RSS_RESPONSE_TOO_LARGE'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2_000_000) res.destroy(new AppError('RSS_RESPONSE_TOO_LARGE'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
function entryLink(value: string, base: string) {
  try {
    const link = new URL(value, base),
      check = new URL(link.href);
    check.search = '';
    check.hash = '';
    feedUrl(check.href);
    return link.href.length <= 2048 ? link.href : '';
  } catch {
    return '';
  }
}
export async function parseRss(xml: string, url: string): Promise<Incoming[]> {
  if (Buffer.byteLength(xml) > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new AppError('UNSAFE_FEED');
  const encoding = xml.slice(0, 200).match(/<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i)?.[1];
  if (encoding && !/^(?:utf-?8|us-ascii)$/i.test(encoding))
    throw new AppError('RSS_ENCODING_UNSUPPORTED');
  const parser = new Parser();
  let feed;
  try {
    feed = await parser.parseString(xml);
  } catch {
    throw new AppError('INVALID_FEED', 502, true);
  }
  if (feed.items.length > 1000) throw new AppError('RSS_TOO_MANY_ENTRIES');
  return feed.items.map((item) => {
    const link = item.link ? entryLink(item.link, url) : '';
    const identity = [item.guid, item.id, link]
      .find((value) => typeof value === 'string' && value.trim())
      ?.trim();
    if (!identity || identity.length > 4096) throw new AppError('RSS_ENTRY_ID_REQUIRED');
    const published = Date.parse(item.isoDate || item.pubDate || '');
    return {
      key: 'rss:' + createHash('sha256').update(`${url}\0${identity}`).digest('hex'),
      kind: 'rss',
      title: preview(item.title || '无标题条目', 300),
      author: preview(feed.title || new URL(url).hostname, 200),
      url: link,
      text: preview(
        sanitizeHtml(item.content || item.contentSnippet || item.summary || '', {
          allowedTags: [],
          allowedAttributes: {},
        }),
        20_000,
      ),
      published: Number.isFinite(published) ? published : null,
    };
  });
}
export async function fetchRss(
  input: string,
  cache: { etag?: string; modified?: string } = {},
  get = readPublicFeed,
) {
  let url = feedUrl(input);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await get(url, cache);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === 3 || !response.headers.location) throw new AppError('RSS_REDIRECT_LIMIT');
        url = feedUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.status === 304) return { unchanged: true, items: [] as Incoming[], ...cache };
      if (response.status !== 200)
        throw new AppError(
          `RSS_HTTP_${response.status}`,
          502,
          response.status === 429 || response.status >= 500,
        );
      return {
        unchanged: false,
        items: await parseRss(response.text, feedUrl(input)),
        etag: response.headers.etag || '',
        modified: response.headers['last-modified'] || '',
      };
    }
    throw new AppError('RSS_REDIRECT_LIMIT');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('RSS_NETWORK_ERROR', 502, true);
  }
}
