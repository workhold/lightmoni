import {chromium, expect} from '@playwright/test';
import {createServer} from 'vite';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, relative} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const out = resolve(root, 'specs/051-dns-bulk-record-actions/evidence'), media = mediaDirectory(out);
await mkdir(out, {recursive: true});
// Every API call is intercepted. This suite never contacts a cloud DNS provider.
const now = new Date().toISOString(), writes = [], checks = [], errors = [];
let records = [], serial = 100, role = 'admin', hold, release;
function reset(count = 41) {records = Array.from({length: count}, (_, i) => ({id: String(i + 1), name: 'host-' + String(i + 1).padStart(2, '0'), type: 'A', value: '192.0.2.' + (i + 1), ttl: 900, line: 'telecom', line_id: '10=0', priority: 10, weight: 7, enabled: i !== 0}));}
reset();
const zone = {id: 'zone', kind: 'dns_zone', name: '测试域名', revision: 3, spec: {domain: 'example.test', scope: 'example.test'}, status: {state: 'observed'}, created_at: now, updated_at: now};
const vite = await createServer({root: resolve(root, 'web'), configFile: resolve(root, 'web/vite.config.ts'), server: {host: '127.0.0.1', port: 0}, logLevel: 'error'});
await vite.listen(); const base = vite.resolvedUrls.local[0];
let browser;
try {browser = await chromium.launch({headless: true});} catch {browser = await chromium.launch({headless: true, channel: 'chrome'});}
const context = await browser.newContext({viewport: {width: 1440, height: 1000}}), page = await context.newPage();
page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
await context.addInitScript(() => {if (!localStorage.getItem('lightmoni.language')) localStorage.setItem('lightmoni.language', 'zh-CN'); localStorage.setItem('lightmoni.appearance', 'light');});
await page.route('**/api/v1/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', '');
  let body = {}, status = 200;
  if (path === '/auth/me') body = {id: 'qa-admin', name: 'DNS QA', role};
  else if (path === '/ops/overview') body = {resources: [zone], agents: [], machines: [], runs: []};
  else if (path === '/ops/resources/zone/records') {
    const url = new URL(request.url()), keyword = url.searchParams.get('keyword') ?? '', offset = Number(url.searchParams.get('offset'));
    const filtered = records.filter(r => r.name.includes(keyword) || r.value.includes(keyword)); body = {records: filtered.slice(offset, offset + 20), total: filtered.length};
  } else if (path === '/ops/resources/zone/actions') {
    const input = request.postDataJSON(); writes.push(structuredClone(input));
    if (hold) {const waiting = hold; hold = undefined; await waiting;}
    const record = input.input.record;
    const state = record?.value === 'reject' ? 'failed' : record?.value === 'unknown' ? 'unknown' : 'succeeded';
    if (state === 'succeeded' && record?.value !== 'verify') {
      if (input.action === 'create_record') records.push({...record, id: String(++serial)});
      if (input.action === 'update_record') Object.assign(records.find(r => r.id === record.id), record);
      if (input.action === 'delete_record') records = records.filter(r => r.id !== input.input.id);
    }
    body = {run: {id: 'run-' + writes.length, state, result: state === 'failed' ? {code: 'provider_rejected'} : record?.value === 'verify' ? {verified: false, state: 'verifying'} : {verified: true}}}; status = 202;
  }
  await route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
});
const drawer = () => page.locator('.ant-drawer:visible').last(), modal = () => page.locator('.ant-modal:visible').last();
const button = (scope, name) => scope.getByRole('button', {name: /^[一-鿿]{2}$/.test(name) ? new RegExp('^' + name[0] + '\\s*' + name[1] + '$') : name, exact: true}).and(scope.locator('.ant-btn'));
async function open() {await page.goto(base + 'domains'); await button(page, '解析记录').click(); await expect(drawer().locator('tr[data-row-key="1"]')).toBeVisible();}
async function check(id) {await drawer().locator('tr[data-row-key="' + id + '"]').getByRole('checkbox').check();}
async function choose(label, value) {await modal().getByLabel(label, {exact: true}).click(); await page.locator('.ant-select-dropdown:visible').getByText(value, {exact: true}).click();}
async function closeResult() {await button(modal(), '关闭').click(); await expect(modal()).toHaveCount(0);}
async function shot(name) {await expect(page.locator('.ant-message-notice')).toHaveCount(0); await page.screenshot({path: resolve(media, name + '.png'), animations: 'disabled'});}
try {
  await open(); await expect(button(drawer(), '批量修改')).toBeDisabled();
  await check('1'); await drawer().locator('.ant-pagination-next').click(); await check('21');
  await expect(drawer().getByText('已选择 2 / 50', {exact: true})).toBeVisible();
  await button(drawer(), '批量删除').click(); await expect(modal().getByText('host-01', {exact: true})).toBeVisible(); await expect(modal().getByText('host-21', {exact: true})).toBeVisible();
  await button(modal(), '取消').click(); expect(writes).toHaveLength(0);
  await button(drawer(), '清空选择').click(); await drawer().locator('.ant-pagination-prev').click();
  await check('1'); await check('2'); await button(drawer(), '批量修改').click();
  await modal().getByLabel('修改记录值', {exact: true}).uncheck(); await choose('新解析类型', 'TXT'); await button(modal(), '确认修改').click(); await expect(button(modal(), '关闭')).toBeEnabled();
  expect(records[0]).toMatchObject({type: 'TXT', value: '192.0.2.1', ttl: 900, line_id: '10=0', priority: 10, weight: 7, enabled: false}); expect(records[1].type).toBe('TXT');
  expect(writes.slice(-2).every(w => w.revision === 3 && w.confirmed)).toBe(true); await closeResult();
  await expect(drawer().getByText('已选择 0 / 50', {exact: true})).toBeVisible();
  await check('2'); await button(drawer(), '批量修改').click(); await modal().getByLabel('修改解析类型', {exact: true}).uncheck(); await modal().getByLabel('新记录值', {exact: true}).fill('new-value'); await button(modal(), '确认修改').click(); await expect(button(modal(), '关闭')).toBeEnabled(); expect(records[1]).toMatchObject({type: 'TXT', value: 'new-value'}); await closeResult();
  checks.push('跨页选择、固定删除目标、取消零写入；仅改类型/仅改value保留TTL、线路、权重、状态及逐请求revision/confirmed');

  await button(drawer(), '批量创建').click(); await modal().getByLabel('主机记录', {exact: true}).fill('multi'); await modal().getByLabel('线路（可选）', {exact: true}).fill('telecom');
  await modal().getByLabel('记录值（每行一个 value）', {exact: true}).fill('203.0.113.10\n\n203.0.113.11\n203.0.113.10'); await expect(modal().getByText('本次记录数: 2', {exact: true})).toBeVisible(); await shot('create-preview-desktop');
  const beforeCreate = writes.length;
  await button(modal(), '确认创建').evaluate(element => {element.click(); element.click();});
  await expect(button(modal(), '关闭')).toBeEnabled(); expect(writes.length - beforeCreate).toBe(2); expect(records.filter(r => r.name === 'multi')).toHaveLength(2); expect(records.slice(-2).every(r => r.line === 'telecom')).toBe(true); await closeResult();
  checks.push('同一主机/类型/线路多value创建，忽略空行与去重，预览2条，双击只发2次请求');

  await button(drawer(), '批量创建').click(); await modal().getByLabel('记录值（每行一个 value）', {exact: true}).fill(Array.from({length: 51}, (_, i) => String(i)).join('\n')); const beforeLimit = writes.length; await button(modal(), '确认创建').click(); await expect(modal().getByText('请输入 1–50 个不同 value，每个最多 4096 字符。', {exact: true})).toBeVisible(); expect(writes.length).toBe(beforeLimit);
  await modal().getByLabel('记录值（每行一个 value）', {exact: true}).fill('reject\nunknown\nverify'); await button(modal(), '确认创建').click(); await expect(button(modal(), '关闭')).toBeEnabled(); await expect(modal().getByText('provider_rejected', {exact: true})).toBeVisible(); await expect(modal().getByText('结果未知', {exact: true}).first()).toBeVisible(); await expect(modal().getByText('待回读', {exact: true}).first()).toBeVisible(); expect(writes.length - beforeLimit).toBe(3); await shot('partial-results'); await closeResult();
  checks.push('51条阻止提交；202失败、未知和待回读分别显示，继续后续且无自动重试');

  await button(drawer(), '批量创建').click(); await modal().getByLabel('记录值（每行一个 value）', {exact: true}).fill('192.0.2.100\n192.0.2.101');
  hold = new Promise(done => {release = done;}); const beforeStop = writes.length; await button(modal(), '确认创建').click(); await expect.poll(() => writes.length).toBe(beforeStop + 1); await expect(button(modal(), '关闭')).toBeDisabled(); await page.keyboard.press('Escape'); await expect(modal()).toBeVisible(); await button(modal(), '停止后续').click(); release(); await expect(button(modal(), '关闭')).toBeEnabled(); expect(writes.length).toBe(beforeStop + 1); await expect(modal().getByText('未执行', {exact: true}).first()).toBeVisible(); await closeResult();
  checks.push('执行锁定关闭/输入，停止只跳过未发出的记录');

  reset(); await open(); await drawer().locator('.ant-pagination-item-3').click(); await expect(drawer().locator('tr[data-row-key="41"]')).toBeVisible(); await drawer().locator('.ant-table-thead').getByRole('checkbox').check(); await button(drawer(), '批量删除').click(); await button(modal(), '确认删除').click(); await expect(button(modal(), '关闭')).toBeEnabled(); await closeResult(); expect(records).toHaveLength(40); await expect(drawer().locator('tr[data-row-key="21"]')).toBeVisible();
  await check('21'); const search = drawer().getByPlaceholder('搜索主机名或记录值', {exact: true}); await search.fill('host-22'); await search.press('Enter'); await expect(drawer().getByText('已选择 0 / 50', {exact: true})).toBeVisible(); await expect(drawer().locator('tr[data-row-key="22"]')).toBeVisible(); await check('22'); await button(drawer(), '同步记录').click(); await expect(drawer().getByText('已选择 0 / 50', {exact: true})).toBeVisible();
  checks.push('当前页全选、批量删除、删除末页回退、搜索和同步清空选择');

  reset(61); await open(); await drawer().locator('.ant-table-thead').getByRole('checkbox').check(); await drawer().locator('.ant-pagination-next').click(); await drawer().locator('.ant-table-thead').getByRole('checkbox').check(); await drawer().locator('.ant-pagination-next').click(); await drawer().locator('.ant-table-thead').getByRole('checkbox').check(); await expect(drawer().getByText('已选择 50 / 50', {exact: true})).toBeVisible(); await expect(drawer().locator('tr[data-row-key="51"]').getByRole('checkbox')).toBeDisabled();
  await button(drawer(), '批量修改').click(); await modal().getByLabel('修改解析类型', {exact: true}).uncheck(); await modal().getByLabel('修改记录值', {exact: true}).uncheck(); const beforeFields = writes.length; await button(modal(), '确认修改').click(); await expect(modal().getByText('至少选择一个要修改的字段。', {exact: true})).toBeVisible(); expect(writes.length).toBe(beforeFields); await button(modal(), '取消').click();
  checks.push('跨页全选限制50条，零修改字段阻止提交');

  // Existing single-record operations remain available.
  reset(); await open(); await button(drawer().locator('tr[data-row-key="1"]'), '编辑').click(); await modal().getByLabel('记录值', {exact: true}).fill('192.0.2.99'); await button(modal(), '保存并更新 DNS').click(); await expect(modal()).toHaveCount(0); expect(records[0]).toMatchObject({value: '192.0.2.99', line_id: '10=0', weight: 7, enabled: false});
  await button(drawer(), '新增记录').click(); await modal().getByLabel('主机记录', {exact: true}).fill('single'); await modal().getByLabel('记录值', {exact: true}).fill('192.0.2.100'); await button(modal(), '保存并更新 DNS').click(); await expect(modal()).toHaveCount(0); expect(records.some(r => r.name === 'single')).toBe(true);
  checks.push('单条创建/编辑保留可用，编辑保留线路ID、权重及停用状态');

  await button(drawer(), '批量创建').click(); await page.setViewportSize({width: 390, height: 844}); await modal().getByLabel('记录值（每行一个 value）', {exact: true}).fill('203.0.113.1\n203.0.113.2'); await expect(button(modal(), '确认创建')).toBeInViewport(); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await shot('create-preview-390'); await button(modal(), '取消').click(); await drawer().locator('.ant-drawer-close').click();
  await page.evaluate(() => localStorage.setItem('lightmoni.language', 'en-US')); await page.reload(); await button(page, 'Records').click(); await button(drawer(), 'Bulk create').click(); await expect(modal().getByLabel('Record values (one value per line)', {exact: true})).toBeVisible(); await button(modal(), 'Cancel').click(); await drawer().locator('.ant-drawer-close').click();
  role = 'member'; await page.reload(); await expect(page).toHaveURL(/\/settings$/); await expect(button(page, 'Bulk create')).toHaveCount(0);
  checks.push('390px无页面横向溢出、确认按钮可达；英文完整入口；成员无批量入口');
  expect(errors).toEqual([]);
  const report = {checked_at: now, fixture: 'Playwright intercepted HTTP API; no live cloud DNS calls', checks, page_errors: errors, request_count: writes.length, media: relative(root, media)};
  await writeFile(resolve(out, 'ui-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {await shot('failure'); await writeFile(resolve(out, 'failure.txt'), await page.locator('body').innerText()); throw error;}
finally {release?.(); await browser.close(); await vite.close();}
