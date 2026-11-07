import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';

const root=resolve(import.meta.dirname,'../../../..'),output=resolve(root,'specs/104-deletion-reference-details/evidence'),media=mediaDirectory(output);
await mkdir(output,{recursive:true});
const now=new Date().toISOString(),resources=[
 {id:'cluster',kind:'cluster',name:'北京集群',revision:1,spec:{machine_ids:['machine']},status:{}},
 {id:'app',kind:'application',name:'ABC Demo',revision:5,spec:{service_name:'abc-demo',role:'generic',source:{type:'custom'},deployment_mode:'manual',mode:'container',image:'example/demo:1',ports:[],deployments:[{cluster_id:'cluster',machine_ids:['machine'],cpu:0.25,memory_mb:128}]},status:{instances:[{id:'instance',state:'removed',cluster_id:'cluster',machine_id:'machine'}]}},
 {id:'gateway',kind:'application',name:'OpenResty',revision:4,spec:{role:'openresty',service_name:'sys-openresty',deployments:[{cluster_id:'cluster',machine_ids:['machine']}],ports:[]},status:{instances:[{id:'entry',state:'running',healthy:true,cluster_id:'cluster',machine_id:'machine'}]}},
 {id:'site',kind:'website',name:'ABC Demo 网站',revision:4,spec:{cluster_ids:['cluster'],routing_mode:'managed',service_application_id:'app',mode:'proxy',bindings:[{domains:['abc.example.test'],locations:[]}]},status:{}},
 {id:'other',kind:'website',name:'售后入口与国际客户访问网站的长名称',revision:7,spec:{cluster_ids:['cluster'],routing_mode:'manual',bindings:[{domains:['support.example.test'],locations:[]}]},status:{}},
].map(r=>({...r,created_at:now,updated_at:now}));
let scenario='both',deletes=0,otherWrites=0;
const reference={id:'site',kind:'website',name:'ABC Demo 网站',domains:['abc.example.test'],sources:[{type:'saved',revision:4},{type:'published',revision:4}]};
const fixture=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');let result={};res.setHeader('content-type','application/json');
 if(req.method==='DELETE'&&url.pathname==='/api/v1/ops/resources/app'){
  let body='';for await(const chunk of req)body+=chunk;expect(JSON.parse(body)).toEqual({revision:5});deletes++;res.statusCode=409;
  result={error:'platform_resource_in_use',...(scenario==='fallback'?{}:{references:[{...reference,sources:scenario==='published'?[{type:'published',revision:3}]:reference.sources},...(scenario==='many'?[{id:'other',kind:'website',name:resources.at(-1).name,domains:['long-name-for-the-customer-service-team-international.example.test'],sources:[{type:'saved',revision:7}]}]:[])]})};
 }else{
  if(!['GET','HEAD'].includes(req.method))otherWrites++;
  if(url.pathname==='/api/v1/auth/me')result={id:'qa',name:'QA',role:'admin'};
  else if(url.pathname==='/api/v1/ops/overview')result={resources,agents:[],runs:[],machines:[{id:'machine',name:'zz-bj-1'}]};
  else if(url.pathname.endsWith('/storage'))result={instances:[],next_offset:null};
  else if(url.pathname.endsWith('/catalog'))result={templates:[]};
 }
 res.end(JSON.stringify(result));
});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));process.env.LIGHTMONI_DEV_API_URL='http://127.0.0.1:'+fixture.address().port;
const vite=await createViteServer({root:resolve(root,'web'),configFile:resolve(root,'web/vite.config.ts'),server:{host:'127.0.0.1',port:5199,strictPort:true},logLevel:'error'});await vite.listen();
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const rounds=[];let activePage;
try{
 for(let round=1;round<=3;round++){
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];activePage=page;page.on('pageerror',e=>errors.push(e.message));
  const shot=async name=>{
   const dialog=page.getByRole('dialog',{name:/无法删除「|Cannot delete “/});
   await expect(dialog).not.toHaveClass(/ant-zoom-(appear|enter|leave)/);
   await expect.poll(()=>dialog.evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.playState==='running').length)).toBe(0);
   await expect.poll(()=>dialog.evaluate(e=>({opacity:getComputedStyle(e).opacity,width:Math.round(e.getBoundingClientRect().width)>300}))).toEqual({opacity:'1',width:true});
   await page.screenshot({path:resolve(media,`round-${round}-${name}.png`),fullPage:false});
  };
  const attempt=async()=>{
   await page.goto('http://127.0.0.1:5199/applications');
   await page.getByRole('article',{name:'ABC Demo',exact:true}).getByRole('button',{name:'更多操作 · ABC Demo',exact:true}).click();
   await page.getByRole('menuitem',{name:'删除登记',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:/删\s*除/,exact:true}).click();
  };
  scenario='both';await attempt();
  let dialog=page.getByRole('dialog',{name:'无法删除「ABC Demo」',exact:true});await expect(dialog).toBeVisible();
  await expect(dialog.getByText('ABC Demo 网站',{exact:true})).toBeVisible();await expect(dialog.getByText('abc.example.test',{exact:true})).toBeVisible();await expect(dialog.getByText('已保存配置 v4 · 已发布版本 v4',{exact:true})).toBeVisible();await expect(dialog.getByRole('listitem')).toHaveCount(1);await shot('desktop');checks.push('409清单显示具体网站、域名、保存和发布版本，同一资源不重复');
  await dialog.getByRole('button',{name:'查看资源',exact:true}).click();await expect(page).toHaveURL(/\/websites\?resource=site$/);await expect(page.getByRole('dialog',{name:'ABC Demo 网站',exact:true})).toBeVisible();await page.getByRole('dialog',{name:'ABC Demo 网站',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();checks.push('查看资源进入网站页面并打开对应详情，无额外写请求');
  scenario='many';await page.setViewportSize({width:390,height:844});await attempt();dialog=page.getByRole('dialog',{name:'无法删除「ABC Demo」',exact:true});await expect(dialog.getByRole('listitem')).toHaveCount(2);await expect(dialog.getByText(resources.at(-1).name,{exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot('mobile-many');await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();checks.push('390px多资源与长名称域名正常换行、无横向溢出，关闭不删除');
  scenario='published';await attempt();dialog=page.getByRole('dialog',{name:'无法删除「ABC Demo」',exact:true});await expect(dialog.getByText('已发布版本 v3',{exact:true})).toBeVisible();await expect(dialog.getByText(/已保存配置/)).toHaveCount(0);await dialog.getByRole('button',{name:'关闭',exact:true}).last().focus();await page.keyboard.press('Enter');await expect(dialog).not.toBeVisible();checks.push('仅旧发布版本引用时显示正确版本；键盘可关闭');
  scenario='fallback';await attempt();await expect(page.getByText('仍有资源引用，请先解除网站或其他资源引用。',{exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'无法删除「ABC Demo」',exact:true})).not.toBeVisible();checks.push('旧服务缺少引用详情时兼容通用错误提示');
  scenario='published';await page.evaluate(()=>localStorage.setItem('lightmoni.language','en-US'));await page.reload();
  await page.getByRole('article',{name:'ABC Demo',exact:true}).getByRole('button',{name:'More actions · ABC Demo',exact:true}).click();await page.getByRole('menuitem',{name:'Delete registration',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Delete',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Cannot delete “ABC Demo”',exact:true});await expect(dialog.getByText('Published revision v3',{exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'View resource',exact:true})).toBeVisible();await shot('english-mobile');await dialog.getByRole('button',{name:'Close',exact:true}).last().click();checks.push('英文来源和跳转按钮正常显示');
  expect(errors).toEqual([]);expect(otherWrites).toBe(0);rounds.push({round,checks,page_errors:errors});await page.close();
 }
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({fixture:'isolated HTTP409 fixture; production unchanged',rounds,delete_attempts:deletes,other_write_requests:otherWrites,media},null,2));console.log(JSON.stringify({rounds,delete_attempts:deletes,other_write_requests:otherWrites,media}));
}catch(error){if(activePage&&!activePage.isClosed()){console.error((await activePage.locator('body').innerText()).slice(-5000));await activePage.screenshot({path:resolve(media,'failure.png')})}throw error}finally{await browser.close();await vite.close();fixture.close();fixture.closeAllConnections()}
