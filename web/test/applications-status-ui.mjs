import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer as createViteServer} from 'vite';

const root=resolve(import.meta.dirname,'../..');
const now=new Date().toISOString();
const base=(id,name,status,instance)=>({
 id,kind:'application',name,revision:2,created_at:now,updated_at:now,
 spec:{service_name:id,role:'generic',deployment_mode:'manual',mode:'container',image:'example/app:2',deployments:[{cluster_id:'cluster',machine_ids:['machine-a']}]},
 status:{deployments:{cluster:{enabled:true,desired_revision:2,applied_revision:2,instances_total:1,ready_instances:1}},instances:[{id:id+'-instance',cluster_id:'cluster',machine_id:'machine-a',state:'running',healthy:true,availability:'ready',observed_generation:'2',ports:[],...instance}],...status},
});
const applications=[
 base('verified','Verified app',{deployments:{cluster:{enabled:true,desired_revision:2,applied_revision:2,instances_total:1,ready_instances:1},old:{enabled:false,desired_revision:1,last_error:'old_error'}}},{}),
 base('protected','Protected app',{}, {availability:'retained',healthy:false,recovery:{state:'blocked',code:'unknown_execution_result'}}),
 base('pending','Pending app',{deployments:{cluster:{enabled:true,desired_revision:2,applied_revision:0,instances_total:0,ready_instances:0}},instances:[]},{}),
 base('failed','Failed app',{}, {state:'failed',availability:'retained',healthy:false}),
 {...base('saved','Saved app',{},{}),revision:3},
 base('log-unknown','Log unknown app',{}, {unresolved_run_id:'log-run'}),
 base('overflow','Overflow app',{}, {unresolved_run_id:'overflow-original'}),
 base('historical','Historical app',{deployments:{cluster:{enabled:true,desired_revision:2,applied_revision:2,instances_total:1,ready_instances:1},old:{enabled:false,desired_revision:1}} ,instances:[{id:'historical-current',cluster_id:'cluster',machine_id:'machine-a',state:'running',healthy:true,availability:'ready',observed_generation:'2',ports:[]},{id:'historical-old',cluster_id:'old',machine_id:'machine-a',state:'unknown',healthy:false,availability:'unavailable',observed_generation:'1',ports:[]}]},{}),
 base('removed-blocked','Removed blocked app',{deployments:{cluster:{enabled:true,desired_revision:2,applied_revision:2,instances_total:1,ready_instances:1},old:{enabled:false,desired_revision:1}},instances:[{id:'removed-current',cluster_id:'cluster',machine_id:'machine-a',state:'running',healthy:true,availability:'ready',observed_generation:'2',ports:[]},{id:'removed-old',cluster_id:'old',machine_id:'machine-a',state:'removed',healthy:false,availability:'unavailable',unresolved_run_id:'removed-run',ports:[]}]},{}),
];
const run=(id,resource_id,action,state,resource_revision=2)=>({id,resource_id,action,state,resource_revision,agent_id:'agent-a',result:{},created_at:now,updated_at:now});
const overflowOriginal=run('overflow-original','overflow','logs','unknown');
const histories={
 verified:[run('new-success','verified','deploy','succeeded'),run('old-unknown','verified','deploy','unknown',1)],
 protected:[run('protected-later','protected','deploy','succeeded'),run('protected-unknown','protected','deploy','unknown')],
 'log-unknown':[run('log-run','log-unknown','logs','unknown'),run('older-deploy','log-unknown','deploy','succeeded')],
 'removed-blocked':[run('removed-run','removed-blocked','remove','unknown')],
 overflow:Array.from({length:100},(_,index)=>run('later-'+index,'overflow','logs','succeeded')),
};
const writes=[],reads=[];
const fixture=createServer((req,res)=>{
 const url=new URL(req.url,'http://fixture'),path=url.pathname.replace('/api/v1','');
 if(req.method!=='GET')writes.push({method:req.method,path});
 else reads.push(path+url.search);
 res.setHeader('content-type','application/json');
 if(path==='/ops/overview')res.end(JSON.stringify({resources:[...applications,{id:'cluster',kind:'cluster',name:'Cluster',revision:1,created_at:now,updated_at:now,spec:{machine_ids:['machine-a']},status:{}}],agents:[],machines:[{id:'machine-a',name:'Machine A',cluster_id:'cluster'}],runs:[]}));
 else if(path.startsWith('/ops/resources/')&&path.endsWith('/storage'))res.end(JSON.stringify({instances:[],standard_root:'',next_offset:null}));
 else if(path.startsWith('/ops/resources/'))res.end(JSON.stringify({resource:applications.find(app=>app.id===path.split('/')[3])}));
 else if(path==='/ops/runs')res.end(JSON.stringify({runs:histories[url.searchParams.get('resource_id')]??[]}));
 else if(path.startsWith('/ops/runs/')&&path.endsWith('/events')){const id=path.split('/')[3],record=id===overflowOriginal.id?overflowOriginal:Object.values(histories).flat().find(item=>item.id===id);res.end(JSON.stringify({run:record,events:[],next_after:0}));}
 else if(path.startsWith('/ops/runs/'))res.end(JSON.stringify(path.split('/')[3]===overflowOriginal.id?overflowOriginal:{}));
 else res.end(JSON.stringify(path==='/auth/me'||path==='/auth/profile'?{id:'qa',name:'QA',role:'admin',active:true}:{}));
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
 await page.goto('http://127.0.0.1:5213/applications',{waitUntil:'domcontentloaded'});
 const protectedCard=page.getByRole('article',{name:'Protected app'});
 await expect(protectedCard).toBeVisible();
 await expect(protectedCard.getByText('待核实',{exact:true})).toBeVisible();
 await expect(page.getByRole('article',{name:'Verified app'}).getByText('运行中',{exact:true})).toBeVisible();
 await expect(page.getByRole('article',{name:'Verified app'}).locator('.lm-ops-error-text')).toHaveCount(0);
 await expect(page.getByRole('article',{name:'Pending app'}).getByText('待处理',{exact:true})).toBeVisible();
 await expect(page.getByRole('article',{name:'Failed app'}).getByText('失败',{exact:true})).toBeVisible();
 const logUnknownCard=page.getByRole('article',{name:'Log unknown app'});
 await expect(logUnknownCard.getByText('结果未知',{exact:true})).toBeVisible();
 await expect(logUnknownCard.getByRole('button',{name:'升级'})).toBeDisabled();
 const historicalCard=page.getByRole('article',{name:'Historical app'});
 await expect(historicalCard.getByText('运行中',{exact:true})).toBeVisible();
 await expect(historicalCard.getByText('另有执行结果待核对',{exact:true})).toBeVisible();
 const savedCard=page.getByRole('article',{name:'Saved app'});
 await expect(savedCard.getByText('待核实',{exact:true})).toBeVisible();
 await expect(savedCard.getByText('当前配置未发布',{exact:true})).toBeVisible();
 await expect(savedCard.getByText('已发布 v2',{exact:true})).toBeVisible();
 await savedCard.getByRole('button',{name:'Saved app',exact:true}).click();
 await expect(page.locator('.ant-drawer-body').getByText('当前配置未发布',{exact:true})).toBeVisible();
 await page.locator('.ant-drawer-open .ant-drawer-close').click();
 await page.getByRole('article',{name:'Verified app'}).getByRole('button',{name:'安装记录'}).click();
 await expect(page.locator('.lm-install-progress').getByText('安装完成，应用已运行',{exact:true})).toBeVisible();
 await expect(page.locator('.lm-install-progress').getByText('new-success',{exact:true})).toBeVisible();
 await page.locator('.lm-install-progress .ant-drawer-close').click();
 await savedCard.getByRole('button',{name:'核对状态'}).click();
 await expect(page.locator('.lm-install-progress').getByText('运行状态待核实',{exact:true})).toBeVisible();
 await expect.poll(()=>reads.some(path=>path==='/ops/runs?resource_id=saved')).toBe(true);
 await page.locator('.lm-install-progress .ant-drawer-close').click();
 const stateFilter=page.getByRole('combobox',{name:'应用状态'});
 await stateFilter.click();
 await page.locator('.ant-select-item-option').filter({hasText:/^待核实$/}).click();
 await expect(page.getByRole('article')).toHaveCount(2);
 await expect(page.locator('.lm-ops-list-count strong')).toHaveText('2');
 await stateFilter.click();
 await page.locator('.ant-select-item-option').filter({hasText:/^待处理$/}).click();
 await expect(page.getByRole('article',{name:'Pending app'})).toBeVisible();
 await expect(page.getByRole('article')).toHaveCount(1);
 await expect(page.locator('.lm-ops-list-count strong')).toHaveText('1');
 await stateFilter.click();
 await page.locator('.ant-select-item-option').filter({hasText:/^全部状态$/}).click();
 await protectedCard.getByRole('button',{name:'更多操作 · Protected app'}).click();
 await expect(page.getByRole('menuitem',{name:'停止'})).toHaveAttribute('aria-disabled','true');
 await expect(page.getByRole('menuitem',{name:'卸载容器'})).toHaveAttribute('aria-disabled','true');
 await expect(page.getByRole('menuitem',{name:'删除登记'})).toHaveAttribute('aria-disabled','true');
 await page.keyboard.press('Escape');
 await protectedCard.getByRole('button',{name:'核对状态'}).click();
 await expect(page.locator('.lm-install-progress')).toBeVisible();
 await expect(page.locator('.lm-install-progress').getByText('运行状态待核实',{exact:true})).toBeVisible();
 await expect(page.locator('.lm-install-progress').getByText('protected-unknown',{exact:true})).toBeVisible();
 await expect(page.locator('.lm-install-progress').getByRole('button',{name:'调整配置 / 重新部署'})).toBeDisabled();
 await expect.poll(()=>reads.some(path=>path==='/ops/runs?resource_id=protected')).toBe(true);
 await page.locator('.lm-install-progress .ant-drawer-close').click();
 await logUnknownCard.getByRole('button',{name:'核对状态'}).click();
 await expect(page.locator('.lm-install-progress').getByText('执行结果未知',{exact:true})).toBeVisible();
 await expect(page.locator('.lm-install-progress').getByText('log-run',{exact:true})).toBeVisible();
 await page.locator('.lm-install-progress .ant-drawer-close').click();
 await page.getByRole('article',{name:'Overflow app'}).getByRole('button',{name:'核对状态'}).click();
 await expect(page.locator('.lm-install-progress').getByText('overflow-original',{exact:true})).toBeVisible();
 assert(reads.includes('/ops/runs/overflow-original'),'the omitted unresolved run must be fetched by ID');
 await page.locator('.lm-install-progress .ant-drawer-close').click();
 await historicalCard.getByRole('button',{name:'更多操作 · Historical app'}).click();
 await expect(page.getByRole('menuitem',{name:'停止'})).toHaveAttribute('aria-disabled','true');
 await expect(page.getByRole('menuitem',{name:'卸载容器'})).toHaveAttribute('aria-disabled','true');
 await expect(page.getByRole('menuitem',{name:'删除登记'})).toHaveAttribute('aria-disabled','true');
 await expect(page.getByRole('menuitem',{name:'重新部署'})).toHaveCount(0);
 await page.keyboard.press('Escape');
 await historicalCard.getByRole('button',{name:'核对状态'}).click();
 await expect(page.locator('.lm-install-progress')).toBeVisible();
 await expect(page.locator('.lm-install-progress').getByText('执行结果未知',{exact:true})).toBeVisible();
 await expect.poll(()=>reads.some(path=>path==='/ops/runs?resource_id=historical')).toBe(true);
 await page.locator('.lm-install-progress .ant-drawer-close').click();
 const removedCard=page.getByRole('article',{name:'Removed blocked app'});
 await expect(removedCard.getByText('另有执行结果待核对',{exact:true})).toBeVisible();
 await removedCard.getByRole('button',{name:'更多操作 · Removed blocked app'}).click();
 await expect(page.getByRole('menuitem',{name:'重新部署'})).toHaveCount(0);
 await expect(page.getByRole('menuitem',{name:'停止'})).toHaveAttribute('aria-disabled','true');
 await page.keyboard.press('Escape');
 await removedCard.getByRole('button',{name:'核对状态'}).click();
 await expect(page.locator('.lm-install-progress').getByText('removed-run',{exact:true})).toBeVisible();
 assert.deepEqual(writes,[],'blocked reconciliation must not dispatch inspect or other writes');
 assert.deepEqual(errors,[]);
 console.log('States and filters rendered; blocked execution opened application run history without writes.');
}finally{
 await browser?.close();
 await vite.close();
 fixture.closeAllConnections();
 await new Promise(done=>fixture.close(done));
}
