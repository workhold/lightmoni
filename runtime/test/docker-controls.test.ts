import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dockerFixture,containerID} from './fixtures/docker-control-fixture.js';
import {registerDockerJobs} from '../src/ops/docker.js';
import {HTTPError} from '../src/shared/http.js';

const path='/ops/machines/machine-a/docker-jobs';

function historicalJob(f:Awaited<ReturnType<typeof dockerFixture>>) {
 const at=new Date().toISOString(),id=randomUUID();
 f.db.run(`INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,capabilities_json,actions_json,target_json,issued_at,expires_at,lease_id,receipt_json,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,'node-a','legacy-docker','legacy-operation','succeeded',JSON.stringify(['docker.control']),JSON.stringify([{kind:'docker',operation:'stop',container_id:containerID}]),JSON.stringify({docker_machine_id:'machine-a'}),at,at,'historical-secret-lease',JSON.stringify({code:'',stdout:'private daemon output',stderr:'private diagnostic'}),at,at);
 return id;
}

test('all legacy Docker dispatch operations including inventory return gone and create no jobs',async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 f.jobs.enqueue=()=>{throw Error('removed Docker dispatch must not enqueue');};
 f.jobs.get=()=>{throw Error('removed Docker dispatch must not load jobs');};
 f.deps.decrypt=()=>{throw Error('removed Docker dispatch must not decrypt');};
 for(const operation of ['inventory','start','stop','restart','unrecognized']) {
  const body={operation,request_id:randomUUID(),confirmed:true,...(operation==='inventory'?{}:{container_id:containerID})};
  for(let attempt=0;attempt<2;attempt++) {
   const response=await f.req(path,'POST',body);assert.equal(response.status,410);assert.equal(response.body.error,'legacy_agent_payload_removed');
  }
 }
 assert.equal((await f.req('/ops/machines/nonexistent/docker-jobs','POST',{})).status,410);
 const malformed=await fetch(f.base+'/api/v1'+path,{method:'POST',headers:{'content-type':'application/json'},body:'{invalid-json'});
 assert.equal(malformed.status,410);assert.equal((await malformed.json()).error,'legacy_agent_payload_removed');
 assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);
 assert.deepEqual(f.calls,[]);
});

test('legacy Docker dispatch refuses before request parsing, host resolution or job-store access',()=>{
 let post:((ctx:any)=>unknown)|undefined;
 const unavailable=()=>{throw Error('removed dispatch accessed a legacy dependency');};
 const deps:any={router:{get(){},post(_path:string,handler:(ctx:any)=>unknown){post=handler;}}};
 registerDockerJobs(deps,{get:unavailable,enqueue:unavailable} as any,fn=>fn,unavailable);
 assert.ok(post);
 assert.throws(()=>post!({body:unavailable}),error=>error instanceof HTTPError&&error.status===410&&error.message==='legacy_agent_payload_removed');
});

test('removed Docker dispatch stays administrator-only',async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 const response=await f.req(path,'POST',{operation:'inventory',request_id:randomUUID()},{'x-role':'member'});
 assert.equal(response.status,403);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);assert.deepEqual(f.calls,[]);
});

test('historical Docker receipts remain host-bound, redacted and read-only',async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 const id=historicalJob(f),before=f.db.get<any>('SELECT * FROM agent_jobs WHERE id=?',id);
 const historical=await f.req(path+'/'+id);
 assert.equal(historical.status,200);assert.equal(historical.body.id,id);assert.equal(historical.body.state,'succeeded');assert.equal(historical.body.operation,'stop');
 assert.doesNotMatch(JSON.stringify(historical),/historical-secret-lease|private daemon output|private diagnostic|lease_id|stdout|stderr/);
 assert.equal((await f.req('/ops/machines/machine-b/docker-jobs/'+id)).status,404);
 assert.equal((await f.req(path+'/'+id,'GET',undefined,{'x-role':'member'})).status,403);
 assert.equal((await f.req(path+'/missing')).status,404);
 assert.deepEqual(f.db.get('SELECT * FROM agent_jobs WHERE id=?',id),before);assert.deepEqual(f.calls,[]);
});


test('ordinary Agent Docker heartbeat is historical even when fresh and self-declares control',async t=>{
 const f=await dockerFixture();t.after(()=>f.close());
 const observed_at=f.deps.now().toISOString();
 f.db.run('UPDATE agents SET heartbeat=? WHERE id=?',JSON.stringify({docker_capabilities:['docker.inventory','docker.control'],collectors_status:{applications:'ok'},docker_inventory:{observed_at,state:'ready',containers:[{id:containerID,name:'history',image:'example:1',state:'running',ports:'',deployment_id:''}],truncated:false}}),'node-a');
 const before=f.db.all('SELECT * FROM agent_jobs');
 const response=await f.req('/ops/inventory?machine_id=machine-a');
 assert.equal(response.status,200);
 const host=response.body.hosts[0];
 assert.equal(host.online,true);assert.deepEqual(host.docker_capabilities,[]);assert.equal(host.active_job,'');
 assert.equal(host.state,'stale');assert.equal(host.historical,true);assert.equal(host.management_blocker,'privileged_executor_required');
 assert.equal(host.observed_at,observed_at);assert.equal(host.containers.length,1);assert.equal(host.containers[0].name,'history');
 assert.deepEqual(f.db.all('SELECT * FROM agent_jobs'),before);assert.deepEqual(f.calls,[]);
});
