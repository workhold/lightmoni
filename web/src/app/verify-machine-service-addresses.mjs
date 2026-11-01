import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

const root=resolve(import.meta.dirname,'../../..'),base=process.env.LIGHTMONI_FLOW_UI_URL??'http://127.0.0.1:5177';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Disposable loopback fixture required');
const run=process.env.LIGHTMONI_UI_RUN??'1',out=resolve(root,'specs/078-machine-service-addresses/evidence/ui-'+run),media=mediaDirectory(out);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{if(!localStorage.getItem('lightmoni.language'))localStorage.setItem('lightmoni.language','zh-CN');if(!localStorage.getItem('lightmoni.appearance'))localStorage.setItem('lightmoni.appearance','dark')});
const page=await context.newPage(),checks=[],errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/service-addresses'))writes.push(r.postDataJSON())});
const modal=()=>page.locator('.lm-machine-address-dialog'),section=scope=>modal().getByRole('region',{name:scope==='private'?'内网服务地址':'公网服务地址',exact:true});
async function json(path,options={}){const r=await context.request.fetch(base+'/api/v1'+path,options);if(!r.ok())throw Error(path+': '+r.status()+' '+await r.text());return r.json()}
async function choose(scope,text){await section(scope).getByLabel('选择方式',{exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText(text,{exact:true}).last().click();await page.keyboard.press('Escape')}
async function shot(name){await expect.poll(()=>page.evaluate(()=>document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).every(a=>a.playState!=='running'))).toBe(true);await page.screenshot({path:resolve(media,name+'.png'),animations:'disabled',fullPage:!await modal().isVisible()})}
async function open(){await page.getByRole('button',{name:'内外网服务地址',exact:true}).first().click();await expect(section('private')).toContainText('10.0.0.16')}
async function save(){await modal().getByRole('button',{name:'保存服务地址',exact:true}).click()}
try{
 expect((await json('/auth/me')).id).toBe('qa-admin');const all=await json('/machines'),host=(Array.isArray(all)?all:all.machines).find(m=>m.name==='NAT 入口主机');if(!host)throw Error('Use the website-management fixture');
 const path='/machines/'+host.id+'/service-addresses';let initial=await json(path);
 await json(path,{method:'PUT',data:{revision:initial.revision,target_generation:initial.target_generation,private:{mode:'auto',address:''},public:{mode:'auto',address:''}}});
 await page.goto(base+'/machines');await open();await expect(section('public')).toContainText('尚无可用地址');await expect(section('public')).toContainText('SSH 连接目标 · 需确认映射');
 await expect(modal()).not.toContainText('172.24.0.1');await expect(modal()).not.toContainText('172.17.0.1');await shot('candidates-dark');
 checks.push('内网网卡自动选择；NAT公网SSH候选仅供确认；代理与容器内网不混入');
 await section('public').getByRole('button',{name:'采用地址 8.8.4.4',exact:true}).click();await expect(section('public').getByLabel('公网 IP',{exact:true})).toHaveValue('8.8.4.4');expect(writes).toHaveLength(0);
 await choose('private','手动指定');await section('private').getByLabel('内网 IP',{exact:true}).fill('8.8.8.8');await save();await expect(section('private').getByText(/请填写内网或共享范围的 IP，不含端口、CIDR 或 URL/)).toBeVisible();expect(writes).toHaveLength(0);
 await section('private').getByLabel('内网 IP',{exact:true}).fill('10.0.0.17');await section('public').getByLabel('公网 IP',{exact:true}).fill('172.21.0.16');await save();await expect(section('public').getByText(/请填写普通公网范围的 IP，不含端口、CIDR 或 URL/)).toBeVisible();expect(writes).toHaveLength(0);await shot('field-error');
 await section('public').getByLabel('公网 IP',{exact:true}).fill('8.8.4.4');
 const conflict='**/api/v1'+path;await page.route(conflict,async route=>route.request().method()==='PUT'?route.fulfill({status:409,json:{error:'machine_service_address_revision_conflict'}}):route.continue());
 await save();await expect(modal()).toContainText('地址配置已被其他操作更新');await expect(section('private').getByLabel('内网 IP',{exact:true})).toHaveValue('10.0.0.17');
 await page.unroute(conflict);await save();await expect(modal()).toBeHidden();const saved=await json(path);expect(saved.private.effective).toBe('10.0.0.17');expect(saved.public.effective).toBe('8.8.4.4');expect(saved.updated_by).toBe('qa-admin');
 checks.push('采用候选不隐式保存；内外网范围错误定位字段；冲突保留输入；真实SQLite/API保存并回读来源/操作者');
 await open();await expect(section('private')).toContainText('10.0.0.17');await expect(section('public')).toContainText('手动指定');await shot('manual-saved');
 await page.setViewportSize({width:390,height:844});await shot('addresses-390');await section('public').getByLabel('公网 IP',{exact:true}).scrollIntoViewIfNeeded();await shot('addresses-390-public');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(modal().getByRole('button',{name:'保存服务地址',exact:true})).toBeInViewport();
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.style.zoom='2');await shot('addresses-200');await expect(modal().locator('.ant-modal-close')).toBeInViewport();await expect(modal().getByRole('button',{name:'保存服务地址',exact:true})).toBeInViewport();await section('public').getByRole('button',{name:'采用地址 8.8.4.4',exact:true}).scrollIntoViewIfNeeded();await expect(section('public').getByRole('button',{name:'采用地址 8.8.4.4',exact:true})).toBeInViewport();await shot('addresses-200-public');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>document.documentElement.style.zoom='');
 await choose('private','自动选择网卡地址');await choose('public','自动选择网卡地址');await save();await expect(modal()).toBeHidden();const restored=await json(path);expect(restored.private.effective).toBe('10.0.0.16');expect(restored.public.effective).toBe('');
 checks.push('内外网独立恢复自动，不改写原始网卡；390px/200%可操作且无页面溢出');

 await open();
 async function frames(name,locator){await locator.evaluate(el=>{el.style.animation='none';void el.offsetWidth;el.style.animation='';for(const a of el.getAnimations()){a.pause();a.currentTime=0}});for(const [index,at] of [0,90,180].entries()){await locator.evaluate((el,at)=>{for(const a of el.getAnimations())a.currentTime=at},at);await page.screenshot({path:resolve(media,name+'-'+index+'.png'),animations:'allow'})}}
 await frames('motion-section',modal().locator('.lm-machine-address-section').first());
 await section('public').getByRole('button',{name:'采用地址 8.8.4.4',exact:true}).click();
 await frames('motion-adopt',section('public').locator('.lm-machine-manual-address'));
 const primary=modal().getByRole('button',{name:'保存服务地址',exact:true});await primary.hover();await page.screenshot({path:resolve(media,'motion-save-0.png'),animations:'allow'});await page.mouse.down();await page.screenshot({path:resolve(media,'motion-save-1.png'),animations:'allow'});await page.mouse.up();await expect(modal()).toBeHidden();await page.screenshot({path:resolve(media,'motion-save-2.png'),animations:'allow'});checks.push('表单出场与采用候选180ms原生CSS时间轴三帧，保存按钮按下/释放反馈三帧');
 await page.evaluate(()=>{localStorage.setItem('lightmoni.language','en-US');localStorage.setItem('lightmoni.appearance','light')});await page.reload();await page.getByRole('button',{name:'Private & public service addresses',exact:true}).first().click();await expect(modal()).toContainText('Public service address');await shot('addresses-english-light');
 await page.emulateMedia({reducedMotion:'reduce'});expect(await modal().locator('.lm-machine-address-section').first().evaluate(el=>getComputedStyle(el).animationName)).toBe('none');checks.push('英文/浅色主题与减少动态效果');
 expect(errors).toEqual([]);await writeFile(resolve(out,'results.json'),JSON.stringify({checks,errors,writes:writes.length,media:relative(root,media),scope:'Real disposable SQLite/HTTP host APIs. Only conflict response injected; no SSH, production hosts or external DNS writes.'},null,2)+'\n');console.log(JSON.stringify({checks,errors,media}));
}catch(e){await shot('failure');await writeFile(resolve(out,'failure.txt'),await page.locator('body').innerText());throw e}finally{await browser.close()}
