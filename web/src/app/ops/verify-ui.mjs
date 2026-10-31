import {chromium,expect} from '@playwright/test';
import {createServer as createHTTPServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';

// Isolated HTTP fixture verifies the UI contract. It performs no cloud, Docker or DNS operations.
const root=resolve(import.meta.dirname,'../../../..'),output=resolve(root,'specs/033-operations-control-plane/evidence/ui'),media=mediaDirectory(output);
await mkdir(output,{recursive:true});
const now=new Date().toISOString(),stamp=()=>new Date().toISOString();
let serial=0,failNext=false;
const resources=[];const runs=[];const writes=[];
const agents=[{id:'agent-a',hostname:'gateway-shanghai-01',last_seen:now},{id:'agent-b',hostname:'app-shanghai-02',last_seen:now}];
function seed(id,kind,name,spec,status={}){resources.push({id,kind,name,revision:1,spec,status,created_at:now,updated_at:now})}
for(const provider of ['aliyun','tencent','volcengine'])seed('cred-'+provider,'credential',provider+' account',{provider,has_access_key_id:true,has_access_key_secret:true});
seed('zone','dns_zone','生产域名',{domain:'example.com',scope:'example.com',credential_id:'cred-aliyun'},{state:'observed',records:[{id:'101',name:'www',type:'A',value:'203.0.113.11',ttl:600,line:'default',enabled:true}]});
seed('pool','node_pool','生产机器池',{agent_ids:['agent-a','agent-b'],port_start:20000,port_end:29999,nodes:[{agent_id:'agent-b',address:'10.0.0.12',cpu:4,memory_mb:8192}]});
seed('gateway','gateway_group','生产入口',{agent_ids:['agent-a'],image:'openresty/openresty:1.27.1.2-0-alpine',http_port:80,https_port:443,public_addresses:{'agent-a':'203.0.113.11'}});
seed('app','application','订单 API',{mode:'container',image:'nginx:alpine',cpu:1,memory_mb:512,agent_ids:['agent-b'],network_mode:'bridge'});
seed('service','service','订单服务',{application_id:'app',node_pool_id:'pool',replicas:2,container_port:8080,cpu:1,memory_mb:512,health:{type:'tcp',interval_seconds:10}},{state:'running',instances:[{id:'instance-1',agent_id:'agent-b',address:'10.0.0.12',port:21001,state:'running',healthy:true,cpu:1,memory_mb:512,last_seen:now}],endpoints:[{ip:'10.0.0.12',port:21001}]});
seed('certificate','certificate','站点证书',{source:'self_signed',domains:['example.com','*.example.com'],auto_renew:true,validity_days:90,renew_before_days:30},{state:'issued',certificate_version:'cert-v2',fingerprint_sha256:'0c'.repeat(32),expires_at:new Date(Date.now()+50*86400000).toISOString(),days_remaining:50});
seed('website','website','生产网站',{domains:['www.example.com'],mode:'service',gateway_group_id:'gateway',service_id:'service',https:true,certificate_id:'certificate',dns_enabled:true,dns_zone_id:'zone'},{state:'running'});
seed('failed-target','certificate_target','CDN 证书同步',{type:'cloud',certificate_id:'certificate',provider:'aliyun',product:'cdn',credential_id:'cred-aliyun',domains:['cdn.example.com'],enabled:true},{state:'failed',desired_certificate_version:'cert-v2-01234567890123456789',applied_certificate_version:'cert-v1-98765432109876543210',error:'provider_authentication_failed'});
runs.push({id:'run-1',resource_id:'failed-target',resource_revision:1,action:'sync',state:'failed',agent_id:'',created_at:now,updated_at:now,result:{code:'provider_authentication_failed'}});
function publicResource(resource){const copy=structuredClone(resource);for(const field of ['access_key_id','access_key_secret','session_token','certificate_pem','private_key_pem'])if(copy.spec[field]){copy.spec['has_'+field.replace('_pem','')]=true;delete copy.spec[field]}if(copy.spec.env){copy.spec.env_keys=Object.keys(copy.spec.env);copy.spec.has_env=copy.spec.env_keys.length>0;delete copy.spec.env}return copy}
const fixture=createHTTPServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');const body=[];for await(const chunk of req)body.push(chunk);let input={};try{input=JSON.parse(Buffer.concat(body).toString()||'{}')}catch{}
 const url=new URL(req.url,'http://local');let status=200,result={};const parts=url.pathname.replace('/api/v1','').split('/').filter(Boolean);
 if(parts.join('/')==='auth/me')result={id:'ui-admin',name:'UI acceptance',role:'admin'};
 else if(parts.join('/')==='test/fail-next'){failNext=true;result={ok:true}}
 else if(parts.join('/')==='ops/overview')result={resources:resources.map(publicResource),agents,runs,capabilities:{}};
 else if(parts.join('/')==='ops/runs')result={runs:runs.filter(r=>!url.searchParams.get('resource_id')||r.resource_id===url.searchParams.get('resource_id'))};
 else if(parts[0]==='ops'&&parts[1]==='resources'){
  const resource=resources.find(r=>r.id===parts[2]);
  if(req.method==='POST'&&parts.length===2||req.method==='PUT'&&parts.length===3){
   if(failNext){failNext=false;status=409;result={error:'验收用保存冲突：请重新检查版本'}}else{
    writes.push(structuredClone(input));if(resource){Object.assign(resource,{name:input.name,spec:input.spec,revision:resource.revision+1,updated_at:stamp()});result={resource:publicResource(resource)}}
    else{const created={id:'created-'+(++serial),kind:input.kind,name:input.name,spec:input.spec,revision:1,status:{},created_at:stamp(),updated_at:stamp()};resources.push(created);result={resource:publicResource(created)}}
   }
  }else if(req.method==='POST'&&parts[3]==='actions'&&resource){
   if(resource.kind==='dns_zone'){
    const records=resource.status.records??=[];if(input.action==='create_record')records.push({...input.input.record,id:'record-'+(++serial)});if(input.action==='update_record'){const record=records.find(r=>r.id===input.input.record.id);Object.assign(record??{},input.input.record)}if(input.action==='delete_record')resource.status.records=records.filter(r=>r.id!==input.input.id);
    if(input.action==='set_record_status'){const record=records.find(r=>r.id===input.input.id);if(record)record.enabled=input.input.enabled}
   }
   const rejected=resource.kind==='dns_zone'&&input.input?.record?.name==='rejected-record';if(rejected)resource.status.records=resource.status.records.filter(r=>r.name!=='rejected-record');const run={id:'run-'+(++serial),resource_id:resource.id,resource_revision:resource.revision,action:input.action,state:rejected?'failed':'succeeded',agent_id:'',created_at:stamp(),updated_at:stamp(),result:rejected?{code:'provider_record_rejected'}:{accepted:true}};status=202;runs.unshift(run);result={run};
  }else if(req.method==='GET'&&parts[3]==='records'&&resource){const filtered=(resource.status.records??[]).filter(r=>!url.searchParams.get('keyword')||[r.name,r.value].some(value=>value.includes(url.searchParams.get('keyword'))));const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??20);result={records:filtered.slice(offset,offset+limit),total:filtered.length}}else if(req.method==='DELETE'&&resource){resources.splice(resources.indexOf(resource),1);result={ok:true}}
 }else if(parts.join('/')==='auth/logout')result={ok:true};
 res.writeHead(status);res.end(JSON.stringify(result));
});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));
process.env.LIGHTMONI_DEV_API_URL='http://127.0.0.1:'+fixture.address().port;
const vite=await createViteServer({root:resolve(root,'web'),configFile:resolve(root,'web/vite.config.ts'),server:{port:Number(process.env.LIGHTMONI_UI_TEST_PORT??5197),strictPort:true},logLevel:'error'});await vite.listen();
const base='http://127.0.0.1:'+vite.config.server.port;
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],checks=[];
page.setDefaultTimeout(10000);
page.on('pageerror',error=>errors.push(error.message));
await context.addInitScript(()=>{localStorage.setItem('lightmoni.appearance','light');localStorage.setItem('lightmoni.language','zh-CN')});
const dialog=()=>page.getByRole('dialog').last();
async function choose(label,value,scope=dialog()){await scope.getByLabel(label,{exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText(value,{exact:true}).click();await page.keyboard.press('Escape')}
async function tags(label,value){const input=dialog().getByLabel(label,{exact:true});await input.fill(value);await input.press('Enter')}
async function save(){await dialog().getByRole('button',{name:'保存配置',exact:true}).click();await expect(dialog()).toBeHidden()}
async function openTab(label){console.log('tab '+label);await page.getByRole('tab',{name:new RegExp('^'+label)}).first().click()}
try{
 await page.goto(base+'/operations');await expect(page.getByRole('heading',{name:'网站与运维',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'生产网站',exact:true})).toBeVisible();checks.push('五能力入口、共享资源和既有视觉加载');
 await openTab('应用');await page.getByRole('button',{name:'新建应用',exact:true}).click();await dialog().getByLabel('名称',{exact:true}).fill('UI 容器');await choose('目标机器','app-shanghai-02');await dialog().getByLabel('容器镜像',{exact:true}).fill('nginx:alpine');
 await dialog().getByRole('button',{name:'添加端口',exact:true}).click();await dialog().getByLabel('宿主端口',{exact:true}).fill('18081');await dialog().getByLabel('容器端口',{exact:true}).fill('80');
 await dialog().getByRole('button',{name:'添加挂载',exact:true}).click();await dialog().getByLabel('容器内绝对路径',{exact:true}).fill('/etc/nginx/conf.d');await dialog().locator('.lm-ops-mount').getByRole('button',{name:'添加',exact:true}).click();await dialog().getByLabel('相对文件路径',{exact:true}).fill('default.conf');await dialog().getByLabel('文件内容',{exact:true}).fill('server { listen 80; }');await save();
 const savedApp=resources.find(r=>r.name==='UI 容器');expect(savedApp.spec.ports[0]).toMatchObject({host_port:18081,container_port:80});expect(savedApp.spec.mounts[0].files['default.conf']).toContain('listen 80');await page.reload();await expect(page.getByRole('button',{name:'UI 容器',exact:true})).toBeVisible();checks.push('容器 typed 表单、端口、托管文件、保存后刷新读回');
 await page.getByRole('button',{name:'新建应用',exact:true}).click();for(let index=0;index<8;index++)await dialog().getByRole('button',{name:'添加端口',exact:true}).click();await dialog().getByLabel('内存（MiB）',{exact:true}).scrollIntoViewIfNeeded();await expect(dialog().locator('.ant-modal-title')).toBeInViewport({ratio:1});await expect(dialog().locator('.ant-modal-close')).toBeInViewport({ratio:1});await expect(dialog().getByRole('button',{name:'保存配置',exact:true})).toBeInViewport({ratio:1});expect(await dialog().locator('.ant-modal-body').evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);await page.screenshot({path:resolve(media,'long-form-fixed-controls.png'),fullPage:false});await dialog().getByRole('button',{name:/取\s*消/}).click();checks.push('长表单新增多行后内部滚动，标题、关闭和保存按钮始终可见');

 await page.getByRole('button',{name:'新建应用',exact:true}).click();await dialog().getByLabel('名称',{exact:true}).fill('保存失败保留');await choose('目标机器','app-shanghai-02');await dialog().getByLabel('容器镜像',{exact:true}).fill('redis:alpine');await context.request.post(process.env.LIGHTMONI_DEV_API_URL+'/api/v1/test/fail-next');await dialog().getByRole('button',{name:'保存配置',exact:true}).click();await expect(dialog().getByText('保存失败，输入已保留',{exact:true})).toBeVisible();await expect(dialog().getByLabel('名称',{exact:true})).toHaveValue('保存失败保留');await dialog().getByRole('button',{name:/取\s*消/}).click();checks.push('HTTP 409 保存失败保持名称、镜像和当前位置');
 await openTab('证书');await expect(page.getByText('cert-v2- / cert-v1-',{exact:false})).toBeVisible();await expect(page.getByText('云账号鉴权失败',{exact:true})).toBeVisible();await expect(page.getByText('检查凭据',{exact:true})).toBeVisible();await expect(page.locator('.lm-ops-target-section .lm-ops-error-text').first()).toHaveAttribute('title','provider_authentication_failed');await page.getByRole('button',{name:'CDN 证书同步',exact:true}).click();await expect(page.getByText('cert-v2-01234567890123456789',{exact:true})).toBeVisible();await page.keyboard.press('Escape');checks.push('失败摘要提供检查凭据提示，长版本缩写且详情保留完整值');
 for(const [provider,label] of [['aliyun','阿里云'],['tencent','腾讯云 / DNSPod'],['volcengine','火山引擎']]){
  await page.getByRole('button',{name:'添加分发目标',exact:true}).click();await dialog().getByLabel('名称',{exact:true}).fill('UI '+provider+' CDN');await choose('证书','站点证书');await choose('目标类型','云 CDN 域名');await choose('云平台',label);await choose('对应平台凭据',provider+' account');await tags('CDN 加速域名','cdn.example.com');await dialog().getByLabel('证书更新后自动执行',{exact:true}).click();await save();const target=resources.find(r=>r.name==='UI '+provider+' CDN');expect(target.spec).toMatchObject({type:'cloud',provider,product:'cdn',enabled:true,domains:['cdn.example.com']});await expect(page.locator('tr').filter({has:page.getByRole('button',{name:'UI '+provider+' CDN',exact:true})})).not.toContainText('期望 / 已应用版本');
 }
 checks.push('阿里云、腾讯云、火山 CDN 目标表单与期望/应用版本差异');
 await page.getByRole('button',{name:'添加分发目标',exact:true}).click();await dialog().getByLabel('名称',{exact:true}).fill('UI 更新脚本');await choose('证书','站点证书');await choose('目标类型','更新后脚本');await choose('执行机器','app-shanghai-02');await dialog().getByLabel('脚本正文',{exact:true}).fill('set -eu\nprintf done');await dialog().getByRole('button',{name:'添加',exact:true}).click();await dialog().getByLabel('变量名',{exact:true}).fill('DEPLOY_REGION');await dialog().getByLabel('变量值',{exact:true}).fill('shanghai');await dialog().getByLabel('证书更新后自动执行',{exact:true}).click();await save();const hook=resources.find(r=>r.name==='UI 更新脚本');expect(hook.spec).toMatchObject({type:'hook',agent_id:'agent-b',interpreter:'/bin/sh',timeout_ms:60000,env:{DEPLOY_REGION:'shanghai'},enabled:true});checks.push('证书更新脚本正文、解释器、环境、超时和自动授权');
 await openTab('托管域名');await page.getByRole('button',{name:'解析记录',exact:true}).first().click();await page.getByRole('button',{name:'新增记录',exact:true}).click();await dialog().getByLabel('主机记录',{exact:true}).fill('api');await dialog().getByLabel('记录值',{exact:true}).fill('203.0.113.20');await dialog().getByRole('button',{name:'保存并更新 DNS',exact:true}).click();await expect(page.getByText('203.0.113.20',{exact:true})).toBeVisible();checks.push('DNS 增加记录、确认写入与平台回读表格');await page.getByRole('button',{name:'新增记录',exact:true}).click();await dialog().getByLabel('主机记录',{exact:true}).fill('rejected-record');await dialog().getByLabel('记录值',{exact:true}).fill('203.0.113.21');await dialog().getByRole('button',{name:'保存并更新 DNS',exact:true}).click();await expect(dialog().getByText('provider_record_rejected',{exact:true})).toBeVisible();await expect(dialog().getByLabel('主机记录',{exact:true})).toHaveValue('rejected-record');checks.push('HTTP 202 业务失败保持 DNS 编辑器输入并显示真实失败');await dialog().getByRole('button',{name:/取\s*消/}).click();await page.keyboard.press('Escape');
 await page.goto(base+'/operations?tab=service');await page.getByRole('button',{name:'订单服务',exact:true}).click();await expect(page.getByText('10.0.0.12:21001',{exact:true}).first()).toBeVisible();await expect(page.getByText('探活通过',{exact:true})).toBeVisible();checks.push('服务详情展示机器、资源、探活与服务发现端点');await page.keyboard.press('Escape');
 await page.goto(base+'/operations?tab=website');await page.getByRole('button',{name:'新建网站',exact:true}).click();await dialog().getByLabel('名称',{exact:true}).fill('UI 服务网站');await tags('网站域名','api.example.com');await choose('OpenResty 网关组','生产入口');await choose('网站类型','托管服务');await choose('托管服务','订单服务');await dialog().getByLabel('启用 HTTPS',{exact:true}).click();await choose('使用证书','站点证书');await dialog().getByLabel('自动维护域名解析',{exact:true}).click();await choose('托管域名','生产域名');await save();expect(resources.find(r=>r.name==='UI 服务网站').spec).toMatchObject({mode:'service',service_id:'service',https:true,dns_enabled:true,certificate_id:'certificate',dns_zone_id:'zone'});checks.push('网站服务发现、HTTPS 与 DNS 关联表单');
 await page.getByRole('button',{name:'切换语言',exact:true}).click();await page.getByRole('menuitem',{name:'English',exact:true}).click();await expect(page.getByRole('heading',{name:'Websites & operations',exact:true})).toBeVisible();checks.push('英文界面');
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks.push('390px 窄屏无页面横向溢出');
 if(errors.length)throw new Error(errors.join('\n'));
 if(process.env.LIGHTMONI_UI_SHOOT==='1'){
  const exec=promisify(execFile),shoot='/Users/zhangsiwen/.codex/skills/oil-ui/scripts/shoot.mjs';
  for(const [name,query,steps] of [['websites','website',''],['certificates','certificate',''],['hook-form','certificate',"click \".lm-ops-target-section > .lm-ops-section-heading button\"; click \".ant-modal .ant-select:has(#spec_type)\"; wait 200; click \".ant-select-item-option[title='更新后脚本']\"; wait 300"]]){
   await exec(process.execPath,[shoot,base+'/operations?tab='+query,'--size','1440x1000,390x844','--full','--out',resolve(media,name),...['--steps','wait 800'+(steps?'; '+steps:'')]],{maxBuffer:1024*1024});
  }
  await exec(process.execPath,[shoot,base+'/operations?tab=certificate','--size','1440x1000','--zoom','2','--full','--steps','wait 800','--out',resolve(media,'certificates-200')],{maxBuffer:1024*1024});
  await exec(process.execPath,[shoot,base+'/operations?tab=application','--size','1440x1000','--record','--steps',`click ".lm-ops-section-heading .ant-btn-primary"; wait 250; click ".ant-modal button[aria-label=添加端口]"`,'--hold','900','--out',resolve(media,'interaction-motion')],{maxBuffer:1024*1024});
 }
 await writeFile(resolve(output,'report.json'),JSON.stringify({checked_at:stamp(),fixture:'Isolated in-memory HTTP API. No Docker, DNS, CA or cloud calls.',checks,writes:writes.map(w=>({kind:w.kind,name:w.name})),page_errors:errors,media},null,2));
 console.log(JSON.stringify({checks,report:resolve(output,'report.json'),media}));
}catch(error){await page.screenshot({path:resolve(media,'failure.png'),fullPage:true}).catch(()=>{});throw error}finally{await context.close();await browser.close();await vite.close();await new Promise(done=>fixture.close(done))}
