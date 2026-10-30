import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DB } from "../src/shared/sqlite.js";
import { Router, HTTPError } from "../src/shared/http.js";
import type { Dependencies } from "../src/shared/types.js";
import { registerAgentCredentials } from "../src/server/agent-credentials.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { registerNodes } from "../src/server/nodes.js";
import { NodeStore, normalizeTask } from "../src/server/nodes-model.js";
import { assertAgentActive, isAgentRemoved } from "../src/server/agent-lifecycle.js";
import { Catalog } from "../src/server/catalog.js";
import { Ingest } from "../src/server/ingest.js";
import { registerCore } from "../src/server/core.js";
import { registerServiceDeployments } from "../src/server/service-deployments.js";
import { registerOperations } from "../src/server/operations.js";
import type { OperationDefinition } from "../src/operations/types.js";
import { issueHostEnrollment } from "./helpers/host-enrollment.js";

async function fixture(t: any, persistent = false) {
  const directory = mkdtempSync(join(tmpdir(), "lm-node-lifecycle-"));
  const db = new DB(persistent ? join(directory, "test.db") : ":memory:"), router = new Router();
  const user = { id: "admin", name: "Admin", role: "admin" };
  const auth = { router, master: Buffer.alloc(32), user: () => user,
    requireAdmin() { if (user.role !== "admin") throw new HTTPError(403, "需要管理员权限"); },
    validateKey(ctx: any) { if (ctx.req.headers.authorization !== "Bearer shared-sdk-key") throw new HTTPError(401, "invalid write key"); return { id: "sdk-key", name: "SDK", allowed_tables: [], allow_all_tables: true }; }, recordKey() {},
  };
  const rows: any[] = [], ch = { user: "fixture", async exec() {}, async query() { return { meta: [], data: [], rows: 0 }; }, async insert(_table: string, values: any[]) { rows.push(...values); } };
  const cat = new Catalog(db, ch, ch);
  const deps = { db, router, auth, cat, ch, reader: ch, now: () => new Date(), externalURL: "http://127.0.0.1", logger: { info() {}, warn() {}, error() {} } } as unknown as Dependencies;
  router.auth = deps.auth;
  const credentials = registerAgentCredentials(deps), nodes = registerNodes(deps, { agentCredentials: credentials });
  const jobs = registerAgentJobs(deps, { agentCredentials: credentials });
  new Ingest(cat, auth as any, undefined, credentials).register();
  const server = createServer(async (req, res) => { if (!await router.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => { const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() as any }; };
  const enroll = async () => {
    const issued = issueHostEnrollment(db, credentials, { endpoint_origin: base, version: "0.1.0", created_by: user.id });
    const enrolled = await request("/api/v1/agents/enroll", "POST", { enrollment_token: issued.token_display_once, install_nonce: issued.enrollment_id, agent_public_key: "fixture", version: "0.1.0", arch: "amd64" });
    const activated = await request(`/api/v1/agents/${enrolled.data.agent_id}/activate`, "POST", { install_nonce: issued.enrollment_id, health: { service: "ready", config_checked: true } }, { authorization: "Bearer " + enrolled.data.bootstrap_credential });
    assert.equal(activated.status, 200);
    const id = enrolled.data.agent_id, control = { authorization: "Bearer " + activated.data.control_credential }, data = { authorization: "Bearer " + activated.data.data_credential, "x-lightmoni-agent-id": id };
    assert.equal((await request("/api/v1/agents/register", "POST", { agent_id: id, hostname: "fixture-node", host_id: "fixture-host", version: "0.1.0", platform: "linux", arch: "amd64" }, control)).status, 200);
    return { id, control, data };
  };
  t.after(async () => { jobs.close?.(); await nodes.close?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, deps, user, credentials, nodes, jobs, rows, cat, base, request, enroll };
}
const metric = () => ({ resourceMetrics: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "fixture" } }] }, scopeMetrics: [{ metrics: [{ name: "requests", gauge: { dataPoints: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), asDouble: 1 }] } }] }] }] });
const remove = (f: Awaited<ReturnType<typeof fixture>>, id: string, body: unknown = { confirm: true }) => f.request(`/api/v1/agents/${id}/remove`, "POST", body);

test("node removal requires admin confirmation, archives once and revokes only its independent credentials", async t => {
  const f = await fixture(t), node = await f.enroll(), other = await f.enroll();
  f.user.role = "member"; assert.equal((await remove(f, node.id)).status, 403); assert.equal((await f.request("/api/v1/agents?include_removed=true")).status, 403); f.user.role = "admin";
  for (const input of [{}, { confirm: "true" }, { confirm: true, reason: 7 }, { confirm: true, extra: true }]) assert.equal((await remove(f, node.id, input)).status, 400);
  assert.equal((await remove(f, "missing")).status, 404);
  const result = await remove(f, node.id, { confirm: true, reason: " retired " });
  assert.equal(result.status, 200); assert.equal(result.data.remote_uninstalled, false); assert.equal(result.data.credentials_revoked, true); assert.equal(result.data.lifecycle_state, "removed"); assert.equal(result.data.removal_reason, "retired");
  assert.deepEqual((await remove(f, node.id, { confirm: true, reason: "different retry" })).data, result.data);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_lifecycle_events WHERE agent_id=?", node.id).n, 1);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_credentials WHERE agent_id=? AND revoked_at IS NOT NULL", node.id).n, 2);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL", other.id).n, 2);
  assert.ok(f.db.get("SELECT id FROM agents WHERE id=?", node.id));
  assert.deepEqual((await f.request("/api/v1/agents")).data.map((n: any) => n.id), [other.id]);
  const archived = (await f.request("/api/v1/agents?include_removed=true")).data.find((n: any) => n.id === node.id);
  assert.equal(archived.lifecycle_state, "removed"); assert.deepEqual(archived.task_ids, []);
  f.user.role = "member"; assert.equal((await f.request("/api/v1/agents")).status, 200);
});

test("removed node cannot heartbeat, fetch config, claim jobs, send data or downgrade to SDK shared-key auth", async t => {
  const f = await fixture(t), node = await f.enroll(), headers = { ...node.data, "x-lightmoni-table": "business" };
  assert.equal((await f.request("/v1/metrics", "POST", metric(), headers)).status, 200); await remove(f, node.id);
  for (const control of [node.control, { authorization: "Bearer shared-sdk-key" }]) {
    assert.equal((await f.request(`/api/v1/agents/${node.id}/heartbeat`, "POST", { hostname: "revived" }, control)).status, 401);
    assert.equal((await f.request("/api/v1/agents/register", "POST", { agent_id: node.id }, control)).status, 401);
    assert.equal((await f.request(`/api/v1/agents/${node.id}/config`, "GET", undefined, control)).status, 401);
    assert.equal((await f.request(`/api/v1/agents/${node.id}/jobs/claim`, "POST", { capabilities: [] }, control)).status, 401);
  }
  assert.equal((await f.request("/v1/metrics", "POST", metric(), headers)).status, 401);
  assert.equal((await f.request("/v1/metrics", "POST", metric(), { ...headers, authorization: "Bearer shared-sdk-key" })).status, 401);
  assert.equal((await f.request("/v1/metrics", "POST", metric(), { "x-lightmoni-table": "business", authorization: "Bearer shared-sdk-key" })).status, 200);
  assert.equal((await f.request(`/api/v1/agents/${node.id}/labels`, "PUT", { label_ids: [] })).status, 409);
  const store = new NodeStore(f.db, () => new Date());
  assert.throws(() => store.heartbeat(node.id, {}, "stale-auth"), /已移除/); assert.throws(() => store.events(node.id, "stale-auth", {}), /已移除/);
  assert.throws(() => f.jobs.enqueue({ agentID: node.id, deploymentID: "new", operationID: "new", actions: [] }), /已移除/); assert.throws(() => f.jobs.claim(node.id, []), /已移除/); assert.equal(f.credentials.has(node.id, "control"), false);
  f.db.run("DELETE FROM agent_credentials WHERE agent_id=?", node.id); f.db.run("DELETE FROM agent_enrollments WHERE agent_id=?", node.id);
  assert.equal(f.credentials.registered?.(node.id), true); assert.equal((await f.request(`/api/v1/agents/${node.id}/heartbeat`, "POST", {}, { authorization: "Bearer shared-sdk-key" })).status, 401);
});

test("shared SDK keys cannot register or control Agent identities", async t => {
  const f = await fixture(t);
  const headers = { authorization: "Bearer shared-sdk-key" };
  assert.equal((await f.request("/api/v1/agents/register", "POST", { agent_id: "legacy" }, headers)).status, 401);
  assert.equal((await f.request("/api/v1/agents/legacy/heartbeat", "POST", {}, headers)).status, 401);
  assert.equal(f.db.get("SELECT id FROM agents WHERE id='legacy'"), undefined);
});

test("queued, executing and unknown jobs plus pending uninstalls prevent partial node removal", async t => {
  const f = await fixture(t), node = await f.enroll(), job = f.jobs.enqueue({ agentID: node.id, deploymentID: "deployment", operationID: "op", actions: [] });
  for (const state of ["queued", "leased", "accepted", "preflighting", "staging", "activating", "verifying", "unknown"]) {
    f.db.run("UPDATE agent_jobs SET state=? WHERE id=?", state, job.id); assert.equal((await remove(f, node.id)).status, 409, state);
    assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL", node.id).n, 2); assert.equal(isAgentRemoved(f.db, node.id), false);
  }
  f.db.run("UPDATE agent_jobs SET state='failed' WHERE id=?", job.id); f.db.exec("CREATE TABLE machine_uninstallations(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT)");
  for (const status of ["awaiting_approval", "running", "unknown"]) { f.db.run("INSERT OR REPLACE INTO machine_uninstallations VALUES('uninstall',?,?)", node.id, status); assert.equal((await remove(f, node.id)).status, 409, status); }
  f.db.run("UPDATE machine_uninstallations SET status='cancelled'"); assert.equal((await remove(f, node.id)).status, 200); assert.equal(f.db.get<any>("SELECT state FROM agent_jobs WHERE id=?", job.id).state, "failed");
});

test("an upload authenticated before removal is rejected when its body completes afterwards", async t => {
  const f = await fixture(t), node = await f.enroll(), payload = Buffer.from(JSON.stringify(metric()));
  const req = httpRequest(f.base + "/v1/metrics", { method: "POST", headers: { ...node.data, "x-lightmoni-table": "business", "content-type": "application/json", "content-length": payload.length } });
  const response = new Promise<number>((resolve, reject) => { req.on("response", res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }); req.on("error", reject); });
  let entered!: () => void; const authenticated = new Promise<void>(resolve => { entered = resolve; });
  const original = f.credentials.authenticate;
  f.credentials.authenticate = (...args) => { const result = original(...args); if (args[1] === node.id && args[2] === "data") entered(); return result; };
  req.write(payload.subarray(0, 1)); await authenticated; assert.equal((await remove(f, node.id)).status, 200);
  req.end(payload.subarray(1)); assert.equal(await response, 401); assert.equal(f.rows.length, 0);
});

test("node tombstone and job enqueue remain mutually exclusive across SQLite writers", async t => {
  const f = await fixture(t, true), node = await f.enroll(), second = new DB(f.db.path); t.after(() => second.close());
  const otherCredentials = registerAgentCredentials({ ...f.deps, db: second, router: new Router() });
  const otherJobs = registerAgentJobs({ ...f.deps, db: second, router: new Router() }, { agentCredentials: otherCredentials });
  assertAgentActive(second, node.id);
  const originalRun = second.run.bind(second); let raced = false;
  second.run = (sql: string, ...params: any[]) => {
    if (!raced && sql.startsWith("INSERT INTO agent_jobs")) {
      raced = true;
      f.db.transaction(() => { f.db.run("INSERT INTO agent_lifecycle(agent_id,state,removed_at) VALUES(?,'removed',?)", node.id, new Date().toISOString()); f.db.run("UPDATE agent_credentials SET revoked_at=? WHERE agent_id=?", new Date().toISOString(), node.id); });
    }
    return originalRun(sql, ...params);
  };
  assert.throws(() => otherJobs.enqueue({ agentID: node.id, deploymentID: "raced", operationID: "raced", actions: [] })); assert.equal(raced, true); assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_jobs WHERE agent_id=?", node.id).n, 0);
  const another = await f.enroll(); f.jobs.enqueue({ agentID: another.id, deploymentID: "first", operationID: "first", actions: [] }); assert.equal((await remove(f, another.id)).status, 409); assert.equal(isAgentRemoved(f.db, another.id), false);
});

test("failed archival audit rolls back tombstone and credential revocation together", async t => {
  const f = await fixture(t), node = await f.enroll();
  f.db.exec("CREATE TRIGGER fail_lifecycle_audit BEFORE INSERT ON agent_lifecycle_events BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END");
  assert.equal((await remove(f, node.id)).status, 500);
  assert.equal(isAgentRemoved(f.db, node.id), false);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL", node.id).n, 2);
  assert.equal((await f.request(`/api/v1/agents/${node.id}/heartbeat`, "POST", {}, node.control)).status, 200);
  f.db.exec("DROP TRIGGER fail_lifecycle_audit");
  assert.equal((await remove(f, node.id)).status, 200);
});

test("removal during asynchronous catalog setup prevents a data insert and old terminal job receipts", async t => {
  const f = await fixture(t), node = await f.enroll();
  const job = f.jobs.enqueue({ agentID: node.id, deploymentID: "terminal", operationID: "terminal", actions: [] });
  f.jobs.cancel(job.id, "admin");
  const ensure = f.cat.ensure.bind(f.cat); let removed = false;
  f.cat.ensure = async (...args) => {
    const result = await ensure(...args);
    if (!removed) { removed = true; assert.equal((await remove(f, node.id)).status, 200); }
    return result;
  };
  assert.equal((await f.request("/v1/metrics", "POST", metric(), { ...node.data, "x-lightmoni-table": "business" })).status, 401);
  assert.equal(f.rows.length, 0);
  assert.throws(() => f.jobs.event(node.id, job.id, { lease_id: "stale" }), /已移除/);
  assert.throws(() => f.jobs.result(node.id, job.id, { lease_id: "stale" }), /已移除/);
  for (const endpoint of ["events", "result"]) assert.equal((await f.request(`/api/v1/agents/${node.id}/jobs/${job.id}/${endpoint}`, "POST", { lease_id: "stale" }, node.control)).status, 401);
});


test("overview and operations selectors exclude archived nodes and new plans reject them", async t => {
  const f = await fixture(t), node = await f.enroll(), other = await f.enroll();
  f.db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,active INTEGER); INSERT INTO users VALUES('admin',1); CREATE TABLE ingest_keys(id TEXT PRIMARY KEY,active INTEGER)");
  registerCore(f.deps);
  const definition: OperationDefinition = { kind: "certificate", operations: ["inspect"], readOnly: ["inspect"], validate: v => v as any, publicConfig: v => v, validateInput: (_op,v) => v as any };
  const ops = registerOperations({ ...f.deps, encrypt: v => v, decrypt: v => v }, { jobs: f.jobs, credentials: f.credentials, definitions: [definition] });
  t.after(() => ops.close?.());
  const resource = await f.request("/api/v1/operations/resources", "POST", { kind: "certificate", name: "test", agent_id: node.id, config: {} });
  assert.equal(resource.status, 201);
  assert.equal((await f.request("/api/v1/overview")).data.agent_count, 2);
  await remove(f, node.id);
  assert.equal((await f.request("/api/v1/overview")).data.agent_count, 1);
  assert.deepEqual((await f.request("/api/v1/operations/agents")).data.agents.map((a: any) => a.id), [other.id]);
  assert.equal((await f.request("/api/v1/operations/resources", "POST", { kind: "certificate", name: "removed", agent_id: node.id, config: {} })).status, 409);
  assert.equal((await f.request(`/api/v1/operations/resources/${resource.data.resource.id}/plans`, "POST", { operation: "inspect" })).status, 409);
});


test("service deployment preflight treats a removed node as unavailable despite its recent heartbeat", async t => {
  const f = await fixture(t), node = await f.enroll();
  const machineID = f.db.get<any>("SELECT id FROM managed_machines WHERE agent_id=?", node.id)!.id;
  const deployments = registerServiceDeployments({ ...f.deps, encrypt: v => v, decrypt: v => v }, { jobs: f.jobs });
  t.after(() => deployments.close?.());
  const service = await f.request("/api/v1/services", "POST", { name: "fixture-service" });
  assert.equal(service.status, 201);
  const target = await f.request(`/api/v1/services/${service.data.id}/targets`, "POST", { machine_id: machineID, adapter: "systemd", config: { unit: "fixture.service", release_directory: "/opt/lightmoni/services/fixture" } });
  assert.equal(target.status, 201);
  const path = `/api/v1/services/${service.data.id}/targets/${target.data.id}/preflight`;
  assert.equal((await f.request(path, "POST", { confirm: true })).status, 202);
  const job = f.db.get<any>("SELECT id FROM agent_jobs WHERE agent_id=?", node.id);
  f.jobs.cancel(job.id, "fixture-cleanup");
  assert.equal((await remove(f, node.id)).status, 200);
  const result = await f.request(path, "POST", { confirm: true });
  assert.equal(result.status, 409); assert.equal(result.data.error, "agent_not_ready");
  assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_jobs WHERE agent_id=?", node.id).n, 1);
});

test("archived history retains labels but never compiles current or global tasks", async t => {
  const f = await fixture(t), node = await f.enroll();
  const machineID = f.db.get<any>("SELECT id FROM managed_machines WHERE agent_id=?", node.id)!.id;
  assert.equal((await f.request(`/api/v1/machines/${machineID}/labels`, "PUT", { label_ids: ["default"] })).status, 200);
  assert.equal((await remove(f, node.id)).status, 200);
  // Host labels survive Agent removal. The normal write path correctly rejects
  // conflicting assignments even without an installed Agent, so inject an
  // existing conflicting definition to verify archival never compiles it.
  let conflictingID = "";
  for (const [name, label_ids, interval] of [["global", [], 15], ["current-one", ["default"], 15], ["current-two", ["default"], 30]] as const) {
    const store=new NodeStore(f.db,()=>new Date());
    store.saveTask(normalizeTask({id:name,name,type:"host",enabled:name!=="current-two",label_ids,config:{collect_interval_seconds:interval,host_collectors:["memory"]}}));
    if (name === "current-two") conflictingID = name;
  }
  f.db.run("UPDATE agent_tasks SET enabled=1 WHERE id=?", conflictingID);
  const history = await f.request("/api/v1/agents?include_removed=true");
  assert.equal(history.status, 200);
  const archived = history.data.find((item: any) => item.id === node.id);
  assert.deepEqual(archived.label_ids, ["default"]);
  assert.equal(archived.labels[0].name, "默认标签");
  assert.deepEqual(archived.tasks, []); assert.deepEqual(archived.task_ids, []);
  assert.equal(archived.config.host_enabled, false); assert.deepEqual(archived.config.host_collectors, []);
  assert.equal(archived.config.logs_enabled, false); assert.deepEqual(archived.config.log_sources, []);
  assert.deepEqual(archived.config.probes, []); assert.equal(archived.config.revision, "");
  const store = new NodeStore(f.db, () => new Date());
  store.compile = () => { throw Error("archived history must not compile current assignments"); };
  assert.deepEqual(store.nodes(true)[0].tasks, []);
});
