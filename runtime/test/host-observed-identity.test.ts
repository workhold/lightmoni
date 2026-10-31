import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import type { Dependencies } from "../src/shared/types.js";
import { registerAgentCredentials } from "../src/server/agent-credentials.js";
import { currentAgentHostname } from "../src/server/agent-hosts.js";
import { recordSSHHostNetwork } from "../src/server/host-network.js";
import { registerManagedMachines } from "../src/server/managed-machines.js";
import { registerNodes } from "../src/server/nodes.js";

async function fixture(t: any) {
  const db = new DB(":memory:"), router = new Router(), at = new Date("2026-10-31T10:00:00.000Z");
  const user = { id: "admin", name: "Admin", role: "admin" };
  const deps = {
    db, router, ...cipher(Buffer.alloc(32, 29)), now: () => at, externalURL: "https://platform.fixture",
    auth: { user: () => user, requireAdmin(ctx: any) { if (ctx.user.role !== "admin") fail(403, "administrator required"); } },
    cat: { ensure: async () => {}, list: async () => [] }, ch: { insert: async () => {} },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const credentials = registerAgentCredentials(deps);
  const machines = registerManagedMachines(deps, { agentCredentials: credentials });
  const nodes = registerNodes(deps, { agentCredentials: credentials });
  const server = createServer(async (req, res) => { if (!await router.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await nodes.close?.(); machines.close?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  const request = async (path: string, method = "GET", body?: unknown, bearer?: string) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any };
  };
  const hostResponse = await request("/machines", "POST", { name: "用户设置的开发机", address: "ssh.fixture", username: "deploy" });
  assert.equal(hostResponse.status, 201);
  const host = hostResponse.data;
  const enroll = async () => {
    const token = credentials.issueEnrollment({ endpoint_origin: deps.externalURL, version: "0.1.0", created_by: user.id, machine_id: host.id, previous_agent_id: machines.get(host.id).agent_id });
    const pending = await request("/agents/enroll", "POST", { enrollment_token: token.token_display_once, install_nonce: "identity-fixture", agent_public_key: "fixture-key", version: "0.1.0", arch: "amd64" });
    assert.equal(pending.status, 201, JSON.stringify(pending.data));
    const active = await request(`/agents/${pending.data.agent_id}/activate`, "POST", { install_nonce: "identity-fixture", health: { service: "ready", config_checked: true } }, pending.data.bootstrap_credential);
    assert.equal(active.status, 200, JSON.stringify(active.data));
    return { id: pending.data.agent_id as string, control: active.data.control_credential as string };
  };
  const register = (agent: { id: string; control: string }, body: Record<string, unknown>) => request("/agents/register", "POST", { agent_id: agent.id, platform: "linux", arch: "amd64", ...body }, agent.control);
  return { db, machines, request, host, enroll, register };
}

test("replacement activation clears the prior hostname before registration and keeps platform asset identity", async t => {
  const f = await fixture(t), retired = await f.enroll();
  assert.equal((await f.register(retired, { hostname: "old-system-host" })).status, 200);
  assert.equal(f.machines.get(f.host.id).observed_hostname, "old-system-host");
  assert.equal((await f.request(`/agents/${retired.id}/credentials/revoke`, "POST", {})).status, 200);
  const replacement = await f.enroll();
  assert.notEqual(replacement.id, retired.id);
  assert.equal(f.db.get<{ observed_hostname: string }>("SELECT observed_hostname FROM managed_machines WHERE id=?", f.host.id)!.observed_hostname, "");
  assert.equal(f.machines.get(f.host.id).observed_hostname, "");
  assert.equal(currentAgentHostname(f.db, f.host.id, retired.id), "");
  assert.equal((await f.register(retired, { hostname: "late-retired-name" })).status, 401);
  assert.equal((await f.register(replacement, { hostname: "new-system-host", machine_id: "other-host", name: "replace-user-name", address: "other.fixture", username: "root", host_id: "client-resource-id" })).status, 200);
  const current = f.machines.get(f.host.id);
  assert.deepEqual({ id: current.id, name: current.name, address: current.address, username: current.username, hostname: current.observed_hostname },
    { id: f.host.id, name: "用户设置的开发机", address: "ssh.fixture", username: "deploy", hostname: "new-system-host" });
  assert.equal(f.machines.list().length, 1);
});

test("removed Agent hostname cannot return through a late heartbeat or suppress independent SSH observations", async t => {
  const f = await fixture(t), agent = await f.enroll();
  assert.equal((await f.register(agent, { hostname: "retired-system-host" })).status, 200);
  f.db.run("UPDATE managed_machines SET host_key_fingerprint='SHA256:fixture' WHERE id=?", f.host.id);
  assert.equal(recordSSHHostNetwork(f.db, { id: f.host.id, ssh_target_generation: 0, host_key_fingerprint: "SHA256:fixture" },
    { hostname: "ssh-system-host", addresses: [{ interface: "eth0", address: "10.3.4.5", family: "IPv4", scope: "private" }], observed_at: "2026-10-31T10:00:00.000Z" }), true);
  assert.equal((await f.request(`/agents/${agent.id}/remove`, "POST", { confirm: true })).status, 200);
  assert.equal(currentAgentHostname(f.db, f.host.id, agent.id), "");
  assert.equal(f.machines.get(f.host.id).observed_hostname, "");
  assert.equal((await f.register(agent, { hostname: "late-removed-name" })).status, 401);
  assert.equal(f.machines.get(f.host.id).observed_hostname, "");
  assert.equal(f.machines.get(f.host.id).name, "用户设置的开发机");
  assert.equal(f.machines.get(f.host.id).network.hostname, "ssh-system-host");
  assert.equal(f.machines.get(f.host.id).network.observed_via, "ssh");
  assert.deepEqual(f.machines.get(f.host.id).network.private_ips, ["10.3.4.5"]);
  const replacement = await f.enroll();
  assert.equal(f.machines.get(f.host.id).agent_id, replacement.id);
  assert.equal(f.machines.get(f.host.id).observed_hostname, "");
  assert.equal(f.machines.get(f.host.id).network.hostname, "ssh-system-host");
});

test("hostname reads use the bound Agent record and ignore stale unowned caches", async t => {
  const f = await fixture(t), agent = await f.enroll();
  assert.equal((await f.register(agent, { hostname: "current-system-host" })).status, 200);
  f.db.run("UPDATE managed_machines SET observed_hostname='stale-owner-host' WHERE id=?", f.host.id);
  assert.equal(currentAgentHostname(f.db, f.host.id, agent.id), "current-system-host");
  assert.equal(f.machines.get(f.host.id).observed_hostname, "current-system-host");
  f.db.run("UPDATE managed_machines SET agent_id='replacement-without-heartbeat' WHERE id=?", f.host.id);
  assert.equal(currentAgentHostname(f.db, f.host.id, agent.id), "");
  assert.equal(f.machines.get(f.host.id).observed_hostname, "");
  f.db.run("UPDATE managed_machines SET agent_id='' WHERE id=?", f.host.id);
  assert.equal(currentAgentHostname(f.db, f.host.id, ""), "");
  assert.equal(f.machines.get(f.host.id).observed_hostname, "");
});
