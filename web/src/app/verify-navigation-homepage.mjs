import {chromium,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mediaDirectory} from '../../../scripts/qa-artifacts.mjs';

// Exercise the already-built production bundle without contacting a platform.
// Authentication and API responses are stateful fixtures; preferences use the
// actual browser storage and actual application controls, including failure cases.
const origin='http://127.0.0.1:19849';
const publicDirectory=await mkdtemp(resolve(tmpdir(),'lightmoni-homepage-'));
await cp(resolve(import.meta.dirname,'../../../runtime/public'),publicDirectory,{recursive:true});
const output=resolve(import.meta.dirname,'../../../specs/029-navigation-homepage');
await mkdir(output,{recursive:true});
const screenshots=mediaDirectory(output),checked=[],errors=[],unexpected=[],requests=[],contexts=[];
const storageKey=id=>'lightmoni.homepage.'+encodeURIComponent(id);
const mark=value=>{checked.push(value);console.log('PASS '+value)};
const bundleIndex=await readFile(resolve(publicDirectory,'index.html'));
const bundleEntry=String(bundleIndex).match(/src="([^"]+\.js)"/u)?.[1];
const bundle={index_sha256:createHash('sha256').update(bundleIndex).digest('hex'),entry:bundleEntry};
if(bundleEntry)bundle.entry_sha256=createHash('sha256').update(await readFile(resolve(publicDirectory,'.'+bundleEntry))).digest('hex');
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}

async function harness({signedIn=true,account='alice',saved={},storageMode='normal'}={}){
 const actors={
  alice:{id:'homepage-alice',name:'alice',nickname:'Alice',role:'admin'},
  bob:{id:'homepage-bob',name:'bob',nickname:'Bob',role:'admin'},
  member:{id:'homepage-member',name:'member',nickname:'Member',role:'member'},
 };
 const state={actors,account,signedIn};
 const context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'dark',reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(({saved,storageMode})=>{
  const originalGet=Storage.prototype.getItem,originalSet=Storage.prototype.setItem;
  if(!originalGet.call(sessionStorage,'homepage-fixture-initialized')){
   originalSet.call(localStorage,'lightmoni.nav.collapsed','false');
   for(const [key,value] of Object.entries(saved))originalSet.call(localStorage,key,value);
   originalSet.call(sessionStorage,'homepage-fixture-initialized','true');
  }
  if(storageMode==='read-blocked')Storage.prototype.getItem=function(key){if(key.startsWith('lightmoni.homepage.'))throw new Error('fixture read blocked');return originalGet.call(this,key)};
  if(storageMode==='write-blocked')Storage.prototype.setItem=function(key,value){if(key.startsWith('lightmoni.homepage.'))throw new Error('fixture write blocked');return originalSet.call(this,key,value)};
  if(storageMode==='write-dropped')Storage.prototype.setItem=function(key,value){if(key.startsWith('lightmoni.homepage.'))return;return originalSet.call(this,key,value)};
  if(storageMode==='readback-blocked'){
   let blockReads=false;
   Storage.prototype.getItem=function(key){if(key.startsWith('lightmoni.homepage.')&&blockReads)throw new Error('fixture readback blocked');return originalGet.call(this,key)};
   Storage.prototype.setItem=function(key,value){originalSet.call(this,key,value);if(key.startsWith('lightmoni.homepage.'))blockReads=true};
  }
 },{saved,storageMode});
 const config={base_url:'https://models.example/v1',model:'fixture-model',protocol:'openai-chat-completions',has_key:false,enabled:false,max_input_tokens:32000,max_output_tokens:4096,max_steps:8,reasoning_effort:'default',code_tasks_enabled:false};
 const fixtures={
  '/api/v1/setup':{required:false},'/api/v1/auth/providers':[],
  '/api/v1/auth/profile':{nickname:'Fixture',avatar_url:'',phone:'',email:'',feishu_id:'',dingtalk_id:'',wecom_id:''},
  '/api/v1/auth/identities':[],
  '/api/v1/overview':{tables:[],agent_count:0,key_count:0,user_count:3},
  '/api/v1/catalog/tables':[],'/api/v1/machines':[],
  '/api/v1/agents':[],'/api/v1/agent-task-labels':[],'/api/v1/agent-tasks':[],
  '/api/v1/agent-install':{endpoint:origin,endpoints:[],version:'0.1.0',bundles:[],install_url:origin+'/downloads/agent/install.sh',release_url:origin+'/downloads/agent'},
  '/api/v1/agent-enrollments':[],
  '/api/v1/assistant/config':config,'/api/v1/assistant/sessions':{items:[]},
  '/api/v1/logs/saved-searches':[],
  '/api/v1/dashboards':[],
  '/api/v1/ops/overview':{resources:[],agents:[],runs:[],capabilities:{}},
  '/api/v1/alerts/groups':[],'/api/v1/alerts/rules':[],'/api/v1/alerts/tables':[],
  '/api/v1/alerts/instances':[],'/api/v1/alerts/events':[],'/api/v1/alerts/incidents':[],
  '/api/v1/alerts/silences':[],'/api/v1/alerts/responders':[],'/api/v1/alerts/policy-defaults':{},
  '/api/v1/alerts/response-statistics':{users:[],records:[],definition:'',truncated:false},
  '/api/v1/notify/channels':[],'/api/v1/notify/deliveries':[],
  '/api/v1/traces/fixture-trace':{trace_id:'fixture-trace',spans:[],incomplete:false,truncated:false,missing_parents:0,from:'2026-10-27T00:00:00Z',to:'2026-10-28T00:00:00Z'},
 };
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(method+' '+url.href);return route.abort()}
  if(path.startsWith('/api/')){
   requests.push({method,path});
   if(path==='/api/v1/auth/me'&&method==='GET')return state.signedIn?route.fulfill({json:state.actors[state.account]}):route.fulfill({status:401,json:{error:'Sign in required'}});
   if(path==='/api/v1/auth/login'&&method==='POST'){
    const {name}=request.postDataJSON();
    if(!Object.hasOwn(state.actors,name))return route.fulfill({status:401,json:{error:'Unknown fixture account'}});
    state.account=name;state.signedIn=true;return route.fulfill({json:state.actors[name]});
   }
   if(path==='/api/v1/auth/logout'&&method==='POST'){state.signedIn=false;return route.fulfill({json:{ok:true}})}
   if(path==='/api/v1/alerts/claim'&&method==='POST'&&request.postDataJSON().token==='fixture-claim')return route.fulfill({status:410,json:{error:'Fixture claim token intentionally expired; no incident is changed'}});
   if(method==='GET'&&Object.hasOwn(fixtures,path))return route.fulfill({json:fixtures[path]});
   unexpected.push(method+' '+path);return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
  }
  if(method!=='GET'){unexpected.push(method+' '+path);return route.abort()}
  const file=path.startsWith('/assets/')?resolve(publicDirectory,'.'+path):resolve(publicDirectory,'index.html');
  const contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2'}[extname(file)]??'application/octet-stream';
  try{return await route.fulfill({body:await readFile(file),contentType})}catch(error){unexpected.push(error.message);return route.abort()}
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 return {context,page,state};
}

async function destination(page,path){await expect(page).toHaveURL(origin+path);await expect(page.locator('.lm-workspace-header')).toBeVisible()}
async function open(page,path){await page.goto(origin+path);await destination(page,path)}
async function chooseHome(page,label){
 const select=page.getByRole('combobox',{name:'默认首页',exact:true});await select.click();
 const order=['概览','AI 助手','监控大盘','日志探索','告警中心','主机管理','节点助手','网站与运维','数据接入','数据管理','个人设置','管理后台'];
 // Traverse the real keyboard selection so offscreen virtualized options need
 // no forced clicks or DOM writes. This also exercises keyboard accessibility.
 for(let index=0;index<20;index++){
  const active=page.locator('.ant-select-dropdown:visible .ant-select-item-option-active .ant-select-item-option-content');
  const current=await active.count()?await active.innerText():'';
  if(current===label){await select.press('Enter');await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);return}
  await select.press(current&&order.indexOf(current)>order.indexOf(label)?'ArrowUp':'ArrowDown');
 }
 throw new Error('Could not select homepage option '+label);
}
async function selectedHome(page,label){await expect(page.locator('#lm-homepage-settings .ant-select')).toContainText(label)}
async function settings(page){await open(page,'/settings?tab=appearance&section=homepage');await expect(page.getByRole('heading',{name:'默认首页',exact:true})).toBeVisible()}
async function login(page,name='alice'){
 await expect(page.getByRole('heading',{name:'登录监控工作台',exact:true})).toBeVisible();
 await page.getByPlaceholder('管理员或成员用户名',{exact:true}).fill(name);await page.getByPlaceholder('输入密码',{exact:true}).fill('fixture-only-password');
 await page.locator('button[type="submit"]').click();
}
async function logout(page){await page.getByRole('button',{name:/账户菜单:/}).click();await page.getByRole('menuitem',{name:'退出登录',exact:false}).click();await expect(page.locator('.lm-workspace-header')).toHaveCount(0)}
async function relogin(page,expected,name='alice'){await logout(page);await page.goto(origin+'/login');await login(page,name);await destination(page,expected)}
async function screenshot(page,name){await page.mouse.move(0,0);await page.screenshot({path:resolve(screenshots,name+'.png'),fullPage:true,animations:'disabled'})}
function group(page,title){return page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:title,exact:true})}

let currentPage;
try{
 const {context,page,state}=await harness();currentPage=page;
 for(const path of ['/','/login','/not-a-real-page']){await page.goto(origin+path);await destination(page,'/assistant');await expect(page.locator('.lm-assistant-header').getByRole('heading',{name:'AI 助手',exact:true})).toBeVisible()}
 mark('root, authenticated login and unknown paths default to AI assistant');

 await expect(group(page,'工作台')).toHaveAttribute('aria-expanded','true');await expect(group(page,'监控分析')).toHaveAttribute('aria-expanded','false');await expect(group(page,'运维工具')).toHaveAttribute('aria-expanded','false');
 await group(page,'监控分析').click();await group(page,'运维工具').click();
 for(const title of ['工作台','监控分析','运维工具'])await expect(group(page,title)).toHaveAttribute('aria-expanded','true');
 await page.locator('.lm-sidebar').getByRole('link',{name:'节点助手',exact:true}).click();await destination(page,'/agents');
 for(const title of ['工作台','监控分析','运维工具'])await expect(group(page,title)).toHaveAttribute('aria-expanded','true');
 await group(page,'运维工具').click();await expect(group(page,'运维工具')).toHaveAttribute('aria-expanded','false');
 await group(page,'运维工具').focus();await page.keyboard.press('Enter');await expect(group(page,'运维工具')).toHaveAttribute('aria-expanded','true');
 const controls=await group(page,'运维工具').getAttribute('aria-controls');await expect(page.locator('#'+controls)).toBeVisible();
 await page.getByRole('button',{name:'收起导航',exact:true}).click();await expect(page.locator('.lm-shell')).toHaveClass(/is-nav-collapsed/);
 await page.getByRole('button',{name:'展开导航',exact:true}).click();
 for(const title of ['工作台','监控分析','运维工具'])await expect(group(page,title)).toHaveAttribute('aria-expanded','true');
 await expect(group(page,'数据与接入')).toHaveAttribute('aria-expanded','false');await screenshot(page,'navigation-multiple-open-zh-1280');
 mark('independent categories retain multi-open state across routes and whole-sidebar collapse; keyboard and aria controls work');
 await page.goto(origin+'/services');await destination(page,'/operations?tab=service');await expect(page.getByRole('heading',{name:'网站与运维',exact:true})).toBeVisible();await expect(page.locator('.lm-sidebar').getByRole('link',{name:'服务部署',exact:true})).toHaveCount(0);await expect(page.getByRole('tab',{name:/托管服务/})).toHaveAttribute('aria-selected','true');
 mark('the former service-deployment route opens hosted services and the sidebar provides one operations entry');

 await settings(page);await chooseHome(page,'概览');await selectedHome(page,'概览');await expect(page.getByText('默认首页已保存',{exact:true})).toBeVisible();await destination(page,'/settings?tab=appearance&section=homepage');
 expect(await page.evaluate(key=>localStorage.getItem(key),storageKey(state.actors.alice.id))).toBe('/overview');
 await expect(page.locator('.lm-brand')).toHaveAttribute('href','/overview');
 await page.locator('.lm-brand').click();await destination(page,'/overview');await expect(page.getByRole('heading',{name:'监控概览',exact:true})).toBeVisible();
 await page.goto(origin+'/');await destination(page,'/overview');await page.goto(origin+'/login');await destination(page,'/overview');await relogin(page,'/overview');
 mark('choosing Overview saves immediately without leaving settings; brand, root, authenticated login and fresh sign-in use /overview');

 await page.getByRole('button',{name:/账户菜单:/}).click();await page.getByRole('menuitem',{name:/默认首页/}).click();await destination(page,'/settings?tab=appearance&section=homepage');
 await expect(page.getByRole('combobox',{name:'默认首页',exact:true})).toBeFocused();await chooseHome(page,'主机管理');await selectedHome(page,'主机管理');
 await page.goto(origin+'/');await destination(page,'/machines');await relogin(page,'/machines');
 mark('account-menu shortcut focuses Default homepage; choosing Machines controls root and fresh sign-in');

 const deepLinks=[
  ['/logs?keyword=timeout&service=orders','/logs?keyword=timeout&service=orders'],
  ['/agents?tab=tasks&label=fixture','/agents?tab=tasks&label=fixture'],
  ['/agents/install?task=fixture','/agents/install?task=fixture'],
  ['/assistant?conversation=fixture&source=logs','/assistant?conversation=fixture&source=logs'],
  ['/a/fixture-claim?tab=events&from=2026-10-27','/alerts?tab=events&from=2026-10-27&claim=fixture-claim'],
  ['/traces/fixture-trace?from=2026-10-27&to=2026-10-28','/traces/fixture-trace?from=2026-10-27&to=2026-10-28'],
 ];
 for(const [path,expected] of deepLinks){await logout(page);await page.goto(origin+path);await login(page);await destination(page,expected)}
 mark('fresh sign-in preserves logs, nodes, node installation, assistant, alert-claim and trace deep links with their query parameters');

 await relogin(page,'/assistant','bob');await settings(page);await selectedHome(page,'AI 助手');
 await chooseHome(page,'概览');await relogin(page,'/machines','alice');
 expect(await page.evaluate(keys=>keys.map(key=>localStorage.getItem(key)),[storageKey(state.actors.alice.id),storageKey(state.actors.bob.id)])).toEqual(['/machines','/overview']);
 mark('two real fixture login sessions in one browser retain independent account preferences');

 state.actors.alice.role='member';await page.goto(origin+'/');await destination(page,'/assistant');await settings(page);await selectedHome(page,'AI 助手');
 await page.getByRole('combobox',{name:'默认首页',exact:true}).click();
 for(const name of ['主机管理','服务部署','网站与运维','管理后台'])await expect(page.locator('.ant-select-dropdown:visible').getByText(name,{exact:true})).toHaveCount(0);
 await page.keyboard.press('Escape');await expect(page.locator('.lm-sidebar').getByRole('link',{name:'主机管理',exact:true})).toHaveCount(0);
 await page.goto(origin+'/machines');await destination(page,'/settings');
 mark('role downgrade invalidates an administrator homepage and hides unauthorized choices; protected routes remain protected');

 for(const invalid of ['https://evil.invalid/','//evil.invalid/','/overview?unexpected=1','/logs/search','/assistant#fragment','/admin']){
  await page.evaluate(({key,value})=>localStorage.setItem(key,value),{key:storageKey(state.actors.alice.id),value:invalid});
  await page.goto(origin+'/');await destination(page,'/assistant');
 }
 mark('external, query-bearing, fragment, nested and unauthorized stored paths fall back to AI assistant');

 for(const storageMode of ['write-blocked','write-dropped']){
  const fixture=await harness({saved:{[storageKey('homepage-alice')]:'/overview'},storageMode});currentPage=fixture.page;
  await settings(fixture.page);await selectedHome(fixture.page,'概览');await chooseHome(fixture.page,'主机管理');
  await expect(fixture.page.getByText('无法确认默认首页已保存，请检查浏览器存储权限后重试。',{exact:true})).toBeVisible();await selectedHome(fixture.page,'概览');
  expect(await fixture.page.evaluate(key=>localStorage.getItem(key),storageKey('homepage-alice'))).toBe('/overview');
  await expect(fixture.page.getByText('默认首页已保存',{exact:true})).toHaveCount(0);
  await fixture.page.goto(origin+'/');await destination(fixture.page,'/overview');
 }
 mark('throwing and silently dropped storage writes report failure, retain the prior selection and stored default, and never claim success');
 const blocked=await harness({saved:{[storageKey('homepage-alice')]:'/machines'},storageMode:'read-blocked'});currentPage=blocked.page;
 await blocked.page.goto(origin+'/');await destination(blocked.page,'/assistant');await settings(blocked.page);await selectedHome(blocked.page,'AI 助手');
 mark('unreadable browser storage falls back to AI assistant without crashing');
 const readback=await harness({saved:{[storageKey('homepage-alice')]:'/overview'},storageMode:'readback-blocked'});currentPage=readback.page;
 await settings(readback.page);await selectedHome(readback.page,'概览');await chooseHome(readback.page,'主机管理');
 await expect(readback.page.getByText('无法确认默认首页已保存，请检查浏览器存储权限后重试。',{exact:true})).toBeVisible();
 await expect(readback.page.getByText('默认首页已保存',{exact:true})).toHaveCount(0);
 await readback.page.reload();await selectedHome(readback.page,'主机管理');
 await readback.page.goto(origin+'/');await destination(readback.page,'/machines');
 mark('a successful write followed by failed readback reports unconfirmed persistence instead of claiming success or an unchanged setting; reload sees the persisted value');

 state.actors.alice.role='admin';currentPage=page;
 await page.evaluate(key=>localStorage.setItem(key,'/overview'),storageKey('homepage-alice'));await settings(page);
 const peer=await context.newPage();peer.on('pageerror',error=>errors.push(error.message));await peer.goto(origin+'/overview');
 await chooseHome(page,'主机管理');await expect(peer.locator('.lm-brand')).toHaveAttribute('href','/machines');await peer.close();
 await chooseHome(page,'概览');await screenshot(page,'default-homepage-zh-1280');
 await page.getByRole('button',{name:'切换语言',exact:true}).click();await page.getByRole('menuitem',{name:'English',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('lang','en-US');await expect(page.getByRole('heading',{name:'Default homepage',exact:true})).toBeVisible();await expect(page.locator('#lm-homepage-settings .ant-select')).toContainText('Overview');
 await page.getByRole('combobox',{name:'Default homepage',exact:true}).click();await expect(page.locator('.ant-select-dropdown:visible').getByText('AI assistant',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
 await screenshot(page,'default-homepage-en-1280');await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Collapse navigation',exact:true}).click();await page.locator('#lm-homepage-settings').scrollIntoViewIfNeeded();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await screenshot(page,'default-homepage-en-390');
 await page.getByRole('button',{name:'Change language',exact:true}).click();await page.getByRole('menuitem',{name:'简体中文',exact:true}).click();
 await expect(page.getByRole('heading',{name:'默认首页',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await screenshot(page,'default-homepage-zh-390');
 mark('preference changes synchronize across tabs; translated labels and controls fit 1280px and 390px without horizontal page overflow');

 expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 expect(requests.filter(request=>request.method!=='GET'&&!['/api/v1/auth/login','/api/v1/auth/logout','/api/v1/alerts/claim'].includes(request.path))).toEqual([]);
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({production_bundle:true,bundle,api_fixtures:true,stateful_fixture_authentication:true,fixture_claim:'Intentionally expired token; no incident changed',real_browser_storage:true,live_backend:false,production_writes:false,widths:[1280,390],languages:['zh-CN','en-US'],deep_links:deepLinks.map(([path])=>path),checked,errors,unexpected},null,2)+'\n');
 await rm(resolve(screenshots,'navigation-homepage-failure.png'),{force:true});
 console.log(`PASS ${checked.length} navigation and default-homepage scenarios`);
}catch(error){
 await currentPage?.screenshot({path:resolve(screenshots,'navigation-homepage-failure.png'),fullPage:true}).catch(()=>{});
 await writeFile(resolve(output,'ui-report.json'),JSON.stringify({production_bundle:true,bundle,api_fixtures:true,live_backend:false,production_writes:false,checked,failed:String(error),errors,unexpected},null,2)+'\n');throw error;
}finally{for(const context of contexts)await context.close();await browser.close();await rm(publicDirectory,{recursive:true,force:true})}
