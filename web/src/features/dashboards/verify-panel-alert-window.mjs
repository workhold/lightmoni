import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {createLightMoni} from '../../../../sdk/typescript/dist/src/index.js';

const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5176',apiBase=process.env.LIGHTMONI_ALERT_QA_API??'http://127.0.0.1:18883';
const run=Date.now().toString(),output=resolve(import.meta.dirname,'../../../../docs/evidence/panel-alert-window',run);
await mkdir(output,{recursive:true});
const receiver=createServer((req,res)=>{req.resume();res.writeHead(202).end();});
await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1600,height:1100}}),page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
let dashboard,channel,group;const ruleIDs=[];
async function json(path,options){const response=await context.request.fetch(base+'/api/v1'+path,options);if(!response.ok())throw new Error(path+': '+response.status()+' '+await response.text());return response.json();}
async function select(name,label){await page.getByRole('combobox',{name,exact:true}).click();await page.getByTitle(label,{exact:true}).last().click();await page.locator('.lm-workbench-sidebar h3').first().click();await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);}
async function edit(){await page.getByRole('button',{name:'窗口延迟验收 面板操作',exact:true}).click();await page.getByRole('menuitem',{name:'设置图表告警',exact:true}).click();await expect(page.getByRole('combobox',{name:'告警曲线 1',exact:true})).toBeVisible();}
async function saveAlert(){await page.locator('.lm-panel-alert-rule').first().getByRole('button',{name:/保存告警/}).click();await expect(page.locator('.lm-panel-alert-rule').first().getByText('已启用',{exact:true})).toBeVisible();}
async function savedRule(){const rules=await json('/alerts/rules');const rule=rules.find(rule=>ruleIDs.includes(rule.id));if(!rule)throw new Error('Saved rule missing');return rule;}
async function preview(rule){const p=await json('/alerts/preview',{method:'POST',data:rule});if(p.states.some(s=>s.health==='error'))throw new Error(JSON.stringify(p.states));return p;}
try{
 const setup=await json('/setup');await json(setup.required?'/setup':'/auth/login',{method:'POST',data:{name:'window-qa',password:'local-alert-window-qa-password'}});
 const key=await json('/keys',{method:'POST',data:{name:'window-qa-'+run,allowed_tables:['panel_alert_window_qa']}});
 const mon=createLightMoni({endpoint:apiBase,key:key.key,table:'panel_alert_window_qa',service:'window-qa-'+run,intervalMs:60000});
 mon.gauge('qa.seed').record(1);await mon.shutdown({timeoutMs:15000});
 channel=await json('/notify/channels',{method:'POST',data:{name:'窗口本地接收器 '+run,type:'webhook',enabled:true,config:{url:`http://127.0.0.1:${receiver.address().port}`}}});
 group=await json('/alerts/groups',{method:'POST',data:{name:'窗口验收通知组 '+run,enabled:true,targets:[{channel_id:channel.id,recipient:{kind:'channel',value:'bound'}}]}});
 // One real SDK row supplies the source table. Controlled timestamps exercise
 // inclusion/exclusion without waiting twelve minutes for historical points.
 const sql=`SELECT point.1 AS time, point.2 AS series, point.3 AS value
FROM (SELECT arrayJoin([
 (now64(9)-INTERVAL 15 MINUTE, 'delayed', toFloat64(-999)),
 (now64(9)-INTERVAL 4 MINUTE, 'delayed', toFloat64(5)),
 (now64(9)-INTERVAL 3 MINUTE, 'delayed', toFloat64(20)),
 (now64(9)-INTERVAL 1 MINUTE, 'delayed', toFloat64(999)),
 (now64(9)-INTERVAL 1 MINUTE, 'absent', toFloat64(999))
]) AS point FROM (SELECT 1 FROM metric_panel_alert_window_qa_gauge WHERE service={qa_service:String} LIMIT 1))
WHERE $__timeFilter(time)
ORDER BY time`;
 const panel={id:crypto.randomUUID(),title:'窗口延迟验收',type:'line',grid:{x:0,y:0,w:12,h:7},options:{x:'time',y:'value',series:'series'},queries:[{refId:'A',sql,params:{qa_service:{type:'String',value:'window-qa-'+run}}}]};
 dashboard=await json('/dashboards',{method:'POST',data:{title:'窗口延迟验收 '+run,description:'',panels:[panel],variables:[],range:{from:'now-20m',to:'now'},refresh:0}});
 await page.goto(base+'/dashboards/'+dashboard.id);await expect(page.locator('.lm-g2-chart canvas')).toBeVisible();await edit();
 await select('告警曲线 1','delayed');await page.getByRole('textbox',{name:'告警阈值 1',exact:true}).fill('10');
 await page.getByRole('spinbutton',{name:'告警回看窗口 1',exact:true}).fill('600');await page.getByRole('spinbutton',{name:'告警窗口结束延迟 1',exact:true}).fill('120');
 await expect(page.getByLabel('告警查询区间 1',{exact:true})).toHaveText('查询区间：now-12min ~ now-2min');
 await select('图表告警组 1',group.name);await saveAlert();
 const rules=(await json('/alerts/rules')).filter(rule=>rule.panel_condition?.panel_id===panel.id);ruleIDs.push(...rules.map(rule=>rule.id));
 let rule=await savedRule(),p=await preview(rule);
 if(rule.window_seconds!==600||rule.delay_seconds!==120||p.states[0].value!=='20'||p.states[0].status!=='firing')throw new Error('Delayed latest value failed: '+JSON.stringify(p));
 const duration=(Date.parse(p.range.to)-Date.parse(p.range.from))/1000,endDelay=(Date.now()-Date.parse(p.range.to))/1000;
 if(duration!==600||endDelay<119||endDelay>125)throw new Error('Wrong actual range: '+JSON.stringify(p.range));
 for(const [label,reducer,value] of [['窗口平均值','avg','12.5'],['窗口最大值','max','20'],['窗口最小值','min','5'],['窗口总和','sum','25'],['有效点数','count','2']]){
  await select('告警取值方式 1',label);await saveAlert();rule=await savedRule();p=await preview(rule);
  if(rule.panel_condition.reducer!==reducer||p.states[0].value!==value)throw new Error(reducer+' failed: '+JSON.stringify(p));
 }
 await select('告警取值方式 1','最新点');await select('告警曲线 1','absent');
 for(const [label,policy,value,status,health] of [['跳过计算（保留已触发告警）','keep_state','','normal','no_data'],['按 0 计算','zero','0','normal','ok'],['按指定值计算','value','18446744073709551615','firing','ok'],['视为告警','alerting','','firing','ok'],['视为正常','normal','','normal','ok']]){
  await select('告警无数据处理 1',label);
  if(policy==='value')await page.getByRole('textbox',{name:'告警无数据替代值 1',exact:true}).fill(value);
  await saveAlert();rule=await savedRule();p=await preview(rule);
  if(rule.no_data_policy!==policy||p.states[0].value!==value||p.states[0].status!==status||p.states[0].health!==health)throw new Error(policy+' failed: '+JSON.stringify(p));
 }
 await select('告警无数据处理 1','按指定值计算');await page.getByRole('textbox',{name:'告警无数据替代值 1',exact:true}).fill('invalid');
 await page.locator('.lm-panel-alert-rule').first().getByRole('button',{name:/保存告警/}).click();
 await expect(page.getByText('无数据替代值必须为有限数值',{exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'告警无数据替代值 1',exact:true})).toHaveValue('invalid');
 if((await savedRule()).no_data_policy!=='normal')throw new Error('Failed save replaced rule');
 await page.getByRole('textbox',{name:'告警无数据替代值 1',exact:true}).fill('18446744073709551615');await saveAlert();
 await page.getByRole('button',{name:'保存大盘',exact:true}).click();await page.getByRole('button',{name:'确认保存',exact:true}).click();await expect(page.getByRole('dialog',{name:'保存大盘',exact:true})).toBeHidden();
 await page.reload();await edit();
 await expect(page.getByRole('spinbutton',{name:'告警回看窗口 1',exact:true})).toHaveValue('600');await expect(page.getByRole('spinbutton',{name:'告警窗口结束延迟 1',exact:true})).toHaveValue('120');await expect(page.getByRole('textbox',{name:'告警无数据替代值 1',exact:true})).toHaveValue('18446744073709551615');
 await expect(page.getByRole('combobox',{name:'告警无数据处理 1',exact:true}).locator('..')).toContainText('按指定值计算');
 await page.locator('.lm-workbench-sidebar').screenshot({path:resolve(output,'desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'图表与设置',exact:true}).click();await page.locator('.lm-workbench-settings').getByRole('tab',{name:'告警',exact:true}).click();
 await expect(page.getByRole('spinbutton',{name:'告警窗口结束延迟 1',exact:true})).toBeVisible();await page.locator('.lm-workbench-settings').screenshot({path:resolve(output,'narrow.png')});
 if(errors.length)throw new Error(errors.join('\n'));
 const report={checks:['实际查询窗口为 now-12min ~ now-2min','延迟窗口排除过新和过旧的点','六种取值方式通过真实 ClickHouse 计算','五种无数据策略预览与保存一致','UInt64 替代值无精度损失','失败保存保留输入和原规则','刷新读回窗口、延迟和无数据配置','390px 设置可操作'],range:p.range,page_errors:errors};
 await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report}));
}catch(error){await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;}finally{
 for(const id of ruleIDs)await json('/alerts/rules/'+id,{method:'DELETE'}).catch(()=>{});
 if(dashboard)await json('/dashboards/'+dashboard.id,{method:'DELETE'}).catch(()=>{});
 if(group)await json('/alerts/groups/'+group.id,{method:'DELETE'}).catch(()=>{});
 if(channel)await json('/notify/channels/'+channel.id,{method:'DELETE'}).catch(()=>{});
 await context.close();await browser.close();await new Promise(resolve=>receiver.close(resolve));
}
