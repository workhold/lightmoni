import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// Real production UI -> HTTP/WebSocket -> disposable sshd with temporary keys.
// No user platform DB, accounts, hosts or private keys are used.
const root=resolve(import.meta.dirname,'../../..'),output=resolve(root,'specs/018-machine-web-terminal'),media=mediaDirectory(output);
await mkdir(output,{recursive:true});
const fixture=spawn(process.execPath,['--import','tsx','test/helpers/terminal-ui-server.ts'],{cwd:resolve(root,'runtime'),stdio:['ignore','pipe','pipe']});
let fixtureErrors='';fixture.stderr.on('data',b=>{fixtureErrors+=b.toString()});
const ready=await new Promise((resolve,reject)=>{
 let data='';fixture.stdout.on('data',chunk=>{data+=chunk.toString();if(data.includes('\n')){try{resolve(JSON.parse(data.split('\n')[0]))}catch(e){reject(e)}}});fixture.once('exit',()=>reject(Error('Fixture exited: '+fixtureErrors)));
});
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const checked=[],errors=[],unexpected=[];const mark=s=>{checked.push(s);console.log('PASS '+s)};
const contexts=[];
async function pageFor(language='zh-CN'){
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});contexts.push(context);
 await context.addCookies([{name:'lm_session',value:'fixture-browser-login',url:ready.origin}]);
 await context.addInitScript(language=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.nav.collapsed','true')},language);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&new URL(r.url()).pathname.startsWith('/api/'))unexpected.push(r.status()+' '+new URL(r.url()).pathname)});
 await page.goto(ready.origin+'/machines');return page;
}
const input=page=>page.locator('.xterm-helper-textarea');
const outputText=async page=>page.locator('.xterm-screen').innerText();
const command=async(page,line)=>{await input(page).focus();await page.keyboard.insertText(line);await input(page).press('Enter')};
let page;
try{
 page=await pageFor();await page.getByRole('button',{name:'登录终端',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已连接'})).toBeVisible();
 await command(page,"printf '\\nBROWSER_%s\\n' '你好'");await expect.poll(()=>outputText(page)).toContain('BROWSER_你好');mark('Real browser terminal automatically logs in and renders UTF-8 command output');
 await command(page,'sleep 20');await input(page).press('Control+c');await command(page,"printf '\\nINT_%s\\n' 'OK'");await expect.poll(()=>outputText(page)).toContain('INT_OK');mark('Ctrl+C interrupts the remote command and shell remains usable');
 const screen=page.locator('.lm-terminal-screen'),before=await screen.boundingBox(),beforeRows=await page.locator('.xterm-rows > div').count();await page.getByRole('button',{name:'全屏切换',exact:true}).click();await expect.poll(async()=>Math.round((await screen.boundingBox()).height)).toBeGreaterThan(Math.round(before.height));
 await expect.poll(()=>page.locator('.xterm-rows > div').count()).toBeGreaterThan(beforeRows);
 const fullRows=await page.locator('.xterm-rows > div').count();await command(page,"printf 'SIZE_FULL '; stty size");await expect.poll(()=>outputText(page)).toMatch(new RegExp('SIZE_FULL '+fullRows+' \\d+')); mark('Fullscreen fits the terminal and propagates PTY resize');
 await page.locator('.ant-modal:visible').screenshot({path:resolve(media,'terminal-fullscreen.png'),animations:'disabled'});
 await page.getByRole('button',{name:'全屏切换',exact:true}).click();await page.getByRole('button',{name:'断开',exact:true}).click();await expect(page.getByText('已主动断开连接。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'重新连接',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已连接'})).toBeVisible();mark('Disconnect and reconnect release the previous host lease');
 await page.locator('.ant-modal-close').click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'登录终端',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已连接'})).toBeVisible();mark('Closing and reopening the window releases the SSH session');
 await page.locator('.ant-modal:visible').screenshot({path:resolve(media,'terminal-window.png'),animations:'disabled'});
 await page.goto(ready.origin+'/settings');await page.goto(ready.origin+'/machines');await page.getByRole('button',{name:'登录终端',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已连接'})).toBeVisible();mark('Navigation unmount closes the terminal and frees the host');
 await page.locator('.ant-modal-close').click();
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'登录终端',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已连接'})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator('.ant-modal:visible').screenshot({path:resolve(media,'terminal-mobile.png'),animations:'disabled'});mark('Narrow viewport keeps the terminal dialog usable');
 await page.locator('.ant-modal-close').click();await page.close();
 page=await pageFor('en-US');await page.getByRole('button',{name:'Open terminal',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Connected'})).toBeVisible();await expect(page.getByRole('button',{name:'Toggle fullscreen',exact:true})).toBeVisible();mark('English terminal controls and status are localized');
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();
 // Add a second metadata-bound key to verify explicit selection; the private
 // key is intentionally invalid and never used to connect in this scenario.
 await page.request.post(ready.origin+`/api/v1/machines/${ready.machineID}/credentials`,{data:{method:'ssh_key',secret:'-----BEGIN OPENSSH PRIVATE KEY-----\ninvalid-fixture-only\n-----END OPENSSH PRIVATE KEY-----'}});
 await page.locator('.ant-modal-close').click();await page.getByRole('button',{name:'Open terminal',exact:true}).click();await expect(page.getByRole('combobox',{name:'Terminal SSH private key'})).toBeVisible();await expect(page.getByRole('button',{name:'Connect',exact:true})).toBeDisabled();mark('Multiple private keys require explicit selection without silently using the first');
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({checked,errors,unexpected},null,2)+'\n');
}catch(error){if(page)await page.screenshot({path:resolve(media,'terminal-failure.png'),fullPage:true}).catch(()=>{});console.error({errors,unexpected,fixtureErrors});throw error}
finally{for(const c of contexts)await c.close();await browser.close();fixture.kill('SIGTERM');await once(fixture,'exit')}
