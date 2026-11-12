import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes,randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import type { Dependencies } from "../src/shared/types.js";
import { registerTaskCenter } from "../src/server/task-center.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { registerPrivilegedExecutors } from "../src/server/privileged-executors.js";
import { PrivilegedExecutorStore } from "../src/server/privileged-executors.js";
import { canonicalJSON, signExecutorRequest, signJWS, verifyJWS, sha256, planClaims, permitClaims, policyClaims } from "../src/shared/privileged-executor.js";
import { VERIFIED_SSH_ONCE_REVISION } from '../src/shared/ssh-once-readiness.js';

function fixture(options:{sshOnce?:boolean;sourceRevision?:string;commands?:string[]}={}) {
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
  db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES('host','Host','host.test',22,'direct_ssh','agent-host',?,?)", clock.toISOString(), clock.toISOString());
  db.exec("CREATE TABLE machine_agent_runtime(machine_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,runtime_mode TEXT NOT NULL,permission_generation INTEGER NOT NULL,updated_at TEXT NOT NULL)");
  db.run("INSERT INTO machine_agent_runtime VALUES('host','agent-host','root',3,?)",clock.toISOString());
  const store = registerPrivilegedExecutors(deps, { dataDir: "/unused" });
  tasks.ordinaryTaskIdentity=(machineID,agentID,executorID,installGeneration)=>store.ordinaryTaskIdentity(machineID,agentID,executorID,installGeneration);
  tasks.nodes.taskScriptCapabilities=(machineID,agentID)=>{const executor=db.get<any>("SELECT id,install_generation FROM privileged_executors WHERE machine_id=? AND agent_id=? AND state='active' ORDER BY install_generation DESC LIMIT 1",machineID,agentID);return executor&&store.ordinaryTaskIdentity(machineID,agentID,executor.id,executor.install_generation)?["task.script.v1","task.script.v2"]:[]};
  store.taskRuns=tasks;
  const keys = generateKeyPairSync("ed25519"), pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const policy = store.preparePolicyPlan("host", { capabilities: ["script.elevated.v1", "container.managed.v1"] }, "admin");
  store.applyPolicy("host", policy.id, { confirm: true, expected_revision: policy.revision }, "admin");
  const bootstrap = store.issueBootstrap("host", ["script.elevated.v1", "container.managed.v1"], "admin");
  const proof = () => signJWS({ version: 1, purpose: "enrollment", token_sha256: sha256(bootstrap.enrollment_token), public_key_sha256: sha256(pub), executor_nonce: randomBytes(24).toString("base64url"), iat: Math.floor(clock.getTime() / 1000), exp: Math.floor(clock.getTime() / 1000) + 60 }, keys.privateKey, bootstrap.executor_id);
  const enrolled = store.enroll({ token: bootstrap.enrollment_token, public_key: pub, proof: proof() });
  const account = { name: "root", uid: 0, gid: 0, groups: [0] }, interpreter = "a".repeat(64);
  const request = (suffix: string, value: any, requestID = randomBytes(24).toString("base64url")) => {
    const path = "/api/v1/privileged-executors/" + enrolled.executor_id + "/" + suffix, raw = canonicalJSON(value);
    const signature = signExecutorRequest({ body: raw, center_instance_id: store.centerInstanceID, executor_id: enrolled.executor_id, install_generation: enrolled.install_generation, method: "POST", path, request_id: requestID, iat: Math.floor(clock.getTime() / 1000), exp: Math.floor(clock.getTime() / 1000) + 60 }, keys.privateKey);
    return { path, raw, signature, invoke(action: (e: any, v: any) => unknown) { return store.signedRequest(enrolled.executor_id, "POST", path, Buffer.from(raw), signature, action) as any; } };
  };
  const heartbeat = () => request("heartbeat", { version: "test", activation_id:randomUUID(), release:{build_id:"test",source_revision:options.sourceRevision??"a".repeat(40),artifact_sha256:"b".repeat(64),state_schema:1}, boot_id: "boot_1234567890123456789", policy_generation: policy.generation, capabilities: ["script.elevated.v1", "container.managed.v1"], ordinary_task_identity:{account:"lightmoni-agent",uid:1001,gid:1001,permission_generation:3}, account_profiles: [account], interpreter_profiles: [{ runtime: "shell", sha256: interpreter }],...(options.sshOnce===false?{}:{ssh_once_commands:options.commands??['managed-once','task-once']}) }).invoke((e, v) => store.heartbeat(e, v));
  heartbeat();
  const makePlan = (extra: any = {}) => store.plan({ host_ids: ["host"], capability: "script.elevated.v1", payload: { kind: "script", runtime: "shell", code: "printf secret-from-script", args: [], cwd_profile: "private", environment: {}, account, interpreter_sha256: interpreter, timeout_ms: 5000, max_output_bytes: 4096 }, ...extra }, "admin");
  const apply = () => { const plan = makePlan(); return store.apply(plan.id, { confirm: true, expected_revision: plan.revision, request_id: randomBytes(24).toString("base64url") }, "admin").jobs[0]; };
  return { db, router, deps, tasks, store, bootstrap, enrolled, pub, keys, proof, request, heartbeat, makePlan, apply, account,
    advance(seconds: number) { clock = new Date(clock.getTime() + seconds * 1000); },
    close() { tasks.close?.(); db.close(); } };
}

test("enrollment is one-use, prebound, independently keyed and default capabilities are disabled", () => {
  const f = fixture(); try {
    assert.throws(() => f.store.enroll({ token: f.bootstrap.enrollment_token, public_key: f.pub, proof: f.proof() }), /enrollment_token/);
    const record = f.db.get<any>("SELECT token_hash FROM privileged_enrollments")!;
    assert.notEqual(record.token_hash, f.bootstrap.enrollment_token);
    assert.equal(f.store.getStatus("host").capabilities["script.elevated.v1"].effective, "ready");
    f.advance(61); assert.equal(f.store.getStatus("host").script_profiles.accounts.length, 0);
    assert.throws(() => f.makePlan(), /not_ready/);
    const p = f.store.preparePolicyPlan("host", { capabilities: [] }, "admin");
    f.store.applyPolicy("host", p.id, { confirm: true, expected_revision: p.revision }, "admin");
    assert.equal(f.store.getStatus("host").capabilities["script.elevated.v1"].effective, "disabled");
    assert.throws(() => f.store.bootstrap("host", { capabilities: ["script.elevated.v1"] }, "admin"), /approved_execution/);
  } finally { f.close(); }
});

test("SSH dispatch readiness requires a reusable bound SSH credential even while the helper is online", () => {
  const f = fixture(); try {
    if (!f.db.all<any>("PRAGMA table_info(managed_machines)").some(column => column.name === "default_account_id"))
      f.db.exec("ALTER TABLE managed_machines ADD COLUMN default_account_id TEXT NOT NULL DEFAULT ''");
    f.db.exec(`CREATE TABLE machine_ssh_accounts(id TEXT PRIMARY KEY,default_credential_id TEXT,deleted_at TEXT);
      CREATE TABLE effective_machine_credentials(id TEXT PRIMARY KEY,machine_id TEXT,revoked_at TEXT,
        secret_cleared_at TEXT,secret_encrypted TEXT,method TEXT,retention TEXT,expires_at TEXT);`);
    f.store.setSSHOnly();
    assert.equal(f.store.getStatus("host").capabilities["script.elevated.v1"].effective, "unavailable");
    f.db.run("INSERT INTO machine_ssh_accounts VALUES('account','binding','')");
    f.db.run("UPDATE managed_machines SET default_account_id='account' WHERE id='host'");
    f.db.run("INSERT INTO effective_machine_credentials VALUES('binding','host',NULL,'','ciphertext','ssh_key','permanent','')");
    f.advance(61);
    assert.equal(f.store.getStatus("host").capabilities["script.elevated.v1"].effective, "ready");
    f.db.run("UPDATE effective_machine_credentials SET revoked_at='2026-11-01T00:01:01Z' WHERE id='binding'");
    assert.equal(f.store.getStatus("host").capabilities["script.elevated.v1"].effective, "unavailable");
  } finally { f.close(); }
});

test('SSH readiness rejects an old helper but preserves the exact verified release during center-first rollout',()=>{
  for(const [name,options,managedReady,taskReady] of [
    ['old',{sshOnce:false,sourceRevision:'7'.repeat(40)},false,false],
    ['verified',{sshOnce:false,sourceRevision:VERIFIED_SSH_ONCE_REVISION},true,true],
    ['verified-explicit-partial',{commands:['task-once'],sourceRevision:VERIFIED_SSH_ONCE_REVISION},false,true],
    ['declared',{sshOnce:true,sourceRevision:'c'.repeat(40)},true,true],
    ['task-only',{commands:['task-once'],sourceRevision:'d'.repeat(40)},false,true],
  ] as const){
    const f=fixture(options);try{
      if (!f.db.all<any>("PRAGMA table_info(managed_machines)").some(column => column.name === 'default_account_id'))
        f.db.exec("ALTER TABLE managed_machines ADD COLUMN default_account_id TEXT NOT NULL DEFAULT ''");
      f.db.exec(`CREATE TABLE machine_ssh_accounts(id TEXT PRIMARY KEY,default_credential_id TEXT,deleted_at TEXT);
        CREATE TABLE effective_machine_credentials(id TEXT PRIMARY KEY,machine_id TEXT,revoked_at TEXT,
          secret_cleared_at TEXT,secret_encrypted TEXT,method TEXT,retention TEXT,expires_at TEXT);`);
      f.db.run("INSERT INTO machine_ssh_accounts VALUES('account','binding','')");
      f.db.run("UPDATE managed_machines SET default_account_id='account' WHERE id='host'");
      f.db.run("INSERT INTO effective_machine_credentials VALUES('binding','host',NULL,'','ciphertext','ssh_key','permanent','')");
      f.store.setSSHOnly();f.advance(61);
      const status=f.store.getStatus('host').capabilities['script.elevated.v1'];
      assert.equal(status.effective,managedReady?'ready':'unavailable',name);
      assert.equal(f.store.supportsSSHOnce('host','managed-once'),managedReady,name);
      assert.equal(f.store.supportsSSHOnce('host','task-once'),taskReady,name);
      if(!managedReady){assert.equal(status.reason_code,'agent_upgrade_required');assert.throws(()=>f.makePlan(),/agent_upgrade_required/);}
      else assert.ok(f.makePlan().id);
    }finally{f.close();}
  }
});

test("signed claim retries retain exact lease, reject altered body and persist nonce replay conflicts", () => {
  const f = fixture(); try {
    const run = f.apply(), req = f.request("jobs/claim", {}), first = req.invoke((e, v) => f.store.claim(e, v));
    const claims = planClaims(verifyJWS(first.job.plan, f.store.centerPublicKey, f.store.centerKeyID));
    assert.equal(claims.job_id, run.id); assert.equal(claims.task_run_id, run.task_run_id);
    assert.equal(canonicalJSON(req.invoke(() => { throw Error("must_not_reclaim"); })), canonicalJSON(first));
    assert.throws(() => f.store.signedRequest(f.enrolled.executor_id, "POST", req.path, Buffer.from('{"other":1}'), req.signature, () => ({})), /principal_mismatch/);
    const claimsInput: any = verifyJWS(req.signature, f.pub, f.enrolled.executor_id);
    f.advance(1);
    assert.equal(canonicalJSON(f.request("jobs/claim", {}, claimsInput.request_id).invoke(() => { throw Error("must_not_reclaim_when_resigned"); })), canonicalJSON(first));
    assert.throws(() => f.request("jobs/claim", { different: true }, claimsInput.request_id).invoke(() => ({})), /replay_conflict/);
    assert.equal(f.db.get<any>("SELECT execution_principal FROM task_runs WHERE id=?", run.id)!.execution_principal, "privileged_executor");
    const publicRoot = f.tasks.get(run.task_run_id);
    assert.equal(JSON.stringify(publicRoot).includes("secret-from-script"), false);
    assert.throws(() => f.tasks.cancel(run.task_run_id, "admin"), /principal_mismatch/);
  } finally { f.close(); }
});

test("ordinary scripts require signed helper claims and audit the fixed unprivileged task identity",()=>{
  const f=fixture();try{
    const task=f.tasks.nodes.task({name:"Reviewed ordinary task",type:"script",enabled:true,target_all:false,host_ids:["host"],label_ids:[],schedule:{mode:"once"},script:{runtime:"shell",code:"printf ok",timeout_seconds:5,max_output_bytes:1024}},"ordinary-script",true);
    const run=f.tasks.dispatch(task.id,{confirm:true,expected_task_revision:task.revision},"admin").runs[0];
    assert.deepEqual(run.snapshot.execution_identity,{account:"lightmoni-agent",uid:1001,gid:1001,permission_generation:3,executor_id:f.enrolled.executor_id,install_generation:f.enrolled.install_generation,privilege:"user"});
    assert.deepEqual(f.store.ordinaryTaskCapabilities("host","agent-host"),["task.script.v1","task.script.v2"]);
    const claimRequest=f.request("task-runs/claim",{capabilities:["task.script.v1"]});
    const claim=claimRequest.invoke((executor,input)=>f.store.taskRuns!.claimForHelper(executor,input)).run;
    assert.equal(claim.id,run.id);assert.equal(claim.snapshot.execution_identity?.account,"lightmoni-agent");
    const heartbeat=f.request("task-runs/"+run.id+"/heartbeat",{lease_token:claim.lease_token}).invoke((executor,input)=>f.store.taskRuns!.heartbeatForHelper(executor,run.id,input));
    assert.equal(heartbeat.state,"running");
    const result=f.request("task-runs/"+run.id+"/result",{lease_token:claim.lease_token,state:"succeeded",code:"",summary:"done",stdout:"ok",stderr:"",exit_code:0}).invoke((executor,input)=>f.store.taskRuns!.resultForHelper(executor,run.id,input));
    assert.equal(result.state,"succeeded");assert.equal(result.requested_by,"admin");assert.equal(result.snapshot.execution_identity.uid,1001);
    const receipt=f.request("task-runs/"+run.id+"/reconcile",{lease_token:claim.lease_token}).invoke((executor,input)=>f.store.taskRuns!.reconcileForHelper(executor,run.id,input));
    assert.deepEqual(receipt,{acknowledged:true,state:"succeeded"});
    f.db.run("UPDATE machine_agent_runtime SET runtime_mode='user' WHERE machine_id='host'");
    assert.deepEqual(f.store.ordinaryTaskCapabilities("host","agent-host"),[]);
  }finally{f.close();}
});

test("signed task identities accept only the unified non-root Agent account", () => {
  const f = fixture(); try {
    const row = f.db.get<any>("SELECT observation_enc FROM privileged_executors WHERE id=?", f.enrolled.executor_id)!;
    const observation = JSON.parse(f.deps.decrypt(row.observation_enc));
    for (const identity of [
      { ...observation.ordinary_task_identity, account: "lightmoni-task" },
      { ...observation.ordinary_task_identity, account: "root" },
      { ...observation.ordinary_task_identity, uid: 0 },
      { ...observation.ordinary_task_identity, gid: 0 },
    ]) {
      assert.throws(() => f.request("heartbeat", { ...observation, ordinary_task_identity: identity })
        .invoke((executor, input) => f.store.heartbeat(executor, input)), /invalid_ordinary_task_identity/);
    }
    assert.deepEqual(f.store.ordinaryTaskIdentity("host", "agent-host", f.enrolled.executor_id, f.enrolled.install_generation), {
      account: "lightmoni-agent", uid: 1001, gid: 1001, permission_generation: 3,
    });
  } finally { f.close(); }
});

test("persistent nonce replies and center signing identity survive store recreation", () => {
  const f = fixture(); try {
    f.apply(); const req = f.request("jobs/claim", {}), initial = req.invoke((e, v) => f.store.claim(e, v));
    const restarted = new PrivilegedExecutorStore(f.deps, { dataDir: "/unused" });
    assert.equal(restarted.centerInstanceID, f.store.centerInstanceID); assert.equal(restarted.centerPublicKey, f.store.centerPublicKey);
    assert.equal(canonicalJSON(restarted.signedRequest(f.enrolled.executor_id, "POST", req.path, Buffer.from(req.raw), req.signature, () => { throw Error("must_not_reclaim_after_restart"); })), canonicalJSON(initial));
  } finally { f.close(); }
});

test("policy withdrawal cancels queued work and signed policy acknowledges the new generation", () => {
  const f = fixture(); try {
    const job = f.apply(), plan = f.store.preparePolicyPlan("host", { capabilities: [] }, "admin");
    f.store.applyPolicy("host", plan.id, { confirm: true, expected_revision: plan.revision }, "admin");
    assert.equal(f.store.getPolicyPlan("host", plan.id).applied_at.length > 0, true);
    assert.equal(f.store.get(job.id).state, "cancelled");
    assert.equal(f.tasks.get(job.task_run_id).state, "cancelled");
    const reply = f.heartbeat(), signed = policyClaims(verifyJWS(reply.policy, f.store.centerPublicKey, f.store.centerKeyID));
    assert.equal(signed.policy_generation, plan.generation); assert.equal(signed.executor_id, f.enrolled.executor_id);
    assert.deepEqual(signed.capabilities, []); assert.ok(signed.exp - signed.iat <= 60);
  } finally { f.close(); }
});

test("verified removal revokes only current idle executor and invalidates its signed identity", () => {
  const f = fixture(); try {
    const queued = f.apply();
    assert.throws(() => f.store.revokeExecutor("host", f.enrolled.executor_id, "admin"), /machine_execution_locked/);
    f.store.cancel(queued.id, "admin");
    const state = f.store.revokeExecutor("host", f.enrolled.executor_id, "admin");
    assert.equal(state.executor!.state, "revoked"); assert.equal(state.capabilities["script.elevated.v1"].authorized, false);
    assert.equal(f.store.revokeExecutor("host", f.enrolled.executor_id, "admin").policy_generation, state.policy_generation);
    assert.throws(() => f.request("jobs/claim", {}).invoke((e, v) => f.store.claim(e, v)), /principal_mismatch/);
  } finally { f.close(); }
});

test("single permit consumes exact grant, cannot be exchanged with a new nonce and output is separate encrypted data", () => {
  const f = fixture(); try {
    const job = f.apply(), claim = f.request("jobs/claim", {}).invoke((e, v) => f.store.claim(e, v));
    const plan = planClaims(verifyJWS(claim.job.plan, f.store.centerPublicKey, f.store.centerKeyID));
    const start = { lease_id: plan.lease_id, step_id: "execute", executor_nonce: "execute_1234567890123456789" };
    const response = f.request("jobs/" + job.id + "/start-permits", start).invoke((e, v) => f.store.startPermit(e, job.id, v));
    const permit = permitClaims(verifyJWS(response.permit, f.store.centerPublicKey, f.store.centerKeyID));
    assert.equal(permit.executor_nonce, start.executor_nonce); assert.ok(permit.exp - permit.iat <= 30);
    assert.equal(f.db.get<any>("SELECT state FROM privileged_grants WHERE job_id=?", job.id)!.state, "consumed");
    assert.throws(() => f.request("jobs/" + job.id + "/start-permits", { ...start, executor_nonce: "another_1234567890123456789" }).invoke((e, v) => f.store.startPermit(e, job.id, v)), /replay_conflict/);
    const result = { lease_id: plan.lease_id, state: "succeeded", code: "", summary: "secret summary", exit_code: 0, stdout: "private script output", stderr: "" };
    f.request("jobs/" + job.id + "/result", result).invoke((e, v) => f.store.result(e, job.id, v));
    assert.equal(f.store.get(job.id).state, "succeeded");
    assert.equal(JSON.stringify(f.store.list()).includes("private script output"), false);
    assert.equal(JSON.stringify(f.tasks.get(job.task_run_id)).includes("private script output"), false);
    assert.equal(JSON.stringify(f.tasks.get(job.task_run_id)).includes("secret summary"), false);
    assert.equal(f.db.get<any>("SELECT output_enc FROM privileged_jobs WHERE id=?", job.id)!.output_enc.includes("private script output"), false);
    assert.equal(f.store.output(job.id, "admin").stdout, "private script output");
    assert.throws(() => f.store.output(job.id, "other"), /active_human_admin/);
  } finally { f.close(); }
});

test("lease loss and unknown never replay; policy and actor revocation block online start", () => {
  const f = fixture(); try {
    const job = f.apply(), claim = f.request("jobs/claim", {}).invoke((e, v) => f.store.claim(e, v));
    const p = planClaims(verifyJWS(claim.job.plan, f.store.centerPublicKey, f.store.centerKeyID));
    f.advance(46); assert.equal(f.store.get(job.id).state, "unknown");
    assert.equal(f.request("jobs/claim", {}).invoke((e, v) => f.store.claim(e, v)).job, null);
    assert.throws(() => f.request("jobs/" + job.id + "/result", { lease_id: p.lease_id, state: "succeeded", code: "", summary: "done", exit_code: 0, stdout: "", stderr: "" }).invoke((e, v) => f.store.result(e, job.id, v)), /execution_unknown/);
    f.store.resolve(job.id, "admin", "Confirmed no active managed execution remains"); f.heartbeat();
    const next = f.apply(), newClaim = f.request("jobs/claim", {}).invoke((e, v) => f.store.claim(e, v));
    const np = planClaims(verifyJWS(newClaim.job.plan, f.store.centerPublicKey, f.store.centerKeyID));
    f.db.run("UPDATE users SET active=0 WHERE id='admin'");
    assert.throws(() => f.request("jobs/" + next.id + "/start-permits", { lease_id: np.lease_id, step_id: "execute", executor_nonce: "start_12345678901234567890" }).invoke((e, v) => f.store.startPermit(e, next.id, v)), /active_human_admin/);
  } finally { f.close(); }
});

test("review freezes binding and profile; no future schedule, mass target or changed plan approval", () => {
  const f = fixture(); try {
    assert.throws(() => f.makePlan({ schedule: { mode: "cron" } }), /unknown/);
    assert.throws(() => f.makePlan({ host_ids: [] }), /explicit_host/);
    const plan = f.makePlan();
    assert.throws(() => f.store.apply(plan.id, { confirm: true, expected_revision: "a".repeat(64), request_id: "request_123456789012345" }, "admin"), /stale_execution_plan/);
    f.db.run("UPDATE managed_machines SET agent_id='new-agent' WHERE id='host'");
    assert.throws(() => f.store.apply(plan.id, { confirm: true, expected_revision: plan.revision, request_id: "request_123456789012345" }, "admin"), /stale_install_generation/);
    assert.equal(f.db.get<any>("SELECT count(*) n FROM privileged_jobs")!.n, 0);
  } finally { f.close(); }
});

test("public root endpoints reject ordinary control and output/apply require explicit human session", async () => {
  const f = fixture(), server = createServer((req, res) => { void f.router.handle(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as any, origin = "http://127.0.0.1:" + address.port;
  try {
    const denied = await fetch(origin + "/api/v1/privileged-executors/" + f.enrolled.executor_id + "/jobs/claim", { method: "POST", headers: { authorization: "Bearer control-agent-host", "content-type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);
    const output = await fetch(origin + "/api/v1/privileged-execution/jobs/nonexistent/output", { headers: { cookie: "lm_session=human", authorization: "Bearer mcp-tool" } });
    assert.equal(output.status, 403);
    const req = f.request("jobs/claim", {});
    const ok = await fetch(origin + req.path, { method: "POST", headers: { "x-lightmoni-executor-signature": req.signature }, body: req.raw });
    assert.equal(ok.status, 200); assert.equal((await ok.json()).job, null);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});

test("active and unknown Docker installations block privileged review approval claim and start permits",()=>{
 for(const state of ["running","unknown"]){
  const f=fixture();try{
   const reviewed=f.makePlan(),job=f.apply();
   const claimed=f.request("jobs/claim",{}).invoke((e,v)=>f.store.claim(e,v));
   const claims=planClaims(verifyJWS(claimed.job.plan,f.store.centerPublicKey,f.store.centerKeyID));
   f.db.exec("CREATE TABLE machine_docker_installations(id TEXT,machine_id TEXT,agent_id TEXT,state TEXT)");
   f.db.run("INSERT INTO machine_docker_installations VALUES('docker','host','agent-host',?)",state);
   assert.throws(()=>f.makePlan(),/docker_installation_pending/);
   assert.throws(()=>f.store.apply(reviewed.id,{confirm:true,expected_revision:reviewed.revision,request_id:randomBytes(24).toString('base64url')},"admin"),/docker_installation_pending/);
   assert.throws(()=>f.request("jobs/"+job.id+"/start-permits",{lease_id:claims.lease_id,step_id:"execute",executor_nonce:"dockerblocked_123456789012345"}).invoke((e,v)=>f.store.startPermit(e,job.id,v)),/docker_installation_pending/);
   assert.equal(f.db.get<any>("SELECT count(*) n FROM privileged_grants WHERE state='consumed'")!.n,0);
  }finally{f.close();}
  const waiting=fixture();try{
   const job=waiting.apply();
   waiting.db.exec("CREATE TABLE machine_docker_installations(id TEXT,machine_id TEXT,agent_id TEXT,state TEXT)");
   waiting.db.run("INSERT INTO machine_docker_installations VALUES('docker','host','agent-host',?)",state);
   assert.equal(waiting.request("jobs/claim",{}).invoke((e,v)=>waiting.store.claim(e,v)).job,null);
   assert.equal(waiting.store.get(job.id).state,"cancelled");
  }finally{waiting.close();}
 }
});
