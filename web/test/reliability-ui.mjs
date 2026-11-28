import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

const build = resolve(import.meta.dirname, '../../runtime/public');
const now = new Date().toISOString();
const services = [{ id: 'fixture-service', name: 'Orders', updated_at: now }];
const user = { id: 'fixture-admin', name: 'QA', role: 'admin', active: true };
const sessions = new Map();
const attempts = new Map();
const timers = new Set();
let deployReady = false;
let failNextDeployRead = false;
let submittedRevision;
let operationFinished = false;

function later(callback, delay) {
  const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
  timers.add(timer);
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
function newSession(title) {
  const id = 'session-' + (sessions.size + 1);
  const session = { id, title, user_id: user.id, status: 'idle', created_at: now, updated_at: now, events: [], messages: [] };
  sessions.set(id, session);
  return session;
}
function add(session, turnID, type, data = {}) {
  const event = { sequence: session.events.length, session_id: session.id, turn_id: turnID, type, timestamp: now, data };
  session.events.push(event);
  return event;
}
function finish(session, turnID, text) {
  session.status = 'idle';
  return [add(session, turnID, 'assistant.message', { text, step: 1 }), add(session, turnID, 'turn.completed')];
}
function seededConversation(title) {
  const session = newSession(title);
  add(session, 'previous', 'user.message', { text: '上一轮提问' });
  finish(session, 'previous', '上一轮已完成');
  return session;
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname;
  if (!path.startsWith('/api/v1/')) {
    const file = path.startsWith('/assets/') ? resolve(build, '.' + path) : resolve(build, 'index.html');
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    try {
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
    return;
  }
  const route = path.slice('/api/v1'.length);
  if (route === '/auth/me' || route === '/auth/profile') return json(res, user);
  if (route === '/auth/providers') return json(res, []);
  if (route === '/setup') return json(res, { required: false });
  if (route === '/catalog/tables') return json(res, []);
  if (route === '/ops/overview') return json(res, { resources: [], agents: [], runs: [], machines: [] });
  if (route === '/ops/resources') return json(res, { resources: [] });
  if (route === '/ops/catalog') return json(res, { templates: [] });
  if (route === '/machines') return json(res, []);
  if (route === '/operations/runs/existing-plan') return json(res, { run: {
    id: 'existing-plan', resource_id: 'backup', resource_revision: 7, operation: 'inspect',
    state: operationFinished ? 'succeeded' : submittedRevision ? 'queued' : 'awaiting_approval',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    preview: { resource: { id: 'backup', name: 'Backup fixture', agent_id: 'host-a', revision: 7, config: {} }, operation: 'inspect', input: {} },
    ...(operationFinished ? { receipt: { verified: true } } : {}),
  } });
  if (route === '/operations/runs/existing-plan/approve' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    submittedRevision = JSON.parse(body).revision;
    return json(res, {});
  }
  if (route === '/services') return json(res, services);
  if (route === '/services/fixture-service') {
    if (failNextDeployRead) {
      failNextDeployRead = false;
      return json(res, { error: 'fixture temporarily unavailable' }, 503);
    }
    const deployment = { target_id: 'target', release_id: 'release', adapter: 'systemd', operation_kind: 'deploy',
      plan: { rollback: { available: false }, release: { version: '1.0.0' } }, phase: 'verifying', created_at: now };
    return json(res, {
      service: services[0],
      targets: [{ id: 'target', machine_id: 'host', machine_name: 'Host A', config: { unit: 'orders.service', release_directory: '/srv/orders' },
        preflight: { status: deployReady ? 'completed' : 'queued', current: deployReady, ready: deployReady, snapshot: {} } }],
      deployments: [{ ...deployment, id: 'live', status: deployReady ? 'succeeded' : 'verifying' },
        { ...deployment, id: 'previous', status: 'failed', receipt: { state: 'unknown' } }],
      releases: [],
    });
  }
  const eventRoute = /^\/deployments\/(live|previous)\/events$/.exec(route);
  if (eventRoute) {
    const id = eventRoute[1];
    if (id === 'previous') await new Promise(resolve => setTimeout(resolve, 400));
    return json(res, [{ id, phase: 'verifying', created_at: now, summary: id === 'live' ?
      deployReady ? '当前部署完成回执' : '当前部署检查中' : '历史部署事件' }]);
  }
  if (route === '/assistant/config') return json(res, { enabled: true, model: 'fixture-model' });
  if (route === '/assistant/sessions' && req.method === 'GET') {
    return json(res, { items: [...sessions.values()].map(session => ({ ...session, events: null })) });
  }
  const sessionRoute = /^\/assistant\/sessions(?:\/([^/]+))?(\/turns)?$/.exec(route);
  if (sessionRoute) {
    const id = sessionRoute[1];
    if (req.method === 'GET') return json(res, sessions.get(id));
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const input = JSON.parse(raw);
    if (!id) return json(res, newSession(input.title), 201);
    const session = sessions.get(id);
    const sent = attempts.get(input.text) ?? [];
    sent.push(input.request_id);
    attempts.set(input.text, sent);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': connected\n\n');
    if (input.text === '提交未到达' && sent.length === 1) return res.end();

    const turnID = 'turn-' + session.events.length;
    const started = add(session, turnID, 'user.message', { text: input.text, request_id: input.request_id });
    if (input.text === '已受理后断线') {
      session.status = 'running';
      later(() => finish(session, turnID, '匹配到本轮持久回执'), 3200);
      return res.end();
    }
    const events = [started, ...finish(session, turnID, '模型测试答复')];
    for (const event of events) res.write('data: ' + JSON.stringify(event) + '\n\n');
    return res.end();
  }
  return json(res, {});
});

let browser, localOrigin, httpOrigin;
before(async () => {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  localOrigin = 'http://127.0.0.1:' + server.address().port;
  httpOrigin = localOrigin.replace('127.0.0.1', 'lightmoni-fixture.test');
  const options = { args: ['--no-proxy-server', '--host-resolver-rules=MAP lightmoni-fixture.test 127.0.0.1'] };
  try { browser = await chromium.launch(options); }
  catch { browser = await chromium.launch({ ...options, channel: 'chrome' }); }
});
after(async () => {
  for (const timer of timers) clearTimeout(timer);
  await browser?.close();
  await new Promise(done => server.close(done));
});

async function open(t, origin, path, prepare) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  t.after(() => page.close());
  await prepare?.(page);
  await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
  return page;
}
async function send(page, text) {
  const input = page.getByRole('textbox', { name: '给 AI 助手的问题' });
  await input.fill(text);
  await input.press('Enter');
}

test('plain HTTP mounts the store and sends AI messages even when catalog reads fail', async t => {
  const page = await open(t, httpOrigin, '/applications?view=store');
  assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof crypto.randomUUID]), [false, 'undefined']);
  await expect(page.getByLabel('搜索应用商店')).toBeVisible({ timeout: 8000 });
  await page.route('**/api/v1/catalog/tables', route => route.fulfill({ status: 503, json: { error: 'fixture table catalog unavailable' } }));
  await page.goto(httpOrigin + '/assistant');
  await send(page, '目录不可用时仍可发送');
  await expect(page.getByText('模型测试答复', { exact: true })).toBeVisible();
  assert.match(attempts.get('目录不可用时仍可发送')[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('deployment review link refreshes preflight, status, and the selected timeline', async t => {
  const path = '/services?service=fixture-service&deployment=live';
  const page = await open(t, localOrigin, path, async page => {
    let signedIn = false;
    await page.route('**/api/v1/auth/me', route => signedIn ? route.continue() : route.fulfill({ status: 401, json: { error: 'fixture signed out' } }));
    await page.route('**/api/v1/auth/login', route => { signedIn = true; return route.fulfill({ json: user }); });
  });
  await page.getByLabel('用户名').fill('fixture-admin');
  await page.getByLabel('密码').fill('fixture-only');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('heading', { name: '服务部署' })).toBeVisible({ timeout: 8000 });
  await expect(page).toHaveURL(localOrigin + path);
  await expect(page.getByText('等待中心 SSH 预检', { exact: true })).toBeVisible();
  await expect(page.getByText('当前部署检查中', { exact: true })).toBeVisible();
  failNextDeployRead = true;
  await expect(page.getByText('进度刷新失败，显示上次结果', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('当前部署检查中', { exact: true })).toBeVisible();
  deployReady = true;
  await expect(page.getByText('预检通过', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('当前部署完成回执', { exact: true })).toBeVisible();
  await expect(page.getByText('结果待确认', { exact: true }).first()).toBeVisible();
  const timelineButtons = page.getByRole('button', { name: '查看时间线' });
  await timelineButtons.nth(1).click();
  await expect(page.getByText('当前部署完成回执', { exact: true })).toHaveCount(0);
  await timelineButtons.nth(0).click();
  await expect(page.getByText('当前部署完成回执', { exact: true })).toBeVisible();
  await expect(page.getByText('历史部署事件', { exact: true })).toHaveCount(0);
});

test('a dropped submission keeps the message for retry with the same ID', async t => {
  const session = seededConversation('未受理断线');
  const page = await open(t, localOrigin, '/assistant');
  await page.getByRole('button', { name: new RegExp(session.title) }).click();
  await expect(page.getByText('上一轮已完成', { exact: true })).toBeVisible();
  await send(page, '提交未到达');
  const queued = page.getByLabel('待发送消息');
  await expect(queued.getByText('提交未到达', { exact: true })).toBeVisible({ timeout: 10000 });
  await queued.getByRole('button', { name: '立即发送' }).click();
  await expect(page.getByText('模型测试答复', { exact: true })).toBeVisible();
  const [first, retry] = attempts.get('提交未到达');
  assert.ok(first);
  assert.equal(first, retry);
});

test('an operations review link submits only the explicitly reviewed native revision', async t => {
  const page = await open(t, localOrigin, '/operations?run=existing-plan');
  const drawer = page.getByRole('dialog', { name: '审阅运维计划' });
  await expect(drawer.getByText('Backup fixture', { exact: true })).toBeVisible();
  const approve = drawer.getByRole('button', { name: '批准执行' });
  await expect(approve).toBeDisabled();
  assert.equal(submittedRevision, undefined);
  await drawer.getByRole('checkbox', { name: '我已核对目标、操作和配置' }).check();
  await approve.click();
  await expect(drawer.getByText('排队中', { exact: true })).toBeVisible();
  assert.equal(submittedRevision, 7);
  operationFinished = true;
  await expect(drawer.getByLabel('执行回执')).toBeVisible({ timeout: 8000 });
  await expect(drawer.getByText('成功', { exact: true })).toBeVisible();
});

test('recovery follows the accepted request through the previous turn and a browser reload', async t => {
  const session = seededConversation('已受理断线');
  const page = await open(t, localOrigin, '/assistant');
  await page.getByRole('button', { name: new RegExp(session.title) }).click();
  await send(page, '已受理后断线');
  await expect(page.getByText('连接中断，正在恢复…', { exact: true })).toBeVisible();
  await expect(page.getByText('匹配到本轮持久回执', { exact: true })).toBeVisible({ timeout: 10000 });
  assert.equal(attempts.get('已受理后断线').length, 1);

  const detached = seededConversation('重新打开运行会话');
  detached.status = 'running';
  add(detached, 'detached', 'user.message', { text: '后台运行中的请求' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(detached.title) }).click();
  await expect(page.locator('.lm-assistant-runbar')).toBeVisible();
  finish(detached, 'detached', '重新打开后看到最终答复');
  await expect(page.getByText('重新打开后看到最终答复', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.lm-assistant-runbar')).toHaveCount(0);
});
