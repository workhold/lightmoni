import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { chromium, expect } = require(require.resolve('@playwright/test', { paths: [resolve(process.cwd(), 'web'), process.cwd()] }));
// Start a separate Vite instance before running. All API calls are fixtures;
// this script never contacts a provider or changes a real code workspace.
const site = process.env.LIGHTMONI_TEST_BASE_URL ?? 'http://127.0.0.1:18887';
const output = process.env.LIGHTMONI_TEST_OUTPUT ?? resolve(tmpdir(), 'lightmoni-code-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [], checks = [], unexpected = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
const stamp = new Date().toISOString();
const preview = {
  id: 'a'.repeat(32), status: 'awaiting_approval', summary: '已准备可审阅的修改',
  diff: '--- a/src/demo.ts\n+++ b/src/demo.ts\n@@ -1 +1 @@\n-old\n+new\n',
  changed_files: ['src/demo.ts'],
  checks: [{ command: 'npm run typecheck', status: 'failed', output: 'fixture typecheck failed' }],
  steps: [{ index: 1, action: 'model turn', status: 'completed' }, { index: 2, action: 'tool:bash', status: 'failed' }],
  created_at: stamp, expires_at: '2099-01-01T00:00:00Z',
};
const event = (sequence, type, data, turn_id = 't1') => ({ sequence, session_id: 's1', turn_id, type, timestamp: stamp, data });
const session = {
  id: 's1', user_id: 'fixture', title: '代码任务验收', created_at: stamp, updated_at: stamp, messages: [],
  events: [event(1, 'user.message', { text: '请修改演示代码' }), event(2, 'tool.call', { call_id: 'c1', tool: 'code_task', input: { task: '修改演示代码', workspace: '.' } }), event(3, 'tool.result', { call_id: 'c1', status: 'success', value: preview }), event(4, 'turn.completed', {})],
};
let role = 'admin', mode = 'completed', applyPosts = 0, sentContext;
await context.route('**/api/**', async route => {
  const req = route.request(), path = new URL(req.url()).pathname.replace(/^\/api\/v1/, ''), method = req.method();
  requests.push({ path, method });
  const send = (json, status = 200) => route.fulfill({ json, status });
  if (path === '/auth/me') return send({ id: 'fixture', name: 'fixture', role });
  if (path === '/assistant/config') return send({ model: 'fixture', enabled: true, code_tasks_enabled: role === 'admin', code_workspace: '.' });
  if (path === '/catalog/tables') return send([]);
  if (path === '/assistant/sessions') return send(method === 'POST' ? session : { items: [session] });
  if (path === '/assistant/sessions/s1') return send(session);
  if (path === '/assistant/code-tasks/' + preview.id && method === 'GET') {
    if (mode === 'unavailable') return send({ error: '任务不可用' }, 404);
    return send({ ...preview, status: mode === 'completed' ? 'completed' : 'awaiting_approval', summary: mode === 'completed' ? '修改已应用' : preview.summary });
  }
  if (path === '/assistant/code-tasks/' + preview.id + '/apply' && method === 'POST') {
    applyPosts++; mode = 'completed'; return send({ ...preview, status: 'completed', summary: '修改已应用' });
  }
  if (path === '/assistant/sessions/s1/turns') {
    sentContext = req.postDataJSON().context;
    return route.fulfill({ contentType: 'text/event-stream', body: [event(5, 'user.message', { text: '检查工作区' }, 't2'), event(6, 'turn.completed', {}, 't2')].map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('') });
  }
  unexpected.push({ path, method }); return send({ error: 'unexpected fixture API' }, 500);
});
const approve = () => page.getByRole('button', { name: '审阅并批准应用', exact: true });
const codeCard = () => page.locator('.lm-assistant-code-task');
try {
  await page.goto(site + '/assistant');
  await page.locator('.lm-assistant-session').filter({ hasText: '代码任务验收' }).click();
  await expect(codeCard()).toContainText('修改已应用');
  await expect(approve()).toHaveCount(0);
  checks.push('历史待审批快照经 GET 刷新为 completed，无应用按钮');

  mode = 'unavailable'; await page.getByRole('button', { name: '刷新状态' }).click();
  await expect(codeCard()).toContainText('状态未确认'); await expect(approve()).toHaveCount(0);
  checks.push('GET 404 显示未确认状态且无法审批');

  mode = 'pending'; await page.getByRole('button', { name: '刷新状态' }).click();
  await expect(approve()).toBeEnabled(); await expect(codeCard()).toContainText('1 项检查失败');
  await page.getByText('执行步骤 · 2', { exact: true }).click(); await expect(page.locator('.lm-assistant-code-steps')).toContainText('运行检查');
  await page.getByText('检查结果 · 1', { exact: true }).click(); await expect(page.locator('.lm-assistant-code-check')).toContainText('fixture typecheck failed');
  await page.getByText('代码 Diff · 1 个文件', { exact: true }).click(); await expect(codeCard().locator('.lm-assistant-code-diff')).toContainText('+new');
  checks.push('执行步骤、失败检查输出与 diff 独立展示');

  await approve().click(); let dialog = page.getByRole('dialog', { name: '批准应用代码修改', exact: true });
  await expect(dialog).toContainText('1 个文件'); expect(applyPosts).toBe(0);
  await dialog.getByRole('button', { name: /取\s*消/ }).click(); expect(applyPosts).toBe(0);
  await approve().click(); dialog = page.getByRole('dialog', { name: '批准应用代码修改', exact: true });
  await dialog.getByRole('button', { name: '确认应用 1 个文件', exact: true }).click();
  await expect(dialog).toBeHidden(); expect(applyPosts).toBe(1); await expect(approve()).toHaveCount(0);
  checks.push('Modal 显示文件数，取消零 POST，确认恰一次 POST，完成后审批消失');

  await page.getByRole('textbox', { name: '代码工作区', exact: true }).fill('demo');
  await page.getByRole('textbox', { name: '给 AI 助手的问题' }).fill('检查工作区');
  await page.getByRole('button', { name: '发送', exact: true }).click(); await expect.poll(() => sentContext?.code_workspace).toBe('demo');
  checks.push('管理员 workspace 以 context.code_workspace 发送');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await page.waitForTimeout(350); await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });

  mode = 'pending'; await page.setViewportSize({ width: 390, height: 900 });
  const collapse = page.getByRole('button', { name: '收起导航', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await page.getByRole('button', { name: '刷新状态' }).click(); await expect(approve()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.waitForTimeout(350); await page.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
  checks.push('390px 收起导航后无页面横向溢出');

  role = 'member'; const marker = requests.length;
  await page.goto(site + '/assistant'); await page.getByRole('button', { name: '对话历史', exact: true }).click();
  await page.getByRole('dialog').locator('.lm-assistant-session').filter({ hasText: '代码任务验收' }).click();
  await expect(page.locator('.lm-assistant-user')).toContainText('请修改演示代码'); await expect(codeCard()).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '代码工作区', exact: true })).toHaveCount(0);
  expect(requests.slice(marker).filter(req => req.path.startsWith('/assistant/code-tasks'))).toEqual([]);
  expect(applyPosts).toBe(1); checks.push('member 隐藏代码卡/工作区且零代码 API 请求');
  expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  const report = { checks, pageerrors: errors, unexpected, apply_posts: applyPosts, screenshots: [resolve(output, 'desktop.png'), resolve(output, 'mobile.png')] };
  await writeFile(resolve(output, 'evidence.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
