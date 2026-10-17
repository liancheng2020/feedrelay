import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import {
  createDeepSeekAdapter,
  validateBrief,
  chunkText,
  parseModelBrief,
  resolveCaptionReferences,
} from '../server/deepseek.js';
import { SummaryService } from '../server/summary.js';
import { fixture, incoming } from './helpers.js';
import { parseCaption } from '../server/captions.js';

test('DS-05: selected passage IDs resolve to original text; unknown IDs never produce evidence', () => {
  const text = '[00:00] 第一段保留繁體原文。\n\n[01:20] 第二段不改写数字123。';
  const parsed = parseModelBrief(JSON.stringify({ overview: {oneLiner: '概括'}, keyPoints: [
    {title:'要点',summary:'说明',evidence:{locator:'[01:20]',quote:'模型改写不作为引文'}}
  ]}));
  const result = validateBrief(resolveCaptionReferences(parsed, text), text);
  assert.equal(result.points[0].quote, '第二段不改写数字123。');
  assert.throws(() => resolveCaptionReferences(parsed, '[00:00] 不存在选中段落'), /SUMMARY_UNSUPPORTED_QUOTE/);
});

test('DS-03: chunk boundaries never split timestamped evidence; invalid single passage is rejected', () => {
  const a = '[00:10] ' + 'a'.repeat(30),
    b = '[00:20] ' + 'b'.repeat(30);
  assert.deepEqual(chunkText(`${a}\n\n${b}`, 50), [a, b]);
  assert.throws(() => chunkText(a, 10), /SUMMARY_CONTENT_UNIT_TOO_LONG/);
  const result = {
    summary: {
      overview: { oneLiner: 'test' },
      keyPoints: [{ title: 't', summary: 's', evidence: { quote: 'bbbb', locator: '[00:10]' } }],
    },
  };
  assert.throws(() => validateBrief(result, `${a}\n\n${b}`), /SUMMARY_UNSUPPORTED_QUOTE/);
});
test('DS-04: bounded JSON syntax/layout repair preserves values and never bypasses literal evidence checks', () => {
  const point = {
    title: '核对',
    summary: '先核对订单状态。',
    evidence: { quote: '必须先核对订单状态。', locator: '[00:10]' },
  };
  const raw = JSON.stringify({ overview: { oneLiner: '先核对状态。', keyPoints: [point] } }).slice(
    0,
    -1,
  );
  const parsed = parseModelBrief(raw);
  const result = validateBrief(parsed, '[00:10] 必须先核对订单状态。');
  assert.equal(result.formatRepaired, true);
  assert.equal(result.points[0].quote, point.evidence.quote);
  assert.throws(
    () => validateBrief(parsed, '[00:10] 实际上未提供该证据。'),
    /SUMMARY_UNSUPPORTED_QUOTE/,
  );
  assert.throws(
    () =>
      parseModelBrief(
        JSON.stringify({ overview: { oneLiner: '冲突', keyPoints: [point] }, keyPoints: [point] }),
      ),
    /SUMMARY_INVALID_OUTPUT/,
  );
  assert.throws(() => parseModelBrief('x'.repeat(80001)), /SUMMARY_INVALID_OUTPUT/);
});

// Direct provider contract: synthetic HTTP responses only, no external checkout or key required.
test('DS-01: direct DeepSeek accepts a synthetic response and repair shares the persistent request gate', async (t) => {
  const config = readConfig({ FEEDRELAY_DEMO: '1' });
  config.demo = false;
  config.deepseek = {
    enabled: true,
    apiKey: 'synthetic-not-a-key',
    model: 'contract-model',
    inputPrice: 1,
    outputPrice: 2,
  };
  const adapter = createDeepSeekAdapter(config);
  const text = '会议于2026年10月16日召开，计划于11月发布。';
  let count = 0;
  const output = {
    overview: { oneLiner: '会议确定11月发布计划。', topic: '发布计划' },
    keyPoints: [
      {
        title: '发布安排',
        summary: '计划于11月发布。',
        evidence: { quote: text, locator: '[段落 1]', seconds: null },
      },
    ],
    keyData: [],
    decisions: [],
    actionItems: [],
    risks: [],
    outline: [],
  };
  const request: typeof fetch = async () => {
    count++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: count === 1 ? 'invalid json' : JSON.stringify(output) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
    );
  };
  const value = await adapter.run(
    { title: '合成测试', text, scope: '邮件正文' },
    request,
    new AbortController().signal,
  );
  assert.equal(count, 2);
  assert.equal(validateBrief(value, text).points[0].quote, text);
  count = 0;
  const f = fixture(t),
    source = f.source('email');
  const service = new SummaryService(f.store, adapter, 'demo', request);
  service.configure({ enabled: true, maxCalls: 2, maxCostCny: 1, confirmed: true });
  service.authorize(source.id, 'manual', false, true);
  const item = f.store.put(
    { ...incoming('contract'), kind: 'email', text },
    [source],
    true,
    'demo',
  );
  service.enqueue(item.id);
  await service.cycle('demo');
  assert.equal(service.list(item.id)[0].status, 'succeeded');
  assert.equal(service.describe().calls, 2);
});

test('DS-02: direct provider splits timed captions and merges evidence with the same repair ledger', async (t) => {
  const f = fixture(t),
    source = f.source();
  const config = {
    ...f.config,
    demo: false,
    deepseek: {
      enabled: true,
      apiKey: 'synthetic-not-a-key',
      model: 'contract-model',
      inputPrice: 1,
      outputPrice: 2,
    },
  };
  let calls = 0,
    extracts = 0,
    merges = 0;
  const partials: any[] = [];
  const request: typeof fetch = async (_url, init) => {
    calls++;
    const messages = JSON.parse(String(init!.body)).messages;
    assert.match(messages[0].content, /直接陈述核心内容/);
    assert.match(messages[0].content, /不把个人观点写成已验证事实/);
    const user = messages[1].content as string;
    let output;
    if (user.includes('合并分段摘要，去重')) {
      merges++;
      output = partials[0];
    } else {
      extracts++;
      const original = user.split('原文：\n')[1];
      const match = original.match(/^\[([\d:]+)\] ([^\n]+)/)!;
      const seconds = match[1].split(':').reduce((n, part) => n * 60 + Number(part), 0);
      output = {
        overview: { oneLiner: '字幕说明状态核对流程。', topic: '状态核对' },
        keyPoints: [
          {
            title: '核对流程',
            summary: '订单处理前应核对状态。',
            evidence: { locator: `[${match[1]}]`, seconds, quote: match[2].slice(0, 60) },
          },
        ],
        keyData: [],
        decisions: [],
        actionItems: [],
        risks: [],
        outline: [],
      };
      if (calls !== 1) partials.push(output);
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: calls === 1 ? 'bad json' : JSON.stringify(output) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
    );
  };
  const service = new SummaryService(
    f.store,
    createDeepSeekAdapter(config),
    'demo',
    request,
    f.engine.summaries.captions,
  );
  const caption = parseCaption(
    {
      videoId: 'abcdefghijk',
      language: 'zh',
      kind: 'manual',
      duration: 120,
      cues: [
        { start: 10000, duration: 1000, text: '第一阶段核对订单状态。'.repeat(750) },
        { start: 60000, duration: 1000, text: '第二阶段核对支付记录。'.repeat(750) },
      ],
    },
    'abcdefghijk',
  );
  service.captions!.fetch = async () => caption;
  service.configure({ enabled: true, maxCalls: 12, maxCostCny: 1, confirmed: true });
  service.authorize(source.id, 'manual', false, true, 'captions');
  const item = f.store.put(incoming(), [f.store.source(source.id)], true, 'demo');
  service.enqueue(item.id);
  await service.cycle('demo');
  const row = service.list(item.id)[0];
  assert.equal(row.status, 'succeeded', row.error);
  assert.equal(extracts, 3); // Two source chunks plus one explicit JSON repair.
  assert.equal(merges, 1);
  assert.equal(service.describe().calls, 4);
  assert.match(row.result!.points[0].url!, /t=10s$/);
});
