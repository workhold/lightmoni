import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';
const base='http://127.0.0.1:5196',out=resolve('specs/091-deployment-autoconfiguration/evidence'),media=mediaDirectory(out);
await mkdir(media,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),rounds=[];
const api=async(path,body)=>{const r=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(path+' '+r.status);return r.json()};
try{
 if((await api('/auth/me')).id!=='qa-admin')throw Error('Disposable fixture required');
 let resources=(await api('/ops/overview')).resources,cluster=resources.find(r=>r.kind==='cluster');
 let zone=resources.find(r=>r.kind==='dns_zone');
 if(!zone){const cred=(await api('/ops/resources',{kind:'credential',name:'DNS fixture',spec:{provider:'aliyun',access_key_id:'fixture',access_key_secret:'fixture-secret'}})).resource;zone=(await api('/ops/resources',{kind:'dns_zone',name:'Hosted example.test',spec:{domain:'example.test',credential_id:cred.id}})).resource}
 let gateway=resources.find(r=>r.kind==='application'&&r.spec.role==='openresty');
 if(!gateway)gateway=(await api('/ops/catalog/openresty/install',{confirmed:false,deployments:[{cluster_id:cluster.id,machine_ids:[cluster.spec.machine_ids[0]]}],deployment_mode:'manual'})).resource;
 resources=(await api('/ops/overview')).resources;
 if(!resources.some(r=>r.kind==='website'))await api('/ops/resources',{kind:'website',name:'UI website',spec:{cluster_ids:[cluster.id],dns_record_mode:'cname',bindings:[{domains:['ui.example.test'],dns_enabled:true,dns_zone_id:zone.id,locations:[{path:'/',action:'return',return_status:200,return_value:'ok'}]}]}});
 for(let round=1;round<=3;round++){
 const context=await browser.newContext({viewport:{width:round===3?390:1440,height:1000},deviceScaleFactor:round===2?2:1,recordVideo:{dir:media,size:{width:round===3?390:1440,height:1000}}});
 await context.addInitScript(()=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance','light')});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 await page.goto(base+'/private-images');await page.getByRole('button',{name:'安装 Docker Registry',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog.getByLabel('宿主端口',{exact:true})).toBeVisible();await expect(dialog).not.toHaveClass(/ant-zoom-enter/);
 await expect(dialog.getByLabel('宿主端口',{exact:true})).toHaveValue('0');
 await expect(dialog.locator('strong').filter({hasText:'5000'})).toBeVisible();await expect(dialog.getByText(/5001|5002/)).toHaveCount(0);
 await page.screenshot({animations:'disabled',path:resolve(media,`registry-single-${round}.png`)});await dialog.getByRole('button',{name:/取\s*消/}).click();
 await page.goto(base+'/websites');await page.getByRole('button',{name:'OpenResty 管理',exact:true}).first().click();
 const entry=page.locator('.lm-ops-entry-manager');await expect(entry.locator('.lm-entry-domain')).toContainText('edge-');
 await entry.getByRole('button',{name:'编辑入口解析',exact:true}).first().click();
 await expect(entry.getByLabel('集群入口域名',{exact:true})).toHaveCount(0);await expect(entry.getByLabel('托管域名',{exact:true})).toBeVisible();
 await page.screenshot({animations:'disabled',path:resolve(media,`entry-generated-${round}.png`)});
 if(round===2)await entry.locator('.lm-entry-editor').screenshot({animations:'disabled',path:resolve(media,'entry-editor-200.png')});
 expect(errors).toEqual([]);rounds.push({round,width:round===3?390:1440,checks:['one registry port 5000','automatic host port 0','generated entry domain','zone-only entry editor','no page error']});
 await context.close();
 }
 await writeFile(resolve(out,'deployment-ui.json'),JSON.stringify({rounds,media},null,2));console.log(JSON.stringify({rounds,media},null,2));
}finally{await browser.close()}
