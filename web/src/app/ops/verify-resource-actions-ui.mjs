import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';

const root=resolve(import.meta.dirname,'../../../..'),output=resolve(root,'specs/103-resource-actions/evidence'),media=mediaDirectory(output);
await mkdir(output,{recursive:true});
const now=new Date().toISOString(),resources=[
 {id:'cluster',kind:'cluster',name:'北京集群',revision:1,spec:{machine_ids:['machine']},status:{}},
 {id:'app',kind:'application',name:'订单服务 · 卸载后保留数据',revision:3,spec:{service_name:'orders-api',role:'generic',source:{type:'custom'},deployment_mode:'manual',mode:'container',image:'registry.example.test/commerce/orders:20261107',ports:[],deployments:[{cluster_id:'cluster',machine_ids:['machine'],cpu:0.25,memory_mb:128}]},status:{instances:[{id:'instance',state:'removed',cluster_id:'cluster',machine_id:'machine'}]}},
 {id:'gateway',kind:'application',name:'OpenResty',revision:4,spec:{role:'openresty',service_name:'sys-openresty',deployments:[{cluster_id:'cluster',machine_ids:['machine']}],ports:[]},status:{instances:[{id:'entry',state:'running',healthy:true,cluster_id:'cluster',machine_id:'machine'}]}},
 {id:'site',kind:'website',name:'订单与售后服务',revision:5,spec:{cluster_ids:['cluster'],routing_mode:'manual',mode:'static',bindings:[{domains:['orders.example.test'],locations:[]}]},status:{}},
].map(r=>({...r,created_at:now,updated_at:now}));
let writes=0;
const fixture=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');let result={};res.setHeader('content-type','application/json');
 if(!['GET','HEAD'].includes(req.method))writes++;
 if(url.pathname==='/api/v1/auth/me')result={id:'qa',name:'QA',role:'admin'};
 else if(url.pathname==='/api/v1/ops/overview')result={resources,agents:[],runs:[],machines:[{id:'machine',name:'zz-bj-1'}]};
 else if(url.pathname==='/api/v1/ops/resources/app/monitoring')result={application:resources.find(r=>r.id==='app'),hosts:[],deployments:[],websites:[]};
 else if(url.pathname.includes('telemetry'))result={website:resources.find(r=>r.id==='site'),results:{},hosts:[],range:{from:now,to:now}};
 else if(url.pathname.endsWith('/catalog'))result={templates:[]};
 res.end(JSON.stringify(result));
});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));process.env.LIGHTMONI_DEV_API_URL='http://127.0.0.1:'+fixture.address().port;
const vite=await createViteServer({root:resolve(root,'web'),configFile:resolve(root,'web/vite.config.ts'),server:{host:'127.0.0.1',port:5198,strictPort:true},logLevel:'error'});await vite.listen();
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const rounds=[];let activePage;
try{
 for(let round=1;round<=3;round++){
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];activePage=page;page.on('pageerror',e=>errors.push(e.message));
  const shot=async name=>page.screenshot({path:resolve(media,`round-${round}-${name}.png`),fullPage:false,animations:'disabled'});
  const compact=async locator=>{for(const b of await locator.all()){await expect(b).toHaveAttribute('aria-label',/.+/);expect(await b.innerText()).toBe('');await expect(b.locator('svg')).toHaveCount(1);const box=await b.boundingBox();expect(box.width).toBeGreaterThanOrEqual(32);expect(box.height).toBeGreaterThanOrEqual(32)}};
  await page.goto('http://127.0.0.1:5198/applications');
  const app=page.getByRole('article',{name:'订单服务 · 卸载后保留数据',exact:true});await expect(app).toBeVisible();
  await compact(page.locator('.lm-app-card-actions button'));
  const monitor=app.getByRole('button',{name:'监控与日志',exact:true});await monitor.hover();await expect(page.getByRole('tooltip',{name:'监控与日志',exact:true})).toBeVisible();await shot('applications-desktop');
  await monitor.focus();await expect(monitor).toBeFocused();await page.keyboard.press('Enter');await expect(page).toHaveURL(/\/applications\/app\/monitoring$/);await expect(page.getByRole('heading',{name:'订单服务 · 卸载后保留数据',exact:true})).toBeVisible();checks.push('应用监控图标具有提示、键盘入口并进入对应资源路由');
  await page.getByRole('button',{name:'返回应用',exact:true}).click();await app.getByRole('button',{name:'更多操作 · 订单服务 · 卸载后保留数据',exact:true}).click();await page.getByRole('menuitem',{name:'删除登记',exact:true}).click();await expect(page.getByRole('dialog').getByText('需先卸载容器并解除引用。持久化数据保留。',{exact:true})).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:/取\s*消/}).click();await expect(page.getByRole('dialog')).not.toBeVisible();expect(writes).toBe(0);checks.push('更多菜单可用、删除保留明确文字确认，取消不发写请求');
  await page.setViewportSize({width:390,height:844});await expect(app).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot('applications-mobile');
  await page.goto('http://127.0.0.1:5198/websites');await page.setViewportSize({width:1440,height:1000});
  const site=page.getByRole('article',{name:'订单与售后服务',exact:true});await compact(site.locator('.lm-website-actions button'));
  await site.getByRole('button',{name:'监控与访问日志',exact:true}).hover();await expect(page.getByRole('tooltip',{name:'监控与访问日志',exact:true})).toBeVisible();await shot('websites-desktop');
  await site.getByRole('button',{name:'监控与访问日志',exact:true}).click();await expect(page).toHaveURL(/\/websites\/site\/monitoring$/);await expect(page.getByRole('heading',{name:'订单与售后服务',exact:true})).toBeVisible();checks.push('网站监控图标进入对应网站的访问日志页面');
  await page.getByRole('button',{name:'返回网站',exact:true}).click();await site.getByRole('button',{name:'更多操作 · 订单与售后服务',exact:true}).click();await expect(page.getByRole('menuitem',{name:'流量设置',exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'新建网站',exact:true}).click();await expect(page.locator('#lm-ops-resource-form')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:/取\s*消/}).click();await expect(page.getByRole('dialog')).not.toBeVisible();checks.push('网站更多菜单和新建图标仍调用原有流程');
  await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot('websites-mobile');checks.push('应用和网站在390px无横向溢出，图标点击范围至少32px');
  await page.evaluate(()=>localStorage.setItem('lightmoni.language','en-US'));await page.reload();await site.getByRole('button',{name:'Monitoring & access logs',exact:true}).focus();await expect(page.getByRole('tooltip',{name:'Monitoring & access logs',exact:true})).toBeVisible();await shot('websites-english-mobile');checks.push('英文和键盘焦点提示可用');
  expect(errors).toEqual([]);expect(writes).toBe(0);rounds.push({round,checks,page_errors:errors});await page.close();
 }
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({fixture:'isolated local HTTP fixture; no production writes',rounds,write_requests:writes,media},null,2));console.log(JSON.stringify({rounds,write_requests:writes,media}));
}catch(error){if(activePage&&!activePage.isClosed()){console.error((await activePage.locator('body').innerText()).slice(-5000));console.error(await activePage.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,15).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right}))})));await activePage.screenshot({path:resolve(media,'failure.png'),fullPage:false})}throw error;}finally{await browser.close();await vite.close();fixture.close();fixture.closeAllConnections()}
