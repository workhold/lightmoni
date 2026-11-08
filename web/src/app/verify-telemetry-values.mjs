import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// Real application pages, synthetic read-only telemetry. No live server credentials.
const root=resolve(import.meta.dirname,'../../..'),output=resolve(root,'specs/114-application-monitor-values/evidence');
await mkdir(output,{recursive:true});const media=mediaDirectory(output),cache=await mkdtemp(resolve(tmpdir(),'lightmoni-telemetry-values-'));
const reads=[],unknown=new Set(),errors=[],rounds=[];let writes=0,revision=0;
const containers=[{id:'c203d12d1111',name:'lm-accee3d0495a4f151e60b077696b0e38-app-1'},{id:'b203d12d2222',name:'orders-worker-with-a-long-container-name-2'}].map(c=>({...c,cluster_id:'cluster',deployment_id:'deployment',state:'running',image:'example/orders:1'}));
const application={id:'app',name:'订单服务',kind:'application',spec:{service_name:'orders-api'},status:{instances:[{id:'deployment',cluster_id:'cluster',machine_id:'machine'}]}};
const manifest={application,hosts:[{id:'machine',name:'bj-1',state:'ready',containers,application_observation:{state:'ok'}}],deployments:[{id:'deployment',cluster_id:'cluster',cluster_name:'北京集群'}],websites:[{id:'site',name:'订单网站'}]};
const user={id:'qa',name:'QA',nickname:'QA',role:'admin',active:true};
function telemetry(url){
 const to=Date.parse(url.searchParams.get('to')??new Date().toISOString()),times=[180,120,60,30].map(s=>new Date(to-s*1000).toISOString()),mode=url.searchParams.get('fixture');
 const load=[];for(const [i,c] of containers.entries()){
  if(url.searchParams.get('container_id')&&url.searchParams.get('container_id')!==c.id)continue;
  const metrics={'container.cpu.percent':i?[4,6,8,null]:[0.31,0.29,revision?0.5:0.23,null],'container.memory.used':[64,68,72].map(m=>m*1024**2),'container.network.receive_bytes':[1000,3000,7000],'container.network.transmit_bytes':[1000,7000,19000],'container.disk.read_bytes':[100,100,100],'container.disk.write_bytes':[100]};
  for(const [name,values] of Object.entries(metrics)){
   const samples=values.map((value,index)=>({time:times[index],name,value,container_id:c.id,container_name:c.name}));
   if(name==='container.cpu.percent'){
    if(mode==='zero')for(const [j,sample] of samples.entries())sample.value=[null,0,'','Infinity'][j];
    if(mode==='missing')for(const [j,sample] of samples.entries())sample.value=[null,'NaN','',false][j];
    // Latest must follow timestamp order, never the response's row order.
    samples.reverse();
   }
   load.push(...samples);
  }
 }
 const result=rows=>({status:'ok',rows}),range={from:url.searchParams.get('from'),to:url.searchParams.get('to')};
 return {range,waiting:mode==='empty',results:{load:result(mode==='empty'?[]:load),web:result([1,2,3].map((qps,i)=>({time:times[i],qps,duration:(i+1)*0.1,website_id:'site',cluster_id:'cluster'}))),sdk_metrics:result([2,4,6].map((value,i)=>({time:times[i],value,instance_id:'orders-sdk',table_name:'orders',name:'request_rate',unit:'reqps',samples:1}))),logs:result([]),sdk_logs:result([])}};
}
const fixture=createServer((req,res)=>{
 const url=new URL(req.url,'http://fixture'),path=url.pathname.replace('/api/v1','');res.setHeader('content-type','application/json');
 if(!['GET','HEAD'].includes(req.method)){writes++;res.writeHead(405);res.end('{}');return}
 reads.push({path,params:Object.fromEntries(url.searchParams)});let body=[];
 if(path==='/auth/me'||path==='/auth/profile')body=user;
 else if(path==='/ops/resources/app/monitoring')body=manifest;
 else if(path==='/ops/resources/app/telemetry')body=telemetry(url);
 else if(path==='/ops/resources/site/website-telemetry')body={...telemetry(url),website:{id:'site',name:'订单网站',spec:{}}};
 else if(path==='/ops/overview')body={resources:[{id:'cluster',kind:'cluster',name:'北京集群'}],machines:[],runs:[],agents:[]};
 else if(path==='/auth/preferences')body={};
 else if(path==='/setup')body={required:false};
 else if(!['/auth/providers','/catalog/tables','/dashboards','/dashboards/templates','/ops/runs','/agents','/machines','/settings/login-providers'].includes(path))unknown.add(path);
 res.end(JSON.stringify(body));
});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));process.env.LIGHTMONI_DEV_API_URL='http://127.0.0.1:'+fixture.address().port;
const vite=await createViteServer({root:resolve(root,'web'),cacheDir:cache,configFile:resolve(root,'web/vite.config.ts'),server:{host:'127.0.0.1',port:5214,strictPort:true},logLevel:'error'});await vite.listen();
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const base='http://127.0.0.1:5214',url='/applications/app/monitoring',plot=page=>page.locator('.lm-application-plot'),values=(page,index=0,row=0)=>plot(page).nth(index).locator('.lm-telemetry-values>li').nth(row).locator('dd');
let page,failure;
async function layout(page){
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 for(const list of await page.locator('.lm-telemetry-values').all()){
  const bounds=await list.boundingBox();for(const value of await list.locator('dd').all()){
   const box=await value.boundingBox();expect(box.x).toBeGreaterThanOrEqual(bounds.x-1);expect(box.x+box.width).toBeLessThanOrEqual(bounds.x+bounds.width+1);
   expect(await value.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
  }
 }
}
try{
 for(let round=1;round<=3;round++){
  const checked=[];
  for(const language of ['zh-CN','en-US'])for(const theme of ['light','dark'])for(const width of [1440,390]){
   revision=0;const context=await browser.newContext({viewport:{width,height:1000},timezoneId:'Asia/Shanghai',reducedMotion:'reduce'});
   await context.addInitScript(({language,theme})=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.appearance',theme);localStorage.setItem('lightmoni.nav.collapsed','true')},{language,theme});
   page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   if(language==='zh-CN'&&theme==='light'&&width===1440)await page.clock.install();
   await page.route('**/*',route=>{const origin=new URL(route.request().url()).origin;return origin===base?route.continue():route.abort()});
   await page.goto(base+url);await expect(plot(page)).toHaveCount(6);await expect(values(page)).toHaveText(['0.23%','0.28%','0.31%']);
   await expect(values(page,0,1)).toHaveText(['8.00%','6.00%','8.00%']);await expect(values(page,1)).toHaveText(['72.00 MiB','68.00 MiB','72.00 MiB']);
   await expect(values(page,2)).toHaveText(['66.67 B/s','50.00 B/s','66.67 B/s']);await expect(values(page,3)).toHaveText(['200.00 B/s','150.00 B/s','200.00 B/s']);await expect(values(page,4)).toHaveText(['0.00 B/s','0.00 B/s','0.00 B/s']);
   await expect(plot(page).nth(5).locator('.lm-telemetry-values')).toHaveCount(0);await expect(values(page).first()).toHaveAttribute('title',/2026|20\d\d/);
   await expect(plot(page).first().getByText(language==='zh-CN'?'最新值':'Latest',{exact:true})).toHaveCount(2);await layout(page);
   if(round===3){
    await plot(page).first().screenshot({path:resolve(media,`${language}-${theme}-${width}.png`),animations:'disabled'});
    if(language==='zh-CN'&&theme==='light'&&width===1440)await page.screenshot({path:resolve(media,'application-monitoring.png'),animations:'disabled'});
   }
   if(width===1440){
    await page.evaluate(()=>document.documentElement.style.zoom='2');await layout(page);
    if(round===3)await plot(page).first().locator('.lm-telemetry-values').screenshot({path:resolve(media,`${language}-${theme}-200.png`),animations:'disabled'});
    await page.evaluate(()=>document.documentElement.style.zoom='');
    await expect.poll(()=>plot(page).first().locator('.uplot').evaluate(e=>e.offsetWidth===e.parentElement.clientWidth)).toBe(true);
   }
   checked.push(`${language}/${theme}/${width}: per-container values, units, timestamp order, null/zero, empty rate, layout`);
   if(language==='zh-CN'&&theme==='light'&&width===1440){
    const over=plot(page).first().locator('.u-over');await over.scrollIntoViewIfNeeded();const box=await over.boundingBox();await over.hover({position:{x:box.width*0.9667,y:box.height*0.4}});
    await expect(page.locator('.lm-series-tooltip:not([hidden])')).toBeVisible();await expect(page.locator('.lm-series-tooltip:not([hidden])')).toContainText('0.29%');await page.mouse.move(0,0);
    revision=1;await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(values(page).first()).toHaveText('0.50%');
    revision=0;await page.clock.fastForward(15000);await expect(values(page).first()).toHaveText('0.23%');
    const choose=async(name,option)=>{await page.getByRole('combobox',{name,exact:true}).click();await page.locator('.ant-select-item-option-content').getByText(option,{exact:true}).click()};
    await choose('监控集群','北京集群');await expect(values(page).first()).toHaveText('0.23%');
    await choose('监控部署','bj-1 · deployme');await expect(values(page).first()).toHaveText('0.23%');
    await choose('监控容器',containers[1].name);await expect(plot(page).first().locator('.lm-telemetry-values>li')).toHaveCount(1);await expect(values(page)).toHaveText(['8.00%','6.00%','8.00%']);
    await choose('监控时间范围','最近 15 分钟');await expect.poll(()=>reads.filter(r=>r.path.endsWith('/telemetry')).at(-1)?.params.minutes).toBe('15');
    const last=reads.filter(r=>r.path.endsWith('/telemetry')).at(-1);expect(last.params.cluster_id).toBe('cluster');expect(last.params.deployment_id).toBe('deployment');expect(last.params.minutes).toBe('15');
    await page.goto(base+url+'?tab=web');await expect(plot(page)).toHaveCount(2);await expect(values(page)).toHaveText(['3.00 req/s','2.00 req/s','3.00 req/s']);await expect(values(page,1)).toHaveText(['300.00 ms','200.00 ms','300.00 ms']);
    await page.goto(base+url+'?tab=sdk');await expect(values(page)).toHaveText(['6.00 req/s','4.00 req/s','6.00 req/s']);
    await page.goto(base+'/websites/site/monitoring');await expect(values(page)).toHaveText(['3.00 req/s','2.00 req/s','3.00 req/s']);
    for(const [mode,expected] of [['zero',['0.00%','0.00%','0.00%']],['missing',['—','—','—']]]){await page.goto(base+url+'?fixture='+mode);await expect(values(page)).toHaveText(expected)}
    await page.goto(base+url+'?fixture=empty');await expect(page.locator('.lm-telemetry-values')).toHaveCount(0);await expect(page.getByText('等待指标上报',{exact:true})).toHaveCount(6);
    checked.push('hover; manual + 15s refresh; cluster/deployment/container/time filters; website + SDK; zero/missing/empty');
   }
   await context.close();
  }
  expect(errors).toEqual([]);rounds.push({round,passed:true,checked});console.log(JSON.stringify({round,passed:true,cases:checked.length}));
 }
 expect(writes).toBe(0);expect([...unknown]).toEqual([]);
}catch(error){failure=String(error);if(page&&!page.isClosed())await page.screenshot({path:resolve(media,'failure.png'),fullPage:true});throw error}
finally{
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({source:'real Vite application pages with read-only synthetic API',rounds,writes,unknown:[...unknown],errors,failure,media_directory:media},null,2)+'\n');
 await browser.close();await vite.close();await new Promise(done=>fixture.close(done));await rm(cache,{recursive:true,force:true});
}
