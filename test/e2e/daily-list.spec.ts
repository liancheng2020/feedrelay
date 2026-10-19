import { test, expect } from './fixtures.js';

for (const width of [1440, 390]) {
  test(`DAILY-01: compact date link opens daily detail at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/digests', async route => {
      const response = await route.fetch();
      const batches = await response.json();
      const batch = batches.find((b: { parts: unknown[] }) => b.parts.length);
      await route.fulfill({ response, json: [{ ...batch, slot: 'aihot:2026-10-19',
        cutoff: Date.parse('2026-10-19T02:00:00Z'), timezone: 'Asia/Shanghai',
        total_parts: 1, parts: [{ ...batch.parts[0], status: 'sent', error: '', resolution: '' }],
      }] });
    });
    await page.goto('/#digests');
    await page.getByLabel('管理密码', { exact: true }).fill('demo');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const row = page.locator('.digest-list article');
    const entry = row.getByRole('link', { name: '查看 2026/10/19 AIHOT AI 日报' });
    await expect(entry).toBeVisible();
    await expect(entry.getByRole('heading')).toHaveText('2026/10/19');
    await expect(row).toContainText('AIHOT AI 日报');
    await expect(row).toContainText('已推送');
    await expect(row.locator('.digest-part')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/feedrelay-daily-${width}.png`, fullPage: true });
    const box = await entry.boundingBox();
    await entry.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
    await expect(page.getByRole('region', { name: '内容详情' })).toBeVisible();
    await expect(page).toHaveURL(/#items\//);
    await page.getByRole('button', { name: '返回列表' }).click();
    await expect(page).toHaveURL(/#digests$/);
    await expect(entry).toBeVisible();
  });
}
