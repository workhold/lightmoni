// Real UI -> SQLite policy -> Node/browser SDK -> isolated ClickHouse.
import { mediaDirectory } from '../../scripts/qa-artifacts.mjs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createLightMoni} from '../../sdk/typescript/dist/src/index.js';
import {sampleLog} from '../../sdk/typescript/dist/src/sampling.js';
const require=createRequire(resolve('web/package.json')),{chromium,request}=require('playwright'),{expect}=require('@playwright/test');
const base=process.env.LIGHTMONI_TEST_URL??'http://127.0.0.1:18882',ui=process.env.LIGHTMONI_UI_URL??'http://localhost:15175',ch=process.env.LIGHTMONI_CH_URL??'http://127.0.0.1:18124';
const out=resolve('docs/evidence/sdk-reporting'),table='sdk_rules_'+randomUUID().slice(0,8),service='rules-node-'+randomUUID().slice(0,8),instance='rules-instance-'+randomUUID().slice(0,8);
await mkdir(out,{recursive:true});
const mediaOutput=mediaDirectory(out);
const api=await request.newContext({baseURL:base});
async function call(method,path,data){const response=await api[method]('/api/v1'+path,{data});if(!response.ok())throw new Error(`${response.status()} ${await response.text()}`);return response.json();}
const setup=await call('get','/setup'),credentials={name:process.env.LIGHTMONI_TEST_USER??'rules-admin',password:process.env.LIGHTMONI_TEST_PASSWORD??'rules-demo-password'};await call('post',setup.required?'/setup':'/auth/login',credentials);
const {key}=await call('post','/keys',{name:'reporting fixture '+table,allowed_tables:[table],allow_all_tables:false});
const mon=createLightMoni({service,table,instanceId:instance,endpoint:base,key,selfTelemetry:false,intervalMs:3600000,configIntervalMs:1000});
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({storageState:{...(await api.storageState()),cookies:(await api.storageState()).cookies.map(c=>({...c,domain:new URL(ui).hostname}))},viewport:{width:1440,height:1000},...(process.env.LIGHTMONI_RECORD_UI==='1'?{recordVideo:{dir:mediaOutput,size:{width:1440,height:1000}}}:{})}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
let relay;
try{
 mon.log('info','seed');await mon.flush();
 await page.goto(ui+'/data?tab=tables');await expect(page.getByRole('tab',{name:'数据表',exact:true})).toBeVisible();
 await expect(page.locator('.ant-table-tbody .ant-table-row').first()).toBeVisible();
 async function findTableRow(){
  await expect(page.locator('.ant-table-tbody .ant-table-row').first()).toBeVisible();
  const row=page.getByRole('row').filter({has:page.getByText('log_'+table,{exact:true})});
  while(await row.count()===0){const current=Number(await page.locator('.ant-pagination-item-active').getAttribute('title'));await page.locator('.ant-pagination-next:not(.ant-pagination-disabled)').click();await expect(page.locator('.ant-pagination-item-active')).toHaveAttribute('title',String(current+1));}
  return row;
 }
 let row=await findTableRow();
 await expect(row).toBeVisible();await row.getByRole('button',{name:'上报规则',exact:true}).click();let dialog=page.getByRole('dialog');await expect(dialog.getByText('匹配所有日志',{exact:true})).toBeVisible();
 await dialog.locator('.lm-log-rule').first().getByRole('button',{name:'删除规则',exact:true}).click();
 await dialog.getByRole('button',{name:'添加 QA 用户',exact:true}).click();await dialog.locator('.lm-log-rule').first().getByRole('textbox',{name:'匹配值 1',exact:true}).fill('qa');
 await dialog.getByRole('button',{name:'添加 VIP 用户',exact:true}).click();await dialog.getByRole('button',{name:'添加全部日志 10%',exact:true}).click();
 const normal=dialog.locator('.lm-log-rule').nth(2);await normal.getByRole('button',{name:'添加条件',exact:true}).click();await normal.getByRole('textbox',{name:'匹配字段 1',exact:true}).fill('attr:event');await normal.getByRole('textbox',{name:'匹配值 1',exact:true}).fill('click');
 await dialog.getByRole('textbox',{name:'稳定采样依据',exact:true}).fill('attr:user_id');
 await dialog.getByRole('tab',{name:'排除规则 (0)',exact:true}).click();await dialog.getByRole('button',{name:'添加排除规则',exact:true}).click();await dialog.getByRole('textbox',{name:'匹配值 1',exact:true}).fill('blocked');
 await dialog.getByRole('button',{name:'保存并下发',exact:true}).click();await expect(dialog).toHaveCount(0);
 const policy=await call('get',`/catalog/tables/log_${table}/log-sampling`);expect(policy.rules.length).toBe(3);expect(policy.exclude[0].conditions[0].values).toEqual(['blocked']);
 await page.reload();row=await findTableRow();await row.getByRole('button',{name:'上报规则',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.locator('.lm-log-rule')).toHaveCount(3);await expect(dialog.getByRole('textbox',{name:'稳定采样依据'})).toHaveValue('attr:user_id');
 await expect(dialog.getByRole('button',{name:'保存并下发',exact:true})).toBeEnabled();await expect.poll(()=>dialog.evaluate(el=>getComputedStyle(el).opacity)).toBe('1');await page.screenshot({path:resolve(mediaOutput,'log-rules-desktop.png'),fullPage:false});await page.setViewportSize({width:390,height:844});await expect.poll(()=>dialog.locator('.lm-log-rule-heading').first().evaluate(el=>getComputedStyle(el).display)).toBe('grid');await page.screenshot({path:resolve(mediaOutput,'log-rules-390.png'),fullPage:false,animations:'disabled'});
 const overflow=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,modal:document.querySelector('[role=dialog]').getBoundingClientRect().toJSON(),footer:document.querySelector('.ant-modal-footer').getBoundingClientRect().toJSON()}));expect(overflow.document).toBeLessThanOrEqual(overflow.viewport+1);await dialog.getByRole('button',{name:/取\s*消/}).click();await page.setViewportSize({width:1440,height:1000});
 await mon.refreshConfig();const counter=mon.counter('events');const inputs=[['qa',{user_id:'qa',event:'click'}],['vip',{user_id:'vip',is_vip:true}],['blocked',{user_id:'blocked',is_vip:true,event:'click'}],['unmatched',{}],['string-vip',{is_vip:'true'}]];let expected=0;
 for(const [body,attrs]of inputs){counter.add(1,attrs);const d=sampleLog(policy,table,{record:{event_id:'x',severity:'INFO',service,instance_id:instance,'sdk.language':'typescript'},attributes:attrs,resource:{}});if(d.keep)expected++;mon.log('info',body,attrs);}
 for(let i=0;i<1000;i++){const attrs={user_id:String(i),event:'click'};counter.add(1,attrs);if(sampleLog(policy,table,{record:{event_id:'x'},attributes:attrs,resource:{}}).keep)expected++;mon.log('info','click '+i,attrs);}
 mon.startSpan('blocked-user',{user_id:'blocked'}).end();await mon.flush();
 async function sql(query){const response=await fetch(ch+'/?database=lightmoni',{method:'POST',headers:{Authorization:'Basic '+Buffer.from('lightmoni:lightmoni_test_password').toString('base64')},body:query+' FORMAT JSON'});if(!response.ok)throw new Error(await response.text());return (await response.json()).data;}
 const logs=(await sql(`SELECT count() AS total,countIf(body='blocked') AS blocked,countIf(body='unmatched') AS unmatched FROM log_${table} WHERE body!='seed'`))[0];expect(Number(logs.total)).toBe(expected);expect(Number(logs.blocked)).toBe(0);expect(Number(logs.unmatched)).toBe(0);
 expect(Number((await sql(`SELECT sum(value_int) AS total FROM metric_${table}_sum WHERE name='events'`))[0].total)).toBe(1005);expect(Number((await sql(`SELECT count() AS total FROM trace_${table}`))[0].total)).toBe(1);
 // Stop only this instance through the real UI; preserve another instance.
 counter.add(7);mon.log('info','purge me',{user_id:'qa'});
 await page.goto(ui+'/data?tab=sdk');await page.getByRole('button',{name:'SDK 停报规则',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'添加排除规则',exact:true}).click();await dialog.getByRole('textbox',{name:'匹配字段 1',exact:true}).fill('instance_id');await dialog.getByRole('textbox',{name:'匹配值 1',exact:true}).fill(instance);await dialog.getByRole('button',{name:'保存并下发',exact:true}).click();await expect(dialog).toHaveCount(0);
 await mon.refreshConfig();expect(mon.stats().reportingDisabled).toBe(true);counter.add(100);mon.log('info','disabled',{user_id:'qa'});mon.startSpan('disabled').end();await mon.flush();
 const other=createLightMoni({service,table,instanceId:instance+'-other',endpoint:base,key,selfTelemetry:false});try{await other.refreshConfig();expect(other.stats().reportingDisabled).toBe(false);other.log('info','other instance',{user_id:'qa'});await other.flush();}finally{await other.shutdown();}
 await page.reload();await page.getByRole('button',{name:'SDK 停报规则',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByRole('textbox',{name:'匹配值 1',exact:true})).toHaveValue(instance);await expect(dialog.getByRole('button',{name:'保存并下发',exact:true})).toBeEnabled();await expect.poll(()=>dialog.evaluate(el=>getComputedStyle(el).opacity)).toBe('1');await page.screenshot({path:resolve(mediaOutput,'sdk-stop-desktop.png'),fullPage:false});await dialog.getByRole('button',{name:'删除规则',exact:true}).click();await dialog.getByRole('button',{name:'保存并下发',exact:true}).click();await expect(dialog).toHaveCount(0);
 await mon.refreshConfig();expect(mon.stats().reportingDisabled).toBe(false);counter.add(3);mon.log('info','resumed',{user_id:'qa'});await mon.flush();expect(Number((await sql(`SELECT sum(value_int) AS total FROM metric_${table}_sum WHERE name='events'`))[0].total)).toBe(1008);expect(Number((await sql(`SELECT count() AS total FROM log_${table} WHERE body IN ('purge me','disabled')`))[0].total)).toBe(0);
 // Browser has no center Key; the business backend proxies config and OTLP.
 relay=spawn(process.execPath,['examples/sdk/browser/server.mjs'],{env:{...process.env,LIGHTMONI_ENDPOINT:base,LIGHTMONI_KEY:key,PORT:'18420'},stdio:'ignore'});
 const browserPage=await context.newPage();await expect(async()=>{await browserPage.goto('http://127.0.0.1:18420');await expect(browserPage.getByRole('heading',{name:'浏览器 SDK 接入示例'})).toBeVisible();}).toPass({timeout:10000});
 const browserStats=await browserPage.evaluate(async({table})=>{const {createLightMoni}=await import('/sdk/typescript/dist/src/browser.js');const c=createLightMoni({service:'rules-browser',table,endpoint:location.origin,selfTelemetry:false});try{await c.refreshConfig();c.counter('browser.events').add(2);c.log('info','browser QA',{user_id:'qa'});c.log('info','browser blocked',{user_id:'blocked',is_vip:true});await c.flush();return c.stats();}finally{await c.shutdown();}},{table});expect(browserStats.excludedLogs).toBe(1);expect(browserStats.configRevision).toBeTruthy();expect(Number((await sql(`SELECT count() AS total FROM log_${table} WHERE body='browser QA'`))[0].total)).toBe(1);expect(Number((await sql(`SELECT sum(value_int) AS total FROM metric_${table}_sum WHERE name='browser.events'`))[0].total)).toBe(2);await browserPage.close();
 // Real API rejection keeps the editor and the user's input available.
 await page.goto(ui+'/data?tab=tables');const target=await findTableRow();await target.getByRole('button',{name:'上报规则',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByRole('textbox',{name:'稳定采样依据'})).toHaveValue('attr:user_id');
 const keys=await call('get','/keys');await call('put','/keys/'+keys.find(k=>k.name==='reporting fixture '+table).id,{active:false});
 // Save failure is exercised by logging out, without mocking any endpoint.
 await call('post','/auth/logout',{});await dialog.getByRole('button',{name:'保存并下发',exact:true}).click();await expect(dialog.getByRole('alert')).toBeVisible();await expect(dialog.getByRole('textbox',{name:'稳定采样依据'})).toHaveValue('attr:user_id');await page.screenshot({path:resolve(mediaOutput,'save-failure.png'),fullPage:true});
 expect(errors).toEqual([]);const report={passed:true,table,expected_sampled_logs:expected,actual_sampled_logs:Number(logs.total),metric_total:1008,trace_total:1,browser_metric_total:2,other_instance_unaffected:true,resume_without_backfill:true,save_failure_keeps_input:true,mobile:overflow,errors};await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await page.screenshot({path:resolve(mediaOutput,'failure.png'),fullPage:true}).catch(()=>{});throw error;}finally{relay?.kill();await mon.shutdown().catch(()=>{});await context.close();if(page.video()){await page.video().saveAs(resolve(mediaOutput,'ui-flow.webm'));await page.video().delete();}await browser.close();await api.dispose();}
