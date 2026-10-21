import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { id } from "../src/shared/crypto.js";
import { registerServiceDeployments } from "../src/server/service-deployments.js";
import type { Dependencies } from "../src/shared/types.js";

test("service inventory creates an approval-ready deployment plan", async (t) => {
  const db = new DB(":memory:"), router = new Router(), user = { id: "admin", name: "Admin", role: "admin" };
  db.exec("CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT NOT NULL,address TEXT NOT NULL,port INTEGER NOT NULL,username TEXT NOT NULL,agent_id TEXT NOT NULL DEFAULT '')");
  const machineID = "machine-1";
  db.run("INSERT INTO managed_machines(id,name,address,port,username) VALUES(?,?,?,?,?)", machineID, "app-1", "10.0.0.9", 22, "deploy");
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
  const release = await request(`/api/v1/services/${serviceID}/releases`, "POST", { version: "2026.10.21", source_type: "artifact", source_ref: "sha256:abc", artifact_digest: "sha256:abc" });
  assert.equal(release.status, 201);
  const plan = await request(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  assert.equal(plan.status, 201);
  assert.equal(plan.data.status, "awaiting_approval");
  assert.equal(plan.data.plan.adapter, "systemd");
  const detail = await request(`/api/v1/services/${serviceID}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.targets.length, 1);
  assert.equal(detail.data.releases.length, 1);
  assert.equal(detail.data.deployments.length, 1);
  assert.notEqual(id(), "");
});

