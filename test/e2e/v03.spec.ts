import { test, expect, type Page } from '@playwright/test';
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('管理密码').fill('demo');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '最新更新', exact: true })).toBeVisible();
}
async function confirm(page: Page, title: string) {
  await page
    .getByRole('dialog', { name: title, exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click();
}
test('v0.3 desktop: opt-in budget, source disclosure, cached summary and independent supplement', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.getByRole('navigation').getByRole('button', { name: '投递设置' }).click();
  await page.getByLabel('启用可选摘要').check();
  await page.getByLabel('累计请求上限').fill('12');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByLabel('累计请求上限')).toHaveValue('12');
  await page.getByLabel('累计预算上限（人民币）').fill('1');
  await expect(page.getByRole('button', { name: '保存摘要预算' })).toBeDisabled();
  await page.getByLabel('我确认外发范围、价格和累计预算；仅对另行授权来源生效。').check();
  await page.getByRole('button', { name: '保存摘要预算' }).click();
  await expect(page.getByRole('status')).toContainText('摘要预算已保存');
  await page.screenshot({ path: info.outputPath('desktop-summary-budget.png'), fullPage: true });
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /订阅源/ })
    .click();
  const row = page.locator('.source-row').filter({ hasText: 'AI 工程观察 · 样例' });
  await row.getByLabel('AI摘要', { exact: true }).selectOption('manual');
  await expect(page.getByRole('dialog', { name: '授权此来源摘要？' })).toContainText(
    '摘要仅在详情页查看',
  );
  await confirm(page, '授权此来源摘要？');
  await row.getByLabel('私聊追加AI补充').click();
  await confirm(page, '授权此来源摘要？');
  await expect(row.getByLabel('私聊追加AI补充')).toBeChecked();
  await page.getByRole('navigation').getByRole('button', { name: '最新更新' }).click();
  await page
    .getByRole('button', { name: 'Agent 的边界：把不确定的决策放进确定的流程', exact: true })
    .click();
  const detail = page.getByRole('dialog', { name: '内容详情' });
  await detail.getByRole('button', { name: '生成摘要', exact: true }).click();
  await confirm(page, '生成当前内容摘要？');
  await expect(detail.locator('.item-summary')).toContainText('已生成', { timeout: 15000 });
  await expect(detail.locator('.summary-point blockquote')).toContainText('本条为合成演示内容');
  await expect(detail.locator('.item-summary')).toContainText('1 次模型请求');
  await expect(detail.locator('.item-summary')).toContainText(/AI补充投递：\s*已接受/, {
    timeout: 15000,
  });
  await page.screenshot({ path: info.outputPath('desktop-item-summary.png'), fullPage: true });
  await detail.getByRole('button', { name: '生成摘要', exact: true }).click();
  await confirm(page, '生成当前内容摘要？');
  await expect(detail.locator('.item-summary')).toContainText('1 次模型请求');
  await page.getByRole('button', { name: '关闭详情' }).click();
  expect(errors).toEqual([]);
});
test('v0.3 mobile: summary content and budget fit, disabling revokes source consent', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const session = await (await page.request.get('/api/session')).json();
  const headers = { Origin: 'http://127.0.0.1:8799', 'X-CSRF-Token': session.csrf };
  expect(
    (
      await page.request.put('/api/summaries/settings', {
        headers,
        data: { enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true },
      })
    ).ok(),
  ).toBe(true);
  const source = (await (await page.request.get('/api/sources')).json()).find(
    (s: { name: string }) => s.name === 'AI 工程观察 · 样例',
  );
  expect(
    (
      await page.request.post(`/api/sources/${source.id}/summary`, {
        headers,
        data: { mode: 'manual', notify: false, confirmed: true },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page
    .getByRole('button', { name: '从需求到上线：一个小工具的工程取舍', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '内容详情' })
    .getByRole('button', { name: '生成摘要', exact: true })
    .click();
  await confirm(page, '生成当前内容摘要？');
  await expect(page.locator('.item-summary')).toContainText('已生成', { timeout: 15000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-item-summary.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.getByRole('navigation').getByRole('button', { name: '投递设置' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-summary-budget.png'), fullPage: true });
  await page.getByLabel('启用可选摘要').uncheck();
  await page.getByLabel('我确认外发范围、价格和累计预算；仅对另行授权来源生效。').check();
  await page.getByRole('button', { name: '保存摘要预算' }).click();
  await expect(page.getByRole('status')).toContainText('摘要预算已保存');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /订阅源/ })
    .click();
  const row = page.locator('.source-row').filter({ hasText: 'AI 工程观察 · 样例' });
  await expect(row.getByLabel('AI摘要', { exact: true })).toHaveValue('off');
});
