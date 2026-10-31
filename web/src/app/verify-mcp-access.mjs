import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:15184';
const output=resolve(process.env.LIGHTMONI_MCP_UI_ARTIFACTS??'/tmp/lightmoni-mcp-ui');
await mkdir(output,{recursive:true});
let browser;
try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const errors=[],checks=[],requests=[];
page.on('pageerror',error=>errors.push(error.message));
const user={id:'ui-admin',name:'UI Admin',role:'admin'},endpoint='https://monitor.example.test/api/v1/mcp';
const scopes=['hosts.read','tasks.read','tasks.source.read','tasks.propose','executions.read','telemetry.catalog.read','alerts.read'];
const expires=new Date(Date.now()+86400000).toISOString(),created=new Date().toISOString();
const data={endpoint,scopes,tokens:[],grants:[{id:'grant-fixture',name:'Fixture OAuth client',host_ids:['host-one'],scopes:['hosts.read'],active:true,expires_at:expires,created_at:created}],clients:[]};
let signedIn=true;
const fakeToken='lm_pat_ui_fixture_not_a_real_credential';
const oauth={client_id:'client-fixture',redirect_uri:'http://127.0.0.1:14999/callback',response_type:'code',code_challenge:'fixture-pkce-challenge',code_challenge_method:'S256',resource:endpoint,state:'fixture-state',scope:'hosts.read tasks.read'};
await page.route('**/api/v1/**',async route=>{
 const request=route.request(),url=new URL(request.url()),method=request.method(),path=url.pathname.slice('/api/v1'.length),body=request.postDataJSON?.();
 requests.push({path,method,body});
 const reply=(json,status=200)=>route.fulfill({status,json});
 if(path==='/auth/me')return reply(signedIn?user:{error:'Sign in required'},signedIn?200:401);
 if(path==='/setup')return reply({required:false});
 if(path==='/auth/providers')return reply([]);
 if(path==='/auth/login'){signedIn=true;return reply(user)}
 if(path==='/machines')return reply([{id:'host-one',name:'Fixture host'},{id:'host-two',name:'Other host'}]);
 if(path==='/mcp-access')return reply(data);
 if(path==='/mcp-access/tokens'&&method==='POST'){
  const item={id:'token-fixture',name:body.name,scopes:body.scopes,host_ids:body.host_ids,active:true,created_at:created,expires_at:expires};data.tokens.push(item);return reply({...item,token:fakeToken},201);
 }
 if(path==='/mcp-access/clients'&&method==='POST'){
  const item={id:'client-created',...body,created_at:created};data.clients.push(item);return reply(item,201);
 }
 if(path==='/mcp-access/grants/grant-fixture'&&method==='DELETE'){data.grants[0].active=false;data.grants[0].revoked_at=created;return reply({ok:true})}
 if(path==='/mcp/oauth/request')return url.searchParams.has('invalid')?reply({error:'Unknown registered client'},400):reply({endpoint,client:{id:oauth.client_id,name:'Fixture Codex',redirect_uris:[oauth.redirect_uri]},request:oauth,scopes:oauth.scope.split(' ')});
 if(path==='/mcp/oauth/approve'&&method==='POST')return reply({redirect_url:base+'/mcp-access?authorized=1'});
 return reply({error:'Unexpected mock API: '+path},404);
});
try{
 await page.goto(base+'/mcp-access');
 await expect(page.getByRole('heading',{name:'MCP 接入',exact:true})).toBeVisible();
 await expect(page.getByText(endpoint,{exact:true})).toBeVisible();
 await expect(page.getByText(/codex mcp add lightmoni --url/)).toBeVisible();
 await page.getByRole('button',{name:'创建令牌',exact:true}).click();
 const tokenDialog=page.getByRole('dialog',{name:'创建个人令牌',exact:true});
 await expect(tokenDialog.getByRole('checkbox',{name:'所有主机，包含以后登记的主机',exact:true})).not.toBeChecked();
 await tokenDialog.getByLabel('名称',{exact:true}).fill('Fixture personal client');
 await tokenDialog.getByRole('button',{name:'创建令牌',exact:true}).click();
 await expect(tokenDialog.getByText('请选择至少一种能力',{exact:true})).toBeVisible();
 expect(requests.filter(value=>value.path==='/mcp-access/tokens'&&value.method==='POST')).toHaveLength(0);
 await tokenDialog.getByLabel('允许调用的能力',{exact:true}).click();
 await page.getByText('主机信息 · hosts.read',{exact:true}).click();
 await tokenDialog.getByLabel('名称',{exact:true}).click();
 await tokenDialog.getByRole('checkbox',{name:'所有主机，包含以后登记的主机',exact:true}).check();
 await tokenDialog.getByRole('button',{name:'创建令牌',exact:true}).click();
 const secretDialog=page.getByRole('dialog',{name:'保存新令牌',exact:true});
 await expect(secretDialog.getByTestId('mcp-new-token')).toHaveText(fakeToken);
 const issued=requests.find(value=>value.path==='/mcp-access/tokens'&&value.method==='POST').body;
 expect(issued).toEqual({name:'Fixture personal client',scopes:['hosts.read'],host_ids:null,expires_in_hours:168});
 await secretDialog.getByRole('button',{name:'我已保存，关闭',exact:true}).click();
 await expect(page.getByTestId('mcp-new-token')).toHaveCount(0);
 expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookie:document.cookie}))).not.toContain(fakeToken);
 await page.getByRole('button',{name:'创建令牌',exact:true}).click();await expect(tokenDialog.getByLabel('名称',{exact:true})).toHaveValue('');await expect(tokenDialog.getByLabel('授权有效期（小时）',{exact:true})).toHaveValue('168');await expect(tokenDialog.getByRole('checkbox',{name:'所有主机，包含以后登记的主机',exact:true})).not.toBeChecked();await tokenDialog.getByRole('button',{name:/^取\s*消$/}).click();await expect(tokenDialog).toBeHidden();
 await page.reload();await expect(page.getByText('Fixture personal client',{exact:true})).toBeVisible();await expect(page.getByText(fakeToken,{exact:true})).toHaveCount(0);
 checks.push('Personal token requires explicit scope and target consent; default finite lifetime; token only in one-time modal, absent from browser storage and reload');
 await page.getByRole('tab',{name:'OAuth 客户端',exact:true}).click();await page.getByRole('button',{name:'登记客户端',exact:true}).click();
 const clientDialog=page.getByRole('dialog',{name:'登记 OAuth 客户端',exact:true});
 await clientDialog.getByLabel('客户端名称',{exact:true}).fill('Fixture client');await clientDialog.getByLabel('回调地址（每行一个）',{exact:true}).fill('http://127.0.0.1:1455/callback\n https://client.example.test/callback ');
 await clientDialog.getByRole('button',{name:/^登\s*记$/}).click();await expect(page.getByText('client-created',{exact:true})).toBeVisible();
 expect(requests.find(value=>value.path==='/mcp-access/clients'&&value.method==='POST').body).toEqual({name:'Fixture client',redirect_uris:['http://127.0.0.1:1455/callback','https://client.example.test/callback']});
 await page.getByRole('tab',{name:'OAuth 授权',exact:true}).click();await page.getByRole('button',{name:/^撤\s*销$/}).click();await page.getByRole('dialog',{name:'撤销此接入授权？',exact:true}).getByRole('button',{name:/^撤\s*销$/}).click();await expect(page.getByRole('dialog',{name:'撤销此接入授权？',exact:true})).toBeHidden();await expect(page.getByText('已撤销',{exact:true}).first()).toBeVisible();
 expect(requests.filter(value=>value.path==='/mcp-access/grants/grant-fixture'&&value.method==='DELETE')).toHaveLength(1);
 checks.push('OAuth client registration preserves explicit redirect URIs; grant revoke sends the selected grant ID');
 await page.screenshot({path:resolve(output,'access-desktop.png'),fullPage:true});
 signedIn=false;const search=new URLSearchParams(oauth).toString();await page.goto(base+'/mcp/authorize?'+search);
 await expect(page.getByRole('button',{name:/^登\s*录$/})).toBeVisible();await page.getByLabel('用户名',{exact:true}).fill('fixture');await page.getByLabel('密码',{exact:true}).fill('fixture-only-password');await page.getByRole('button',{name:/^登\s*录$/}).click();
 await expect(page.getByRole('heading',{name:'授权 MCP 客户端',exact:true})).toBeVisible();expect(new URL(page.url()).pathname+new URL(page.url()).search).toBe('/mcp/authorize?'+search);
 await expect(page.getByText('Fixture Codex',{exact:true})).toBeVisible();await expect(page.getByText('tasks.source.read',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('checkbox',{name:'所有主机，包含以后登记的主机',exact:true})).not.toBeChecked();
 await page.getByRole('button',{name:'允许访问',exact:true}).click();await expect(page.getByText('请选择主机或明确授权所有主机',{exact:true})).toBeVisible();
 expect(requests.filter(value=>value.path==='/mcp/oauth/approve')).toHaveLength(0);
 await page.getByLabel('选择主机',{exact:true}).click();await page.getByText('Fixture host · host-one',{exact:true}).click();await page.getByLabel('选择主机',{exact:true}).press('Escape');await page.getByLabel('授权有效期（小时）',{exact:true}).focus();
 await page.screenshot({path:resolve(output,'consent-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'允许访问',exact:true}).click();await expect(page).toHaveURL(base+'/mcp-access?authorized=1');
 expect(requests.find(value=>value.path==='/mcp/oauth/approve').body).toEqual({...oauth,host_ids:['host-one'],expires_in_hours:168});
 checks.push('OAuth deep link and query survive sign-in; consent shows only requested scopes; explicit host selection is required and preserved on approval');
 await page.goto(base+'/mcp/authorize?invalid=1');await expect(page.getByText('授权请求无效或已失效',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'允许访问',exact:true})).toHaveCount(0);checks.push('Invalid OAuth request has no approval form');
 await page.goto(base+'/mcp/authorize?'+search);await expect(page.getByRole('button',{name:'取消授权',exact:true})).toBeVisible();const approvalsBeforeCancel=requests.filter(value=>value.path==='/mcp/oauth/approve').length;await page.getByRole('button',{name:'取消授权',exact:true}).click();await expect(page).toHaveURL(base+'/mcp-access');expect(requests.filter(value=>value.path==='/mcp/oauth/approve')).toHaveLength(approvalsBeforeCancel);checks.push('Canceling authorization does not create a grant');
 await page.setViewportSize({width:390,height:900});await page.goto(base+'/mcp-access');await expect(page.getByRole('heading',{name:'MCP 接入',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve(output,'access-mobile.png'),fullPage:true});
 await page.evaluate(()=>localStorage.setItem('lightmoni.language','en-US'));await page.reload();await expect(page.getByRole('heading',{name:'MCP access',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Create token',exact:true})).toBeVisible();checks.push('390px layout has no page overflow; English management UI is available');
 expect(errors).toEqual([]);const report={passed:true,checks,errors,backend:'Mock API UI checks only; backend security and client interoperability require independent runtime tests.'};await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(output,'report.json'),JSON.stringify({passed:false,checks,errors,error:String(error)},null,2)+'\n');throw error}
finally{await context.close();await browser.close()}
