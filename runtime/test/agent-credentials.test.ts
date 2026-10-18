import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { registerAgentCredentials } from "../src/server/agent-credentials.js";
import type { Dependencies } from "../src/shared/types.js";

async function fixture(t: any) {
  const db = new DB(":memory:"), router = new Router(), user = {
    id: "admin-id",
    name: "admin",
    role: "admin",
  };
  const deps = {
    db,
    router,
    externalURL: "https://monitor.example.test",
    auth: {
      user: () => user,
      requireAdmin: () => {},
      validateKey: () => {
        throw Error("unused");
      },
      master: Buffer.alloc(32),
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
  const request = async (path: string, method: string, body?: any, headers: Record<string, string> = {}) => {
    const response = await fetch(endpoint + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : undefined };
  };
  return { db, store, request };
}

test("enrollment issues one-time bootstrap and separates control/data credentials", async (t) => {
  const f = await fixture(t);
  const created = await f.request("/api/v1/agent-enrollments", "POST", {
    endpoint_origin: "https://monitor.example.test",
    version: "0.1.0",
    allowed_arch: ["amd64"],
    scopes: ["agent.control", "agent.data"],
  });
  assert.equal(created.status, 201);
  assert.match(created.data.token_display_once, /^lm_enroll_/);
  assert.doesNotMatch(created.data.install_command_hint, /lm_enroll_/);
  assert.match(created.data.install_command_hint, /^sh install\.sh .*--release-url .*\/downloads\/agent/);
  assert.equal(
    f.store.canDownloadWithEnrollmentToken(created.data.token_display_once),
    true,
  );

  const first = await f.request("/api/v1/agents/enroll", "POST", {
    enrollment_token: created.data.token_display_once,
    install_nonce: "nonce-1",
    agent_public_key: "ed25519:fixture",
    version: "0.1.0",
    arch: "amd64",
  });
  assert.equal(first.status, 201);
  assert.match(first.data.bootstrap_credential, /^lm_bootstrap_/);
  const resumed = await f.request("/api/v1/agents/enroll", "POST", {
    enrollment_token: created.data.token_display_once,
    install_nonce: "nonce-1",
    agent_public_key: "ed25519:fixture",
    version: "0.1.0",
    arch: "amd64",
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.agent_id, first.data.agent_id);
  assert.match(resumed.data.bootstrap_credential, /^lm_bootstrap_/);
  assert.notEqual(resumed.data.bootstrap_credential, first.data.bootstrap_credential);

  const activated = await f.request(
    `/api/v1/agents/${first.data.agent_id}/activate`,
    "POST",
    {
      install_nonce: "nonce-1",
      health: { service: "ready", config_checked: true },
    },
    // The idempotent retry rotates the bootstrap secret. The installer must
    // use the credential from the latest enrollment response.
    { authorization: `Bearer ${resumed.data.bootstrap_credential}` },
  );
  assert.equal(activated.status, 200);
  assert.match(activated.data.control_credential, /^lm_agent_control_/);
  assert.match(activated.data.data_credential, /^lm_agent_data_/);

  const control = f.store.authenticate(
    { headers: { authorization: `Bearer ${activated.data.control_credential}` } } as any,
    first.data.agent_id,
    "control",
  );
  assert.equal(control.agent_id, first.data.agent_id);
  assert.throws(
    () =>
      f.store.authenticate(
        { headers: { authorization: `Bearer ${activated.data.control_credential}` } } as any,
        first.data.agent_id,
        "data",
      ),
    /invalid agent credential/,
  );

  const revoked = await f.request(
    `/api/v1/agents/${first.data.agent_id}/credentials/revoke`,
    "POST",
    { audience: "control", reason: "fixture" },
  );
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.revoked, 1);
  assert.throws(
    () =>
      f.store.authenticate(
        { headers: { authorization: `Bearer ${activated.data.control_credential}` } } as any,
        first.data.agent_id,
        "control",
      ),
    /invalid agent credential/,
  );
});

test("enrollment token cannot be replayed with a second nonce", async (t) => {
  const f = await fixture(t);
  const created = await f.request("/api/v1/agent-enrollments", "POST", {});
  assert.equal(created.status, 201);
  const first = await f.request("/api/v1/agents/enroll", "POST", {
    enrollment_token: created.data.token_display_once,
    install_nonce: "first",
    agent_public_key: "ed25519:fixture",
    version: "0.1.0",
    arch: "amd64",
  });
  assert.equal(first.status, 201);
  const replay = await f.request("/api/v1/agents/enroll", "POST", {
    enrollment_token: created.data.token_display_once,
    install_nonce: "second",
    agent_public_key: "ed25519:other",
    version: "0.1.0",
    arch: "amd64",
  });
  assert.equal(replay.status, 409);
});

test("enrollment cannot issue a credential subset the installer cannot persist", async (t) => {
  const f = await fixture(t);
  const created = await f.request("/api/v1/agent-enrollments", "POST", {
    scopes: ["agent.control"],
  });
  assert.equal(created.status, 400);
});
