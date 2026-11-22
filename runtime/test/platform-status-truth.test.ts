import { ReconciliationRegistry } from "../src/reconciliation/registry.js";
import { createHostNetworkSchema, recordHostNetwork } from "../src/server/host-network.js";
import { normalizeNetworkAddresses } from "../src/shared/host-network.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { cipher } from "../src/shared/crypto.js";
import { Router, fail } from "../src/shared/http.js";
import { registerAgentJobs } from "./helpers/domain-jobs.js";
import { registerOperationsPlatform } from "../src/ops/index.js";
import type { Dependencies } from "../src/shared/types.js";

const CAPABILITIES = ["operations.platform","operations.platform.registry.v1","operations.platform.storage.v2","operations.platform.readiness.v1","operations.platform.image-refresh.v1","operations.platform.image-cache.v1","operations.platform.image-sources.v1","operations.platform.instance-recovery.v1","operations.platform.reconciliation.v1"];

async function fixture(t: any, reconciliationEnabled = false) {
  const db = new DB(":memory:");
  db.exec(
    `CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','admin',1);CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);INSERT INTO agents VALUES('a','ha','A','1','linux','amd64','2026-10-29T02:00:00.000Z','default','{}');CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT,address TEXT,agent_id TEXT);INSERT INTO managed_machines(id,name,address,agent_id) VALUES('ma','Machine A','10.0.0.1','a');`,
  );
  db.exec("ALTER TABLE managed_machines ADD COLUMN ssh_target_generation INTEGER NOT NULL DEFAULT 0; ALTER TABLE managed_machines ADD COLUMN host_key_fingerprint TEXT NOT NULL DEFAULT ''");
  createHostNetworkSchema(db);
  let now = new Date("2026-10-29T02:00:00Z");
  const router = new Router();
  const deps = {
    db,
    router,
    ...cipher(Buffer.alloc(32, 12)),
    now: () => now,
    logger: { error() {}, warn() {}, info() {} },
    auth: {
      requireAdmin(ctx: any) {
        if (ctx.user.role !== "admin") fail(403, "administrator_required");
      },
      user(req: any) {
        return { id: req.headers["x-role"] ?? "admin", role: req.headers["x-role"] ?? "admin" };
      },
    },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const reconciliation = new ReconciliationRegistry(deps);
  const jobs = registerAgentJobs(deps, { agentCredentials: { has: () => true } as any }),
    platform = registerOperationsPlatform(deps, {
      jobs,
      dataDir: "/tmp/status-truth-tests",
      intervalMs: 1000000,
      ...(reconciliationEnabled ? { reconciliation } : {}),
    }),
    store = platform.store;
  const server = createServer((req, res) => void router.handle(req, res).then(found => { if (!found) { res.writeHead(404); res.end(); } }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const req = async (path: string, method = "GET", body?: any) => {
    const r = await fetch("http://127.0.0.1:" + (server.address() as any).port + "/api/v1/ops" + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const createCluster = () => {
    const machine = db.get<any>("SELECT * FROM managed_machines WHERE id='ma'")!;
    if (!db.get("SELECT machine_id FROM machine_network_observations WHERE machine_id='ma'"))
      recordHostNetwork(db, "ma", machine.agent_id, normalizeNetworkAddresses([{ interface: "eth0", address: machine.address }, { interface: "eth0", address: "203.0.113.1" }]), undefined, now.toISOString());
    return store.create("cluster", "Cluster", {
      machine_ids: ["ma"],
      port_start: 21000,
      port_end: 21020,
      nodes: [{ machine_id: "ma", address: "10.0.0.1", public_address: "203.0.113.1", cpu: 4, memory_mb: 4096 }],
    }, "admin");
  };
  const app = (c: any) =>
    store.create("application", "Watched", {
      deployments: [{ cluster_id: c.id, machine_ids: ["ma"], replicas: 1, cpu: 0.25, memory_mb: 128 }],
      source: { type: "custom" },
      deployment_mode: "manual",
      machine_ids: ["ma"],
      role: "generic",
      mode: "container",
      image: "example:1",
      mounts: [],
      ports: [{ name: "http", container_port: 8080, host_port: 0, protocol: "tcp", app_protocol: "http" }],
      cpu: 0.25,
      memory_mb: 128,
    }, "admin");
  const action = (r: any, name: string) =>
    req("/resources/" + r.id + "/actions", "POST", { revision: r.revision, confirmed: true, action: name, input: {} });
  const finish = (agentID: string, data: any = { healthy: true, running: true, containers: [{ running: true }] }, state = "succeeded") => {
    const job = jobs.claim(agentID, CAPABILITIES);
    assert.ok(job);
    const payload = platform.resolvePayload(job);
    for (const [n, phase] of ["accepted", "staging", "activating", "verifying"].entries())
      jobs.event(agentID, job.id, { lease_id: job.lease_id, sequence: n + 1, phase, summary: "test" });
    jobs.result(agentID, job.id, {
      lease_id: job.lease_id,
      state,
      ...(data.code ? { code: data.code } : {}),
      summary: "test",
      snapshot: {
        health: { healthy: state === "succeeded" },
        operations: { operation_id: payload.operation_id, resource_id: payload.resource.id, data },
      },
    });
    return { job, payload };
  };
  t.after(async () => {
    await reconciliation.close();
    await platform.close();
    jobs.close?.();
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return {
    reconciliation, db, store, platform, jobs, req, createCluster, app, action, finish,
    instance(owner: string) { return db.get<any>("SELECT * FROM ops_cluster_instances WHERE owner_id=?", owner)!; },
    published(owner: string) { return (store.get(owner, "application").status?.instances ?? [])[0] ?? {}; },
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    heartbeat() { db.run("UPDATE agents SET last_seen=? WHERE id='a'", now.toISOString()); },
  };
}

test("an unknown execution self-verifies through a read-only inspect instead of blocking", async t => {
  const f = await fixture(t, true);
  f.db.run("UPDATE agents SET heartbeat=? WHERE id='a'", JSON.stringify({ operations_capabilities: ["operations.platform.reconciliation.v1"] }));
  const c = f.createCluster(), a = f.app(c);
  await f.action(a, "deploy");
  f.finish("a");
  assert.equal(f.instance(a.id).state, "running");

  // A redeploy whose lease expires mid-flight leaves the instance unknown.
  await f.action(a, "deploy");
  const apply = f.jobs.claim("a", CAPABILITIES)!;
  assert.ok(apply);
  f.advance(46000);
  f.jobs.expireLeases?.();
  assert.equal(f.instance(a.id).state, "unknown");
  assert.ok(f.published(a.id).unresolved_run_id, "the card would report 结果未知");

  // The registry resolves it itself with a read-only inspect once the cooldown
  // has passed — no manual agent recovery.
  f.advance(31000);
  f.heartbeat();
  await f.reconciliation.tick();
  const verify = f.db.get<any>("SELECT id,state FROM agent_jobs WHERE id<>? AND agent_id='a' AND state='queued'", apply.id);
  assert.ok(verify, "registry must dispatch a read-only verification inspect");

  f.finish("a", { healthy: true, running: true, containers: [{ running: true }], configuration_matches: true });
  const restored = f.instance(a.id);
  assert.equal(restored.state, "running");
  assert.equal(restored.healthy, 1);
  assert.equal(f.published(a.id).unresolved_run_id, undefined);
  assert.equal(f.published(a.id).healthy, true);

  f.advance(6000);
  await f.reconciliation.tick();
  const resource = f.db.get<any>("SELECT state FROM reconciliation_resources WHERE resource_key=?", restored.id);
  assert.equal(resource.state, "in_sync");
});

test("a late read-only receipt settles an unknown lease and restores the verified status", async t => {
  const f = await fixture(t);
  const c = f.createCluster(), a = f.app(c);
  await f.action(a, "deploy");
  f.finish("a");
  assert.equal(f.instance(a.id).state, "running");

  // The periodic inspect is claimed, its lease expires, and the run goes unknown.
  f.advance(31000);
  f.heartbeat();
  await f.platform.tick();
  const inspect = f.jobs.claim("a", CAPABILITIES)!;
  assert.ok(inspect);
  const payload = f.platform.resolvePayload(inspect);
  assert.equal(payload.resource.config.task, "workload.inspect");
  f.advance(46000);
  f.jobs.expireLeases?.();
  assert.equal(f.db.get<any>("SELECT state FROM agent_jobs WHERE id=?", inspect.id)!.state, "unknown");
  assert.ok(f.published(a.id).unresolved_run_id);

  // The agent finally delivers its observation with the original lease: the
  // centre accepts the read-only fact instead of discarding it.
  f.jobs.result("a", inspect.id, {
    lease_id: inspect.lease_id,
    state: "succeeded",
    summary: "late observation",
    snapshot: {
      health: { healthy: true },
      operations: { operation_id: payload.operation_id, resource_id: payload.resource.id, data: { healthy: true, running: true, containers: [{ running: true }] } },
    },
  });
  assert.equal(f.db.get<any>("SELECT state FROM agent_jobs WHERE id=?", inspect.id)!.state, "succeeded");
  const restored = f.instance(a.id);
  assert.equal(restored.state, "running");
  assert.equal(restored.healthy, 1);
  assert.equal(f.published(a.id).unresolved_run_id, undefined);

  // Write results keep the review boundary: a late apply receipt is rejected.
  await f.action(a, "deploy");
  const write = f.jobs.claim("a", CAPABILITIES)!;
  assert.ok(write);
  f.advance(46000);
  f.jobs.expireLeases?.();
  assert.throws(
    () => f.jobs.result("a", write.id, { lease_id: write.lease_id, state: "succeeded", summary: "late write" }),
    /resolved unknown execution/,
  );
});

test("execution-environment failures keep the last verified state instead of reporting failed", async t => {
  const f = await fixture(t);
  const c = f.createCluster(), a = f.app(c);
  await f.action(a, "deploy");
  f.finish("a");

  await f.action(a, "deploy");
  f.finish("a", { code: "docker_daemon_unavailable" }, "failed");
  const degraded = f.instance(a.id);
  assert.equal(degraded.state, "running", "a docker daemon hiccup is not a workload fact");
  assert.equal(degraded.healthy, 0);
  assert.equal(degraded.health_failures, 1);

  await f.action(a, "deploy");
  f.finish("a", { code: "image_pull_backoff" }, "failed");
  assert.equal(f.instance(a.id).state, "failed", "business failures still report failed");
});

test("an unresolved unknown managed task fences writes but not read-only verification", async t => {
  const f = await fixture(t, true);
  f.db.run("UPDATE agents SET heartbeat=? WHERE id='a'", JSON.stringify({ operations_capabilities: ["operations.platform.reconciliation.v1"] }));
  const c = f.createCluster(), a = f.app(c);
  await f.action(a, "deploy");
  f.finish("a");

  // A redeploy that loses its lease leaves the instance unknown.
  await f.action(a, "deploy");
  const apply = f.jobs.claim("a", CAPABILITIES)!;
  assert.ok(apply);
  f.advance(46000);
  f.jobs.expireLeases?.();
  assert.equal(f.instance(a.id).state, "unknown");

  // The agent now also carries an unresolved unknown managed task.
  if (!f.db.get("SELECT 1 FROM sqlite_master WHERE name='task_runs'"))
    f.db.exec("CREATE TABLE task_runs(id TEXT PRIMARY KEY, agent_id TEXT, host_id TEXT, execution_principal TEXT, state TEXT, resolved_at TEXT NOT NULL DEFAULT '')");
  f.db.run("INSERT INTO task_runs VALUES('tr-unknown','a','ma','privileged_executor','unknown','')");

  f.advance(31000);
  f.heartbeat();
  await f.reconciliation.tick();
  const resource = f.db.get<any>("SELECT state,code FROM reconciliation_resources WHERE resource_key=?", f.instance(a.id).id);
  assert.equal(resource.state, "pending", "read-only verification is dispatched despite the unknown managed task");
  assert.notEqual(resource.code, "reconciliation_failed");
  const verifyJob = f.db.get<any>("SELECT id FROM agent_jobs WHERE agent_id='a' AND state='queued' AND id<>?", apply.id);
  assert.ok(verifyJob, "the read-only inspect job enqueues through the admission fence");

  // Writes stay fenced until the unknown task is resolved by review. The
  // executor completes the read-only inspect through its own lease lane.
  const leaseID = "lease-verify-1";
  const leased = f.jobs.leasePrivileged!(verifyJob.id, leaseID, new Date(Date.now() + 45000).toISOString());
  const payload = f.platform.resolvePayload(leased);
  for (const [n, phase] of ["accepted", "staging", "activating", "verifying"].entries())
    f.jobs.event("a", verifyJob.id, { lease_id: leaseID, sequence: n + 1, phase, summary: "test" });
  f.jobs.result("a", verifyJob.id, {
    lease_id: leaseID, state: "succeeded", summary: "test",
    snapshot: { health: { healthy: true }, operations: { operation_id: payload.operation_id, resource_id: payload.resource.id, data: { healthy: true, running: true, containers: [{ running: true }], configuration_matches: true } } },
  });
  assert.equal(f.instance(a.id).state, "running");
  const redeploy = await f.action(a, "deploy");
  assert.equal(redeploy.status, 409);
  assert.match(String(redeploy.body.error), /privileged_execution_pending/);
});

test("verify dispatch refusals defer reconciliation instead of crash-looping", async t => {
  const f = await fixture(t, true);
  f.db.run("UPDATE agents SET heartbeat=? WHERE id='a'", JSON.stringify({ operations_capabilities: ["operations.platform.reconciliation.v1"] }));
  const c = f.createCluster(), a = f.app(c);
  await f.action(a, "deploy");
  f.finish("a");

  await f.action(a, "deploy");
  const apply = f.jobs.claim("a", CAPABILITIES)!;
  assert.ok(apply);
  f.advance(46000);
  f.jobs.expireLeases?.();
  assert.equal(f.instance(a.id).state, "unknown");

  // A pending agent update refuses every enqueue, including read-only ones.
  if (!f.db.get("SELECT 1 FROM sqlite_master WHERE name='machine_agent_updates'"))
    f.db.exec("CREATE TABLE machine_agent_updates(id TEXT PRIMARY KEY, agent_id TEXT, machine_id TEXT, status TEXT)");
  f.db.run("INSERT INTO machine_agent_updates VALUES('upd-1','a','ma','running')");

  f.advance(31000);
  f.heartbeat();
  await f.reconciliation.tick();
  const resource = f.db.get<any>("SELECT state,code FROM reconciliation_resources WHERE resource_key=?", f.instance(a.id).id);
  assert.equal(resource.state, "pending");
  assert.equal(resource.code, "verify_dispatch_deferred");
});
