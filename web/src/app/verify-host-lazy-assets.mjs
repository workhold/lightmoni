import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';

// Built assets and intercepted API responses only; no remote host is contacted.
const root=resolve(import.meta.dirname,'../../..');
const bundle=resolve(root,'runtime/public');
const evidence=resolve(root,'specs/132-host-dialog-lazy/evidence');
const server=createServer(async(request,response)=>{
 try{
  const path=decodeURIComponent(new URL(request.url,'http://fixture').pathname);
  const file=path.startsWith('/assets/')?resolve(bundle,'.'+path):resolve(bundle,'index.html');
  if(!file.startsWith(bundle+'/')||!(await stat(file)).isFile())throw Error('Unknown asset');
  response.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]??'application/octet-stream'));
  response.end(await readFile(file));
 }catch{response.writeHead(404);response.end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const now=new Date().toISOString(),expiresAt=new Date(Date.now()+600_000).toISOString();
const credential={id:'fixture-credential',account_id:'fixture-account',username:'root',account_revision:1,method:'ssh_key',retention:'permanent',expires_at:'',secret_fingerprint:'metadata-only'};
const account={id:'fixture-account',machine_id:'fixture-host',username:'root',revision:1,default_credential_id:credential.id,created_at:now,created_by:'fixture',updated_at:now,credentials:[credential],last_check:null,check_fresh:false,recommended:true,recommended_credential_id:credential.id};
const available={available:true,reason:''};
const machine={id:'fixture-host',name:'Fixture host',address:'192.0.2.10',port:22,connection_method:'direct_ssh',host_key_fingerprint:'SHA256:fixture',host_key_status:'confirmed',platform:'linux',arch:'amd64',agent_id:'',agent_status:'unknown',credential_count:1,active_credential_count:1,active_ssh_credential_count:1,active_ssh_key_count:1,ssh_recovery_available:true,capabilities:{terminal:available,ssh_check:available,deploy_agent:available,uninstall_agent:available},default_account_id:account.id,accounts:[account],last_deployment_status:'',updated_at:now,created_at:now};
const directory={machine_id:machine.id,path:'/',entries:[{name:'readme.txt',type:'file',size:6,mode:'0644',modified_at:now,version:'entry-v1'}],truncated:false,version:'directory-v1'};
const assets=[],calls=[],errors=[];
page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/assets/'))assets.push(path)});
page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>localStorage.setItem('lightmoni.language','zh-CN'));
await page.route('**/api/v1/**',async route=>{
 const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
 calls.push({path,method,body:method==='POST'?request.postDataJSON():undefined});
 if(path==='/api/v1/setup')return route.fulfill({json:{required:false}});
 if(path==='/api/v1/auth/me')return route.fulfill({json:{id:'fixture-admin',name:'Fixture admin',role:'admin'}});
 if(path==='/api/v1/auth/profile')return route.fulfill({json:{}});
 if(path==='/api/v1/machines')return route.fulfill({json:[machine]});
 if(path===`/api/v1/machines/${machine.id}`&&method==='GET')return route.fulfill({json:{machine,credentials:[credential],deployments:[]}});
 if(path==='/api/v1/ops/inventory')return route.fulfill({json:{hosts:[{id:machine.id,agent_id:'',online:true,state:'ready',error:'',observed_at:now,truncated:false,active_job:'',docker_capabilities:[],containers:[]}]}});
 if(path===`/api/v1/ops/machines/${machine.id}/container-jobs`&&method==='GET')return route.fulfill({json:{jobs:[]}});
 if(path==='/api/v1/operations/resources'&&method==='GET')return route.fulfill({json:{resources:[]}});
 if(path==='/api/v1/agents'||path==='/api/v1/agent-task-labels'||path==='/api/v1/host-labels')return route.fulfill({json:[]});
 if(path===`/api/v1/machines/${machine.id}/file-session`&&method==='POST')return route.fulfill({json:{machine_id:machine.id,credential_id:credential.id,session_id:'fixtureSessionID_1234567890abcdef',idle_timeout_ms:20_000,expires_at:expiresAt,initial_directory:directory}});
 if(path===`/api/v1/machines/${machine.id}/file-session`&&method==='DELETE')return route.fulfill({json:{ok:true}});
 if(path===`/api/v1/machines/${machine.id}/file`&&method==='GET')return route.fulfill({json:{machine_id:machine.id,path:'/readme.txt',content:'hello\n',version:'file-v1',size:6}});
 return route.fulfill({json:[]});
});
const hasAsset=(list,pattern)=>list.some(path=>pattern.test(path));
const assetBytes=async list=>(await Promise.all(list.map(async path=>(await stat(resolve(bundle,'.'+path))).size))).reduce((sum,size)=>sum+size,0);
const deferred=/\/(?:HostFilesDialog|HostContainersDialog|MachineTerminalDialog|CodeEditor|bracketMatching)-[^/]+\.(?:js|css)$/;
let report;
try{
 await page.goto(origin+'/machines');
 const row=page.locator('tr[data-row-key="fixture-host"]');
 await expect(row).toBeVisible();
 await page.waitForLoadState('networkidle');
 const coldAssets=[...assets];
 expect(coldAssets.filter(path=>deferred.test(path))).toEqual([]);
 expect(calls.some(call=>call.path.includes('/file-session'))).toBe(false);

 let releaseContainerChunk;
 await page.route(/\/HostContainersDialog-[^/]+\.js$/,async route=>{await new Promise(resolve=>releaseContainerChunk=resolve);await route.continue()},{times:1});
 await row.getByRole('button',{name:'全部容器',exact:true}).click();
 await expect.poll(()=>!!releaseContainerChunk).toBe(true);
 await expect(page.locator('.lm-host-resource-dialog .lm-host-dialog-loading[role="status"]')).toContainText('正在加载容器面板');
 await page.getByRole('dialog',{name:'全部容器 · Fixture host'}).locator('.ant-modal-close').click();
 releaseContainerChunk();
 await page.waitForTimeout(250);
 expect(calls.some(call=>call.path==='/api/v1/ops/inventory')).toBe(false);
 await row.getByRole('button',{name:'全部容器',exact:true}).click();
 const containers=page.getByRole('dialog',{name:'全部容器 · Fixture host'});
 await expect(containers.getByRole('button',{name:/刷新清单/})).toBeVisible();
 await expect.poll(()=>calls.filter(call=>call.path==='/api/v1/ops/inventory').length).toBe(1);
 const containerAssets=[...assets];
 expect(hasAsset(containerAssets,/\/HostContainersDialog-[^/]+\.js$/)).toBe(true);
 expect(hasAsset(containerAssets,/\/(?:CodeEditor|bracketMatching)-[^/]+\.(?:js|css)$/)).toBe(false);
 await containers.locator('.ant-modal-close').click();
 await expect(containers).toHaveCount(0);

 // A slow module load leaves an accessible, closeable dialog and creates no file session.
 let releaseFileChunk;
 await page.route(/\/HostFilesDialog-[^/]+\.js$/,async route=>{await new Promise(resolve=>releaseFileChunk=resolve);await route.continue()},{times:1});
 await row.getByRole('button',{name:'文件管理',exact:true}).click();
 await expect.poll(()=>!!releaseFileChunk).toBe(true);
 await expect(page.locator('.lm-host-dialog-loading[role="status"]')).toBeVisible();
 await expect(page.locator('.lm-host-dialog-loading')).toContainText('正在加载文件管理');
 await page.locator('.lm-host-files-dialog .ant-modal-close').click();
 releaseFileChunk();
 await page.waitForTimeout(250);
 await expect(page.locator('.lm-host-files-dialog')).toHaveCount(0);
 expect(calls.some(call=>call.path.includes('/file-session'))).toBe(false);

 await row.getByRole('button',{name:'文件管理',exact:true}).click();
 const dialog=page.locator('.lm-host-files-dialog');
 await expect(dialog.getByRole('button',{name:'readme.txt',exact:true})).toBeVisible();
 const directoryAssets=[...assets];
 expect(hasAsset(directoryAssets,/\/HostFilesDialog-[^/]+\.js$/)).toBe(true);
 expect(hasAsset(directoryAssets,/\/(?:CodeEditor|bracketMatching)-[^/]+\.(?:js|css)$/)).toBe(false);
 const opens=calls.filter(call=>call.path===`/api/v1/machines/${machine.id}/file-session`&&call.method==='POST');
 expect(opens).toHaveLength(1);
 expect(opens[0].body).toEqual({credential_id:credential.id,initial_path:'/'});
 expect(calls.some(call=>call.path===`/api/v1/machines/${machine.id}`&&call.method==='GET')).toBe(false);

 await dialog.getByRole('button',{name:'readme.txt',exact:true}).click();
 await expect(dialog.locator('.monaco-editor')).toBeVisible();
 const editorAssets=[...assets];
 expect(hasAsset(editorAssets,/\/CodeEditor-[^/]+\.js$/)).toBe(true);
 expect(hasAsset(editorAssets,/\/bracketMatching-[^/]+\.js$/)).toBe(true);
 await dialog.locator('.ant-modal-close').click();
 await expect(dialog).toHaveCount(0);
 await expect.poll(()=>calls.filter(call=>call.path===`/api/v1/machines/${machine.id}/file-session`&&call.method==='DELETE').length).toBe(1);

 let releaseTerminalChunk;
 await page.route(/\/MachineTerminalDialog-[^/]+\.js$/,async route=>{await new Promise(resolve=>releaseTerminalChunk=resolve);await route.continue()},{times:1});
 await row.getByRole('button',{name:'登录终端',exact:true}).click();
 await expect.poll(()=>!!releaseTerminalChunk).toBe(true);
 await expect(page.locator('.lm-terminal-dialog .lm-host-dialog-loading[role="status"]')).toContainText('正在加载终端');
 await page.locator('.lm-terminal-dialog .ant-modal-close').click();
 releaseTerminalChunk();
 await page.waitForTimeout(250);
 await expect(page.locator('.lm-terminal-dialog')).toHaveCount(0);
 expect(calls.some(call=>call.path.includes('/terminal-sessions'))).toBe(false);

 let releaseTerminalSession;
 await page.route(`**/api/v1/machines/${machine.id}/terminal-sessions`,async route=>{
  if(route.request().method()!=='POST')return route.fallback();
  calls.push({path:`/api/v1/machines/${machine.id}/terminal-sessions`,method:'POST',body:route.request().postDataJSON()});
  await new Promise(resolve=>releaseTerminalSession=resolve);
  await route.fulfill({json:{id:'fixture-terminal-session',websocket_path:'/api/v1/machines/fixture-host/terminal-sessions/fixture-terminal-session/ws'}});
 },{times:1});
 await row.getByRole('button',{name:'登录终端',exact:true}).click();
 const terminal=page.getByRole('dialog',{name:'SSH 终端 · Fixture host'});
 await expect.poll(()=>!!releaseTerminalSession).toBe(true);
 const terminalAssets=[...assets];
 expect(hasAsset(terminalAssets,/\/MachineTerminalDialog-[^/]+\.js$/)).toBe(true);
 await terminal.locator('.ant-modal-close').click();
 releaseTerminalSession();
 await expect(terminal).toHaveCount(0);
 await expect.poll(()=>calls.filter(call=>call.path.endsWith('/fixture-terminal-session')&&call.method==='DELETE').length).toBeGreaterThan(0);
 const terminalSessionCloses=calls.filter(call=>call.path.endsWith('/fixture-terminal-session')&&call.method==='DELETE').length;

 await row.getByRole('button',{name:'全部容器',exact:true}).click();
 const reopenedContainers=page.getByRole('dialog',{name:'全部容器 · Fixture host'});
 await expect(reopenedContainers.getByRole('button',{name:'接管已有 Compose',exact:true})).toBeEnabled();
 let releaseComposeChunk;
 await page.route(/\/ExternalComposeManagement-[^/]+\.js$/,async route=>{await new Promise(resolve=>releaseComposeChunk=resolve);await route.continue()},{times:1});
 await reopenedContainers.getByRole('button',{name:'接管已有 Compose',exact:true}).click();
 await expect.poll(()=>!!releaseComposeChunk).toBe(true);
 const compose=page.getByRole('dialog',{name:'已有 Compose 项目 · Fixture host'});
 await expect(compose.locator('.lm-host-dialog-loading[role="status"]')).toContainText('正在加载 Compose 接管');
 await compose.locator('.ant-modal-close').click();
 releaseComposeChunk();
 await page.waitForTimeout(250);
 expect(calls.some(call=>call.path==='/api/v1/operations/resources')).toBe(false);
 await reopenedContainers.getByRole('button',{name:'接管已有 Compose',exact:true}).click();
 await expect(compose.getByRole('textbox',{name:'Compose 项目名称',exact:true})).toBeVisible();
 await expect.poll(()=>calls.filter(call=>call.path==='/api/v1/operations/resources').length).toBe(1);
 const composeAssets=[...assets];
 expect(hasAsset(composeAssets,/\/ExternalComposeManagement-[^/]+\.js$/)).toBe(true);
 await compose.locator('.ant-modal-close').click();
 await reopenedContainers.locator('.ant-modal-close').click();
 await expect(reopenedContainers).toHaveCount(0);
 const member=await browser.newPage({viewport:{width:1440,height:900}}),memberCalls=[];
 try{
  await member.route('**/api/v1/**',route=>{
   const path=new URL(route.request().url()).pathname;memberCalls.push(path);
   if(path==='/api/v1/setup')return route.fulfill({json:{required:false}});
   if(path==='/api/v1/auth/me')return route.fulfill({json:{id:'fixture-member',name:'Fixture member',role:'member'}});
   if(path==='/api/v1/auth/profile')return route.fulfill({json:{}});
   return route.fulfill({json:[]});
  });
  await member.goto(origin+'/machines');
  await expect(member.getByRole('heading',{name:'主机',exact:true})).toBeVisible();
  await member.waitForLoadState('networkidle');
  expect(memberCalls.some(path=>path==='/api/v1/machines'||path.includes('/file-session')||path.includes('/terminal-sessions'))).toBe(false);
  await expect(member.getByRole('button',{name:'文件管理',exact:true})).toHaveCount(0);
 }finally{await member.close()}
 expect(errors).toEqual([]);
 const containerAdditional=containerAssets.slice(coldAssets.length),directoryAdditional=directoryAssets.slice(containerAssets.length),editorAdditional=editorAssets.slice(directoryAssets.length),terminalAdditional=terminalAssets.slice(editorAssets.length),composeAdditional=composeAssets.slice(terminalAssets.length);
 report={source:'isolated built bundle and intercepted APIs; no SSH or production access',cold_assets:coldAssets,cold_asset_bytes:await assetBytes(coldAssets),container_additional_assets:containerAdditional,container_additional_bytes:await assetBytes(containerAdditional),directory_additional_assets:directoryAdditional,directory_additional_bytes:await assetBytes(directoryAdditional),editor_additional_assets:editorAdditional,editor_additional_bytes:await assetBytes(editorAdditional),terminal_additional_assets:terminalAdditional,terminal_additional_bytes:await assetBytes(terminalAdditional),compose_additional_assets:composeAdditional,compose_additional_bytes:await assetBytes(composeAdditional),file_session_opens:opens.length,file_session_closes:1,terminal_session_opens:1,terminal_session_close_requests:terminalSessionCloses,member_machine_reads:memberCalls.filter(path=>path==='/api/v1/machines').length,page_errors:errors};
 await mkdir(evidence,{recursive:true});
 await writeFile(resolve(evidence,'lazy-assets.json'),JSON.stringify(report,null,2)+'\n');
 console.log('PASS host first load excludes file/container/terminal dialogs and Monaco/xterm; container list and file directory exclude Monaco; editor, terminal and Compose load on demand; canceled opens do not create sessions or reads');
}finally{await page.close();await browser.close();await new Promise(resolve=>server.close(resolve))}
