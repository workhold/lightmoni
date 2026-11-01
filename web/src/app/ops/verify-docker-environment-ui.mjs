import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';
const root=resolve(import.meta.dirname,'../../../..'),base='http://127.0.0.1:5179',out=resolve(root,'specs/069-docker-environment/evidence'),media=mediaDirectory(out);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1600,height:1080},reducedMotion:'reduce'});
await context.addInitScript(()=>{if(!localStorage.getItem('lightmoni.language'))localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance','dark')});
const page=await context.newPage(),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
const panel=()=>page.getByRole('dialog').filter({has:page.getByText(/^Docker 环境 · /)});
const post=async(path,data={})=>{const r=await context.request.post(base+'/api/v1'+path,{data});if(!r.ok())throw Error(await r.text());return r.json();};
try{
 await page.goto(base+'/machines');
 for(const status of ['未安装','可用','权限不足','服务不可用','待检测','观测已过期'])await expect(page.getByRole('table').getByText(status,{exact:true}).first()).toBeVisible();
 await page.screenshot({path:resolve(media,'machine-docker-states.png'),fullPage:true});checks.push('机器列表六种状态分别展示');
 const missing=page.getByRole('row').filter({has:page.getByText('缺少 Docker',{exact:true})});await missing.getByRole('button',{name:'安装 Docker',exact:true}).click();
 await expect(panel()).toBeVisible();await expect(panel().getByText('未安装',{exact:true})).toBeVisible();await expect(panel().getByRole('combobox')).toHaveCount(1);
 await page.screenshot({path:resolve(media,'docker-install-panel.png')});
 await panel().getByRole('button',{name:'一键安装 Docker',exact:true}).click();await page.getByRole('button',{name:'确认安装',exact:true}).click();await expect(panel().getByText('正在安装',{exact:true})).toBeVisible();
 await panel().getByRole('button',{name:'关闭',exact:true}).click();await missing.getByRole('button',{name:'安装 Docker',exact:true}).click();
 await expect(panel().getByText('环境安装完成',{exact:true})).toBeVisible({timeout:15000});await expect(panel().getByText('未安装',{exact:true})).toBeVisible();checks.push('确认安装、关窗重开持久回读、SSH成功不掩盖Agent观测');
 await post('/qa/agent-ready');await panel().getByRole('button',{name:/^刷\s*新$/}).click();await expect(panel().getByText('可用',{exact:true})).toBeVisible();await expect(panel().getByRole('button',{name:'一键安装 Docker',exact:true})).toBeDisabled();
 await panel().getByRole('button',{name:'关闭',exact:true}).click();
 const permission=page.getByRole('row').filter({has:page.getByText('Docker 权限不足',{exact:true})});await permission.getByRole('button',{name:'检查环境',exact:true}).click();await expect(panel().getByText('Agent 无权访问 Docker',{exact:true})).toBeVisible();await expect(panel().getByRole('button',{name:'一键安装 Docker',exact:true})).toBeDisabled();await panel().getByRole('button',{name:'关闭',exact:true}).click();checks.push('权限错误独立引导，不能误导为缺失或继续补装');
 await page.goto(base+'/applications');await page.getByRole('article',{name:'OpenResty 缺少 Docker',exact:true}).getByRole('button',{name:'安装记录',exact:true}).click();
 const progress=page.locator('.lm-install-progress');await expect(progress.getByText('安装未完成',{exact:true})).toBeVisible();await expect(progress.getByText('失败原因 · 目标机器未安装 Docker',{exact:true})).toBeVisible();await progress.getByRole('button',{name:'补装 Docker 环境',exact:true}).click();await expect(panel().getByText('环境安装完成',{exact:true})).toBeVisible({timeout:15000});await expect(panel().getByText('可用',{exact:true})).toBeVisible();await page.screenshot({path:resolve(media,'application-docker-recovery.png')});checks.push('OpenResty失败摘要和精确诊断、补装入口绑定实际主机、保留失败历史');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(media,'docker-mobile.png')});expect(await panel().evaluate(el=>el.getBoundingClientRect().width)).toBeLessThanOrEqual(390);checks.push('390px面板可见且宽度有界');
 await page.evaluate(()=>localStorage.setItem('lightmoni.language','en-US'));await page.reload();await page.goto(base+'/machines');await page.getByRole('row').filter({has:page.getByText('Docker 权限不足',{exact:true})}).getByRole('button',{name:'Check environment',exact:true}).click();await expect(page.getByText('Agent cannot access Docker',{exact:true})).toBeVisible();await page.screenshot({path:resolve(media,'docker-english-mobile.png')});checks.push('英文诊断与窄屏');
 expect(errors).toEqual([]);await writeFile(resolve(out,'ui-report.json'),JSON.stringify({checks,errors,media},null,2));console.log(JSON.stringify({checks,errors,media}));
}catch(error){await page.screenshot({path:resolve(media,'failure.png'),fullPage:true});await writeFile(resolve(out,'ui-failure.txt'),String(error)+'\n'+await page.locator('body').innerText());throw error;}
finally{await context.close();await browser.close();}
