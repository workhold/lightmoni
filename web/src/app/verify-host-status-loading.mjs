import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';

const bundle=resolve(import.meta.dirname,'../../../runtime/public');
const server=createServer(async(request,response)=>{
 try{
  const path=decodeURIComponent(new URL(request.url,'http://fixture').pathname);
  let file=path.startsWith('/assets/')?resolve(bundle,'.'+path):join(bundle,'index.html');
  if(!file.startsWith(bundle+'/')||!(await stat(file)).isFile())file=join(bundle,'index.html');
  response.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream'));
  response.end(await readFile(file));
 }catch{response.writeHead(404);response.end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const errors=[],calls=[];
page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>localStorage.setItem('lightmoni.language','zh-CN'));
const observedAt=new Date().toISOString();
const available={available:true,reason:''};
const operation={id:'install-status',machine_id:'host-status',kind:'install',status:'running',execution_stage:'preflight',created_at:observedAt,started_at:observedAt};
const machine={id:'host-status',name:'心跳主机',address:'192.0.2.10',port:22,connection_method:'direct_ssh',host_key_fingerprint:'',host_key_status:'unconfigured',platform:'linux',arch:'amd64',agent_id:'agent-status',agent_status:'online',agent_observed_at:observedAt,agent_operation:operation,credential_count:0,active_credential_count:0,active_ssh_credential_count:0,active_ssh_key_count:0,ssh_recovery_available:false,capabilities:{terminal:available,ssh_check:available,deploy_agent:available,uninstall_agent:available},last_deployment_status:'',updated_at:observedAt,created_at:observedAt};
let releaseAgents,releaseLabels,releaseMachines;
let holdMachines=false,holdAuxiliary=true,machineInFlight=0,maxMachineInFlight=0;
await page.route('**/api/v1/**',async route=>{
 const path=new URL(route.request().url()).pathname,method=route.request().method();calls.push({path,method});
 if(path==='/api/v1/machines'&&method==='GET'){
  machineInFlight++;maxMachineInFlight=Math.max(maxMachineInFlight,machineInFlight);
  if(holdMachines)await new Promise(resolve=>releaseMachines=resolve);
  machineInFlight--;
  return route.fulfill({json:[machine]}).catch(()=>{});
 }
 if(path==='/api/v1/agents'){
  if(holdAuxiliary)await new Promise(resolve=>releaseAgents=resolve);
  return route.fulfill({json:[{id:'agent-status',hostname:'心跳主机',platform:'linux',arch:'amd64',version:'1.0.0',last_seen:observedAt,lifecycle_state:'active',heartbeat:{runtime:{mode:'user',permission_generation:1,uid:1000,gid:1000}},config:{},label_ids:[],labels:[],task_ids:[],tasks:[]}]}).catch(()=>{});
 }
 if(path==='/api/v1/host-labels'){
  if(holdAuxiliary)await new Promise(resolve=>releaseLabels=resolve);
  return route.fulfill({json:[]}).catch(()=>{});
 }
 if(path==='/api/v1/setup')return route.fulfill({json:{required:false}});
 if(path==='/api/v1/auth/me')return route.fulfill({json:{id:'admin',name:'Admin',role:'admin'}});
 if(path==='/api/v1/auth/profile')return route.fulfill({json:{}});
 return route.fulfill({json:[]});
});
try{
 await page.goto(origin+'/machines');
 const row=page.locator('tr[data-row-key="host-status"]');
 await expect(row).toBeVisible();
 await expect(row).toContainText('在线');
 await expect(row).toContainText('最近上报');
 expect(releaseAgents).toBeDefined();expect(releaseLabels).toBeDefined();
 expect(calls.filter(call=>call.path.includes('ssh-check')||call.path.includes('terminal-sessions'))).toHaveLength(0);
 await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
 const initial=calls.filter(call=>call.path==='/api/v1/machines').length;
 holdMachines=true;
 const timedOut=page.waitForEvent('requestfailed',{predicate:request=>new URL(request.url()).pathname==='/api/v1/machines',timeout:10_000});
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect.poll(()=>calls.filter(call=>call.path==='/api/v1/machines').length).toBe(initial+1);
 await page.evaluate(()=>{for(let i=0;i<4;i++)window.dispatchEvent(new Event('focus'))});
 await page.waitForTimeout(3000);
 expect(calls.filter(call=>call.path==='/api/v1/machines')).toHaveLength(initial+1);
 expect(calls.filter(call=>call.path==='/api/v1/agents')).toHaveLength(1);
 expect(calls.filter(call=>call.path==='/api/v1/host-labels')).toHaveLength(1);
 expect(maxMachineInFlight).toBe(1);
 await expect(row.locator('section[data-agent-operation-id="install-status"]')).toBeVisible();
 await timedOut;
 holdMachines=false;releaseMachines();
 await expect.poll(()=>calls.filter(call=>call.path==='/api/v1/machines').length,{timeout:5000}).toBe(initial+2);
 expect(maxMachineInFlight).toBe(1);
 holdAuxiliary=false;releaseAgents();releaseLabels();
 await expect(row).toContainText('仅监控');
 expect(errors).toHaveLength(0);
 console.log('PASS host list renders before slow Agent and label responses; Agent time is visible; automatic refresh does not overlap or starve auxiliary requests and retries after a held request times out; ordinary reads do not request SSH');
}finally{
 releaseAgents?.();releaseLabels?.();releaseMachines?.();
 await page.close();await browser.close();await new Promise(resolve=>server.close(resolve));
}
