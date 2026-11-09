// Isolated UI contracts with a real HTTP download of this checkout's backup
// script. No Docker, SSH, cloud requests, schedules or production mutations.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium,expect as baseExpect} from '../web/node_modules/@playwright/test/index.mjs';
import {createServer as createViteServer} from '../web/node_modules/vite/dist/node/index.js';
import {mediaDirectory} from './qa-artifacts.mjs';

const expect=baseExpect.configure({timeout:10000}),root=resolve(import.meta.dirname,'..');
const evidence=resolve(root,'specs/117-deployment-followups/evidence'),media=resolve(mediaDirectory(evidence),'backup-tools-ui');
await mkdir(evidence,{recursive:true});await mkdir(media,{recursive:true});
const bytes=await readFile(resolve(root,'scripts/lightmoni-backup.py')),sha=createHash('sha256').update(bytes).digest('hex');
const productInputs=['web/src/app/BackupTools.tsx','web/src/app/ops/InstalledApplications.tsx','web/src/shared/CodeEditor.tsx'];
const sourceHashes=Object.fromEntries(await Promise.all(productInputs.map(async path=>[path,createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')])));
const httpRequests=[];let available=true;
const http=createServer((req,res)=>{
 const path=new URL(req.url,'http://fixture').pathname;httpRequests.push({method:req.method,path});
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET'){res.writeHead(405);res.end();return}
 if(!req.headers.cookie?.split(';').some(v=>v.trim()==='lm_session=backup-ui-admin')){res.writeHead(401);res.end('{}');return}
 if(path==='/api/v1/backup-tool'){
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({available,filename:'lightmoni-backup.py',download_url:'/api/v1/backup-tool/download',sha256:available?sha:null}));return;
 }
 if(path==='/api/v1/backup-tool/download'&&available){
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="lightmoni-backup.py"','Content-Length':bytes.length});res.end(bytes);return;
 }
 res.writeHead(404);res.end('{}');
});
await new Promise(done=>http.listen(0,'127.0.0.1',done));const apiOrigin='http://127.0.0.1:'+http.address().port;
const harness=await mkdtemp(resolve(root,'web/.qa-backup-tools-')),cache=await mkdtemp(resolve(tmpdir(),'lightmoni-backup-vite-'));
const applicationID='7'.repeat(32),applicationName='订单数据服务 · Orders data';
await writeFile(resolve(harness,'main.tsx'),`import React from'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{App}from'../src/shared/ui';import{I18nProvider}from'../src/shared/i18n';import AppearanceProvider from'../src/shared/appearance';import BackupTools from'../src/app/BackupTools';import InstalledApplications from'../src/app/ops/InstalledApplications';import'../src/app/style.css';import'../src/app/theme.css';import'../src/app/operations.css';const application={id:${JSON.stringify(applicationID)},kind:'application',name:${JSON.stringify(applicationName)},revision:3,spec:{service_name:'orders-data',mode:'compose',deployment_mode:'manual',compose:{services:{database:{image:'postgres:17'},cache:{image:'redis:7.4'}}},deployments:[]},status:{state:'running',instances:[]},created_at:'2026-11-09T00:00:00Z',updated_at:'2026-11-09T00:00:00Z'};const unexpected=()=>{throw Error('Unexpected destructive or deployment action in backup UI verification')};function Harness(){return new URLSearchParams(location.search).has('applications')?<main className='lm-page'><h1>Installed applications</h1><InstalledApplications applications={[application]} resources={[application]} machines={[]} filter='all' onEdit={unexpected} onLogo={unexpected} onAction={unexpected} onProgress={unexpected} onDetails={unexpected} onMonitor={unexpected} onDelete={unexpected} onUpgrade={unexpected} onTerminal={unexpected} onStore={unexpected}/></main>:<BackupTools/>}createRoot(document.getElementById('root')!).render(<BrowserRouter><I18nProvider><AppearanceProvider><App><Harness/></App></AppearanceProvider></I18nProvider></BrowserRouter>);`);
const vite=await createViteServer({root:resolve(root,'web'),configFile:false,cacheDir:cache,resolve:{dedupe:['react','react-dom']},logLevel:'error',plugins:[{name:'backup-tools-ui-fixture',configureServer(server){server.middlewares.use((req,res,next)=>{
 if(!req.url?.startsWith('/backup-tools-ui'))return next();res.setHeader('Content-Type','text/html');res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/'+basename(harness)+'/main.tsx"></script>');
 })}}],server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/*']},proxy:{'/api':{target:apiOrigin}}}});
await vite.listen();const origin=vite.resolvedUrls.local[0];
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const scenarios=[
 {language:'zh-CN',appearance:'light',width:1440,height:1000,zoom:'100%'},
 {language:'zh-CN',appearance:'dark',width:390,height:844,zoom:'100%'},
 {language:'en-US',appearance:'light',width:390,height:844,zoom:'100%'},
 {language:'en-US',appearance:'dark',width:1440,height:1000,zoom:'100%'},
 {language:'zh-CN',appearance:'light',width:720,height:500,zoom:'200% equivalent of 1440×1000'},
 {language:'en-US',appearance:'dark',width:720,height:500,zoom:'200% equivalent of 1440×1000'},
];
const runs=[],allErrors=[],external=[],unexpectedCallbacks=[];
const translations={
 'zh-CN':{title:'备份与迁移',tabs:['导出与下载','恢复与迁移','定期云备份'],download:'下载备份工具',more:'更多操作',backup:'备份应用',dialog:'应用备份',close:'关闭',unavailable:'当前发行包尚未包含备份工具'},
 'en-US':{title:'Backup & migration',tabs:['Export & download','Restore & migrate','Scheduled cloud backups'],download:'Download backup tool',more:'More actions',backup:'Back up application',dialog:'Application backup',close:'Close',unavailable:'This release does not include the backup tool yet'},
};
try{
 for(let run=1;run<=3;run++){
  const checks=[];
  for(const scenario of scenarios){
   const name=[scenario.language,scenario.appearance,scenario.width].join('-'),label=translations[scenario.language];
   const context=await browser.newContext({viewport:{width:scenario.width,height:scenario.height},recordVideo:{dir:resolve(media,'video'),size:{width:scenario.width,height:scenario.height}}});
   await context.addCookies([{name:'lm_session',value:'backup-ui-admin',url:origin}]);
   await context.addInitScript(({language,appearance})=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.appearance',appearance)},scenario);
   const page=await context.newPage(),errors=[],downloads=[],visited=[];
   page.on('pageerror',error=>{errors.push(error.message);allErrors.push({run,name,error:error.message});if(error.message.startsWith('Unexpected'))unexpectedCallbacks.push(error.message)});
   page.on('request',request=>{if(request.url().startsWith('http')&&!request.url().startsWith(origin))external.push({run,name,url:request.url()})});
   const shot=async suffix=>{if(run===1)await page.screenshot({path:resolve(media,name+'-'+suffix+'.png'),animations:'disabled',fullPage:false})};
   const noOverflow=async()=>{await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)};
   const download=async scope=>{
    await expect(scope.getByText(sha,{exact:true})).toBeVisible();
    const link=scope.getByRole('link',{name:new RegExp(label.download)});await expect(link).toHaveAttribute('href','/api/v1/backup-tool/download');
    const ready=page.waitForEvent('download');await link.click();const result=await ready;
    expect(result.suggestedFilename()).toBe('lightmoni-backup.py');const actual=await readFile(await result.path());expect(actual.equals(bytes)).toBe(true);
    expect(createHash('sha256').update(actual).digest('hex')).toBe(sha);downloads.push({filename:result.suggestedFilename(),bytes:actual.length,sha256:sha});
   };
   const tabs=async(scope,kind)=>{
    await expect(scope.getByRole('tab')).toHaveCount(3);
    for(let index=0;index<label.tabs.length;index++){
     const tab=scope.getByRole('tab',{name:label.tabs[index]});
     // Keyboard access remains available when Ant Design moves long mobile
     // tab captions into its horizontal overflow affordance.
     await tab.focus();await page.keyboard.press('Enter');await expect(tab).toHaveAttribute('aria-selected','true');
     const panel=scope.getByRole('tabpanel',{name:label.tabs[index]});await expect(panel.locator('.monaco-editor')).toBeVisible();
     await expect(panel.locator('.lm-code-editor')).toHaveClass(/is-readonly/);
     await expect(panel.locator('.monaco-editor')).toHaveClass(scenario.appearance==='dark'?/vs-dark/:/(?:^|\s)vs(?:\s|$)/);
     if(index===0){await expect(panel).toContainText(kind==='application'?applicationID:'--project');await expect(panel).toContainText('--confirm-stop')}
     if(index===1){await expect(panel).toContainText('--confirm-empty-targets');await expect(panel).toContainText('compose.json')}
     if(index===2){await expect(panel).toContainText('systemd');await expect(panel).toContainText('5 GiB')}
     await noOverflow();await panel.scrollIntoViewIfNeeded();await shot(kind+'-'+['export','restore','schedule'][index]);visited.push(kind+':'+['export','restore','schedule'][index]);
    }
   };
   try{
    await page.goto(origin+'backup-tools-ui');await expect(page.getByRole('heading',{name:label.title,exact:true})).toBeVisible();await download(page);await tabs(page,'deployment');
    await page.goto(origin+'backup-tools-ui?applications=1');const article=page.getByRole('article',{name:applicationName,exact:true});await expect(article).toBeVisible();
    await article.getByRole('button',{name:label.more+' · '+applicationName,exact:true}).click();await page.getByRole('menuitem',{name:label.backup,exact:true}).click();
    const dialog=page.getByRole('dialog',{name:label.dialog+' · '+applicationName,exact:true});await expect(dialog).toBeVisible();await download(dialog);await tabs(dialog,'application');
    const close=dialog.getByRole('button',{name:new RegExp('^'+label.close.split('').join(' ?')+'$')}).last();await close.scrollIntoViewIfNeeded();await expect(close).toBeInViewport();await shot('application-footer');await close.click();await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);checks.push({...scenario,visited,downloads,errors,video:await page.video().path()});
    console.log('PASS backup tools UI round '+run+' '+name);
   }catch(error){await page.screenshot({path:resolve(media,'failure-'+run+'-'+name+'.png'),fullPage:true});console.error(await page.locator('body').innerText());throw error}finally{await context.close()}
  }
  runs.push({run,checks});
 }
 // A release without the script must never expose an active download link.
 available=false;const context=await browser.newContext();await context.addCookies([{name:'lm_session',value:'backup-ui-admin',url:origin}]);const page=await context.newPage();await page.goto(origin+'backup-tools-ui');await expect(page.getByText(translations['zh-CN'].unavailable,{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:/下载备份工具/})).toHaveCount(0);await context.close();
 expect(allErrors).toEqual([]);expect(external).toEqual([]);expect(unexpectedCallbacks).toEqual([]);expect(httpRequests.every(request=>request.method==='GET')).toBe(true);
 const finishedHashes=Object.fromEntries(await Promise.all(productInputs.map(async path=>[path,createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')])));
 await writeFile(resolve(evidence,'backup-tools-ui.json'),JSON.stringify({scope:'Vite source UI, actual InstalledApplications menu and BackupTools components; real loopback HTTP metadata and byte-for-byte script downloads. No Docker, SSH, cloud, schedule installation or production mutations.',script:{sha256:sha,size:bytes.length},source_hashes:sourceHashes,source_changed_during_run:productInputs.filter(path=>sourceHashes[path]!==finishedHashes[path]),runs,unavailable_release:true,page_errors:allErrors,external_requests:external,http_requests:httpRequests,media},null,2)+'\n');
}finally{
 await browser.close();await vite.close();http.closeAllConnections();await new Promise(done=>http.close(done));await rm(harness,{recursive:true,force:true});await rm(cache,{recursive:true,force:true});
}
