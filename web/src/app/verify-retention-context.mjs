import { mediaDirectory } from '../../../scripts/qa-artifacts.mjs';
import {chromium,expect} from '@playwright/test';
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Dedicated QA instance with real SQLite and ClickHouse. Only AI model output
// and deliberate failure responses are intercepted; no external AI call occurs.
const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5179';
const chBase=process.env.LIGHTMONI_QA_CH_URL??'http://127.0.0.1:18124';
const run=process.env.LIGHTMONI_QA_RUN??'1';
const output=resolve(import.meta.dirname,'../../../docs/evidence/retention-context');
await mkdir(output,{recursive:true});
const mediaOutput=mediaDirectory(output);
let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:run==='1'?{dir:mediaOutput,size:{width:1440,height:1000}}:undefined}),page=await context.newPage();
context.setDefaultTimeout(15000);
await context.addInitScript(()=>{localStorage.setItem('lightmoni.nav.collapsed','false');localStorage.setItem('lightmoni.appearance','dark');});
const errors=[],checks=[],snapshots=[];
page.on('pageerror',error=>errors.push(error.message));
async function json(path,options){const response=await context.request.fetch(`${base}/api/v1${path}`,options);if(!response.ok())throw new Error(`${path}: ${response.status()} ${await response.text()}`);return response.json();}
async function choose(label,text){await page.getByRole('combobox',{name:label,exact:true}).click();await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:text}).click();}
async function ttl(name){const response=await context.request.post(chBase+'/?query='+encodeURIComponent(`SHOW CREATE TABLE lightmoni._lm_${name} FORMAT TabSeparatedRaw`),{headers:{Authorization:'Basic '+Buffer.from('lightmoni:lightmoni_test_password').toString('base64')}});expect(response.ok()).toBe(true);return response.text();}
async function shot(name){await page.screenshot({path:resolve(mediaOutput,`${run}-${name}.png`),fullPage:true,animations:'disabled'});}
async function openAI(expected){await page.getByRole('button',{name:'打开 AI 助手',exact:true}).click();await expect(page.locator('.lm-assistant-page-context')).toContainText(expected);await expect(page.getByRole('textbox',{name:'给 AI 助手的问题'})).toBeEnabled();await page.getByRole('textbox',{name:'给 AI 助手的问题'}).fill('分析当前页面');const before=snapshots.length;await page.getByRole('button',{name:'发送',exact:true}).click();await expect.poll(()=>snapshots.length).toBe(before+1);return snapshots.at(-1);}
async function closeAI(){await page.locator('.ant-drawer:visible').filter({has:page.locator('.lm-assistant')}).locator('.ant-drawer-close').click();await expect(page.locator('.lm-assistant.is-compact')).toHaveCount(0);}
async function mode(value){await choose('单表保留方式',value);}
async function tableEditor(name){await page.locator('.ant-table-row').filter({hasText:name}).getByRole('button',{name:'设置时长'}).click();await expect(page.getByRole('dialog',{name:'数据表保留时长'})).toBeVisible();}
async function saveTable(){await page.getByRole('button',{name:'保存时长',exact:true}).click();await expect(page.getByRole('dialog',{name:'数据表保留时长'})).toBeHidden();}
try{
 const setup=await json('/setup'),account={name:'retention-qa',password:'local-retention-qa-password'};
 await json(setup.required?'/setup':'/auth/login',{method:'POST',data:account});
 await json('/settings/retention',{method:'PUT',data:{default_days:7}});
 const logical=`uiqa${run}`,logName=`log_${logical}`,metricName=`metric_${logical}_gauge`;
 const key=await json('/keys',{method:'POST',data:{name:`retention-qa-${run}`,allowed_tables:[logical]}});
 const time=String(BigInt(Date.now())*1000000n),resource={attributes:[{key:'service.name',value:{stringValue:'orders-api'}}]};
 for(const [signal,data]of [['logs',{resourceLogs:[{resource,scopeLogs:[{logRecords:[{timeUnixNano:time,severityText:'ERROR',body:{stringValue:'支付超时 retention-context QA'},attributes:[{key:'status',value:{intValue:'504'}}]}]}]}]}],['metrics',{resourceMetrics:[{resource,scopeMetrics:[{metrics:[{name:'latency',gauge:{dataPoints:[{timeUnixNano:time,asDouble:12}]}}]}]}]}]]){
  const response=await context.request.post(`${base}/v1/${signal}`,{headers:{Authorization:`Bearer ${key.key}`,'X-Lightmoni-Table':logical,'Content-Type':'application/json'},data});expect(response.ok(),await response.text()).toBe(true);
 }
 const table=()=>json('/catalog/tables').then(tables=>tables.find(t=>t.id===logName));
 expect((await table()).effective_retention_days).toBe(7);expect((await ttl(metricName))).toContain('toIntervalDay(7)');
 const dashboard=await json('/dashboards',{method:'POST',data:{title:`订单监控 · ${run}`,description:'上下文验证',panels:[{id:crypto.randomUUID(),title:'错误日志',type:'stat',queries:[{refId:'A',sql:`SELECT count() AS value FROM ${logName} WHERE $__timeFilter(event_time)`}],options:{},grid:{x:0,y:0,w:6,h:5}}],variables:[],range:{from:'now-1h',to:'now'},refresh:0}});
 await page.route('**/api/v1/assistant/config',route=>route.fulfill({json:{enabled:true,model:'qa-model',base_url:'http://unused.invalid',has_key:false}}));
 await page.route('**/api/v1/assistant/sessions/*/turns',async route=>{const input=route.request().postDataJSON();snapshots.push(input.context);const now=new Date().toISOString(),id=crypto.randomUUID();const events=[{sequence:1,session_id:'qa',turn_id:id,type:'user.message',timestamp:now,data:{text:input.text}},{sequence:2,session_id:'qa',turn_id:id,type:'turn.completed',timestamp:now,data:{}}];await route.fulfill({contentType:'text/event-stream',body:events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')});});
 await page.goto(`${base}/dashboards/${dashboard.id}`);await expect(page.locator('.lm-dashboard-panel')).toBeVisible();
 await expect(page.locator('.lm-topbar')).toHaveCount(0);const floating=await page.getByRole('button',{name:'打开 AI 助手'}).boundingBox();expect(floating.x).toBeGreaterThan(1300);expect(floating.y).toBeGreaterThan(900);
 await shot('dashboard');const dashContext=await openAI(dashboard.title);expect(dashContext.dashboard_id).toBe(dashboard.id);expect(dashContext.panels[0].queries[0].sql).toContain(logName);expect(dashContext.range.from).toBeTruthy();await shot('dashboard-ai');await closeAI();checks.push('顶部栏移除；右下角 AI 获取当前大盘、SQL 与时间范围');
 await page.goto(base+'/settings?tab=retention');await expect(page.getByRole('spinbutton',{name:'默认保留天数'})).toHaveValue('7');
 const heading=await page.locator('.lm-page-heading').boundingBox();const surface=await page.locator('.lm-retention-settings').boundingBox();
 await page.getByRole('spinbutton',{name:'默认保留天数'}).fill('14');await page.getByRole('button',{name:'保存默认时长'}).click();await expect(page.locator('.ant-message-notice').filter({hasText:'默认保留时长已保存'})).toBeVisible();
 expect((await page.locator('.lm-page-heading').boundingBox()).y).toBe(heading.y);expect((await page.locator('.lm-retention-settings').boundingBox()).y).toBe(surface.y);await shot('global-toast');
 await expect(page.locator('.ant-message-notice').filter({hasText:'默认保留时长已保存'})).toBeHidden({timeout:8000});await page.reload();await expect(page.getByRole('spinbutton',{name:'默认保留天数'})).toHaveValue('14');expect(await ttl(logName)).toContain('toIntervalDay(14)');
 await page.goto(base+'/data?tab=tables');await tableEditor(logName);await mode('自定义天数');await page.getByRole('spinbutton',{name:'单表保留天数'}).fill('30');await saveTable();await page.reload();await expect(page.locator('.ant-table-row').filter({hasText:logName})).toContainText('30 天');
 await json('/settings/retention',{method:'PUT',data:{default_days:3}});expect((await table()).effective_retention_days).toBe(30);expect(await ttl(logName)).toContain('toIntervalDay(30)');
 await tableEditor(logName);await mode('永久保留');await saveTable();expect(await ttl(logName)).not.toContain('\nTTL ');await json('/settings/retention',{method:'PUT',data:{default_days:21}});expect((await table()).effective_retention_days).toBe(0);
 await tableEditor(logName);await mode('跟随全局默认');await saveTable();await page.reload();const row=page.locator('.ant-table-row').filter({hasText:logName});await expect(row).toContainText('21 天');await expect(row).toContainText('跟随全局');expect(await ttl(logName)).toContain('toIntervalDay(21)');await shot('table-retention');
 checks.push('全局默认、单表覆盖、永久保留、恢复继承均写入真实 ClickHouse TTL；刷新后读回');
 await tableEditor(logName);await mode('自定义天数');await page.getByRole('spinbutton',{name:'单表保留天数'}).fill('31');
 const failure=route=>route.fulfill({status:503,json:{error:'存储暂不可用，请重试'}});await page.route(`**/api/v1/catalog/tables/${logName}/retention`,failure);await page.getByRole('button',{name:'保存时长',exact:true}).click();await expect(page.locator('.ant-message-notice').filter({hasText:'存储暂不可用'})).toBeVisible();await expect(page.getByRole('dialog',{name:'数据表保留时长'})).toBeVisible();await expect(page.getByRole('spinbutton',{name:'单表保留天数'})).toHaveValue('31');expect((await table()).effective_retention_days).toBe(21);await page.unroute(`**/api/v1/catalog/tables/${logName}/retention`,failure);await page.getByRole('button',{name:/取\s*消/,exact:true}).click();
 await page.goto(base+'/settings?tab=retention');await expect(page.getByRole('spinbutton',{name:'默认保留天数'})).toHaveValue('21');await page.route('**/api/v1/settings/retention',async route=>{if(route.request().method()==='PUT')return failure(route);return route.continue();});await page.getByRole('spinbutton',{name:'默认保留天数'}).fill('9');const before=await page.locator('.lm-retention-settings').boundingBox();await page.getByRole('button',{name:'保存默认时长'}).click();await expect(page.locator('.ant-message-notice').filter({hasText:'存储暂不可用'})).toBeVisible();expect((await page.locator('.lm-retention-settings').boundingBox()).y).toBe(before.y);expect((await json('/settings/retention')).default_days).toBe(21);await page.unroute('**/api/v1/settings/retention');checks.push('成功/失败悬浮提示不推移页面，自动消失；失败保留表单输入与旧配置');
 await page.goto(base+'/logs');await choose('日志表',logName);await page.getByLabel('日志关键词',{exact:true}).fill('支付超时');await page.getByLabel('日志关键词',{exact:true}).press('Enter');await expect(page.getByRole('button',{name:/^查看日志详情/}).first()).toBeVisible();
 const logContext=await openAI('日志探索');expect(logContext.table).toBe(logName);expect(logContext.log_query.keyword).toBe('支付超时');expect(logContext.status.result_rows).toBeGreaterThan(0);await shot('logs-ai');await closeAI();checks.push('AI 获取已执行日志检索的关键词、表、范围与结果状态');
 await page.goto(base+'/query?sql=SELECT%201');await expect(page).toHaveURL(base+'/');await expect(page.getByRole('link',{name:'SQL 工作台',exact:true})).toHaveCount(0);checks.push('SQL 工作台移除；旧链接回到概览');
 await page.goto(base+'/data?tab=tables');const cleanContext=await openAI('数据接入');expect(cleanContext.dashboard_id).toBeUndefined();expect(cleanContext.log_query).toBeUndefined();expect(cleanContext.query).toBeUndefined();await closeAI();checks.push('切换页面不携带过期大盘或日志上下文');
 await page.goto(base+'/alerts');await expect(page.getByRole('button',{name:'创建告警规则'})).toBeVisible();await page.getByRole('tab',{name:'告警组',exact:true}).click();await page.getByRole('button',{name:'创建告警组',exact:true}).click();await page.getByRole('textbox',{name:'告警组名称'}).fill('悬浮反馈验收 '+run);const filtersBefore=await page.locator('.lm-alert-filters').boundingBox();await page.getByRole('dialog',{name:'告警组与通知目标'}).getByRole('button',{name:/确\s*定/,exact:true}).click();await expect(page.getByRole('dialog',{name:'告警组与通知目标'})).toBeHidden();await expect(page.locator('.ant-message-notice').filter({hasText:'已保存，配置已生效'})).toBeVisible();expect((await page.locator('.lm-alert-filters').boundingBox()).y).toBe(filtersBefore.y);await expect(page.locator('.lm-alert-page > .ant-alert-success')).toHaveCount(0);await shot('alerts-toast');await expect(page.locator('.ant-message-notice')).toBeHidden({timeout:8000});checks.push('告警保存悬浮提醒，筛选区坐标保持不变');
 await page.goto(base+'/dashboards');await expect(page.getByRole('heading',{name:'监控大盘',exact:true})).toBeVisible();await expect(page.locator('.lm-dashboard-page .ant-table-row').first()).toBeVisible();await page.setViewportSize({width:750,height:1000});await page.getByRole('button',{name:'收起导航',exact:true}).click();await page.getByRole('button',{name:'展开导航',exact:true}).click();await page.getByRole('button',{name:'收起导航',exact:true}).click();await expect(page.getByRole('button',{name:'打开 AI 助手'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot('narrow');
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/settings?tab=retention');await page.locator('html').evaluate(element=>{element.style.zoom='2';});await expect(page.getByRole('button',{name:'保存默认时长'})).toBeVisible();await shot('zoom-200');checks.push('窄屏导航折叠/展开与 AI 入口可用，200% 关键区域检查');
 if(errors.length)throw new Error(errors.join('\n'));
 await writeFile(resolve(output,`${run}-report.json`),JSON.stringify({run,checks,page_errors:errors,contexts:snapshots},null,2));console.log(JSON.stringify({run,checks,page_errors:errors}));
}catch(error){await shot('failure').catch(()=>{});console.error(String(error).slice(0,1800));process.exitCode=1;}finally{await json('/settings/retention',{method:'PUT',data:{default_days:7}}).catch(()=>{});await context.close();if(run==='1'&&page.video())await rename(await page.video().path(),resolve(mediaOutput,'1-interactions.webm'));await browser.close();}
