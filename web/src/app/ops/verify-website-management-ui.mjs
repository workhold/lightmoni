import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';

const root=resolve(import.meta.dirname,'../../../..');
const base=process.env.LIGHTMONI_FLOW_UI_URL??'http://127.0.0.1:5177';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw Error('Disposable loopback fixture required');
const run=process.env.LIGHTMONI_UI_RUN??'1',baseline=process.env.LIGHTMONI_UI_BASELINE==='1';
const out=resolve(root,'specs/077-website-management-flow/evidence/'+(baseline?'baseline':'ui-'+run));
const media=mediaDirectory(out);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{if(!localStorage.getItem('lightmoni.language'))localStorage.setItem('lightmoni.language','zh-CN');if(!localStorage.getItem('lightmoni.appearance'))localStorage.setItem('lightmoni.appearance','dark')});
const page=await context.newPage(),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
async function json(path,options={}){const response=await context.request.fetch(base+'/api/v1/ops'+path,options);if(!response.ok())throw Error(path+': '+response.status()+' '+await response.text());return response.json()}
async function seed(kind,name,spec){const existing=(await json('/overview')).resources.find(r=>r.name===name);if(existing)return existing;return(await json('/resources',{method:'POST',data:{kind,name,spec}})).resource}
async function shot(name){await expect.poll(()=>page.evaluate(()=>document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).every(a=>a.playState!=='running'))).toBe(true);await page.screenshot({path:resolve(media,name+'.png'),fullPage:true,animations:'disabled'})}
const modal=()=>page.locator('.ant-modal:visible').last();
async function choose(label,text,scope=modal()){await scope.getByLabel(label,{exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText(text,{exact:true}).click();await page.keyboard.press('Escape')}
let scenario='default',actionRequests=[];
try{
 const user=await context.request.get(base+'/api/v1/auth/me');expect((await user.json()).id).toBe('qa-admin');
 const a=await seed('cluster','南方入口',{machine_ids:[],nodes:[]}),b=await seed('cluster','北方入口',{machine_ids:[],nodes:[]});
 const credential=await seed('credential','流程验收 DNS 账号',{provider:'aliyun',access_key_id:'qa-fixture',access_key_secret:'qa-private-fixture'});
 const zone=await seed('dns_zone','example.test',{domain:'example.test',credential_id:credential.id});
 let entry=await seed('application','OpenResty 流程验收',{source:{type:'store',template_id:'openresty',template_version:'1.27.1.2-0-alpine'},role:'openresty',deployment_mode:'managed',mode:'container',network_mode:'host',image:'openresty/openresty:1.27.1.2-0-alpine',deployments:[{cluster_id:a.id,replicas:1,cpu:.25,memory_mb:128,gateway_domain:'south.edge.example.test'},{cluster_id:b.id,replicas:1,cpu:.5,memory_mb:256,gateway_domain:'north.edge.example.test',gateway_dns_zone_id:zone.id}],ports:[{name:'http',container_port:80,host_port:80,protocol:'tcp',app_protocol:'http'},{name:'https',container_port:443,host_port:443,protocol:'tcp',app_protocol:'https'}]});
 const resetSpec={...entry.spec,deployments:entry.spec.deployments.map((d,i)=>({...d,gateway_domain:(i?'north':'south')+'.edge.example.test',gateway_dns_zone_id:i?zone.id:undefined}))};
 entry=(await json('/resources/'+entry.id,{method:'PUT',data:{name:entry.name,revision:entry.revision,spec:resetSpec}})).resource;
 const siteSpec=(domain,ids)=>({routing_mode:'manual',mode:'proxy',dns_record_mode:'cname',cluster_ids:ids,bindings:[{domains:[domain],dns_enabled:true,dns_zone_id:zone.id,locations:[{path:'/',cluster_targets:ids.map(cluster_id=>({cluster_id,target:'proxy',upstreams:[{url:'http://127.0.0.1:5000'}]}))}]}]});
 const draft=await seed('website','镜像仓库',siteSpec('registry.example.test',[a.id]));
 const online=await seed('website','文档服务',siteSpec('docs.example.test',[a.id,b.id]));
 const partial=await seed('website','订单网关',siteSpec('orders.example.test',[a.id,b.id]));
 const active=(revision,extra={})=>({desired_revision:revision,enabled:true,active:true,synchronized:true,phase:'active',instances:{gateway:{state:'succeeded',revision}},...extra});
 await page.route('**/api/v1/ops/overview',async route=>{
  const response=await route.fetch(),body=await response.json();
  body.resources=body.resources.map(r=>{
   if(r.id===entry.id)return{...r,status:{...r.status,dns_error:scenario==='dns-error'?'dns_line_not_supported':'',dns:[],dns_updated_at:undefined,deployments:{[a.id]:{enabled:true,desired_revision:r.revision,applied_revision:r.revision},[b.id]:{enabled:false,desired_revision:0}},instances:[{id:'gateway',cluster_id:a.id,state:'running',healthy:true,retired:false}]}};
   if(r.id===draft.id)return{...r,status:{deployments:{},actual_cluster_ids:[],cluster_traffic:{},domain_traffic:{}}};
   if(r.id===online.id)return{...r,status:{deployments:{[a.id]:active(r.revision),[b.id]:active(r.revision)},actual_cluster_ids:[a.id,b.id],domain_traffic:{'docs.example.test':{cluster_ids:[a.id,b.id],eligible_cluster_ids:[a.id,b.id]}},cluster_traffic:{[a.id]:{eligible:true},[b.id]:{eligible:true}},dns:[{verified:true,propagation:'not_checked'}],dns_updated_at:'2026-11-01T12:00:00Z',dns_signature:'qa-readback'}};
   if(r.id===partial.id)return{...r,status:{deployments:{[a.id]:active(r.revision),[b.id]:active(r.revision,{active:false,synchronized:false,phase:scenario==='unknown'?'unknown':'failed',last_error:'gateway_apply_failed',instances:{gateway:{state:scenario==='unknown'?'unknown':'failed',revision:r.revision}}})},actual_cluster_ids:[a.id,b.id],domain_traffic:{'orders.example.test':{cluster_ids:[a.id,b.id],eligible_cluster_ids:[a.id]}},cluster_traffic:{[a.id]:{eligible:true},[b.id]:{eligible:false}},dns_error:scenario==='dns-error'?'dns_line_not_supported':''}};
   return r;
  });await route.fulfill({response,json:body});
 });
 await page.goto(base+'/websites');await expect(page.getByRole('button',{name:'镜像仓库',exact:true})).toBeVisible();
 if(baseline){await shot('websites-before');await page.getByRole('button',{name:'OpenResty 管理',exact:true}).click();await shot('entries-before');checks.push('旧页面与入口管理基线截图');}
 else {
  const article=name=>page.getByRole('article',{name,exact:true});
  await expect(article('镜像仓库').getByText('未发布',{exact:true})).toBeVisible();
  await expect(article('镜像仓库').getByText('发布后同步',{exact:true})).toBeVisible();
  await expect(article('文档服务').getByText('最近回读成功',{exact:true})).toBeVisible();
  await expect(article('订单网关').getByText('部分集群已发布',{exact:true})).toBeVisible();
  await shot('websites-dark');checks.push('未发布/全部发布/部分失败与DNS最近回读分开显示');
  await page.route('**/api/v1/ops/resources/*/actions',async route=>{actionRequests.push(route.request().postDataJSON());await route.fulfill({status:202,json:{runs:[]}})});
  await article('镜像仓库').getByRole('button',{name:'发布网站',exact:true}).click();
  await expect(modal().getByRole('button',{name:'确认发布',exact:true})).toBeVisible();
  expect(actionRequests).toHaveLength(0);await shot('publish-confirm');
  await modal().getByRole('button',{name:/^取\s*消$/}).click();expect(actionRequests).toHaveLength(0);
  await article('镜像仓库').getByRole('button',{name:'发布网站',exact:true}).click();
  await choose('执行集群（留空为全部已配置集群）',a.name);
  await modal().getByRole('button',{name:'确认发布',exact:true}).click();
  await expect(modal()).toBeHidden();expect(actionRequests).toEqual([{revision:draft.revision,confirmed:true,action:'deploy',input:{cluster_id:a.id}}]);
  await page.locator('.ant-drawer:visible').last().locator('.ant-drawer-close').click();checks.push('显式发布确认：取消零请求，确认携带当前版本/集群/confirmed；不触发真实Agent');
  await article('镜像仓库').getByRole('button',{name:'编辑配置',exact:true}).click();
  await modal().getByRole('button',{name:'保存配置',exact:true}).click();
  await expect(modal()).toBeHidden();
  await expect(page.locator('.lm-website-lifecycle')).toContainText('保存只更新配置');
  expect(actionRequests).toHaveLength(1);await shot('saved-lifecycle');
  await page.locator('.ant-drawer:visible').last().locator('.ant-drawer-close').click();checks.push('真实网站保存后打开配置/发布/解析详情，保存不隐式发布');
  await page.getByRole('button',{name:'OpenResty 管理',exact:true}).click();
  const drawer=page.locator('.lm-ops-entry-manager');
  const southRow=drawer.locator('.lm-entry-row').filter({has:page.getByRole('heading',{name:a.name,exact:true})});
  await expect(southRow).toContainText('自行维护 A / AAAA');await shot('entry-dns-overview');
  await southRow.getByRole('button',{name:'编辑入口解析',exact:true}).click();
  await choose('入口 A / AAAA 解析','由系统自动维护',southRow);
  await southRow.getByRole('button',{name:'保存入口解析',exact:true}).click();
  await expect(southRow.getByText('请选择托管域名',{exact:true})).toBeVisible();
  await choose('托管域名',zone.name,southRow);
  const before=(await json('/resources/'+entry.id)).resource;
  await southRow.getByLabel('集群入口域名',{exact:true}).fill('https://wrong/path');
  await southRow.getByRole('button',{name:'保存入口解析',exact:true}).click();
  await expect(southRow.getByText('请填写完整域名，不含协议、端口或路径。',{exact:true})).toBeVisible();
  await southRow.getByLabel('集群入口域名',{exact:true}).fill('south.edge.example.test');
  const conflict='**/api/v1/ops/resources/'+entry.id;
  await page.route(conflict,async route=>route.request().method()==='PUT'?route.fulfill({status:409,json:{error:'platform_revision_conflict'}}):route.continue());
  await southRow.getByRole('button',{name:'保存入口解析',exact:true}).click();
  await expect(southRow).toContainText('当前输入已保留');await expect(southRow.getByLabel('集群入口域名',{exact:true})).toHaveValue('south.edge.example.test');
  await page.unroute(conflict);
  await southRow.getByRole('button',{name:'保存入口解析',exact:true}).click();
  await expect(southRow.getByRole('button',{name:'编辑入口解析',exact:true})).toBeVisible();
  const saved=(await json('/resources/'+entry.id)).resource;
  expect(saved.spec).toEqual({...before.spec,deployments:before.spec.deployments.map(d=>d.cluster_id===a.id?{...d,gateway_dns_zone_id:zone.id}:d)});
  checks.push('入口短表单必填/域名错误位于字段下；并发冲突保留输入；真实PUT只改变所选集群DNS字段');
  await shot('entry-dns-saved');await drawer.locator('.ant-drawer-close').click();
  scenario='unknown';await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(article('订单网关').getByRole('button',{name:'检查发布状态',exact:true})).toBeVisible();
  scenario='dns-error';await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(article('订单网关')).toContainText('DNS 账号或套餐不支持所选线路。');
  checks.push('未知发布结果先检查；DNS错误提供具体下一步');
  scenario='default';await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await shot('websites-390');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'OpenResty 管理',exact:true}).click();await shot('entries-390');
  await page.locator('.lm-ops-entry-manager').locator('.ant-drawer-close').click();
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.style.zoom='2');await shot('websites-200');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>document.documentElement.style.zoom='');
  await page.evaluate(()=>localStorage.setItem('lightmoni.language','en-US'));await page.reload();await expect(page.getByRole('button',{name:'New Websites',exact:true})).toBeVisible();await shot('websites-english');
  await page.evaluate(()=>localStorage.setItem('lightmoni.appearance','light'));await page.reload();await expect(page.getByRole('article',{name:'镜像仓库',exact:true})).toBeVisible();await shot('websites-light');
  await page.emulateMedia({reducedMotion:'reduce'});expect(await page.locator('.lm-website-list').evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
  checks.push('390px与200%无页面横向溢出；英文/明暗主题/减少动态效果');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance','dark')});await page.reload();
  // Sample the actual CSS animation timeline, including the native active-button feedback.
  const list=page.locator('.lm-website-list');
  await list.evaluate(el=>{el.style.animation='none';void el.offsetWidth;el.style.animation='';const a=el.getAnimations()[0];if(a){a.pause();a.currentTime=0}});
  for(const [index,at] of [0,90,180].entries()){await list.evaluate((el,at)=>{for(const a of el.getAnimations())a.currentTime=at},at);await page.screenshot({path:resolve(media,'motion-enter-'+index+'.png'),animations:'allow'})}
  await page.getByRole('button',{name:'OpenResty 管理',exact:true}).click();
  const editButton=page.locator('.lm-entry-row').first().getByRole('button',{name:'编辑入口解析',exact:true});await editButton.click();
  const editor=page.locator('.lm-entry-editor');await editor.evaluate(el=>{el.style.animation='none';void el.offsetWidth;el.style.animation='';for(const a of el.getAnimations()){a.pause();a.currentTime=0}});
  for(const [index,at] of [0,90,180].entries()){await editor.evaluate((el,at)=>{for(const a of el.getAnimations())a.currentTime=at},at);await page.screenshot({path:resolve(media,'motion-edit-'+index+'.png'),animations:'allow'})}
  await editor.getByRole('button',{name:/^取\s*消$/}).click();await page.locator('.lm-ops-entry-manager').locator('.ant-drawer-close').click();
  const primary=article('镜像仓库').getByRole('button',{name:'发布当前配置',exact:true});
  // Existing unsent draft uses "发布网站"; saved revisions do not imply publication.
  const button=await primary.count()?primary:article('镜像仓库').getByRole('button',{name:'发布网站',exact:true});
  await button.hover();await page.screenshot({path:resolve(media,'motion-button-0.png'),animations:'allow'});
  await page.mouse.down();await page.screenshot({path:resolve(media,'motion-button-1.png'),animations:'allow'});await page.mouse.up();await page.screenshot({path:resolve(media,'motion-button-2.png'),animations:'allow'});
  await modal().getByRole('button',{name:/^取\s*消$/}).click();checks.push('出场/入口编辑状态转换的实际180ms CSS时间轴三帧，以及发布按钮按下/释放三帧；默认动效非新增长动画');
 }

 await writeFile(resolve(out,'results.json'),JSON.stringify({checks,errors,media:relative(root,media),scope:'Real disposable SQLite/API. Health, publication and DNS observation are explicit browser response fixtures; no external DNS or Agent actions.'},null,2)+'\n');
 if(errors.length)throw Error(JSON.stringify(errors));console.log(JSON.stringify({checks,errors,media}));
}catch(error){await shot('failure');await writeFile(resolve(out,'failure.txt'),await page.locator('body').innerText());throw error}finally{await browser.close()}
