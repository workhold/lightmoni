import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {hostDockerHash,hostDockerReceipt,normalizeHostDockerAction,type HostDockerAction} from '../src/shared/host-docker.js';
import {managedExecutionPayload} from '../src/shared/managed-execution.js';
import {fakeHostDocker,hostContainerID,stoppedContainerID,usedImageID,stoppedImageID,unusedImageID,defaultLimits} from './helpers/host-docker-fixture.js';

test('host actions reject arbitrary daemon, raw Docker escapes and malformed config before execution',()=>{
 const valid={kind:'host_docker',operation:'create',config:{name:'qa-test',image_id:unusedImageID,command:['sleep','10'],ports:[],named_volumes:[],start:false,...defaultLimits}};
 assert.deepEqual(normalizeHostDockerAction(valid),valid);
 for(const c of [{...valid,endpoint:'http://other'},{...valid,config:{...valid.config,privileged:true}},{...valid,config:{...valid.config,image_id:'alpine:latest'}},{...valid,config:{...valid.config,named_volumes:[{name:'qa-data',destination:'/run/docker.sock',read_only:false}]}},{...valid,config:{...valid.config,ports:[{host_port:0,container_port:80,protocol:'tcp'}]}},{kind:'host_docker',operation:'remove',container_id:'short',expected_revision:'a'.repeat(64),force:false,remove_anonymous_volumes:false}])assert.throws(()=>normalizeHostDockerAction(c));
 assert.throws(()=>normalizeHostDockerAction({...valid,config:{...valid.config,memory_bytes:1}}));
});

test('inspect exposes only public metadata, locks exact revisions and verifies rename/update/lifecycle',async t=>{
 const f=fakeHostDocker();t.after(()=>f.close());
 const first=await f.run({kind:'host_docker',operation:'inspect',container_id:hostContainerID});assert.equal(first.state,'succeeded');assert.doesNotMatch(JSON.stringify(first),/PASSWORD|hidden/);
 let detail=(first.snapshot.host_docker as any).container;
 const stale=await f.run({kind:'host_docker',operation:'rename',container_id:detail.id,expected_revision:'f'.repeat(64),name:'changed'});assert.equal(stale.state,'failed');assert.equal(stale.code,'host_docker_revision_changed');assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
 for(const input of [{operation:'rename',name:'renamed'},{operation:'update',config:{memory_bytes:32*1024*1024,nano_cpus:500000000,restart_policy:{name:'always',max_retry_count:0}}},{operation:'stop'},{operation:'start'},{operation:'restart'}]){
  const r=await f.run({kind:'host_docker',container_id:detail.id,expected_revision:detail.revision,...input} as HostDockerAction);assert.equal(r.state,'succeeded',JSON.stringify(r));detail=(r.snapshot.host_docker as any).container;
 }
 assert.equal(detail.name,'renamed');assert.equal(detail.memory_bytes,32*1024*1024);assert.equal(detail.state,'running');
});

test('create uses a local full image ID, explicit ports/named volumes and verifies persisted config',async t=>{
 const f=fakeHostDocker();t.after(()=>f.close());
 const action=normalizeHostDockerAction({kind:'host_docker',operation:'create',config:{name:'qa-new',image_id:unusedImageID,command:['sleep','600'],ports:[{host_port:8080,container_port:80,protocol:'tcp'}],named_volumes:[{name:'qa-data',destination:'/data',read_only:true}],start:true,...defaultLimits}});
 const r=await f.run(action);assert.equal(r.state,'succeeded',JSON.stringify(r));const c=(r.snapshot.host_docker as any).container;assert.equal(c.state,'running');assert.equal(c.mounts[0].read_only,true);
 const create=f.calls.find(c=>c.path.includes('/containers/create'))!;assert.equal((create.body as any).HostConfig.NetworkMode,'bridge');assert.equal((create.body as any).HostConfig.Privileged,undefined);assert.equal((create.body as any).Env,undefined);
});

test('remove refuses running containers by default and never requests volume deletion implicitly',async t=>{
 const f=fakeHostDocker();t.after(()=>f.close());const c=(await f.run({kind:'host_docker',operation:'inspect',container_id:hostContainerID})).snapshot.host_docker as any;
 const action:HostDockerAction={kind:'host_docker',operation:'remove',container_id:hostContainerID,expected_revision:c.container.revision,force:false,remove_anonymous_volumes:false};
 const refused=await f.run(action);assert.equal(refused.state,'failed');assert.equal(refused.code,'host_docker_running');
 const result=await f.run({...action,force:true});assert.equal(result.state,'succeeded');assert(!f.containers.has(hostContainerID));assert(f.volumes.has('qa-data'));
 assert(f.calls.some(r=>r.method==='DELETE'&&r.path.endsWith('?force=true&v=false')));
});

test('image cleanup excludes running AND stopped references, only deletes reviewed IDs, and rechecks references',async t=>{
 const f=fakeHostDocker();t.after(()=>f.close());const preview=(await f.run({kind:'host_docker',operation:'images'})).snapshot.host_docker as any;
 assert.equal(preview.images.find((i:any)=>i.id===usedImageID).in_use,true);assert.equal(preview.images.find((i:any)=>i.id===stoppedImageID).in_use,true);
 const candidate=preview.images.find((i:any)=>i.id===unusedImageID);
 const action:HostDockerAction={kind:'host_docker',operation:'prune_images',preview_job_id:'a'.repeat(32),previewed_at:preview.observed_at,images:[{image_id:candidate.id,expected_revision:candidate.revision}]};
 f.containers.get(stoppedContainerID).Image=unusedImageID;
 const skipped=await f.run(action);assert.equal(skipped.state,'succeeded');assert.deepEqual((skipped.snapshot.host_docker as any).skipped,[{id:unusedImageID,reason:'in_use'}]);assert.equal(f.calls.filter(r=>r.method==='DELETE').length,0);
 f.containers.get(stoppedContainerID).Image=stoppedImageID;
 const cleaned=await f.run(action);assert.equal(cleaned.state,'succeeded');assert.deepEqual((cleaned.snapshot.host_docker as any).deleted,[unusedImageID]);assert(f.images.has(usedImageID));assert(f.images.has(stoppedImageID));assert.equal(f.images.size,3);
 assert(f.calls.some(r=>r.method==='DELETE'&&r.path.endsWith('?force=false&noprune=true')));
});

test('cleanup fails before writing on expired preview or changed candidate metadata',async t=>{
 const f=fakeHostDocker();t.after(()=>f.close());const p=(await f.run({kind:'host_docker',operation:'images'})).snapshot.host_docker as any,i=p.images.find((i:any)=>i.id===unusedImageID);
 const a:HostDockerAction={kind:'host_docker',operation:'prune_images',preview_job_id:'a'.repeat(32),previewed_at:p.observed_at,images:[{image_id:i.id,expected_revision:i.revision}]};
 f.images.get(unusedImageID).RepoTags=['other:tag'];const changed=await f.run(a);assert.equal(changed.code,'host_docker_revision_changed');assert.equal(changed.state,'failed');
 f.advance(301000);const expired=await f.run(a);assert.equal(expired.code,'host_docker_preview_expired');assert.equal(expired.state,'failed');assert.equal(f.calls.filter(r=>r.method==='DELETE').length,0);
});

test('daemon pin, final authority, mutation interruption and durable unknown locks prevent replay',async t=>{
 const f=fakeHostDocker();t.after(()=>f.close());const d=((await f.run({kind:'host_docker',operation:'inspect',container_id:hostContainerID})).snapshot.host_docker as any).container;
 f.setDaemon('changed');let r=await f.run({kind:'host_docker',operation:'start',container_id:d.id,expected_revision:d.revision});assert.equal(r.state,'failed');assert.equal(r.code,'docker_daemon_changed');
 f.setDaemon('qa-daemon');f.context.authorize=async()=>{throw Error('execution_cancelled')};r=await f.run({kind:'host_docker',operation:'start',container_id:d.id,expected_revision:d.revision});assert.equal(r.state,'failed');assert.equal(r.code,'execution_cancelled');
 f.context.authorize=async()=>{};f.interrupt();r=await f.run({kind:'host_docker',operation:'start',container_id:d.id,expected_revision:d.revision});assert.equal(r.state,'unknown');assert.doesNotMatch(JSON.stringify(r),/secret daemon/);assert(existsSync(join(f.root,'operations/execution.lock')));
 r=await f.run({kind:'host_docker',operation:'start',container_id:d.id,expected_revision:d.revision});assert.equal(r.code,'operations_node_locked');
});

test('receipt identity and sensitive-field allowlist survive malicious extra data',async t=>{
 const f=fakeHostDocker();t.after(()=>f.close());const a:HostDockerAction={kind:'host_docker',operation:'inspect',container_id:hostContainerID};const r=await f.run(a),data=structuredClone(r.snapshot) as any;data.host_docker.container.Env=['PASSWORD=hidden'];
 assert.doesNotMatch(JSON.stringify(hostDockerReceipt(a,data,r.started_at,new Date())),/PASSWORD|hidden/);
 data.host_docker.container.id=stoppedContainerID;assert.throws(()=>hostDockerReceipt(a,data,r.started_at,new Date()));data.host_docker.container.id=hostContainerID;data.host_docker.request_sha256=hostDockerHash({...a,container_id:stoppedContainerID});assert.throws(()=>hostDockerReceipt(a,data,r.started_at,new Date()));
 const payload={kind:'managed',operation:'execute',resource_id:'a'.repeat(32),resource_revision:1,job:{id:'a'.repeat(32),agent_id:'agent',expires_at:new Date().toISOString(),capabilities:['docker.host'],actions:[a],target:{}},timeout_ms:600000,max_output_bytes:262144};
 assert.equal(managedExecutionPayload(payload).job.actions[0].operation,'inspect');assert.throws(()=>managedExecutionPayload({...payload,job:{...payload.job,capabilities:['docker.control']}}));
});

test('large image inventories page by full IDs without losing candidates or loosening reference checks',async t=>{
 const f=fakeHostDocker();t.after(()=>f.close());for(let n=100;n<605;n++){const id='sha256:'+n.toString(16).padStart(64,'0');f.images.set(id,{Id:id,RepoTags:['qa:page-'+n],Created:1,Size:1024,SharedSize:0})}
 const seen=new Set<string>();let cursor='',pages=0;
 do{const r=await f.run({kind:'host_docker',operation:'images',...(cursor?{cursor}:{})});assert.equal(r.state,'succeeded');const p=r.snapshot.host_docker as any;assert(p.images.length<=100);assert(Buffer.byteLength(JSON.stringify(p))<81000);for(const i of p.images){assert(!seen.has(i.id));seen.add(i.id)}cursor=p.next_cursor;pages++}while(cursor);
 assert.equal(seen.size,509);assert.equal(pages,6);
});

test('a definite create rejection releases the node lane and preserves a reviewable failed result',async t=>{
 const f=fakeHostDocker();t.after(()=>f.close());const config={name:'qa-running',image_id:unusedImageID,command:[],ports:[],named_volumes:[],start:false,...defaultLimits};
 const failed=await f.run({kind:'host_docker',operation:'create',config});assert.equal(failed.state,'failed');assert.equal(failed.code,'host_docker_conflict');assert(!existsSync(join(f.root,'operations/execution.lock')));
 const good=await f.run({kind:'host_docker',operation:'create',config:{...config,name:'corrected'}});assert.equal(good.state,'succeeded');assert.equal((good.snapshot.host_docker as any).container.name,'corrected');
});

test('a missing container image identity fails closed before image deletion',async t=>{
 const f=fakeHostDocker();t.after(()=>f.close());const preview=(await f.run({kind:'host_docker',operation:'images'})).snapshot.host_docker as any,i=preview.images.find((i:any)=>i.id===unusedImageID);
 const actual=f.context.transport;f.context.transport=async request=>request.path.endsWith('/containers/json?all=1')?{statusCode:200,body:[{Id:hostContainerID,ImageID:''}]}:actual(request);
 const r=await f.run({kind:'host_docker',operation:'prune_images',preview_job_id:'a'.repeat(32),previewed_at:preview.observed_at,images:[{image_id:i.id,expected_revision:i.revision}]});assert.equal(r.state,'failed');assert.equal(f.calls.filter(r=>r.method==='DELETE').length,0);
});
