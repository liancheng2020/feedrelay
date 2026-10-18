import { test, expect } from '@playwright/test';
async function login(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByLabel('管理密码').fill('demo');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '最新更新', exact: true })).toBeVisible();
}
test('v0.2 desktop: digest parts, confirmed mode change and portable config', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.getByRole('navigation').getByRole('button', { name: '每日日报' }).click();
  await expect(page.locator('.digest-list article').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('desktop-digests.png'), fullPage: true });
  await page.getByRole('button', { name: '查看分片' }).first().click();
  await expect(page.getByRole('region', { name: '内容详情' })).toContainText(
    'FeedRelay 日报',
  );
  await page.getByRole('button', { name: '返回列表' }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /订阅源/ })
    .click();
  const row = page.locator('.source-row').filter({ hasText: '公开订阅 · 日报样例' });
  await row.getByLabel('投递方式').selectOption('immediate');
  const confirm = page.getByRole('dialog', { name: '切换为即时？' });
  await expect(confirm).toContainText('已有积压保持原投递方式');
  await confirm.getByRole('button', { name: '确认', exact: true }).click();
  await expect(row.getByLabel('投递方式')).toHaveValue('immediate');
  await page.getByRole('button', { name: '导入配置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入订阅配置' });
  const config = {
    format: 'feedrelay.sources',
    version: 1,
    sources: [
      {
        type: 'youtube',
        name: '浏览器导入样例',
        channel: 'UC' + 'v'.repeat(22),
        delivery_mode: 'digest',
      },
    ],
  };
  await dialog.getByLabel('选择 JSON 配置').setInputFiles({
    name: 'sources.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(config)),
  });
  await dialog.getByRole('button', { name: '预览配置' }).click();
  await expect(dialog).toContainText('新增 1 项');
  await page.screenshot({ path: info.outputPath('desktop-import.png'), fullPage: true });
  await dialog.getByRole('button', { name: '确认导入' }).click();
  await expect(
    page
      .locator('.source-row')
      .filter({ hasText: '浏览器导入样例' })
      .getByText('已暂停', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '导出配置', exact: true }).click();
  const exporting = page.getByRole('dialog', { name: '导出订阅配置' });
  await expect(exporting.getByRole('checkbox')).not.toBeChecked();
  const download = page.waitForEvent('download');
  await exporting.getByRole('button', { name: '下载配置' }).click();
  expect((await download).suggestedFilename()).toBe('feedrelay-sources.json');
  expect(errors).toEqual([]);
});
test('v0.2 mobile: RSS consent, digest navigation and schedule settings', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /订阅源/ })
    .click();
  await page.getByRole('button', { name: '添加订阅源', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '订阅源设置' });
  await dialog.getByRole('button', { name: 'RSS', exact: true }).click();
  await dialog.getByLabel('名称', { exact: true }).fill('手机RSS样例');
  await dialog.getByLabel('公开 RSS / Atom 地址').fill('https://example.com/mobile-feed.xml');
  await dialog.getByLabel('投递方式', { exact: true }).selectOption('digest');
  await dialog.getByRole('checkbox').check();
  await page.screenshot({ path: info.outputPath('mobile-add-rss.png'), fullPage: true });
  await dialog.getByRole('button', { name: '保存订阅源' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: '每日日报' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-digests.png'), fullPage: true });
  await page.getByRole('navigation').getByRole('button', { name: '投递设置' }).click();
  await expect(page.getByLabel('日报时间（所选时区）')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
