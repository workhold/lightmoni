import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';

const root=resolve(import.meta.dirname,'../../../..');
const base=process.env.LIGHTMONI_INSTALL_UI_URL??'http://127.0.0.1:5174';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Disposable loopback fixture required');
const out=resolve(root,'specs/054-website-install-guidance/evidence/ui-'+(process.env.LIGHTMONI_UI_RUN??'1'));
const media=mediaDirectory(out);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
await context.addInitScript(()=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance','dark')});
const page=await context.newPage(),checks=[],errors=[];
const suffix=Date.now().toString(36),appName='入口-'+suffix,clusterName='网站集群-'+suffix;
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
const drawer=()=>page.locator('.lm-ops-catalog');
const modal=()=>page.locator('.ant-modal:visible').last();
async function json(path,options={}){const response=await context.request.fetch(base+'/api/v1'+path,options);if(!response.ok())throw Error(path+': '+response.status()+' '+await response.text());return response.json()}
async function choose(label,text,scope=drawer()){await scope.getByLabel(label,{exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText(text,{exact:true}).click();await page.keyboard.press('Escape')}
async function shot(name){await expect.poll(()=>page.evaluate(()=>document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).every(a=>a.playState!=='running'))).toBe(true);await page.screenshot({path:resolve(media,name+'.png'),fullPage:false,animations:'disabled'})}
async function noOverflow(){await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}
async function guide(){await expect(page.getByRole('heading',{name:'请先安装 OpenResty',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'新建网站',exact:true})).toHaveCount(0);await expect(page.getByRole('combobox',{name:'筛选集群',exact:true})).toHaveCount(0);await expect(page.locator('.lm-ops-workspace table')).toHaveCount(0)}

try{
 if((await json('/auth/me')).id!=='qa-admin')throw Error('QA fixture required');
 if((await json('/ops/overview')).resources.length)throw Error('Clean disposable fixture required');
 // Hold a real response to distinguish loading from an empty successful snapshot.
 let release,started;const gate=new Promise(resolve=>{release=resolve}),entered=new Promise(resolve=>{started=resolve});
 await page.route('**/api/v1/ops/overview',async route=>{started();await gate;await route.continue()});
 await page.goto(base+'/websites');await entered;
 await expect(page.getByRole('button',{name:'安装 OpenResty',exact:true})).toHaveCount(0);
 release();await guide();await page.unroute('**/api/v1/ops/overview');
 await expect(page.locator('nav a[href="/clusters"]')).toHaveCount(0);
 await expect(page.locator('.lm-ops-cluster-context')).toHaveCount(0);await noOverflow();await shot('uninstalled-zh-desktop');
 checks.push('加载不误报未安装；成功空快照显示安装主动作，无网站空表和集群管理横栏/侧栏项');
 await page.route('**/api/v1/ops/overview',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'qa_overview_unavailable'})}));
 await page.reload();await expect(page.getByText('无法读取运维状态',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'安装 OpenResty',exact:true})).toHaveCount(0);await shot('overview-error');
 await page.unroute('**/api/v1/ops/overview');await page.getByRole('button',{name:/^重\s*试$/}).click();await guide();
 checks.push('读取失败展示重试而非安装结论；重试实际接口恢复');

 await page.setViewportSize({width:390,height:844});await guide();await noOverflow();await shot('uninstalled-zh-390');
 await page.getByRole('button',{name:'切换语言',exact:true}).click();await page.getByRole('menuitem',{name:'English',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Install OpenResty to get started',exact:true})).toBeVisible();await noOverflow();await shot('uninstalled-en-390');
 await page.getByRole('button',{name:'Install OpenResty',exact:true}).click();await expect(page).toHaveURL(base+'/applications?install=openresty');
 await expect(drawer().getByRole('heading',{name:'OpenResty',exact:true})).toBeVisible();await expect(drawer().getByLabel('Display name',{exact:true})).toHaveValue('OpenResty');await noOverflow();await shot('install-en-390');
 await drawer().getByRole('button',{name:'Cancel',exact:true}).click();await expect(page).toHaveURL(base+'/applications');await expect(page.locator('.ant-drawer:visible')).toHaveCount(0);
 await page.getByRole('button',{name:'Change language',exact:true}).click();await page.getByRole('menuitem',{name:'简体中文',exact:true}).click();
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/websites');await page.getByRole('button',{name:'安装 OpenResty',exact:true}).click();
 await expect(drawer().getByLabel('展示名',{exact:true})).toHaveValue('OpenResty');await page.reload();await expect(drawer().getByLabel('展示名',{exact:true})).toHaveValue('OpenResty');
 checks.push('中英文/390px 无溢出；按钮跳转应用安装深链接直接选中 OpenResty，刷新可恢复，取消清除参数');

 await drawer().getByLabel('展示名',{exact:true}).fill(appName);
 const popupPromise=page.waitForEvent('popup');await drawer().getByRole('link',{name:'管理集群',exact:true}).click();const popup=await popupPromise;
 await expect(popup).toHaveURL(base+'/clusters');await expect(popup.getByRole('heading',{level:1,name:'集群',exact:true})).toBeVisible();await expect(popup.locator('header')).toContainText('集群');
 await expect(popup.locator('nav a[href="/clusters"]')).toHaveCount(0);
 await popup.getByRole('button',{name:'新建集群',exact:true}).click();const clusterEditor=popup.locator('.ant-modal:visible');await clusterEditor.getByLabel('名称',{exact:true}).fill(clusterName);
 const machine=(await json('/ops/overview')).machines[0];await clusterEditor.getByLabel('集群机器',{exact:true}).click();await popup.locator('.ant-select-dropdown:visible').getByText(machine.name,{exact:true}).click();await popup.keyboard.press('Escape');await clusterEditor.getByRole('button',{name:'保存配置',exact:true}).click();await expect(clusterEditor).toBeHidden();
 const cluster=(await json('/ops/overview')).resources.find(r=>r.kind==='cluster'&&r.name===clusterName);
 await popup.close();await page.bringToFront();await expect(drawer().getByLabel('展示名',{exact:true})).toHaveValue(appName);await expect(drawer().getByRole('button',{name:'新建集群',exact:true})).toHaveCount(0);
 await choose('部署集群',clusterName);await expect(drawer().locator('.lm-ops-deployment .ant-select').first()).toContainText(clusterName);
 await drawer().getByLabel('集群入口域名',{exact:true}).fill('edge.example.test');await shot('install-selected-cluster');
 checks.push('集群字段仅保留新页管理链接；真实管理页创建集群并回读选择，父表单输入保留');

 await page.route('**/api/v1/ops/catalog/openresty/install',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'qa_install_conflict'})}));
 await drawer().getByRole('button',{name:'确认安装并部署',exact:true}).click();await expect(drawer().getByText('安装未完成，输入已保留',{exact:true})).toBeVisible();await expect(drawer().getByLabel('展示名',{exact:true})).toHaveValue(appName);await expect(drawer().getByLabel('集群入口域名',{exact:true})).toHaveValue('edge.example.test');await shot('install-error-preserved');
 await page.unroute('**/api/v1/ops/catalog/openresty/install');await drawer().getByRole('button',{name:'确认安装并部署',exact:true}).click();
 await expect(page).toHaveURL(base+'/websites');await expect(page.locator('.ant-drawer:visible')).toHaveCount(0);await expect(page.getByRole('button',{name:'新建网站',exact:true})).toBeVisible();
 const entry=(await json('/ops/overview')).resources.find(r=>r.kind==='application'&&r.spec.role==='openresty');
 expect(entry.spec.deployments[0].cluster_id).toBe(cluster.id);expect(entry.spec.deployments[0].gateway_domain).toBe('edge.example.test');
 await page.reload();await expect(page.getByRole('button',{name:'OpenResty 管理',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'安装 OpenResty',exact:true})).toHaveCount(0);await shot('installed-websites');
 checks.push('模拟安装保存失败保留输入；随后真实 catalog install 创建单例和部署请求，返回网站并刷新读回');

 await page.getByRole('button',{name:'新建网站',exact:true}).click();await expect(modal().getByRole('link',{name:'管理集群',exact:true})).toHaveAttribute('href','/clusters');await expect(modal().getByRole('button',{name:'新建集群',exact:true})).toHaveCount(0);await shot('website-cluster-field');await modal().getByRole('button',{name:/^取\s*消$/}).click();
 await page.goto(base+'/applications?install=openresty');await expect(page).toHaveURL(base+'/applications?install=openresty');await expect(page.locator('.ant-drawer:visible')).toHaveCount(0);
 await page.getByRole('button',{name:'应用商店',exact:true}).click();await expect(drawer().getByRole('button',{name:'已安装',exact:true})).toBeDisabled();await expect(drawer().getByRole('heading',{name:'OpenResty',exact:true})).toHaveCount(0);await drawer().getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'部署自定义应用',exact:true}).click();await expect(modal().getByRole('button',{name:'新建集群',exact:true})).toHaveCount(0);await expect(modal().getByRole('link',{name:'管理集群',exact:true})).toHaveCount(1);await shot('application-cluster-field');await modal().getByRole('button',{name:/^取\s*消$/}).click();
 checks.push('已有应用（尚无Agent成功回执）仍显示网站列表；安装深链接/商店均不重复安装；网站集群字段只有管理跳转');

 for(const preference of ['/clusters','/operations']){await page.evaluate(value=>localStorage.setItem('lightmoni.homepage.qa-admin',value),preference);await page.goto(base+'/');await expect(page).toHaveURL(base+'/applications')}
 await page.goto(base+'/operations');await expect(page).toHaveURL(base+'/applications');
 const member=await browser.newContext();await member.route('**/api/v1/auth/me',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:'qa-member',name:'Member',role:'member'})}));
 const memberPage=await member.newPage();for(const path of ['/clusters','/applications?install=openresty','/websites']){await memberPage.goto(base+path);await expect(memberPage).toHaveURL(base+'/settings')}await member.close();
 await page.goto(base+'/settings?tab=appearance&section=homepage');await page.getByRole('combobox',{name:'默认首页',exact:true}).click();await expect(page.locator('.ant-select-dropdown:visible').getByText('集群',{exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
 checks.push('旧集群/运维本地首页偏好与 /operations 转至应用；成员无法进入集群、网站或安装路由');

 // Revisit uninstalled state in a second viewport using a read-only response fixture.
 await page.route('**/api/v1/ops/overview',async route=>{const response=await route.fetch();const body=await response.json();body.resources=body.resources.filter(r=>r.id!==entry.id);await route.fulfill({response,json:body})});
 await page.setViewportSize({width:720,height:500});await page.goto(base+'/websites');await guide();await noOverflow();await expect(page.getByRole('button',{name:'安装 OpenResty',exact:true})).toBeInViewport();await shot('uninstalled-200-equivalent');
 await page.unroute('**/api/v1/ops/overview');
 expect(errors).toEqual([]);await writeFile(resolve(out,'results.json'),JSON.stringify({checks,errors,media:relative(root,media),limitations:'Disposable HTTP/SQLite fixture; no remote Agent or public DNS execution. 200% layout checked at 720px equivalent viewport.'},null,2));console.log(JSON.stringify({checks,errors,media}));
}catch(error){await shot('failure');await writeFile(resolve(out,'failure.txt'),await page.locator('body').innerText());throw error}
finally{await browser.close()}
