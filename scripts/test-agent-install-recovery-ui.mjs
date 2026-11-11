// Real MachinesPage interactions against isolated API fixtures; no SSH or production access.
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect as baseExpect} from '../web/node_modules/@playwright/test/index.mjs';
import {build} from '../web/node_modules/vite/dist/node/index.js';
const expect=baseExpect.configure({timeout:15000});
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=join(root,'.local-dev/evidence/agent-install-recovery-ui'),harness=join(root,'web/.local-agent-install-recovery-ui'),bundle=join(out,'bundle');
await mkdir(out,{recursive:true});await mkdir(harness,{recursive:true});
await writeFile(join(harness,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(harness,'main.tsx'),`import React from'react';import{createRoot}from'react-dom/client';import{BrowserRouter,useNavigate}from'react-router-dom';import{App}from'../src/shared/ui';import{I18nProvider}from'../src/shared/i18n';import MachinesPage from'../src/app/MachinesPage';import'../src/app/style.css';function Harness(){const navigate=useNavigate();window.switchHost=()=>navigate('/?machine=h2&deployment=d2');return <MachinesPage user={{id:'admin',name:'Admin',role:'admin'}}/>}createRoot(document.getElementById('root')!).render(<BrowserRouter><I18nProvider><App><Harness/></App></I18nProvider></BrowserRouter>);`);
let server,browser;
const checks=[],errors=[],unexpected=[];
try{
 await build({root:harness,configFile:false,base:'/',logLevel:'silent',resolve:{dedupe:['react','react-dom']},build:{outDir:bundle,emptyOutDir:true}});
 server=createServer(async(req,res)=>{try{const path=resolve(bundle,decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,''));if(!path.startsWith(bundle+'/')&&path!==bundle)throw Error('path');let file=path;try{if(!(await stat(file)).isFile())file=join(bundle,'index.html')}catch{file=join(bundle,'index.html')}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream'));res.end(await readFile(file))}catch{res.writeHead(404);res.end()}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const machine=id=>({id,name:'Recovery host '+id,address:'host.invalid',port:22,agent_id:'',agent_status:'offline',arch:'amd64',platform:'linux',connection_method:'ssh',host_key_status:'verified',credential_count:1,active_credential_count:1,active_ssh_key_count:1,default_account_id:'a1',accounts:[{id:'a1',username:'root',revision:1,default_credential_id:'c1'}],capabilities:{terminal:{available:true,reason:''},ssh_check:{available:true,reason:''},deploy_agent:{available:false,reason:'installation_unknown'}},agent_operation:record(id),updated_at:'',created_at:''});
 const record=id=>({id:id==='h1'?'d1':'d2',machine_id:id,status:'unknown',execution_stage:'bootstrap_dispatched',version:'0.1.0',arch:'amd64',plan:{credential:{id:'c1'},version:'0.1.0',arch:'amd64',steps:[],expires_at:'2099-01-01T00:00:00Z'},receipt:{},error:'Installer exited before activation',resolved_at:'',created_at:'2026-11-11T00:00:00Z'});
 const credential={id:'c1',account_id:'a1',username:'root',account_revision:1,method:'ssh_key',retention:'permanent',expires_at:'',secret_fingerprint:'fixture-only'};
 for(const scenario of ['read-success','read-failed','read-mismatch','read-regressed','late-read','resolve-lost-response','post-mismatch']){
  const context=await browser.newContext({viewport:{width:1280,height:1000},reducedMotion:'reduce'});await context.addInitScript(()=>localStorage.setItem('lightmoni.language','zh-CN'));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  let afterPost=false,resolved=false,mode=scenario,readCount=0,releaseRead;const calls=[];
  await context.route('**/*',async route=>{if(new URL(route.request().url()).origin===base)return route.continue();unexpected.push(route.request().url());await route.abort()});
  await context.route('**/api/v1/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method();calls.push({path,method});let status=200,value;
   const saved=id=>({...record(id),...(id==='h1'&&resolved?{resolved_at:'2026-11-11T01:00:00Z',resolved_by:'admin',resolution_reason:'Checked remote installer has exited'}:{})});
   if(path==='/machines'&&method==='GET')value=[machine('h1'),machine('h2')];
   else if(['/agents','/host-labels'].includes(path))value=[];
   else if(/^\/machines\/h[12]$/.test(path)&&method==='GET'){const id=path.split('/')[2];value={machine:machine(id),credentials:[credential],deployments:[saved(id)]};}
   else if(/^\/machines\/h[12]\/deployments\/d[12]$/.test(path)&&method==='GET'){
    const id=path.split('/')[2];value=saved(id);
    if(id==='h1'&&afterPost){readCount++;
     if(mode==='read-failed'){status=502;value={error:'Record read unavailable'};}
     if(mode==='read-mismatch')value=saved('h2');
     if(mode==='read-regressed')value={...value,status:'running'};
     if(mode==='late-read')await new Promise(done=>releaseRead=done);
    }
   }else if(path==='/machines/h1/deployments/d1/reconcile'&&method==='POST'){
    afterPost=true;status=502;value={error:'Read-only verification failed'};
    if(mode==='post-mismatch'){status=200;value=saved('h2');}
   }else if(path==='/machines/h1/deployments/d1/resolve'&&method==='POST'){
    expect(request.postDataJSON()).toEqual({confirm:true,reason:'Checked remote installer has exited'});afterPost=true;resolved=true;value=saved('h1');
    if(mode==='resolve-lost-response'){status=502;value={error:'Resolution response lost'};}
   }else{unexpected.push({path,method});status=404;value={error:'Unexpected API'};}
   try{await route.fulfill({status,json:value})}catch(error){if(!page.isClosed())throw error;}
  });
  await page.goto(base+'/?machine=h1&deployment=d1');
  const reason=page.getByRole('textbox',{name:'人工结束原因'}),verify=page.getByRole('button',{name:'只读核对首装结果',exact:true});
  await expect(verify).toBeEnabled();await reason.fill('Checked remote installer has exited');
  if(scenario==='resolve-lost-response'){
   await page.getByRole('button',{name:'人工结束本次首装',exact:true}).click();await page.getByRole('button',{name:'确认人工结束',exact:true}).click();
   await expect(page.getByText('已人工结束，原首装结果仍未知',{exact:true})).toBeVisible();expect(readCount).toBe(1);
  }else{
   await verify.click();
   if(scenario==='late-read'){
    await expect.poll(()=>!!releaseRead).toBe(true);await page.evaluate(()=>window.switchHost());
    await expect(page.locator('.ant-modal').getByText('d2',{exact:true})).toBeVisible();
    const lateResponse=page.waitForResponse(response=>response.url().endsWith('/machines/h1/deployments/d1'));releaseRead();await lateResponse;await expect(page.locator('.ant-modal').getByText('d2',{exact:true})).toBeVisible();await expect(page.locator('.ant-modal').getByText('d1',{exact:true})).toHaveCount(0);await expect(verify).toBeEnabled();await expect(reason).toBeEnabled();
   }else if(['read-failed','read-mismatch','read-regressed'].includes(scenario)){
    await expect(reason).toBeDisabled();await expect(page.getByText('无法确认原部署记录，请先只读刷新；不要重复创建或执行。',{exact:true})).toBeVisible();
    mode='read-success';await page.getByRole('button',{name:'刷新原部署记录',exact:true}).click();await expect(reason).toBeEnabled();await expect(verify).toBeEnabled();
   }else{
    await expect(reason).toBeEnabled();await expect(verify).toBeEnabled();await expect(reason).toHaveValue('Checked remote installer has exited');expect(readCount).toBe(1);
    if(scenario==='read-success'){
     await expect(page.getByText('Read-only verification failed',{exact:true})).toBeVisible();
     await page.getByRole('button',{name:'人工结束本次首装',exact:true}).click();await page.getByRole('button',{name:'确认人工结束',exact:true}).click();
     await expect(page.getByText('已人工结束，原首装结果仍未知',{exact:true})).toBeVisible();
    }
   }
  }
  expect(calls.filter(call=>call.method==='POST'&&!/\/(reconcile|resolve)$/.test(call.path))).toEqual([]);
  checks.push(scenario);await context.close();
 }
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 await writeFile(join(out,'report.json'),JSON.stringify({checks,errors,unexpected},null,2)+'\n');console.log(JSON.stringify({passed:checks.length,checks}));
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}await rm(harness,{recursive:true,force:true});}
