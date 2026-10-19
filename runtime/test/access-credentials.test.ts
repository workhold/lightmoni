import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { fail, Router } from "../src/shared/http.js";
import { registerAgentCredentials } from "../src/server/agent-credentials.js";
import type { Dependencies } from "../src/shared/types.js";

async function fixture(t: any) {
  const db = new DB(":memory:");
  const router = new Router();
  let current = new Date("2026-10-19T08:00:00.000Z");
  const deps = {
    db,
    router,
    now: () => current,
    externalURL: "https://monitor.example.test",
    auth: {
      user: (req: any) => {
        const role = req.headers["x-test-role"];
        return role === "anonymous" ? undefined : { id: "user-1", name: "fixture", role: role ?? "admin" };
      },
      requireAdmin: (ctx: any) => {
        if (ctx.user.role !== "admin") fail(403, "administrator required");
      },
    },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const store = registerAgentCredentials(deps);
  const server = createServer(async (req, res) => {
    if (!(await router.handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const request = async (path: string, method = "GET", body?: any, headers: Record<string, string> = {}) => {
    const response = await fetch(endpoint + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any };
  };
  const issue = (expires_in_seconds = 24 * 60 * 60) => store.issueEnrollment({
    endpoint_origin: "https://monitor.example.test",
    version: "0.1.0",
    expires_in_seconds,
    created_by: "admin-id",
  });
  const enroll = (issued: ReturnType<typeof issue>) => request("/api/v1/agents/enroll", "POST", {
    enrollment_token: issued.token_display_once,
    install_nonce: "private-install-nonce",
    agent_public_key: "private-agent-public-key",
    version: "0.1.0",
    arch: "amd64",
  });
  const activate = (pending: { agent_id: string; bootstrap_credential: string }) => request(
    `/api/v1/agents/${pending.agent_id}/activate`,
    "POST",
    { install_nonce: "private-install-nonce", health: { service: "ready", config_checked: true } },
    { authorization: `Bearer ${pending.bootstrap_credential}` },
  );
  const changes = () => db.get<any>("SELECT total_changes() AS count")!.count;
  return { db, store, request, issue, enroll, activate, changes, setNow: (value: string) => { current = new Date(value); } };
}

test("credential management requires administrator access", async (t) => {
  const f = await fixture(t);
  for (const [path, method] of [
    ["/api/v1/agent-credentials", "GET"],
    ["/api/v1/agent-enrollments", "GET"],
    ["/api/v1/agent-enrollments/unknown/revoke", "POST"],
  ]) {
    assert.equal((await f.request(path, method, undefined, { "x-test-role": "member" })).status, 403);
    assert.equal((await f.request(path, method, undefined, { "x-test-role": "anonymous" })).status, 401);
  }
});

test("enrollment directory computes effective states without writes or secret fields", async (t) => {
  const f = await fixture(t);
  const issued = f.issue();
  const expired = f.issue(60);
  const pending = f.issue();
  await f.enroll(pending);
  const pendingExpired = f.issue();
  await f.enroll(pendingExpired);
  f.db.run("UPDATE agent_enrollments SET pending_expires_at=? WHERE id=?", "2026-10-19T08:01:00.000Z", pendingExpired.enrollment_id);
  const pendingTokenExpired = f.issue(60);
  await f.enroll(pendingTokenExpired);
  const active = f.issue();
  const activePending = await f.enroll(active);
  assert.equal((await f.activate(activePending.data)).status, 200);
  const cancelled = f.issue(60);
  assert.equal((await f.request(`/api/v1/agent-enrollments/${cancelled.enrollment_id}/revoke`, "POST")).status, 200);
  f.setNow("2026-10-19T08:01:00.000Z");
  const before = f.changes();
  const response = await f.request("/api/v1/agent-enrollments");
  assert.equal(response.status, 200);
  assert.equal(f.changes(), before);
  const states = Object.fromEntries(response.data.map((row: any) => [row.id, row.status]));
  assert.deepEqual(states, {
    [issued.enrollment_id]: "issued",
    [expired.enrollment_id]: "expired",
    [pending.enrollment_id]: "pending_activation",
    [pendingExpired.enrollment_id]: "expired",
    [pendingTokenExpired.enrollment_id]: "expired",
    [active.enrollment_id]: "active",
    [cancelled.enrollment_id]: "cancelled",
  });
  for (const row of response.data) {
    assert.deepEqual(Object.keys(row).sort(), [
      "id", "status", "endpoint_origin", "allowed_arch", "version", "initial_label_id", "scopes",
      "expires_at", "created_at", "used_at", "pending_expires_at", "agent_id",
    ].sort());
  }
  assert.doesNotMatch(JSON.stringify(response.data), /private-install-nonce|private-agent-public-key|lm_enroll_|lm_bootstrap_|token_hash|bootstrap_hash/);
  assert.equal(f.db.get<any>("SELECT status FROM agent_enrollments WHERE id=?", expired.enrollment_id)!.status, "issued");
  assert.equal(f.db.get<any>("SELECT status FROM agent_enrollments WHERE id=?", pendingExpired.enrollment_id)!.status, "pending_activation");
  assert.equal(f.store.enrollmentStatus(pendingTokenExpired.enrollment_id)!.status, "expired");
});

test("credential directory exposes the latest 200 metadata records with effective states and no writes", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 205; i++) {
    f.db.run(
      `INSERT INTO agent_credentials(id,agent_id,audience,scope,token_hash,created_at,last_used_at,expires_at,revoked_at,revoke_reason)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      `credential-${i}`, `agent-${i}`, "control", "agent.control", `secret-hash-${i}`,
      new Date(Date.parse("2026-10-19T07:00:00.000Z") + i * 1000).toISOString(),
      "2026-10-19T07:30:00.000Z", i === 203 || i === 202 ? "2026-10-19T08:00:00.000Z" : "2026-10-20T08:00:00.000Z",
      i === 202 ? "2026-10-19T07:55:00.000Z" : null, i === 202 ? "administrator revoked" : "",
    );
  }
  const before = f.changes();
  const response = await f.request("/api/v1/agent-credentials");
  assert.equal(response.status, 200);
  assert.equal(response.data.length, 200);
  assert.equal(response.data[0].id, "credential-204");
  assert.equal(response.data[199].id, "credential-5");
  assert.deepEqual(response.data.slice(0, 3).map((row: any) => row.status), ["active", "expired", "revoked"]);
  for (const row of response.data) {
    assert.deepEqual(Object.keys(row).sort(), [
      "id", "agent_id", "audience", "scope", "created_at", "last_used_at", "expires_at", "revoked_at", "revoke_reason", "status",
    ].sort());
  }
  assert.doesNotMatch(JSON.stringify(response.data), /secret-hash|token_hash|grace_until/);
  assert.equal(f.changes(), before);
});

test("revoking an issued token is idempotent and prevents enrollment and release authorization", async (t) => {
  const f = await fixture(t);
  const issued = f.issue(60);
  const path = `/api/v1/agent-enrollments/${issued.enrollment_id}/revoke`;
  assert.equal(f.store.canDownloadWithEnrollmentToken(issued.token_display_once), true);
  assert.deepEqual(await f.request(path, "POST"), { status: 200, data: { ok: true } });
  f.setNow("2026-10-19T08:02:00.000Z");
  const before = f.changes();
  assert.deepEqual(await f.request(path, "POST"), { status: 200, data: { ok: true } });
  assert.equal(f.changes(), before);
  assert.equal(f.store.canDownloadWithEnrollmentToken(issued.token_display_once), false);
  assert.notEqual((await f.enroll(issued)).status, 201);
  assert.equal(f.db.get<any>("SELECT count(*) AS count FROM agent_credentials")!.count, 0);
});

test("revoking a pending token prevents resume and activation with its existing bootstrap credential", async (t) => {
  const f = await fixture(t);
  const issued = f.issue();
  const pending = await f.enroll(issued);
  assert.equal(pending.status, 201);
  assert.deepEqual(await f.request(`/api/v1/agent-enrollments/${issued.enrollment_id}/revoke`, "POST"), { status: 200, data: { ok: true } });
  assert.equal((await f.enroll(issued)).status, 409);
  assert.equal((await f.activate(pending.data)).status, 401);
  assert.equal(f.store.canDownloadWithEnrollmentToken(issued.token_display_once), false);
  assert.equal(f.db.get<any>("SELECT count(*) AS count FROM agent_credentials")!.count, 0);
});

test("revoke rejects missing, active and expired enrollments without revoking node credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/v1/agent-enrollments/missing/revoke", "POST")).status, 404);
  const active = f.issue();
  const pending = await f.enroll(active);
  assert.equal((await f.activate(pending.data)).status, 200);
  const expired = f.issue(60);
  const pendingExpired = f.issue();
  await f.enroll(pendingExpired);
  f.setNow("2026-10-19T08:15:00.000Z");
  const before = f.changes();
  for (const row of [active, expired, pendingExpired])
    assert.equal((await f.request(`/api/v1/agent-enrollments/${row.enrollment_id}/revoke`, "POST")).status, 409);
  assert.equal(f.changes(), before);
  assert.equal(f.db.get<any>("SELECT count(*) AS count FROM agent_credentials WHERE revoked_at IS NULL")!.count, 2);
});

test("pending tokens reject resume and activation when either authorization deadline expires", async (t) => {
  for (const expiresIn of [60, 24 * 60 * 60]) {
    const f = await fixture(t);
    const issued = f.issue(expiresIn);
    const pending = await f.enroll(issued);
    assert.equal(pending.status, 201);
    f.setNow(expiresIn === 60 ? "2026-10-19T08:01:00.000Z" : "2026-10-19T08:15:00.000Z");
    assert.equal((await f.enroll(issued)).status, 401);
    assert.equal((await f.activate(pending.data)).status, 401);
    assert.equal(f.store.canDownloadWithEnrollmentToken(issued.token_display_once), false);
    assert.equal(f.db.get<any>("SELECT count(*) AS count FROM agent_credentials")!.count, 0);
  }
});

test("existing node credential revocation still covers all credentials of the chosen audience", async (t) => {
  const f = await fixture(t);
  const issued = f.issue();
  const pending = await f.enroll(issued);
  assert.equal((await f.activate(pending.data)).status, 200);
  f.db.run(
    `INSERT INTO agent_credentials(id,agent_id,audience,scope,token_hash,created_at,expires_at)
     SELECT 'second-control',agent_id,audience,scope,'second-hash',created_at,expires_at FROM agent_credentials WHERE audience='control'`,
  );
  const result = await f.request(`/api/v1/agents/${pending.data.agent_id}/credentials/revoke`, "POST", { audience: "control", reason: "credential test" });
  assert.equal(result.status, 200);
  assert.equal(result.data.revoked, 2);
  const listed = await f.request("/api/v1/agent-credentials");
  assert.equal(listed.data.filter((row: any) => row.audience === "control" && row.status === "revoked").length, 2);
  assert.equal(listed.data.filter((row: any) => row.audience === "data" && row.status === "active").length, 1);
});
