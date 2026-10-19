import { test, expect } from './fixtures.js';

test('YouTube handle input: clear demo boundary, synthetic resolution and canonical paused source', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('管理密码').fill('demo');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /订阅源/ })
    .click();
  await page.getByRole('button', { name: '添加订阅源', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '订阅源设置' });
  await editor.getByLabel('名称', { exact: true }).fill('Handle 合成验证');
  await editor.getByLabel('频道地址 / ID').fill('https://www.youtube.com/@MeiTouJun');
  await editor.getByRole('button', { name: '保存订阅源', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('演示模式不访问真实频道');
  await expect(editor).toBeVisible();
  await editor.getByLabel('频道地址 / ID').fill('https://www.youtube.com/@feedrelay-demo');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-youtube-handle.png'), fullPage: true });
  await editor.getByRole('button', { name: '保存订阅源', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const row = page.locator('.source-row').filter({ hasText: 'Handle 合成验证' });
  await expect(row).toContainText('UC' + 'd'.repeat(22));
  await expect(row).toContainText('已暂停');
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await page
    .getByRole('dialog', { name: '删除订阅源' })
    .getByRole('button', { name: '确认删除', exact: true })
    .click();
  await expect(row).toHaveCount(0);
});
