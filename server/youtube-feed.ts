import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import sanitizeHtml from 'sanitize-html';
import { AppError, preview, type Config } from './config.js';
import { fetchFeed, type FeedResult } from './adapters.js';
import { captionProcess } from './captions.js';
import { channelId } from './youtube.js';

export function parseUploads(value: unknown, channel: string): FeedResult {
  const data = value as { channel?: string; entries?: Record<string, unknown>[] } | null;
  if (data?.channel !== channel || !Array.isArray(data.entries) || !data.entries.length || data.entries.length > 15)
    throw new AppError('YOUTUBE_UPLOADS_UNAVAILABLE', 502, true, 60_000);
  const ids = new Set<string>();
  const items = data.entries.map((entry) => {
    if (!entry || entry.channel !== channel || typeof entry.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{11}$/.test(entry.id) || ids.has(entry.id) ||
        typeof entry.title !== 'string' || !entry.title.trim() ||
        typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp) ||
        entry.timestamp <= 0 || entry.timestamp * 1000 > Date.now())
      throw new AppError('YOUTUBE_UPLOADS_UNAVAILABLE', 502, true, 60_000);
    ids.add(entry.id);
    return {
      key: `youtube:${entry.id}`, kind: 'youtube' as const,
      title: preview(entry.title, 300), author: preview(String(entry.author || ''), 200),
      text: preview(sanitizeHtml(String(entry.description || ''), {
        allowedTags: [], allowedAttributes: {},
      }), 20_000),
      url: `https://www.youtube.com/watch?v=${entry.id}`,
      published: entry.timestamp * 1000,
    };
  });
  return { unchanged: false, items, etag: '', modified: '', fallback: true };
}

export function createYoutubeFeed(
  config: Config,
  request: typeof fetch,
  signal: AbortSignal,
  runProcess = captionProcess,
): typeof fetchFeed {
  const helper = resolve('scripts/youtube-uploads.py');
  return async (channel, cache = {}) => {
    channel = channelId(channel);
    try {
      return await fetchFeed(channel, cache, request);
    } catch (error) {
      if (!(error instanceof AppError) ||
          !(error.code === 'YOUTUBE_FEED_NOT_READY' || /^YOUTUBE_HTTP_5\d\d$/.test(error.code)) ||
          config.demo || !existsSync(config.captions.python) || !existsSync(helper)) throw error;
      try {
        const data = await runProcess(config.captions.python, helper, {
          channel, proxy: config.youtubeProxy, node: process.execPath,
        }, signal, 120_000);
        return parseUploads(data, channel);
      } catch {
        if (signal.aborted) throw new AppError('YOUTUBE_CANCELLED');
        throw new AppError('YOUTUBE_UPLOADS_UNAVAILABLE', 502, true, 60_000);
      }
    }
  };
}
