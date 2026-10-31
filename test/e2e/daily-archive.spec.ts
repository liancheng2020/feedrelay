import { test, expect } from './fixtures.js';

interface Digest {
  id: string;
  slot: string;
  cutoff: number;
  timezone: string;
  total_parts: number;
  members: number;
  parts: { id: string; item_id: string; status: string; error: string; resolution: string }[];
}

function isDigest(value: unknown): value is Digest {
  if (typeof value !== 'object' || value === null) return false;
  return 'id' in value && typeof value.id === 'string'
    && 'slot' in value && typeof value.slot === 'string'
    && 'cutoff' in value && typeof value.cutoff === 'number'
    && 'timezone' in value && typeof value.timezone === 'string'
    && 'total_parts' in value && typeof value.total_parts === 'number'
    && 'members' in value && typeof value.members === 'number'
    && 'parts' in value && Array.isArray(value.parts)
    && value.parts.every((part: unknown) => typeof part === 'object' && part !== null
      && 'id' in part && typeof part.id === 'string'
      && 'item_id' in part && typeof part.item_id === 'string'
      && 'status' in part && typeof part.status === 'string'
      && 'error' in part && typeof part.error === 'string'
      && 'resolution' in part && typeof part.resolution === 'string');
}

for (const width of [1440, 390]) {
  test(`DAILY-CALENDAR-01: date selection and month recovery at ${width}px`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date('2026-10-31T06:00:00Z'));

    let template: Digest | undefined;
    let failMonth = '';
    const requestedMonths: string[] = [];
    await page.route('**/api/digests?*', async route => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('view')).toBe('calendar');
      expect(url.searchParams.get('page')).toBeNull();
      expect(url.searchParams.get('pageSize')).toBeNull();
      const month = url.searchParams.get('month');
      if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        throw new Error(`Invalid calendar month: ${month}`);
      }
      requestedMonths.push(month);
      if (month === failMonth) {
        failMonth = '';
        await route.fulfill({ status: 503, json: { error: '测试暂不可用' } });
        return;
      }
      if (!template) {
        // Only the isolated demo fixture supplies a real item link for detail navigation.
        const response = await route.fetch({ url: new URL('/api/digests', url).href });
        expect(response.ok()).toBe(true);
        const archive: unknown = await response.json();
        if (!Array.isArray(archive)) throw new Error('Expected the legacy digest seed array');
        template = archive.find((batch: unknown): batch is Digest => isDigest(batch) && batch.parts.length > 0);
        if (!template) throw new Error('Missing demo digest seed with a detail item');
      }
      const batch = (date: string, suffix: string, status: 'sent' | 'failed', subscription = false): Digest => {
        if (!template) throw new Error('Missing demo digest seed');
        return {
          ...template,
          id: `calendar-${date}-${suffix}`,
          slot: `${subscription ? 'subscription' : 'aihot'}:${date}:${suffix}`,
          cutoff: Date.parse(`${date}T02:00:00Z`),
          timezone: 'Asia/Shanghai',
          total_parts: 1,
          parts: [{ ...template.parts[0], id: `calendar-part-${date}-${suffix}`, status, error: '', resolution: '' }],
        };
      };
      const items = month === '2026-10' ? [
        batch('2026-10-31', 'sent', 'sent'),
        batch('2026-10-30', 'failed', 'failed'),
        batch('2026-10-30', 'sent', 'sent', true),
      ] : month === '2026-09' ? [batch('2026-09-15', 'sent', 'sent')] : [];
      await route.fulfill({ json: { items, total: items.length, month, months: ['2026-10', '2026-09'] } });
    });

    await page.goto('/#digests');
    await page.getByLabel('管理密码', { exact: true }).fill('demo');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const calendar = page.getByRole('region', { name: '日报月历', exact: true });
    const monthInput = calendar.getByLabel('日报月份', { exact: true });
    const dates = calendar.getByRole('group', { name: '选择日报日期' }).getByRole('button');
    const daily = page.getByRole('region', { name: '当日日报', exact: true });
    const rows = page.locator('.digest-list article');
    const day = (date: string) => calendar.getByRole('button', { name: new RegExp(`^${date}，`) });
    const expectDay = async (date: string, count: number) => {
      await expect(dates).toHaveCount(42);
      await expect(day(date)).toHaveAttribute('aria-pressed', 'true');
      await expect(daily.getByRole('heading', { name: date.replaceAll('-', '/'), exact: true })).toBeVisible();
      await expect(daily.locator('article')).toHaveCount(count);
      await expect(rows).toHaveCount(count);
    };
    const capture = async (state: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({ path: info.outputPath(`calendar-${width}-${state}.png`), fullPage: true });
    };

    await expect(monthInput).toHaveValue('2026-10');
    await expectDay('2026-10-31', 1);
    await expect(calendar.getByRole('button', { name: '2026-10-31，1份日报，已推送', exact: true })).toBeVisible();
    await expect(rows).toContainText('已推送');
    await capture('today');

    const requestsBeforeSelection = requestedMonths.length;
    await calendar.getByRole('button', { name: '2026-10-29，暂无日报', exact: true }).click();
    await expectDay('2026-10-29', 0);
    await expect(daily.getByRole('heading', { name: '当天暂无日报', exact: true })).toBeVisible();
    await capture('empty-day');
    await calendar.getByRole('button', { name: '2026-10-30，2份日报，需处理', exact: true }).click();
    await expectDay('2026-10-30', 2);
    await expect(rows.filter({ hasText: '失败' })).toHaveCount(1);
    await expect(rows.filter({ hasText: '已推送' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'AIHOT AI 日报' })).toHaveCount(1);
    await expect(rows.filter({ hasText: '订阅汇总' })).toHaveCount(1);
    expect(requestedMonths).toHaveLength(requestsBeforeSelection);
    await capture('multiple-digests');

    await rows.first().getByRole('link').click();
    await expect(page.getByRole('region', { name: '内容详情' })).toBeVisible();
    await expect(page).toHaveURL(/#items\//);
    await capture('detail');
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect(page).toHaveURL(/#digests$/);
    await expect(monthInput).toHaveValue('2026-10');
    await expectDay('2026-10-30', 2);

    await calendar.getByRole('button', { name: '上个月', exact: true }).click();
    await expect(monthInput).toHaveValue('2026-09');
    await expectDay('2026-09-15', 1);
    await expect(calendar.getByRole('button', { name: '2026-09-15，1份日报，已推送', exact: true })).toBeVisible();
    await capture('september');

    failMonth = '2026-08';
    await calendar.getByRole('button', { name: '上个月', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('测试暂不可用');
    await expect(monthInput).toHaveValue('2026-09');
    await expectDay('2026-09-15', 1);
    expect(requestedMonths.at(-1)).toBe('2026-08');
    await capture('failed-month-rollback');

    // Retry the same navigation after a failed request.
    await calendar.getByRole('button', { name: '上个月', exact: true }).click();
    await expect(monthInput).toHaveValue('2026-08');
    await expectDay('2026-08-01', 0);
    await expect(daily.getByRole('heading', { name: '当天暂无日报', exact: true })).toBeVisible();
    await capture('empty-month');
    await calendar.getByRole('button', { name: '下个月', exact: true }).click();
    await expect(monthInput).toHaveValue('2026-09');
    await expectDay('2026-09-15', 1);

    await monthInput.fill('2026-10');
    await expectDay('2026-10-31', 1);
    await calendar.getByRole('button', { name: '下个月', exact: true }).click();
    await expect(monthInput).toHaveValue('2026-11');
    await expectDay('2026-11-01', 0);
    failMonth = '2026-10';
    await calendar.getByRole('button', { name: '今天', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('测试暂不可用');
    await expect(monthInput).toHaveValue('2026-11');
    await expectDay('2026-11-01', 0);
    await capture('failed-today-rollback');
    await calendar.getByRole('button', { name: '今天', exact: true }).click();
    await expect(monthInput).toHaveValue('2026-10');
    await expectDay('2026-10-31', 1);
    await expect(day('2026-10-31')).toHaveAttribute('aria-current', 'date');
    await capture('returned-to-today');
  });
}
