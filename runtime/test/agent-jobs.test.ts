import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import type { Dependencies } from "../src/shared/types.js";

function fixture(expirySweepIntervalMs?: number) {
  const db = new DB(":memory:");
  let current = new Date("2026-10-22T00:00:00.000Z");
  const deps = {
    db,
    router: new Router(),
    auth: { requireAdmin: () => {}, user: () => ({ id: "admin", name: "Admin", role: "admin" }), validateKey: () => { throw Error("unused"); }, master: Buffer.alloc(32) },
    now: () => current,
    externalURL: "http://127.0.0.1:8080",
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
    logger: { info() {}, warn() {}, error() {} },
    cat: { list: async () => [] }, query: async () => ({ request_id: "", results: [] }), referencedTables: async () => [],
    ch: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
    reader: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
  } as unknown as Dependencies;
  const credentials = { has: () => true, authenticate() { return { credential_id: "cred", agent_id: "agent-1", audience: "control", scope: "agent.control", expires_at: "", last_used_at: "" }; } } as any;
  return { db, deps, jobs: registerAgentJobs(deps, { agentCredentials: credentials, expirySweepIntervalMs }), advance(seconds: number) { current = new Date(current.getTime() + seconds * 1000); } };
}

test("Agent job lease protocol is idempotent and records bounded receipts", () => {
  const f = fixture();
  const created = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-1", operationID: "op-1", capabilities: ["health.systemd"], actions: [{ kind: "health_check", check: { kind: "systemd-active", unit: "checkout.service" } }] });
  const repeated = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-1", operationID: "op-1", capabilities: ["health.systemd"], actions: [{ kind: "health_check", check: { kind: "systemd-active", unit: "checkout.service" } }] });
  assert.equal(repeated.id, created.id);
  assert.equal(f.jobs.claim("agent-1", ["health.http"]), null);
  const leased = f.jobs.claim("agent-1", ["health.systemd"]);
  assert.ok(leased);
  assert.equal(leased.state, "leased");
  assert.throws(() => f.jobs.event("other-agent", leased!.id, { lease_id: leased!.lease_id, sequence: 1, phase: "accepted" }), /does not belong/);
  const accepted = f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 1, phase: "accepted", summary: "job accepted" });
  assert.equal(accepted.state, "accepted");
  assert.equal(f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 1, phase: "accepted", summary: "job accepted" }).state, "accepted");
  const staged = f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 2, phase: "staging", summary: "artifact staged", snapshot: { digest: "sha256:…" } });
  assert.equal(staged.state, "staging");
  assert.throws(() => f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 3, phase: "accepted", summary: "late regression" }), /cannot move backwards/);
  const activating = f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 3, phase: "activating", summary: "activate release" });
  assert.equal(activating.state, "activating");
  const verifying = f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 4, phase: "verifying", summary: "health check" });
  assert.equal(verifying.state, "verifying");
  assert.throws(() => f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 6, phase: "verifying", summary: "sequence gap" }), /sequence has a gap/);
  const done = f.jobs.result("agent-1", leased!.id, { lease_id: leased!.lease_id, state: "succeeded", code: "", summary: "service active", snapshot: { active_state: "active", health: { healthy: true } } });
  assert.equal(done.state, "succeeded");
  assert.equal(done.lease_id, "");
  assert.equal(f.jobs.get(leased!.id).receipt.state, "succeeded");
  f.db.close();
});

test("ordinary queue rejects legacy writes, daemon reads and read capability spoofing before persistence", () => {
  const f = fixture();
  const forbidden = [
    { capabilities: ["systemd.restart"], actions: [{kind:"systemd", operation:"restart", unit:"app.service"}] },
    { capabilities: ["artifact.stage"], actions: [{kind:"stage_artifact", digest:"a".repeat(64)}] },
    { capabilities: ["artifact.activate_release"], actions: [{kind:"activate_release", version:"v2"}] },
    { capabilities: ["docker.inventory"], actions: [{kind:"docker", operation:"inventory"}] },
    { capabilities: ["docker.control"], actions: [{kind:"docker", operation:"restart"}] },
    ...["website","certificate","compose","backup","platform"].map(domain=>({capabilities:["operations."+domain],actions:[{kind:"operations",domain,operation_id:"private"}]})),
    { capabilities: ["health.systemd"], actions: [{kind:"systemd", operation:"restart", unit:"app.service"}] },
    { capabilities: ["health.systemd"], actions: [{kind:"health_check", check:{kind:"systemd-active",unit:"app.service"}, command:"touch /etc/unsafe"}] },
    { capabilities: ["health.systemd"], actions: [{kind:"health_check", check:{kind:"systemd-active",unit:"app.service",operation:"restart"}}] },
    { capabilities: ["health.http"], actions: [{kind:"health_check", check:{kind:"http",url:"https://user:secret@example.com"}}] },
    { capabilities: ["health.http","systemd.restart"], actions: [{kind:"health_check", check:{kind:"http",url:"https://example.com"}}] },
    { capabilities: ["health.http"], actions: [{kind:"health_check", check:{kind:"http",url:"https://example.com",timeoutMs:30001}}] },
  ];
  try {
    forbidden.forEach((job,i)=>assert.throws(()=>f.jobs.enqueue({agentID:"agent-1",deploymentID:"denied-"+i,operationID:"denied-"+i,...job}),/privileged_executor_required/));
    assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_jobs")!.n,0);
    assert.throws(()=>f.jobs.claim("agent-1",["health.http","systemd.restart"]),/privileged_executor_required/);
  } finally { f.db.close(); }
});

test("one node cannot claim another job while a previous lease is active", () => {
  const f = fixture();
  f.jobs.enqueue({agentID:"agent-1",deploymentID:"one",operationID:"one",capabilities:["health.systemd"],actions:[{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}]});
  f.jobs.enqueue({agentID:"agent-1",deploymentID:"two",operationID:"two",capabilities:["health.systemd"],actions:[{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}]});
  const first=f.jobs.claim("agent-1",["health.systemd"])!;
  assert.ok(first); assert.equal(f.jobs.claim("agent-1",["health.systemd"]),null);
  f.jobs.result("agent-1",first.id,{lease_id:first.lease_id,state:"failed",summary:"closed"});
  assert.ok(f.jobs.claim("agent-1",["health.systemd"])); f.db.close();
});

test("success without verified health evidence becomes unknown and cancellation reports prior state", () => {
  const f = fixture();
  const updates: any[] = [];
  f.jobs.onUpdate((update) => updates.push(update));
  const malformed = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-malformed", operationID: "op-malformed", capabilities: ["health.systemd"], actions: [{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}] });
  const leased = f.jobs.claim("agent-1", ["health.systemd"]);
  assert.ok(leased);
  const invalid = f.jobs.result("agent-1", malformed.id, { lease_id: leased!.lease_id, state: "succeeded", summary: "claimed success", snapshot: { health: { healthy: true } } });
  assert.equal(invalid.state, "unknown");
  assert.equal(invalid.receipt.code, "invalid_agent_sequence");
  assert.equal(updates.at(-1).previousState, "leased");
  assert.equal(updates.at(-1).healthVerified, false);

  const queued = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-queued", operationID: "op-queued", capabilities: ["health.systemd"], actions: [{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}] });
  f.jobs.cancel(queued.id, "admin");
  assert.equal(updates.at(-1).phase, "cancelled");
  assert.equal(updates.at(-1).previousState, "queued");
  const claimed = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-claimed-cancel", operationID: "op-claimed-cancel", capabilities: ["health.systemd"], actions: [{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}] });
  const claimedLease = f.jobs.claim("agent-1", ["health.systemd"]);
  assert.ok(claimedLease);
  f.jobs.cancel(claimed.id, "admin");
  assert.equal(f.jobs.get(claimed.id).state, "unknown");
  assert.equal(f.jobs.get(claimed.id).receipt.code, "unknown_execution_result");
  assert.equal(updates.at(-1).phase, "unknown");
  assert.equal(updates.at(-1).previousState, "leased");
  const expired = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-expired", operationID: "op-expired", capabilities: ["health.systemd"], actions: [{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}], expiresInSeconds: 60 });
  f.advance(61);
  assert.equal(f.jobs.claim("agent-1", ["health.systemd"]), null);
  assert.equal(f.jobs.get(expired.id).state, "cancelled");
  assert.equal(f.jobs.get(expired.id).receipt.code, "job_expired");
  assert.equal(updates.at(-1).previousState, "queued");
  f.db.close();
});

test("centre sweep expires lost Agent leases without waiting for another Agent request", async () => {
  const f = fixture(10);
  const job = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-offline", operationID: "op-offline", capabilities: ["health.systemd"], actions: [{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}] });
  const leased = f.jobs.claim("agent-1", ["health.systemd"]);
  assert.ok(leased);
  f.advance(46);
  f.jobs.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.jobs.get(job.id).state, "unknown");
  } finally {
    f.jobs.close();
    f.db.close();
  }
});

test("expired Agent leases become unknown and cannot be completed", () => {
  const f = fixture();
  const job = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-2", operationID: "op-2", capabilities: ["health.systemd"], actions: [{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}] });
  const leased = f.jobs.claim("agent-1", ["health.systemd"]);
  assert.ok(leased);
  f.advance(46);
  assert.equal(f.jobs.claim("agent-1", ["health.systemd"]), null);
  const unknown = f.jobs.get(job.id);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.receipt.code, "unknown_execution_result");
  assert.throws(() => f.jobs.result("agent-1", job.id, { lease_id: leased!.lease_id, state: "succeeded", summary: "late" }), /lease is invalid|expired/);
  f.db.close();
});

test("read-only systemd preflight jobs reject deployment phases and snapshots from an earlier request", () => {
  const f = fixture();
  const revision = "a".repeat(64);
  const makeSnapshot = (preflightID: string) => ({
    health: { healthy: true },
    preflight: {
      provider: "systemd", ready: true, systemd_available: true, unit_exists: true,
      active_state: "active", enabled: true, unit_file_state: "enabled", filesystem_check_supported: true, release_directory_exists: true,
      release_directory_writable: true, entrypoint_matches: true, current_pointer_valid: true,
      current_version: "v1", observed_at: "2026-10-22T00:00:00.000Z",
      preflight_id: preflightID, target_revision: revision,
    },
  });
  const queueProbe = (preflightID: string) => f.jobs.enqueue({
    agentID: "agent-1", deploymentID: `preflight:${preflightID}`, operationID: `op-${preflightID}`,
    capabilities: ["systemd.probe"],
    actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: "/opt/checkout", preflightID, targetRevision: revision }],
  });

  const oldID = "b".repeat(32);
  queueProbe(oldID);
  const oldJob = f.jobs.claim("agent-1", ["systemd.probe"]);
  assert.ok(oldJob);
  f.jobs.event("agent-1", oldJob!.id, { lease_id: oldJob!.lease_id, sequence: 1, phase: "accepted", summary: "accepted" });
  f.jobs.event("agent-1", oldJob!.id, { lease_id: oldJob!.lease_id, sequence: 2, phase: "preflighting", summary: "preflight" });
  const oldResult = f.jobs.result("agent-1", oldJob!.id, { lease_id: oldJob!.lease_id, state: "succeeded", summary: "completed", snapshot: makeSnapshot(oldID) });
  assert.equal(oldResult.state, "succeeded");

  const newID = "c".repeat(32);
  queueProbe(newID);
  const newJob = f.jobs.claim("agent-1", ["systemd.probe"]);
  assert.ok(newJob);
  f.jobs.event("agent-1", newJob!.id, { lease_id: newJob!.lease_id, sequence: 1, phase: "accepted", summary: "accepted" });
  f.jobs.event("agent-1", newJob!.id, { lease_id: newJob!.lease_id, sequence: 2, phase: "preflighting", summary: "preflight" });
  assert.throws(() => f.jobs.event("agent-1", newJob!.id, { lease_id: newJob!.lease_id, sequence: 3, phase: "staging", summary: "must be rejected" }), /phase does not match/);
  assert.throws(() => f.jobs.event("agent-1", newJob!.id, { lease_id: newJob!.lease_id, sequence: 3, phase: "verifying", summary: "must be rejected" }), /phase does not match/);
  const replay = f.jobs.result("agent-1", newJob!.id, { lease_id: newJob!.lease_id, state: "succeeded", summary: "replayed", snapshot: makeSnapshot(oldID) });
  assert.equal(replay.state, "failed");
  assert.equal(replay.receipt.code, "invalid_preflight_result");
  assert.deepEqual(replay.receipt.snapshot, {});
  f.db.close();
});

test('pending, running, unknown and completed node uninstallations block enqueue and claim',()=>{
 const f=fixture();try{
  f.db.exec('CREATE TABLE machine_uninstallations(id TEXT,agent_id TEXT,status TEXT)');
  f.jobs.enqueue({agentID:'agent-1',deploymentID:'prior',operationID:'prior',capabilities:["health.systemd"],actions:[{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}]});
  for(const state of ['awaiting_approval','running','unknown','succeeded']){
   f.db.run('INSERT INTO machine_uninstallations VALUES(?,?,?)','u','agent-1',state);
   assert.throws(()=>f.jobs.enqueue({agentID:'agent-1',deploymentID:state,operationID:state,capabilities:["health.systemd"],actions:[{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}]}),/uninstallation_blocks_jobs/);
   assert.equal(f.jobs.claim('agent-1',['health.systemd']),null);
   f.db.run('DELETE FROM machine_uninstallations');
  }
  assert.ok(f.jobs.claim('agent-1',['health.systemd']));
 }finally{f.jobs.close?.();f.db.close();}
});

test("recovery uninstall fences host-bound jobs even when the actual remote identity is missing or different",()=>{
  for(const state of ["awaiting_approval","running","unknown"]){
    const f=fixture();try{
      const queued=f.jobs.enqueue({agentID:"agent-1",deploymentID:"before",operationID:"before",capabilities:["health.systemd"],actions:[{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}]});
      f.db.exec("CREATE TABLE managed_machines(id TEXT PRIMARY KEY,agent_id TEXT);CREATE TABLE machine_uninstallations(id TEXT PRIMARY KEY,machine_id TEXT,agent_id TEXT,status TEXT)");
      f.db.run("INSERT INTO managed_machines VALUES('host','agent-1')");
      f.db.run("INSERT INTO machine_uninstallations VALUES('removal','host','',?)",state);
      assert.throws(()=>f.jobs.enqueue({agentID:"agent-1",deploymentID:"during",operationID:"during",capabilities:["health.systemd"],actions:[{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}]}),/uninstallation_blocks_jobs/);
      assert.equal(f.jobs.claim("agent-1",["health.systemd"]),null);
      assert.equal(f.jobs.get(queued.id).state,"queued");
      f.db.run("UPDATE machine_uninstallations SET status='cancelled'");
      assert.equal(f.jobs.claim("agent-1",["health.systemd"])!.id,queued.id);
    }finally{f.jobs.close();f.db.close();}
  }
});

function insertLegacy(f: ReturnType<typeof fixture>, id: string, state: string, attempts: number) {
  const at=f.deps.now().toISOString();
  f.db.run("INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,capabilities_json,actions_json,issued_at,expires_at,created_at,updated_at,attempts,lease_id,lease_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id,"agent-1","legacy-deployment-"+id,"legacy-operation-"+id,state,JSON.stringify(["systemd.restart"]),JSON.stringify([{kind:"systemd",operation:"restart",unit:"app.service"}]),at,"2099-01-01T00:00:00.000Z",at,at,attempts,"old-lease","2099-01-01T00:00:00.000Z");
}

test("startup quarantines old writes and replays durable outcomes to business stores registered later", () => {
  const f=fixture();
  try {
    insertLegacy(f,"queued","queued",0);insertLegacy(f,"claimed","leased",1);insertLegacy(f,"running","activating",1);insertLegacy(f,"retried","queued",1);
    const restarted=registerAgentJobs({...f.deps,router:new Router()},{agentCredentials:{has:()=>true} as any});
    const updates:any[]=[];restarted.onUpdate(update=>updates.push(update));
    assert.equal(updates.length,4);
    for(const id of ["queued","claimed","running","retried"]) {
      const job=restarted.get(id);assert.equal(job.state,id==="queued"?"cancelled":"unknown");assert.equal(job.receipt.code,"legacy_agent_write_removed");assert.equal(job.lease_id,"");assert.equal(job.lease_expires_at,"");
      assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_job_events WHERE job_id=?",id)!.n,1);
      assert.equal(restarted.cancel(id,"admin").state,job.state,"cancellation cannot release an unresolved write fence");
      assert.throws(()=>restarted.event("agent-1",id,{lease_id:"old-lease",sequence:2,phase:"succeeded"}),/privileged_executor_required/);
      assert.throws(()=>restarted.result("agent-1",id,{lease_id:"old-lease",state:"succeeded",snapshot:{health:{healthy:true}}}),/privileged_executor_required/);
      assert.equal(restarted.get(id).state,job.state);
    }
    assert.equal(updates.find(update=>update.jobID==="running").previousState,"activating");
    assert.equal(restarted.claim("agent-1",["health.systemd"]),null);
    const second:any[]=[];restarted.onUpdate(update=>second.push(update));assert.equal(second.length,4);
    assert.equal(updates.length,4,"new subscriptions do not notify old observers twice");
    assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_job_events")!.n,4,"replay never appends a second canonical event");
    restarted.close();
  } finally {f.jobs.close();f.db.close();}
});

test("claim quarantines a legacy row inserted after startup and cannot lease it through self-reported capability", () => {
  const f=fixture();try {
    const updates:any[]=[];f.jobs.onUpdate(update=>updates.push(update));insertLegacy(f,"after-startup","accepted",1);
    assert.throws(()=>f.jobs.claim("agent-1",["systemd.restart"]),/privileged_executor_required/);
    assert.equal(f.jobs.get("after-startup").state,"unknown");assert.equal(updates[0].code,"legacy_agent_write_removed");
    assert.equal(f.jobs.claim("agent-1",["health.systemd"]),null);
  } finally {f.db.close();}
});


test("ordinary control HTTP cannot renew, finish or cancel an old write lease",async t=>{
  const f=fixture();insertLegacy(f,"legacy-http","activating",1);
  const server=createServer((req,res)=>{void f.deps.router.handle(req,res);});server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>{server.closeAllConnections();server.close();f.db.close();});
  const base=`http://127.0.0.1:${(server.address() as any).port}/api/v1/agents/agent-1/jobs`;
  for(const endpoint of ["events","result","cancel"]) {
    const response=await fetch(base+"/legacy-http/"+endpoint,{method:"POST",headers:{authorization:"Bearer ordinary-control","content-type":"application/json"},body:JSON.stringify({lease_id:"old-lease",sequence:1,phase:"verifying",state:"succeeded",snapshot:{health:{healthy:true}}})});
    assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:"privileged_executor_required"});
    assert.equal(f.jobs.get("legacy-http").state,"activating","a refused old lease must not report success or release its fence");
  }
  const claim=await fetch(base+"/claim",{method:"POST",headers:{authorization:"Bearer ordinary-control","content-type":"application/json"},body:JSON.stringify({capabilities:["systemd.restart"]})});
  assert.equal(claim.status,409);assert.deepEqual(await claim.json(),{error:"privileged_executor_required"});
  assert.equal(f.jobs.get("legacy-http").state,"unknown");
});
