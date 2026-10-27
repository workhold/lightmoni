import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { executeWebsite, recoverWebsiteGateway } from '../src/operations/websites.js';
import { executeCertificate } from '../src/operations/certificates.js';
import type { OperationConfig, OperationExecutionContext, OperationPayload } from '../src/operations/types.js';

/** Run only in an isolated Linux environment with nginx, openssl, ps and id. No host ports or existing gateways are used. */
test('Linux Nginx: static, proxy, version recovery, uploaded TLS and certificate rotation', {skip:process.env.LIGHTMONI_NGINX_LIVE!=='1',timeout:60000}, async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'lightmoni-nginx-live-'));
 const publicDir=dataDir+'-public';
 const command:OperationExecutionContext['command']=(file,args,options={})=>new Promise((resolve,reject)=>{
  const child=spawn(file,args,{cwd:options.cwd,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C'}});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('live command timeout'));},options.timeoutMs??15000);
  child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);code===0?resolve({stdout,stderr}):reject(Error(stderr));});child.stdin.end(options.stdin);
 });
 const context:OperationExecutionContext={dataDir,publicDir,signal:new AbortController().signal,now:()=>new Date(),command};
 const payload=(id:string,kind:'website'|'certificate',config:OperationConfig,operation='apply',revision=1,input:OperationConfig={}):OperationPayload=>({version:1,operation_id:`job-${Date.now()}-${Math.floor(Math.random()*1e6)}`,operation,resource:{id,kind,name:id,agent_id:'node-one',revision,config,created_at:'',updated_at:''},input});
 const upstream=createServer((_req,res)=>res.end('upstream healthy'));await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const getPort=async()=>{const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as any).port;await new Promise<void>(r=>reserve.close(()=>r()));return port;};
 const httpPort=await getPort(),proxyPort=await getPort(),httpsPort=await getPort();
 try{
  assert.equal(await recoverWebsiteGateway(context),false);
  const first={domains:['example.test'],mode:'static',listen_port:httpPort,static_files:{'index.html':'first static content','assets/app.js':'console.log(1)'}};
  const result=await executeWebsite(payload('site-one','website',first),context);assert.equal(result.verified,true);
  assert.equal(await (await fetch(`http://127.0.0.1:${httpPort}/`)).text(),'first static content');
  assert.equal((await fetch(`http://127.0.0.1:${httpPort}/`)).headers.get('content-type'),'text/html');
  await assert.rejects(executeWebsite(payload('site-one','website',{domains:first.domains,mode:'proxy',listen_port:httpPort,upstream:'http://127.0.0.1:9'},'apply',2),context),/WEBSITE_ACTIVATION_FAILED_RESTORED/);
  assert.equal(await (await fetch(`http://127.0.0.1:${httpPort}/`)).text(),'first static content');
  const second={...first,static_files:{'index.html':'second static content'}};await executeWebsite(payload('site-one','website',second,'apply',2),context);
  await executeWebsite(payload('site-one','website',second,'restore',2,{version:result.data.active_version}),context);assert.equal(await (await fetch(`http://127.0.0.1:${httpPort}/`)).text(),'first static content');
  const proxy={domains:['proxy.test'],mode:'proxy',listen_port:proxyPort,upstream:`http://127.0.0.1:${(upstream.address() as any).port}`};await executeWebsite(payload('site-proxy','website',proxy),context);assert.equal(await (await fetch(`http://127.0.0.1:${proxyPort}/`)).text(),'upstream healthy');
  const makeCertificate=async(name:string,days:string)=>{await command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dataDir,name+'.key'),'-out',join(dataDir,name+'.crt'),'-days',days,'-subj','/CN=example.test','-addext','subjectAltName=DNS:example.test']);return{domains:['example.test'],certificate_pem:await readFile(join(dataDir,name+'.crt'),'utf8'),private_key_pem:await readFile(join(dataDir,name+'.key'),'utf8')};};
  const cert=await makeCertificate('first','2');assert.equal((await executeCertificate(payload('cert-one','certificate',cert,'install'),context)).verified,true);assert.equal((await stat(join(dataDir,'operations','certificates','cert-one','private.key'))).mode&0o777,0o600);
  const tls={...first,certificate_id:'cert-one',https_port:httpsPort};await executeWebsite(payload('site-one','website',tls,'apply',3),context);
  const newCert=await makeCertificate('second','3');await executeCertificate(payload('cert-one','certificate',newCert,'install',2),context);
  const log=await executeWebsite(payload('site-one','website',tls,'logs',3,{stream:'access',lines:2}),context);assert.ok(log.data.text);
  await executeWebsite(payload('site-one','website',tls,'disable',3),context);await executeWebsite(payload('site-proxy','website',proxy,'disable',1),context);
 }finally{
  await new Promise<void>(r=>upstream.close(()=>r()));
  await command('nginx',['-p',join(dataDir,'operations','websites')+'/','-c',join(dataDir,'operations','websites','nginx.conf'),'-s','quit']).catch(()=>{});
  await rm(dataDir,{recursive:true,force:true});await rm(publicDir,{recursive:true,force:true});
 }
});
