import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { summaryState } from '../web/summary-state.js';

test('RD-09: source unavailability is distinct from model failure and stale errors do not mask progress', () => {
  assert.equal(summaryState('failed', 'YOUTUBE_NO_CAPTIONS').label, '暂无可用字幕');
  assert.equal(summaryState('failed', 'YOUTUBE_EMPTY_CAPTION').tone, 'unavailable');
  assert.equal(summaryState('failed', 'YOUTUBE_NETWORK_ERROR').label, '字幕获取受阻');
  assert.equal(summaryState('failed', 'MODEL_AUTH_FAILED').label, '生成失败');
  assert.equal(summaryState('running', 'YOUTUBE_NO_CAPTIONS').captionIssue, false);
  assert.equal(summaryState('succeeded', '').label, '已生成');
});

test('RD-10: rendered detail hides YouTube promotion, preserves email body and shows retry without fake summary/push', async (t) => {
  const vite = await createServer({
    configFile: false,
    root: resolve('web'),
    plugins: [vue()],
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { default: Detail } = await vite.ssrLoadModule('/ItemDetail.vue');
  const summary = {
    id: 'summary',
    status: 'failed',
    error: 'YOUTUBE_NO_CAPTIONS',
    scope: 'YouTube 字幕',
    current: true,
    revision: '',
    result: null,
    calls: [],
    output: null,
  };
  const detail = {
    id: 'item',
    kind: 'youtube',
    videoId: 'abcdefghijk',
    title: 'Synthetic video',
    author: 'Synthetic source',
    text: 'PROMOTIONAL_DESCRIPTION_MUST_BE_HIDDEN',
    url: '',
    expired: 0,
    discovered: 1,
    published: null,
    received: null,
    canSummarize: true,
    summaries: [summary],
    transcript: null as { language: string; kind: string; text: string } | null,
    delivery: null,
    attempts: [],
  };
  const render = (value: typeof detail, asrReady = false) =>
    renderToString(
      createSSRApp({
        render: () =>
          h(Detail, {
            detail: value,
            demo: true,
            busy: false,
            captionsReady: true,
            asrReady,
            pushReady: true,
            pushLabel: '微信',
            time: () => 'time',
            explain: (s: string) => s,
            labels: {},
          }),
      }),
    );
  const html = await render(detail);
  assert(!html.includes(detail.text));
  assert(!html.includes('仅视频简介'));
  assert(!html.includes('生成失败'));
  assert(!html.includes('微信推送'));
  assert(html.includes('暂无可用字幕'));
  assert(html.includes('重新获取字幕'));
  assert(html.includes('未调用 DeepSeek'));
  const mail = await render({
    ...detail,
    kind: 'email',
    text: 'SYNTHETIC_EMAIL_BODY',
    summaries: [],
  });
  assert(mail.includes('SYNTHETIC_EMAIL_BODY'));
  const transcript = await render({
    ...detail,
    summaries: [],
    transcript: {
      language: 'zh',
      kind: 'manual',
      text: '[00:10] SYNTHETIC_TRANSCRIPT',
    },
  });
  assert(transcript.includes('字幕原文'));
  assert(transcript.includes('SYNTHETIC_TRANSCRIPT'));
  const asr = await render(
    {
      ...detail,
      transcript: { language: 'zh', kind: 'transcribed', text: '[00:10] SYNTHETIC_ASR' },
    },
    true,
  );
  assert(asr.includes('音频转写全文'));
  assert(asr.includes('本地转写 · 可能误识别'));
  assert(asr.includes('重新提取并总结'));
});
