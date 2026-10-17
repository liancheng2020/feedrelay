import { test, expect } from '@playwright/test';

test('desktop: browse, resolve uncertainty, manage source and settings', async ({ page }, info) => {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('管理密码').fill('demo');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '最新更新', exact: true })).toBeVisible();
  await expect(page.getByText('Agent 的边界：把不确定的决策放进确定的流程')).toBeVisible();
  await page.screenshot({ path: info.outputPath('desktop-updates.png'), fullPage: true });
  await page.getByRole('button', { name: '为什么幂等不是加一个重试按钮', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '内容详情' })).toBeVisible();
  await page.getByRole('button', { name: '已核查', exact: true }).click();
  await page
    .getByRole('dialog', { name: '标记为已人工核查？' })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: '内容详情' }).getByText('已人工核查', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /订阅源/ })
    .click();
  await page.getByRole('button', { name: '添加订阅源', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '订阅源设置' });
  await editor.getByLabel('名称', { exact: true }).fill('浏览器验证频道');
  await editor.getByLabel('频道地址 / ID').fill('UC' + 'z'.repeat(22));
  await editor.getByRole('button', { name: '保存订阅源' }).click();
  const row = page.locator('.source-row').filter({ hasText: '浏览器验证频道' });
  await expect(row.getByText('已暂停')).toBeVisible();
  await row.getByRole('button', { name: '启用采集' }).click();
  const enable = page.getByRole('dialog', { name: '启用订阅' });
  await enable.getByLabel('同时启用飞书私聊推送').check();
  await expect(enable.getByRole('button', { name: '确认启用' })).toBeDisabled();
  await enable.getByRole('checkbox').nth(1).check();
  await enable.getByRole('button', { name: '确认启用' }).click();
  await expect(row.getByText('采集中')).toBeVisible();
  await page.screenshot({ path: info.outputPath('desktop-sources.png'), fullPage: true });
  await row.getByRole('button', { name: '删除', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '删除订阅源' });
  await deletion.getByRole('button', { name: '确认删除' }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: '投递设置' }).click();
  await expect(page.getByText('飞书应用机器人', { exact: true })).toBeVisible();
  await page.getByLabel('每日发送尝试上限').fill('55');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status')).toContainText('设置已保存');
  expect(failures).toEqual([]);
});

test('mobile: no overflow, details and source modal remain usable', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('管理密码').fill('demo');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '最新更新', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-updates.png'), fullPage: true });
  await page.getByRole('button', { name: '查看详情' }).first().click();
  await expect(page.getByRole('dialog', { name: '内容详情' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('mobile-detail.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /订阅源/ })
    .click();
  await page.getByRole('button', { name: '添加订阅源', exact: true }).click();
  await page.getByRole('button', { name: '邮件规则' }).click();
  await expect(
    page.getByRole('dialog', { name: '订阅源设置' }).getByLabel('发件邮箱地址'),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-add-mail.png'), fullPage: true });
});
