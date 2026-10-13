// UI fixtures only; Go tests exercise the real API, queue, signatures and local receivers.
import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const output=resolve(import.meta.dirname,'../../../../docs/evidence/notification-channels');
await mkdir(output,{recursive:true});
let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),errors=[],checks=[],channels=[],groups=[],tests=[];
page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
const secretKeys=['url','secret','token','password','access_key','access_key_id','access_key_secret','headers','secret_id','secret_key','app_key','app_secret'];
const publicChannel=c=>({...c,has_secret:secretKeys.some(key=>!!c.config[key]),config:Object.fromEntries(Object.entries(c.config).filter(([key])=>!secretKeys.includes(key)))});
let rejectSave=false;
await page.route('**/api/v1/**',async route=>{
 const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method(),body=request.postDataJSON();
 if(path==='/auth/me')return route.fulfill({json:{id:'qa',name:'QA',role:'admin'}});
 if(path==='/notify/channels'&&method==='GET')return route.fulfill({json:channels.map(publicChannel)});
 if(path.startsWith('/notify/channels')&&['POST','PUT'].includes(method)){
  if(path.endsWith('/test')){tests.push({channel_id:path.split('/')[3],...body});return route.fulfill({json:{ok:true}});}
  if(rejectSave){rejectSave=false;return route.fulfill({status:400,json:{error:'验收：供应商配置不完整'}});}
  const prior=channels.find(c=>c.id===path.split('/')[3]);
  const c={...body,id:prior?.id??String(channels.length+1),revision:(prior?.revision??0)+1,config:{...body.config}};
  for(const key of secretKeys)if(!c.config[key]&&prior?.config[key])c.config[key]=prior.config[key];
  if(prior)channels[channels.indexOf(prior)]=c;else channels.push(c);
  return route.fulfill({json:publicChannel(c)});
 }
 if(path==='/alerts/groups'&&method==='GET')return route.fulfill({json:groups});
 if(path==='/alerts/groups'&&method==='POST'){const g={...body,id:String(groups.length+1)};groups.push(g);return route.fulfill({json:g});}
 return route.fulfill({json:[]});
});
const dialog=()=>page.getByRole('dialog',{name:'配置通知渠道',exact:true});
const manager=()=>page.getByRole('dialog',{name:'通知渠道',exact:true});
const button=(scope,name)=>scope.getByRole('button',{name:new RegExp(name.split('').join('\\s*'))});
async function choose(select,label){
 await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
 await select.locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').click();
 await page.locator('.ant-select-dropdown:visible').getByText(label,{exact:true}).click();
 await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
}
async function add(label,fields){
 await manager().getByRole('button',{name:'添加通知渠道',exact:true}).click();
 await dialog().getByLabel('通知渠道名称',{exact:true}).fill(label);
 await choose(dialog().getByRole('combobox',{name:'通知渠道类型',exact:true}),label);
 for(const [name,value]of Object.entries(fields))await dialog().getByLabel(name,{exact:true}).fill(value);
 await button(dialog(),'确定').click();await expect(dialog()).toBeHidden();
 await expect(manager().getByRole('row').filter({hasText:label})).toHaveCount(1);
}
try{
 await page.goto((process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5176')+'/alerts');
 await page.getByRole('tab',{name:'告警组',exact:true}).click();await page.getByRole('button',{name:'管理通知渠道',exact:true}).click();
 await add('阿里云电话语音',{'AccessKey ID':'test-ali-id','AccessKey Secret':'test-ali-secret','语音模板 Code':'TTS_TEST','模板变量（JSON 对象）':'{"name":"{{rule}}","state":"{{status}}"}'});
 await add('腾讯云电话语音',{'SecretId':'test-tencent-id','SecretKey':'test-tencent-secret','应用 SDK AppID':'1400000000','语音模板 ID':'123','模板变量（JSON 数组，按模板顺序）':'["{{rule}}","{{status}}"]'});
 await add('腾讯云短信',{'SecretId':'test-tencent-id','SecretKey':'test-tencent-secret','应用 SDK AppID':'1400000000','已审核的短信签名':'监控','短信模板 ID':'456'});
 await add('华为云短信',{'Application Key':'test-huawei-id','Application Secret':'test-huawei-secret','应用接入地址':'https://smsapi.cn-north-4.myhuaweicloud.com','短信签名通道号':'106900000000','短信模板 ID':'789'});
 checks.push('四个新增渠道可以选择、填写中文配置并保存');
 await manager().getByRole('button',{name:'添加通知渠道',exact:true}).click();
 await dialog().getByLabel('通知渠道名称',{exact:true}).fill('邮箱告警');
 await choose(dialog().getByRole('combobox',{name:'通知渠道类型',exact:true}),'邮箱（SMTP）');
 for(const [label,host]of [['QQ 邮箱','smtp.qq.com'],['网易 163 邮箱','smtp.163.com'],['网易 126 邮箱','smtp.126.com'],['腾讯企业邮箱','smtp.exmail.qq.com'],['阿里企业邮箱','smtp.qiye.aliyun.com']]){
  await choose(dialog().getByRole('combobox',{name:'邮箱配置预设',exact:true}),label);
  await expect(dialog().getByLabel('SMTP 服务器',{exact:true})).toHaveValue(host);
  await expect(dialog().getByLabel('端口',{exact:true})).toHaveValue('465');
  await expect(dialog().getByRole('combobox',{name:'连接加密',exact:true})).toHaveValue('');
  await expect(dialog().getByText('SSL / TLS（通常为 465）',{exact:true})).toBeVisible();
 }
 await choose(dialog().getByRole('combobox',{name:'邮箱配置预设',exact:true}),'自定义 SMTP');
 await expect(dialog().getByLabel('SMTP 服务器',{exact:true})).toHaveValue('');
 await choose(dialog().getByRole('combobox',{name:'邮箱配置预设',exact:true}),'QQ 邮箱');
 await dialog().getByLabel('登录邮箱 / 用户名',{exact:true}).fill('qa@qq.com');await dialog().getByLabel('客户端授权码 / 密码',{exact:true}).fill('test-authorization-code');await dialog().getByLabel('发件邮箱',{exact:true}).fill('qa@qq.com');
 rejectSave=true;await button(dialog(),'确定').click();await expect(dialog().getByText('验收：供应商配置不完整',{exact:false})).toBeVisible();await expect(dialog().getByLabel('发件邮箱',{exact:true})).toHaveValue('qa@qq.com');
 await button(dialog(),'确定').click();await expect(dialog()).toBeHidden();checks.push('五种邮箱预设正确填入服务器/TLS/465；自定义可切换；保存失败保留输入');
 await manager().getByRole('button',{name:'关闭',exact:true}).click();await page.reload();await page.getByRole('tab',{name:'告警组',exact:true}).click();await page.getByRole('button',{name:'管理通知渠道',exact:true}).click();
 const voiceRow=manager().getByRole('row').filter({hasText:'腾讯云电话语音'});await button(voiceRow,'编辑').click();
 await expect(dialog().getByLabel('SecretKey',{exact:true})).toHaveValue('');await expect(dialog().getByLabel('语音模板 ID',{exact:true})).toHaveValue('123');
 await dialog().getByLabel('通知渠道名称',{exact:true}).fill('腾讯云电话语音（更新）');await button(dialog(),'确定').click();await expect(dialog()).toBeHidden();
 expect(channels.find(c=>c.type==='tencent_voice').config.secret_key).toBe('test-tencent-secret');checks.push('刷新回读配置；秘密不回显，编辑留空保留秘密');
 await page.screenshot({path:resolve(output,'channels-desktop.png'),fullPage:true});
 await manager().getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'创建告警组',exact:true}).click();
 const group=page.getByRole('dialog',{name:'告警组与通知目标',exact:true});await group.getByLabel('告警组名称',{exact:true}).fill('多渠道告警');
 for(const label of ['腾讯云电话语音（更新）','腾讯云短信','华为云短信','邮箱告警']){
  await group.getByRole('button',{name:'添加通知目标',exact:true}).click();const target=group.locator('.lm-alert-target').last();
  await choose(target.getByRole('combobox'),label);await target.getByLabel('接收目标',{exact:true}).fill(label==='邮箱告警'?'ops@example.com':'13800000000');
 }
 await group.locator('.lm-alert-target').first().getByRole('button',{name:'发送测试',exact:true}).click();const confirm=page.getByRole('dialog',{name:'向该目标发送测试',exact:true});await button(confirm,'确定').click();await expect(confirm).toBeHidden();
 expect(tests[0].recipient).toEqual({kind:'phone',value:'13800000000'});await button(group,'确定').click();await expect(group).toBeHidden();
 expect(groups[0].targets.map(t=>t.recipient.kind)).toEqual(['phone','phone','phone','email']);checks.push('新增渠道在告警组使用phone目标，邮箱使用email；测试提交正确目标');
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'管理通知渠道',exact:true}).click();await button(manager().getByRole('row').filter({hasText:'华为云短信'}),'编辑').click();
 await expect(dialog().getByLabel('应用接入地址',{exact:true})).toHaveValue('https://smsapi.cn-north-4.myhuaweicloud.com');
 expect(await dialog().evaluate(node=>{const box=node.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth+1;})).toBe(true);
 for(const input of await dialog().locator('input,textarea').all())expect(await input.evaluate(node=>node.getBoundingClientRect().right<=innerWidth+1)).toBe(true);
 await dialog().getByLabel('通知渠道名称',{exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:resolve(output,'huawei-mobile.png'),fullPage:true});
 await button(dialog(),'确定').click();await expect(dialog()).toBeHidden();checks.push('390px 配置表单和输入框未横向溢出，保存按钮可滚动访问');
 expect(errors).toEqual([]);await writeFile(resolve(output,'report.json'),JSON.stringify({passed:true,checks,page_errors:errors,scope:'UI fixtures; no real provider messages sent'},null,2));console.log(JSON.stringify({passed:true,checks}));
}catch(error){await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;}
finally{await browser.close();}
