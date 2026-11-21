// Isolated brand-version acceptance. It uses the real BrandMark component and shell state, with no production API.
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {chromium,expect} from '@playwright/test';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),source=join(root,'.local-brand-version'),bundle=join(source,'bundle'),output=resolve(root,'../.local-dev/evidence/194-brand-version-badge');
const version=JSON.parse(await readFile(join(root,'..','package.json'),'utf8')).version;
await mkdir(source,{recursive:true});await mkdir(output,{recursive:true});
await writeFile(join(source,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(source,'main.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{App,ConfigProvider}from'../shared/ui';import{I18nProvider}from'../shared/i18n';import BrandMark from'../app/BrandMark';import'../app/style.css';import'../app/theme.css';import'../app/navigation.css';createRoot(document.getElementById('root')).render(<div className=\"lm-shell is-nav-expanded\"><I18nProvider><BrowserRouter><ConfigProvider><BrandMark homepage="/overview"/></ConfigProvider></BrowserRouter></I18nProvider></div>);`);await build({root:source,configFile:false,logLevel:'silent',build:{outDir:bundle,emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
const server=createServer(async(req,res)=>{try{let file=resolve(bundle,decodeURIComponent(new URL(req.url,'http://fixture').pathname).replace(/^\//,''));if(!file.startsWith(bundle+'/'))file=join(bundle,'index.html');try{if(!(await stat(file)).isFile())file=join(bundle,'index.html')}catch{file=join(bundle,'index.html')}res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'));res.end(await readFile(file));}catch{res.writeHead(404);res.end()}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const checks=[];
try{
 for(const collapsed of [false,true]){
  const context=await browser.newContext({viewport:{width:1280,height:360},reducedMotion:'reduce'});
  await context.addInitScript(({collapsed})=>{localStorage.setItem('lightmoni.nav.collapsed',String(collapsed))},{collapsed});
  const page=await context.newPage();const writes=[];
  await page.route('**/api/v1/*',route=>{writes.push(new URL(route.request().url()).pathname);return route.fulfill({status:500,json:{error:'unexpected API call'}})});
  await page.goto(base);
  await page.evaluate(collapsed=>document.getElementById('root').firstElementChild.className=`lm-shell ${collapsed?'is-nav-collapsed':'is-nav-expanded'}`,collapsed);
  await expect(page.locator('.lm-brand-copy small')).toContainText('监控工作台');
  const badge=page.locator('.lm-brand-version');
  if(collapsed){await expect(badge).toBeHidden();checks.push('collapsed navigation hides brand copy and version')}
  else{await expect(badge).toHaveText(`v${version}`);await expect(badge).toHaveAttribute('title','LightMoni 版本');await page.screenshot({path:join(output,collapsed?'collapsed.png':'expanded.png'),fullPage:true});checks.push(`expanded brand shows package version v${version}`)}
  expect(writes).toEqual([]);await context.close();
 }
 await writeFile(join(output,'browser-results.json'),JSON.stringify({version,passed:checks.length,checks},null,2));console.log(JSON.stringify({version,passed:checks.length,checks}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(source,{recursive:true,force:true})}
