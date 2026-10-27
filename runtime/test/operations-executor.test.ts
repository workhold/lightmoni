import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, access, readFile, realpath, rename, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { operationCommand, executeOperation } from '../src/agent/operations.js';
import { operationTools } from '../src/assistant/operation-tools.js';
import type { OperationsStore } from '../src/operations/types.js';

test('operations commands do not inherit Docker remote or private process environment', async t => {
 const keys=['DOCKER_HOST','LIGHTMONI_TEST_PRIVATE'];
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.DOCKER_HOST='tcp://unintended.example:2375';process.env.LIGHTMONI_TEST_PRIVATE='dummy-test-private';
 t.after(()=>{for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];});
 const r=await operationCommand(process.execPath,['-e','process.stdout.write(JSON.stringify({docker:process.env.DOCKER_HOST,private:process.env.LIGHTMONI_TEST_PRIVATE,locale:process.env.LC_ALL}))']);
 assert.deepEqual(JSON.parse(r.stdout),{locale:'C'});
});

test('a command timeout terminates the POSIX descendant process group', {skip:process.platform==='win32'}, async t=>{
 const root=await mkdtemp(join(tmpdir(),'lightmoni-ops-process-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const marker=join(root,'orphan-wrote-file');
 const descendant=`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected'),1200)`;
 const parent=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
 await assert.rejects(operationCommand(process.execPath,['-e',parent],{timeoutMs:400}),/operation_command_timeout/);
 await new Promise(r=>setTimeout(r,1000));
 await assert.rejects(access(marker));
});

test('AI tools omit raw application log receipts and cannot approve operations',async()=>{
 const store={getRun:()=>({id:'run',operation:'logs',receipt:{snapshot:{operations:{data:{logs:'unknown customer password',sensitive_logs:true}}}},review_url:'/operations?run=run'})} as unknown as OperationsStore;
 const tools=operationTools(store),tool=tools.find(t=>t.name==='get_operations_run')!;
 assert.equal(tools.some(t=>/approve|execute/.test(t.name)),false);
 const result=await tool.execute({id:'run'},new AbortController().signal,{id:'admin',name:'Admin',role:'admin'}as any);
 assert.equal(JSON.stringify(result).includes('customer password'),false);
 assert.equal((result as any).run.receipt,null);
});

test('durable node writer lock survives unknown results and rejects concurrent runners',async t=>{
 const {acquireOperationLock}=await import('../src/agent/operation-lock.js');
 const root=await mkdtemp(join(tmpdir(),'lightmoni-ops-lock-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=await acquireOperationLock(root,'first',new Date());
 await assert.rejects(acquireOperationLock(root,'second',new Date()),/operations_node_locked/);
 await first.finish(true);
 await assert.rejects(acquireOperationLock(root,'after-restart',new Date()),/operations_node_locked/);
 // Explicit operator recovery after inspecting the node; never an automatic stale-PID timeout.
 await rm(join(root,'operations','execution.lock'));
 const recovered=await acquireOperationLock(root,'recovered',new Date());await recovered.finish(false);
 const next=await acquireOperationLock(root,'next',new Date());await next.finish(false);
});

test('node writer exclusion spans processes and a crashed writer never expires automatically',async t=>{
 const {acquireOperationLock}=await import('../src/agent/operation-lock.js');
 const root=await realpath(await mkdtemp(join(tmpdir(),'lightmoni-ops-lock-process-')));
 const moduleURL=new URL('../src/agent/operation-lock.ts',import.meta.url).href;
 const source=`const {acquireOperationLock}=await import(${JSON.stringify(moduleURL)});await acquireOperationLock(${JSON.stringify(root)},'child-writer',new Date());process.stdout.write('LOCKED\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}await rm(root,{recursive:true,force:true});});
 let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('child did not acquire writer lock: '+stderr)),5000);
  child.stdout.on('data',chunk=>{if(chunk.toString().includes('LOCKED')){clearTimeout(timer);resolve();}});
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);reject(Error('lock child exited '+code+': '+stderr));});
 });
 await assert.rejects(acquireOperationLock(root,'concurrent-parent',new Date()),/operations_node_locked/);
 const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 assert.equal(JSON.parse(await readFile(join(root,'operations','execution.lock'),'utf8')).state,'executing');
 await assert.rejects(acquireOperationLock(root,'after-crash',new Date()),/operations_node_locked/);
});

test('finishing an old writer cannot unlink a replacement inode',async t=>{
 const {acquireOperationLock}=await import('../src/agent/operation-lock.js');
 const root=await mkdtemp(join(tmpdir(),'lightmoni-ops-lock-replaced-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const old=await acquireOperationLock(root,'old-writer',new Date()),path=join(root,'operations','execution.lock');
 await rename(path,path+'.operator-retained');
 const replacement=await acquireOperationLock(root,'replacement-writer',new Date());
 await old.finish(false);
 assert.equal(JSON.parse(await readFile(path,'utf8')).operation_id,'replacement-writer');
 await assert.rejects(acquireOperationLock(root,'third-writer',new Date()),/operations_node_locked/);
 await replacement.finish(false);
 const next=await acquireOperationLock(root,'next-writer',new Date());await next.finish(false);
});

test('certificate metadata I/O failure after installing live material is unknown and retains the node lock',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'lightmoni-ops-cert-io-')));
 t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(root+'-public',{recursive:true,force:true});});
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'test.key'),'-out',join(root,'test.crt'),'-days','2','-subj','/CN=example.test','-addext','subjectAltName=DNS:example.test'],{stdio:'ignore'});
 const id='a'.repeat(32),config={domains:['example.test'],certificate_pem:await readFile(join(root,'test.crt'),'utf8'),private_key_pem:await readFile(join(root,'test.key'),'utf8')};
 const original=fs.promises.writeFile;
 fs.promises.writeFile=(async function(file:any,...args:any[]){
  if(typeof file==='string'&&file.includes('/certificates/'+id+'/state.json.'))throw Object.assign(Error('simulated metadata I/O failure'),{code:'EIO'});
  return (original as any)(file,...args);
 }) as typeof original;
 syncBuiltinESMExports();
 let receipt;
 try{
  receipt=await executeOperation({version:1,operation_id:'b'.repeat(32),operation:'install',resource:{id,kind:'certificate',name:'Test certificate',agent_id:'node',revision:1,config,created_at:'',updated_at:''},input:{}},{dataDir:root,publicDir:root+'-public',signal:new AbortController().signal,now:()=>new Date(),command:async()=>({stdout:'',stderr:''})},async()=>{});
 }finally{fs.promises.writeFile=original;syncBuiltinESMExports();}
 assert.equal(await readFile(join(root,'operations','certificates',id,'certificate.pem'),'utf8'),config.certificate_pem);
 await assert.rejects(access(join(root,'operations','certificates',id,'state.json')));
 assert.equal(receipt.state,'unknown');
 assert.equal(JSON.parse(await readFile(join(root,'operations','execution.lock'),'utf8')).state,'unknown');
});

test('a rejected Compose generation cannot poison the node writer lock before any Docker command',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'lightmoni-ops-generation-lock-')));t.after(()=>rm(root,{recursive:true,force:true}));
 let calls=0;
 const receipt=await executeOperation({version:1,operation_id:'d'.repeat(32),operation:'apply',resource:{id:'e'.repeat(32),kind:'compose',name:'Generation conflict',agent_id:'node',revision:1,created_at:'',updated_at:'',config:{project_name:'qa-conflict',compose:{services:{app:{image:'python:3.12-slim'}}}}},input:{expected_generation:1}},{dataDir:root,signal:new AbortController().signal,now:()=>new Date(),command:async()=>{calls++;return{stdout:'',stderr:''};}},async()=>{});
 assert.equal(calls,0);
 assert.equal(receipt.state,'failed');
 await assert.rejects(access(join(root,'operations','execution.lock')));
});

test('a backup source limit rejected before storage write releases the node writer lock',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'lightmoni-ops-backup-rejected-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source'),storage=join(root,'storage'),id='f'.repeat(32);
 await mkdir(source,{mode:0o700});await mkdir(storage,{mode:0o700});await writeFile(join(source,'data.txt'),'too big',{mode:0o600});
 const receipt=await executeOperation({version:1,operation_id:'c'.repeat(32),operation:'create',resource:{id,kind:'backup',name:'Source limit',agent_id:'node',revision:1,created_at:'',updated_at:'',config:{source_path:source,storage:{type:'local',path:storage},max_bytes:1}},input:{}},{dataDir:root,signal:new AbortController().signal,now:()=>new Date(),command:async()=>{throw Error('no shell expected');}},async()=>{});
 assert.equal(receipt.state,'failed');
 assert.deepEqual(await readdir(join(storage,id)),[]);
 await assert.rejects(access(join(root,'operations','execution.lock')));
});
