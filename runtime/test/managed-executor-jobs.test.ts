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
import {connectExecutorObservations} from '../src/server/executor-observation.js';
import {encodeOTLP,nowNano} from '../src/shared/otlp.js';
import {randomUUID} from 'node:crypto';
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
  for (const [name, def] of [["execution_principal", "TEXT NOT NULL DEFAULT 'agent'"], ["executor_id", "TEXT NOT NULL DEFAULT ''"]])
    if (!db.all<any>("PRAGMA table_info(task_runs)").some(c => c.name === name)) db.exec("ALTER TABLE task_runs ADD COLUMN " + name + " " + def);
  db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES('host','Host','host.test',22,'root','direct_ssh','agent-host',?,?)", clock.toISOString(), clock.toISOString());
  db.exec("CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,last_seen TEXT,heartbeat TEXT);CREATE TABLE ops_platform_runs(id TEXT PRIMARY KEY,job_id TEXT,actor TEXT)");
  db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES('agent-host','host','Host','test','linux','arm64',?,'{}')",clock.toISOString());
  const credentials:any={has:()=>true,authenticate:(req:any)=>{if(req.headers.authorization!=='Bearer ordinary-control')fail(401,'control_required')}};
  const jobs=registerAgentJobs(deps,{agentCredentials:credentials,separateExecutor:true});
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
  const heartbeat = () => request("heartbeat", { version: "test", activation_id:"11111111-1111-4111-8111-111111111111", boot_id: "boot_1234567890123456789", policy_generation: policy.generation, capabilities: ["script.elevated.v1", "container.managed.v1", "operations.managed.v1"], operations_capabilities:["operations.platform"],account_profiles: [account], interpreter_profiles: [{ runtime: "shell", sha256: interpreter }] }).invoke((e, v) => store.heartbeat(e, v));
  heartbeat();
  const makePlan = (extra: any = {}) => store.plan({ host_ids: ["host"], capability: "script.elevated.v1", payload: { kind: "script", runtime: "shell", code: "printf secret-from-script", args: [], cwd_profile: "private", environment: {}, account, interpreter_sha256: interpreter, timeout_ms: 5000, max_output_bytes: 4096 }, ...extra }, "admin");
  const apply = () => { const plan = makePlan(); return store.apply(plan.id, { confirm: true, expected_revision: plan.revision, request_id: randomBytes(24).toString("base64url") }, "admin").jobs[0]; };
  let revision=1;const payloads=new Map<string,any>();
  const resolve=(job:any)=>{const p=payloads.get(job.operation_id);if(!p||p.resource.revision!==revision)fail(409,'platform_payload_revision_changed');return p;};
  registerOperations(deps,{jobs,credentials,definitions:[],resolvePayload:resolve});
  connectManagedExecutorJobs(deps,{jobs,executors:store,artifacts:{directory:'/not-used'} as any,resolvePlatform:resolve});
  const enqueue=()=>{const operation=randomBytes(16).toString('hex'),resource=randomBytes(16).toString('hex');
    const job=jobs.enqueue({agentID:'agent-host',deploymentID:'platform-'+resource,operationID:operation,actions:[{kind:'operations',domain:'platform',operation_id:operation}],capabilities:['operations.platform'],target:{operations_resource_id:resource}});
    payloads.set(operation,{version:1,operation_id:operation,operation:'inspect',resource:{id:resource,kind:'platform',name:'QA',agent_id:'agent-host',revision:1,config:{task:'node.inspect',cluster_id:resource},created_at:clock.toISOString(),updated_at:clock.toISOString()},input:{}});
    db.run('INSERT INTO ops_platform_runs VALUES(?,?,?)',operation,job.id,'admin');return job;
  };
  return { db, router, deps, tasks, store, jobs, payloads, enqueue, change:()=>revision++,bootstrap, enrolled, pub, keys, proof, request, heartbeat, makePlan, apply, account,
    advance(seconds: number) { clock = new Date(clock.getTime() + seconds * 1000); },
    close() { jobs.close();store.close();tasks.close?.(); db.close(); } };
}

function flow(f:ReturnType<typeof fixture>){
 const job=f.enqueue(),claim=f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v)),plan=planClaims(verifyJWS(claim.job.plan,f.store.centerPublicKey,f.store.centerKeyID));
 const permit=()=>f.request('jobs/'+job.id+'/start-permits',{lease_id:plan.lease_id,step_id:'managed.execute',executor_nonce:randomBytes(24).toString('base64url')}).invoke((e,v)=>f.store.startPermit(e,job.id,v));
 const phases=()=>{for(const [i,phase] of ['accepted','staging','activating','verifying'].entries())f.request('jobs/'+job.id+'/events',{lease_id:plan.lease_id,sequence:i+1,phase,code:'',detail:{phase,summary:'Structured operation progress'}}).invoke((e,v)=>f.store.events(e,job.id,v));};
 const result=()=>{const p=f.payloads.get(job.operation_id),receipt={state:'succeeded',code:'',summary:'Verified operation',snapshot:{health:{healthy:true},operations:{operation_id:p.operation_id,resource_id:p.resource.id,data:{ok:true}}},started_at:'',finished_at:''};return f.request('jobs/'+job.id+'/result',{lease_id:plan.lease_id,state:'succeeded',code:'',summary:'Managed done',exit_code:0,stdout:canonicalJSON(receipt),stderr:''}).invoke((e,v)=>f.store.result(e,job.id,v));};
 return{job,claim,plan,permit,phases,result};
}
test('signed domain work retains original lineage and ordinary control cannot read or mutate it',async()=>{
 const f=fixture();const server=createServer((req,res)=>void f.router.handle(req,res));
 try{const x=flow(f);assert.equal(x.job.execution_principal,'privileged_executor');assert.equal(f.jobs.claim('agent-host',['operations.platform','docker.control','artifact.stage']),null);assert.equal(x.plan.job_id,x.job.id);assert.equal(x.plan.capability,'operations.managed.v1');x.permit();
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port;
 for(const [suffix,method] of [['operations','GET'],['events','POST'],['result','POST'],['cancel','POST']]){const r=await fetch(base+'/api/v1/agents/agent-host/jobs/'+x.job.id+'/'+suffix,{method,headers:{authorization:'Bearer ordinary-control','content-type':'application/json','x-lightmoni-job-lease':x.plan.lease_id},body:method==='POST'?JSON.stringify({lease_id:x.plan.lease_id,state:'succeeded',sequence:1,phase:'accepted'}):undefined});assert.equal(r.status,403,suffix);}
 assert.equal(f.jobs.get(x.job.id).state,'leased');x.phases();x.result();assert.equal(f.jobs.get(x.job.id).state,'succeeded');assert.equal(f.store.get(x.job.id).state,'succeeded');assert.equal(f.db.get<any>('SELECT state FROM task_runs WHERE id=?',x.job.id)?.state,'succeeded');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));f.close();}
});
test('a changed source approval blocks an online permit before any side effect',()=>{const f=fixture();try{const x=flow(f);f.change();assert.throws(x.permit,/revision_changed/);assert.equal(f.db.all('SELECT * FROM privileged_start_permits').length,0);}finally{f.close();}});
test('domain receipt faults roll back both principals and preserve a retryable acknowledgement',()=>{const f=fixture();try{const x=flow(f);x.permit();x.phases();f.db.exec("CREATE TRIGGER fail_parent BEFORE UPDATE OF receipt_json ON agent_jobs BEGIN SELECT RAISE(ABORT,'parent_receipt_failure');END");assert.throws(x.result,/parent_receipt_failure/);assert.equal(f.store.get(x.job.id).state,'running');assert.equal(f.jobs.get(x.job.id).state,'verifying');f.db.exec('DROP TRIGGER fail_parent');x.result();assert.equal(f.jobs.get(x.job.id).state,'succeeded');}finally{f.close();}});
test('lease loss preserves unknown fences without replaying through ordinary control',()=>{const f=fixture();try{const x=flow(f);f.advance(46);f.store.sweep();assert.equal(f.jobs.get(x.job.id).state,'unknown');assert.equal(f.store.get(x.job.id).state,'unknown');assert.equal(f.request('jobs/claim',{}).invoke((e,v)=>f.store.claim(e,v)).job,null);assert.equal(f.jobs.claim('agent-host',['operations.platform']),null);}finally{f.close();}});
test('a cached start permit cannot restore authority after policy revocation',()=>{
 const f=fixture();try{const x=flow(f),r=f.request('jobs/'+x.job.id+'/start-permits',{lease_id:x.plan.lease_id,step_id:'managed.execute',executor_nonce:randomBytes(24).toString('base64url')});r.invoke((e,v)=>f.store.startPermit(e,x.job.id,v));const p=f.store.preparePolicyPlan('host',{capabilities:[]},'admin');f.store.applyPolicy('host',p.id,{confirm:true,expected_revision:p.revision},'admin');assert.throws(()=>r.invoke((e,v)=>f.store.startPermit(e,x.job.id,v)),/stale_policy|policy_disabled|not_authorized/);}finally{f.close();}
});
test('signed application observations bind central ownership and durably acknowledge before export',{timeout:6000},async()=>{
 const f=fixture();f.db.exec('CREATE TABLE ops_cluster_instances(id TEXT,owner_id TEXT,cluster_id TEXT,machine_id TEXT,agent_id TEXT);CREATE TABLE ops_platform_resources(id TEXT,kind TEXT,spec_cipher TEXT)');
 f.db.run('INSERT INTO ops_cluster_instances VALUES(?,?,?,?,?)','deployment','application','cluster','host','agent-host');f.db.run('INSERT INTO ops_platform_resources VALUES(?,?,?)','application','application',f.deps.encrypt(JSON.stringify({service_name:'approved-service',role:'generic'})));
 let failExport=true,exports=0;const module=connectExecutorObservations(f.deps,f.store,async(_table,rows)=>{if(failExport)throw Error('storage_unavailable');assert.equal(rows[0].row.attributes.application_id,'application');assert.equal(rows[0].row.service,'approved-service');exports++;});
 try{
  const attr=(key:string,value:string)=>({key,value:{stringValue:value}}),payload=encodeOTLP('logs',{resourceLogs:[{resource:{attributes:[attr('service.name','executor')]},scopeLogs:[{logRecords:[{timeUnixNano:nowNano().toString(),body:{stringValue:'private-application-line'},attributes:[attr('deployment_id','deployment'),attr('container_id','a'.repeat(64))]}]}]}]}).toString('base64');
  const value={id:randomUUID(),signal:'logs',payload};const send=(body:any)=>f.request('observations/batches',body).invoke((e,v)=>{f.store.observationAuthority(e.id);return f.store.observations!.accept(e,v);});
  assert.deepEqual(send(value),{accepted:true});assert.deepEqual(send(value),{accepted:true});assert.equal(f.db.get<any>('SELECT count(*) n FROM privileged_observation_batches')!.n,1);assert.ok(!f.db.get<any>('SELECT rows_enc FROM privileged_observation_batches')!.rows_enc.includes('private-application-line'));
  assert.throws(()=>send({...value,payload:Buffer.concat([Buffer.from(payload,'base64'),Buffer.from('x')]).toString('base64')}),/replay_conflict/);await new Promise(r=>setTimeout(r,1100));assert.equal(exports,0);assert.equal(f.db.get<any>('SELECT completed FROM privileged_observation_batches')!.completed,0);failExport=false;await new Promise(r=>setTimeout(r,1100));assert.equal(exports,1);assert.equal(f.db.get<any>('SELECT completed FROM privileged_observation_batches')!.completed,1);
  f.db.run("UPDATE users SET role='viewer' WHERE id='admin'");assert.throws(()=>send({...value,id:randomUUID()}),/active_human|admin/);
 }finally{await module.close?.();f.close();}
});
