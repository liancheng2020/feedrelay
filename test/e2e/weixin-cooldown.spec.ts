import { test, expect } from './fixtures.js';

test.use({ authMode: 'local' });
for (const width of [1440, 390]) {
  test(`AC3/4: Weixin hourly retry beyond five attempts and day expiry at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width, height: 900 });
    const now = Date.parse('2026-10-29T04:00:00Z');
    await page.clock.setFixedTime(now);
    let due = false;
    await page.route('**/api/overview', async route => {
      const response = await route.fetch();
      const overview = await response.json();
      overview.connections.channel = 'weixin';
      overview.connections.pushReady = due;
      overview.connections.weixin = { bound: true, ready: due, recipient: 'synthetic',
        lastInbound: now - 2 * 86400000, lastPoll: now, lastAccepted: 0,
        error: due ? '' : 'WEIXIN_CONTEXT_REJECTED', nextRetryAt: due ? now : now + 3600000 };
      const check = overview.diagnostics.checks.find((c: { id: string }) => c.id === 'push');
      check.ok = due;
      check.detail = due ? '整点重试窗口内，符合条件的当日任务待后台调度（仍受授权及额度限制）'
        : '微信拒绝发送，可能上下文或发送限制；下次自动重试（北京时间）：2026/10/29 13:00:00（仅限任务创建当日）';
      await route.fulfill({ response, json: overview });
    });
    await page.route('**/api/items?*', async route => {
      const response = await route.fetch();
      const data = await response.json();
      data.items[0] = { ...data.items[0], status: 'pending', pushStatus: 'waiting', attempt: 0, error: '' };
      data.items[1] = { ...data.items[1], status: 'failed', pushStatus: 'attention', attempt: 5, error: 'WEIXIN_CONTEXT_REJECTED' };
      data.items[2] = { ...data.items[2], status: 'cancelled', pushStatus: 'attention', error: 'WEIXIN_DAY_EXPIRED' };
      await route.fulfill({ response, json: data });
    });
    await page.route('**/api/digests', async route => {
      const response = await route.fetch();
      const batches = await response.json();
      const batch = batches.find((b: { parts: unknown[] }) => b.parts.length);
      await route.fulfill({ response, json: [{ ...batch, slot: 'aihot:2026-10-29', total_parts: 1,
        parts: [{ ...batch.parts[0], status: 'failed', attempt: 5, error: 'WEIXIN_CONTEXT_REJECTED' }] }] });
    });
    for (const view of ['updates', 'digests', 'settings']) {
      await page.goto(`/#${view}`);
      const notice = view === 'settings' ? page.getByRole('region', { name: '运行检查' }) : page.getByRole('status');
      await expect(notice).toContainText('微信拒绝发送，可能上下文或发送限制');
      await expect(notice).toContainText('下次自动重试（北京时间）：');
      if (view !== 'settings') {
        const box = await notice.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeLessThan(280);
        const retry = await notice.locator('span').last().boundingBox();
        expect(retry!.width).toBeGreaterThan(200);
      }
      if (view === 'updates') {
        await expect(page.locator('.updates-table').getByText('待推送', { exact: true })).toBeVisible();
        await expect(page.locator('.updates-table')).toContainText('每小时整点重试');
        await expect(page.locator('.updates-table')).toContainText('已取消，不再补发');
        await expect(page.getByText('已达5次尝试上限', { exact: false })).toHaveCount(0);
      }
      if (view === 'digests') await expect(page.locator('.digest-list')).toContainText('每小时整点重试');
      if (view === 'settings') await expect(page.getByRole('button', { name: '发送测试', exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `/tmp/feedrelay-weixin-${view}-${width}.png`, fullPage: true });
    }
    due = true;
    for (const view of ['updates', 'digests', 'settings']) {
      await page.goto(`/#${view}`);
      const notice = view === 'settings' ? page.getByRole('region', { name: '运行检查' }) : page.getByRole('status');
      await expect(notice).toContainText('待后台调度');
      await expect(notice).not.toContainText('下次自动重试（北京时间）：');
    }
    expect(errors).toEqual([]);
  });
}
