import { chromium, expect, request } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mediaDirectory } from '../../../../scripts/qa-artifacts.mjs';

const base = process.env.LIGHTMONI_UI_URL ?? 'http://127.0.0.1:5173';
const center = process.env.LIGHTMONI_QA_CENTER_URL ?? base;
const run = process.env.LIGHTMONI_QA_RUN ?? '1';
const output = resolve(import.meta.dirname, '../../../../docs/evidence/log-discover');
const media = mediaDirectory(output);
await mkdir(output, { recursive: true });
const api = await request.newContext({ baseURL: center });
let browser, context, page;
const checks = [], errors = [], queries = [];
async function settle() {
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
    animation.effect?.getComputedTiming().iterations !== Infinity).every(animation => animation.playState !== 'running'))).toBe(true);
}
async function shot(name) {
  await settle();
  return page.screenshot({ path: resolve(media, `${run}-${name}.png`), fullPage: !/panel|values|document|fields/.test(name) });
}
async function searchAfter(action) {
  const response = page.waitForResponse(response => response.url().endsWith('/logs/search') && response.request().method() === 'POST');
  const [result] = await Promise.all([response, action()]);
  expect(result.ok()).toBe(true);
  return result.json();
}
async function choose(label, value) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByText(value, { exact: true }).last().click();
}
try {
  const login = await api.post('/api/v1/auth/login', { data: {
    name: process.env.LIGHTMONI_TEST_USER ?? 'local-admin',
    password: process.env.LIGHTMONI_TEST_PASSWORD ?? 'local-demo-password',
  } });
  expect(login.ok()).toBe(true);
  const tables = await (await api.get('/api/v1/catalog/tables')).json();
  const table = tables.find(table => table.id === 'log_demo_app') ?? tables.find(table => table.kind === 'log');
  if (!table) throw new Error('A real log table is required');
  const range = { from: new Date(Date.now() - 7 * 86400000).toISOString(), to: new Date().toISOString() };
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: await api.storageState(),
    recordVideo: { dir: media, size: { width: 1440, height: 1000 } } });
  await context.addInitScript(() => { localStorage.setItem('lightmoni.appearance', 'light'); localStorage.setItem('lightmoni.nav.collapsed', 'true'); });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/logs/search')) queries.push(request.postDataJSON()); });
  const url = base + '/logs?' + new URLSearchParams({ table: table.id, ...range });
  await page.goto(url);
  await expect(page.locator('.lm-log-message').first()).toBeVisible();
  await expect(page.locator('.lm-log-histogram canvas')).toBeVisible();
  await choose('时间图拆分', '按级别拆分');
  await choose('时间图拆分', '不拆分');
  await shot('desktop-light');
  checks.push('真实 API 日志、匹配数、时间分布和虚拟表格加载成功');

  // A field opens beside the rail; its actions query the same data source.
  await page.locator('.lm-log-field > button[title="severity"]').click();
  await expect(page.locator('.lm-log-top-values .lm-log-value-row').first()).toBeVisible();
  await shot('field-values');
  await page.getByRole('button', { name: '关闭字段统计', exact: true }).click();
  await page.getByRole('button', { name: '筛选字段类型', exact: true }).click();
  await choose('字段类型', '数字');
  await expect(page.locator('.lm-log-field-list .lm-log-field')).not.toHaveCount(0);
  const kinds = await page.locator('.lm-log-field-list .lm-log-field-type').evaluateAll(nodes => nodes.map(node => node.title));
  expect(kinds.every(kind => kind === '数字')).toBe(true);
  await choose('字段类型', '全部类型');
  await page.getByRole('button', { name: '筛选字段类型', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索字段', exact: true }).fill('source id');
  await expect(page.locator('.lm-log-field-list .lm-log-field')).toHaveCount(2);
  await page.getByRole('textbox', { name: '搜索字段', exact: true }).fill('');
  checks.push('字段 Top 值弹层、类型筛选、多词字段搜索可用');

  await page.locator('.lm-log-field').filter({ has: page.locator('button[title="host_id"]') }).dragTo(page.locator('.lm-log-results'));
  await expect(page.locator('.lm-log-column-title > span:first-child').filter({ hasText: /^host_id$/ })).toHaveCount(1);
  await page.getByRole('button', { name: '列操作 host_id', exact: true }).click();
  await page.getByRole('menuitem', { name: '向左移动', exact: true }).click();
  await expect.poll(() => page.locator('.lm-log-column-title > span:first-child').allTextContents()).toEqual(['event_time', 'severity', 'service', 'host_id', 'body']);
  await page.getByRole('button', { name: '列操作 host_id', exact: true }).click();
  await page.getByRole('menuitem', { name: '移除此列', exact: true }).click();
  const sorted = await searchAfter(() => page.getByRole('button', { name: '切换时间排序', exact: true }).click());
  expect(queries.at(-1).spec.sort).toBe('asc');
  expect(sorted.frame.rows.length).toBeGreaterThan(0);
  checks.push('拖动字段加列、表头菜单移动/移除列、时间排序均生效');

  await page.getByRole('button', { name: '表格显示选项', exact: true }).click();
  await choose('表格密度', '宽松');
  await choose('日志行数', '三行');
  await page.getByRole('button', { name: '表格显示选项', exact: true }).click();
  await page.reload();
  await expect(page.locator('.lm-log-table-scroll')).toHaveClass(/is-comfortable/);
  await expect(page.locator('.lm-log-message').first()).toHaveClass(/is-wrapped/);
  checks.push('表格密度与行高在刷新后恢复');

  await page.locator('.lm-log-message').first().click();
  const detail = page.getByRole('dialog', { name: /日志详情/ });
  await expect(detail.getByRole('tab', { name: '表格', exact: true })).toHaveAttribute('aria-selected', 'true');
  await detail.getByRole('textbox', { name: '搜索文档字段和值', exact: true }).fill('trace');
  await expect(detail.locator('.lm-discover-document-fields .ant-table-tbody > tr.ant-table-row')).toHaveCount(1);
  await detail.getByRole('tab', { name: 'JSON', exact: true }).click();
  await expect(detail.locator('.lm-log-json-node').first()).toBeVisible();
  await detail.locator('.ant-drawer-close').click();
  checks.push('文档详情默认字段表格、字段/值搜索与 JSON 切换有效');

  const service = page.locator('.lm-log-inline-filter').filter({ hasText: String(table.services[0]) }).first();
  await service.hover();
  const filtered = await searchAfter(() => service.locator('..').locator('..').getByRole('button', { name: '排除单元格 service', exact: true }).click());
  expect(queries.at(-1).spec.filters.some(filter => filter.field === 'service' && filter.op === 'ne')).toBe(true);
  await page.getByRole('button', { name: '管理所有过滤', exact: true }).click();
  await searchAfter(() => page.getByRole('menuitem', { name: '禁用所有过滤', exact: true }).click());
  expect(queries.at(-1).spec.filters.every(filter => filter.disabled)).toBe(true);
  await page.getByRole('button', { name: '管理所有过滤', exact: true }).click();
  await searchAfter(() => page.getByRole('menuitem', { name: '移除所有过滤', exact: true }).click());
  await expect(page.locator('.lm-log-message').first()).toBeVisible();
  checks.push('单元格排除生成真实条件，批量禁用和移除过滤更新查询');

  await page.getByRole('button', { name: '时间范围', exact: true }).click();
  await expect(page.getByRole('tab', { name: '快速选择', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '快速选择', exact: true }).click();
  await expect(page.getByRole('tab', { name: '快速选择', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.lm-discover-time-presets')).toBeVisible();
  await shot('time-panel');
  await searchAfter(() => page.getByRole('button', { name: '最近 7 天', exact: true }).click());
  expect(Date.parse(queries.at(-1).spec.range.to) - Date.parse(queries.at(-1).spec.range.from)).toBe(7 * 86400000);
  const currentRange = queries.at(-1).spec.range;
  await searchAfter(() => page.getByRole('button', { name: '上一个时间段', exact: true }).click());
  expect(queries.at(-1).spec.range.to).toBe(currentRange.from);
  await searchAfter(() => page.getByRole('button', { name: '下一个时间段', exact: true }).click());
  expect(queries.at(-1).spec.range).toEqual(currentRange);
  await page.getByRole('button', { name: '时间范围', exact: true }).click();
  await page.getByRole('tab', { name: '绝对时间', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '绝对开始时间', exact: true })).toBeVisible();
  await shot('absolute-time-panel');
  await searchAfter(() => page.getByRole('button', { name: '应用时间范围', exact: true }).click());
  expect(queries.at(-1).spec.range).toEqual(currentRange);
  checks.push('快捷范围自动查询、前后时间段平移、绝对时间应用保留毫秒精度');

  await page.getByRole('button', { name: '全屏查看', exact: true }).click();
  await expect(page.locator('.lm-logs-page')).toHaveClass(/is-fullscreen/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.lm-logs-page')).not.toHaveClass(/is-fullscreen/);
  await page.getByRole('button', { name: '收起时间图', exact: true }).click();
  await expect(page.locator('.lm-log-histogram')).toHaveCount(0);
  await page.getByRole('button', { name: '展开时间图', exact: true }).click();
  await expect(page.locator('.lm-log-histogram canvas')).toBeVisible();
  checks.push('全屏 / Esc 退出、时间图折叠与展开可用');

  await page.route('**/api/v1/logs/search', route => route.fulfill({ status: 503, json: { error: '查询暂时不可用' } }));
  await page.getByRole('combobox', { name: '日志关键词', exact: true }).fill('preserve-this-query');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByText('保留了检索条件；上次结果仅供参考。')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '日志关键词', exact: true })).toHaveValue('preserve-this-query');
  await expect(page.locator('.lm-log-message').first()).toBeVisible();
  await page.unroute('**/api/v1/logs/search');
  await page.getByRole('combobox', { name: '日志关键词', exact: true }).fill('');
  await searchAfter(() => page.getByRole('button', { name: '查询', exact: true }).click());
  checks.push('查询失败保留输入和上次结果，重试可恢复');

  // No saved resource is written: failure and readback are isolated at these routes.
  await page.route('**/api/v1/logs/saved-searches', route => route.request().method() === 'POST'
    ? route.fulfill({status:503,json:{error:'无法保存检索'}}) : route.continue());
  await page.getByRole('button', {name:'保存检索',exact:true}).click();
  const saveDialog = page.getByRole('dialog', {name:'保存检索',exact:true});
  await saveDialog.getByRole('textbox', {name:'检索名称',exact:true}).fill('保留检索名称');
  await saveDialog.getByRole('button', {name:'保 存',exact:true}).click();
  await expect(page.getByText('无法保存检索', {exact:true})).toBeVisible();
  await expect(saveDialog.getByRole('textbox', {name:'检索名称',exact:true})).toHaveValue('保留检索名称');
  await saveDialog.locator('.ant-modal-close').click();
  await page.unroute('**/api/v1/logs/saved-searches');
  const savedQuery = queries.at(-1).spec;
  const savedView = JSON.parse(new URL(page.url()).searchParams.get('q')).view;
  await page.route('**/api/v1/logs/saved-searches/qa-discover', route => route.fulfill({json:{
    id:'qa-discover',title:'QA 只读检索',spec:savedQuery,view:savedView,revision:1,updated_at:new Date().toISOString(),
  }}));
  await page.goto(base + '/logs?' + new URLSearchParams({table:table.id,saved:'qa-discover'}));
  await expect(page.locator('.lm-log-title')).toContainText('QA 只读检索');
  await expect(page.locator('.lm-log-message').first()).toBeVisible();
  const otherTable = tables.find(item => item.kind === 'log' && item.id !== table.id);
  if (otherTable) {
    await searchAfter(() => choose('日志表', otherTable.name));
    await expect(page.locator('.lm-log-title')).toContainText('未保存的检索');
    expect(queries.at(-1).spec.table_id).toBe(otherTable.id);
  }
  await page.goto(url);
  await expect(page.locator('.lm-log-message').first()).toBeVisible();
  await expect(page.getByText('无法保存检索', {exact:true})).toBeHidden();
  checks.push('保存失败保留名称；只读保存检索重开，切换数据视图解除旧保存关联（未写入保存资源）');

  await shot('desktop-final');
  await page.setViewportSize({ width: 750, height: 950 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '字段', exact: true }).click();
  await expect(page.locator('.lm-log-fields-mobile')).toBeVisible();
  await shot('narrow-fields');
  await page.getByRole('dialog').locator('.ant-drawer-close').click();
  await expect(page.locator('.lm-log-fields-mobile')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot('mobile');
  checks.push('750px 字段抽屉与 390px 页面无横向溢出');
  await context.close();
  await page.video()?.saveAs(resolve(media, `${run}-interactions.webm`));
  await page.video()?.delete();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: await api.storageState() });
  await context.addInitScript(() => { localStorage.setItem('lightmoni.appearance', 'dark'); localStorage.setItem('lightmoni.nav.collapsed', 'true'); });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('.lm-log-message').first()).toBeVisible();
  await shot('desktop-dark');
  await page.getByRole('button', { name: '时间范围', exact: true }).click();
  await expect(page.getByRole('tab', { name: '绝对时间', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: '绝对开始时间', exact: true })).toBeVisible();
  await shot('dark-time-panel');
  await page.getByRole('button', { name: '时间范围', exact: true }).click();
  await expect(page.locator('.lm-discover-time-panel')).toBeHidden();
  await page.locator('.lm-log-open-detail').first().click();
  await expect(page.getByRole('dialog', {name:/日志详情/})).toBeVisible();
  await expect(page.getByRole('textbox', {name:'搜索文档字段和值',exact:true})).toBeVisible();
  await shot('dark-document');
  await page.getByRole('dialog', {name:/日志详情/}).locator('.ant-drawer-close').click();
  await expect(page.getByRole('textbox', {name:'搜索文档字段和值',exact:true})).toBeHidden();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button', {name:'字段',exact:true}).click();
  await expect(page.locator('.lm-log-fields-mobile')).toBeVisible();
  await shot('mobile-fields');
  checks.push('深色主题的主页面、时间面板、文档详情完成截图检查');
  await context.close();
  context = await browser.newContext({viewport:{width:720,height:500},deviceScaleFactor:2,storageState:await api.storageState()});
  await context.addInitScript(() => {localStorage.setItem('lightmoni.appearance','light');localStorage.setItem('lightmoni.nav.collapsed','true');});
  page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('.lm-log-message').first()).toBeVisible();
  await shot('zoom-200');
  checks.push('200% 等效布局（720 CSS px / 1440 输出像素）取证');
  expect(errors).toEqual([]);
  await writeFile(resolve(output, `${run}-report.json`), JSON.stringify({ passed: true, run, checks, errors, excludedResponseRows: filtered.frame.rows.length }, null, 2));
  console.log(JSON.stringify({ passed: true, run, checks }));
} catch (error) {
  if (page) await shot('failure').catch(() => {});
  await writeFile(resolve(output, `${run}-report.json`), JSON.stringify({ passed: false, run, checks, errors, error: String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
  await api.dispose();
}
