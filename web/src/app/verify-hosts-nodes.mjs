import {chromium,expect} from '@playwright/test';
import {mkdtemp,cp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,extname} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// A copied production bundle and wholly intercepted fixture APIs. No network,
// real SSH, enrollment credential, machine, or production service is touched.
const origin='http://127.0.0.1:19861',publicDir=await mkdtemp(resolve(tmpdir(),'lightmoni-hosts-nodes-ui-'));
await cp(resolve(import.meta.dirname,'../../../runtime/public'),publicDir,{recursive:true});
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'specs/034-unified-host-nodes');await mkdir(output,{recursive:true});
const media=mediaDirectory(output),checked=[],errors=[],unexpected=[],contexts=[];
const mark=value=>{checked.push(value);console.log('PASS '+value)};
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
async function harness({role='admin',language='zh-CN',width=1440,withoutKeys=false}={}){
 const now=new Date().toISOString(),available={available:true,reason:''};
 const base={port:22,username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:fixtureconfirmed',host_key_status:'confirmed',agent_status:'unknown',credential_count:1,active_credential_count:1,active_ssh_credential_count:1,active_ssh_key_count:1,ssh_recovery_available:true,capabilities:{terminal:available,ssh_check:available,deploy_agent:available,uninstall_agent:available},last_deployment_status:'',updated_at:now,created_at:now};
 const machines=[{...base,id:'host-bare',name:'Fixture bare host',address:'bare.example.test',agent_id:''},{...base,id:'host-linked',name:'Fixture linked host',address:'linked.example.test',agent_id:'node-linked',agent_status:'online'}];
 const nodes=['linked','orphan'].map(suffix=>({id:'node-'+suffix,hostname:'Fixture '+suffix+' node',platform:'linux',arch:'amd64',version:'fixture',last_seen:now,lifecycle_state:'active',heartbeat:{config_revision:'fixture'},config:{revision:'fixture'},label_ids:['default'],labels:[{id:'default',name:'默认'}],tasks:[{id:'task-one',name:'Fixture metrics',type:'host'}]}));
 const labels=[{id:'default',name:'默认',node_count:2,task_count:1}],tasks=[{id:'task-one',name:'Fixture metrics',type:'host',enabled:true,label_ids:['default'],config:{host_enabled:true,host_collectors:['cpu'],collect_interval_seconds:15}}];
 const keys=withoutKeys?[]:[{id:'fixture-key',method:'ssh_key',secret_fingerprint:'metadata-only',retention:'managed',expires_at:new Date(Date.now()+60_000).toISOString()}];
 const state={machines,nodes,labels,tasks,requests:[],removeError:'',linkError:'',holdRemove:false,releaseRemove:undefined};
 const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(language=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.nav.collapsed','true');localStorage.setItem('lightmoni.homepage.fixture-user','/agents')},language);
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(url.href);return route.abort()}
  if(path.startsWith('/api/')){
   const body=request.postData()?request.postDataJSON():undefined;state.requests.push({path,query:url.search,method,body});
   if(path==='/api/v1/auth/me')return route.fulfill({json:{id:'fixture-user',name:'Fixture User',role}});
   if(path==='/api/v1/auth/profile')return route.fulfill({json:{}});
   if(path==='/api/v1/agents'&&method==='GET')return route.fulfill({json:state.nodes.filter(node=>url.searchParams.get('include_removed')==='true'||node.lifecycle_state!=='removed')});
   if(path==='/api/v1/agent-task-labels')return route.fulfill({json:state.labels});
   if(path==='/api/v1/agent-tasks')return route.fulfill({json:state.tasks});
   if(path==='/api/v1/machines'&&method==='GET')return route.fulfill({json:state.machines});
   if(path==='/api/v1/catalog/tables')return route.fulfill({json:[]});
   const remove=path.match(/^\/api\/v1\/agents\/([^/]+)\/remove$/);
   if(remove&&method==='POST'){
    if(state.holdRemove)await new Promise(resolve=>state.releaseRemove=resolve);
    if(state.removeError)return route.fulfill({status:409,json:{error:state.removeError}});
    expect(body.confirm).toBe(true);const node=state.nodes.find(node=>node.id===remove[1]);node.lifecycle_state='removed';node.removed_at=now;node.removal_reason=body.reason;
    return route.fulfill({json:{agent_id:node.id,lifecycle_state:'removed',removed_at:now,credentials_revoked:true,remote_uninstalled:false}});
   }
   const tag=path.match(/^\/api\/v1\/agents\/([^/]+)\/labels$/);
   if(tag&&method==='PUT'){state.nodes.find(node=>node.id===tag[1]).label_ids=body.label_ids;return route.fulfill({json:{ok:true}})}
   const link=path.match(/^\/api\/v1\/machines\/([^/]+)\/agent-link$/);
   if(link&&method==='POST'){
    if(state.linkError)return route.fulfill({status:409,json:{error:state.linkError}});
    expect(body).toEqual({agent_id:'node-orphan',credential_id:'fixture-key'});const host=state.machines.find(host=>host.id===link[1]);host.agent_id=body.agent_id;host.agent_status='online';return route.fulfill({json:host});
   }
   const detail=path.match(/^\/api\/v1\/machines\/([^/]+)$/);
   if(detail&&method==='GET')return route.fulfill({json:{machine:state.machines.find(host=>host.id===detail[1]),credentials:keys,deployments:[]}});
   unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
  }
  const file=path.startsWith('/assets/')?resolve(publicDir,'.'+path):resolve(publicDir,'index.html');
  return route.fulfill({body:await readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]??'application/octet-stream'});
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 const row=id=>page.locator(`.ant-table-tbody tr[data-row-key="${id}"]`),removes=()=>state.requests.filter(request=>request.path.endsWith('/remove'));
 return {page,state,row,removes};
}
let current;
try{
 const {page,state,row,removes}=await harness();current=page;await page.goto(origin+'/machines');
 await expect(page.getByRole('heading',{name:'主机',exact:true})).toBeVisible();await expect(page.locator('.lm-sidebar').getByRole('link',{name:'主机',exact:true})).toHaveCount(1);await expect(page.locator('.lm-sidebar').getByRole('link',{name:'节点助手',exact:true})).toHaveCount(0);
 await expect(row('host-bare')).toBeVisible();await expect(row('host-linked')).toBeVisible();await expect(row('node:node-orphan')).toBeVisible();await expect(row('node:node-linked')).toHaveCount(0);await expect(row('host-bare')).toContainText('未接入 Agent');await expect(row('host-linked')).toContainText('Agent 在线');await expect(row('node:node-orphan')).toContainText('独立接入节点');mark('one navigation entry and three distinct host/node states; explicit identity aggregation never duplicates a linked node');
 await row('node:node-orphan').getByRole('button',{name:'卸载指引',exact:true}).click();let dialog=page.getByRole('dialog',{name:'卸载 Agent 指引',exact:true});await expect(dialog).toContainText('不会把显示此指引当作卸载成功');await expect(dialog).toContainText('uninstall.sh');await dialog.locator('.ant-modal-close').click();expect(state.requests.filter(request=>request.method==='POST')).toHaveLength(0);mark('independent nodes explain SSH and manual uninstall requirements without executing an action');
 await row('node:node-orphan').getByRole('button',{name:'移除节点',exact:true}).click();dialog=page.getByRole('dialog',{name:'移除节点',exact:true});await expect(dialog).toContainText('node-orphan');await expect(dialog).toContainText('远端 Agent 可能仍在运行');await dialog.getByRole('button',{name:/取\s*消/,exact:true}).click();expect(removes()).toHaveLength(0);mark('node removal binds its target and explains archive versus uninstall; cancellation sends no write');
 state.removeError='Fixture running task prevents removal';await row('node:node-orphan').getByRole('button',{name:'移除节点',exact:true}).click();await page.getByRole('button',{name:'确认移除节点',exact:true}).click();await expect(page.getByRole('dialog',{name:'移除节点',exact:true})).toContainText(state.removeError);await expect(row('node:node-orphan')).toBeVisible();mark('backend task/removal conflict stays visible and keeps the node intact');
 state.removeError='';state.holdRemove=true;await page.getByRole('textbox',{name:'移除原因（可选）',exact:true}).fill('Fixture retirement');await page.getByRole('dialog',{name:'移除节点',exact:true}).locator('button.ant-btn-dangerous').evaluate(button=>{button.click();button.click()});await expect.poll(()=>!!state.releaseRemove).toBe(true);expect(removes()).toHaveLength(2);await expect(page.getByRole('dialog',{name:'移除节点',exact:true}).getByRole('button',{name:/取\s*消/,exact:true})).toBeDisabled();state.releaseRemove();await expect(row('node:node-orphan')).toHaveCount(0);await expect(row('host-linked')).toBeVisible();expect(removes().at(-1).body.reason).toBe('Fixture retirement');mark('retry and synchronous repeated confirmation send one removal request; success hides only the target node');
 await page.getByRole('checkbox',{name:'包含已移除节点',exact:true}).check();await expect(row('node:node-orphan')).toBeVisible();await expect(row('node:node-orphan')).toContainText('节点已移除');await expect(row('node:node-orphan').getByRole('button',{name:'移除节点',exact:true})).toHaveCount(0);await row('node:node-orphan').getByRole('button',{name:'节点详情',exact:true}).click();dialog=page.getByRole('dialog',{name:'节点详情',exact:true});await expect(dialog).toContainText('Fixture retirement');await expect(dialog).toContainText('旧凭据不能继续接入');await dialog.locator('.ant-modal-close').click();mark('administrator history reads include_removed, retains archive metadata, and never offers restoration or repeat removal');
 await page.getByRole('tab',{name:'监控任务',exact:true}).click();await expect(page.getByRole('row').filter({hasText:'Fixture metrics'})).toBeVisible();await expect(page).toHaveURL(origin+'/machines?tab=tasks');await page.getByRole('tab',{name:'任务标签',exact:true}).click();await expect(page.getByRole('heading',{name:'任务标签',exact:true})).toBeVisible();mark('monitoring tasks and labels reuse existing editors in one workspace');
 await page.goto(origin+'/agents?tab=tasks&group=default');await expect(page.getByRole('tab',{name:'监控任务',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('row').filter({hasText:'Fixture metrics'})).toBeVisible();await page.goto(origin+'/');await expect(page).toHaveURL(origin+'/machines');mark('legacy /agents task deep links work and legacy default-homepage preferences resolve to /machines');
 {
  const test=await harness();current=test.page;await test.page.goto(origin+'/machines');await test.row('node:node-orphan').getByRole('button',{name:'关联主机',exact:true}).click();const modal=test.page.getByRole('dialog',{name:'核验并关联主机与节点',exact:true});await expect(modal).toContainText('不按 IP 或名称自动合并');await modal.getByRole('combobox',{name:'待关联主机',exact:true}).click();await test.page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:'Fixture bare host'}).click();await expect(modal.getByRole('button',{name:'执行只读核验并关联',exact:true})).toBeEnabled();test.state.linkError='Fixture Agent identity mismatch';await modal.getByRole('button',{name:'执行只读核验并关联',exact:true}).click();await expect(modal).toContainText(test.state.linkError);await expect(test.row('node:node-orphan')).toBeVisible();test.state.linkError='';await modal.getByRole('button',{name:'执行只读核验并关联',exact:true}).click();await expect(modal).toHaveCount(0);await expect(test.row('node:node-orphan')).toHaveCount(0);await expect(test.row('host-bare')).toContainText('node-orphan');mark('explicit SSH identity-link UI sends only reviewed IDs, preserves failures, and merges rows only after successful server verification');
  await test.row('host-bare').getByRole('button',{name:'设置任务标签',exact:true}).click();await expect(test.page.getByRole('dialog',{name:'设置任务标签 · Fixture orphan node',exact:true})).toBeVisible();await test.page.getByRole('button',{name:'保存任务标签',exact:true}).click();await expect(test.page.getByRole('dialog')).toHaveCount(0);expect(test.state.requests.filter(request=>request.method==='PUT').at(-1).path).toBe('/api/v1/agents/node-orphan/labels');mark('unified node rows keep the task-label editor and its exact node identity');
 }
 {
  const test=await harness({withoutKeys:true});current=test.page;await test.page.goto(origin+'/machines');await test.row('host-bare').getByRole('button',{name:'关联已有节点',exact:true}).click();const modal=test.page.getByRole('dialog',{name:'核验并关联主机与节点',exact:true});await expect(modal).toContainText('请先在该主机添加有效私钥或临时/托管密码');await expect(modal.getByRole('button',{name:'执行只读核验并关联',exact:true})).toBeDisabled();expect(test.state.requests.filter(request=>request.method==='POST')).toHaveLength(0);mark('SSH identity linking without an active key gives a reason and cannot submit');
 }
 {
  const test=await harness({role:'member'});current=test.page;await test.page.goto(origin+'/machines?machine=host-linked&deployment=fixture-plan');await expect(test.row('node:node-linked')).toBeVisible();await expect(test.row('host-linked')).toHaveCount(0);await expect(test.page.getByRole('button',{name:'删除主机',exact:true})).toHaveCount(0);await expect(test.page.getByRole('button',{name:'移除节点',exact:true})).toHaveCount(0);await expect(test.page.getByRole('button',{name:'关联主机',exact:true})).toHaveCount(0);await test.page.getByRole('tab',{name:'监控任务',exact:true}).click();await expect(test.page.getByRole('button',{name:/新建任务/})).toBeDisabled();expect(test.state.requests.some(request=>request.path.startsWith('/api/v1/machines'))).toBe(false);expect(test.state.requests.some(request=>request.path.includes('credentials'))).toBe(false);mark('members retain node and task views while never requesting machine, credential, or lifecycle APIs, including hostile machine deep links');
 }
 {
  const test=await harness({language:'en-US',width:390});current=test.page;await test.page.goto(origin+'/machines');await expect(test.page.getByRole('heading',{name:'Hosts',exact:true})).toBeVisible();await expect(test.row('node:node-orphan')).toBeVisible();await test.row('node:node-orphan').getByRole('button',{name:'Remove node',exact:true}).click();await expect(test.page.getByRole('dialog',{name:'Remove node',exact:true})).toContainText('remote software stays installed');expect(await test.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await test.page.screenshot({path:resolve(media,'hosts-nodes-en-390.png'),fullPage:true,animations:'disabled'});mark('English unified list and removal confirmation fit a 390px viewport without page overflow');
 }
 current=page;await page.screenshot({path:resolve(media,'hosts-nodes-zh-1440.png'),fullPage:true,animations:'disabled'});
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);await writeFile(resolve(output,'hosts-nodes-ui-report.json'),JSON.stringify({production_bundle:true,api_fixtures:true,real_ssh:false,production_writes:false,checked,errors,unexpected},null,2)+'\n');
}catch(error){await current?.screenshot({path:resolve(media,'hosts-nodes-failure.png'),fullPage:true}).catch(()=>{});console.error({errors,unexpected});throw error}
finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDir,{recursive:true,force:true})}
