import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, incoming } from './helpers.js';
import { AppError } from '../server/config.js';
import {
  ASR_SCOPE,
  captionEvidence,
  createCaptionAdapter,
  parseCaption,
} from '../server/captions.js';

const raw = {
  videoId: 'abcdefghijk',
  language: 'zh',
  kind: 'transcribed',
  model: 'faster-whisper-test',
  duration: 120,
  cues: [{ start: 10000, duration: 3000, text: '合成转写全文中的证据。' }],
};

test('ASR-01: only missing/empty captions trigger enabled local fallback; network/auth failures do not download audio', async (t) => {
  const f = fixture(t),
    model = join(f.dir, 'model');
  mkdirSync(model);
  writeFileSync(join(model, 'model.bin'), 'synthetic');
  writeFileSync(join(model, 'config.json'), '{}');
  const config = {
    ...f.config,
    demo: false,
    captions: { ...f.config.captions, enabled: true, asr: true, model, python: process.execPath },
  };
  let error = 'YOUTUBE_NO_CAPTIONS';
  const helpers: string[] = [];
  const adapter = createCaptionAdapter(
    config,
    async (_python, helper, _input, _signal, timeout, progress) => {
      helpers.push(helper);
      if (helper.endsWith('youtube-captions.py')) throw new AppError(error);
      assert.equal(timeout, 1800000);
      progress?.('transcribing', 50);
      return raw;
    },
  );
  const events: string[] = [];
  assert.equal(
    (await adapter.fetch(raw.videoId, new AbortController().signal, (stage) => events.push(stage)))
      .kind,
    'transcribed',
  );
  assert.deepEqual(events, ['transcribing']);
  assert.equal(helpers.length, 2);
  for (const code of ['YOUTUBE_NETWORK_ERROR', 'YOUTUBE_ACCESS_BLOCKED']) {
    error = code;
    const before: number = helpers.length;
    await assert.rejects(
      adapter.fetch(raw.videoId, new AbortController().signal),
      new RegExp(code),
    );
    assert.equal(helpers.length, before + 1);
  }
  const disabled = createCaptionAdapter(
    { ...config, captions: { ...config.captions, asr: false } },
    async () => {
      throw new AppError('YOUTUBE_NO_CAPTIONS');
    },
  );
  await assert.rejects(
    disabled.fetch(raw.videoId, new AbortController().signal),
    /YOUTUBE_NO_CAPTIONS/,
  );
  const caption = parseCaption(raw, raw.videoId);
  assert.throws(
    () => captionEvidence({ oneLiner: '', points: [] }, { ...caption, model: 'changed' }),
    /CACHE_INVALID/,
  );
});

test('ASR-02: full local transcript, progress, model ledger and cached retry reuse the existing summary/push pipeline', async (t) => {
  const f = fixture(t),
    source = f.source('youtube', false),
    s = f.engine.summaries;
  const item = f.store.put(incoming(), [source], false, f.engine.destination);
  s.captions!.asrAvailable = true;
  s.configure({ enabled: true, maxCalls: 3, maxCostCny: 1, confirmed: true });
  let downloads = 0;
  s.captions!.fetch = async (_id, _signal, progress) => {
    downloads++;
    progress?.('downloading', 90);
    assert.equal(s.list(item.id)[0].progress.stage, 'downloading');
    progress?.('transcribing', 50);
    return parseCaption(raw, raw.videoId);
  };
  let first = true;
  const generate = s.adapter.run;
  s.adapter.run = async (...args) => {
    assert.equal(args[0].scope, ASR_SCOPE);
    assert.equal(s.list(item.id)[0].progress.stage, 'summarizing');
    if (first) {
      first = false;
      throw new AppError('MODEL_SERVICE_FAILED');
    }
    return generate(...args);
  };
  s.request(item.id, 'captions');
  await s.cycle(f.engine.destination);
  assert.equal(s.transcript(item.id)!.kind, 'transcribed');
  assert.equal(s.list(item.id)[0].status, 'failed');
  s.request(item.id, 'captions', true);
  await s.cycle(f.engine.destination);
  assert.equal(downloads, 1);
  const row = s.list(item.id)[0];
  assert.equal(row.status, 'succeeded', row.error);
  assert.equal(row.scope, ASR_SCOPE);
  assert.equal(row.progress, null);
  assert.equal(s.describe().calls, 1);
  const output = s.pushLatest(item.id, row.id, row.revision);
  const snapshot = f.store.get('SELECT snapshot FROM deliveries WHERE id=?', output.id)!
    .snapshot as string;
  assert(snapshot.startsWith('测试标题（模拟摘要）\n\n1. '));
  assert(!snapshot.includes('原文引用：'));
  assert(!snapshot.includes('仅供参考'));
  assert.equal(s.describe().calls, 1);
  assert.equal(
    f.store.get("SELECT count(*) n FROM meta WHERE key LIKE 'summary-progress:%'")!.n,
    0,
  );
});

test('ASR-03: Python audio-only adapter enforces bounds, consumes all segments and cleans temporary files', (t) => {
  const run = spawnSync('python3', ['test/youtube-transcribe.test.py'], { encoding: 'utf8' });
  if (run.error) return t.skip('local Python unavailable');
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('ASR-04: shutdown aborts local transcription without model calls or orphaned progress', async (t) => {
  const f = fixture(t),
    source = f.source('youtube', false),
    s = f.engine.summaries;
  const item = f.store.put(incoming(), [source], false, f.engine.destination);
  s.captions!.asrAvailable = true;
  s.configure({ enabled: true, maxCalls: 2, maxCostCny: 1, confirmed: true });
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  s.captions!.fetch = async (_id, signal, progress) => {
    progress?.('transcribing', 10);
    started();
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new AppError('YOUTUBE_CANCELLED')), {
        once: true,
      }),
    );
    return parseCaption(raw, raw.videoId);
  };
  s.request(item.id, 'captions');
  const running = s.cycle(f.engine.destination);
  await ready;
  s.cancel();
  await running;
  assert.equal(s.list(item.id)[0].status, 'failed');
  assert.equal(s.describe().calls, 0);
  assert.equal(
    f.store.get("SELECT count(*) n FROM meta WHERE key LIKE 'summary-progress:%'")!.n,
    0,
  );
});
