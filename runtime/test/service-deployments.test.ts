import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { id } from "../src/shared/crypto.js";
import { canTransitionDeployment, registerServiceDeployments } from "../src/server/service-deployments.js";
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
  registerServiceDeployments(deps);
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
  const target = await request(`/api/v1/services/${serviceID}/targets`, "POST", { machine_id: machineID, adapter: "systemd", config: { unit: "checkout.service" } });
  assert.equal(target.status, 201);
  const unsupportedTarget = await request(`/api/v1/services/${serviceID}/targets`, "POST", { machine_id: "machine-1", adapter: "docker_compose", config: {} });
  assert.equal(unsupportedTarget.status, 400);
  const release = await request(`/api/v1/services/${serviceID}/releases`, "POST", { version: "2026.10.21", source_type: "artifact", source_ref: "sha256:abc", artifact_digest: "sha256:abc" });
  assert.equal(release.status, 201);
  const plan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  assert.equal(plan.status, 201);
  assert.equal(plan.data.status, "awaiting_approval");
  assert.equal(plan.data.plan.adapter, "systemd");
  // Once the agents table exists, approval requires a recent heartbeat rather
  // than trusting a stale machine binding.
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL)");
  const notReady = await request(`/api/v1/deployments/${plan.data.id}/approve`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.data.error, "agent_not_ready");
  db.run("INSERT INTO agents(id,last_seen) VALUES(?,?)", "agent-1", "2026-10-20T23:59:00Z");
  const approval = await request(`/api/v1/deployments/${plan.data.id}/approve`, "POST", { confirm: true, expected_state: "awaiting_approval" });
  assert.equal(approval.status, 200);
  assert.equal(approval.data.status, "agent_ready");
  assert.match(approval.data.operation_id, /^[a-f0-9]{32}$/);
  const events = await request(`/api/v1/deployments/${plan.data.id}/events`);
  assert.equal(events.status, 200);
  assert.deepEqual(events.data.map((event: any) => event.state), ["awaiting_approval", "agent_ready"]);
  const rollback = await request(`/api/v1/deployments/${plan.data.id}/rollback`, "POST", { confirm: true, reason: "人工检查" });
  assert.equal(rollback.status, 200);
  assert.equal(rollback.data.status, "rollback_pending");
  const repeatedRollback = await request(`/api/v1/deployments/${plan.data.id}/rollback`, "POST", { confirm: true });
  assert.equal(repeatedRollback.status, 200);
  assert.equal(repeatedRollback.data.operation_id, rollback.data.operation_id);
  const detail = await request(`/api/v1/services/${serviceID}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.targets.length, 1);
  assert.equal(detail.data.releases.length, 1);
  assert.equal(detail.data.deployments.length, 1);
  assert.equal(detail.data.deployments[0].status, "rollback_pending");
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
