import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// Production UI -> isolated HTTP/WS -> real loopback SSH password/PTY protocol.
// The fixture generates a random password, never prints it, and never executes
// OS commands or touches a user platform, credentials, host, or SSH daemon.
const root=resolve(import.meta.dirname,'../../..'),output=resolve(root,'specs/030-machine-lifecycle-validation'),media=mediaDirectory(output);
await mkdir(output,{recursive:true});
const fixture=spawn(process.execPath,['--import','tsx','test/helpers/terminal-ui-server.ts'],{cwd:resolve(root,'runtime'),env:{...process.env,LIGHTMONI_TERMINAL_AUTH:'password'},stdio:['ignore','pipe','pipe']});
let fixtureErrors='';fixture.stderr.on('data',b=>{fixtureErrors+=b.toString()});
const ready=await new Promise((resolve,reject)=>{
 let data='';fixture.stdout.on('data',chunk=>{data+=chunk.toString();if(data.includes('\n')){try{resolve(JSON.parse(data.split('\n')[0]))}catch(e){reject(e)}}});fixture.once('exit',()=>reject(Error('Fixture exited: '+fixtureErrors)));
});
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const checked=[],errors=[],unexpected=[],contexts=[];const mark=s=>{checked.push(s);console.log('PASS '+s)};
async function pageFor(language){
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});contexts.push(context);
 await context.addCookies([{name:'lm_session',value:'fixture-browser-login',url:ready.origin}]);
 await context.addInitScript(language=>localStorage.setItem('lightmoni.language',language),language);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&new URL(r.url()).pathname.startsWith('/api/'))unexpected.push(r.status()+' '+new URL(r.url()).pathname)});
 await page.goto(ready.origin+'/machines');return page;
}
let page;
try{
 page=await pageFor('zh-CN');await page.getByRole('button',{name:'登录终端',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已连接'})).toBeVisible();
 await expect(page.getByText('密码终端结束或连接失败后，会自动撤销并清除已保存的密码。重新连接请添加新密码。',{exact:true})).toBeVisible();
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('fixture-identify');await page.locator('.xterm-helper-textarea').press('Enter');
 await expect.poll(()=>page.locator('.xterm-screen').innerText()).toContain('FIXTURE_USER=fixture');mark('Chinese UI opens a real SSH password/PTY connection and renders identification output');
 await page.locator('.ant-modal:visible').screenshot({path:resolve(media,'password-terminal-zh.png'),animations:'disabled'});
 await page.getByRole('button',{name:'断开',exact:true}).click();await expect(page.getByRole('button',{name:'重新连接',exact:true})).toBeDisabled();
 await expect(page.getByText('请添加有效的无口令 SSH 私钥或新的一次性密码。',{exact:true})).toBeVisible();mark('Disconnect consumes the one-time password locally and prevents reconnect');
 await page.locator('.ant-modal-close').click();await expect(page.getByRole('button',{name:'登录终端',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'添加新的 SSH 凭据',exact:true})).toBeVisible();mark('Terminal release refreshes capabilities and prevents reopening with the consumed password');
 const seeded=await page.request.post(ready.origin+'/api/v1/fixtures/password-credential',{headers:{origin:ready.origin},data:{}});expect(seeded.ok()).toBe(true);
 await page.close();page=await pageFor('en-US');await page.getByRole('button',{name:'Open terminal',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Connected'})).toBeVisible();
 await expect(page.getByText('Stored passwords are revoked and cleared when the terminal ends or connection fails. Add a new password to reconnect.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();await expect(page.getByRole('button',{name:'Reconnect',exact:true})).toBeDisabled();mark('English password terminal warning and single-use reconnect behavior match Chinese');
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 await writeFile(resolve(output,'password-terminal-ui-report.json'),JSON.stringify({checked,errors,unexpected},null,2)+'\n');
}catch(error){if(page)await page.screenshot({path:resolve(media,'password-terminal-failure.png'),fullPage:true}).catch(()=>{});console.error({errors,unexpected,fixtureErrors});throw error}
finally{for(const context of contexts)await context.close();await browser.close();fixture.kill('SIGTERM');await once(fixture,'exit')}
