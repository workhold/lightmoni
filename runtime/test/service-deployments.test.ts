import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { id } from "../src/shared/crypto.js";
import { canTransitionDeployment, registerServiceDeployments } from "../src/server/service-deployments.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import type { Dependencies } from "../src/shared/types.js";

test("service metadata and readonly preflight remain available while unported execution is blocked", async (t) => {
  const db = new DB(":memory:"), router = new Router(), user = { id: "admin", name: "Admin", role: "admin" };
  let clock = new Date("2026-10-21T00:00:00.000Z");
  db.exec("CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT NOT NULL,address TEXT NOT NULL,port INTEGER NOT NULL,username TEXT NOT NULL,agent_id TEXT NOT NULL DEFAULT '')");
  const machineID = "machine-1";
  db.run("INSERT INTO managed_machines(id,name,address,port,username,agent_id) VALUES(?,?,?,?,?,?)", machineID, "app-1", "10.0.0.9", 22, "deploy", "agent-1");
  const deps = {
    db,
    router,
    auth: { requireAdmin: () => {}, user: () => user, validateKey: () => { throw Error("unused"); }, master: Buffer.alloc(32) },
    now: () => new Date(clock),
    externalURL: "http://127.0.0.1:8080",
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
    logger: { info() {}, warn() {}, error() {} },
    cat: { list: async () => [] }, query: async () => ({ request_id: "", results: [] }), referencedTables: async () => [],
    ch: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
    reader: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const jobs = registerAgentJobs(deps, { agentCredentials: { has: () => true } as any });
  registerServiceDeployments(deps, { jobs });
  const server = createServer((req, res) => void router.handle(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = async (path: string, method = "GET", body?: any) => {
    const response = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    return { status: response.status, data };
  };
  const completePreflight = async (serviceIDValue: string, targetIDValue: string, currentVersion: string) => {
    const queued = await request(`/api/v1/services/${serviceIDValue}/targets/${targetIDValue}/preflight`, "POST", { confirm: true });
    assert.equal(queued.status, 202);
    const job = jobs.claim("agent-1", ["systemd.probe"]);
    assert.ok(job);
    jobs.event("agent-1", job!.id, { lease_id: job!.lease_id, sequence: 1, phase: "accepted", summary: "accepted" });
    jobs.event("agent-1", job!.id, { lease_id: job!.lease_id, sequence: 2, phase: "preflighting", summary: "preflight" });
    const action = job!.actions[0];
    jobs.result("agent-1", job!.id, { lease_id: job!.lease_id, state: "succeeded", summary: "preflight complete", snapshot: { health: { healthy: true }, preflight: { provider: "systemd", ready: true, systemd_available: true, unit_exists: true, active_state: "active", enabled: true, unit_file_state: "enabled", filesystem_check_supported: true, release_directory_exists: true, release_directory_writable: true, entrypoint_matches: true, current_pointer_valid: true, current_version: currentVersion, observed_at: clock.toISOString(), preflight_id: action.preflightID, target_revision: action.targetRevision } } });
    return job!;
  };
  t.after(() => { server.close(); db.close(); });
  const created = await request("/api/v1/services", "POST", { name: "checkout", description: "Checkout API" });
  assert.equal(created.status, 201);
  const serviceID = created.data.id;
  const target = await request(`/api/v1/services/${serviceID}/targets`, "POST", { machine_id: machineID, adapter: "systemd", config: { unit: "checkout.service", release_directory: "/opt/lightmoni/services/checkout" } });
  assert.equal(target.status, 201);
  const badTarget = await request(`/api/v1/services/${serviceID}/targets`, "POST", { machine_id: machineID, adapter: "systemd", config: { unit: "checkout.service; id", release_directory: "/opt/checkout" } });
  assert.equal(badTarget.status, 400);
  const unsupportedTarget = await request(`/api/v1/services/${serviceID}/targets`, "POST", { machine_id: "machine-1", adapter: "docker_compose", config: {} });
  assert.equal(unsupportedTarget.status, 400);
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL,platform TEXT NOT NULL DEFAULT 'linux',arch TEXT NOT NULL DEFAULT 'amd64')");
  db.run("INSERT INTO agents(id,last_seen,platform,arch) VALUES(?,?,?,?)", "agent-1", "2026-10-20T23:59:00Z", "linux", "amd64");
  const preflightQueued = await request(`/api/v1/services/${serviceID}/targets/${target.data.id}/preflight`, "POST", { confirm: true });
  assert.equal(preflightQueued.status, 202);
  const probeJob = jobs.claim("agent-1", ["systemd.probe"]);
  assert.ok(probeJob);
  assert.equal(probeJob!.actions[0].kind, "systemd_probe");
  assert.equal(probeJob!.actions[0].unit, "checkout.service");
  assert.equal(probeJob!.actions[0].releaseDirectory, "/opt/lightmoni/services/checkout");
  assert.match(probeJob!.actions[0].preflightID, /^[a-f0-9]{32}$/);
  assert.match(probeJob!.actions[0].targetRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(probeJob!.capabilities, ["systemd.probe"]);
  const preflightSnapshot = {
    health: { healthy: true },
    preflight: { provider: "systemd", ready: true, systemd_available: true, unit_exists: true, active_state: "active", enabled: true, unit_file_state: "enabled", filesystem_check_supported: true, release_directory_exists: true, release_directory_writable: true, entrypoint_matches: true, current_pointer_valid: true, current_version: "v1", observed_at: "2026-10-21T00:00:00.000Z", preflight_id: probeJob!.actions[0].preflightID, target_revision: probeJob!.actions[0].targetRevision, ignored_output: "secret" },
  };
  jobs.event("agent-1", probeJob!.id, { lease_id: probeJob!.lease_id, sequence: 1, phase: "accepted", summary: "accepted" });
  jobs.event("agent-1", probeJob!.id, { lease_id: probeJob!.lease_id, sequence: 2, phase: "preflighting", summary: "preflight" });
  jobs.event("agent-1", probeJob!.id, { lease_id: probeJob!.lease_id, sequence: 3, phase: "succeeded", summary: "preflight complete" });
  jobs.result("agent-1", probeJob!.id, { lease_id: probeJob!.lease_id, state: "succeeded", summary: "preflight complete", snapshot: preflightSnapshot });
  const storedProbeJob = jobs.get(probeJob!.id);
  assert.equal(JSON.stringify(storedProbeJob).includes("ignored_output"), false);
  assert.equal(JSON.stringify(storedProbeJob).includes("secret"), false);
  const preflightView = await request(`/api/v1/services/${serviceID}/targets/${target.data.id}/preflight`);
  assert.equal(preflightView.status, 200);
  assert.equal(preflightView.data.ready, true);
  assert.equal(preflightView.data.current, true);
  assert.equal(JSON.stringify(preflightView.data).includes("ignored_output"), false);
  const previousRelease = await request(`/api/v1/services/${serviceID}/releases`, "POST", { version: "v1", source_type: "artifact", source_ref: "git:0123456789abcdef" });
  assert.equal(previousRelease.status, 201);
  db.run("UPDATE releases SET status='ready',artifact_digest=?,artifact_size=1,artifact_format='lightmoni-release-v1.tar.gz',manifest_json=? WHERE id=?", "b".repeat(64), JSON.stringify({ schema_version: 1, service_id: serviceID, version: "v1", architecture: "any", entrypoint: "run" }), previousRelease.data.id);
  const release = await request(`/api/v1/services/${serviceID}/releases`, "POST", { version: "2026.10.21", source_type: "artifact", source_ref: "sha256:abc", artifact_digest: "sha256:abc" });
  assert.equal(release.status, 201);
  db.run("UPDATE releases SET status='ready',artifact_digest=?,artifact_size=1,artifact_format='lightmoni-release-v1.tar.gz',manifest_json=? WHERE id=?", "a".repeat(64), JSON.stringify({ schema_version: 1, service_id: serviceID, version: "2026.10.21", architecture: "any", entrypoint: "run" }), release.data.id);
  const plan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  assert.equal(plan.status, 201);
  assert.equal(plan.data.status, "awaiting_approval");
  assert.equal(plan.data.plan.adapter, "systemd");
  assert.equal(plan.data.plan.preflight.ready, true);
  assert.equal(plan.data.plan.provider_plan_status, "blocked");
  assert.equal(plan.data.plan.provider_plan_reason, "privileged_profile_not_implemented");
  assert.deepEqual(plan.data.plan.actions, []);
  assert.deepEqual(plan.data.plan.capabilities, []);
  assert.equal(plan.data.plan.rollback.available, false);
  assert.equal(plan.data.plan.rollback.reason, "privileged_profile_not_implemented");
  assert.equal(plan.data.plan.rollback.previous_version, "v1");
  const jobCount=db.get<any>("SELECT count(*) n FROM agent_jobs")!.n;
  const before=db.get<any>("SELECT * FROM deployments WHERE id=?",plan.data.id);
  for (const action of ["approve","rollback"]) {
    const result=await request(`/api/v1/deployments/${plan.data.id}/${action}`,"POST",{confirm:true,expected_state:"awaiting_approval"});
    assert.equal(result.status,409);assert.equal(result.data.error,"privileged_profile_not_implemented");
    assert.deepEqual(db.get<any>("SELECT * FROM deployments WHERE id=?",plan.data.id),before,"unported execution cannot change desired state or approval metadata");
    assert.equal(db.get<any>("SELECT count(*) n FROM agent_jobs")!.n,jobCount);
    const absent=await request(`/api/v1/deployments/does-not-exist/${action}`,"POST",{});
    assert.equal(absent.status,409,"profile gate precedes legacy record lookup");
  }
  const removedDownload=await request("/api/v1/agents/agent-1/jobs/legacy-job/artifacts/private-release");
  assert.equal(removedDownload.status,410);assert.equal(removedDownload.data.error,"legacy_agent_payload_removed");

  // Simulate old rows present before the process upgrade. The queue is
  // registered before the business module, so its terminal quarantine must
  // be replayed to the later subscriber without duplicating audit events.
  const original=db.get<any>("SELECT * FROM deployments WHERE id=?",plan.data.id)!;
  const legacyIDs:string[]=[];
  for(const state of ["queued","activating"]) {
    const record={...original,id:id(),operation_id:id(),status:state==="queued"?"agent_ready":"activating",phase:state==="queued"?"agent_ready":"activating"};legacyIDs.push(record.id);
    const columns=Object.keys(record);db.run(`INSERT INTO deployments(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,...Object.values(record));
    const at=clock.toISOString();
    db.run("INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,capabilities_json,actions_json,issued_at,expires_at,created_at,updated_at,attempts,lease_id,lease_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "old-"+record.id,"agent-1",record.id,record.operation_id,state,JSON.stringify(["systemd.restart"]),JSON.stringify([{kind:"systemd",operation:"restart",unit:"checkout.service"}]),at,"2099-01-01T00:00:00Z",at,at,state==="queued"?0:1,"old-lease","2099-01-01T00:00:00Z");
  }
  const restartedDeps={...deps,router:new Router()};
  const restartedJobs=registerAgentJobs(restartedDeps,{agentCredentials:{has:()=>true} as any});
  registerServiceDeployments(restartedDeps,{jobs:restartedJobs});
  for(const [i,depID] of legacyIDs.entries()) {
    const record=db.get<any>("SELECT * FROM deployments WHERE id=?",depID)!;
    assert.equal(record.phase,i===0?"cancelled":"unknown");assert.equal(record.error_code,"legacy_agent_write_removed");
    assert.equal(record.status,i===0?"cancelled":"activating");assert.equal(JSON.parse(record.receipt_json).state,record.phase);
    assert.equal(restartedJobs.cancel("old-"+depID,"admin").state,record.phase);
    assert.throws(()=>restartedJobs.result("agent-1","old-"+depID,{lease_id:"old-lease",state:"succeeded"}),/privileged_executor_required/);
  }
  const eventsBefore=db.get<any>("SELECT count(*) n FROM deployment_events")!.n;
  registerServiceDeployments({...deps,router:new Router()},{jobs:restartedJobs});
  assert.equal(db.get<any>("SELECT count(*) n FROM deployment_events")!.n,eventsBefore,"startup replay is idempotent for business audit history");
  restartedJobs.close();
  const serviceDetail=await request(`/api/v1/services/${serviceID}`);assert.equal(serviceDetail.status,200);
  assert.equal((await request(`/api/v1/services/${serviceID}/targets/${target.data.id}/preflight`)).data.ready,true);
});

test("deployment state graph rejects skips and migrates legacy metadata", () => {
  assert.equal(canTransitionDeployment("awaiting_approval", "agent_ready"), true);
  assert.equal(canTransitionDeployment("awaiting_approval", "succeeded"), false);
  assert.equal(canTransitionDeployment("succeeded", "rollback_pending"), true);
  assert.equal(canTransitionDeployment("rolled_back", "succeeded"), false);

  const db = new DB(":memory:");
  db.exec(`
    CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT NOT NULL,address TEXT NOT NULL,port INTEGER NOT NULL,username TEXT NOT NULL,agent_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE services(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',repository_url TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,created_by TEXT NOT NULL);
    CREATE TABLE service_targets(id TEXT PRIMARY KEY,service_id TEXT NOT NULL,machine_id TEXT NOT NULL,adapter TEXT NOT NULL,config_json TEXT NOT NULL DEFAULT '{}',desired_release_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'unknown',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE releases(id TEXT PRIMARY KEY,service_id TEXT NOT NULL,version TEXT NOT NULL,source_type TEXT NOT NULL,source_ref TEXT NOT NULL,artifact_digest TEXT NOT NULL DEFAULT '',manifest_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'ready',created_at TEXT NOT NULL,created_by TEXT NOT NULL);
    CREATE TABLE deployments(id TEXT PRIMARY KEY,service_id TEXT NOT NULL,target_id TEXT NOT NULL,release_id TEXT NOT NULL,adapter TEXT NOT NULL,status TEXT NOT NULL,plan_json TEXT NOT NULL DEFAULT '{}',receipt_json TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,created_by TEXT NOT NULL,approved_at TEXT NOT NULL DEFAULT '',started_at TEXT NOT NULL DEFAULT '',finished_at TEXT NOT NULL DEFAULT '');
    INSERT INTO deployments(id,service_id,target_id,release_id,adapter,status,created_at,created_by) VALUES('dep','svc','target','rel','systemd','succeeded','2026-10-21T00:00:00Z','admin');
  `);
  const router = new Router(), deps = {
    db, router,
    auth: { requireAdmin: () => {}, user: () => ({ id: "admin", name: "Admin", role: "admin" }), validateKey: () => { throw Error("unused"); }, master: Buffer.alloc(32) },
    now: () => new Date("2026-10-21T00:00:00Z"), externalURL: "http://127.0.0.1:8080",
    encrypt: (value: string) => value, decrypt: (value: string) => value,
    logger: { info() {}, warn() {}, error() {} },
    cat: { list: async () => [] }, query: async () => ({ request_id: "", results: [] }), referencedTables: async () => [],
    ch: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
    reader: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
  } as unknown as Dependencies;
  registerServiceDeployments(deps);
  const columns = new Set(db.all<{ name: string }>("PRAGMA table_info(deployments)").map((column) => column.name));
  assert.equal(columns.has("operation_id"), true);
  assert.equal(columns.has("previous_json"), true);
  assert.equal(columns.has("target_snapshot_json"), true);
  assert.equal(columns.has("approved_by"), true);
  assert.equal(db.get<{ phase: string }>("SELECT phase FROM deployments WHERE id='dep'")?.phase, "succeeded");
  db.close();
});
