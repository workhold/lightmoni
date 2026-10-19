import { mediaDirectory } from '../../../scripts/qa-artifacts.mjs';
import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {SDK_AGENT_ENDPOINT,sdkEnvironment,sdkExamples,sdkSampleFor} from './sdkExamples.ts';

const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:19381';
const output=process.env.LIGHTMONI_QA_OUTPUT?resolve(process.env.LIGHTMONI_QA_OUTPUT):resolve(import.meta.dirname,'../../../docs/evidence/multilang-sdk');
await mkdir(output,{recursive:true});
const mediaOutput=mediaDirectory(output);
let browser;
try{browser=await chromium.launch({headless:true});}
catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true,permissions:['clipboard-read','clipboard-write']});
await context.addInitScript(()=>{localStorage.setItem('lightmoni.nav.collapsed','false');if(!localStorage.getItem('lightmoni.appearance'))localStorage.setItem('lightmoni.appearance','dark');});
const page=await context.newPage(),errors=[],checked=[];
page.on('pageerror',error=>errors.push(error.message));
const code=page.locator('pre[aria-label="业务接入 SDK 示例"]'),environment=page.locator('pre[aria-label="SDK 环境变量"]'),endpoint=page.getByRole('combobox',{name:'SDK 上报地址',exact:true});
const center='http://lightmoni:8080',agent='http://remote-agent:4318';
async function mode(value){const name=value==='direct'?'直连平台':'通过 LightMoni Agent';await page.getByText(name,{exact:true}).click();await expect(page.getByRole('radio',{name,exact:true})).toBeChecked();}
async function choose(language){await page.getByRole('combobox',{name:'SDK 语言'}).click();await page.locator('.ant-select-dropdown:visible').getByText(language,{exact:true}).click();}
try{
 const login=await context.request.post(base+'/api/v1/auth/login',{data:{name:process.env.LIGHTMONI_TEST_USER??'sdk-local-admin',password:process.env.LIGHTMONI_TEST_PASSWORD??'sdk-local-test-password'}});
 expect(login.ok()).toBe(true);
 const install=await(await context.request.get(base+'/api/v1/sdk-install')).json();expect(install.packages).toHaveLength(3);
 await page.goto(base+'/data');await expect(page.getByRole('heading',{name:'SDK 接入',exact:true})).toBeVisible();
 await expect(endpoint).toHaveValue(install.endpoint??base);await expect(page.getByRole('radio',{name:'直连平台',exact:true})).toBeChecked();
 await mode('agent');await expect(endpoint).toHaveValue(SDK_AGENT_ENDPOINT);await endpoint.fill(agent);await mode('direct');expect(await endpoint.inputValue()).not.toBe(SDK_AGENT_ENDPOINT);
 await endpoint.fill('ftp://invalid.example');await expect(page.getByText('请输入完整的 HTTP(S) 地址，不包含用户名、密码、查询参数或片段')).toBeVisible();
 await expect(page.getByRole('button',{name:/复制环境变量/})).toBeDisabled();await expect(page.getByRole('button',{name:/复制接入样例/})).toBeDisabled();
 await endpoint.fill('http://127.0.0.1:18380');await expect(page.locator('.lm-sdk-container-note')).toHaveClass(/ant-alert-warning/);
 await expect(page.locator('.lm-sdk-container-note')).toContainText('容器中的 localhost');await endpoint.fill(center);await expect(page.locator('.lm-sdk-container-note')).toHaveClass(/ant-alert-info/);
 for(const item of install.packages){
  await choose(item.language);await expect(page.locator('pre[aria-label="SDK 安装命令"]')).toHaveText(sdkExamples[item.id].install);
  for(const route of ['agent','direct']){
   await mode(route);await expect(endpoint).toHaveValue(route==='agent'?agent:center);
   const sample=sdkSampleFor(item.id,route),env=sdkEnvironment(route,route==='agent'?agent:center);
   await expect(code).toHaveText(sample);expect(await code.textContent()).toBe(sample);await expect(code).toHaveAttribute('data-language',sdkExamples[item.id].language);
   await expect(environment).toHaveText(env);await expect(code.locator('.hljs-keyword').first()).toBeVisible();expect(await code.locator('[class^=hljs-]').count()).toBeGreaterThan(3);
   expect(await code.locator('.hljs-keyword').first().evaluate(node=>getComputedStyle(node).color!==getComputedStyle(node.closest('pre')).color)).toBe(true);
   await page.getByRole('button',{name:/复制接入样例/}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(sample);
   await page.getByRole('button',{name:/复制环境变量/}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(env);
   checked.push(item.id+':'+route);
  }
  const download=page.getByRole('link',{name:'下载 SDK 与示例',exact:true});await expect(download).toHaveAttribute('href',item.url);
  const downloaded=page.waitForEvent('download');await download.click();expect((await downloaded).suggestedFilename()).toBe(item.file);
 }
 await choose('Python');await page.getByRole('button',{name:'管理上报 Key',exact:true}).click();await expect(page.getByRole('tab',{name:'上报 Key',exact:true})).toHaveAttribute('aria-selected','true');
 await page.getByRole('tab',{name:'SDK 接入',exact:true}).click();await expect(page.getByRole('radio',{name:'直连平台',exact:true})).toBeChecked();await expect(endpoint).toHaveValue(center);await expect(code).toHaveText(sdkSampleFor('python','direct'));
 await page.mouse.move(10,890);await expect(page.locator('.ant-message-notice')).toHaveCount(0,{timeout:8000});await page.screenshot({path:resolve(mediaOutput,'sdk-desktop.png'),fullPage:true,animations:'disabled'});
 const darkColor=await code.locator('.hljs-keyword').first().evaluate(node=>getComputedStyle(node).color);
 // Reload resets the form but preserves the appearance preference.
 await page.evaluate(()=>localStorage.setItem('lightmoni.appearance','light'));await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await choose('Python');await mode('direct');await endpoint.fill(center);await expect(code.locator('.hljs-keyword').first()).toBeVisible();expect(await code.locator('.hljs-keyword').first().evaluate(node=>getComputedStyle(node).color)).not.toBe(darkColor);
 await page.screenshot({path:resolve(mediaOutput,'sdk-light.png'),fullPage:true,animations:'disabled'});
 await page.evaluate(()=>localStorage.setItem('lightmoni.appearance','dark'));await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await choose('Python');await mode('direct');await endpoint.fill(center);await page.getByRole('button',{name:'收起导航',exact:true}).click();
 for(const width of [750,390]){
  await page.setViewportSize({width,height:900});await expect(endpoint).toBeVisible();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve(mediaOutput,'sdk-'+width+'.png'),fullPage:true,animations:'disabled'});
 }
 await page.setViewportSize({width:1280,height:900});await page.getByRole('tab',{name:'图表模板',exact:true}).click();await expect(page.getByRole('button',{name:'运行 SQL',exact:true})).toHaveCount(0);
 await page.getByRole('tab',{name:'数据表',exact:true}).click();await expect(page.getByRole('button',{name:'查询数据',exact:true})).toHaveCount(0);
 await page.goto(base+'/query?sql=SELECT%201');await expect(page).toHaveURL(base+'/');await expect(page.getByRole('link',{name:'SQL 工作台',exact:true})).toHaveCount(0);
 const query=await context.request.post(base+'/api/v1/query',{data:{request_id:'sdk-qa-query',range:{from:new Date(Date.now()-3600000).toISOString(),to:new Date().toISOString()},interval_ms:60000,queries:[{refId:'A',sql:'SELECT 1 AS value'}]}});
 expect(query.ok()).toBe(true);expect((await query.json()).results[0].status).toBe('success');
 expect(errors).toEqual([]);
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({routes:checked,widths:[1280,750,390],downloads:3,highlighted_samples:6,clipboard_samples:6,clipboard_environments:6,themes:['dark','light'],url_validation:true,mode_endpoint_preserved:true,key_navigation_preserves_setup:true,workbench_removed:true,query_api_preserved:true,errors},null,2)+'\n');
 console.log('PASS three SDK languages in both modes: highlighted code, exact clipboard, downloads, address validation, retained setup, themes/layout; SQL Workbench removed, query API works');
}catch(error){await page.screenshot({path:resolve(mediaOutput,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await context.close();await browser.close();}
