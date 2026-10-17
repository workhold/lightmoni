/**
 * Real UI + Node API smoke test; no interception, mocks, model requests, or writes
 * except fixture login. Reuses the repository's existing Playwright installation.
 * Run: node runtime/test/helpers/browser-live.mjs
 */
import {chromium,expect} from '../../../web/node_modules/@playwright/test/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const base=process.env.LIGHTMONI_NODE_QA_URL??'http://127.0.0.1:18885';
const output=resolve(process.env.LIGHTMONI_BROWSER_EVIDENCE_DIR??join(root,'.local-dev','node-browser-live-'+new Date().toISOString().replace(/[:.]/g,'-')));
const account={name:process.env.LIGHTMONI_NODE_QA_USER??'node-qa-admin',password:process.env.LIGHTMONI_NODE_QA_PASSWORD??'node-qa-password-123'};
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname)||new URL(base).port==='8080')throw Error('Use the isolated local Node QA server; never the original Go service');
await mkdir(output,{recursive:true,mode:0o700});
const evidence={checked_at:new Date().toISOString(),base,interception_used:false,pages:[],api_responses:[],page_errors:[],http_500:[],request_failures:[],external_requests:[],passed:false};
let browser,context,page;const origin=new URL(base).origin;
try{
 try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
 context=await browser.newContext({viewport:{width:1440,height:1050},timezoneId:'Asia/Shanghai'});context.setDefaultTimeout(15000);page=await context.newPage();
 page.on('pageerror',e=>evidence.page_errors.push(e.message));
 page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin)evidence.external_requests.push({method:request.method(),origin:url.origin,path:url.pathname});});
 page.on('response',response=>{const url=new URL(response.url());if(url.pathname.startsWith('/api/'))evidence.api_responses.push({method:response.request().method(),path:url.pathname,status:response.status()});if(response.status()>=500)evidence.http_500.push({path:url.pathname,status:response.status()});});
 page.on('requestfailed',request=>{if(!request.failure()?.errorText?.includes('ERR_ABORTED'))evidence.request_failures.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText});});
 await page.goto(base+'/',{waitUntil:'domcontentloaded'});await expect(page.getByRole('heading',{name:'登录监控工作台',exact:true})).toBeVisible();await page.getByLabel('用户名',{exact:true}).fill(account.name);await page.getByLabel('密码',{exact:true}).fill(account.password);
 const [login]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/auth/login'&&r.request().method()==='POST'),page.getByRole('button',{name:/登\s*录/}).click()]);if(login.status()!==200)throw Error('Fixture login failed');await expect(page.getByRole('heading',{name:'监控概览',exact:true})).toBeVisible();
 const pages=[
  {name:'overview',path:'/',heading:'监控概览',api:'/api/v1/overview'},
  {name:'dashboards',path:'/dashboards',heading:'监控大盘',api:'/api/v1/dashboards'},
  {name:'logs',path:'/logs',heading:'日志探索',api:'/api/v1/catalog/tables'},
  {name:'alerts',path:'/alerts',heading:'告警与通知',api:'/api/v1/alerts/groups'},
  {name:'agents',path:'/agents',heading:'节点助手',api:'/api/v1/agents'},
  {name:'models',path:'/admin?tab=models',heading:'管理后台',api:'/api/v1/assistant/config'},
  {name:'assistant',path:'/assistant',heading:'AI 助手',api:'/api/v1/assistant/sessions'},
 ];
 for(const item of pages){
  const start=evidence.api_responses.length;
  await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===item.api&&r.status()===200),page.goto(base+item.path,{waitUntil:'domcontentloaded'})]);await expect(page.getByRole('heading',{name:item.heading,exact:true}).first()).toBeVisible();await page.waitForLoadState('networkidle',{timeout:10000});
  if(item.name==='models'){await expect(page.getByRole('tab',{name:'模型管理',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByText('API Key',{exact:true}).first()).toBeVisible();}
  if(item.name==='assistant')await expect(page.getByRole('textbox',{name:'给 AI 助手的问题'})).toBeVisible();
  if(item.name==='agents')await expect(page.getByRole('tab',{name:'任务管理',exact:true})).toBeVisible();
  const errors=await page.locator('.ant-alert-error:visible').count();if(errors)throw Error(item.name+' rendered an error alert');
  const screenshot=item.name+'.png';await page.screenshot({path:join(output,screenshot),fullPage:true,animations:'disabled'});
  evidence.pages.push({name:item.name,path:item.path,rendered:true,api_responses:evidence.api_responses.length-start,error_alerts:errors,screenshot});
 }
 evidence.passed=evidence.pages.length===pages.length&&evidence.page_errors.length===0&&evidence.http_500.length===0&&evidence.request_failures.length===0&&evidence.external_requests.length===0;if(!evidence.passed)process.exitCode=1;
}catch(error){evidence.failure=error instanceof Error?error.message:String(error);process.exitCode=1;if(page)await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await context?.close();await browser?.close();await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({passed:evidence.passed,pages:evidence.pages.length,api_requests:evidence.api_responses.length,page_errors:evidence.page_errors.length,http_500:evidence.http_500.length,external_requests:evidence.external_requests.length,...(evidence.failure?{failure:evidence.failure}:{}),evidence_directory:output}));}
