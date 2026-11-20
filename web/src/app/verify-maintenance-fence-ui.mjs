// Isolated browser acceptance for the durable maintenance-fence recovery dialog.
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {chromium,expect} from '@playwright/test';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),source=join(root,'.local-maintenance-fence'),bundle=join(source,'bundle'),output=join(root,'../.local-dev/evidence/192-agent-lifecycle-fence-closure');
await mkdir(source,{recursive:true});await mkdir(output,{recursive:true});
await writeFile(join(source,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(source,'main.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{App,ConfigProvider}from'../shared/ui';import{I18nProvider}from'../shared/i18n';import MachineMaintenanceFenceDialog from '../app/MachineMaintenanceFenceDialog';import'../app/style.css';import'../app/theme.css';import'../app/machines.css';
createRoot(document.getElementById('root')).render(<I18nProvider><BrowserRouter><ConfigProvider><App><MachineMaintenanceFenceDialog machine={{id:'host-a',name:'Host A'}} onClose={()=>{}} onRefresh={async()=>{}}/></App></ConfigProvider></BrowserRouter></I18nProvider>);`);
await build({root:source,configFile:false,logLevel:'silent',build:{outDir:bundle,emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
const server=createServer(async(req,res)=>{try{let file=resolve(bundle,decodeURIComponent(new URL(req.url,'http://fixture').pathname).replace(/^\//,''));if(!file.startsWith(bundle+'/'))file=join(bundle,'index.html');try{if(!(await stat(file)).isFile())file=join(bundle,'index.html')}catch{file=join(bundle,'index.html')}res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'));res.end(await readFile(file));}catch{res.writeHead(404);res.end()}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
let unresolved=true;const writes=[];let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const page=await browser.newPage({viewport:{width:1200,height:900},reducedMotion:'reduce'});
await page.route('**/api/v1/machines/host-a/busy',route=>route.fulfill({json:{machine_id:'host-a',busy:false,maintenance_blockers:unresolved?[{kind:'executor_bootstrap',id:'legacy-bootstrap-1234567890',state:'unknown'}]:[]}}));
await page.route('**/api/v1/machines/host-a/executor-bootstraps/*/reconcile',async route=>{writes.push(route.request().postDataJSON());unresolved=false;return route.fulfill({json:{id:'legacy-bootstrap-1234567890',status:'unknown',resolved_at:new Date().toISOString(),resolved_by:'qa-admin',resolution_reason:'current executor heartbeat verified'}})});
const checks=[];
try{
 await page.goto(base);
 await expect(page.getByRole('dialog',{name:'维护围栏与恢复'})).toBeVisible();
 await expect(page.getByText('历史首装执行器')).toBeVisible();
 await expect(page.getByText('legacy-bootstrap-1234567890')).toBeVisible();
 await expect(page.getByText('unknown',{exact:true})).toBeVisible();
 checks.push('durable blocker type, id and state are visible');
 await page.getByRole('button',{name:'选择人工闭环'}).click();
 const close=page.getByRole('button',{name:'确认闭环历史围栏'});
 await expect(close).toBeDisabled();
 checks.push('closure requires confirmation and reason');
 await page.getByRole('checkbox',{name:/我已核对当前执行器在线/}).check();
 await page.getByRole('textbox',{name:'闭环原因'}).fill('current executor heartbeat verified');
 await close.click();
 await expect(page.getByText('legacy-bootstrap-1234567890')).toHaveCount(0);
 await expect(page.getByText('历史围栏已人工闭环',{exact:true})).toBeVisible();
 expect(writes).toEqual([{confirm:true,reason:'current executor heartbeat verified'}]);
 checks.push('explicit admin closure preserves unknown and clears the fence projection');
 await page.screenshot({path:join(output,'maintenance-fence.png'),fullPage:true});
 await writeFile(join(output,'browser-results.json'),JSON.stringify({passed:checks.length,checks,writes},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(source,{recursive:true,force:true})}
