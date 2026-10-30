import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:19485';
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'artifacts/screenshots/specs/050-center-endpoint-discovery');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const request=async(path,method='GET',data)=>{const r=await context.request.fetch(base+'/api/v1'+path,{method,data});expect(r.ok(),await r.text()).toBe(true);return r.json()};
try{
 const account={name:'endpoint-qa',password:'local-endpoint-qa-password'};
 const setup=await request('/setup');await request(setup.required?'/setup':'/auth/login','POST',account);
 await request('/settings/reporting','PUT',{endpoints:[{id:'public',name:'公网入口',url:'https://monitor.example.com',scope:'public'}],default_endpoint_id:'public'});
 await page.goto(base+'/admin?tab=reporting');await expect(page.getByRole('textbox',{name:'上报地址 1 URL',exact:true})).toHaveValue('https://monitor.example.com');
 await page.locator('button').filter({hasText:'新增地址'}).click();
 await page.getByRole('textbox',{name:'上报地址 2 名称',exact:true}).fill('中心内网');
 await page.getByRole('textbox',{name:'上报地址 2 URL',exact:true}).fill('http://10.0.0.8:8080');
 await page.getByRole('combobox',{name:'上报地址 2 用途',exact:true}).click();await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:'内网优先'}).click();
 await page.getByRole('button',{name:'保存上报地址',exact:true}).click();await expect.poll(async()=>(await request('/settings/reporting')).endpoints[1]?.scope).toBe('internal');
 await page.reload();await expect(page.getByRole('textbox',{name:'上报地址 2 URL',exact:true})).toHaveValue('http://10.0.0.8:8080');
 expect((await request('/sdk-install')).endpoint).toBe('https://monitor.example.com');
 await page.screenshot({path:resolve(output,'reporting-zh-1440.png'),fullPage:true});
 await page.getByRole('textbox',{name:'上报地址 2 URL',exact:true}).fill('http://10.0.0.9:9090');
 await page.route('**/api/v1/settings/reporting',r=>r.request().method()==='PUT'?r.fulfill({status:503,json:{error:'QA 保存失败'}}):r.continue());
 await page.getByRole('button',{name:'保存上报地址',exact:true}).click();await expect(page.getByText('QA 保存失败',{exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'上报地址 2 URL',exact:true})).toHaveValue('http://10.0.0.9:9090');await page.unroute('**/api/v1/settings/reporting');
 await page.getByRole('button',{name:'保存上报地址',exact:true}).click();await expect.poll(async()=>(await request('/settings/reporting')).endpoints[1].url).toBe('http://10.0.0.9:9090');
 await page.setViewportSize({width:390,height:900});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve(output,'reporting-zh-390.png'),fullPage:true});
 await page.evaluate(()=>localStorage.setItem('lightmoni.language','en-US'));await page.reload();await expect(page.getByRole('heading',{name:'Reporting address',exact:true})).toBeVisible();await page.setViewportSize({width:1440,height:1000});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve(output,'reporting-en-1440.png'),fullPage:true});
 const member={name:'endpoint-member-'+Date.now(),password:'local-endpoint-member-password',role:'member',active:true};await request('/users','POST',member);
 const memberContext=await browser.newContext();try{await memberContext.request.post(base+'/api/v1/auth/login',{data:member});expect((await memberContext.request.put(base+'/api/v1/settings/reporting',{data:{endpoints:[]}})).status()).toBe(403)}finally{await memberContext.close()}
 expect(errors).toEqual([]);await writeFile(resolve(output,'ui-report.json'),JSON.stringify({saved:true,reloaded:true,internal_ip_port_update:true,public_bootstrap:true,failed_save_retains_input:true,member_write_denied:true,languages:['zh-CN','en-US'],widths:[1440,390],errors},null,2)+'\n');console.log('PASS address scopes, internal IP/port update, public bootstrap, persisted reload, failed save, member permissions and 390px');
}catch(error){await page.screenshot({path:resolve(output,'failure.png'),fullPage:true});throw error;}finally{await context.close();await browser.close()}
