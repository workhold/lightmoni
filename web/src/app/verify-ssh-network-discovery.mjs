import {chromium,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {extname,resolve} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// The copied production bundle uses intercepted APIs only. No SSH connection,
// installation, production request, or real credential is possible here.
const origin='http://127.0.0.1:19879',publicDir=await mkdtemp(resolve(tmpdir(),'lightmoni-network-ui-'));
await cp(resolve(import.meta.dirname,'../../../runtime/public'),publicDir,{recursive:true});
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'specs/051-ssh-host-network-discovery/evidence/ui');
await mkdir(output,{recursive:true});
const media=mediaDirectory(output),checked=[],errors=[],unexpected=[],contexts=[];
const index=await readFile(resolve(publicDir,'index.html')),entry=String(index).match(/src="([^"]+\.js)"/u)?.[1];
const bundle={index_sha256:createHash('sha256').update(index).digest('hex'),entry};
if(entry)bundle.entry_sha256=createHash('sha256').update(await readFile(resolve(publicDir,'.'+entry))).digest('hex');
const mark=value=>{checked.push(value);console.log('PASS '+value)};
const copy={
 'zh-CN':{address:'SSH 连接地址',register:'登记主机',edit:'编辑主机',check:'SSH 安装检查',run:'开始 SSH 检查',details:/详\s*情/,discovery:'主机网络发现',private:'内网 IP',source:'到平台的公网来源',via:'网卡采集：SSH 预检',agentVia:'网卡采集：Agent 心跳',unknown:'待发现',notReady:'SSH 已连接，安装条件不满足',ready:'SSH 已连接，安装检查通过',unavailable:'尚未发现网卡地址，可稍后重新检查或等待 Agent 上报。',empty:'本次采集未发现网卡地址'},
 'en-US':{address:'SSH connection address',register:'Register host',edit:'Edit host',check:'SSH preflight',run:'Run SSH preflight',details:'Details',discovery:'Host network discovery',private:'Private IP',source:'Public source to platform',via:'Interface discovery：SSH preflight',agentVia:'Interface discovery：Agent heartbeat',unknown:'Not discovered',notReady:'SSH connected; installation prerequisites not met',ready:'SSH connected; installation checks passed',unavailable:'No interface addresses discovered. Retry later or wait for Agent reporting.',empty:'No interface addresses found in this snapshot'},
};
let browser,current;
try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
async function harness(language,width){
 const observed='2026-10-31T01:02:03.000Z',expires='2099-01-01T00:00:00.000Z',available={available:true,reason:''};
 const host={id:'network-host',name:'User chosen host',address:'ssh-gateway.example.test',port:2222,username:'deploy',connection_method:'direct_ssh',agent_id:'',agent_status:'unknown',default_credential_id:'network-key',capabilities:{terminal:available,ssh_check:available,deploy_agent:available,uninstall_agent:available},credential_count:1,active_credential_count:1,active_ssh_credential_count:1,active_ssh_key_count:1,active_reusable_ssh_credential_count:1,ssh_recovery_available:true,host_key_fingerprint:'',host_key_status:'unconfigured',label_ids:[],labels:[],created_at:observed,updated_at:observed};
 const addresses=[{interface:'eth0',address:'10.23.4.5',family:'IPv4',scope:'private'},{interface:'eth1',address:'fd12:3456:789a:1:1234:5678:9abc:def0',family:'IPv6',scope:'private'},{interface:'eth2',address:'203.0.113.7',family:'IPv4',scope:'public'}];
 const discovery={status:'succeeded',hostname:'ssh-observed-host',addresses,observed_at:observed};
 const credential={id:'network-key',name:'Fixture default key',method:'ssh_key',retention:'managed',expires_at:expires,secret_fingerprint:'SHA256:fixture-network-key'};
 const result={id:'network-check',machine_id:host.id,credential_id:credential.id,connected:true,ready:false,platform:'linux',arch:'arm64',checks:{linux:true,supported_arch:true,systemd:false},error_code:'prerequisites_missing',checked_at:observed,expires_at:expires,agent_installation:{state:'absent'},discovery};
 const state={host,result,requests:[]};
 const context=await browser.newContext({viewport:{width,height:1000},timezoneId:'Asia/Shanghai',reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(language=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.nav.collapsed','true')},language);
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(method+' '+url.href);return route.abort()}
  if(path.startsWith('/api/')){
   const body=request.postData()?request.postDataJSON():undefined;state.requests.push({path,method,body});
   const fixtures={'/api/v1/setup':{required:false},'/api/v1/auth/providers':[],'/api/v1/auth/me':{id:'network-admin',name:'Fixture User',role:'admin'},'/api/v1/auth/profile':{},'/api/v1/catalog/tables':[],'/api/v1/dashboards':[],'/api/v1/connection-credentials':[],'/api/v1/host-labels':[],'/api/v1/agents':[],'/api/v1/machines':[host],'/api/v1/machines/network-host':{machine:host,credentials:[credential],deployments:[],uninstallations:[]},'/api/v1/machines/network-host/tasks':[],'/api/v1/machines/network-host/agent-updates':[]};
   if(method==='GET'&&Object.hasOwn(fixtures,path))return route.fulfill({json:fixtures[path]});
   if(method==='POST'&&path==='/api/v1/machines/network-host/ssh-check'){
    if(state.result.discovery?.status==='succeeded'){
     const sample=state.result.discovery;
     host.network={hostname:sample.hostname,addresses:sample.addresses,private_ips:sample.addresses.filter(address=>address.scope==='private').map(address=>address.address),public_ips:sample.addresses.filter(address=>address.scope==='public').map(address=>address.address),observed_at:sample.observed_at,observed_via:'ssh',source_ip:'',source_observed_at:'',source_kind:'unavailable'};
    }
    return route.fulfill({json:state.result});
   }
   unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
  }
  if(method!=='GET'){unexpected.push(method+' '+path);return route.abort()}
  const file=path.startsWith('/assets/')?resolve(publicDir,'.'+path):resolve(publicDir,'index.html');
  return route.fulfill({body:await readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]??'application/octet-stream'});
 });
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
 return {page,state,row:page.locator('tr[data-row-key="network-host"]'),observed,discovery};
}
try{
 for(const language of ['zh-CN','en-US'])for(const width of [1440,390]){
  const {page,state,row,observed,discovery}=await harness(language,width);current=page;const c=copy[language],prefix=language+' '+width+'px: ';
  await page.goto(origin+'/machines');await expect(row).toContainText(c.address+(language==='zh-CN'?'：':': '));
  await page.getByRole('button',{name:c.register,exact:true}).click();let dialog=page.getByRole('dialog');await expect(dialog.getByRole('textbox',{name:c.address,exact:false})).toBeVisible();await dialog.locator('.ant-modal-close').click();
  await row.getByRole('button',{name:c.edit,exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByRole('textbox',{name:c.address,exact:false})).toHaveValue('ssh-gateway.example.test');await dialog.locator('.ant-modal-close').click();mark(prefix+'registration, editing, and the host column identify the SSH connection address');

  async function check(){await row.getByRole('button',{name:c.check,exact:true}).click();const modal=page.getByRole('dialog');await modal.getByRole('button',{name:c.run,exact:true}).click();return modal}
  dialog=await check();await expect(dialog.getByText(c.notReady,{exact:true})).toBeVisible();const section=dialog.locator('.lm-ssh-network-discovery');await expect(section.getByRole('heading',{name:c.discovery,exact:true})).toBeVisible();await expect(section).toContainText('ssh-observed-host');await expect(section).toContainText(c.via);await section.getByRole('button',{name:language==='zh-CN'?/全部原始网卡地址/:/All raw interface addresses/}).click();await expect(section.getByText('eth0',{exact:true})).toBeVisible();await expect(section.getByText('eth1',{exact:true})).toBeVisible();await expect(section).toContainText('fd12:3456:789a:1:1234:5678:9abc:def0');await expect(section).not.toContainText(c.source);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(dialog).not.toHaveClass(/ant-zoom/);await page.mouse.move(0,0);await expect(page.getByRole('tooltip')).toHaveCount(0);await dialog.screenshot({path:resolve(media,'ssh-network-'+language+'-'+width+'.png'),animations:'disabled'});await dialog.locator('.ant-modal-close').click();mark(prefix+'preflight discovers IPv4, IPv6, hostname, interfaces, source and time without Agent even when installation prerequisites fail');

  await expect(row).toContainText(c.private+'：10.23.4.5');await expect(row).toContainText(c.via);await expect(row).not.toContainText(c.source);await expect(row).toContainText('User chosen host');await expect(row).toContainText('ssh-gateway.example.test:2222');expect(state.host.agent_id).toBe('');await page.reload();await expect(row).toContainText(c.via);await row.getByRole('button',{name:c.details,exact:true}).click();dialog=page.getByRole('dialog');await dialog.locator('.lm-host-addresses').getByRole('button',{name:language==='zh-CN'?/全部原始网卡地址/:/All raw interface addresses/}).click();await expect(dialog.getByText('eth0',{exact:true})).toBeVisible();await expect(dialog).toContainText(c.via);await expect(dialog).toContainText('ssh-observed-host');await expect(dialog).toContainText(new Date(observed).toLocaleString(language,{timeZone:'Asia/Shanghai'}));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(dialog).not.toHaveClass(/ant-zoom/);await page.mouse.move(0,0);await expect(page.getByRole('tooltip')).toHaveCount(0);await dialog.locator('.lm-host-addresses').scrollIntoViewIfNeeded();await dialog.locator('.lm-host-addresses').screenshot({path:resolve(media,'host-network-'+language+'-'+width+'.png'),animations:'disabled'});await dialog.locator('.ant-modal-close').click();mark(prefix+'refresh and host details retain discovered addresses and SSH provenance while keeping identity, name, SSH target, and platform source separate');

  state.result={...state.result,ready:true,checks:{linux:true,supported_arch:true,systemd:true},error_code:'',discovery:{status:'unavailable',hostname:'',addresses:[],observed_at:''}};
  dialog=await check();await expect(dialog.getByText(c.ready,{exact:true})).toBeVisible();await expect(dialog.locator('.lm-ssh-network-discovery')).toContainText(c.unavailable);await expect(dialog.locator('.ant-alert-warning,.ant-alert-error')).toHaveCount(0);await dialog.locator('.ant-modal-close').click();await expect(row).toContainText('10.23.4.5');expect(state.host.network.observed_at).toBe(observed);mark(prefix+'unavailable discovery is a quiet empty result and does not erase the prior successful snapshot or fail installation checks');

  delete state.result.discovery;dialog=await check();await expect(dialog.locator('.lm-ssh-network-discovery')).toContainText(c.unavailable);await dialog.locator('.ant-modal-close').click();mark(prefix+'historical check results without discovery use the same empty state');
  state.result.discovery={...discovery,addresses:[],hostname:'',observed_at:'2026-10-31T02:03:04.000Z'};dialog=await check();await dialog.locator('.lm-ssh-network-discovery').getByRole('button',{name:language==='zh-CN'?/全部原始网卡地址/:/All raw interface addresses/}).click();await expect(dialog.locator('.lm-ssh-network-discovery')).toContainText(c.empty);await expect(dialog.locator('.lm-ssh-network-discovery')).toContainText(c.via);await dialog.locator('.ant-modal-close').click();await expect(row).not.toContainText('10.23.4.5');mark(prefix+'a successful empty snapshot shows no addresses rather than an unavailable collection');

  state.host.network={...state.host.network,hostname:'agent-observed-host',addresses:discovery.addresses,private_ips:['10.23.4.5','fd12:3456:789a:1:1234:5678:9abc:def0'],public_ips:['203.0.113.7'],observed_via:'agent',source_ip:'8.8.4.4',source_observed_at:'2026-10-31T02:03:04.000Z',source_kind:'trusted_proxy'};await page.reload();await expect(row).toContainText(c.agentVia);await expect(row).toContainText(c.source+'：8.8.4.4');await expect(row).not.toContainText(language==='zh-CN'?'出口 / 来源 IP':'Egress / source IP');mark(prefix+'later Agent snapshots label Agent collection separately from platform-observed connection source');
  expect(state.requests.filter(request=>request.method!=='GET'&&!request.path.endsWith('/ssh-check'))).toEqual([]);mark(prefix+'all remote actions are explicit SSH-check fixture requests; no registration, target edits, plans, or installations are submitted');
 }
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({production_bundle:true,bundle,fixture_only:true,production_writes:false,ssh_connections:false,installations:false,languages:['zh-CN','en-US'],widths:[1440,390],passed:checked.length,checked,errors,unexpected},null,2)+'\n');
}catch(error){if(current)await current.screenshot({path:resolve(media,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(output,'ui-report.json'),JSON.stringify({bundle,checked,failed:String(error),errors,unexpected},null,2)+'\n');throw error}
finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDir,{recursive:true,force:true})}
