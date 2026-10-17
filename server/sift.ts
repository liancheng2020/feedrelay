import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError, type Config } from './config.js';

export const MODEL_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export interface Brief {
  oneLiner: string;
  points: { title: string; text: string; quote: string; locator: string; url?: string }[];
}
export interface SummaryInput {
  title: string;
  text: string;
  scope: string;
  captions?: boolean;
}
export interface SiftAdapter {
  stamp: string;
  available: boolean;
  unavailableReason?: string;
  model: string;
  inputPrice: number;
  outputPrice: number;
  run: (input: SummaryInput, request: typeof fetch, signal: AbortSignal) => Promise<unknown>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const contentHash = (input: SummaryInput) => digest(JSON.stringify(input));
export const normalizeQuote = (s: string) => s.normalize('NFC').replace(/\s+/gu, ' ').trim();
export const summaryLimits = (captions = false) =>
  captions
    ? { maxCalls: 12, timeoutMs: 240000, chunkLength: 12000 }
    : { maxCalls: 2, timeoutMs: 60000, chunkLength: 20000 };
const object = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('SUMMARY_INVALID_OUTPUT');
  return value as Record<string, unknown>;
};
const textField = (value: unknown, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new AppError('SUMMARY_INVALID_OUTPUT');
  return value;
};

// Sift checks its full schema; this boundary accepts only the small grounded subset we display.
export function validateBrief(value: unknown, input: string): Brief {
  const summary = object(object(value).summary);
  const line = textField(object(summary.overview).oneLiner, 240);
  if (
    typeof line !== 'string' ||
    !line.trim() ||
    line.length > 240 ||
    !Array.isArray(summary.keyPoints) ||
    summary.keyPoints.length < 1 ||
    summary.keyPoints.length > 3
  )
    throw new AppError('SUMMARY_INVALID_OUTPUT');
  const points = summary.keyPoints.map((value: unknown) => {
    const p = object(value),
      evidence = object(p.evidence);
    const title = textField(p.title, 100),
      text = textField(p.summary, 400),
      quote = textField(evidence.quote, 160),
      locator = textField(evidence.locator, 80);
    if (!normalizeQuote(input).includes(normalizeQuote(quote)))
      throw new AppError('SUMMARY_UNSUPPORTED_QUOTE');
    return { title, text, quote, locator };
  });
  return { oneLiner: line, points };
}

export function createSiftAdapter(config: Config): SiftAdapter {
  const { dir, model, inputPrice, outputPrice } = config.sift;
  const identity = () =>
    digest(
      ['summarize.js', 'source.js', 'content.js', 'errors.js']
        .map((file) => readFileSync(join(dir, 'lib', file), 'utf8'))
        .join('\n'),
    );
  let revision = '',
    unavailableReason = '';
  if (!config.demo && config.sift.enabled) {
    try {
      revision = identity();
    } catch {
      unavailableReason = 'SIFT_MODULE_UNAVAILABLE';
    }
  }
  return {
    available: config.demo || (config.sift.enabled && !!revision),
    unavailableReason,
    model: config.demo ? 'demo-sift' : model,
    inputPrice: config.demo ? 1 : inputPrice,
    outputPrice: config.demo ? 2 : outputPrice,
    stamp: digest(
      JSON.stringify({
        revision,
        model,
        mode: 'concise',
        version: 'feedrelay-brief-1',
        demo: config.demo,
        inputPrice,
        outputPrice,
      }),
    ),
    async run(input, request, signal) {
      if (config.demo) {
        await request(MODEL_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify({
            model: 'demo-sift',
            messages: [{ role: 'user', content: input.text }],
            max_tokens: 2600,
          }),
          signal,
        });
        const first = input.text
          .trim()
          .split(/\n/u)
          .find((s) => s.trim())!;
        const marker = input.captions ? first.match(/^\[([\d:]+)\]\s*/) : null;
        const quote = first.slice(marker?.[0].length || 0).slice(0, 120);
        return {
          summary: {
            overview: { oneLiner: '模拟摘要：仅展示提供内容中的信息。' },
            keyPoints: [
              {
                title: '原文要点（模拟）',
                summary: quote,
                evidence: { quote, locator: marker ? `[${marker[1]}]` : '原文首段' },
              },
            ],
          },
        };
      }
      if (identity() !== revision) throw new AppError('SIFT_MODULE_CHANGED_RESTART');
      const mod = await import(pathToFileURL(join(dir, 'lib/summarize.js')).href);
      if (
        typeof mod.summarizeContentDetailed !== 'function' ||
        typeof mod.PROMPT_VERSION !== 'string'
      )
        throw new AppError('SIFT_MODULE_INCOMPATIBLE');
      return mod.summarizeContentDetailed(
        { text: input.text, title: input.title, sourceType: input.scope, summaryMode: 'concise' },
        {
          env: {
            AI_PROVIDER: 'deepseek',
            DEEPSEEK_API_KEY: config.sift.apiKey,
            DEEPSEEK_MODEL: model,
            DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
          },
          fetchImpl: request,
          signal,
          ...summaryLimits(input.captions),
          repairs: 1,
        },
      );
    },
  };
}

export const demoModelFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50 } }), {
    headers: { 'Content-Type': 'application/json' },
  });

export async function boundedModelFetch(
  request: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) {
  const response = await request(input, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([
      init?.signal || new AbortController().signal,
      AbortSignal.timeout(25000),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      response.status === 429
        ? 'MODEL_RATE_LIMITED'
        : response.status === 401 || response.status === 403
          ? 'MODEL_AUTH_FAILED'
          : 'MODEL_SERVICE_FAILED',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('MODEL_RESPONSE_INVALID');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256000) throw new AppError('MODEL_RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
