import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,chmod,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {inspectRecoveryReview} from '../src/operations/instance-recovery-review.js';
import type {OperationExecutionContext} from '../src/operations/types.js';

async function fixture(t:any){
 const root=await realpath(resolve(await mkdtemp(join(tmpdir(),'lm-recovery-review-')))),platform=join(root,'operations','platform'),data=join(platform,'applications','application1','instances','old1');
 await mkdir(data,{recursive:true,mode:0o700});
 await writeFile(join(platform,'.lightmoni-owner.json'),JSON.stringify({version:1,domain:'platform',root}),{mode:0o600});
 const manifest=JSON.stringify({services:{app:{image:'nginx:alpine',environment:{PASSWORD:'must-stay-private'}}}}),digest=createHash('sha256').update(manifest).digest('hex'),version=join(data,'versions',digest);
 await mkdir(version,{recursive:true,mode:0o700});await writeFile(join(version,'compose.json'),manifest,{mode:0o600});
 await writeFile(join(data,'state.json'),JSON.stringify({version:2,application_id:'application1',instance_id:'old1',resource_id:'application1',revision:3,digest,manifest:join(version,'compose.json')}),{mode:0o600});
 t.after(()=>rm(root,{recursive:true,force:true}));
 const calls:string[][]=[],container='a'.repeat(64);
 let labels:Record<string,string>={'io.lightmoni.platform.instance':'old1','io.lightmoni.platform.owner':'lightmoni','io.lightmoni.platform.application':'application1'};
 const context={dataDir:root,now:()=>new Date('2026-11-06T00:00:00Z'),signal:new AbortController().signal,
  command:async(command:string,args:string[])=>{assert.equal(command,'docker');calls.push(args);return {stdout:args[0]==='ps'?container+'\n':JSON.stringify([{Id:container,State:{Running:true},Config:{Labels:labels},Mounts:[{Type:'bind',Source:join(data,'data'),Destination:'/data',RW:true}],HostConfig:{PortBindings:{'8080/tcp':[{HostPort:'21000'}]}}}]),stderr:'',code:0}}} as unknown as OperationExecutionContext;
 return {root,platform,data,calls,context,container,input:{plan_id:'plan1',stage:'plan',instances:[{instance_id:'old1',owner_id:'application1',kind:'workload'}]},setLabels(value:Record<string,string>){labels=value}};
}
test('review inventory reads actual managed files and deduplicated owned containers without writes or secret contents',async t=>{
 const f=await fixture(t),before=await readdir(f.root,{recursive:true}),state=await readFile(join(f.data,'state.json'),'utf8');
 const result=await inspectRecoveryReview(f.input,f.context),p=result.instances[0];
 assert.deepEqual(p.containers,[f.container]);assert.equal(p.managed_state,true);assert.equal(p.data_present,true);assert.equal(p.data_path,f.data);assert.match(p.inventory_sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(p.mounts,[{container_id:f.container,type:'bind',source:join(f.data,'data'),target:'/data',read_only:false}]);
 assert.doesNotMatch(JSON.stringify(result),/must-stay-private|password|HostPort|Labels/);
 assert.equal(f.calls.length,4);assert.ok(f.calls.every(c=>['ps','inspect'].includes(c[0])));
 assert.deepEqual(await readdir(f.root,{recursive:true}),before);assert.equal(await readFile(join(f.data,'state.json'),'utf8'),state);
 const again=await inspectRecoveryReview({...f.input,stage:'apply'},f.context);assert.equal(again.instances[0].inventory_sha256,p.inventory_sha256);
});
test('review inventory rejects foreign containers, unsafe directories, symlinks, invalid state and unfinished operations',async t=>{
 for(const mode of ['foreign','world-writable','symlink','invalid-state','owner-marker','lock','foreign-state','foreign-application','foreign-manifest','application-parent-link']){
  const f=await fixture(t);
  if(mode==='foreign')f.setLabels({'io.lightmoni.platform.instance':'other','io.lightmoni.platform.owner':'lightmoni'});
  if(mode==='world-writable')await chmod(f.data,0o777);
  if(mode==='symlink'){await rm(join(f.data,'state.json'));await symlink('/etc/passwd',join(f.data,'state.json'));}
  if(mode==='invalid-state')await writeFile(join(f.data,'state.json'),'invalid');
  if(mode==='owner-marker')await writeFile(join(f.platform,'.lightmoni-owner.json'),JSON.stringify({version:1,domain:'platform',root:'/different'}));
  if(mode==='lock')await mkdir(join(f.root,'operations','execution.lock'));
  if(mode==='application-parent-link'){const app=join(f.platform,'applications','application1');await import('node:fs/promises').then(fs=>fs.rename(app,app+'-retained'));await symlink(app+'-retained',app);}
  if(mode==='foreign-state'||mode==='foreign-application'||mode==='foreign-manifest'){const state=JSON.parse(await readFile(join(f.data,'state.json'),'utf8'));if(mode==='foreign-state')state.resource_id='another-app';else if(mode==='foreign-application')state.application_id='another-app';else state.manifest='/etc/passwd';await writeFile(join(f.data,'state.json'),JSON.stringify(state));}
  await assert.rejects(inspectRecoveryReview(f.input,f.context),/INSTANCE_RECOVERY_OWNERSHIP_UNVERIFIED/,mode);
 }
});
