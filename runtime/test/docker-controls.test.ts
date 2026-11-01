import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dockerFixture,containerID} from './fixtures/docker-control-fixture.js';
import {ApplicationObserver} from '../src/agent/application-observer.js';
import {executeDocker,readDockerInventory} from '../src/agent/docker.js';
import {operationCommand} from '../src/agent/operations.js';
import {AgentJobRunner} from '../src/agent/jobs.js';

const path='/ops/machines/machine-a/docker-jobs';
const inventory=()=>({operation:'inventory',request_id:randomUUID()});

for(const operation of ['inventory','start','stop','restart'])test('ordinary Agent refuses legacy Docker '+operation+' before any daemon or payload request',async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 const created=f.jobs.enqueue({agentID:'node-a',deploymentID:'legacy-docker',operationID:randomUUID(),actions:[{kind:'docker',operation,...(operation==='inventory'?{}:{container_id:containerID})}],capabilities:[operation==='inventory'?'docker.inventory':'docker.control'],target:{docker_machine_id:'machine-a'}});
 const leased=f.jobs.claim('node-a',[operation==='inventory'?'docker.inventory':'docker.control']);assert.equal(leased.id,created.id);const requests=[];
 const runner=new AgentJobRunner({endpoint:f.base,agentID:'node-a',controlCredential:'fixture-control',dataDir:f.root},{command:f.command,fetch:(async(url:any,init:RequestInit)=>{requests.push(String(url));return String(url).endsWith('/jobs/claim')?Response.json({job:leased}):fetch(url,init)}) as typeof fetch});
 assert.equal((await runner.pollOnce())?.code,'privileged_executor_required');assert.equal(f.calls.length,0);
 assert.equal(requests.some(url=>url.includes('/operations')||url.includes('/artifact')),false);
 assert.equal(f.jobs.get(created.id).state,'failed');assert.equal(f.jobs.get(created.id).receipt.code,'privileged_executor_required');
});

test('inventory collection preserves old containers and safe diagnostic; query is shared without waiting for app logs',async()=>{
 let fail=false,count=0;const command:any=async()=>{count++;await Promise.resolve();if(fail)throw Object.assign(Error('private raw error'),{code:'docker_permission_denied'});return {stdout:JSON.stringify({ID:containerID,Names:'app',Image:'busybox',State:'running'}),stderr:''}};
 const observer=new ApplicationObserver({} as any,command);
 await Promise.all([observer.refreshInventory(),observer.refreshInventory()]);assert.equal(count,2);
 fail=true;await assert.rejects(observer.refreshInventory());assert.equal(observer.inventory?.containers.length,1);assert.equal(observer.inventory?.error,'docker_permission_denied');assert(observer.inventory?.attempted_at);assert.doesNotMatch(JSON.stringify(observer.inventory),/private/);
});

test('unverified or mismatched Agent receipts are bounded and cannot report Docker success',async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 const job=(await f.req(path,'POST',inventory())).body,lease=f.jobs.claim('node-a',['docker.inventory'])!;
 let seq=0;for(const phase of ['accepted','staging','activating','verifying'])f.jobs.event('node-a',job.id,{lease_id:lease.lease_id,sequence:++seq,phase,summary:'safe',snapshot:{password:'hidden'}});
 const result=f.jobs.result('node-a',job.id,{lease_id:lease.lease_id,state:'succeeded',summary:'password=hidden',snapshot:{health:{healthy:true},docker:{operation:'stop',container_id:containerID,inventory:{}}}});
 assert.equal(result.state,'failed');assert.equal(result.receipt.code,'invalid_docker_receipt');assert.doesNotMatch(JSON.stringify(result),/hidden/);
 assert(f.db.all<any>('SELECT snapshot_json FROM agent_job_events').every(row=>!row.snapshot_json.includes('hidden')));
});

test('queued Docker tasks expire; mutation interruption retains unknown result and writer fence',async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 const queued=(await f.req(path,'POST',inventory())).body;f.advance(121000);f.jobs.claim('node-a',['docker.inventory']);assert.equal(f.jobs.get(queued.id).state,'cancelled');
 const events:string[]=[];let calls=0;
 const result=await executeDocker({kind:'docker',operation:'restart',container_id:containerID},randomUUID(),{dataDir:f.root,now:()=>new Date(),signal:new AbortController().signal,command:async(_file,args)=>{calls++;if(args.includes('inspect'))return {stdout:containerID+' running',stderr:''};throw Error('secret from daemon')}},async e=>{events.push(e.phase)});
 assert.equal(result.state,'unknown');assert.doesNotMatch(JSON.stringify(result),/secret from daemon/);assert.equal(calls,2);
 const second=await executeDocker({kind:'docker',operation:'stop',container_id:containerID},randomUUID(),{dataDir:f.root,now:()=>new Date(),signal:new AbortController().signal,command:f.command},async()=>{});
 assert.equal(second.code,'operations_node_locked');assert.equal(f.calls.length,0);
});

test('Docker output count/size is bounded and private fields never leave inventory',async()=>{
 const snapshot=await readDockerInventory(async()=>({stdout:Array.from({length:501},(_,i)=>JSON.stringify({ID:i.toString(16).padStart(64,'0'),Names:'n'.repeat(256),Image:'i'.repeat(256),State:'running',Ports:'p'.repeat(1024),Labels:'password=hidden',Env:['SECRET=hidden']})).join('\n'),stderr:''}));
 assert(snapshot.truncated);assert(Buffer.byteLength(JSON.stringify(snapshot))<=80*1024);assert(snapshot.containers.length<500);assert.doesNotMatch(JSON.stringify(snapshot),/SECRET|hidden/);
});

test('real local Docker inventory reads public fields through the production bounded command', {skip:process.env.LIGHTMONI_DOCKER_LIVE!=='1'},async()=>{
 const snapshot=await readDockerInventory(operationCommand);assert.equal(snapshot.state,'ready');assert(snapshot.containers.every(c=>/^[a-f0-9]{64}$/.test(c.id)));
});

test('real Docker start, restart and stop verify state on an isolated disposable container', {skip:process.env.LIGHTMONI_DOCKER_LIVE!=='1'},async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 const created=await operationCommand('docker',['--context','default','create','--network','none','--name','lightmoni-057-'+randomUUID(),'--label','io.lightmoni.qa=057','alpine:3.23','sleep','600'],{timeoutMs:15000});
 const id=created.stdout.trim();assert.match(id,/^[a-f0-9]{64}$/);
 t.after(async()=>{await operationCommand('docker',['--context','default','rm','--force',id],{timeoutMs:15000})});
 for(const operation of ['start','restart','stop'] as const){
  const result=await executeDocker({kind:'docker',operation,container_id:id},randomUUID(),{dataDir:f.root,now:()=>new Date(),signal:new AbortController().signal,command:operationCommand},async()=>{});
  assert.equal(result.state,'succeeded',JSON.stringify(result));
  const data=result.snapshot.docker as any;assert.equal(data.container_state,operation==='stop'?'exited':'running');
 }
});
