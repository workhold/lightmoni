import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mediaDirectory } from '../../../../scripts/qa-artifacts.mjs';

const base = process.env.LIGHTMONI_SERVICE_PORT_UI_URL ?? 'http://127.0.0.1:5179';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw Error('Requires disposable loopback API');
const output = resolve(import.meta.dirname, '../../../../specs/115-website-service-ports/evidence');
await mkdir(output, { recursive: true });
const media = mediaDirectory(output);
let browser;
try { browser = await chromium.launch({ headless: true }); }
catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  localStorage.setItem('lightmoni.language', 'zh-CN');
  localStorage.setItem('lightmoni.appearance', 'light');
});
const page = await context.newPage(), errors = [], checks = [], created = [];
page.on('pageerror', e => errors.push(e.message));
page.setDefaultTimeout(10000);
const modal = () => page.locator('.ant-modal:visible').last();
const target = () => modal().locator('.lm-ops-cluster-target').first();
const json = async (path, method = 'GET', data) => {
  const response = await context.request.fetch(base + '/api/v1' + path, { method, data });
  if (!response.ok()) throw Error(path + ': ' + response.status() + ' ' + await response.text());
  return response.json();
};
const seed = async (kind, name, spec) => {
  const { resource } = await json('/ops/resources', 'POST', { kind, name, spec });
  created.push(resource.id);
  return resource;
};
const choose = async (label, option, scope = modal()) => {
  await scope.getByLabel(label, { exact: true }).click();
  await page.locator('.ant-select-dropdown:visible').getByText(option, { exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
};
const shot = name => page.screenshot({ path: resolve(media, name + '.png'), animations: 'disabled' });
const save = async () => {
  await modal().getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(modal()).toBeHidden();
};
const edit = async (name, label) => {
  const drawer = page.locator('.ant-drawer:visible');
  if (await drawer.count()) await drawer.last().locator('.ant-drawer-close').click();
  await page.getByRole('article', { name, exact: true }).getByRole('button', { name: label, exact: true }).click();
};
try {
  expect((await json('/auth/me')).id).toBe('qa-admin');
  const machines = await json('/machines');
  const machine = machines.find(m => m.agent_id === 'qa-node');
  expect(machine).toBeTruthy();
  const suffix = Date.now().toString(36);
  const cluster = await seed('cluster', '端口验收-' + suffix, { machine_ids: [machine.id] });
  const spec = {
    source: { type: 'custom' }, role: 'generic', deployment_mode: 'manual', mode: 'container',
    image: 'nginx:alpine', network_mode: 'bridge',
    deployments: [{ cluster_id: cluster.id, machine_ids: [machine.id], replicas: 1, cpu: .25, memory_mb: 128 }],
  };
  const empty = await seed('application', '未声明端口-' + suffix, { ...spec, ports: [] });
  let app = await seed('application', '手动 Web-' + suffix, { ...spec, ports: [
    { name: 'web', container_port: 8080, host_port: 18080, protocol: 'tcp', app_protocol: '' },
    { name: 'db', container_port: 5432, host_port: 15432, protocol: 'tcp', app_protocol: 'tcp' },
    { name: 'udp', container_port: 9000, host_port: 19000, protocol: 'udp', app_protocol: 'udp' },
  ] });
  await seed('application', 'OpenResty-' + suffix, {
    source: { type: 'store', template_id: 'openresty', template_version: '1.27.1.2-0-alpine' },
    role: 'openresty', deployment_mode: 'manual', mode: 'container', network_mode: 'host',
    image: 'openresty/openresty:1.27.1.2-0-alpine',
    deployments: spec.deployments.map(d => ({ ...d, gateway_domain: 'edge-' + suffix + '.example.test' })),
    ports: [{ name: 'http', container_port: 80, host_port: 80, protocol: 'tcp', app_protocol: 'http' },
      { name: 'https', container_port: 443, host_port: 443, protocol: 'tcp', app_protocol: 'https' }],
  });
  await page.goto(base + '/websites');
  await page.getByRole('button', { name: '新建网站', exact: true }).click();
  const siteName = '手动服务端口-' + suffix;
  await modal().getByLabel('名称', { exact: true }).fill(siteName);
  await choose('应用集群', cluster.name);
  await modal().getByLabel('网站域名', { exact: true }).fill('ports-' + suffix + '.example.test');
  await modal().getByLabel('网站域名', { exact: true }).press('Enter');
  await modal().getByRole('button', { name: '添加路径规则', exact: true }).click();
  await choose('后端来源', '服务名与端口', target());
  await expect(target().getByText('请先选择后端服务。', { exact: true })).toBeVisible();
  await choose('后端服务名', empty.name + ' · ' + empty.spec.service_name, target());
  await expect(target().getByText(/当前服务未声明端口/)).toBeVisible();
  await choose('后端服务名', app.name + ' · ' + app.spec.service_name, target());
  await expect(target().getByText(/当前服务没有可用于网站的 HTTP\/HTTPS 端口/)).toBeVisible();
  await target().getByLabel('应用端口', { exact: true }).click();
  for (const name of ['web · 8080/tcp', 'db · 5432/tcp', 'udp · 9000/udp']) {
    await expect(page.locator('.ant-select-dropdown:visible .ant-select-item-option-disabled').filter({ hasText: name })).toBeVisible();
  }
  await expect(page.locator('.ant-select-dropdown:visible')).not.toHaveClass(/slide-up-(enter|appear)/);
  await shot('incompatible-service-ports');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  await modal().getByRole('button', { name: /^取\s*消$/ }).click();
  checks.push('未选服务/未声明端口/未标记 HTTP 协议分别提示，TCP/UDP 已声明端口可见但不可选');

  // Correct the existing manual application through its real YAML editor.
  await page.goto(base + '/applications');
  await page.locator('.lm-installed-app').filter({ hasText: app.name }).getByRole('button', { name: /^配\s*置$/ }).click();
  await choose('配置方式', '高级 YAML');
  await modal().getByLabel('Compose 配置（YAML）', { exact: true }).fill(`services:\n  app:\n    image: nginx:alpine\n    ports:\n      - target: 8080\n        published: "18080"\n        protocol: tcp\n        app_protocol: http\n      - target: 5432\n        published: "15432"\n        protocol: tcp\n        app_protocol: tcp\n      - target: 9000\n        published: "19000"\n        protocol: udp\n`);
  await save();
  app = (await json('/ops/resources/' + app.id)).resource;
  expect(app.spec.deployment_mode).toBe('manual');
  expect(app.spec.ports[0]).toMatchObject({ name: 'web', container_port: 8080, host_port: 18080, app_protocol: 'http' });
  checks.push('真实应用 YAML 编辑将旧空协议修正为 HTTP，保留手动模式、命名端口与宿主映射');

  await page.goto(base + '/websites');
  await page.getByRole('button', { name: '新建网站', exact: true }).click();
  await modal().getByLabel('名称', { exact: true }).fill(siteName);
  await choose('应用集群', cluster.name);
  await modal().getByLabel('网站域名', { exact: true }).fill('ports-' + suffix + '.example.test');
  await modal().getByLabel('网站域名', { exact: true }).press('Enter');
  await modal().getByRole('button', { name: '添加路径规则', exact: true }).click();
  await choose('后端来源', '服务名与端口', target());
  await choose('后端服务名', app.name + ' · ' + app.spec.service_name, target());
  await choose('应用端口', 'web · 8080/http', target());
  await shot('manual-web-port-selected');
  await save();
  let site = (await json('/ops/overview')).resources.find(r => r.name === siteName);
  created.push(site.id);
  expect(site.spec.bindings[0].locations[0].cluster_targets[0]).toMatchObject({ target: 'application', application_id: app.id, port_name: 'web' });
  checks.push('手动部署 Web 服务可在逐集群服务后端选择 HTTP 端口并真实保存回读');

  await edit(siteName, '编辑配置');
  await choose('后端管理模式', '托管 · 通过服务发现');
  await choose('后端服务名', app.name + ' · ' + app.spec.service_name);
  await choose('服务端口', 'web · 8080/http');
  await save();
  site = (await json('/ops/resources/' + site.id)).resource;
  expect(site.spec.routing_mode).toBe('managed');
  expect(site.spec.service_application_id).toBe(app.id);
  expect(site.spec.service_port_name).toBe('web');
  checks.push('自动服务发现同样可关联手动部署应用并回读服务与命名端口');

  await context.addInitScript(() => localStorage.setItem('lightmoni.language', 'en-US'));
  await page.reload();
  await edit(siteName, 'Edit configuration');
  await choose('Backend service name', empty.name + ' · ' + empty.spec.service_name);
  await expect(modal().getByText(/This service has no declared ports/)).toBeVisible();
  await choose('Backend service name', app.name + ' · ' + app.spec.service_name);
  await choose('Service port', 'web · 8080/http');
  await expect(modal().getByText(/Both manual and managed deployments can be linked/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await modal().getByLabel('Service port', { exact: true }).scrollIntoViewIfNeeded();
  await expect(modal().getByRole('button', { name: 'Save configuration', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot('english-390');
  checks.push('英文反馈与 390px 窄屏可读、无页面横向溢出且保存按钮可见');
  expect(errors).toEqual([]);
  await writeFile(resolve(output, 'browser.json'), JSON.stringify({ checked_at: new Date().toISOString(), checks, page_errors: errors, scope: 'Real web app and disposable SQLite/HTTP API. No remote Agents, deployments or production changes.' }, null, 2) + '\n');
  console.log(JSON.stringify({ checks, page_errors: errors }));
} catch (error) {
  await shot('failure').catch(() => {});
  await writeFile(resolve(output, 'failure.txt'), await page.locator('body').innerText()).catch(() => {});
  throw error;
} finally {
  for (const id of created.reverse()) {
    try {
      let { resource } = await json('/ops/resources/' + id);
      if (resource.kind === 'cluster') resource = (await json('/ops/resources/' + id, 'PUT', {
        revision: resource.revision, spec: { ...resource.spec, machine_ids: [], nodes: [] },
      })).resource;
      await json('/ops/resources/' + id, 'DELETE', { revision: resource.revision });
    } catch {}
  }
  await browser.close();
}
