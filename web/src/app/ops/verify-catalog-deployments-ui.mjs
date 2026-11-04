import {chromium,expect} from '@playwright/test';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {basename,relative,resolve} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';

const root=resolve(import.meta.dirname,'../../../..');
const base=process.env.LIGHTMONI_CATALOG_TARGETS_UI_URL??'http://127.0.0.1:5197';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw Error('Loopback QA fixture required');
const out=resolve(root,'specs/092-catalog-deployment-duplicates/evidence'),media=mediaDirectory(out);
await mkdir(out,{recursive:true});
const harness=await mkdtemp(resolve(root,'web/qa-catalog-targets-'));
const browser=await chromium.launch({headless:true,channel:'chrome'}),checks=[],errors=[];
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{if(!localStorage.getItem('lightmoni.language'))localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance','light')});
const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
const panel=()=>page.locator('.lm-ops-catalog');
async function api(path,body){const reply=await context.request.fetch(base+'/api/v1'+path,{method:body?'POST':'GET',...(body?{data:body}:{})});expect(reply.ok(),await reply.text()).toBe(true);return reply.json()}
async function refresh(){await Promise.all([page.waitForResponse(r=>r.url().includes('/ops/overview')),page.evaluate(()=>window.dispatchEvent(new Event('focus')))])}
async function select(label,option,index=0){await panel().getByLabel(label,{exact:true}).nth(index).click();await page.locator('.ant-select-dropdown:visible').last().getByText(option,{exact:true}).click()}
async function open(){await page.goto(base+'/applications?view=store');await page.getByRole('listitem',{name:'Gitea',exact:true}).getByRole('button',{name:/^(安\s*装|Install)$/}).click()}
async function manual(){await panel().getByText('高级设置',{exact:true}).click();await select('安装位置','自选部署位置')}
async function install(templateID='gitea'){const [reply]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/ops/catalog/'+templateID+'/install')),panel().getByRole('button',{name:/^(开始安装|Start installation)$/}).click()]);return {status:reply.status(),request:reply.request().postDataJSON(),body:await reply.json()}}
async function machine(name,index=0){await expect(panel().locator('.lm-install-target').nth(index)).toContainText(name)}

try{
 expect((await api('/auth/me')).id).toBe('qa-admin');
 expect((await api('/ops/overview')).resources).toHaveLength(0);
 const first=(await api('/ops/resources',{kind:'cluster',name:'第一集群',spec:{machine_ids:['qa-machine'],nodes:[{machine_id:'qa-machine',address:'10.0.0.7',cpu:8,memory_mb:8192}]}})).resource;
 await open();await panel().getByLabel('外部访问 URL',{exact:true}).fill('https://git.example.test');await manual();
 await expect(panel().getByRole('button',{name:/添加集群部署$/})).toBeDisabled();
 await refresh();await expect(panel().locator('.lm-install-target')).toHaveCount(1);
 const single=await install();expect(single.status).toBe(201);expect(single.request.deployments.map(d=>d.cluster_id)).toEqual([first.id]);
 checks.push('单集群禁止添加第二行；刷新后 Gitea 安装仍只提交一个位置，真实 HTTP 返回 201');

 await open();await panel().getByLabel('外部访问 URL',{exact:true}).fill('https://auto.example.test');
 const automatic=await install();expect(automatic.status).toBe(201);expect(automatic.request.deployments).toBeUndefined();expect(automatic.body.resource.spec.deployments).toHaveLength(1);
 checks.push('自动选址不提交手工草稿，后端仍生成唯一位置');

 const second=(await api('/ops/resources',{kind:'cluster',name:'第二集群',spec:{machine_ids:['qa-machine-2'],nodes:[{machine_id:'qa-machine-2',address:'10.0.0.8',cpu:8,memory_mb:8192}]}})).resource;
 await open();await panel().getByLabel('外部访问 URL',{exact:true}).fill('https://multi.example.test');await manual();
 await select('部署集群','第一集群');await panel().getByRole('button',{name:/添加集群部署$/}).click();
 await expect(panel().locator('.lm-install-target')).toHaveCount(2);await expect(panel().getByRole('button',{name:/添加集群部署$/})).toBeDisabled();
 await refresh();await expect(panel().locator('.lm-install-target').nth(1)).toContainText('选择安装位置');
 // A disappearing cluster must not cause the sole remaining cluster to be copied into the blank row.
 await page.route('**/api/v1/ops/overview*',async route=>{const reply=await route.fetch(),body=await reply.json();body.resources=body.resources.filter(r=>r.id!==second.id);await route.fulfill({response:reply,json:body})});
 await refresh();await expect(panel().locator('.lm-install-target').nth(1)).toContainText('选择安装位置');
 await page.unroute('**/api/v1/ops/overview*');await refresh();
 await select('部署集群','第二集群',1);await machine('QA 备用节点',1);
 await panel().getByLabel('每实例内存（MiB）',{exact:true}).nth(0).fill('1152');await panel().getByLabel('每实例内存（MiB）',{exact:true}).nth(1).fill('1792');
 await panel().locator('.lm-install-target').first().getByRole('button',{name:/移除$/}).click();
 await expect(panel().locator('.lm-install-target')).toHaveCount(1);await expect(panel().getByRole('button',{name:/添加集群部署$/})).toBeEnabled();
 await expect(panel().getByLabel('每实例内存（MiB）',{exact:true})).toHaveValue('1792');
 await panel().getByRole('button',{name:/添加集群部署$/}).click();await select('部署集群','第一集群',1);await machine('QA Docker 节点',1);
 await panel().getByLabel('宿主端口 · http',{exact:true}).fill('13000');await panel().getByLabel('宿主端口 · ssh',{exact:true}).fill('12222');
 await panel().getByText('高级设置',{exact:true}).click();
 const multi=await install();expect(multi.status).toBe(201);expect(multi.request.deployments.map(d=>d.cluster_id)).toEqual([second.id,first.id]);expect(multi.body.resource.spec.deployments).toHaveLength(2);expect(multi.request.deployments.map(d=>d.memory_mb)).toEqual([1792,1024]);
 checks.push('多集群添加/移除/重新添加均保持独立；刷新只剩一个集群时不复制已选位置；合法双集群安装返回 201');

 for(const language of ['zh-CN','en-US']){
  await page.evaluate(language=>{localStorage.setItem('lightmoni.language',language)},language);
  await open();const english=language==='en-US',name='Gitea retry '+language;
  await panel().getByLabel(english?'Display name':'展示名',{exact:true}).fill(name);
  await panel().getByLabel(english?'Public URL':'外部访问 URL',{exact:true}).fill('https://retry.example.test');
  await page.route('**/api/v1/ops/catalog/gitea/install',route=>route.fulfill({status:400,json:{error:'duplicate_application_deployment'}}));
  const failed=await install();expect(failed.status).toBe(400);
  await expect(panel().getByText(english?'A cluster is selected more than once. Remove the duplicate target and select its machines in one deployment.':'部署集群重复。请移除重复的安装位置；同一集群的多台机器请在一处选择。',{exact:true})).toBeVisible();
  await expect(panel().getByLabel(english?'Display name':'展示名',{exact:true})).toHaveValue(name);
  await expect(panel().getByLabel(english?'Public URL':'外部访问 URL',{exact:true})).toHaveValue('https://retry.example.test');
  await page.setViewportSize({width:english?390:1440,height:1000});await page.screenshot({path:resolve(media,'duplicate-error-'+language+'.png'),animations:'disabled'});
  await page.unroute('**/api/v1/ops/catalog/gitea/install');const retry=await install();expect(retry.status).toBe(201);expect(retry.request.request_id).toBe(failed.request.request_id);
  checks.push(language+' 后端重复错误显示操作指引，输入和 request_id 保留，重试返回 201');
 }
 // Mount the real fields with an already duplicated draft, as retained by an older client.
 await writeFile(resolve(harness,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
 await writeFile(resolve(harness,'main.tsx'),`
 import React,{useState} from 'react';
 import {createRoot} from 'react-dom/client';
 import {Form,Button} from '../src/shared/ui';
 import I18nProvider from '../src/shared/i18n';
 import CatalogInstallFields from '../src/app/ops/CatalogInstallFields';
 const overview=await fetch('/api/v1/ops/overview').then(r=>r.json());
 const catalog=await fetch('/api/v1/ops/catalog').then(r=>r.json());
 const template=catalog.templates.find(t=>t.id==='gitea');
 const target={cluster_id:${JSON.stringify(first.id)},machine_ids:['qa-machine'],cpu:1,memory_mb:1024};
 function Draft(){const [form]=Form.useForm(),[advanced,setAdvanced]=useState(true);return <Form form={form} initialValues={{automatic_placement:false,spec:{deployment_mode:'manual',deployments:[target,{...target}]},parameters:{external_url:'https://retained.example.test'}}} onFinish={()=>{document.querySelector('#submitted').textContent='saved'}}><CatalogInstallFields template={template} resources={overview.resources} machines={overview.machines} advanced={advanced} onAdvanced={setAdvanced}/><Button htmlType="submit">验证安装</Button><output id="submitted"/></Form>}
 createRoot(document.getElementById('root')).render(<I18nProvider><Draft/></I18nProvider>);
 `);
 await page.evaluate(()=>localStorage.setItem('lightmoni.language','zh-CN'));
 await page.goto(base+'/'+basename(harness)+'/index.html');
 await page.getByRole('button',{name:'验证安装',exact:true}).click();
 await expect(page.getByText('每个集群只能配置一次部署；多台机器请在同一部署中选择。',{exact:true})).toBeVisible();
 await expect(page.locator('#submitted')).toBeEmpty();await expect(page.getByLabel('外部访问 URL',{exact:true})).toHaveValue('https://retained.example.test');
 await page.locator('.lm-install-target').nth(1).getByRole('button',{name:/移除$/}).click();
 await page.getByRole('button',{name:'验证安装',exact:true}).click();await expect(page.locator('#submitted')).toHaveText('saved');
 checks.push('真实字段组件载入旧重复草稿后阻止提交并保留参数，移除重复行后通过校验');

 const credential=(await api('/ops/resources',{kind:'credential',name:'DNS fixture',spec:{provider:'aliyun',access_key_id:'fixture',access_key_secret:'fixture-secret'}})).resource;
 const zone=(await api('/ops/resources',{kind:'dns_zone',name:'验收托管区域',spec:{domain:'example.test',credential_id:credential.id}})).resource;
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/applications?view=store');
 await page.getByRole('listitem',{name:'OpenResty',exact:true}).getByRole('button',{name:/^安\s*装$/}).click();await manual();await select('部署集群','第一集群');
 await select('入口域名托管（可选）','验收托管区域');
 await panel().getByLabel('每实例 CPU 核数',{exact:true}).fill('0.5');await panel().getByLabel('每实例内存（MiB）',{exact:true}).fill('192');await panel().getByText('高级设置',{exact:true}).click();
 const gateway=await install('openresty');expect(gateway.status).toBe(201);
 expect(gateway.body.resource.spec.deployments[0]).toMatchObject({cluster_id:first.id,gateway_dns_zone_id:zone.id,cpu:0.5,memory_mb:192});
 checks.push('OpenResty 高级托管区域和资源字段保留正确列表路径，折叠面板后提交仍完整');
 expect(errors).toEqual([]);
 await writeFile(resolve(out,'ui.json'),JSON.stringify({checks,errors,media:relative(root,media),limits:'Disposable real HTTP/SQLite/controller fixture; no remote Docker, public DNS or production installation executed.'},null,2));
 console.log(JSON.stringify({checks,errors,media},null,2));
}catch(error){await page.screenshot({path:resolve(media,'failure.png'),animations:'disabled'});console.error(await page.locator('body').innerText());throw error}
finally{await context.close();await browser.close();await rm(harness,{recursive:true,force:true})}
