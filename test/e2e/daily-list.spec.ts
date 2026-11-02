import { test, expect } from './fixtures.js';

for (const width of [1440, 390]) {
  test(`DAILY-01: calendar daily row opens detail at ${width}px`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date('2026-10-19T06:00:00Z'));
    await page.route('**/api/digests?*', async route => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('view')).toBe('calendar');
      expect(url.searchParams.get('month')).toBe('2026-10');
      // Demo dates follow the server clock; read the unfiltered seed before assigning a fixed calendar date.
      const response = await route.fetch({ url: new URL('/api/digests', url).href });
      expect(response.ok()).toBe(true);
      const archive: unknown = await response.json();
      if (!Array.isArray(archive)) throw new Error('Expected the legacy digest seed array');
      const batches: unknown[] = archive;
      const batch = batches.find((value): value is { id: string; parts: { id: string; item_id: string }[] } =>
        typeof value === 'object' && value !== null
        && 'id' in value && typeof value.id === 'string'
        && 'parts' in value && Array.isArray(value.parts) && value.parts.length > 0
        && value.parts.every((part: unknown) => typeof part === 'object' && part !== null
          && 'id' in part && typeof part.id === 'string'
          && 'item_id' in part && typeof part.item_id === 'string'));
      if (!batch) throw new Error('Missing demo digest seed with a detail item');
      await route.fulfill({ json: { month: '2026-10', months: ['2026-10'], total: 1, items: [{ ...batch, slot: 'aihot:2026-10-19',
        cutoff: Date.parse('2026-10-19T02:00:00Z'), timezone: 'Asia/Shanghai',
        members: 1, total_parts: 1, parts: [{ ...batch.parts[0], status: 'sent', error: '', resolution: '' }],
      }] } });
    });
    await page.goto('/#digests');
    await page.getByLabel('管理密码', { exact: true }).fill('demo');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const calendar = page.getByRole('region', { name: '日报月历', exact: true });
    await expect(calendar.getByLabel('日报月份', { exact: true })).toHaveValue('2026-10');
    const selectedDay = calendar.getByRole('button', { name: '2026-10-19，1份日报，已推送', exact: true });
    await expect(selectedDay).toHaveAttribute('aria-pressed', 'true');
    const row = page.locator('.digest-list article');
    await expect(row).toHaveCount(1);
    const entry = row.getByRole('link', { name: '查看 2026/10/19 AIHOT AI 日报' });
    await expect(entry).toBeVisible();
    await expect(entry.getByRole('heading')).toHaveText('AIHOT AI 日报');
    await expect(row).toContainText('AIHOT AI 日报');
    await expect(row).toContainText('已推送');
    await expect(row.locator('.digest-part')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`daily-${width}.png`), fullPage: true });
    const box = await entry.boundingBox();
    if (!box) throw new Error('Daily row has no clickable bounds');
    await entry.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(page.getByRole('region', { name: '内容详情' })).toBeVisible();
    await expect(page).toHaveURL(/#items\//);
    await page.getByRole('button', { name: '返回列表' }).click();
    await expect(page).toHaveURL(/#digests$/);
    await expect(entry).toBeVisible();
    await expect(selectedDay).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });
}
