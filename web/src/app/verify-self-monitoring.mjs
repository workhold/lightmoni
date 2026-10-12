import {chromium,expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const base='http://localhost:18380',out=resolve(import.meta.dirname,'../../../docs/evidence/self-monitoring');
await mkdir(out,{recursive:true});
const fixtures=JSON.parse(await readFile(resolve(out,'local-fixtures.json'),'utf8'));
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{localStorage.setItem('lightmoni.appearance','dark');localStorage.setItem('lightmoni.nav.collapsed','false');});
const login=await context.request.post(base+'/api/v1/auth/login',{data:{name:'local-admin',password:'local-demo-password'}});expect(login.ok()).toBeTruthy();
const page=await context.newPage(),errors=[],queries=[];page.on('pageerror',e=>errors.push(e.message));
page.on('response',async response=>{if(response.url().endsWith('/api/v1/query')&&response.status()===200){const body=await response.json();for(const result of body.results??[])if(result.status==='error')queries.push(result.error);}});
const dashboards=[['system-center','系统监控 · 上报中心',12],['system-agent','系统监控 · Agent',6],['system-sdk','系统监控 · SDK',6],[fixtures.business_dashboard_id,'Mac 本机 · SDK 封装 demo',6]];
try {
 await page.goto(base+'/dashboards');await expect(page.getByRole('heading',{name:'监控大盘',exact:true})).toBeVisible();
 for(const [,title] of dashboards)await expect(page.getByRole('button',{name:title,exact:true})).toBeVisible();
 await page.screenshot({path:resolve(out,'dashboard-list.png'),fullPage:true});
 for(const [id,title,count] of dashboards){
  await page.goto(base+'/dashboards/'+id);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();await expect(page.locator('.lm-dashboard-panel')).toHaveCount(count);
  await expect(page.locator('.lm-panel-loading')).toHaveCount(0,{timeout:30000});await expect(page.locator('.lm-dashboard-panel .ant-alert-error')).toHaveCount(0);
  await page.mouse.move(20,20);await page.screenshot({path:resolve(out,id==='system-center'?'center-desktop.png':id==='system-agent'?'agent-desktop.png':id==='system-sdk'?'sdk-desktop.png':'demo-desktop.png'),fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});await page.goto(base+'/dashboards/system-agent');await expect(page.locator('.lm-panel-loading')).toHaveCount(0,{timeout:30000});
 const overflow=await page.evaluate(()=>({viewport:innerWidth,page:document.documentElement.scrollWidth}));expect(overflow.page).toBeLessThanOrEqual(overflow.viewport+1);
 await page.screenshot({path:resolve(out,'agent-390.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/data?tab=tables');await page.getByRole('tab',{name:'数据表',exact:true}).click();await expect(page.getByText('系统内置',{exact:true})).toHaveCount(4);await page.locator('.ant-pagination-next').click();await expect(page.getByText('系统内置',{exact:true})).toHaveCount(4);await page.screenshot({path:resolve(out,'system-tables.png'),fullPage:true});
 await page.goto(base+'/agents');await page.getByRole('tab',{name:/Mac 本机测试/}).click();await expect(page.getByText('darwin / arm64',{exact:true})).toBeVisible();await expect(page.getByText('在线',{exact:true})).toBeVisible();
 await page.screenshot({path:resolve(out,'mac-agent.png'),fullPage:true});
 expect(errors).toEqual([]);expect(queries).toEqual([]);await writeFile(resolve(out,'browser-report.json'),JSON.stringify({passed:true,dashboards:dashboards.map(([id,title,panels])=>({id,title,panels})),system_tables:8,mobile:overflow,errors,query_errors:queries},null,2));console.log('PASS four real dashboards, system-table labels, Mac Agent and mobile layout');
} finally {await context.close();await browser.close();}
