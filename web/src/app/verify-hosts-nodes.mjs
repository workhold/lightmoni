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
 const machines=[{...base,id:'host-bare',name:'Fixture bare host',address:'bare.example.test',agent_id:''},{...base,id:'host-linked',name:'Fixture linked host',address:'linked.example.test',agent_id:'node-linked',agent_status:'online'},{...base,id:'host-channel',name:'Fixture channel host',address:'channel.example.test',port:22,username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:fixtureconfirmed',host_key_status:'confirmed',agent_id:'node-second',agent_status:'online',observed_hostname:'Fixture reported hostname',ssh_recovery_available:false,credential_count:0,active_credential_count:0,active_ssh_credential_count:0,active_ssh_key_count:0,capabilities:{terminal:{available:false,reason:'ssh_credential_required'},ssh_check:{available:false,reason:'ssh_credential_required'},deploy_agent:{available:false,reason:'ssh_credential_required'},uninstall_agent:{available:false,reason:'ssh_credential_required'}}}];
 const nodes=['linked','second'].map(suffix=>({id:'node-'+suffix,machine_id:suffix==='linked'?'host-linked':'host-channel',machine_name:suffix==='linked'?'Fixture linked host':'Fixture channel host',hostname:'Fixture '+suffix+' node',platform:'linux',arch:'amd64',version:'fixture',last_seen:now,lifecycle_state:'active',heartbeat:{config_revision:'fixture'},config:{revision:'fixture'},label_ids:['default'],labels:[{id:'default',name:'默认'}],tasks:[{id:'task-one',name:'Fixture metrics',type:'host'}]}));
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
   const detail=path.match(/^\/api\/v1\/machines\/([^/]+)$/);
   if(detail&&method==='GET')return route.fulfill({json:{machine:state.machines.find(host=>host.id===detail[1]),credentials:detail[1]==='host-channel'?[]:keys,deployments:[]}});
   if(detail&&method==='PUT'){const host=state.machines.find(host=>host.id===detail[1]);Object.assign(host,body);return route.fulfill({json:host})}
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
 await expect(row('host-bare')).toBeVisible();await expect(row('host-linked')).toBeVisible();await expect(row('host-channel')).toBeVisible();await expect(row('node:node-linked')).toHaveCount(0);await expect(row('host-bare')).toContainText('未接入 Agent');await expect(row('host-linked')).toContainText('Agent 在线');await expect(row('host-channel')).toContainText('channel.example.test:22');await expect(row('host-channel')).toContainText('主机 ID：host-channel');await expect(page.getByRole('button',{name:'关联已有节点',exact:true})).toHaveCount(0);await expect(page.getByText('独立接入节点 · 未关联主机',{exact:true})).toHaveCount(0);mark('one host asset list uses persisted IDs, enriches Agent status, and does not manufacture SSH addresses for registered hosts');
 await row('host-channel').getByRole('button',{name:'卸载指引',exact:true}).click();let dialog=page.getByRole('dialog',{name:'卸载 Agent 指引',exact:true});await expect(dialog).toContainText('不会把显示此指引当作卸载成功');await expect(dialog).toContainText('uninstall.sh');await dialog.locator('.ant-modal-close').click();expect(state.requests.filter(request=>request.method==='POST')).toHaveLength(0);mark('registered hosts explain SSH and manual uninstall requirements without executing an action');
 await row('host-channel').getByRole('button',{name:'移除节点',exact:true}).click();dialog=page.getByRole('dialog',{name:'移除节点',exact:true});await expect(dialog).toContainText('node-second');await expect(dialog).toContainText('远端 Agent 可能仍在运行');await dialog.getByRole('button',{name:/取\s*消/,exact:true}).click();expect(removes()).toHaveLength(0);mark('node removal binds its target and explains archive versus uninstall; cancellation sends no write');
 state.removeError='Fixture running task prevents removal';await row('host-channel').getByRole('button',{name:'移除节点',exact:true}).click();await page.getByRole('button',{name:'确认移除节点',exact:true}).click();await expect(page.getByRole('dialog',{name:'移除节点',exact:true})).toContainText(state.removeError);await expect(row('host-channel')).toBeVisible();mark('backend task/removal conflict stays visible and keeps the node intact');
 state.removeError='';state.holdRemove=true;await page.getByRole('textbox',{name:'移除原因（可选）',exact:true}).fill('Fixture retirement');await page.getByRole('dialog',{name:'移除节点',exact:true}).locator('button.ant-btn-dangerous').evaluate(button=>{button.click();button.click()});await expect.poll(()=>!!state.releaseRemove).toBe(true);expect(removes()).toHaveLength(2);await expect(page.getByRole('dialog',{name:'移除节点',exact:true}).getByRole('button',{name:/取\s*消/,exact:true})).toBeDisabled();state.releaseRemove();await expect(row('host-channel')).toBeVisible();await expect(row('host-channel')).toContainText('节点已移除');await expect(row('host-linked')).toBeVisible();expect(removes().at(-1).body.reason).toBe('Fixture retirement');mark('retry and synchronous repeated confirmation send one removal request; identity removal retains its host asset');
 await page.getByRole('checkbox',{name:'包含已移除节点',exact:true}).check();await expect(row('host-channel')).toBeVisible();await expect(row('host-channel')).toContainText('节点已移除');await expect(row('host-channel').getByRole('button',{name:'移除节点',exact:true})).toHaveCount(0);await row('host-channel').getByRole('button',{name:'节点详情',exact:true}).click();dialog=page.getByRole('dialog',{name:'节点详情',exact:true});await expect(dialog).toContainText('Fixture retirement');await expect(dialog).toContainText('旧凭据不能继续接入');await dialog.locator('.ant-modal-close').click();mark('administrator history reads include_removed, retains archive metadata, and never offers restoration or repeat removal');
 await page.getByRole('tab',{name:'监控任务',exact:true}).click();await expect(page.getByRole('row').filter({hasText:'Fixture metrics'})).toBeVisible();await expect(page).toHaveURL(origin+'/machines?tab=tasks');await page.getByRole('tab',{name:'任务标签',exact:true}).click();await expect(page.getByRole('heading',{name:'任务标签',exact:true})).toBeVisible();mark('monitoring tasks and labels reuse existing editors in one workspace');
 await page.goto(origin+'/agents?tab=tasks&group=default');await expect(page.getByRole('tab',{name:'监控任务',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('row').filter({hasText:'Fixture metrics'})).toBeVisible();await page.goto(origin+'/');await expect(page).toHaveURL(origin+'/machines');mark('legacy /agents task deep links work and legacy default-homepage preferences resolve to /machines');
 {
  const test=await harness();current=test.page;await test.page.goto(origin+'/machines');
  await test.row('host-channel').getByRole('button',{name:'编辑主机',exact:true}).click();let modal=test.page.getByRole('dialog',{name:'编辑主机 · Fixture channel host',exact:true});
  await expect(modal).toContainText('host-channel');await expect(modal).toContainText('Fixture reported hostname');await modal.getByRole('checkbox',{name:'配置 SSH 连接',exact:true}).uncheck();await expect(modal.getByRole('textbox')).toHaveCount(1);
  await modal.getByRole('textbox',{name:'主机名称',exact:false}).fill('User selected host name');await modal.getByRole('button',{name:'保存主机',exact:true}).click();await expect(modal).toHaveCount(0);await expect(test.row('host-channel')).toContainText('User selected host name');expect(test.state.requests.filter(request=>request.method==='PUT').at(-1).body).toEqual({name:'User selected host name'});
  await test.row('host-channel').getByRole('button',{name:'编辑主机',exact:true}).click();modal=test.page.getByRole('dialog',{name:'编辑主机 · User selected host name',exact:true});await expect(modal.getByRole('checkbox',{name:'配置 SSH 连接',exact:true})).toBeChecked();await expect(modal.getByRole('textbox',{name:'地址',exact:false})).toHaveValue('channel.example.test');await modal.getByRole('textbox',{name:'地址',exact:false}).fill('verified.example.test');await modal.getByRole('textbox',{name:'登录用户名',exact:false}).fill('deploy');await expect(modal.getByRole('textbox',{name:'主机身份指纹',exact:false})).toHaveCount(0);await modal.getByRole('button',{name:'保存主机',exact:true}).click();await expect(modal).toHaveCount(0);expect(test.state.requests.filter(request=>request.method==='PUT').at(-1).body).toEqual({name:'User selected host name',address:'verified.example.test',port:22,username:'deploy',connection_method:'direct_ssh'});expect(test.state.requests.filter(request=>request.method==='POST')).toHaveLength(0);mark('registered host editing keeps immutable asset identity, saves a chosen name alone, and requires explicit SSH connection details without performing remote work');
 }
 {
  const test=await harness({role:'member'});current=test.page;await test.page.goto(origin+'/machines?machine=host-linked&deployment=fixture-plan');await expect(test.row('host-linked')).toBeVisible();await expect(test.row('node:node-linked')).toHaveCount(0);await expect(test.row('host-linked')).not.toContainText('linked.example.test');await expect(test.page.getByRole('button',{name:'删除主机',exact:true})).toHaveCount(0);await expect(test.page.getByRole('button',{name:'移除节点',exact:true})).toHaveCount(0);await expect(test.page.getByRole('button',{name:'关联主机',exact:true})).toHaveCount(0);await test.page.getByRole('tab',{name:'监控任务',exact:true}).click();await expect(test.page.getByRole('button',{name:/新建任务/})).toBeDisabled();expect(test.state.requests.some(request=>request.path.startsWith('/api/v1/machines'))).toBe(false);expect(test.state.requests.some(request=>request.path.includes('credentials'))).toBe(false);mark('members retain real host IDs and task views while never requesting machine, credential, or lifecycle APIs, including hostile machine deep links');
 }
 {
  const test=await harness({language:'en-US',width:390});current=test.page;await test.page.goto(origin+'/machines');await expect(test.page.getByRole('heading',{name:'Hosts',exact:true})).toBeVisible();await expect(test.row('host-channel')).toBeVisible();await test.row('host-channel').getByRole('button',{name:'Remove node',exact:true}).click();await expect(test.page.getByRole('dialog',{name:'Remove node',exact:true})).toContainText('remote software stays installed');expect(await test.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await test.page.screenshot({path:resolve(media,'hosts-nodes-en-390.png'),fullPage:true,animations:'disabled'});mark('English unified list and removal confirmation fit a 390px viewport without page overflow');
 }
 current=page;await page.screenshot({path:resolve(media,'hosts-nodes-zh-1440.png'),fullPage:true,animations:'disabled'});
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);await writeFile(resolve(output,'hosts-nodes-ui-report.json'),JSON.stringify({production_bundle:true,api_fixtures:true,real_ssh:false,production_writes:false,checked,errors,unexpected},null,2)+'\n');
}catch(error){await current?.screenshot({path:resolve(media,'hosts-nodes-failure.png'),fullPage:true}).catch(()=>{});console.error({errors,unexpected});throw error}
finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDir,{recursive:true,force:true})}
