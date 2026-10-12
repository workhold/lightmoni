import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Use an isolated server: this changes its defaults and creates a test member.
const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:19481';
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'/tmp/lightmoni-reporting-evidence');
await mkdir(output,{recursive:true});
let browser;
try{browser=await chromium.launch({headless:true});}
catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['clipboard-read','clipboard-write']});
await context.addInitScript(()=>localStorage.setItem('lightmoni.nav.collapsed','true'));
const page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
async function request(path,options){
 const response=await context.request.fetch(base+'/api/v1'+path,options);
 expect(response.ok(),await response.text()).toBe(true);
 return response.json();
}
const publicAddress='https://monitor.example.com/lightmoni',internalAddress='http://10.0.0.8:8080/lightmoni';
const settingsInput=page.getByRole('textbox',{name:'默认上报地址',exact:true});
const sdkInput=page.getByRole('textbox',{name:'SDK 上报地址',exact:true});
const agentInput=page.getByRole('textbox',{name:'Agent 上报地址',exact:true});
const save=()=>page.getByRole('button',{name:'保存默认地址',exact:true}).click();
async function noOverflow(){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
try{
 const setup=await request('/setup'),account={name:'reporting-qa',password:'local-reporting-qa-password'};
 await request(setup.required?'/setup':'/auth/login',{method:'POST',data:account});
 const deployed=(await request('/settings/instance')).external_url.replace(/\/+$/,'');
 await request('/settings/reporting',{method:'PUT',data:{endpoint:''}});
 await page.goto(base+'/settings?tab=reporting');await expect(settingsInput).toHaveValue('');
 await expect(settingsInput).toHaveAttribute('placeholder',deployed);
 await settingsInput.fill('ftp://invalid.example');await save();
 await expect(page.getByText('请输入完整的 HTTP(S) 地址，不包含用户名、密码、查询参数或片段',{exact:true})).toBeVisible();
 expect((await request('/settings/reporting')).endpoint).toBe('');
 await settingsInput.fill(publicAddress+'///');await save();await expect(settingsInput).toHaveValue(publicAddress);
 expect((await request('/settings/reporting')).effective_endpoint).toBe(publicAddress);
 await page.reload();await expect(settingsInput).toHaveValue(publicAddress);
 await page.screenshot({path:resolve(output,'settings-desktop.png'),fullPage:true});

 await settingsInput.fill(internalAddress);
 await page.route('**/api/v1/settings/reporting',route=>route.request().method()==='PUT'?route.fulfill({status:503,json:{error:'QA 保存失败，请重试'}}):route.continue());
 await save();await expect(page.getByText('QA 保存失败，请重试',{exact:true})).toBeVisible();
 await expect(settingsInput).toHaveValue(internalAddress);
 expect((await request('/settings/reporting')).effective_endpoint).toBe(publicAddress);
 await page.unroute('**/api/v1/settings/reporting');await save();
 await expect.poll(async()=>(await request('/settings/reporting')).effective_endpoint).toBe(internalAddress);
 await settingsInput.fill(publicAddress);await save();await expect(settingsInput).toHaveValue(publicAddress);
 await expect.poll(async()=>(await request('/settings/reporting')).effective_endpoint).toBe(publicAddress);

 await page.goto(base+'/data');await expect(sdkInput).toHaveValue('http://127.0.0.1:4318');
 await page.getByText('直连中心',{exact:true}).click();await expect(sdkInput).toHaveValue(publicAddress);
 await expect(page.getByRole('link',{name:'下载 SDK 与示例',exact:true})).toHaveAttribute('href',publicAddress+'/downloads/sdk/lightmoni-sdk-0.1.0.tgz');
 await sdkInput.fill(internalAddress);
 await expect(page.locator('pre[aria-label="SDK 环境变量"]')).toContainText("export LIGHTMONI_ENDPOINT='"+internalAddress+"'");
 await page.getByText('通过 Agent',{exact:true}).click();await expect(sdkInput).toHaveValue('http://127.0.0.1:4318');
 await page.getByText('直连中心',{exact:true}).click();await expect(sdkInput).toHaveValue(internalAddress);
 await page.getByRole('button',{name:'恢复默认地址',exact:true}).click();await expect(sdkInput).toHaveValue(publicAddress);
 await sdkInput.fill(internalAddress);await page.screenshot({path:resolve(output,'sdk-override-desktop.png'),fullPage:true});

 await page.getByRole('tab',{name:'Agent 接入',exact:true}).click();await expect(agentInput).toHaveValue(publicAddress);
 await agentInput.fill(internalAddress+'///');
 const command=page.locator('pre[aria-label="Agent 安装命令"]');
 await expect(command).toContainText(internalAddress+'/downloads/agent/install.sh');
 await expect(command).toContainText("--release-url '"+internalAddress+"/downloads/agent'");
 await expect(command).toContainText("--endpoint '"+internalAddress+"'");
 await expect(command).not.toContainText('monitor.example.com');
 await page.getByRole('textbox',{name:'Agent 上报 Key',exact:true}).fill('local-qa-write-key');
 await page.getByRole('button',{name:'复制安装命令',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(await command.textContent());
 await expect(command).not.toContainText('local-qa-write-key');
 await agentInput.fill('http://center/?key=value');await expect(page.getByRole('button',{name:'复制安装命令',exact:true})).toBeDisabled();
 await agentInput.fill(internalAddress);await page.screenshot({path:resolve(output,'agent-override-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'恢复默认地址',exact:true}).click();await expect(agentInput).toHaveValue(publicAddress);
 expect((await request('/settings/reporting')).effective_endpoint).toBe(publicAddress);

 const member={name:'reporting-member-'+Date.now(),password:'local-reporting-member-password'};
 await request('/users',{method:'POST',data:{...member,role:'member',active:true}});
 const memberContext=await browser.newContext();
 try{
  expect((await memberContext.request.post(base+'/api/v1/auth/login',{data:member})).ok()).toBe(true);
  expect((await memberContext.request.get(base+'/api/v1/settings/reporting')).ok()).toBe(true);
  expect((await memberContext.request.put(base+'/api/v1/settings/reporting',{data:{endpoint:internalAddress}})).status()).toBe(403);
 }finally{await memberContext.close();}

 await page.setViewportSize({width:390,height:900});await noOverflow();
 await page.screenshot({path:resolve(output,'agent-390.png'),fullPage:true});
 await page.goto(base+'/settings?tab=reporting');await expect(settingsInput).toHaveValue(publicAddress);await noOverflow();
 await page.screenshot({path:resolve(output,'settings-390.png'),fullPage:true});
 await settingsInput.fill('');await save();
 await expect.poll(async()=>(await request('/settings/reporting')).effective_endpoint).toBe(deployed);
 for(const path of ['/sdk-install','/agent-install'])expect((await request(path)).endpoint).toBe(deployed);
 await page.goto(base+'/data');await expect(sdkInput).toHaveValue('http://127.0.0.1:4318');
 await page.getByText('直连中心',{exact:true}).click();await expect(sdkInput).toHaveValue(deployed);await noOverflow();
 expect(errors).toEqual([]);
 await writeFile(resolve(output,'report.json'),JSON.stringify({saved_and_reloaded:true,save_failure_preserves_input:true,network_overrides:true,agent_downloads_follow_override:true,restore_default:true,member_permissions:true,widths:[1280,390],errors},null,2)+'\n');
 console.log('PASS persistent reporting defaults, SDK/Agent A/B overrides, installer downloads, reset, failed save, member permissions and mobile layout');
}catch(error){await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await context.close();await browser.close();}
