import {chromium,expect} from '../../../web/node_modules/@playwright/test/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const base='http://127.0.0.1:19043',website='http://127.0.0.1:18080';
const output=resolve('.local-dev/042-cluster-demo/browser');await mkdir(output,{recursive:true,mode:0o700});
let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await context.addInitScript(()=>{localStorage.setItem('lightmoni.language','zh-CN');localStorage.setItem('lightmoni.appearance','light');});
try{
  const unauthenticated=await context.request.get(base+'/api/v1/ops/overview');expect(unauthenticated.status()).toBe(401);
  await page.goto(base+'/qa/workbench');
  const user=await(await context.request.get(base+'/api/v1/auth/me')).json();expect(user.id).toBe('demo-admin');expect(user.role).toBe('admin');
  const session=(await context.cookies()).find(cookie=>cookie.name==='lm_session');expect(session?.httpOnly).toBe(true);
  const overview=await(await context.request.get(base+'/api/v1/ops/overview')).json();
  const web=overview.resources.find(resource=>resource.spec.service_name==='demo-web'),ingress=overview.resources.find(resource=>resource.spec.service_name==='demo-openresty');
  expect(web.spec.deployments.length).toBe(2);expect(ingress.spec.deployment_mode).toBe('managed');
  await expect(page.getByRole('button',{name:'Demo 留言程序',exact:true})).toBeVisible();
  await expect(page.getByText(/^demo-web · v/).first()).toBeVisible();
  await page.screenshot({path:join(output,'workbench-applications.png'),fullPage:true});
  await page.goto(base+'/websites');await expect(page.getByRole('button',{name:'Demo 留言网站',exact:true})).toBeVisible();
  await page.screenshot({path:join(output,'workbench-websites.png'),fullPage:true});
  const live=await context.newPage();await live.goto(website);
  const marker='浏览器验收 '+Date.now().toString(36);await live.getByRole('textbox',{name:'留言内容'}).fill(marker);await live.getByRole('button',{name:'保存到数据库'}).click();
  await expect(live.getByText(marker,{exact:true})).toBeVisible();await expect(live.getByRole('status')).toHaveText('已写入 MySQL');
  await live.screenshot({path:join(output,'demo-message-saved.png'),fullPage:true});
  const admin=await(await context.request.get('http://127.0.0.1:18081')).json();expect(admin.port).toBe('admin');
  const report={verified_at:new Date().toISOString(),browser_version:browser.version(),entry:base+'/qa/workbench',unauthenticated_status:401,user_id:user.id,role:user.role,http_only_session:true,applications:overview.resources.filter(resource=>resource.kind==='application').map(resource=>({id:resource.id,service_name:resource.spec.service_name,mode:resource.spec.deployment_mode,clusters:resource.spec.deployments.map(deployment=>deployment.cluster_id)})),browser_database_write_read:true,admin_port:admin.port,screenshots:['workbench-applications.png','workbench-websites.png','demo-message-saved.png'],page_errors:errors};
  expect(errors).toEqual([]);await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
