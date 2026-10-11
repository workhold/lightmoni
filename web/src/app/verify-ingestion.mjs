import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Run against an isolated QA instance. This creates keys through the real API.
const base = process.env.LIGHTMONI_UI_URL ?? 'http://127.0.0.1:5178';
const output = resolve(import.meta.dirname,'../../../docs/evidence/ingestion-table-keys');
const run = process.env.LIGHTMONI_QA_RUN ?? '1';
await mkdir(output,{recursive:true});
let browser;
try { browser = await chromium.launch({headless:true}); }
catch { browser = await chromium.launch({headless:true,channel:'chrome'}); }
const context = await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,permissions:['clipboard-read','clipboard-write']});
context.setDefaultTimeout(10000);
const page = await context.newPage();
const errors = [];
page.on('pageerror',error => errors.push(error.message));
const checks = [];
async function request(path,options) {
  const response = await context.request.fetch(base+'/api/v1'+path,options);
  if (!response.ok()) throw new Error(`${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function addTable(scope,table) {
  const input = scope.getByRole('combobox',{name:'允许写入的 Table'});
  await input.fill(table); await input.press('Enter'); await input.press('Escape'); await input.press('Tab');
}
async function noOverflow() {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
try {
  const setup = await request('/setup');
  const account = {name:'ingestion-qa',password:'local-ingestion-qa-password'};
  await request(setup.required ? '/setup' : '/auth/login',{method:'POST',data:account});
  await page.goto(base+'/data');
  await expect(page.getByRole('tab',{name:'SDK 接入',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'SDK 接入',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'接入 Agent'})).toHaveCount(0);
  await page.screenshot({path:resolve(output,`sdk-${run}.png`),fullPage:true,animations:'disabled'});
  await page.getByRole('tab',{name:'Agent 接入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'接入 Agent'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'SDK 接入',exact:true})).toHaveCount(0);
  checks.push('SDK 和 Agent 独立 Tab，切换后只显示所选接入方式');

  await page.getByRole('tab',{name:'上报 Key',exact:true}).click();
  const legacy = page.getByRole('row').filter({hasText:'旧 Key 待配置'});
  const legacyPage = Math.floor((await request('/keys')).findIndex(key => key.id === 'qa-legacy') / 10) + 1;
  if (legacyPage > 1) await page.locator(`.ant-pagination-item-${legacyPage}`).click();
  await expect(legacy.getByText('待配置 · 禁止写入')).toBeVisible();
  if (legacyPage > 1) await page.locator('.ant-pagination-item-1').click();
  await page.getByRole('button',{name:/创建 Key$/}).click();
  const dialog = page.getByRole('dialog',{name:'创建上报 Key',exact:true});
  const name = `Web 日志 QA ${run} ${Date.now()}`;
  await dialog.getByRole('textbox',{name:'Key 名称',exact:true}).fill(name);
  await dialog.getByRole('button',{name:/创\s*建/}).click();
  await expect(dialog.getByText('请选择 1–200 个允许写入的逻辑 table')).toBeVisible();
  await addTable(dialog,'*');
  await dialog.getByRole('button',{name:/创\s*建/}).click();
  await expect(dialog.getByText(/无效的逻辑 table/)).toBeVisible();
  await dialog.locator('.ant-select-selection-item-remove').click();
  await addTable(dialog,'web');
  await expect(dialog.getByText(/无效的逻辑 table/)).toBeHidden();
  await dialog.getByRole('textbox',{name:'Key 名称',exact:true}).click();
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  await page.screenshot({path:resolve(output,`key-create-${run}.png`),fullPage:true,animations:'disabled'});
  await dialog.getByRole('button',{name:/创\s*建/}).click();
  const created = page.getByRole('dialog',{name:'Key 已创建，仅显示这一次'});
  await expect(created).toBeVisible();
  const key = (await created.locator('code').innerText()).trim();
  await expect(created.getByText('允许写入：web')).toBeVisible();
  await created.getByRole('button',{name:'已保存',exact:true}).click();
  let list = await request('/keys');
  const item = list.find(item => item.name === name);
  expect(item.allowed_tables).toEqual(['web']);
  expect(item.key).toBeUndefined();
  checks.push('创建必填 table，拒绝通配符，返回白名单且列表不泄露明文');

  const batch = `browser-qa-${item.id}`;
  const payload = {resourceLogs:[{resource:{attributes:[{key:'service.name',value:{stringValue:'browser-qa'}}]},scopeLogs:[{logRecords:[{timeUnixNano:String(BigInt(Date.now())*1000000n),body:{stringValue:'browser QA log'}}]}]}]};
  const send = (signal,table,body=payload) => context.request.post(base+'/v1/'+signal,{data:body,headers:{Authorization:'Bearer '+key,'X-Lightmoni-Table':table,'X-Lightmoni-Batch-ID':batch+'-'+table}});
  expect((await send('logs','web')).status()).toBe(200);
  for (const signal of ['logs','metrics','traces']) expect((await send(signal,'host',{})).status()).toBe(403);
  checks.push('真实上报入口允许 web，logs/metrics/traces 越权 host 均返回 403');

  let row = page.getByRole('row').filter({hasText:name});
  await row.getByRole('button',{name:/编\s*辑/}).click();
  let editor = page.getByRole('dialog',{name:'编辑上报 Key',exact:true});
  await editor.locator('.ant-select-selection-item-remove').click();
  await addTable(editor,'mobile');
  await page.route('**/api/v1/keys/'+item.id,async route => {
    if (route.request().method() === 'PUT') await route.fulfill({status:503,json:{error:'QA 保存失败，请重试'}});
    else await route.continue();
  });
  await editor.getByRole('button',{name:/保\s*存/}).click();
  await expect(editor.getByText('QA 保存失败，请重试')).toBeVisible();
  await expect(editor.locator('.ant-select-selection-item')).toHaveText('mobile');
  list = await request('/keys');
  expect(list.find(key => key.id === item.id).allowed_tables).toEqual(['web']);
  await page.unroute('**/api/v1/keys/'+item.id);
  await editor.getByRole('button',{name:/保\s*存/}).click();
  await expect(editor).toBeHidden();
  await page.reload();
  await page.getByRole('tab',{name:'上报 Key',exact:true}).click();
  row = page.getByRole('row').filter({hasText:name});
  await expect(row.getByText('mobile',{exact:true})).toBeVisible();
  expect((await send('logs','web')).status()).toBe(403);
  expect((await send('logs','mobile',{})).status()).toBe(200);
  checks.push('保存失败保留输入，重试保存和刷新回读成功；权限修改拒绝已确认 web 批次');
  await row.getByRole('button',{name:/禁\s*用/}).click();
  await page.getByRole('button',{name:/确\s*定/}).click();
  await expect(row.getByRole('button',{name:/启\s*用/})).toBeVisible();
  expect((await send('logs','mobile',{})).status()).toBe(401);
  await row.getByRole('button',{name:/启\s*用/}).click();
  await page.getByRole('button',{name:/确\s*定/}).click();
  await expect(row.getByRole('button',{name:/禁\s*用/})).toBeVisible();
  list = await request('/keys');
  expect(list.find(key => key.id === item.id).allowed_tables).toEqual(['mobile']);
  checks.push('启用/禁用保留 table 白名单，禁用后上报返回 401');
  await noOverflow();
  await page.screenshot({path:resolve(output,`keys-${run}.png`),fullPage:true,animations:'disabled'});

  await page.getByRole('button',{name:/创建 Key$/}).click();
  const allEditor = page.getByRole('dialog',{name:'创建上报 Key',exact:true});
  const allName = `全表 Key QA ${run} ${Date.now()}`;
  await allEditor.getByRole('textbox',{name:'Key 名称',exact:true}).fill(allName);
  await expect(allEditor.getByRole('radio',{name:'指定 table',exact:true})).toBeChecked();
  await allEditor.getByRole('radio',{name:'所有 table',exact:true}).check();
  await expect(allEditor.getByRole('combobox',{name:'允许写入的 Table'})).toHaveCount(0);
  await page.screenshot({path:resolve(output,`key-create-all-${run}.png`),fullPage:true,animations:'disabled'});
  await allEditor.getByRole('button',{name:/创\s*建/}).click();
  await expect(created).toBeVisible();
  const allKey = (await created.locator('code').innerText()).trim();
  await expect(created.getByText('允许写入：所有 table')).toBeVisible();
  await created.getByRole('button',{name:'已保存',exact:true}).click();
  list = await request('/keys');
  const allItem = list.find(key => key.name === allName);
  expect(allItem.allow_all_tables).toBe(true);
  expect(allItem.allowed_tables).toEqual([]);
  const allSend = (signal,table) => context.request.post(base+'/v1/'+signal,{data:{},headers:{Authorization:'Bearer '+allKey,'X-Lightmoni-Table':table,'X-Lightmoni-Batch-ID':`all-ui-${allItem.id}-${signal}-${table}`}});
  for (const signal of ['logs','metrics','traces']) expect((await allSend(signal,'future_table')).status()).toBe(200);
  const allRow = page.getByRole('row').filter({hasText:allName});
  await expect(allRow.getByText('所有 table',{exact:true})).toBeVisible();
  await allRow.getByRole('button',{name:/禁\s*用/}).click();
  await page.getByRole('button',{name:/确\s*定/}).click();
  await expect(allRow.getByRole('button',{name:/启\s*用/})).toBeEnabled();
  expect((await allSend('logs','future_table')).status()).toBe(401);
  await allRow.getByRole('button',{name:/启\s*用/}).click();
  await page.getByRole('button',{name:/确\s*定/}).click();
  await expect(allRow.getByRole('button',{name:/禁\s*用/})).toBeVisible();
  expect((await allSend('logs','another_future_table')).status()).toBe(200);
  await page.reload();
  await page.getByRole('tab',{name:'上报 Key',exact:true}).click();
  await allRow.getByRole('button',{name:/编\s*辑/}).click();
  editor = page.getByRole('dialog',{name:'编辑上报 Key',exact:true});
  await expect(editor.getByRole('radio',{name:'所有 table',exact:true})).toBeChecked();
  await editor.getByRole('radio',{name:'指定 table',exact:true}).check();
  await addTable(editor,'web');
  await editor.getByRole('button',{name:/保\s*存/}).click();
  await expect(editor).toBeHidden();
  expect((await allSend('logs','future_table')).status()).toBe(403);
  expect((await allSend('logs','web')).status()).toBe(200);
  checks.push('全表 Key 无需白名单，可写未来 table；启停和刷新保留全表权限，切回白名单立即拒绝其他 table');

  await page.getByRole('tab',{name:'Agent 接入',exact:true}).click();
  await page.getByRole('button',{name:'创建上报 Key',exact:true}).click();
  await page.getByRole('textbox',{name:'新 Key 名称',exact:true}).fill(`Agent QA ${run} ${Date.now()}`);
  await addTable(page,'business');
  const createAgentButton = page.locator('form button[type="submit"]');
  await createAgentButton.click();
  await expect(page.getByRole('button',{name:'复制安装命令',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'复制安装命令',exact:true}).click();
  const command = await page.evaluate(() => navigator.clipboard.readText());
  expect(command).toContain('--key-stdin');
  expect(command).toContain('--endpoint');
  expect(command).toContain("--group-id 'default'");
  list = await request('/keys');
  expect(list.find(key => key.name.startsWith(`Agent QA ${run}`)).allowed_tables).toEqual(['business','files','host','probe']);
  const allAgentName = `Agent 全表 QA ${run} ${Date.now()}`;
  await page.getByRole('textbox',{name:'新 Key 名称',exact:true}).fill(allAgentName);
  await page.getByRole('radio',{name:'所有 table',exact:true}).check();
  await expect(page.getByRole('combobox',{name:'允许写入的 Table'})).toHaveCount(0);
  await expect(createAgentButton).not.toHaveClass(/ant-btn-loading/);
  await createAgentButton.click();
  await expect.poll(async () => (await request('/keys')).find(key => key.name === allAgentName)?.allow_all_tables).toBe(true);
  checks.push('Agent 接入也可显式创建允许所有 table 的 Key');
  await page.getByRole('tab',{name:'SDK 接入',exact:true}).click();
  await page.getByRole('tab',{name:'Agent 接入',exact:true}).click();
  await expect(page.getByLabel('Agent 上报 Key',{exact:true})).toHaveValue('');
  checks.push('Agent Key 默认 host/probe/files，可添加业务 table；复制自动配置命令，切换 Tab 清除明文');

  for (const width of [750,390]) {
    await page.setViewportSize({width,height:900});
    if (await page.locator('.lm-shell.is-nav-expanded').count()) await page.locator('.lm-nav-collapse').click();
    await page.getByRole('tab',{name:'SDK 接入',exact:true}).click();
    await noOverflow();
    await page.screenshot({path:resolve(output,`sdk-${width}-${run}.png`),fullPage:true,animations:'disabled'});
    await page.getByRole('tab',{name:'Agent 接入',exact:true}).click();
    await noOverflow();
    await page.screenshot({path:resolve(output,`agent-${width}-${run}.png`),fullPage:true,animations:'disabled'});
  }
  expect(errors).toEqual([]);
  checks.push('1440/750/390 视口无页面横向溢出，无浏览器运行时异常');
  await writeFile(resolve(output,`report-${run}.json`),JSON.stringify({run,checks,errors,backend:'真实 Auth/SQLite/Ingest；ClickHouse 写入替身'},null,2));
  console.log(JSON.stringify({run,status:'PASS',checks}));
} catch (error) {
  await page.screenshot({path:resolve(output,`failure-${run}.png`),fullPage:true,animations:'disabled'});
  console.log(JSON.stringify({buttons:await page.getByRole('button').allTextContents(),errors}));
  throw error;
} finally { await browser.close(); }
