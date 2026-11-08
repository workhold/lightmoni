import {chromium,expect} from '../web/node_modules/@playwright/test/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from './qa-artifacts.mjs';
const base=process.env.LIGHTMONI_REGISTRY_UI_URL??'http://127.0.0.1:19876',out=resolve('specs/111-registry-pull-credentials/evidence'),media=mediaDirectory(out);
await mkdir(out,{recursive:true});
const api=async(path,method='GET',body)=>{const r=await fetch(base+'/api/v1'+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error(path+' HTTP '+r.status);return r.json();};
if((await api('/auth/me')).id!=='qa-admin')throw Error('Disposable fixture required');
const original=(await api('/ops/overview')).resources.find(r=>r.name==='QA private app');
if(original.spec.registry_credential_ids?.length)await api('/ops/resources/'+original.id,'PUT',{name:original.name,revision:original.revision,spec:{...original.spec,registry_credential_ids:[]}});
for(const c of await api('/ops/registry-credentials'))await api('/ops/registry-credentials/'+c.id,'DELETE',{revision:c.revision});
let activePage;
const browser=await chromium.launch({channel:'chrome',headless:true}),rounds=[];
try{
 for(let round=1;round<=3;round++){
  const context=await browser.newContext({viewport:{width:round===3?390:1440,height:1000},deviceScaleFactor:round===2?2:1,recordVideo:{dir:media,size:{width:round===3?390:1440,height:1000}}});
  await context.addInitScript(({round})=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance',round===2?'dark':'light');},{round});
  const page=await context.newPage(),errors=[];activePage=page;page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  const app=(await api('/ops/overview')).resources.find(r=>r.name==='QA private app');
  if(app.spec.registry_credential_ids?.length)await api('/ops/resources/'+app.id,'PUT',{name:app.name,revision:app.revision,spec:{...app.spec,registry_credential_ids:[]}});
  await page.goto(base+'/image-sources');await expect(page.getByRole('button',{name:'新增仓库凭据',exact:true})).toBeVisible();
  await page.screenshot({path:resolve(media,`registry-list-${round}.png`),animations:'disabled'});
  await page.getByRole('button',{name:'新增仓库凭据',exact:true}).click();const dialog=page.getByRole('dialog');
  const name='UI registry '+round;
  await dialog.getByLabel('凭据名称',{exact:true}).fill(name);await dialog.getByLabel('仓库地址',{exact:true}).fill('http://registry.example.test');await dialog.getByLabel('用户名',{exact:true}).fill('robot');await dialog.getByLabel('密码或 Token',{exact:true}).fill('fixture-only-ui-secret');
  await dialog.getByRole('button',{name:'保存凭据',exact:true}).click();await expect(dialog.getByText(/请检查仓库地址和仓库内路径/)).toBeVisible();await expect(dialog.getByRole('button',{name:'保存凭据',exact:true})).not.toHaveClass(/ant-btn-loading/);await expect(dialog.getByLabel('凭据名称',{exact:true})).toHaveValue(name);await expect(dialog.getByLabel('密码或 Token',{exact:true})).toHaveValue('fixture-only-ui-secret');
  await page.screenshot({path:resolve(media,`registry-failure-${round}.png`),animations:'disabled'});
  await dialog.getByLabel('仓库地址',{exact:true}).fill('registry.example.test');await dialog.getByRole('button',{name:'保存凭据',exact:true}).click();await expect(dialog).not.toBeVisible();
  await page.reload();const row=page.getByRole('row').filter({hasText:name});await expect(row).toBeVisible();
  let credential=(await api('/ops/registry-credentials')).find(c=>c.name===name);if(JSON.stringify(credential).includes('fixture-only-ui-secret'))throw Error('Secret leaked');
  await row.getByRole('button',{name:/编\s*辑/ }).click();await expect(dialog.getByLabel('密码或 Token',{exact:true})).toHaveValue('');await dialog.getByLabel('凭据名称',{exact:true}).fill(name+' edited');await dialog.getByRole('button',{name:'保存凭据',exact:true}).click();await expect(dialog).not.toBeVisible();
  credential=(await api('/ops/registry-credentials')).find(c=>c.id===credential.id);expect(credential.has_password).toBe(true);expect(credential.name).toBe(name+' edited');
  await page.goto(base+'/applications');await page.getByRole('button',{name:'配置',exact:true}).first().click();await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox',{name:'镜像仓库凭据',exact:true}).click();await expect.poll(async()=>{const bounds=await page.locator('.ant-select-dropdown:visible').boundingBox();return bounds?.width??0;}).toBeGreaterThanOrEqual(280);await expect.poll(async()=>{const b=await page.locator('.ant-select-dropdown:visible').boundingBox();return !!b&&b.x>=8&&b.x+b.width<=(round===3?390:1440)-8;}).toBe(true);await page.screenshot({path:resolve(media,`application-dropdown-${round}.png`)});await page.locator('.ant-select-item-option').filter({hasText:credential.name+' · registry.example.test · robot'}).click();await dialog.locator('.ant-modal-title').click();await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  await page.screenshot({path:resolve(media,`application-binding-${round}.png`),animations:'disabled'});
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click();await expect(dialog).not.toBeVisible();
  const saved=(await api('/ops/overview')).resources.find(r=>r.id===app.id);expect(saved.spec.registry_credential_ids).toEqual([credential.id]);
  await page.goto(base+'/image-sources');const linked=page.getByRole('row').filter({hasText:credential.name});await expect(linked.getByRole('link',{name:'QA private app',exact:true})).toBeVisible();
  await linked.getByRole('button',{name:/撤\s*销/ }).click();await page.getByRole('button',{name:/确\s*定|^OK$/}).last().click();await expect(linked.getByText('已撤销',{exact:true})).toBeVisible();
  await page.screenshot({path:resolve(media,`registry-revoked-${round}.png`),animations:'disabled'});
  expect(errors).toEqual([]);rounds.push({round,width:round===3?390:1440,appearance:round===2?'dark':'light',checks:['invalid input retains secret and form','create and refresh readback','blank secret edit preserves','bind credential using application form','reference readback','revoke readback','no page errors']});
  await context.close();
 }
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem('lightmoni.language','en-US'));const page=await context.newPage();await page.goto(base+'/image-sources');await expect(page.getByRole('button',{name:'Add registry credential',exact:true})).toBeVisible();await page.getByRole('button',{name:'Add registry credential',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('Password or token',{exact:true})).toBeVisible();await page.screenshot({path:resolve(media,'registry-english.png'),animations:'disabled'});await context.close();
 await writeFile(resolve(out,'ui.json'),JSON.stringify({rounds,english:true,media:media.replace(resolve('.')+'/', '')},null,2));console.log(JSON.stringify({rounds,english:true,media:media.replace(resolve('.')+'/', '')},null,2));
}catch(e){if(activePage&&!activePage.isClosed()){await activePage.screenshot({path:resolve(media,'ui-failed.png')});console.log((await activePage.locator('body').innerText()).slice(-3500));}throw e;}finally{await browser.close();}
