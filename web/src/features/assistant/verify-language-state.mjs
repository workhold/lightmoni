import {chromium,expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import {mediaDirectory} from '../../../../scripts/qa-artifacts.mjs';

// Serve the production bundle entirely through Playwright interception. Every
// API response is a fixture; this script never writes to a running platform.
const origin='http://127.0.0.1:19848';
const publicDirectory=resolve(import.meta.dirname,'../../../../runtime/public');
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'specs/016-header-preferences-i18n');
await mkdir(output,{recursive:true});
const screenshots=mediaDirectory(output),checks=[],errors=[],unexpected=[],requests=[];
const mark=check=>{checks.push(check);console.log('PASS '+check)};
const timestamp='2026-10-19T03:00:00Z';
const user={id:'fixture-user',name:'fixture-login',nickname:'业务用户名原文',role:'admin'};
const catalog=[{id:'fixture-log',name:'log_app',kind:'log',services:['payment-api','订单服务'],columns:[{name:'event_time',type:'DateTime64(3)'},{name:'body',type:'String'},{name:'service',type:'String'}]}];
const config={base_url:'https://models.example/v1',model:'fixture-model',protocol:'openai-chat-completions',has_key:false,enabled:true,max_input_tokens:32000,max_output_tokens:4096,max_steps:8,reasoning_effort:'provider-default',code_tasks_enabled:true,code_workspace:'initial-workspace'};
const draft={title:'业务大盘原文',panels:[{id:'fixture-panel',title:'业务图表原文',type:'stat',queries:[{refId:'A',sql:'SELECT 1 AS value'}]}]};
const event=(sequence,type,data)=>({sequence,session_id:'fixture-session',turn_id:'fixture-turn',type,timestamp,data});
const session={id:'fixture-session',title:'业务会话原文',user_id:user.id,created_at:timestamp,updated_at:timestamp,messages:[],events:[
 event(0,'user.message',{text:'原始提问不翻译'}),
 event(1,'tool.call',{call_id:'fixture-draft',tool:'draft_dashboard',input:{}}),
 event(2,'tool.result',{call_id:'fixture-draft',status:'success',value:{draft}}),
 event(3,'assistant.message',{text:'模型生成原文不翻译'}),event(4,'turn.completed',{}),
]};
const fixtures={
 '/auth/me':user,'/overview':{tables:catalog,agent_count:1,key_count:1,user_count:1},
 '/catalog/tables':catalog,'/assistant/config':config,'/assistant/sessions':{items:[session]},'/assistant/sessions/fixture-session':session,
 '/alerts/groups':[],'/alerts/rules':[],'/alerts/tables':[],'/alerts/instances':[],'/alerts/events':[],
 '/notify/channels':[],'/notify/deliveries':[],'/dashboards':[],
};
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const context=await browser.newContext({viewport:{width:1280,height:1000},reducedMotion:'reduce'});
await context.addInitScript(()=>{localStorage.setItem('lightmoni.nav.collapsed','true')});
async function intercept(route,{authenticated=true,setup=false}={}){
 const request=route.request(),url=new URL(request.url());
 if(url.origin!==origin){unexpected.push(request.method()+' '+url.href);return route.abort()}
 if(url.pathname.startsWith('/api/')){
  const path=url.pathname.replace('/api/v1','');requests.push({method:request.method(),path});
  if(request.method()==='GET'&&path==='/auth/me'&&!authenticated)return route.fulfill({status:401,json:{error:'Sign in required'}});
  if(request.method()==='GET'&&path==='/setup')return route.fulfill({json:{required:setup}});
  if(request.method()==='GET'&&path==='/auth/providers')return route.fulfill({json:[]});
  if(request.method()==='GET'&&Object.hasOwn(fixtures,path))return route.fulfill({json:fixtures[path]});
  unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
 }
 if(request.method()!=='GET'){unexpected.push(request.method()+' '+url.pathname);return route.abort()}
 const file=url.pathname.startsWith('/assets/')?resolve(publicDirectory,'.'+url.pathname):resolve(publicDirectory,'index.html');
 const contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2'}[extname(file)]??'application/octet-stream';
 try{return await route.fulfill({body:await readFile(file),contentType})}catch(error){unexpected.push(error.message);return route.abort()}
}
await context.route('**/*',route=>intercept(route));
const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
async function language(next,{crossTab=false}={}){
 if(crossTab){
  // A real storage event is how a preference change in another tab reaches an
  // open dialog. It also allows us to verify state behind a modal mask.
  await page.evaluate(value=>{localStorage.setItem('lightmoni.language',value);window.dispatchEvent(new StorageEvent('storage',{key:'lightmoni.language',newValue:value}))},next);
 }else{
  const current=await page.locator('html').getAttribute('lang');
  await page.getByRole('button',{name:current==='en-US'?'Change language':'切换语言',exact:true}).click();
  await page.getByRole('menuitem',{name:next==='en-US'?'English':'简体中文',exact:true}).click();
 }
 await expect(page.locator('html')).toHaveAttribute('lang',next);
}
async function choose(select,option,targetPage=page){await select.click();await targetPage.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText(option,{exact:true}).click()}
async function overflowElements(targetPage){return targetPage.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].flatMap(element=>{const box=element.getBoundingClientRect(),style=getComputedStyle(element);return box.width>0&&box.right>innerWidth+1&&style.visibility==='visible'?[{tag:element.tagName,class:typeof element.className==='string'?element.className:'',left:box.left,right:box.right,width:box.width}]:[]}).slice(0,15)}))}
async function assertAssistantInputs(panel,prompt,workspace){
 await expect(panel.locator('.lm-assistant-composer textarea')).toHaveValue(prompt);
 await expect(panel.locator('.lm-assistant-code-workspace input')).toHaveValue(workspace);
 await expect(panel.locator('.lm-assistant-context .ant-select').nth(0)).toContainText('log_app');
 await expect(panel.locator('.lm-assistant-context .ant-select').nth(1)).toContainText('订单服务');
}
async function verifyLoginForms(){
 for(const setup of [false,true]){
  const loginContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await loginContext.route('**/*',route=>intercept(route,{authenticated:false,setup}));
  const login=await loginContext.newPage();login.setDefaultTimeout(15000);login.on('pageerror',error=>errors.push(error.message));
  try{
   await login.goto(origin+'/settings');
   await expect(login.getByRole('heading',{name:setup?'创建监控工作台':'登录监控工作台',exact:true})).toBeVisible();
   const form=login.locator('form');
   await form.getByRole('textbox',{name:/用户名$/}).fill('业务用户名草稿');
   if(setup)await form.getByLabel(/密码$/).fill('short');
   await form.locator('button[type=submit]').click();
   await expect(form).toContainText(setup?'密码至少8位':'请输入密码');
   const beforeLogin=requests.length;
   await choose(login.getByRole('combobox',{name:'显示语言',exact:true}),'English',login);
   await expect(login.locator('html')).toHaveAttribute('lang','en-US');
   await expect(login.getByRole('heading',{name:setup?'Create your monitoring workspace':'Sign in to your monitoring workspace',exact:true})).toBeVisible();
   await expect(form.getByRole('textbox',{name:/Username$/})).toHaveValue('业务用户名草稿');
   await expect(form.getByLabel(/Password$/)).toHaveValue(setup?'short':'');
   await expect(form).toContainText(setup?'Password must be at least 8 characters':'Enter your password');
   await expect(form.getByText(setup?'密码至少8位':'请输入密码',{exact:true})).not.toBeVisible();
   await expect.poll(()=>login.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),{timeout:5000}).toBe(true);
   await login.screenshot({path:resolve(screenshots,`${setup?'setup':'login'}-language-state-390.png`),fullPage:true});
   if(!setup)await form.getByLabel(/Password$/).fill('fixture-only-draft');
   await choose(login.getByRole('combobox',{name:'Display language',exact:true}),'简体中文',login);
   await expect(login.locator('html')).toHaveAttribute('lang','zh-CN');
   await expect(form.getByRole('textbox',{name:/用户名$/})).toHaveValue('业务用户名草稿');
   await expect(form.getByLabel(/密码$/)).toHaveValue(setup?'short':'fixture-only-draft');
   if(setup){await expect(form).toContainText('密码至少8位');await expect(form.getByText('Password must be at least 8 characters',{exact:true})).not.toBeVisible()}
   expect(requests.length).toBe(beforeLogin);
   expect(await login.locator('.lm-workspace-header').count()).toBe(0);
   mark(`${setup?'initial setup':'sign-in'} language control translates validation while retaining form drafts at 390px without requests or account header`);
  }catch(error){
   await login.screenshot({path:resolve(screenshots,`${setup?'setup':'login'}-language-state-failure.png`),fullPage:true});
   console.error(JSON.stringify(await overflowElements(login)));throw error;
  }finally{await loginContext.close()}
 }

}
try{
 await verifyLoginForms();
 await page.goto(origin+'/');await page.getByRole('button',{name:'打开 AI 助手',exact:true}).click();
 const compact=page.locator('.ant-drawer .lm-assistant.is-compact');
 await expect(compact.locator('.lm-assistant-code-workspace input')).toHaveValue('initial-workspace');
 await choose(compact.locator('.lm-assistant-context .ant-select').nth(0),'log_app');
 await choose(compact.locator('.lm-assistant-context .ant-select').nth(1),'订单服务');
 await compact.locator('.lm-assistant-composer textarea').fill('抽屉中的提问草稿');
 await compact.locator('.lm-assistant-code-workspace input').fill('draft-workspace/不翻译');
 const beforeDrawer=requests.length;
 await language('en-US',{crossTab:true});
 await assertAssistantInputs(compact,'抽屉中的提问草稿','draft-workspace/不翻译');
 await expect(compact.locator('.lm-assistant-page-context')).toContainText('Overview');
 expect(requests.length).toBe(beforeDrawer);
 await language('zh-CN',{crossTab:true});
 await assertAssistantInputs(compact,'抽屉中的提问草稿','draft-workspace/不翻译');
 mark('assistant drawer retains question, table, service and workspace on both language switches; context title translates without API requests');

 await page.goto(origin+'/assistant');
 const assistant=page.locator('.lm-assistant');
 await expect(assistant.locator('.lm-assistant-code-workspace input')).toHaveValue('initial-workspace');
 await choose(assistant.locator('.lm-assistant-context .ant-select').nth(0),'log_app');
 await choose(assistant.locator('.lm-assistant-context .ant-select').nth(1),'订单服务');
 await choose(assistant.locator('.lm-assistant-context .ant-select').nth(2),'最近 6 小时');
 await assistant.locator('.lm-assistant-composer textarea').fill('全页提问草稿');
 await assistant.locator('.lm-assistant-code-workspace input').fill('scripts/custom-draft');
 const beforePage=requests.length;
 await language('en-US');
 await assertAssistantInputs(assistant,'全页提问草稿','scripts/custom-draft');
 await expect(assistant.locator('.lm-assistant-context .ant-select').nth(2)).toContainText('Last 6 hours');
 expect(requests.length).toBe(beforePage);
 await language('zh-CN');
 await assertAssistantInputs(assistant,'全页提问草稿','scripts/custom-draft');
 mark('full assistant retains query draft, selected scope, lookback and workspace through the visible language menu');

 await assistant.locator('.lm-assistant-session').getByText('业务会话原文',{exact:true}).click();
 await expect(assistant).toContainText('模型生成原文不翻译');
 await assistant.locator('.lm-assistant-tools .ant-collapse-header').click();
 await assistant.getByRole('button',{name:'审阅大盘草稿',exact:true}).click();
 const dashboard=page.locator('.ant-modal:visible');
 await dashboard.locator('.lm-assistant-draft>label input').fill('修改后的业务大盘草稿');
 await dashboard.locator('.lm-assistant-draft-panel-title > input').fill('修改后的图表名称');
 await dashboard.locator('.lm-assistant-draft-query textarea').fill('SELECT 42 AS value -- 业务 SQL 不翻译');
 const beforeDraft=requests.length;
 await language('en-US',{crossTab:true});
 await expect(dashboard).toContainText('Dashboard name');
 await expect(dashboard.locator('.lm-assistant-draft>label input')).toHaveValue('修改后的业务大盘草稿');
 await expect(dashboard.locator('.lm-assistant-draft-panel-title > input')).toHaveValue('修改后的图表名称');
 await expect(dashboard.locator('.lm-assistant-draft-query textarea')).toHaveValue('SELECT 42 AS value -- 业务 SQL 不翻译');
 expect(requests.length).toBe(beforeDraft);
 await language('zh-CN',{crossTab:true});
 await expect(dashboard.locator('.lm-assistant-draft>label input')).toHaveValue('修改后的业务大盘草稿');
 await page.screenshot({path:resolve(screenshots,'assistant-draft-language-state-1280.png'),fullPage:true});
 mark('dashboard draft title, panel title and SQL survive both language switches; model-generated content stays unchanged');

 await page.goto(origin+'/alerts');await page.getByRole('button',{name:'创建告警规则',exact:true}).click();
 const rule=page.locator('.ant-modal:visible');
 await rule.getByRole('textbox',{name:'规则名称',exact:true}).fill('告警草稿业务原文');
 await rule.getByRole('textbox',{name:'告警固定参数',exact:true}).fill('{"note":{"type":"String","value":"原始参数"}}');
 await rule.getByRole('textbox',{name:'告警阈值',exact:true}).fill('12.5');
 await choose(rule.getByRole('combobox',{name:'告警服务范围',exact:true}),'订单服务');
 await rule.getByRole('textbox',{name:'规则名称',exact:true}).click();
 const beforeRule=requests.length;
 await language('en-US',{crossTab:true});
 await expect(rule).toContainText('Rule name');
 await expect(rule.getByRole('textbox',{name:'Rule name',exact:true})).toHaveValue('告警草稿业务原文');
 await expect(rule.getByRole('textbox',{name:'Alert fixed parameters',exact:true})).toHaveValue('{"note":{"type":"String","value":"原始参数"}}');
 await expect(rule.getByRole('textbox',{name:'Alert threshold',exact:true})).toHaveValue('12.5');
 await expect(rule.locator('.ant-select').filter({has:page.getByRole('combobox',{name:'Alert service scope',exact:true})})).toContainText('订单服务');
 expect(requests.length).toBe(beforeRule);
 await language('zh-CN',{crossTab:true});
 await expect(rule.getByRole('textbox',{name:'规则名称',exact:true})).toHaveValue('告警草稿业务原文');
 await expect(rule.getByRole('textbox',{name:'告警阈值',exact:true})).toHaveValue('12.5');
 await page.setViewportSize({width:390,height:844});
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),{timeout:5000}).toBe(true);
 await page.screenshot({path:resolve(screenshots,'alert-rule-language-state-390.png'),fullPage:true});
 mark('alert editor preserves rule name, typed parameters, threshold and service selection without requests or narrow-screen overflow');


 expect(requests.filter(request=>request.method!=='GET')).toEqual([]);
 expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 await writeFile(resolve(output,'language-state-report.json'),JSON.stringify({production_bundle:true,api_fixtures:true,live_backend:false,checks,writes:0,errors,unexpected},null,2)+'\n');
}catch(error){
 await page.screenshot({path:resolve(screenshots,'language-state-failure.png'),fullPage:true}).catch(()=>{});
 await writeFile(resolve(output,'language-state-report.json'),JSON.stringify({production_bundle:true,api_fixtures:true,checks,failed:String(error),overflow:await overflowElements(page),errors,unexpected},null,2)+'\n');
 throw error;
}finally{await context.close();await browser.close()}
