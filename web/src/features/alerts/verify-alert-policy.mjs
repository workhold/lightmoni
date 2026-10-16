// Controlled UI fixtures; Go tests verify evaluation, persistence and sending.
import { mediaDirectory } from '../../../../scripts/qa-artifacts.mjs';
import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const output=resolve(import.meta.dirname,'../../../../docs/evidence/alert-policy');
await mkdir(output,{recursive:true});
const mediaOutput=mediaDirectory(output);
const baseline=process.env.LIGHTMONI_POLICY_BASELINE==='1',errors=[],checks=[];
const policy=(methods,start='',end='')=>({methods,start,end,weekdays:[],repeat_seconds:300,backup_after_seconds:600,fallback_after_seconds:1200,escalate_after_rounds:0,escalate_to:'',max_rounds:6,handling_seconds:3600});
const policies={P0:policy(['voice','sms']),P1:{...policy(['voice','sms'],'09:00','22:00'),night_mode:'after_count',night_after_count:3,night_methods:['voice']},P2:policy(['sms'],'09:00','22:00'),P3:policy(['email'],'09:00','18:00')};
const legacy=structuredClone(policies);delete legacy.P1.night_mode;delete legacy.P1.night_after_count;delete legacy.P1.night_methods;
let group={id:'g1',revision:1,name:'支付值班组',enabled:true,members:['u1'],primary:['u1'],backup:[],fallback:[],timezone:'Asia/Shanghai',channel_ids:['voice','sms'],schedule:{mode:'fixed',timezone:'Asia/Shanghai',anchor:new Date().toISOString(),interval_days:1,shifts:[],overrides:[]},policies:legacy};
let rule={id:'r1',name:'支付错误率',kind:'sql',enabled:true,revision:1,sql:'SELECT value FROM metric_app',source_table_ids:['metric_app'],services:[],value_field:'value',label_fields:[],operator:'gt',threshold:'5',interval_seconds:60,window_seconds:300,delay_seconds:0,for_seconds:0,recovery_seconds:0,repeat_seconds:0,health_for_seconds:60,notify_health:false,severity:'P1'};
let rejectSave=false;
const people=[{id:'u1',name:'张三',role:'admin',active:true,has_phone:true}],channels=[{id:'voice',type:'aliyun_voice',name:'电话接入',enabled:true},{id:'sms',type:'aliyun_sms',name:'短信接入',enabled:true}];
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/v1/**',async route=>{
 const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method();
 const json=value=>route.fulfill({json:value});
 if(path==='/auth/me')return json(people[0]);
 if(path==='/alerts/responders')return json(people);
 if(path==='/alerts/policy-defaults')return json(policies);
 if(path==='/notify/channels')return json(channels);
 if(path==='/catalog/tables')return json([{id:'metric_app',name:'metric_app',kind:'metric',services:[],columns:[{name:'value',type:'Float64'}]}]);
 if(path==='/alerts/groups')return json([group]);
 if(path==='/alerts/groups/g1'&&method==='PUT'){
  if(rejectSave){rejectSave=false;return route.fulfill({status:409,json:{error:'配置已变更，请刷新后重试'}})}
  group={...request.postDataJSON(),revision:group.revision+1};return json(group);
 }
 if(path==='/alerts/rules')return json([rule]);
 if(path==='/alerts/rules/r1'&&method==='PUT'){rule={...request.postDataJSON(),revision:rule.revision+1};return json(rule)}
 return json([]);
});
const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5173';
async function openPolicies(){
 await page.getByRole('tab',{name:'告警组',exact:true}).click();
 await page.getByRole('button',{name:'成员、排班与策略'}).click();
 const dialog=page.getByRole('dialog',{name:'管理告警组'});
 await dialog.getByRole('tab',{name:'等级与升级策略'}).click();
 return dialog;
}
async function choose(input,label){await input.locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').click();await page.locator('.ant-select-dropdown:visible').getByText(label,{exact:true}).click()}
async function save(dialog){await dialog.locator('.ant-modal-footer').getByRole('button',{name:/确\s*定/}).click()}
try{
 await page.goto(base+'/alerts');
 let dialog=await openPolicies();
 if(baseline){await page.screenshot({path:resolve(mediaOutput,'before.png'),fullPage:true,animations:'disabled'});checks.push('baseline captured')}
 else{
  // Opening a legacy group must not silently opt it into nighttime calls.
  await expect(dialog.getByLabel('P1夜间策略',{exact:true})).toBeVisible();
  await expect(dialog.getByText('仅记录，不通知',{exact:true})).toHaveCount(3);
  await choose(dialog.getByLabel('P1夜间策略',{exact:true}),'累计持续告警后通知');
  await dialog.getByRole('spinbutton',{name:'P1夜间持续告警轮数',exact:true}).fill('4');
  await dialog.getByRole('spinbutton',{name:'P1夜间持续告警轮数',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(mediaOutput,'policies-desktop.png'),fullPage:true,animations:'disabled'});
  rejectSave=true;await save(dialog);
  await expect(dialog.getByText('配置已变更，请刷新后重试',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('spinbutton',{name:'P1夜间持续告警轮数',exact:true})).toHaveValue('4');
  await save(dialog);await expect(dialog).toBeHidden();
  expect(group.policies.P1.night_after_count).toBe(4);expect(group.policies.P1.night_methods).toEqual(['voice']);
  await page.reload();dialog=await openPolicies();
  await expect(dialog.getByRole('spinbutton',{name:'P1夜间持续告警轮数',exact:true})).toHaveValue('4');
  checks.push('夜间策略和轮数可保存并刷新回读；保存失败保留输入；已有组保持仅记录');
  await dialog.getByRole('button',{name:'关闭',exact:true}).first().click();
  await page.getByRole('tab',{name:'告警规则',exact:true}).click();
  await page.getByRole('button',{name:/^编\s*辑$/}).click();
  const editor=page.getByRole('dialog',{name:'编辑告警规则'});
  await editor.getByRole('spinbutton',{name:'连续异常检测次数',exact:true}).fill('3');
  await editor.getByRole('spinbutton',{name:'连续异常检测次数',exact:true}).evaluate(el=>el.scrollIntoView({block:'center'}));
  await page.screenshot({path:resolve(mediaOutput,'rule-desktop.png'),fullPage:true,animations:'disabled'});
  await editor.getByRole('button',{name:'保存规则',exact:true}).click();await expect(editor).toBeHidden();
  expect(rule.for_count).toBe(3);
  await page.reload();await page.getByRole('button',{name:/^编\s*辑$/}).click();
  await expect(page.getByRole('spinbutton',{name:'连续异常检测次数',exact:true})).toHaveValue('3');
  await page.getByRole('dialog',{name:'编辑告警规则'}).getByRole('button',{name:/^取\s*消$/}).click();
  checks.push('规则连续异常检测次数与夜间告警轮数独立保存、刷新回读');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('combobox',{name:'告警功能'}).selectOption('groups');
  await page.getByRole('button',{name:'成员、排班与策略'}).click();
  dialog=page.getByRole('dialog',{name:'管理告警组'});await dialog.getByRole('tab',{name:'等级与升级策略'}).click();
  await expect(dialog.getByRole('spinbutton',{name:'P1夜间持续告警轮数',exact:true})).toHaveValue('4');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await dialog.getByRole('spinbutton',{name:'P1夜间持续告警轮数',exact:true}).evaluate(el=>el.scrollIntoView({block:'center'}));
  await page.screenshot({path:resolve(mediaOutput,'policies-mobile.png'),fullPage:true,animations:'disabled'});
  await dialog.getByRole('button',{name:'关闭',exact:true}).first().click();
  await page.getByRole('combobox',{name:'告警功能'}).selectOption('rules');
  await page.getByRole('button',{name:/^编\s*辑$/}).click();
  const mobileRule=page.getByRole('dialog',{name:'编辑告警规则'});
  await expect(mobileRule).toBeVisible();
  await mobileRule.getByRole('spinbutton',{name:'连续异常检测次数',exact:true}).fill('3');
  await mobileRule.getByRole('spinbutton',{name:'连续异常检测次数',exact:true}).evaluate(el=>el.scrollIntoView({block:'center'}));
  await expect(mobileRule.getByRole('spinbutton',{name:'连续异常检测次数',exact:true})).toHaveValue('3');
  expect(await mobileRule.evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1)).toBe(true);
  await page.screenshot({path:resolve(mediaOutput,'rule-mobile.png'),fullPage:true,animations:'disabled'});
  checks.push('390px策略与连续异常检测表单可操作，无横向溢出');
 }
 expect(errors).toEqual([]);
 await writeFile(resolve(output,baseline?'baseline-report.json':'report.json'),JSON.stringify({passed:true,checks,page_errors:errors},null,2));
 console.log(JSON.stringify({passed:true,checks}));
}catch(error){await page.screenshot({path:resolve(mediaOutput,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{});console.error(error);process.exitCode=1}
finally{await browser.close()}
