import { test, expect } from './fixtures.js';

for (const width of [1440, 390]) {
  test(`AUTH-05: login, password change and return route at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#settings');
    await expect(page.getByLabel('管理密码', { exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/feedrelay-login-${width}.png`, fullPage: true });
    await page.getByLabel('管理密码', { exact: true }).fill('demo');
    await page.getByRole('button', { name: '显示密码', exact: true }).click();
    await expect(page.getByLabel('管理密码', { exact: true })).toHaveAttribute('type', 'text');
    await page.getByLabel('在此设备保持登录 30 天').check();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '管理密码', exact: true })).toBeVisible();
    const sessionCookie = (await page.context().cookies()).find(c => c.name === 'feedrelay.session')!;
    expect(sessionCookie.expires - Date.now() / 1000).toBeGreaterThan(29 * 86400);
    await page.getByLabel('当前密码', { exact: true }).fill('demo');
    await page.getByLabel('新密码（8–16 个字符）', { exact: true }).fill('browser-pass-123');
    await page.getByLabel('确认新密码', { exact: true }).fill('browser-pass-123');
    await page.getByRole('button', { name: '保存并重新登录' }).click();
    await expect(page.getByRole('status')).toContainText('密码已更新');
    await page.getByLabel('管理密码', { exact: true }).fill('browser-pass-123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '管理密码', exact: true })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#settings');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/feedrelay-auth-${width}.png`, fullPage: true });
    await page.context().clearCookies();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByLabel('管理密码', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('会话已过期');
    expect(new URL(page.url()).hash).toBe('#settings');
    await page.getByLabel('管理密码', { exact: true }).fill('browser-pass-123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '管理密码', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByLabel('管理密码', { exact: true })).toBeVisible();
  });
}
