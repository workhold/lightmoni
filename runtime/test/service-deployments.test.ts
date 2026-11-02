import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { id } from "../src/shared/crypto.js";
import { canTransitionDeployment, registerServiceDeployments } from "../src/server/service-deployments.js";
import { registerAgentJobs } from "./helpers/domain-jobs.js";
import type { Dependencies } from "../src/shared/types.js";

test("service inventory creates an approval-ready deployment plan", async (t) => {
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
  const server = createServer((req, res) => void router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}}));
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
  assert.equal(plan.data.plan.provider_plan_status, "ready");
  assert.equal(plan.data.plan.provider_plan_reason, "");
  assert.equal(plan.data.plan.rollback.available, true);
  assert.equal(plan.data.plan.rollback.previous_version, "v1");
  assert.equal(plan.data.plan.rollback.previous_release_id, previousRelease.data.id);

  const firstService = await request("/api/v1/services", "POST", { name: "first-deploy", description: "First deployment has no previous release" });
  const firstTarget = await request(`/api/v1/services/${firstService.data.id}/targets`, "POST", { machine_id: machineID, adapter: "systemd", config: { unit: "first-deploy.service", release_directory: "/opt/lightmoni/services/first-deploy" } });
  await completePreflight(firstService.data.id, firstTarget.data.id, "");
  const firstRelease = await request(`/api/v1/services/${firstService.data.id}/releases`, "POST", { version: "v1", source_type: "artifact", source_ref: "git:first-deploy" });
  db.run("UPDATE releases SET status='ready',artifact_digest=?,artifact_size=1,artifact_format='lightmoni-release-v1.tar.gz',manifest_json=? WHERE id=?", "c".repeat(64), JSON.stringify({ schema_version: 1, service_id: firstService.data.id, version: "v1", architecture: "any", entrypoint: "run" }), firstRelease.data.id);
  const firstPlan = await request(`/api/v1/services/${firstService.data.id}/deployments/plan`, "POST", { target_id: firstTarget.data.id, release_id: firstRelease.data.id });
  assert.equal(firstPlan.data.plan.rollback.available, false);
  db.run("UPDATE deployments SET status='succeeded',phase='succeeded' WHERE id=?", firstPlan.data.id);
  const firstRollback = await request(`/api/v1/deployments/${firstPlan.data.id}/rollback`, "POST", { confirm: true, expected_state: "succeeded" });
  assert.equal(firstRollback.status, 409);
  assert.equal(firstRollback.data.error, "rollback_unavailable_no_previous_release");
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_jobs WHERE deployment_id=?", firstPlan.data.id)?.count, 0);

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
  db.run("UPDATE deployments SET plan_json=? WHERE id=?", JSON.stringify({ ...plan.data.plan, actions: [], capabilities: [] }), plan.data.id);
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
  const rollbackWithoutFreshProbe = await request(`/api/v1/deployments/${plan.data.id}/rollback`, "POST", { confirm: true, reason: "人工检查", expected_state: "succeeded" });
  assert.equal(rollbackWithoutFreshProbe.status, 409);
  assert.equal(rollbackWithoutFreshProbe.data.error, "rollback_preflight_required");
  await completePreflight(serviceID, target.data.id, "external-v9");
  const changedCurrentRollback = await request(`/api/v1/deployments/${plan.data.id}/rollback`, "POST", { confirm: true, reason: "人工检查", expected_state: "succeeded" });
  assert.equal(changedCurrentRollback.status, 409);
  assert.equal(changedCurrentRollback.data.error, "rollback_target_changed");
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_jobs WHERE deployment_id=?", plan.data.id)?.count, 1, "a changed current version must not enqueue a rollback job");
  await completePreflight(serviceID, target.data.id, "2026.10.21");
  const rollback = await request(`/api/v1/deployments/${plan.data.id}/rollback`, "POST", { confirm: true, reason: "人工检查", expected_state: "succeeded" });
  assert.equal(rollback.status, 202);
  assert.equal(rollback.data.status, "rollback_pending");
  assert.equal(rollback.data.operation_kind, "rollback");
  assert.equal(rollback.data.job_state, "queued");
  const repeatedRollback = await request(`/api/v1/deployments/${plan.data.id}/rollback`, "POST", { confirm: true });
  assert.equal(repeatedRollback.status, 200);
  assert.equal(repeatedRollback.data.operation_id, rollback.data.operation_id);
  const rollbackJob = jobs.claim("agent-1", ["artifact.activate_release", "systemd.restart", "health.systemd"]);
  assert.ok(rollbackJob);
  assert.deepEqual(rollbackJob!.actions, [
    { kind: "activate_release", releaseDirectory: "/opt/lightmoni/services/checkout", version: "v1", expectedCurrentVersion: "2026.10.21" },
    { kind: "systemd", operation: "restart", unit: "checkout.service" },
    { kind: "health_check", check: { kind: "systemd-active", unit: "checkout.service" } },
  ]);
  jobs.event("agent-1", rollbackJob!.id, { lease_id: rollbackJob!.lease_id, sequence: 1, phase: "accepted", summary: "accepted" });
  jobs.event("agent-1", rollbackJob!.id, { lease_id: rollbackJob!.lease_id, sequence: 2, phase: "activating", summary: "restoring previous release" });
  jobs.event("agent-1", rollbackJob!.id, { lease_id: rollbackJob!.lease_id, sequence: 3, phase: "verifying", summary: "checking restored release" });
  jobs.result("agent-1", rollbackJob!.id, { lease_id: rollbackJob!.lease_id, state: "succeeded", summary: "rollback complete", snapshot: { current_version: "v1", health: { healthy: true } } });
  const rolledBack = await request(`/api/v1/deployments/${plan.data.id}`);
  assert.equal(rolledBack.data.status, "rolled_back");
  assert.equal(rolledBack.data.receipt.state, "rolled_back");
  const idempotentRolledBack = await request(`/api/v1/deployments/${plan.data.id}/rollback`, "POST", { confirm: true, expected_state: "rolled_back" });
  assert.equal(idempotentRolledBack.status, 200);
  assert.equal(idempotentRolledBack.data.operation_id, rollback.data.operation_id);

  await completePreflight(serviceID, target.data.id, "v1");
  const invalidReceiptPlan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  assert.equal(invalidReceiptPlan.data.plan.rollback.previous_version, "v1");
  db.run("UPDATE deployments SET status='succeeded',phase='succeeded' WHERE id=?", invalidReceiptPlan.data.id);
  await completePreflight(serviceID, target.data.id, "2026.10.21");
  const invalidReceiptRollback = await request(`/api/v1/deployments/${invalidReceiptPlan.data.id}/rollback`, "POST", { confirm: true, expected_state: "succeeded" });
  assert.equal(invalidReceiptRollback.status, 202);
  const invalidReceiptJob = jobs.claim("agent-1", ["artifact.activate_release", "systemd.restart", "health.systemd"]);
  assert.ok(invalidReceiptJob);
  jobs.event("agent-1", invalidReceiptJob!.id, { lease_id: invalidReceiptJob!.lease_id, sequence: 1, phase: "accepted", summary: "accepted" });
  jobs.event("agent-1", invalidReceiptJob!.id, { lease_id: invalidReceiptJob!.lease_id, sequence: 2, phase: "activating", summary: "restoring previous release" });
  jobs.event("agent-1", invalidReceiptJob!.id, { lease_id: invalidReceiptJob!.lease_id, sequence: 3, phase: "verifying", summary: "checking restored release" });
  jobs.result("agent-1", invalidReceiptJob!.id, { lease_id: invalidReceiptJob!.lease_id, state: "succeeded", summary: "rollback complete", snapshot: { current_version: "unexpected-v9", health: { healthy: true } } });
  const invalidReceiptDetail = await request(`/api/v1/deployments/${invalidReceiptPlan.data.id}`);
  assert.equal(invalidReceiptDetail.data.status, "failed");
  assert.equal(invalidReceiptDetail.data.receipt.state, "unknown");
  assert.notEqual(invalidReceiptDetail.data.status, "rolled_back");
  const retryWithoutNewPreflight = await request(`/api/v1/deployments/${invalidReceiptPlan.data.id}/rollback`, "POST", { confirm: true, expected_state: "failed" });
  assert.equal(retryWithoutNewPreflight.status, 409);
  assert.equal(retryWithoutNewPreflight.data.error, "rollback_preflight_required");
  clock = new Date(clock.getTime() + 1000);
  await completePreflight(serviceID, target.data.id, "2026.10.21");
  const explicitlyRetriedRollback = await request(`/api/v1/deployments/${invalidReceiptPlan.data.id}/rollback`, "POST", { confirm: true, expected_state: "failed", reason: "管理员检查主机并重新预检后确认重试" });
  assert.equal(explicitlyRetriedRollback.status, 202);
  assert.notEqual(explicitlyRetriedRollback.data.operation_id, invalidReceiptRollback.data.operation_id);
  jobs.cancel(explicitlyRetriedRollback.data.job_id, "test cleanup");

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
  assert.equal(detail.data.releases.length, 2);
  assert.equal(detail.data.deployments.length, 3);
  assert.equal(detail.data.deployments.find((item: any) => item.id === plan.data.id).status, "rolled_back");

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
  const staleTargetPlan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  await request(`/api/v1/services/${serviceID}/targets/${target.data.id}`, "PATCH", { config: { ...target.data.config, release_directory: "/opt/lightmoni/services/checkout-v2" } });
  db.run("UPDATE agents SET last_seen=? WHERE id=?", "2026-10-20T23:59:00Z", "agent-1");
  const staleTargetApproval = await request(`/api/v1/deployments/${staleTargetPlan.data.id}/approve`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(staleTargetApproval.status, 409);
  assert.equal(staleTargetApproval.data.error, "deployment_target_changed");
  const oldTargetConfig = target.data.config;
  const changedTarget = await request(`/api/v1/services/${serviceID}/targets/${target.data.id}`, "PATCH", { config: { ...oldTargetConfig, release_directory: "/opt/lightmoni/services/checkout-v2" } });
  assert.equal(changedTarget.status, 200);
  const stalePreflight = await request(`/api/v1/services/${serviceID}/targets/${target.data.id}/preflight`);
  assert.equal(stalePreflight.data.current, false);
  const targetDetail = await request(`/api/v1/services/${serviceID}`);
  assert.equal(targetDetail.data.targets[0].preflight.current, false);
  assert.notEqual(id(), "");
});

test("deployment state graph rejects invalid phase transitions", () => {
  assert.equal(canTransitionDeployment("awaiting_approval", "agent_ready"), true);
  assert.equal(canTransitionDeployment("awaiting_approval", "succeeded"), false);
  assert.equal(canTransitionDeployment("succeeded", "rollback_pending"), true);
  assert.equal(canTransitionDeployment("rolled_back", "succeeded"), false);

});
