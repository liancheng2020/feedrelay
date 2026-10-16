import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { createSiftAdapter, validateBrief } from '../server/sift.js';
import { SummaryService } from '../server/summary.js';
import { fixture, incoming } from './helpers.js';

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
