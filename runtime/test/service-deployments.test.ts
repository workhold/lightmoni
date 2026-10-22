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

test("service inventory creates an approval-ready deployment plan", async (t) => {
  const db = new DB(":memory:"), router = new Router(), user = { id: "admin", name: "Admin", role: "admin" };
  db.exec("CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT NOT NULL,address TEXT NOT NULL,port INTEGER NOT NULL,username TEXT NOT NULL,agent_id TEXT NOT NULL DEFAULT '')");
  const machineID = "machine-1";
  db.run("INSERT INTO managed_machines(id,name,address,port,username,agent_id) VALUES(?,?,?,?,?,?)", machineID, "app-1", "10.0.0.9", 22, "deploy", "agent-1");
  const deps = {
    db,
    router,
    auth: { requireAdmin: () => {}, user: () => user, validateKey: () => { throw Error("unused"); }, master: Buffer.alloc(32) },
    now: () => new Date("2026-10-21T00:00:00Z"),
    externalURL: "http://127.0.0.1:8080",
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
    logger: { info() {}, warn() {}, error() {} },
    cat: { list: async () => [] }, query: async () => ({ request_id: "", results: [] }), referencedTables: async () => [],
    ch: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
    reader: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const jobs = registerAgentJobs(deps);
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
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL)");
  db.run("INSERT INTO agents(id,last_seen) VALUES(?,?)", "agent-1", "2026-10-20T23:59:00Z");
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
    preflight: { provider: "systemd", ready: true, systemd_available: true, unit_exists: true, active_state: "active", enabled: true, unit_file_state: "enabled", filesystem_check_supported: true, release_directory_exists: true, release_directory_writable: true, current_version: "v1", observed_at: "2026-10-21T00:00:00.000Z", preflight_id: probeJob!.actions[0].preflightID, target_revision: probeJob!.actions[0].targetRevision, ignored_output: "secret" },
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
  const release = await request(`/api/v1/services/${serviceID}/releases`, "POST", { version: "2026.10.21", source_type: "artifact", source_ref: "sha256:abc", artifact_digest: "sha256:abc" });
  assert.equal(release.status, 201);
  const plan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  assert.equal(plan.status, 201);
  assert.equal(plan.data.status, "awaiting_approval");
  assert.equal(plan.data.plan.adapter, "systemd");
  assert.equal(plan.data.plan.preflight.ready, true);
  assert.equal(plan.data.plan.provider_plan_reason, "artifact_transport_required");
  await request(`/api/v1/services/${serviceID}/targets/${target.data.id}`, "PATCH", { status: "disabled" });
  assert.equal((await request(`/api/v1/services/${serviceID}/targets/${target.data.id}/preflight`)).data.current, false);
  await request(`/api/v1/services/${serviceID}/targets/${target.data.id}`, "PATCH", { status: "unknown" });
  assert.equal((await request(`/api/v1/services/${serviceID}/targets/${target.data.id}/preflight`)).data.current, true);
  // Once the agents table exists, approval requires a recent heartbeat rather
  // than trusting a stale machine binding.
  db.run("UPDATE agents SET last_seen=? WHERE id=?", "2026-10-20T23:00:00Z", "agent-1");
  const notReady = await request(`/api/v1/deployments/${plan.data.id}/approve`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.data.error, "agent_not_ready");
  db.run("UPDATE agents SET last_seen=? WHERE id=?", "2026-10-20T23:59:00Z", "agent-1");
  const emptyApproval = await request("/api/v1/deployments/" + plan.data.id + "/approve", "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(emptyApproval.status, 409);
  assert.equal(emptyApproval.data.error, "deployment_plan_not_executable");
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_jobs WHERE deployment_id=?", plan.data.id)?.count, 0);
  db.run("UPDATE deployments SET plan_json=? WHERE id=?", JSON.stringify({ ...plan.data.plan, actions: [{ kind: "systemd", operation: "restart", unit: "checkout.service" }], capabilities: ["systemd.restart"] }), plan.data.id);
  const noHealthApproval = await request(`/api/v1/deployments/${plan.data.id}/approve`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(noHealthApproval.status, 409);
  assert.equal(noHealthApproval.data.error, "deployment_plan_not_executable");
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_jobs WHERE deployment_id=?", plan.data.id)?.count, 0);
  // Exercise receipt-driven state using a reviewed typed action plan. Trusted
  // artifact upload and delivery are still required for production.
  const executablePlan = {
    ...plan.data.plan,
    actions: [
      { kind: "systemd", operation: "restart", unit: "checkout.service" },
      { kind: "health_check", check: { kind: "systemd-active", unit: "checkout.service" } },
    ],
    capabilities: ["systemd.restart", "health.systemd"],
  };
  db.run("UPDATE deployments SET plan_json=? WHERE id=?", JSON.stringify(executablePlan), plan.data.id);
  const approval = await request(`/api/v1/deployments/${plan.data.id}/approve`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(approval.status, 200);
  assert.equal(approval.data.status, "agent_ready");
  assert.match(approval.data.operation_id, /^[a-f0-9]{32}$/);
  const leased = jobs.claim("agent-1", ["systemd.restart", "health.systemd"]);
  assert.ok(leased);
  let sequence = 0;
  for (const phase of ["accepted", "staging", "activating", "verifying"] as const) {
    jobs.event("agent-1", leased!.id, {
      lease_id: leased!.lease_id, sequence: ++sequence, phase, summary: "untrusted agent detail",
    });
  }
  jobs.result("agent-1", leased!.id, {
    lease_id: leased!.lease_id, state: "succeeded", code: "",
    summary: "secret=must-not-appear", snapshot: { private_key: "must-not-appear", health: { healthy: true } },
    started_at: "2026-10-21T00:00:00.000Z", finished_at: "2026-10-21T00:00:01.000Z",
  });
  const completed = await request("/api/v1/deployments/" + plan.data.id);
  assert.equal(completed.data.status, "succeeded");
  assert.equal(JSON.stringify(completed.data).includes("must-not-appear"), false);
  const events = await request(`/api/v1/deployments/${plan.data.id}/events`);
  assert.equal(events.status, 200);
  assert.deepEqual(events.data.map((event: any) => event.state), ["awaiting_approval", "agent_ready", "agent_ready", "staging", "activating", "verifying", "succeeded"]);
  assert.equal(JSON.stringify(events.data).includes("untrusted agent detail"), false);
  const rollback = await request(`/api/v1/deployments/${plan.data.id}/rollback`, "POST", { confirm: true, reason: "人工检查" });
  assert.equal(rollback.status, 200);
  assert.equal(rollback.data.status, "rollback_pending");
  const repeatedRollback = await request(`/api/v1/deployments/${plan.data.id}/rollback`, "POST", { confirm: true });
  assert.equal(repeatedRollback.status, 200);
  assert.equal(repeatedRollback.data.operation_id, rollback.data.operation_id);
  const uncertainPlan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  assert.equal(uncertainPlan.status, 201);
  const uncertainExecutablePlan = {
    ...uncertainPlan.data.plan,
    actions: [
      { kind: "systemd", operation: "restart", unit: "checkout.service" },
      { kind: "health_check", check: { kind: "systemd-active", unit: "checkout.service" } },
    ],
    capabilities: ["systemd.restart", "health.systemd"],
  };
  db.run("UPDATE deployments SET plan_json=? WHERE id=?", JSON.stringify(uncertainExecutablePlan), uncertainPlan.data.id);
  const uncertainApproval = await request(`/api/v1/deployments/${uncertainPlan.data.id}/approve`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(uncertainApproval.status, 200);
  const uncertainJob = jobs.claim("agent-1", ["systemd.restart", "health.systemd"]);
  assert.ok(uncertainJob);
  jobs.result("agent-1", uncertainJob!.id, {
    lease_id: uncertainJob!.lease_id, state: "unknown", code: "unknown_execution_result",
    summary: "private output must not reach deployment history", snapshot: { authorization: "secret" },
  });
  const uncertainDetail = await request(`/api/v1/deployments/${uncertainPlan.data.id}`);
  assert.equal(uncertainDetail.data.status, "agent_ready");
  assert.equal(uncertainDetail.data.receipt.state, "unknown");
  assert.equal(JSON.stringify(uncertainDetail.data).includes("secret"), false);
  const detail = await request(`/api/v1/services/${serviceID}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.targets.length, 1);
  assert.equal(detail.data.releases.length, 1);
  assert.equal(detail.data.deployments.length, 2);
  assert.equal(detail.data.deployments.find((item: any) => item.id === plan.data.id).status, "rollback_pending");

  const queuedCancelPlan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  const cancelActions = [
    { kind: "systemd", operation: "restart", unit: "checkout.service" },
    { kind: "health_check", check: { kind: "systemd-active", unit: "checkout.service" } },
  ];
  db.run("UPDATE deployments SET plan_json=? WHERE id=?", JSON.stringify({ ...queuedCancelPlan.data.plan, actions: cancelActions, capabilities: ["systemd.restart", "health.systemd"] }), queuedCancelPlan.data.id);
  const queuedCancelApproval = await request(`/api/v1/deployments/${queuedCancelPlan.data.id}/approve`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(queuedCancelApproval.status, 200);
  const queuedJob = db.get<any>("SELECT id FROM agent_jobs WHERE deployment_id=?", queuedCancelPlan.data.id);
  assert.ok(queuedJob);
  const queuedCancel = await request(`/api/v1/deployments/${queuedCancelPlan.data.id}/cancel`, "POST", { confirm: true, expected_state: "agent_ready" });
  assert.equal(queuedCancel.status, 200);
  assert.equal(jobs.get(queuedJob!.id).state, "cancelled");
  const safelyCancelled = await request(`/api/v1/deployments/${queuedCancelPlan.data.id}`);
  assert.equal(safelyCancelled.data.status, "cancelled");
  assert.equal(safelyCancelled.data.receipt.state, "cancelled");

  const runningCancelPlan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  db.run("UPDATE deployments SET plan_json=? WHERE id=?", JSON.stringify({ ...runningCancelPlan.data.plan, actions: cancelActions, capabilities: ["systemd.restart", "health.systemd"] }), runningCancelPlan.data.id);
  const runningCancelApproval = await request(`/api/v1/deployments/${runningCancelPlan.data.id}/approve`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(runningCancelApproval.status, 200);
  const runningJob = jobs.claim("agent-1", ["systemd.restart", "health.systemd"]);
  assert.ok(runningJob);
  jobs.event("agent-1", runningJob!.id, { lease_id: runningJob!.lease_id, sequence: 1, phase: "accepted", summary: "accepted" });
  const claimedCancel = await request(`/api/v1/deployments/${runningCancelPlan.data.id}/cancel`, "POST", { confirm: true, expected_state: "agent_ready" });
  assert.equal(claimedCancel.status, 409);
  assert.equal(claimedCancel.data.error, "deployment_job_already_claimed");
  jobs.cancel(runningJob!.id, "admin");
  const uncertainCancel = await request(`/api/v1/deployments/${runningCancelPlan.data.id}`);
  assert.equal(uncertainCancel.data.status, "agent_ready");
  assert.equal(uncertainCancel.data.receipt.state, "unknown");

  const invalidSuccessPlan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  db.run("UPDATE deployments SET plan_json=? WHERE id=?", JSON.stringify({ ...invalidSuccessPlan.data.plan, actions: cancelActions, capabilities: ["systemd.restart", "health.systemd"] }), invalidSuccessPlan.data.id);
  const invalidSuccessApproval = await request(`/api/v1/deployments/${invalidSuccessPlan.data.id}/approve`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(invalidSuccessApproval.status, 200);
  const invalidSuccessJob = jobs.claim("agent-1", ["systemd.restart", "health.systemd"]);
  assert.ok(invalidSuccessJob);
  jobs.event("agent-1", invalidSuccessJob!.id, { lease_id: invalidSuccessJob!.lease_id, sequence: 1, phase: "accepted", summary: "accepted" });
  jobs.result("agent-1", invalidSuccessJob!.id, { lease_id: invalidSuccessJob!.lease_id, state: "succeeded", summary: "invalid success", snapshot: { health: { healthy: true } } });
  const invalidSuccess = await request(`/api/v1/deployments/${invalidSuccessPlan.data.id}`);
  assert.equal(invalidSuccess.data.status, "agent_ready");
  assert.equal(invalidSuccess.data.receipt.state, "unknown");
  assert.equal(invalidSuccess.data.receipt.code, "invalid_agent_sequence");

  const unapprovedPlan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  const unapprovedCancel = await request(`/api/v1/deployments/${unapprovedPlan.data.id}/cancel`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(unapprovedCancel.status, 200);
  assert.equal(unapprovedCancel.data.status, "cancelled");
  const staleCancel = await request(`/api/v1/deployments/${unapprovedPlan.data.id}/cancel`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(staleCancel.status, 409);
  const oldTargetConfig = target.data.config;
  const changedTarget = await request(`/api/v1/services/${serviceID}/targets/${target.data.id}`, "PATCH", { config: { ...oldTargetConfig, release_directory: "/opt/lightmoni/services/checkout-v2" } });
  assert.equal(changedTarget.status, 200);
  const stalePreflight = await request(`/api/v1/services/${serviceID}/targets/${target.data.id}/preflight`);
  assert.equal(stalePreflight.data.current, false);
  const targetDetail = await request(`/api/v1/services/${serviceID}`);
  assert.equal(targetDetail.data.targets[0].preflight.current, false);
  assert.notEqual(id(), "");
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
