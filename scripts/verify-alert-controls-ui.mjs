import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium, expect } = require(require.resolve('@playwright/test', { paths: [resolve(process.cwd(), 'web'), process.cwd()] }));
// Run against a separate Vite instance, for example:
// npm --prefix web run dev -- --port 18887 --strictPort
// Every API request is intercepted. No real alert, provider, or workspace changes.
const site = process.env.LIGHTMONI_TEST_BASE_URL ?? 'http://127.0.0.1:18887';
const output = process.env.LIGHTMONI_TEST_OUTPUT ?? resolve(tmpdir(), 'lightmoni-alert-controls-ui');
// Set LIGHTMONI_TEST_SCENARIO=receipt to check only the committed silence result.
const receiptOnly = process.env.LIGHTMONI_TEST_SCENARIO === 'receipt';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [], checks = [], unexpected = [], requests = [], sentContexts = [];
page.on('pageerror', error => errors.push(error.message));

const stamp = '2026-10-18T00:00:00Z';
const title = '告警变更验收';
const beforeSQL = "SELECT service, avg(value) AS value\nFROM metric_app\nWHERE $__timeFilter(event_time)\n  AND service = 'checkout'\n  /* BEFORE_SQL_START " + 'original-query-'.repeat(32) + " BEFORE_SQL_END */\nGROUP BY service";
const afterSQL = "SELECT service, max(value) AS value\nFROM metric_app\nWHERE $__timeFilter(event_time)\n  AND service = 'checkout'\n  /* AFTER_SQL_START " + 'updated-query-'.repeat(32) + " AFTER_SQL_END */\nGROUP BY service";
const before = {
  id: 'rule-checkout', name: 'Checkout 延迟', kind: 'sql', enabled: true, revision: 4,
  sql: beforeSQL, source_table_ids: ['metric-app'], group_ids: ['group-checkout'], services: ['checkout'],
  params: {}, value_field: 'value', label_fields: ['service'], operator: 'gt', threshold: '100',
  interval_seconds: 60, window_seconds: 300, delay_seconds: 0, for_seconds: 60, for_count: 1,
  recovery_seconds: 60, repeat_seconds: 300, health_for_seconds: 120, notify_health: true, severity: 'P1',
};
const after = { ...before, sql: afterSQL, threshold: '250' };
const proposal = {
  id: 'b'.repeat(32), session_id: 's1', operation: 'rule.update', target_id: before.id,
  status: 'awaiting_approval', before, after, summary: '将 Checkout 延迟阈值从 100 调整为 250，并使用最大值查询',
  impact: ['继续求值，新的 SQL 与阈值将在确认后生效', '规则状态和待发送通知将按业务规则更新'],
  reason: '按值班要求调整 Checkout 告警', created_at: stamp, expires_at: '2099-01-01T00:00:00Z',
};
const event = (sequence, type, data, turn_id = 't1') => ({ sequence, session_id: 's1', turn_id, type, timestamp: stamp, data });
const session = {
  id: 's1', user_id: 'fixture', title, created_at: stamp, updated_at: stamp, messages: [],
  events: [
    event(1, 'user.message', { text: '请调整 Checkout 告警阈值和 SQL' }),
    event(2, 'tool.call', { call_id: 'c1', tool: 'propose_alert_change', input: { operation: 'rule.update', target_id: before.id, patch: { threshold: '250', sql: afterSQL }, reason: proposal.reason } }),
    event(3, 'tool.result', { call_id: 'c1', status: 'success', value: { proposal } }),
    event(4, 'turn.completed', {}),
  ],
};
const plannedEnd = '2026-10-18T00:01:00Z', actualEnd = '2026-10-18T00:05:00Z';
const silenceBefore = { id: 'silence-checkout', scope: 'service', service: 'checkout', from: stamp, until: '', daily_start: '22:00', daily_end: '09:00', weekdays: [1, 2, 3, 4, 5], timezone: 'Asia/Shanghai', reason: '发布期间静默', revision: 1 };
const silenceResult = { ...silenceBefore, until: actualEnd, ended_at: actualEnd, revision: 2 };
if (receiptOnly) {
  Object.assign(proposal, { operation: 'silence.end', target_id: silenceBefore.id, before: silenceBefore, after: { ...silenceBefore, until: plannedEnd }, summary: '提前结束 Checkout 静默', impact: ['实际结束时间以确认事务回执为准'] });
  session.events = [
    event(1, 'user.message', { text: '提前结束 Checkout 静默' }),
    event(2, 'tool.call', { call_id: 'c1', tool: 'propose_alert_change', input: { operation: 'silence.end', target_id: silenceBefore.id, reason: '发布完成' } }),
    event(3, 'tool.result', { call_id: 'c1', status: 'success', value: { proposal } }),
    event(4, 'tool.call', { call_id: 'c2', tool: 'get_alert_proposal', input: { id: proposal.id } }),
    event(5, 'tool.result', { call_id: 'c2', status: 'success', value: { proposal } }),
    event(6, 'turn.completed', {}),
  ];
}
const catalog = [{ id: 'metric-app', name: 'metric_app', kind: 'metric', services: ['checkout'], columns: [{ name: 'event_time', type: 'DateTime64(3)' }, { name: 'service', type: 'String' }, { name: 'value', type: 'Float64' }] }];
const groups = [{ id: 'group-checkout', name: 'Checkout 值班组', enabled: true, targets: [], members: [], primary: [], backup: [], fallback: [], timezone: 'Asia/Shanghai', channel_ids: [], schedule: { mode: 'fixed', timezone: 'Asia/Shanghai', anchor: stamp, interval_days: 1, shifts: [], overrides: [] }, policies: {} }];
let role = 'admin', mode = 'completed', applyOutcome = 'success', applyPosts = 0, proposalGets = 0, ruleGets = 0, silenceGets = 0;
let holdGet, holdApply;
const gates = new Set();
function gate() {
  let release;
  const promise = new Promise(resolvePromise => { release = () => { gates.delete(release); resolvePromise(); }; });
  gates.add(release);
  return { promise, release };
}
function currentProposal() {
  if (receiptOnly) return { ...proposal, status: 'completed', applied_at: actualEnd, result: silenceResult };
  if (mode === 'completed') return { ...proposal, status: 'completed', applied_at: stamp, result: { ...after, revision: 5 } };
  if (mode === 'expired') return { ...proposal, expires_at: '2000-01-01T00:00:00Z' };
  if (mode === 'malformed') { const { after: omitted, ...incomplete } = proposal; return incomplete; }
  return proposal;
}

await context.route('**/api/**', async route => {
  const req = route.request(), path = new URL(req.url()).pathname.replace(/^\/api\/v1/, ''), method = req.method();
  requests.push({ path, method, query: new URL(req.url()).search });
  const send = (json, status = 200) => route.fulfill({ json, status });
  if (path === '/auth/me') return send({ id: 'fixture', name: 'fixture', role });
  if (path === '/assistant/config') return send({ model: 'fixture', enabled: true, code_tasks_enabled: role === 'admin', code_workspace: '.' });
  if (path === '/catalog/tables') return send(catalog);
  if (path === '/assistant/sessions') return send(method === 'POST' ? session : { items: [session] });
  if (path === '/assistant/sessions/s1') return send(session);
  if (path === '/assistant/alert-proposals/' + proposal.id && method === 'GET') {
    proposalGets++;
    const waiting = holdGet; holdGet = undefined;
    if (waiting) await waiting.promise;
    if (mode === 'unavailable') return send({ error: '提案不可用，请刷新提案' }, 404);
    return send(currentProposal());
  }
  if (path === '/assistant/alert-proposals/' + proposal.id + '/apply' && method === 'POST') {
    applyPosts++;
    expect(req.postDataJSON()).toEqual({});
    const waiting = holdApply; holdApply = undefined;
    if (waiting) await waiting.promise;
    if (applyOutcome === 'conflict') {
      mode = 'unavailable';
      return send({ error: '版本已变化，请刷新提案后重新审阅' }, 409);
    }
    mode = 'completed';
    return send(currentProposal());
  }
  if (path === '/assistant/sessions/s1/turns') {
    sentContexts.push(req.postDataJSON().context);
    const turn = 't' + (sentContexts.length + 1);
    return route.fulfill({ contentType: 'text/event-stream', body: [event(5 + sentContexts.length * 2, 'user.message', { text: '读取当前告警上下文' }, turn), event(6 + sentContexts.length * 2, 'turn.completed', {}, turn)].map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('') });
  }
  if (method === 'GET' && path === '/alerts/rules') { ruleGets++; return send([mode === 'completed' ? { ...after, revision: 5 } : before]); }
  if (method === 'GET' && path === '/alerts/groups') return send(groups);
  if (method === 'GET' && path === '/alerts/silences') { silenceGets++; return send([]); }
  if (method === 'GET' && path === '/alerts/tables') return send([{ table: catalog[0], rules: [before], configured: true, warning: '' }]);
  if (method === 'GET' && path === '/alerts/response-statistics') return send({ users: [], records: [], definition: '', truncated: false });
  if (method === 'GET' && ['/alerts/instances', '/alerts/events', '/alerts/incidents', '/alerts/responders', '/notify/channels', '/notify/deliveries', '/dashboards'].includes(path)) return send([]);
  unexpected.push({ path, method });
  return send({ error: 'unexpected fixture API' }, 500);
});

const card = () => page.locator('.lm-assistant-alert-proposal');
const review = () => page.getByRole('button', { name: '审阅并确认变更', exact: true });
const refresh = () => page.getByRole('button', { name: /刷新提案/ });
const confirmation = () => page.getByRole('dialog', { name: '确认告警变更', exact: true });
const confirm = () => confirmation().getByRole('button', { name: '确认应用变更', exact: true });
let confirmationView;
async function readyConfirmation() {
  await expect(confirmation()).toBeVisible();
  // A newly mounted dialog can have a box while its enter animation is still
  // fully transparent. Require a stable, hittable button before taking evidence.
  await confirm().click({ trial: true });
  await expect.poll(async () => {
    confirmationView = await confirmation().evaluate(dialog => {
      const title = dialog.querySelector('.ant-modal-title');
      const button = [...dialog.querySelectorAll('button')].find(item => item.textContent?.includes('确认应用变更'));
      if (!title || !button) return { ready: false };
      const titleBox = title.getBoundingClientRect(), buttonBox = button.getBoundingClientRect();
      let opacity = 1;
      for (let element = title; element; element = element.parentElement) opacity *= Number(getComputedStyle(element).opacity);
      const hit = document.elementFromPoint(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
      const titleInView = titleBox.width > 100 && titleBox.height > 10 && titleBox.top >= 0 && titleBox.bottom <= innerHeight;
      const buttonInView = buttonBox.width > 80 && buttonBox.top >= 0 && buttonBox.bottom <= innerHeight;
      return { ready: opacity >= .99 && titleInView && buttonInView && !!hit && button.contains(hit), opacity, title: { x: titleBox.x, y: titleBox.y, width: titleBox.width, height: titleBox.height }, button: { x: buttonBox.x, y: buttonBox.y, width: buttonBox.width, height: buttonBox.height } };
    });
    return confirmationView.ready;
  }).toBe(true);
}
async function loadFixtureSession() {
  const listed = page.locator('.lm-assistant-session').filter({ hasText: title });
  const history = page.getByRole('button', { name: '对话历史', exact: true });
  await expect.poll(async () => await listed.first().isVisible() || await history.isVisible()).toBe(true);
  if (!(await listed.first().isVisible())) await history.click();
  await listed.last().click();
  await expect(card()).toBeVisible();
}
async function pending() {
  mode = 'pending';
  await refresh().click();
  await expect(review()).toBeEnabled();
}
async function noConfirmation() {
  const buttons = page.getByRole('button', { name: '确认应用变更', exact: true });
  if (await buttons.count()) await expect(buttons).toBeDisabled();
  if (await review().count()) await expect(review()).toBeDisabled();
}
async function sendContext() {
  const marker = sentContexts.length;
  await page.getByRole('textbox', { name: '给 AI 助手的问题' }).fill('读取当前告警上下文');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => sentContexts.length).toBe(marker + 1);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  return sentContexts.at(-1);
}
async function closeAssistant() {
  const drawer = page.getByRole('dialog', { name: 'AI 助手', exact: true });
  await drawer.locator('.ant-drawer-close').click();
  await expect(drawer).toBeHidden();
}
async function cancelReview() {
  await confirmation().getByRole('button', { name: /取\s*消/ }).click();
  await expect(confirmation()).toBeHidden();
}

try {
  await page.goto(site + '/assistant');
  await loadFixtureSession();
  await expect(card()).toContainText('已应用');
  await expect(review()).toHaveCount(0);
  expect(proposalGets).toBeGreaterThan(0);
  checks.push('历史 awaiting_approval 快照回读 completed 后隐藏确认');

  if (receiptOnly) {
    await expect(card().locator('.lm-assistant-alert-effective')).toContainText(actualEnd);
    await expect(card().locator('.lm-assistant-alert-diff')).toContainText(plannedEnd);
    await card().getByText('实际生效配置（完整）', { exact: true }).click();
    const result = card().locator('.lm-assistant-alert-result');
    await expect(result.getByText('实际结束时间', { exact: true })).toBeVisible();
    await expect(result).toContainText(actualEnd);
    await expect(result).toContainText(silenceResult.reason);
    await expect(result).toContainText(silenceResult.timezone);
    await expect(result).toContainText('22:00');
    await expect(result).not.toContainText(plannedEnd);
    await expect(page.getByText('核验告警提案', { exact: true })).toBeVisible();
    expect(applyPosts).toBe(0);
    checks.push('silence.end 完成回执展示实际 ended_at/until 与完整配置，保留预览时间且无再次确认，核验工具标签中文');
    await page.waitForTimeout(350);
    await result.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: resolve(output, 'receipt.png'), fullPage: true, animations: 'disabled' });
  } else {
  mode = 'unavailable';
  await refresh().click();
  await expect(card()).toContainText('状态未确认');
  await noConfirmation();
  checks.push('GET 失败显示状态未确认且不可确认');

  mode = 'expired';
  await refresh().click();
  await expect(card()).toContainText('已过期');
  await expect(review()).toHaveCount(0);
  expect(applyPosts).toBe(0);
  checks.push('GET 返回过期待确认提案时无确认按钮');

  mode = 'malformed';
  await refresh().click();
  await expect(card()).toContainText('状态未确认');
  await noConfirmation();
  expect(applyPosts).toBe(0);
  checks.push('GET 缺少完整 after 配置时不可确认');

  await pending();
  const diff = card().locator('.lm-assistant-alert-diff');
  await expect(diff).toContainText(beforeSQL);
  await expect(diff).toContainText(afterSQL);
  await expect(card()).toContainText('创建');
  await expect(card()).toContainText('有效');
  await expect(card()).toContainText('2099');
  await expect(card()).toContainText(proposal.reason);
  await expect(card()).toContainText(proposal.impact[0]);
  checks.push('完整 SQL 原值/新值、创建/有效期、理由及影响可读');

  const beforeReviewGets = proposalGets;
  holdGet = gate(); const reviewRead = holdGet;
  await review().click();
  await expect.poll(() => proposalGets).toBeGreaterThan(beforeReviewGets);
  await expect(confirmation()).toHaveCount(0);
  expect(applyPosts).toBe(0);
  reviewRead.release();
  await readyConfirmation();
  await expect(confirmation()).toContainText(beforeSQL);
  await expect(confirmation()).toContainText(afterSQL);
  await confirmation().locator('.ant-modal-body').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: resolve(output, 'confirmation.png'), fullPage: true, animations: 'disabled' });
  await cancelReview();
  expect(applyPosts).toBe(0);
  checks.push('审阅先 GET 后显示 Modal，Modal 含完整 SQL，取消零 POST');

  await review().click();
  await expect(confirmation()).toBeVisible();
  holdApply = gate(); const applying = holdApply;
  await confirm().evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => applyPosts).toBe(1);
  await confirmation().evaluate(dialog => {
    dialog.querySelector('.ant-modal-close')?.click();
    [...dialog.querySelectorAll('button')].find(button => button.textContent?.replace(/\s/g, '') === '取消')?.click();
    [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('确认应用变更'))?.click();
  });
  await page.keyboard.press('Escape');
  await expect(confirmation()).toBeVisible();
  expect(applyPosts).toBe(1);
  applying.release();
  await expect(confirmation()).toBeHidden();
  await expect(card()).toContainText('已应用');
  await expect(review()).toHaveCount(0);
  expect(applyPosts).toBe(1);
  checks.push('明确确认只发一次 POST；连续点击、提交中关闭/取消/Escape 不重复提交');

  await pending();
  await expect(page.locator('.ant-message-success')).toHaveCount(0);
  applyOutcome = 'conflict';
  const conflictMarker = applyPosts;
  await review().click();
  await confirm().click();
  await expect.poll(() => applyPosts).toBe(conflictMarker + 1);
  await expect(card()).toContainText('版本已变化，请刷新提案后重新审阅');
  await expect(card()).not.toContainText('已应用');
  await expect(page.locator('.ant-message-success')).toHaveCount(0);
  await noConfirmation();
  const conflictGets = proposalGets;
  mode = 'pending';
  await refresh().click();
  await expect.poll(() => proposalGets).toBeGreaterThan(conflictGets);
  await expect(review()).toBeEnabled();
  if (await confirmation().isVisible()) await cancelReview();
  const rereviewGets = proposalGets;
  await review().click();
  await expect.poll(() => proposalGets).toBeGreaterThan(rereviewGets);
  await expect(confirmation()).toBeVisible();
  await cancelReview();
  expect(applyPosts).toBe(conflictMarker + 1);
  applyOutcome = 'success';
  checks.push('409 保留错误且不显示成功，刷新并重新审阅后才可再次确认');

  await card().evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  const collapse = page.getByRole('button', { name: '收起导航', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await expect(review()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await card().evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
  checks.push('390px 卡片及长 SQL 不造成页面横向溢出');

  role = 'member'; const memberMarker = requests.length;
  await page.goto(site + '/assistant');
  await loadFixtureSession();
  await expect(review()).toBeEnabled();
  expect(requests.slice(memberMarker).some(req => req.path.startsWith('/assistant/alert-proposals/'))).toBe(true);
  await expect(page.getByRole('textbox', { name: '代码工作区', exact: true })).toHaveCount(0);
  checks.push('member 可读取和审阅告警卡片，不受代码任务管理员限制');

  // Disable only the alert workbench's regular polling on the following page.
  // Its refresh after apply must therefore come from the successful-change event.
  await page.addInitScript(() => {
    const original = window.setInterval.bind(window);
    window.setInterval = (handler, timeout, ...args) => timeout === 5000 ? 0 : original(handler, timeout, ...args);
    window.__fixtureAlertChanges = 0;
    window.addEventListener('lightmoni:alert-changed', () => { window.__fixtureAlertChanges++; });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(site + '/alerts');
  await expect(page.getByRole('button', { name: '创建告警规则', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '服务筛选', exact: true }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText('checkout', { exact: true }).click();
  await page.getByRole('combobox', { name: '启用状态筛选', exact: true }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText('已启用', { exact: true }).click();
  await page.getByRole('tab', { name: '事件与发送记录', exact: true }).click();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await loadFixtureSession();
  const filtered = await sendContext();
  expect(filtered.alerts.tab).toBe('history');
  expect(filtered.alerts.filters).toMatchObject({ service: 'checkout', enabled: 'true' });
  await closeAssistant();
  await page.getByRole('tab', { name: '告警规则', exact: true }).click();
  await expect(page.getByRole('tab', { name: '告警规则', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: /^编\s*辑$/ }).click();
  await expect(page.getByRole('dialog', { name: '编辑告警规则', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).evaluate(button => button.click());
  await loadFixtureSession();
  const editing = await sendContext();
  expect(editing.alerts.tab).toBe('rules');
  expect(editing.alerts.editing_rule_id).toBe(before.id);
  await closeAssistant();
  await page.getByRole('dialog', { name: '编辑告警规则', exact: true }).getByRole('button', { name: /取\s*消/ }).click();
  checks.push('告警页向助手发送当前 tab、筛选与正在编辑的规则 ID');

  await page.getByRole('tab', { name: '静默窗口', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建静默窗口', exact: true })).toBeVisible();
  await expect.poll(() => silenceGets).toBeGreaterThan(0);
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await loadFixtureSession();
  await expect(review()).toBeEnabled();
  await review().click();
  await expect(confirmation()).toBeVisible();
  const refreshMarker = { rules: ruleGets, silences: silenceGets, posts: applyPosts };
  await confirm().click();
  await expect(card()).toContainText('已应用');
  await expect.poll(() => ruleGets).toBeGreaterThan(refreshMarker.rules);
  await expect.poll(() => silenceGets).toBeGreaterThan(refreshMarker.silences);
  expect(await page.evaluate(() => window.__fixtureAlertChanges)).toBe(1);
  expect(applyPosts).toBe(refreshMarker.posts + 1);
  checks.push('member 明确确认后触发变更事件，告警页和静默工作台立即回读（已禁用轮询）');
  }

  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  const report = { checks, pageerrors: errors, unexpected, apply_posts: applyPosts, proposal_gets: proposalGets, captured_alert_contexts: sentContexts.map(item => item.alerts), ...(confirmationView ? { confirmation_view: confirmationView } : {}), screenshots: receiptOnly ? ['receipt.png'] : ['desktop.png', 'mobile.png', 'confirmation.png'] };
  await writeFile(resolve(output, receiptOnly ? 'receipt-evidence.json' : 'evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ error: String(error), checks, pageerrors: errors, unexpected, requests: requests.slice(-40), body: await page.locator('body').innerText().catch(() => '') }, null, 2));
  throw error;
} finally {
  for (const release of [...gates]) release();
  await browser.close();
}
