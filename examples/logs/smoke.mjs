// Real Docker ClickHouse + SQLite + local Agent + Go/Node SDK + browser acceptance.
// No requests or query results are mocked.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(path.join(root,'web/package.json'));
const {chromium,request}=require('playwright');const {expect}=require('@playwright/test');
const base=process.env.LIGHTMONI_TEST_URL??'http://127.0.0.1:18880';
const ui=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5173';
const endpoint=process.env.LIGHTMONI_ENDPOINT??'http://127.0.0.1:4318';
const logicalTable=process.env.LIGHTMONI_LOGS_TABLE??'acceptance';
const table='log_'+logicalTable;const run=process.env.LIGHTMONI_LOGS_REUSE_RUN??('logs-'+randomUUID());
const api=await request.newContext({baseURL:base});
async function get(path){const r=await api.get('/api/v1'+path);if(!r.ok())throw new Error(`${r.status()} ${await r.text()}`);return r.json()}
async function post(path,body){const r=await api.post('/api/v1'+path,{data:body});if(!r.ok())throw new Error(`${r.status()} ${await r.text()}`);return r.json()}
const setup=await get('/setup');const credentials={name:process.env.LIGHTMONI_TEST_USER??'local-admin',password:process.env.LIGHTMONI_TEST_PASSWORD??'local-demo-password'};
await post(setup.required?'/setup':'/auth/login',credentials);for(const item of (await get('/logs/saved-searches')).filter(item=>item.title.startsWith(run)))await api.delete('/api/v1/logs/saved-searches/'+item.id);
const env={...process.env,LIGHTMONI_ENDPOINT:endpoint,LIGHTMONI_LOGS_RUN:run,LIGHTMONI_LOGS_TABLE:logicalTable};
if(!process.env.LIGHTMONI_LOGS_REUSE_RUN)for(const [program,args] of [['go',['run','./examples/logs/go','-count','240']],['node',['examples/logs/node.mjs']]])console.log(execFileSync(program,args,{cwd:root,env,encoding:'utf8',timeout:60000}).trim());
const from=new Date(Date.now()-60*60000).toISOString(),to=new Date(Date.now()+600000).toISOString();
const spec={table_id:table,range:{from,to},services:[],keyword:run,filters:[],sort:'desc',mode:'filters'};
await expect(async()=>{const result=await post('/logs/search',{spec,limit:200});expect(result.total_loaded).toBe(480);expect(result.truncated).toBe(false)}).toPass({timeout:30000,intervals:[500,1000]});
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser=await chromium.launch({headless:true,...(existsSync(chrome)?{executablePath:chrome}:{})});
const context=await browser.newContext({viewport:{width:1512,height:1100},storageState:await api.storageState(),permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const select=async(label,option)=>{await page.getByRole('combobox',{name:label,exact:true}).click();await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({hasText:new RegExp('^'+option.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}).click()};
const waitSearch=()=>{const waiting=page.waitForResponse(r=>r.url().endsWith('/logs/search')&&r.request().method()==='POST');waiting.catch(()=>{});return waiting};
page.on('response',async response=>{if(response.url().endsWith('/logs/search')){try{const body=await response.json();console.log('search',response.status(),body.total_loaded,body.frame?.rows?.length,body.next_cursor,JSON.stringify(response.request().postDataJSON().spec?.keyword))}catch{}}});
const query=async()=>{const response=waitSearch();await page.locator('.lm-log-search-line').getByRole('button',{name:/查\s*询/}).click();expect((await response).status()).toBe(200);await expect(page.locator('.lm-log-search-line').getByRole('button',{name:/查\s*询/})).not.toHaveClass(/loading/)};
try{
 await page.goto(ui+'/logs?'+new URLSearchParams({table,from,to}),{waitUntil:'networkidle'});
 await expect(page.getByRole('heading',{name:'日志探索',exact:true})).toBeVisible();
 await expect(page.getByText('200 条已载入',{exact:true})).toBeVisible();await page.getByRole('combobox',{name:'日志关键词',exact:true}).fill(run);await query();
 await expect(page.getByText('200 条已载入',{exact:true})).toBeVisible();
 expect(await page.locator('.lm-log-histogram canvas').count()).toBeGreaterThan(0);
 expect(await page.locator('.ant-table-tbody-virtual [data-row-key]').count()).toBeLessThan(50);
 for(const count of [400,480]){const response=waitSearch();await page.getByRole('button',{name:/加载更多$/}).click();expect((await response).status()).toBe(200);await expect(page.getByText(`${count} 条已载入`,{exact:true})).toBeVisible()}
 await select('服务筛选','logs-go-demo');await query();await expect(page.getByText('200 条已载入',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:/添加过滤$/}).click();
 const modal=page.getByRole('dialog',{name:'添加过滤'});
 const modalSelect=async(label,option)=>{const labels={'字段范围':'过滤字段范围','字段':'过滤字段','值类型':'过滤值类型'};await modal.getByRole('combobox',{name:labels[label],exact:true}).click();await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({hasText:new RegExp('^'+option.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}).click()};
 await modalSelect('字段范围','自定义属性');await modalSelect('字段','status');await modalSelect('值类型','数字');await modal.getByRole('spinbutton').fill('500');
 const filterResponse=waitSearch();await modal.getByRole('button',{name:'应用过滤'}).click();expect((await filterResponse).status()).toBe(200);await expect(page.getByText('48 条已载入',{exact:true})).toBeVisible();
 await expect(page.locator('.lm-log-chips')).toContainText('status');
 await page.getByRole('textbox',{name:'搜索字段',exact:true}).fill('retryable');await page.getByRole('button',{name:'添加列 attr:retryable',exact:true}).click();await expect(page.locator('.lm-log-column-title').filter({hasText:'retryable'})).toBeVisible();
 await page.getByRole('button',{name:/列$/}).click();await expect(page.getByRole('dialog',{name:'显示列与顺序'})).toBeVisible();await page.getByRole('button',{name:/完\s*成$/}).click();
 const handle=page.getByRole('separator',{name:'调整 body 列宽'});await handle.focus();await handle.press('ArrowRight');await expect(handle).toBeFocused();
 await page.locator('.lm-log-message').first().click();const detail=page.getByRole('dialog',{name:/日志详情/});await expect(detail).toBeVisible();await expect(detail.locator('.lm-log-body')).toContainText('PaymentError');
 await detail.getByRole('tab',{name:/JSON$/}).click();await expect(detail.locator('.lm-log-json-node').first()).toContainText('retryable');
 await detail.getByRole('button',{name:/同源上下文$/}).click();await expect(detail.locator('.lm-log-context')).toContainText('源输出顺序');await expect(detail.locator('.lm-log-context > button')).not.toHaveCount(0);
 await detail.getByRole('button',{name:/复制链接$/}).click();const link=await page.evaluate(()=>navigator.clipboard.readText());expect(link).toContain('event=');expect(link).not.toContain('key=');
 await detail.locator('.ant-drawer-close').click();
 await page.getByRole('button',{name:/保存检索$/}).click();await page.getByRole('textbox',{name:'检索名称'}).fill(run);await page.getByRole('button',{name:/保\s*存$/}).click();await expect(page.getByRole('dialog',{name:/保存检索/})).not.toBeVisible();
 await page.getByRole('button',{name:'保存的检索',exact:true}).click();const savedDrawer=page.getByRole('dialog',{name:'保存的检索'});const savedItem=savedDrawer.locator('.ant-table-row').filter({hasText:run}).first();await expect(savedItem).toBeVisible();await savedItem.getByRole('button',{name:/分\s*享$/}).click();const savedLink=await page.evaluate(()=>navigator.clipboard.readText());expect(savedLink).toContain('saved=');await savedDrawer.locator('.ant-drawer-close').click();
 await page.goto(savedLink);await expect(page.getByText('48 条已载入',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'更多日志操作'}).click();await page.getByRole('menuitem',{name:'查看执行 SQL'}).click();const sql=page.getByRole('dialog',{name:'实际执行的 SQL'});await expect(sql).toContainText('lm_log');await sql.getByRole('button',{name:'在 SQL 工作台打开'}).click();await expect(page).toHaveURL(/\/query\?/);await expect(page.getByRole('heading',{name:'SQL 工作台',exact:true})).toBeVisible();await page.goBack();await expect(page.getByText('48 条已载入',{exact:true})).toBeVisible();
 const downloadPromise=page.waitForEvent('download');downloadPromise.catch(()=>{});await page.getByRole('button',{name:'更多日志操作'}).click();await page.getByRole('menuitem',{name:'导出已载入日志 CSV'}).click();const download=await downloadPromise;expect(download.suggestedFilename()).toMatch(/\.csv$/);
 await page.getByRole('button',{name:/^实时$/}).click();await expect(page.getByRole('button',{name:'暂停实时',exact:true})).toBeVisible();console.log(execFileSync('go',['run','./examples/logs/go','-count','5'],{cwd:root,env,encoding:'utf8',timeout:60000}).trim());await expect(page.locator('.lm-log-new')).toContainText('1 条新到达',{timeout:20000});await expect(page.getByText('48 条已载入',{exact:true})).toBeVisible();await page.locator('.lm-log-new').click();await expect(page.getByText('49 条已载入',{exact:true})).toBeVisible();await page.getByRole('button',{name:'暂停实时',exact:true}).click();await page.getByRole('button',{name:'实时',exact:true}).click();await expect(page.getByRole('button',{name:'暂停实时',exact:true})).toBeVisible();await page.getByRole('button',{name:'暂停实时',exact:true}).click();
 const resultDir=path.join(root,'examples/logs/results');mkdirSync(resultDir,{recursive:true});await page.screenshot({path:path.join(resultDir,'explore.png'),fullPage:true});writeFileSync(path.join(resultDir,'run.json'),JSON.stringify({run,table,from,to,ui,base,endpoint},null,2));
 expect(errors).toEqual([]);console.log('PASS real SDK → Agent → ClickHouse logs: pagination, service/typed filter, fields, keyboard column resize, raw/JSON/context, saved share, SQL backlink, CSV, live pause/resume.');
 const items=await get('/logs/saved-searches');for(const item of items.filter(x=>x.title.startsWith(run)))await api.delete('/api/v1/logs/saved-searches/'+item.id);
}catch(error){const dir=path.join(root,'examples/logs/results');mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(-2500));throw error}finally{for(const item of (await get('/logs/saved-searches')).filter(item=>item.title.startsWith(run)))await api.delete('/api/v1/logs/saved-searches/'+item.id);await browser.close();await api.dispose()}
