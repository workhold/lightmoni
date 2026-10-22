import { test } from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import type { Dependencies } from "../src/shared/types.js";

function fixture(expirySweepIntervalMs?: number) {
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
  return { db, deps, jobs: registerAgentJobs(deps, { agentCredentials: credentials, expirySweepIntervalMs }), advance(seconds: number) { current = new Date(current.getTime() + seconds * 1000); } };
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
  assert.equal(f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 1, phase: "accepted", summary: "job accepted" }).state, "accepted");
  const staged = f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 2, phase: "staging", summary: "artifact staged", snapshot: { digest: "sha256:…" } });
  assert.equal(staged.state, "staging");
  assert.throws(() => f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 3, phase: "accepted", summary: "late regression" }), /cannot move backwards/);
  const activating = f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 3, phase: "activating", summary: "activate release" });
  assert.equal(activating.state, "activating");
  const verifying = f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 4, phase: "verifying", summary: "health check" });
  assert.equal(verifying.state, "verifying");
  assert.throws(() => f.jobs.event("agent-1", leased!.id, { lease_id: leased!.lease_id, sequence: 6, phase: "verifying", summary: "sequence gap" }), /sequence has a gap/);
  const done = f.jobs.result("agent-1", leased!.id, { lease_id: leased!.lease_id, state: "succeeded", code: "", summary: "service active", snapshot: { active_state: "active", health: { healthy: true } } });
  assert.equal(done.state, "succeeded");
  assert.equal(done.lease_id, "");
  assert.equal(f.jobs.get(leased!.id).receipt.state, "succeeded");
  f.db.close();
});

test("success without verified health evidence becomes unknown and cancellation reports prior state", () => {
  const f = fixture();
  const updates: any[] = [];
  f.jobs.onUpdate((update) => updates.push(update));
  const malformed = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-malformed", operationID: "op-malformed", actions: [{ kind: "health_check" }] });
  const leased = f.jobs.claim("agent-1", []);
  assert.ok(leased);
  const invalid = f.jobs.result("agent-1", malformed.id, { lease_id: leased!.lease_id, state: "succeeded", summary: "claimed success", snapshot: { health: { healthy: true } } });
  assert.equal(invalid.state, "unknown");
  assert.equal(invalid.receipt.code, "invalid_agent_sequence");
  assert.equal(updates.at(-1).previousState, "leased");
  assert.equal(updates.at(-1).healthVerified, false);

  const queued = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-queued", operationID: "op-queued", actions: [] });
  f.jobs.cancel(queued.id, "admin");
  assert.equal(updates.at(-1).phase, "cancelled");
  assert.equal(updates.at(-1).previousState, "queued");
  const claimed = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-claimed-cancel", operationID: "op-claimed-cancel", actions: [] });
  const claimedLease = f.jobs.claim("agent-1", []);
  assert.ok(claimedLease);
  f.jobs.cancel(claimed.id, "admin");
  assert.equal(f.jobs.get(claimed.id).state, "unknown");
  assert.equal(f.jobs.get(claimed.id).receipt.code, "unknown_execution_result");
  assert.equal(updates.at(-1).phase, "unknown");
  assert.equal(updates.at(-1).previousState, "leased");
  const expired = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-expired", operationID: "op-expired", actions: [], expiresInSeconds: 60 });
  f.advance(61);
  assert.equal(f.jobs.claim("agent-1", []), null);
  assert.equal(f.jobs.get(expired.id).state, "cancelled");
  assert.equal(f.jobs.get(expired.id).receipt.code, "job_expired");
  assert.equal(updates.at(-1).previousState, "queued");
  f.db.close();
});

test("centre sweep expires lost Agent leases without waiting for another Agent request", async () => {
  const f = fixture(10);
  const job = f.jobs.enqueue({ agentID: "agent-1", deploymentID: "dep-offline", operationID: "op-offline", actions: [] });
  const leased = f.jobs.claim("agent-1", []);
  assert.ok(leased);
  f.advance(46);
  f.jobs.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.jobs.get(job.id).state, "unknown");
  } finally {
    f.jobs.close();
    f.db.close();
  }
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
