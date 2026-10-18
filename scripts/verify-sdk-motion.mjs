// Run only against the isolated SDK onboarding QA instance, after the UI checks.
import {chromium,expect} from '../web/node_modules/@playwright/test/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from './qa-artifacts.mjs';
const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:15176',output=resolve('docs/evidence/telemetry-table-model'),media=mediaDirectory(output);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),report=[];
await context.request.post(base+'/api/v1/auth/login',{data:{name:'sdk-onboarding-qa',password:'local-sdk-onboarding-password'}});
try{
 await page.goto(base+'/data');await page.locator('.lm-sdk-config').waitFor();
 async function frames(selector,name,duration){
  for(const [label,time] of [['start',0],['mid',duration/2],['end',duration]]){
   const state=await page.locator(selector).evaluate((el,time)=>{const animation=el.getAnimations().find(item=>item.animationName==='lm-sdk-enter');if(!animation)throw Error('missing entry animation');animation.pause();animation.currentTime=time;return {opacity:getComputedStyle(el).opacity,transform:getComputedStyle(el).transform};},time);
   report.push({name,label,time,...state});await page.screenshot({path:resolve(media,`${name}-${label}.png`)});
  }
 }
 await frames('.lm-sdk-config','entry',220);
 await page.getByText('无密钥模式',{exact:true}).click();await frames('.lm-sdk-anonymous','authentication',160);
 await page.getByText('使用 SDK 密钥',{exact:true}).click();await page.getByRole('combobox',{name:'SDK 密钥',exact:true}).click();await page.getByRole('button',{name:'创建 SDK 密钥',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'创建 SDK 密钥',exact:true});await dialog.getByRole('textbox',{name:'密钥名称',exact:true}).fill('SDK 动效验收');await page.screenshot({path:resolve(media,'create-start.png')});
 let release,blocked;const pending=new Promise(resolve=>release=resolve),intercepted=new Promise(resolve=>blocked=resolve);
 await page.route('**/api/v1/keys',async route=>{if(route.request().method()==='POST'){blocked();await pending;}await route.continue();});
 await dialog.getByRole('button',{name:'创建并选择'}).click();await intercepted;await expect(dialog.locator('button[type=submit]')).toHaveClass(/loading/);await page.screenshot({path:resolve(media,'create-mid.png')});
 const response=page.waitForResponse(res=>res.url().endsWith('/api/v1/keys')&&res.request().method()==='POST');release();const result=await(await response).json();await expect(dialog).toBeHidden();await expect(page.getByRole('button',{name:'复制接入样例',exact:true})).toBeEnabled();await page.screenshot({path:resolve(media,'create-end.png'),mask:[page.getByLabel('SDK 环境变量',{exact:true})]});
 await context.request.put(base+'/api/v1/keys/'+result.id,{data:{active:false}});
 report.push({name:'create',states:['dialog','loading','created and selected'],secretMasked:true});
 await writeFile(resolve(output,'motion.json'),JSON.stringify({passed:true,report},null,2));console.log('SDK motion: entry/authentication frames and create loading/result passed');
}finally{await browser.close();}
