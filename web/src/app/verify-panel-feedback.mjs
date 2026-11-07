import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'../../..'),base='http://127.0.0.1:19887';
const round=process.env.LIGHTMONI_UI_RUN??'1',out=resolve(root,'specs/104-panel-feedback/evidence'),media=resolve(root,'.local-dev/panel-feedback-104/round-'+round);
await mkdir(out,{recursive:true});await mkdir(media,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),checks=[],errors=[];
const context=await browser.newContext({viewport:{width:1366,height:900},locale:'zh-CN'});
await context.addInitScript(()=>{localStorage.setItem('lightmoni.language','zh-CN');if(!localStorage.getItem('lightmoni.appearance'))localStorage.setItem('lightmoni.appearance','light')});
const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
const qa=async(path)=>{const response=await context.request.get(base+'/__qa/'+path);expect(response.ok()).toBe(true);return response.json()};
const mark=value=>checks.push(value);
const shot=async(name)=>{await expect(page.locator('.lm-main .lm-page').first()).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).every(a=>a.playState!=='running'))).toBe(true);await page.screenshot({path:resolve(media,name+'.png'),fullPage:true,animations:'disabled'})};
const fits=async()=>expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
const choose=async(label,value)=>{await page.getByLabel(label,{exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText(value,{exact:true}).click()};
try{
 await qa('reset');
 await page.goto(base+'/websites/qa-web/monitoring?minutes=15&source=qa');
 await expect(page.getByRole('heading',{name:'ABC Demo',exact:true})).toBeVisible();
 await expect(page.locator('.lm-application-plot')).toHaveCount(2);await expect(page.locator('.lm-application-plot').first()).toContainText('北京 · 生产集群');
 await expect(page.getByRole('table')).toHaveCount(0);await shot('website-overview');
 await page.getByRole('tab',{name:'访问日志',exact:true}).click();await expect(page).toHaveURL(/tab=logs/);expect(new URL(page.url()).searchParams.get('minutes')).toBe('15');expect(new URL(page.url()).searchParams.get('source')).toBe('qa');
 await page.reload();await expect(page.getByRole('tab',{name:'访问日志',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(5);await expect(page.locator('.ant-tabs-tabpane-active .lm-application-plot')).toHaveCount(0);await expect(page.locator('.ant-table-tbody pre')).toHaveCount(0);
 await page.getByRole('button',{name:'日志详情',exact:true}).first().click();let detail=page.getByRole('dialog',{name:'日志详情',exact:true});await expect(detail).toBeVisible();await expect(detail).toContainText('"request_time":0');await expect(detail).toContainText('北京 · 生产集群');await shot('access-log-detail');await detail.locator('.ant-drawer-close').click();
 await choose('状态码筛选','5xx');await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(1);await expect(page.locator('.ant-table-tbody')).toContainText('502');await choose('状态码筛选','全部状态码');
 await page.getByRole('textbox',{name:'筛选已加载日志',exact:true}).fill('no-such-route');await expect(page.getByText('没有符合筛选条件的日志',{exact:true})).toBeVisible();await page.getByRole('textbox',{name:'筛选已加载日志',exact:true}).fill('');await shot('access-logs');
 await page.getByRole('tab',{name:'访问大盘',exact:true}).click();await page.goBack();await expect(page.getByRole('tab',{name:'访问日志',exact:true})).toHaveAttribute('aria-selected','true');await page.goForward();await expect(page.getByRole('tab',{name:'访问大盘',exact:true})).toHaveAttribute('aria-selected','true');
 await choose('监控时间范围','最近 1 小时');expect(new URL(page.url()).searchParams.get('minutes')).toBe('60');
 mark('Overview/log tabs, URL refresh/back/forward, time range, named cluster legend, loaded-record filters, compact rows and raw details including zero duration');
 await qa('telemetry/empty');await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByText('此时间范围内暂无请求数据',{exact:true}).first()).toBeVisible();
 await qa('telemetry/degraded');await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByText('zz-bj-1 · 采集异常',{exact:true})).toBeVisible();await expect(page.locator('.lm-collection-status')).toContainText('最近成功');await shot('collection-degraded');
 await qa('telemetry/error');await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByText('监控加载失败',{exact:true})).toBeVisible();await expect(page.locator('.lm-application-plot')).toHaveCount(2);
 await qa('telemetry/truncated');await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('tab',{name:'访问日志',exact:true}).click();await expect(page.getByText('日志已截断，筛选仅针对已加载记录；请缩短时间范围',{exact:true})).toBeVisible();
 mark('Empty, collection degraded with last-success evidence, read failure retains data, and truncation scope');
 await page.goto(base+'/machines');await expect(page.getByRole('button',{name:'登录终端',exact:true})).toBeVisible();
 expect(await page.getByRole('button',{name:'登录终端',exact:true}).innerText()).toBe('');
 await page.getByRole('button',{name:'登录终端',exact:true}).focus();await expect(page.getByRole('tooltip')).toContainText('登录终端');
 await page.getByRole('button',{name:'Agent 管理 · zz-bj-1',exact:true}).click();await expect(page.getByRole('menuitem',{name:/升级 Agent/})).toHaveAttribute('aria-disabled','true');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'更多操作 · zz-bj-1',exact:true}).click();await expect(page.getByRole('menuitem',{name:'主机详情',exact:true})).toBeVisible();await page.keyboard.press('Escape');await page.mouse.move(0,0);await page.getByRole('button',{name:'刷新',exact:true}).blur();await fits();await shot('hosts');
 await page.goto(base+'/connection-credentials');await page.getByRole('button',{name:'重命名',exact:true}).click();let modal=page.getByRole('dialog',{name:'重命名连接凭据',exact:true});const finalName='生产 SSH · '+round;
 await modal.getByRole('textbox',{name:'凭据名称',exact:true}).fill(finalName);await qa('fail-next');await modal.getByRole('button',{name:'保存凭据',exact:true}).click();await expect(modal.getByRole('alert')).toContainText('credential_revision_conflict');await expect(modal.getByRole('textbox',{name:'凭据名称',exact:true})).toHaveValue(finalName);await shot('credential-save-failure');
 await modal.getByRole('button',{name:'保存凭据',exact:true}).click();await expect(modal).toHaveCount(0);await page.reload();await expect(page.getByText(finalName,{exact:true})).toBeVisible();
 const before=(await qa('calls')).filter(c=>c.path.endsWith('/revoke')).length;await page.getByRole('button',{name:'撤销',exact:true}).click();modal=page.getByRole('dialog',{name:'撤销连接凭据？',exact:true});await expect(modal).toContainText('清除保存的秘密');await modal.getByRole('button',{name:'取消',exact:true}).click();expect((await qa('calls')).filter(c=>c.path.endsWith('/revoke'))).toHaveLength(before);await shot('credentials');
 mark('Host icon actions, keyboard tooltip and disabled Agent operations; credential rename failure preserves input, save survives refresh, revocation still confirms');
 await page.goto(base+'/machines?tab=tasks');await expect(page.getByRole('button',{name:'派发任务',exact:true})).toBeVisible();await page.getByRole('button',{name:'删除',exact:true}).click();await expect(page.getByRole('dialog',{name:'确认删除',exact:true})).toBeVisible();await page.getByRole('dialog',{name:'确认删除',exact:true}).locator('.ant-modal-footer .ant-btn-default').click();await shot('tasks');
 await page.getByRole('tab',{name:'执行记录',exact:true}).click();await page.getByRole('button',{name:'查看结果',exact:true}).click();const taskResult=page.getByRole('dialog',{name:'执行结果',exact:true});await expect(taskResult).toContainText('执行结果未知，请先核对目标实际状态');await expect(taskResult).toContainText('archive started');await shot('task-result');await taskResult.locator('.ant-drawer-close').click();
 await page.goto(base+'/domains');await page.getByRole('button',{name:'解析记录',exact:true}).click();const dns=page.getByRole('dialog',{name:'解析记录 · heyphp.com',exact:true});await expect(dns.getByRole('button',{name:'批量删除',exact:true})).toBeDisabled();await dns.getByRole('button',{name:'删除',exact:true}).click();await expect(page.getByText('确认删除此 DNS 记录？',{exact:true})).toBeVisible();await page.keyboard.press('Escape');await shot('dns-records');

 for(const state of ['unknown','failed','running','succeeded']){
  await qa('run/'+state);await page.goto(base+'/websites');await page.getByRole('button',{name:'操作日志',exact:true}).click();const logs=page.getByRole('dialog',{name:'操作日志',exact:true});await expect(logs.locator('.ant-table-tbody')).toContainText('部署');await expect(logs.locator('pre')).toHaveCount(0);
  await logs.getByRole('button',{name:'查看回执',exact:true}).click();const result=page.getByRole('dialog',{name:'执行结果',exact:true});await expect(result).toBeVisible();await expect(result.locator('details')).not.toHaveAttribute('open','');
  if(state==='unknown')await expect(result.getByRole('alert')).toContainText('先核对目标实际状态');
  if(state==='failed')await expect(result.getByRole('alert')).toContainText('Nginx 配置检查失败');
  if(state==='running')await expect(result.getByRole('alert').first()).toContainText('请求已提交');
  await result.locator('summary').click();await expect(result.locator('pre')).toContainText(state==='failed'?'nginx_test_failed':state==='succeeded'?'ok':'awaiting_receipt');await result.locator('summary').click();await shot('execution-'+state);
  if(state==='unknown'){await qa('run/succeeded');await result.getByRole('button',{name:'刷新结果',exact:true}).click();await expect(result.locator('.lm-result-summary')).toContainText('成功');await expect(result.getByText('执行结果未知',{exact:true})).toHaveCount(0);await expect(result.getByRole('alert')).toContainText('已发布并验证')}
 }
 mark('Task delete confirmation and shared operation log/result drawers for unknown, failed, running and succeeded with raw receipts collapsed');
 await page.goto(base+'/websites/qa-web/monitoring?tab=logs');await page.setViewportSize({width:390,height:844});await expect(page.getByRole('tab',{name:'访问日志',exact:true})).toBeVisible();await fits();await shot('logs-mobile');
 await page.getByRole('button',{name:'日志详情',exact:true}).last().click();await fits();await shot('log-detail-mobile');await page.getByRole('dialog',{name:'日志详情',exact:true}).locator('.ant-drawer-close').click();
 await page.goto(base+'/machines');await expect(page.getByRole('button',{name:'登录终端',exact:true})).toBeVisible();await fits();await shot('hosts-mobile');await page.goto(base+'/connection-credentials');await expect(page.getByText(finalName,{exact:true})).toBeVisible();await fits();await shot('credentials-mobile');
 // A half-sized CSS viewport covers 200% reflow, not native browser zoom.
 await page.setViewportSize({width:683,height:450});await page.goto(base+'/websites/qa-web/monitoring');await expect(page.getByRole('heading',{name:'ABC Demo',exact:true})).toBeVisible();await fits();await shot('overview-200-reflow');
 await page.setViewportSize({width:1366,height:900});await page.evaluate(()=>{localStorage.setItem('lightmoni.appearance','dark')});await page.reload();await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'lightmoni.appearance',newValue:'dark'})));await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await fits();await shot('overview-dark');
 mark('390px website logs/raw details, hosts and credentials; 683px reflow at 200%; dark appearance');
 expect(errors).toEqual([]);
 await writeFile(resolve(out,'ui-round-'+round+'.json'),JSON.stringify({round,passed:true,checks,errors,media},null,2));console.log(JSON.stringify({round,passed:true,checks:checks.length}));
}catch(error){await shot('failure').catch(()=>{});await writeFile(resolve(out,'ui-round-'+round+'.json'),JSON.stringify({round,passed:false,checks,errors,error:String(error),media},null,2));throw error}finally{await browser.close()}
