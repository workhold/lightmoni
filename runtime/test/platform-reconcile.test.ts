import { test } from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { registerOperationsPlatform } from "../src/ops/index.js";
import type { Dependencies } from "../src/shared/types.js";

test("two workload reconciliation rounds continue while a DNS observation remains in flight", async (t) => {
  const db = new DB(":memory:");
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','admin',1);CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);INSERT INTO agents VALUES('node-a','host-a','Test','1','linux','amd64','2026-10-29T02:00:00Z','default','{}')",
  );
  let now = new Date("2026-10-29T02:00:00Z");
  const deps = {
    db,
    router: new Router(),
    ...cipher(Buffer.alloc(32, 8)),
    now: () => now,
    auth: { requireAdmin() {} },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  const jobs = registerAgentJobs(deps);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dnsRequests = 0;
  const platform = registerOperationsPlatform(deps, {
    jobs,
    dataDir: "/tmp/lightmoni-reconcile-test",
    fetch: async () => {
      dnsRequests++;
      await gate;
      return new Response(
        JSON.stringify({ TotalCount: 0, DomainRecords: { Record: [] } }),
      );
    },
  });
  t.after(async () => {
    release();
    await platform.close();
    jobs.close?.();
    db.close();
  });
  const credential = platform.store.create(
    "credential",
    "DNS",
    {
      provider: "aliyun",
      access_key_id: "test-id",
      access_key_secret: "test-secret",
    },
    "admin",
  );
  platform.store.create(
    "dns_zone",
    "Zone",
    { domain: "example.test", credential_id: credential.id },
    "admin",
  );
  const app = platform.store.create(
    "application",
    "Application",
    { mode: "container", image: "nginx:1.30.6-alpine", agent_ids: ["node-a"] },
    "admin",
  );
  platform.store.patchStatus(app.id, {
    enabled: true,
    desired_revision: 1,
    policy_actor: "admin",
  });
  db.run(
    "INSERT INTO ops_platform_instances(id,owner_id,agent_id,slot,state,healthy,last_seen,created_at,updated_at,desired_state) VALUES(?,?,?,?,?,?,?,?,?,?)",
    "a".repeat(32),
    app.id,
    "node-a",
    "node-a",
    "running",
    1,
    "2026-10-29T01:59:00Z",
    "2026-10-29T01:59:00Z",
    "2026-10-29T01:59:00Z",
    "running",
  );
  const settle = async () => {
    for (let i = 0; i < 5; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const first = platform.tick();
  await settle();
  assert.equal(dnsRequests, 1);
  assert.equal(
    platform.store.actions(app.id).length,
    1,
    "DNS must not block the first workload inspection",
  );
  const job = jobs.claim("node-a", ["operations.platform"])!,
    payload = platform.resolvePayload(job);
  for (const [i, phase] of [
    "accepted",
    "staging",
    "activating",
    "verifying",
  ].entries())
    jobs.event("node-a", job.id, {
      lease_id: job.lease_id,
      sequence: i + 1,
      phase,
      summary: "inspection",
    });
  jobs.result("node-a", job.id, {
    lease_id: job.lease_id,
    state: "succeeded",
    summary: "healthy",
    snapshot: {
      health: { healthy: true },
      operations: {
        operation_id: payload.operation_id,
        resource_id: app.id,
        data: { healthy: true, containers: [{ running: true }] },
      },
    },
  });
  now = new Date(now.getTime() + 35000);
  const second = platform.tick();
  await settle();
  assert.equal(
    dnsRequests,
    1,
    "the same DNS domain must not overlap its own unfinished tick",
  );
  assert.equal(
    platform.store.actions(app.id).length,
    2,
    "the next workload round must run before the first DNS request finishes",
  );
  release();
  await Promise.all([first, second]);
});
