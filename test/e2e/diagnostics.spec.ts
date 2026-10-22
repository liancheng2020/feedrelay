import { test, expect } from './fixtures.js';

test.use({ authMode: 'local' });
for (const width of [1440, 390]) {
  test(`HOST-14: source failures are actionable and status refresh does not collect at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    let checks = 0;
    const issue = { sourceId: 'synthetic-source', name: '异常频道样例', error: 'YOUTUBE_NETWORK_ERROR',
      lastSuccess: null, status: 'retry_wait', nextCheck: Date.now() + 3600_000 };
    await page.route('**/api/overview', async route => {
      const response = await route.fetch();
      const overview = await response.json();
      overview.diagnostics.sourceIssues = checks ? [] : [issue];
      const sourceCheck = overview.diagnostics.checks.find((c: { id: string }) => c.id === 'sources');
      sourceCheck.ok = checks > 0;
      sourceCheck.detail = checks ? '3 个已启用；0 个异常' : '3 个已启用；1 个异常';
      await route.fulfill({ response, json: overview });
    });
    await page.route('**/api/sources/synthetic-source/check', async route => {
      checks++;
      await route.fulfill({ status: 202, json: { id: 'synthetic-job', status: 'retry_wait' } });
    });
    await page.goto('/#settings');
    const section = page.getByRole('region', { name: '运行检查', exact: true });
    await expect(section.getByText(issue.name, { exact: true })).toBeVisible();
    await expect(section.getByText('YouTube 连接失败，请检查网络或代理', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByText('运行状态已刷新。', { exact: true })).toBeVisible();
    expect(checks).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/feedrelay-diagnostics-${width}.png` });
    await section.getByRole('button', { name: `重新采集 ${issue.name}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '立即重新采集？' });
    await expect(dialog.getByText(/可能产生模型费用/)).toBeVisible();
    expect(checks).toBe(0);
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await expect(section.getByText('3 个已启用；0 个异常', { exact: true })).toBeVisible();
    await expect(section.getByText(issue.name, { exact: true })).toHaveCount(0);
    expect(checks).toBe(1);
  });
}
