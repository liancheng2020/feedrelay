import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isolatedPythonEnvironment, terminateProcessTree } from './process-platform.js';
import { AppError, type Config } from './config.js';
import { contentHash, normalizeQuote, type Brief } from './deepseek.js';

export const CAPTION_SCOPE = 'YouTube 字幕（不含画面，时间定位仅供参考）';
export const ASR_SCOPE = 'YouTube 全程音频转写（不含画面，可能误识别）';
export const MAX_CAPTION_TEXT = 48000;
const revision = 'youtube-captions-2';
export interface Caption {
  videoId: string;
  language: string;
  kind: 'manual' | 'automatic' | 'transcribed';
  model?: string;
  duration: number;
  text: string;
  hash: string;
}
export interface CaptionAdapter {
  available: boolean;
  asrAvailable?: boolean;
  stamp: string;
  fetch: (
    id: string,
    signal: AbortSignal,
    progress?: (stage: string, percent: number) => void,
  ) => Promise<Caption>;
}
export const timeLabel = (seconds: number) => {
  const parts = [Math.floor(seconds / 60), seconds % 60];
  if (parts[0] >= 60) parts.splice(0, 1, Math.floor(parts[0] / 60), parts[0] % 60);
  return parts.map((n) => String(n).padStart(2, '0')).join(':');
};
const captionHash = (c: Omit<Caption, 'hash'>) =>
  contentHash({
    title: `${c.videoId}:${c.language}:${c.kind}:${c.duration}`,
    text: c.text,
    scope: c.kind === 'transcribed' ? `${revision}:asr:${c.model}` : revision,
  });

export function parseCaption(value: unknown, id: string): Caption {
  const data = value as Record<string, any>;
  if (
    !data ||
    data.videoId !== id ||
    !/^[a-zA-Z0-9_-]{11}$/.test(id) ||
    !/^[a-zA-Z0-9-]{1,24}$/.test(data.language) ||
    !['manual', 'automatic', 'transcribed'].includes(data.kind) ||
    (data.kind === 'transcribed' &&
      (typeof data.model !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(data.model))) ||
    !Number.isFinite(data.duration) ||
    data.duration <= 0 ||
    !Array.isArray(data.cues) ||
    data.cues.length > 20000
  )
    throw new AppError('YOUTUBE_INVALID_CAPTION');
  if (data.duration > 14400) throw new AppError('YOUTUBE_VIDEO_TOO_LONG');
  if (data.kind === 'transcribed' && data.duration > 3600)
    throw new AppError('YOUTUBE_ASR_VIDEO_TOO_LONG');
  const units: { second: number; end: number; parts: string[]; length: number }[] = [];
  let previous = '',
    lastStart = -1,
    lastEnd = -1,
    size = 0;
  for (const cue of data.cues) {
    if (!cue || typeof cue.text !== 'string') throw new AppError('YOUTUBE_INVALID_CAPTION');
    let text = normalizeQuote(cue.text.replace(/[\u0000-\u001f]/gu, ' '));
    if (!text) continue;
    if (
      !Number.isFinite(cue.start) ||
      !Number.isFinite(cue.duration) ||
      cue.start < lastStart ||
      cue.start < 0 ||
      cue.duration < 0 ||
      cue.start > data.duration * 1000 + 2000
    )
      throw new AppError('YOUTUBE_INVALID_CAPTION');
    const original = text;
    // Remove exact rolling-prefix overlap only for adjacent automatic-caption cues.
    if (data.kind === 'automatic' && cue.start <= lastEnd + 500 && cue.start - lastStart <= 5000) {
      if (previous && text.startsWith(previous)) text = text.slice(previous.length).trim();
    }
    previous = original;
    lastStart = cue.start;
    lastEnd = cue.start + cue.duration;
    if (!text) continue;
    size += text.length;
    if (size > MAX_CAPTION_TEXT) throw new AppError('YOUTUBE_CAPTION_TOO_LONG');
    const second = Math.floor(cue.start / 1000);
    const unit = units.at(-1);
    // Automatic cues often split a sentence every 1-2 seconds. Keep short, contiguous
    // passages together so literal evidence can cover a sentence without losing its start time.
    if (
      unit &&
      second - unit.second < 20 &&
      cue.start <= unit.end + 5000 &&
      unit.length + text.length + 1 <= 600
    ) {
      unit.parts.push(text);
      unit.length += text.length + 1;
      unit.end = Math.max(unit.end, cue.start + cue.duration);
    } else
      units.push({ second, end: cue.start + cue.duration, parts: [text], length: text.length });
  }
  const text = units
    .map(({ second, parts }) => `[${timeLabel(second)}] ${parts.join(' ')}`)
    .join('\n\n');
  if (!text.trim()) throw new AppError('YOUTUBE_EMPTY_CAPTION');
  if (text.length > MAX_CAPTION_TEXT) throw new AppError('YOUTUBE_CAPTION_TOO_LONG');
  const caption = {
    videoId: id,
    language: data.language as string,
    kind: data.kind as Caption['kind'],
    ...(data.kind === 'transcribed' ? { model: data.model as string } : {}),
    duration: data.duration as number,
    text,
  };
  return { ...caption, hash: captionHash(caption) };
}

export function captionEvidence(result: Brief, caption: Caption) {
  if (caption.hash !== captionHash(caption)) throw new AppError('YOUTUBE_CAPTION_CACHE_INVALID');
  const units = new Map(
    [...caption.text.matchAll(/^\[([\d:]+)\] (.*)$/gm)].map((m) => [`[${m[1]}]`, m[2]]),
  );
  for (const point of result.points) {
    if (
      !units.has(point.locator) ||
      !normalizeQuote(units.get(point.locator)!).includes(normalizeQuote(point.quote))
    )
      throw new AppError('SUMMARY_UNSUPPORTED_QUOTE');
    const seconds = point.locator
      .slice(1, -1)
      .split(':')
      .reduce((n, part) => n * 60 + Number(part), 0);
    point.url = `https://www.youtube.com/watch?v=${caption.videoId}&t=${seconds}s`;
  }
  return result;
}

// No shell, inherited secrets, cookies or disk subtitle files. Cancellation includes EJS children.
export async function captionProcess(
  python: string,
  helper: string,
  input: object,
  signal: AbortSignal,
  timeout = 45000,
  progress?: (stage: string, percent: number) => void,
) {
  const home = await mkdtemp(join(tmpdir(), 'feedrelay-captions-'));
  try {
    if (signal.aborted) throw new AppError('YOUTUBE_CANCELLED');
    return await new Promise<unknown>((resolveResult, reject) => {
      const child = spawn(python, ['-I', helper], {
        cwd: home,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: isolatedPythonEnvironment(home, python),
      });
      let out = '',
        size = 0,
        failure = '';
      const stop = (code: string) => {
        if (failure) return;
        failure ||= code;
        terminateProcessTree(child);
      };
      const abort = () => stop('YOUTUBE_CANCELLED');
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(() => stop('YOUTUBE_TIMEOUT'), timeout);
      child.stdout.setEncoding('utf8');
      let progressBuffer = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        progressBuffer = (progressBuffer + chunk).slice(-4096);
        let newline: number;
        while ((newline = progressBuffer.indexOf('\n')) >= 0) {
          const line = progressBuffer.slice(0, newline);
          progressBuffer = progressBuffer.slice(newline + 1);
          try {
            const p = JSON.parse(line);
            if (['downloading', 'transcribing'].includes(p.stage) && Number.isFinite(p.percent))
              progress?.(p.stage, Math.max(0, Math.min(100, p.percent)));
          } catch {
            /* Ignore library diagnostics; never forward raw stderr. */
          }
        }
      });
      child.stdout.on('data', (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 2_000_000) stop('YOUTUBE_CAPTION_TOO_LARGE');
        else out += chunk;
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
      child.on('error', () => {
        failure = 'YOUTUBE_RUNTIME_UNAVAILABLE';
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (failure || code !== 0)
          return reject(new AppError(failure || 'YOUTUBE_EXTRACTION_FAILED'));
        try {
          const data = JSON.parse(out);
          if (data.error)
            throw new AppError(
              /^YOUTUBE_[A-Z_]+$/.test(data.error) ? data.error : 'YOUTUBE_EXTRACTION_FAILED',
            );
          resolveResult(data);
        } catch (error) {
          reject(error instanceof AppError ? error : new AppError('YOUTUBE_INVALID_CAPTION'));
        }
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export function createCaptionAdapter(config: Config, runProcess = captionProcess): CaptionAdapter {
  const helper = resolve('scripts/youtube-captions.py');
  const { enabled, python, proxy, asr, model } = config.captions;
  const asrHelper = resolve('scripts/youtube-transcribe.py');
  const asrAvailable =
    enabled &&
    asr &&
    existsSync(python) &&
    existsSync(join(model, 'model.bin')) &&
    existsSync(join(model, 'config.json')) &&
    existsSync(asrHelper);
  const available = config.demo || (enabled && existsSync(python) && existsSync(helper));
  const helperSource = existsSync(helper) ? readFileSync(helper, 'utf8') : '';
  const asrSource = asrAvailable ? readFileSync(asrHelper, 'utf8') : '';
  const stamp = contentHash({
    title: revision,
    text: config.demo
      ? 'demo'
      : JSON.stringify({
          enabled,
          available,
          python,
          proxy,
          helper: helperSource,
          ...(asr
            ? {
                asr,
                model,
                asrAvailable,
                asrSource,
                modelConfig: asrAvailable ? readFileSync(join(model, 'config.json'), 'utf8') : '',
                modelVersion: asrAvailable
                  ? [
                      statSync(join(model, 'model.bin')).size,
                      statSync(join(model, 'model.bin')).mtimeMs,
                    ]
                  : [],
              }
            : {}),
        }),
    scope: 'captions',
  });
  return {
    available,
    asrAvailable,
    stamp,
    async fetch(id, signal, progress) {
      if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) throw new AppError('YOUTUBE_INVALID_VIDEO_ID');
      if (config.demo)
        return parseCaption(
          {
            videoId: id,
            language: 'zh',
            kind: 'manual',
            duration: 120,
            cues: [
              { start: 10000, duration: 3000, text: '合成字幕：工具结果需要可回查的证据。' },
              { start: 60000, duration: 5000, text: '合成字幕：重要的业务动作需要人工确认。' },
            ],
          },
          id,
        );
      if (!enabled || !existsSync(python)) throw new AppError('YOUTUBE_RUNTIME_UNAVAILABLE');
      if (readFileSync(helper, 'utf8') !== helperSource)
        throw new AppError('YOUTUBE_COMPONENT_CHANGED_RESTART');
      try {
        return parseCaption(
          await runProcess(python, helper, { id, proxy, node: process.execPath }, signal),
          id,
        );
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !['YOUTUBE_NO_CAPTIONS', 'YOUTUBE_EMPTY_CAPTION'].includes(error.code) ||
          !asr
        )
          throw error;
        if (!asrAvailable) throw new AppError('YOUTUBE_ASR_NOT_READY');
        if (readFileSync(asrHelper, 'utf8') !== asrSource)
          throw new AppError('YOUTUBE_COMPONENT_CHANGED_RESTART');
        return parseCaption(
          await runProcess(
            python,
            asrHelper,
            { id, proxy, node: process.execPath, model },
            signal,
            1800000,
            progress,
          ),
          id,
        );
      }
    },
  };
}
