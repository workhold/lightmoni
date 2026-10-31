import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dockerFixture,containerID} from './fixtures/docker-control-fixture.js';
import {ApplicationObserver} from '../src/agent/application-observer.js';
import {executeDocker,readDockerInventory} from '../src/agent/docker.js';
import {operationCommand} from '../src/agent/operations.js';

const path='/ops/machines/machine-a/docker-jobs';
const inventory=()=>({operation:'inventory',request_id:randomUUID()});

test('Docker immediate collection crosses HTTP, authenticated Agent lease and durable receipt, without lease disclosure',async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 assert.equal((await f.req('/ops/inventory?machine_id=machine-a')).body.hosts[0].error,'docker_cli_missing');
 assert.equal((await f.req(path,'POST',inventory(),{'x-role':'member'})).status,403);
 const body=inventory(),created=await f.req(path,'POST',body);assert.equal(created.status,202);assert.equal(created.body.state,'queued');assert.equal(created.body.lease_id,undefined);
 assert.equal((await f.req(path,'POST',inventory())).body.id,created.body.id);
 assert.equal((await f.req(path,'POST',body)).body.id,created.body.id);
 assert.equal((await f.req(path,'POST',{...body,operation:'stop',container_id:containerID,confirmed:true})).status,409);
 assert.equal((await f.req('/agents/node-a/jobs/claim','POST',{capabilities:['docker.inventory']})).status,403);
 assert.equal((await f.req('/ops/machines/machine-b/docker-jobs/'+created.body.id)).status,404);
 assert.equal((await f.req(path+'/'+created.body.id,'GET',undefined,{'x-role':'member'})).status,403);
 assert.equal((await f.runner.pollOnce())?.state,'succeeded');
 const job=await f.req(path+'/'+created.body.id);assert.equal(job.body.state,'succeeded');assert.doesNotMatch(JSON.stringify(job),/fixture-control|lease_id|stdout|stderr/);
 const host=(await f.req('/ops/inventory?machine_id=machine-a')).body.hosts[0];assert.equal(host.state,'ready');assert.equal(host.containers.length,2);assert.equal(host.containers[1].state,'exited');assert.equal(host.error,'');
 assert.equal((await f.req(path,'POST',body)).body.id,created.body.id);
 assert(f.calls.every(args=>args[0]==='--context'&&args[1]==='default'));
});

test('Docker writes require confirmation, fresh same-host full ID, execute once and refresh the inventory',async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 const body={operation:'stop',container_id:containerID,request_id:randomUUID()};
 assert.equal((await f.req(path,'POST',body)).body.error,'docker_confirmation_required');
 assert.equal((await f.req(path,'POST',{...body,confirmed:true})).body.error,'docker_fresh_inventory_required');
 await f.req(path,'POST',inventory());await f.runner.pollOnce();
 assert.equal((await f.req(path,'POST',{...body,container_id:'--all',confirmed:true})).status,400);
 assert.equal((await f.req(path,'POST',{...body,container_id:'f'.repeat(64),confirmed:true})).status,409);
 const created=await f.req(path,'POST',{...body,confirmed:true});assert.equal(created.status,202);
 assert.equal((await f.req(path,'POST',{...body,confirmed:true})).body.id,created.body.id);
 const receipt=await f.runner.pollOnce();assert.equal(receipt?.state,'succeeded');
 assert.equal((await f.req(path,'POST',{...body,confirmed:true})).body.id,created.body.id);
 assert.equal((await f.req('/ops/inventory?machine_id=machine-a')).body.hosts[0].containers[0].state,'exited');
 assert.equal(await f.runner.pollOnce(),null);assert.equal(f.calls.filter(args=>args[2]==='stop').length,1);
 const stored=f.jobs.get(created.body.id);assert.equal(stored.target.actor,'admin');assert.equal(stored.target.docker_machine_id,'machine-a');
});

test('offline/old Agents fail explicitly and old cached observations do not supersede newer immediate results',async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 f.db.run("UPDATE agents SET heartbeat='{}'");assert.equal((await f.req(path,'POST',inventory())).body.error,'docker_agent_upgrade_required');
 f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify(f.heartbeat));
 await f.req(path,'POST',inventory());await f.runner.pollOnce();
 f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify({...f.heartbeat,docker_inventory:{...f.heartbeat.docker_inventory,attempted_at:undefined,observed_at:new Date(0).toISOString(),state:'ready'}}));
 assert.equal((await f.req('/ops/inventory?machine_id=machine-a')).body.hosts[0].containers.length,2);
 f.advance(121000);assert.equal((await f.req(path,'POST',inventory())).body.error,'docker_agent_offline');
});

test('inventory collection preserves old containers and safe diagnostic; query is shared without waiting for app logs',async()=>{
 let fail=false,count=0;const command:any=async()=>{count++;await Promise.resolve();if(fail)throw Object.assign(Error('private raw error'),{code:'docker_permission_denied'});return {stdout:JSON.stringify({ID:containerID,Names:'app',Image:'busybox',State:'running'}),stderr:''}};
 const observer=new ApplicationObserver({} as any,command);
 await Promise.all([observer.refreshInventory(),observer.refreshInventory()]);assert.equal(count,1);
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
