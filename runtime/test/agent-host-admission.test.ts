import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { registerAgentCredentials } from "../src/server/agent-credentials.js";
import { registerManagedMachines, type SSHRunner } from "../src/server/managed-machines.js";
import { registerNodes } from "../src/server/nodes.js";
import { NodeStore } from "../src/server/nodes-model.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { registerOperations } from "../src/server/operations.js";
import type { OperationDefinition } from "../src/operations/types.js";
import { registerInstall } from "../src/server/install.js";
import type { Dependencies } from "../src/shared/types.js";

const at = new Date("2026-10-29T08:00:00.000Z");
const preflight = "LMSSH=1\nplatform=linux\narch=amd64\nlinux=1\nsupported_arch=1\ncurl=1\ntar=1\ngzip=1\nsha256sum=1\nsystemd=1\ninstall_privilege=1\nplatform_https=1\nagent_installation=absent\n";
async function fixture(t: any) {
  const db = new DB(":memory:"), router = new Router(), user = { id: "admin", name: "Admin", role: "admin" };
  const deps = { db, router, ...cipher(Buffer.alloc(32, 8)), now: () => at, externalURL: "https://monitor.example.test",
    auth: { user: () => user, requireAdmin(ctx: any) { if (ctx.user.role !== "admin") fail(403, "administrator required"); },
      validateKey() { return { id: "shared-sdk-key", name: "SDK", allowed_tables: [], allow_all_tables: true }; } },
    cat: { ensure: async () => {} }, ch: { insert: async () => {} }, logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const credentials = registerAgentCredentials(deps);
  const jobs = registerAgentJobs(deps, { agentCredentials: credentials });
  let runner: SSHRunner = async () => ({ stdout: preflight, stderr: "", stages: [] });
  const machines = registerManagedMachines(deps, { agentCredentials: credentials, sshRunner: input => runner(input) });
  const nodes = registerNodes(deps, { agentCredentials: credentials });
  const definition: OperationDefinition = { kind: "certificate", operations: ["inspect"], readOnly: ["inspect"], validate: value => value as any, publicConfig: value => value, validateInput: (_op, value) => value as any };
  const ops = registerOperations(deps, { jobs, credentials, definitions: [definition] });
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-host-admission-"));
  writeFileSync(join(directory, "install.sh"), "fixture-installer");
  registerInstall(deps, directory, credentials);
  const server = createServer(async (req, res) => { if (!await router.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => { ops.close?.(); jobs.close?.(); await nodes.close?.(); machines.close?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (path: string, method = "GET", body?: unknown, bearer?: string) => {
    const result = await fetch(base + "/api/v1" + path, { method, headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, data: await result.json() as any };
  };
  const host = async (name = "用户主机") => {
    const result = await request("/machines", "POST", { name, address: "ssh.example.test", username: "deploy", connection_method: "direct_ssh", host_key_fingerprint: "SHA256:abcdefghijklmnop" });
    assert.equal(result.status, 201); return result.data;
  };
  const issue = (machineID: string) => credentials.issueEnrollment({ endpoint_origin: deps.externalURL, version: "0.1.0", created_by: user.id, machine_id: machineID, previous_agent_id: machines.get(machineID).agent_id });
  const exchange = async (token: string, nonce = "fixture-nonce") => request("/agents/enroll", "POST", { enrollment_token: token, install_nonce: nonce, agent_public_key: "fixture-key", version: "0.1.0", arch: "amd64" });
  const activate = async (pending: any, nonce = "fixture-nonce") => request(`/agents/${pending.agent_id}/activate`, "POST", { install_nonce: nonce, health: { service: "ready", config_checked: true } }, pending.bootstrap_credential);
  const enroll = async (machineID: string) => {
    const token = issue(machineID), pending = await exchange(token.token_display_once); assert.equal(pending.status, 201);
    const active = await activate(pending.data); assert.equal(active.status, 200);
    return { agentID: pending.data.agent_id, token, control: active.data.control_credential, data: active.data.data_credential };
  };
  const register = (agent: {agentID:string;control:string}, body: any = {}) => request("/agents/register", "POST", { agent_id: agent.agentID, hostname: "same-hostname", host_id: "client-resource-id", platform: "linux", arch: "amd64", ...body }, agent.control);
  return { db, user, credentials, machines, jobs, ops, request, host, issue, exchange, activate, enroll, register, base, setRunner(value: SSHRunner) { runner = value; } };
}

test("host-bound enrollment claims only its server target and repeated registration never duplicates assets", async t => {
  const f = await fixture(t), a = await f.host("用户自定义 A"), b = await f.host("用户自定义 B");
  const agentA = await f.enroll(a.id), agentB = await f.enroll(b.id);
  assert.equal(f.machines.get(a.id).agent_id, agentA.agentID);
  const first = await f.register(agentA, { machine_id: b.id }); assert.equal(first.status, 200); assert.equal(first.data.machine_id, a.id);
  assert.equal((await f.register(agentB)).status, 200);
  const repeats = await Promise.all([f.register(agentA), f.register(agentA)]); assert.ok(repeats.every(result => result.status === 200));
  assert.equal(f.machines.list().length, 2); assert.equal(f.machines.get(a.id).name, "用户自定义 A");
  assert.equal(f.machines.get(a.id).observed_hostname, "same-hostname");
  assert.equal((await f.request(`/machines/${a.id}`, "PUT", { name: "改名后" })).status, 200);
  assert.equal((await f.register(agentA, { hostname: "new-observed-name", address: "attacker.example.test", username: "root" })).status, 200);
  assert.equal(f.machines.get(a.id).name, "改名后"); assert.equal(f.machines.get(a.id).address, "ssh.example.test"); assert.equal(f.machines.get(a.id).username, "deploy");
  new NodeStore(f.db, () => at); assert.equal(f.machines.list().length, 2);
  f.user.role = "member"; assert.equal((await f.request("/machines")).status, 403);
  const rows = (await f.request("/agents")).data;
  assert.equal(rows.find((row: any) => row.id === agentA.agentID).machine_name, "改名后");
  assert.deepEqual(new Set(rows.map((row: any) => row.machine_id)), new Set([a.id, b.id]));
  for (const row of rows) for (const field of ["address", "port", "username", "host_key_fingerprint", "credentials"]) assert.equal(Object.hasOwn(row, field), false);
});

test("unbound tokens, unknown shared-key nodes and persisted orphans cannot create host assets", async t => {
  const f = await fixture(t), host = await f.host(), token = f.issue(host.id);
  f.db.run("UPDATE agent_enrollments SET machine_id='' WHERE id=?", token.enrollment_id);
  assert.equal(f.credentials.canDownloadWithEnrollmentToken(token.token_display_once), false);
  assert.equal(f.credentials.enrollmentStatus(token.enrollment_id)?.status, "unavailable");
  const rejected = await f.exchange(token.token_display_once); assert.equal(rejected.status, 409); assert.match(rejected.data.error, /registered_host_required/);
  f.db.run("UPDATE agent_enrollments SET machine_id=? WHERE id=?", host.id, token.enrollment_id);
  const pending = await f.exchange(token.token_display_once); assert.equal(pending.status, 201);
  f.db.run("UPDATE agent_enrollments SET machine_id='' WHERE id=?", token.enrollment_id);
  assert.equal((await f.activate(pending.data)).status, 409);
  assert.equal((await f.exchange(token.token_display_once)).status, 409);
  const unknown = await f.request("/agents/register", "POST", { agent_id: "unknown", machine_id: host.id }, "shared-sdk-key"); assert.equal(unknown.status, 401);
  f.db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat,group_id) VALUES('orphan','resource','old-host','','linux','amd64',?,'{}','default')", at.toISOString());
  new NodeStore(f.db, () => at);
  assert.equal(f.machines.list().length, 1); assert.deepEqual((await f.request("/agents")).data, []);
  const store = new NodeStore(f.db, () => at);
  assert.throws(() => store.heartbeat("orphan", {}, "stale-auth"), /registered_host_required/);
  assert.equal(f.machines.list().length, 1); assert.ok(f.db.get("SELECT id FROM agents WHERE id='orphan'"));
});

test("Agent downloads require a valid server-reserved host token and never accept an SDK reporting key", async t => {
  const f = await fixture(t), host = await f.host(), token = f.issue(host.id), url = f.base + "/downloads/agent/install.sh";
  for (const headers of [{}, { authorization: "Bearer shared-sdk-key" }]) {
    const result = await fetch(url, { headers }); assert.equal(result.status, 401); await result.text();
  }
  const allowed = await fetch(url, { headers: { authorization: "Bearer " + token.token_display_once } }); assert.equal(allowed.status, 200); assert.equal(await allowed.text(), "fixture-installer");
  f.db.run("UPDATE agent_enrollments SET machine_id='' WHERE id=?", token.enrollment_id);
  const denied = await fetch(url, { headers: { authorization: "Bearer " + token.token_display_once } }); assert.equal(denied.status, 401); await denied.text();
});

test("Agent registration before SSH installation receipt remains bound to the originally registered host", async t => {
  const f = await fixture(t), host = await f.host("SSH 安装目标");
  const credential = await f.request(`/machines/${host.id}/credentials`, "POST", { method: "ssh_key", secret: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-secret\n-----END OPENSSH PRIVATE KEY-----", retention: "temporary" });
  assert.equal(credential.status, 201);
  let installedID = "";
  f.setRunner(async input => {
    if (!input.enrollmentToken) return { stdout: preflight, stderr: "", stages: [] };
    const row = f.db.get<any>("SELECT machine_id FROM agent_enrollments ORDER BY created_at DESC LIMIT 1"); assert.equal(row.machine_id, host.id);
    const pending = await f.exchange(input.enrollmentToken); assert.equal(pending.status, 201);
    const active = await f.activate(pending.data); assert.equal(active.status, 200); installedID = pending.data.agent_id;
    const registered = await f.register({ agentID: installedID, control: active.data.control_credential }); assert.equal(registered.status, 200); assert.equal(registered.data.machine_id, host.id);
    assert.equal(f.machines.list().length, 1);
    return { stdout: "installed", stderr: "", stages: ["installed"] };
  });
  const checked = await f.request(`/machines/${host.id}/ssh-check`, "POST", { credential_id: credential.data.credential_id }); assert.equal(checked.status, 200);
  const plan = await f.request(`/machines/${host.id}/deployments/plan`, "POST", { check_id: checked.data.id, credential_id: credential.data.credential_id, version: "0.1.0", arch: "amd64" }); assert.equal(plan.status, 201);
  const applied = await f.request(`/machines/${host.id}/deployments/${plan.data.id}/apply`, "POST", { confirm: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.data)); assert.equal(applied.data.status, "succeeded"); assert.equal(f.machines.list().length, 1); assert.equal(f.machines.get(host.id).agent_id, installedID);
});

test("deletion requires removing Agent identity and cannot resurrect a host on a later heartbeat", async t => {
  const f = await fixture(t), host = await f.host(), agent = await f.enroll(host.id); assert.equal((await f.register(agent)).status, 200);
  const denied = await f.request(`/machines/${host.id}`, "DELETE"); assert.equal(denied.status, 409); assert.match(denied.data.error, /先移除关联 Agent/);
  assert.equal((await f.request(`/agents/${agent.agentID}/remove`, "POST", { confirm: true })).status, 200);
  assert.equal((await f.request(`/machines/${host.id}`, "DELETE")).status, 200);
  assert.equal((await f.register(agent)).status, 401); assert.equal(f.machines.list().length, 0);
  new NodeStore(f.db, () => at); assert.equal(f.machines.list().length, 0);
});

test("changed or deleted reservations cannot activate or register and concurrent identities cannot claim one host", async t => {
  const f = await fixture(t), host = await f.host(), tokenA = f.issue(host.id), tokenB = f.issue(host.id);
  const pendingA = await f.exchange(tokenA.token_display_once, "a"), pendingB = await f.exchange(tokenB.token_display_once, "b");
  assert.equal((await f.activate(pendingA.data, "a")).status, 200);
  assert.equal((await f.activate(pendingB.data, "b")).status, 409);
  const other = await f.host(), token = f.issue(other.id), pending = await f.exchange(token.token_display_once);
  f.db.run("DELETE FROM managed_machines WHERE id=?", other.id);
  assert.equal((await f.activate(pending.data)).status, 409); assert.equal(f.credentials.canDownloadWithEnrollmentToken(token.token_display_once), false);
});

test("orphan and revoked identities cannot receive operations resources, plans or queued jobs", async t => {
  const f = await fixture(t), host = await f.host(), agent = await f.enroll(host.id); assert.equal((await f.register(agent)).status, 200);
  f.db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat,group_id) VALUES('orphan','same','orphan','','linux','amd64',?,'{}','default')", at.toISOString());
  const agents = await f.request("/operations/agents"); assert.equal(agents.status, 200); assert.deepEqual(agents.data.agents.map((value: any) => value.id), [agent.agentID]);
  const makeResource = (agentID: string) => f.request("/operations/resources", "POST", { kind: "certificate", name: "Cert", agent_id: agentID, config: {} });
  assert.equal((await makeResource("orphan")).status, 409);
  assert.throws(() => f.jobs.enqueue({ agentID: "orphan", deploymentID: "bad", operationID: "bad", actions: [] }), /registered_host_required/);
  const resource = await makeResource(agent.agentID); assert.equal(resource.status, 201);
  assert.equal((await f.request(`/agents/${agent.agentID}/credentials/revoke`, "POST", { audience: "control" })).status, 200);
  assert.deepEqual((await f.request("/operations/agents")).data.agents, []);
  assert.equal((await makeResource(agent.agentID)).status, 409);
  assert.throws(() => f.ops.plan(resource.data.resource.id, "inspect", {}, "admin"), /registered_host_required/);
  assert.throws(() => f.jobs.enqueue({ agentID: agent.agentID, deploymentID: "revoked", operationID: "revoked", actions: [] }), /registered_host_required/);
  f.db.run("UPDATE agent_enrollments SET machine_id='' WHERE id=?", agent.token.enrollment_id);
  assert.equal(f.credentials.has(agent.agentID, "data"), false);
  assert.throws(() => f.credentials.authenticate({ headers: { authorization: "Bearer " + agent.data } } as any, agent.agentID, "data"), /registered_host_required/);
});

test("a failed activated install can safely reinstall with the same host ID after fresh absent preflight", async t => {
  const f = await fixture(t), host = await f.host(), credential = await f.request(`/machines/${host.id}/credentials`, "POST", { method: "ssh_key", secret: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-secret\n-----END OPENSSH PRIVATE KEY-----", retention: "managed", confirm_managed: true });
  assert.equal(credential.status, 201);
  let failInstallation = true;
  const identities: string[] = [];
  f.setRunner(async input => {
    if (!input.enrollmentToken) return { stdout: preflight, stderr: "", stages: [] };
    const pending = await f.exchange(input.enrollmentToken); assert.equal(pending.status, 201);
    const active = await f.activate(pending.data); assert.equal(active.status, 200);
    identities.push(pending.data.agent_id);
    if (failInstallation) throw Error("transport lost after activation");
    assert.equal((await f.register({ agentID: pending.data.agent_id, control: active.data.control_credential })).status, 200);
    return { stdout: "installed", stderr: "", stages: [] };
  });
  const install = async () => {
    const check = await f.request(`/machines/${host.id}/ssh-check`, "POST", { credential_id: credential.data.credential_id }); assert.equal(check.status, 200);
    const plan = await f.request(`/machines/${host.id}/deployments/plan`, "POST", { check_id: check.data.id, credential_id: credential.data.credential_id, version: "0.1.0", arch: "amd64" }); assert.equal(plan.status, 201, JSON.stringify(plan.data));
    return f.request(`/machines/${host.id}/deployments/${plan.data.id}/apply`, "POST", { confirm: true });
  };
  assert.equal((await install()).status, 502); assert.equal(f.machines.get(host.id).agent_id, identities[0]);
  assert.equal(f.credentials.has(identities[0], "control"), false); assert.equal(f.credentials.has(identities[0], "data"), false);
  failInstallation = false; const retry = await install(); assert.equal(retry.status, 200, JSON.stringify(retry.data)); assert.equal(f.machines.get(host.id).agent_id, identities[1]); assert.notEqual(identities[0], identities[1]);
  assert.equal(f.machines.list().length, 1); assert.equal(f.db.get<any>("SELECT count(*) n FROM machine_deployments WHERE machine_id=?", host.id)!.n, 2);
});

test("retired Agent replacement retains host ID and plan snapshots reject a changed prior identity", async t => {
  const f = await fixture(t), host = await f.host(), old = await f.enroll(host.id); assert.equal((await f.register(old)).status, 200);
  assert.equal((await f.request(`/agents/${old.agentID}/credentials/revoke`, "POST", {})).status, 200);
  // A verified successful uninstall is historical evidence; a fresh preflight
  // must still prove that retained files were reviewed and the install is absent.
  f.db.run("INSERT INTO machine_uninstallations(id,machine_id,agent_id,credential_id,status,plan_json,created_at,created_by) VALUES('uninstalled',?,?,'old','succeeded','{}',?,'admin')", host.id, old.agentID, at.toISOString());
  const credential = await f.request(`/machines/${host.id}/credentials`, "POST", { method: "ssh_key", secret: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----", retention: "temporary" });
  const check = await f.request(`/machines/${host.id}/ssh-check`, "POST", { credential_id: credential.data.credential_id }); assert.equal(check.status, 200);
  const plan = await f.request(`/machines/${host.id}/deployments/plan`, "POST", { check_id: check.data.id, credential_id: credential.data.credential_id, version: "0.1.0", arch: "amd64" }); assert.equal(plan.status, 201, JSON.stringify(plan.data));
  f.db.run("UPDATE managed_machines SET agent_id='changed-agent' WHERE id=?", host.id);
  assert.equal((await f.request(`/machines/${host.id}/deployments/${plan.data.id}/apply`, "POST", { confirm: true })).status, 409);
  f.db.run("UPDATE managed_machines SET agent_id=? WHERE id=?", old.agentID, host.id);
  const replacement = await f.enroll(host.id); assert.equal((await f.register(replacement)).status, 200);
  assert.equal(f.machines.get(host.id).agent_id, replacement.agentID); assert.equal(f.machines.list().length, 1);
  assert.equal(f.machines.get(host.id).agent_status, "online"); assert.equal(f.machines.get(host.id).last_uninstallation_status, "");
  assert.equal((await f.register(old)).status, 401); assert.equal(f.db.get<any>("SELECT count(*) n FROM machine_uninstallations WHERE machine_id=?", host.id)!.n, 1);
  assert.equal((await f.request(`/machines/${host.id}/credentials/${credential.data.credential_id}`, "DELETE")).status, 200);
  assert.equal((await f.request(`/agents/${replacement.agentID}/credentials/revoke`, "POST", {})).status, 200);
  // The previous identity's successful uninstall is not proof that the newly
  // installed Agent is gone, even after revoking its credentials.
  assert.equal((await f.request(`/machines/${host.id}`, "DELETE")).status, 409);
});
