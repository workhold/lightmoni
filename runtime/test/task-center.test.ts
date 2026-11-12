import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import type { Dependencies } from "../src/shared/types.js";
import { TaskRunStore, registerTaskCenter } from "../src/server/task-center.js";
import { SCRIPT_TASK_CAPABILITY } from "../src/shared/task-center.js";

function fixture() {
  const db = new DB(":memory:"), router = new Router(), user = { id: "admin", name: "Admin", role: "admin" };
  let clock = new Date("2026-10-30T00:00:00Z");
  const deps = { db, router, now: () => clock,
    auth: { user: () => user, requireAdmin(ctx: any) { if (ctx.user.role !== "admin") fail(403, "admin required"); } },
    logger: { info() {}, warn() {}, error(...v: any[]) { console.error(...v); } },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const credentials = { has: () => true, authenticate(req: any, agent: string, audience: string) {
    if (audience !== "control" || req.headers.authorization !== "Bearer control-" + agent) fail(401, "control credentials required");
    return { agent_id: agent, audience: "control" };
  } } as any;
  const store = registerTaskCenter(deps, { agentCredentials: credentials });
  const host = (id: string, agent = "agent-" + id) => {
    db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'direct_ssh',?,?,?)", id, "Host " + id, id + ".example.test", agent, clock.toISOString(), clock.toISOString());
    return id;
  };
  host("one"); host("two"); host("empty", "");
  db.exec("CREATE TABLE machine_agent_runtime(machine_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,runtime_mode TEXT NOT NULL,permission_generation INTEGER NOT NULL,updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE privileged_executors(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,install_generation INTEGER NOT NULL,state TEXT NOT NULL)");
  for (const id of ["one","two"]) {
    const agentID="agent-"+id,executorID="helper-"+id;
    db.run("INSERT INTO machine_agent_runtime VALUES(?,?,'root',3,?)",id,agentID,clock.toISOString());
    db.run("INSERT INTO privileged_executors VALUES(?,?,?,1,'active')",executorID,id,agentID);
  }
  store.ordinaryTaskIdentity=(machineID,agentID,executorID,installGeneration)=>{
    const runtime=db.get<any>("SELECT * FROM machine_agent_runtime WHERE machine_id=? AND agent_id=? AND runtime_mode='root'",machineID,agentID);
    const executor=db.get<any>("SELECT id FROM privileged_executors WHERE id=? AND machine_id=? AND agent_id=? AND install_generation=? AND state='active'",executorID,machineID,agentID,installGeneration);
    return runtime&&executor?{account:"lightmoni-agent",uid:1001,gid:1001,permission_generation:runtime.permission_generation}:null;
  };
  store.nodes.taskScriptCapabilities=(machineID,agentID)=>{
    const executor=db.get<any>("SELECT id,install_generation FROM privileged_executors WHERE machine_id=? AND agent_id=? AND state='active' ORDER BY install_generation DESC LIMIT 1",machineID,agentID);
    return executor&&store.ordinaryTaskIdentity?.(machineID,agentID,executor.id,executor.install_generation)?["task.script.v1","task.script.v2"]:[];
  };
  const helper=(agentID:string)=>{const machine=db.get<any>("SELECT id FROM managed_machines WHERE agent_id=?",agentID),executor=machine&&db.get<any>("SELECT id,install_generation FROM privileged_executors WHERE machine_id=? AND agent_id=? AND state='active'",machine.id,agentID);if(!machine||!executor)throw Error("test_helper_unavailable");return {id:executor.id,machine_id:machine.id,agent_id:agentID,install_generation:executor.install_generation};};
  const claim=(agentID:string,caps:string[])=>store.claimForHelper(helper(agentID),{capabilities:caps}).run;
  const heartbeat=(agentID:string,id:string,input:any)=>store.heartbeatForHelper(helper(agentID),id,input);
  const receipt=(agentID:string,id:string,input:any)=>store.resultForHelper(helper(agentID),id,input);
  const task = (id = "script-one", options: any = {}) => store.nodes.task({ name: "Sample task", type: "script", enabled: true, target_all: false, host_ids: ["one"], label_ids: [],
    schedule: { mode: "once" }, script: { runtime: "node", code: "console.log('original')", timeout_seconds: 5, max_output_bytes: 4096 }, ...options }, id, true);
  return { db, deps, router, user, store, task, host, helper, claim, heartbeat, receipt,
    advance(seconds: number) { clock = new Date(clock.getTime() + seconds * 1000); },
    close() { store.close?.(); db.close(); } };
}
const capabilities = [SCRIPT_TASK_CAPABILITY];
const result = (lease: string, overrides: any = {}) => ({ lease_token: lease, state: "succeeded", code: "", summary: "done", stdout: "ok", stderr: "", exit_code: 0, ...overrides });

test('manual scripts require an exact SSH invocation while scheduled helper polling remains separate',()=>{
  const f=fixture();try{
    f.task();const manual=f.store.dispatch('script-one',{confirm:true},'admin').runs[0];
    f.store.setSSHOnly();
    assert.equal(f.claim('agent-one',capabilities),null);
    const wrong=f.store.claimForHelper(f.helper('agent-one'),{capabilities,run_id:'0'.repeat(8)+'-'+['0'.repeat(4),'0'.repeat(4),'0'.repeat(4),'0'.repeat(12)].join('-')}).run;
    assert.equal(wrong,null);
    const claimed=f.store.claimForHelper(f.helper('agent-one'),{capabilities,run_id:manual.id}).run;
    assert.equal(claimed?.id,manual.id);
  }finally{f.close();}
});

test('an old helper blocks new manual scripts without invalidating an already accepted run',()=>{
  const f=fixture();try{
    f.task('manual-old');
    f.store.sshOnceReady=()=>false;
    f.store.setSSHOnly();
    assert.throws(()=>f.store.dispatch('manual-old',{confirm:true},'admin'),/agent_upgrade_required/);
    assert.equal(f.store.list().length,0);
    f.store.sshOnceReady=()=>true;
    const accepted=f.store.dispatch('manual-old',{confirm:true},'admin').runs[0];
    assert.equal(accepted.state,'queued');
    f.store.sshOnceReady=()=>false;
    assert.equal(f.store.claimForHelper(f.helper('agent-one'),{capabilities,run_id:accepted.id}).run?.id,accepted.id);
  }finally{f.close();}
});

test("ordinary routes cannot claim, mutate, expire or retry a root executor lineage",()=>{
  const f=fixture();try{
    f.task();const run=f.store.dispatch("script-one",{confirm:true},"admin").runs[0];
    const claim=f.claim("agent-one",capabilities)!;
    f.db.run("UPDATE task_runs SET execution_principal='privileged_executor',executor_id='root-executor' WHERE id=?",run.id);
    assert.equal(f.claim("agent-one",capabilities),null);
    assert.throws(()=>f.heartbeat("agent-one",run.id,{lease_token:claim.lease_token}),/principal_mismatch/);
    assert.throws(()=>f.receipt("agent-one",run.id,result(claim.lease_token)),/principal_mismatch/);
    assert.throws(()=>f.store.cancel(run.id,"admin"),/principal_mismatch/);
    f.advance(1000);f.store.sweep();assert.equal(f.store.get(run.id).state,"running");
    f.db.run("UPDATE task_runs SET state='unknown' WHERE id=?",run.id);
    assert.throws(()=>f.store.resolve(run.id,"admin","checked process stopped"),/principal_mismatch/);
    assert.throws(()=>f.store.retry(run.id,"admin"),/principal_mismatch/);
    assert.equal(f.store.get(run.id).execution_principal,"privileged_executor");
    assert.throws(()=>f.store.dispatch("script-one",{confirm:true,request_id:"new-root-fence"},"admin"),/privileged_execution_pending|unresolved/);
  }finally{f.close();}
});

test("manual dispatch validates confirmation and targets atomically, snapshots code and hides lease tokens", () => {
  const f = fixture(); try {
    f.task();
    assert.throws(() => f.store.dispatch("script-one", {}, "admin"), /confirmation/);
    assert.throws(() => f.store.dispatch("script-one", { confirm: true, host_ids: ["two"] }, "admin"), /outside task targets/);
    const run = f.store.dispatch("script-one", { confirm: true, request_id: "safe-request" }, "admin").runs[0];
    assert.equal(run.state, "queued"); assert.equal(Object.hasOwn(run, "lease_token"), false);
    assert.deepEqual(run.snapshot.execution_identity,{account:"lightmoni-agent",uid:1001,gid:1001,permission_generation:3,executor_id:"helper-one",install_generation:1,privilege:"user"});
    assert.equal(run.requested_by,"admin");
    assert.equal(f.store.dispatch("script-one", { confirm: true, request_id: "safe-request" }, "admin").runs[0].id, run.id);
    assert.equal(f.store.list().length, 1);
    const updated = f.store.nodes.getTask("script-one");
    f.store.nodes.task({ ...updated, script: { ...updated.script, code: "console.log('changed')" } }, updated.id, false);
    assert.equal(f.store.get(run.id).snapshot.script.code, "console.log('original')");
    f.task("no-agent", { host_ids: ["one", "empty"] });
    assert.throws(() => f.store.dispatch("no-agent", { confirm: true }, "admin"), /enrolled Agent/);
    assert.equal(f.store.list({ task_id: "no-agent" }).length, 0);
  } finally { f.close(); }
});

test("scheduled scripts skip hosts without a fresh signed helper and still dispatch to eligible hosts",()=>{
  const f=fixture();try{
    f.task("scheduled",{host_ids:["one","two"],schedule:{mode:"interval",interval_seconds:10}});
    const lastSeen="2026-10-30T00:00:00.000Z";
    for(const id of ["one","two"])f.db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES(?,?,?,'1','linux','x64',?,'{}')","agent-"+id,id,id,lastSeen);
    f.store.nodes.taskScriptCapabilities=()=>["task.script.v1","task.script.v2"];
    f.store.tick();
    f.store.nodes.taskScriptCapabilities=(machineID)=>machineID==="two"?["task.script.v1","task.script.v2"]:[];
    f.advance(10);f.store.tick();
    assert.equal(f.store.nodes.effectiveHostTasks("one").find(task=>task.id==="scheduled")?.status,"task_channel_unavailable");
    assert.equal(f.store.list({task_id:"scheduled",host_id:"one"}).length,0);
    assert.equal(f.store.list({task_id:"scheduled",host_id:"two"}).length,1);
    f.task("manual",{host_ids:["one"]});
    assert.throws(()=>f.store.dispatch("manual",{confirm:true},"admin"),/signed_task_helper_unavailable/);
    assert.equal(f.store.list({task_id:"manual"}).length,0);
  }finally{f.close();}
});

test("claims require capability, serialize per Agent, bind hashed leases and accept only bounded valid receipts", () => {
  const f = fixture(); try {
    f.task(); const run = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    assert.equal(f.claim("agent-one", []), null);
    const claim = f.claim("agent-one", capabilities)!;
    assert.equal(claim.id, run.id); assert.equal(claim.state, "running");
    assert.notEqual(f.db.get<any>("SELECT lease_hash FROM task_runs WHERE id=?", run.id)!.lease_hash, claim.lease_token);
    assert.equal(f.claim("agent-one", capabilities), null);
    assert.throws(() => f.receipt("agent-two", run.id, result(claim.lease_token)), /another Agent/);
    assert.throws(() => f.receipt("agent-one", run.id, result("a".repeat(64))), /invalid task run lease/);
    assert.throws(() => f.receipt("agent-one", run.id, result(claim.lease_token, { stdout: "x".repeat(4097) })), /oversized/);
    assert.throws(() => f.receipt("agent-one", run.id, result(claim.lease_token, { exit_code: 1 })), /invalid/);
    assert.equal(f.receipt("agent-one", run.id, result(claim.lease_token)).state, "succeeded");
    assert.equal(f.receipt("agent-one", run.id, result(claim.lease_token, { state: "failed" })).state, "succeeded");
    assert.equal(Object.hasOwn(f.store.list()[0], "lease_hash"), false);
  } finally { f.close(); }
});

test("lease expiry is durable unknown, never automatic replay; explicit retry uses current definition", () => {
  const f = fixture(); try {
    f.task(); const run = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    const claim = f.claim("agent-one", capabilities)!;
    f.advance(61); assert.equal(f.store.get(run.id).state, "unknown");
    assert.equal(f.claim("agent-one", capabilities), null);
    assert.throws(() => f.receipt("agent-one", run.id, result(claim.lease_token)), /expired/);
    assert.throws(() => f.store.dispatch("script-one", { confirm: true }, "admin"), /unresolved/);
    const updated = f.store.nodes.getTask("script-one");
    f.store.nodes.task({ ...updated, script: { ...updated.script, code: "console.log('new version')" } }, updated.id, false);
    const retry = f.store.retry(run.id, "admin");
    assert.equal(retry.retry_of, run.id); assert.equal(retry.snapshot.script.code, "console.log('new version')");
    assert.equal(f.store.get(run.id).superseded_by, retry.id);
    assert.throws(() => f.store.retry(run.id, "admin"), /already has a retry/);
    assert.equal(f.claim("agent-one", capabilities)!.id, retry.id);
  } finally { f.close(); }
});

test("unresolved result on a host fences a different script until retry or manual resolution", () => {
  const f = fixture(); try {
    f.task("script-one");
    const run = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    f.task("script-two", { name: "Another script" });
    const waiting = f.store.dispatch("script-two", { confirm: true }, "admin").runs[0];
    const claim = f.claim("agent-one", capabilities)!;
    assert.equal(claim.id, run.id);
    f.advance(61);
    assert.equal(f.store.get(run.id).state, "unknown");
    assert.equal(f.claim("agent-one", capabilities), null, "a task queued before the unknown result also remains fenced");
    f.task("script-three", { name: "A third script" });
    assert.throws(() => f.store.dispatch("script-three", { confirm: true }, "admin"), /unresolved task result/);

    f.store.resolve(run.id, "admin", "Confirmed the remote process stopped");
    assert.equal(f.claim("agent-one", capabilities)!.id, waiting.id);
    assert.equal(f.store.get(run.id).state, "unknown", "manual resolution does not rewrite the historical outcome");
    assert.ok(claim.lease_token);
  } finally { f.close(); }
});

test("reviewed task revisions reject concurrent source edits before dispatch and retry", () => {
  const f = fixture(); try {
    const old = f.task();
    f.store.nodes.task({ ...old, script: { ...old.script, code: "console.log('unreviewed source')" } }, old.id, false);
    assert.throws(() => f.store.dispatch(old.id, { confirm: true, expected_task_revision: old.revision }, "admin"), /changed since review/);
    assert.equal(f.store.list().length, 0);
    const reviewed = f.store.nodes.getTask(old.id);
    const run = f.store.dispatch(old.id, { confirm: true, expected_task_revision: reviewed.revision }, "admin").runs[0];
    f.store.cancel(run.id, "admin");
    f.store.nodes.task({ ...reviewed, script: { ...reviewed.script, code: "console.log('edited again')" } }, old.id, false);
    assert.throws(() => f.store.retry(run.id, "admin", false, reviewed.revision), /changed since review/);
    assert.equal(f.store.get(run.id).superseded_by, ""); assert.equal(f.store.list().length, 1);
  } finally { f.close(); }
});

test("manual unknown resolution records an immutable audit without replaying or inventing success", () => {
  const f = fixture(); try {
    f.task(); const run = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    assert.throws(() => f.store.resolve(run.id, "admin", "Checked host"), /only an unknown/);
    const claim = f.claim("agent-one", capabilities)!;
    assert.throws(() => f.store.resolve(run.id, "admin", "Checked host"), /only an unknown/);
    f.advance(61); assert.equal(f.store.get(run.id).state, "unknown");
    assert.throws(() => f.store.resolve(run.id, "admin", " "), /reason/);
    assert.throws(() => f.store.resolve(run.id, "admin", "x".repeat(513)), /reason/);
    const resolved = f.store.resolve(run.id, "admin", "  Verified process ended on the host  ");
    assert.equal(resolved.state, "unknown"); assert.equal(resolved.code, "lease_expired");
    assert.equal(resolved.resolved_by, "admin"); assert.ok(resolved.resolved_at);
    assert.equal(resolved.resolution_reason, "Verified process ended on the host");
    assert.equal(f.store.resolve(run.id, "other-admin", "Another reason").resolution_reason, resolved.resolution_reason);
    assert.equal(f.store.get(run.id).resolved_by, "admin");
    assert.equal(f.store.list().length, 1); assert.equal(f.claim("agent-one", capabilities), null);
    assert.throws(() => f.store.retry(run.id, "admin"), /resolved/);
    assert.throws(() => f.receipt("agent-one", run.id, result(claim.lease_token)), /manually resolved/);
    const next = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    assert.notEqual(next.id, run.id); assert.equal(next.retry_of, "");
  } finally { f.close(); }
});

test("cancellation waits for Agent receipt, removed targets cancel before claim and rebound identities cannot submit", () => {
  const f = fixture(); try {
    f.task(); const run = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    const principal=f.helper("agent-one");
    const claim = f.claim("agent-one", capabilities)!;
    assert.equal(f.store.cancel(run.id, "admin").state, "running");
    assert.equal(f.heartbeat("agent-one", run.id, { lease_token: claim.lease_token }).cancel_requested, true);
    assert.equal(f.receipt("agent-one", run.id, result(claim.lease_token, { state: "cancelled", exit_code: null })).state, "cancelled");
    const queued = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    f.db.run("UPDATE managed_machines SET agent_id='new-agent' WHERE id='one'");
    assert.equal(f.store.get(queued.id).code, "agent_binding_changed");
    assert.throws(() => f.store.resultForHelper(principal,run.id,result(claim.lease_token)), /helper_agent_binding_changed/);
  } finally { f.close(); }
});

test("interval scheduling persists next due, skips overlaps and missed periods, and honors host overrides", () => {
  const f = fixture(); try {
    f.task("periodic", { schedule: { mode: "interval", interval_seconds: 10 }, execution_policy: { queue_timeout_seconds: 86400 } });
    f.store.tick(); assert.equal(f.store.list().length, 0);
    f.advance(10); f.store.tick(); assert.equal(f.store.list().length, 1);
    const queued = f.store.list()[0]; assert.equal(queued.trigger, "schedule");
    f.advance(3600); f.store.tick(); assert.equal(f.store.list().length, 1);
    const store2 = new TaskRunStore(f.deps); store2.tick(); assert.equal(store2.list().length, 1);
    const claim = f.claim("agent-one", capabilities)!;
    f.receipt("agent-one",claim.id,result(claim.lease_token));
    f.advance(10); f.store.tick(); assert.equal(f.store.list().length, 2);
    f.store.cancel(f.store.list()[0].id, "admin");
    f.store.nodes.setOverride("one", "periodic", { enabled: false });
    f.advance(10); f.store.tick(); assert.equal(f.store.list().length, 2);
  } finally { f.close(); }
});

test("scheduler rechecks a definition edited after its scan before dispatching a due interval", () => {
  const f = fixture(); try {
    f.task("periodic", { schedule: { mode: "interval", interval_seconds: 10 } });
    f.store.tick(); f.advance(10);
    const staleScan = f.store.nodes.tasks(), current = f.store.nodes.getTask("periodic");
    f.store.nodes.task({ ...current, schedule: { mode: "once" } }, current.id, false);
    const actual = f.store.nodes.tasks.bind(f.store.nodes);
    f.store.nodes.tasks = () => { f.store.nodes.tasks = actual; return staleScan; };
    f.store.tick();
    assert.equal(f.store.list().length, 0, "an old interval scan cannot execute a task now configured for explicit dispatch");
  } finally { f.close(); }
});

test("real HTTP rejects ordinary Agent bearer task claims and results; signed helper owns task control", async t => {
  const f=fixture();
  const server=createServer(async(req,res)=>{if(!await f.router.handle(req,res)){res.writeHead(404);res.end()}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));f.close()});
  const post=async(path:string,body:unknown,bearer:string)=>{const response=await fetch(endpoint+path,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+bearer},body:JSON.stringify(body)});const text=await response.text();let value:any;try{value=JSON.parse(text)}catch{value=null}return {status:response.status,body:value}};
  const noHelper=await post("/api/v1/agents/agent-one/task-runs/claim",{capabilities},"control-agent-one");
  assert.equal(noHelper.status,404);
  const wrongAudience=await post("/api/v1/agents/agent-one/task-runs/claim",{capabilities},"data-agent-one");
  assert.equal(wrongAudience.status,404);
  const result=await post("/api/v1/agents/agent-one/task-runs/any-run/result",{lease_token:"a".repeat(64),state:"succeeded",code:"",summary:"done",stdout:"",stderr:"",exit_code:0},"control-agent-one");
  assert.equal(result.status,404);
});
