// Run only against the dedicated local metric-period QA server, using tsx.
// The fixture seeds past effective times to exercise 1h periods without waiting an hour.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '../web/node_modules/@playwright/test/index.mjs';
import { DB } from '../runtime/src/shared/sqlite.ts';
import { createLightMoni } from '../sdk/typescript/dist/src/index.js';

const base='http://127.0.0.1:18887';
const periods=[10,30,60,300,600,1800,3600];
const labels=['10 秒','30 秒（默认）','1 分钟','5 分钟','10 分钟','30 分钟','1 小时'];
const account={name:'metric-period-qa',password:'local-metric-period-password'};
const prefix='periodqa_'+Date.now().toString(16);
const tables=periods.map(seconds=>prefix+'_'+seconds);
const evidence={passed:false,checked_at:new Date().toISOString(),configuration:[],clickhouse:[],ui:[],page_errors:[],fixture_history_seeded:true};
const screenshots=resolve('artifacts/screenshots/metric-periods');
await mkdir(screenshots,{recursive:true});
let cookie='',key,client,browser,page;
async function request(path,method='GET',body,expected=200){
 const response=await fetch(base+'/api/v1'+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const value=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(value)}`);return value;
}
try {
 const setup=await request('/setup');
 const login=await fetch(base+'/api/v1'+(setup.required?'/setup':'/auth/login'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(account)});
 assert.ok(login.ok);cookie=login.headers.get('set-cookie').split(';')[0];
 key=await request('/keys','POST',{name:'metric period acceptance'},201);
 for(const [index,seconds] of periods.entries()){
  const initial=await request('/metric-windows/'+tables[index]);
  assert.equal(initial.default_seconds,30);assert.deepEqual(initial.periods,periods);assert.equal(initial.history.at(-1).seconds,30);
  const saved=await request('/metric-windows/'+tables[index],'PUT',{window_seconds:seconds});
  assert.equal(saved.history.at(-1).seconds,seconds);
  evidence.configuration.push({seconds,default_seconds:initial.default_seconds,saved:true});
 }
 for(const window_seconds of [20,120,[10,30],'30'])await request('/metric-windows/'+tables[0],'PUT',{window_seconds},400);
 const db=new DB(resolve('.local-dev/metric-periods-qa/state/lightmoni.db'));
 try {
  const effective=Math.floor((Date.now()/1000-7200)/3600)*3600;
  db.transaction(()=>{for(const [index,seconds] of periods.entries()){
   db.run('DELETE FROM metric_window_config WHERE logical_name=?',tables[index]);
   if(seconds!==30)db.run('INSERT INTO metric_window_config VALUES(?,?,?)',tables[index],effective,seconds);
  }});
 } finally {db.close();}
 client=createLightMoni({service:'metric-period-qa',env:'test',endpoint:base,key:key.key,selfTelemetry:false,configIntervalMs:3600000});
 await client.refreshConfig();
 for(const table of tables){client.record(table,'duration',{},10,1);client.record(table,'duration',{},20,1);}
 await client.flush();
 for(const table of tables)client.record(table,'duration',{},30,1);
 await client.flush();
 const hour=Math.floor(Date.now()/3600000)*3600000;
 const range={from:new Date(hour-3600000).toISOString(),to:new Date(hour+3600000).toISOString()};
 for(const [index,seconds] of periods.entries()){
  const response=await request('/query','POST',{range,interval_ms:seconds*1000,queries:[{refId:'A',sql:`SELECT window_seconds,sum(\`count\`) AS samples,sum(\`value\`) AS total FROM ${tables[index]} GROUP BY window_seconds`}]});
  const result=response.results[0];assert.equal(result.status,'success',JSON.stringify(result));
  const frame=result.frames[0];const rows=frame.rows.map(row=>Object.fromEntries(frame.columns.map((column,i)=>[column.name,row[i]])));
  assert.equal(rows.length,1);assert.equal(Number(rows[0].window_seconds),seconds);assert.equal(Number(rows[0].samples),3);assert.equal(Number(rows[0].total),60);
  evidence.clickhouse.push({seconds,samples:3,total:60,incremental_flush:true});
 }
 const invalid=await request('/query','POST',{range,interval_ms:10000,queries:[{refId:'A',sql:`SELECT sum(\`count\`) FROM ${tables[1]}`}]});
 assert.equal(invalid.results[0].status,'error');
 try {browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
 const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai'});
 const separator=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,separator),value:cookie.slice(separator+1),url:base}]);
 page=await context.newPage();page.on('pageerror',error=>evidence.page_errors.push(error.message));
 await page.goto(base+'/data-management');
 await expect(page.getByRole('heading',{name:'数据管理'})).toBeVisible();
 await expect.poll(()=>page.getByRole('row').count()).toBeGreaterThan(1);
 const row=page.getByRole('row').filter({hasText:tables[0]});
 while(!await row.count())await page.locator('.ant-pagination-next:not(.ant-pagination-disabled)').click();
 await expect(row).toBeVisible();
 const open=async()=>{
  await row.getByRole('button',{name:'聚合周期',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'上报聚合周期'})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'上报聚合周期'})).toBeEnabled();
  await page.getByRole('dialog').evaluate(async element=>{
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   await Promise.all(element.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));
  });
 };
 for(const [index,seconds] of periods.entries()){
  await open();
  await page.getByRole('combobox',{name:'上报聚合周期'}).click();
  await page.locator('.ant-select-item-option').filter({has:page.getByText(labels[index],{exact:true})}).click();
  const [saved]=await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/metric-windows/'+tables[0]&&response.request().method()==='PUT'),page.getByRole('dialog').getByRole('button',{name:/保\s*存/}).click()]);
  assert.equal(saved.status(),200);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  assert.equal((await request('/metric-windows/'+tables[0])).history.at(-1).seconds,seconds);
  await open();await expect(page.getByRole('dialog').getByText(labels[index],{exact:true})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:/取\s*消/}).click();
  evidence.ui.push({seconds,saved:true,reopened:true});
 }
 // Actual authorization failure, without intercepting or replacing API responses.
 await request('/users','POST',{name:prefix,password:'local-metric-member-password',role:'member'},201);
 await open();await page.getByRole('combobox',{name:'上报聚合周期'}).click();
 await page.locator('.ant-select-item-option').filter({has:page.getByText('1 分钟',{exact:true})}).click();
 await context.request.post(base+'/api/v1/auth/login',{data:{name:prefix,password:'local-metric-member-password'}});
 await page.getByRole('dialog').getByRole('button',{name:/保\s*存/}).click();
 await expect(page.getByRole('dialog').getByRole('alert')).toContainText('管理员');
 await expect(page.getByRole('dialog').getByText('1 分钟',{exact:true})).toBeVisible();
 await context.request.post(base+'/api/v1/auth/login',{data:account});
 await page.getByRole('dialog').getByRole('button',{name:/保\s*存/}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
 evidence.save_failure_preserved=true;
 await open();await page.screenshot({path:resolve(screenshots,'desktop.png'),fullPage:true,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});
 await expect.poll(async()=>{const dialog=await page.getByRole('dialog').boundingBox();return !!dialog&&dialog.x>=0&&dialog.x+dialog.width<=391;}).toBe(true);
 await page.screenshot({path:resolve(screenshots,'narrow.png'),fullPage:true,animations:'disabled'});
 assert.equal((await request('/metric-windows/'+tables[1])).history.at(-1).seconds,30);
 assert.equal(evidence.page_errors.length,0);
 evidence.passed=true;
} catch(error) {
 evidence.failure=error.message;
 await page?.screenshot({path:resolve(screenshots,'failure.png'),fullPage:true}).catch(()=>{});
 throw error;
} finally {
 await browser?.close();await client?.shutdown();
 if(key)await request('/keys/'+key.id,'PUT',{active:false});
 await mkdir('docs/evidence/metric-periods',{recursive:true});
 await writeFile('docs/evidence/metric-periods/report.json',JSON.stringify(evidence,null,2)+'\n');
}
console.log(JSON.stringify({passed:evidence.passed,periods:periods.length,clickhouse:evidence.clickhouse.length,ui:evidence.ui.length,page_errors:evidence.page_errors.length}));
