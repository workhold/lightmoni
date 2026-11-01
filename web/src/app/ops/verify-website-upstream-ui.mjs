import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { mediaDirectory } from '../../../../scripts/qa-artifacts.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const base = process.env.LIGHTMONI_UPSTREAM_UI_URL ?? 'http://127.0.0.1:5176';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw Error('Disposable loopback fixture required');
const out = resolve(root, 'specs/076-website-upstream-validation/evidence');
const media = mediaDirectory(out);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  if (!localStorage.getItem('lightmoni.language')) localStorage.setItem('lightmoni.language', 'zh-CN');
  localStorage.setItem('lightmoni.appearance', 'dark');
});
const page = await context.newPage(), errors = [], checks = [], created = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000);
let saves = 0;
page.on('request', request => {
  if (['POST', 'PUT'].includes(request.method()) && /\/api\/v1\/ops\/resources(?:\/[^/?]+)?$/.test(request.url())) saves++;
});
const modal = () => page.locator('.ant-modal:visible').last();
const save = () => modal().getByRole('button', { name: '保存配置', exact: true }).click();
const targets = () => modal().locator('.lm-ops-cluster-target');
const url = index => targets().nth(index).getByLabel('后端 URL', { exact: true });
async function json(path, options = {}) {
  const response = await context.request.fetch(base + '/api/v1/ops' + path, options);
  if (!response.ok()) throw Error(path + ': ' + response.status() + ' ' + await response.text());
  return response.json();
}
async function seed(kind, name, spec) {
  const { resource } = await json('/resources', { method: 'POST', data: { kind, name, spec } });
  created.push(resource.id);
  return resource;
}
async function choose(label, text, scope = modal()) {
  await scope.getByLabel(label, { exact: true }).click();
  await page.locator('.ant-select-dropdown:visible').getByText(text, { exact: true }).click();
  await page.keyboard.press('Escape');
}
async function shot(name) {
  await page.screenshot({ path: resolve(media, name + '.png'), animations: 'disabled' });
}
try {
  const user = await context.request.get(base + '/api/v1/auth/me');
  expect((await user.json()).id).toBe('qa-admin');
  if ((await json('/overview')).resources.some(r=>r.kind==='application'&&r.spec.role==='openresty')) throw Error('Use a clean disposable fixture');
  const suffix = Date.now().toString(36);
  const clusters = [
    await seed('cluster', '上游验证一-' + suffix, { machine_ids: [], nodes: [] }),
    await seed('cluster', '上游验证二-' + suffix, { machine_ids: [], nodes: [] }),
  ];
  const deployments = clusters.map(c => ({ cluster_id: c.id, replicas: 1, cpu: .25, memory_mb: 128 }));
  const app = await seed('application', 'Registry-' + suffix, {
    source: { type: 'custom' }, role: 'generic', deployment_mode: 'managed', mode: 'container',
    network_mode: 'bridge', image: 'registry:2', deployments,
    ports: [{ name: 'registry', container_port: 5000, protocol: 'tcp', app_protocol: 'http' }],
  });
  await seed('application', '入口-' + suffix, {
    source: { type: 'store', template_id: 'openresty', template_version: '1.27.1.2-0-alpine' },
    role: 'openresty', deployment_mode: 'managed', mode: 'container', network_mode: 'host',
    image: 'openresty/openresty:1.27.1.2-0-alpine',
    deployments: deployments.map((d, i) => ({ ...d, gateway_domain: 'edge' + i + '.example.test' })),
    ports: [{ name: 'http', container_port: 80, host_port: 80, protocol: 'tcp', app_protocol: 'http' },
      { name: 'https', container_port: 443, host_port: 443, protocol: 'tcp', app_protocol: 'https' }],
  });
  await page.goto(base + '/websites');
  await page.getByRole('button', { name: '新建网站', exact: true }).click();
  const siteName = 'docker镜像仓库-' + suffix;
  await modal().getByLabel('名称', { exact: true }).fill(siteName);
  for (const cluster of clusters) await choose('应用集群', cluster.name);
  await modal().getByLabel('网站域名', { exact: true }).fill('registry-' + suffix + '.example.test');
  await modal().getByLabel('网站域名', { exact: true }).press('Enter');
  await modal().getByRole('button', { name: '添加路径规则', exact: true }).click();
  await expect(targets()).toHaveCount(2);
  await url(1).fill('http://10.0.0.2:5000');
  for (const value of ['127.0.0.1:5000', 'registry.internal:5000', 'ftp://127.0.0.1:5000',
    'http://127.0.0.1:5000/v2/', 'http://127.0.0.1:5000/?q=1', 'http://127.0.0.1:5000/#v2',
    'http://user:password@127.0.0.1:5000']) {
    await url(0).fill(value);
    await modal().locator('.ant-modal-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await save();
    const hint = value.includes('user:password') ? '后端 URL 不能包含账号或密码。' :
      value.includes('/v2/') ? '后端 URL 不能包含路径，请在“转发与负载均衡”中设置 URI。' :
      /[?#]/.test(value) ? '后端 URL 不能包含查询参数或片段。' :
      '请以 http:// 或 https:// 开头，例如 http://127.0.0.1:5000。';
    await expect(targets().nth(0).getByText(hint, { exact: true })).toBeVisible();
    await expect(url(0)).toBeFocused();
    await expect(url(0)).toBeInViewport();
    await expect(url(0)).toHaveValue(value);
    await expect(modal().getByText('保存失败，输入已保留', { exact: true })).toHaveCount(0);
    expect(saves).toBe(0);
    if (value === '127.0.0.1:5000') await shot('missing-scheme-dark');
  }
  checks.push('原始127.0.0.1:5000及其他无协议/路径/查询/片段/凭据/非HTTP地址：字段提示、首错聚焦滚动、零保存请求');
  await url(0).fill('');
  await save();
  await expect(targets().nth(0).getByText('请填写后端 URL，例如 http://10.0.0.11:8080', { exact: true })).toBeVisible();
  expect(saves).toBe(0);
  await targets().nth(0).getByRole('button', { name: '删除后端', exact: true }).click();
  await save();
  await expect(targets().nth(0).getByText(/每个集群的手动后端至少需要一个地址/)).toBeVisible();
  expect(saves).toBe(0);
  await targets().nth(0).getByRole('button', { name: '添加后端', exact: true }).click();
  await url(0).fill('http://127.0.0.1:5000');
  await url(1).fill('10.0.0.2:5000');
  await save();
  await expect(url(1)).toBeFocused();
  await expect(url(0)).toHaveValue('http://127.0.0.1:5000');
  expect(saves).toBe(0);
  checks.push('空URL、删除全部后端、第二集群错误均拦截并保留另一集群输入');
  await url(1).fill('https://[fd00::2]:5443/');
  await targets().nth(0).getByLabel('失败次数阈值', { exact: true }).fill('3');
  await targets().nth(0).getByLabel('失败恢复时间（秒）', { exact: true }).fill('5');
  for (const [code, hint] of [
    ['INVALID_WEBSITE_UPSTREAM', '后端 URL 格式不正确'],
    ['WEBSITE_UPSTREAM_REQUIRED', '每个集群的手动后端至少需要一个地址'],
    ['MIXED_UPSTREAM_PROTOCOLS', '同一集群同一路径的后端须统一使用 HTTP 或 HTTPS'],
  ]) {
    await page.route('**/api/v1/ops/resources', route => route.fulfill({ status: 400, json: { error: code } }));
    await save();
    await expect(modal().getByText('保存失败，输入已保留', { exact: true })).toBeVisible();
    await expect(modal().locator('.ant-alert-error .ant-alert-description')).toContainText(hint);
    await expect(modal().getByLabel('名称', { exact: true })).toHaveValue(siteName);
    await expect(url(0)).toHaveValue('http://127.0.0.1:5000');
    await page.unroute('**/api/v1/ops/resources');
  }
  checks.push('三个服务端上游错误显示中文原因且保留所有输入');
  await save();
  await expect(modal()).toBeHidden();
  let site = (await json('/overview')).resources.find(r => r.name === siteName);
  created.push(site.id);
  const savedTargets = site.spec.bindings[0].locations[0].cluster_targets;
  expect(savedTargets.map(t => t.upstreams[0].url)).toEqual(['http://127.0.0.1:5000', 'https://[fd00::2]:5443']);
  expect(savedTargets[0].upstreams[0]).toMatchObject({ weight: 1, max_fails: 3, fail_timeout_seconds: 5 });
  checks.push('纠正协议后真实SQLite/API创建成功，IPv6/根斜杠规范化、权重/失败参数回读正确');
  const edit = async () => {
    const detail=page.locator('.ant-drawer:visible');
    if(await detail.count())await detail.last().locator('.ant-drawer-close').click();
    await page.getByRole('article',{name:siteName,exact:true}).getByRole('button',{name:'编辑配置',exact:true}).click();
  };
  await edit();
  await url(0).fill('127.0.0.1:5000');
  await save();
  await choose('后端来源', '应用命名端口', targets().nth(0));
  await choose('后端应用', app.name + ' · ' + app.spec.service_name, targets().nth(0));
  await choose('应用端口', 'registry · 5000/http', targets().nth(0));
  await save();
  await expect(modal()).toBeHidden();
  site = (await json('/resources/' + site.id)).resource;
  expect(site.spec.bindings[0].locations[0].cluster_targets[0].target).toBe('application');
  expect(site.spec.bindings[0].locations[0].cluster_targets[0].upstreams).toBeUndefined();
  checks.push('有URL错误时切到应用命名端口可保存，隐藏的无效手动后端不会提交');
  await edit();
  await choose('后端管理模式', '托管服务 · 自动发现集群');
  await choose('托管服务', app.name + ' · ' + app.spec.service_name);
  await choose('服务端口', 'registry · 5000/http');
  await save();
  await expect(modal()).toBeHidden();
  site = (await json('/resources/' + site.id)).resource;
  expect(site.spec.routing_mode).toBe('managed');
  checks.push('托管服务分支保存成功');
  await edit();
  await choose('后端管理模式', '手动配置 · 按集群设置后端');
  await choose('后端来源', '手动后端', targets().nth(0));
  await targets().nth(0).getByRole('button', { name: '添加后端', exact: true }).click();
  await url(0).fill('127.0.0.1:5000');
  await save();
  await choose('处理方式', '返回 / 重定向');
  await save();
  await expect(modal()).toBeHidden();
  site = (await json('/resources/' + site.id)).resource;
  expect(site.spec.bindings[0].locations[0].cluster_targets).toEqual([]);
  checks.push('有URL错误时切到返回/重定向可保存');
  await edit();
  await choose('处理方式', '反向代理');
  await choose('网站类型', '静态网站');
  await modal().getByRole('button', { name: '添加文件', exact: true }).click();
  await modal().getByLabel('相对文件路径', { exact: true }).fill('index.html');
  await modal().getByLabel('文件内容', { exact: true }).fill('Registry help');
  await save();
  await expect(modal()).toBeHidden();
  site = (await json('/resources/' + site.id)).resource;
  expect(site.spec.mode).toBe('static');
  checks.push('静态网站不受隐藏上游校验影响');
  await context.addInitScript(() => localStorage.setItem('lightmoni.language', 'en-US'));
  await page.reload();
  await page.getByRole('button', { name: 'New Websites', exact: true }).click();
  await modal().getByLabel('Name', { exact: true }).fill('English registry');
  await choose('Website clusters', clusters[0].name);
  await modal().getByLabel('Website domains', { exact: true }).fill('english-' + suffix + '.example.test');
  await modal().getByLabel('Website domains', { exact: true }).press('Enter');
  await modal().getByRole('button', { name: 'Add path rule', exact: true }).click();
  await targets().nth(0).getByLabel('Upstream URL', { exact: true }).fill('127.0.0.1:5000');
  const before = saves;
  await modal().getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(targets().nth(0).getByText('Start with http:// or https://, for example http://127.0.0.1:5000.', { exact: true })).toBeVisible();
  expect(saves).toBe(before);
  await shot('missing-scheme-english');
  await page.setViewportSize({ width: 390, height: 844 });
  await targets().nth(0).getByLabel('Upstream URL', { exact: true }).scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(modal().getByRole('button', { name: 'Save configuration', exact: true })).toBeInViewport();
  await shot('missing-scheme-390');
  checks.push('英文提示、390px无页面横向溢出且保存按钮可见');
  expect(errors).toEqual([]);
  const results = { checks, errors, saves, media: relative(root, media), scope: 'Current web app, real disposable SQLite/API; server error translation uses injected 400 responses. No Agent execution or production update.' };
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results));
} catch (error) {
  await shot('failure');
  await writeFile(resolve(out, 'failure.txt'), await page.locator('body').innerText());
  throw error;
} finally {
  for (const id of created.reverse()) {
    try {
      const { resource } = await json('/resources/' + id);
      await json('/resources/' + id, { method: 'DELETE', data: { revision: resource.revision } });
    } catch {}
  }
  await browser.close();
}
