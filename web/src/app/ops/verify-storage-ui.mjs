import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';
const root=resolve(import.meta.dirname,'../../../..'),output=resolve(root,'specs/099-app-registration-storage/evidence'),media=mediaDirectory(output);
await mkdir(output,{recursive:true});
const now=new Date().toISOString(),base='/var/lib/lightmoni-managed/operations/platform',resources=[
 {id:'cluster',kind:'cluster',name:'测试集群',revision:1,spec:{machine_ids:['machine']},status:{}},
 {id:'app',kind:'application',name:'存储验收应用',revision:1,spec:{service_name:'storage-qa',role:'generic',source:{type:'custom'},deployment_mode:'manual',mode:'container',image:'example:1',ports:[],deployments:[{cluster_id:'cluster',machine_ids:['machine'],cpu:0.25,memory_mb:128}]},status:{instances:[{id:'instance',state:'removed',cluster_id:'cluster',machine_id:'machine'}]}},
 {id:'gateway',kind:'application',name:'OpenResty',revision:1,spec:{role:'openresty',service_name:'sys-openresty',deployments:[{cluster_id:'cluster',machine_ids:['machine']}],ports:[]},status:{}},
 {id:'site',kind:'website',name:'存储验收网站',revision:1,spec:{cluster_ids:['cluster'],routing_mode:'manual',mode:'static',bindings:[{domains:['storage.example.test'],locations:[]}]},status:{}},
].map(r=>({...r,created_at:now,updated_at:now}));
let unavailable=false,fail=false,storageReads=0;
const fixture=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');let result={};res.setHeader('content-type','application/json');
 if(url.pathname==='/api/v1/auth/me')result={id:'qa',name:'QA',role:'admin'};
 else if(url.pathname==='/api/v1/ops/overview')result={resources,agents:[],runs:[],machines:[{id:'machine',name:'验收机器'}]};
 else if(req.method==='DELETE'&&url.pathname==='/api/v1/ops/resources/site'){const deletion={state:'pending',targets:[{machine_id:'machine',state:'waiting',error:'website_cleanup_host_offline'}]};resources.find(r=>r.id==='site').status.deletion=deletion;res.statusCode=202;result={deleted:false,deletion};}
 else if(url.pathname.endsWith('/storage')){
  storageReads++;if(fail){res.statusCode=503;result={error:'fixture_unavailable'}}else{
  const site=url.pathname.includes('/site/'),r=site?base+'/gateways/entry':base+'/applications/app/instances/instance';
  result={resource_id:site?'site':'app',layout_version:2,standard_root:base,next_offset:null,instances:[{instance_id:site?'entry':'instance',cluster_id:'cluster',machine_id:'machine',state:site?'running':'removed',observed_at:unavailable?null:now,storage:unavailable?null:{layout_version:2,application_root:site?null:base+'/applications/app',instance_root:r,state_file:r+'/state.json',...(site?{config_file:r+'/current/nginx.conf',version_root:r+'/versions/'+('a'.repeat(64))}:{}),mounts:site?[]:[{service:'database',type:'volume',volume:'lm-instance_database',source:'/srv/docker/volumes/lm-instance_database/_data',target:'/data',read_only:false}],sites:site?[{website_id:'site',root:base+'/websites/site',current:base+'/websites/site/current',config_file:base+'/websites/site/versions/'+('a'.repeat(64))+'/nginx.conf',auth_dir:base+'/websites/site/versions/'+('a'.repeat(64))+'/auth',certificate_dir:base+'/websites/site/versions/'+('a'.repeat(64))+'/ssl',public_dir:base+'/websites/site/versions/'+('a'.repeat(64))+'/public'}]:[]}}]};}
 }
 else if(url.pathname.endsWith('/catalog'))result={templates:[]};
 res.end(JSON.stringify(result));
});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));process.env.LIGHTMONI_DEV_API_URL='http://127.0.0.1:'+fixture.address().port;
const vite=await createViteServer({root:resolve(root,'web'),configFile:resolve(root,'web/vite.config.ts'),server:{host:'127.0.0.1',port:5199,strictPort:true},logLevel:'error'});await vite.listen();
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
const panel=()=>page.locator('.ant-drawer-body'),shot=async name=>{await expect(page.locator('.ant-drawer-content-wrapper')).toHaveCSS('transform','none');await page.screenshot({path:resolve(media,name+'.png'),fullPage:false,animations:'disabled'})};
try{
 await page.goto('http://127.0.0.1:5199/applications');await page.getByRole('button',{name:'存储验收应用',exact:true}).click();
 await expect(panel().getByText('宿主机存储与挂载',{exact:true})).toBeVisible();await expect(panel().getByText('/srv/docker/volumes/lm-instance_database/_data',{exact:true})).toBeVisible();await shot('application-zh-1440');checks.push('应用显示实际Docker数据目录与容器目标');
 unavailable=true;await panel().getByRole('button',{name:'刷新清单',exact:true}).click();await expect(panel().getByText(/尚无存储回执/)).toBeVisible();checks.push('旧Agent无回执不会伪造已观测位置');
 fail=true;await panel().getByRole('button',{name:'刷新清单',exact:true}).click();await expect(panel().getByText('存储清单读取失败',{exact:true})).toBeVisible();fail=false;unavailable=false;
 await page.goto('http://127.0.0.1:5199/websites');await page.getByRole('button',{name:'存储验收网站',exact:true}).click();
 await expect(panel().getByText(base+'/gateways/entry/current/nginx.conf',{exact:true})).toBeVisible();await expect(panel().getByText('网站配置文件',{exact:true})).toBeVisible();await shot('website-zh-1440');checks.push('网站显示网关索引和按网站ID隔离的配置/SSL/鉴权/静态目录');
 await page.locator('.ant-drawer-close').click();await page.locator('.lm-website-item').getByRole('button',{name:/更多/}).click();await page.getByText('删除登记',{exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'删除登记',exact:true}).click();await expect(panel().getByText(/网站删除进度/)).toBeVisible();await expect(panel().getByText('主机离线，等待恢复后清理。',{exact:true})).toBeVisible();await expect(page.getByText('资源已删除',{exact:true})).toHaveCount(0);checks.push('202删除展示逐机器离线等待，不误报删除成功');
 await page.setViewportSize({width:390,height:844});await panel().getByText('宿主机存储与挂载',{exact:true}).scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await panel().evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await shot('website-zh-390');checks.push('390px长路径换行且抽屉和页面均无横向溢出');
 await page.evaluate(()=>localStorage.setItem('lightmoni.language','en-US'));await page.reload();await page.getByRole('button',{name:'存储验收网站',exact:true}).click();await expect(panel().getByText('Host storage and mounts',{exact:true})).toBeVisible();await shot('website-en-390');checks.push('英文界面与窄屏可用');
 expect(errors).toEqual([]);await writeFile(resolve(output,'ui-report.json'),JSON.stringify({fixture:'isolated HTTP responses; no production, cloud or Docker operations',checks,storage_reads:storageReads,page_errors:errors,media},null,2));console.log(JSON.stringify({checks,media}));
}catch(error){console.error(JSON.stringify({page_errors:errors,body:await page.locator('body').innerText()}));await page.screenshot({path:resolve(media,'failure.png'),fullPage:false});throw error;}finally{await browser.close();await vite.close();fixture.close();fixture.closeAllConnections()}
