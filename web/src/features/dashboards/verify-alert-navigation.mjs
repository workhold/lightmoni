import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5178',run=process.env.LIGHTMONI_QA_RUN??'1';
const output=resolve(import.meta.dirname,'../../../../docs/evidence/agent-alert-workflow');
await mkdir(output,{recursive:true});
let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:run==='1'?{dir:output,size:{width:1440,height:1000}}:undefined}),page=await context.newPage(),errors=[],checks=[];
context.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
let dashboard,channel,group;const ruleIDs=[];
async function json(path,options){const response=await context.request.fetch(base+'/api/v1'+path,options);if(!response.ok())throw new Error(path+': '+response.status()+' '+await response.text());return response.json();}
async function shot(name){await page.screenshot({path:resolve(output,`${name}-${run}.png`),fullPage:true,animations:'disabled'});}
async function ready(){await expect.poll(()=>page.locator('.lm-g2-chart').evaluateAll(nodes=>nodes.length>0&&nodes.every(node=>Number(node.dataset.chartCommits)>0))).toBe(true);}
// Inspect both the submitted marks and the actual canvas scene, leaving drawing unchanged.
await page.route('**/src/features/dashboards/ChartView.tsx*',async route=>{const response=await route.fetch(),source=await response.text();await route.fulfill({response,body:source.replace('queue.submit(finalOptions);','node.__qaOptions=finalOptions; node.__qaChart=chart; queue.submit(finalOptions);')});});
async function drawing(selector='.lm-g2-chart'){
 return page.locator(selector).evaluateAll(nodes=>nodes.map(node=>{
  const spec=node.__qaOptions,marks=(spec.type==='view'?spec.children:[spec]).map(mark=>({type:mark.type,threshold:mark.type==='lineY'?mark.data[0].threshold:undefined,key:mark.scale?.y?.key,domain:mark.scale?.y?.domain}));
  const labels=[],lines=[],thresholdBounds=[];function visit(shape){const a=shape.attributes??{};if(shape.nodeName==='text'){labels.push(String(a.text));if(String(a.text).startsWith('阈值 ')){const bounds=shape.getBounds();thresholdBounds.push({text:String(a.text),min:[...bounds.min],max:[...bounds.max]});}}if(a.stroke==='#ff738a'||a.stroke==='#b42343')lines.push({type:shape.nodeName,lineDash:a.lineDash,x1:a.x1,x2:a.x2,y1:a.y1,y2:a.y2,path:a.path});for(const child of shape.childNodes??[])visit(child);}
  visit(node.__qaChart.getContext().canvas.document.documentElement);return {marks,labels,lines,thresholdBounds};
 }));
}
try{
 const setup=await json('/setup');await json(setup.required?'/setup':'/auth/login',{method:'POST',data:{name:'ingestion-qa',password:'local-ingestion-qa-password'}});
 channel=await json('/notify/channels',{method:'POST',data:{name:`跳转验收渠道 ${run}-${Date.now()}`,type:'webhook',enabled:true,config:{url:'http://127.0.0.1:9'}}});
 group=await json('/alerts/groups',{method:'POST',data:{name:`跳转验收组 ${run}-${Date.now()}`,enabled:true,targets:[{channel_id:channel.id,recipient:{kind:'channel',value:'bound'}}]}});
 const panel={id:crypto.randomUUID(),title:'CPU 与延迟',type:'line',grid:{x:0,y:0,w:12,h:7},options:{x:'time',y:'value',unit:'percentunit',right_axis_refs:['B'],right_unit:'ms'},queries:[{refId:'A',sql:'SELECT event_time AS time, value FROM log_web WHERE $__timeFilter(event_time)'},{refId:'B',sql:'SELECT event_time AS time, value FROM log_web WHERE $__timeFilter(event_time)'}]};
 const category={...panel,id:crypto.randomUUID(),title:'按机房的指标',type:'bar',grid:{x:0,y:7,w:12,h:7},options:{x:'category',y:'value'},queries:[{refId:'A',sql:'SELECT category, value FROM log_web /* categories */'}]};
 const ruleBase={kind:'sql',enabled:true,sql:'SELECT count() AS value FROM log_web WHERE $__timeFilter(event_time)',source_table_ids:['log_web'],services:[],value_field:'value',label_fields:[],operator:'gt',interval_seconds:60,window_seconds:300,for_seconds:0,recovery_seconds:0,repeat_seconds:0,health_for_seconds:60,notify_health:false,severity:'warning',group_ids:[group.id]};
 const savedRules=[];
 for(const [p,ref,threshold,reducer] of [[panel,'A','0.8','last'],[panel,'B','2000','last'],[category,'A','80','avg']]){const rule=await json('/alerts/rules',{method:'POST',data:{...ruleBase,name:`${p.title} · ${ref}`,threshold,panel_condition:{panel_id:p.id,query_ref:ref,reducer}}});savedRules.push(rule);ruleIDs.push(rule.id);}
 // No panel has saved alert_rule_ids: panel ownership must still find all three rules.
 dashboard=await json('/dashboards',{method:'POST',data:{title:`生产告警跳转 ${run}`,panels:[panel,category],variables:[],range:{from:'now-15m',to:'now'},refresh:0}});
 await page.route('**/api/v1/query',route=>{
  const request=route.request().postDataJSON();return route.fulfill({json:{request_id:request.request_id,results:request.queries.map(query=>({refId:query.refId,status:'success',complete:true,truncated:false,frames:[query.sql.includes('categories')?{columns:[{name:'category',type:'String'},{name:'value',type:'Float64'}],rows:[['上海',55],['北京',95],['广州',70]]}:{columns:[{name:'time',type:'DateTime64(3)'},{name:'value',type:'Float64'}],rows:(query.refId==='B'?[800,1400,2500,1800,1000]:[0.4,0.5,0.95,0.8,0.6]).map((value,index)=>[new Date(Date.now()-(6-index)*60000).toISOString(),value])}]}))}});
 });
 await page.goto(base+'/dashboards/'+dashboard.id);await ready();let plots=await drawing();
 expect(plots[0].marks.filter(mark=>mark.type==='lineY').map(mark=>[mark.threshold,mark.key])).toEqual([[0.8,'lightmoni-left-y'],[2000,'lightmoni-right-y']]);
 expect(plots[0].labels).toContain('阈值 80.00%');expect(plots[0].labels).toContain('阈值 2.00 s');expect(plots[0].lines.length).toBeGreaterThanOrEqual(2);
 expect(plots[1].marks.some(mark=>mark.type==='lineY'&&mark.threshold===80)).toBe(true);expect(plots[1].labels).toContain('阈值 80.00');
 checks.push('未保存大盘绑定时按面板加载阈值；实际画布含左右轴单位标签及虚线；类别柱图显示阈值');await shot('thresholds');
 await page.goto(base+'/alerts');const ruleRow=page.getByRole('row').filter({hasText:savedRules[0].name});
 await expect(ruleRow.getByRole('link',{name:`${dashboard.title} / ${panel.title}`,exact:true})).toBeVisible();await shot('alert-list');
 await ruleRow.getByRole('link').click();await expect(page.locator('.lm-workbench-sidebar').getByRole('tab',{name:'告警',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(page.getByRole('textbox',{name:'面板名称',exact:true})).toHaveValue(panel.title);await expect(page.getByRole('textbox',{name:'告警阈值 1',exact:true})).toHaveValue('0.8');
 await page.getByRole('checkbox',{name:'显示告警水位线',exact:true}).uncheck();await expect.poll(async()=>(await drawing('.lm-panel-preview .lm-g2-chart'))[0].marks.filter(mark=>mark.type==='lineY').length).toBe(0);
 await page.getByRole('checkbox',{name:'显示告警水位线',exact:true}).check();await expect.poll(async()=>(await drawing('.lm-panel-preview .lm-g2-chart'))[0].marks.filter(mark=>mark.type==='lineY').length).toBe(2);
 let reject=true;await page.route(`**/api/v1/alerts/rules/${savedRules[0].id}`,async route=>{if(route.request().method()==='PUT'&&reject){reject=false;await route.fulfill({status:503,json:{error:'验收保存失败'}});}else await route.continue();});
 await page.getByRole('textbox',{name:'告警阈值 1',exact:true}).fill('0.85');await page.locator('.lm-workbench-sidebar .lm-panel-alert-rule').first().getByRole('button',{name:/保存告警/}).click();
 await expect(page.getByText('验收保存失败',{exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'告警阈值 1',exact:true})).toHaveValue('0.85');
 expect((await json('/alerts/rules')).find(rule=>rule.id===savedRules[0].id).threshold).toBe('0.8');
 await page.locator('.lm-workbench-sidebar .lm-panel-alert-rule').first().getByRole('button',{name:/保存告警/}).click();await expect(page.locator('.lm-workbench-sidebar .lm-panel-alert-rule').first().getByText('已启用',{exact:true})).toBeVisible();
 await expect.poll(async()=>(await drawing('.lm-panel-preview .lm-g2-chart'))[0].labels.includes('阈值 85.00%')).toBe(true);
 const bounds=(await drawing('.lm-panel-preview .lm-g2-chart'))[0].thresholdBounds.sort((a,b)=>a.min[1]-b.min[1]);expect(bounds[0].max[1]).toBeLessThanOrEqual(bounds[1].min[1]);
 checks.push('规则列表直接打开正确面板的告警 Tab；失败保留输入与原规则；重试成功后预览阈值立即更新');await shot('alert-settings');
 if(run==='3'){await page.locator('.lm-panel-preview').evaluate(node=>node.style.zoom='2');await page.locator('.lm-panel-preview').screenshot({path:resolve(output,'threshold-200.png')});await page.locator('.lm-panel-preview').evaluate(node=>node.style.zoom='');}
 await page.getByRole('button',{name:'放弃修改',exact:true}).click();
 await expect.poll(async()=>(await drawing())[0]?.labels.includes('阈值 85.00%')).toBe(true);
 await page.getByRole('button',{name:`${panel.title} 面板操作`,exact:true}).click();await page.getByRole('menuitem',{name:'设置图表告警',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'告警阈值 1',exact:true})).toHaveValue('0.85');
 checks.push('保存告警后返回大盘立即刷新阈值，无需先保存大盘绑定');
 await page.getByRole('button',{name:'保存大盘',exact:true}).click();await page.getByRole('dialog',{name:'保存大盘',exact:true}).getByRole('button',{name:'确认保存',exact:true}).click();await expect(page.getByRole('dialog',{name:'保存大盘',exact:true})).toBeHidden();
 await page.reload();await expect(page.getByRole('textbox',{name:'告警阈值 1',exact:true})).toHaveValue('0.85');
 await page.getByRole('button',{name:'放弃修改',exact:true}).click();await ready();plots=await drawing();expect(plots[0].marks.some(mark=>mark.type==='lineY'&&mark.threshold===0.85)).toBe(true);
 checks.push('保存大盘并刷新，URL 重新打开相同告警设置，配置与阈值线保持');
 const state={rule_id:savedRules[0].id,fingerprint:'qa',labels:{service:'api'},status:'firing',health:'ok',value:'0.95'};
 // Event UI uses a controlled fixture; no external notification is sent by this QA server.
 await page.route('**/api/v1/alerts/events*',route=>route.fulfill({json:[{id:'qa-event',rule_id:savedRules[0].id,rule_name:savedRules[0].name,kind:'firing',created_at:new Date().toISOString(),message:'CPU 超过阈值',state,source_table_ids:['log_web'],group_ids:[group.id]}]}));
 await page.goto(base+'/alerts');await page.getByRole('tab',{name:'事件与发送记录',exact:true}).click();const eventRow=page.getByRole('row').filter({hasText:savedRules[0].name});
 await expect(eventRow.getByRole('link')).toBeVisible();await eventRow.getByRole('button',{name:/查\s*看/}).click();await expect(page.getByRole('dialog',{name:'告警事件详情',exact:true}).getByRole('link')).toBeVisible();await page.getByRole('dialog',{name:'告警事件详情',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await eventRow.getByRole('link').click();
 const settings=page.locator('.lm-workbench-settings');await expect(settings.getByRole('tab',{name:'告警',exact:true})).toHaveAttribute('aria-selected','true');await expect(settings.getByRole('textbox',{name:'告警阈值 1',exact:true})).toHaveValue('0.85');
 await expect.poll(()=>settings.locator('.ant-drawer-content-wrapper').evaluate(node=>{const box=node.getBoundingClientRect();return box.width>200&&box.height>300&&box.left>=0&&box.right<=innerWidth+1;})).toBe(true);
 await settings.getByRole('textbox',{name:'告警阈值 1',exact:true}).fill('0.85');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await settings.locator('.ant-drawer-body').screenshot({path:resolve(output,`narrow-settings-body-${run}.png`)});await shot('narrow-settings');checks.push('事件列表与详情提供对应设置链接；390px 跳转自动打开告警设置抽屉且无页面横向溢出');
 expect(errors).toEqual([]);await writeFile(resolve(output,`verification-${run}.json`),JSON.stringify({run,passed:true,checks,page_errors:errors,plots,fixtures:'隔离 SQLite 真实保存；查询结果及事件列表使用受控数据；未发送通知'},null,2));console.log(JSON.stringify({run,passed:true,checks}));
}catch(error){await shot('failure').catch(()=>{});await writeFile(resolve(output,`verification-${run}.json`),JSON.stringify({run,passed:false,checks,page_errors:errors,error:String(error)},null,2));console.error(error);process.exitCode=1;}
finally{
 if(dashboard)await json('/dashboards/'+dashboard.id,{method:'DELETE'}).catch(()=>{});
 for(const id of ruleIDs)await json('/alerts/rules/'+id,{method:'DELETE'}).catch(()=>{});
 if(group)await json('/alerts/groups/'+group.id,{method:'DELETE'}).catch(()=>{});if(channel)await json('/notify/channels/'+channel.id,{method:'DELETE'}).catch(()=>{});
 const video=page.video();await context.close();if(video&&run==='1'){await video.saveAs(resolve(output,'interaction-1.webm'));await video.delete();}await browser.close();
}
