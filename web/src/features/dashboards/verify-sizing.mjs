import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:18380',source=process.env.LIGHTMONI_TEST_DASHBOARD??'80a186bd-6b01-41b3-95c5-15ee556e735d';
const output=resolve(import.meta.dirname,'../../../../examples/dashboards/evidence');await mkdir(output,{recursive:true});
let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];let copyID;
page.on('pageerror',error=>errors.push(error.message));
async function json(path,options){const response=await context.request.fetch(`${base}/api/v1${path}`,options);if(!response.ok())throw new Error(`${path} ${response.status()} ${await response.text()}`);return response.json();}
try{
 await json('/auth/login',{method:'POST',data:{name:process.env.LIGHTMONI_TEST_USER??'local-admin',password:process.env.LIGHTMONI_TEST_PASSWORD??'local-demo-password'}});
 let dashboard=await json(`/dashboards/${source}/copy`,{method:'POST',data:{title:`最小仪表与减少动画验收 ${Date.now()}`}});copyID=dashboard.id;
 const cpu=dashboard.panels.find(panel=>panel.queries.some(query=>query.sql.includes('host.cpu')));dashboard.panels=[{...cpu,type:'gauge',title:'CPU 最小仪表',options:{...cpu.options,min:0,max:1,unit:'percent'},grid:{x:0,y:0,w:6,h:3}}];dashboard.range={from:'now-24h',to:'now'};dashboard.refresh=0;
 await json(`/dashboards/${copyID}`,{method:'PUT',data:dashboard});await page.goto(`${base}/dashboards/${copyID}`);await expect(page.locator('.lm-g2-chart canvas')).toBeVisible();await expect(page.locator('.lm-panel-loading')).toHaveCount(0);
 const geometry=await page.locator('.lm-panel-body').evaluate(node=>({height:node.clientHeight,scrollHeight:node.scrollHeight,canvas:node.querySelector('canvas')?.getBoundingClientRect().height}));if(geometry.scrollHeight>geometry.height+1||geometry.canvas<140)throw new Error(`仪表裁切 ${JSON.stringify(geometry)}`);
 await page.getByRole('button',{name:'编辑大盘',exact:true}).click();await page.getByRole('button',{name:'调整面板大小',exact:true}).focus();for(let i=0;i<5;i++)await page.keyboard.press('ArrowUp');await page.getByRole('button',{name:'保存更改',exact:true}).click();await page.getByRole('button',{name:'确认保存',exact:true}).click();await expect(page.getByRole('dialog',{name:'保存大盘',exact:true})).toBeHidden();await expect(page.getByRole('button',{name:'编辑大盘',exact:true})).toBeVisible();
 dashboard=await json(`/dashboards/${copyID}`);if(dashboard.panels[0].grid.h!==5)throw new Error('图表最小尺寸未在保存定义中生效');await expect(page.locator('.ant-modal-mask:visible')).toHaveCount(0);await expect(page.locator('.ant-alert-error')).toHaveCount(0);
 await page.screenshot({path:resolve(output,'minimum-gauge-reduced-motion.png'),fullPage:true,animations:'disabled'});if(errors.length)throw new Error(errors.join('\n'));
 const report={dashboard_id:copyID,checked_at:new Date().toISOString(),geometry,saved_grid:dashboard.panels[0].grid,reduced_motion_modal_exited:true,page_errors:errors};await writeFile(resolve(output,'minimum-gauge-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{console.log(`QA dashboard: ${copyID}`);await context.close();await browser.close();}
