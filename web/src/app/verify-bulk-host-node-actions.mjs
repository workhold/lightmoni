import {chromium,expect} from '@playwright/test';
import {mkdtemp,cp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,extname} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// Use a copied production web bundle. Every request is intercepted, including
// static assets. No production platform, real SSH, secret, or host is touched.
const origin='http://127.0.0.1:19863';
const publicDir=await mkdtemp(resolve(tmpdir(),'lightmoni-bulk-host-node-ui-'));
await cp(resolve(import.meta.dirname,'../../../runtime/public'),publicDir,{recursive:true});
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'specs/035-bulk-host-node-actions');await mkdir(output,{recursive:true});
const media=mediaDirectory(output),checked=[],errors=[],unexpected=[],contexts=[];
const mark=value=>{checked.push(value);console.log('PASS '+value)};
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}

async function harness({role='admin',language='zh-CN',width=1440,keys='one',count=2}={}){
 const at=new Date().toISOString(),expires=new Date(Date.now()+900_000).toISOString(),available={available:true,reason:''};
 const base={port:22,username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:fixtureconfirmed',host_key_status:'confirmed',agent_status:'unknown',credential_count:1,active_credential_count:1,active_ssh_credential_count:1,active_ssh_key_count:1,ssh_recovery_available:true,capabilities:{terminal:available,ssh_check:available,deploy_agent:available,uninstall_agent:available},last_deployment_status:'',last_uninstallation_status:'',updated_at:at,created_at:at};
 const machines=Array.from({length:count},(_,index)=>({...base,id:'host-'+(index+1),name:'Fixture host '+(index+1),address:'host'+(index+1)+'.example.test',agent_id:index===1?'node-linked':'',agent_status:index===1?'online':'unknown',arch:index===1?'arm64':'amd64'}));
 const nodes=['linked','orphan'].map(suffix=>({id:'node-'+suffix,hostname:'Fixture '+suffix+' node',platform:'linux',arch:'amd64',version:'fixture',last_seen:at,lifecycle_state:'active',heartbeat:{config_revision:'fixture'},config:{revision:'fixture'},label_ids:suffix==='linked'?['fixture-label']:[],labels:[],tasks:[]}));
 const credentials=Object.fromEntries(machines.map(machine=>[machine.id,keys==='none'?[]:keys==='password'?[{id:machine.id+'-password',method:'password',secret_fingerprint:'fixture-password-metadata',retention:'one_time',expires_at:expires}]:Array.from({length:keys==='many'?2:1},(_,i)=>({id:machine.id+'-key-'+(i+1),method:'ssh_key',secret_fingerprint:'fixture-key-'+(i+1)+'-metadata',retention:'managed',expires_at:expires}))]));
 const state={machines,nodes,credentials,requests:[],plans:new Map(),checks:new Map(),checkFailures:new Set(),checkErrors:new Set(),planTransportError:new Set(),cancelFailures:new Set(),applyFailures:new Set(),applyUnknown:new Set(),applyTransportError:new Set(),readFailures:new Set(),removeFailures:new Set(),deleteFailures:new Set(),expiredPlans:false,holdPath:'',release:undefined};
 const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(language=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.nav.collapsed','true')},language);
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(url.href);return route.abort()}
  if(path.startsWith('/api/')){
   const body=request.postData()?request.postDataJSON():undefined;state.requests.push({path,query:url.search,method,body});
   if(path===state.holdPath)await new Promise(resolve=>state.release=resolve);
   if(path==='/api/v1/setup')return route.fulfill({json:{required:false}});
   if(path==='/api/v1/auth/providers')return route.fulfill({json:[]});
   if(path==='/api/v1/auth/me')return route.fulfill({json:{id:'fixture-user',name:'Fixture User',role}});
   if(path==='/api/v1/auth/profile')return route.fulfill({json:{}});
   if(path==='/api/v1/agents'&&method==='GET')return route.fulfill({json:state.nodes.filter(node=>url.searchParams.get('include_removed')==='true'||node.lifecycle_state!=='removed')});
   if(path==='/api/v1/agent-task-labels')return route.fulfill({json:[{id:'fixture-label',name:'Fixture selected label',node_count:1,task_count:0}]});
   if(['/api/v1/agent-tasks','/api/v1/catalog/tables','/api/v1/dashboards'].includes(path))return route.fulfill({json:[]});
   if(path==='/api/v1/machines'&&method==='GET')return route.fulfill({json:state.machines});
   const detail=path.match(/^\/api\/v1\/machines\/([^/]+)$/);
   if(detail){
    const host=state.machines.find(host=>host.id===detail[1]);
    if(!host)return route.fulfill({status:404,json:{error:'Fixture host not found'}});
    if(method==='GET')return route.fulfill({json:{machine:host,credentials:state.credentials[host.id],deployments:[...state.plans.values()].filter(plan=>plan.machine_id===host.id&&plan.kind==='deployments'),uninstallations:[...state.plans.values()].filter(plan=>plan.machine_id===host.id&&plan.kind==='uninstallations')}});
    if(method==='DELETE'){
     if(state.deleteFailures.has(host.id))return route.fulfill({status:409,json:{error:'Fixture active credentials prevent deletion'}});
     state.machines=state.machines.filter(item=>item!==host);return route.fulfill({json:{ok:true}});
    }
   }
   const check=path.match(/^\/api\/v1\/machines\/([^/]+)\/ssh-check$/);
   if(check&&method==='POST'){
    const host=state.machines.find(host=>host.id===check[1]);
    expect(body).toEqual({credential_id:expect.any(String)});
    if(state.checkErrors.has(host.id))return route.fulfill({status:502,json:{error:'Fixture SSH unavailable'}});
    const result={id:host.id+'-check',machine_id:host.id,credential_id:body.credential_id,connected:true,ready:!state.checkFailures.has(host.id),platform:'linux',arch:host.arch,checks:{linux:true,supported_arch:true,curl:true,tar:true,gzip:true,sha256sum:true,systemd:!state.checkFailures.has(host.id),install_privilege:true,platform_https:true},agent_installation:{state:host.agent_id?'present':'absent'},error_code:state.checkFailures.has(host.id)?'prerequisites_missing':'',checked_at:at,expires_at:expires};state.checks.set(result.id,result);
    return route.fulfill({json:result});
   }
   const operation=path.match(/^\/api\/v1\/machines\/([^/]+)\/(deployments|uninstallations)\/([^/]+)(?:\/(apply|cancel|reconcile))?$/);
   if(operation){
    const [,id,kind,planID,action]=operation,host=state.machines.find(host=>host.id===id);
    if(planID==='plan'&&method==='POST'){
     const preflight=state.checks.get(body.check_id),credential=state.credentials[id].find(item=>item.id===body.credential_id);
     expect(preflight.machine_id).toBe(id);expect(credential.method).toBe('ssh_key');
     if(kind==='deployments'){expect(body.arch).toBe(host.arch);expect(body.arch).not.toBe('auto')}
     const plan={id:id+'-'+kind,machine_id:id,kind,agent_id:host.agent_id,credential_id:credential.id,status:'awaiting_approval',created_at:at,version:body.version,arch:body.arch,plan:{machine:host,agent_id:host.agent_id,credential,preflight,check_id:body.check_id,version:body.version,arch:body.arch,expires_at:state.expiredPlans?'2000-01-01T00:00:00Z':expires,steps:kind==='deployments'?['确认主机公钥指纹','安装独立 systemd Agent','等待 Agent 激活回执']:['核对远端 Agent 身份','停止并禁用 Agent 服务','保留配置、身份与缓存'],retained_paths:['/etc/lightmoni-agent','/var/lib/lightmoni-agent'],removed_paths:['/opt/lightmoni-agent','/etc/systemd/system/lightmoni-agent.service'],warnings:['Fixture reviewed operation only']},review_url:`/machines?machine=${id}&${kind==='deployments'?'deployment':'uninstallation'}=${id+'-'+kind}`};
     state.plans.set(plan.id,plan);if(state.planTransportError.has(id))return route.fulfill({status:502,json:{error:'Fixture plan response interrupted'}});return route.fulfill({status:201,json:plan});
    }
    const plan=state.plans.get(planID);expect(plan).toBeTruthy();expect(plan.machine_id).toBe(id);
    if(method==='GET'){
     if(state.readFailures.has(id))return route.fulfill({status:503,json:{error:'Fixture saved record unavailable'}});
     return route.fulfill({json:plan});
    }
    if(action==='apply'&&method==='POST'){
     expect(body).toEqual({confirm:true});
     if(state.applyTransportError.has(id)){plan.status='unknown';return route.fulfill({status:502,json:{error:'Fixture transport interrupted'}})}
     plan.status=state.applyUnknown.has(id)?'unknown':state.applyFailures.has(id)?'failed':'succeeded';
     if(plan.status==='failed')plan.error='Fixture reviewed operation failed';
     if(plan.status==='succeeded')plan.receipt={agent_id:host.agent_id||id+'-agent',remote_removed:kind==='uninstallations',data_retained:true,credentials_revoked:kind==='uninstallations',activated:true,verified_at:at,stages:['remote_command_completed']};
     return route.fulfill({json:plan});
    }
    if(action==='cancel'&&method==='POST'){expect(body).toEqual({});if(state.cancelFailures.has(id))return route.fulfill({status:409,json:{error:'Fixture cancellation not confirmed'}});plan.status='cancelled';return route.fulfill({json:plan})}
    if(action==='reconcile'&&method==='POST'){expect(body).toEqual({});plan.status='succeeded';plan.receipt={agent_id:host.agent_id,remote_removed:true,data_retained:true,credentials_revoked:true,verified_at:at};return route.fulfill({json:plan})}
   }
   const remove=path.match(/^\/api\/v1\/agents\/([^/]+)\/remove$/);
   if(remove&&method==='POST'){
    expect(body.confirm).toBe(true);
    if(state.removeFailures.has(remove[1]))return route.fulfill({status:409,json:{error:'Fixture running task prevents removal'}});
    const node=state.nodes.find(node=>node.id===remove[1]);node.lifecycle_state='removed';node.removed_at=at;
    return route.fulfill({json:{agent_id:node.id,lifecycle_state:'removed',removed_at:at,credentials_revoked:true,remote_uninstalled:false}});
   }
   unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
  }
  const file=path.startsWith('/assets/')?resolve(publicDir,'.'+path):resolve(publicDir,'index.html');
  return route.fulfill({body:await readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]??'application/octet-stream'});
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 const row=id=>page.locator(`.ant-table-tbody tr[data-row-key="${id}"]`),requests=(ending,method='POST')=>state.requests.filter(request=>request.method===method&&request.path.endsWith(ending));
 const open=async()=>{await page.goto(origin+'/machines');await expect(role==='admin'?row('host-1'):row('node:node-orphan')).toBeVisible()};
 const select=async(...ids)=>{for(const id of ids)await row(id).getByRole('checkbox').check()};
 return {page,state,row,requests,open,select};
}

const actionLabels={ssh_check:'批量 SSH 安装检查',install:'批量部署 Agent',uninstall:'批量卸载 Agent',remove_node:'批量移除节点',delete_host:'批量删除主机'};
async function batch(test,action,ids){await test.select(...ids);await test.page.getByRole('region',{name:'批量操作',exact:true}).getByRole('button',{name:actionLabels[action],exact:true}).click();return test.page.getByRole('dialog').last()}
const target=(modal,id)=>modal.locator(`[data-batch-target="${id}"]`);
async function prepare(modal){await modal.getByRole('button',{name:'检查并生成批量计划',exact:true}).click();await expect(modal.getByRole('button',{name:'取消未执行计划并关闭',exact:true})).toBeVisible()}
async function approve(modal){await modal.getByRole('checkbox',{name:'我已逐项审阅目标、步骤和影响',exact:true}).check();await modal.getByRole('button',{name:'确认执行已审阅计划',exact:true}).click()}
async function close(modal){await modal.getByRole('button',{name:'关闭',exact:true}).click();await expect(modal).toHaveCount(0)}
async function waitStatus(modal,id,status){await expect(target(modal,id)).toHaveAttribute('data-batch-status',status==='succeeded'?'success':status)}
async function stableModal(modal){await expect.poll(()=>modal.evaluate(element=>{const style=getComputedStyle(element);return style.opacity==='1'&&style.transform==='none'})).toBe(true)}

// Scenarios exercise state transitions and network effects, rather than merely
// checking that the same labels used by the implementation exist.
let current;
try{
 {
  const t=await harness({count:12});current=t.page;await t.open();const toolbar=t.page.getByRole('region',{name:'批量操作',exact:true});
  await expect(t.row('host-1').getByRole('cell').first().getByRole('checkbox')).toBeVisible();await expect(toolbar.getByRole('button',{name:'批量部署 Agent',exact:true})).toBeDisabled();
  await t.select('host-1');await t.page.getByRole('listitem',{name:'2',exact:true}).click();await t.select('host-12');await expect(toolbar).toContainText('已选择 2 项');await t.page.getByRole('listitem',{name:'1',exact:true}).click();await expect(t.row('host-1').getByRole('checkbox')).toBeChecked();mark('leading administrator checkboxes preserve stable selected targets across pagination');
  await toolbar.getByRole('button',{name:'清除选择',exact:true}).click();await expect(toolbar).toContainText('已选择 0 项');await t.select('host-1');t.state.machines=t.state.machines.filter(host=>host.id!=='host-1');await t.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(t.row('host-1')).toHaveCount(0);await expect(toolbar).toContainText('已选择 0 项');mark('clear selection works and refreshed-away targets cannot remain in a hidden selection');
 }
 {
  const t=await harness();current=t.page;await t.open();await t.select('host-1','host-2');await t.page.getByRole('combobox',{name:'按任务标签筛选',exact:true}).click();await t.page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:'Fixture selected label'}).click();await expect(t.row('host-1')).toHaveCount(0);await expect(t.page.getByRole('region',{name:'批量操作',exact:true})).toContainText('已选择 1 项');await expect(t.row('host-2').getByRole('checkbox')).toBeChecked();mark('changing the task-label filter immediately prunes hidden targets while preserving visible selection');
 }
 {
  const t=await harness({count:51});current=t.page;await t.open();const toolbar=t.page.getByRole('region',{name:'批量操作',exact:true});for(let pageNo=1;pageNo<=5;pageNo++){if(pageNo>1)await t.page.getByRole('listitem',{name:String(pageNo),exact:true}).click();for(let i=(pageNo-1)*10+1;i<=pageNo*10;i++)await t.select('host-'+i)}await expect(toolbar).toContainText('已选择 50 项');await t.page.getByRole('listitem',{name:'6',exact:true}).click();await t.row('host-51').getByRole('checkbox').click();await expect(t.row('host-51').getByRole('checkbox')).not.toBeChecked();await expect(toolbar).toContainText('已选择 50 项');mark('cross-page selection enforces the 50-target limit without dropping existing selections');
 }
 {
  const t=await harness({role:'member'});current=t.page;await t.open();await expect(t.page.getByRole('region',{name:'批量操作',exact:true})).toHaveCount(0);await expect(t.row('node:node-orphan').getByRole('checkbox')).toHaveCount(0);expect(t.state.requests.some(request=>request.path.startsWith('/api/v1/machines'))).toBe(false);mark('members have no selection or bulk action controls and never request host credentials');
 }
 {
  const t=await harness();current=t.page;await t.page.goto(origin+'/machines?machine=host-1');await expect(t.page.getByRole('dialog',{name:'主机详情 · Fixture host 1',exact:true})).toBeVisible();expect(t.state.requests.filter(request=>request.method!=='GET')).toHaveLength(0);mark('host history links reopen the exact selected host details without initiating remote operations');
  await t.page.goto(origin+'/machines?machine=not-found');await expect(t.page.getByText('Fixture host not found',{exact:true})).toBeVisible();await expect(t.page.getByRole('dialog')).toHaveCount(0);mark('a stale host-history deep link reports a visible 404 and does not display another host');
 }
 {
  const t=await harness();current=t.page;await t.open();const modal=await batch(t,'ssh_check',['host-1','node:node-orphan']);await expect(target(modal,'node:node-orphan')).toContainText('不适用');await modal.getByRole('button',{name:'开始批量 SSH 检查',exact:true}).click();await waitStatus(modal,'host-1','succeeded');expect(t.requests('/ssh-check')).toHaveLength(1);expect(t.requests('/ssh-check')[0].path).toContain('/host-1/');await close(modal);mark('mixed host and independent-node selection displays inapplicable targets and only checks hosts');
 }
 {
  const t=await harness();t.state.holdPath='/api/v1/machines/host-1';current=t.page;await t.open();const modal=await batch(t,'ssh_check',['host-1','host-2']);await expect.poll(()=>!!t.state.release).toBe(true);await modal.getByRole('button',{name:'停止后续',exact:true}).click();t.state.holdPath='';t.state.release();await expect(target(modal,'host-2')).toContainText('已停止后续');expect(t.requests('/host-2','GET')).toHaveLength(0);await expect(modal.getByRole('button',{name:'开始批量 SSH 检查',exact:true})).toBeDisabled();expect(t.requests('/ssh-check')).toHaveLength(0);mark('stop during credential preparation waits for the current detail and prevents subsequent host or SSH requests');
 }
 {
  const t=await harness({keys:'many'});current=t.page;await t.open();const modal=await batch(t,'ssh_check',['host-1']);const credential=modal.getByRole('combobox',{name:'SSH 凭据 · Fixture host 1',exact:true});await expect(credential).toBeVisible();await expect(modal.getByRole('button',{name:'开始批量 SSH 检查',exact:true})).toBeDisabled();expect(t.requests('/ssh-check')).toHaveLength(0);await credential.click();await t.page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:'fixture-key-2-metadata'}).click();await modal.getByRole('button',{name:'开始批量 SSH 检查',exact:true}).click();await waitStatus(modal,'host-1','succeeded');expect(t.requests('/ssh-check')[0].body.credential_id).toBe('host-1-key-2');mark('multiple credentials require explicit per-host selection and transmit only the selected credential ID');
 }
 {
  const t=await harness({keys:'password'});current=t.page;await t.open();const modal=await batch(t,'ssh_check',['host-1']);await expect(modal).toContainText('一次性密码');await expect(modal).toContainText('消耗');await modal.getByRole('button',{name:'开始批量 SSH 检查',exact:true}).click();await waitStatus(modal,'host-1','succeeded');expect(t.requests('/ssh-check')[0].body).toEqual({credential_id:'host-1-password'});await close(modal);const install=await batch(t,'install',['host-1']);await expect(target(install,'host-1')).toContainText('不适用');expect(t.requests('/deployments/plan')).toHaveLength(0);mark('one-time password consumption is explained before SSH checks and passwords cannot create install plans');
 }
 {
  const t=await harness();t.state.checkFailures.add('host-1');current=t.page;await t.open();const modal=await batch(t,'ssh_check',['host-1','host-2']);await modal.getByRole('button',{name:'开始批量 SSH 检查',exact:true}).click();await waitStatus(modal,'host-1','failed');await waitStatus(modal,'host-2','succeeded');expect(t.requests('/ssh-check')).toHaveLength(2);await expect(target(modal,'host-1')).toContainText('安装检查未通过');mark('HTTP 200 with ready=false is a failure and processing continues to the next host');
 }
 {
  const t=await harness();t.state.machines[1].agent_id='';current=t.page;await t.open();const modal=await batch(t,'install',['host-1','host-2']);await prepare(modal);expect(t.requests('/deployments/plan').map(request=>request.body.arch)).toEqual(['amd64','arm64']);expect(t.requests('/apply')).toHaveLength(0);await expect(modal).toContainText('systemd');await expect(modal).toContainText('host1.example.test');await expect(modal).toContainText('host2.example.test');await expect(modal.getByRole('button',{name:'确认执行已审阅计划',exact:true})).toBeDisabled();mark('per-host checks create amd64 and arm64 saved plans without executing and expose reviewed host, steps, and expiry');await approve(modal);await waitStatus(modal,'host-1','succeeded');await waitStatus(modal,'host-2','succeeded');expect(t.requests('/apply')).toHaveLength(2);mark('review confirmation executes each saved install plan once, using its own detected architecture');
 }
 {
  const t=await harness();t.state.machines[1].agent_id='';t.state.expiredPlans=true;current=t.page;await t.open();const modal=await batch(t,'install',['host-1']);await prepare(modal);await expect(modal).toContainText('计划已过期');await expect(modal.getByRole('button',{name:'确认执行已审阅计划',exact:true})).toHaveCount(0);expect(t.requests('/apply')).toHaveLength(0);await modal.getByRole('button',{name:'取消未执行计划并关闭',exact:true}).click();await expect(modal).toHaveCount(0);expect(t.requests('/cancel')).toHaveLength(1);mark('expired saved plans cannot execute and closing explicitly cancels the unexecuted plan');
 }
 {
  const t=await harness();t.state.planTransportError.add('host-1');current=t.page;await t.open();const modal=await batch(t,'install',['host-1']);await prepare(modal);await expect(modal).toContainText('已从持久化历史恢复计划');expect(t.requests('/deployments/plan')).toHaveLength(1);expect(t.requests('/host-1','GET')).toHaveLength(2);expect(t.requests('/apply')).toHaveLength(0);await approve(modal);await waitStatus(modal,'host-1','succeeded');expect(t.requests('/deployments/plan')).toHaveLength(1);expect(t.requests('/apply')).toHaveLength(1);mark('a lost creation response recovers the same saved plan by check and credential identity instead of creating it again');
 }
 {
  const t=await harness();t.state.cancelFailures.add('host-1');current=t.page;await t.open();const modal=await batch(t,'install',['host-1']);await prepare(modal);await modal.getByRole('button',{name:'取消未执行计划并关闭',exact:true}).click();await expect(modal).toBeVisible();await expect(modal).toContainText('Fixture cancellation not confirmed');expect(t.requests('/cancel')).toHaveLength(1);expect(t.state.plans.get('host-1-deployments').status).toBe('awaiting_approval');t.state.cancelFailures.clear();await modal.getByRole('button',{name:'取消未执行计划并关闭',exact:true}).click();await expect(modal).toHaveCount(0);expect(t.requests('/apply')).toHaveLength(0);mark('failed cancellation retains the saved pending plan visibly and prevents closing until cancellation is confirmed');
 }
 {
  const t=await harness();t.state.machines[1].agent_id='';t.state.applyFailures.add('host-1');current=t.page;await t.open();const modal=await batch(t,'install',['host-1','host-2']);await prepare(modal);await approve(modal);await waitStatus(modal,'host-1','failed');await waitStatus(modal,'host-2','succeeded');expect(t.requests('/apply')).toHaveLength(2);mark('an individual reviewed installation failure remains visible and does not prevent later targets');
 }
 {
  const t=await harness();t.state.machines[1].agent_id='';current=t.page;await t.open();const modal=await batch(t,'install',['host-1','host-2']);await prepare(modal);t.state.holdPath='/api/v1/machines/host-1/deployments/host-1-deployments/apply';await modal.getByRole('checkbox',{name:'我已逐项审阅目标、步骤和影响',exact:true}).check();await modal.getByRole('button',{name:'确认执行已审阅计划',exact:true}).evaluate(button=>{button.click();button.click()});await expect.poll(()=>!!t.state.release).toBe(true);expect(t.requests('/apply')).toHaveLength(1);await modal.getByRole('button',{name:'停止后续',exact:true}).click();t.state.release();await waitStatus(modal,'host-1','succeeded');expect(t.requests('/apply')).toHaveLength(1);await modal.getByRole('button',{name:'取消未执行计划并关闭',exact:true}).click();await expect(modal).toHaveCount(0);expect(t.requests('/cancel')).toHaveLength(1);expect(t.requests('/cancel')[0].path).toContain('host-2-deployments');mark('synchronous repeated confirmation sends one request; stop waits for the active host and cancels only the later unexecuted plan');
 }
 {
  const t=await harness();t.state.applyTransportError.add('host-2');current=t.page;await t.open();const modal=await batch(t,'uninstall',['host-2','node:node-orphan']);await expect(target(modal,'node:node-orphan')).toContainText('不适用');await prepare(modal);await expect(modal).toContainText('/var/lib/lightmoni-agent');await approve(modal);await waitStatus(modal,'host-2','unknown');expect(t.requests('/apply')).toHaveLength(1);expect(t.requests('/host-2-uninstallations','GET')).toHaveLength(1);await expect(target(modal,'host-2')).toContainText('核对');mark('uninstall transport interruption reads the same saved plan and exposes unknown outcome without retrying apply');
 }
 {
  const t=await harness();current=t.page;await t.open();const modal=await batch(t,'remove_node',['host-1','host-2','node:node-orphan']);await expect(target(modal,'host-1')).toContainText('不适用');await expect(modal).toContainText('不会卸载');expect(t.requests('/remove')).toHaveLength(0);await expect(modal.getByRole('button',{name:'确认批量移除节点',exact:true})).toBeDisabled();await modal.getByRole('checkbox',{name:'我已逐项审阅目标、步骤和影响',exact:true}).check();await modal.getByRole('button',{name:'确认批量移除节点',exact:true}).click();await waitStatus(modal,'host-2','succeeded');await waitStatus(modal,'node:node-orphan','succeeded');expect(t.requests('/remove')).toHaveLength(2);expect(t.requests('/remove').map(request=>request.path.split('/').at(-2)).sort()).toEqual(['node-linked','node-orphan']);expect(t.requests('/apply')).toHaveLength(0);mark('batch node removal confirms identity revocation separately, skips bare hosts, and never invokes remote uninstall');
 }
 {
  const t=await harness({keys:'none'});t.state.deleteFailures.add('host-1');current=t.page;await t.open();const modal=await batch(t,'delete_host',['host-1','host-2','node:node-orphan']);await expect(modal).toContainText('不会卸载');await expect(target(modal,'node:node-orphan')).toContainText('不适用');expect(t.state.requests.filter(request=>request.method==='DELETE')).toHaveLength(0);await expect(modal.getByRole('button',{name:'确认批量删除主机',exact:true})).toBeDisabled();await modal.getByRole('checkbox',{name:'我已逐项审阅目标、步骤和影响',exact:true}).check();await modal.getByRole('button',{name:'确认批量删除主机',exact:true}).click();await waitStatus(modal,'host-1','failed');await waitStatus(modal,'host-2','succeeded');expect(t.state.requests.filter(request=>request.method==='DELETE')).toHaveLength(2);expect(t.requests('/remove')).toHaveLength(0);mark('batch host deletion has separate irreversible confirmation, preserves per-host conflicts, and never removes a node identity');
 }
 {
  const t=await harness({keys:'none',width:390});current=t.page;await t.open();const modal=await batch(t,'install',['host-1','node:node-orphan']);await expect(target(modal,'host-1')).toContainText('不适用');await expect(modal.getByRole('button',{name:'检查并生成批量计划',exact:true})).toBeDisabled();expect(await t.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await stableModal(modal);await t.page.screenshot({path:resolve(media,'bulk-host-node-zh-390.png'),fullPage:true,animations:'disabled'});mark('Chinese 390px selection and inapplicable-target dialog fit the viewport and cannot submit missing credentials');
 }
 {
  const t=await harness({language:'en-US',width:390});current=t.page;await t.open();await t.select('host-1','node:node-orphan');const toolbar=t.page.getByRole('region',{name:'Bulk actions',exact:true});await expect(toolbar).toContainText('Selected 2');await toolbar.getByRole('button',{name:'Bulk SSH preflight',exact:true}).click();const modal=t.page.getByRole('dialog');await expect(modal).toContainText('Fixture host 1');await expect(modal).toContainText('Not applicable');expect(await t.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await stableModal(modal);await t.page.screenshot({path:resolve(media,'bulk-host-node-en-390.png'),fullPage:true,animations:'disabled'});mark('English bulk labels, per-target reason, and 390px dialog remain usable without page overflow');
 }
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 await writeFile(resolve(output,'bulk-host-node-ui-report.json'),JSON.stringify({scope:'Copied production web bundle with all HTTP intercepted.',production_bundle:true,api_fixtures:true,real_ssh:false,production_writes:false,checked,errors,unexpected},null,2)+'\n');
 await rm(resolve(media,'bulk-host-node-failure.png'),{force:true});
}catch(error){await current?.screenshot({path:resolve(media,'bulk-host-node-failure.png'),fullPage:true}).catch(()=>{});console.error({errors,unexpected});throw error}
finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDir,{recursive:true,force:true})}
