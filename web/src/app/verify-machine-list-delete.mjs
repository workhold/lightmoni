import {chromium,expect} from '@playwright/test';
import {mkdtemp,cp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,extname} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// Local production bundle with intercepted APIs only. No real host is touched.
const origin='http://127.0.0.1:19859',publicDir=await mkdtemp(resolve(tmpdir(),'lightmoni-list-delete-ui-'));
await cp(resolve(import.meta.dirname,'../../../runtime/public'),publicDir,{recursive:true});
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'specs/033-navigation-machine-actions');await mkdir(output,{recursive:true});
const media=mediaDirectory(output),checked=[],errors=[],unexpected=[],contexts=[];
const mark=value=>{checked.push(value);console.log('PASS '+value)};
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const copies={
 'zh-CN':{remove:'删除主机',dialog:'删除主机',confirm:'确认删除主机',close:'关闭',review:'我已逐项审阅目标、步骤和影响',details:/详\s*情/,alphaDetail:'主机详情 · Fixture alpha',betaDetail:'主机详情 · Fixture beta',scope:'永久删除平台中的主机记录',running:'停止后续',credentialGuard:'请先撤销有效连接凭据',deploymentGuard:'存在待确认或执行中的安装计划',uninstallGuard:'存在待确认、执行中或结果未知的卸载流程'},
 'en-US':{remove:'Delete hosts',dialog:'Delete hosts',confirm:'Confirm host deletion',close:'Close',review:'I have reviewed each target, step, and impact',details:'Details',alphaDetail:'Host details · Fixture alpha',betaDetail:'Host details · Fixture beta',scope:'Permanently delete platform host records',running:'Stop subsequent operations',credentialGuard:'Revoke active connection credentials',deploymentGuard:'A pending or running installation plan exists',uninstallGuard:'A pending, running, or uncertain uninstall workflow exists'},
};
const rawGuards=['请先撤销或等待所有有效连接凭据失效后再删除主机','该主机有未结束的部署任务，请先完成或取消后再删除','此主机有待审批、运行中或结果未知的 Agent 卸载，请先取消或核对','此主机有终端、检查或部署正在进行，请先结束后重试'];
async function harness(language='zh-CN',width=1440){
 const at=new Date().toISOString(),available={available:true,reason:''};
 const base={port:22,username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:fixtureconfirmedfingerprint',host_key_status:'confirmed',agent_id:'',agent_status:'unknown',active_credential_count:0,active_ssh_credential_count:0,active_ssh_key_count:0,ssh_recovery_available:false,capabilities:{terminal:available,ssh_check:available,deploy_agent:available,uninstall_agent:available},credential_count:0,arch:'',platform:'',updated_at:at,created_at:at};
 const machines=[{...base,id:'machine-alpha',name:'Fixture alpha',address:'alpha.example.test'},{...base,id:'machine-beta',name:'Fixture beta',address:'beta.example.test'}];
 const state={machines,requests:[],deleteError:'',deleteStatus:409,holdDelete:false,releaseDelete:undefined,holdDetails:new Set(),releaseDetails:new Map(),credentials:[],deployments:[],uninstallations:[],holdNextList:false,releaseList:undefined,failList:false};
 const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(language=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.nav.collapsed','true')},language);
 const fixtures={'/api/v1/setup':{required:false},'/api/v1/auth/providers':[],'/api/v1/auth/me':{id:'fixture-admin',name:'Fixture Admin',role:'admin'},'/api/v1/auth/profile':{},'/api/v1/catalog/tables':[],'/api/v1/dashboards':[]};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(url.href);return route.abort()}
  if(path.startsWith('/api/')){
   if(method==='GET'&&['/api/v1/agents','/api/v1/agent-task-labels'].includes(path))return route.fulfill({json:[]});
   state.requests.push({method,path});
   if(path==='/api/v1/machines'&&method==='GET'){
    if(state.holdNextList){const snapshot=[...state.machines];state.holdNextList=false;await new Promise(resolve=>{state.releaseList=resolve});return route.fulfill({json:snapshot})}
    if(state.failList){return route.fulfill({status:503,json:{error:'Fixture list reload failed'}})}
    return route.fulfill({json:state.machines});
   }
   const match=path.match(/^\/api\/v1\/machines\/(machine-alpha|machine-beta)$/);
   if(match){
    const id=match[1],machine=machines.find(m=>m.id===id);
    if(method==='GET'){
     if(state.holdDetails.delete(id))await new Promise(resolve=>state.releaseDetails.set(id,resolve));
     return route.fulfill({json:{machine,credentials:state.credentials,deployments:state.deployments,uninstallations:state.uninstallations}});
    }
    if(method==='DELETE'){
     if(state.holdDelete)await new Promise(resolve=>{state.releaseDelete=resolve});
     if(state.deleteError)return route.fulfill({status:state.deleteStatus,json:{error:state.deleteError}});
     state.machines=state.machines.filter(m=>m.id!==id);return route.fulfill({json:{ok:true}});
    }
   }
   if(method==='GET'&&Object.hasOwn(fixtures,path))return route.fulfill({json:fixtures[path]});
   unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
  }
  const file=path.startsWith('/assets/')?resolve(publicDir,'.'+path):resolve(publicDir,'index.html');
  return route.fulfill({body:await readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]??'application/octet-stream'});
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/machines');await expect(page.locator('.ant-table-tbody tr[data-row-key="machine-alpha"]')).toBeVisible();
 const row=id=>page.locator(`.ant-table-tbody tr[data-row-key="${id}"]`),deletes=()=>state.requests.filter(r=>r.method==='DELETE');
 return {page,state,row,deletes};
}
const target=(dialog,id)=>dialog.locator(`[data-batch-target="${id}"]`);
async function openDeletion(test,language='zh-CN',id='machine-alpha'){
 const c=copies[language];await test.row(id).getByRole('checkbox').check();
 await test.page.getByRole('region').filter({has:test.page.getByRole('button',{name:c.remove,exact:true})}).getByRole('button',{name:c.remove,exact:true}).click();
 const dialog=test.page.getByRole('dialog',{name:c.dialog,exact:true});
 await expect(dialog.getByRole('checkbox',{name:c.review,exact:true})).toBeVisible();return dialog;
}
async function close(dialog,language='zh-CN'){await dialog.getByRole('button',{name:copies[language].close,exact:true}).last().click();await expect(dialog).toHaveCount(0)}
async function confirm(dialog,language='zh-CN'){const c=copies[language];await dialog.getByRole('checkbox',{name:c.review,exact:true}).check();await dialog.getByRole('button',{name:c.confirm,exact:true}).click()}
let current;
try{
 for(const language of ['zh-CN','en-US']){
  const test=await harness(language,language==='en-US'?390:1440),{page,state,row,deletes}=test;current=page;const c=copies[language];
  await expect(row('machine-alpha').getByRole('button',{name:language==='zh-CN'?'删除主机':'Delete host',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:c.remove,exact:true})).toBeDisabled();
  let dialog=await openDeletion(test,language);
  await expect(target(dialog,'machine-alpha')).toContainText('Fixture alpha');await expect(target(dialog,'machine-alpha')).toContainText('alpha.example.test:22');await expect(target(dialog,'machine-beta')).toHaveCount(0);await expect(dialog).toContainText(c.scope);await expect(dialog.getByRole('button',{name:c.confirm,exact:true})).toBeDisabled();expect(deletes()).toHaveLength(0);
  await expect.poll(()=>dialog.evaluate(element=>{const style=getComputedStyle(element);return style.opacity==='1'&&style.transform==='none'})).toBe(true);
  await page.screenshot({path:resolve(media,'delete-confirmation-'+language+'.png'),fullPage:true});const bounds=await dialog.boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(page.viewportSize().width+1);
  await close(dialog,language);expect(deletes()).toHaveLength(0);dialog=await openDeletion(test,language);await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);expect(deletes()).toHaveLength(0);mark(language+': one selected host uses the shared toolbar and target snapshot; review, close, and Escape cannot send an unconfirmed DELETE');
  for(const [field,value,guard] of [
   ['credentials',[{id:'credential',method:'ssh_key',retention:'permanent',expires_at:''}],c.credentialGuard],
   ['deployments',[{id:'plan',status:'awaiting_approval'}],c.deploymentGuard],
   ['uninstallations',[{id:'uninstall',status:'unknown'}],c.uninstallGuard],
  ]){
   state[field]=value;dialog=await openDeletion(test,language);await expect(target(dialog,'machine-alpha')).toHaveAttribute('data-batch-status','not_applicable');await expect(target(dialog,'machine-alpha')).toContainText(guard);await expect(dialog.getByRole('button',{name:c.confirm,exact:true})).toBeDisabled();expect(deletes()).toHaveLength(0);await close(dialog,language);state[field]=[];
  }
  mark(language+': active credentials and pending deployment/removal records block deletion before confirmation with localized explanations');
  for(const guard of [...rawGuards,'Fixture authorization expired']){
   state.deleteError=guard;state.deleteStatus=guard==='Fixture authorization expired'?403:409;dialog=await openDeletion(test,language);const before=deletes().length;await confirm(dialog,language);
   await expect(target(dialog,'machine-alpha')).toHaveAttribute('data-batch-status','failed');await expect(target(dialog,'machine-alpha')).toContainText(guard);await expect(target(dialog,'machine-alpha')).toContainText('alpha.example.test:22');await expect(row('machine-alpha')).toBeVisible();await expect(row('machine-beta')).toBeVisible();expect(deletes()).toHaveLength(before+1);await close(dialog,language);
  }
  mark(language+': server lifecycle and authorization rejections remain in the per-host results and preserve both host rows');
  state.deleteError='';state.holdDelete=true;dialog=await openDeletion(test,language);await dialog.getByRole('checkbox',{name:c.review,exact:true}).check();const before=deletes().length;
  await dialog.getByRole('button',{name:c.confirm,exact:true}).evaluate(button=>{button.click();button.click()});await expect.poll(()=>deletes().length).toBe(before+1);await expect(dialog.getByRole('button',{name:c.running,exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:c.close,exact:true})).toHaveCount(0);await page.keyboard.press('Escape');await expect(dialog).toBeVisible();expect(deletes().at(-1).path).toBe('/api/v1/machines/machine-alpha');state.releaseDelete();
  await expect(target(dialog,'machine-alpha')).toHaveAttribute('data-batch-status','success');await expect(row('machine-alpha')).toHaveCount(0);await expect(row('machine-beta')).toBeVisible();expect(deletes()).toHaveLength(before+1);await close(dialog,language);mark(language+': reopening after failure and repeated synchronous confirmation send one DELETE, keep the result visible, and remove only the selected host');
  await page.screenshot({path:resolve(media,'delete-list-'+language+'.png'),fullPage:true,animations:'disabled'});
 }
 {
  const test=await harness(),{page,state,row}=test;current=page;const c=copies['zh-CN'];state.holdDetails.add('machine-beta');
  await row('machine-beta').getByRole('button',{name:c.details,exact:true}).click();await expect.poll(()=>state.releaseDetails.has('machine-beta')).toBe(true);
  state.holdDelete=true;const dialog=await openDeletion(test);await confirm(dialog);await expect.poll(()=>!!state.releaseDelete).toBe(true);state.releaseDetails.get('machine-beta')();await expect(page.getByRole('dialog',{name:c.betaDetail,exact:true})).toBeVisible();state.releaseDelete();
  await expect(row('machine-alpha')).toHaveCount(0);await expect(page.getByRole('dialog',{name:c.betaDetail,exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:c.betaDetail,exact:true})).toContainText('beta.example.test:22');await page.getByRole('dialog',{name:c.betaDetail,exact:true}).locator('.ant-modal-close').click();await close(dialog);mark('Deleting alpha leaves beta details intact when its in-flight read finishes during deletion');
 }
 {
  const test=await harness(),{page,state,row}=test;current=page;const c=copies['zh-CN'];state.holdDetails.add('machine-alpha');
  await row('machine-alpha').getByRole('button',{name:c.details,exact:true}).click();await expect.poll(()=>state.releaseDetails.has('machine-alpha')).toBe(true);
  const dialog=await openDeletion(test);await confirm(dialog);await expect(row('machine-alpha')).toHaveCount(0);await close(dialog);
  const completed=page.waitForResponse(r=>r.url()===origin+'/api/v1/machines/machine-alpha'&&r.request().method()==='GET');state.releaseDetails.get('machine-alpha')();await completed;await expect(page.getByRole('dialog')).toHaveCount(0);await expect(row('machine-beta')).toBeVisible();mark('A late detail response for a deleted host cannot reopen its stale dialog');
 }
 {
  const test=await harness(),{page,state,row}=test;current=page;state.failList=true;
  const dialog=await openDeletion(test);await confirm(dialog);await expect(target(dialog,'machine-alpha')).toHaveAttribute('data-batch-status','success');await expect(page.getByText('Fixture list reload failed',{exact:true})).toBeVisible();await expect(row('machine-alpha')).toHaveCount(0);await expect(row('machine-beta')).toBeVisible();mark('A successful DELETE removes its row immediately even when the following list refresh fails');
 }
 {
  const test=await harness(),{page,state,row}=test;current=page;state.holdNextList=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>!!state.releaseList).toBe(true);
  const dialog=await openDeletion(test);await confirm(dialog);await expect(row('machine-alpha')).toHaveCount(0);await expect(row('machine-beta')).toBeVisible();await close(dialog);
  const completed=page.waitForResponse(r=>r.url()===origin+'/api/v1/machines'&&r.request().method()==='GET');state.releaseList();await completed;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await expect(row('machine-alpha')).toHaveCount(0);await expect(row('machine-beta')).toBeVisible();mark('A stale list response arriving after deletion cannot restore the deleted row');
 }
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);await writeFile(resolve(output,'machine-list-delete-ui-report.json'),JSON.stringify({checked,errors,unexpected},null,2)+'\n');
}catch(error){if(current)await current.screenshot({path:resolve(media,'machine-list-delete-failure.png'),fullPage:true}).catch(()=>{});console.error({errors,unexpected});throw error}
finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDir,{recursive:true,force:true})}
