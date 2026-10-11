import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {sdkExamples} from './sdkExamples.ts';

const base = process.env.LIGHTMONI_UI_URL ?? 'http://127.0.0.1:19381';
const output = process.env.LIGHTMONI_QA_OUTPUT ? resolve(process.env.LIGHTMONI_QA_OUTPUT) : resolve(import.meta.dirname,'../../../docs/evidence/multilang-sdk');
await mkdir(output,{recursive:true});
let browser;
try { browser = await chromium.launch({headless:true}); }
catch { browser = await chromium.launch({headless:true,channel:'chrome'}); }
const context = await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true,permissions:['clipboard-read','clipboard-write']});
const page = await context.newPage();
const errors = [];
page.on('pageerror',error => errors.push(error.message));
try {
  const login = await context.request.post(base+'/api/v1/auth/login',{data:{name:process.env.LIGHTMONI_TEST_USER??'sdk-local-admin',password:process.env.LIGHTMONI_TEST_PASSWORD??'sdk-local-test-password'}});
  expect(login.ok()).toBe(true);
  const response = await context.request.get(base+'/api/v1/sdk-install');
  const install = await response.json();
  expect(install.packages).toHaveLength(8);
  await page.goto(base+'/data');
  await expect(page.getByRole('heading',{name:'SDK 接入',exact:true})).toBeVisible();
  const select = page.getByRole('combobox',{name:'SDK 语言'});
  const checked = [];
  for (const item of install.packages) {
    await select.click();
    await page.locator('.ant-select-dropdown:visible').getByText(item.language,{exact:true}).click();
    await expect(page.locator('pre.lm-code').nth(0)).toHaveText(sdkExamples[item.id].install);
    await expect(page.locator('pre.lm-code').nth(1)).toHaveText(sdkExamples[item.id].sample);
    const example=page.locator('pre.lm-highlighted-code').nth(1);
    await expect(example).toHaveAttribute('data-language',sdkExamples[item.id].language);
    expect(await example.textContent()).toBe(sdkExamples[item.id].sample);
    await expect(example.locator('.hljs-keyword').first()).toBeVisible();
    expect(await example.locator('[class^=hljs-]').count()).toBeGreaterThan(3);
    expect(await example.locator('.hljs-keyword').first().evaluate(node=>getComputedStyle(node).color!==getComputedStyle(node.closest('pre')).color)).toBe(true);
    await page.getByRole('button',{name:/复制接入样例/}).click();
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(sdkExamples[item.id].sample);
    const download = page.getByRole('link',{name:'下载 SDK 与示例',exact:true});
    await expect(download).toHaveAttribute('href',item.url);
    const downloaded = page.waitForEvent('download');
    await download.click();
    expect((await downloaded).suggestedFilename()).toBe(item.file);
    checked.push(item.id);
  }
  await select.click();
  await page.locator('.ant-select-dropdown:visible').getByText('Python',{exact:true}).click();
  await select.press('Escape');await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  await page.screenshot({path:resolve(output,'sdk-desktop.png'),animations:'disabled'});
  const keyword=page.locator('.lm-highlighted-code').nth(1).locator('.hljs-keyword').first();
  const darkColor=await keyword.evaluate(node=>getComputedStyle(node).color);
  await page.evaluate(()=>localStorage.setItem('lightmoni.appearance','light'));await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await expect(page.locator('.lm-highlighted-code').nth(1).locator('.hljs-keyword').first()).toBeVisible();
  expect(await keyword.evaluate(node=>getComputedStyle(node).color)).not.toBe(darkColor);
  await page.screenshot({path:resolve(output,'sdk-light.png'),animations:'disabled'});
  await page.evaluate(()=>localStorage.setItem('lightmoni.appearance','dark'));await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.locator('.lm-highlighted-code').nth(1).locator('.hljs-keyword').first()).toBeVisible();
  if(await page.getByRole('button',{name:'收起导航',exact:true}).count())await page.getByRole('button',{name:'收起导航',exact:true}).click();
  for (const width of [750,390]) {
    await page.setViewportSize({width,height:900});
    await expect(page.getByRole('combobox',{name:'SDK 语言'})).toBeVisible();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:resolve(output,'sdk-'+width+'.png'),fullPage:true,animations:'disabled'});
  }
  expect(errors).toEqual([]);
  await writeFile(resolve(output,'ui-report.json'),JSON.stringify({languages:checked,widths:[1280,750,390],downloads:8,highlighted_languages:8,clipboard_samples:8,themes:['dark','light'],errors},null,2)+'\n');
  console.log('PASS eight SDK languages highlighted, exact code/clipboard, downloads, dark/light themes, desktop/mobile layout');
} catch(error) {
  await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;
} finally {
  await context.close(); await browser.close();
}
