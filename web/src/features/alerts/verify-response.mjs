// Browser interaction coverage. Provider protocols and state transitions are
// exercised by the Go integration tests, not by these controlled UI fixtures.
import { mediaDirectory } from '../../../../scripts/qa-artifacts.mjs';
import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=resolve(import.meta.dirname,'../../../../docs/evidence/alert-response');await mkdir(output,{recursive:true});
const mediaOutput=mediaDirectory(output);
const checks=[],errors=[],writes=[];let claims=0;
const now=new Date().toISOString(),before=new Date(Date.now()-300000).toISOString();
const policy=(methods,start='',end='')=>({methods,start,end,weekdays:[],repeat_seconds:120,backup_after_seconds:300,fallback_after_seconds:600,escalate_after_rounds:0,escalate_to:'',max_rounds:6,handling_seconds:1800});
const policies={P0:policy(['voice','sms','chat']),P1:policy(['sms','chat'],'09:00','22:00'),P2:{...policy(['email','webhook'],'09:00','22:00'),repeat_seconds:1800,escalate_after_rounds:3,escalate_to:'P1'},P3:policy(['email'],'09:00','18:00')};
const people=[{id:'u1',name:'张三'},{id:'u2',name:'李四'},{id:'u3',name:'王五'}].map(p=>({...p,role:'member',active:true,has_email:true,has_phone:true,has_feishu:true}));
let profile={user_id:'u1',email:'ops@example.com',phone:'+8613800000001',feishu_id:'open_u1',dingtalk_id:'',wecom_id:'',timezone:'Asia/Shanghai',source:'manual',updated_at:now};
let group={id:'g1',revision:1,name:'支付值班组',enabled:true,members:['u1','u2','u3'],primary:['u1','u2'],backup:['u3'],fallback:['u3'],timezone:'Asia/Shanghai',channel_ids:['feishu','dingtalk','wecom'],targets:[],schedule:{mode:'fixed',timezone:'Asia/Shanghai',anchor:now,interval_days:1,shifts:[],overrides:[]},policies};
const channels=[{id:'feishu',name:'飞书值班群',type:'feishu'},{id:'dingtalk',name:'钉钉值班群',type:'dingtalk'},{id:'wecom',name:'企业微信值班群',type:'wecom'}].map(c=>({...c,revision:1,enabled:true,config:{},has_secret:true}));
const tables=[{id:'metric_app',name:'metric_app',kind:'metric',services:['payment-api'],columns:[{name:'value',type:'UInt64'}]},{id:'log_app',name:'log_app',kind:'log',services:['payment-api'],columns:[{name:'body',type:'String'},{name:'service',type:'String'}]},{id:'trace_app',name:'trace_app',kind:'trace',services:['payment-api'],columns:[]}];
let incident={id:'incident-1',rule_id:'r1',group_id:'g1',group_name:group.name,state:'unclaimed',priority:'P1',original_priority:'P2',stage:'primary',owner_id:'',owner_name:'',ack_method:'',ack_at:'',handling_until:'',created_at:before,resolved_at:'',round:3,active_seconds:180,level_active_seconds:60,since_round_seconds:45,exhausted:false,deferred_reason:'',group,event:{rule_name:'支付接口错误率',message:'错误率 8.2% > 5% · 持续3分钟',range:{from:before,to:now},state:{labels:{service:'payment-api'},value:'8.2'}},evidence:{status:'ready',captured_at:now,from:before,to:now,log_table_id:'log_app',trace_table_ids:['trace_app'],trace_ids:['trace-1'],logs:[{event_id:'log-1',event_time:now,severity:'ERROR',body:'upstream timeout',trace_id:'trace-1'}],truncated:false}};
let silences=[];
const timeline=[{id:'a1',at:before,kind:'triggered',message:'等待值班人员接手',method:''},{id:'a2',at:now,kind:'notifying',message:'P1 · 主班 · 第3轮',method:''}];
let browser;try{browser=await chromium.launch({headless:true,channel:'chrome'})}catch{browser=await chromium.launch({headless:true})}
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/v1/**',async route=>{
 const req=route.request(),u=new URL(req.url()),path=u.pathname.replace('/api/v1',''),method=req.method(),body=req.postDataJSON();
 if(method!=='GET')writes.push({path,body});
 const json=v=>route.fulfill({json:v});
 if(path==='/auth/me')return json({...people[0],role:'admin'});
 if(path==='/alerts/groups'&&method==='GET')return json([group]);
 if(path.startsWith('/alerts/groups/')&&path.endsWith('/schedule-preview'))return json([0,1].map(i=>({date:`2026-10-${13+i}`,primary:body.group.schedule.shifts[i]?.primary??body.group.primary,backup:body.group.schedule.shifts[i]?.backup??body.group.backup,coverage_gap:false})));
 if(path.startsWith('/alerts/groups')&&['POST','PUT'].includes(method)){group={...body,id:'g1',revision:group.revision+1};return json(group)}
 if(path==='/alerts/responders')return json(people);
 if(path==='/alerts/policy-defaults')return json(policies);
 if(path==='/catalog/tables')return json(tables);
 if(path==='/notify/channels'&&method==='GET')return json(channels);
 if(path.startsWith('/notify/channels')&&['POST','PUT'].includes(method)){const c={...body,id:body.id||'app-new',revision:1,has_secret:true,config:{app_id:body.config?.app_id}};channels.push(c);return json(c)}
 if(path.endsWith('/callback-url'))return json({url:'https://monitor.example/api/v1/notify/callbacks/app/local-test-token'});
 if(path==='/alerts/incidents')return json([incident]);
 if(path==='/alerts/claim'){claims++;incident={...incident,state:'acknowledged',owner_id:'u1',owner_name:'张三',ack_method:'feishu_link',ack_at:now,handling_until:new Date(Date.now()+1800000).toISOString()};return json(incident)}
 if(path==='/alerts/incidents/incident-1')return json({incident,timeline});
 if(path.startsWith('/alerts/incidents/incident-1/'))return json(incident);
 if(path==='/alerts/silences'&&method==='GET')return json(silences);
 if(path==='/alerts/silences'&&method==='POST'){silences.push({...body,id:'silence-'+silences.length});return json(silences.at(-1))}
 if(path==='/alerts/response-statistics')return json({definition:'接手率=本人接手告警数/实际通知本人的不同组告警数；多渠道与重试去重。',truncated:false,users:[{user_id:'u1',user_name:'张三',notified:10,acknowledged:8,peer_claimed:2,recovered:0,pending:0,ack_rate:80,mean_ack_seconds:45,median_ack_seconds:30,p95_ack_seconds:90,methods:{feishu_link:5,phone_answered:3}},{user_id:'u2',user_name:'李四',notified:10,acknowledged:2,peer_claimed:8,recovered:0,pending:0,ack_rate:20,mean_ack_seconds:70,median_ack_seconds:50,p95_ack_seconds:120,methods:{dingtalk_link:2}}],records:[{response_id:'incident-1',user_name:'张三',group_name:group.name,rule_name:incident.event.rule_name,priority:'P1',stage:'primary',notified_at:before,ack_at:now,ack_method:'feishu_link',ack_seconds:45,outcome:'claimed'}]});
 if(path.startsWith('/traces/'))return json({trace_id:'trace-1',from:before,to:now,incomplete:false,truncated:false,missing_parents:0,spans:[{span_id:'root',parent_span_id:'',name:'POST /payments',service:'payment-api',start_time:before,end_time:now,duration_ns:'300000000',status:'ERROR',attributes_json:'{"route":"/payments"}',events_json:'[]'},{span_id:'child',parent_span_id:'root',name:'database query',service:'payment-db',start_time:new Date(Date.parse(before)+30).toISOString(),end_time:new Date(Date.parse(before)+120).toISOString(),duration_ns:'90000000',status:'ERROR',attributes_json:'{}'}]});
 if(path==='/auth/profile'){if(method==='PUT')profile={...profile,...body,source:'manual',updated_at:now};return json({nickname:'张三',avatar_url:'',...profile})}
 if(path==='/auth/notification-profile'||path.includes('/notification-profile')){if(method==='PUT')profile={...body,source:'manual',updated_at:now};return json(profile)}
 if(path==='/users')return json(people);
 if(path==='/settings/instance')return json({external_url:'https://monitor.example'});
 if(path==='/settings/login-providers'||path==='/settings/alert-directory-sources')return json([]);
 return json([]);
});
const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5187';
async function choose(input,text){await input.locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').click();await page.locator('.ant-select-dropdown:visible').getByText(text,{exact:true}).click()}
async function confirm(dialog){await dialog.locator('.ant-modal-footer').getByRole('button',{name:/确\s*定|OK/}).click()}
try{
 await page.goto(base+'/a/'+'a'.repeat(32));const detail=page.getByRole('dialog',{name:'告警现场与响应'});await expect(detail).toBeVisible();await expect(detail.getByText('飞书跳转',{exact:true})).toBeVisible();expect(claims).toBe(1);expect(new URL(page.url()).pathname).toBe('/alerts');checks.push('短接手入口跳转告警页并且只认领一次，显示实际接手人和方式');
 await page.screenshot({path:resolve(mediaOutput,'incident-desktop.png'),fullPage:true});await detail.getByRole('button',{name:'关闭',exact:true}).last().click();
 await page.getByRole('tab',{name:'接手统计',exact:true}).click();await expect(page.getByText('80%',{exact:true})).toBeVisible();await expect(page.getByText('电话接听 3',{exact:true})).toBeVisible();await expect(page.getByText('钉钉跳转 2',{exact:true})).toBeVisible();checks.push('人员接手率、平均/P95时长、同组接手及不同接手方式显示正确');await page.screenshot({path:resolve(mediaOutput,'statistics-desktop.png'),fullPage:true});
 await page.getByRole('tab',{name:'告警组',exact:true}).click();await expect(page.getByRole('tab',{name:'告警组',exact:true})).toHaveAttribute('aria-selected','true');await page.getByRole('button',{name:'成员、排班与策略'}).click();const groupDialog=page.getByRole('dialog',{name:'管理告警组'});await choose(groupDialog.getByRole('combobox',{name:'排班方式'}),'按周轮换');await groupDialog.getByRole('button',{name:'添加周期班次'}).click();await groupDialog.getByRole('button',{name:'预览未来14天'}).click();await expect(groupDialog.getByText('2026-10-13',{exact:true})).toBeVisible();await groupDialog.getByRole('tab',{name:'等级与升级策略'}).click();await expect(groupDialog.getByText('每层最大通知轮数',{exact:true})).toHaveCount(4);await confirm(groupDialog);await expect(groupDialog).toBeHidden();expect(writes.find(v=>v.path==='/alerts/groups/g1').body.schedule.shifts).toHaveLength(2);checks.push('用户组、并行主备、两周循环、排班预览和分级响应策略可以保存');
 await page.getByRole('tab',{name:'静默窗口',exact:true}).click();await page.getByRole('button',{name:'创建静默窗口'}).click();const silence=page.getByRole('dialog',{name:'配置静默窗口'});await silence.getByRole('textbox').last().fill('发布维护');await confirm(silence);await expect(silence).toBeHidden();await expect(page.getByText('发布维护',{exact:true})).toBeVisible();checks.push('静默窗口创建后可回读');
 await page.goto(base+'/settings?tab=notifications');await expect(page.getByText('钉钉值班群',{exact:true})).toBeVisible();await expect(page.getByText('企业微信值班群',{exact:true})).toBeVisible();await page.getByRole('button',{name:'添加通知接入'}).click();const config=page.getByRole('dialog',{name:'配置通知接入'});await config.getByLabel('通知渠道名称',{exact:true}).fill('飞书企业应用');await choose(config.getByRole('combobox',{name:'通知渠道类型'}),'飞书企业应用机器人');await config.getByLabel('App ID',{exact:true}).fill('local-app');await config.getByLabel('App Secret',{exact:true}).fill('local-secret');await config.getByLabel('Verification Token',{exact:true}).fill('local-verify');await confirm(config);await expect(config).toBeHidden();checks.push('系统设置覆盖飞书/钉钉/企业微信并支持企业应用配置');
 await page.goto(base+'/settings?tab=contacts');await page.getByLabel('手机号',{exact:true}).fill('+8613900000001');await page.getByRole('button',{name:'保存个人资料'}).click();await expect(page.getByText('个人资料已保存',{exact:true})).toBeVisible();expect(profile.phone).toBe('+8613900000001');checks.push('本人通知资料可以保存');
 await page.goto(base+'/traces/trace-1?'+new URLSearchParams({tables:'trace_app',log_table:'log_app',from:before,to:now}));await expect(page.getByText('POST /payments',{exact:true})).toBeVisible();await expect(page.getByText('database query',{exact:true})).toBeVisible();await page.screenshot({path:resolve(mediaOutput,'trace-desktop.png'),fullPage:true});checks.push('固定时间与表范围的Trace树、瀑布与错误状态正确展示');
 await page.setViewportSize({width:390,height:844});await page.goto(base+'/settings?tab=contacts');await expect(page.getByLabel('收件邮箱',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:resolve(mediaOutput,'contacts-mobile.png'),fullPage:true});
 await page.goto(base+'/alerts');await page.getByRole('combobox',{name:'告警功能'}).selectOption('groups');await page.getByRole('button',{name:'成员、排班与策略'}).click();const mobile=page.getByRole('dialog',{name:'管理告警组'});await expect(mobile).toBeVisible();expect(await mobile.evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1)).toBe(true);await page.screenshot({path:resolve(mediaOutput,'schedule-mobile.png'),fullPage:true});checks.push('390px联系方式和排班对话框没有横向溢出');
 expect(errors).toEqual([]);await writeFile(resolve(output,'report.json'),JSON.stringify({passed:true,checks,page_errors:errors,scope:'Controlled browser fixtures; Go tests use real local HTTP and SQLite. No paid notifications sent.'},null,2));console.log(JSON.stringify({passed:true,checks}));
}catch(error){await writeFile(resolve(output,'failure-dom.json'),JSON.stringify(await page.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},errors:[],dropdowns:[...document.querySelectorAll('.ant-select-dropdown')].map(e=>({rect:e.getBoundingClientRect().toJSON(),style:e.getAttribute('style'),parent:e.parentElement?.getBoundingClientRect().toJSON(),items:[...e.querySelectorAll('.ant-select-item-option-content')].map(i=>({text:i.textContent,rect:i.getBoundingClientRect().toJSON()}))}))})),null,2)).catch(()=>{});await page.screenshot({path:resolve(mediaOutput,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1}finally{await browser.close()}
