import { test, expect } from './fixtures.js';
test('reading: table, bookmarkable detail, evidence views and explicit idempotent summary push', async ({
  page,
}, info) => {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('管理密码').fill('demo');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const table = page.getByRole('table', { name: '更新记录' });
  await expect(table.getByRole('columnheader', { name: '标题', exact: true })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: '推送状态', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/session')).json();
  const headers = { Origin: 'http://127.0.0.1:8799', 'X-CSRF-Token': session.csrf };
  expect(
    (
      await page.request.put('/api/summaries/settings', {
        headers,
        data: { enabled: true, maxCalls: 40, maxCostCny: 1, confirmed: true },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page
    .getByRole('link', { name: 'Agent 的边界：把不确定的决策放进确定的流程', exact: true })
    .click();
  const detail = page.getByRole('region', { name: '内容详情' });
  await expect(page).toHaveURL(/#items\/[a-f0-9-]+$/);
  await expect(detail.getByText(/^(基于视频字幕 · 不含画面|字幕优先 · 无字幕时本地转写)$/)).toBeVisible();
  await expect(detail.getByText('本条为合成演示内容，不代表真实视频或新闻。')).toHaveCount(0);
  await detail.getByRole('button', { name: '生成摘要', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '生成当前内容摘要？', exact: true });
  await expect(confirm).toContainText('公开字幕');
  await confirm.getByRole('button', { name: '确认', exact: true }).click();
  const summary = detail.getByRole('region', { name: 'AI摘要', exact: true });
  await expect(summary).toContainText('已生成', { timeout: 15000 });
  await expect(detail.getByRole('heading', { name: '字幕原文', exact: true })).toBeVisible();
  await summary.getByRole('tab', { name: '脉络', exact: true }).click();
  await expect(summary.getByRole('group', { name: '内容脉络图' })).toBeVisible();
  await summary.getByRole('tab', { name: '时间线', exact: true }).click();
  await expect(summary.getByRole('link', { name: '[00:10]', exact: true })).toHaveAttribute(
    'href',
    /&t=10s$/,
  );
  await summary.getByRole('button', { name: '飞书推送', exact: true }).click();
  await page
    .getByRole('dialog', { name: '推送最新摘要到飞书？' })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(summary).toContainText('接口已接受', { timeout: 15000 });
  await expect(summary.getByRole('button', { name: '飞书推送', exact: true })).toBeDisabled();
  const url = page.url();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Agent 的边界：把不确定的决策放进确定的流程', exact: true }),
  ).toBeVisible();
  expect(page.url()).toBe(url);
  await page.screenshot({ path: info.outputPath('reading-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('reading-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(page.getByRole('table', { name: '更新记录' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});
