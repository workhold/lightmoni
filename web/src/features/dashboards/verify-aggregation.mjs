import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadSource} from './test-module.mjs';
const {panelIntervalFor}=loadSource(new URL('./query-options.ts',import.meta.url));
const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5178',center=process.env.LIGHTMONI_QA_CENTER_URL??'http://localhost:18380';
const output=resolve(import.meta.dirname,'../../../../docs/evidence/time-aggregation');
await mkdir(output,{recursive:true});
let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],checks=[],requests=[];
await context.addInitScript(()=>{localStorage.setItem('lightmoni.appearance','dark');localStorage.setItem('lightmoni.nav.collapsed','true');});
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/query')requests.push(request.postDataJSON());});
await page.route('**/api/v1/**',async route=>{if(new URL(base).origin===new URL(center).origin||['GET','HEAD','OPTIONS'].includes(route.request().method()))return route.continue();const url=new URL(route.request().url()),response=await route.fetch({url:center+url.pathname+url.search,headers:{...route.request().headers(),origin:new URL(center).origin}});await route.fulfill({response});});
async function json(path,options){const response=await context.request.fetch(base+'/api/v1'+path,options);if(!response.ok())throw new Error(path+': '+response.status()+' '+await response.text());return response.json();}
async function query(sql,range,interval_ms=60000){const response=await json('/query',{method:'POST',data:{request_id:crypto.randomUUID(),range,interval_ms,queries:[{refId:'A',sql}]}});expect(response.results[0].status).toBe('success');expect(response.results[0].complete).toBe(true);return response.results[0].frames[0];}
function queryResponse(){return page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/query');}
async function run(){const response=queryResponse();await page.getByRole('button',{name:'运行全部查询',exact:true}).click();const result=await (await response).json();expect(result.results.every(result=>result.complete&&result.status==='success')).toBe(true);await expect(page.locator('.lm-query-pending')).toHaveCount(0);return result;}
async function functionSelect(ref,name){await page.getByRole('combobox',{name:`查询 ${ref} 聚合函数`,exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText(name,{exact:true}).click();await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);}
async function interval(value){const input=page.getByRole('combobox',{name:'聚合间隔',exact:true});await input.fill(value);await input.press('Escape');await input.blur();}
async function noOverflow(){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
async function settledChart(){await expect.poll(()=>page.locator('.lm-panel-preview .lm-g2-chart').evaluate(node=>Number(node.dataset.chartCommits)>0&&node.dataset.chartUpdates===node.dataset.chartCommits&&!node.querySelector('.lm-chart-frame:not([hidden])'))).toBe(true);}
let fixture;
try{
 await json('/auth/login',{method:'POST',data:{name:process.env.LIGHTMONI_TEST_USER??'local-admin',password:process.env.LIGHTMONI_TEST_PASSWORD??'local-demo-password'}});
 const latest=await query("SELECT max(event_time) AS latest FROM metric_host_gauge WHERE name='host.cpu.utilization'",{from:'2026-10-10T00:00:00Z',to:'2026-10-12T00:00:00Z'});
 const end=Math.floor(Date.parse(latest.rows[0][0])/300000)*300000,range={from:new Date(end-3600000).toISOString(),to:new Date(end).toISOString()};
 const raw=await query("SELECT event_time,host_id,value FROM metric_host_gauge WHERE $__timeFilter(event_time) AND name='host.cpu.utilization' ORDER BY event_time",range);
 expect(raw.rows.length).toBeGreaterThan(120);
 const samples=new Map();for(const [time,host,value] of raw.rows){const key=host;const rows=samples.get(key)??[];rows.push([Date.parse(time),Number(value)]);samples.set(key,rows);}
 function expected(intervalMS,reducer,multiplier=1){const buckets=new Map();for(const [host,rows] of samples)for(const [time,value] of rows){const bucket=Math.floor(time/intervalMS)*intervalMS,key=JSON.stringify([bucket,host]),values=buckets.get(key)??[];values.push(value*multiplier);buckets.set(key,values);}return new Map([...buckets].map(([key,values])=>{values.sort((a,b)=>a-b);return [key,reducer==='avg'?values.reduce((a,b)=>a+b,0)/values.length:reducer==='max'?values.at(-1):values[Math.min(values.length-1,Math.floor(values.length*.95))]];}));}
 function verifyResult(result,intervalMS,reducers){for(const query of result.results){const frame=query.frames[0],want=expected(intervalMS,reducers[query.refId],query.refId==='B'?2:1);expect(frame.rows.length).toBe(want.size);for(const [time,host,value] of frame.rows){expect(Date.parse(time)%intervalMS).toBe(0);const key=JSON.stringify([Date.parse(time),host]);expect(want.has(key)).toBe(true);expect(Number(value)).toBeCloseTo(want.get(key),10);}}}
 const sql="SELECT $__timeInterval(event_time) AS time,host_id AS series,avg(value) AS value FROM metric_host_gauge WHERE $__timeFilter(event_time) AND name='host.cpu.utilization' GROUP BY time,series ORDER BY time,series";
 const panel={id:crypto.randomUUID(),title:'时间聚合验证',type:'line',queries:[{refId:'A',sql},{refId:'B',sql:sql.replace('avg(value)','avg(value*2)')}],options:{x:'time',y:'value',series:'series',query_interval:'1m',query_min_interval:'30s',unit:'percentunit'},grid:{x:0,y:0,w:6,h:7}};
 fixture=await json('/dashboards',{method:'POST',data:{title:'时间聚合 QA '+Date.now(),description:'临时验证大盘',panels:[panel],variables:[],range,refresh:0}});
 await page.goto(base+'/dashboards/'+fixture.id);await expect(page.locator('.lm-panel-body')).toHaveAttribute('data-query-interval-ms','60000');
 await page.getByRole('button',{name:'编辑 时间聚合验证',exact:true}).click();await expect(page.getByRole('combobox',{name:'聚合间隔',exact:true})).toHaveValue('1m');
 await expect(page.getByRole('combobox',{name:'最小聚合间隔',exact:true})).toBeDisabled();
 await expect(page.locator('.lm-panel-preview .lm-panel-body')).toHaveAttribute('data-query-interval-ms','60000');
 const avgResponse=await run();verifyResult(avgResponse,60000,{A:'avg',B:'avg'});checks.push('真实原始 CPU 样本：1min avg 与独立计算一致，桶时间按 UTC 整分钟对齐');
 const before=requests.length;await functionSelect('A','p95');await functionSelect('B','max · 最大值');await interval('5m');await expect(page.locator('.lm-query-pending')).toBeVisible();expect(requests.length).toBe(before);
 await page.locator('.lm-preview-toolbar').getByText('原始数据',{exact:true}).click();expect(requests.length).toBe(before);
 const p95Response=await run();verifyResult(p95Response,300000,{A:'p95',B:'max'});expect(requests.at(-1).interval_ms).toBe(300000);expect(requests.at(-1).queries[0].sql).toContain('quantileExact(0.95)(value)');expect(requests.at(-1).queries[1].sql).toContain('max(value*2)');
 await expect(page.locator('.lm-query-options')).toContainText('实际间隔 5min');checks.push('5min p95 / max 每条查询独立，数据库结果与原始样本计算一致；编辑待运行，原始数据模式保留桶宽');
 await page.locator('.lm-preview-toolbar').getByText('图表',{exact:true}).click();await page.locator('.lm-workbench-data').evaluate(node=>node.scrollTop=0);await settledChart();await page.screenshot({path:resolve(output,'editor-desktop.png'),animations:'disabled'});
 await interval('auto');const minimum=page.getByRole('combobox',{name:'最小聚合间隔',exact:true});await expect(minimum).toBeEnabled();await minimum.fill('30s');await minimum.press('Escape');await minimum.blur();await run();await expect(page.locator('.lm-panel-preview .lm-panel-body')).toHaveAttribute('data-query-interval-ms','30000');
 const points=page.getByRole('spinbutton',{name:'最大数据点',exact:true});await points.fill('12');await points.blur();await run();await expect(page.locator('.lm-panel-preview .lm-panel-body')).toHaveAttribute('data-query-interval-ms','300000');
 await page.setViewportSize({width:390,height:900});await noOverflow();await expect(page.getByRole('combobox',{name:'查询 A 聚合函数',exact:true})).toBeVisible();await expect(page.locator('.lm-panel-preview .lm-panel-body')).toHaveAttribute('data-query-interval-ms','300000');
 await expect(page.locator('.lm-panel-preview .lm-g2-chart')).toHaveAttribute('data-chart-layout','compact');await settledChart();await page.locator('.lm-workbench-data').evaluate(node=>node.scrollTop=0);await page.screenshot({path:resolve(output,'editor-390.png'),animations:'disabled'});checks.push('自动间隔尊重 30s 最小间隔；固定最大数据点 12 在桌面/390px 下均保持 5min；窄屏无页面横向溢出');
 await page.setViewportSize({width:1440,height:1000});await points.fill('');await minimum.fill('');await minimum.blur();await run();
 const width=await page.locator('.lm-panel-preview .lm-panel-body').evaluate(node=>node.clientWidth);await expect(page.locator('.lm-panel-preview .lm-panel-body')).toHaveAttribute('data-query-interval-ms',String(panelIntervalFor(range,{query_interval:'auto'},width)));
 const invalidBefore=requests.length;await interval('0s');await page.getByRole('button',{name:'运行全部查询',exact:true}).click();await expect(page.getByText('聚合间隔须为正整数加单位，例如 30s、1min、5min 或 1h',{exact:true})).toBeVisible();expect(requests.length).toBe(invalidBefore);
 await interval('5m');await run();checks.push('未限制数据点时使用实际面板宽度和 Grafana 间隔舍入；非法间隔在查询前拒绝');
 await page.getByRole('button',{name:'应用到大盘',exact:true}).click();await expect(page.locator('.lm-panel-workbench')).toHaveCount(0);await page.getByRole('button',{name:'保存更改',exact:true}).click();const saveDialog=page.getByRole('dialog',{name:'保存大盘',exact:true});await saveDialog.getByRole('button',{name:/确认保存$/}).click();await expect(saveDialog).toBeHidden();
 const saved=await json('/dashboards/'+fixture.id);expect(saved.panels[0].options.query_interval).toBe('5m');expect(saved.panels[0].queries[0].sql).toContain('quantileExact(0.95)(value)');expect(saved.panels[0].queries[1].sql).toContain('max(value*2)');
 await page.reload();await expect(page.locator('.lm-panel-body')).toHaveAttribute('data-query-interval-ms','300000');await page.getByRole('button',{name:'编辑 时间聚合验证',exact:true}).click();await expect(page.getByRole('combobox',{name:'聚合间隔',exact:true})).toHaveValue('5m');await expect(page.locator('.lm-query-aggregation').first()).toContainText('p95');checks.push('真实 SQLite 保存与刷新读回保留 5min、p95、max 配置');
 await page.getByRole('button',{name:'放弃修改',exact:true}).click();
 await page.getByRole('button',{name:'时间聚合验证 面板操作',exact:true}).click();await page.getByRole('menuitem',{name:'查看图表',exact:true}).click();await expect(page.locator('.lm-panel-viewer .lm-panel-body')).toHaveAttribute('data-query-interval-ms','300000');await page.getByRole('button',{name:'返回大盘',exact:true}).click();checks.push('固定 5min 在全屏查看中保持同一聚合粒度');
 await page.getByRole('button',{name:'编辑 时间聚合验证',exact:true}).click();await interval('auto');await page.getByRole('button',{name:'应用到大盘',exact:true}).click();
 const grid=page.locator('.lm-dashboard-panel .lm-panel-body'),gridWidth=await grid.evaluate(node=>node.clientWidth),gridInterval=panelIntervalFor(range,{},gridWidth);await expect(grid).toHaveAttribute('data-query-interval-ms',String(gridInterval));
 await page.getByRole('button',{name:'时间聚合验证 面板操作',exact:true}).click();await page.getByRole('menuitem',{name:'查看图表',exact:true}).click();
 const viewer=page.locator('.lm-panel-viewer .lm-panel-body');await expect(viewer).toBeVisible();const viewerWidth=await viewer.evaluate(node=>node.clientWidth),viewerInterval=panelIntervalFor(range,{},viewerWidth);expect(viewerInterval).toBeLessThan(gridInterval);await expect(viewer).toHaveAttribute('data-query-interval-ms',String(viewerInterval));
 await page.getByRole('button',{name:'返回大盘',exact:true}).click();await expect(grid).toHaveAttribute('data-query-interval-ms',String(gridInterval));checks.push('自动间隔在全屏查看中随像素宽度变细，返回网格后恢复；仅分辨率改变时重新查询');
 expect(errors).toEqual([]);
 await writeFile(resolve(output,'report.json'),JSON.stringify({passed:true,checks,range,rawSamples:raw.rows.length,errors},null,2)+'\n');console.log(JSON.stringify({passed:true,checks,rawSamples:raw.rows.length}));
}catch(error){await page.screenshot({path:resolve(output,'failure.png'),animations:'disabled'}).catch(()=>{});await writeFile(resolve(output,'report.json'),JSON.stringify({passed:false,checks,errors,error:String(error)},null,2));console.error(error);process.exitCode=1;}
finally{if(fixture){const latest=await json('/dashboards/'+fixture.id);await json(`/dashboards/${fixture.id}?revision=${latest.revision}`,{method:'DELETE'});}await context.close();await browser.close();}
