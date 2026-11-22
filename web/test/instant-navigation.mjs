import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer as createViteServer} from 'vite';

const root=resolve(import.meta.dirname,'../..');
const now=new Date().toISOString();
let overviewReads=0;
const spec={service_name:'cached-app',role:'generic',deployment_mode:'manual',mode:'container',image:'example/app:1',deployments:[{cluster_id:'cluster',machine_ids:[]}]};
const resource=(name,status)=>({id:'app',kind:'application',name,revision:1,created_at:now,updated_at:now,spec,status:status??{state:'configured',instances:[]}});
const fixture=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://fixture').pathname.replace('/api/v1','');
 res.setHeader('content-type','application/json');
 if(path==='/ops/overview'){
  overviewReads++;
  await delay(3000);
  res.end(JSON.stringify({resources:[resource('Overview app')],agents:[],machines:[],runs:[]}));
  return;
 }
 if(path==='/ops/resources'){res.end(JSON.stringify({resources:[resource('Staged app',undefined)]}));return}
 res.end(JSON.stringify(path==='/auth/me'||path==='/auth/profile'?{id:'qa',name:'QA',role:'admin',active:true}:path==='/overview'?{tables:[],agent_count:0,key_count:0,user_count:1}:{}));
});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));
process.env.LIGHTMONI_DEV_API_URL='http://127.0.0.1:'+fixture.address().port;
const vite=await createViteServer({root:resolve(root,'web'),configFile:resolve(root,'web/vite.config.ts'),server:{host:'127.0.0.1',port:5213,strictPort:true},logLevel:'error'});
await vite.listen();
let browser;
try{
 try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:5213/overview',{waitUntil:'domcontentloaded'});
 await expect(page.locator('.lm-stats .lm-stat').first()).toBeVisible();
 await page.getByRole('button',{name:'运维工具'}).click();
 const applications=page.getByRole('link',{name:'应用管理'});
 await applications.hover();
 await delay(2000);
 const clickedAt=Date.now();
 await applications.click();
 await page.waitForURL('**/applications');
 await expect(page.getByRole('searchbox',{name:'搜索资源'})).toBeVisible({timeout:2000});
 await expect(page.getByRole('article',{name:'Staged app'})).toBeVisible({timeout:2000});
 const structureAt=Date.now()-clickedAt;
 assert(structureAt<2500,`page structure must render before the delayed overview resolves (took ${structureAt}ms)`);
 await expect(page.getByRole('article',{name:'Overview app'})).toBeVisible({timeout:8000});
 assert(overviewReads===1,'initial load performs exactly one overview request');
 await page.getByRole('link',{name:'集群管理'}).click();
 await page.waitForURL('**/clusters');
 await expect(page.getByRole('searchbox',{name:'搜索资源'})).toBeVisible({timeout:2000});
 await delay(400);
 await expect(page.locator('.ant-spin-spinning')).toHaveCount(0);
 assert(overviewReads>=2,'cache hit must trigger a silent background refresh');
 const backAt=Date.now();
 await page.getByRole('link',{name:'应用管理'}).click();
 await page.waitForURL('**/applications');
 await expect(page.getByRole('article',{name:'Overview app'})).toBeVisible({timeout:1500});
 await expect(page.getByRole('article',{name:'Staged app'})).toHaveCount(0);
 const cachedAt=Date.now()-backAt;
 assert(cachedAt<2500,`cached resources must render without waiting for the overview request (took ${cachedAt}ms)`);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({overviewReads,structureAt,cachedAt}));
 console.log('Instant navigation, hover preload, and cross-route ops cache verified.');
}finally{
 await browser?.close();
 await vite.close();
 fixture.closeAllConnections();
 await new Promise(done=>fixture.close(done));
}
