// Dedicated local QA server only; no provider calls or external machine connections.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,expect} from '../web/node_modules/@playwright/test/index.mjs';

const base='http://127.0.0.1:18887',account={name:'metric-period-qa',password:'local-metric-period-password'};
const output=resolve('artifacts/screenshots/metric-main-integration');await mkdir(output,{recursive:true});
const evidence={passed:false,checked_at:new Date().toISOString(),sdk_packages:[],pages:[],page_errors:[],http_500:[]};
let browser,context,page,keyID;
try {
 try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
 context=await browser.newContext({viewport:{width:1440,height:1050},timezoneId:'Asia/Shanghai'});
 const login=await context.request.post(base+'/api/v1/auth/login',{data:account});assert.equal(login.status(),200);
 const installation=await (await context.request.get(base+'/api/v1/sdk-install')).json();
 assert.deepEqual(installation.packages.map(pkg=>pkg.id),['go','typescript','python','rust']);
 const checksums=await (await context.request.get(base+'/downloads/sdk/SDK_SHA256SUMS')).text();
 for(const pkg of installation.packages){
  assert.equal(pkg.available,true,pkg.id);const response=await context.request.get(pkg.url);assert.equal(response.status(),200,pkg.id);
  const digest=createHash('sha256').update(await response.body()).digest('hex');assert.ok(checksums.includes(digest+'  '+pkg.file));
  evidence.sdk_packages.push({id:pkg.id,downloaded:true,checksum_verified:true});
 }
 page=await context.newPage();page.on('pageerror',error=>evidence.page_errors.push(error.message));page.on('response',response=>{if(response.status()>=500)evidence.http_500.push({path:new URL(response.url()).pathname,status:response.status()});});
 await page.goto(base+'/data?tab=keys');await expect(page.getByRole('heading',{name:'SDK 接入',exact:true})).toBeVisible();
 await page.getByRole('button',{name:/SDK 密钥/}).click();
 await page.getByRole('textbox',{name:'密钥名称'}).fill('main integration SDK '+Date.now());
 const [created]=await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/keys'&&response.request().method()==='POST'),page.getByRole('dialog').getByRole('button',{name:/^创\s*建$/}).click()]);
 assert.equal(created.status(),201);keyID=(await created.json()).id;
 await page.getByRole('dialog',{name:'SDK 密钥已创建'}).getByRole('button',{name:'已保存',exact:true}).click();
 await page.getByRole('tab',{name:'SDK 样例',exact:true}).click();
 await page.getByText('无密钥模式',{exact:true}).click();
 const languages=['Go','Node.js','Rust','Python'];
 for(const name of languages){await page.getByRole('combobox',{name:'SDK 语言',exact:true}).click();await page.locator('.ant-select-item-option').filter({has:page.getByText(name,{exact:true})}).click();await expect(page.getByRole('button',{name:/复制接入样例/})).toBeEnabled();}
 await expect(page.getByRole('tab',{name:'豁免表',exact:true})).toBeVisible();
 await page.screenshot({path:resolve(output,'sdk.png'),fullPage:true,animations:'disabled'});evidence.pages.push({path:'/data',sdk_languages:languages,three_tabs:true});
 await page.goto(base+'/agents');await page.getByRole('tab',{name:'任务管理',exact:true}).click();
 await page.getByRole('button',{name:/新建任务/}).click();
 const editor=page.getByRole('dialog',{name:'新建任务',exact:true});await expect(editor.getByText('host',{exact:true})).toBeVisible();await expect(editor.getByRole('textbox',{name:'指标上报表',exact:true})).toHaveCount(0);
 await editor.getByRole('button',{name:/取\s*消/}).click();evidence.pages.push({path:'/agents',main_task_management:true,fixed_reporting_table:true});
 await page.goto(base+'/agents/install');await expect(page.getByRole('heading',{name:'接入执行节点',exact:true})).toBeVisible();evidence.pages.push({path:'/agents/install',main_enrollment:true});
 await page.goto(base+'/machines');await expect(page.getByRole('heading',{name:'主机管理',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/登记主机/})).toBeVisible();evidence.pages.push({path:'/machines',main_machine_management:true});
 await page.goto(base+'/settings?tab=appearance');await page.getByRole('combobox',{name:'显示语言',exact:true}).click();await page.locator('.ant-select-item-option').filter({has:page.getByText('English',{exact:true})}).click();
 await expect(page.getByRole('heading',{name:'Personal settings',exact:true})).toBeVisible();
 await page.goto(base+'/machines');await expect(page.getByRole('heading',{name:'Host management',exact:true})).toBeVisible();
 await page.screenshot({path:resolve(output,'main-machines-english.png'),fullPage:true,animations:'disabled'});evidence.pages.push({path:'/settings?tab=appearance',main_language_preferences:true});
 assert.deepEqual(evidence.page_errors,[]);assert.deepEqual(evidence.http_500,[]);evidence.passed=true;
}catch(error){evidence.failure=error.message;await page?.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{
 if(keyID)await context.request.put(base+'/api/v1/keys/'+keyID,{data:{active:false}});
 await browser?.close();await mkdir('docs/evidence/metric-main-integration',{recursive:true});await writeFile('docs/evidence/metric-main-integration/report.json',JSON.stringify(evidence,null,2)+'\n');
}
console.log(JSON.stringify({passed:evidence.passed,sdk_packages:evidence.sdk_packages.length,pages:evidence.pages.length,page_errors:evidence.page_errors.length}));
