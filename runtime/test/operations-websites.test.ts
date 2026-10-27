import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { websiteDefinition, executeWebsite, recoverWebsiteGateway } from '../src/operations/websites.js';
import type { OperationExecutionContext, OperationPayload } from '../src/operations/types.js';

const payload = (config: any, operation='apply', input:any={}):OperationPayload => ({version:1,operation_id:'run-one',operation,resource:{id:'site-one',kind:'website',name:'Example',agent_id:'node-one',revision:1,config,created_at:'',updated_at:''},input});

test('website rejects configuration injection, arbitrary paths and cross-protocol upstreams', () => {
  for (const config of [
    {domains:['x.test; include /etc/nginx/*;'],mode:'proxy',upstream:'http://127.0.0.1'},
    {domains:['x.test'],mode:'proxy',upstream:'file:///etc/passwd'},
    {domains:['x.test'],mode:'proxy',upstream:'http://user:secret@example.com'},
    {domains:['x.test'],mode:'static',static_files:{'../escape':'secret'}},
    {domains:['x.test'],mode:'static',static_files:{'index.html':'a'},listen_port:0},
  ]) assert.throws(() => websiteDefinition.validate(config));
  assert.equal(websiteDefinition.validate({domains:['EXAMPLE.com'],mode:'proxy',upstream:'http://127.0.0.1:3000'}).domains[0], 'example.com');
  assert.throws(() => websiteDefinition.validateInput('restore',{version:'../../etc'},{}));
});

test('website nginx preflight failure preserves active files and returns no command output', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'lightmoni-web-'));
  try {
    const context:OperationExecutionContext={dataDir,publicDir:dataDir+'-public',signal:new AbortController().signal,now:()=>new Date(),command:async()=>{throw new Error('private upstream credentials in stderr');}};
    await assert.rejects(executeWebsite(payload({domains:['example.test'],mode:'static'}),context), /NGINX_PREFLIGHT_FAILED/);
    await assert.rejects(readFile(join(dataDir,'operations','websites','active','site-one.conf')));
  } finally { await rm(dataDir,{recursive:true,force:true});await rm(dataDir+'-public',{recursive:true,force:true}); }
});

test('website rejects symlink managed directory rather than following it', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'lightmoni-web-'));
  const external=await mkdtemp(join(tmpdir(),'lightmoni-external-'));
  try {
    await mkdir(join(dataDir,'operations'));
    await symlink(external,join(dataDir,'operations','websites'));
    const context:OperationExecutionContext={dataDir,publicDir:dataDir+'-public',signal:new AbortController().signal,now:()=>new Date(),command:async()=>({stdout:'',stderr:''})};
    await assert.rejects(executeWebsite(payload({domains:['example.test'],mode:'static'}),context), /UNSAFE_MANAGED_PATH/);
  } finally {await rm(dataDir,{recursive:true,force:true});await rm(dataDir+'-public',{recursive:true,force:true});await rm(external,{recursive:true,force:true});}
});

test('website applies, probes actual HTTP, restores a version and bounds logs', async () => {
  let health='';const server=createServer((req,res)=>res.end(req.url==='/.well-known/lightmoni-health'?health:'ok'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as any).port;
  const dataDir=await mkdtemp(join(tmpdir(),'lightmoni-web-'));
  const calls:{file:string,args:string[]}[]=[];let failReloads=0;
  const context:OperationExecutionContext={dataDir,publicDir:dataDir+'-public',signal:new AbortController().signal,now:()=>new Date(),command:async(file,args)=>{
    calls.push({file,args});
    if(file==='nginx'&&args.includes('-s')&&args.includes('reload')&&failReloads-->0)throw new Error('simulated reload failure');
    if(file==='nginx'&&!args.includes('-t')){const conf=await readFile(join(dataDir,'operations','websites','active','site-one.conf'),'utf8');health=conf.match(/return 200 "([a-f0-9]+)"/)?.[1]??'';}
    if(file==='ps')return {stdout:`nginx: master process nginx -p ${join(await import('node:fs/promises').then(m=>m.realpath(dataDir)),'operations','websites')}/ -c ${join(await import('node:fs/promises').then(m=>m.realpath(dataDir)),'operations','websites','nginx.conf')}`,stderr:''};
    if(file==='nginx'&&!args.includes('-t')) await writeFile(join(dataDir,'operations','websites','nginx.pid'),String(process.pid));
    return {stdout:'',stderr:''};
  }};
  try {
    const config={domains:['example.test'],mode:'static',listen_port:port,static_files:{'index.html':'hello'}};
    const result=await executeWebsite(payload(config),context);
    assert.equal(result.verified,true);
    assert.equal(result.data.http_status,200);
    assert.ok(calls.some(call=>call.file==='nginx'&&call.args.includes('-t')));
    const v=result.data.active_version;
    const second=payload({...config,static_files:{'index.html':'updated'}});second.resource.revision=2;second.operation_id='run-two';
    await executeWebsite(second,context);
    const restore=payload(second.resource.config,'restore',{version:v});restore.resource.revision=2;restore.operation_id='run-three';
    const restored=await executeWebsite(restore,context);
    assert.equal(restored.data.active_version,v);
    await writeFile(join(dataDir,'operations','websites','logs','site-one.access.log'),'one\ntwo\nthree\n');
    const logs=await executeWebsite(payload(config,'logs',{stream:'access',lines:2}),context);
    assert.equal(logs.data.text,'two\nthree');
    const disable=payload(config,'disable');disable.resource.revision=2;failReloads=1;await assert.rejects(executeWebsite(disable,context),/^Error: WEBSITE_DISABLE_FAILED$/);
    failReloads=2;await assert.rejects(executeWebsite(disable,context),/WEBSITE_DISABLE_FAILED_RECOVERY_FAILED/);
    await writeFile(join(dataDir,'operations','websites','active','site-one.conf'),'unverified candidate after crash');
    await assert.rejects(recoverWebsiteGateway(context),/WEBSITE_RECOVERY_UNVERIFIED_CONFIGURATION/);
    await writeFile(join(dataDir,'operations','websites','logs','site-one.access.log'),'界\\'.repeat(40000));
    const large=await executeWebsite(payload(config,'logs',{stream:'access',lines:200}),context);
    assert.ok(Buffer.byteLength(JSON.stringify(large.data))<=48*1024);assert.equal(large.data.truncated,true);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dataDir,{recursive:true,force:true});await rm(dataDir+'-public',{recursive:true,force:true});}
});

test('website rejects a forged PID before signalling another process', async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'lightmoni-web-'));
 const ctx:OperationExecutionContext={dataDir,publicDir:dataDir+'-public',signal:new AbortController().signal,now:()=>new Date(),command:async()=>({stdout:'node some-other-service',stderr:''})};
 try {
  await executeWebsite(payload({domains:['example.test'],mode:'static'},'inspect'),ctx);
  await writeFile(join(dataDir,'operations','websites','nginx.pid'),String(process.pid));
  await assert.rejects(executeWebsite(payload({domains:['example.test'],mode:'static'},'inspect'),ctx),/GATEWAY_PROCESS_OWNERSHIP_MISMATCH/);
 }finally{await rm(dataDir,{recursive:true,force:true});await rm(dataDir+'-public',{recursive:true,force:true});}
});

test('website public assets remain separate from private gateway data and worker is unprivileged', async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'lightmoni-web-'));
 try{
  const context:OperationExecutionContext={dataDir,publicDir:dataDir+'-public',signal:new AbortController().signal,now:()=>new Date(),command:async()=>{throw new Error('NGINX unavailable');}};
  await assert.rejects(executeWebsite(payload({domains:['example.test'],mode:'static'}),context),/NGINX_PREFLIGHT_FAILED/);
  const dirs=await import('node:fs/promises');const {realpath,stat,readdir}=dirs;
  const active=join(await realpath(dataDir),'operations','websites');
  const siteVersion=(await readdir(join(active,'versions','site-one')))[0];
  const content=join(dataDir+'-public','sites','site-one',siteVersion,'index.html');
  assert.equal((await stat(content)).mode&0o777,0o644);
  assert.equal((await stat(dataDir)).mode&0o777,0o700);
  const config=await readFile(join(active,'versions','site-one',siteVersion,'site.conf'),'utf8');
  assert.ok(config.includes(dataDir+'-public')||config.includes(await realpath(dataDir+'-public')));
 }finally{await rm(dataDir,{recursive:true,force:true});await rm(dataDir+'-public',{recursive:true,force:true});}
});


test('static content limits account for UTF8 size and JSON escaping before private job download',()=>{
 const valid=websiteDefinition.validate({domains:['example.test'],mode:'static',static_files:{'index.html':'x'.repeat(512*1024)}});
 assert.ok(Buffer.byteLength(JSON.stringify(payload(valid)))<1_200_000);
 assert.throws(()=>websiteDefinition.validate({domains:['example.test'],mode:'static',static_files:{'index.html':'x'.repeat(512*1024+1)}}),/STATIC_CONTENT_LIMIT/);
 assert.throws(()=>websiteDefinition.validate({domains:['example.test'],mode:'static',static_files:{'index.html':'\\'.repeat(512*1024)}}),/STATIC_SERIALIZED_CONTENT_LIMIT/);
});
