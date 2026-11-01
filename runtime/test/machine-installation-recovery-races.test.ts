import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { registerManagedMachines, type SSHRunner } from "../src/server/managed-machines.js";
import type { Dependencies } from "../src/shared/types.js";

const checkOutput = "LMSSH=1\nplatform=linux\narch=amd64\nlinux=1\nsupported_arch=1\ncurl=1\ntar=1\ngzip=1\nsha256sum=1\nsystemd=1\nprivilege_state=root\ninstall_privilege=1\nplatform_https=1\nagent_installation=absent\n";
const now = new Date("2026-10-31T00:00:00.000Z");
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Two isolated routers share an in-memory database to model a restarted
 * runtime while an old SSH request still has a delayed response. SSH and
 * enrollment are synthetic; no external host or system service is contacted. */
async function fixture(t: any, sshRunner: SSHRunner) {
  const db = new DB(":memory:");
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '')");
  const user = { id: "admin", name: "Admin", role: "admin" }, master = Buffer.alloc(32, 9);
  let issued = 0;
  const credentials = {
    has: () => true,
    issueEnrollment: (input: any) => {
      issued++;
      // Match the real store's enrollment + installation-stage transaction.
      if (input.deployment_id) db.transaction(() => {
        assert.ok(db.get("SELECT id FROM machine_deployments WHERE id=? AND status='running' AND execution_stage='enrollment_issuing' AND resolved_at=''", input.deployment_id));
        db.run("UPDATE machine_deployments SET enrollment_id='race-enrollment',execution_stage='enrollment_issued' WHERE id=?", input.deployment_id);
      });
      return { enrollment_id: "race-enrollment", token_display_once: "lm_enroll_race",
        token_expires_at: "2026-10-31T01:00:00.000Z", install_command_hint: "" };
    },
    enrollmentStatus: () => ({ status: "active", agent_id: "race-agent", used_at: now.toISOString() }),
    cancelEnrollment: () => {},
  } as any;
  const deps = {
    db, ...cipher(master), now: () => now,
    auth: { master, user: () => user, requireAdmin: (ctx: any) => { if (ctx.user.role !== "admin") fail(403, "administrator required"); }, validateKey: () => { throw Error("unused"); } },
    externalURL: "https://monitor.example.com", logger: { info() {}, warn() {}, error() {} },
    cat: { list: async () => [] }, query: async () => ({ request_id: "", results: [] }), referencedTables: async () => [],
    ch: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
    reader: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
  } as unknown as Dependencies;
  const modules: ReturnType<typeof registerManagedMachines>[] = [], servers: ReturnType<typeof createServer>[] = [];
  const start = async () => {
    const router = new Router(); router.auth = deps.auth;
    modules.push(registerManagedMachines({ ...deps, router }, { agentCredentials: credentials, sshRunner }));
    const server = createServer(async (req, res) => {
      if (!await router.handle(req, res)) { res.writeHead(404); res.end(); }
    });
    servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    return async (path: string, method = "GET", body?: any) => {
      const response = await fetch(url + "/api/v1" + path, {
        method, headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() as any };
    };
  };
  t.after(() => { for (const module of modules) module.close?.(); for (const server of servers) server.close(); db.close(); });
  const request = await start();
  const host = await request("/machines", "POST", { name: "race-host", address: "race.example.test", username: "root" });
  assert.equal(host.status, 201);
  const mid = host.data.id;
  // Synthetic runner bypasses real SSH host-key observation.
  db.run("UPDATE managed_machines SET host_key_fingerprint=? WHERE id=?", "SHA256:abcdefghijklmnop", mid);
  const key = await request(`/machines/${mid}/credentials`, "POST", { method: "password", secret: "fixture-test-password", retention: "permanent", confirm_permanent: true });
  assert.equal(key.status, 201);
  const check = await request(`/machines/${mid}/ssh-check`, "POST", {});
  assert.equal(check.status, 200);
  const plan = await request(`/machines/${mid}/deployments/plan`, "POST", { check_id: check.data.id, version: "0.1.0", arch: "amd64" });
  assert.equal(plan.status, 201);
  return { db, mid, did: plan.data.id, request, start, get issued() { return issued; } };
}

for (const rejected of [false, true]) test(`resolved installation prevents late preflight ${rejected ? "failure overwrite" : "dispatch"}`, { timeout: 5000 }, async t => {
  const entered = deferred<void>(), remote = deferred(); let checks = 0, bootstraps = 0;
  t.after(() => remote.resolve({ stdout: checkOutput, stderr: "", stages: [] }));
  const f = await fixture(t, async input => {
    if (input.enrollmentToken) { bootstraps++; return { stdout: "installed", stderr: "", stages: [] }; }
    if (++checks === 2) { entered.resolve(); return await remote.promise; }
    return { stdout: checkOutput, stderr: "", stages: [] };
  });
  const apply = f.request(`/machines/${f.mid}/deployments/${f.did}/apply`, "POST", { confirm: true });
  await Promise.race([entered.promise, apply.then(result => { throw Error("apply ended before delayed preflight: " + JSON.stringify(result)); })]);
  const recover = await f.start();
  assert.equal(f.db.get<any>("SELECT status FROM machine_deployments WHERE id=?", f.did)?.status, "unknown");
  const resolved = await recover(`/machines/${f.mid}/deployments/${f.did}/resolve`, "POST", { confirm: true, reason: "Isolated test: remote preflight has ended" });
  assert.equal(resolved.status, 200, JSON.stringify(resolved));
  if (rejected) remote.reject(Error("late preflight error"));
  else remote.resolve({ stdout: checkOutput, stderr: "", stages: [] });
  const response = await apply;
  assert.ok(response.status >= 400, "the old request cannot report installation success");
  assert.equal(f.issued, 0, "a resolved installation must not issue a new identity");
  assert.equal(bootstraps, 0, "a resolved installation must not dispatch bootstrap");
  const row = f.db.get<any>("SELECT * FROM machine_deployments WHERE id=?", f.did);
  assert.equal(row.status, "unknown"); assert.ok(row.resolved_at); assert.equal(row.finished_at, "");
  assert.equal(f.db.get<any>("SELECT last_error FROM managed_machines WHERE id=?", f.mid).last_error, "");
});

test("resolved installation ignores a late bootstrap receipt without overwriting newer host state", { timeout: 5000 }, async t => {
  const entered = deferred<void>(), remote = deferred();
  t.after(() => remote.resolve({ stdout: checkOutput, stderr: "", stages: [] }));
  const f = await fixture(t, async input => {
    if (input.enrollmentToken) { entered.resolve(); return await remote.promise; }
    return { stdout: checkOutput, stderr: "", stages: [] };
  });
  const apply = f.request(`/machines/${f.mid}/deployments/${f.did}/apply`, "POST", { confirm: true });
  await Promise.race([entered.promise, apply.then(result => { throw Error("apply ended before delayed bootstrap: " + JSON.stringify(result)); })]);
  const recover = await f.start();
  const resolved = await recover(`/machines/${f.mid}/deployments/${f.did}/resolve`, "POST", { confirm: true, reason: "Isolated test: remote installation has ended" });
  assert.equal(resolved.status, 200, JSON.stringify(resolved));
  f.db.run("UPDATE managed_machines SET last_error=? WHERE id=?", "newer observation", f.mid);
  remote.resolve({ stdout: "late success", stderr: "", stages: [] });
  const response = await apply;
  assert.ok(response.status >= 400);
  const row = f.db.get<any>("SELECT * FROM machine_deployments WHERE id=?", f.did);
  assert.equal(row.status, "unknown"); assert.ok(row.resolved_at);
  assert.equal(f.db.get<any>("SELECT last_error FROM managed_machines WHERE id=?", f.mid).last_error, "newer observation");
});
