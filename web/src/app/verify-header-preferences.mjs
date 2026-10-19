import {chromium,expect} from '@playwright/test';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// Run the production bundle with isolated stateful API fixtures. No requests
// reach a running platform, and no real account or preference is modified.
const origin='http://127.0.0.1:19847',publicDirectory=await mkdtemp(resolve(tmpdir(),'lightmoni-header-'));
// Keep all pages on one build even if a local development build starts later.
await cp(resolve(import.meta.dirname,'../../../runtime/public'),publicDirectory,{recursive:true});
const output=resolve(process.env.LIGHTMONI_QA_OUTPUT??'specs/016-header-preferences-i18n');
await mkdir(output,{recursive:true});
const screenshots=mediaDirectory(output),checked=[],errors=[],unexpected=[],requests=[],contexts=[];
const mark=value=>{checked.push(value);console.log('PASS '+value)};
const stats={requests:0,input_tokens:0,output_tokens:0,total_tokens:0,input_missing:0,output_missing:0,total_missing:0,succeeded_requests:0,failed_requests:0,cancelled_requests:0,pending_requests:0,unknown_status_requests:0,estimated_costs:[],unpriced_requests:0,partial_priced_requests:0};
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}

async function harness({role='admin',blockedStorage=false,invalidStorage=false}={}) {
 const state={user:{id:'fixture-user',name:'fixture-login',nickname:'Fixture display name',role},profile:{nickname:'Fixture display name',avatar_url:'',phone:'',email:'',feishu_id:'',dingtalk_id:'',wecom_id:''},logoutFails:true};
 const context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'dark',reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(({blockedStorage,invalidStorage})=>{
  if(blockedStorage){Storage.prototype.getItem=()=>{throw new Error('fixture storage blocked')};Storage.prototype.setItem=()=>{throw new Error('fixture storage blocked')};return}
  // Set each value once, so reloads exercise persisted preferences.
  if(!sessionStorage.getItem('header-qa-initialized')){
   localStorage.setItem('lightmoni.nav.collapsed','true');
   if(invalidStorage){localStorage.setItem('lightmoni.appearance','invalid');localStorage.setItem('lightmoni.accent','invalid');localStorage.setItem('lightmoni.language','invalid')}
   sessionStorage.setItem('header-qa-initialized','true');
  }
 },{blockedStorage,invalidStorage});
 const config={base_url:'https://models.example/v1',model:'fixture-model',protocol:'openai-chat-completions',has_key:false,enabled:false,max_input_tokens:32000,max_output_tokens:4096,max_steps:8,reasoning_effort:'default',code_tasks_enabled:false};
 const packages=[['typescript','TypeScript / Node.js'],['python','Python'],['ruby','Ruby']].map(([id,language])=>({id,language,runtime:language,url:origin+'/downloads/'+id+'.tgz',available:true}));
 const fixtures={
  '/api/v1/setup':{required:false},'/api/v1/auth/providers':[], '/api/v1/auth/identities':[],
  '/api/v1/overview':{tables:[],agent_count:0,key_count:0,user_count:1},
  '/api/v1/catalog/tables':[], '/api/v1/keys':[], '/api/v1/agent-enrollments':[], '/api/v1/agent-credentials':[],
  '/api/v1/users':[], '/api/v1/settings/login-providers':[], '/api/v1/settings/instance':{external_url:origin},
  '/api/v1/settings/reporting':{endpoint:origin,endpoints:[],default_endpoint_id:''}, '/api/v1/settings/retention':{default_days:7},
  '/api/v1/sdk-install':{endpoint:origin,endpoints:[],packages,deferred:[{id:'go',language:'Go'},{id:'rust',language:'Rust'}]},
  '/api/v1/agent-install':{endpoint:origin,endpoints:[],version:'0.1.0',bundles:[],install_url:origin+'/downloads/agent/install.sh',release_url:origin+'/downloads/agent'},
  '/api/v1/agents':[], '/api/v1/agent-task-labels':[], '/api/v1/agent-tasks':[], '/api/v1/machines':[],
  '/api/v1/dashboards':[], '/api/v1/templates':[], '/api/v1/logs/saved-searches':[],
  '/api/v1/alerts/groups':[], '/api/v1/alerts/rules':[], '/api/v1/alerts/tables':[], '/api/v1/alerts/instances':[], '/api/v1/alerts/events':[],
  '/api/v1/notify/channels':[], '/api/v1/notify/deliveries':[], '/api/v1/alerts/incidents':[], '/api/v1/alerts/silences':[], '/api/v1/alerts/responders':[],
  '/api/v1/alerts/policy-defaults':{}, '/api/v1/settings/alert-directory-sources':[],
  '/api/v1/alerts/response-statistics':{users:[],records:[],definition:'',truncated:false},
  '/api/v1/traces/fixture-trace':{trace_id:'fixture-trace',spans:[],incomplete:false,truncated:false,missing_parents:0,from:'2026-10-19T00:00:00Z',to:'2026-10-20T00:00:00Z'},
  '/api/v1/assistant/config':config, '/api/v1/assistant/sessions':{items:[]},
  '/api/v1/assistant/billing':{currency:'CNY',input_price_per_million:0,output_price_per_million:0},
  '/api/v1/assistant/usage':{totals:stats,daily:[],models:[],sources:[],from:'2026-09-20',to:'2026-10-20',days:30,timezone:'UTC'},
  '/api/v1/assistant/usage/details':{records:[],limit:20,has_more:false,from:'2026-09-20',to:'2026-10-20',timezone:'UTC'},
 };
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(method+' '+url.href);return route.abort()}
  if(path.startsWith('/api/')){
   const body=request.postData()?request.postDataJSON():undefined;requests.push({method,path,body});
   if(method==='GET'&&path==='/api/v1/auth/me')return route.fulfill({json:state.user});
   if(method==='GET'&&path==='/api/v1/auth/profile')return route.fulfill({json:state.profile});
   if(method==='PUT'&&path==='/api/v1/auth/profile'){state.profile={...state.profile,...body};state.user={...state.user,nickname:state.profile.nickname,avatar_url:state.profile.avatar_url};return route.fulfill({json:state.profile})}
   if(method==='POST'&&path==='/api/v1/auth/logout')return state.logoutFails?route.fulfill({status:503,json:{error:'fixture sign-out failure'}}):route.fulfill({json:{ok:true}});
   if(method==='GET'&&Object.hasOwn(fixtures,path))return route.fulfill({json:fixtures[path]});
   unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
  }
  if(method!=='GET'){unexpected.push(method+' '+path);return route.abort()}
  const file=path.startsWith('/assets/')?resolve(publicDirectory,'.'+path):resolve(publicDirectory,'index.html');
  const contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2'}[extname(file)]??'application/octet-stream';
  try{return await route.fulfill({body:await readFile(file),contentType})}catch(error){unexpected.push(error.message);return route.abort()}
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return {context,page,state};
}
async function changeLanguage(page,value){
 const language=await page.locator('html').getAttribute('lang');
 await page.getByRole('button',{name:language==='en-US'?'Change language':'切换语言',exact:true}).click();
 await page.getByRole('menuitem',{name:value==='en-US'?'English':'简体中文',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('lang',value);
}
async function choose(page,label,option){await page.getByRole('combobox',{name:label,exact:true}).click();await page.locator('.ant-select-dropdown:visible').getByText(option,{exact:true}).click()}
async function screenshot(page,name){await page.mouse.move(0,0);await page.screenshot({path:resolve(screenshots,name+'.png'),fullPage:true,animations:'disabled'})}
async function noOverflow(page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}
async function remainingChinese(page){
 return page.locator('.lm-route-content').evaluate(root=>{
  const found=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){
   const node=walker.currentNode,parent=node.parentElement;
   if(!parent||parent.closest('pre,code,textarea,input,.x-markdown,.monaco-editor')||!parent.checkVisibility({visibilityProperty:true,opacityProperty:true}))continue;
   const value=node.textContent.trim().replaceAll('简体中文','');if(/[\u4e00-\u9fff]/.test(value))found.push(value);
  }
  return [...new Set(found)];
 });
}

let currentPage;
try{
 const {context,page,state}=await harness();currentPage=page;
 await page.goto(origin+'/settings');await expect(page.getByRole('heading',{name:'个人设置',exact:true})).toBeVisible();
 const header=page.getByRole('banner',{name:'工作台顶部栏'});
 await expect(header).toContainText('Fixture display name');await expect(header).toContainText('管理员');
 await expect(page.locator('.lm-sidebar .lm-avatar,.lm-sidebar-profile,.lm-sidebar-bottom')).toHaveCount(0);
 const account=header.getByRole('button',{name:/账户菜单/});const bounds=await account.boundingBox();expect(bounds.y).toBeLessThan(80);expect(bounds.x).toBeGreaterThan(640);
 mark('account name and role are visible at top right, without a sidebar duplicate');

 await page.getByRole('textbox',{name:'昵称',exact:true}).fill('Unsubmitted 草稿');
 await changeLanguage(page,'en-US');await expect(page.getByRole('heading',{name:'Personal settings',exact:true})).toBeVisible();
 await expect(page.getByRole('textbox',{name:'Display name',exact:true})).toHaveValue('Unsubmitted 草稿');
 expect(requests.filter(item=>item.method!=='GET')).toEqual([]);
 mark('language changes live while retaining profile draft and without write requests');
 await page.getByRole('textbox',{name:'Display name',exact:true}).fill('Updated fixture name');await page.getByRole('button',{name:'Save profile',exact:true}).click();
 await expect(page.locator('.lm-account-summary')).toContainText('Updated fixture name');
 expect(requests.find(item=>item.method==='PUT').body).not.toHaveProperty('language');
 mark('saved profile updates the top account name immediately');

 await page.goto(origin+'/settings?tab=appearance');await expect(page.getByRole('heading',{name:'Interface preferences',exact:true})).toBeVisible();
 await choose(page,'Theme','Light');await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await page.getByRole('button',{name:'Violet',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-accent','violet');
 const accent=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--lm-accent').trim());expect(accent).toBe('#6d28d9');
 await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','en-US');await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(page.locator('html')).toHaveAttribute('data-accent','violet');
 await screenshot(page,'preferences-light-en-1280');
 mark('light theme and accent apply to the interface and survive reload with language');
 await choose(page,'Theme','System');await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await choose(page,'Theme','Dark');await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 mark('system theme follows OS changes, while explicit dark stays selected');

 await page.getByRole('button',{name:'Appearance',exact:true}).click();const quick=page.locator('.ant-popover:visible').getByRole('region',{name:'Interface preferences'});
 await expect(quick).toBeVisible();
 await quick.getByRole('button',{name:'Teal',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-accent','teal');
 await screenshot(page,'quick-appearance-en-1280');
 await page.getByRole('button',{name:'Appearance',exact:true}).click();await expect(page.locator('.ant-popover:visible')).toHaveCount(0);
 mark('top appearance shortcut uses the same preference state');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.getByRole('button',{name:'Appearance',exact:true}).click();await expect(quick).toBeVisible();await quick.getByRole('button',{name:'Orange',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-accent','orange');
 await page.getByRole('button',{name:'Appearance',exact:true}).click();await page.emulateMedia({reducedMotion:'reduce'});
 mark('header popup controls work with both normal and reduced motion');

 const peer=await context.newPage();peer.on('pageerror',error=>errors.push(error.message));await peer.goto(origin+'/settings?tab=appearance');
 await changeLanguage(page,'zh-CN');await expect(peer.locator('html')).toHaveAttribute('lang','zh-CN');await changeLanguage(page,'en-US');await expect(peer.locator('html')).toHaveAttribute('lang','en-US');
 await page.getByRole('button',{name:'Violet',exact:true}).first().click();await expect(peer.locator('html')).toHaveAttribute('data-accent','violet');await peer.close();
 mark('language and accent synchronize across tabs in the same browser');

 const routes=process.env.LIGHTMONI_QA_HEADER_ONLY?[]:['/','/dashboards','/logs','/alerts',...['Alert group','Alert response','Response statistics','Silence windows','Alert data tables','Events and delivery history'].map(tab=>({path:'/alerts',tab})),'/traces/fixture-trace','/agents','/agents?tab=tasks','/agents?tab=labels','/machines','/data','/data?tab=agent','/data-management','/assistant','/settings?tab=profile','/settings?tab=appearance','/settings?tab=bindings','/admin?tab=users','/admin?tab=login','/admin?tab=models','/admin?tab=reporting','/admin?tab=credentials&section=sdk','/admin?tab=credentials&section=enrollments','/admin?tab=credentials&section=agents','/admin?tab=notifications','/admin?tab=directory','/admin?tab=retention','/admin?tab=alerts'];
 const routeResults=[];
 for(const route of routes){
  const path=typeof route==='string'?route:route.path;
  await page.goto(origin+path);await expect(page.locator('.lm-workspace-header')).toBeVisible();await page.waitForLoadState('networkidle');
  if(typeof route!=='string'){await page.getByRole('tab',{name:route.tab,exact:true}).click();await page.waitForLoadState('networkidle')}
  const remaining=await remainingChinese(page);routeResults.push({path,tab:typeof route==='string'?undefined:route.tab,remaining});
 }
 await writeFile(resolve(output,'route-translation-report.json'),JSON.stringify(routeResults,null,2)+'\n');
 expect(routeResults.filter(item=>item.remaining.length)).toEqual([]);
 if(routes.length)mark(`${routes.length} application routes render their fixed visible interface in English`);

 state.user.nickname='A very long display name that should stay readable through the account menu';
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:900});await page.goto(origin+'/settings?tab=appearance');await expect(page.locator('.lm-account-summary')).toContainText(state.user.nickname);await noOverflow(page);
  await screenshot(page,`preferences-dark-en-${width}`);
  await changeLanguage(page,'zh-CN');await noOverflow(page);await screenshot(page,`preferences-dark-zh-${width}`);await changeLanguage(page,'en-US');
  await page.getByRole('button',{name:'Expand navigation',exact:true}).click();await noOverflow(page);await screenshot(page,`navigation-expanded-en-${width}`);
  expect(await page.locator('.lm-brand').evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+24))})).toBe(true);
  await page.getByRole('button',{name:'Collapse navigation',exact:true}).click();
 }
 mark('both languages, long account names and appearance controls fit desktop and 390px');

 const member=await harness({role:'member',invalidStorage:true});currentPage=member.page;
 await member.page.goto(origin+'/settings?tab=appearance');await expect(member.page.locator('html')).toHaveAttribute('lang','zh-CN');await expect(member.page.locator('html')).toHaveAttribute('data-theme','dark');await expect(member.page.locator('html')).toHaveAttribute('data-accent','blue');
 await expect(member.page.locator('.lm-account-summary')).toContainText('成员');await expect(member.page.locator('.lm-sidebar').getByRole('link',{name:'管理后台',exact:true})).toHaveCount(0);
 mark('invalid stored preferences fall back safely and member permissions remain unchanged');

 const blocked=await harness({blockedStorage:true});currentPage=blocked.page;
 await blocked.page.goto(origin+'/settings?tab=appearance');await changeLanguage(blocked.page,'en-US');await choose(blocked.page,'Theme','Light');await blocked.page.getByRole('button',{name:'Orange',exact:true}).click();
 await expect(blocked.page.locator('html')).toHaveAttribute('data-theme','light');await expect(blocked.page.locator('html')).toHaveAttribute('data-accent','orange');
 mark('preferences remain usable when browser storage is blocked');

 currentPage=page;await page.getByRole('button',{name:/Account menu/}).click();await page.getByRole('menuitem',{name:'Sign out',exact:false}).click();
 await expect(page.getByText('fixture sign-out failure',{exact:true})).toBeVisible();await expect(page.locator('.lm-account-summary')).toBeVisible();
 state.logoutFails=false;await page.getByRole('button',{name:/Account menu/}).click();await page.getByRole('menuitem',{name:'Sign out',exact:false}).click();
 await expect(page.locator('.lm-workspace-header')).toHaveCount(0);await expect(page.getByRole('heading',{name:'Sign in to your monitoring workspace',exact:true})).toBeVisible();
 mark('sign-out errors preserve the session and successful sign-out shows the login page');

 expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({production_bundle:true,api_fixtures:true,stateful_fixture_writes:true,live_backend:false,checked,widths:[1280,390],languages:['zh-CN','en-US'],routes:routes.length,errors,unexpected},null,2)+'\n');
 console.log(`PASS ${checked.length} header, theme and language scenarios`);
}catch(error){await currentPage?.screenshot({path:resolve(screenshots,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(output,'ui-report.json'),JSON.stringify({production_bundle:true,api_fixtures:true,checked,failed:String(error),errors,unexpected},null,2)+'\n');throw error}
finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDirectory,{recursive:true,force:true})}
