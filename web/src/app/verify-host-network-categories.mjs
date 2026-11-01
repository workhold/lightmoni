import {chromium,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {extname,resolve} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';
// All HTTP and WebSocket traffic stays in intercepted fixtures; no real host or SSH.
const origin='http://127.0.0.1:19897',publicDir=await mkdtemp(resolve(tmpdir(),'lightmoni-network-categories-'));
await cp(resolve(import.meta.dirname,'../../../runtime/public'),publicDir,{recursive:true});
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'specs/054-host-network-address-categories/evidence/ui');await mkdir(output,{recursive:true});
const media=mediaDirectory(output),checked=[],failures=[],errors=[],unexpected=[],contexts=[];
const index=await readFile(resolve(publicDir,'index.html')),entry=String(index).match(/src="([^"]+\.js)"/u)?.[1],hash=value=>createHash('sha256').update(value).digest('hex');
const bundle={index_sha256:hash(index),entry,entry_sha256:entry?hash(await readFile(resolve(publicDir,'.'+entry))):''};
let browser,current;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const copy={
 'zh-CN':{details:/详\s*情/,private:'内网 IP',public:'公网范围网卡 IP',vpn:'VPN / 隧道 IP',source:'到平台的公网来源',internalSource:'平台连接来源（内网）',all:'全部原始网卡地址',other:'其他地址（容器、回环及特殊范围）',unknown:'尚未发现主机网卡地址',entryPrivate:'内网入口',entryPublic:'公网范围入口',entryDomain:'域名入口',entryShared:'共享地址入口',check:'SSH 安装检查',run:'开始 SSH 检查'},
 'en-US':{details:'Details',private:'Private IP',public:'Public-range interface IP',vpn:'VPN / tunnel IP',source:'Public source to platform',internalSource:'Platform connection source (private)',all:'All raw interface addresses',other:'Other addresses (container, local, and special ranges)',unknown:'Host interface addresses not discovered',entryPrivate:'Private entry',entryPublic:'Public-range entry',entryDomain:'Hostname entry',entryShared:'Shared-address entry',check:'SSH preflight',run:'Run SSH preflight'},
};
const addressEntry=(interfaceName,address,scope='private')=>({interface:interfaceName,address,family:address.includes(':')?'IPv6':'IPv4',scope});
async function harness(language='zh-CN',width=1440,role='admin'){
 const at='2026-10-31T01:02:03.000Z',available={available:true,reason:''},addresses=[addressEntry('eth0','10.41.0.2'),...Array.from({length:6},(_,i)=>addressEntry(i?'br-abcdef00000'+i:'docker0',`172.${18+i}.0.1`)),addressEntry('wg0','10.8.0.2'),addressEntry('br0','192.168.8.1'),addressEntry('bond0.12','fd12::7'),addressEntry('lo','127.0.0.1','loopback'),addressEntry('eth0','fe80::1','link_local'),addressEntry('eth0','203.0.113.7','public')];
 const network={hostname:'observed-host',addresses,private_ips:addresses.filter(x=>x.scope==='private').map(x=>x.address),public_ips:['203.0.113.7'],observed_at:at,observed_via:'agent',source_ip:'172.24.0.1',source_observed_at:at,source_kind:'direct'};
 const host={id:'network-host',name:'User host',address:'10.41.0.2',port:2222,username:'deploy',connection_method:'direct_ssh',agent_id:'',agent_status:'unknown',default_credential_id:'fixture-key',capabilities:{terminal:available,ssh_check:available,deploy_agent:available,uninstall_agent:available},ssh_recovery_available:true,label_ids:[],labels:[],network,created_at:at,updated_at:at};
 const key={id:'fixture-key',method:'ssh_key',retention:'permanent',expires_at:'',secret_fingerprint:'SHA256:fixture'},state={host,requests:[],network};
 const context=await browser.newContext({viewport:{width,height:1050},timezoneId:'Asia/Shanghai',reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(language=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.nav.collapsed','true')},language);
 await context.routeWebSocket('**/*',ws=>{unexpected.push('WebSocket '+ws.url());ws.close()});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();if(url.origin!==origin){unexpected.push(method+' '+url.href);return route.abort()}
  if(path.startsWith('/api/')){
   state.requests.push({path,method});const base='/api/v1/machines/network-host',fixtures={'/api/v1/setup':{required:false},'/api/v1/auth/providers':[],'/api/v1/auth/me':{id:'fixture-admin',name:'Fixture Admin',role},'/api/v1/auth/profile':{},'/api/v1/catalog/tables':[],'/api/v1/dashboards':[],'/api/v1/connection-credentials':[],'/api/v1/host-labels':[],'/api/v1/agents':[],'/api/v1/machines':[host],'/api/v1/task-hosts':[host],[base]:{machine:host,credentials:[key],deployments:[],uninstallations:[]},[base+'/tasks']:[],[base+'/agent-updates']:[]};
   if(method==='GET'&&Object.hasOwn(fixtures,path))return route.fulfill({json:fixtures[path]});
   if(method==='POST'&&path===base+'/ssh-check')return route.fulfill({json:{id:'fixture-check',machine_id:host.id,credential_id:key.id,connected:true,ready:true,platform:'linux',arch:'arm64',checks:{linux:true},checked_at:at,expires_at:'2099-01-01T00:00:00Z',agent_installation:{state:'absent'},discovery:{status:'succeeded',hostname:network.hostname,addresses:network.addresses,observed_at:at}}});
   unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
  }
  const file=path.startsWith('/assets/')?resolve(publicDir,'.'+path):resolve(publicDir,'index.html');return route.fulfill({body:await readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]??'application/octet-stream'});
 });
 const page=await context.newPage();current=page;page.setDefaultTimeout(3500);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/machines');return {page,state,row:page.locator('tr[data-row-key="network-host"]')};
}
const close=async page=>{await page.getByRole('dialog').locator('.ant-modal-close').click();await expect(page.getByRole('dialog')).toHaveCount(0)};
async function scenario(name,run){try{await run();checked.push(name);console.log('PASS '+name)}catch(error){failures.push({name,error:String(error)});console.log('FAIL '+name+' '+String(error));await current?.screenshot({path:resolve(media,'failure-'+failures.length+'.png'),fullPage:true}).catch(()=>{})}}
try{
 for(const language of ['zh-CN','en-US'])for(const width of [1440,390]){
  const c=copy[language],prefix=language+' '+width+'px: ';
  await scenario(prefix+'summary prioritizes host addresses and tunnel addresses without container bridges or private platform peers',async()=>{
   const {page,row}=await harness(language,width),summary=row.locator('.lm-host-addresses');await expect(summary).toContainText(c.private+'：10.41.0.2');await expect(summary).toContainText(c.vpn+'：10.8.0.2');await expect(summary).not.toContainText('172.18.0.1');await expect(summary).not.toContainText('172.24.0.1');await expect(summary).not.toContainText('203.0.113.7');await expect(row).toContainText(c.entryPrivate);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await row.locator('td').nth(1).screenshot({path:resolve(media,'host-row-'+language+'-'+width+'.png'),animations:'disabled'});
   await row.getByRole('button',{name:c.details,exact:true}).click();const dialog=page.getByRole('dialog'),network=dialog.locator('.lm-host-addresses');await expect(network).toContainText(c.internalSource+'：172.24.0.1');await expect(network).toContainText(language==='zh-CN'?'公网/内网出口：待确认':'Public/private egress: unconfirmed');await expect(network.getByText('172.18.0.1',{exact:true})).toHaveCount(0);await expect(dialog).not.toHaveClass(/ant-zoom/);await network.scrollIntoViewIfNeeded();await page.mouse.move(0,0);await expect(page.getByRole('tooltip')).toHaveCount(0);await network.screenshot({path:resolve(media,'host-details-'+language+'-'+width+'.png'),animations:'disabled'});await network.getByRole('button',{name:c.other,exact:false}).click();await expect(network.getByText('172.18.0.1',{exact:true})).toBeVisible();await network.getByRole('button',{name:c.all,exact:false}).click();await expect(network.getByText('br0',{exact:true})).toBeVisible();await expect(network.getByText('bond0.12',{exact:true})).toBeVisible();await close(page);
  });
  await scenario(prefix+'public source and interface ranges stay separate from configured SSH entry and unknown egress',async()=>{
   const {page,state,row}=await harness(language,width);state.host.address='ssh.example.test';state.network.addresses.push(addressEntry('eth1','8.8.8.8','public'));state.network.source_ip='8.8.4.4';state.network.source_kind='trusted_proxy';await page.reload();await expect(row).toContainText(c.entryDomain);await expect(row).toContainText(c.public+'：8.8.8.8');await expect(row).toContainText(c.source+'：8.8.4.4');await expect(row).not.toContainText(language==='zh-CN'?'公网出口':'Public egress');await row.getByRole('button',{name:c.details,exact:true}).click();await expect(page.getByRole('dialog')).toContainText(language==='zh-CN'?'可信代理':'Trusted proxy');await close(page);state.host.address='[2606:4700::1111]';await page.reload();await expect(row).toContainText(c.entryPublic);await expect(row).toContainText('[2606:4700::1111]:2222');state.host.address='100.64.0.8';state.network.addresses.push(addressEntry('eth3','100.64.0.9'));await page.reload();await expect(row).toContainText(c.entryShared);await expect(row).toContainText((language==='zh-CN'?'共享地址 IP':'Shared-address IP')+'：100.64.0.9');
  });
  await scenario(prefix+'SSH preflight shares category projection and keeps raw observations collapsed',async()=>{
   const {page,row}=await harness(language,width);await row.getByRole('button',{name:c.check,exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:c.run,exact:true}).click();const discovery=dialog.locator('.lm-ssh-network-discovery');await expect(discovery).toContainText(c.private+'：10.41.0.2');await expect(discovery).toContainText(c.vpn+'：10.8.0.2');await expect(discovery.getByText('172.18.0.1',{exact:true})).toHaveCount(0);await expect(discovery).not.toContainText(c.source);await discovery.getByRole('button',{name:c.all,exact:false}).click();await expect(discovery.getByText('docker0',{exact:true})).toBeVisible();await close(page);
  });
 }
 await scenario('legacy aggregate arrays and empty observations do not invent host addresses or produce repeated missing-IP rows',async()=>{
  const {page,state,row}=await harness();state.network.addresses=[];state.network.private_ips=['172.18.0.1','10.99.0.4'];state.network.public_ips=['203.0.113.7'];state.network.source_ip='';state.network.observed_at='';state.network.hostname='';await page.reload();const summary=row.locator('.lm-host-addresses');await expect(summary).toContainText(copy['zh-CN'].unknown);await expect(summary).not.toContainText('172.18.0.1');await expect(summary).not.toContainText('10.99.0.4');await expect(summary).not.toContainText('203.0.113.7');await expect(summary.locator('.ant-typography')).toHaveCount(1);
 });
 await scenario('members cannot see configured SSH targets while retaining observed network summaries',async()=>{
  const {page,row}=await harness('en-US',1440,'member');await expect(row).not.toContainText('SSH connection address');await expect(row).not.toContainText(copy['en-US'].entryPrivate);await expect(row.locator('.lm-host-addresses')).toContainText('10.41.0.2');expect((await page.locator('button').allTextContents()).join(' ')).not.toContain('SSH preflight');
 });
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);await writeFile(resolve(output,'ui-report.json'),JSON.stringify({production_bundle:true,bundle,fixture_only:true,production_writes:false,ssh_connections:false,languages:['zh-CN','en-US'],widths:[1440,390],passed:checked.length,checked,failures,errors,unexpected},null,2)+'\n');if(failures.length)throw Error(failures.length+' network category scenarios failed');
}finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDir,{recursive:true,force:true})}
