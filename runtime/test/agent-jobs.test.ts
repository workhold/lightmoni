import { test } from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import type { Dependencies } from "../src/shared/types.js";

function fixture() {
  const db = new DB(":memory:");
  let current = new Date("2026-10-22T00:00:00.000Z");
  const deps = {
    db,
    router: new Router(),
    auth: { requireAdmin: () => {}, user: () => ({ id: "admin", name: "Admin", role: "admin" }), validateKey: () => { throw Error("unused"); }, master: Buffer.alloc(32) },
    now: () => current,
    externalURL: "http://127.0.0.1:8080",
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
    logger: { info() {}, warn() {}, error() {} },
    cat: { list: async () => [] }, query: async () => ({ request_id: "", results: [] }), referencedTables: async () => [],
    ch: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
    reader: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
  } as unknown as Dependencies;
  const credentials = { authenticate() { return { credential_id: "cred", agent_id: "agent-1", audience: "control", scope: "agent.control", expires_at: "", last_used_at: "" }; } } as any;
  return { db, deps, jobs: registerAgentJobs(deps, { agentCredentials: credentials }), advance(seconds: number) { current = new Date(current.getTime() + seconds * 1000); } };
}

test("Agent job lease protocol is idempotent and records bounded receipts", () => {
  const f = fixture();
  const created = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-1", operationID: "op-1", capabilities: ["systemd.restart"], actions: [{ kind: "systemd", operation: "restart", unit: "checkout.service" }] });
  const repeated = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-1", operationID: "op-1", capabilities: ["systemd.restart"], actions: [{ kind: "systemd", operation: "restart", unit: "checkout.service" }] });
  assert.equal(repeated.id, created.id);
  assert.equal(f.jobs.claim("agent-1", ["artifact.stage"]), null);
  const leased = f.jobs.claim("agent-1", ["systemd.restart"]);
  assert.ok(leased);
  assert.equal(leased.state, "leased");
  assert.throws(() => f.jobs.event("other-agent", leased!.id, { lease_id: leased!.lease_id, sequence: 1, phase: "accepted" }), /does not belong/);
  const accepted = f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 1, phase: "accepted", summary: "job accepted" });
  assert.equal(accepted.state, "accepted");
  const staged = f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 2, phase: "staging", summary: "artifact staged", snapshot: { digest: "sha256:…" } });
  assert.equal(staged.state, "staging");
  const done = f.jobs.result("agent-1", leased!.id, { lease_id: leased!.lease_id, state: "succeeded", code: "", summary: "service active", snapshot: { active_state: "active" } });
  assert.equal(done.state, "succeeded");
  assert.equal(done.lease_id, "");
  assert.equal(f.jobs.get(leased!.id).receipt.state, "succeeded");
  f.db.close();
});

test("expired Agent leases become unknown and cannot be completed", () => {
  const f = fixture();
  const job = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-2", operationID: "op-2", actions: [] });
  const leased = f.jobs.claim("agent-1", []);
  assert.ok(leased);
  f.advance(46);
  assert.equal(f.jobs.claim("agent-1", []), null);
  const unknown = f.jobs.get(job.id);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.receipt.code, "unknown_execution_result");
  assert.throws(() => f.jobs.result("agent-1", job.id, { lease_id: leased!.lease_id, state: "succeeded", summary: "late" }), /lease is invalid|expired/);
  f.db.close();
});
