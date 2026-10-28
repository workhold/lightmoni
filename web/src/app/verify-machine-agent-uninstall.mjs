import {chromium,expect} from '@playwright/test';
import {mkdtemp,cp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,extname} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// Exercise the real production bundle, with every HTTP request intercepted.
// No live host, SSH session, secret, model, or Agent is accessed.
const origin='http://127.0.0.1:19853';
const publicDir=await mkdtemp(resolve(tmpdir(),'lightmoni-uninstall-ui-'));
await cp(resolve(import.meta.dirname,'../../../runtime/public'),publicDir,{recursive:true});
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??await mkdtemp(resolve(tmpdir(),'lightmoni-uninstall-evidence-')));await mkdir(output,{recursive:true});
const media=mediaDirectory(output),checked=[],errors=[],unexpected=[],contexts=[];
const mark=value=>{checked.push(value);console.log('PASS '+value)};
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
async function harness({language='zh-CN',role='admin',reason='',agentPresent=true}={}){
 const at=new Date().toISOString(),expires=new Date(Date.now()+900_000).toISOString();
 const capability={available:!reason,reason};
 const machine={id:'fixture-host',name:'Fixture host',address:'host.example.com',port:22,username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:fixtureconfirmed',host_key_status:'confirmed',agent_id:'fixture-agent',agent_status:'online',active_credential_count:1,active_ssh_credential_count:1,active_ssh_key_count:1,credential_count:1,ssh_recovery_available:true,capabilities:{terminal:{available:true,reason:''},ssh_check:{available:true,reason:''},deploy_agent:{available:true,reason:''},uninstall_agent:capability},updated_at:at,created_at:at};
 const credential={id:'fixture-key',method:'ssh_key',retention:'temporary',secret_fingerprint:'metadata-only',expires_at:expires};
 const result={id:'fixture-check',machine_id:machine.id,credential_id:credential.id,connected:true,ready:true,platform:'linux',arch:'amd64',checks:{linux:true,supported_arch:true,curl:true,tar:true,gzip:true,sha256sum:true,systemd:true,install_privilege:true,platform_https:true},agent_installation:{state:agentPresent?'present':'absent'},error_code:'',checked_at:at,expires_at:expires};
 const saved={id:'fixture-uninstall',machine_id:machine.id,agent_id:machine.agent_id,credential_id:credential.id,status:'awaiting_approval',created_at:at,plan:{machine,agent_id:machine.agent_id,credential,check_id:result.id,expires_at:expires,steps:['核对远端 Agent 身份','停止并禁用 Agent 服务','确认服务停止后移除 Agent 程序','保留配置、身份与缓存','核验移除结果并撤销节点凭据'],retained_paths:['/etc/lightmoni-agent','/var/lib/lightmoni-agent'],removed_paths:['/opt/lightmoni-agent','/etc/systemd/system/lightmoni-agent.service'],warnings:['采集和节点任务将停止；业务服务、制品、容器和卷保持不变。','默认保留配置和缓存，但旧节点凭据将撤销，重装需重新接入。','SSH 中断可能产生未知结果，请使用核对功能，不要盲目重试。']},review_url:'/machines?machine=fixture-host&uninstallation=fixture-uninstall'};
 const state={machine,credential,result,record:saved,records:[],requests:[],applyUnknown:false,reconcileFailed:false,applyError:false,readFails:false,checkReady:true};
 const context=await browser.newContext({viewport:{width:1365,height:1000},reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(language=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.nav.collapsed','true')},language);
 const fixtures={'/api/v1/setup':{required:false},'/api/v1/auth/providers':[],'/api/v1/auth/me':{id:'fixture-admin',name:'Fixture Admin',role},'/api/v1/auth/profile':{},'/api/v1/catalog/tables':[],'/api/v1/dashboards':[]};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(url.href);return route.abort()}
  if(path.startsWith('/api/')){
   const body=request.postData()?request.postDataJSON():undefined;state.requests.push({method,path,body});
   if(path==='/api/v1/machines'&&method==='GET')return route.fulfill({json:[machine]});
   if(path==='/api/v1/machines/'+machine.id&&method==='GET')return route.fulfill({json:{machine,credentials:[credential],deployments:[],uninstallations:state.records}});
   if(path.endsWith('/ssh-check')&&method==='POST')return route.fulfill({json:state.result});
   if(path.endsWith('/uninstallations/plan')&&method==='POST'){
    expect(body).toEqual({check_id:'fixture-check',credential_id:'fixture-key'});state.records=[state.record];return route.fulfill({json:state.record,status:201});
   }
   if(path.endsWith('/uninstallations/fixture-uninstall')&&method==='GET'){
    if(state.readFails)return route.fulfill({status:503,json:{error:'Fixture refresh unavailable'}});
    return route.fulfill({json:state.record});
   }
   if(path.endsWith('/uninstallations/fixture-uninstall/cancel')&&method==='POST'){
    expect(body).toEqual({});state.record={...state.record,status:'cancelled'};state.records=[state.record];return route.fulfill({json:state.record});
   }
   if(path.endsWith('/uninstallations/fixture-uninstall/apply')&&method==='POST'){
    expect(body).toEqual({confirm:true});
    if(state.applyError)return route.fulfill({status:502,json:{error:'Fixture transport interrupted'}});
    state.record={...state.record,status:state.applyUnknown?'unknown':'succeeded',...(state.applyUnknown?{}:{receipt:{agent_id:'fixture-agent',remote_removed:true,data_retained:true,credentials_revoked:true,revoked_credentials:2,verified_at:at,stages:['remote_removed','credentials_revoked']}})};state.records=[state.record];return route.fulfill({json:state.record});
   }
   if(path.endsWith('/uninstallations/fixture-uninstall/reconcile')&&method==='POST'){
    expect(body).toEqual({});state.record=state.reconcileFailed?{...state.record,status:'failed',error:'核对确认 Agent 程序完整，卸载未完成；请重新审阅计划',receipt:{agent_id:'fixture-agent',remote_removed:false,credentials_revoked:false,service_stopped:true,remote_unchanged:true,verified_at:at}}:{...state.record,status:'succeeded',receipt:{agent_id:'fixture-agent',remote_removed:true,data_retained:true,credentials_revoked:true,revoked_credentials:2,verified_at:at}};state.records=[state.record];return route.fulfill({json:state.record});
   }
   if(method==='GET'&&Object.hasOwn(fixtures,path))return route.fulfill({json:fixtures[path]});
   unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
  }
  const file=path.startsWith('/assets/')?resolve(publicDir,'.'+path):resolve(publicDir,'index.html');
  return route.fulfill({body:await readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]??'application/octet-stream'});
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return{page,state};
}
const requestCount=(state,ending)=>state.requests.filter(r=>r.method==='POST'&&r.path.endsWith(ending)).length;
async function preview(page){await page.getByRole('button',{name:'卸载 Agent',exact:true}).click();await page.getByRole('button',{name:'核对身份并生成卸载计划',exact:true}).click();await expect(page.getByText('fixture-uninstall',{exact:true})).toBeVisible()}
async function confirm(page){await page.getByRole('button',{name:'我已审阅，卸载 Agent',exact:true}).click();await page.getByRole('button',{name:'确认卸载',exact:true}).click()}
let current;
try{
 const success=await harness();current=success.page;await current.goto(origin+'/machines');await preview(current);
 await expect(current.getByText('fixture-agent',{exact:true})).toBeVisible();await expect(current.getByText('/var/lib/lightmoni-agent',{exact:true})).toBeVisible();
 await expect(current.getByText(/重装须先人工核查保留的旧身份/)).toBeVisible();expect(requestCount(success.state,'/apply')).toBe(0);mark('Identity check creates a saved uninstall plan without applying; retained data and enrollment warning are visible');
 await current.getByRole('button',{name:'我已审阅，卸载 Agent',exact:true}).click();expect(requestCount(success.state,'/apply')).toBe(0);await current.getByRole('button',{name:'返回审阅',exact:true}).click();mark('The destructive action requires a separate administrator confirmation');
 await confirm(current);await expect(current.getByText('卸载完成',{exact:true})).toBeVisible();await expect(current.getByText('已确认移除',{exact:true})).toBeVisible();await expect(current.getByText('已撤销（2 条）',{exact:true})).toBeVisible();await expect(current.getByText('已保留',{exact:true})).toBeVisible();expect(requestCount(success.state,'/apply')).toBe(1);mark('Successful receipt separately confirms remote removal, data retention, and credential revocation');
 await current.locator('.ant-modal:visible').screenshot({path:resolve(media,'uninstall-success.png'),animations:'disabled'});
 await current.locator('.ant-modal:visible .ant-modal-close').click();await current.getByRole('button',{name:/详\s*情/}).click();await expect(current.getByText('卸载历史',{exact:true})).toBeVisible();await current.getByRole('button',{name:'查看卸载记录',exact:true}).click();await expect(current.getByText('已确认移除',{exact:true})).toBeVisible();mark('Host details retain uninstall history and open the saved operation');
 const cancel=await harness();current=cancel.page;await current.goto(origin+'/machines');await preview(current);await current.getByRole('button',{name:'取消卸载计划',exact:true}).click();await expect(current.getByText('已取消',{exact:true})).toBeVisible();expect(requestCount(cancel.state,'/apply')).toBe(0);expect(requestCount(cancel.state,'/cancel')).toBe(1);mark('Cancelling a pending plan never runs removal');
 const unknown=await harness();unknown.state.applyUnknown=true;current=unknown.page;await current.goto(origin+'/machines');await preview(current);await confirm(current);await expect(current.getByText('结果未知，需核对',{exact:true})).toBeVisible();await expect(current.getByRole('button',{name:'我已审阅，卸载 Agent',exact:true})).toHaveCount(0);await current.getByRole('button',{name:'只读核对远端状态',exact:true}).click();await expect(current.getByText('卸载完成',{exact:true})).toBeVisible();expect(requestCount(unknown.state,'/apply')).toBe(1);expect(requestCount(unknown.state,'/reconcile')).toBe(1);mark('Unknown outcomes expose fixed read-only reconciliation and never repeat apply');
 const incomplete=await harness();incomplete.state.record={...incomplete.state.record,status:'unknown'};incomplete.state.reconcileFailed=true;current=incomplete.page;await current.goto(origin+incomplete.state.record.review_url);await current.getByRole('button',{name:'只读核对远端状态',exact:true}).click();await expect(current.getByText('卸载失败',{exact:true})).toBeVisible();await expect(current.getByText('已停止，请在重新执行前核对服务状态',{exact:true})).toBeVisible();await expect(current.getByRole('button',{name:'我已审阅，卸载 Agent',exact:true})).toHaveCount(0);expect(requestCount(incomplete.state,'/apply')).toBe(0);mark('Read-only reconciliation can report incomplete removal and a stopped service without replaying the old plan');
 const stale=await harness();current=stale.page;await current.goto(origin+'/machines');await preview(current);stale.state.applyError=true;stale.state.readFails=true;await confirm(current);await expect(current.getByText(/暂时无法刷新已保存的操作/)).toBeVisible();await expect(current.getByRole('button',{name:'我已审阅，卸载 Agent',exact:true})).toHaveCount(0);stale.state.readFails=false;stale.state.record={...stale.state.record,status:'unknown'};await current.getByRole('button',{name:'刷新操作状态',exact:true}).click();await expect(current.getByRole('button',{name:'只读核对远端状态',exact:true})).toBeVisible();mark('A failed refresh after a transport error blocks blind retries until the saved state is retrieved');
 const expired=await harness();expired.state.record={...expired.state.record,plan:{...expired.state.record.plan,expires_at:'2000-01-01T00:00:00Z'}};current=expired.page;await current.goto(origin+expired.state.record.review_url);await expect(current.getByRole('button',{name:'我已审阅，卸载 Agent',exact:true})).toBeDisabled();await expect(current.getByRole('button',{name:'取消卸载计划',exact:true})).toBeEnabled();expect(requestCount(expired.state,'/uninstallations/plan')).toBe(0);mark('Deep links reopen the same expired plan, prevent apply, and allow cancellation');
 const existing=await harness();current=existing.page;await current.goto(origin+'/machines');await current.getByRole('button',{name:'部署 Agent',exact:true}).click();await current.getByRole('button',{name:'检查并生成部署计划',exact:true}).click();await expect(current.getByText('检测到已有 LightMoni Agent',{exact:true})).toBeVisible();expect(requestCount(existing.state,'/deployments/plan')).toBe(0);mark('Detecting an existing Agent stops fresh-install planning before any identity can be replaced');
 const ambiguous=await harness();ambiguous.state.result.agent_installation.state='unknown';current=ambiguous.page;await current.goto(origin+'/machines');await current.getByRole('button',{name:'部署 Agent',exact:true}).click();await current.getByRole('button',{name:'检查并生成部署计划',exact:true}).click();await expect(current.getByText('无法确定是否已有 Agent',{exact:true})).toBeVisible();expect(requestCount(ambiguous.state,'/deployments/plan')).toBe(0);mark('Unknown Agent presence also blocks fresh-install planning');
 const blocked=await harness({reason:'agent_task_busy'});current=blocked.page;await current.goto(origin+'/machines');await expect(current.getByRole('button',{name:'卸载 Agent',exact:true})).toBeDisabled();await expect(current.getByText(/节点有运行中、已派发或结果未知的任务/)).toBeVisible();mark('Unavailable uninstall capability shows an actionable task-busy reason');
 const en=await harness({language:'en-US'});current=en.page;await current.goto(origin+'/machines');await current.getByRole('button',{name:'Uninstall Agent',exact:true}).click();await expect(current.getByText('Remove the Agent and retain data',{exact:true})).toBeVisible();await current.getByRole('button',{name:'Verify identity and create uninstall plan',exact:true}).click();await expect(current.getByText('Verify the remote Agent identity',{exact:true})).toBeVisible();await expect(current.getByText('Retained paths',{exact:true})).toBeVisible();await expect(current.getByText('Verify removal and revoke Agent credentials',{exact:true})).toBeVisible();await expect(current.getByText('An interrupted SSH connection may leave an unknown outcome. Use verification instead of retrying blindly.',{exact:true})).toBeVisible();await expect(current.getByRole('button',{name:'I have reviewed the plan; uninstall Agent',exact:true})).toBeVisible();await current.locator('.ant-modal:visible').screenshot({path:resolve(media,'uninstall-plan-en.png'),animations:'disabled'});mark('English preview localizes identity verification, data retention, and confirmation controls');
 const member=await harness({role:'member'});current=member.page;await current.goto(origin+'/machines');await expect(current).toHaveURL(origin+'/settings');expect(member.state.requests.filter(r=>r.path.includes('/machines'))).toHaveLength(0);mark('Members never load host data or uninstall controls');
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);await writeFile(resolve(output,'uninstall-ui-report.json'),JSON.stringify({scope:'Isolated production web bundle with intercepted requests; no remote execution.',checked,errors,unexpected},null,2)+'\n');console.log('REPORT '+resolve(output,'uninstall-ui-report.json'));
}catch(error){if(current)await current.screenshot({path:resolve(media,'uninstall-ui-failure.png'),fullPage:true}).catch(()=>{});console.error({errors,unexpected});throw error}
finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDir,{recursive:true,force:true})}
