// Production-bundle interaction checks. API fixtures never contact hosts or production.
import {createServer} from 'node:http';
import {readFile,stat,mkdir,writeFile,rm,cp} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect as baseExpect} from '../web/node_modules/@playwright/test/index.mjs';
import {build} from '../web/node_modules/vite/dist/node/index.js';

const expect=baseExpect.configure({timeout:15000});
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),publicDir=join(root,'.local-dev/evidence/agent-updates-direct/platform-bundle');
const out=resolve(process.env.LIGHTMONI_QA_OUTPUT||join(root,'.local-dev/evidence/agent-updates-direct'));await mkdir(out,{recursive:true});
await rm(publicDir,{recursive:true,force:true});await cp(join(root,'runtime/public'),publicDir,{recursive:true});
const harnessRoot=join(root,'web/.local-agent-update-ui'),harnessOut=join(out,'refresh-harness');await mkdir(harnessRoot,{recursive:true});
await writeFile(join(harnessRoot,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(harnessRoot,'main.tsx'),`import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';import{App}from'../src/shared/ui';import{I18nProvider}from'../src/shared/i18n';import Update from'../src/app/MachineAgentUpdateDialog';import Rollout from'../src/app/MachineAgentRolloutDialog';import'../src/app/style.css';const params=new URLSearchParams(location.search);function Harness(){const[record,setRecord]=useState(),[closed,setClosed]=useState(false);useEffect(()=>{if(!params.has('rollout'))fetch('/api/v1/machines/h1/agent-updates/'+params.get('id')).then(r=>r.json()).then(setRecord)},[]);const onRefresh=async()=>{throw Error('host refresh unavailable')};return closed?<p>Closed after saved operation</p>:params.has('rollout')?<Rollout existingID={params.get('id')} onRefresh={onRefresh} onClose={()=>setClosed(true)}/>:record?<Update machine={{id:'h1',name:'Test host 1',arch:'amd64'}} credentials={[]} existing={record} onRefresh={onRefresh} onClose={()=>setClosed(true)}/>:null}createRoot(document.getElementById('root')!).render(<I18nProvider><App><Harness/></App></I18nProvider>);`);
await build({root:harnessRoot,configFile:false,base:'/__agent-update-harness/',logLevel:'silent',build:{outDir:harnessOut,emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost'),harness=url.pathname.startsWith('/__agent-update-harness/'),directory=harness?harnessOut:publicDir,relative=decodeURIComponent(harness?url.pathname.replace('/__agent-update-harness/',''):url.pathname).replace(/^\/+/,''),candidate=resolve(directory,relative);if(!candidate.startsWith(directory+'/')&&candidate!==directory)throw Error('invalid path');let file=candidate;try{if(!(await stat(file)).isFile())file=join(directory,'index.html')}catch{file=join(directory,'index.html')}res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ttf':'font/ttf'}[extname(file)]||'application/octet-stream'));res.end(await readFile(file))}catch{res.writeHead(404);res.end()}});
await new Promise(accept=>server.listen(0,'127.0.0.1',accept));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:'chrome'}),checks=[],errors=[],unexpected=[];
const catalog={version:'0.1.0',source_revision:'bbbbbbbbbbbbbbbb',build_id:'build-new',state_schema:1,platform:'linux',arch:'amd64',sha256:'b'.repeat(64),size:2048};
const old={version:'0.1.0',source_revision:'aaaaaaaaaaaaaaaa',build_id:'build-old',state_schema:1,artifact_sha256:'a'.repeat(64),boot_id:'old-boot'};
const now=()=>new Date().toISOString(),keys=[{account_id:'a1',username:'root',account_revision:1,id:'key1',name:'Secondary SSH key',method:'ssh_key',retention:'permanent',expires_at:'',secret_fingerprint:'SHA256:secondary-key'},{account_id:'a1',username:'root',account_revision:1,id:'key2',name:'Primary SSH key',is_default:true,method:'ssh_key',retention:'permanent',expires_at:'',secret_fingerprint:'SHA256:primary-key'}];
const capability={available:true,reason:''};
const hosts=['h1','h2'].map((id,index)=>({id,name:`Test host ${index+1}`,default_account_id:'a1',accounts:[{id:'a1',machine_id:id,username:'root',revision:1,default_credential_id:'key2',credentials:[],last_check:null,check_fresh:true,recommended:true,recommended_credential_id:'key2',created_at:now(),updated_at:now(),created_by:'admin'}],default_credential_id:'key2',address:`192.0.2.${index+1}`,port:22,username:'root',connection_method:'direct_ssh',host_key_status:'observed',arch:'amd64',agent_id:`agent-${id}`,agent_status:'online',label_ids:[],agent_release:old,agent_update:{state:'update_available',target_sha256:catalog.sha256,target_version:catalog.version},ssh_recovery_available:true,capabilities:{terminal:capability,ssh_check:capability,deploy_agent:{available:false,reason:'agent_already_installed'},uninstall_agent:capability,update_agent:capability,rollback_agent:capability},created_at:now(),updated_at:now()}));
const agents=hosts.map(host=>({id:host.agent_id,machine_id:host.id,hostname:host.name,platform:'linux',arch:'amd64',version:'0.1.0',last_seen:now(),heartbeat:{release:old,control_interval_seconds:30},label_ids:[],labels:[],task_ids:[],tasks:[],config:{}}));
const operations=new Map(),rollouts=new Map(),calls=[],holds=[];
const hold=(path,method='GET')=>{let release,ready;const item={path,method,started:false,completed:false,promise:new Promise(resolve=>{release=resolve}),waiting:new Promise(resolve=>{ready=resolve})};item.release=release;item.ready=ready;holds.push(item);return item};
const flush=async page=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))};let serial=0,role='admin',applyOutcome='unknown',failUpdateReads=0,revokedDefault=false;
const planFor=(machineID,action='upgrade')=>{const host=hosts.find(item=>item.id===machineID),id=`update-${++serial}`,plan={machine:host,credential:keys[1],current:{...old,release:old,fingerprint:'fingerprint-old',agent_id:host.agent_id},target:action==='rollback'?{...catalog,source_revision:'previous-revision',sha256:'c'.repeat(64)}:catalog,expires_at:new Date(Date.now()+900000).toISOString(),steps:['核对主机、Agent 身份与当前程序指纹','确认目标构建的新进程已同步平台配置'],warnings:['保留主机 ID、Agent 身份、配置、队列和游标；不会重新接入。']},record={id,machine_id:machineID,agent_id:host.agent_id,action,status:'awaiting_approval',plan,created_at:now(),review_url:`/machines?machine=${machineID}&agent_update=${id}`};operations.set(id,record);return record};
const rolloutView=record=>({...record,items:record.items.map(item=>({...item,status:operations.get(item.update_id).status,update:operations.get(item.update_id)}))});
const context=await browser.newContext({viewport:{width:1440,height:1050}});
await context.route('**/*',async route=>{if(new URL(route.request().url()).origin===base)return route.continue();unexpected.push({url:route.request().url(),method:route.request().method()});await route.abort()});
await context.route('**/api/v1/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method(),body=request.postDataJSON();calls.push({path,method,body});let value;
 try{
  if(method==='GET'&&/^\/machines\/[^/]+\/agent-updates\/[^/]+$/.test(path)&&failUpdateReads>0){failUpdateReads--;await route.fulfill({status:503,json:{error:'saved status temporarily unavailable'}});return}
  if(path==='/setup')value={required:false};
  else if(path==='/auth/providers'||path==='/catalog/tables'||path==='/dashboards'||path==='/connection-credentials')value=[];
  else if(path==='/auth/profile')value={};
  else if(path==='/auth/me')value={id:'test-user',name:'Tester',role};
  else if(path==='/machines'||path==='/task-hosts')value=hosts;
  else if(path==='/agents')value=agents;
  else if(path==='/host-labels'||path==='/agent-tasks'||path==='/task-templates'||path==='/task-runs')value=[];
  else if(path==='/agent-releases')value={releases:[catalog]};
  else if(/^\/machines\/[^/]+$/.test(path))value={machine:hosts.find(host=>host.id===path.split('/')[2]),credentials:keys.map(key=>({...key,...(revokedDefault&&key.id==='key2'?{revoked_at:now()}: {})})),deployments:[],uninstallations:[]};
  else if(/^\/machines\/[^/]+\/agent-updates\/plan$/.test(path)){expect(method).toBe('POST');value=planFor(path.split('/')[2],body.action)}
  else if(/^\/machines\/[^/]+\/agent-updates\/start$/.test(path)){
   expect(method).toBe('POST');expect(body).toEqual({});
   if(revokedDefault){await route.fulfill({status:409,json:{error:'所选 SSH 凭据不可用'}});return}
   value=planFor(path.split('/')[2]);value.status=applyOutcome;value.events=[{at:now(),stage:'ready'},{at:now(),stage:'starting'},{at:now(),stage:'accepted'},{at:now(),stage:applyOutcome}];
  }
  else if(/^\/machines\/[^/]+\/agent-updates$/.test(path))value=[...operations.values()].filter(record=>record.machine_id===path.split('/')[2]);
  else if(/^\/machines\/[^/]+\/agent-updates\/[^/]+/.test(path)){
   const parts=path.split('/'),record=operations.get(parts[4]);if(!record)throw Error('missing update');
   if(parts[5]==='apply'){expect(body.confirm).toBe(true);record.status=applyOutcome;await new Promise(done=>setTimeout(done,100))}
   if(parts[5]==='cancel')record.status='cancelled';
   if(parts[5]==='reconcile')record.status='rolled_back';value=record;
  }else if(path==='/agent-rollouts'&&method==='GET')value=[...rollouts.values()].map(rolloutView);
  else if(path==='/agent-rollouts/plan'){const id=`rollout-${++serial}`,record={id,status:'awaiting_approval',target_sha256:body.target_sha256,created_at:now(),items:body.machine_ids.map(machineID=>({machine_id:machineID,machine_name:hosts.find(host=>host.id===machineID).name,update_id:planFor(machineID).id}))};rollouts.set(id,record);value=rolloutView(record)}
  else if(path.startsWith('/agent-rollouts/')){const parts=path.split('/'),record=rollouts.get(parts[2]);if(!record)throw Error('missing rollout');if(parts[3]==='apply'||parts[3]==='resume'){expect(body.confirm).toBe(true);record.status='running'}if(parts[3]==='pause')record.status='paused';if(parts[3]==='cancel'){record.status='cancelled';for(const item of record.items){const update=operations.get(item.update_id);if(update.status==='awaiting_approval')update.status='cancelled'}}value=rolloutView(record)}
  else{unexpected.push({path,method});value=[]}
  value=structuredClone(value);const held=holds.find(item=>!item.started&&item.path===path&&item.method===method);if(held){held.started=true;held.ready();await held.promise;held.completed=true}await route.fulfill({json:value});
 }catch(error){errors.push(String(error));await route.fulfill({status:500,json:{error:String(error)}})}
});
const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
const check=async(name,run)=>{await run();checks.push(name)};
const clickMaintenance=async(name,action)=>{await page.getByRole('button',{name:'Agent 管理 · '+name}).click();await page.locator('.ant-dropdown:visible').getByRole('menuitem',{name:action,exact:true}).last().dispatchEvent('click')};
try{
 await page.goto(base+'/machines');
 await check('same version with a different artifact shows an available update',async()=>{await expect(page.getByText('有可用更新',{exact:true}).first()).toBeVisible();await expect(page.getByText('bbbbbbbbbbbb',{exact:false})).toHaveCount(0);await expect(page.getByText('aaaaaaaaaaaa',{exact:false}).first()).toBeVisible()});
 await check('late host details never replace the last selected upgrade target',async()=>{const held=hold('/machines/h1');await clickMaintenance('Test host 1','升级 Agent');await held.waiting;await clickMaintenance('Test host 2','升级 Agent');await expect(page.getByRole('dialog')).toContainText('Agent 版本管理 · Test host 2');held.release();await expect.poll(()=>held.completed).toBe(true);await flush(page);await expect(page.getByRole('dialog')).toContainText('Agent 版本管理 · Test host 2');await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()});
 await check('closing the selected upgrade invalidates an earlier pending host response',async()=>{const held=hold('/machines/h1');await clickMaintenance('Test host 1','升级 Agent');await held.waiting;await clickMaintenance('Test host 2','升级 Agent');await expect(page.getByRole('dialog')).toContainText('Agent 版本管理 · Test host 2');await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();held.release();await expect.poll(()=>held.completed).toBe(true);await flush(page);await expect(page.getByRole('dialog')).toHaveCount(0)});
 await check('late upgrade deep links never supersede a newer manual host selection',async()=>{const record=planFor('h1'),held=hold('/machines/h1');await page.goto(base+record.review_url);await held.waiting;await clickMaintenance('Test host 2','升级 Agent');await expect(page.getByRole('dialog')).toContainText('Agent 版本管理 · Test host 2');held.release();await expect.poll(()=>held.completed).toBe(true);await flush(page);await expect(page.getByRole('dialog')).toContainText('Agent 版本管理 · Test host 2');await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.goto(base+'/machines')});
 await check('an unavailable default credential does not fall back to another account',async()=>{operations.clear();revokedDefault=true;await page.goto(base+'/machines');await clickMaintenance('Test host 1','升级 Agent');const dialog=page.getByRole('dialog');await expect(dialog.getByRole('alert')).toContainText('所选 SSH 凭据不可用');await expect(dialog.getByRole('combobox',{name:'更新 SSH 凭据'})).toHaveCount(0);await dialog.getByRole('button',{name:'关闭',exact:true}).click();revokedDefault=false;await page.goto(base+'/machines')});
 await check('single-host upgrade starts once and shows stage log without a plan form',async()=>{applyOutcome='succeeded';const before=calls.filter(call=>call.path==='/machines/h1/agent-updates/start').length;await clickMaintenance('Test host 1','升级 Agent');const dialog=page.getByRole('dialog');await expect(dialog.getByText('升级日志',{exact:true})).toBeVisible();await expect(dialog.getByText('更新成功',{exact:true})).toBeVisible();await expect(dialog.locator('li').filter({hasText:'维护器已接收'})).toBeVisible();await expect(dialog.getByRole('combobox',{name:'目标 Agent 发行'})).toHaveCount(0);await expect(dialog.getByRole('button',{name:'检查并生成计划'})).toHaveCount(0);expect(calls.filter(call=>call.path==='/machines/h1/agent-updates/start')).toHaveLength(before+1);expect(calls.filter(call=>call.path.endsWith('/apply')&&call.path.includes('/agent-updates/'))).toHaveLength(0)});

 await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();applyOutcome='unknown';
}catch(error){errors.push(String(error));throw error}finally{for(const held of holds)held.release();await writeFile(join(out,'direct-ui-report.json'),JSON.stringify({production_bundle:true,callback_failure_harness:true,api_fixtures:true,real_ssh:false,production_writes:false,checks,errors,unexpected,screenshots:out},null,2)+'\n');await browser.close();await new Promise(done=>server.close(done));await rm(harnessRoot,{recursive:true,force:true})}
if(errors.length||unexpected.length)throw Error(JSON.stringify({errors,unexpected}));console.log(JSON.stringify({passed:checks.length,checks}));
