// Isolated unified image-management acceptance. No production API or mutation.
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {chromium,expect} from '@playwright/test';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),source=join(root,'.local-image-management'),bundle=join(source,'bundle'),output=join(root,'../.local-dev/evidence/182-unified-image-management');
await mkdir(source,{recursive:true});await mkdir(output,{recursive:true});
await writeFile(join(source,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(source,'main.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter,Routes,Route,Navigate}from'react-router-dom';import{App,ConfigProvider}from'../shared/ui';import{I18nProvider}from'../shared/i18n';import Sidebar from'../app/SidebarNavigation';import Page from'../app/ImageManagementPage';import'../app/style.css';import'../app/theme.css';import'../app/navigation.css';import'../app/operations.css';
createRoot(document.getElementById('root')).render(<I18nProvider><BrowserRouter><ConfigProvider><App><Sidebar pathname='/image-management' role='admin' collapsed={false}/><Routes><Route path='/image-management' element={<Page/>}/><Route path='/private-images' element={<Navigate to='/image-management?tab=registry' replace/>}/><Route path='/image-sources' element={<Navigate to='/image-management?tab=sources' replace/>}/></Routes></App></ConfigProvider></BrowserRouter></I18nProvider>);`);
await build({root:source,configFile:false,logLevel:'silent',build:{outDir:bundle,emptyOutDir:true,sourcemap:true},resolve:{dedupe:['react','react-dom']}});
const server=createServer(async(req,res)=>{try{let file=resolve(bundle,decodeURIComponent(new URL(req.url,'http://fixture').pathname).replace(/^\//,''));if(!file.startsWith(bundle+'/'))file=join(bundle,'index.html');try{if(!(await stat(file)).isFile())file=join(bundle,'index.html')}catch{file=join(bundle,'index.html')}res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'));res.end(await readFile(file));}catch{res.writeHead(404);res.end()}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,now=new Date().toISOString();
const cluster={id:'prod',kind:'cluster',name:'生产集群',revision:1,spec:{machine_ids:['host-a']},status:{}},site={id:'registry-site',name:'私有镜像仓库入口',revision:1,spec:{bindings:[{domains:['docker.doc-a.cn'],certificate_id:'cert'}],auth:{users:[{username:'panel'}]}}};
const registry={revision:1,application:{id:'sys-docker-registry',spec:{deployments:[]}},deployments:[{cluster_id:'prod',machine_id:'host-a',endpoint:'http://172.21.0.16:20000',cache_enabled:true,status:{last_error:'',cache_pending:false,applied_revision:1,desired_revision:1},host_ports:[]}],external:{carrier_cluster_id:'prod',website:site,revision:1},cleanup_run:null};
const overview={resources:[cluster],agents:[],runs:[],machines:[{id:'host-a',name:'Host A',agent_id:'agent-a',agent_status:'online'}]},queries=[],mutations=[];let registryReads=0;
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.stack??error.message));
await page.route('**/api/v1/**',async route=>{
 const request=route.request(),path=new URL(request.url()).pathname.replace(/^\/api\/v1/,''),method=request.method();
 if(path==='/ops/private-registry/images/query'&&method==='POST'){queries.push(request.postDataJSON());return route.fulfill({json:{id:'run-images',resource_id:'registry',resource_revision:1,agent_id:'agent-a',action:'inspect',state:'succeeded',result:{repositories:['ebookn/ebookn'],usage_complete:true},created_at:now,updated_at:now}})}
 if(method!=='GET'){mutations.push(path);return route.fulfill({status:500,json:{error:'unexpected mutation'}})}
 if(path==='/ops/private-registry'){registryReads++;return route.fulfill({json:registry})}
 if(path==='/ops/overview')return route.fulfill({json:overview});
 if(path==='/ops/registry-credentials')return route.fulfill({json:[{id:'credential-1',name:'绘本镜像仓库',registry:'docker.doc-a.cn',repository_prefix:'',cluster_ids:[],username:'panel',revision:1,expires_at:'',status:'active',references:[]}]});
 if(path==='/ops/resources'&&new URL(request.url()).searchParams.get('kind')==='cluster')return route.fulfill({json:{resources:[cluster]}});
 if(path==='/ops/image-sources')return route.fulfill({json:{revision:1,rules:[{source:'docker.io',target:'https://mirror.ccs.tencentyun.com',allow_upstream:true}]}});
 return route.fulfill({status:404,json:{error:'unexpected fixture path '+path}});
});
const checks=[];
try{
 await page.goto(base+'/private-images');await expect(page).toHaveURL(/\/image-management\?tab=registry$/);await expect(page.getByRole('heading',{name:'对外发布入口',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'镜像与版本',exact:true})).toHaveCount(0);checks.push('legacy private-images deep link opens registry tab only');
 await page.getByRole('tab',{name:'镜像与版本',exact:true}).click();await expect(page).toHaveURL(/tab=images/);await expect(page.getByRole('heading',{name:'镜像与版本',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'对外发布入口',exact:true})).toHaveCount(0);await page.getByRole('combobox',{name:'镜像',exact:true}).click();await expect(page.getByTitle('ebookn/ebookn',{exact:true})).toBeVisible();checks.push('images tab keeps registry summary and versions without publishing entry');
 await page.getByRole('tab',{name:'凭据与来源代理',exact:true}).click();await expect(page).toHaveURL(/tab=sources/);await expect(page.getByRole('heading',{name:'镜像仓库凭据',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'镜像来源代理',exact:true})).toBeVisible();await expect(page.getByText('绘本镜像仓库',{exact:true})).toBeVisible();await expect(page.getByLabel('代理仓库 / 路径前缀',{exact:true})).toHaveValue('https://mirror.ccs.tencentyun.com');checks.push('sources tab keeps credentials and proxy settings');
 await page.goto(base+'/image-sources');await expect(page).toHaveURL(/\/image-management\?tab=sources$/);await expect(page.getByRole('heading',{name:'镜像来源代理',exact:true})).toBeVisible();checks.push('legacy image-sources deep link opens sources tab');
 const links=await page.locator('nav a').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')));expect(links.filter(link=>link==='/image-management')).toHaveLength(1);expect(links).not.toContain('/private-images');expect(links).not.toContain('/image-sources');expect(mutations).toEqual([]);expect(registryReads).toBeLessThanOrEqual(2);await writeFile(join(output,'browser-results.json'),JSON.stringify({passed:checks.length,checks,queries,mutations,registryReads},null,2));await page.screenshot({path:join(output,'image-management-sources.png'),fullPage:true});console.log(JSON.stringify({passed:checks.length,checks}));
}catch(error){console.error('Page errors:',pageErrors);await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(source,{recursive:true,force:true})}
