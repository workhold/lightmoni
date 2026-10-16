import { mediaDirectory } from '../../../../scripts/qa-artifacts.mjs';
import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5173',output=resolve(import.meta.dirname,'../../../../examples/dashboards/evidence/axis-range');
await mkdir(output,{recursive:true});
const mediaOutput=mediaDirectory(output);
let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage(),errors=[],checks=[];
let dashboardID;
page.on('pageerror',error=>errors.push(error.message));
async function json(path,options){const response=await context.request.fetch(`${base}/api/v1${path}`,options);if(!response.ok())throw new Error(`${path}: ${response.status()} ${await response.text()}`);return response.json();}
const sql=(values,series='api')=>values.map((value,index)=>`SELECT now64(3) - INTERVAL ${6-index} MINUTE AS time, '${series}' AS series, toFloat64(${value}) AS value`).join(' UNION ALL ');
const panel=(title,type,options,queries,index)=>({id:crypto.randomUUID(),title,type,options:{x:'time',y:'value',series:'series',legend_mode:'hidden',...options},queries,grid:{x:index%2*6,y:Math.floor(index/2)*6,w:6,h:6}});
async function ready(count){await expect(page.locator('.lm-g2-chart canvas:not(.lm-chart-frame)')).toHaveCount(count);await expect(page.locator('.lm-panel-loading')).toHaveCount(0);await expect(page.locator('.lm-panel-body .ant-alert-error,.lm-panel-body .ant-alert-warning')).toHaveCount(0);await expect.poll(()=>page.locator('.lm-g2-chart').evaluateAll(nodes=>nodes.every(node=>Number(node.dataset.chartCommits)>0))).toBe(true);await expect(page.locator('.lm-chart-frame:not([hidden])')).toHaveCount(0);}
async function edit(title){await page.getByRole('button',{name:`编辑 ${title}`,exact:true}).click();if((await page.viewportSize()).width>=900)await page.locator('.lm-workbench-sidebar').getByRole('tab',{name:'显示设置',exact:true}).click();await expect.poll(async()=>{const transient=page.locator('.lm-panel-preview .ant-alert').filter({hasText:'HTTP 502'});if(await transient.count())await transient.getByRole('button').click();return page.locator('.lm-panel-preview .lm-g2-chart canvas:not(.lm-chart-frame)').count();},{timeout:15000}).toBe(1);}
async function select(name,text,scope=page){await scope.getByRole('combobox',{name,exact:true}).click();await page.getByText(text,{exact:true}).last().click();}
async function save(){await page.getByRole('button',{name:'保存更改',exact:true}).click();await page.getByRole('dialog',{name:'保存大盘',exact:true}).locator('button').filter({hasText:'确认保存'}).click();await expect(page.getByRole('dialog',{name:'保存大盘',exact:true})).toBeHidden();}
// Inspect the actual submitted G2 specification without changing chart behavior.
await page.route('**/src/features/dashboards/ChartView.tsx*',async route=>{const response=await route.fetch(),source=await response.text();await route.fulfill({response,body:source.replace('queue.submit(finalOptions);','node.__qaOptions = finalOptions; queue.submit(finalOptions);')});});
async function scales(preview=false){return page.locator(preview?'.lm-panel-preview .lm-g2-chart':'.lm-g2-chart').evaluateAll(nodes=>nodes.map(node=>{const spec=node.__qaOptions;return (spec.type==='view'?spec.children:[spec]).filter(mark=>['line','area','rect','interval'].includes(mark.type)).map(mark=>mark.scale.y);}));}
const position=(value,domain)=>(value-domain[0])/(domain[1]-domain[0]);
try{
 await json('/auth/login',{method:'POST',data:{name:process.env.LIGHTMONI_TEST_USER??'local-admin',password:process.env.LIGHTMONI_TEST_PASSWORD??'local-demo-password'}});
 const query=[{refId:'A',sql:sql([80,84,100,88,82])}],panels=[
  panel('自动范围 · 包含 0','line',{},query,0),
  panel('自动范围 · 贴合数据','line',{left_zero:false},query,1),
  panel('双轴独立范围','line',{left_zero:false,right_zero:true,right_axis_refs:['B'],right_unit:'bytes'},[...query,{refId:'B',sql:sql([1024,2048,4096,3072,2048],'memory')}],2),
  panel('正负堆叠','bar',{stacked:true,left_zero:false},[{refId:'A',sql:sql([80,90,100,90,80],'a')+' UNION ALL '+sql([30,40,50,40,30],'b')+' UNION ALL '+sql([-20,-30,-40,-30,-20],'c')}],3),
  panel('全零','line',{},[{refId:'A',sql:sql([0,0,0,0,0])}],4),
  panel('常量 · 贴合数据','line',{left_zero:false},[{refId:'A',sql:sql([80,80,80,80,80])}],5),
  panel('面积图 · 贴合数据','area',{left_zero:false},query,6),
  panel('可见阈值','line',{thresholds:[{value:120,color:'#ff7383',label:'警告'}],show_points:true},query,7),
  panel('对数范围','line',{left_scale:'log'},[{refId:'A',sql:sql([10,100,1000,100,10])}],8),
  panel('样本直方图','histogram',{histogram_mode:'auto',bin_count:3},query,9),
 ];
 const dashboard=await json('/dashboards',{method:'POST',data:{title:`Y 轴范围验收 ${Date.now()}`,description:'自动范围与配置交互验收',panels,variables:[],range:{from:'now-15m',to:'now'},refresh:0,revision:0}});dashboardID=dashboard.id;
 await page.goto(`${base}/dashboards/${dashboardID}`);await ready(panels.length);
 let actual=await scales();expect(position(100,actual[0][0].domain)).toBeCloseTo(.85);expect(actual[0][0].domain[0]).toBe(0);expect(position(80,actual[1][0].domain)).toBeCloseTo(.15);expect(position(100,actual[1][0].domain)).toBeCloseTo(.85);
 expect(actual[2][0].domain[0]).toBeGreaterThan(0);expect(actual[2][1].domain[0]).toBe(0);expect(position(4096,actual[2][1].domain)).toBeCloseTo(.85);expect(position(150,actual[3][0].domain)).toBeCloseTo(.85);expect(position(-40,actual[3][0].domain)).toBeCloseTo(.15);expect(actual[4][0].domain[1]).toBeGreaterThan(0);expect(actual[5][0].domain[0]).toBeLessThan(80);expect(actual[5][0].domain[1]).toBeGreaterThan(80);expect(position(120,actual[7][0].domain)).toBeCloseTo(.85);
 const logDomain=actual[8][0].domain;expect(actual[8][0].type).toBe('log');expect((Math.log(1000)-Math.log(logDomain[0]))/(Math.log(logDomain[1])-Math.log(logDomain[0]))).toBeCloseTo(.85);expect(position(3,actual[9][0].domain)).toBeCloseTo(.85);
 checks.push('实际 G2 单轴 / 双轴 / 面积 / 正负堆叠 / 全零 / 常量 / 阈值 / 对数 / 直方图范围，自动峰值 85%');
 await page.screenshot({path:resolve(mediaOutput,'gallery.png'),fullPage:true});
 await edit(panels[0].title);await select('左轴范围','贴合数据 · 上下留白');await expect.poll(async()=>((await scales(true))[0]?.[0]?.domain[0]??0)>0).toBe(true);
 await page.getByRole('button',{name:'应用到大盘',exact:true}).click();await save();await page.reload();await ready(panels.length);let saved=await json(`/dashboards/${dashboardID}`);expect(saved.panels[0].options.left_zero).toBe(false);
 await edit(panels[0].title);await expect(page.locator('.lm-workbench-sidebar').getByText('贴合数据 · 上下留白',{exact:true})).toBeVisible();await page.getByRole('spinbutton',{name:'左轴最小值',exact:true}).fill('70');await page.getByRole('spinbutton',{name:'左轴最大值',exact:true}).fill('110');await expect.poll(async()=>(await scales(true))[0]?.[0]?.domain).toEqual([70,110]);
 await page.screenshot({path:resolve(mediaOutput,'editor.png'),fullPage:true});await page.getByRole('button',{name:'应用到大盘',exact:true}).click();
 let reject=true;await page.route(`**/api/v1/dashboards/${dashboardID}`,async route=>{if(route.request().method()==='PUT'&&reject){reject=false;await route.fulfill({status:500,json:{error:'验收保存失败'}});}else await route.continue();});
 await page.getByRole('button',{name:'保存更改',exact:true}).click();await page.getByRole('dialog',{name:'保存大盘',exact:true}).locator('button').filter({hasText:'确认保存'}).click();await expect(page.getByRole('dialog',{name:'保存大盘',exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'保存大盘',exact:true}).locator('.ant-alert-error')).toBeVisible();await page.getByRole('dialog',{name:'保存大盘',exact:true}).locator('button').filter({hasText:'确认保存'}).click();await expect(page.getByRole('dialog',{name:'保存大盘',exact:true})).toBeHidden();
 await page.reload();await ready(panels.length);actual=await scales();expect(actual[0][0].domain).toEqual([70,110]);saved=await json(`/dashboards/${dashboardID}`);expect(saved.panels[0].options.left_min).toBe(70);expect(saved.panels[0].options.left_max).toBe(110);checks.push('单轴范围切换、手动上下限、保存失败保留草稿、重试和刷新回读');
 await edit(panels[0].title);await page.getByRole('spinbutton',{name:'左轴最小值',exact:true}).fill('');await page.getByRole('spinbutton',{name:'左轴最大值',exact:true}).fill('');await select('左轴范围','包含 0（默认）');await expect.poll(async()=>(await scales(true))[0]?.[0]?.domain[0]).toBe(0);await page.getByRole('button',{name:'应用到大盘',exact:true}).click();await save();saved=await json(`/dashboards/${dashboardID}`);expect(saved.panels[0].options.left_min).toBeUndefined();expect(saved.panels[0].options.left_max).toBeUndefined();expect(saved.panels[0].options.left_zero).toBe(true);checks.push('清空手动上下限后恢复自动范围');
 await page.setViewportSize({width:390,height:844});await ready(panels.length);await edit(panels[0].title);await page.getByRole('button',{name:'图表与设置',exact:true}).click();const settings=page.locator('.lm-workbench-settings');await settings.getByRole('tab',{name:'显示设置',exact:true}).click();await expect(settings.getByRole('combobox',{name:'左轴范围',exact:true})).toBeVisible();await expect(settings.getByRole('spinbutton',{name:'左轴最小值',exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:resolve(mediaOutput,'narrow-editor.png'),fullPage:true});checks.push('390px 设置抽屉可操作、无横向溢出');
 expect(errors).toEqual([]);await writeFile(resolve(output,'report.json'),JSON.stringify({checked_at:new Date().toISOString(),checks,scales:actual,page_errors:errors},null,2));console.log(JSON.stringify({checks,page_errors:errors,output}));
}catch(error){await page.screenshot({path:resolve(mediaOutput,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;}
finally{if(dashboardID){const current=await json(`/dashboards/${dashboardID}`).catch(()=>undefined);if(current)await context.request.delete(`${base}/api/v1/dashboards/${dashboardID}?revision=${current.revision}`);}await context.close();await browser.close();}
