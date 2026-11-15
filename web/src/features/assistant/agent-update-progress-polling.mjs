// Isolated assistant update-card polling acceptance. No real host or production API.
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {chromium,expect} from '@playwright/test';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const source=join(root,'.local-agent-update-polling'),output=join(root,'../.local-dev/evidence/173-agent-recovery-inline/polling'),bundle=join(source,'bundle');
await mkdir(source,{recursive:true});await mkdir(output,{recursive:true});
await writeFile(join(source,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(source,'main.tsx'),`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{App,Button,ConfigProvider}from'../shared/ui';import{I18nProvider}from'../shared/i18n';import AgentUpdateProgress from'../features/assistant/AgentUpdateProgress';import'../app/style.css';import'../app/theme.css';import'../features/assistant/assistant.css';
const record={id:'update-1',machine_id:'machine-1',agent_id:'agent-1',action:'upgrade',status:'running',created_at:'2026-11-15T00:00:00Z',review_url:'/machines?machine=machine-1&agent_update=update-1',plan:{machine:{id:'machine-1',name:'host-one',address:'192.0.2.1',port:22},ssh_account:{id:'account-1',username:'root',revision:1},current:{version:'0.1.0',source_revision:'old',fingerprint:'abc'},target:{version:'0.1.1',source_revision:'new',arch:'amd64',sha256:'a'.repeat(64),build_id:'build-new'},expires_at:'2099-11-15T00:00:00Z',steps:['verify'],warnings:['pause']}};
function Harness(){const[visible,setVisible]=useState(true);return <><Button onClick={()=>setVisible(false)}>Unmount fixture</Button>{visible&&<AgentUpdateProgress value={record} canApprove={true}/>}</>}
createRoot(document.getElementById('root')).render(<I18nProvider><BrowserRouter><ConfigProvider><App><Harness/></App></ConfigProvider></BrowserRouter></I18nProvider>);`);
await build({root:source,configFile:false,base:'/',logLevel:'silent',build:{outDir:bundle,emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
const server=createServer(async(req,res)=>{
 try{
  let file=resolve(bundle,decodeURIComponent(new URL(req.url,'http://fixture').pathname).replace(/^\//,''));
  if(!file.startsWith(bundle+'/'))file=join(bundle,'index.html');
  try{if(!(await stat(file)).isFile())file=join(bundle,'index.html')}catch{file=join(bundle,'index.html')}
  res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'));
  res.end(await readFile(file));
 }catch{res.writeHead(404);res.end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const fixtureRecord=state=>({id:'update-1',machine_id:'machine-1',agent_id:'agent-1',action:'upgrade',status:state.status,created_at:'2026-11-15T00:00:00Z',review_url:'/machines?machine=machine-1&agent_update=update-1',...(state.stage?{events:[{at:'2026-11-15T00:00:01Z',stage:state.stage}]}:{}),...(state.status==='unknown'?{recovery_revision:state.revision,recovery_requires_verification:state.recoveryRequired}:{}),plan:{machine:{id:'machine-1',name:'host-one',address:'192.0.2.1',port:22},ssh_account:{id:'account-1',username:'root',revision:1},current:{version:'0.1.0',source_revision:'old',fingerprint:'abc'},target:{version:'0.1.1',source_revision:'new',arch:'amd64',sha256:'a'.repeat(64),build_id:'build-new'},expires_at:'2099-11-15T00:00:00Z',steps:['verify'],warnings:['pause']}});
const checks=[];
async function run(name,fn){
 const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 const state={status:'running',calls:0,failures:0,stage:'accepted',recoveryRequired:false,revision:'c'.repeat(64),reconcileCalls:0,recoverCalls:0,reconcileBody:null,recoverBody:null};
 await page.route('**/api/v1/machines/machine-1/agent-updates/update-1',async route=>{
  state.calls++;
  if(state.failures>0){state.failures--;return route.fulfill({status:503,json:{error:'fixture read failure'}})}
  return route.fulfill({json:fixtureRecord(state)});
 });
 await page.route('**/api/v1/machines/machine-1/agent-updates/update-1/*',async route=>{
  const action=new URL(route.request().url()).pathname.split('/').at(-1);
  if(route.request().method()!=='POST')return route.fulfill({status:405,json:{error:'method not allowed'}});
  if(action==='reconcile'){
   state.reconcileCalls++;state.reconcileBody=route.request().postDataJSON();state.status='failed';
   return route.fulfill({json:fixtureRecord(state)});
  }
  if(action==='recover'){
   state.recoverCalls++;state.recoverBody=route.request().postDataJSON();state.status='rolled_back';
   return route.fulfill({json:fixtureRecord(state)});
  }
  return route.fulfill({status:404,json:{error:'unknown fixture action'}});
 });
 await fn(page,state);checks.push({name,passed:true});console.log('PASS '+name);await page.close();
}
try{
 await run('running card reaches real succeeded and stops polling',async(page,state)=>{await page.goto(base);await expect(page.getByText('执行请求已接受，正在更新或核验；这不代表升级成功',{exact:true})).toBeVisible();await expect.poll(async()=>page.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');state.status='succeeded';state.stage='succeeded';await expect(page.getByText('Agent 更新成功，已核验目标发行',{exact:true})).toBeVisible({timeout:10000});expect(await page.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');await page.waitForTimeout(3500);expect(state.calls).toBe(2)});
 await run('failed state is never presented as success',async(page,state)=>{state.status='failed';await page.goto(base);await expect(page.getByText('Agent 更新失败',{exact:true})).toBeVisible();await expect(page.getByText('Agent 更新成功，已核验目标发行',{exact:true})).toHaveCount(0)});
 await run('unknown state requires read-only verification',async(page,state)=>{state.status='unknown';await page.goto(base);await expect(page.getByText('更新结果未知，请打开原记录只读核对',{exact:true})).toBeVisible();await expect(page.getByText('Agent 更新成功，已核验目标发行',{exact:true})).toHaveCount(0);await page.screenshot({path:join(output,'unknown-card.png'),fullPage:true})});
 await run('unknown card reconciles the original record without recovery',async(page,state)=>{state.status='unknown';await page.goto(base);const button=page.getByRole('button',{name:'只读核对结果',exact:true});await expect(button).toBeVisible();await button.click();await expect(page.getByText('Agent 更新失败',{exact:true})).toBeVisible();expect(state.reconcileCalls).toBe(1);expect(state.recoverCalls).toBe(0);expect(state.reconcileBody).toEqual({})});
 await run('reviewed recovery sends the current revision once and shows the real terminal state',async(page,state)=>{state.status='unknown';await page.goto(base);const recover=page.getByRole('button',{name:'恢复中断维护',exact:true});await expect(recover).toBeVisible();await expect(recover).toBeDisabled();await page.getByRole('checkbox').check();await expect(recover).toBeEnabled();await recover.click();await expect(page.getByText('目标更新未通过健康确认，已恢复原程序',{exact:true})).toBeVisible();expect(state.recoverCalls).toBe(1);expect(state.recoverBody).toEqual({confirm:true,expected_revision:'c'.repeat(64)});expect(Object.hasOwn(state.recoverBody,'credential_id')).toBe(false)});
 await run('a changed recovery revision is reread and never dispatched',async(page,state)=>{state.status='unknown';await page.goto(base);const recover=page.getByRole('button',{name:'恢复中断维护',exact:true});await expect(recover).toBeVisible();await page.getByRole('checkbox').check();state.revision='d'.repeat(64);await recover.click();await expect(page.getByText('恢复条件已变化或上次恢复尚未核对，请重新只读核对',{exact:true})).toBeVisible();expect(state.recoverCalls).toBe(0)});
 await run('an unverified previous recovery blocks another recovery',async(page,state)=>{state.status='unknown';state.recoveryRequired=true;await page.goto(base);await expect(page.getByText('上次恢复结果尚未核对，禁止再次恢复',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'恢复中断维护',exact:true})).toBeDisabled();expect(state.recoverCalls).toBe(0)});
 await run('read failure retains state and a later read succeeds',async(page,state)=>{state.failures=1;await page.goto(base);await expect(page.getByText('暂时无法刷新更新状态，保留最后记录，稍后重试',{exact:true})).toBeVisible();state.status='succeeded';await expect(page.getByText('Agent 更新成功，已核验目标发行',{exact:true})).toBeVisible({timeout:12000})});
 await run('unmount aborts future reads',async(page,state)=>{await page.goto(base);await page.getByRole('button',{name:'Unmount fixture',exact:true}).click();await page.waitForTimeout(3500);expect(state.calls).toBe(0)});
 await writeFile(join(output,'results.json'),JSON.stringify({passed:checks.length,checks},null,2));console.log(JSON.stringify({passed:checks.length,output}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(source,{recursive:true,force:true})}
