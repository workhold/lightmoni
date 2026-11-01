// Isolated UI contract checks. No SSH, credentials, or production requests.
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {chromium,expect as playwrightExpect} from '@playwright/test';

const expect=playwrightExpect.configure({timeout:10000}),root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const source=join(root,'.local-host-execution-ui'),output=join(root,'../.local-dev/evidence/privileged-executor/host-ui'),bundle=join(output,'bundle');
await mkdir(source,{recursive:true});await mkdir(output,{recursive:true});
await writeFile(join(source,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(source,'main.tsx'),`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{App,Button,ConfigProvider,theme}from'../src/shared/ui';import{I18nProvider}from'../src/shared/i18n';import Panel from'../src/app/HostExecutionPanel';import Maintenance from'../src/app/ExecutorMaintenanceDialog';import Registration from'../src/app/MachineRegistrationDialog';import Summary from'../src/shared/SSHCheckSummary';import'../src/app/style.css';import'../src/app/machines.css';const query=new URLSearchParams(location.search);const keys=[{id:'second',name:'Secondary key',method:'ssh_key',retention:'permanent',expires_at:''},{id:'primary',name:'Primary key',method:'ssh_key',retention:'permanent',expires_at:''}];function Harness(){const[host,setHost]=useState('h1');const machine={id:host,name:'主机 '+host,agent_id:'agent-'+host,agent_status:'online',default_credential_id:'primary'};return query.get('view')==='maintenance'?<Maintenance machine={machine} executorID='executor-1' credentials={keys} onClose={()=>{}} onChanged={async()=>{}}/>:query.get('view')==='registration'?<Registration onClose={()=>{}} onChanged={async()=>{}} onCheck={()=>{}} onPlan={()=>{}}/>:query.get('view')==='summary'?<Summary result={{id:'c',machine_id:'h1',credential_id:'primary',connected:true,ready:false,platform:'linux',arch:'amd64',checks:{install_privilege:false},error_code:'prerequisites_missing',checked_at:new Date().toISOString(),expires_at:new Date(Date.now()+900000).toISOString(),privilege:{state:query.get('state')||'unavailable',reason_code:'privilege_unavailable_or_interactive'},agent_installation:{state:'absent'}}}/>:<><Button onClick={()=>setHost(host==='h1'?'h2':'h1')}>Switch host</Button><Panel key={host} machine={machine} credentials={query.has('no-credential')?[]:keys} admin={!query.has('member')}/></>}createRoot(document.getElementById('root')!).render(<I18nProvider><BrowserRouter><ConfigProvider theme={{algorithm:query.has('dark')?theme.darkAlgorithm:theme.defaultAlgorithm}}><App><main style={{padding:24,maxWidth:950}}><Harness/></main></App></ConfigProvider></BrowserRouter></I18nProvider>);`);
await build({root:source,configFile:false,base:'/',logLevel:'silent',build:{outDir:bundle,emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
const server=createServer(async(req,res)=>{try{let file=resolve(bundle,decodeURIComponent(new URL(req.url,'http://fixture').pathname).replace(/^\//,''));if(!file.startsWith(bundle+'/'))file=join(bundle,'index.html');try{if(!(await stat(file)).isFile())file=join(bundle,'index.html')}catch{file=join(bundle,'index.html')}res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'));res.end(await readFile(file))}catch{res.writeHead(404);res.end()}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:'chrome'}),checks=[],unexpected=[];
const capabilities=['container.managed.v1','script.elevated.v1','operations.managed.v1'];
const status=(id='h1',enabled=[],executor=null,effective='disabled')=>({machine_id:id,policy_generation:0,executor,capabilities:Object.fromEntries(capabilities.map(key=>[key,{authorized:enabled.includes(key),effective:enabled.includes(key)?effective:'disabled'}]))});
const bootstrap=(selected)=>({id:'bootstrap-1',status:'awaiting_approval',revision:'a'.repeat(64),expires_at:new Date(Date.now()+300000).toISOString(),plan:{credential_id:'primary',machine:{id:'h1',name:'主机 h1',agent_id:'agent-h1',address:'192.0.2.1',username:'deploy'},capabilities:selected,release:{sha256:'b'.repeat(64),build_id:'fixture-build'},steps:['安装独立 root 运维执行器'],privilege:{state:'sudo_noninteractive'}}});
const run=async(name,fn)=>{const page=await browser.newPage();page.on('pageerror',error=>unexpected.push(name+': '+error.message));try{await fn(page);checks.push({name,passed:true})}catch(error){checks.push({name,passed:false,error:error.message});await page.screenshot({path:join(output,`failure-${checks.length}.png`),fullPage:true});throw error}finally{await page.close()}};
try{
 await run('default off, default credential, exact single-capability review and lost apply response',async page=>{
  const calls=[];let selected=[],applies=0;
  await page.route('**/api/v1/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON();if(path.endsWith('/executor-bootstrap/plans'))return route.fulfill({json:[]});calls.push({path,body,method:request.method()});
   if(path.endsWith('/execution-status'))return route.fulfill({json:status()});
   if(path.endsWith('/executor-bootstrap/plan')){selected=body.capabilities;expect(body.credential_id).toBe('primary');return route.fulfill({json:bootstrap(selected)})}
   if(path.endsWith('/apply')){applies++;expect(body.confirm).toBe(true);expect(body.expected_revision).toBe('a'.repeat(64));return route.abort('failed')}
   if(path.endsWith('/executor-bootstrap/plans/bootstrap-1'))return route.fulfill({json:{id:'bootstrap-1',status:'unknown',executor_id:'executor-1'}});
   throw Error('Unexpected '+path);
  });
  await page.goto(base);const container=page.getByRole('switch',{name:'容器管理'}),script=page.getByRole('switch',{name:'允许提权脚本'});
  await expect(script).toBeEnabled();await expect(container).not.toBeChecked();await expect(script).not.toBeChecked();
  await script.click();expect(calls.filter(call=>call.method==='POST')).toHaveLength(0);
  await page.getByRole('button',{name:'检查并生成执行器安装计划'}).click();await expect(page.getByText('fixture-build')).toBeVisible();expect(selected).toEqual(['script.elevated.v1']);
  const apply=page.getByRole('button',{name:'确认执行此权限计划'});await expect(apply).toBeDisabled();
  await page.screenshot({path:join(output,'host-permission-review-zh.png'),fullPage:true});
  await page.getByRole('checkbox',{name:'我已审阅此主机、发行包和精确权限变更'}).check();await apply.click();
  await expect(page.getByText('提交结果未知，请回读原计划')).toBeVisible();await expect(script).toBeDisabled();expect(applies).toBe(1);
  await page.getByRole('button',{name:'回读原计划与执行状态'}).click();await expect(page.getByText('执行结果未知',{exact:true})).toBeVisible();expect(applies).toBe(1);
 });
 await run('policy uses existing executor, separates authorization, online and readiness; no SSH',async page=>{
  const calls=[];let current=status('h1',capabilities,{id:'executor-1',online:false,last_seen:'2026-11-01T00:00:00.000Z'},'unavailable');
  await page.route('**/api/v1/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON();if(path.endsWith('/executor-bootstrap/plans'))return route.fulfill({json:[]});calls.push({path,body});
   if(path.endsWith('/execution-status'))return route.fulfill({json:current});
   if(path.endsWith('/execution-policy/plan')){expect(body).toEqual({capabilities:[]});return route.fulfill({json:{id:'policy-1',revision:'c'.repeat(64),expires_at:new Date(Date.now()+300000).toISOString(),machine_id:'h1',agent_id:'agent-h1',previous_generation:0,generation:1,capabilities:[]}})}
   if(path.endsWith('/apply')){expect(body).toEqual({confirm:true,expected_revision:'c'.repeat(64)});current={...status('h1',[],{id:'executor-1',online:false}),policy_generation:1};return route.fulfill({json:current})}
   throw Error('Unexpected '+path);
  });
  await page.goto(base);await expect(page.getByText('中心已授权')).toHaveCount(3);await expect(page.getByText('依赖不可用')).toHaveCount(3);await expect(page.getByText('离线',{exact:true})).toBeVisible();
  await page.getByRole('switch',{name:'容器管理'}).click();await page.getByRole('switch',{name:'允许提权脚本'}).click();await page.getByRole('switch',{name:'受管主机运维（整机高信任）'}).click();
  await page.getByRole('button',{name:'生成权限变更计划'}).click();await expect(page.getByText('全部关闭',{exact:true})).toBeVisible();
  await page.getByRole('checkbox',{name:'我已审阅此主机、发行包和精确权限变更'}).check();await page.getByRole('button',{name:'确认执行此权限计划'}).click();
  await expect(page.getByText('中心授权已更新，实际状态见上方')).toBeVisible();await expect(page.getByText('中心未授权')).toHaveCount(3);expect(calls.some(call=>call.path.includes('bootstrap'))).toBe(false);
 });
 await run('plan failures preserve choices and editing invalidates prior approval',async page=>{
  let attempts=0;
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/executor-maintenance/releases'))return route.fulfill({json:{releases:[]}});if(path.endsWith('/executor-bootstrap/plans'))return route.fulfill({json:[]});if(path.endsWith('/execution-status'))return route.fulfill({json:status()});if(path.endsWith('/executor-bootstrap/plan')){attempts++;if(attempts===1)return route.fulfill({status:409,json:{error:'privilege_unavailable_or_interactive'}});return route.fulfill({json:bootstrap(route.request().postDataJSON().capabilities)})}throw Error('Unexpected '+path)});
  await page.goto(base);const script=page.getByRole('switch',{name:'允许提权脚本'});await expect(script).toBeEnabled();await script.click();await page.getByRole('button',{name:'检查并生成执行器安装计划'}).click();await expect(page.getByText('privilege_unavailable_or_interactive')).toBeVisible();await expect(script).toBeChecked();
  await page.getByRole('button',{name:'检查并生成执行器安装计划'}).click();await page.getByRole('checkbox',{name:'我已审阅此主机、发行包和精确权限变更'}).check();await page.getByRole('switch',{name:'容器管理'}).click();await expect(page.getByRole('button',{name:'确认执行此权限计划'})).toHaveCount(0);await expect(page.getByRole('button',{name:'检查并生成执行器安装计划'})).toBeVisible();
 });
 await run('lost policy approval recovers only the original applied plan without replay',async page=>{
  let applies=0;const policy={id:'policy-1',revision:'c'.repeat(64),expires_at:new Date(Date.now()+300000).toISOString(),machine_id:'h1',agent_id:'agent-h1',previous_generation:0,generation:1,capabilities:[]};
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname,method=route.request().method();if(path.endsWith('/execution-status'))return route.fulfill({json:status('h1',capabilities,{id:'executor-1',online:true},'ready')});if(path.endsWith('/execution-policy/plan'))return route.fulfill({json:policy});if(path.endsWith('/apply')){applies++;return route.abort('failed')}if(path.endsWith('/execution-policy/plans/policy-1')&&method==='GET')return route.fulfill({json:{...policy,applied_at:new Date().toISOString()}});throw Error('Unexpected '+path)});
  await page.goto(base);await expect(page.getByRole('switch',{name:'容器管理'})).toBeEnabled();await page.getByRole('switch',{name:'容器管理'}).click();await page.getByRole('switch',{name:'允许提权脚本'}).click();await page.getByRole('switch',{name:'受管主机运维（整机高信任）'}).click();await page.getByRole('button',{name:'生成权限变更计划'}).click();await page.getByRole('checkbox',{name:'我已审阅此主机、发行包和精确权限变更'}).check();await page.getByRole('button',{name:'确认执行此权限计划'}).click();await expect(page.getByText('提交结果未知，请回读原计划')).toBeVisible();await page.getByRole('button',{name:'刷新中心授权与执行状态'}).click();await expect(page.getByText('中心授权已更新，实际状态见上方')).toBeVisible();expect(applies).toBe(1);
 });
 await run('lost prepare response finds a new exact matching record read-only, without duplicate creation',async page=>{
  let saved,creates=0;
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/executor-maintenance/releases'))return route.fulfill({json:{releases:[]}});if(path.endsWith('/execution-status'))return route.fulfill({json:status()});if(path.endsWith('/executor-bootstrap/plans'))return route.fulfill({json:saved?[saved]:[]});if(path.endsWith('/executor-bootstrap/plan')){creates++;saved=bootstrap(route.request().postDataJSON().capabilities);return route.abort('failed')}throw Error('Unexpected '+path)});
  await page.goto(base);await expect(page.getByRole('switch',{name:'允许提权脚本'})).toBeEnabled();await page.getByRole('switch',{name:'允许提权脚本'}).click();await page.getByRole('button',{name:'检查并生成执行器安装计划'}).click();await expect(page.getByText('创建响应失联，已找回匹配的安装计划，请审阅后再批准。')).toBeVisible();await expect(page.getByText('bootstrap-1',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'确认执行此权限计划'})).toBeDisabled();expect(creates).toBe(1);
 });
 await run('expired plan never enables permission approval',async page=>{
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/executor-maintenance/releases'))return route.fulfill({json:{releases:[]}});if(path.endsWith('/execution-status'))return route.fulfill({json:status()});if(path.endsWith('/executor-bootstrap/plans'))return route.fulfill({json:[]});if(path.endsWith('/executor-bootstrap/plan'))return route.fulfill({json:{...bootstrap(['script.elevated.v1']),expires_at:new Date(Date.now()-1000).toISOString()}});throw Error('Unexpected '+path)});
  await page.goto(base);await expect(page.getByRole('switch',{name:'允许提权脚本'})).toBeEnabled();await page.getByRole('switch',{name:'允许提权脚本'}).click();await page.getByRole('button',{name:'检查并生成执行器安装计划'}).click();await expect(page.getByText('计划已过期，请重新检查')).toBeVisible();await expect(page.getByRole('checkbox',{name:'我已审阅此主机、发行包和精确权限变更'})).toBeDisabled();await expect(page.getByRole('button',{name:'确认执行此权限计划'})).toBeDisabled();
 });
 await run('no reusable credential blocks bootstrap without switching defaults',async page=>{
  await page.route('**/api/v1/**',route=>route.fulfill({json:status()}));await page.goto(base+'?no-credential');const script=page.getByRole('switch',{name:'允许提权脚本'});await expect(script).toBeEnabled();await script.click();await expect(page.getByRole('button',{name:'检查并生成执行器安装计划'})).toBeDisabled();
 });
 await run('member cannot load or mutate executor permissions',async page=>{
  let calls=0;await page.route('**/api/v1/**',route=>{calls++;return route.abort()});await page.goto(base+'?member');await expect(page.getByRole('button',{name:'Switch host'})).toBeVisible();await expect(page.getByRole('switch')).toHaveCount(0);expect(calls).toBe(0);
 });
 await run('late status from a previous host cannot populate the new host panel',async page=>{
  let release,started;const waiting=new Promise(resolve=>{started=resolve});
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/executor-maintenance/releases'))return route.fulfill({json:{releases:[]}});if(path.includes('/h1/')){await new Promise(resolve=>{release=resolve;started()});return route.fulfill({json:status('h1',[],{id:'wrong-old-executor',online:true})}).catch(()=>{})}return route.fulfill({json:status('h2',[],{id:'right-executor',online:true})})});
  await page.goto(base);await waiting;await page.getByRole('button',{name:'Switch host'}).click();await expect(page.getByText('right-executor')).toBeVisible();release();await expect(page.getByText('wrong-old-executor')).toHaveCount(0);await expect(page.getByText('right-executor')).toBeVisible();
 });
 await run('registration explains bootstrap account without forcing root username',async page=>{
  await page.route('**/api/v1/**',route=>route.fulfill({json:[]}));await page.goto(base+'?view=registration');await expect(page.getByText('安装 Agent 需要 root，或支持免交互提权的 sudo 账户。登录账户用于安装和恢复，Agent 使用独立账户运行。')).toBeVisible();await page.getByLabel('登录用户名').fill('deploy');await expect(page.getByLabel('登录用户名')).toHaveValue('deploy');
 });
 await run('failed privilege explains noninteractive sudo honestly in both languages and dark theme',async page=>{
  await page.goto(base+'?view=summary');await expect(page.getByText('无可用免交互提权')).toBeVisible();await expect(page.getByText(/需要密码的 sudo 当前不支持/)).toBeVisible();
  await page.evaluate(()=>localStorage.setItem('lightmoni.language','en-US'));await page.goto(base+'?view=summary&dark');await expect(page.getByText('Non-interactive elevation unavailable')).toBeVisible();await page.screenshot({path:join(output,'privilege-dark-en.png'),fullPage:true});
 });
 await run('unknown bootstrap reload recovers original identity and requires fresh credential plus explicit confirmation',async page=>{
  let reconciles=0,current={...bootstrap(['script.elevated.v1']),status:'unknown',executor_id:'executor-1',expires_at:new Date(Date.now()-600000).toISOString()};current.plan.credential_id='expired-original';
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/executor-maintenance/releases'))return route.fulfill({json:{releases:[]}});
   if(path.endsWith('/execution-status'))return route.fulfill({json:status('h1',['script.elevated.v1'],{id:'executor-1',online:false,state:current.status==='failed'?'revoked':'bootstrap_unknown'},'unknown')});
   if(path.endsWith('/executor-bootstrap/plans'))return route.fulfill({json:[current]});
   if(path.endsWith('/reconcile')){reconciles++;expect(route.request().postDataJSON()).toEqual({confirm:true,credential_id:'second'});current={...current,status:'failed',error:'已只读确认远端未安装，原安装结束；未执行安装或删除'};return route.fulfill({json:current})}
   throw Error('Unexpected '+path);
  });
  await page.goto(base);await expect(page.getByText('执行结果未知',{exact:true})).toBeVisible();await expect(page.getByRole('switch',{name:'允许提权脚本'})).toBeChecked();await expect(page.getByRole('button',{name:'运维执行器维护',exact:true})).toBeEnabled();const action=page.getByRole('button',{name:'只读核对并结束未安装记录'});await expect(action).toBeDisabled();await page.screenshot({path:join(output,'bootstrap-unknown-readonly-zh.png'),fullPage:true});
  await page.getByRole('combobox',{name:'安装结果核对 SSH 凭据'}).click();await page.getByText('Secondary key',{exact:true}).click();await expect(action).toBeDisabled();
  await page.getByRole('checkbox',{name:'确认只读核对：仅远端未安装时结束此记录并撤销原身份'}).check();await action.click();await expect(page.getByText('已只读确认远端未安装，原安装结束；未执行安装或删除')).toBeVisible();expect(reconciles).toBe(1);await expect(page.getByRole('button',{name:'准备新的权限变更'})).toBeVisible();
 });
 const removal=()=>({id:'maintenance-1',status:'awaiting_approval',revision:'d'.repeat(64),executor_id:'executor-1',expires_at:new Date(Date.now()+300000).toISOString(),plan:{action:'uninstall',machine:{id:'h1',name:'主机 h1',agent_id:'agent-h1',address:'192.0.2.1',username:'deploy'},credential_id:'primary',executor_id:'executor-1',install_generation:1,steps:['复核原执行器身份与本地未结束任务','核实远端移除后撤销平台执行器身份']}});
 await run('executor removal reviews exact identity, dispatches once, then reads original result',async page=>{
  let saved,applies=0;
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/executor-maintenance/releases'))return route.fulfill({json:{releases:[]}});
   if(path.endsWith('/executor-maintenance/plans'))return route.fulfill({json:saved?[saved]:[]});
   if(path.endsWith('/executor-maintenance/plan')){expect(route.request().postDataJSON()).toEqual({action:'uninstall',credential_id:'primary'});saved=removal();return route.fulfill({json:saved})}
   if(path.endsWith('/apply')){applies++;const body=route.request().postDataJSON();expect(body.confirm).toBe(true);expect(body.expected_revision).toBe(saved.revision);expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);saved={...saved,status:'running'};return route.fulfill({json:saved})}
   if(path.endsWith('/plans/maintenance-1')){saved={...saved,status:'succeeded',finished_at:new Date().toISOString()};return route.fulfill({json:saved})}
   throw Error('Unexpected '+path);
  });
  await page.goto(base+'?view=maintenance');await page.getByRole('combobox',{name:'执行器维护动作'}).click();await page.getByText('卸载',{exact:true}).click();await expect(page.getByText('维护独立 root 运维执行器',{exact:true})).toBeVisible();await page.getByRole('button',{name:'检查并生成维护计划'}).click();await expect(page.getByText('executor-1 / 1')).toBeVisible();await page.screenshot({path:join(output,'executor-maintenance-review-zh.png'),fullPage:true});const apply=page.getByRole('button',{name:'确认执行维护计划'});await expect(apply).toBeDisabled();await page.getByRole('checkbox',{name:'我已审阅此主机、执行器、源目标程序和维护动作，仅批准此精确计划'}).check();await apply.click();await page.getByRole('button',{name:'回读原维护记录'}).click();await expect(page.getByText('已核验卸载并撤销身份')).toBeVisible();expect(applies).toBe(1);
 });
 await run('lost removal response only reads original record and reconciles with a fresh selected credential',async page=>{
  let saved=removal(),exists=false,applies=0,reconciles=0;
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/executor-maintenance/releases'))return route.fulfill({json:{releases:[]}});
   if(path.endsWith('/executor-maintenance/plans'))return route.fulfill({json:exists?[saved]:[]});
   if(path.endsWith('/executor-maintenance/plan')){exists=true;return route.fulfill({json:saved})}
   if(path.endsWith('/apply')){applies++;saved={...saved,status:'unknown'};return route.abort('failed')}
   if(path.endsWith('/reconcile')){reconciles++;expect(route.request().postDataJSON()).toEqual({credential_id:'second'});saved={...saved,status:'succeeded'};return route.fulfill({json:saved})}
   if(path.endsWith('/plans/maintenance-1'))return route.fulfill({json:saved});
   throw Error('Unexpected '+path);
  });
  await page.goto(base+'?view=maintenance');await page.getByRole('combobox',{name:'执行器维护动作'}).click();await page.getByText('卸载',{exact:true}).click();await page.getByRole('button',{name:'检查并生成维护计划'}).click();await page.getByRole('checkbox',{name:'我已审阅此主机、执行器、源目标程序和维护动作，仅批准此精确计划'}).check();await page.getByRole('button',{name:'确认执行维护计划'}).click();await expect(page.getByText('请求结果未知，请回读原记录')).toBeVisible();await page.getByRole('button',{name:'回读原维护记录'}).click();const verify=page.getByRole('button',{name:'只读核对原维护结果'});await expect(verify).toBeEnabled();await page.getByRole('combobox',{name:'执行器维护核对 SSH 凭据'}).click();await page.getByText('Secondary key',{exact:true}).click();await verify.click();await expect(page.getByText('已核验卸载并撤销身份')).toBeVisible();expect(applies).toBe(1);expect(reconciles).toBe(1);
 });
 await run('expired removal plan cannot be approved and remains cancellable',async page=>{
  let saved={...removal(),expires_at:new Date(Date.now()-1000).toISOString()},cancelled=0;
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/executor-maintenance/releases'))return route.fulfill({json:{releases:[]}});if(path.endsWith('/executor-maintenance/plans'))return route.fulfill({json:[saved]});if(path.endsWith('/cancel')){expect(route.request().postDataJSON()).toEqual({});cancelled++;saved={...saved,status:'cancelled'};return route.fulfill({json:saved})}throw Error('Unexpected '+path)});
  await page.goto(base+'?view=maintenance');await expect(page.getByText('计划已过期，请取消后重新检查')).toBeVisible();await expect(page.getByRole('button',{name:'确认执行维护计划'})).toBeDisabled();await page.getByRole('button',{name:'取消尚未执行的计划'}).click();await expect(page.getByText('已取消',{exact:true})).toBeVisible();expect(cancelled).toBe(1);
 });
 await run('lost removal preparation recovers exact plan without a second creation',async page=>{
  let saved,creates=0;
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/executor-maintenance/releases'))return route.fulfill({json:{releases:[]}});if(path.endsWith('/executor-maintenance/plans'))return route.fulfill({json:saved?[saved]:[]});if(path.endsWith('/executor-maintenance/plan')){creates++;saved=removal();return route.abort('failed')}throw Error('Unexpected '+path)});
  await page.goto(base+'?view=maintenance');await page.getByRole('combobox',{name:'执行器维护动作'}).click();await page.getByText('卸载',{exact:true}).click();await page.getByRole('button',{name:'检查并生成维护计划'}).click();await expect(page.getByText('maintenance-1',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'确认执行维护计划'})).toBeDisabled();expect(creates).toBe(1);
 });
 const currentBuild={version:'1.0.0',build_id:'source-build',source_revision:'a'.repeat(40),artifact_sha256:'b'.repeat(64),state_schema:1,arch:'amd64',fingerprint:'c'.repeat(64)},targetBuild={...currentBuild,version:'1.1.0',build_id:'target-build',source_revision:'d'.repeat(40),artifact_sha256:'e'.repeat(64)};
 for(const [action,actionText] of [['upgrade','升级'],['rollback','回退'],['repair','修复']])await run('executor '+action+' uses one reviewed maintenance API with pinned runtimes',async page=>{
  let saved,applies=0,created=0;
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname,method=route.request().method();
   if(path.endsWith('/executor-maintenance/releases'))return route.fulfill({json:{releases:[{...targetBuild,sha256:targetBuild.artifact_sha256,platform:'linux'}]}});
   if(path.endsWith('/executor-maintenance/probe'))return route.fulfill({json:{schema:1,executor_id:'executor-1',machine_id:'h1',agent_id:'agent-h1',install_generation:1,policy_generation:7,service_active:true,current:currentBuild,previous:targetBuild,repairable:true,phase:'ready',fenced:null,pending_results:0}});
   if(path.endsWith('/executor-maintenance/plans'))return route.fulfill({json:saved?[saved]:[]});
   if(path.endsWith('/executor-maintenance/plan')){created++;expect(route.request().postDataJSON()).toEqual({action,credential_id:'primary',...(action==='upgrade'?{target_sha256:targetBuild.artifact_sha256}:{})});saved={...removal(),plan:{...removal().plan,action,current:currentBuild,target:action==='repair'?currentBuild:targetBuild,policy_generation:7}};return route.fulfill({json:saved})}
   if(path.endsWith('/apply')){applies++;const body=route.request().postDataJSON();expect(body.expected_revision).toBe(saved.revision);expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);expect(body.confirm).toBe(true);saved={...saved,status:'succeeded'};return route.fulfill({json:saved})}
   throw Error('Unexpected '+method+' '+path);
  });
  await page.goto(base+'?view=maintenance');if(action!=='upgrade'){await page.getByRole('combobox',{name:'执行器维护动作'}).click();await page.getByText(actionText,{exact:true}).click();}
  await page.getByRole('button',{name:'只读检查执行器现场'}).click();await expect(page.getByText('source-build',{exact:true})).toBeVisible();
  if(action==='upgrade'){await page.getByRole('combobox',{name:'目标执行器发行'}).click();await page.getByText(new RegExp('1.1.0 · target-build')).click();}
  await page.getByRole('button',{name:'检查并生成维护计划'}).click();await expect(page.getByText('批准的目标程序',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'确认执行维护计划'})).toBeDisabled();expect(applies).toBe(0);
  await page.getByRole('checkbox',{name:'我已审阅此主机、执行器、源目标程序和维护动作，仅批准此精确计划'}).check();await page.getByRole('button',{name:'确认执行维护计划'}).click();await expect(page.getByText('维护完成并核验目标构建',{exact:true})).toBeVisible();expect(created).toBe(1);expect(applies).toBe(1);
 });
 await run('maintenance rejects a plan for a different action without enabling approval',async page=>{
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/releases'))return route.fulfill({json:{releases:[]}});if(path.endsWith('/plans'))return route.fulfill({json:[]});if(path.endsWith('/plan'))return route.fulfill({json:removal()});throw Error('Unexpected '+path)});
  await page.goto(base+'?view=maintenance');await page.getByRole('combobox',{name:'执行器维护动作'}).click();await page.getByText('修复',{exact:true}).click();await page.getByRole('button',{name:'检查并生成维护计划'}).click();await expect(page.getByText('返回的维护计划与当前动作、目标或凭据不匹配')).toBeVisible();await expect(page.getByRole('button',{name:'确认执行维护计划'})).toHaveCount(0);
 });
 await run('maintenance missing build metadata cannot be approved even when action matches',async page=>{
  const saved={...removal(),plan:{...removal().plan,action:'repair'}};
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/releases'))return route.fulfill({json:{releases:[]}});if(path.endsWith('/plans'))return route.fulfill({json:[saved]});throw Error('Unexpected '+path)});
  await page.goto(base+'?view=maintenance');await expect(page.getByText('源或目标程序记录不完整，不能批准此维护计划')).toBeVisible();await expect(page.getByRole('checkbox',{name:'我已审阅此主机、执行器、源目标程序和维护动作，仅批准此精确计划'})).toBeDisabled();await expect(page.getByRole('button',{name:'确认执行维护计划'})).toBeDisabled();
 });
 await run('maintenance readback rejects changed frozen source while retaining original review',async page=>{
  const saved={...removal(),plan:{...removal().plan,action:'upgrade',current:currentBuild,target:targetBuild}};
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/releases'))return route.fulfill({json:{releases:[]}});if(path.endsWith('/plans'))return route.fulfill({json:[saved]});if(path.endsWith('/plans/maintenance-1'))return route.fulfill({json:{...saved,plan:{...saved.plan,current:{...currentBuild,build_id:'unapproved-build'}}}});throw Error('Unexpected '+path)});
  await page.goto(base+'?view=maintenance');await expect(page.getByText('source-build',{exact:true})).toBeVisible();await page.getByRole('button',{name:'回读原维护记录'}).click();await expect(page.getByText('维护记录与目标主机、执行器或原计划不匹配')).toBeVisible();await expect(page.getByText('unapproved-build',{exact:true})).toHaveCount(0);await expect(page.getByText('source-build',{exact:true})).toBeVisible();await expect(page.getByRole('checkbox',{name:'我已审阅此主机、执行器、源目标程序和维护动作，仅批准此精确计划'})).toBeDisabled();
 });
 await run('maintenance unavailable original credential blocks approval and still permits cancellation',async page=>{
  const saved={...removal(),plan:{...removal().plan,credential_id:'expired-original'}};
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/releases'))return route.fulfill({json:{releases:[]}});if(path.endsWith('/plans'))return route.fulfill({json:[saved]});throw Error('Unexpected '+path)});
  await page.goto(base+'?view=maintenance');await expect(page.getByText('原计划凭据已不可用，请取消后使用有效凭据重新检查')).toBeVisible();await expect(page.getByRole('button',{name:'确认执行维护计划'})).toBeDisabled();await expect(page.getByRole('button',{name:'取消尚未执行的计划'})).toBeEnabled();
 });
 if(unexpected.length)throw Error(unexpected.join('\n'));
 await writeFile(join(output,'results.json'),JSON.stringify({passed:checks.length,checks,unexpected},null,2));console.log(JSON.stringify({passed:checks.length,checks,output}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(source,{recursive:true,force:true})}
