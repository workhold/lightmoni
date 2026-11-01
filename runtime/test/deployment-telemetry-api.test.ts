import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { registerServiceDeployments } from "../src/server/service-deployments.js";
import { DB } from "../src/shared/sqlite.js";
import { fail, Router } from "../src/shared/http.js";
import type { ClickHouse, Context, Dependencies, Table } from "../src/shared/types.js";

const FINISHED_AT = "2026-10-23T00:00:00.000Z";
const BINDING = { table: "log_orders", service: "orders-sdk", instance_id: "node-a" };
const TARGET_CONFIG = { unit: "orders.service", release_directory: "/opt/lightmoni/services/orders" };
const columns = [
  { name: "service", type: "String" },
  { name: "instance_id", type: "String" },
  { name: "service_version", type: "String" },
  { name: "event_time", type: "DateTime64(9, 'UTC')" },
  { name: "ingested_at", type: "DateTime64(9, 'UTC')" },
];
const TABLE: Table = {
  id: "orders-table", name: "log_orders", logical_name: "orders", kind: "log", system: false,
  columns, services: [BINDING.service], retention_days: null, effective_retention_days: 30,
};
const matchingResponse = () => ({
  meta: columns,
  data: [{
    service: BINDING.service, instance_id: BINDING.instance_id, service_version: "v2",
    event_time: "2026-10-23T00:00:30.000Z", ingested_at: "2026-10-23T00:00:31.000Z",
  }],
  rows: 1,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t: TestContext, configured = true) {
  const db = new DB(":memory:"), router = new Router();
  let clock = new Date(FINISHED_AT), reads = 0, catalogReads = 0;
  let readerQuery: ClickHouse["query"] = async () => matchingResponse();
  let catalogList = async (): Promise<Table[]> => [TABLE];
  db.exec("CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT NOT NULL,address TEXT NOT NULL,port INTEGER NOT NULL,username TEXT NOT NULL,agent_id TEXT NOT NULL DEFAULT '')");
  db.run("INSERT INTO managed_machines(id,name,address,port,username,agent_id) VALUES(?,?,?,?,?,?)", "machine-a", "app-a", "10.0.0.9", 22, "deploy", "agent-a");
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL,platform TEXT NOT NULL,arch TEXT NOT NULL)");
  db.run("INSERT INTO agents(id,last_seen,platform,arch) VALUES(?,?,?,?)", "agent-a", FINISHED_AT, "linux", "amd64");
  const deps = {
    db, router,
    auth: {
      requireAdmin: (ctx: Context) => { if (ctx.user.role !== "admin") fail(403, "admin only"); },
      user: (req: any) => req.headers["x-test-role"] === "anonymous" ? undefined : ({ id: "operator", name: "Operator", role: req.headers["x-test-role"] || "admin" }),
      validateKey: () => { throw Error("unused"); }, master: Buffer.alloc(32),
    },
    now: () => new Date(clock), externalURL: "http://127.0.0.1:8080",
    encrypt: (value: string) => value, decrypt: (value: string) => value,
    logger: { info() {}, warn() {}, error() {} },
    cat: { list: async () => { catalogReads++; return catalogList(); } },
    query: async () => ({ request_id: "", results: [] }), referencedTables: async () => [],
    ch: { query: async () => { throw Error("writer must not query telemetry"); }, exec: async () => {}, insert: async () => {} },
    reader: { query: async (...args: Parameters<ClickHouse["query"]>) => { reads++; return readerQuery(...args); }, exec: async () => {}, insert: async () => {} },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const jobs = registerAgentJobs(deps, { agentCredentials: { has: () => true } as any });
  const services = registerServiceDeployments(deps, { jobs });
  const server = createServer((req, res) => { void router.handle(req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(() => { server.closeAllConnections(); server.close(); db.close(); });
  const request = async (path: string, method = "GET", body?: unknown, role = "admin") => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json", "x-test-role": role },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any };
  };
  const created = await request("/api/v1/services", "POST", { name: "orders-platform" });
  assert.equal(created.status, 201);
  const serviceID = created.data.id as string;
  const config = { ...TARGET_CONFIG, ...(configured ? { telemetry: BINDING } : {}) };
  const target = await request(`/api/v1/services/${serviceID}/targets`, "POST", { machine_id: "machine-a", adapter: "systemd", config });
  assert.equal(target.status, 201);
  const targetID = target.data.id as string;
  // A real preflight and ordered Agent health receipt establish eligibility.
  const preflight = async (currentVersion: string) => {
    const queued = await request(`/api/v1/services/${serviceID}/targets/${targetID}/preflight`, "POST", { confirm: true });
    assert.equal(queued.status, 202);
    const job = jobs.claim("agent-a", ["systemd.probe"]);
    assert.ok(job);
    jobs.event("agent-a", job.id, { lease_id: job.lease_id, sequence: 1, phase: "accepted", summary: "accepted" });
    jobs.event("agent-a", job.id, { lease_id: job.lease_id, sequence: 2, phase: "preflighting", summary: "checking" });
    jobs.result("agent-a", job.id, {
      lease_id: job.lease_id, state: "succeeded", summary: "probe done",
      snapshot: { health: { healthy: true }, preflight: {
        provider: "systemd", ready: true, systemd_available: true, unit_exists: true, active_state: "active", enabled: true, unit_file_state: "enabled",
        filesystem_check_supported: true, release_directory_exists: true, release_directory_writable: true,
        entrypoint_matches: true, current_pointer_valid: true, current_version: currentVersion,
        observed_at: clock.toISOString(), preflight_id: job.actions[0].preflightID, target_revision: job.actions[0].targetRevision,
      } },
    });
  };
  for (const version of ["v1", "v2"]) {
    const release = await request(`/api/v1/services/${serviceID}/releases`, "POST", { version, source_type: "artifact", source_ref: "git:test" });
    assert.equal(release.status, 201);
    db.run("UPDATE releases SET status='ready',artifact_digest=?,artifact_size=1,artifact_format='lightmoni-release-v1.tar.gz',manifest_json=? WHERE id=?",
      (version === "v1" ? "a" : "b").repeat(64), JSON.stringify({ schema_version: 1, service_id: serviceID, version, architecture: "any", entrypoint: "run" }), release.data.id);
  }
  const releaseID = db.get<any>("SELECT id FROM releases WHERE version='v2'")!.id as string;
  const plan = async () => {
    const result = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: targetID, release_id: releaseID });
    assert.equal(result.status, 201);
    // This fixture isolates receipt/query integration from file transfer.
    db.run("UPDATE deployments SET plan_json=? WHERE id=?", JSON.stringify({
      ...result.data.plan,
      actions: [{ kind: "systemd", operation: "restart", unit: TARGET_CONFIG.unit }, { kind: "health_check", check: { kind: "systemd-active", unit: TARGET_CONFIG.unit } }],
      capabilities: ["systemd.restart", "health.systemd"],
    }), result.data.id);
    return result.data.id as string;
  };
  await preflight("v1");
  const deploymentID = await plan();
  const approved = await request(`/api/v1/deployments/${deploymentID}/approve`, "POST", { confirm: true });
  assert.equal(approved.status,409);assert.equal(approved.data.error,"privileged_profile_not_implemented");
  // Historical succeeded receipts remain queryable. Seed the pre-upgrade
  // durable evidence directly; no test reopens the removed write channel.
  const jobID="historical-job-"+deploymentID,operationID="historical-operation-"+deploymentID;
  const at=clock.toISOString();
  db.run("INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,capabilities_json,actions_json,issued_at,expires_at,created_at,updated_at,attempts,receipt_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    jobID,"agent-a",deploymentID,operationID,"succeeded",JSON.stringify(["systemd.restart","health.systemd"]),JSON.stringify([{kind:"systemd",operation:"restart",unit:TARGET_CONFIG.unit}]),at,at,at,at,1,JSON.stringify({state:"succeeded",snapshot:{health:{healthy:true}}}));
  db.run("UPDATE deployments SET status='succeeded',phase='succeeded',operation_id=?,approved_at=?,finished_at=?,receipt_json=? WHERE id=?",operationID,at,at,JSON.stringify({state:"succeeded",job_id:jobID}),deploymentID);
  const initial = await request(`/api/v1/deployments/${deploymentID}`);
  assert.equal(initial.data.status, "succeeded");
  clock = new Date("2026-10-23T00:01:00.000Z");
  const verify = (body: unknown = {}, role = "admin") => request(`/api/v1/deployments/${deploymentID}/verify-telemetry`, "POST", body, role);
  return {
    db, jobs, services, request, verify, preflight, plan, serviceID, targetID, deploymentID, releaseID, jobID,
    get reads() { return reads; }, get catalogReads() { return catalogReads; },
    setQuery(fn: ClickHouse["query"]) { readerQuery = fn; }, setCatalog(fn: typeof catalogList) { catalogList = fn; },
    setClock(iso: string) { clock = new Date(iso); },
  };
}

test("telemetry verification requires admin and a strictly empty request", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.verify({}, "member")).status, 403);
  assert.equal((await f.verify({}, "anonymous")).status, 401);
  for (const body of [{ table: BINDING.table }, { from: FINISHED_AT }, { sql: "SELECT secret" }, [], null])
    assert.equal((await f.verify(body)).status, 400);
  assert.equal(f.reads, 0);
  assert.equal((await f.request(`/api/v1/deployments/${f.deploymentID}`)).data.telemetry, null);
});

test("telemetry binding is explicit, strict and snapshotted with the deployment", async (t) => {
  const f = await fixture(t);
  const detail = await f.request(`/api/v1/deployments/${f.deploymentID}`);
  assert.deepEqual(detail.data.target_snapshot.config.telemetry, BINDING);
  for (const telemetry of [{ ...BINDING, instance_id: "" }, { table: BINDING.table, service: BINDING.service }, { ...BINDING, sql: "SELECT secret" }, { ...BINDING, table: "log_orders;DROP TABLE orders" }]) {
    const changed = await f.request(`/api/v1/services/${f.serviceID}/targets/${f.targetID}`, "PATCH", { config: { ...TARGET_CONFIG, telemetry } });
    assert.equal(changed.status, 400);
  }
  assert.equal(f.reads, 0, "configuration and status reads never query telemetry");
  const before = await f.request(`/api/v1/services/${f.serviceID}/targets/${f.targetID}/preflight`);
  assert.equal(before.data.current, true);
  const changed = await f.request(`/api/v1/services/${f.serviceID}/targets/${f.targetID}`, "PATCH", { config: { ...TARGET_CONFIG, telemetry: { ...BINDING, instance_id: "node-b" } } });
  assert.equal(changed.status, 200);
  assert.equal((await f.request(`/api/v1/services/${f.serviceID}/targets/${f.targetID}/preflight`)).data.current, false);
  assert.equal((await f.verify()).status, 409);
  assert.equal(f.reads, 0);
});

test("historical healthy deployment persists an independent bounded telemetry summary for UI and AI", async (t) => {
  const f = await fixture(t);
  const verified = await f.verify();
  assert.equal(verified.status, 200);
  assert.equal(verified.data.status, "succeeded");
  const result = verified.data.telemetry;
  assert.equal(result.state, "verified");
  assert.equal(result.serviceId, f.serviceID);
  assert.equal(result.deploymentId, f.deploymentID);
  assert.deepEqual(result.selector, BINDING);
  assert.equal(result.serviceVersion, "v2");
  assert.equal(result.observedSamples, 1);
  assert.equal(result.minSamples, 1);
  assert.equal(result.stale, false);
  assert.equal(Date.parse(result.from), Date.parse(FINISHED_AT));
  assert.equal(Date.parse(result.to), Date.parse("2026-10-23T00:05:00.000Z"));
  assert.equal(Date.parse(result.deadline), Date.parse("2026-10-23T00:06:00.000Z"));
  assert.equal(f.reads, 1);
  const detail = await f.request(`/api/v1/deployments/${f.deploymentID}`);
  assert.deepEqual(detail.data.telemetry, result);
  assert.deepEqual(f.services.assistantDeployment(f.deploymentID).telemetry, result);
  assert.equal(f.reads, 1, "GET and assistant reads must use the persisted result");
  assert.equal(JSON.stringify(detail.data).includes("untrusted host output"), false);
  assert.equal(JSON.stringify(detail.data).includes("host token must not escape"), false);
});

test("unconfigured targets do not query; waiting and timeout retain a fixed observation window", async (t) => {
  const unconfigured = await fixture(t, false);
  const missing = await unconfigured.verify();
  assert.equal(missing.status, 200);
  assert.equal(missing.data.telemetry.state, "unconfigured");
  assert.equal(missing.data.status, "succeeded");
  assert.equal(unconfigured.reads, 0);
  assert.equal(unconfigured.catalogReads, 0);
  const f = await fixture(t);
  f.setQuery(async () => ({ meta: columns, data: [], rows: 0 }));
  const waiting = await f.verify();
  assert.equal(waiting.status, 200);
  assert.equal(waiting.data.telemetry.state, "waiting");
  f.setClock("2026-10-23T00:07:00.000Z");
  const timeout = await f.verify();
  assert.equal(timeout.status, 200);
  assert.equal(timeout.data.telemetry.state, "timed_out");
  assert.equal(timeout.data.status, "succeeded");
  for (const field of ["from", "to", "deadline"])
    assert.equal(timeout.data.telemetry[field], waiting.data.telemetry[field]);
});

test("catalog and reader failures return safe unavailable summaries without changing deployment health", async (t) => {
  const f = await fixture(t);
  f.setCatalog(async () => { throw Error("secret=private-catalog-password"); });
  const catalogFailure = await f.verify();
  assert.equal(catalogFailure.status, 200);
  assert.equal(catalogFailure.data.telemetry.state, "unavailable");
  assert.equal(f.reads, 0);
  f.setCatalog(async () => [TABLE]);
  f.setQuery(async () => { throw Error("SELECT private FROM logs password=secret-reader-password"); });
  const queryFailure = await f.verify();
  assert.equal(queryFailure.status, 200);
  assert.equal(queryFailure.data.telemetry.state, "unavailable");
  assert.equal(queryFailure.data.status, "succeeded");
  assert.equal(f.reads, 1);
  assert.doesNotMatch(JSON.stringify([catalogFailure, queryFailure]), /private-catalog-password|secret-reader-password|SELECT private/);
});

test("telemetry verification rejects incomplete health receipts and rollback operations without querying", async (t) => {
  const f = await fixture(t);
  const original = f.db.get<any>("SELECT * FROM deployments WHERE id=?", f.deploymentID)!;
  f.db.run("UPDATE deployments SET status='verifying' WHERE id=?", f.deploymentID);
  assert.equal((await f.verify()).status, 409);
  f.db.run("UPDATE deployments SET status='succeeded',receipt_json=? WHERE id=?", JSON.stringify({ state: "unknown", job_id: f.jobID }), f.deploymentID);
  assert.equal((await f.verify()).status, 409);
  f.db.run("UPDATE deployments SET receipt_json=?,operation_kind='rollback' WHERE id=?", original.receipt_json, f.deploymentID);
  assert.equal((await f.verify()).status, 409);
  f.db.run("UPDATE deployments SET operation_kind='deploy' WHERE id=?", f.deploymentID);
  const jobReceipt = JSON.parse(f.db.get<any>("SELECT receipt_json FROM agent_jobs WHERE id=?", f.jobID)!.receipt_json);
  f.db.run("UPDATE agent_jobs SET receipt_json=? WHERE id=?", JSON.stringify({ ...jobReceipt, snapshot: { health: { healthy: false } } }), f.jobID);
  assert.equal((await f.verify()).status, 409);
  assert.equal(f.reads, 0);
});

test("a process admits one verification at a time and releases its slot after completion", async (t) => {
  const f = await fixture(t), entered = deferred<void>(), response = deferred<Awaited<ReturnType<ClickHouse["query"]>>>();
  f.setQuery(async () => { entered.resolve(); return response.promise; });
  const pending = f.verify();
  await entered.promise;
  const busy = await f.verify();
  assert.equal(busy.status, 503);
  assert.equal(busy.data.error, "telemetry_verification_busy");
  assert.equal(f.reads, 1);
  response.resolve(matchingResponse());
  assert.equal((await pending).data.telemetry.state, "verified");
  f.setQuery(async () => matchingResponse());
  assert.equal((await f.verify()).status, 200);
  assert.equal(f.reads, 2);
});

test("verification discards in-flight evidence after target/release edits, rollback, or a later approved deployment", async (t) => {
  for (const race of ["target", "release", "rollback", "deployment"] as const) {
    await t.test(race, async (st) => {
      const f = await fixture(st);
      const baseline = await f.verify();
      assert.equal(baseline.status, 200);
      assert.equal(baseline.data.telemetry.state, "verified");
      const entered = deferred<void>(), response = deferred<Awaited<ReturnType<ClickHouse["query"]>>>();
      f.setQuery(async () => { entered.resolve(); return response.promise; });
      const pending = f.verify();
      await entered.promise;
      if (race === "target") {
        const changed = await f.request(`/api/v1/services/${f.serviceID}/targets/${f.targetID}`, "PATCH", { config: { ...TARGET_CONFIG, telemetry: { ...BINDING, instance_id: "node-b" } } });
        assert.equal(changed.status, 200);
      } else if (race === "release") {
        f.db.run("UPDATE releases SET version='v2-changed' WHERE id=?", f.releaseID);
      } else if (race === "rollback") {
        await f.preflight("v2");
        const rollback = await f.request(`/api/v1/deployments/${f.deploymentID}/rollback`, "POST", { confirm: true, expected_state: "succeeded" });
        assert.equal(rollback.status,409);assert.equal(rollback.data.error,"privileged_profile_not_implemented");
        // A concurrent recovery/import of historical state must invalidate
        // telemetry evidence even though new rollback dispatch is disabled.
        f.db.run("UPDATE deployments SET operation_kind='rollback',status='rollback_pending' WHERE id=?",f.deploymentID);
      } else {
        await f.preflight("v2");
        const nextID = await f.plan();
        const approved = await f.request(`/api/v1/deployments/${nextID}/approve`, "POST", { confirm: true });
        assert.equal(approved.status,409);assert.equal(approved.data.error,"privileged_profile_not_implemented");
        const at="2026-10-23T00:01:00.000Z";
        f.db.run("INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,issued_at,expires_at,created_at,updated_at,receipt_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
          "later-historical-job","agent-a",nextID,"later-historical-operation","succeeded",at,at,at,at,JSON.stringify({state:"succeeded",snapshot:{health:{healthy:true}}}));
      }
      response.resolve(matchingResponse());
      const rejected = await pending;
      assert.equal(rejected.status, 409);
      const current = await f.request(`/api/v1/deployments/${f.deploymentID}`);
      assert.equal(current.data.telemetry.stale, true);
      assert.equal(current.data.telemetry.checkedAt, baseline.data.telemetry.checkedAt, "discarded evidence must not replace the persisted summary");
      assert.equal(f.services.assistantDeployment(f.deploymentID).telemetry.stale, true);
      assert.equal((await f.verify()).status, 409);
    });
  }
});
