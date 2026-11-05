import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DB } from '../src/shared/sqlite.js';
import { cipher } from '../src/shared/crypto.js';
import { desiredHash, managedResourceID } from '../src/shared/desired-state.js';
import { ReconciliationRegistry, type DesiredResource } from '../src/reconciliation/registry.js';

function setup(t:any) {
  const root=mkdtempSync(join(tmpdir(),'lm-reconcile-')),path=join(root,'control.db');let ms=Date.parse('2026-11-05T00:00:00Z');
  let db=new DB(path);
  const deps={get db(){return db;},now:()=>new Date(ms),...cipher(Buffer.alloc(32,15)),logger:{info(){},warn(){},error(){}}};
  let registry=new ReconciliationRegistry(deps);
  t.after(async()=>{await registry.close();db.close();rmSync(root,{recursive:true,force:true});});
  return {deps,get db(){return db;},get registry(){return registry;},advance:(n=60001)=>ms+=n,reopen:async()=>{await registry.close();db.close();db=new DB(path);registry=new ReconciliationRegistry(deps);}};
}
const resource=(key='site',machine='m-a',agent='a-a'):DesiredResource=>({key,machine_id:machine,agent_id:agent,owner_id:'website-a',actor:'admin',desired:{ports:[80,443],secret:'private-material'},summary:{domains:['example.com'],ports:[80,443]}});

test('registry persists independent machine targets, encrypted desired and no payload in public inventory',async t=>{
  const f=setup(t);let targets=[resource(),resource('site','m-b','a-b')];
  f.registry.register({kind:'test.deployment',category:'deployment',collect:()=>targets,reconcile:()=>({state:'in_sync'})});
  await f.registry.tick();
  const a=f.registry.inventory('m-a').resources[0],b=f.registry.inventory('m-b').resources[0];
  assert.notEqual(a.id,b.id);assert.equal(a.state,'in_sync');assert.equal(a.observed_generation,a.generation);
  assert(!JSON.stringify(f.registry.inventory('m-a')).includes('private-material'));
  assert(!f.db.get<any>('SELECT desired_cipher FROM reconciliation_resources WHERE id=?',a.id)!.desired_cipher.includes('private-material'));
  await f.reopen();assert.equal(f.registry.get(a.id)?.desired.secret,'private-material');assert.equal(f.registry.inventory('m-a').resources[0].code,'provider_unavailable');
  targets=[];f.registry.register({kind:'test.deployment',category:'deployment',collect:()=>targets,reconcile:r=>({state:r.deleted?'in_sync':'pending'})});
  f.advance();await f.registry.tick();const deleted=f.registry.inventory('m-a').resources[0];assert.equal(deleted.deleted,true);assert.equal(deleted.generation,2);assert.equal(deleted.state,'in_sync');
});
test('snapshot validation is atomic: duplicates/compilation failure cannot imply deletion',async t=>{
  const f=setup(t);let targets=[resource()];
  f.registry.register({kind:'test.file',category:'file',collect:()=>targets,reconcile:()=>({state:'in_sync'})});f.registry.refresh();const old=f.registry.inventory('m-a').resources[0];
  targets=[resource('new'),resource('new')];f.registry.refresh();const all=f.registry.inventory('m-a').resources;
  assert.equal(all.length,1);assert.equal(all[0].id,old.id);assert.equal(all[0].deleted,false);assert.equal(all[0].code,'desired_snapshot_failed');
  targets=[resource()];await f.registry.tick();assert.equal(f.registry.inventory('m-a').resources[0].state,'in_sync');
  assert.throws(()=>f.registry.register({kind:'test.file',category:'file',collect:()=>[],reconcile:()=>({state:'pending'})}),/duplicate/);
});
test('late results cannot acknowledge a new generation and stable JSON does not create spurious revisions',async t=>{
  const f=setup(t);let target=resource(),release!:()=>void,started!:()=>void;
  const waiting=new Promise<void>(r=>started=r),hold=new Promise<void>(r=>release=r);
  f.registry.register({kind:'test.file',category:'file',collect:()=>[target],reconcile:async()=>{started();await hold;return {state:'in_sync'};}});
  const running=f.registry.tick();await waiting;
  target={...target,desired:{secret:'changed',ports:[80,443]}};f.registry.refresh();release();await running;
  const next=f.registry.inventory('m-a').resources[0];assert.equal(next.generation,2);assert.equal(next.state,'pending');assert.equal(next.observed_generation,0);
  target={...target,desired:{ports:[80,443],secret:'changed'}};f.registry.refresh();assert.equal(f.registry.inventory('m-a').resources[0].generation,2);
});
test('known failures retry with bounded backoff, in-flight ticks coalesce and successful state is rechecked',async t=>{
  const f=setup(t);let attempts=0,actual=false;
  f.registry.register({kind:'test.file',category:'file',collect:()=>[resource()],reconcile:()=>{attempts++;return {state:actual?'in_sync':'drifted',code:actual?'':'temporary_failure'};}});
  await Promise.all([f.registry.tick(),f.registry.tick()]);assert.equal(attempts,1);assert.equal(f.registry.inventory('m-a').resources[0].failures,1);
  await f.registry.tick();assert.equal(attempts,1);
  f.advance(5001);await f.registry.tick();assert.equal(attempts,2);
  for(let n=0;n<9;n++){f.advance(300001);await f.registry.tick();}
  const retry=f.registry.inventory('m-a').resources[0];assert.equal(Date.parse(retry.next_attempt_at)-f.deps.now().getTime(),300000);
  actual=true;f.advance(300001);await f.registry.tick();assert.equal(f.registry.inventory('m-a').resources[0].state,'in_sync');assert.equal(f.registry.inventory('m-a').resources[0].failures,0);
  actual=false;f.advance();await f.registry.tick();assert.equal(f.registry.inventory('m-a').resources[0].state,'drifted');
});
test('dependencies must be current and on the same machine; binding changes retain cleanup intent',async t=>{
  const f=setup(t);let agent='a-a',dependencyReady=false,applies=0;
  f.registry.register({kind:'test.dependency',category:'custom',collect:()=>[resource('dependency')],reconcile:()=>({state:dependencyReady?'in_sync':'pending'})});
  f.registry.register({kind:'test.consumer',category:'deployment',collect:()=>[{...resource('consumer','m-a',agent),dependencies:[managedResourceID('test.dependency','m-a','a-a','dependency')]}],reconcile:r=>{applies++;return {state:'in_sync'};}});
  await f.registry.tick();assert.equal(applies,0);
  dependencyReady=true;f.advance();await f.registry.tick();f.advance();await f.registry.tick();assert(applies>=1);
  agent='a-new';f.registry.refresh();const rows=f.registry.inventory('m-a').resources.filter(r=>r.provider==='test.consumer');
  assert.equal(rows.length,2);assert.equal(rows.find(r=>r.agent_id==='a-a')?.deleted,true);assert.equal(rows.find(r=>r.agent_id==='a-new')?.observed_generation,0);
});
test('error sanitization never returns provider exception payload and hash normalizes object order',async t=>{
  const f=setup(t);f.registry.register({kind:'test.error',category:'custom',collect:()=>[resource()],reconcile:()=>{throw Error('PRIVATE KEY private-material');}});await f.registry.tick();
  assert.equal(f.registry.inventory('m-a').resources[0].code,'reconciliation_failed');assert(!JSON.stringify(f.registry.inventory('m-a')).includes('private-material'));
  assert.equal(desiredHash({b:2,a:1}),desiredHash({a:1,b:2}));
});

test('Agent provider compares both actual summaries, changes generation with effective tasks and never claims old Agents are verified',async t=>{
  const {NodeStore}=await import('../src/server/nodes-model.js'),{registerAgentConfiguration}=await import('../src/reconciliation/agent-config.js'),{normalizeRemote}=await import('../src/agent/config.js');
  const f=setup(t),nodes=new NodeStore(f.db,f.deps.now),at=f.deps.now().toISOString();
  f.db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES('m-a','A','host',22,'direct_ssh','a-a',?,?)",at,at);
  f.db.run("INSERT INTO agents VALUES('a-a','h-a','A','1','linux','amd64',?,'{}')",at);
  registerAgentConfiguration(f.deps as any,f.registry);await f.registry.tick();assert.equal(f.registry.inventory('m-a').resources[0].code,'config_observation_required');
  let hash=desiredHash(normalizeRemote(nodes.effective('a-a').config));
  f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify({config_observation:{runtime_hash:hash,persisted_hash:hash}}));f.advance();f.db.run('UPDATE agents SET last_seen=?',f.deps.now().toISOString());await f.registry.tick();
  assert.equal(f.registry.inventory('m-a').resources[0].state,'in_sync');
  f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify({config_observation:{runtime_hash:hash,persisted_hash:'0'.repeat(64)}}));f.advance();f.db.run('UPDATE agents SET last_seen=?',f.deps.now().toISOString());await f.registry.tick();assert.equal(f.registry.inventory('m-a').resources[0].state,'drifted');
  const task=nodes.getTask('platform-default:host');nodes.saveTask({...task,config:{...task.config,collect_interval_seconds:30}});
  f.registry.refresh();assert.equal(f.registry.inventory('m-a').resources[0].generation,2);assert.equal(f.registry.inventory('m-a').resources[0].observed_generation,0);
  hash=desiredHash(normalizeRemote(nodes.effective('a-a').config));f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify({config_observation:{runtime_hash:hash,persisted_hash:hash}}));await f.registry.tick();assert.equal(f.registry.inventory('m-a').resources[0].state,'in_sync');
  f.advance(121000);await f.registry.tick();assert.equal(f.registry.inventory('m-a').resources[0].code,'agent_offline');
});
