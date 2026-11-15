// Isolated batch permission-default acceptance. No real host or production API.
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {chromium,expect} from '@playwright/test';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),source=join(root,'.local-batch-runtime'),bundle=join(source,'bundle'),output=join(root,'../.local-dev/evidence/178-agent-lifecycle-recovery-ux');
await mkdir(source,{recursive:true});await mkdir(output,{recursive:true});
await writeFile(join(source,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(source,'main.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{App,ConfigProvider}from'../shared/ui';import{I18nProvider}from'../shared/i18n';import Batch from'../app/MachineBatchDialog';import'../app/style.css';import'../app/theme.css';import'../app/machines.css';
createRoot(document.getElementById('root')).render(<I18nProvider><BrowserRouter><ConfigProvider><App><Batch action='install' targets={[{id:'h1',name:'Host one',machine:{id:'h1',name:'Host one',address:'h1.example.test',port:22,connection_method:'direct_ssh',agent_id:'',agent_status:'unknown'}},{id:'h2',name:'Host two',machine:{id:'h2',name:'Host two',address:'h2.example.test',port:22,connection_method:'direct_ssh',agent_id:'',agent_status:'unknown'}}]} onClose={()=>{}} onRefresh={async()=>{}}/></App></ConfigProvider></BrowserRouter></I18nProvider>);`);
await build({root:source,configFile:false,logLevel:'silent',build:{outDir:bundle,emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
const server=createServer(async(req,res)=>{try{let file=resolve(bundle,decodeURIComponent(new URL(req.url,'http://fixture').pathname).replace(/^\//,''));if(!file.startsWith(bundle+'/'))file=join(bundle,'index.html');try{if(!(await stat(file)).isFile())file=join(bundle,'index.html')}catch{file=join(bundle,'index.html')}res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'));res.end(await readFile(file));}catch{res.writeHead(404);res.end()}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});const writes=[];
await page.route('**/api/v1/machines/*',async route=>{
 const id=new URL(route.request().url()).pathname.split('/').at(-1);if(route.request().method()!=='GET'){writes.push(route.request().url());return route.fulfill({status:500,json:{error:'unexpected write'}})}
 const key={id:'key-'+id,account_id:'account-'+id,username:'root',account_revision:1,method:'ssh_key',retention:'managed',expires_at:'2099-01-01T00:00:00Z',secret_fingerprint:'fixture'};
 const machine={id,name:id==='h1'?'Host one':'Host two',address:id+'.example.test',port:22,connection_method:'direct_ssh',host_key_status:'confirmed',agent_id:'',agent_status:'unknown',capabilities:{deploy_agent:{available:true,reason:''}},...(id==='h1'?{agent_runtime_mode:'user'}:{})};
 return route.fulfill({json:{machine,credentials:[key],deployments:[],uninstallations:[]}});
});
try{
 await page.goto(base);const checkbox=page.getByRole('checkbox',{name:'启用完整主机管理（安装 root 管理组件）',exact:true});
 await expect(checkbox).toBeVisible();await expect(checkbox).not.toBeChecked();await expect(checkbox).toBeEnabled();await checkbox.check();
 await expect(checkbox).toBeChecked();await page.getByRole('button',{name:'检查并生成批量计划',exact:true}).waitFor({state:'visible',timeoutMs:10000});
 await expect(checkbox).toBeChecked();expect(writes).toEqual([]);
 await writeFile(join(output,'batch-runtime.json'),JSON.stringify({passed:true,checks:['historical monitoring defaults batch to user','manual root selection remains checked after initialization','no plan or remote write was submitted']},null,2));console.log('PASS batch runtime inheritance and manual override');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(source,{recursive:true,force:true})}
