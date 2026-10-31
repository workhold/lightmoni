import {chromium,expect} from '@playwright/test';
import {createServer} from 'vite';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';
const root=resolve(import.meta.dirname,'../../../..'),out=resolve(root,'specs/053-certificate-async-issuance/evidence'),media=mediaDirectory(out);await mkdir(out,{recursive:true});
const fixture=spawn(process.execPath,['--import','./runtime/node_modules/tsx/dist/loader.mjs','runtime/test/fixtures/certificate-async-ui-server.ts'],{cwd:root,stdio:['ignore','pipe','pipe']});
const backend=await new Promise((resolve,reject)=>{let output='';fixture.stdout.on('data',data=>{output+=data;try{resolve(JSON.parse(output.trim()).base)}catch{}});fixture.once('exit',code=>reject(Error('fixture exited '+code)));fixture.stderr.on('data',data=>process.stderr.write(data));});
const vite=await createServer({root:resolve(root,'web'),configFile:resolve(root,'web/vite.config.ts'),server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:backend,changeOrigin:true,configure(proxy){proxy.on('proxyReq',request=>request.setHeader('origin',backend))}}}},logLevel:'error'});await vite.listen();
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);await context.addInitScript(()=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance','light')});
const drawer=()=>page.locator('.ant-drawer:visible').last(),modal=()=>page.locator('.ant-modal:visible').last();
const button=(scope,name)=>scope.getByRole('button',{name:/^[一-鿿]{2}$/.test(name)?new RegExp('^'+name[0]+'\\s*'+name[1]+'$'):name,exact:true}).and(scope.locator('.ant-btn'));
try{
 await page.goto(vite.resolvedUrls.local[0]+'certificates');await button(page,'新建证书').click();
 await modal().getByLabel('名称',{exact:true}).fill('异步申请验收');
 // The regular certificate form defaults to ACME, with the saved account/zone chosen explicitly.
 await modal().locator('input[id$="domains"]').fill('example.test');await page.keyboard.press('Enter');
 await modal().locator('input[id$="acme_account_id"]').click();await page.locator('.ant-select-dropdown:visible').getByTitle('QA ACME',{exact:true}).click();
 await modal().locator('input[id$="dns_zone_ids"]').click();await page.locator('.ant-select-dropdown:visible').getByTitle('example.test',{exact:true}).click();await modal().getByLabel('名称',{exact:true}).click();
 await button(modal(),'保存并开始执行').click();await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
 await expect(page.getByText('申请中',{exact:true})).toBeVisible();checks.push('Creating an ACME certificate closes immediately while DNS propagation is blocked');
 await page.getByRole('button',{name:'证书执行日志 · 异步申请验收',exact:true}).click();
 await expect(drawer().getByText('等待 DNS 传播',{exact:true}).first()).toBeVisible();await expect(drawer().getByText('写入并回读 DNS TXT 记录',{exact:true}).first()).toBeVisible();
 await page.screenshot({path:resolve(media,'certificate-pending.png'),fullPage:true,animations:'disabled'});checks.push('Status log icon opens persisted real Router/SQLite ACME and DNS progress');
 await fetch(backend+'/api/v1/qa/release',{method:'POST'});
 await expect(drawer().getByText(/DNS problem: NXDOMAIN/).first()).toBeVisible({timeout:10000});
 await expect(drawer().getByText('清理并回读 DNS 验证记录',{exact:true}).first()).toBeVisible();
 await expect(drawer()).not.toContainText('qa-hidden-');await page.screenshot({path:resolve(media,'certificate-failed.png'),fullPage:true,animations:'disabled'});checks.push('Automatic polling shows the CA DNS problem and cleanup, without challenge values or credentials');
 const firstID=(await (await fetch(backend+'/api/v1/qa/state')).json()).certificates[0].status.last_run_id;
 await drawer().locator('.ant-drawer-close').click();
 await button(page,'执行').click();await button(modal(),'确认执行').click();await expect(page.locator('.ant-modal:visible')).toHaveCount(0);await expect(drawer()).toBeVisible();
 checks.push('Manual issuance returns immediately and opens the same execution history drawer');
 await drawer().getByRole('combobox',{name:'执行记录',exact:true}).click();await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:firstID.slice(0,6)}).click();await expect(drawer().getByText(firstID,{exact:true})).toBeVisible();checks.push('History selection loads the selected execution without mixing events');
 await context.addInitScript(()=>localStorage.setItem('lightmoni.language','en-US'));await page.reload();await expect(page.getByRole('button',{name:'Certificate execution logs · 异步申请验收'})).toBeVisible();
 await page.getByRole('button',{name:'Certificate execution logs · 异步申请验收'}).click();await expect(drawer().getByText('Execution state',{exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await expect.poll(async()=>{const b=await drawer().locator('.ant-drawer-content-wrapper').boundingBox();return b&&b.x>=-1&&b.width<=390}).toBeTruthy();await page.screenshot({path:resolve(media,'certificate-mobile-en.png'),fullPage:true,animations:'disabled'});checks.push('English and narrow-screen execution drawer render without runtime errors');
 await fetch(backend+'/api/v1/qa/legacy',{method:'POST'});await page.setViewportSize({width:1440,height:1000});await page.reload();await page.getByRole('button',{name:'Certificate execution logs · 旧记录验收'}).click();await expect(drawer().getByText(/This older receipt contains only an error code/)).toBeVisible();await expect(drawer().getByText(/older history cannot be reconstructed/)).toBeVisible();checks.push('Legacy generic errors explain that historical causes cannot be reconstructed');
 expect(errors).toEqual([]);await writeFile(resolve(out,'ui-report.json'),JSON.stringify({passed:checks.length,checks,errors,backend:'Real loopback Router + SQLite; synthetic ACME/DNS peers; no production requests',screenshots:['certificate-pending.png','certificate-failed.png','certificate-mobile-en.png'].map(name=>relative(root,resolve(media,name)))},null,2));
 console.log(JSON.stringify({passed:checks.length,errors}));
}catch(error){console.log(await page.locator('body').innerText());await page.screenshot({path:resolve(media,'debug-failure.png'),fullPage:true,animations:'disabled'});throw error;}finally{await browser.close();await vite.close();fixture.kill('SIGTERM')}
