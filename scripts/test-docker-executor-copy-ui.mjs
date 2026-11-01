import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect as baseExpect} from '../web/node_modules/@playwright/test/index.mjs';
import {build} from '../web/node_modules/vite/dist/node/index.js';

const expect=baseExpect.configure({timeout:10000}),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=join(root,'.local-dev/evidence/docker-executor-copy-ui'),harness=join(root,'web/.local-docker-executor-copy-ui');
await mkdir(out,{recursive:true});await mkdir(harness,{recursive:true});
await writeFile(join(harness,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(harness,'main.tsx'),`import React from'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{App,ConfigProvider,theme}from'../src/shared/ui';import{I18nProvider}from'../src/shared/i18n';import Panel from'../src/app/ops/DockerEnvironmentPanel';import'../src/app/style.css';createRoot(document.getElementById('root')!).render(<BrowserRouter><I18nProvider><ConfigProvider theme={{algorithm:theme.darkAlgorithm}}><App><Panel machine={{id:'h1',name:'Fixture host'}} onClose={()=>{}}/></App></ConfigProvider></I18nProvider></BrowserRouter>);`);
await build({root:harness,configFile:false,base:'/',logLevel:'silent',resolve:{dedupe:['react','react-dom']},build:{outDir:join(out,'bundle'),emptyOutDir:true}});
const server=createServer(async(req,res)=>{try{const directory=join(out,'bundle'),path=resolve(directory,decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/,''));if(!path.startsWith(directory+'/')&&path!==directory)throw Error('path');let file=path;try{if(!(await stat(file)).isFile())file=join(directory,'index.html')}catch{file=join(directory,'index.html')}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'));res.end(await readFile(file))}catch{res.writeHead(404);res.end()}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:'chrome'}),checks=[],errors=[],unexpected=[],calls=[];
let state,context,page;
const fresh=async(environment='missing',installation)=>{state={machine:{agent_id:'agent-h1',docker_environment:{state:environment,observed_at:'2026-11-02T00:00:00Z'}},...(installation?{installation}:{})};await page.goto(base+'/')};
const check=async(name,run)=>{await run();checks.push(name)};
const forbidden=/配置 Agent 对本机 Docker socket|重启 Agent|为受管 Agent 配置访问权限|确认 Agent 可访问|Configure Agent access|restart Agent|Agent may restart|verify Agent access|will be granted Docker access/i;
try{
 for(const language of ['zh-CN','en-US']){
  context=await browser.newContext({viewport:{width:1280,height:950},reducedMotion:'reduce'});await context.addInitScript(value=>localStorage.setItem('lightmoni.language',value),language);page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{if(new URL(route.request().url()).origin===base)return route.continue();unexpected.push(route.request().url());await route.abort()});
  await context.route('**/api/v1/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method(),body=request.postDataJSON();calls.push({path,method,body});let value,status=200;
   if(path==='/machines/h1/docker-environment'&&method==='GET')value=state;
   else if(path==='/machines/h1'&&method==='GET')value={credentials:[{id:'credential-fixture',method:'ssh_key',name:'Fixture key',is_default:true,retention:'permanent',expires_at:''}]};
   else if(path==='/machines/h1/docker-installations'&&method==='POST'){expect(body.confirmed).toBe(true);expect(body.credential_id).toBe('credential-fixture');expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);state.installation={id:'install-fixture',state:'running',phase:'installing_packages',updated_at:'2026-11-01T00:00:00Z'};value=state.installation;}
   else if(path==='/machines/h1/docker-installations/install-fixture/verify'&&method==='POST'){expect(body).toEqual({credential_id:'credential-fixture'});value=state.installation;}
   else{unexpected.push({path,method});status=404;value={error:'Unexpected API'}}
   await route.fulfill({status,json:structuredClone(value)});
  });
  const panel=()=>page.getByRole('dialog'),en=language==='en-US',text=(zh,english)=>en?english:zh;
  await fresh();
  await check(language+' install review describes dependencies and independent executor without Agent privilege changes',async()=>{await expect(panel().getByRole('button',{name:text('一键安装 Docker','Install Docker'),exact:true})).toBeEnabled();await expect(panel()).toContainText(text('容器访问和操作需在主机执行权限中启用并验证独立 root 运维执行器。','Enable and verify the independent root operations executor in Host execution permissions for container access and operations.'));expect(await panel().innerText()).not.toMatch(forbidden);await panel().getByRole('button',{name:text('一键安装 Docker','Install Docker'),exact:true}).click();await expect(page.getByText(text('将安装缺失的 Engine / Compose 软件包、启用 Docker 服务并验证主机环境。容器访问和操作由另行启用的独立 root 运维执行器完成。','Missing Engine / Compose packages will be installed, Docker enabled, and the host environment verified. Container access and operations use the separately enabled independent root operations executor.'),{exact:true})).toBeVisible();await page.getByRole('button',{name:text('确认安装','Confirm installation'),exact:true}).click();await expect(panel().getByText(text('正在安装','Installing'),{exact:true})).toBeVisible();await expect(panel()).toContainText('Docker Engine');expect(await panel().innerText()).not.toMatch(forbidden)});
  await fresh('permission_denied');
  await check(language+' permission failure points to exact host executor settings and cannot reinstall dependencies',async()=>{await expect(panel().getByText(text('容器执行权限尚未验证','Container execution permissions not verified'),{exact:true})).toBeVisible();await expect(panel().getByRole('link',{name:text('打开主机执行权限','Open host execution permissions'),exact:true})).toHaveAttribute('href','/machines?machine=h1');await expect(panel().getByRole('button',{name:text('一键安装 Docker','Install Docker'),exact:true})).toBeDisabled();expect(await panel().innerText()).not.toMatch(forbidden)});
  await fresh('ready',{id:'install-fixture',state:'succeeded',phase:'verified',updated_at:'2026-11-01T00:00:00Z'});
  await check(language+' success proves Engine and Compose dependencies without claiming container operations are ready',async()=>{await expect(panel().getByText(text('主机环境已就绪','Host environment ready'),{exact:true})).toBeVisible();await expect(panel().getByText(text('Docker 依赖安装完成','Docker dependencies installed'),{exact:true})).toBeVisible();await expect(panel()).toContainText(text('原应用失败记录保留','The original application failure history is retained'));expect(await panel().innerText()).not.toMatch(forbidden);await panel().getByRole('button',{name:text('核对远端结果','Verify remote result'),exact:true}).click();await expect.poll(()=>calls.filter(value=>value.path.endsWith('/verify')&&value.method==='POST').length).toBeGreaterThan(0)});
  await fresh('missing',{id:'legacy-fixture',state:'failed',phase:'configuring_agent',code:'docker_install_agent_access_failed',updated_at:'2026-11-01T00:00:00Z'});
  await check(language+' legacy phase and failure remain readable as historical behavior',async()=>{await expect(panel()).toContainText(text('旧安装阶段：Agent 权限配置','Legacy installation stage: Agent permission configuration'));await expect(panel()).toContainText(text('旧版本 Agent 权限配置失败。这是旧安装记录','Legacy Agent permission configuration failed. This is an old installation record'));expect(await panel().innerText()).not.toMatch(forbidden)});
  await fresh('daemon_unavailable');
  await check(language+' daemon diagnostics do not instruct changing ordinary Agent permissions',async()=>{await expect(panel().getByText(text('无法连接 Docker 服务','Cannot connect to Docker'),{exact:true})).toBeVisible();expect(await panel().innerText()).not.toMatch(forbidden)});
  await page.setViewportSize({width:390,height:844});await fresh('permission_denied');
  await check(language+' mobile dark permission guidance and navigation stay visible without horizontal page overflow',async()=>{await expect(panel().getByRole('link',{name:text('打开主机执行权限','Open host execution permissions'),exact:true})).toBeVisible();expect(await panel().evaluate(element=>element.getBoundingClientRect().width)).toBeLessThanOrEqual(390);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:join(out,language+'-mobile-dark.png'),fullPage:true})});
  await context.close();context=undefined;
 }
}catch(error){errors.push(String(error));if(page)await page.screenshot({path:join(out,'failure.png'),fullPage:true});throw error}
finally{await writeFile(join(out,'report.json'),JSON.stringify({source_bundle:true,api_fixtures:true,real_ssh:false,production_writes:false,checks,errors,unexpected,calls},null,2)+'\n');await context?.close();await browser.close();await new Promise(done=>server.close(done));await rm(harness,{recursive:true,force:true})}
if(errors.length||unexpected.length)throw Error(JSON.stringify({errors,unexpected}));console.log(JSON.stringify({passed:checks.length,checks}));
