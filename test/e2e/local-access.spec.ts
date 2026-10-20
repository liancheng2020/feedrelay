import { test, expect } from './fixtures.js';

test.use({ authMode: 'local' });
for (const width of [1440, 390]) {
  test(`LOCAL-03: open and refresh without login at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#settings');
    await expect(page.getByRole('heading', { name: '邮箱接入', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '运行检查', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '运行检查' })).toContainText('自动摘要推送');
    await expect(page.getByLabel('管理密码', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '管理密码', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: '邮箱接入', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/feedrelay-hosting-settings-${width}.png`, fullPage: true });
    await page.getByRole('navigation').getByRole('button', { name: '最新更新', exact: true }).click();
    await expect(page.getByRole('table', { name: '更新记录' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/feedrelay-local-${width}.png`, fullPage: true });
  });
}
