// Isolated bulk-action state gating. No production API or writes.
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {chromium,expect} from '@playwright/test';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),source=join(root,'.local-bulk-action-gates'),bundle=join(source,'bundle'),output=join(root,'../.local-dev/evidence/192-agent-lifecycle-fence-closure');
await mkdir(source,{recursive:true});await mkdir(output,{recursive:true});
await writeFile(join(source,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(source,'main.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{App,ConfigProvider}from'../shared/ui';import{I18nProvider}from'../shared/i18n';import Sidebar from'../app/SidebarNavigation';import Machines from'../app/MachinesPage';import'../app/style.css';import'../app/theme.css';import'../app/navigation.css';import'../app/machines.css';
const user={id:'qa-admin',name:'QA Admin',role:'admin',active:true};
createRoot(document.getElementById('root')).render(<I18nProvider><BrowserRouter><ConfigProvider><App><Sidebar pathname='/machines' role='admin' collapsed={false}/><Machines user={user} embedded={true}/></App></ConfigProvider></BrowserRouter></I18nProvider>);`);
await build({root:source,configFile:false,logLevel:'silent',build:{outDir:bundle,emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
const server=createServer(async(req,res)=>{try{let file=resolve(bundle,decodeURIComponent(new URL(req.url,'http://fixture').pathname).replace(/^\//,''));if(!file.startsWith(bundle+'/'))file=join(bundle,'index.html');try{if(!(await stat(file)).isFile())file=join(bundle,'index.html')}catch{file=join(bundle,'index.html')}res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'));res.end(await readFile(file));}catch{res.writeHead(404);res.end()}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const now=new Date().toISOString(),yes={available:true,reason:''},no={available:false,reason:'agent_already_installed'};
const host={id:'host-current',name:'zz-bj-1',address:'49.232.14.169',port:22,connection_method:'direct_ssh',host_key_fingerprint:'',host_key_status:'unconfigured',platform:'linux',arch:'',agent_id:'agent-current',agent_status:'online',agent_observed_at:now,agent_operation:null,agent_release:{version:'0.1.8',source_revision:'b9686762ac97',artifact_sha256:'a'.repeat(64),arch:'amd64'},agent_update:{state:'current'},default_account_id:'',accounts:[],credential_count:1,active_credential_count:1,active_ssh_credential_count:1,active_ssh_key_count:1,active_reusable_ssh_credential_count:1,ssh_recovery_available:true,capabilities:{terminal:yes,ssh_check:yes,deploy_agent:no,uninstall_agent:yes,recovery_uninstall_agent:yes,update_agent:yes,rollback_agent:yes},last_deployment_status:'succeeded',last_uninstallation_status:'',updated_at:now,created_at:now,label_ids:[],labels:[],cluster_id:'cluster',cluster_name:'zz-bj'};
const agents=[{id:'agent-current',machine_id:'host-current',hostname:'zz-bj-1',platform:'linux',arch:'amd64',version:'0.1.8',last_seen:now,lifecycle_state:'active',heartbeat:{}}];
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});const writes=[];
await page.route('**/api/v1/*',async route=>{if(route.request().method()!=='GET'){writes.push(route.request().url());return route.fulfill({status:500,json:{error:'unexpected write'}})}const path=new URL(route.request().url()).pathname;if(path==='/api/v1/machines')return route.fulfill({json:[host]});if(path==='/api/v1/agents')return route.fulfill({json:agents});if(path==='/api/v1/host-labels')return route.fulfill({json:[]});return route.fulfill({status:404,json:{error:'unexpected fixture path '+path}})});
try{
 await page.goto(base);
 await page.getByRole('button',{name:/Agent 管理 · zz-bj-1/}).click();
 await expect(page.getByRole('menuitem',{name:/部署 Agent/})).toBeDisabled();
 await expect(page.getByRole('menuitem',{name:/查看 Agent 更新/})).toBeEnabled();
 await expect(page.getByRole('menuitem',{name:/卸载 Agent/})).toBeEnabled();
 await expect(page.getByRole('menuitem',{name:/维护围栏与恢复/})).toBeEnabled();
 await page.keyboard.press('Escape');
 await page.getByRole('checkbox',{name:'选择 zz-bj-1'}).click();
 const toolbar=page.getByRole('region',{name:'批量操作'});
 await expect(toolbar.getByText('已选择 1 台',{exact:true})).toBeVisible();
 await expect(toolbar.getByRole('button',{name:'SSH 安装检查',exact:true})).toBeEnabled();
 await expect(toolbar.getByRole('button',{name:'部署 Agent',exact:true})).toBeDisabled();
 await expect(toolbar.getByRole('button',{name:'卸载 Agent',exact:true})).toBeEnabled();
 await expect(toolbar.getByRole('button',{name:'移除节点',exact:true})).toBeEnabled();
 await expect(toolbar.getByRole('button',{name:'删除主机',exact:true})).toBeDisabled();
 await expect(toolbar.getByRole('button',{name:'升级 Agent',exact:true})).toBeDisabled();
 await expect(toolbar.getByText(/SSH\/安装\/卸载等批次最多 50 台，Agent 升级批次最多 20 台/)).toBeVisible();
 expect(writes).toEqual([]);
 await page.screenshot({path:join(output,'bulk-action-gates.png'),fullPage:true});await writeFile(join(output,'bulk-action-gates.json'),JSON.stringify({passed:2,checks:['current installed host shows safe Agent-management actions','current installed host enables only applicable bulk actions and documents separate 50/20 limits'],writes},null,2));console.log(JSON.stringify({passed:2,checks:['current installed host shows safe Agent-management actions','current installed host enables only applicable bulk actions and documents separate 50/20 limits']}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(source,{recursive:true,force:true})}
