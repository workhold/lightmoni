import {chromium,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {extname,resolve} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// A real production UI with deterministic HTTP/WebSocket fixtures. No host,
// credentials, Agent, SSH server, or external network is contacted.
const origin='http://127.0.0.1:19881',publicDir=await mkdtemp(resolve(tmpdir(),'lightmoni-identity-ui-'));
await cp(resolve(import.meta.dirname,'../../../runtime/public'),publicDir,{recursive:true});
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'specs/051-ssh-host-network-discovery/evidence/identity-ui');await mkdir(output,{recursive:true});
const media=mediaDirectory(output),checked=[],errors=[],unexpected=[],contexts=[];
const index=await readFile(resolve(publicDir,'index.html')),entry=String(index).match(/src="([^"]+\.js)"/u)?.[1];
const bundle={index_sha256:createHash('sha256').update(index).digest('hex'),entry,entry_sha256:entry?createHash('sha256').update(await readFile(resolve(publicDir,'.'+entry))).digest('hex'):''};
const mark=value=>{checked.push(value);console.log('PASS '+value)};
let browser,current;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
async function harness(){
 const observed='2026-10-31T01:02:03.000Z',expires='2099-01-01T00:00:00.000Z',available={available:true,reason:''};
 const hosts=['a','b'].map(id=>({id,name:'User host '+id.toUpperCase(),address:id==='a'?'2001:db8::1':'ssh-b.example.test',port:2222,username:'deploy',connection_method:'direct_ssh',agent_id:'',agent_status:'unknown',default_credential_id:'key-'+id,capabilities:{terminal:available,ssh_check:available,deploy_agent:available,uninstall_agent:available},credential_count:1,active_credential_count:1,active_ssh_credential_count:1,active_ssh_key_count:1,active_reusable_ssh_credential_count:1,ssh_recovery_available:true,host_key_fingerprint:'SHA256:fixture-host-'+id,host_key_status:'observed',label_ids:[],labels:[],created_at:observed,updated_at:observed,network:{hostname:'system-'+id,addresses:[],private_ips:[],public_ips:[],observed_at:observed,observed_via:'ssh',source_ip:'',source_observed_at:'',source_kind:'unavailable'}}));
 const credentials=id=>[{id:'key-'+id,name:'Credential '+id.toUpperCase(),method:'ssh_key',retention:'managed',expires_at:expires,secret_fingerprint:'SHA256:fixture-key-'+id}];
 const state={hosts,requests:[],holds:[],plans:[],emptyCredentials:false,role:'admin'};
 const detail=id=>({machine:hosts.find(host=>host.id===id),credentials:state.emptyCredentials?[]:credentials(id),deployments:state.plans.filter(plan=>plan.machine_id===id),uninstallations:[]});
 const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai',reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(()=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.nav.collapsed','true')});
 await context.routeWebSocket('**/terminal-ws/**',ws=>{ws.send(JSON.stringify({type:'status',status:'connected'}));ws.onMessage(()=>{})});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(method+' '+url.href);return route.abort()}
  if(path.startsWith('/api/')){
   const body=request.postData()?request.postDataJSON():undefined;state.requests.push({path,method,body});
   const fixture={'/api/v1/setup':{required:false},'/api/v1/auth/providers':[],'/api/v1/auth/me':{id:'identity-admin',name:'Fixture Admin',role:state.role},'/api/v1/auth/profile':{},'/api/v1/catalog/tables':[],'/api/v1/dashboards':[],'/api/v1/connection-credentials':[],'/api/v1/host-labels':[],'/api/v1/agents':[],'/api/v1/machines':state.hosts,'/api/v1/task-hosts':state.hosts};
   let response;
   const match=path.match(/^\/api\/v1\/machines\/([ab])(?:\/(.*))?$/u),id=match?.[1],suffix=match?.[2];
   if(method==='GET'&&Object.hasOwn(fixture,path))response=fixture[path];
   else if(id&&method==='GET'&&!suffix)response=detail(id);
   else if(id&&method==='GET'&&['tasks','agent-updates'].includes(suffix))response=[];
   else if(id&&method==='PUT'&&!suffix){Object.assign(hosts.find(host=>host.id===id),body);response=hosts.find(host=>host.id===id)}
   else if(id&&method==='DELETE'&&!suffix){state.hosts=state.hosts.filter(host=>host.id!==id);response={deleted:true}}
   else if(id&&method==='POST'&&suffix==='terminal-sessions')response={id:'session-'+id,websocket_path:'/terminal-ws/'+id};
   else if(id&&method==='DELETE'&&suffix?.startsWith('terminal-sessions/'))response={closed:true};
   else if(id&&method==='POST'&&suffix==='ssh-check')response={id:'check-'+id,machine_id:id,credential_id:body.credential_id,connected:true,ready:true,platform:'linux',arch:'arm64',checks:{linux:true},error_code:'',checked_at:observed,expires_at:expires,agent_installation:{state:'absent'}};
   else if(id&&method==='POST'&&suffix==='deployments/plan')response={id:'plan-'+id,machine_id:id,credential_id:body.credential_id,status:'awaiting_approval',version:body.version,arch:body.arch,created_at:observed,plan:{machine:hosts.find(host=>host.id===id),expires_at:expires,version:body.version,arch:body.arch,steps:['自动校验主机公钥']}};
   else if(id&&method==='POST'&&suffix==='deployments/plan-'+id+'/apply')response={id:'plan-'+id,status:'succeeded'};
   else{unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}})}
   if(method==='POST'&&suffix==='deployments/plan')state.plans.push(response);
   if(method==='POST'&&suffix?.endsWith('/apply'))Object.assign(state.plans.find(plan=>plan.machine_id===id),response);
   response=structuredClone(response);
   const held=state.holds.find(item=>!item.started&&item.path===path&&item.method===method);
   if(held){held.started=true;held.ready();await held.promise;held.completed=true}
   try{return await route.fulfill({json:response})}catch(error){if(!request.isNavigationRequest()&&!String(error).includes('Target page, context or browser has been closed'))throw error}
   return;
  }
  const file=path.startsWith('/assets/')?resolve(publicDir,'.'+path):resolve(publicDir,'index.html');
  return route.fulfill({body:await readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]??'application/octet-stream'});
 });
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
 const hold=(id,suffix='',method='GET')=>{let release,ready;const item={path:'/api/v1/machines/'+id+(suffix?'/'+suffix:''),method,started:false,completed:false,promise:new Promise(resolve=>{release=resolve}),waiting:new Promise(resolve=>{ready=resolve})};item.release=release;item.ready=ready;state.holds.push(item);return item};
 const row=id=>page.locator('tr[data-row-key="'+id+'"]');
 return {page,state,row,hold,detail};
}
const close=async page=>{await page.getByRole('dialog').locator('.ant-modal-close').click();await expect(page.getByRole('dialog')).toHaveCount(0)};
const flush=async page=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))};
try{
 let h=await harness();current=h.page;await h.page.goto(origin+'/machines');await expect(h.row('a')).toContainText('[2001:db8::1]:2222');await expect(h.row('a')).toContainText('系统主机名：system-a');mark('user-defined host names and observed system hostnames remain distinct; IPv6 ports are bracketed');
 let held=h.hold('a');await h.row('a').getByRole('button',{name:'登录终端',exact:true}).click();await held.waiting;await h.row('b').getByRole('button',{name:'登录终端',exact:true}).click();await expect(h.page.getByRole('dialog')).toContainText('SSH 终端 · User host B');await expect(h.page.getByRole('status')).toContainText('已连接');held.release();await expect.poll(()=>held.completed).toBe(true);await flush(h.page);await expect(h.page.getByRole('dialog')).toContainText('SSH 终端 · User host B');expect(h.state.requests.filter(item=>item.method==='POST'&&item.path.endsWith('/terminal-sessions')).map(item=>item.path)).toEqual(['/api/v1/machines/b/terminal-sessions']);await close(h.page);mark('late host A response never replaces or auto-connects over the last selected host B terminal');
 held=h.hold('a');await h.row('a').getByRole('button',{name:/详\s*情/,exact:true}).click();await held.waiting;await h.row('b').getByRole('button',{name:/详\s*情/,exact:true}).click();await expect(h.page.getByRole('dialog')).toContainText('主机详情 · User host B');await close(h.page);held.release();await expect.poll(()=>held.completed).toBe(true);await flush(h.page);await expect(h.page.getByRole('dialog')).toHaveCount(0);mark('closing B details invalidates an earlier pending A response instead of reopening A');
 for(const [button,title] of [['SSH 安装检查','SSH 安装检查 · User host B'],['卸载 Agent','卸载 LightMoni Agent · User host B']]){
  held=h.hold('a');await h.row('a').getByRole('button',{name:button,exact:true}).click();await held.waiting;await h.row('b').getByRole('button',{name:button,exact:true}).click();await expect(h.page.getByRole('dialog')).toContainText(title);held.release();await expect.poll(()=>held.completed).toBe(true);await flush(h.page);await expect(h.page.getByRole('dialog')).toContainText(title);await close(h.page);mark(button+': a late A response cannot change the selected B target');
 }
 held=h.hold('a');await h.row('a').getByRole('button',{name:'部署 Agent',exact:true}).click();await held.waiting;await close(h.page);await h.row('b').getByRole('button',{name:'部署 Agent',exact:true}).click();await expect(h.page.getByRole('dialog')).toContainText('Credential B');held.release();await expect.poll(()=>held.completed).toBe(true);await flush(h.page);await expect(h.page.getByRole('dialog')).toContainText('Credential B');await expect(h.page.getByRole('dialog')).not.toContainText('Credential A');await h.page.getByRole('dialog').getByRole('button',{name:'检查并生成部署计划',exact:true}).click();await expect(h.page.getByRole('dialog')).toContainText('请审阅固定部署步骤后确认');expect(h.state.requests.filter(item=>item.method==='POST'&&item.path.endsWith('/ssh-check')).at(-1)).toMatchObject({path:'/api/v1/machines/b/ssh-check',body:{credential_id:'key-b'}});expect(h.state.requests.filter(item=>item.path.endsWith('/apply'))).toHaveLength(0);mark('closing A and opening B never mixes credentials; plan stays bound to B and waits for explicit approval');
 held=h.hold('b');await h.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await held.waiting;await h.page.getByRole('dialog').getByRole('button',{name:'我已审阅，确认执行 SSH 部署',exact:true}).click();await expect(h.page.getByRole('dialog')).toContainText('Agent 已部署并收到激活回执');held.release();await expect.poll(()=>held.completed).toBe(true);await flush(h.page);await expect(h.page.getByRole('dialog')).toContainText('Agent 已部署并收到激活回执');await expect(h.page.getByRole('dialog').getByRole('button',{name:'我已审阅，确认执行 SSH 部署',exact:true})).toHaveCount(0);await close(h.page);mark('a stale refresh cannot roll a completed deployment back to awaiting approval or offer another apply');
 // A stale same-host refresh must not roll back a later successful rename.
 await h.row('b').getByRole('button',{name:/详\s*情/,exact:true}).click();await expect(h.page.getByRole('dialog')).toContainText('主机详情 · User host B');held=h.hold('b');await h.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await held.waiting;await close(h.page);await h.row('b').getByRole('button',{name:'编辑主机',exact:true}).click();await h.page.getByRole('dialog').getByRole('textbox',{name:'主机名称（用户自定义）',exact:false}).fill('Renamed host B');await h.page.getByRole('dialog').getByRole('button',{name:'保存主机',exact:true}).click();await expect(h.page.getByRole('dialog')).toHaveCount(0);await h.row('b').getByRole('button',{name:/详\s*情/,exact:true}).click();await expect(h.page.getByRole('dialog')).toContainText('主机详情 · Renamed host B');held.release();await expect.poll(()=>held.completed).toBe(true);await flush(h.page);await expect(h.page.getByRole('dialog')).toContainText('主机详情 · Renamed host B');await close(h.page);mark('late refresh snapshots cannot overwrite later host edits or a newly opened details selection');
 // Deletion through the regular reviewed batch UI invalidates pending host requests.
 h=await harness();current=h.page;await h.page.goto(origin+'/machines');held=h.hold('a');await h.row('a').getByRole('button',{name:/详\s*情/,exact:true}).click();await held.waiting;h.state.emptyCredentials=true;await h.row('a').getByRole('checkbox').check();await h.page.getByRole('button',{name:'删除主机',exact:true}).click();let dialog=h.page.getByRole('dialog');await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'确认删除主机',exact:true}).click();await expect(dialog).toContainText('成功');await dialog.locator('.ant-modal-footer').getByRole('button',{name:/关\s*闭/,exact:true}).click();await expect(h.row('a')).toHaveCount(0);held.release();await expect.poll(()=>held.completed).toBe(true);await flush(h.page);await expect(h.row('a')).toHaveCount(0);await expect(h.page.getByRole('dialog')).toHaveCount(0);mark('reviewed host deletion prevents stale detail responses from resurrecting the host or its dialog');
 // Deep-link loading and manual selections share the same operation guard.
 h=await harness();current=h.page;held=h.hold('a');await h.page.goto(origin+'/machines?machine=a');await held.waiting;await h.row('b').getByRole('button',{name:/详\s*情/,exact:true}).click();await expect(h.page.getByRole('dialog')).toContainText('主机详情 · User host B');held.release();await expect.poll(()=>held.completed).toBe(true);await flush(h.page);await expect(h.page.getByRole('dialog')).toContainText('主机详情 · User host B');await close(h.page);mark('late deep-link details cannot supersede a newer manual host selection');
 await h.row('a').getByRole('button',{name:/详\s*情/,exact:true}).click();dialog=h.page.getByRole('dialog');await expect(dialog).toContainText('deploy@[2001:db8::1]:2222');await expect(dialog).toContainText('主机名称（用户自定义）');await expect(dialog).toContainText('系统主机名');await expect(dialog).not.toHaveClass(/ant-zoom/);await dialog.screenshot({path:resolve(media,'identity-details-zh-1440.png'),animations:'disabled'});await close(h.page);await h.row('a').getByRole('button',{name:'编辑主机',exact:true}).click();dialog=h.page.getByRole('dialog');await expect(dialog.getByRole('textbox',{name:'主机名称（用户自定义）',exact:false})).toHaveValue('User host A');await expect(dialog.getByRole('textbox',{name:'SSH 连接地址',exact:false})).toHaveValue('2001:db8::1');await expect(dialog).toContainText('系统主机名');await expect(dialog).not.toHaveClass(/ant-zoom/);await dialog.screenshot({path:resolve(media,'identity-edit-zh-1440.png'),animations:'disabled'});await close(h.page);mark('detail and editing explicitly distinguish asset name, immutable ID, system hostname and SSH endpoint');
 // Browser Back can unmount a busy host view; its completed check must not
 // continue by creating a deployment plan from a page the user has left.
 h=await harness();current=h.page;await h.page.goto(origin+'/connection-credentials');await h.page.getByRole('link',{name:'主机',exact:true}).click();await h.row('b').getByRole('button',{name:'部署 Agent',exact:true}).click();await expect(h.page.getByRole('dialog')).toContainText('Credential B');held=h.hold('b','ssh-check','POST');await h.page.getByRole('dialog').getByRole('button',{name:'检查并生成部署计划',exact:true}).click();await held.waiting;await h.page.goBack();await expect(h.page).toHaveURL(origin+'/connection-credentials');held.release();await expect.poll(()=>held.completed).toBe(true);await flush(h.page);expect(h.state.requests.filter(item=>item.path.endsWith('/deployments/plan'))).toHaveLength(0);await expect(h.page.getByRole('dialog')).toHaveCount(0);mark('leaving a busy host view invalidates its check before it can create a deployment plan');
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);mark('all HTTP and terminal WebSocket traffic stays inside isolated fixtures with zero page errors');
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({production_bundle:true,bundle,fixture_only:true,production_writes:false,ssh_connections:false,installations:false,passed:checked.length,checked,errors,unexpected},null,2)+'\n');
}catch(error){if(current)await current.screenshot({path:resolve(media,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(output,'ui-report.json'),JSON.stringify({bundle,checked,failed:String(error),errors,unexpected},null,2)+'\n');throw error}
finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDir,{recursive:true,force:true})}
