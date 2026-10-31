import {chromium,expect} from '@playwright/test';
import {mkdtemp,cp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,extname} from 'node:path';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// Isolated production bundle. Every request is intercepted; no real machines,
// credentials, accounts, models or enrollment tokens are touched.
const origin='http://127.0.0.1:19849',publicDir=await mkdtemp(resolve(tmpdir(),'lightmoni-ssh-ui-'));
await cp(resolve(import.meta.dirname,'../../../runtime/public'),publicDir,{recursive:true});
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'specs/017-assistant-ssh-bootstrap');await mkdir(output,{recursive:true});
const media=mediaDirectory(output);
const checked=[],errors=[],unexpected=[],contexts=[];
const mark=value=>{checked.push(value);console.log('PASS '+value)};
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
async function harness({role='admin',language='zh-CN'}={}){
 const at=new Date().toISOString(),expires=new Date(Date.now()+900_000).toISOString();
 const machine={id:'fixture-machine',name:'Fixture host',address:'host.example.com',port:22,username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:fixtureconfirmedfingerprint',host_key_status:'confirmed',agent_id:'',agent_status:'unknown',active_credential_count:1,active_ssh_credential_count:1,active_ssh_key_count:1,ssh_recovery_available:true,capabilities:{terminal:{available:true,reason:''},ssh_check:{available:true,reason:''},deploy_agent:{available:true,reason:''}},credential_count:1,arch:'',platform:'',updated_at:at,created_at:at};
 const credential={id:'fixture-key',method:'ssh_key',secret_fingerprint:'fixture-metadata-only',expires_at:expires,retention:'managed'};
 const result={id:'fixture-check',machine_id:machine.id,credential_id:credential.id,connected:true,ready:true,platform:'linux',arch:'arm64',checks:{linux:true,supported_arch:true,curl:true,tar:true,gzip:true,sha256sum:true,systemd:true,install_privilege:true,platform_https:true},error_code:'',checked_at:at,expires_at:expires};
 const plan={id:'fixture-plan',machine_id:machine.id,status:'awaiting_approval',plan:{machine,credential,preflight:result,version:'0.1.0',arch:'arm64',expires_at:expires,steps:['自动校验主机公钥','建立受限 SSH 连接','安装独立 systemd Agent','等待 Agent 激活回执'],warnings:['AI 不会读取或发送 SSH 秘密。']},review_url:'/machines?machine=fixture-machine&deployment=fixture-plan'};
 const state={role,result,plan,hold:false,failApply:false,release:undefined,requests:[],credentials:[credential],deleted:false,deleteError:'请先解绑本主机的有效连接凭据后再删除主机'};
 const context=await browser.newContext({viewport:{width:1365,height:1000},reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(language=>{localStorage.setItem('lightmoni.language',language);localStorage.setItem('lightmoni.nav.collapsed','true')},language);
 const user={id:'fixture-admin',name:'Fixture Admin',role};
 const fixtures={'/api/v1/setup':{required:false},'/api/v1/auth/providers':[],'/api/v1/auth/me':user,'/api/v1/auth/profile':{},'/api/v1/catalog/tables':[],'/api/v1/dashboards':[], '/api/v1/assistant/config':{enabled:true,has_key:true,base_url:'https://models.example/v1',model:'fixture-model',protocol:'openai-chat-completions',code_tasks_enabled:false},'/api/v1/assistant/sessions':{items:[{id:'fixture-session',title:'SSH fixture session'}]},'/api/v1/assistant/sessions/fixture-session':{id:'fixture-session',events:[
  {type:'user.message',data:{text:'Install Agent on fixture host'}},
  {type:'tool.call',data:{tool:'check_managed_machine_ssh',call_id:'check',input:{machine_id:machine.id}}},
  {type:'tool.result',data:{call_id:'check',status:'success',value:result}},
  {type:'tool.call',data:{tool:'propose_agent_install',call_id:'plan',input:{machine_id:machine.id,check_id:result.id}}},
  {type:'tool.result',data:{call_id:'plan',status:'success',value:plan}},
  {type:'turn.completed',data:{}},
 ].map((e,index)=>({...e,sequence:index+1,session_id:'fixture-session',turn_id:'fixture-turn',timestamp:at}))}};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(url.href);return route.abort()}
  if(path.startsWith('/api/')){
   if(method==='GET'&&['/api/v1/agents','/api/v1/agent-task-labels','/api/v1/host-labels','/api/v1/connection-credentials','/api/v1/task-hosts'].includes(path))return route.fulfill({json:[]});
   if(method==='GET'&&/^\/api\/v1\/machines\/[^/]+\/tasks$/.test(path))return route.fulfill({json:[]});
   const body=request.postData()?request.postDataJSON():undefined;state.requests.push({method,path,body});
   if(path==='/api/v1/machines'&&method==='GET')return route.fulfill({json:state.deleted?[]:[machine]});
   if(path==='/api/v1/machines/'+machine.id&&method==='GET')return route.fulfill({json:{machine,credentials:state.credentials,deployments:[state.plan]}});
   if(path==='/api/v1/machines/'+machine.id+'/credentials/'+credential.id&&method==='DELETE'){state.credentials=[];return route.fulfill({json:{ok:true}})}
   if(path==='/api/v1/machines/'+machine.id&&method==='DELETE'){
    if(state.deleteError)return route.fulfill({status:409,json:{error:state.deleteError}});
    state.deleted=true;return route.fulfill({json:{ok:true}});
   }
   if(path.endsWith('/ssh-check')&&method==='POST'){
    if(state.hold)await new Promise(resolve=>{state.release=resolve});
    return route.fulfill({json:state.result}).catch(()=>{});
   }
   if(path.endsWith('/deployments/plan')&&method==='POST'){expect(body.arch).toBe('arm64');expect(body.check_id).toBe('fixture-check');return route.fulfill({json:state.plan})}
   if(path.endsWith('/deployments/fixture-plan')&&method==='GET')return route.fulfill({json:state.plan});
   if(path.endsWith('/deployments/fixture-plan/cancel')&&method==='POST'){
    state.plan={...state.plan,status:'cancelled'};return route.fulfill({json:state.plan});
   }
   if(path.endsWith('/deployments/fixture-plan/apply')&&method==='POST'){
    expect(body).toEqual({confirm:true});
    if(state.failApply){state.plan={...state.plan,status:'failed',error:'Fixture SSH installation failed'};return route.fulfill({status:502,json:{error:state.plan.error}})}
    state.plan={...state.plan,status:'succeeded',receipt:{agent_id:'fixture-agent',stages:['remote_command_completed']}};return route.fulfill({json:state.plan});
   }
   if(method==='GET'&&Object.hasOwn(fixtures,path))return route.fulfill({json:fixtures[path]});
   unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
  }
  const file=path.startsWith('/assets/')?resolve(publicDir,'.'+path):resolve(publicDir,'index.html');
  return route.fulfill({body:await readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]??'application/octet-stream'});
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return {page,state};
}
let current;
try{
 const {page,state}=await harness();current=page;await page.goto(origin+'/machines');
 await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
 await page.locator('.ant-table-tbody .ant-typography').filter({hasText:'host.example.com:22'}).locator('.ant-typography-copy').click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe('host.example.com:22');mark('Copying the displayed host address copies address:port rather than the machine ID');
 await page.getByRole('button',{name:'添加凭据',exact:true}).click();
 await expect(page.getByRole('dialog').getByText('6 小时（默认）',{exact:true})).toBeVisible();
 await expect(page.getByRole('dialog').getByText('保存时长',{exact:false}).first()).toBeVisible();
 const passwordInput=page.getByPlaceholder('输入 SSH 密码',{exact:true});await passwordInput.fill('fixture-password');
 await page.getByRole('combobox',{name:'登录方式',exact:false}).click();await page.locator('.ant-select-dropdown:visible').getByText('SSH 私钥',{exact:true}).click();
 await expect(page.getByPlaceholder('SSH 私钥内容',{exact:true})).toHaveValue('');mark('Switching credential methods clears the previous secret before it can be reused or displayed');
 await page.locator('.ant-modal:visible .ant-modal-close').click();mark('Chinese credential hints describe six-hour storage and secret clearing');
 await page.getByRole('button',{name:'SSH 安装检查',exact:true}).click();
 state.result={...state.result,ready:false,checks:{...state.result.checks,systemd:false},error_code:'prerequisites_missing'};
 await page.getByRole('button',{name:'开始 SSH 检查',exact:true}).click();await expect(page.getByText('SSH 已连接，安装条件不满足',{exact:true})).toBeVisible();
 expect(state.requests.filter(r=>r.path.endsWith('/deployments/plan'))).toHaveLength(0);mark('Connected SSH with missing prerequisites does not propose or install');
 state.result={...state.result,connected:false,checks:{},error_code:'host_key_mismatch'};
 await page.getByRole('button',{name:'开始 SSH 检查',exact:true}).click();await expect(page.getByText('主机公钥与已记录的身份不一致，连接已停止。',{exact:true})).toBeVisible();mark('Pinned host-key failure is explained');
 state.result={...state.plan.plan.preflight};
 await page.getByRole('button',{name:'开始 SSH 检查',exact:true}).click();await expect(page.getByText('SSH 已连接，安装检查通过',{exact:true})).toBeVisible();mark('Standalone successful SSH preflight');
 state.hold=true;await page.getByRole('button',{name:'开始 SSH 检查',exact:true}).click();await expect(page.getByRole('button',{name:'取消检查',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'取消检查',exact:true}).click();state.hold=false;state.release?.();await expect(page.getByRole('dialog')).toHaveCount(0);mark('In-flight preflight can be cancelled without a late result reopening the dialog');
 await page.getByRole('button',{name:'部署 Agent',exact:true}).click();await page.getByRole('button',{name:'检查并生成部署计划',exact:true}).click();
 await expect(page.getByText('fixture-plan',{exact:true})).toBeVisible();await expect(page.getByText('0.1.0 / arm64',{exact:true})).toBeVisible();expect(state.requests.filter(r=>r.path.endsWith('/apply'))).toHaveLength(0);mark('Deployment form detects architecture and saves a plan without applying');
 const plans=state.requests.filter(r=>r.path.endsWith('/deployments/plan')).length;
 await page.goto(origin+state.plan.review_url);await expect(page.getByRole('button',{name:'我已审阅，确认执行 SSH 部署',exact:true})).toBeEnabled();expect(state.requests.filter(r=>r.path.endsWith('/deployments/plan'))).toHaveLength(plans);
 await page.getByRole('button',{name:'我已审阅，确认执行 SSH 部署',exact:true}).click();await expect(page.getByText('Agent 已部署并收到激活回执',{exact:true})).toBeVisible();mark('Deep link reviews and confirms the same persisted plan exactly once');
 state.plan={...state.plan,status:'awaiting_approval'};state.failApply=true;
 await page.goto(origin+state.plan.review_url);await page.getByRole('button',{name:'我已审阅，确认执行 SSH 部署',exact:true}).click();
 await expect(page.getByText('部署状态：failed',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'我已审阅，确认执行 SSH 部署',exact:true})).toHaveCount(0);state.failApply=false;mark('Failed installation refreshes its real status and removes the obsolete approval action');
 state.plan={...state.plan,status:'awaiting_approval',plan:{...state.plan.plan,expires_at:'2000-01-01T00:00:00Z'}};
 await page.goto(origin+state.plan.review_url);await expect(page.getByRole('button',{name:'我已审阅，确认执行 SSH 部署',exact:true})).toBeDisabled();mark('Expired plans cannot be confirmed in the UI');
 await page.goto(origin+'/machines');const machineRow=page.locator('.ant-table-tbody tr[data-row-key="fixture-machine"]');await expect(machineRow.getByRole('button',{name:'删除主机',exact:true})).toHaveCount(0);await machineRow.getByRole('checkbox').check();await page.getByRole('region',{name:'批量操作',exact:true}).getByRole('button',{name:'删除主机',exact:true}).click();let deletion=page.getByRole('dialog',{name:'删除主机',exact:true});
 await expect(deletion.locator('[data-batch-target="fixture-machine"]')).toHaveAttribute('data-batch-status','not_applicable');await expect(deletion).toContainText('请先解绑本主机的有效连接凭据');await expect(deletion.getByRole('button',{name:'确认删除主机',exact:true})).toBeDisabled();expect(state.requests.filter(r=>r.method==='DELETE')).toHaveLength(0);await deletion.getByRole('button',{name:'关闭',exact:true}).click();
 await machineRow.getByRole('button',{name:/详\s*情/,exact:true}).click();await expect(page.getByRole('dialog').getByRole('button',{name:'删除主机',exact:true})).toHaveCount(0);mark('Single-host toolbar deletion blocks active credentials and keeps host details free of a duplicate delete action');
 await page.getByRole('button',{name:'取消计划',exact:true}).click();await page.getByRole('button',{name:'确认取消',exact:true}).click();await expect(page.locator('.ant-modal').getByText('cancelled',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'取消计划',exact:true})).toHaveCount(0);mark('An unexecuted expired plan can be cancelled from history without running SSH');
 await page.getByRole('dialog').getByRole('button',{name:/解\s*绑/,exact:true}).click();await page.locator('.ant-popover').getByRole('button',{name:/解\s*绑/,exact:true}).click();await expect(page.getByRole('dialog').getByRole('button',{name:/解\s*绑/,exact:true})).toHaveCount(0);await page.getByRole('dialog').locator('.ant-modal-close').click();
 state.deleteError='';await machineRow.getByRole('checkbox').check();await page.getByRole('region',{name:'批量操作',exact:true}).getByRole('button',{name:'删除主机',exact:true}).click();deletion=page.getByRole('dialog',{name:'删除主机',exact:true});await deletion.getByRole('checkbox',{name:'我已逐项审阅目标、步骤和影响',exact:true}).check();await deletion.getByRole('button',{name:'确认删除主机',exact:true}).click();await expect(deletion.locator('[data-batch-target="fixture-machine"]')).toHaveAttribute('data-batch-status','success');await expect(page.getByText('尚无主机',{exact:true})).toBeVisible();await deletion.getByRole('button',{name:'关闭',exact:true}).click();expect(state.requests.filter(r=>r.method==='DELETE'&&r.path.endsWith('/fixture-machine'))).toHaveLength(1);mark('After cancelling the plan and unlinking the host credentials, the reviewed single-host batch deletes once and refreshes the empty list');
 const en=await harness({language:'en-US'});current=en.page;await en.page.goto(origin+'/machines');
 await en.page.getByRole('button',{name:'Add credential',exact:true}).click();
 await expect(en.page.getByRole('dialog').getByText('6 hours (default)',{exact:true})).toBeVisible();
 await expect(en.page.getByRole('dialog').getByPlaceholder('Enter SSH password',{exact:true})).toBeVisible();
 await en.page.getByRole('button',{name:'Close',exact:true}).click();mark('English credential hints match the same validity and retention behavior');
 await en.page.getByRole('button',{name:'SSH preflight',exact:true}).click();await en.page.getByRole('button',{name:'Run SSH preflight',exact:true}).click();await expect(en.page.getByText('SSH connected; installation checks passed',{exact:true})).toBeVisible();
 await en.page.getByRole('button',{name:'Close',exact:true}).click();await en.page.goto(origin+en.state.plan.review_url);await expect(en.page.getByText('Install the independent systemd Agent service',{exact:true})).toBeVisible();mark('English preflight and saved-plan steps are localized');
 await en.page.getByRole('button',{name:'Close',exact:true}).click();await en.page.goto(origin+'/assistant');await en.page.getByRole('button',{name:/SSH fixture session/}).click();
 await en.page.getByText('SSH installation preflight',{exact:true}).click();await expect(en.page.getByText('SSH connected; installation checks passed',{exact:true})).toBeVisible();await en.page.getByText('Prepare Agent deployment plan',{exact:true}).click();await en.page.getByRole('button',{name:'Review deployment plan',exact:true}).click();await expect(en.page).toHaveURL(origin+en.state.plan.review_url);await expect(en.page.getByText('fixture-plan',{exact:true})).toBeVisible();mark('Assistant tool result links to its exact persisted installation plan');
 await en.page.locator('.ant-modal:visible').screenshot({path:resolve(media,'ssh-plan-ui.png'),animations:'disabled'});
 const member=await harness({role:'member'});current=member.page;await member.page.goto(origin+'/machines');await expect(member.page).toHaveURL(origin+'/machines');await expect(member.page.getByRole('button',{name:'SSH 安装检查',exact:true})).toHaveCount(0);expect(member.state.requests.filter(r=>r.path.startsWith('/api/v1/machines'))).toHaveLength(0);mark('Members cannot load host data or SSH actions');
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({checked,errors,unexpected},null,2)+'\n');
}catch(error){if(current)await current.screenshot({path:resolve(media,'ssh-ui-failure.png'),fullPage:true}).catch(()=>{});console.error({errors,unexpected});throw error}
finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDir,{recursive:true,force:true})}
