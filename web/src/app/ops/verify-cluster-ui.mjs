import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';
// Requires the disposable SQLite QA fixture with managed_machines and this web app.
// The test intentionally saves drafts; the separate Docker demo verifies execution.
const base=process.env.LIGHTMONI_CLUSTER_UI_URL??'http://127.0.0.1:19934';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Cluster UI acceptance requires a loopback QA server');
const output=resolve(import.meta.dirname,'../../../../specs/042-cluster-applications/evidence/ui-live'),media=mediaDirectory(output);await mkdir(output,{recursive:true});
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),checks=[],errors=[],created=[];
page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
await context.addInitScript(()=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance','light')});
const suffix=Date.now().toString(36),name=value=>'UI-'+suffix+' '+value,domain='ui-'+suffix+'.example.test';
async function json(path,options={}){const response=await context.request.fetch(base+'/api/v1'+path,options);if(!response.ok())throw Error(path+': '+response.status()+' '+await response.text());return response.json()}
async function settled(){await expect(page.locator('.ant-spin-spinning:visible')).toHaveCount(0)}
async function screenshot(options){await expect.poll(()=>page.evaluate(()=>document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).every(animation=>animation.playState!=='running'))).toBe(true);return page.screenshot(options)}
async function all(){return(await json('/ops/overview')).resources}
async function byId(id){return(await all()).find(resource=>resource.id===id)}
async function save(kind,label){const before=new Set((await all()).map(r=>r.id));await dialog().getByRole('button',{name:'保存配置',exact:true}).click();await expect(dialog()).toBeHidden();const added=(await all()).filter(r=>!before.has(r.id));const resource=added.find(r=>r.kind===kind&&r.name===name(label));expect(resource).toBeTruthy();created.push(resource.id);return resource}
const dialog=()=>page.locator('.ant-modal:visible').last();
const drawer=()=>page.locator('.ant-drawer-section:visible').last();
async function closeDropdown(){await page.keyboard.press('Escape');await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0)}
async function choose(label,value,scope=dialog()){await scope.getByLabel(label,{exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText(value,{exact:true}).click();await closeDropdown()}
async function tags(label,value,scope=dialog()){const input=scope.getByLabel(label,{exact:true});await input.fill(value);await input.press('Enter')}
async function open(route,button,label,display=false){await page.goto(base+route);await page.getByRole('button',{name:button,exact:true}).click();await dialog().getByLabel(display?'展示名':'名称',{exact:true}).fill(name(label))}
async function seed(kind,label,spec){const {resource}=await json('/ops/resources',{method:'POST',data:{kind,name:name(label),spec}});created.push(resource.id);return resource}
try{
 const user=await json('/auth/me');if(user.id!=='qa-admin')throw Error('The server is not the isolated qa-admin acceptance environment');
 const initial=await json('/ops/overview');
 const available=initial.machines?.filter(m=>!m.cluster_id&&!initial.resources.some(r=>r.kind==='cluster'&&r.spec.machine_ids?.includes(m.id)))??[];
 if(available.length<2)throw Error('QA fixture needs two unassigned stable managed machines');
 const [machine,machine2]=available,clusterList=[];
 for(const [index,node] of [[0,machine],[1,machine2]]){
  await open('/clusters','新建集群','集群'+index);await choose('集群机器',node.name);
  const c=await save('cluster','集群'+index);expect(c.spec.machine_ids).toEqual([node.id]);clusterList.push(c);
 }
 const [cluster,cluster2]=clusterList;
 checks.push('真实 SQLite 创建两个集群、稳定机器唯一归属和节点地址读回');
 await page.getByRole('button',{name:'新建集群',exact:true}).click();await dialog().getByLabel('集群机器',{exact:true}).click();
 const occupied=page.locator('.ant-select-dropdown:visible').getByText(machine.name+' · 已属于其他集群',{exact:true});
 await expect(occupied).toBeVisible();await expect(occupied.locator('xpath=ancestor::*[contains(@class,"ant-select-item-option")][1]')).toHaveAttribute('aria-disabled','true');
 await closeDropdown();await dialog().getByRole('button',{name:/^取\s*消$/}).click();checks.push('已属于其他集群的机器在成员选择中禁用');
 const appRoute='/applications';
 async function custom(managed){
  await open(appRoute,'部署自定义应用','订单程序',true);await choose('部署模式',managed?'托管模式':'手动模式');
  const placements=dialog().locator('.lm-ops-deployment');await choose('部署集群',cluster.name,placements.nth(0));
  if(managed){
   await placements.nth(0).getByLabel('期望实例数',{exact:true}).fill('2');
   await dialog().getByRole('button',{name:'添加集群部署',exact:true}).click();
   await choose('部署集群',cluster2.name,placements.nth(1));await placements.nth(1).getByLabel('期望实例数',{exact:true}).fill('3');
   await placements.nth(1).getByLabel('每实例 CPU 核数',{exact:true}).fill('2');await placements.nth(1).getByLabel('每实例内存（MiB）',{exact:true}).fill('1024');
  }else await choose('部署机器',machine.name,placements.nth(0));
  await dialog().getByLabel('容器镜像',{exact:true}).fill('nginx:alpine');
  for(const [index,portName,port] of [[0,'api',8080],[1,'admin',9090]]){
   await dialog().getByRole('button',{name:'添加端口',exact:true}).click();const row=dialog().locator('.lm-ops-named-port-row').nth(index);
   await row.getByLabel('端口名称',{exact:true}).fill(portName);await row.getByLabel('容器端口',{exact:true}).fill(String(port));
   if(managed&&index===0)await row.getByLabel('宿主端口',{exact:true}).fill('18182');
  }
  if(managed)await dialog().getByLabel('探活端口名称',{exact:true}).fill('api');
  return save('application','订单程序');
 }
 const app=await custom(true),duplicate=await custom(false);
 expect(app.name).toBe(duplicate.name);expect(app.spec.service_name).not.toBe(duplicate.spec.service_name);
 expect(app.spec.deployments).toMatchObject([{cluster_id:cluster.id,replicas:2,cpu:1,memory_mb:512},{cluster_id:cluster2.id,replicas:3,cpu:2,memory_mb:1024}]);
 expect(app.spec.ports[0].host_port).toBe(18182);
 checks.push('全局应用跨双集群部署，2×1CPU/512MiB与3×2CPU/1GiB独立配置，托管固定端口；同名独立手动应用');
 await page.reload();await expect(page.getByRole('button',{name:app.name,exact:true})).toHaveCount(2);
 let row=page.locator('tr').filter({hasText:app.spec.service_name}).first();await row.getByRole('button',{name:/^编\s*辑$/}).click();
 await expect(dialog().getByLabel('serviceName',{exact:true})).toBeDisabled();await screenshot({path:resolve(media,'application-editor-desktop.png'),fullPage:false,animations:'disabled'});await dialog().getByLabel('每实例 CPU 核数',{exact:true}).last().scrollIntoViewIfNeeded();await screenshot({path:resolve(media,'application-deployments-desktop.png'),fullPage:false,animations:'disabled'});
 await dialog().getByLabel('展示名',{exact:true}).fill(name('冲突输入仍在'));const current=await byId(app.id);
 await json('/ops/resources/'+app.id,{method:'PUT',data:{revision:current.revision,name:current.name,spec:{...current.spec,deployments:current.spec.deployments.map((d,i)=>i?d:{...d,memory_mb:768})}}});
 await dialog().getByRole('button',{name:'保存配置',exact:true}).click();await expect(dialog().getByText('保存失败，输入已保留',{exact:true})).toBeVisible();
 await expect(dialog().getByLabel('展示名',{exact:true})).toHaveValue(name('冲突输入仍在'));await dialog().getByRole('button',{name:/^取\s*消$/}).click();
 checks.push('刷新跨集群配置、serviceName 编辑禁用；真实 revision 冲突保留表单');
 await open('/domains','新建托管域名','域名');const parent=dialog();await parent.getByLabel('托管域名',{exact:true}).fill('example.test');await parent.getByRole('button',{name:'新建DNS 账号',exact:true}).click();await drawer().getByLabel('名称',{exact:true}).fill(name('DNS 账号'));await drawer().getByLabel('Access Key ID / SecretId',{exact:true}).fill('qa-id');await drawer().getByLabel('Access Key Secret / SecretKey',{exact:true}).fill('qa-secret');await drawer().getByRole('button',{name:'保存并选择',exact:true}).click();await expect(parent.getByLabel('托管域名',{exact:true})).toHaveValue('example.test');await expect(parent.getByText(name('DNS 账号'),{exact:true})).toBeVisible();const credential=(await all()).find(r=>r.name===name('DNS 账号'));created.push(credential.id);const zone=await save('dns_zone','域名');expect(zone.spec.credential_id).toBe(credential.id);checks.push('DNS 账号就近快捷创建、父表单输入保持、自动回填并实际保存');
 await open('/certificates','新建证书','证书');await tags('证书域名',domain);await tags('证书域名','admin-'+domain);const certificateParent=dialog();await certificateParent.getByRole('button',{name:'新建ACME 账号',exact:true}).click();await drawer().getByLabel('名称',{exact:true}).fill(name('ACME 账号'));await drawer().getByLabel('联系邮箱',{exact:true}).fill('qa@example.test');await drawer().getByRole('checkbox').check();await drawer().getByRole('button',{name:'保存并选择',exact:true}).click();await expect(certificateParent.getByText(name('ACME 账号'),{exact:true})).toBeVisible();const acme=(await all()).find(r=>r.name===name('ACME 账号'));created.push(acme.id);await choose('DNS 验证域名',zone.name);const certificate=await save('certificate','证书');expect(certificate.spec.acme_account_id).toBe(acme.id);checks.push('ACME 账号快捷创建自动回填，证书域名和 DNS 引用保持');
 await page.goto(base+appRoute);await page.getByRole('button',{name:'应用商店',exact:true}).click();await expect(drawer().getByText('MySQL',{exact:true})).toBeVisible();const mysql=drawer().locator('tr').filter({hasText:'MySQL'});await mysql.getByRole('button',{name:/^安\s*装$/}).click();await expect(drawer().getByText('推荐手动部署',{exact:true})).toBeVisible();await expect(drawer().getByLabel('应用版本',{exact:true})).toBeVisible();await expect(drawer().getByRole('button',{name:'确认安装并部署',exact:true})).toBeVisible();await screenshot({path:resolve(media,'store-install-desktop.png'),fullPage:false,animations:'disabled'});await closeDropdown();checks.push('商店真实目录、版本、参数、数据库托管建议与安装确认入口');
 const openresty=await seed('application','入口',{deployments:clusterList.map(c=>({cluster_id:c.id,machine_ids:c.spec.machine_ids,cpu:.25,memory_mb:128})),source:{type:'store',template_id:'openresty'},role:'openresty',deployment_mode:'manual',mode:'container',network_mode:'host',image:'openresty/openresty:1.27.1.2-0-alpine',ports:[{name:'http',container_port:80,host_port:80,protocol:'tcp',app_protocol:'http'},{name:'https',container_port:443,host_port:443,protocol:'tcp',app_protocol:'https'}]});
 await open('/websites','新建网站','网站');await choose('应用集群',cluster.name);await choose('应用集群',cluster2.name);
 for(const [index,hostname,portName] of [[0,domain,'api'],[1,'admin-'+domain,'admin']]){
  if(index)await dialog().getByRole('button',{name:'添加域名绑定',exact:true}).click();
  const binding=dialog().locator('.lm-ops-binding').nth(index);await tags('网站域名',hostname,binding);
  await binding.getByRole('button',{name:'添加路径规则',exact:true}).click();
  for(let ci=0;ci<2;ci++){
   const target=binding.locator('.lm-ops-cluster-target').nth(ci);await target.getByLabel('后端应用',{exact:true}).click();
   if(ci===1)await expect(page.locator('.ant-select-dropdown:visible').getByText(duplicate.name+' · '+duplicate.spec.service_name,{exact:true})).toHaveCount(0);
   await page.locator('.ant-select-dropdown:visible').getByText(app.name+' · '+app.spec.service_name,{exact:true}).click();await closeDropdown();
   await choose('应用端口',portName+' · '+(portName==='api'?8080:9090)+'/http',target);
  }
  if(index===0){await binding.getByLabel('启用 HTTPS',{exact:true}).click();await choose('使用证书',certificate.name,binding);await binding.getByLabel('自动维护域名解析',{exact:true}).click();await choose('托管域名',zone.name,binding)}
 }
 await dialog().getByText('站点：请求限制、压缩与日志',{exact:true}).click();await dialog().getByLabel('启用Gzip压缩',{exact:true}).click();
 const website=await save('website','网站');expect(website.spec.cluster_ids).toEqual([cluster.id,cluster2.id]);expect(website.spec.bindings).toHaveLength(2);
 expect(website.spec.bindings[0].locations[0].cluster_targets).toMatchObject([{cluster_id:cluster.id,target:'application',application_id:app.id,port_name:'api'},{cluster_id:cluster2.id,target:'application',application_id:app.id,port_name:'api'}]);
 expect(website.spec.bindings[1].locations[0].cluster_targets[1].port_name).toBe('admin');expect(website.spec.nginx.gzip).toBe(true);
 await page.reload();await expect(page.getByRole('button',{name:website.name,exact:true})).toBeVisible();await settled();await screenshot({path:resolve(media,'websites-desktop.png'),fullPage:true,animations:'disabled'});
 await page.locator('tr').filter({has:page.getByRole('button',{name:website.name,exact:true})}).getByRole('button',{name:/^编\s*辑$/}).click();
 await expect(dialog().locator('.lm-ops-cluster-target').nth(0).getByText(app.name+' · '+app.spec.service_name,{exact:true})).toBeVisible();await expect(dialog().locator('.lm-ops-cluster-target').nth(0).getByText('api · 8080/http',{exact:true})).toBeVisible();await expect(dialog().locator('.lm-ops-cluster-target').nth(3).getByText('admin · 9090/http',{exact:true})).toBeVisible();await screenshot({path:resolve(media,'website-editor-desktop.png'),fullPage:false,animations:'disabled'});await dialog().getByLabel('后端应用',{exact:true}).first().scrollIntoViewIfNeeded();await screenshot({path:resolve(media,'website-targets-desktop.png'),fullPage:false,animations:'disabled'});await dialog().getByRole('button',{name:/^取\s*消$/}).click();
 checks.push('网站双集群公共域名/证书/DNS/Gzip配置，每路径上游按集群绑定；缺部署应用不可选，无健康实例允许保存');
 for(const [path,title] of [['/clusters','集群'],['/applications','应用'],['/websites','网站'],['/domains','托管域名'],['/certificates','证书']]){await page.goto(base+path+(''));await expect(page.getByRole('heading',{name:title,exact:true}).first()).toBeVisible();await expect(page.getByRole('link',{name:/托管服务|网关组/})).toHaveCount(0)}
 await page.goto(base+appRoute);await expect(page.getByRole('button',{name:openresty.name,exact:true})).toBeVisible();await settled();await screenshot({path:resolve(media,'applications-desktop.png'),fullPage:true,animations:'disabled'});await page.setViewportSize({width:390,height:844});if(await page.getByRole('button',{name:'收起导航',exact:true}).isVisible())await page.getByRole('button',{name:'收起导航',exact:true}).click();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await screenshot({path:resolve(media,'applications-390.png'),fullPage:true,animations:'disabled'});await page.getByRole('button',{name:'部署自定义应用',exact:true}).click();await dialog().getByRole('button',{name:'添加端口',exact:true}).click();await dialog().getByLabel('容器端口',{exact:true}).scrollIntoViewIfNeeded();await expect(dialog().getByRole('button',{name:'保存配置',exact:true})).toBeInViewport();expect(await dialog().locator('.ant-modal-body').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await screenshot({path:resolve(media,'application-editor-390.png'),fullPage:false,animations:'disabled'});const zoomContext=await browser.newContext({viewport:{width:720,height:500},deviceScaleFactor:2});await zoomContext.addInitScript(()=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.nav.collapsed','true');localStorage.setItem('lightmoni.appearance','light')});const zoomPage=await zoomContext.newPage();await zoomPage.goto(base+appRoute);await zoomPage.getByRole('button',{name:'部署自定义应用',exact:true}).click();const zoomDialog=zoomPage.locator('.ant-modal:visible');await zoomDialog.getByRole('button',{name:'添加端口',exact:true}).click();await zoomDialog.getByLabel('容器端口',{exact:true}).scrollIntoViewIfNeeded();await expect(zoomDialog.getByRole('button',{name:'保存配置',exact:true})).toBeInViewport();await zoomPage.screenshot({path:resolve(media,'application-editor-200.png'),fullPage:false,animations:'disabled'});await zoomContext.close();checks.push('五个独立路由、导航去除旧入口、390px 列表和多端口表单无页面溢出');
 if(errors.length)throw Error(errors.join('\n'));
 await writeFile(resolve(output,'report.json'),JSON.stringify({checked_at:new Date().toISOString(),base,backend:'Actual SQLite + cluster/application controllers; isolated qa-admin',checks,page_errors:errors,scope:'Draft configuration, real persistence and conflict/shortcut interactions. No cloud calls or container execution.',created_count:created.length},null,2));console.log(JSON.stringify({checks,report:resolve(output,'report.json')}));
}catch(error){await screenshot({path:resolve(media,'failure.png'),fullPage:true}).catch(()=>{});console.error('Checks before failure:',checks);throw error}finally{
 const priority={website:0,application:1,certificate_target:2,certificate:3,dns_zone:4,acme_account:5,credential:6,cluster:7};
 const owned=(await all().catch(()=>[])).filter(r=>r.name.startsWith('UI-'+suffix+' ')).sort((a,b)=>(priority[a.kind]??9)-(priority[b.kind]??9));
 for(const {id} of owned){try{const r=await byId(id);if(!r)continue;if(r.kind==='cluster')await json('/ops/resources/'+id,{method:'PUT',data:{revision:r.revision,name:r.name,spec:{...r.spec,machine_ids:[],nodes:[]}}});const latest=await byId(id);await json('/ops/resources/'+id,{method:'DELETE',data:{revision:latest.revision}})}catch(error){console.error('QA cleanup:',id,error.message)}}
 await context.close();await browser.close();
}
