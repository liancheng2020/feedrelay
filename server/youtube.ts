import { Parser } from 'htmlparser2';
import { Agent, ProxyAgent } from 'undici';
import { AppError } from './config.js';

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const DEMO_CHANNEL = 'UC' + 'd'.repeat(22);

// Normalize user input only; callers cannot turn it into an arbitrary fetch URL.
export function channelInput(input: string) {
  let value = input.trim();
  if (value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value))
    throw new AppError('INVALID_CHANNEL');
  if (value.startsWith('https://')) {
    try {
      const url = new URL(value);
      if (
        !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port ||
        url.hash ||
        [...url.searchParams].some(
          ([key, text]) =>
            !['si', 'feature', 'sub_confirmation'].includes(key) || text.length > 200,
        )
      )
        throw new Error();
      const path = decodeURIComponent(url.pathname).replace(/\/$/u, '');
      const channel = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})$/u);
      if (channel) return channel[1];
      const handle = path.match(
        /^\/(@[^/]+)(?:\/(?:videos|shorts|streams|featured|about|playlists|community))?$/u,
      );
      if (!handle) throw new Error();
      value = handle[1];
    } catch {
      throw new AppError('INVALID_CHANNEL');
    }
  }
  if (CHANNEL_ID.test(value)) return value;
  value = value.normalize('NFC');
  if (!/^@[\p{L}\p{N}][\p{L}\p{M}\p{N}_.·-]{0,99}$/u.test(value))
    throw new AppError('INVALID_CHANNEL');
  return value;
}

export function channelId(input: string) {
  const value = channelInput(input);
  if (!CHANNEL_ID.test(value)) throw new AppError('CHANNEL_ID_REQUIRED');
  return value;
}

function channelMetadata() {
  const ids = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    try {
      ids.add(channelId(value));
    } catch {}
  };
  const parser = new Parser({
    onopentag(name, attrs) {
      // YouTube may put document metadata after <body>; never scan generic channelId fields.
      if (name === 'link' && attrs.rel === 'canonical') add(attrs.href);
      if (name === 'meta' && attrs.property === 'og:url') add(attrs.content);
    },
  });
  return {
    parser,
    result() {
      if (ids.size !== 1) throw new AppError('CHANNEL_RESOLUTION_FAILED', 502);
      return [...ids][0];
    },
  };
}

export function channelFromHtml(html: string) {
  const metadata = channelMetadata();
  metadata.parser.end(html);
  return metadata.result();
}

export async function resolveChannel(input: string, request: typeof fetch = fetch) {
  const value = channelInput(input);
  if (CHANNEL_ID.test(value)) return value;
  try {
    const response = await request(
      `https://www.youtube.com/@${encodeURIComponent(value.slice(1))}`,
      {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'FeedRelay/0.3', Accept: 'text/html' },
      },
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new AppError(
        response.status === 404
          ? 'CHANNEL_NOT_FOUND'
          : response.status === 429
            ? 'YOUTUBE_RATE_LIMITED'
            : 'YOUTUBE_ACCESS_BLOCKED',
        502,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AppError('CHANNEL_RESOLUTION_FAILED', 502);
    const metadata = channelMetadata(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4_000_000) throw new AppError('CHANNEL_RESPONSE_TOO_LARGE', 502);
        metadata.parser.write(decoder.decode(part.value, { stream: true }));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    metadata.parser.end(decoder.decode());
    return metadata.result();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('YOUTUBE_NETWORK_ERROR', 502);
  }
}

export async function resolveDemoChannel(input: string) {
  const value = channelInput(input);
  if (value.toLowerCase() === '@feedrelay-demo') return DEMO_CHANNEL;
  if (value.startsWith('@')) throw new AppError('DEMO_CHANNEL_HANDLE');
  return value;
}

export function youtubeTransport(proxy: string) {
  // Explicit dispatcher avoids inheriting browser/system proxy settings or affecting other services.
  const agent = proxy
    ? new ProxyAgent({ uri: proxy, connections: 2 })
    : new Agent({ connections: 2 });
  const request: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (
      url.origin !== 'https://www.youtube.com' ||
      url.username ||
      url.password ||
      (init?.method && init.method !== 'GET')
    )
      throw new AppError('YOUTUBE_REQUEST_BLOCKED');
    return fetch(input, { ...init, dispatcher: agent } as RequestInit);
  };
  return { request, close: () => agent.destroy() };
}
