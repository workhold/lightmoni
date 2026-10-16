import { mediaDirectory } from '../../../../scripts/qa-artifacts.mjs';
import { chromium, expect, request } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.LIGHTMONI_UI_URL ?? 'http://localhost:15174';
const center = process.env.LIGHTMONI_QA_CENTER_URL ?? 'http://localhost:18380';
const run = process.env.LIGHTMONI_QA_RUN ?? '1';
const output = resolve(import.meta.dirname, '../../../../docs/evidence/log-columns');
await mkdir(output, { recursive: true });
const mediaOutput=mediaDirectory(output);
const api = await request.newContext({ baseURL: center });
async function json(path, options) {
  const response = await api.fetch('/api/v1' + path, options);
  if (!response.ok()) throw new Error(path + ': ' + response.status());
  return response.json();
}
let browser;
try { browser = await chromium.launch({ headless: true }); }
catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
let context, page;
const checks = [], errors = [];
const shot = name => page.screenshot({ path: resolve(mediaOutput, `${run}-${name}.png`), fullPage: true, animations: 'disabled' });
try {
  await json('/auth/login', { method: 'POST', data: {
    name: process.env.LIGHTMONI_TEST_USER ?? 'local-admin',
    password: process.env.LIGHTMONI_TEST_PASSWORD ?? 'local-demo-password',
  } });
  const tables = await json('/catalog/tables');
  const table = tables.find(t => t.id === 'log_demo_app') ?? tables.find(t => t.kind === 'log');
  if (!table) throw new Error('A real log table is required');
  const spec = { table_id: table.id, range: {
    from: new Date(Date.now() - 86400000).toISOString(), to: new Date().toISOString(),
  }, services: [], keyword: '', filters: [], sort: 'desc', mode: 'filters', sql: '' };
  const data = await json('/logs/search', { method: 'POST', data: { spec, limit: 200 } });
  expect(data.frame.rows.length).toBeGreaterThan(0);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    storageState: await api.storageState() });
  await context.addInitScript(() => localStorage.setItem('lightmoni.appearance', 'dark'));
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const view = { columns: ['event_time', 'severity', 'service', 'body'],
    pinned: ['event_time'], widths: {}, lookback: 0 };
  const url = base + '/logs?' + new URLSearchParams({ table: table.id, ...spec.range,
    q: JSON.stringify({ v: 1, query: spec, view }) });
  await page.goto(url);
  const scroll = page.locator('.lm-log-table-scroll');
  const headers = page.locator('.lm-log-column-title > span:first-child');
  await expect(page.locator('.lm-log-message').first()).toBeVisible();
  await expect(page.locator('.lm-log-results .ant-table-cell-fix-left')).toHaveCount(0);
  await expect(page.locator('.lm-log-table-picker')).toHaveCSS('width', '260px');
  checks.push('旧链接的固定时间列设置不再锁列；表选择器加宽');

  for (const name of ['event_id', 'host_id', 'agent_id', 'key_id'])
    await page.getByRole('button', { name: '添加列 ' + name, exact: true }).click();
  await page.getByRole('button', { name: '上移列 body', exact: true }).click();
  await page.getByRole('button', { name: '下移列 event_time', exact: true }).click();
  let order = ['severity', 'event_time', 'body', 'service', 'event_id', 'host_id', 'agent_id', 'key_id'];
  await expect.poll(() => headers.allTextContents()).toEqual(order);
  await page.getByRole('button', { name: /列$/ }).click();
  const columns = page.getByRole('dialog', { name: '显示列与顺序' });
  await columns.locator('.lm-log-columns-config > div').filter({ hasText: 'key_id' })
    .getByRole('button', { name: /上\s*移$/, exact: true }).click();
  await columns.getByRole('button', { name: /完\s*成$/, exact: true }).click();
  order = [...order.slice(0, 6), 'key_id', 'agent_id'];
  await expect.poll(() => headers.allTextContents()).toEqual(order);
  const handle = page.getByRole('separator', { name: '调整 event_time 列宽', exact: true });
  await handle.press('ArrowRight');
  await page.reload();
  await expect(page.locator('.lm-log-message').first()).toBeVisible();
  await expect.poll(() => headers.allTextContents()).toEqual(order);
  await expect(page.getByRole('separator', { name: '调整 event_time 列宽', exact: true }))
    .toBeVisible();
  const widths = await page.locator('.lm-log-results .ant-table-thead .ant-table-cell')
    .evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().width)));
  expect(widths).toEqual([34, 110, 260, 360, 180, 280, 280, 280, 280]);
  checks.push('左侧和列设置调整顺序；调整列宽后刷新保留顺序及宽度');
  await shot('desktop');

  const position = () => page.evaluate(() => ({
    header: document.querySelector('.lm-log-column-title').getBoundingClientRect().x,
    body: document.querySelector('.ant-table-tbody-virtual .ant-table-cell:nth-child(2)').getBoundingClientRect().x,
    left: document.querySelector('.lm-log-table-scroll').scrollLeft,
  }));
  const before = await position();
  await scroll.hover();
  await page.mouse.wheel(550, 0);
  await expect.poll(async () => (await position()).left).toBeGreaterThan(400);
  const after = await position();
  expect(Math.abs((before.header - after.header) - (after.left - before.left))).toBeLessThan(2);
  expect(Math.abs((before.body - after.body) - (after.left - before.left))).toBeLessThan(2);
  await expect(page.locator('.lm-log-results .ant-table-cell-fix-left')).toHaveCount(0);
  await page.mouse.wheel(-200, 0);
  await expect.poll(async () => (await position()).left).toBeLessThan(after.left - 100);
  const left = (await position()).left;
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 120);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await position()).left).toBeGreaterThan(left + 50);
  const holder = page.locator('.ant-table-tbody-virtual-holder');
  await holder.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => holder.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  await shot('scrolled');
  checks.push('左右滚动、Shift+滚轮和纵向虚拟滚动有效，表头与数据行移动同样距离，无固定列');
  const body = await page.locator('.lm-log-message').first().innerText();
  await page.locator('.lm-log-message').first().click();
  const detail = page.getByRole('dialog', { name: /日志详情/ });
  await expect(detail.locator('.lm-log-body')).toContainText(body);
  await detail.locator('.ant-drawer-close').click();
  const query = page.waitForResponse(response => response.url().endsWith('/logs/search'));
  await page.getByRole('button', { name: '查询', exact: true }).click();
  expect((await query).ok()).toBe(true);
  await expect.poll(() => scroll.evaluate(node => node.scrollLeft)).toBe(0);
  await expect.poll(() => headers.allTextContents()).toEqual(order);
  checks.push('滚动后打开真实日志详情有效，重新查询回到最左侧并保留列顺序');

  await page.setViewportSize({ width: 750, height: 950 });
  const collapse = page.getByRole('button', { name: '收起导航', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await expect(page.locator('.lm-shell')).toHaveClass(/is-nav-collapsed/);
  await expect.poll(() => headers.allTextContents()).toEqual(order);
  const narrowWidths = await page.locator('.lm-log-results .ant-table-thead .ant-table-cell')
    .evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().width)));
  expect(narrowWidths).toEqual(widths);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await scroll.evaluate(node => { node.scrollLeft = 0; });
  await scroll.press('ArrowRight');
  await expect.poll(() => scroll.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  await shot('narrow');
  checks.push('750px 窄屏保留全部已选列和固定宽度，键盘横向滚动有效，页面无横向溢出');

  // Only the catalog label is lengthened to exercise overflow; all log responses
  // remain real. This fixture never modifies the catalog or stored data.
  const longName = table.name + '_production_payment_events_with_similar_table_names_2026_10_12';
  await page.route('**/api/v1/catalog/tables', route => route.fulfill({ json:
    tables.map(t => t.id === table.id ? { ...t, name: longName } : t) }));
  await page.reload();
  await expect(page.locator('.lm-log-table-name')).toHaveText(longName);
  await page.locator('.lm-log-table-picker').hover();
  await expect(page.getByRole('tooltip', { name: longName, exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '日志表', exact: true }).click();
  const option = page.locator('.lm-log-table-option').filter({ hasText: longName });
  await expect(option).toBeVisible();
  await page.mouse.move(720, 250);
  await expect(page.getByRole('tooltip', { name: longName, exact: true })).toBeHidden();
  await expect.poll(async () => (await option.boundingBox())?.height ?? 0).toBeGreaterThan(30);
  expect(await option.evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true);
  expect(await option.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await shot('long-table-name');
  checks.push('超长表名悬停显示全文，下拉列表换行完整展示（仅目录名称使用长度测试数据）');
  expect(errors).toEqual([]);
  await writeFile(resolve(output, `${run}-report.json`), JSON.stringify({ run, passed: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ run, passed: true, checks }));
} catch (error) {
  await page?.screenshot({ path: resolve(mediaOutput, `${run}-failure.png`), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, `${run}-report.json`), JSON.stringify({ run, passed: false, checks, errors, error: String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser.close();
  await api.dispose();
}
