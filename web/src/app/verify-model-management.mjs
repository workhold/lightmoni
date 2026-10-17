import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
// All API requests are isolated fixtures; no live configuration or provider is touched.
const site = process.env.LIGHTMONI_TEST_BASE_URL ?? 'http://127.0.0.1:8080';
const fixedTime = new Date('2026-10-17T05:00:00Z');
let config = { runtime: 'mastra', protocol: 'anthropic-messages', base_url: 'https://fixture.example/v1', model: 'fixture-model', has_key: true, enabled: true, max_input_tokens: 32000, max_output_tokens: 4096, max_steps: 8, reasoning_effort: 'provider-default' };
let billing = { base_url: config.base_url, protocol: config.protocol, model: config.model, currency: 'CNY', input_price_per_million: null, output_price_per_million: null };
let configError = false, billingError = false, usageMode = 'normal', rejectBilling = false, detailsError = false, modelRows = 24;
const billingWrites = [], configWrites = [], usageRequests = [], detailsRequests = [];
let billingReads = 0, holdUsage;
const zero = { requests: 0, succeeded_requests: 0, failed_requests: 0, cancelled_requests: 0, pending_requests: 0, unknown_status_requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, input_missing: 0, output_missing: 0, total_missing: 0, unpriced_requests: 0, partial_priced_requests: 0, estimated_costs: [] };
const totals = { ...zero, requests: 8, succeeded_requests: 3, failed_requests: 1, cancelled_requests: 1, pending_requests: 1, unknown_status_requests: 2, input_tokens: 1234000, output_tokens: 2468, total_tokens: 1236468, input_missing: 1, output_missing: 2, total_missing: 2, unpriced_requests: 3, partial_priced_requests: 2, estimated_costs: [{ currency: 'CNY', amount: 1.2, requests: 2, partial_requests: 1 }, { currency: 'USD', amount: 0.003, requests: 1, partial_requests: 1 }] };
const identity = value => JSON.stringify([value.base_url, value.protocol, value.model]);
function range(days, timezone) {
  const offset = timezone === 'Asia/Shanghai' ? 8 : 0;
  const to = new Date(Date.UTC(2026, 9, 18) - offset * 3600000);
  return { from: new Date(to.getTime() - days * 86400000).toISOString(), to: to.toISOString() };
}
function usage(url) {
  const days = Number(url.searchParams.get('days')), timezone = url.searchParams.get('timezone');
  const empty = usageMode === 'empty';
  return { days, timezone, ...range(days, timezone), totals: empty ? zero : totals,
    daily: empty ? [] : Array.from({ length: days }, (_, index) => ({ ...zero, ...(index === days - 1 ? totals : {}), date: new Date(Date.UTC(2026, 9, 18 - days + index)).toISOString().slice(0, 10) })),
    models: empty ? [] : Array.from({ length: modelRows }, (_, index) => ({ ...zero, ...(index === 0 ? totals : {}), base_url: index === modelRows - 1 ? '' : config.base_url, protocol: index === modelRows - 1 ? '' : config.protocol, model: index === modelRows - 1 ? '' : `fixture-${String(index + 1).padStart(2, '0')}`, requests: index === 0 ? totals.requests : 1, input_missing: index === 0 ? totals.input_missing : 1, output_missing: 1, total_missing: 1, unpriced_requests: 1 })),
    sources: empty ? [] : [{ source: 'assistant', ...totals }, { source: 'connection-test', ...zero, requests: 1, succeeded_requests: 1, input_tokens: 2, output_tokens: 2, total_tokens: 4, estimated_costs: [{ currency: 'CNY', amount: 0, requests: 1, partial_requests: 0 }] }] };
}
function usageDetails(url) {
  const days = Number(url.searchParams.get('days')), timezone = url.searchParams.get('timezone');
  const base = { id: 'request-complete', request_id: 'request-complete', status: 'succeeded', timestamp: '2026-10-17T04:00:00Z', completed_at: '2026-10-17T04:00:02Z', source: 'assistant', phase: 'execute', base_url: config.base_url, protocol: config.protocol, model: 'historical-model', input_tokens: 1000000, output_tokens: 1000000, total_tokens: 2000000, currency: 'CNY', input_price_per_million: 3, output_price_per_million: 12, input_estimated_cost: 3, output_estimated_cost: 12, estimated_cost: 15, cost_status: 'complete' };
  return { ...range(days, timezone), timezone, limit: 100, has_more: true, records: [base,
    { ...base, id: 'request-partial', request_id: 'request-partial', status: 'failed', failure_reason: 'service_interrupted', output_tokens: null, total_tokens: null, output_estimated_cost: null, estimated_cost: 3, cost_status: 'partial' },
    { ...base, id: 'request-cancelled', request_id: 'request-cancelled', status: 'cancelled', output_price_per_million: 0, output_estimated_cost: 0, estimated_cost: 3 },
    { ...base, id: 'request-pending', request_id: 'request-pending', status: 'pending', completed_at: '', input_tokens: null, output_tokens: null, total_tokens: null, input_estimated_cost: null, output_estimated_cost: null, estimated_cost: null, cost_status: 'unpriced' },
    { ...base, id: 'legacy', request_id: '', status: '', input_price_per_million: null, output_price_per_million: null, input_estimated_cost: null, output_estimated_cost: null, cost_status: 'legacy' }] };
}
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
await page.clock.install({ time: fixedTime });
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/v1/**', async route => {
  const req = route.request(), url = new URL(req.url()), path = url.pathname.slice('/api/v1'.length);
  if (path === '/auth/me') return route.fulfill({ json: { id: 'fixture-admin', name: 'fixture-admin', role: 'admin' } });
  if (path === '/assistant/config') {
    if (req.method() === 'PUT') {
      const data = req.postDataJSON(), oldIdentity = identity(config); configWrites.push(data); config = { ...config, ...data, has_key: true }; delete config.api_key;
      if (identity(config) !== oldIdentity) billing = { ...billing, base_url: config.base_url, protocol: config.protocol, model: config.model, input_price_per_million: null, output_price_per_million: null };
    }
    return route.fulfill({ status: configError ? 500 : 200, json: configError ? { error: 'fixture config failure' } : config });
  }
  if (path === '/assistant/billing') {
    if (req.method() === 'PUT') {
      const data = req.postDataJSON(); billingWrites.push(data);
      if (rejectBilling) return route.fulfill({ status: 409, json: { error: 'model connection changed' } });
      billing = { ...data };
    } else billingReads++;
    return route.fulfill({ status: billingError ? 500 : 200, json: billingError ? { error: 'fixture billing failure' } : billing });
  }
  if (path === '/assistant/usage') {
    usageRequests.push({ days: url.searchParams.get('days'), timezone: url.searchParams.get('timezone') });
    if (usageMode === 'error') return route.fulfill({ status: 500, json: { error: 'fixture usage failure' } });
    if (usageMode === 'held') {
      const response = usage(url);
      await new Promise(resolve => { holdUsage = { release: async () => { await route.fulfill({ json: response }).catch(() => {}); resolve(); } }; });
      return;
    }
    return route.fulfill({ json: usage(url) });
  }
  if (path === '/assistant/usage/details') {
    detailsRequests.push({ days: url.searchParams.get('days'), timezone: url.searchParams.get('timezone'), limit: url.searchParams.get('limit') });
    return route.fulfill({ status: detailsError ? 500 : 200, json: detailsError ? { error: 'fixture details failure' } : usageDetails(url) });
  }
  if (path === '/assistant/models') return route.fulfill({ json: { base_url: config.base_url, protocol: config.protocol, protocol_options: [config.protocol], protocol_source: 'manual', requires_confirmation: false, capabilities_verified: false, models: [{ id: 'fixture-model' }], truncated: false } });
  if (path === '/settings/instance') return route.fulfill({ json: { external_url: site } });
  return route.fulfill({ json: path === '/users' || path === '/settings/login-providers' ? [] : {} });
});
const connection = page.locator('.lm-model-settings'), fees = page.locator('.lm-model-billing'), stats = page.locator('.lm-model-usage');
const input = fees.getByRole('spinbutton', { name: '输入单价 / 百万 Token' }), output = fees.getByRole('spinbutton', { name: '输出单价 / 百万 Token' });
const active = () => stats.getByRole('tabpanel').filter({ visible: true });
async function choose(select, label) { await select.click(); await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: label }).click(); }
async function noOverflow() { await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
async function modal(name) { const dialog = page.getByRole('dialog', { name }); await expect(dialog).toBeVisible(); return dialog; }
async function savePrices() { const count = billingWrites.length; await fees.getByRole('button', { name: /保存单价$/ }).click(); await expect.poll(() => billingWrites.length).toBe(count + 1); if (!rejectBilling) await expect(fees.getByRole('button', { name: /保存单价$/ })).toBeEnabled(); }
try {
  await page.goto(site + '/admin?tab=models');
  await expect(page.getByRole('tab', { name: '模型管理', exact: true })).toBeVisible();
  await expect(input).toBeVisible(); await expect(input).toHaveValue(''); await expect(output).toHaveValue('');
  await expect(stats.locator('.lm-model-usage-summary')).toContainText('1,234,000');
  await expect(stats.locator('.lm-model-usage-summary')).toContainText('1 次未报告');
  await expect(stats.locator('.lm-model-usage-cost-total')).toContainText('CNY 1.20'); await expect(stats.locator('.lm-model-usage-cost-total')).toContainText('USD 0.003');
  await expect(stats.locator('.lm-model-usage-cost-total')).toContainText('3 次完全未计价'); await expect(stats.locator('.lm-model-usage-cost-total')).toContainText('2 次仅部分计价');
  await expect(stats.locator('.lm-model-usage-statuses')).toHaveText(/成功 3失败 1已取消 1进行中 1状态未知 2/);
  await expect(active().getByRole('row').filter({ hasText: '2026-10-17' }).first()).toContainText('2026-10-17'); await expect(active()).toContainText('今天 · 未结束'); await expect(stats.locator('.lm-model-usage-freshness')).toContainText('最后刷新：');
  expect(detailsRequests).toEqual([]);
  checks.push('默认30个真实日历日最近优先，今天未结束与最后刷新时间明确；5种请求状态、缺失Token、部分/完全未计价和多币种独立展示；明细按需加载');

  await input.fill('0'); await output.fill('1.25'); await choose(fees.getByRole('combobox', { name: '计费币种' }), 'USD · 美元'); await savePrices();
  expect(billingWrites[0]).toEqual({ base_url: config.base_url, protocol: config.protocol, model: config.model, currency: 'USD', input_price_per_million: 0, output_price_per_million: 1.25 }); expect(configWrites).toEqual([]);
  await expect(input).toHaveValue(/^0(?:\.0+)?$/); await output.fill(''); await input.fill('1'); await savePrices(); expect(billingWrites.at(-1).output_price_per_million).toBe(null);
  checks.push('单价独立保存；0为免费、清空为null，不修改连接与历史费用');

  await input.fill('9.99'); await expect(fees).toContainText('有未保存修改'); const reads = billingReads;
  await connection.getByRole('button', { name: '编辑模型配置', exact: true }).click();
  let dialog = await modal('AI 模型连接'); await dialog.getByText('执行限制', { exact: true }).click(); await dialog.getByRole('spinbutton', { name: '每轮最多执行步数' }).fill('9'); await dialog.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect.poll(() => configWrites.length).toBe(1); expect(configWrites[0].max_steps).toBe(9); await expect(input).toHaveValue('9.99'); expect(billingReads).toBe(reads); await expect(fees).toContainText('有未保存修改');
  checks.push('dirty9.99时仅保存同连接max_steps，保留草稿与dirty提示且不重新GET单价');

  await fees.getByRole('button', { name: '重新加载单价', exact: true }).click(); dialog = await modal('放弃未保存的单价修改？'); await dialog.getByRole('button', { name: '继续编辑', exact: true }).click(); await expect(input).toHaveValue('9.99'); expect(billingReads).toBe(reads);
  await fees.getByRole('button', { name: '重新加载单价', exact: true }).click(); dialog = await modal('放弃未保存的单价修改？'); await dialog.getByRole('button', { name: '放弃修改并重新加载', exact: true }).click(); await expect(input).toHaveValue(/^1(?:\.0+)?$/); await expect(fees.getByText('有未保存修改', { exact: true })).toHaveCount(0);
  checks.push('手动重载单价支持取消保留草稿、确认后加载服务器单价');

  await input.fill('9.99'); await connection.getByRole('button', { name: '编辑模型配置', exact: true }).click(); const modelDialog = await modal('AI 模型连接'); await modelDialog.getByRole('combobox', { name: /模型名称/ }).fill('new-model'); await modelDialog.getByRole('button', { name: '保存配置', exact: true }).click();
  dialog = await modal('更换模型连接并放弃未保存单价？'); await dialog.getByRole('button', { name: '返回继续编辑', exact: true }).click(); await expect(modelDialog).toBeVisible(); expect(configWrites.length).toBe(1); await expect(input).toHaveValue('9.99');
  await modelDialog.getByRole('button', { name: '保存配置', exact: true }).click(); dialog = await modal('更换模型连接并放弃未保存单价？'); await dialog.getByRole('button', { name: '更换连接并放弃单价修改', exact: true }).click(); await expect(modelDialog).toBeHidden(); await expect(input).toHaveValue(''); await expect(fees).toContainText('new-model'); await expect(connection).toContainText('new-model');
  checks.push('更换身份前确认放弃dirty单价，取消不PUT；确认后新模型加载空价，旧草稿不套用新模型');

  await input.fill('5.5'); rejectBilling = true; config = { ...config, model: 'changed-by-admin' }; billing = { ...billing, model: config.model, input_price_per_million: 2.5 };
  await savePrices(); await expect(fees).toContainText('模型连接已更新，草稿已保留'); await expect(input).toBeDisabled(); await expect(input).toHaveValue('5.5'); await expect(connection.getByRole('button', { name: '编辑模型配置', exact: true })).toBeDisabled();
  rejectBilling = false; configError = true;
  await fees.getByRole('button', { name: '重新加载单价', exact: true }).click(); dialog = await modal('放弃未保存的单价修改？'); await dialog.getByRole('button', { name: '放弃修改并重新加载', exact: true }).click();
  await expect(fees).toContainText('无法加载模型单价或同步连接'); await expect(input).toHaveValue('5.5'); await expect(fees).toContainText('有未保存修改'); await expect(connection).toContainText('无法同步模型连接'); await expect(connection.getByRole('button', { name: '编辑模型配置', exact: true })).toBeDisabled(); await expect(stats.locator('.lm-model-usage-summary')).toBeVisible();
  configError = false; await fees.getByRole('button', { name: '重新加载单价', exact: true }).click(); dialog = await modal('放弃未保存的单价修改？'); await dialog.getByRole('button', { name: '放弃修改并重新加载', exact: true }).click();
  await expect(input).toHaveValue('2.5'); await expect(connection).toContainText('changed-by-admin'); await expect(connection.getByRole('button', { name: '编辑模型配置', exact: true })).toBeEnabled(); await expect(fees).toContainText('changed-by-admin'); await savePrices(); expect(billingWrites.at(-1).model).toBe('changed-by-admin');
  checks.push('409保留旧草稿并禁止旧配置编辑；同步连接失败保留5.5草稿和dirty；成功重载同步摘要与计费身份后使用新身份保存');

  await stats.getByRole('tab', { name: '按模型', exact: true }).click(); await active().getByTitle('2', { exact: true }).click(); await expect(active().getByTitle('2', { exact: true })).toHaveClass(/ant-pagination-item-active/); await expect(active()).toContainText('fixture-11');
  usageMode = 'held'; await stats.getByRole('button', { name: '刷新统计', exact: true }).click(); await expect.poll(() => !!holdUsage).toBe(true); await expect(active()).toContainText('fixture-11'); await expect(stats.getByRole('tab', { name: '按模型', exact: true })).toHaveAttribute('aria-selected', 'true'); await holdUsage.release(); holdUsage = undefined; await expect(stats.getByRole('button', { name: '刷新统计', exact: true })).toBeEnabled(); await expect(active()).toContainText('fixture-11');
  usageMode = 'error'; await stats.getByRole('button', { name: '刷新统计', exact: true }).click(); await expect(stats).toContainText('已有结果已保留'); await expect(active()).toContainText('fixture-11'); await expect(active().getByTitle('2', { exact: true })).toHaveClass(/ant-pagination-item-active/);
  usageMode = 'normal'; await stats.getByRole('button', { name: '重试统计', exact: true }).click(); await expect(stats.getByRole('button', { name: '重试统计', exact: true })).toHaveCount(0); await expect(active()).toContainText('fixture-11');
  modelRows = 5; await stats.getByRole('button', { name: '刷新统计', exact: true }).click(); await expect(active()).toContainText('fixture-01'); await expect(active().getByTitle('2', { exact: true })).toHaveCount(0); modelRows = 24;
  checks.push('按模型第2页刷新/加载/失败均保留tab、页码与旧数据；数据减少后页码收敛到有效页');

  for (const days of [7, 90, 30]) { await choose(stats.getByRole('combobox', { name: '统计范围' }), `最近 ${days} 天`); await expect.poll(() => usageRequests.at(-1).days).toBe(String(days)); await expect(stats.locator('.lm-model-usage-freshness')).toContainText(`含今天的 ${days} 个日历日`); }
  await stats.getByRole('tab', { name: '按来源', exact: true }).click(); await expect(active().getByText('连接测试', { exact: true })).toBeVisible(); await expect(active().getByText('CNY 0.00', { exact: true })).toBeVisible();
  await stats.getByRole('tab', { name: '调用明细', exact: true }).click(); await expect(active()).toContainText('request-complete'); await expect(active()).toContainText('historical-model'); await expect(active()).toContainText('CNY 12.00'); await expect(active()).toContainText('CNY 15.00'); await expect(active()).toContainText('部分计价（另有未知部分）'); await expect(active()).toContainText('服务中断'); await expect(active()).toContainText('历史费用（单价未知）'); await expect(active()).toContainText('历史请求 ID 未知'); await expect(active()).toContainText('进行中'); await expect(active()).toContainText('范围内还有更早的调用');
  expect(detailsRequests.at(-1)).toEqual({ days: '30', timezone: 'Asia/Shanghai', limit: '100' });
  detailsError = true; await stats.getByRole('button', { name: '刷新统计', exact: true }).click(); await expect(active()).toContainText('无法加载调用明细'); await expect(active()).toContainText('request-complete'); detailsError = false; await active().getByRole('button', { name: '重试明细', exact: true }).click(); await expect(active().getByRole('button', { name: '重试明细', exact: true })).toHaveCount(0);
  checks.push('调用明细按需请求，显示当时单价/输入输出分费用/请求ID/状态/历史未知/部分计价和最多100次提示，明细失败保留已有记录并可重试');

  await expect(page.locator('.ant-message-notice')).toHaveCount(0, { timeout: 8000 }); await page.screenshot({ path: '/tmp/lightmoni-model-management-details.png', fullPage: true, animations: 'disabled' });
  await stats.getByRole('tab', { name: '按日统计', exact: true }).click(); await expect(active()).toContainText('2026-10-17'); await noOverflow(); await page.screenshot({ path: '/tmp/lightmoni-model-management-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 900 }); await page.getByRole('button', { name: '收起导航', exact: true }).click(); await noOverflow(); await expect(input).toBeVisible(); await stats.scrollIntoViewIfNeeded(); await expect(stats.getByRole('combobox', { name: '统计范围' })).toBeVisible(); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: '/tmp/lightmoni-model-management-mobile.png', fullPage: true, animations: 'disabled' }); await page.setViewportSize({ width: 1440, height: 1100 });
  checks.push('桌面与390px移动端无页面横向溢出，表格在容器内横向滚动');

  billingError = true; await fees.getByRole('button', { name: '重新加载单价', exact: true }).click(); await expect(fees).toContainText('无法加载模型单价或同步连接'); await expect(input).toHaveValue('2.5'); await expect(stats.locator('.lm-model-usage-summary')).toBeVisible(); billingError = false; await fees.getByRole('button', { name: '重新加载单价', exact: true }).click(); await expect(fees.getByText(/无法加载模型单价或同步连接/)).toHaveCount(0);
  usageMode = 'empty'; await stats.getByRole('button', { name: '刷新统计', exact: true }).click(); await expect(stats).toContainText('所选时间范围内暂无用量记录'); await expect(stats.locator('.lm-model-usage-summary')).toContainText('0');
  checks.push('连接/计费/统计错误独立呈现，不遮挡其他区块；计费加载失败保留已有单价，空统计明确');

  usageMode = 'held'; await choose(stats.getByRole('combobox', { name: '统计范围' }), '最近 7 天'); await expect.poll(() => !!holdUsage).toBe(true); await expect(stats).toContainText('当前仍显示最近 30 天');
  usageMode = 'normal'; await choose(stats.getByRole('combobox', { name: '统计范围' }), '最近 90 天'); await expect(stats.locator('.lm-model-usage-freshness')).toContainText('含今天的 90 个日历日'); await holdUsage.release(); holdUsage = undefined; await expect(stats.locator('.lm-model-usage-freshness')).toContainText('含今天的 90 个日历日');
  const timezone = stats.getByRole('combobox', { name: '统计时区' }); await timezone.fill('UTC'); await timezone.press('Enter'); await expect.poll(() => usageRequests.at(-1).timezone).toBe('UTC'); await expect(stats.locator('.lm-model-usage-freshness')).toContainText('UTC');
  checks.push('切换范围时标注旧结果所属范围；迟到7天响应不能覆盖90天；IANA时区正确请求');

  expect(errors).toEqual([]);
  const result = { checks, errors, billingWrites: billingWrites.length, configWrites: configWrites.length, usageRequests, detailsRequests, providerRequests: 0, liveConfigWrites: 0 };
  await writeFile('/tmp/lightmoni-model-management-browser.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ body: (await page.locator('body').innerText()).slice(-11000), errors })); await page.screenshot({ path: '/tmp/lightmoni-model-management-failure.png', fullPage: true }); throw error;
} finally {
  if (holdUsage) await holdUsage.release(); await context.close(); await browser.close();
}
