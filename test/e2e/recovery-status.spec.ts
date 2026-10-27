import { test, expect } from './fixtures.js';

for (const width of [1440, 390]) {
  test(`AC3: daily recovery dates and retry status at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date('2026-10-27T01:00:00Z'));
    let state = { enabled: true, startDate: '2026-10-25', lastDate: '2026-10-25',
      checkDate: '2026-10-26', error: 'AIHOT_NOT_PUBLISHED', nextCheck: Date.parse('2026-10-26T03:00:00Z') };
    await page.route('**/api/aihot', route => route.fulfill({ json: state }));
    await page.goto('/#digests');
    await page.getByLabel('管理密码', { exact: true }).fill('demo');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const settings = page.getByRole('region', { name: '日报设置' });
    await expect(settings).toContainText('2026-10-26 检查结果：日报尚未发布或内容尚未就绪');
    await expect(settings).toContainText('等待后台检查');
    await expect(settings).toContainText('最近入队版次：2026-10-25');
    await expect(settings).not.toContainText('今日日报');
    await expect(settings).not.toContainText('下次检查：');
    state = { ...state, checkDate: '2026-10-27', nextCheck: Date.parse('2026-10-27T03:00:00Z') };
    await page.reload();
    await expect(settings).toContainText('2026-10-27 检查结果');
    await expect(settings).toContainText('下次检查：');
    await expect(settings).not.toContainText('等待后台检查');
    state = { ...state, error: 'AIHOT_INVALID_REPORT' };
    await page.reload();
    await expect(settings).toContainText('2026-10-27 检查结果：日报格式异常，等待上游恢复');
    await expect(settings).toContainText('下次检查：');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/feedrelay-recovery-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
