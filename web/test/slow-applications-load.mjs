import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer as createViteServer} from 'vite';

const root=resolve(import.meta.dirname,'../..');
let overviewReads=0;
const overviewStarted=[];
let mode='slow',manualReads=0;
const now=new Date().toISOString();
const fixture=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://fixture').pathname.replace('/api/v1','');
 res.setHeader('content-type','application/json');
 if(path==='/ops/overview'){
  overviewReads++;
  overviewStarted.push(Date.now());
  if(mode==='failure'){res.statusCode=503;res.end(JSON.stringify({error:'fixture_overview_failed'}));return}
  const request=mode==='manual'?++manualReads:0;
  await delay(mode==='slow'?11_500:request===1?700:0);
  const name=mode==='slow'?'Slow app':request===1?'Stale app':'Fresh app';
  res.end(JSON.stringify({resources:[{id:'app',kind:'application',name,revision:1,created_at:now,updated_at:now,spec:{service_name:'slow-app',role:'generic',deployment_mode:'manual',mode:'container',image:'example/app:1',deployments:[{cluster_id:'cluster',machine_ids:[]}]},status:{state:'configured',instances:[]}}],agents:[],machines:[],runs:[]}));
  return;
 }
 res.end(JSON.stringify(path==='/auth/me'||path==='/auth/profile'?{id:'qa',name:'QA',role:'admin',active:true}:{}));
});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));
process.env.LIGHTMONI_DEV_API_URL='http://127.0.0.1:'+fixture.address().port;
const vite=await createViteServer({root:resolve(root,'web'),configFile:resolve(root,'web/vite.config.ts'),server:{host:'127.0.0.1',port:5212,strictPort:true},logLevel:'error'});
await vite.listen();
let browser;
try{
 try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const started=Date.now();
 await page.goto('http://127.0.0.1:5212/applications',{waitUntil:'domcontentloaded'});
 await delay(10_300);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.getByRole('article',{name:'Slow app'})).toBeVisible({timeout:17_000});
 const visibleAt=Date.now();
 console.log(JSON.stringify({overviewReads,requestsAt:overviewStarted.map(value=>value-started),visibleAt:visibleAt-started}));
 assert(overviewReads<=2&&overviewStarted.every(value=>value-overviewStarted[0]<10_000),'automatic refresh must not start while the initial request is unfinished');
 mode='manual';
 await page.getByRole('button',{name:'刷新'}).click();
 await delay(80);
 await page.getByRole('button',{name:'刷新'}).click();
 await expect(page.getByRole('article',{name:'Fresh app'})).toBeVisible();
 await delay(800);
 await expect(page.getByRole('article',{name:'Stale app'})).toHaveCount(0);
 mode='failure';
 await page.getByRole('button',{name:'刷新'}).click();
 await expect(page.getByText('fixture_overview_failed')).toBeVisible();
 await expect(page.locator('.ant-spin-spinning')).toHaveCount(0);
 mode='manual';
 await page.getByRole('button',{name:'重试'}).click();
 await expect(page.getByRole('article',{name:'Fresh app'})).toBeVisible();
 await expect(page.getByText('fixture_overview_failed')).toHaveCount(0);
 assert.deepEqual(errors,[]);
 console.log('Slow overview, polling/focus, explicit replacement, failure and retry completed.');
}finally{
 await browser?.close();
 await vite.close();
 fixture.closeAllConnections();
 await new Promise(done=>fixture.close(done));
}
