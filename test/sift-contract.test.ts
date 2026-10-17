import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { createSiftAdapter, validateBrief } from '../server/sift.js';
import { SummaryService } from '../server/summary.js';
import { fixture, incoming } from './helpers.js';
import { parseCaption } from '../server/captions.js';

// Optional local-module contract: synthetic provider responses only, never a real model request.
test(
  'installed Sift module accepts a synthetic response and its repair uses the same request gate',
  { skip: !process.env.SIFT_TEST_DIR },
  async (t) => {
    const config = readConfig({ FEEDRELAY_DEMO: '1' });
    config.demo = false;
    config.sift = {
      enabled: true,
      dir: process.env.SIFT_TEST_DIR!,
      apiKey: 'synthetic-not-a-key',
      model: 'contract-model',
      inputPrice: 1,
      outputPrice: 2,
    };
    const adapter = createSiftAdapter(config);
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
  },
);

test(
  'installed Sift splits long timed captions, merges existing evidence and uses one ledger for repairs',
  { skip: !process.env.SIFT_TEST_DIR },
  async (t) => {
    const f = fixture(t),
      source = f.source();
    const config = {
      ...f.config,
      demo: false,
      sift: {
        enabled: true,
        dir: process.env.SIFT_TEST_DIR!,
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
      const user = JSON.parse(String(init!.body)).messages[1].content as string;
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
      createSiftAdapter(config),
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
  },
);
