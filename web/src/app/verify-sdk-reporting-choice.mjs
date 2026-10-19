import {chromium,expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';
import {SDK_AGENT_ENDPOINT,sdkEnvironment,sdkExamples,sdkSampleFor} from './sdkExamples.ts';

// Exercise the real production bundle without a server or changes to a running instance.
// Only authentication and read-only SDK/catalogue API replies are fixtures.
const origin='http://127.0.0.1:19845';
const publicDirectory=resolve(import.meta.dirname,'../../../runtime/public');
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'/tmp/lightmoni-sdk-reporting-choice');
await mkdir(output,{recursive:true});
const screenshots=mediaDirectory(output),errors=[],unexpected=[],checked=[];
const platform='https://platform.example/monitor',agent='http://lightmoni-agent:4318';
const names={typescript:'TypeScript / Node.js',python:'Python',ruby:'Ruby'};
const packages=Object.keys(sdkExamples).map(id=>({id,language:names[id],runtime:names[id],file:id+'.tar.gz',url:origin+'/downloads/'+id+'.tar.gz',available:true}));
const fixtures={
 '/api/v1/auth/me':{id:'sdk-fixture-admin',name:'sdk-fixture-admin',role:'admin'},
 '/api/v1/sdk-install':{endpoint:platform,endpoints:[],version:'0.1.0',packages,deferred:[{id:'go',language:'Go',runtime:'Go 1.26+',status:'deferred',reason:'后续支持'},{id:'rust',language:'Rust',runtime:'Rust 1.85+',status:'deferred',reason:'后续支持'}],checksums_url:''},
 '/api/v1/catalog/tables':[],
 '/api/v1/templates':[],
 '/api/v1/keys':[],
};
let browser;
try{browser=await chromium.launch({headless:true});}
catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['clipboard-read','clipboard-write']});
await context.addInitScript(()=>{localStorage.setItem('lightmoni.nav.collapsed','true');localStorage.setItem('lightmoni.appearance','dark');});
await context.route('**/*',async route=>{
 const request=route.request(),url=new URL(request.url());
 if(url.origin!==origin||request.method()!=='GET'){
  unexpected.push(request.method()+' '+url.href);return route.abort();
 }
 if(Object.hasOwn(fixtures,url.pathname))return route.fulfill({json:fixtures[url.pathname]});
 if(url.pathname.startsWith('/api/')){
  unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
 }
 const path=url.pathname.startsWith('/assets/')?resolve(publicDirectory,'.'+url.pathname):resolve(publicDirectory,'index.html');
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ttf':'font/ttf'}[extname(path)]??'application/octet-stream';
 try{return await route.fulfill({body:await readFile(path),contentType:mime});}
 catch(error){unexpected.push(error.message);return route.abort();}
});
const page=await context.newPage();
page.on('pageerror',error=>errors.push(error.message));
const input=page.getByRole('combobox',{name:'SDK 上报地址',exact:true});
const environment=page.locator('pre[aria-label="SDK 环境变量"]'),sample=page.locator('pre[aria-label="业务接入 SDK 示例"]');
const modeName=mode=>mode==='direct'?'直连平台':'通过 LightMoni Agent';
async function chooseMode(mode){await page.getByText(modeName(mode),{exact:true}).click();await expect(page.getByRole('radio',{name:modeName(mode),exact:true})).toBeChecked();}
async function chooseLanguage(id){await page.getByRole('combobox',{name:'SDK 语言'}).click();await page.locator('.ant-select-dropdown:visible').getByText(names[id],{exact:true}).click();}
async function checkCopy(language,mode,endpoint){
 const env=sdkEnvironment(mode,endpoint),code=sdkSampleFor(language,mode);
 await expect(environment).toHaveText(env);await expect(sample).toHaveText(code);
 await page.getByRole('button',{name:/复制环境变量/}).click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(env);
 await page.getByRole('button',{name:/复制接入样例/}).click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(code);
}
try{
 await page.goto(origin+'/data');await expect(page.getByRole('heading',{name:'SDK 接入',exact:true})).toBeVisible();
 await expect(page.getByText('后续支持：Go、Rust。暂不提供安装包。',{exact:true})).toBeVisible();
 await page.getByRole('combobox',{name:'SDK 语言'}).click();
 const options=page.locator('.ant-select-dropdown:visible');
 await expect(options.locator('.ant-select-item-option')).toHaveCount(3);
 for(const label of ['PHP','Go','Rust'])await expect(options.getByText(label,{exact:true})).toHaveCount(0);
 await page.keyboard.press('Escape');
 await expect(page.getByRole('radio',{name:'直连平台',exact:true})).toBeChecked();await expect(input).toHaveValue(platform);
 await expect(page.getByText('业务 SDK → LightMoni 平台。',{exact:false})).toContainText('无需安装或启动 Agent');
 await input.fill('http://127.0.0.1:8080');await expect(page.locator('.lm-sdk-container-note')).toHaveClass(/ant-alert-warning/);
 await expect(page.locator('.lm-sdk-container-note')).toContainText('平台域名');await input.fill(platform);
 await chooseMode('agent');await expect(input).toHaveValue(SDK_AGENT_ENDPOINT);
 await expect(page.locator('.lm-sdk-container-note')).toHaveClass(/ant-alert-warning/);
 await expect(page.locator('.lm-sdk-container-note')).toContainText('Agent 地址');
 await expect(page.locator('.lm-sdk-mode-description').last()).toContainText('不代表平台已经入库');
 await input.fill(agent);await expect(page.locator('.lm-sdk-container-note')).toHaveClass(/ant-alert-info/);
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:900});
  for(const mode of ['direct','agent']){
   const endpoint=mode==='direct'?platform:agent;
   await chooseMode(mode);await expect(input).toHaveValue(endpoint);
   for(const language of Object.keys(sdkExamples)){
    await chooseLanguage(language);
    // Changing language retains either selected route and its separate address.
    await expect(page.getByRole('radio',{name:modeName(mode),exact:true})).toBeChecked();await expect(input).toHaveValue(endpoint);
    await checkCopy(language,mode,endpoint);
    await expect(page.locator('.lm-sdk-container-note')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    checked.push({width,language,mode});
   }
  }
  await expect(page.locator('.ant-message-notice')).toHaveCount(0,{timeout:8000});
  for(const mode of ['direct','agent']){
   await chooseMode(mode);await page.mouse.move(0,0);
   await page.screenshot({path:resolve(screenshots,mode+'-'+width+'.png'),fullPage:true,animations:'disabled'});
  }
 }
 await page.setViewportSize({width:1280,height:900});
 await input.fill('ftp://invalid.example');await expect(page.getByRole('button',{name:/复制环境变量/})).toBeDisabled();
 await expect(page.getByRole('button',{name:/复制接入样例/})).toBeDisabled();
 await input.fill(agent);await chooseMode('direct');await expect(input).toHaveValue(platform);
 await page.getByRole('button',{name:'管理上报 Key',exact:true}).click();await expect(page.getByRole('tab',{name:'上报 Key',exact:true})).toHaveAttribute('aria-selected','true');
 await page.getByRole('tab',{name:'SDK 接入',exact:true}).click();await expect(input).toHaveValue(platform);
 await expect(page.getByRole('radio',{name:'直连平台',exact:true})).toBeChecked();await expect(sample).toHaveText(sdkSampleFor('ruby','direct'));
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({production_bundle:true,supported_languages:Object.keys(names),deferred_languages:['go','rust'],php_removed:true,api_fixtures:true,live_backend:false,default_direct:true,mode_endpoints_preserved:true,language_retains_mode:true,clipboard_matches:true,container_notes_both_modes:true,key_tab_retains_setup:true,invalid_endpoint_blocks_copy:true,widths:[1280,390],checked,errors,unexpected},null,2)+'\n');
 console.log('PASS production SDK page with API fixtures: three languages × two modes × desktop/mobile, retained addresses, clipboard, validation and container hints');
}catch(error){await page.screenshot({path:resolve(screenshots,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await context.close();await browser.close();}
