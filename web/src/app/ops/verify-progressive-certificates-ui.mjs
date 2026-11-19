import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';

const root=resolve(import.meta.dirname,'../../../..'),output=resolve(root,'specs/187-progressive-ops-certificates/evidence'),media=mediaDirectory(output);
await mkdir(output,{recursive:true});
const now=new Date().toISOString(),resources=[
 {id:'cluster',kind:'cluster',name:'测试集群',revision:1,spec:{machine_ids:['machine']},status:{}},
 {id:'gateway',kind:'application',name:'OpenResty',revision:1,spec:{role:'openresty',source:{type:'store'},service_name:'gateway',deployment_mode:'manual',mode:'container',deployments:[{cluster_id:'cluster',machine_ids:['machine']}],ports:[]},status:{}},
 {id:'app',kind:'application',name:'订单应用',revision:1,spec:{role:'generic',source:{type:'custom'},service_name:'orders',deployment_mode:'manual',mode:'container',image:'orders:qa',deployments:[{cluster_id:'cluster',machine_ids:['machine'],cpu:1,memory_mb:128}],ports:[]},status:{}},
 {id:'managed-cert',kind:'certificate',name:'managed.example.test',revision:1,spec:{source:'acme',domains:['managed.example.test']},status:{certificate_version:'v1'}},
 {id:'site',kind:'website',name:'订单网站',revision:1,spec:{mode:'static',routing_mode:'manual',dns_record_mode:'cname',cluster_ids:['cluster'],bindings:[{domains:['first.example.test'],https:true,certificate_id:'managed-cert',dns_enabled:false,locations:[]},{domains:['second.example.test'],https:true,certificate_id:'managed-cert',dns_enabled:false,locations:[]}],nginx:{tls_protocols:['TLSv1.2','TLSv1.3']}},status:{deployments:{}}},
].map(resource=>({...resource,created_at:now,updated_at:now}));
let writes=0,savedCertificate,savedWebsite;
const fixture=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture'),path=url.pathname.replace('/api/v1','');
 res.setHeader('content-type','application/json');
 if(path==='/auth/me'){res.end(JSON.stringify({id:'qa',name:'QA',role:'admin'}));return}
 if(path==='/ops/overview'){res.end(JSON.stringify({resources,agents:[],runs:[],machines:[{id:'machine',name:'测试机器',cluster_id:'cluster'}]}));return}
 if(path==='/ops/inventory'){res.end(JSON.stringify({applications:resources.filter(resource=>resource.kind==='application')}));return}
 if(path.endsWith('/storage')){res.end(JSON.stringify({instances:[],next_offset:null}));return}
 if(path==='/ops/resources'&&req.method==='GET'){
  const selected=resources.filter(resource=>!url.searchParams.get('kind')||resource.kind===url.searchParams.get('kind'));
  res.end(JSON.stringify({resources:url.searchParams.get('view')==='config'?selected.map(({status,...config})=>config):selected,total:selected.length,limit:1000,offset:0,next_offset:null}));return;
 }
 if(path==='/ops/resources'&&req.method==='POST'){
  writes++;const body=JSON.parse(await new Promise(done=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>done(text))}));
  if(body.kind==='certificate'){
   if(!body.spec.certificate_pem?.includes('BEGIN CERTIFICATE')||!body.spec.private_key_pem?.includes('PRIVATE KEY')){res.writeHead(400);res.end(JSON.stringify({error:'certificate_material_required'}));return}
   savedCertificate=body;
   const {certificate_pem,private_key_pem,...spec}=body.spec;
   const resource={id:'uploaded-cert',kind:'certificate',name:spec.domains[0],revision:1,spec:{...spec,has_certificate:true,has_private_key:true},status:{certificate_version:'v2'},created_at:now,updated_at:now};
   resources.push(resource);res.writeHead(201);res.end(JSON.stringify({resource}));return;
  }
 }
 if(path==='/ops/resources/site'&&req.method==='PUT'){
  writes++;const body=JSON.parse(await new Promise(done=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>done(text))}));savedWebsite=body;
  const site=resources.find(resource=>resource.id==='site');site.spec=body.spec;site.revision++;res.end(JSON.stringify({resource:site}));return;
 }
 res.end(JSON.stringify({}));
});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));
process.env.LIGHTMONI_DEV_API_URL='http://127.0.0.1:'+fixture.address().port;
const vite=await createViteServer({root:resolve(root,'web'),configFile:resolve(root,'web/vite.config.ts'),server:{host:'127.0.0.1',port:5217,strictPort:true},logLevel:'error'});await vite.listen();
let browser,dir;const checks=[],errors=[];
try{
 try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('lightmoni.language','zh-CN'));
 let releaseOverview;const holdOverview=()=>{let promise=new Promise(done=>releaseOverview=done);return promise};
 let gate=holdOverview();
 await page.route('**/api/v1/ops/overview',async route=>{await gate;await route.continue()});
 await page.goto('http://127.0.0.1:5217/applications');
 const app=page.getByRole('article',{name:'订单应用',exact:true});
 await expect(app).toBeVisible();await expect(app.getByText('加载中',{exact:true})).toBeVisible();
 await expect(app.getByRole('button',{name:'配置',exact:true})).toBeDisabled();
 await page.screenshot({path:resolve(media,'application-config-first.png'),animations:'disabled'});
 checks.push('应用配置在总览响应延迟时先显示，状态为加载中且依赖状态的操作禁用');
 releaseOverview();await expect(app.getByText('加载中',{exact:true})).toHaveCount(0);await expect(app.getByRole('button',{name:'配置',exact:true})).toBeEnabled();
 await page.unroute('**/api/v1/ops/overview');
 let releaseInventory;const inventoryGate=new Promise(done=>releaseInventory=done);
 await page.route('**/api/v1/ops/inventory*',async route=>{await inventoryGate;await route.continue()});
 await page.goto('http://127.0.0.1:5217/applications?machine=machine');
 await expect(page.getByRole('article',{name:'订单应用',exact:true})).toHaveCount(0);
 releaseInventory();await expect(page.getByRole('article',{name:'订单应用',exact:true})).toBeVisible();
 await page.unroute('**/api/v1/ops/inventory*');
 checks.push('按主机筛选在清单到达前不显示错误的应用匹配');
 await page.route('**/api/v1/ops/overview',async route=>{await gate;await route.continue()});
 gate=holdOverview();await page.goto('http://127.0.0.1:5217/websites');
 const site=page.getByRole('article',{name:'订单网站',exact:true});await expect(site).toBeVisible();
 await expect(site.getByText('加载中',{exact:true}).first()).toBeVisible();await expect(site.getByRole('button',{name:'编辑配置',exact:true})).toBeDisabled();
 releaseOverview();await expect(site.getByText('未发布',{exact:true})).toBeVisible();
 checks.push('网站配置先展示；发布与 DNS 状态随后替换加载中');
 await page.unroute('**/api/v1/ops/overview');
 let releaseStale;const staleGate=new Promise(done=>releaseStale=done);let overviewCalls=0;
 await page.route('**/api/v1/ops/overview',async route=>{if(++overviewCalls===1)await staleGate;try{await route.continue()}catch{}});
 await page.goto('http://127.0.0.1:5217/applications');await expect(app.getByText('加载中',{exact:true})).toBeVisible();
 await page.getByRole('link',{name:'网站',exact:true}).click();await expect(site.getByText('未发布',{exact:true})).toBeVisible();
 releaseStale();await expect(page).toHaveURL(/\/websites$/);await expect(app).toHaveCount(0);
 await page.unroute('**/api/v1/ops/overview');
 checks.push('旧页面的迟到响应不能覆盖导航后的新页面');
 await page.route('**/api/v1/ops/overview',route=>route.fulfill({status:503,json:{error:'status_fixture_failed'}}));
 await page.goto('http://127.0.0.1:5217/applications');await expect(app).toBeVisible();
 await expect(app.getByText('加载失败',{exact:true})).toBeVisible();await expect(page.getByText('status_fixture_failed')).toBeVisible();
 checks.push('总览失败保留应用配置，状态显示加载失败');
 await page.unroute('**/api/v1/ops/overview');
 await page.getByRole('button',{name:'重试',exact:true}).click();await expect(app.getByRole('button',{name:'配置',exact:true})).toBeEnabled();
 await page.goto('http://127.0.0.1:5217/certificates');await expect(page.getByRole('button',{name:'新建证书',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'新建证书',exact:true}).click();
 const modal=()=>page.locator('.ant-modal:visible').last();
 await modal().getByLabel('证书来源',{exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText('上传证书',{exact:true}).click();
 await modal().getByLabel('证书域名',{exact:true}).fill('second.example.test');
 dir=await mkdtemp(join(tmpdir(),'lightmoni-cert-ui-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'private.key'),'-out',join(dir,'chain.pem'),'-days','3','-subj','/CN=second.example.test','-addext','subjectAltName=DNS:second.example.test'],{stdio:'ignore'});
 const chain=await readFile(join(dir,'chain.pem')),key=await readFile(join(dir,'private.key'));
 await modal().locator('.ant-upload input[type=file]').nth(0).setInputFiles({name:'oversized.pem',mimeType:'application/x-pem-file',buffer:Buffer.alloc(128*1024+1,65)});
 await expect(modal().getByText('文件为空或超过大小限制（证书链 128 KiB，私钥 64 KiB）。')).toBeVisible();
 await modal().locator('.ant-upload input[type=file]').nth(0).setInputFiles({name:'chain.pem',mimeType:'application/x-pem-file',buffer:chain});
 await modal().locator('.ant-upload input[type=file]').nth(1).setInputFiles({name:'private.key',mimeType:'application/x-pem-file',buffer:key});
 await expect(modal().getByText('已读取私钥文件：',{exact:false})).toBeVisible();
 expect(writes).toBe(0);
 await modal().getByRole('button',{name:'保存并开始执行',exact:true}).click();await expect(modal()).toBeHidden();
 expect(savedCertificate.spec.certificate_pem).toBe(chain.toString());expect(savedCertificate.spec.private_key_pem).toBe(key.toString());
 checks.push('本地 PEM 选择不提前上传；保存沿用证书资源接口且私钥不回显在公开资源');
 await page.goto('http://127.0.0.1:5217/websites');await site.getByRole('button',{name:'编辑配置',exact:true}).click();
 await modal().getByText('站点：HTTPS与HTTP/2',{exact:true}).click();
 const certificateSelect=modal().getByLabel('second.example.test',{exact:true});await certificateSelect.click();
 await page.locator('.ant-select-dropdown:visible').getByText('second.example.test · 手动上传 · 可用',{exact:true}).click();
 await modal().getByRole('button',{name:'保存配置',exact:true}).click();await expect(modal()).toBeHidden();
 expect(savedWebsite.spec.bindings.map(binding=>binding.certificate_id)).toEqual(['managed-cert','uploaded-cert']);
 await page.locator('.ant-drawer:visible').last().locator('.ant-drawer-close').click();
 await site.getByRole('button',{name:'编辑配置',exact:true}).click();await modal().getByText('站点：HTTPS与HTTP/2',{exact:true}).click();
 await expect(modal().getByText('second.example.test · 手动上传 · 可用',{exact:true})).toBeVisible();
 await modal().getByText('second.example.test · 手动上传 · 可用',{exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:resolve(media,'website-https-certificates.png'),animations:'disabled'});
 checks.push('HTTPS 设置逐绑定选择平台或上传证书，保存并重新打开保留证书引用');
 expect(errors).toEqual([]);
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({checks,writes,page_errors:errors,source:'isolated local HTTP fixture and real Vite pages; generated ephemeral certificate pair'},null,2));
 console.log(JSON.stringify({checks,writes}));
}finally{if(browser)await browser.close();await vite.close();fixture.close();fixture.closeAllConnections();if(dir)await rm(dir,{recursive:true,force:true})}
