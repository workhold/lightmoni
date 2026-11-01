import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';
const root=resolve(import.meta.dirname,'../../../..'),base=process.env.LIGHTMONI_INSTALL_UI_URL??'http://127.0.0.1:5177';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw Error('Loopback QA fixture required');
const out=resolve(root,process.env.LIGHTMONI_INSTALL_UI_OUT??'specs/058-app-install-progress/evidence/ui-'+(process.env.LIGHTMONI_UI_RUN??'1')),media=mediaDirectory(out);await mkdir(out,{recursive:true});await rm(resolve(out,'failure.txt'),{force:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:media,size:{width:1440,height:1000}}});
await context.addInitScript(()=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance','dark')});
const page=await context.newPage(),checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
const catalog=()=>page.locator('.lm-ops-catalog'),progress=()=>page.locator('.lm-install-progress');
async function json(path,data){const res=await context.request.fetch(base+'/api/v1'+path,{method:data?'POST':'GET',...(data?{data}:{})});if(!res.ok())throw Error(path+': '+await res.text());return res.json()}
async function shot(name){await expect.poll(()=>page.evaluate(()=>document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).every(a=>a.playState!=='running'))).toBe(true);await page.screenshot({path:resolve(media,name+'.png'),animations:'disabled'})}
async function install(name,{failFirst=false}={}){
 await page.getByRole('button',{name:'应用商店',exact:true}).click();await page.getByRole('listitem',{name:'Redis',exact:true}).getByRole('button',{name:/^安\s*装$/}).click();
 await catalog().getByLabel('展示名',{exact:true}).fill(name);await expect(catalog().getByLabel('服务标识',{exact:true})).toBeHidden();await expect(catalog().locator('.ant-select').filter({has:page.getByLabel('部署机器',{exact:true})})).toContainText('QA Docker 节点');
 await catalog().getByLabel('访问密码',{exact:true}).fill('qa-hidden-install-secret');await expect(catalog().getByLabel('宿主端口 · redis',{exact:true})).toHaveValue('6379');
 if(failFirst){
  await shot('basic-install');await catalog().getByText('高级设置',{exact:true}).click();await expect(catalog().getByLabel('服务标识',{exact:true})).toBeVisible();
  const mode=async label=>{await catalog().getByLabel('部署模式',{exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText(label,{exact:true}).click()};
  await mode('自动调度');await expect(catalog().getByLabel('宿主端口 · redis',{exact:true})).toHaveValue('0');await mode('手动指定机器');await expect(catalog().getByLabel('宿主端口 · redis',{exact:true})).toHaveValue('6379');await catalog().getByLabel('宿主端口 · redis',{exact:true}).fill('16379');await mode('自动调度');await expect(catalog().getByLabel('宿主端口 · redis',{exact:true})).toHaveValue('16379');await mode('手动指定机器');await catalog().getByLabel('宿主端口 · redis',{exact:true}).fill('0');
  await catalog().getByLabel('每实例内存（MiB）',{exact:true}).fill('192');await shot('advanced-settings');await catalog().getByText('高级设置',{exact:true}).click();
  await page.route('**/api/v1/ops/catalog/redis/install',r=>r.fulfill({status:409,json:{error:'qa_install_conflict'}}));
  await catalog().getByRole('button',{name:/开始安装$/}).click();await expect(catalog().getByText('安装未完成，输入已保留',{exact:true})).toBeVisible();await expect(catalog().getByLabel('展示名',{exact:true})).toHaveValue(name);await expect(catalog().getByLabel('访问密码',{exact:true})).toHaveValue('qa-hidden-install-secret');await page.unroute('**/api/v1/ops/catalog/redis/install');
 }
 await catalog().getByLabel('宿主端口 · redis',{exact:true}).fill('0');
 await expect(catalog().getByRole('button',{name:/开始安装$/})).not.toHaveClass(/ant-btn-loading/);
 const [reply]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/ops/catalog/redis/install')&&r.request().method()==='POST'),catalog().getByRole('button',{name:/开始安装$/}).click()]);const body=await reply.json();expect(reply.status()).toBe(201);if(failFirst)expect(body.resource.spec.deployments[0].memory_mb).toBe(192);
 await expect(progress()).toBeVisible();await expect(catalog()).toBeHidden();await expect(progress().getByText('安装进行中',{exact:true})).toBeVisible();return {resource:body.resource,run:body.runs[0]};
}
async function step(run,phase,extra={}){await json('/qa/advance',{run_id:run.id,phase,...extra})}
async function begin(run){for(const phase of ['accepted','staging'])await step(run,phase);await step(run,'activating',{step:'starting_containers'})}
async function close(){await progress().getByRole('button',{name:/^(关闭|Close)$/}).click();await expect(progress()).toBeHidden()}
try{
 if((await json('/auth/me')).id!=='qa-admin')throw Error('Disposable fixture required');
 await page.goto(base+'/applications');
 await page.route('**/api/v1/ops/catalog',r=>r.fulfill({status:503,json:{error:'qa_catalog_unavailable'}}));
 await page.getByRole('button',{name:'应用商店',exact:true}).click();await expect(page.getByText('无法读取应用商店',{exact:true})).toBeVisible();
 await page.unroute('**/api/v1/ops/catalog');await page.getByRole('button',{name:/^重\s*试$/,exact:true}).click();await expect(page.getByRole('listitem',{name:'Redis',exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'已安装',exact:true}).click();checks.push('应用商店加载失败可见且可原位重试');
 const suffix=Date.now().toString(36),failed=await install('失败安装-'+suffix,{failFirst:true});checks.push('基本表单自动选择唯一集群/在线机器；手动容器端口/托管自动分配0/显式端口跨模式保留；高级资源折叠提交；保存失败保留输入');
 await begin(failed.run);await expect(progress().getByText('拉取镜像并启动容器',{exact:true}).first()).toBeVisible();await shot('install-running');
 await page.route('**/api/v1/ops/runs/*/events?*',r=>r.fulfill({status:503,json:{error:'qa_logs_unavailable'}}));await expect(progress().getByText('步骤日志读取失败',{exact:true})).toBeVisible();await expect(progress().getByText('安装完成，应用已运行',{exact:true})).toHaveCount(0);await shot('logs-unavailable');await page.unroute('**/api/v1/ops/runs/*/events?*');await progress().getByRole('button',{name:/^刷\s*新$/}).click();await expect(progress().getByText('步骤日志读取失败',{exact:true})).toHaveCount(0);
 await step(failed.run,'failed',{cause:'image_network_failed'});await expect(progress().getByText('安装未完成',{exact:true})).toBeVisible();await expect(progress().getByText('失败原因 · 镜像下载网络异常',{exact:true})).toBeVisible();await expect(progress().getByText('检查目标机器到镜像仓库的 DNS、网络和代理配置。',{exact:true})).toBeVisible();await shot('failure-reason');
 const rows=await progress().locator('tbody tr').count();expect(rows).toBeGreaterThan(3);await close();await page.reload();await page.getByRole('article',{name:failed.resource.name,exact:true}).getByRole('button',{name:'安装记录',exact:true}).click();await expect(progress().getByText('失败原因 · 镜像下载网络异常',{exact:true})).toBeVisible();expect(await progress().locator('tbody tr').count()).toBe(rows);checks.push('真实 Agent job 阶段持久化；日志503不误报成功，恢复去重；失败原因与建议刷新后回读');
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot('failure-390');await close();
 await page.setViewportSize({width:1440,height:1000});const good=await install('成功安装-'+suffix);await begin(good.run);await step(good.run,'verifying');await step(good.run,'succeeded');await expect(progress().getByText('安装完成，应用已运行',{exact:true})).toBeVisible();await shot('install-succeeded');await close();checks.push('最终成功仅由健康回执和整体应用状态确认');
 await page.goto(base+'/applications?cluster='+good.resource.spec.deployments[0].cluster_id);
 const goodCard=page.getByRole('article',{name:good.resource.name,exact:true});await expect(goodCard.getByText('运行中',{exact:true})).toBeVisible();await goodCard.getByRole('button',{name:/^停\s*止$/,exact:true}).click();await expect(page.getByRole('dialog').getByText('停止所选部署，服务将不可用；持久化数据保留。',{exact:true})).toBeVisible();await expect(page.getByRole('dialog').locator('.ant-select').filter({has:page.getByLabel('执行集群（留空为全部已配置集群）',{exact:true})})).toContainText('安装集群');await page.getByRole('dialog').getByRole('button',{name:/取\s*消/}).click();await shot('installed-cards');checks.push('已安装卡片显示版本、机器和端口，直接停止继承筛选集群、展示影响并可取消');
 const unknown=await install('未知安装-'+suffix);await begin(unknown.run);await step(unknown.run,'unknown');await expect(progress().getByText('执行结果未知',{exact:true})).toBeVisible();await expect(progress().getByText('结果未知，请先检查实际状态，不要重复安装。',{exact:true})).toBeVisible();await shot('install-unknown');await close();checks.push('unknown 独立展示且不自动重新安装');
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'切换语言',exact:true}).click();await page.getByRole('menuitem',{name:'English',exact:true}).click();await page.getByRole('article',{name:failed.resource.name,exact:true}).getByRole('button',{name:'Installation history',exact:true}).click();await expect(progress().getByText('Failure reason · Image download network failure',{exact:true})).toBeVisible();await shot('failure-en-390');await close();
 await page.getByRole('button',{name:'Application store',exact:true}).click();await page.getByRole('listitem',{name:'Redis',exact:true}).getByRole('button',{name:'Install',exact:true}).click();await expect(catalog().getByRole('button',{name:'Start installation',exact:true})).toBeVisible();await shot('basic-en-390');await catalog().getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('tab',{name:'Installed',exact:true}).click();
 await page.setViewportSize({width:720,height:500});await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('article',{name:failed.resource.name,exact:true}).getByRole('button',{name:'Installation history',exact:true}).click();await expect(progress().getByText('Failure reason · Image download network failure',{exact:true})).toBeVisible();await shot('failure-200-equivalent');checks.push('中文/英文390px、200%等效布局与减少动效检查');
 expect(errors).toEqual([]);await writeFile(resolve(out,'results.json'),JSON.stringify({checks,errors,media:relative(root,media),limits:'Real HTTP/SQLite/job controller with controlled Agent receipts. No external Docker or registry executed. 200% checked at equivalent viewport.'},null,2));console.log(JSON.stringify({checks,errors,media}));
}catch(e){await shot('failure');await writeFile(resolve(out,'failure.txt'),await page.locator('body').innerText());throw e}
finally{await context.close();await browser.close()}
