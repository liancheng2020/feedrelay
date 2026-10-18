import { test, expect } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`PG-02: page sizes, navigation and empty filters at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route(/\/api\/items(?:\?|$)/, async (route) => {
      const url = new URL(route.request().url());
      const pageSize = Number(url.searchParams.get('pageSize') || 20);
      const total = url.searchParams.get('status') === 'sent' ? 0 : 107;
      const current = Math.min(Number(url.searchParams.get('page') || 1), Math.max(1, Math.ceil(total / pageSize)));
      const start = (current - 1) * pageSize;
      const items = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, index) => ({
        id: `page-item-${start + index}`, kind: 'youtube', title: `分页记录 ${start + index + 1}`,
        author: '分页样例', text: '', url: '', discovered: 1, published: 1,
        received: null, expired: 0, status: 'discovered', summaryStatus: 'none',
      }));
      await route.fulfill({ json: { page: current, pageSize, total, items } });
    });
    await page.goto('/');
    await page.getByLabel('管理密码').fill('demo');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const rows = page.locator('.updates-table tbody tr');
    const pager = page.getByLabel('列表分页');
    const size = page.getByLabel('每页条数');
    await expect(size).toHaveValue('20');
    await expect(rows).toHaveCount(20);
    await expect(pager).toContainText('1–20 / 107 条');
    await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(rows.first()).toContainText('分页记录 21');
    for (const count of [10, 50, 100]) {
      await size.selectOption(String(count));
      await expect(rows).toHaveCount(count);
      await expect(rows.first()).toContainText('分页记录 1');
      await expect(pager.locator('.pagination-page')).toHaveText(`1 / ${Math.ceil(107 / count)} 页`);
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(rows.first()).toContainText(`分页记录 ${count + 1}`);
    }
    await expect(rows).toHaveCount(7);
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await size.selectOption('20');
    await expect(rows).toHaveCount(20);
    await expect(size).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await pager.screenshot({ path: info.outputPath(`pagination-${width}.png`) });
    await page.getByRole('combobox', { name: '投递状态', exact: true }).selectOption('sent');
    await expect(rows).toHaveCount(0);
    await expect(pager).toContainText('0–0 / 0 条');
    await expect(pager.locator('.pagination-page')).toHaveText('1 / 1 页');
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  });
}
