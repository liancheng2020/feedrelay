import { test, expect } from './fixtures.js';

for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1280, 720], [1440, 900], [1920, 1080]]) {
  test(`PAGE-01: readable, complete static page at ${width}x${height}`, async ({ page, baseURL }) => {
    const errors: string[] = [], external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(baseURL!)) external.push(request.url()); });
    await page.setViewportSize({ width, height });
    await page.goto('./');
    await expect(page.getByRole('heading', { name: 'FeedRelay.', exact: true })).toBeVisible();
    await expect(page.getByText('FEED IN. INSIGHT OUT.', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '开始部署', exact: true }).last()).toBeVisible();
    expect(await page.locator('.hero-product img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.screenshot({ path: `/tmp/feedrelay-site-${width}-hero.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.source-strip').evaluate(element => element.getBoundingClientRect().top < innerHeight - 10)).toBe(true);
    const cta = await page.locator('.hero-actions').boundingBox();
    const visual = await page.locator('.hero-product').boundingBox();
    expect(cta!.y + cta!.height).toBeLessThan(visual!.y);
    const note = await page.locator('.platform-note').boundingBox();
    expect(note!.y + note!.height).toBeLessThan(visual!.y);
    if (width >= 1280) {
      const visibleRows = await page.locator('.hero-product img').evaluate((image: HTMLImageElement) => {
        const bounds = image.getBoundingClientRect();
        const heroBottom = image.closest('.hero')!.getBoundingClientRect().bottom;
        const visibleHeight = Math.min(bounds.bottom, heroBottom) - bounds.top;
        // The captured table contains a 45px header and seven 65px rows.
        return (visibleHeight * image.naturalWidth / bounds.width - 45) / 65;
      });
      expect(Math.round(visibleRows * 100) / 100).toBeGreaterThanOrEqual(height >= 1000 ? 7 : height >= 900 ? 5.5 : 3.3);
    }
    await page.locator('#preview').scrollIntoViewIfNeeded();
    await expect(page.getByRole('tabpanel', { name: 'AI 摘要', exact: true }).getByRole('img')).toBeVisible();
    expect(await page.getByRole('tabpanel', { name: 'AI 摘要', exact: true }).getByRole('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.locator('#start').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/feedrelay-site-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    expect(await page.locator('.hero h1').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}

test('PAGE-02: previews, keyboard selection and accessible zoom work', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('navigation', { name: '官网导航' }).getByRole('link', { name: '界面预览', exact: true }).click();
  await expect(page).toHaveURL(/#preview$/);
  await expect(page.getByRole('link', { name: '功能说明', exact: true })).toHaveAttribute('href', 'https://github.com/liancheng2020/feedrelay#功能');
  const tabs = page.getByRole('tablist', { name: '产品界面' });
  await tabs.getByRole('tab', { name: '最新更新' }).click();
  await expect(page.getByRole('tabpanel', { name: '最新更新', exact: true })).toBeVisible();
  await tabs.getByRole('tab', { name: '最新更新' }).press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'AI 摘要' })).toBeFocused();
  await tabs.getByRole('tab', { name: 'AI 摘要' }).press('End');
  await expect(page.getByRole('tabpanel', { name: '每日日报', exact: true })).toBeVisible();
  const zoom = page.getByRole('button', { name: '放大界面预览' });
  await zoom.click();
  await expect(page.getByRole('dialog', { name: '界面大图' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(zoom).toBeFocused();
});

test('PAGE-03: install steps copy correct commands and handle clipboard rejection', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as any).copiedCommand = value; } } });
  });
  await page.goto('./#start');
  await page.getByRole('button', { name: '复制命令' }).click();
  await expect(page.getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => (window as any).copiedCommand)).toContain('git clone https://github.com/liancheng2020/feedrelay.git');
  await page.getByRole('tab', { name: '后台托管', exact: true }).click();
  await expect(page.locator('#install-command')).toContainText('npm run service -- install');
  await page.getByRole('button', { name: '复制命令' }).click();
  expect(await page.evaluate(() => (window as any).copiedCommand)).not.toContain('git clone');
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } } }); });
  await page.getByRole('button', { name: '已复制命令' }).click();
  await expect(page.getByRole('status')).toHaveText('无法复制，请选择下方命令');
});

test('PAGE-04: mobile navigation and native FAQ remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  const menu = page.getByRole('button', { name: '打开导航' });
  await menu.click();
  await expect(page.getByRole('navigation', { name: '官网导航' })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: '开始部署' }).click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await page.getByText('电脑需要一直开着吗？', { exact: true }).click();
  await expect(page.getByText('需要保持程序运行、网络可用且系统未休眠。只熄屏可以继续，关机或休眠会暂停采集推送。', { exact: true })).toBeVisible();
});

test('PAGE-05: pre-rendered content survives no JavaScript and project-path assets resolve', async ({ browser, baseURL, request }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(baseURL!);
    await expect(page.getByRole('heading', { name: 'FeedRelay.', exact: true })).toBeVisible();
    await expect(page.locator('#install-command')).toContainText('npm ci');
    expect(await page.locator('.hero-product img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const response = await request.get(baseURL!);
    const html = await response.text();
    expect(html).toContain('自动采集视频、邮件和 RSS');
    expect(html).not.toMatch(/SESSION_SECRET=|IMAP_PASSWORD=|DEEPSEEK_API_KEY=|feedrelay\.sqlite/);
    for (const path of ['images/workspace.png', 'images/summary.png', 'images/daily.png', 'images/hero.png', 'images/hero-mobile.png', 'favicon.svg', 'sitemap.xml'])
      expect((await request.get(baseURL! + path)).ok()).toBe(true);
    for (const path of ['.env', 'data/feedrelay.sqlite', '../.env'])
      expect((await request.get(baseURL! + path)).status()).toBe(404);
  } finally { await context.close(); }
});
