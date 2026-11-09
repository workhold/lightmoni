import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import type { Dependencies } from "../src/shared/types.js";
import { registerTaskCenter } from "../src/server/task-center.js";
import { registerPrivilegedExecutors } from "../src/server/privileged-executors.js";
import { PrivilegedExecutorStore } from "../src/server/privileged-executors.js";
import { canonicalJSON, signExecutorRequest, signJWS, verifyJWS, sha256, planClaims, permitClaims, policyClaims } from "../src/shared/privileged-executor.js";

import {registerAgentJobs} from '../src/server/agent-jobs.js';
import {registerOperations} from '../src/server/operations.js';
import {connectManagedExecutorJobs} from '../src/server/managed-executor-jobs.js';
import {connectExecutorObservations,restoreObservationRows} from '../src/server/executor-observation.js';
import {encodeOTLP,nowNano} from '../src/shared/otlp.js';
import {randomUUID} from 'node:crypto';
import {registerHostDockerJobs} from '../src/ops/host-docker.js';
import {executeHostDocker} from '../src/privileged-executor/host-docker.js';
import {fakeHostDocker,hostContainerID,unusedImageID} from './helpers/host-docker-fixture.js';
import {managedExecutorObservation} from '../src/server/managed-executor-status.js';
import {registerOperationSchedules} from '../src/server/operation-schedules.js';
import {backupDefinition} from '../src/operations/backups.js';
function fixture() {
  const db = new DB(":memory:"), router = new Router(), crypt = cipher(randomBytes(32));
  let clock = new Date("2026-11-01T00:00:00Z");
  const user = { id: "admin", name: "Admin", role: "admin" }, deps = { db, router, now: () => clock,
    externalURL: "https://moni.example.test", encrypt: crypt.encrypt, decrypt: crypt.decrypt,
    auth: { user(req: any) { return req.headers.cookie === "lm_session=human" ? user : undefined; }, requireAdmin(ctx: any) { if (ctx.user.role !== "admin") fail(403, "admin_required"); } },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const tasks = registerTaskCenter(deps);
  db.exec("CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER)");
  db.run("INSERT INTO users(id,name,role,active) VALUES('admin','Admin','admin',1)");
  db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES('host','Host','host.test',22,'direct_ssh','agent-host',?,?)", clock.toISOString(), clock.toISOString());
  db.exec("CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,last_seen TEXT,heartbeat TEXT);CREATE TABLE ops_platform_runs(id TEXT PRIMARY KEY,job_id TEXT,actor TEXT)");
  db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES('agent-host','host','Host','test','linux','arm64',?,'{}')",clock.toISOString());
  const credentials:any={has:()=>true,authenticate:(req:any)=>{if(req.headers.authorization!=='Bearer ordinary-control')fail(401,'control_required')}};
  const jobs=registerAgentJobs(deps,{agentCredentials:credentials});
  const store = registerPrivilegedExecutors(deps, { dataDir: "/unused" });
  const keys = generateKeyPairSync("ed25519"), pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const policy = store.preparePolicyPlan("host", { capabilities: ["script.elevated.v1", "container.managed.v1", "operations.managed.v1"] }, "admin");
  store.applyPolicy("host", policy.id, { confirm: true, expected_revision: policy.revision }, "admin");
  const bootstrap = store.issueBootstrap("host", ["script.elevated.v1", "container.managed.v1", "operations.managed.v1"], "admin");
  const proof = () => signJWS({ version: 1, purpose: "enrollment", token_sha256: sha256(bootstrap.enrollment_token), public_key_sha256: sha256(pub), executor_nonce: randomBytes(24).toString("base64url"), iat: Math.floor(clock.getTime() / 1000), exp: Math.floor(clock.getTime() / 1000) + 60 }, keys.privateKey, bootstrap.executor_id);
  const enrolled = store.enroll({ token: bootstrap.enrollment_token, public_key: pub, proof: proof() });
  const account = { name: "root", uid: 0, gid: 0, groups: [0] }, interpreter = "a".repeat(64);
  const request = (suffix: string, value: any, requestID = randomBytes(24).toString("base64url")) => {
    const path = "/api/v1/privileged-executors/" + enrolled.executor_id + "/" + suffix, raw = canonicalJSON(value);
    const signature = signExecutorRequest({ body: raw, center_instance_id: store.centerInstanceID, executor_id: enrolled.executor_id, install_generation: enrolled.install_generation, method: "POST", path, request_id: requestID, iat: Math.floor(clock.getTime() / 1000), exp: Math.floor(clock.getTime() / 1000) + 60 }, keys.privateKey);
    return { path, raw, signature, invoke(action: (e: any, v: any) => unknown) { return store.signedRequest(enrolled.executor_id, "POST", path, Buffer.from(raw), signature, action) as any; } };
  };
  const heartbeat = (extra:any={}) => request("heartbeat", { version: "test", activation_id:"11111111-1111-4111-8111-111111111111", boot_id: "boot_1234567890123456789", policy_generation: policy.generation, capabilities: ["script.elevated.v1", "container.managed.v1", "operations.managed.v1"], operations_capabilities:["operations.platform"],account_profiles: [account], interpreter_profiles: [{ runtime: "shell", sha256: interpreter }],...extra }).invoke((e, v) => store.heartbeat(e, v));
  heartbeat();
  const makePlan = (extra: any = {}) => store.plan({ host_ids: ["host"], capability: "script.elevated.v1", payload: { kind: "script", runtime: "shell", code: "printf secret-from-script", args: [], cwd_profile: "private", environment: {}, account, interpreter_sha256: interpreter, timeout_ms: 5000, max_output_bytes: 4096 }, ...extra }, "admin");
  const apply = () => { const plan = makePlan(); return store.apply(plan.id, { confirm: true, expected_revision: plan.revision, request_id: randomBytes(24).toString("base64url") }, "admin").jobs[0]; };
  let revision=1;const payloads=new Map<string,any>();
  const resolve=(job:any)=>{const p=payloads.get(job.operation_id);if(!p||p.resource.revision!==revision)fail(409,'platform_payload_revision_changed');return p;};
  const ops=registerOperations(deps,{jobs,credentials,definitions:[backupDefinition]});
  const schedules=registerOperationSchedules(deps,ops);
  connectManagedExecutorJobs(deps,{jobs,executors:store,artifacts:{directory:'/not-used'} as any,resolvePlatform:resolve});
  const enqueue=()=>{const operation=randomBytes(16).toString('hex'),resource=randomBytes(16).toString('hex');
    const job=jobs.enqueue({agentID:'agent-host',deploymentID:'platform-'+resource,operationID:operation,actions:[{kind:'operations',domain:'platform',operation_id:operation}],capabilities:['operations.platform'],target:{operations_resource_id:resource}});
    payloads.set(operation,{version:1,operation_id:operation,operation:'inspect',resource:{id:resource,kind:'platform',name:'QA',agent_id:'agent-host',revision:1,config:{task:'node.inspect',cluster_id:resource},created_at:clock.toISOString(),updated_at:clock.toISOString()},input:{}});
    db.run('INSERT INTO ops_platform_runs VALUES(?,?,?)',operation,job.id,'admin');return job;
  };
  return { db, router, deps, tasks, store, jobs, ops, schedules, payloads, enqueue, change:()=>revision++,bootstrap, enrolled, pub, keys, proof, request, heartbeat, makePlan, apply, account,
    advance(seconds: number) { clock = new Date(clock.getTime() + seconds * 1000); },
    close() { schedules.close?.();ops.close?.();jobs.close();store.close();tasks.close?.(); db.close(); } };
}

function scheduledBackup(f: ReturnType<typeof fixture>) {
  const resource=randomBytes(16).toString('hex'),at=f.deps.now().toISOString();
  f.db.run('INSERT INTO ops_resources VALUES(?,?,?,?,?,?,?,?,?)',resource,'backup','Backup','agent-host',1,
    f.deps.encrypt(JSON.stringify({source_path:'/var/lib/lightmoni-test',storage:{type:'local',path:'/var/backups/lightmoni-test'}})),at,at,'admin');
  const schedule=f.schedules.create({resource_id:resource,resource_revision:1,operation:'create',cron:'* * * * *',timezone:'UTC',enabled:true},'admin');
  f.advance(60);f.heartbeat();f.schedules.tick();
  const fire=f.schedules.fires(schedule.id)[0],run=f.ops.getRun(fire.run_id),job=f.jobs.get(run.job_id);
  return {schedule,fire,run,job};
}
test('scheduled backups retain a real authorizer and reach the signed executor',()=>{
  const f=fixture();try {
    const {job,run,schedule}=scheduledBackup(f);
    assert.equal(run.approved_by,'admin');assert.equal(run.created_by,'admin');
    const sealed=JSON.parse(f.deps.decrypt(f.db.get<any>('SELECT payload_cipher FROM ops_runs WHERE id=?',run.id)!.payload_cipher));
    assert.equal(sealed.authorization.schedule_id,schedule.id);
    const claim=f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v));
    assert.equal(planClaims(verifyJWS(claim.job.plan,f.store.centerPublicKey,f.store.centerKeyID)).job_id,job.id);
    assert.equal(f.jobs.get(job.id).state,'leased');
  }finally{f.close();}
});
for(const mutation of ['disable','revision','delete','delete-fire','input','authorizer','demote'] as const)test('scheduled backup revalidates '+mutation+' before start',()=>{
  const f=fixture();try {
    const {job,schedule}=scheduledBackup(f);
    const claim=f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v));
    const plan=planClaims(verifyJWS(claim.job.plan,f.store.centerPublicKey,f.store.centerKeyID));
    if(mutation==='disable')f.db.run('UPDATE ops_schedules SET enabled=0 WHERE id=?',schedule.id);
    if(mutation==='revision')f.db.run('UPDATE ops_schedules SET revision=revision+1 WHERE id=?',schedule.id);
    if(mutation==='delete')f.db.run('DELETE FROM ops_schedules WHERE id=?',schedule.id);
    if(mutation==='delete-fire')f.db.run('DELETE FROM ops_schedule_fires WHERE schedule_id=?',schedule.id);
    if(mutation==='input')f.db.run('UPDATE ops_schedules SET input_json=? WHERE id=?',f.deps.encrypt('{"changed":true}'),schedule.id);
    if(mutation==='authorizer')f.db.run("UPDATE ops_schedules SET authorized_by='another' WHERE id=?",schedule.id);
    if(mutation==='demote')f.db.run("UPDATE users SET role='member' WHERE id='admin'");
    assert.throws(()=>f.request('jobs/'+job.id+'/start-permits',{lease_id:plan.lease_id,step_id:'managed.execute',executor_nonce:randomBytes(24).toString('base64url')}).invoke((e,v)=>f.store.startPermit(e,job.id,v)),mutation==='demote'?/active_human_admin_required/:/schedule_authorization_changed/);
    assert.equal(f.db.all('SELECT * FROM privileged_start_permits').length,0);
  }finally{f.close();}
});
test('revoked scheduled backup is cancelled before being claimed',()=>{
  const f=fixture();try{const {job,schedule}=scheduledBackup(f);f.db.run('UPDATE ops_schedules SET enabled=0 WHERE id=?',schedule.id);
    assert.equal(f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v)).job,null);
    assert.equal(f.jobs.get(job.id).state,'cancelled');
  }finally{f.close();}
});

function flow(f:ReturnType<typeof fixture>,task?:string){
 const job=f.enqueue();
 if(task){const payload=f.payloads.get(job.operation_id);payload.resource.config.task=task;payload.operation=task.endsWith('.inspect')?'inspect':'apply';}
 const claim=f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v)),plan=planClaims(verifyJWS(claim.job.plan,f.store.centerPublicKey,f.store.centerKeyID));
 const permit=()=>f.request('jobs/'+job.id+'/start-permits',{lease_id:plan.lease_id,step_id:'managed.execute',executor_nonce:randomBytes(24).toString('base64url')}).invoke((e,v)=>f.store.startPermit(e,job.id,v));
 const phases=()=>{for(const [i,phase] of ['accepted','staging','activating','verifying'].entries())f.request('jobs/'+job.id+'/events',{lease_id:plan.lease_id,sequence:i+1,phase,code:'',detail:{phase,summary:'Structured operation progress'}}).invoke((e,v)=>f.store.events(e,job.id,v));};
 const result=()=>{const p=f.payloads.get(job.operation_id),receipt={state:'succeeded',code:'',summary:'Verified operation',snapshot:{health:{healthy:true},operations:{operation_id:p.operation_id,resource_id:p.resource.id,data:{ok:true}}},started_at:'',finished_at:''};return f.request('jobs/'+job.id+'/result',{lease_id:plan.lease_id,state:'succeeded',code:'',summary:'Managed done',exit_code:0,stdout:canonicalJSON(receipt),stderr:''}).invoke((e,v)=>f.store.result(e,job.id,v));};
 return{job,claim,plan,permit,phases,result};
}
test('signed domain work retains original lineage and ordinary control cannot read or mutate it',async()=>{
 const f=fixture();const server=createServer((req,res)=>void f.router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}}));
 try{const x=flow(f);assert.equal(x.job.execution_principal,'privileged_executor');assert.equal(f.jobs.claim('agent-host',['operations.platform','docker.control','artifact.stage']),null);assert.equal(x.plan.job_id,x.job.id);assert.equal(x.plan.capability,'operations.managed.v1');x.permit();
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port;
 for(const [suffix,method] of [['operations','GET'],['events','POST'],['result','POST'],['cancel','POST']]){const r=await fetch(base+'/api/v1/agents/agent-host/jobs/'+x.job.id+'/'+suffix,{method,headers:{authorization:'Bearer ordinary-control','content-type':'application/json','x-lightmoni-job-lease':x.plan.lease_id},body:method==='POST'?JSON.stringify({lease_id:x.plan.lease_id,state:'succeeded',sequence:1,phase:'accepted'}):undefined});assert.equal(r.status,suffix==='operations'?404:403,suffix);}
 assert.equal(f.jobs.get(x.job.id).state,'leased');x.phases();x.result();assert.equal(f.jobs.get(x.job.id).state,'succeeded');assert.equal(f.store.get(x.job.id).state,'succeeded');assert.equal(f.db.get<any>('SELECT state FROM task_runs WHERE id=?',x.job.id)?.state,'succeeded');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));f.close();}
});
test('a changed source approval blocks an online permit before any side effect',()=>{const f=fixture();try{const x=flow(f);f.change();assert.throws(x.permit,/revision_changed/);assert.equal(f.db.all('SELECT * FROM privileged_start_permits').length,0);}finally{f.close();}});
test('domain receipt faults roll back both principals and preserve a retryable acknowledgement',()=>{const f=fixture();try{const x=flow(f);x.permit();x.phases();f.db.exec("CREATE TRIGGER fail_parent BEFORE UPDATE OF receipt_json ON agent_jobs BEGIN SELECT RAISE(ABORT,'parent_receipt_failure');END");assert.throws(x.result,/parent_receipt_failure/);assert.equal(f.store.get(x.job.id).state,'running');assert.equal(f.jobs.get(x.job.id).state,'verifying');f.db.exec('DROP TRIGGER fail_parent');x.result();assert.equal(f.jobs.get(x.job.id).state,'succeeded');}finally{f.close();}});
test('lease loss preserves unknown fences without replaying through ordinary control',()=>{const f=fixture();try{const x=flow(f);f.advance(46);f.store.sweep();assert.equal(f.jobs.get(x.job.id).state,'unknown');assert.equal(f.store.get(x.job.id).state,'unknown');assert.equal(f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v)).job,null);assert.equal(f.jobs.claim('agent-host',['operations.platform']),null);}finally{f.close();}});
for(const task of ['node.inspect','workload.inspect','gateway.inspect','registry.inspect'])test('signed reconciliation releases an interrupted '+task+' without replaying or inventing health',()=>{
 const f=fixture();try{
  const old=flow(f,task);old.permit();f.advance(46);f.store.sweep();f.heartbeat();
  const original=f.jobs.get(old.job.id).receipt;
  const reconcile=()=>f.request('jobs/'+old.job.id+'/reconcile',{lease_id:old.plan.lease_id}).invoke((e,v)=>f.store.reconcile(e,old.job.id,v));
  const first=reconcile();assert.equal(first.release_fence,true);assert.equal(first.job.state,'unknown');assert.equal(first.job.resolved_by,f.enrolled.executor_id);assert.equal(first.job.resolution_reason,'read_only_observation_interrupted');
  assert.deepEqual(f.jobs.get(old.job.id).receipt,original);assert.equal(f.jobs.get(old.job.id).state,'unknown');
  assert.equal(f.db.get<any>('SELECT state FROM task_runs WHERE id=?',old.job.id)!.state,'unknown');
  assert.equal(reconcile().job.resolved_at,first.job.resolved_at);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM privileged_audit WHERE job_id=? AND event='read_only_observation_reconciled'",old.job.id)!.n,1);
  const next=flow(f,'workload.inspect');assert.notEqual(next.job.id,old.job.id);next.permit();next.phases();next.result();
  assert.equal(f.jobs.get(next.job.id).state,'succeeded');assert.equal(f.jobs.claim('agent-host',['operations.platform']),null);
 }finally{f.close()}
});
for(const task of ['workload.apply','gateway.apply','workload.remove'])test('signed reconciliation retains unknown mutation fence for '+task,()=>{
 const f=fixture();try{
  const old=flow(f,task);old.permit();f.advance(46);f.store.sweep();f.heartbeat();
  const result=f.request('jobs/'+old.job.id+'/reconcile',{lease_id:old.plan.lease_id}).invoke((e,v)=>f.store.reconcile(e,old.job.id,v));
  assert.equal(result.release_fence,false);assert.equal(result.job.resolved_at,'');assert.throws(()=>f.enqueue(),/privileged_execution_pending/);
 }finally{f.close()}
});
test('automatic observation recovery rejects changed payload identity, hashes and leases',()=>{
 for(const tamper of ['digest','target','operation','multiple-actions','agent','parent']){const f=fixture();try{
  const old=flow(f);old.permit();f.advance(46);f.store.sweep();f.heartbeat();
  const row=f.db.get<any>('SELECT payload_enc FROM privileged_jobs WHERE id=?',old.job.id)!,payload=JSON.parse(f.deps.decrypt(row.payload_enc));
  if(tamper==='target')payload.job.target.operations_resource_id='other';
  if(tamper==='operation')payload.operation_payload.operation='apply';
  if(tamper==='multiple-actions')payload.job.actions.push({...payload.job.actions[0]});
  if(tamper==='agent')payload.operation_payload.resource.agent_id='other';
  if(tamper==='parent')f.db.run("UPDATE agent_jobs SET operation_id='other' WHERE id=?",old.job.id);
  const encoded=canonicalJSON(payload);f.db.run('UPDATE privileged_jobs SET payload_enc=?,payload_sha256=? WHERE id=?',f.deps.encrypt(encoded),tamper==='digest'?'f'.repeat(64):sha256(encoded),old.job.id);
  const result=f.request('jobs/'+old.job.id+'/reconcile',{lease_id:old.plan.lease_id}).invoke((e,v)=>f.store.reconcile(e,old.job.id,v));
  assert.equal(result.release_fence,false,tamper);
  assert.throws(()=>f.request('jobs/'+old.job.id+'/reconcile',{lease_id:'wrong'}).invoke((e,v)=>f.store.reconcile(e,old.job.id,v)),/principal_mismatch/);
 }finally{f.close()}}
});
test('a reconstructed center reconciles the original signed observation after lease loss',()=>{
 const f=fixture();let restarted:PrivilegedExecutorStore|undefined;
 try{
  const old=flow(f,'workload.inspect');old.permit();f.advance(46);f.store.close();
  restarted=new PrivilegedExecutorStore(f.deps,{dataDir:'/unused'});
  restarted.managed=f.store.managed;
  restarted.sweep();f.heartbeat();
  assert.equal(restarted.centerInstanceID,f.store.centerInstanceID);
  const request=f.request('jobs/'+old.job.id+'/reconcile',{lease_id:old.plan.lease_id});
  const result:any=restarted.signedRequest(f.enrolled.executor_id,'POST',request.path,Buffer.from(request.raw),request.signature,(e,v)=>restarted!.reconcile(e,old.job.id,v));
  assert.equal(result.release_fence,true);assert.equal(f.jobs.get(old.job.id).state,'unknown');
  assert.equal(f.db.get<any>('SELECT state,resolved_at FROM task_runs WHERE id=?',old.job.id)!.state,'unknown');
  assert(f.db.get<any>('SELECT resolved_at FROM task_runs WHERE id=?',old.job.id)!.resolved_at);
  const fresh=flow(f,'workload.inspect');fresh.permit();fresh.phases();fresh.result();assert.equal(f.jobs.get(fresh.job.id).state,'succeeded');
 }finally{restarted?.close();f.close()}
});
test('managed work can queue behind a running signed operation and only runs after its receipt',()=>{
 const f=fixture();try{
  const first=flow(f),next=f.enqueue();
  assert.equal(f.jobs.get(next.id).state,'queued');
  assert.equal(f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v)).job,null);
  first.permit();first.phases();first.result();
  const claim=f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v));
  assert.equal(planClaims(verifyJWS(claim.job.plan,f.store.centerPublicKey,f.store.centerKeyID)).job_id,next.id);
 }finally{f.close()}
});
test('managed admission preserves manual privilege and unresolved result fences',()=>{
 for(const mode of ['manual','unknown','mismatch']){const f=fixture();try{
  if(mode==='manual')f.apply();else{const old=flow(f);if(mode==='unknown'){f.advance(46);f.store.sweep();f.heartbeat()}else f.db.run("UPDATE privileged_jobs SET task_run_id='other' WHERE id=?",old.job.id)}
  assert.throws(()=>f.enqueue(),/privileged_execution_pending/);
 }finally{f.close()}}
});
test('human reconciliation preserves both unknown histories and permits a new signed managed job',()=>{
 const f=fixture();try{
  const old=flow(f);f.advance(46);f.store.sweep();const receipt=f.jobs.get(old.job.id).receipt;
  assert.equal(f.store.resolve(old.job.id,'admin','Verified the worker ended').state,'unknown');f.heartbeat();
  assert.doesNotThrow(()=>f.makePlan());
  const next=f.enqueue(),claim=f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v));
  assert.equal(planClaims(verifyJWS(claim.job.plan,f.store.centerPublicKey,f.store.centerKeyID)).job_id,next.id);
  assert.equal(f.jobs.get(old.job.id).state,'unknown');assert.deepEqual(f.jobs.get(old.job.id).receipt,receipt);
  assert.equal(f.store.get(old.job.id).state,'unknown');assert.equal(f.store.get(old.job.id).resolved_by,'admin');
  assert.equal(f.jobs.claim('agent-host',['operations.platform']),null);
 }finally{f.close()}
});
test('an explicitly reconciled manual privileged result also releases admission',()=>{
 const f=fixture();try{
  const old=f.apply();f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v));f.advance(46);f.store.sweep();
  assert.equal(f.store.get(old.id).state,'unknown');f.store.resolve(old.id,'admin','Verified manual execution ended');f.heartbeat();
  assert.doesNotThrow(()=>f.enqueue());
 }finally{f.close()}
});
test('a cached start permit cannot restore authority after policy revocation',()=>{
 const f=fixture();try{const x=flow(f),r=f.request('jobs/'+x.job.id+'/start-permits',{lease_id:x.plan.lease_id,step_id:'managed.execute',executor_nonce:randomBytes(24).toString('base64url')});r.invoke((e,v)=>f.store.startPermit(e,x.job.id,v));const p=f.store.preparePolicyPlan('host',{capabilities:[]},'admin');f.store.applyPolicy('host',p.id,{confirm:true,expected_revision:p.revision},'admin');assert.throws(()=>r.invoke((e,v)=>f.store.startPermit(e,x.job.id,v)),/stale_policy|policy_disabled|not_authorized/);}finally{f.close();}
});
test('signed application observations bind central ownership and durably acknowledge before export',{timeout:6000},async()=>{
 const f=fixture();f.db.exec('CREATE TABLE ops_cluster_instances(id TEXT,owner_id TEXT,cluster_id TEXT,machine_id TEXT,agent_id TEXT);CREATE TABLE ops_platform_resources(id TEXT,kind TEXT,spec_cipher TEXT)');
 f.db.run('INSERT INTO ops_cluster_instances VALUES(?,?,?,?,?)','deployment','application','cluster','host','agent-host');f.db.run('INSERT INTO ops_platform_resources VALUES(?,?,?)','application','application',f.deps.encrypt(JSON.stringify({service_name:'approved-service',role:'generic'})));
 let failExport=true,exports=0;const module=connectExecutorObservations(f.deps,f.store,async(_table,rows)=>{if(failExport)throw Error('storage_unavailable');assert.equal(rows[0].row.attributes.application_id,'application');assert.equal(rows[0].row.service,'approved-service');assert.equal(rows[0].row.source_seq,'9007199254740993');exports++;});
 try{
  const attr=(key:string,value:string)=>({key,value:{stringValue:value}}),payload=encodeOTLP('logs',{resourceLogs:[{resource:{attributes:[attr('service.name','executor')]},scopeLogs:[{logRecords:[{timeUnixNano:nowNano().toString(),body:{stringValue:'private-application-line'},attributes:[attr('deployment_id','deployment'),attr('container_id','a'.repeat(64)),{key:'lightmoni.source_seq',value:{intValue:'9007199254740993'}}]}]}]}]}).toString('base64');
  const value={id:randomUUID(),signal:'logs',payload};const send=(body:any)=>f.request('observations/batches',body).invoke((e,v)=>{f.store.observationAuthority(e.id);return f.store.observations!.accept(e,v);});
  assert.deepEqual(send(value),{accepted:true});assert.deepEqual(send(value),{accepted:true});assert.equal(f.db.get<any>('SELECT count(*) n FROM privileged_observation_batches')!.n,1);assert.ok(!f.db.get<any>('SELECT rows_enc FROM privileged_observation_batches')!.rows_enc.includes('private-application-line'));
  const saved=f.db.get<any>('SELECT id,rows_enc FROM privileged_observation_batches')!,legacy=JSON.parse(f.deps.decrypt(saved.rows_enc));assert.equal(legacy[0].row.source_seq,'9007199254740993');legacy[0].row.source_seq={isLosslessNumber:true,value:'9007199254740993'};f.db.run('UPDATE privileged_observation_batches SET rows_enc=? WHERE id=?',f.deps.encrypt(canonicalJSON(legacy)),saved.id);
  assert.throws(()=>send({...value,payload:Buffer.concat([Buffer.from(payload,'base64'),Buffer.from('x')]).toString('base64')}),/replay_conflict/);await new Promise(r=>setTimeout(r,1100));assert.equal(exports,0);assert.equal(f.db.get<any>('SELECT completed FROM privileged_observation_batches')!.completed,0);assert.deepEqual(f.deps.applicationObservationStatus?.('agent-host'),{pending_batches:1,error:'observation_export_failed'});failExport=false;await new Promise(r=>setTimeout(r,1100));assert.equal(exports,1);assert.equal(f.db.get<any>('SELECT completed FROM privileged_observation_batches')!.completed,1);assert.deepEqual(f.deps.applicationObservationStatus?.('agent-host'),{pending_batches:0,error:''});
  f.db.run("UPDATE users SET role='viewer' WHERE id='admin'");assert.throws(()=>send({...value,id:randomUUID()}),/active_human|admin/);
 }finally{await module.close?.();f.close();}
});
test('observation sequence recovery refuses unsafe or malformed numeric wrappers',()=>{
 const row=(value:any)=>[{kind:'log',subtype:'',row:{source_seq:value}}];
 assert.equal(restoreObservationRows(row({isLosslessNumber:true,value:'18446744073709551615'}))[0].row.source_seq,'18446744073709551615');
 for(const value of [9007199254740992,-1,'18446744073709551616',{isLosslessNumber:true,value:'1',secret:'unexpected'},{value:'1'},'1e3'])assert.throws(()=>restoreObservationRows(row(value)),/invalid_observation_source_sequence/);
});
test('more than one drain window of failed observations cannot starve a later healthy batch',{timeout:6000},async()=>{
 const f=fixture();f.db.exec('CREATE TABLE ops_cluster_instances(id TEXT,owner_id TEXT,cluster_id TEXT,machine_id TEXT,agent_id TEXT);CREATE TABLE ops_platform_resources(id TEXT,kind TEXT,spec_cipher TEXT)');
 f.db.run('INSERT INTO ops_cluster_instances VALUES(?,?,?,?,?)','deployment','application','cluster','host','agent-host');f.db.run('INSERT INTO ops_platform_resources VALUES(?,?,?)','application','application',f.deps.encrypt(JSON.stringify({service_name:'approved-service',role:'generic'})));
 let exported=0;const module=connectExecutorObservations(f.deps,f.store,async(_table,rows)=>{if(rows[0].row.body==='poison')throw Error('storage_unavailable');exported++;});
 try{
  const send=(body:string)=>{const value={id:randomUUID(),signal:'logs',payload:encodeOTLP('logs',{resourceLogs:[{resource:{attributes:[{key:'service.name',value:{stringValue:'executor'}}]},scopeLogs:[{logRecords:[{timeUnixNano:nowNano().toString(),body:{stringValue:body},attributes:[{key:'deployment_id',value:{stringValue:'deployment'}},{key:'container_id',value:{stringValue:'a'.repeat(64)}}]}]}]}]}).toString('base64')};f.request('observations/batches',value).invoke((e,v)=>f.store.observations!.accept(e,v));return value.id;};
  for(let i=0;i<21;i++)send('poison');f.db.run("UPDATE privileged_observation_batches SET created_at='2026-10-31T23:59:59Z'");send('healthy');
  await new Promise(r=>setTimeout(r,2400));assert.equal(exported,1);assert.equal(f.db.get<any>('SELECT count(*) n FROM privileged_observation_batches WHERE completed=0')!.n,21);
 }finally{await module.close?.();f.close();}
});

async function hostContainerHTTP(f:ReturnType<typeof fixture>){
 let ready=true;
 registerHostDockerJobs(f.deps,f.jobs,handler=>handler,()=>({id:'host',agent_id:'agent-host',online:true,state:'ready',truncated:false,docker_capabilities:ready?['docker.host']:[]}));
 const server=createServer((req,res)=>void f.router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end('{}')}}));server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+(server.address() as any).port+'/api/v1/ops/machines/host/container-jobs';
 const req=async(body?:any,suffix='',headers:Record<string,string>={})=>{const r=await fetch(base+suffix,{method:body?'POST':'GET',headers:{cookie:'lm_session=human','content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json() as any}};
 return{req,old(){ready=false},close(){server.close();server.closeAllConnections()}};
}
async function completeHostContainerJob(f:ReturnType<typeof fixture>,node:ReturnType<typeof fakeHostDocker>,job:any){
 const claim=f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v)),plan=planClaims(verifyJWS(claim.job.plan,f.store.centerPublicKey,f.store.centerKeyID));assert.equal(plan.job_id,job.id);assert.equal(plan.capability,'operations.managed.v1');
 f.request('jobs/'+job.id+'/start-permits',{lease_id:plan.lease_id,step_id:'managed.execute',executor_nonce:randomBytes(24).toString('base64url')}).invoke((e,v)=>f.store.startPermit(e,job.id,v));
 let seq=0;const receipt=await executeHostDocker(job.action,job.id,{...node.context,now:f.deps.now,authorize:async()=>{f.request('jobs/'+job.id+'/renew',{lease_id:plan.lease_id}).invoke((e,v)=>f.store.renew(e,job.id,v))}},async event=>{f.request('jobs/'+job.id+'/events',{lease_id:plan.lease_id,sequence:++seq,phase:event.phase,code:'',detail:event}).invoke((e,v)=>f.store.events(e,job.id,v))});
 assert.equal(receipt.state,'succeeded',JSON.stringify(receipt));f.request('jobs/'+job.id+'/result',{lease_id:plan.lease_id,state:receipt.state,code:receipt.code,summary:receipt.summary,exit_code:0,stdout:canonicalJSON(receipt),stderr:''}).invoke((e,v)=>f.store.result(e,job.id,v));return f.jobs.get(job.id);
}

test('host container HTTP requires a live human, exact confirmation, idempotency and signed management execution',async()=>{
 const f=fixture(),http=await hostContainerHTTP(f),node=fakeHostDocker();
 try{
  const input={request_id:randomUUID(),action:{kind:'host_docker',operation:'inspect',container_id:hostContainerID}};
  assert.equal((await http.req(input,'',{authorization:'Bearer ordinary-control'})).status,403);
  const created=await http.req(input);assert.equal(created.status,202);assert.equal((await http.req(input)).body.id,created.body.id);
  assert.equal((await http.req({...input,action:{...input.action,container_id:'b'.repeat(64)}})).status,409);
  assert.equal(f.jobs.claim('agent-host',['docker.host']),null);
  await completeHostContainerJob(f,node,created.body);
  const read=await http.req(undefined,'/'+created.body.id);assert.equal(read.body.state,'succeeded');assert.equal(read.body.result.container.name,'qa-running');assert.equal(read.body.blocking,false);assert.doesNotMatch(JSON.stringify(read),/PASSWORD|hidden/);
  const remove={request_id:randomUUID(),action:{kind:'host_docker',operation:'remove',container_id:hostContainerID,expected_revision:read.body.result.container.revision,force:true,remove_anonymous_volumes:false}};
  assert.equal((await http.req(remove)).status,400);
  const accepted=await http.req({...remove,confirmed:true});assert.equal(accepted.status,202);await completeHostContainerJob(f,node,accepted.body);assert.equal((await http.req(undefined,'/'+accepted.body.id)).body.result.removed_id,hostContainerID);
  http.old();assert.equal((await http.req({...input,request_id:randomUUID()})).status,409);
  f.db.run("UPDATE users SET active=0 WHERE id='admin'");assert.equal((await http.req(undefined)).status,403);
 }finally{http.close();node.close();f.close()}
});

test('host image cleanup is bound to its successful preview and cannot include referenced or forged candidates',async()=>{
 const f=fixture(),http=await hostContainerHTTP(f),node=fakeHostDocker();
 try{
  const read=await http.req({request_id:randomUUID(),action:{kind:'host_docker',operation:'images'}});await completeHostContainerJob(f,node,read.body);
  const p=(await http.req(undefined,'/'+read.body.id)).body,result=p.result,i=result.images.find((i:any)=>i.id===unusedImageID);
  const input={confirmed:true,request_id:randomUUID(),action:{kind:'host_docker',operation:'prune_images',preview_job_id:p.id,previewed_at:result.observed_at,images:[{image_id:i.id,expected_revision:i.revision}]}};
  assert.equal((await http.req({...input,action:{...input.action,images:[{image_id:result.images[0].id,expected_revision:result.images[0].revision}]}})).status,409);
  assert.equal((await http.req({...input,action:{...input.action,previewed_at:'2026-01-01T00:00:00Z'}})).status,409);
  const accepted=await http.req(input);assert.equal(accepted.status,202);await completeHostContainerJob(f,node,accepted.body);
  const receipt=(await http.req(undefined,'/'+accepted.body.id)).body;assert.deepEqual(receipt.result.deleted,[unusedImageID]);assert.equal(receipt.blocking,false);
  assert.equal((await http.req(input)).body.id,accepted.body.id);
  f.advance(301);assert.equal((await http.req({...input,request_id:randomUUID()})).status,409);
 }finally{http.close();node.close();f.close()}
});


test('host-management compatibility comes from a signed root observation, never the ordinary Agent heartbeat',()=>{
 const f=fixture();try{
  const inventory={management_version:1,state:'ready',observed_at:f.deps.now().toISOString(),containers:[],truncated:false};
  f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify({docker_inventory:inventory,docker_capabilities:['docker.host']}));
  assert.equal(managedExecutorObservation(f.deps,'agent-host')?.docker_inventory?.management_version,undefined);
  f.heartbeat({docker_inventory:inventory});assert.equal(managedExecutorObservation(f.deps,'agent-host')?.docker_inventory?.management_version,1);
 }finally{f.close()}
});

test('registry secret uses the signed current lease, never the journal payload; revoked source still accepts final receipt',async()=>{
 const {createRegistryCredentialSchema}=await import('../src/ops/registry-credentials.js');
 const f=fixture();try{
  createRegistryCredentialSchema({deps:f.deps} as any);
  const credential='a'.repeat(32),image='private.test/team/app:1';
  f.db.run('INSERT INTO ops_registry_credentials VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?)',credential,'Private','private.test','team','[]','robot',f.deps.encrypt('signed-fixture-password'),'','','admin','admin',new Date().toISOString(),new Date().toISOString());
  f.heartbeat({operations_capabilities:['operations.platform','operations.platform.registry-auth.v1']});
  const job=f.enqueue();f.db.run('UPDATE agent_jobs SET capabilities_json=? WHERE id=?',JSON.stringify(['operations.platform','operations.platform.registry-auth.v1']),job.id);
  const operation=f.payloads.get(job.operation_id);operation.resource.config.registry_authorizations=[{id:credential,revision:1,registry:'private.test',repository_prefix:'team',images:[image]}];
  const claim=f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v)),plan=planClaims(verifyJWS(claim.job.plan,f.store.centerPublicKey,f.store.centerKeyID));
  assert(!JSON.stringify(claim).includes('signed-fixture-password'));
  f.request('jobs/'+job.id+'/start-permits',{lease_id:plan.lease_id,step_id:'managed.execute',executor_nonce:randomBytes(24).toString('base64url')}).invoke((e,v)=>f.store.startPermit(e,job.id,v));
  const req=f.request('jobs/'+job.id+'/registry-credentials',{lease_id:plan.lease_id,image});
  const read=()=>req.invoke((e,v)=>f.store.managedRegistryCredential(e,job.id,v));
  assert.equal(read().credential.password,'signed-fixture-password');
  assert.equal(read().credential.password,'signed-fixture-password');
  for(const row of f.db.all<any>('SELECT response_enc FROM privileged_request_nonces'))assert(!f.deps.decrypt(row.response_enc).includes('signed-fixture-password'));
  assert.throws(()=>f.request('jobs/'+job.id+'/registry-credentials',{lease_id:'wrong',image}).invoke((e,v)=>f.store.managedRegistryCredential(e,job.id,v)),/lease/);
  assert.throws(()=>f.request('jobs/'+job.id+'/registry-credentials',{lease_id:plan.lease_id,image:'private.test/other:1'}).invoke((e,v)=>f.store.managedRegistryCredential(e,job.id,v)),/not_authorized/);
  f.db.run("UPDATE ops_registry_credentials SET secret_cipher='',revoked_at='revoked',revision=2 WHERE id=?",credential);
  // Simulate the source revalidation that the production platform adapter performs.
  f.change();assert.throws(read,/revision_changed/);
  const receipt={state:'failed',code:'registry_auth_cancelled',summary:'Stopped after credential revocation',snapshot:{},started_at:'',finished_at:''};
  f.request('jobs/'+job.id+'/result',{lease_id:plan.lease_id,state:receipt.state,code:receipt.code,summary:receipt.summary,exit_code:1,stdout:canonicalJSON(receipt),stderr:''}).invoke((e,v)=>f.store.result(e,job.id,v));
  assert.equal(f.jobs.get(job.id).state,'failed');assert.equal(f.store.get(job.id).state,'failed');
  for(const table of ['privileged_jobs','privileged_request_nonces','task_runs'])assert(!JSON.stringify(f.db.all('SELECT * FROM '+table)).includes('signed-fixture-password'));
 }finally{f.close();}
});
