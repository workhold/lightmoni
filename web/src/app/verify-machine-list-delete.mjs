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
 'zh-CN':{remove:'删除主机',confirm:'确认删除',cancel:/取\s*消/,details:/详\s*情/,resolve:'查看详情并处理',alphaDetail:'主机详情 · Fixture alpha',betaDetail:'主机详情 · Fixture beta',failure:'未能删除主机“Fixture alpha”',cancelPlan:'取消计划',confirmCancel:'确认取消',id:'主机编号',warning:'此操作无法撤销',scope:'不会卸载远端 Agent 或停止业务服务。',guards:['请先撤销或等待所有有效连接凭据失效后再删除主机','该主机有未结束的部署任务，请先完成或取消后再删除','此主机有待审批、运行中或结果未知的 Agent 卸载，请先取消或核对','此主机有终端、检查或部署正在进行，请先结束后重试']},
 'en-US':{remove:'Delete host',confirm:'Confirm deletion',cancel:'Cancel',details:'Details',resolve:'View details to resolve',alphaDetail:'Host details · Fixture alpha',betaDetail:'Host details · Fixture beta',failure:'Could not delete host “Fixture alpha”',cancelPlan:'Cancel plan',confirmCancel:'Confirm cancellation',id:'Host ID',warning:'This action cannot be undone',scope:'It does not uninstall the remote Agent or stop business services.',guards:['Revoke all active connection credentials or wait for them to expire before deleting the host.','This host has an unfinished deployment. Finish or cancel it before deleting the host.','This host has a pending, running, or uncertain Agent removal. Cancel or verify it first.','This host has an active terminal, check, or deployment. Finish it and retry.']},
};
const rawGuards=copies['zh-CN'].guards;
async function harness(language='zh-CN',width=1440){
 const at=new Date().toISOString(),available={available:true,reason:''};
 const base={port:22,username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:fixtureconfirmedfingerprint',host_key_status:'confirmed',agent_id:'',agent_status:'unknown',active_credential_count:0,active_ssh_credential_count:0,active_ssh_key_count:0,ssh_recovery_available:false,capabilities:{terminal:available,ssh_check:available,deploy_agent:available,uninstall_agent:available},credential_count:0,arch:'',platform:'',updated_at:at,created_at:at};
 const machines=[{...base,id:'machine-alpha',name:'Fixture alpha',address:'alpha.example.test'},{...base,id:'machine-beta',name:'Fixture beta',address:'beta.example.test'}];
 const state={machines,requests:[],deleteError:'',deleteStatus:409,holdDelete:false,releaseDelete:undefined,holdDetails:new Set(),releaseDetails:new Map(),cancelError:'',holdNextList:false,releaseList:undefined,failList:false};
 const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(language=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.nav.collapsed','true')},language);
 const fixtures={'/api/v1/setup':{required:false},'/api/v1/auth/providers':[],'/api/v1/auth/me':{id:'fixture-admin',name:'Fixture Admin',role:'admin'},'/api/v1/auth/profile':{},'/api/v1/catalog/tables':[],'/api/v1/dashboards':[]};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(url.href);return route.abort()}
  if(path.startsWith('/api/')){
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
     if(state.holdDetails.has(id))await new Promise(resolve=>state.releaseDetails.set(id,resolve));
     return route.fulfill({json:{machine,credentials:[],deployments:[{id:'fixture-plan',machine_id:id,status:'awaiting_approval',version:'fixture',created_at:at}]}});
    }
    if(method==='DELETE'){
     if(state.holdDelete)await new Promise(resolve=>{state.releaseDelete=resolve});
     if(state.deleteError)return route.fulfill({status:state.deleteStatus,json:{error:state.deleteError}});
     state.machines=state.machines.filter(m=>m.id!==id);return route.fulfill({json:{ok:true}});
    }
   }
   if(path==='/api/v1/machines/machine-alpha/deployments/fixture-plan/cancel'&&method==='POST')return route.fulfill({status:409,json:{error:state.cancelError}});
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
let current;
try{
 for(const language of ['zh-CN','en-US']){
  const {page,state,row,deletes}=await harness(language,language==='en-US'?390:1440);current=page;const c=copies[language];
  await row('machine-alpha').getByRole('button',{name:c.remove,exact:true}).click();let dialog=page.getByRole('dialog',{name:c.remove,exact:true});
  await expect(dialog.getByText('Fixture alpha',{exact:true})).toBeVisible();await expect(dialog.getByText('alpha.example.test:22',{exact:true})).toBeVisible();await expect(dialog.getByText('machine-alpha',{exact:true})).toBeVisible();await expect(dialog.getByText(c.id,{exact:true})).toBeVisible();await expect(dialog.getByText(c.warning,{exact:true})).toBeVisible();await expect(dialog).toContainText(c.scope);
  expect(state.requests.filter(r=>r.path==='/api/v1/machines/machine-alpha')).toHaveLength(0);
  await expect(dialog).not.toHaveClass(/ant-zoom-(enter|appear)/);await expect(dialog).toHaveCSS('opacity','1');await expect(dialog).toHaveCSS('transform','none');await page.screenshot({path:resolve(media,'delete-confirmation-'+language+'.png'),fullPage:true});
  const bounds=await dialog.boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(page.viewportSize().width+1);
  await dialog.getByRole('button',{name:c.cancel,exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(deletes()).toHaveLength(0);
  await row('machine-alpha').getByRole('button',{name:c.remove,exact:true}).click();await expect(page.getByRole('dialog',{name:c.remove,exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);expect(deletes()).toHaveLength(0);mark(language+': list action binds name/address/ID without a detail fetch; Cancel and Escape send no DELETE');
  for(let i=0;i<rawGuards.length;i++){
   state.deleteError=rawGuards[i];await row('machine-alpha').getByRole('button',{name:c.remove,exact:true}).click();await page.getByRole('dialog',{name:c.remove,exact:true}).getByRole('button',{name:c.confirm,exact:true}).click();
   await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.lm-machine-delete-error')).toContainText(c.failure);await expect(page.locator('.lm-machine-delete-error')).toContainText('alpha.example.test:22');await expect(page.locator('.lm-machine-delete-error')).toContainText(c.guards[i]);await expect(row('machine-alpha')).toBeVisible();await expect(row('machine-beta')).toBeVisible();
  }
  mark(language+': credential, deployment, removal, and active-operation rejections remain visible with the correct host and translated cause');
  state.deleteError='Fixture authorization expired';state.deleteStatus=403;await row('machine-alpha').getByRole('button',{name:c.remove,exact:true}).click();await page.getByRole('dialog',{name:c.remove,exact:true}).getByRole('button',{name:c.confirm,exact:true}).click();await expect(page.locator('.lm-machine-delete-error')).toContainText(state.deleteError);await expect(row('machine-alpha')).toBeVisible();mark(language+': server permission rejection preserves the host and exact unknown cause');
  await page.getByRole('button',{name:c.resolve,exact:true}).click();dialog=page.getByRole('dialog',{name:c.alphaDetail,exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:c.remove,exact:true})).toHaveCount(0);
  state.cancelError='只能取消尚未执行的部署计划';await dialog.getByRole('button',{name:c.cancelPlan,exact:true}).click();await page.getByRole('button',{name:c.confirmCancel,exact:true}).click();await expect(dialog.locator('.lm-machine-form-notice')).toContainText(language==='zh-CN'?state.cancelError:'Only an unexecuted deployment plan can be cancelled.');
  await expect(page.locator('.lm-machine-delete-error')).toContainText('Fixture authorization expired');await dialog.locator('.ant-modal-close').click();mark(language+': rejection links to its host details; cancel-plan errors do not replace the list deletion error');
  state.deleteError='';state.holdDelete=true;await row('machine-alpha').getByRole('button',{name:c.remove,exact:true}).click();dialog=page.getByRole('dialog',{name:c.remove,exact:true});const before=deletes().length;
  await dialog.getByRole('button',{name:c.confirm,exact:true}).evaluate(button=>{button.click();button.click()});await expect.poll(()=>deletes().length).toBe(before+1);await expect(dialog.getByRole('button',{name:c.cancel,exact:true})).toBeDisabled();await expect(dialog.getByRole('button',{name:language==='zh-CN'?/确认删除/:/Confirm deletion/})).toBeDisabled();await page.keyboard.press('Escape');await expect(dialog).toBeVisible();expect(deletes().at(-1).path).toBe('/api/v1/machines/machine-alpha');state.releaseDelete();
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(row('machine-alpha')).toHaveCount(0);await expect(row('machine-beta')).toBeVisible();expect(deletes().length).toBe(before+1);await expect(page.locator('.lm-machine-delete-error')).toHaveCount(0);mark(language+': synchronous repeated confirmation sends one DELETE, locks cancellation, refreshes only the deleted row, and supports retry after rejection');
  await page.screenshot({path:resolve(media,'delete-list-'+language+'.png'),fullPage:true,animations:'disabled'});
 }
 {
  const {page,state,row}=await harness();current=page;const c=copies['zh-CN'];state.holdDetails.add('machine-beta');
  await row('machine-beta').getByRole('button',{name:c.details,exact:true}).click();await expect.poll(()=>state.releaseDetails.has('machine-beta')).toBe(true);
  state.holdDelete=true;await row('machine-alpha').getByRole('button',{name:c.remove,exact:true}).click();await page.getByRole('dialog',{name:c.remove,exact:true}).getByRole('button',{name:c.confirm,exact:true}).click();await expect.poll(()=>!!state.releaseDelete).toBe(true);
  state.releaseDetails.get('machine-beta')();await expect(page.getByRole('dialog',{name:c.betaDetail,exact:true})).toBeVisible();state.releaseDelete();await expect(row('machine-alpha')).toHaveCount(0);await expect(page.getByRole('dialog',{name:c.remove,exact:true})).toHaveCount(0);await expect(page.getByRole('dialog',{name:c.betaDetail,exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:c.betaDetail,exact:true})).toContainText('beta.example.test:22');mark('Deleting alpha leaves beta details intact when its in-flight read finishes during deletion');
 }
 {
  const {page,state,row}=await harness();current=page;const c=copies['zh-CN'];state.holdDetails.add('machine-alpha');
  await row('machine-alpha').getByRole('button',{name:c.details,exact:true}).click();await expect.poll(()=>state.releaseDetails.has('machine-alpha')).toBe(true);
  await row('machine-alpha').getByRole('button',{name:c.remove,exact:true}).click();await page.getByRole('dialog',{name:c.remove,exact:true}).getByRole('button',{name:c.confirm,exact:true}).click();await expect(row('machine-alpha')).toHaveCount(0);
  const completed=page.waitForResponse(r=>r.url()===origin+'/api/v1/machines/machine-alpha'&&r.request().method()==='GET');state.releaseDetails.get('machine-alpha')();await completed;await expect(page.getByRole('dialog')).toHaveCount(0);await expect(row('machine-beta')).toBeVisible();mark('A late detail response for a deleted host cannot reopen its stale dialog');
 }
 {
  const {page,state,row}=await harness();current=page;const c=copies['zh-CN'];state.failList=true;
  await row('machine-alpha').getByRole('button',{name:c.remove,exact:true}).click();await page.getByRole('dialog',{name:c.remove,exact:true}).getByRole('button',{name:c.confirm,exact:true}).click();
  await expect(page.getByText('Fixture list reload failed',{exact:true})).toBeVisible();await expect(row('machine-alpha')).toHaveCount(0);await expect(row('machine-beta')).toBeVisible();await expect(page.locator('.lm-machine-delete-error')).toHaveCount(0);mark('A successful DELETE removes its row immediately even when the following list refresh fails');
 }
 {
  const {page,state,row}=await harness();current=page;const c=copies['zh-CN'];state.holdNextList=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>!!state.releaseList).toBe(true);
  await row('machine-alpha').getByRole('button',{name:c.remove,exact:true}).click();await page.getByRole('dialog',{name:c.remove,exact:true}).getByRole('button',{name:c.confirm,exact:true}).click();await expect(row('machine-alpha')).toHaveCount(0);await expect(row('machine-beta')).toBeVisible();
  const completed=page.waitForResponse(r=>r.url()===origin+'/api/v1/machines'&&r.request().method()==='GET');state.releaseList();await completed;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect(row('machine-alpha')).toHaveCount(0);await expect(row('machine-beta')).toBeVisible();mark('A stale list response arriving after deletion cannot restore the deleted row');
 }
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);await writeFile(resolve(output,'machine-list-delete-ui-report.json'),JSON.stringify({checked,errors,unexpected},null,2)+'\n');
}catch(error){if(current)await current.screenshot({path:resolve(media,'machine-list-delete-failure.png'),fullPage:true}).catch(()=>{});console.error({errors,unexpected});throw error}
finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDir,{recursive:true,force:true})}
