import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher, hash } from "../src/shared/crypto.js";
import type { Dependencies } from "../src/shared/types.js";
import { registerManagedMachines, type SSHRunner } from "../src/server/managed-machines.js";
import { NodeStore } from "../src/server/nodes-model.js";
import { createAgentUpdatesSchema } from "../src/server/machine-agent-updates.js";
import { AgentReleaseCatalog } from "../src/server/machine-agent-updates-catalog.js";
import { assertNoPendingAgentUpdate } from "../src/server/machine-agent-updates-guard.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { registerAgentJobs } from "./helpers/domain-jobs.js";
import { SCRIPT_TASK_CAPABILITY } from "../src/shared/task-center.js";

const OLD_BOOT = "11111111-1111-4111-8111-111111111111", NEW_BOOT = "22222222-2222-4222-8222-222222222222";
const oldRelease = { version: "0.1.0", source_revision: "1".repeat(40), build_id: "0.1.0-before", state_schema: 1,
  artifact_sha256: "1".repeat(64), arch: "amd64", fingerprint: "a".repeat(64), boot_id: OLD_BOOT };
const previousRelease = { ...oldRelease, artifact_sha256: "2".repeat(64), build_id: "0.1.0-previous", fingerprint: "b".repeat(64) };
type Mode = "success" | "rollback" | "wrong_build" | "same_boot" | "wrong_config" | "last_error" | "disconnect" | "missing_receipt" | "hold" | "failed" | "service_state_changed";

function releaseFiles(directory: string) {
  mkdirSync(directory, { recursive: true });
  const file = "lightmoni-agent_0.1.0_linux_amd64.tar.gz", bytes = Buffer.from("approved immutable agent archive");
  writeFileSync(join(directory, file), bytes);
  writeFileSync(join(directory, "update.sh"), "#!/bin/sh\n# trusted updater\n");
  writeFileSync(join(directory, "update-runner.mjs"), "// trusted maintenance worker\n");
  const release = { version: "0.1.0", source_revision: "3".repeat(40), build_id: "0.1.0-new-build", state_schema: 1,
    platform: "linux", arch: "amd64", file, sha256: hash(bytes), size: bytes.length, build_time: "2026-10-30T00:00:00Z" };
  writeFileSync(join(directory, "agent-releases.json"), JSON.stringify({ schema: 1, releases: [release] }));
  return release;
}
async function fixture(t: any, healthTimeout = 300, uninstallerUpdated?: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-agent-updates-")), downloads = join(directory, "downloads"), release = releaseFiles(downloads);
  const db = new DB(":memory:"), router = new Router(), user = { id: "admin", name: "Admin", role: "admin" };
  let clock = new Date("2026-10-30T00:00:00Z"), origin = "";
  const deps = { db, router, ...cipher(Buffer.alloc(32, 5)), now: () => clock, externalURL: "https://lightmoni.example.test",
    auth: { user: () => user, requireAdmin(ctx: any) { if (ctx.user.role !== "admin") fail(403, "admin required"); } },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const nodes = new NodeStore(db, deps.now), modes = new Map<string, Mode>(), calls: any[] = [], observations = new Map<string, any>(), states = new Map<string, any>();
  const credentials = { has: () => true, authenticate: () => ({}) } as any;
  let downloadHook: ((input: any, operation: any) => Promise<void>) | undefined;
  const heartbeat = (operation: any, status: any, mode: Mode) => {
    const revision = nodes.effective(operation.agent_id).config.revision;
    const value = { agent_id: operation.agent_id, version: status.target.version, release: { ...status.target },
      boot_id: mode === "same_boot" ? OLD_BOOT : NEW_BOOT, last_error: mode === "last_error" ? "report temporarily failed" : "",
      config_revision: mode === "wrong_config" ? "outdated" : revision, task_capabilities: [SCRIPT_TASK_CAPABILITY] };
    if (mode === "wrong_build") value.release.build_id = "unapproved-build";
    db.run("UPDATE agents SET version=?,heartbeat=?,last_seen=? WHERE id=?", status.target.version, JSON.stringify(value), clock.toISOString(), operation.agent_id);
  };
  const runner: SSHRunner = async input => {
    calls.push(input);
    const mid = input.machine.id, mode = modes.get(mid) ?? "success";
    if (input.command.includes("unmanaged_installation")) return { stdout: JSON.stringify(observations.get(mid)), stderr: "", stages: ["probe"] };
    const operation = db.get<any>("SELECT * FROM machine_agent_updates WHERE machine_id=? AND status IN ('running','verifying','unknown') ORDER BY rowid DESC LIMIT 1", mid);
    if (!operation) throw Error("fixture operation missing");
    const body = JSON.parse(operation.plan_json);
    if (input.command.includes(".update-bootstrap.XXXXXX")) {
      if (downloadHook) await downloadHook(input, operation);
      if (mode === "missing_receipt") throw Error("connection lost before start receipt");
      const state = { schema: 1, operation_id: operation.id, agent_id: operation.agent_id, status: "accepted", from: body.current,
        target: { version: body.target.version, source_revision: body.target.source_revision, build_id: body.target.build_id, state_schema: 1,
          artifact_sha256: body.target.artifact_sha256 ?? body.target.sha256, arch: body.target.arch },
        local_health: { service_active: false, identity_matches: false, release_matches: false, boot_id: "" },
        started_at: clock.toISOString(), updated_at: clock.toISOString() };
      states.set(operation.id, state);
      if (mode === "disconnect") throw Error("connection lost after detached start");
      return { stdout: JSON.stringify(state), stderr: "", stages: ["start"] };
    }
    const state = states.get(operation.id);
    if (!state) throw Error("receipt does not exist");
    if (input.command.includes("update-runner.mjs commit")) {
      state.commit_requested = true;
      return { stdout: JSON.stringify(state), stderr: "", stages: ["commit_request"] };
    }
    if (input.command.includes("update-runner.mjs status")) {
      if (mode === "hold" || mode === "disconnect") return { stdout: JSON.stringify(state), stderr: "", stages: ["status"] };
      if (mode === "failed") state.status = "failed";
      else if (mode === "service_state_changed") {
        state.status = "failed"; state.error_code = "service_state_changed";
        observations.get(mid).service_active = false;
      }
      else if (mode === "rollback") {
        state.status = "rolled_back"; state.restored_fingerprint = body.current.fingerprint;
        state.local_health = { service_active: body.current.service_active !== false, identity_matches: true, release_matches: true, boot_id: NEW_BOOT };
      } else {
        state.status = state.commit_requested ? "succeeded" : "waiting_confirmation";
        state.local_health = { service_active: true, identity_matches: true, release_matches: true, boot_id: mode === "same_boot" ? OLD_BOOT : NEW_BOOT };
        heartbeat(operation, state, mode);
      }
      if (uninstallerUpdated !== undefined) state.uninstaller_updated = uninstallerUpdated;
      return { stdout: JSON.stringify(state), stderr: "", stages: ["status"] };
    }
    throw Error("unexpected fixture SSH command");
  };
  const machines = registerManagedMachines(deps, { sshRunner: runner, agentCredentials: credentials, downloadsDir: downloads,
    dataDir: directory, updatePollIntervalMs: 5, updateHealthTimeoutMs: healthTimeout });
  const server = createServer(async (req, res) => { if (!await router.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); origin = "http://127.0.0.1:" + (server.address() as any).port;
  t.after(async () => { await machines.close?.(); server.closeAllConnections(); server.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (path: string, method = "GET", body?: any, headers: Record<string, string> = {}) => {
    const response = await fetch(origin + "/api/v1" + path, { method, headers: { ...(body == null ? {} : { "content-type": "application/json" }), ...headers }, body: body == null ? undefined : JSON.stringify(body) });
    const raw = await response.text(); let data: any; try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: response.status, raw, data };
  };
  const host = async (name = "test-host") => {
    const created = await request("/machines", "POST", { name, address: name + ".example.test", username: "root" }); assert.equal(created.status, 201, created.raw);
    const mid = created.data.id, agent = "agent-" + mid;
    const credential = await request(`/machines/${mid}/credentials`, "POST", { method: "password", secret: "  actual-login-secret\t", retention: "managed", confirm_managed: true });
    assert.equal(credential.status, 201, credential.raw);
    db.run("UPDATE managed_machines SET agent_id=?,platform='linux',arch='amd64',host_key_fingerprint=? WHERE id=?", agent, "SHA256:fixture-server-identity", mid);
    db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES(?,?,?,'0.1.0','linux','amd64',?,?)", agent, "identity-" + mid, name, clock.toISOString(), JSON.stringify({ version: "0.1.0", boot_id: OLD_BOOT, release: oldRelease, task_capabilities: [SCRIPT_TASK_CAPABILITY] }));
    observations.set(mid, { schema: 1, ready: true, agent_id: agent, arch: "amd64", service_active: true, lifecycle_locked: false, operation_lock: false,
      current: { ...oldRelease }, previous: { ...previousRelease } });
    return { id: mid, agent, credential: credential.data.credential_id };
  };
  const plan = (mid: string, action = "upgrade") => request(`/machines/${mid}/agent-updates/plan`, "POST", { action, ...(action === "upgrade" ? { target_sha256: release.sha256 } : {}) });
  const apply = (mid: string, operationID: string) => request(`/machines/${mid}/agent-updates/${operationID}/apply`, "POST", { confirm: true });
  const settle = async (mid: string, operationID: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const operation = (await request(`/machines/${mid}/agent-updates/${operationID}`)).data;
      if (!["running", "verifying"].includes(operation.status)) return operation;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error("update fixture did not settle");
  };
  return { directory, downloads, release, db, deps, user, nodes, machines, request, host, plan, apply, settle, modes, calls, observations, states, credentials,
    advance(seconds: number) { clock = new Date(clock.getTime() + seconds * 1000); },
    setDownloadHook(hook: typeof downloadHook) { downloadHook = hook; }, origin };
}

test("catalog distinguishes a new build at the same version and pins archive plus maintenance scripts", t => {
  const root = mkdtempSync(join(tmpdir(), "lm-update-catalog-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const downloads = join(root, "downloads"), release = releaseFiles(downloads), catalog = new AgentReleaseCatalog(downloads, join(root, "cache"));
  assert.equal(catalog.list()[0].version, oldRelease.version); assert.notEqual(catalog.list()[0].sha256, oldRelease.artifact_sha256);
  const pinned = catalog.pin(release.sha256);
  writeFileSync(join(downloads, release.file), "replaced after approval");
  writeFileSync(join(downloads, "update.sh"), "replaced updater");
  assert.equal(catalog.list().length, 0);
  assert.equal(readFileSync(catalog.verify(pinned.files["bundle.tar.gz"]), "utf8"), "approved immutable agent archive");
  assert.match(readFileSync(catalog.verify(pinned.files["update.sh"]), "utf8"), /trusted updater/);
  writeFileSync(catalog.path(pinned.files["bundle.tar.gz"]), "tampered cache");
  assert.throws(() => catalog.verify(pinned.files["bundle.tar.gz"]), /被修改/);
});

test("same-version approved upgrade commits only after new boot, exact release and synchronized control config", async t => {
  const f = await fixture(t), h = await f.host();
  const proposed = await f.plan(h.id); assert.equal(proposed.status, 201, proposed.raw); const operation = proposed.data;
  assert.equal(operation.plan.target.sha256, f.release.sha256); assert.equal(operation.plan.current.release.build_id, oldRelease.build_id);
  assert.equal(operation.plan.target.version, oldRelease.version); assert.notEqual(operation.plan.target.build_id, oldRelease.build_id);
  assert.equal(proposed.raw.includes("actual-login-secret"), false); assert.equal(proposed.raw.includes("lm_update_"), false);
  assert.equal((await f.apply(h.id, operation.id)).status, 202);
  const finished = await f.settle(h.id, operation.id); assert.equal(finished.status, "succeeded", JSON.stringify(finished));
  assert.equal(finished.receipt.local_health.boot_id, NEW_BOOT);
  assert.equal(f.calls.filter(input => input.command.includes("update-runner.mjs commit")).length, 1);
  assert.ok(f.calls.some(input => input.command.includes(".update-bootstrap") && input.stdin.includes("lm_update_")));
  assert.ok(f.calls.every(input => !input.command.includes("lm_update_") && !input.command.includes("actual-login-secret")));
  assert.equal(f.db.get<any>("SELECT ticket_hash FROM machine_agent_updates WHERE id=?", operation.id)!.ticket_hash, "");
  assert.equal(f.machines.get(h.id).agent_id, h.agent); assert.equal(f.machines.get(h.id).agent_release.build_id, f.release.build_id);
  assert.equal((await f.apply(h.id, operation.id)).status, 409);
  assert.equal(f.calls.filter(input => input.command.includes(".update-bootstrap")).length, 1);
});

for (const updated of [false, true]) test(`HTTP maintenance receipt retains uninstaller_updated=${updated}`, async t => {
  const f = await fixture(t, 300, updated), h = await f.host(), proposed = await f.plan(h.id);
  assert.equal(proposed.status, 201, proposed.raw);
  assert.equal((await f.apply(h.id, proposed.data.id)).status, 202);
  const finished = await f.settle(h.id, proposed.data.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.receipt.uninstaller_updated, updated);
  assert.equal(JSON.parse(f.db.get<any>("SELECT receipt_json FROM machine_agent_updates WHERE id=?", proposed.data.id)!.receipt_json).uninstaller_updated, updated);
});

test("maintenance records successful SSH use in both the host binding and shared credential library", async t => {
  const f = await fixture(t), h = await f.host(), untouched = await f.host("untouched-host");
  const source = f.db.get<{ connection_credential_id: string }>("SELECT connection_credential_id FROM machine_credentials WHERE id=?", h.credential)!.connection_credential_id;
  const unused = f.db.get<{ connection_credential_id: string }>("SELECT connection_credential_id FROM machine_credentials WHERE id=?", untouched.credential)!.connection_credential_id;
  assert.ok(source); assert.notEqual(source, unused);
  const usedAt = () => ({
    binding: f.db.get<{ last_used_at: string }>("SELECT last_used_at FROM machine_credentials WHERE id=?", h.credential)!.last_used_at,
    library: f.db.get<{ last_used_at: string }>("SELECT last_used_at FROM connection_credentials WHERE id=?", source)!.last_used_at,
  });
  assert.deepEqual(usedAt(), { binding: "", library: "" });
  f.advance(5);
  const operation = await f.plan(h.id); assert.equal(operation.status, 201, operation.raw);
  assert.deepEqual(usedAt(), { binding: f.deps.now().toISOString(), library: f.deps.now().toISOString() });
  f.advance(5);
  assert.equal((await f.apply(h.id, operation.data.id)).status, 202);
  assert.equal((await f.settle(h.id, operation.data.id)).status, "succeeded");
  const expected = f.deps.now().toISOString();
  assert.deepEqual(usedAt(), { binding: expected, library: expected });
  const listed = await f.request("/connection-credentials"); assert.equal(listed.status, 200);
  assert.equal(listed.data.find((credential: any) => credential.id === source).last_used_at, expected);
  assert.equal(listed.data.find((credential: any) => credential.id === unused).last_used_at, "");
});

test("revoking a shared credential cancels its pending maintenance before any remote start", async t => {
  const f = await fixture(t), h = await f.host();
  const operation = await f.plan(h.id); assert.equal(operation.status, 201, operation.raw);
  const source = f.db.get<{ connection_credential_id: string }>("SELECT connection_credential_id FROM machine_credentials WHERE id=?", h.credential)!.connection_credential_id;
  assert.equal((await f.request(`/connection-credentials/${source}/revoke`, "POST", { confirm: true })).status, 200);
  const saved = await f.request(`/machines/${h.id}/agent-updates/${operation.data.id}`);
  assert.equal(saved.data.status, "cancelled");
  assert.equal((await f.apply(h.id, operation.data.id)).status, 409);
  assert.equal(f.calls.some(call => call.command.includes(".update-bootstrap")), false);
});

for (const mode of ["wrong_build", "same_boot", "wrong_config", "last_error"] as const) test(`health gate refuses ${mode} and never sends commit`, async t => {
  const f = await fixture(t, 45), h = await f.host(); f.modes.set(h.id, mode);
  const operation = (await f.plan(h.id)).data;
  assert.equal((await f.apply(h.id, operation.id)).status, 202);
  const finished = await f.settle(h.id, operation.id); assert.equal(finished.status, "unknown");
  assert.equal(f.calls.some(input => input.command.includes("update-runner.mjs commit")), false);
  assert.equal(f.machines.get(h.id).capabilities.update_agent.reason, "agent_update_pending");
});

test("automatic rollback needs restored program fingerprint, preserves identity and does not claim upgrade success", async t => {
  const f = await fixture(t), h = await f.host(); f.modes.set(h.id, "rollback");
  const operation = (await f.plan(h.id)).data; await f.apply(h.id, operation.id);
  const result = await f.settle(h.id, operation.id); assert.equal(result.status, "rolled_back");
  assert.equal(result.receipt.restored_fingerprint, oldRelease.fingerprint); assert.equal(f.machines.get(h.id).agent_id, h.agent);
  assert.equal(f.calls.some(input => input.command.includes("update-runner.mjs commit")), false);
});

test("plan validation covers replay, expiry, changed program, architecture and unsupported rollback identity", async t => {
  const f = await fixture(t), h = await f.host();
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/plan`, "POST", { action: "upgrade", target_sha256: "latest" })).status, 400);
  f.observations.get(h.id).arch = "arm64"; assert.equal((await f.plan(h.id)).status, 409); f.observations.get(h.id).arch = "amd64";
  const p = (await f.plan(h.id)).data;
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/${p.id}/apply`, "POST", { confirm: false })).status, 400);
  f.observations.get(h.id).current.fingerprint = "c".repeat(64);
  assert.equal((await f.apply(h.id, p.id)).status, 409); assert.equal(f.calls.filter(input => input.command.includes(".update-bootstrap")).length, 0);
  await f.request(`/machines/${h.id}/agent-updates/${p.id}/cancel`, "POST", {}); f.observations.get(h.id).current.fingerprint = oldRelease.fingerprint;
  const expired = (await f.plan(h.id)).data; f.advance(901); assert.equal((await f.apply(h.id, expired.id)).status, 409);
  await f.request(`/machines/${h.id}/agent-updates/${expired.id}/cancel`, "POST", {});
  f.observations.get(h.id).previous.source_revision = "";
  assert.equal((await f.plan(h.id, "rollback")).status, 409);
});

test("explicit rollback is separately reviewed and goes through the same new-process confirmation", async t => {
  const f = await fixture(t), h = await f.host();
  const proposed = await f.plan(h.id, "rollback"); assert.equal(proposed.status, 201, proposed.raw);
  assert.equal(proposed.data.plan.target.sha256, previousRelease.artifact_sha256); assert.equal(proposed.data.plan.files["bundle.tar.gz"], undefined);
  await f.apply(h.id, proposed.data.id);
  assert.equal((await f.settle(h.id, proposed.data.id)).status, "succeeded");
});

test("a failed installed service can be explicitly rolled back to a healthy retained release", async t => {
  const f = await fixture(t), h = await f.host();
  f.observations.get(h.id).service_active = false;
  f.observations.get(h.id).current.boot_id = "";
  assert.equal((await f.plan(h.id)).status, 409, "upgrade still requires a healthy source");
  const proposed = await f.plan(h.id, "rollback"); assert.equal(proposed.status, 201, proposed.raw);
  assert.equal((await f.apply(h.id, proposed.data.id)).status, 202);
  assert.equal((await f.settle(h.id, proposed.data.id)).status, "succeeded");
});

test("failed rollback from an inactive source restores its original stopped state without an unknown deadlock", async t => {
  const f = await fixture(t), h = await f.host();
  f.observations.get(h.id).service_active = false; f.observations.get(h.id).current.boot_id = "";
  f.modes.set(h.id, "rollback");
  const p = (await f.plan(h.id, "rollback")).data;
  assert.equal(p.plan.current.service_active, false);
  assert.equal((await f.apply(h.id, p.id)).status, 202);
  const result = await f.settle(h.id, p.id);
  assert.equal(result.status, "rolled_back", JSON.stringify(result));
  assert.equal(result.receipt.local_health.service_active, false);
  assert.match(result.error, /仍停止/);
  assert.equal(f.machines.get(h.id).capabilities.update_agent.reason, "");
});

for (const beforeActive of [true, false]) test(`rollback plan rejects ${beforeActive ? "active to inactive" : "inactive to active"} source changes before dispatch`, async t => {
  const f = await fixture(t), h = await f.host();
  f.observations.get(h.id).service_active = beforeActive;
  const proposed = await f.plan(h.id, "rollback"); assert.equal(proposed.status, 201, proposed.raw);
  f.observations.get(h.id).service_active = !beforeActive;
  const rejected = await f.apply(h.id, proposed.data.id);
  assert.equal(rejected.status, 409, rejected.raw);
  assert.match(rejected.raw, /服务运行状态已变化/);
  assert.equal(f.calls.some(input => input.command.includes(".update-bootstrap")), false);
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/${proposed.data.id}`)).data.status, "awaiting_approval");
});

test("a worker source-state rejection confirms unchanged inactive source as failed without an unknown fence", async t => {
  const f = await fixture(t), h = await f.host(); f.modes.set(h.id, "service_state_changed");
  const p = (await f.plan(h.id)).data;
  assert.equal((await f.apply(h.id, p.id)).status, 202);
  const result = await f.settle(h.id, p.id);
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.receipt.error_code, "service_state_changed");
  assert.equal(f.observations.get(h.id).service_active, false);
  assert.equal(f.machines.get(h.id).capabilities.update_agent.reason, "");
  assert.equal(f.calls.some(input => input.command.includes("update-runner.mjs commit")), false);
});

test("a disconnected worker source-state rejection reconciles an unchanged inactive source as failed", async t => {
  const f = await fixture(t), h = await f.host(); f.modes.set(h.id, "disconnect");
  const p = (await f.plan(h.id)).data;
  assert.equal((await f.apply(h.id, p.id)).data.status, "unknown");
  const remote = f.states.get(p.id); remote.status = "failed"; remote.error_code = "service_state_changed";
  f.observations.get(h.id).service_active = false;
  const before = f.calls.length;
  const result = await f.request(`/machines/${h.id}/agent-updates/${p.id}/reconcile`, "POST", {});
  assert.equal(result.data.status, "failed", result.raw);
  assert.equal(result.data.receipt.error_code, "service_state_changed");
  assert.equal(f.machines.get(h.id).capabilities.update_agent.reason, "");
  assert.equal(f.calls.slice(before).some(input => input.command.includes(" commit") || input.command.includes(".update-bootstrap")), false);
});

test("lost commit response can be reconciled after a later natural restart without rewriting commit boot", async t => {
  const f = await fixture(t), h = await f.host(); f.modes.set(h.id, "disconnect");
  const p = (await f.plan(h.id)).data;
  assert.equal((await f.apply(h.id, p.id)).data.status, "unknown");
  const remote = f.states.get(p.id), restartedBoot = "33333333-3333-4333-8333-333333333333";
  remote.status = "succeeded";
  remote.local_health = { service_active: true, identity_matches: true, release_matches: true, boot_id: NEW_BOOT };
  f.observations.get(h.id).current = { ...remote.target, fingerprint: "c".repeat(64), boot_id: restartedBoot };
  f.modes.set(h.id, "hold");
  f.db.run("UPDATE agents SET heartbeat=?,last_seen=? WHERE id=?", JSON.stringify({ agent_id: h.agent, version: remote.target.version,
    release: remote.target, boot_id: restartedBoot, last_error: "", config_revision: f.nodes.effective(h.agent).config.revision }), f.deps.now().toISOString(), h.agent);
  const before = f.calls.length;
  const verified = await f.request(`/machines/${h.id}/agent-updates/${p.id}/reconcile`, "POST", {});
  assert.equal(verified.data.status, "succeeded", verified.raw);
  assert.equal(verified.data.receipt.local_health.boot_id, NEW_BOOT);
  assert.equal(verified.data.receipt.current_verification.boot_id, restartedBoot);
  assert.equal(f.machines.get(h.id).capabilities.update_agent.reason, "");
  assert.equal(f.calls.slice(before).some(input => input.command.includes(" commit") || input.command.includes(".update-bootstrap")), false);
});

test("tickets bind host, operation, immutable files and expire once detached execution starts", async t => {
  const f = await fixture(t), h = await f.host(); const p = (await f.plan(h.id)).data;
  f.setDownloadHook(async (input, operation) => {
    const bearer = JSON.parse(input.stdin).download_token;
    const path = `/machines/${h.id}/agent-updates/${operation.id}/downloads/`;
    assert.equal((await f.request(path + "bundle.tar.gz")).status, 401);
    assert.equal((await f.request(path + "bundle.tar.gz", "GET", undefined, { authorization: "Bearer wrong" })).status, 401);
    const downloaded = await f.request(path + "bundle.tar.gz", "GET", undefined, { authorization: "Bearer " + bearer });
    assert.equal(downloaded.status, 200, downloaded.raw); assert.equal(hash(Buffer.from(downloaded.raw)), f.release.sha256);
    assert.equal((await f.request(path + "secrets.json", "GET", undefined, { authorization: "Bearer " + bearer })).status, 404);
    const stored = f.db.get<any>("SELECT ticket_hash FROM machine_agent_updates WHERE id=?", operation.id)!;
    assert.notEqual(stored.ticket_hash, bearer); assert.equal(stored.ticket_hash, hash(bearer));
  });
  await f.apply(h.id, p.id); await f.settle(h.id, p.id);
  const tokenValue = JSON.parse(f.calls.find(input => input.command.includes(".update-bootstrap")).stdin).download_token;
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/${p.id}/downloads/bundle.tar.gz`, "GET", undefined, { authorization: "Bearer " + tokenValue })).status, 401);
});

test("SSH disconnect remains unknown; read-only reconciliation never commits a waiting operation", async t => {
  const f = await fixture(t), h = await f.host(); f.modes.set(h.id, "disconnect");
  const p = (await f.plan(h.id)).data, result = await f.apply(h.id, p.id); assert.equal(result.data.status, "unknown");
  const remote = f.states.get(p.id); remote.status = "waiting_confirmation"; remote.local_health = { service_active: true, identity_matches: true, release_matches: true, boot_id: NEW_BOOT };
  const before = f.calls.length;
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/${p.id}/reconcile`, "POST", {})).data.status, "unknown");
  assert.equal(f.calls.slice(before).some(input => input.command.includes(" commit") || input.command.includes(".update-bootstrap")), false);
  remote.status = "rolled_back"; remote.restored_fingerprint = oldRelease.fingerprint;
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/${p.id}/reconcile`, "POST", {})).data.status, "rolled_back");
});

test("a missing start receipt cannot release the fence before start deadline or after a changed program", async t => {
  const f = await fixture(t), h = await f.host(); f.modes.set(h.id, "missing_receipt");
  const p = (await f.plan(h.id)).data; assert.equal((await f.apply(h.id, p.id)).data.status, "unknown");
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/${p.id}/reconcile`, "POST", {})).status, 409);
  f.advance(181); f.observations.get(h.id).current.fingerprint = "c".repeat(64);
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/${p.id}/reconcile`, "POST", {})).status, 409);
  f.observations.get(h.id).current.fingerprint = oldRelease.fingerprint;
  f.observations.get(h.id).service_active = false;
  const verified = await f.request(`/machines/${h.id}/agent-updates/${p.id}/reconcile`, "POST", {});
  assert.equal(verified.data.status, "failed", verified.raw); assert.equal(verified.data.receipt.remote_unchanged, true);
});

test("maintenance fencing prevents conflicting tasks, jobs, deletion, SSH terminals and host changes", async t => {
  const f = await fixture(t), h = await f.host(), tasks = new TaskRunStore(f.deps, f.credentials), jobs = registerAgentJobs(f.deps, { agentCredentials: f.credentials });
  t.after(() => jobs.close?.());
  const task = tasks.nodes.task({ name: "Sample", type: "script", enabled: true, target_all: false, host_ids: [h.id], label_ids: [],
    schedule: { mode: "once" }, script: { runtime: "node", code: "console.log('ok')", timeout_seconds: 5, max_output_bytes: 4096 } }, "update-fence-task", true);
  const p = (await f.plan(h.id)).data;
  assert.throws(() => tasks.dispatch(task.id, { confirm: true }, "admin"), /升级|维护/);
  assert.equal(tasks.claim(h.agent, [SCRIPT_TASK_CAPABILITY]), null);
  assert.throws(() => jobs.enqueue({ agentID: h.agent, deploymentID: "deployment-one", operationID: "operation-one", capabilities: ["health.systemd"], actions: [{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}] }), /升级|维护/);
  assert.equal(jobs.claim(h.agent, []), null);
  assert.throws(() => assertNoPendingAgentUpdate(f.db, h.agent), /升级|维护/);
  assert.throws(() => f.machines.acquireTerminal(h.id, h.credential, () => {}), /升级|维护/);
  assert.equal((await f.request(`/machines/${h.id}`, "PUT", { name: "changed" })).status, 409);
  assert.equal((await f.request(`/machines/${h.id}`, "DELETE")).status, 409);
  await f.request(`/machines/${h.id}/agent-updates/${p.id}/cancel`, "POST", {});
  assert.equal(tasks.dispatch(task.id, { confirm: true }, "admin").runs.length, 1);
  assert.equal((await f.plan(h.id)).status, 409);
});

test("interval scheduling skips only the host under maintenance and never catches up its missed slot", async t => {
  const f = await fixture(t), one = await f.host("scheduled-one"), two = await f.host("scheduled-two"), tasks = new TaskRunStore(f.deps, f.credentials);
  const task = tasks.nodes.task({ name: "Scheduled task", type: "script", enabled: true, target_all: false, host_ids: [one.id, two.id], label_ids: [],
    schedule: { mode: "interval", interval_seconds: 10 }, script: { runtime: "node", code: "console.log('ok')", timeout_seconds: 5, max_output_bytes: 4096 } }, "update-fence-schedule", true);
  tasks.tick(); const p = (await f.plan(one.id)).data; f.advance(10); tasks.tick();
  const first = tasks.list({ task_id: task.id }); assert.equal(first.length, 1); assert.equal(first[0].host_id, two.id);
  tasks.cancel(first[0].id, "admin");
  await f.request(`/machines/${one.id}/agent-updates/${p.id}/cancel`, "POST", {});
  tasks.tick(); assert.equal(tasks.list({ host_id: one.id }).length, 0);
  f.advance(10); tasks.tick(); assert.equal(tasks.list({ host_id: one.id }).length, 1);
  assert.equal(tasks.list({ host_id: two.id }).length, 2);
});

test("maintenance defers automatic retries without closing consent or blocking other hosts and schedules", async t => {
  const f = await fixture(t), one = await f.host("retry-one"), two = await f.host("retry-two"), tasks = new TaskRunStore(f.deps, f.credentials);
  const script = { runtime: "node", code: "console.log('ok')", timeout_seconds: 5, max_output_bytes: 4096 };
  const retryable = tasks.nodes.task({ name: "Retry task", type: "script", enabled: true, target_all: false, host_ids: [one.id, two.id], label_ids: [],
    schedule: { mode: "once" }, script, execution_policy: { retry_count: 1, retry_delay_seconds: 10 } }, "update-fence-retry", true);
  const scheduled = tasks.nodes.task({ name: "Other host schedule", type: "script", enabled: true, target_all: false, host_ids: [two.id], label_ids: [],
    schedule: { mode: "interval", interval_seconds: 10 }, script }, "update-fence-other-schedule", true);
  tasks.dispatch(retryable.id, { confirm: true }, "admin");
  const failed = new Map<string, string>();
  for (const host of [one, two]) {
    const run = tasks.claim(host.agent, [SCRIPT_TASK_CAPABILITY])!; assert.ok(run);
    tasks.result(host.agent, run.id, { lease_token: run.lease_token, state: "failed", code: "script_failed", summary: "failed", stdout: "", stderr: "", exit_code: 1 });
    failed.set(host.id, run.id);
  }
  tasks.tick(); const p = await f.plan(one.id); assert.equal(p.status, 201, p.raw);
  f.advance(10); assert.doesNotThrow(() => tasks.tick());
  const retries = tasks.list({ task_id: retryable.id }).filter(run => run.trigger === "retry");
  assert.equal(retries.length, 1); assert.equal(retries[0].host_id, two.id); assert.equal(retries[0].retry_of, failed.get(two.id));
  assert.deepEqual(f.db.get<any>("SELECT auto_retry_closed,superseded_by FROM task_runs WHERE id=?", failed.get(one.id)!), { auto_retry_closed: 0, superseded_by: "" });
  assert.equal(tasks.list({ task_id: scheduled.id })[0].host_id, two.id);
  assert.equal((await f.request(`/machines/${one.id}/agent-updates/${p.data.id}/cancel`, "POST", {})).status, 200);
  assert.doesNotThrow(() => tasks.tick());
  const resumed = tasks.list({ task_id: retryable.id }).find(run => run.retry_of === failed.get(one.id));
  assert.ok(resumed); assert.equal(resumed.host_id, one.id);
  assert.equal(tasks.get(failed.get(one.id)!).superseded_by, resumed.id);
});

test("maintenance failures cannot fill the bounded retry scan and starve a later host", async t => {
  const f = await fixture(t), one = await f.host("blocked-retries"), two = await f.host("eligible-retry"), tasks = new TaskRunStore(f.deps, f.credentials);
  const task = tasks.nodes.task({ name: "Retry window", type: "script", enabled: true, target_all: false, host_ids: [one.id, two.id], label_ids: [],
    schedule: { mode: "once" }, script: { runtime: "node", code: "console.log('ok')", timeout_seconds: 5, max_output_bytes: 4096 },
    execution_policy: { retry_count: 1, retry_delay_seconds: 10 } }, "update-fence-retry-window", true);
  let eligibleID = "";
  for (let i = 0; i < 201; i++) {
    const host = i === 200 ? two : one;
    tasks.dispatch(task.id, { confirm: true, host_ids: [host.id] }, "admin");
    const run = tasks.claim(host.agent, [SCRIPT_TASK_CAPABILITY])!; assert.ok(run);
    tasks.result(host.agent, run.id, { lease_token: run.lease_token, state: "failed", code: "script_failed", summary: "failed", stdout: "", stderr: "", exit_code: 1 });
    if (i === 200) eligibleID = run.id;
  }
  const planned = await f.plan(one.id); assert.equal(planned.status, 201, planned.raw);
  f.advance(10); assert.doesNotThrow(() => tasks.tick());
  const replacement = tasks.get(eligibleID).superseded_by;
  assert.ok(replacement); assert.equal(tasks.get(replacement).host_id, two.id);
  assert.equal(f.db.get<any>("SELECT count(*) AS n FROM task_runs WHERE host_id=? AND trigger='retry'", one.id)!.n, 0);
  assert.equal(f.db.get<any>("SELECT count(*) AS n FROM task_runs WHERE host_id=? AND auto_retry_closed=0", one.id)!.n, 200);
});

test("invalid platform endpoints are rejected before SSH and never leave a running operation", async t => {
  const f = await fixture(t), h = await f.host();
  for (const endpoint of ["http://platform.example.test", "https://user:password@platform.example.test", "https://platform.example.test/?key=x", "not a URL"]) {
    f.deps.externalURL = endpoint;
    assert.equal((await f.plan(h.id)).status, 409);
    assert.equal(f.db.get<any>("SELECT count(*) AS n FROM machine_agent_updates")!.n, 0);
  }
  assert.equal(f.calls.length, 0);
});

test("persistent rollout serializes hosts, pauses on failure, resumes past acknowledged failures and rejects bypass", async t => {
  const f = await fixture(t), one = await f.host("first"), two = await f.host("second"); f.modes.set(one.id, "rollback");
  const proposal = await f.request("/agent-rollouts/plan", "POST", { machine_ids: [one.id, two.id], target_sha256: f.release.sha256 });
  assert.equal(proposal.status, 201, proposal.raw); const rolloutID = proposal.data.id, first = proposal.data.items[0], second = proposal.data.items[1];
  assert.equal((await f.apply(one.id, first.update_id)).status, 409);
  assert.equal((await f.request(`/machines/${two.id}/agent-updates/${second.update_id}/cancel`, "POST", {})).status, 409);
  assert.equal((await f.request(`/agent-rollouts/${rolloutID}/apply`, "POST", { confirm: true })).status, 202);
  await f.settle(one.id, first.update_id);
  let paused: any;
  for (let i = 0; i < 100; i++) { paused = (await f.request(`/agent-rollouts/${rolloutID}`)).data; if (paused.status === "paused") break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(paused.status, "paused"); assert.equal(paused.items[1].status, "awaiting_approval");
  assert.equal(f.calls.filter(input => input.machine.id === two.id && input.command.includes(".update-bootstrap")).length, 0);
  assert.equal((await f.request(`/agent-rollouts/${rolloutID}/resume`, "POST", { confirm: true })).status, 202);
  const done = await f.settle(two.id, second.update_id); assert.equal(done.status, "succeeded", JSON.stringify(done));
  assert.equal(f.calls.filter(input => input.machine.id === one.id && input.command.includes(".update-bootstrap")).length, 1);
});

test("rollout cancel affects only untouched plans; restart retains unknown operations and pauses batches", async t => {
  const f = await fixture(t), one = await f.host("first"), two = await f.host("second"); f.modes.set(one.id, "hold");
  const proposal = (await f.request("/agent-rollouts/plan", "POST", { machine_ids: [one.id, two.id], target_sha256: f.release.sha256 })).data;
  await f.request(`/agent-rollouts/${proposal.id}/apply`, "POST", { confirm: true });
  for (let i = 0; i < 100; i++) { if (f.states.size) break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal((await f.request(`/agent-rollouts/${proposal.id}/cancel`, "POST", {})).status, 202);
  assert.equal((await f.request(`/machines/${two.id}/agent-updates/${proposal.items[1].update_id}`)).data.status, "cancelled");
  createAgentUpdatesSchema(f.deps);
  assert.equal((await f.request(`/machines/${one.id}/agent-updates/${proposal.items[0].update_id}`)).data.status, "unknown");
  assert.equal((await f.request(`/agent-rollouts/${proposal.id}`)).data.status, "cancelled");
  const other = await f.host("restart"), p = (await f.plan(other.id)).data;
  f.db.run("UPDATE machine_agent_updates SET status='running' WHERE id=?", p.id);
  f.db.run("UPDATE agent_update_rollouts SET status='running' WHERE id=?", proposal.id);
  createAgentUpdatesSchema(f.deps);
  assert.equal(f.machines.agentUpdates!.assistantGet(other.id, p.id).status, "unknown");
  assert.equal((await f.request(`/agent-rollouts/${proposal.id}`)).data.status, "paused");
});

test("members can inspect release and update metadata but cannot plan or approve maintenance", async t => {
  const f = await fixture(t), h = await f.host(), p = (await f.plan(h.id)).data; f.user.role = "member";
  assert.equal((await f.request("/agent-releases")).status, 200);
  assert.equal((await f.request(`/machines/${h.id}/agent-updates`)).status, 200);
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/${p.id}`)).status, 200);
  assert.equal((await f.plan(h.id)).status, 403); assert.equal((await f.apply(h.id, p.id)).status, 403);
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/${p.id}/cancel`, "POST", {})).status, 403);
  assert.equal((await f.request(`/machines/${h.id}/agent-updates/${p.id}/reconcile`, "POST", {})).status, 403);
});
