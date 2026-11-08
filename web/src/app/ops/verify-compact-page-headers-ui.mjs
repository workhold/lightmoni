import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';

const root=resolve(import.meta.dirname,'../../../..'),output=resolve(root,'specs/106-compact-page-headers/evidence'),media=mediaDirectory(output);
await mkdir(output,{recursive:true});
const now=new Date().toISOString(),resources=[
 {id:'cluster',kind:'cluster',name:'北京集群',revision:1,spec:{machine_ids:['machine']},status:{}},
 {id:'app',kind:'application',name:'订单服务 · 卸载后保留数据',revision:3,spec:{service_name:'orders-api',role:'generic',source:{type:'custom'},deployment_mode:'manual',mode:'container',image:'registry.example.test/commerce/orders:20261107',ports:[],deployments:[{cluster_id:'cluster',machine_ids:['machine'],cpu:0.25,memory_mb:128}]},status:{instances:[{id:'instance',state:'removed',cluster_id:'cluster',machine_id:'machine'}]}},
 {id:'gateway',kind:'application',name:'OpenResty',revision:4,spec:{role:'openresty',service_name:'sys-openresty',deployments:[{cluster_id:'cluster',machine_ids:['machine']}],ports:[]},status:{instances:[{id:'entry',state:'running',healthy:true,cluster_id:'cluster',machine_id:'machine'}]}},
 {id:'site',kind:'website',name:'订单与售后服务',revision:5,spec:{cluster_ids:['cluster'],routing_mode:'manual',mode:'static',bindings:[{domains:['orders.example.test'],locations:[]}]},status:{}},
].map(r=>({...r,created_at:now,updated_at:now}));
const reads=new Map(),unknown=new Set();let writes=0;
const user={id:'qa',name:'QA',nickname:'QA',role:'admin',active:true};
const fixture=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture'),path=url.pathname.replace('/api/v1',''),referer=new URL(req.headers.referer??'http://fixture'),mode=referer.searchParams.get('fixture');reads.set(path,(reads.get(path)??0)+1);res.setHeader('content-type','application/json');
 if(!['GET','HEAD'].includes(req.method)){writes++;res.writeHead(405);res.end(JSON.stringify({error:'fixture_is_read_only'}));return}
 let result=[];
 if(path==='/auth/me'||path==='/auth/profile')result=user;
 else if(path==='/ops/overview'){
  if(mode==='error'){res.writeHead(503);res.end(JSON.stringify({error:'fixture_load_failed'}));return}
  result={resources:mode==='setup'?resources.filter(r=>r.id!=='gateway'):resources,agents:[],runs:[],machines:[{id:'machine',name:'zz-bj-1'}]};
 }else if(path==='/ops/resources/app/monitoring')result={application:resources.find(r=>r.id==='app'),hosts:[],deployments:[],websites:[]};
 else if(path.includes('telemetry'))result={website:resources.find(r=>r.id==='site'),results:{},hosts:[],range:{from:now,to:now}};
 else if(path==='/ops/catalog')result={templates:[]};
 else if(path==='/ops/image-sources')result={revision:1,rules:[]};
 else if(path==='/ops/private-registry')result=mode==='empty'?{}:{application:{...resources.find(r=>r.id==='app'),spec:{role:'registry'}},deployments:[]};
 else if(path==='/mcp-access')result={endpoint:'https://moni.example.test/mcp',scopes:['catalog.read'],tokens:[],grants:[],clients:[]};
 else if(path==='/sdk-install')result={version:'0.1.0',packages:[],node_url:'',go_url:'',checksums_url:''};
 else if(path==='/overview')result={counts:{},tables:[],agents:[],alerts:[]};
 else if(path==='/settings/instance')result={external_url:'https://moni.example.test'};
 else if(path==='/auth/preferences')result={};
 else if(path==='/ops/runs')result=[];
 else if(!['/catalog/tables','/dashboards','/dashboards/templates','/machines','/agents','/agent-task-labels','/agent-tasks','/agent-jobs','/agent-task-runs','/agent-operations','/connection-credentials','/keys','/sdk-exempt-tables','/users','/settings/login-providers','/auth/providers','/auth/identities','/logs/saved'].includes(path))unknown.add(path);
 res.end(JSON.stringify(result));
});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));process.env.LIGHTMONI_DEV_API_URL='http://127.0.0.1:'+fixture.address().port;
const vite=await createViteServer({root:resolve(root,'web'),configFile:resolve(root,'web/vite.config.ts'),server:{host:'127.0.0.1',port:5206,strictPort:true},logLevel:'error'});await vite.listen();
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const routes=['/applications','/applications?view=store','/websites','/clusters','/domains','/certificates','/machines','/private-images','/private-images?fixture=empty','/image-sources','/connection-credentials','/data-management','/data?tab=keys','/settings','/admin','/mcp-access','/dashboards','/overview','/applications/app/monitoring','/websites/site/monitoring','/logs','/websites?fixture=setup','/applications?fixture=error'];
const rounds=[],observedErrors=[];let activePage,activeCase,failure;
const within=async(page,selector)=>{for(const item of await page.locator(selector).all()){if(!await item.isVisible())continue;const b=await item.boundingBox();if(b.width>page.viewportSize().width+1||b.x< -1||b.x+b.width>page.viewportSize().width+1)throw Error('overflow '+selector+' '+JSON.stringify(b))}};
try{
 for(let round=1;round<=3;round++){
  const checks=[],errors=[];
  for(const language of ['zh-CN','en-US'])for(const width of [390,1440]){
   const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});await context.addInitScript(lang=>localStorage.setItem('lightmoni.language',lang),language);const page=activePage=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);observedErrors.push({case:activeCase,message:e.message})});
   for(const route of routes){activeCase={route,language,width,round};
    await page.goto('http://127.0.0.1:5206'+route);await expect(page.locator('.lm-route-content>.lm-page')).toBeVisible();await expect(page.locator('.lm-route-content>.lm-page .lm-page-heading')).toHaveCount(0);await expect(page.locator('.lm-route-content>.lm-page h1')).toHaveCount(0);await expect(page.locator('.lm-workspace-header [role="heading"]')).toBeVisible();
    // Await the page's actual ready state, rather than taking an initial spinner as evidence.
    if(route==='/applications'){
     await expect(page.getByRole('article',{name:'OpenResty',exact:true})).toBeVisible();const search=page.getByRole('searchbox',{name:language==='zh-CN'?'搜索资源':'Search resources'});await search.fill('OpenResty');const before=reads.get('/ops/overview')??0;await page.locator('.lm-ops-section-heading').getByRole('button',{name:language==='zh-CN'?'刷新':'Refresh',exact:true}).click();await expect.poll(()=>reads.get('/ops/overview')??0).toBeGreaterThan(before);await expect(search).toHaveValue('OpenResty');await search.clear();await expect(page.locator('.lm-ops-section-heading').getByRole('button',{name:language==='zh-CN'?'操作日志':'Operation logs',exact:true})).toBeVisible();
    }
    if(route==='/private-images')await expect(page.locator('.lm-ops-subheading').getByRole('button',{name:language==='zh-CN'?'刷新':'Refresh',exact:true})).toBeVisible();
    if(route==='/private-images?fixture=empty')await expect(page.getByRole('button',{name:language==='zh-CN'?'刷新':'Refresh',exact:true})).toBeVisible();
    if(route==='/websites?fixture=setup')await expect(page.getByRole('button',{name:language==='zh-CN'?'刷新':'Refresh',exact:true})).toBeVisible();
    await within(page,'.lm-ops-section-heading button,.lm-content-toolbar button,.ant-tabs-extra-content button');
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);if(overflow)throw Error('document overflow: '+route+' '+language+' '+width);
    if(round===3&&['/applications','/websites','/machines','/data-management','/private-images','/dashboards'].includes(route))await page.screenshot({path:resolve(media,language+'-'+width+'-'+route.slice(1)+'.png'),fullPage:false,animations:'disabled'});
    checks.push({route,language,width});
   }
   if(width===1440){for(const route of ['/applications','/websites','/data-management']){await page.goto('http://127.0.0.1:5206'+route);await expect(page.locator('.lm-route-content>.lm-page')).toBeVisible();await page.evaluate(()=>document.documentElement.style.zoom='2');await within(page,'.lm-ops-section-heading button,.lm-content-toolbar button');await page.evaluate(()=>document.documentElement.style.zoom='');checks.push({route,language,width,zoom:2})}}
   await context.close();
  }
  if(errors.length)throw Error(JSON.stringify(errors));rounds.push({round,passed:checks.length,checks,errors});console.log(JSON.stringify({round,passed:checks.length}));
 }
}catch(error){failure=String(error);if(activePage&&!activePage.isClosed())await activePage.screenshot({path:resolve(media,'failure.png'),fullPage:true});throw error}
finally{await writeFile(resolve(output,'ui-report.json'),JSON.stringify({rounds,writes,observedErrors,failure,activeCase,unknown_fixture_reads:[...unknown],media_directory:media,source:'real workspace pages through the project Vite/PW harness; synthetic read-only API'},null,2)+'\n');await browser.close();await vite.close();await new Promise(done=>fixture.close(done))}
if(writes)throw Error('unexpected write request');
