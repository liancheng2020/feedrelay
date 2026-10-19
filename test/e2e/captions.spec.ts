import { test, expect } from './fixtures.js';

test('captions: explicit scope confirmation, grounded timestamp links, revocation and mobile layout', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('管理密码').fill('demo');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '最新更新', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/session')).json();
  const headers = { Origin: 'http://127.0.0.1:8799', 'X-CSRF-Token': session.csrf };
  expect(
    (
      await page.request.put('/api/summaries/settings', {
        headers,
        data: { enabled: true, maxCalls: 30, maxCostCny: 1, confirmed: true },
      })
    ).ok(),
  ).toBe(true);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /订阅源/ })
    .click();
  const row = page.locator('.source-row').filter({ hasText: 'AI 工程观察 · 样例' });
  await expect(row.getByLabel('摘要正文', { exact: true })).toBeEnabled();
  await expect(row.getByLabel('AI摘要', { exact: true })).toBeEnabled();
  await row.getByLabel('AI摘要', { exact: true }).selectOption('manual');
  const dialog = page.getByRole('dialog', { name: '授权此来源摘要？', exact: true });
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await row.getByLabel('摘要正文', { exact: true }).selectOption('captions');
  await expect(dialog).toContainText('不读取Cookie、不下载音视频');
  await expect(dialog).toContainText('12次模型请求');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(row.getByLabel('摘要正文', { exact: true })).toHaveValue('captions');
  await page.screenshot({ path: info.outputPath('desktop-caption-source.png'), fullPage: true });
  await page.getByRole('navigation').getByRole('button', { name: '最新更新', exact: true }).click();
  await page
    .getByRole('link', { name: 'Agent 的边界：把不确定的决策放进确定的流程', exact: true })
    .click();
  const detail = page.getByRole('region', { name: '内容详情' });
  await detail.getByRole('button', { name: '生成摘要', exact: true }).click();
  await page
    .getByRole('dialog', { name: '生成当前内容摘要？', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(detail.locator('.reading-summary')).toContainText('已生成', { timeout: 15000 });
  await expect(detail.locator('.reading-summary')).toContainText('不含画面');
  await expect(detail.getByRole('link', { name: '[00:10] 查看原文' })).toHaveAttribute(
    'href',
    /&t=10s$/,
  );
  await page.screenshot({ path: info.outputPath('desktop-caption-summary.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-caption-summary.png'), fullPage: true });
  await page.getByRole('button', { name: '返回列表' }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /订阅源/ })
    .click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-caption-source.png'), fullPage: true });
  await row.getByLabel('摘要正文', { exact: true }).selectOption('feed');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(row.getByLabel('摘要正文', { exact: true })).toHaveValue('feed');
  await row.getByLabel('AI摘要', { exact: true }).selectOption('off');
  await page
    .getByRole('dialog', { name: '关闭此来源摘要？', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(row.getByLabel('摘要正文', { exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
