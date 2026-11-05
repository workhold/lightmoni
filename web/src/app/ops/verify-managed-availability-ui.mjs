import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const base=process.env.LIGHTMONI_AVAILABILITY_UI_URL??'http://127.0.0.1:19935';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Requires isolated loopback QA fixture');
const output=resolve(import.meta.dirname,'../../../../specs/093-managed-availability/evidence');await mkdir(output,{recursive:true});
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await context.addInitScript(()=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance','light')});
const api=async(path,method='GET',data)=>{const r=await context.request.fetch(base+'/api/v1'+path,{method,data});if(!r.ok())throw Error(await r.text());return r.json()};
const dialog=()=>page.locator('.ant-modal:visible').last();
const choose=async(label,value)=>{await dialog().getByLabel(label,{exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText(value,{exact:true}).click();await page.keyboard.press('Escape');await dialog().locator('.ant-modal-header').click();await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0)};
let cluster,app;
try{
 const user=await api('/auth/me');expect(user.id).toBe('qa-admin');
 cluster=(await api('/ops/resources','POST',{kind:'cluster',name:'Availability QA cluster',spec:{machine_ids:['qa-machine','qa-machine-2']}})).resource;
 await page.goto(base+'/applications');await page.getByRole('button',{name:'部署自定义应用',exact:true}).click();
 await dialog().getByLabel('展示名',{exact:true}).fill('Availability QA');
 await choose('部署模式','托管模式');await choose('部署集群',cluster.name);
 await dialog().getByLabel('连续失联 / 不健康宽限（分钟）',{exact:true}).fill('7');
 await dialog().getByLabel('最低在线比例（%）',{exact:true}).fill('60');
 await dialog().getByLabel('期望实例数',{exact:true}).fill('3');
 await dialog().getByLabel('容器镜像',{exact:true}).fill('nginx:alpine');
 await dialog().getByRole('button',{name:'添加端口',exact:true}).click();
 await dialog().getByLabel('端口名称',{exact:true}).fill('http');await dialog().getByLabel('容器端口',{exact:true}).fill('8080');
 await choose('探活方式（可选）','HTTP');
 await dialog().getByLabel('探活端口名称',{exact:true}).fill('http');
 await dialog().getByLabel('探活间隔（秒）',{exact:true}).fill('10');
 await dialog().getByLabel('探活超时（秒）',{exact:true}).fill('2');
 await dialog().getByLabel('健康检查路径',{exact:true}).fill('/ready');
 const statuses=dialog().getByLabel('预期 HTTP 状态码',{exact:true});await statuses.fill('204');await statuses.press('Enter');await page.keyboard.press('Escape');await dialog().locator('.ant-modal-header').click();await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
 await dialog().getByLabel('最低在线比例（%）',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve(output,'availability-form.png')});
 await dialog().getByRole('button',{name:'保存配置',exact:true}).click();await expect(dialog()).toBeHidden();
 app=(await api('/ops/overview')).resources.find(r=>r.name==='Availability QA');expect(app).toBeTruthy();
 expect(app.spec.heartbeat_grace_minutes).toBe(7);expect(app.spec.deployments[0].min_available_percent).toBe(60);
 expect(app.spec.health).toMatchObject({type:'http',port_name:'http',path:'/ready',expected_statuses:[200,204],interval_seconds:10,timeout_seconds:2});
 await page.locator('.lm-installed-app').filter({hasText:'Availability QA'}).getByRole('button',{name:/^配\s*置$/}).click();
 await choose('部署模式','手动模式');await choose('部署机器','QA Docker 节点');
 await expect(dialog().getByLabel('健康检查路径',{exact:true})).toHaveValue('/ready');
 await dialog().getByLabel('健康检查路径',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve(output,'manual-health-form.png')});
 await dialog().getByRole('button',{name:'保存配置',exact:true}).click();await expect(dialog()).toBeHidden();
 app=(await api('/ops/overview')).resources.find(r=>r.id===app.id);expect(app.spec.deployment_mode).toBe('manual');expect(app.spec.health.expected_statuses).toEqual([200,204]);
 expect(errors).toEqual([]);
 await writeFile(resolve(output,'browser.json'),JSON.stringify({checked_at:new Date().toISOString(),checks:['managed grace and cluster minimum saved through actual API','HTTP path, statuses, timeout and interval persisted','manual mode exposes and preserves health checks'],page_errors:errors,scope:'Disposable SQLite fixture, real form persistence; no remote Agents or cloud calls'},null,2));
 console.log('Managed availability and manual health UI verified');
}catch(e){await page.screenshot({path:resolve(output,'failure.png')}).catch(()=>{});throw e}finally{
 if(app)await api('/ops/resources/'+app.id,'DELETE',{revision:app.revision}).catch(()=>{});
 if(cluster){cluster=(await api('/ops/resources/'+cluster.id,'PUT',{revision:cluster.revision,name:cluster.name,spec:{...cluster.spec,machine_ids:[],nodes:[]}})).resource;await api('/ops/resources/'+cluster.id,'DELETE',{revision:cluster.revision}).catch(()=>{})}
 await browser.close();
}
