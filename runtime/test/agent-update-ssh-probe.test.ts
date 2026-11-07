import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as path from 'node:path';
import {runInNewContext} from 'node:vm';
import {agentUpdateProbeSource,parseAgentUpdateProbe,parseAgentUpdateStatus,agentUpdateRecoveryBootstrap,agentUpdateRecoveryBootstrapSource} from '../src/server/machine-agent-update-ssh.js';

const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/** Run the actual self-contained SSH source. No fingerprint function or source
 * path is replaced; the filesystem and systemctl are isolated in memory. */
function inlineFixture(){
 const root='/opt/lightmoni-agent/releases/original',boot='11111111-1111-4111-8111-111111111111';
 const node=Buffer.alloc(7*65536+19,37),main=Buffer.alloc(5*65536+11,42),uninstall=Buffer.alloc(3*65536+9,58);
 const manifest={version:'0.1.0',platform:'linux',arch:'amd64',state_schema:1,source_revision:'1'.repeat(40),build_id:'original-build',node_binary_sha256:sha(node)};
 const files=new Map<string,Buffer>([
  [root+'/node',node],[root+'/app/runtime/dist/agent/main.js',main],[root+'/uninstall.sh',uninstall],
  [root+'/release.json',Buffer.from(JSON.stringify(manifest))],[root+'/installation.json',Buffer.from(JSON.stringify({schema:1,artifact_sha256:'2'.repeat(64)}))],
  ['/usr/local/bin/lightmoni-agent',Buffer.from('#!/bin/sh\n# fixture launcher\n')],
  ['/etc/systemd/system/lightmoni-agent.service',readFileSync(path.resolve(import.meta.dirname,'../../deploy/agent/lightmoni-agent.service'))],
  ['/etc/lightmoni-agent/config.json',Buffer.from(JSON.stringify({runtime_mode:'user',permission_generation:1}))],
  ['/var/lib/lightmoni-agent/identity.json',Buffer.from(JSON.stringify({agent_id:'fixture-agent'}))],
 ]);
 const binary=new Set([root+'/node',root+'/app/runtime/dist/agent/main.js',root+'/uninstall.sh']);
 const descriptors=new Map<number,{file:string;position:number}>();let next=0,maxRead=0,binaryWholeReads=0,reads=0;
 const missing=()=>{throw Object.assign(Error('fixture file absent'),{code:'ENOENT'});};
 const info=(file:string)=>{const directory=file==='/'||[...files.keys()].some(name=>name.startsWith(file+'/'));
  if(!directory&&!files.has(file)&&file!=='/opt/lightmoni-agent/current')missing();
  return {uid:0,mode:directory?0o755:0o644,size:files.get(file)?.length??0,isSymbolicLink:()=>file==='/opt/lightmoni-agent/current',isDirectory:()=>directory,isFile:()=>files.has(file)};};
 const fs={
  lstatSync:info,existsSync:(file:string)=>files.has(file)||[...files.keys()].some(name=>name.startsWith(file+'/')),
  realpathSync:(file:string)=>file==='/opt/lightmoni-agent/current'?root:file,
  readFileSync(file:string,encoding?:string){if(binary.has(file)){binaryWholeReads++;throw Error('large runtime file was buffered');}const bytes=files.get(file)??missing();return encoding?bytes.toString(encoding as BufferEncoding):bytes;},
  openSync(file:string){if(!files.has(file))missing();const fd=++next;descriptors.set(fd,{file,position:0});return fd;},
  closeSync(fd:number){descriptors.delete(fd);},
  readSync(fd:number,buffer:Buffer,offset:number,length:number,position:number|null){reads++;maxRead=Math.max(maxRead,length);assert.ok(length<=65536,'inline hash read exceeded 64 KiB');
   const descriptor=descriptors.get(fd)!;const bytes=files.get(descriptor.file)!;const start=position??descriptor.position,n=Math.max(0,Math.min(length,bytes.length-start));bytes.copy(buffer,offset,start,start+n);if(position===null)descriptor.position+=n;return n;},
 };
 const run=()=>{let stdout='';const process={arch:'x64',stdout:{write:(value:string)=>{stdout+=value;}},exitCode:0};
  runInNewContext(agentUpdateProbeSource,{Buffer,process,require(name:string){
   if(name==='node:fs')return fs;if(name==='node:path')return path;if(name==='node:crypto')return {createHash};
   if(name==='node:child_process')return {execFileSync(file:string,args:string[]){
    if(file==='systemctl'){
     const helper=args[1]==='lightmoni-agent-helper.service',property=args.find(a=>a.startsWith('--property='));
     if(property==='--property=LoadState')return helper?'not-found':'loaded';if(property==='--property=FragmentPath')return helper?'':'/etc/systemd/system/lightmoni-agent.service';
     if(property==='--property=ActiveState')return 'active';if(property==='--property=DropInPaths')return '';throw Error('unexpected systemctl property');
    }
    assert.equal(args[0],'status');return JSON.stringify({agent_id:'fixture-agent',boot_id:boot,runtime:{uid:995,gid:995,mode:'user',permission_generation:1}});
   }};throw Error('unexpected inline module');
  }},{timeout:2000});return parseAgentUpdateProbe(stdout);
 };
 const expected=()=>{const release={version:manifest.version,source_revision:manifest.source_revision,build_id:manifest.build_id,state_schema:1,artifact_sha256:'2'.repeat(64),arch:'amd64'};
  return sha(JSON.stringify({release_path:root,release,manifest:sha(files.get(root+'/release.json')!),launcher:sha(files.get('/usr/local/bin/lightmoni-agent')!),service:sha(files.get('/etc/systemd/system/lightmoni-agent.service')!),helper_service:'',node:sha(node),entrypoint:sha(main),uninstaller:sha(uninstall)}));};
 return {run,expected,node,main,uninstall,metrics:()=>({maxRead,binaryWholeReads,reads,openDescriptors:descriptors.size})};
}

test('the actual inline SSH probe uses bounded 64 KiB reads and preserves the buffered fingerprint',()=>{
 const f=inlineFixture();assert.equal(f.run().current.fingerprint,f.expected());
 assert.deepEqual({...f.metrics(),reads:0},{maxRead:65536,binaryWholeReads:0,reads:0,openDescriptors:0});assert.ok(f.metrics().reads>20);
});

for(const name of ['main','uninstall'] as const)test('inline SSH probe hashes '+name+' changes beyond its first block',()=>{
 const f=inlineFixture(),before=f.run().current.fingerprint;f[name][65536+7]^=1;
 assert.notEqual(f.run().current.fingerprint,before);assert.equal(f.run().current.fingerprint,f.expected());assert.equal(f.metrics().binaryWholeReads,0);
});

test('inline SSH probe verifies the manifest node digest beyond its first block and closes descriptors',()=>{
 const f=inlineFixture();f.node[65536+7]^=1;assert.throws(()=>f.run(),{status:409,message:'当前 Agent 安装未通过受管指纹、账户或状态检查，请先核对安装或审阅恢复卸载'});assert.equal(f.metrics().openDescriptors,0);assert.equal(f.metrics().binaryWholeReads,0);
});

test('remote status retains only validated recovery and worker exit evidence',()=>{
 const release={version:'0.1.0',source_revision:'1'.repeat(40),build_id:'fixture-build',state_schema:1,artifact_sha256:'2'.repeat(64),arch:'amd64',fingerprint:'3'.repeat(64),boot_id:''};
 const status={schema:1,operation_id:'a'.repeat(32),agent_id:'fixture-agent',status:'failed',from:release,target:release,
  local_health:{service_active:true,helper_active:false,identity_matches:true,release_matches:true,boot_id:''},started_at:'2026-11-04T00:00:00Z',updated_at:'2026-11-04T00:00:00Z',
  recovery:{schema:1,status:'succeeded',action:'archive_preparing',source_status:'preparing',recovered_at:'2026-11-04T00:00:00Z'},worker_exit:{schema:1,result:'signal',exit_code:'killed',exit_status:9,memory_peak_bytes:12345}};
 assert.deepEqual(parseAgentUpdateStatus(JSON.stringify(status)).worker_exit,status.worker_exit);assert.deepEqual(parseAgentUpdateStatus(JSON.stringify(status)).recovery,status.recovery);
 for(const recovery of [null,{...status.recovery,action:'replay_worker'},{...status.recovery,secret:'unexpected'},{...status.recovery,recovered_at:'invalid'}])assert.throws(()=>parseAgentUpdateStatus(JSON.stringify({...status,recovery})),/invalid_response/);
 for(const worker_exit of [null,{...status.worker_exit,result:'arbitrary-value'},{...status.worker_exit,exit_status:256},{...status.worker_exit,memory_peak_bytes:-1},{...status.worker_exit,secret:'unexpected'}])assert.throws(()=>parseAgentUpdateStatus(JSON.stringify({...status,worker_exit})),/invalid_response/);
});

test('recovery bootstrap validates its operation and fixed runner digest',()=>{
 assert.throws(()=>agentUpdateRecoveryBootstrap('../escape','a'.repeat(64)));assert.throws(()=>agentUpdateRecoveryBootstrap('a'.repeat(32),'bad'));
 const command=agentUpdateRecoveryBootstrap('a'.repeat(32),'b'.repeat(64));assert.match(command,/mktemp -d/);assert.match(command,/flock/);assert.match(command,/600000/);assert.match(command,/sha256/);
 assert.equal(command.includes('/opt/lightmoni-agent/update-runner.mjs'),false);assert.equal(command.includes('download_token'),false);
});

test('the actual recovery bootstrap verifies stdin source before executing its fixed recover command',()=>{
 const operation='a'.repeat(32),source=Buffer.from('// fixed maintenance implementation\n'),request={operation_id:operation};
 const run=(bytes:Buffer,reply:{status:number;stdout:string}={status:0,stdout:'{"status":"failed"}'})=>{
  let stdout='',spawned=0;const written=new Map<string,Buffer>();const listeners=new Map<string,(value?:string)=>void>();
  const process={execPath:'/bundled/node',argv:['node','/private/root-recovery'],stdin:{on:(name:string,callback:(value?:string)=>void)=>listeners.set(name,callback)},stdout:{write:(value:string)=>{stdout+=value;}},exit:()=>{throw Error('unexpected exit');}};
  runInNewContext(agentUpdateRecoveryBootstrapSource(operation,sha(source)),{Buffer,process,require(name:string){
   if(name==='node:crypto')return {createHash};
   if(name==='node:fs')return {writeFileSync(file:string,value:Buffer,options:any){assert.equal(options.mode,0o600);assert.equal(options.flag,'wx');written.set(file,Buffer.from(value));}};
   if(name==='node:child_process')return {spawnSync(file:string,args:string[],options:any){spawned++;assert.equal(file,'flock');assert.deepEqual(Array.from(args),['-n','/run/lightmoni-agent-recovery.guard','/bundled/node','/private/root-recovery/update-runner.mjs','recover','--operation',operation]);assert.equal(options.input,JSON.stringify(request));assert.equal(options.timeout,600000);return reply;}};
   throw Error('unexpected bootstrap module');
  }},{timeout:1000});listeners.get('data')!(JSON.stringify({runner_base64:bytes.toString('base64'),request}));listeners.get('end')!();
  return {output:JSON.parse(stdout),spawned,written};
 };
 const good=run(source);assert.equal(good.spawned,1);assert.equal(good.written.size,1);assert.deepEqual(good.output,{status:'failed'});
 const altered=run(Buffer.from('// changed source'));assert.equal(altered.spawned,0);assert.equal(altered.written.size,0);assert.equal(altered.output.error_code,'recovery_bootstrap_unverified');
 const running=run(source,{status:1,stdout:''});assert.equal(running.output.error_code,'recovery_guard_busy');
 const rejected=run(source,{status:1,stdout:'{"error_code":"recovery_worker_running"}'});assert.equal(rejected.output.error_code,'recovery_worker_running');
});
