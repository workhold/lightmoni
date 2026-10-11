import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {createLightMoni} from '../../../../sdk/typescript/dist/src/index.js';

const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5175',apiBase=process.env.LIGHTMONI_ALERT_QA_API??'http://127.0.0.1:18881',run=Date.now().toString(),output=resolve(import.meta.dirname,'../../../../docs/evidence/panel-alerts',run);
await mkdir(output,{recursive:true});
const receipts=[],receiver=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;receipts.push({path:req.url,body:JSON.parse(body)});res.writeHead(202).end();});
await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${receiver.address().port}`;
let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1600,height:1100}}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
let dashboardID,chartGroup,tableGroup;const ruleIDs=[],channelIDs=[];
async function json(path,options){const response=await context.request.fetch(base+'/api/v1'+path,options);if(!response.ok())throw new Error(path+': '+response.status()+' '+await response.text());return response.json();}
async function select(name,label){await page.getByRole('combobox',{name,exact:true}).click();await page.getByTitle(label,{exact:true}).last().click();await page.locator('.lm-workbench-sidebar h3').first().click();await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);}
async function edit(){await page.getByRole('button',{name:'图表告警验收 面板操作',exact:true}).click();await page.getByRole('menuitem',{name:'设置图表告警',exact:true}).click();await expect(page.getByRole('combobox',{name:'告警曲线 1',exact:true})).toBeVisible();}
async function saveDashboard(){await page.getByRole('button',{name:'保存大盘',exact:true}).click();await page.getByRole('button',{name:'确认保存',exact:true}).click();await expect(page.getByRole('dialog',{name:'保存大盘',exact:true})).toBeHidden();}
async function saveAlert(index){await page.getByRole('region',{name:`告警条件 ${index}`,exact:true}).getByRole('button',{name:'保存告警',exact:true}).click();await expect(page.getByRole('region',{name:`告警条件 ${index}`,exact:true}).getByText('已启用',{exact:true})).toBeVisible();}
try{
 await json('/auth/login',{method:'POST',data:{name:'panel-alert-qa',password:'local-panel-alert-qa-password'}});
 const key=await json('/keys',{method:'POST',data:{name:'panel-alert-qa-'+run,allowed_tables:['panel_alert_qa']}});
 const services=['line-a-'+run,'line-b-'+run],emit=async()=>{for(const [index,service] of services.entries()){const mon=createLightMoni({endpoint:apiBase,key:key.key,table:'panel_alert_qa',service,intervalMs:60000});mon.gauge('qa.value').record(index?0.2:0.95);await mon.shutdown({timeoutMs:15000});}};
 await emit();
 for(const path of ['/chart','/table']){const channel=await json('/notify/channels',{method:'POST',data:{name:path+'-'+run,type:'webhook',enabled:true,config:{url:endpoint+path}}});channelIDs.push(channel.id);
  // Separate loopback targets prove that explicit groups override table defaults.
  const saved=await json('/alerts/groups',{method:'POST',data:{name:(path==='/chart'?'图表通知组 ':'数据表默认组 ')+run,enabled:true,targets:[{channel_id:channel.id,recipient:{kind:'channel',value:'bound'}}]}});if(path==='/chart')chartGroup=saved;else tableGroup=saved;
 }
 await json('/catalog/tables/metric_panel_alert_qa_gauge',{method:'PUT',data:{alert_group_id:tableGroup.id}});
 const panel={id:crypto.randomUUID(),title:'图表告警验收',type:'line',grid:{x:0,y:0,w:12,h:7},options:{x:'time',y:'value',series:'series',unit:'percentunit'},queries:[{refId:'A',sql:"SELECT $__timeInterval(event_time) AS time, service AS series, avg(value) AS value FROM metric_panel_alert_qa_gauge WHERE $__timeFilter(event_time) AND name='qa.value' AND service IN {services:Array(String)} GROUP BY time,series ORDER BY time",params:{services:{type:'Array(String)',value:services}}}]};
 const dashboard=await json('/dashboards',{method:'POST',data:{title:'图表告警验收 '+run,description:'',panels:[panel],variables:[],range:{from:'now-20m',to:'now'},refresh:0}});dashboardID=dashboard.id;
 await page.goto(base+'/dashboards/'+dashboardID);await expect(page.locator('.lm-g2-chart canvas')).toBeVisible();await edit();
 await expect(page.getByText('关联告警规则',{exact:true})).toHaveCount(0);await expect(page.getByText('配置新告警',{exact:true})).toHaveCount(0);
 await select('告警曲线 1',services[0]);await page.getByRole('textbox',{name:'告警阈值 1',exact:true}).fill('0.8');await select('图表告警组 1',chartGroup.name);
 await page.getByRole('button',{name:'应用到大盘',exact:true}).click();await expect(page.getByText('请先保存或移除尚未保存的告警条件',{exact:true})).toBeVisible();await saveAlert(1);
 await page.locator('.lm-workbench-sidebar').screenshot({path:resolve(output,'threshold.png')});await page.locator('.lm-workbench-sidebar').evaluate(element=>element.style.zoom='2');await page.locator('.lm-workbench-sidebar').screenshot({path:resolve(output,'threshold-200.png')});await page.locator('.lm-workbench-sidebar').evaluate(element=>element.style.zoom='');
 await page.getByRole('button',{name:'添加告警条件',exact:true}).click();await select('告警曲线 2',services[0]);await select('告警触发条件 2','没有打点');await page.getByRole('spinbutton',{name:'告警回看窗口 2',exact:true}).fill('10');await page.getByRole('region',{name:'告警条件 2',exact:true}).getByText('检查与持续时间',{exact:true}).click();await page.getByRole('spinbutton',{name:'告警检查间隔 2',exact:true}).fill('1');await select('图表告警组 2',chartGroup.name);await saveAlert(2);
 await expect(page.getByRole('textbox',{name:'告警阈值 2',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'添加告警条件',exact:true}).click();await select('告警曲线 3',services[1]);await select('告警触发条件 3','低于');await page.getByRole('textbox',{name:'告警阈值 3',exact:true}).fill('0.3');await select('图表告警组 3',chartGroup.name);await saveAlert(3);
 await saveDashboard();
 const saved=await json('/dashboards/'+dashboardID);ruleIDs.push(...saved.panels[0].options.alert_rule_ids);if(ruleIDs.length!==3)throw new Error('Three chart alerts not persisted');
 const rules=(await json('/alerts/rules')).filter(rule=>ruleIDs.includes(rule.id));for(const rule of rules){if(JSON.stringify(rule.group_ids)!==JSON.stringify([chartGroup.id])||!rule.panel_condition.series)throw new Error('Line or explicit group not persisted');}
 const high=rules.find(rule=>rule.operator==='gt'),missing=rules.find(rule=>rule.operator==='no_data'),low=rules.find(rule=>rule.operator==='lt');
 for(const rule of [high,low]){const preview=await json('/alerts/preview',{method:'POST',data:rule});if(preview.states.length!==1||preview.states[0].status!=='firing'||preview.routes.length!==1||preview.routes[0].group_ids.join()!==chartGroup.id)throw new Error('Threshold or direct route preview failed: '+JSON.stringify(preview));}

 await edit();await page.locator('.monaco-editor .view-lines').click({position:{x:220,y:14}});const modifier=await page.evaluate(()=>/Mac/.test(navigator.platform)?'Meta':'Control'),marker='chart-alert-sync-'+run;await page.keyboard.press(modifier+'+A');await page.keyboard.insertText(panel.queries[0].sql+'\n-- '+marker);await saveDashboard();
 const synced=(await json('/alerts/rules')).filter(rule=>ruleIDs.includes(rule.id));if(synced.length!==3||synced.some(rule=>!rule.sql.includes(marker)))throw new Error('Chart query changes did not update its alerts');
 await page.reload();await edit();await expect(page.getByRole('textbox',{name:'告警阈值 1',exact:true})).toHaveValue('0.8');await expect(page.getByRole('textbox',{name:'告警阈值 2',exact:true})).toHaveCount(0);await expect(page.getByRole('textbox',{name:'告警阈值 3',exact:true})).toHaveValue('0.3');
 await page.getByRole('combobox',{name:'告警触发条件 1',exact:true}).click();await page.getByTitle('高于',{exact:true}).last().click();await page.locator('.lm-workbench-sidebar h3').first().click();
 // An invalid threshold must preserve both the input and the existing saved rule.
 await page.getByRole('textbox',{name:'告警阈值 1',exact:true}).fill('invalid');await page.getByRole('region',{name:'告警条件 1',exact:true}).getByRole('button',{name:'保存告警',exact:true}).click();await expect(page.getByText('threshold must be a finite number',{exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'告警阈值 1',exact:true})).toHaveValue('invalid');await page.getByRole('textbox',{name:'告警阈值 1',exact:true}).fill('0.8');await saveAlert(1);
 // Wait for the real evaluator to detect missing points, then resume SDK data.
 await expect.poll(async()=>{const events=await json('/alerts/events?rule_id='+missing.id);return events.some(event=>event.kind==='firing');},{timeout:75000}).toBe(true);
 await emit();await expect.poll(async()=>{const events=await json('/alerts/events?rule_id='+missing.id);return events.some(event=>event.kind==='resolved');},{timeout:75000}).toBe(true);
 await expect.poll(()=>receipts.some(receipt=>receipt.path==='/chart'),{timeout:20000}).toBe(true);if(receipts.some(receipt=>receipt.path==='/table'))throw new Error('Explicit chart alert sent to table group');
 await page.locator('.lm-workbench-sidebar').screenshot({path:resolve(output,'saved-conditions.png')});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'图表与设置',exact:true}).click();await page.locator('.lm-workbench-settings').getByRole('tab',{name:'告警',exact:true}).click();await expect(page.locator('.lm-workbench-settings').getByRole('combobox',{name:'图表告警组 1',exact:true})).toBeVisible();await page.screenshot({path:resolve(output,'narrow.png'),fullPage:true});
 const report={dashboard_id:dashboardID,rule_ids:ruleIDs,checks:['直接菜单打开图表告警，无关联规则选择器','当前曲线高于/低于/没有打点直接配置','SQL 实查 SDK 数据，最新值和点数正确','直接告警组覆盖数据表默认组，真实发送仅到本地测试接收器','保存/刷新/重新打开保持所有条件','修改图表查询后告警查询同步更新','保存失败保留输入且阻止丢失草稿','实际断点触发与恢复事件','390px 设置抽屉可配置告警组'],page_errors:errors,loopback_receipts:receipts.map(receipt=>({path:receipt.path,kind:receipt.body.event?.kind??receipt.body.kind}))};
 if(errors.length)throw new Error(errors.join('\n'));await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,checks:report.checks,receipts:report.loopback_receipts}));
}catch(error){await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;}finally{
 for(const id of ruleIDs)await json('/alerts/rules/'+id,{method:'DELETE'}).catch(()=>{});
 if(dashboardID)await json('/dashboards/'+dashboardID,{method:'DELETE'}).catch(()=>{});
 await json('/catalog/tables/metric_panel_alert_qa_gauge',{method:'PUT',data:{alert_group_id:''}}).catch(()=>{});
 for(const group of [chartGroup,tableGroup])if(group)await json('/alerts/groups/'+group.id,{method:'DELETE'}).catch(()=>{});
 for(const id of channelIDs)await json('/notify/channels/'+id,{method:'DELETE'}).catch(()=>{});
 await context.close();await browser.close();await new Promise(resolve=>receiver.close(resolve));
}
