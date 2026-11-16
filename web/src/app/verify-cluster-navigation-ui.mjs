// Isolated navigation and host-cluster acceptance. No production API or writes.
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {chromium,expect} from '@playwright/test';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),source=join(root,'.local-cluster-navigation'),bundle=join(source,'bundle'),output=join(root,'../.local-dev/evidence/181-cluster-navigation-ux');
await mkdir(source,{recursive:true});await mkdir(output,{recursive:true});
await writeFile(join(source,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(source,'main.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{App,ConfigProvider}from'../shared/ui';import{I18nProvider}from'../shared/i18n';import Sidebar from'../app/SidebarNavigation';import Machines from'../app/MachinesPage';import'../app/style.css';import'../app/theme.css';import'../app/navigation.css';import'../app/machines.css';
const user={id:'qa-admin',name:'QA Admin',role:'admin',active:true};
createRoot(document.getElementById('root')).render(<I18nProvider><BrowserRouter><ConfigProvider><App><Sidebar pathname='/clusters' role='admin' collapsed={false}/><Machines user={user} embedded={true}/></App></ConfigProvider></BrowserRouter></I18nProvider>);`);
await build({root:source,configFile:false,logLevel:'silent',build:{outDir:bundle,emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
const server=createServer(async(req,res)=>{try{let file=resolve(bundle,decodeURIComponent(new URL(req.url,'http://fixture').pathname).replace(/^\//,''));if(!file.startsWith(bundle+'/'))file=join(bundle,'index.html');try{if(!(await stat(file)).isFile())file=join(bundle,'index.html')}catch{file=join(bundle,'index.html')}res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'));res.end(await readFile(file));}catch{res.writeHead(404);res.end()}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const now=new Date().toISOString(),cap={available:false,reason:'agent_not_linked'},machine=(id,name,cluster_id,cluster_name)=>({id,name,address:id+'.example.test',port:22,connection_method:'direct_ssh',host_key_fingerprint:'',host_key_status:'unconfigured',platform:'linux',arch:'amd64',agent_id:'agent-'+id,agent_status:'online',agent_observed_at:now,agent_operation:null,default_account_id:'',accounts:[],credential_count:0,active_credential_count:0,active_ssh_credential_count:0,active_ssh_key_count:0,active_reusable_ssh_credential_count:0,ssh_recovery_available:false,capabilities:{terminal:cap,ssh_check:cap,deploy_agent:cap,uninstall_agent:cap,recovery_uninstall_agent:cap,update_agent:cap,rollback_agent:cap},last_deployment_status:'',last_uninstallation_status:'',updated_at:now,created_at:now,label_ids:[],labels:[],cluster_id,cluster_name});
const hosts=[machine('host-a','Host A','prod','生产集群'),machine('host-b','Host B','','')],agents=hosts.map(host=>({id:'agent-'+host.id,machine_id:host.id,hostname:host.name,platform:'linux',arch:'amd64',version:'0.1.5',last_seen:now,lifecycle_state:'active',heartbeat:{}})),writes=[];
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
await page.route('**/api/v1/*',async route=>{
 const path=new URL(route.request().url()).pathname;if(route.request().method()!=='GET'){writes.push(route.request().url());return route.fulfill({status:500,json:{error:'unexpected write'}})}
 if(path==='/api/v1/machines')return route.fulfill({json:hosts});if(path==='/api/v1/agents')return route.fulfill({json:agents});if(path==='/api/v1/host-labels')return route.fulfill({json:[]});return route.fulfill({status:404,json:{error:'unexpected fixture path '+path}});
});
const checks=[];
try{
 await page.goto(base);await expect(page.getByRole('link',{name:'集群管理',exact:true})).toBeVisible();
 const links=await page.locator('nav a').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')));expect(links.indexOf('/image-management')).toBeLessThan(links.indexOf('/clusters'));expect(links.indexOf('/clusters')).toBeLessThan(links.indexOf('/applications'));
 const cluster=page.getByRole('link',{name:'生产集群',exact:true});await expect(cluster).toHaveAttribute('href','/clusters?resource=prod');await expect(page.getByText('未分配集群',{exact:true})).toBeVisible();await expect(page.getByText('Host A',{exact:true})).toBeVisible();await expect(page.getByText('Host B',{exact:true})).toBeVisible();checks.push('sidebar order, cluster detail link and unassigned display');
 await page.goto(base+'/?cluster=unassigned');await expect(page.getByText('Host B',{exact:true})).toBeVisible();await expect(page.getByText('Host A',{exact:true})).toHaveCount(0);checks.push('unassigned deep-link filter');
 await page.goto(base+'/?cluster=prod');await expect(page.getByText('Host A',{exact:true})).toBeVisible();await expect(page.getByText('Host B',{exact:true})).toHaveCount(0);checks.push('cluster ID deep-link filter');
 expect(writes).toEqual([]);await page.screenshot({path:join(output,'cluster-hosts.png',),fullPage:true});await writeFile(join(output,'browser-results.json'),JSON.stringify({passed:checks.length,checks,writes},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(source,{recursive:true,force:true})}
