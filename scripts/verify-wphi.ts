import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from 'playwright/test';
import { createServer, startLocalServer } from '../server/src/app';
import { createWphiDataset } from '../server/src/domain/wphi-demo';

declare global {
  interface Window {
    wphiMotion: Record<string, { stagger: boolean; pulse: boolean }>;
  }
}

// Isolated data and no state path: browser verification never changes saved operator settings.
const dataset = createWphiDataset();
const server = startLocalServer(createServer({ dataset, staticDirectory: resolve('dist') }), { port: 0, log: () => undefined });
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw Error('Missing server address');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
mkdirSync(resolve('test-results/wphi'), { recursive: true });
// Evaluate browser-side code directly so the TypeScript runner adds no Node-side helpers.
await page.addInitScript({ content: `
  window.wphiMotion = {};
  function scaleOf(element) {
    const transform = getComputedStyle(element).transform;
    return new DOMMatrixReadOnly(transform === 'none' ? undefined : transform).a;
  }
  function sample() {
    const root = document.querySelector('.wphi-dashboard[data-health-dimension-motion-complete="false"]');
    if (root) {
      const pageKey = root.classList.contains('overview-page') ? 'overview' : 'health';
      const observed = window.wphiMotion[pageKey] ??= { stagger: false, pulse: false };
      const fills = Array.from(root.querySelectorAll('[data-dimension-fill]'), scaleOf);
      const tips = Array.from(root.querySelectorAll('[data-dimension-tip]'), scaleOf);
      if (fills.length === 7 && fills[0] > 0.15 && fills[0] - fills[6] > 0.15) observed.stagger = true;
      if (tips.some(scale => scale > 1.08)) observed.pulse = true;
    }
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
` });

async function verifyScoreLayout(pageKey: 'overview' | 'health', rowSelector: string) {
  const dashboard = page.locator('.wphi-dashboard');
  await expect(dashboard).toHaveAttribute('data-health-dimension-motion-complete', 'true');
  expect(errors).toEqual([]);
  expect(await page.evaluate(key => window.wphiMotion[key], pageKey)).toEqual({ stagger: true, pulse: true });
  await expect(dashboard.locator('[data-dimension-score]')).toHaveText(['90.00', '100.00', '86.00', '100.00', '100.00', '98.44', '100.00']);
  await expect(dashboard.locator('.health-ring-score')).toHaveCSS('font-size', '42px');
  await expect(dashboard.getByText(/等权|权重/)).toHaveCount(0);
  for (const width of [1920, 1440, 1366]) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 900 });
    if (pageKey === 'overview') {
      const trend = await dashboard.locator('.overview-trend').boundingBox();
      const details = await page.locator('.wphi-details').boundingBox();
      expect(details!.y, `overview configuration below trend at ${width}px`).toBeGreaterThanOrEqual(trend!.y + trend!.height);
    }
    const aligned = await dashboard.locator(rowSelector).evaluateAll(rows => {
      return rows.length === 7 && rows.every(row => {
        const panel = row.closest('.glass-panel')!.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        const meter = row.querySelector('.health-dimension-meter')!.getBoundingClientRect();
        const score = row.querySelector('[data-dimension-score]')!.getBoundingClientRect();
        const label = row.querySelector('.dimension-row__label');
        const icon = row.querySelector('b')!.getBoundingClientRect();
        const labelRect = label?.getBoundingClientRect();
        return rect.bottom < panel.bottom && rect.right < panel.right
          && Math.abs((meter.top + meter.bottom - score.top - score.bottom) / 2) < 1
          && (!labelRect || Math.abs((icon.top + icon.bottom - labelRect.top - labelRect.bottom) / 2) < 1);
      });
    });
    expect(aligned, `${pageKey} score rows at ${width}px`).toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 ? [] :
      Array.from(document.querySelectorAll('body *')).flatMap(element => {
        const rect = element.getBoundingClientRect();
        return rect.right > innerWidth + 1 && rect.width > 0
          ? [{ name: element.tagName, className: element.getAttribute('class'), right: Math.round(rect.right) }]
          : [];
      }).slice(0, 10));
    expect(overflow, `${pageKey} horizontal overflow at ${width}px`).toEqual([]);
    if (width === 1920) await page.screenshot({ path: resolve(`test-results/wphi/${pageKey}.png`) });
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
}

try {
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('button', { name: '进入智慧中枢' }).click();
  await expect(page.getByRole('heading', { name: '运行总览', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '健康指数 96.35' })).toBeVisible();
  await expect(page.getByRole('img', { name: '近30日健康趋势图' })).toBeVisible();
  await verifyScoreLayout('overview', '.dimension-row');
  await page.getByRole('button', { name: /健康指数/ }).click();
  await expect(page.getByRole('heading', { name: '健康指数得分', exact: true })).toBeVisible();
  await expect(page.getByTestId('wphi-cv')).toContainText('CV 20.00% · 目标 15%');
  await expect(page.getByText('七维度算术平均', { exact: true })).toBeVisible();
  await expect(page.getByText('运行风险低')).toBeVisible();
  await expect(page.getByRole('img', { name: '近30日健康指数柱状趋势' })).toBeVisible();
  await verifyScoreLayout('health', '.health-dimension');

  await page.getByText('评分配置与每日运行上报', { exact: true }).click();
  await expect(page.getByRole('button', { name: '保存评分配置' })).toBeEnabled();
  await page.getByRole('spinbutton', { name: '出水总氮 mg/L', exact: true }).fill('6');
  await page.getByRole('button', { name: '保存评分配置' }).click();
  await expect(page.getByText('保存成功', { exact: true })).toBeVisible();
  await expect(page.locator('.wphi-metrics tr').filter({ hasText: '出水总氮' }).first().locator('td').last()).toHaveText('6');
  await page.getByRole('combobox', { name: '系统运行状态' }).selectOption('false');
  await expect(page.getByRole('button', { name: '保存运行日报' })).toBeDisabled();
  await page.getByRole('textbox', { name: '异常原因' }).fill('设备巡检发现异常');
  await page.getByRole('button', { name: '保存运行日报' }).click();
  await expect(page.locator('.health-dimension').filter({ hasText: '系统稳定' })).toContainText('96.67');

  await page.getByRole('checkbox', { name: '检修模式' }).check();
  await page.getByRole('button', { name: '保存评分配置' }).click();
  await expect(page.getByText('当前水厂处于【检修模式】，健康评分已主动暂停')).toBeVisible();
  await expect(page.getByRole('img', { name: /健康指数/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '实际运行值与目标' })).toBeVisible();
  await page.screenshot({ path: resolve('test-results/wphi/maintenance.png'), fullPage: true });
  await page.getByRole('checkbox', { name: '检修模式' }).uncheck();
  await page.getByRole('button', { name: '保存评分配置' }).click();
  await expect(page.getByRole('img', { name: /^健康指数 \d/ })).toBeVisible();
  await expect(page.locator('.wphi-dashboard')).toHaveAttribute('data-health-dimension-motion-complete', 'true');
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.getByText('评分配置与每日运行上报', { exact: true }).click();
  await page.screenshot({ path: resolve('test-results/wphi/desktop-compact.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
  console.log('WPHI browser verification passed: seven aligned scores, original meter animations, targets, daily report, maintenance and recovery.');
} finally {
  await browser.close();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
