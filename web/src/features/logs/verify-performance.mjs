import { chromium, expect, request } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.LIGHTMONI_UI_URL ?? 'http://localhost:15174';
const center = process.env.LIGHTMONI_QA_CENTER_URL ?? 'http://localhost:18380';
const phase = process.env.LIGHTMONI_PERF_PHASE ?? 'optimized';
const output = resolve(import.meta.dirname, '../../../../docs/evidence/log-performance');
await mkdir(output, { recursive: true });
const api = await request.newContext({ baseURL: center });
const login = await api.post('/api/v1/auth/login', { data: {
  name: process.env.LIGHTMONI_TEST_USER ?? 'local-admin',
  password: process.env.LIGHTMONI_TEST_PASSWORD ?? 'local-demo-password',
} });
expect(login.ok()).toBe(true);
const catalog = await (await api.get('/api/v1/catalog/tables')).json();
const table = catalog.find(item => item.kind === 'log');
if (!table) throw new Error('A log schema is required');
const end = Date.now(), start = end - 3600000;
const range = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
const records = Array.from({ length: 2000 }, (_, index) => {
  const attributes = { lm_perf_payload: 'x'.repeat(480), tenant: 'checkout', latency: index,
    request: 'y'.repeat(240), region: 'east', success: true };
  // Attributes first seen near the end expose repeated full-array searches.
  if (index >= 1900) attributes['late_' + String((index - 1900) % 40).padStart(2, '0')] = index;
  return { event_id: 'perf-' + index, event_time: new Date(start + (index + 1) * 1000).toISOString(),
    ingested_at: new Date(end).toISOString(), service: 'perf-checkout', severity: 'INFO',
    body: 'performance log ' + index + ' ' + 'message '.repeat(24),
    host_id: 'host-' + index, agent_id: 'agent-' + index, key_id: 'key-' + index,
    source_id: 'perf-source', attributes_json: JSON.stringify(attributes) };
});
const frameColumns = table.columns.map(column => ({ name: column.name, type: column.type }));
const rowData = records.map(record => frameColumns.map(column => record[column.name] ?? null));
const bytes = Buffer.byteLength(JSON.stringify(rowData));
expect(bytes).toBeLessThan(8 * 1024 * 1024);
let browser;
try { browser = await chromium.launch({ headless: true }); }
catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: await api.storageState() });
await context.addInitScript(({ times }) => {
  localStorage.setItem('lightmoni.nav.collapsed', 'true');
  window.__logPerf = { parses: 0, cellTimes: 0, longTasks: [] };
  const parse = JSON.parse;
  JSON.parse = function (value, ...args) {
    if (typeof value === 'string' && value.startsWith('{"lm_perf_payload":')) window.__logPerf.parses++;
    return parse.call(this, value, ...args);
  };
  const dates = new Set(times), format = Date.prototype.toLocaleString;
  Date.prototype.toLocaleString = function (...args) {
    if (dates.has(this.getTime())) window.__logPerf.cellTimes++;
    return format.apply(this, args);
  };
  const intlFormat = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'format');
  Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', { ...intlFormat, get() {
    const original = intlFormat.get.call(this);
    return value => {
      if (dates.has(Number(value))) window.__logPerf.cellTimes++;
      return original(value);
    };
  } });
  new PerformanceObserver(list => {
    window.__logPerf.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })));
  }).observe({ type: 'longtask', buffered: false });
}, { times: records.map(record => Date.parse(record.event_time)) });
const page = await context.newPage(), errors = [], queries = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/v1/logs/search', route => {
  const body = route.request().postDataJSON(), offset = Number(body.cursor ?? 0), limit = 200;
  queries.push(body);
  return route.fulfill({ json: {
    frame: { columns: frameColumns, rows: rowData.slice(offset, offset + limit) },
    histogram: { columns: [{ name: 'time', type: 'DateTime' }, { name: 'count', type: 'UInt64' }, { name: 'severity', type: 'String' }],
      rows: [[new Date(start).toISOString(), 2000, 'INFO']] },
    session_id: 'perf-session', next_cursor: offset + limit < records.length ? String(offset + limit) : '',
    total_loaded: 2000, truncated: false, expires_at: new Date(end + 120000).toISOString(),
    generated_at: new Date(end).toISOString(), range, sql: 'SELECT * FROM ' + table.name,
    count_sql: 'SELECT count() FROM ' + table.name, histogram_sql: '', params: {}, interval_ms: 3600000,
    scope: 'bounded_session; performance_fixture',
  } });
});
await page.route('**/api/v1/logs/*/events/*', route => {
  const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
  const index = records.findIndex(record => record.event_id === id);
  return route.fulfill({ json: { frame: { columns: frameColumns, rows: [rowData[index]] } } });
});
await page.route('**/api/v1/logs/aggregate', route => route.fulfill({ json: {
  field: route.request().postDataJSON().field, total: 2000, present: 2000, truncated: false,
  generated_at: new Date(end).toISOString(), scope: 'performance_fixture',
  frame: { columns: [{ name: 'value', type: 'String' }, { name: 'value_type', type: 'String' }, { name: 'count', type: 'UInt64' }],
    rows: [['1900', 'Number', 1]] },
} }));
const spec = { table_id: table.id, range, services: [], keyword: '', filters: [], sort: 'asc', mode: 'filters', sql: '' };
const view = { columns: ['event_time', 'severity', 'service', 'body', 'event_id', 'host_id', 'agent_id', 'key_id'],
  pinned: [], widths: {}, lookback: 0, chart_collapsed: true };
const url = base + '/logs?' + new URLSearchParams({ table: table.id, ...range,
  q: JSON.stringify({ v: 1, query: spec, view }) });
const snapshot = () => page.evaluate(() => ({ ...window.__logPerf, at: performance.now() }));
const measurements = {};
try {
  const begun = Date.now();
  await page.goto(url);
  await expect(page.getByText('200 条已载入', { exact: true })).toBeVisible();
  for (let count = 400; count <= 2000; count += 200) {
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(page.getByText(count.toLocaleString() + ' 条已载入', { exact: true })).toBeVisible();
  }
  measurements.loadMs = Date.now() - begun;
  measurements.loaded = await snapshot();
  expect(await page.locator('.ant-table-row').count()).toBeLessThan(40);
  const before = await snapshot();
  await page.getByRole('combobox', { name: '日志关键词', exact: true }).pressSequentially('trace 123');
  await expect(page.getByRole('combobox', { name: '日志关键词', exact: true })).toHaveValue('trace 123');
  const after = await snapshot();
  measurements.keyword = { ms: after.at - before.at, attributeParses: after.parses - before.parses,
    timeCellRenders: after.cellTimes - before.cellTimes,
    longTasks: after.longTasks.filter(task => task.start >= before.at) };
  if (phase !== 'baseline') {
    expect(measurements.keyword.attributeParses).toBe(0);
    expect(measurements.keyword.timeCellRenders).toBe(0);
    expect(measurements.loaded.parses).toBeLessThan(5000);
  }
  const beforeFields = await snapshot();
  await page.getByRole('textbox', { name: '搜索字段', exact: true }).fill('late_');
  await expect(page.locator('.lm-log-field-list .lm-log-field')).toHaveCount(40);
  const afterFields = await snapshot();
  measurements.fields = { ms: afterFields.at - beforeFields.at, attributeParses: afterFields.parses - beforeFields.parses,
    timeCellRenders: afterFields.cellTimes - beforeFields.cellTimes };
  if (phase !== 'baseline') {
    expect(measurements.fields.attributeParses).toBe(0);
    expect(measurements.fields.timeCellRenders).toBe(0);
  }
  await page.getByRole('textbox', { name: '搜索字段', exact: true }).fill('');
  const scroll = page.locator('.lm-log-table-scroll');
  await scroll.hover();
  await page.mouse.wheel(550, 0);
  await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(400);
  await page.mouse.wheel(-550, 0);
  await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBe(0);
  const holder = page.locator('.ant-table-tbody-virtual-holder');
  await holder.hover();
  await page.mouse.wheel(0, 1000000);
  await expect(page.locator('[data-row-key="perf-1999"]')).toBeVisible();
  await page.locator('[data-row-key="perf-1999"] .lm-log-message').click();
  const detail = page.getByRole('dialog', { name: /日志详情/ });
  await expect(detail.locator('.lm-log-body')).toContainText('performance log 1999');
  await detail.locator('.ant-drawer-close').click();
  // Display settings must invalidate cached cell presentation.
  await page.getByRole('combobox', { name: '日志行数', exact: true }).click();
  await page.getByRole('combobox', { name: '日志行数', exact: true }).press('ArrowDown');
  await page.getByRole('combobox', { name: '日志行数', exact: true }).press('Enter');
  await expect(page.locator('.lm-log-message').first()).toHaveClass(/is-wrapped/);
  const handle = page.getByRole('separator', { name: '调整 event_time 列宽', exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2);
  await page.mouse.up();
  await expect.poll(() => handle.evaluate(element => Math.round(element.closest('.ant-table-cell').getBoundingClientRect().width))).toBe(280);
  // Replacing a row with the same ID must invalidate its cached values and type.
  rowData[0][frameColumns.findIndex(column => column.name === 'body')] = 'refreshed performance log';
  rowData[0][frameColumns.findIndex(column => column.name === 'attributes_json')] = '{"lm_perf_payload":"new","latency":"updated"}';
  await page.locator('.lm-log-results .lm-log-inline-filter').filter({ hasText: /^INFO$/ }).first().click();
  await expect(page.getByText('200 条已载入', { exact: true })).toBeVisible();
  expect(queries.at(-1).spec.filters).toEqual([{ scope: 'column', field: 'severity', type: 'string', op: 'eq', value: 'INFO' }]);
  const currentView = JSON.parse(new URL(page.url()).searchParams.get('q')).view;
  expect(currentView.row_lines).toBe(3);
  expect(currentView.widths.event_time).toBe(280);
  await expect(page.locator('.lm-log-message').first()).toHaveText('refreshed performance log');
  await expect(page.locator('.lm-log-message').first()).toHaveClass(/is-wrapped/);
  await expect(page.locator('.lm-log-field > button[title="attr:latency"] .lm-log-field-type')).toHaveAttribute('title', '文本');
  expect(errors).toEqual([]);
  await writeFile(resolve(output, phase + '-report.json'), JSON.stringify({ phase, passed: true, rows: 2000, bytes,
    fixture: 'Controlled 2,000-row response, 40 late attributes, no stored log/catalog mutation', measurements, errors }, null, 2));
  console.log(JSON.stringify({ phase, passed: true, measurements }));
} catch (error) {
  await writeFile(resolve(output, phase + '-report.json'), JSON.stringify({ phase, passed: false, measurements, errors, error: String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
  await api.dispose();
}
