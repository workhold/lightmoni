import {chromium,expect} from '@playwright/test';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// The application is its real production bundle. Every API, including writes,
// is intercepted by isolated stateful fixtures; this never contacts a platform.
const origin='http://127.0.0.1:19846';
const publicDirectory=resolve(import.meta.dirname,'../../../runtime/public');
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??resolve(import.meta.dirname,'../../../specs/015-data-access-management'));
await mkdir(output,{recursive:true});
const screenshots=mediaDirectory(output),checked=[],errors=[],unexpected=[],requests=[],contexts=[];
const createdAt='2026-10-19T00:00:00.000Z',expiresAt='2099-01-01T00:00:00.000Z';
const oneTimeKey='fixture_sdk_secret_displayed_only_once';
const catalog=[
  {id:'log_web',name:'log_web',logical_name:'web',kind:'log',columns:[],services:['web-prod'],retention_days:null,effective_retention_days:7},
  {id:'metric_web_count',name:'metric_web_count',logical_name:'web',kind:'metric',columns:[],services:['web-prod'],retention_days:30,effective_retention_days:30},
  {id:'lightmoni_log',name:'lightmoni_log',logical_name:'lightmoni',kind:'log',columns:[],services:['lightmoni'],system:true,retention_days:null,effective_retention_days:7},
];
const packages=[['typescript','TypeScript / Node.js'],['python','Python'],['ruby','Ruby']].map(([id,language])=>({id,language,runtime:language,file:id+'.tar.gz',url:origin+'/downloads/'+id+'.tar.gz',available:true}));
const install={endpoint:'https://platform.example',endpoints:[],version:'0.1.0',packages,deferred:[{id:'go',language:'Go'},{id:'rust',language:'Rust'}],checksums_url:''};
const row=(page,text)=>page.getByRole('row').filter({hasText:text});
const count=(method,path)=>requests.filter(item=>item.method===method&&item.path===path).length;
const requestBody=(method,path)=>requests.filter(item=>item.method===method&&item.path===path).at(-1)?.body;
const mark=name=>{checked.push(name);console.log('PASS '+name)};
// Ant Design adds accessible icon labels and spaces inside two-character buttons.
const buttonName=text=>new RegExp([...text].map(character=>character.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s*'));
let browser;
try{browser=await chromium.launch({headless:true});}
catch{browser=await chromium.launch({headless:true,channel:'chrome'});}

async function harness(role='admin') {
  const state={
    tables:structuredClone(catalog),
    keys:[{id:'sdk-existing',name:'业务上报',active:true,allowed_tables:['web'],allow_all_tables:false,last_used:createdAt,upload_batches:8,error_count:0}],
    enrollments:[
      {id:'enr-issued',status:'issued'},
      {id:'enr-pending',status:'pending_activation',pending_expires_at:'2098-01-01T00:00:00.000Z',agent_id:'node-pending'},
      {id:'enr-active',status:'active',agent_id:'node-a',used_at:createdAt},
      {id:'enr-expired',status:'expired',expires_at:'2001-01-01T00:00:00.000Z'},
      {id:'enr-cancelled',status:'cancelled'},
    ].map(item=>({created_at:createdAt,expires_at:expiresAt,endpoint_origin:'https://platform.example',version:'0.1.0',initial_label_id:'default',...item})),
    credentials:[
      {id:'cred-control-a',agent_id:'node-a',audience:'control',scope:'agent.control',status:'active'},
      {id:'cred-control-b',agent_id:'node-a',audience:'control',scope:'agent.control',status:'active'},
      {id:'cred-data-a',agent_id:'node-a',audience:'data',scope:'agent.data',status:'active'},
      {id:'cred-expired',agent_id:'node-b',audience:'data',scope:'agent.data',status:'expired',expires_at:'2001-01-01T00:00:00.000Z'},
    ].map(item=>({created_at:createdAt,expires_at:expiresAt,last_used_at:createdAt,...item})),
    policy:{key:'event_id',rules:[{name:'全部日志',rate:1,conditions:[]}],exclude:[]},
  };
  const failures=new Map();
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});contexts.push(context);
  await context.addInitScript(()=>{localStorage.setItem('lightmoni.nav.collapsed','true');localStorage.setItem('lightmoni.appearance','dark')});
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),method=request.method(),path=url.pathname;
    if(url.origin!==origin){unexpected.push(method+' '+url.href);return route.abort()}
    if(path.startsWith('/api/')) {
      const body=request.postData()?request.postDataJSON():undefined;
      requests.push({role,method,path,body});
      const failure=failures.get(method+' '+path);
      if(failure){failures.set(method+' '+path,failure-1);return route.fulfill({status:503,json:{error:'fixture: temporary unavailable'}})}
      const reply=json=>route.fulfill({json});
      const user={id:'fixture-'+role,name:'fixture-'+role,role};
      if(method==='GET') {
        if(path==='/api/v1/auth/me')return reply(user);
        if(path==='/api/v1/auth/profile')return reply({nickname:'',avatar_url:'',phone:'',email:'',feishu_id:'',dingtalk_id:'',wecom_id:''});
        if(path==='/api/v1/sdk-install')return reply(install);
        if(path==='/api/v1/catalog/tables')return reply(state.tables);
        if(path==='/api/v1/users')return reply([{...user,active:true}]);
        if(path==='/api/v1/settings/login-providers'||path==='/api/v1/templates'||path==='/api/v1/dashboards')return reply([]);
        if(path==='/api/v1/settings/instance')return reply({external_url:origin});
        if(path==='/api/v1/keys')return reply(state.keys);
        if(/^\/api\/v1\/keys\/[^/]+\/events$/.test(path))return reply([{at:createdAt,service:'web-prod',status:'ok',detail:'fixture upload accepted'}]);
        if(path==='/api/v1/agent-enrollments')return reply(state.enrollments);
        if(path==='/api/v1/agent-credentials')return reply(state.credentials);
        if(path==='/api/v1/agent-install')return reply({endpoint:origin,endpoints:[],version:'0.1.0',bundles:['linux-arm64.tar.gz'],install_url:origin+'/downloads/agent/install.sh',release_url:origin+'/downloads/agent'});
        if(path==='/api/v1/agent-task-labels')return reply([{id:'default',name:'默认任务标签',node_count:1,task_count:1}]);
        if(path==='/api/v1/agent-tasks')return reply([{id:'host-task',type:'host',enabled:true,label_ids:['default'],config:{host_table:'web'}}]);
        if(path==='/api/v1/catalog/tables/log_web/log-sampling')return reply(state.policy);
      }
      if(method==='POST'&&path==='/api/v1/keys') {
        const key={id:'sdk-created',...body,active:true,last_used:'',upload_batches:0,error_count:0};state.keys.push(key);
        return reply({...key,key:oneTimeKey});
      }
      if(method==='PUT'&&path.startsWith('/api/v1/keys/')) {
        const key=state.keys.find(item=>item.id===decodeURIComponent(path.split('/').at(-1)));Object.assign(key,body);return reply(key);
      }
      if(method==='POST'&&/^\/api\/v1\/agent-enrollments\/[^/]+\/revoke$/.test(path)) {
        state.enrollments.find(item=>item.id===decodeURIComponent(path.split('/').at(-2))).status='cancelled';return reply({ok:true});
      }
      if(method==='POST'&&/^\/api\/v1\/agents\/[^/]+\/credentials\/revoke$/.test(path)) {
        const agentID=decodeURIComponent(path.split('/').at(-3));
        state.credentials.filter(item=>item.agent_id===agentID&&item.audience===body.audience).forEach(item=>Object.assign(item,{status:'revoked',revoked_at:createdAt,revoke_reason:body.reason}));return reply({ok:true});
      }
      if(method==='PUT'&&path==='/api/v1/catalog/tables/log_web/retention') {
        Object.assign(state.tables.find(item=>item.id==='log_web'),body,{effective_retention_days:body.retention_days??7});return reply({ok:true});
      }
      unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
    }
    if(method!=='GET'){unexpected.push(method+' '+path);return route.abort()}
    const file=path.startsWith('/assets/')?resolve(publicDirectory,'.'+path):resolve(publicDirectory,'index.html');
    const contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ttf':'font/ttf','.woff2':'font/woff2'}[extname(file)]??'application/octet-stream';
    try{return await route.fulfill({body:await readFile(file),contentType})}
    catch(error){unexpected.push(error.message);return route.abort()}
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  return {page,state,failOnce:path=>failures.set('GET /api/v1'+path,1)};
}

async function goto(page,path,heading) {
  await page.goto(origin+path);
  if(heading)await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
}
async function modalClose(page) {
  const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:/关\s*闭|Close/}).click();await expect(dialog).toHaveCount(0);
}
async function refreshCount(page,button,path) {
  const before=count('GET','/api/v1'+path);await page.getByRole('button',{name:buttonName(button)}).click();
  await expect.poll(()=>count('GET','/api/v1'+path)).toBeGreaterThan(before);
}
async function confirmCancel(page) {
  const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:/取\s*消|Cancel/}).click();await expect(dialog).toHaveCount(0);
}
async function noOverflow(page,label,width) {
  await expect.poll(()=>page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:innerWidth}))).toEqual({document:width,viewport:width});
  await page.mouse.move(0,0);await page.screenshot({path:resolve(screenshots,label+'-'+width+'.png'),fullPage:true,animations:'disabled'});
}

let currentPage;
try {
  const admin=await harness(),{page,state,failOnce}=admin;currentPage=page;
  await goto(page,'/data','数据接入');await expect(page.getByRole('heading',{name:'SDK 接入',exact:true})).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab',{name:'SDK 接入',exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:'执行节点接入',exact:true})).toBeVisible();
  await expect.poll(()=>count('GET','/api/v1/sdk-install')).toBeGreaterThan(0);
  expect(requests.filter(item=>['/api/v1/keys','/api/v1/templates','/api/v1/catalog/tables'].includes(item.path))).toEqual([]);
  mark('data page has two tabs and no key/template/catalog dependency');
  failOnce('/sdk-install');await page.getByRole('button',{name:buttonName('刷新接入状态')}).click();
  await expect(page.getByText('fixture: temporary unavailable',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:buttonName('重试接入信息')}).click();await expect(page.getByText('fixture: temporary unavailable',{exact:true})).toHaveCount(0);
  mark('SDK metadata failure has independent retry');

  await goto(page,'/data?tab=keys','管理后台');await expect(page).toHaveURL(origin+'/admin?tab=credentials&section=sdk');
  await expect(page.getByRole('tab',{name:'SDK 上报密钥',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(row(page,'sdk-existing')).toBeVisible();
  for(const name of ['SDK 上报密钥','Agent 接入令牌','节点凭据'])await expect(page.getByRole('tab',{name,exact:true})).toBeVisible();
  await refreshCount(page,'刷新密钥','/keys');
  failOnce('/keys');await page.getByRole('button',{name:buttonName('刷新密钥')}).click();await expect(page.getByText('SDK 上报密钥加载失败',{exact:true})).toBeVisible();
  await expect(row(page,'sdk-existing')).toBeVisible();await page.getByRole('button',{name:buttonName('重试')}).click();await expect(page.getByText('SDK 上报密钥加载失败',{exact:true})).toHaveCount(0);
  mark('legacy keys redirect and SDK list refresh/failure retains loaded entries');

  await page.getByRole('button',{name:buttonName('创建 SDK 上报密钥')}).click();
  let dialog=page.getByRole('dialog');await dialog.getByRole('textbox',{name:'密钥名称',exact:true}).fill('新业务上报');
  await dialog.getByRole('radio',{name:'所有 table',exact:true}).check();await dialog.getByRole('button',{name:buttonName('创建')}).click();
  const createdDialog=page.getByRole('dialog',{name:'上报密钥已创建，仅显示这一次',exact:true});await expect(createdDialog).toContainText(oneTimeKey);
  expect(requestBody('POST','/api/v1/keys')).toMatchObject({name:'新业务上报',allow_all_tables:true});
  await createdDialog.getByRole('button',{name:buttonName('已保存')}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(oneTimeKey,{exact:true})).toHaveCount(0);await expect(row(page,'sdk-created')).toContainText('新业务上报');
  await row(page,'sdk-created').getByRole('button',{name:buttonName('编辑')}).click();dialog=page.getByRole('dialog');
  await dialog.getByRole('textbox',{name:'密钥名称',exact:true}).fill('已更新业务上报');await dialog.getByRole('button',{name:buttonName('保存')}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page,'sdk-created')).toContainText('已更新业务上报');
  await row(page,'sdk-created').getByRole('button',{name:buttonName('禁用')}).click();await page.getByRole('dialog').getByRole('button',{name:/确\s*定|OK/}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page,'sdk-created').getByRole('button',{name:buttonName('启用')})).toBeVisible();
  await row(page,'sdk-created').getByRole('button',{name:buttonName('启用')}).click();await page.getByRole('dialog').getByRole('button',{name:/确\s*定|OK/}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page,'sdk-created').getByRole('button',{name:buttonName('禁用')})).toBeVisible();
  failOnce('/keys/sdk-existing/events');await row(page,'sdk-existing').getByRole('button',{name:buttonName('查看上报记录')}).click();
  await expect(page.getByRole('dialog')).toContainText('上报记录加载失败');await page.getByRole('dialog').getByRole('button',{name:buttonName('重试')}).click();
  await expect(page.getByRole('dialog')).toContainText('fixture upload accepted');await modalClose(page);
  mark('SDK key create/display-once/edit/disable/enable and event failure/retry');

  await page.getByRole('tab',{name:'告警配置',exact:true}).click();await expect(page).toHaveURL(origin+'/admin?tab=alerts');
  await expect(page.getByRole('button',{name:buttonName('创建 SDK 上报密钥')})).toHaveCount(0);
  await expect(row(page,'sdk-existing')).toHaveCount(0);await expect(page.getByText(oneTimeKey,{exact:true})).toHaveCount(0);
  const beforeRemount=count('GET','/api/v1/keys');await page.getByRole('tab',{name:'接入凭据',exact:true}).click();
  await expect(row(page,'sdk-existing')).toBeVisible();await expect.poll(()=>count('GET','/api/v1/keys')).toBeGreaterThan(beforeRemount);
  mark('credential panels unmount on inactive administrator tabs and reload independently');

  await page.getByRole('tab',{name:'Agent 接入令牌',exact:true}).click();await expect(page).toHaveURL(origin+'/admin?tab=credentials&section=enrollments');
  await expect(row(page,'enr-pending')).toContainText('待激活');
  for(const [id,status] of [['enr-issued','待接入'],['enr-active','已接入'],['enr-expired','已过期'],['enr-cancelled','已撤销']])await expect(row(page,id)).toContainText(status);
  for(const id of ['enr-active','enr-expired','enr-cancelled'])await expect(row(page,id).getByRole('button',{name:buttonName('撤销令牌')})).toBeDisabled();
  await refreshCount(page,'刷新令牌','/agent-enrollments');
  failOnce('/agent-enrollments');await page.getByRole('button',{name:buttonName('刷新令牌')}).click();await expect(page.getByText('Agent 接入令牌加载失败',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:buttonName('重试')}).click();await expect(page.getByText('Agent 接入令牌加载失败',{exact:true})).toHaveCount(0);
  const enrollmentRevoke='/api/v1/agent-enrollments/enr-pending/revoke',beforeRevoke=count('POST',enrollmentRevoke);
  await row(page,'enr-pending').getByRole('button',{name:buttonName('撤销令牌')}).click();await expect(page.getByRole('dialog')).toContainText('无法继续激活');
  await confirmCancel(page);expect(count('POST',enrollmentRevoke)).toBe(beforeRevoke);
  await row(page,'enr-pending').getByRole('button',{name:buttonName('撤销令牌')}).click();await page.getByRole('dialog').getByRole('button',{name:buttonName('撤销令牌')}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page,'enr-pending')).toContainText('已撤销');await expect(row(page,'enr-pending').getByRole('button',{name:buttonName('撤销令牌')})).toBeDisabled();
  expect(count('POST',enrollmentRevoke)).toBe(beforeRevoke+1);
  mark('enrollment lifecycle, refresh/retry and confirmed revocation');
  await page.getByRole('button',{name:buttonName('生成 Agent 接入令牌')}).click();await expect(page).toHaveURL(origin+'/data?tab=agent');
  await expect(page.getByRole('heading',{name:'接入执行节点',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:buttonName('生成一次性接入令牌')})).toBeEnabled();
  await page.getByRole('link',{name:'管理接入凭据',exact:true}).click();await expect(page).toHaveURL(origin+'/admin?tab=credentials&section=enrollments');
  mark('Agent token generation opens existing deployment flow and credentials return link');

  await page.getByRole('tab',{name:'节点凭据',exact:true}).click();await expect(page).toHaveURL(origin+'/admin?tab=credentials&section=agents');
  await expect(row(page,'cred-control-a')).toContainText('control · 控制通道');await expect(row(page,'cred-data-a')).toContainText('data · 遥测上报');
  await refreshCount(page,'刷新节点凭据','/agent-credentials');
  failOnce('/agent-credentials');await page.getByRole('button',{name:buttonName('刷新节点凭据')}).click();await expect(page.getByText('节点凭据加载失败',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:buttonName('重试')}).click();await expect(page.getByText('节点凭据加载失败',{exact:true})).toHaveCount(0);
  const credentialRevoke='/api/v1/agents/node-a/credentials/revoke',beforeCredential=count('POST',credentialRevoke);
  await row(page,'cred-control-a').getByRole('button',{name:buttonName('撤销该用途全部凭据')}).click();await expect(page.getByRole('dialog')).toContainText('所有未撤销凭据');await confirmCancel(page);
  expect(count('POST',credentialRevoke)).toBe(beforeCredential);
  await row(page,'cred-control-a').getByRole('button',{name:buttonName('撤销该用途全部凭据')}).click();await page.getByRole('dialog').getByRole('button',{name:buttonName('撤销全部 control 凭据')}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  for(const id of ['cred-control-a','cred-control-b']){await expect(row(page,id)).toContainText('已撤销');await expect(row(page,id).getByRole('button',{name:buttonName('撤销该用途全部凭据')})).toBeDisabled()}
  await expect(row(page,'cred-data-a')).toContainText('有效');expect(requestBody('POST',credentialRevoke)).toMatchObject({audience:'control'});
  mark('node credentials refresh/retry and revocation applies to every matching agent/audience');

  await goto(page,'/data?tab=tables','数据管理');await expect(page).toHaveURL(origin+'/data-management');await expect(row(page,'log_web')).toContainText('web-prod');
  await row(page,'log_web').getByRole('button',{name:buttonName('设置时长')}).click();dialog=page.getByRole('dialog');await expect(dialog).toContainText('数据表保留时长');
  await dialog.getByRole('combobox',{name:'单表保留方式',exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText('自定义天数',{exact:true}).click();
  await dialog.getByRole('spinbutton',{name:'单表保留天数',exact:true}).fill('14');await dialog.getByRole('button',{name:buttonName('保存时长')}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page,'log_web')).toContainText('14 天');expect(requestBody('PUT','/api/v1/catalog/tables/log_web/retention')).toEqual({retention_days:14});
  await row(page,'log_web').getByRole('button',{name:buttonName('上报规则')}).click();dialog=page.getByRole('dialog');await expect(dialog).toContainText('日志上报规则');await expect(dialog.getByRole('button',{name:buttonName('保存并下发')})).toBeEnabled();await modalClose(page);
  await expect(row(page,'lightmoni_log').getByRole('button',{name:buttonName('上报规则')})).toHaveCount(0);
  failOnce('/catalog/tables');await page.getByRole('button',{name:buttonName('刷新数据表')}).click();await expect(page.getByText('数据表目录加载失败',{exact:true})).toBeVisible();
  await expect(row(page,'log_web')).toContainText('14 天');await expect(page.getByText('当前显示上次成功加载的目录，请刷新后确认最新设置。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:buttonName('重试')}).click();await expect(page.getByText('数据表目录加载失败',{exact:true})).toHaveCount(0);
  mark('legacy tables redirect, catalog TTL/log editor, refresh failure retains prior data');
  await goto(page,'/data?tab=templates','监控大盘');await expect(page).toHaveURL(origin+'/dashboards');
  mark('legacy templates redirect to monitoring dashboards');

  // Exercise a first-load failure separately; an unavailable directory is never
  // presented as a successfully loaded empty catalogue.
  failOnce('/catalog/tables');await goto(page,'/data-management','数据管理');await expect(page.getByText('数据表目录加载失败',{exact:true})).toBeVisible();
  await expect(page.getByText('尚无数据表，接入数据后会自动创建',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:buttonName('重试')}).click();await expect(row(page,'log_web')).toBeVisible();
  mark('first-load catalogue failure is not an empty success and can retry');

  for(const width of [1280,390]) {
    await page.setViewportSize({width,height:900});
    for(const [label,path,heading,ready] of [
      ['sdk','/data','数据接入','SDK 接入'],
      ['deployment','/data?tab=agent','数据接入','接入执行节点'],
      ['sdk-keys','/admin?tab=credentials&section=sdk','管理后台'],
      ['enrollments','/admin?tab=credentials&section=enrollments','管理后台'],
      ['node-credentials','/admin?tab=credentials&section=agents','管理后台'],
      ['data-management','/data-management','数据管理'],
    ]) {
      await goto(page,path,heading);if(ready)await expect(page.getByRole('heading',{name:ready,exact:true})).toBeVisible();
      if(label==='sdk-keys')await expect(row(page,'sdk-existing')).toBeVisible();
      if(label==='enrollments')await expect(row(page,'enr-issued')).toBeVisible();
      if(label==='node-credentials')await expect(row(page,'cred-data-a')).toBeVisible();
      if(label==='data-management')await expect(row(page,'log_web')).toBeVisible();
      await noOverflow(page,label,width);
    }
  }
  mark('six platform screens fit desktop 1280 and narrow 390 pixels');

  const member=await harness('member');currentPage=member.page;const memberPage=member.page;
  await goto(memberPage,'/data-management','数据管理');await expect(row(memberPage,'log_web')).toContainText('web-prod');
  await expect(memberPage.getByRole('button',{name:buttonName('设置时长')})).toHaveCount(0);await expect(memberPage.getByRole('button',{name:buttonName('上报规则')})).toHaveCount(0);
  await expect(memberPage.getByRole('link',{name:'管理全局默认时长',exact:true})).toHaveCount(0);
  await goto(memberPage,'/data?tab=keys','数据接入');await expect(memberPage).toHaveURL(origin+'/data?tab=sdk');await expect(memberPage.getByRole('button',{name:buttonName('管理接入凭据')})).toHaveCount(0);
  await goto(memberPage,'/admin?tab=credentials&section=agents','个人设置');await expect(memberPage).toHaveURL(origin+'/settings');
  expect(requests.filter(item=>item.role==='member'&&/\/keys|\/agent-enrollments|\/agent-credentials|\/users|\/settings\/login-providers/.test(item.path))).toEqual([]);
  await memberPage.setViewportSize({width:390,height:900});await goto(memberPage,'/data-management','数据管理');await expect(row(memberPage,'log_web')).toBeVisible();await noOverflow(memberPage,'member-data-management',390);
  mark('members retain read-only data access and cannot load administrator credential APIs');

  expect(state.keys.find(item=>item.id==='sdk-created').name).toBe('已更新业务上报');
  expect(errors).toEqual([]);expect(unexpected).toEqual([]);
  await rm(resolve(screenshots,'failure.png'),{force:true});
  await writeFile(resolve(output,'ui-report.json'),JSON.stringify({production_bundle:true,api_fixtures:true,stateful_fixture_writes:true,live_backend:false,widths:[1280,390],checked,api_requests:requests.length,errors,unexpected},null,2)+'\n');
  console.log(`PASS ${checked.length} access management scenarios; production bundle, isolated fixtures, no live backend changes`);
} catch(error) {
  await currentPage?.screenshot({path:resolve(screenshots,'failure.png'),fullPage:true}).catch(()=>{});
  await writeFile(resolve(output,'ui-report.json'),JSON.stringify({production_bundle:true,api_fixtures:true,live_backend:false,checked,failed:String(error),errors,unexpected},null,2)+'\n');
  throw error;
} finally {
  for(const context of contexts)await context.close();await browser.close();
}
