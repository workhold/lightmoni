import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readAgentRelease } from "../src/agent/release.js";
import { agentUpdateStartCommand, parseAgentUpdateProbe, parseAgentUpdateStatus } from "../src/server/machine-agent-update-ssh.js";
const repo = resolve(import.meta.dirname, "../..");
const { AgentMaintenance } = await import(pathToFileURL(join(repo, "deploy/agent/update-runner.mjs")).href);
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");

function fixture(t: any, options: { legacy?: boolean; failTarget?: boolean; failRollback?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "lm-update-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = (name: string) => join(root, name);
  for (const name of ["opt/lightmoni-agent/releases/old/app/runtime/dist/agent", "etc/systemd/system", "etc/lightmoni-agent", "var/lib/lightmoni-agent", "usr/local/bin", "run", "staging"])
    fs.mkdirSync(p(name), { recursive: true, mode: 0o755 });
  const old = p("opt/lightmoni-agent/releases/old"), arch = "arm64";
  fs.writeFileSync(join(old, "node"), "synthetic trusted Node\n", { mode: 0o755 });
  fs.writeFileSync(join(old, "app/runtime/dist/agent/main.js"), "// old code\n");
  fs.writeFileSync(join(old, "release.json"), JSON.stringify(options.legacy ? { version: "0.1.0", platform: "linux", arch, node_version: "24.15.0", requires: "glibc >= 2.28", node_sha256: "e".repeat(64) } : { version: "0.1.0", platform: "linux", arch, source_revision: "a".repeat(40), build_id: "old-build", state_schema: 1 }));
  if (!options.legacy) fs.writeFileSync(join(old, "installation.json"), JSON.stringify({ schema: 1, artifact_sha256: "1".repeat(64) }));
  fs.symlinkSync(old, p("opt/lightmoni-agent/current"));
  fs.writeFileSync(p("usr/local/bin/lightmoni-agent"), "#!/bin/sh\n# old launcher\n", { mode: 0o755 });
  fs.writeFileSync(p("etc/systemd/system/lightmoni-agent.service"), "old unit\n");
  fs.writeFileSync(p("etc/lightmoni-agent/config.json"), '{"control_credential":"test-private-control","data_credential":"test-private-data"}\n', { mode: 0o600 });
  fs.writeFileSync(p("var/lib/lightmoni-agent/identity.json"), '{"agent_id":"fixture-agent","host_id":"fixture-host"}\n', { mode: 0o600 });
  fs.writeFileSync(p("var/lib/lightmoni-agent/queue.sqlite"), randomBytes(128), { mode: 0o600 });
  const saved = Object.fromEntries(["etc/lightmoni-agent/config.json", "var/lib/lightmoni-agent/identity.json", "var/lib/lightmoni-agent/queue.sqlite"].map(name => [name, fs.readFileSync(p(name))]));
  const packageDir = p("package"), runtime = join(packageDir, "lightmoni-agent-runtime");
  fs.mkdirSync(join(runtime, "app/runtime/dist/agent"), { recursive: true });
  const manifest = { version: "0.1.0", platform: "linux", arch, source_revision: "b".repeat(40), build_id: "new-build", state_schema: 1 };
  fs.writeFileSync(join(runtime, "release.json"), JSON.stringify(manifest));
  fs.writeFileSync(join(runtime, "node"), "synthetic new Node\n", { mode: 0o755 });
  fs.writeFileSync(join(runtime, "app/runtime/dist/agent/main.js"), "// new code\n");
  fs.writeFileSync(join(runtime, "padding"), randomBytes(4096));
  fs.writeFileSync(join(packageDir, "lightmoni-agent"), "#!/bin/sh\n# new launcher\n", { mode: 0o755 });
  fs.writeFileSync(join(packageDir, "lightmoni-agent.service"), "new unit\n");
  const archive = p("staging/bundle.tar.gz");
  const repack = () => execFileSync("tar", ["-czf", archive, "-C", packageDir, "lightmoni-agent", "lightmoni-agent.service", "lightmoni-agent-runtime"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  repack();
  let now = Date.now(), active = true, boot = randomUUID(), restarts = 0;
  const calls: Array<[string, string[]]> = [];
  let onSleep: undefined | (() => void);
  const maintenance = new AgentMaintenance({ root, arch, uid: process.getuid?.() ?? 0, now: () => now, sleep: async (ms: number) => { now += ms; onSleep?.(); }, launch: () => {},
    command: (file: string, args: string[]) => {
      calls.push([file, args]);
      if (file === "systemctl") {
        if (args[0] === "show") {
          if (args.includes("--property=ActiveState")) return active ? "active" : "inactive";
          if (args.includes("--property=FragmentPath")) return p("etc/systemd/system/lightmoni-agent.service");
          if (args.includes("--property=LoadState")) return "loaded";
        }
        if (args[0] === "stop") active = false;
        if (args[0] === "restart") {
          restarts++; boot = randomUUID();
          const current = fs.realpathSync(p("opt/lightmoni-agent/current"));
          if (options.failTarget && current !== old || options.failRollback && current === old && restarts > 1) throw Error("synthetic restart failure must not leak");
          active = true;
        }
        return "";
      }
      if (args[0] === "status") {
        const current = fs.realpathSync(p("opt/lightmoni-agent/current"));
        const meta = maintenance.metadata(current);
        return JSON.stringify({ agent_id: "fixture-agent", ...(options.legacy && current === old ? {} : { boot_id: boot, release: meta }) });
      }
      return "configuration valid";
    },
  });
  const request = () => ({ operation_id: randomBytes(16).toString("hex"), expected_agent_id: "fixture-agent", expected_fingerprint: maintenance.probe().current.fingerprint, expected_service_active: active, start_deadline: new Date(now + 180000).toISOString(), action: "upgrade", target: { version: manifest.version, source_revision: manifest.source_revision, build_id: manifest.build_id, state_schema: 1, arch, artifact_sha256: sha(fs.readFileSync(archive)) }, archive_path: archive, confirm_timeout_seconds: 10 });
  const preserve = () => { for (const [name, bytes] of Object.entries(saved)) assert.deepEqual(fs.readFileSync(p(name)), bytes, name + " retained"); };
  return { root, p, old, runtime, packageDir, archive, manifest, maintenance, request, calls, repack, preserve, setActive: (value: boolean) => { active = value; }, onSleep: (callback: () => void) => { onSleep = callback; } };
}

test("same-version upgrade is bound to source/build/digest and commits only a new boot; identity, credentials and live queue survive", async t => {
  const f = fixture(t), request = f.request(), before = f.maintenance.probe();
  const accepted = await f.maintenance.start(request);
  assert.equal(accepted.status, "accepted");
  assert.equal(fs.statSync(f.p("opt/lightmoni-agent/updates/" + request.operation_id)).mode & 0o777, 0o700);
  f.onSleep(() => {
    const state = f.maintenance.state(request.operation_id);
    if (state.status === "waiting_confirmation") f.maintenance.commit({ operation_id: request.operation_id, expected_boot_id: state.local_health.boot_id, expected_target_sha256: request.target.artifact_sha256 });
  });
  const result = await f.maintenance.worker(request.operation_id);
  assert.equal(result.status, "succeeded");
  assert.notEqual(result.local_health.boot_id, before.current.boot_id);
  assert.equal(result.target.version, before.current.version);
  const probe = f.maintenance.probe();
  assert.equal(probe.current.artifact_sha256, request.target.artifact_sha256);
  assert.equal(probe.previous.fingerprint, before.current.fingerprint);
  assert.equal(probe.lifecycle_locked, false);
  assert.equal(fs.statSync(join(fs.realpathSync(f.p("opt/lightmoni-agent/current")), "installation.json")).mode & 0o777, 0o644);
  assert.equal(parseAgentUpdateProbe(JSON.stringify(probe)).current.build_id, "new-build");
  assert.equal(parseAgentUpdateStatus(JSON.stringify(result)).status, "succeeded");
  f.preserve();
});
test("unconfirmed upgrade automatically restores legacy program without restoring or losing live state", async t => {
  const f = fixture(t, { legacy: true }), request = f.request();
  const original = request.expected_fingerprint;
  await f.maintenance.start(request);
  const result = await f.maintenance.worker(request.operation_id);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.error_code, "confirmation_timeout");
  assert.equal(result.restored_fingerprint, original);
  assert.equal(f.maintenance.probe().current.fingerprint, original);
  assert.equal(f.maintenance.probe().lifecycle_locked, false);
  f.preserve();
});
test("failed new service restores previous files and service", async t => {
  const f = fixture(t, { failTarget: true }), request = f.request();
  await f.maintenance.start(request);
  const result = await f.maintenance.worker(request.operation_id);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.local_health.service_active, true);
  assert.equal(fs.realpathSync(f.p("opt/lightmoni-agent/current")), f.old);
  assert.match(fs.readFileSync(f.p("usr/local/bin/lightmoni-agent"), "utf8"), /old launcher/);
  f.preserve();
});
test("failed restoration keeps lifecycle fence and durable rollback_failed receipt", async t => {
  const f = fixture(t, { failTarget: true, failRollback: true }), request = f.request();
  await f.maintenance.start(request);
  const result = await f.maintenance.worker(request.operation_id);
  assert.equal(result.status, "rollback_failed");
  assert.equal(f.maintenance.ownsLock(request.operation_id), true);
  f.preserve();
});
test("tampered package and expired startup deadline leave program untouched", async t => {
  const f = fixture(t), request = f.request();
  fs.appendFileSync(f.archive, "tamper");
  await assert.rejects(f.maintenance.start(request), /checksum_mismatch/);
  assert.equal(f.maintenance.probe().lifecycle_locked, false);
  request.start_deadline = new Date(0).toISOString();
  await assert.rejects(f.maintenance.start(request), /start_deadline_expired/);
  assert(!f.calls.some(([, args]) => args[0] === "stop"));
  f.preserve();
});
test("unsafe archive symlink is rejected before stopping or replacing any program", async t => {
  const f = fixture(t);
  fs.symlinkSync("/etc/passwd", join(f.runtime, "escape")); f.repack();
  const request = f.request(); await f.maintenance.start(request);
  const result = await f.maintenance.worker(request.operation_id);
  assert.equal(result.status, "failed"); assert.equal(result.error_code, "unsafe_archive_link");
  assert(!f.calls.some(([, args]) => args[0] === "stop")); f.preserve();
});
test("running/unknown task markers and changed installation fence stale plans", async t => {
  const f = fixture(t), request = f.request();
  fs.writeFileSync(f.p("var/lib/lightmoni-agent/task-run-state.json"), '{"id":"pending-run"}');
  await assert.rejects(f.maintenance.start(request), /operation_conflict/);
  fs.unlinkSync(f.p("var/lib/lightmoni-agent/task-run-state.json"));
  fs.appendFileSync(f.p("usr/local/bin/lightmoni-agent"), "# changed\n");
  await assert.rejects(f.maintenance.start(request), /installation_changed/);
  f.preserve();
});
test("read-only status cannot commit; mismatched boot rejected, explicit request rolls back", async t => {
  const f = fixture(t), request = f.request(); await f.maintenance.start(request);
  let checked = false;
  f.onSleep(() => {
    const state = f.maintenance.state(request.operation_id);
    if (state.status !== "waiting_confirmation" || checked) return;
    checked = true;
    assert.throws(() => f.maintenance.commit({ operation_id: request.operation_id, expected_boot_id: randomUUID(), expected_target_sha256: request.target.artifact_sha256 }), /commit_health_changed/);
    assert.equal(f.maintenance.state(request.operation_id).status, "waiting_confirmation");
    f.maintenance.rollback({ operation_id: request.operation_id });
  });
  const result = await f.maintenance.worker(request.operation_id);
  assert.equal(checked, true); assert.equal(result.status, "rolled_back"); assert.equal(result.error_code, "rollback_requested"); f.preserve();
});
test("runtime release reads the fixed running directory and ignores mutable current pointer", t => {
  const f = fixture(t), release = readAgentRelease(f.old);
  assert.equal(release.build_id, "old-build");
  assert.equal(release.artifact_sha256, "1".repeat(64));
  fs.unlinkSync(f.p("opt/lightmoni-agent/current")); fs.symlinkSync(f.runtime, f.p("opt/lightmoni-agent/current"));
  assert.equal(readAgentRelease(f.old).build_id, "old-build");
});
test("SSH bootstrap contains no token, binds all three SHA, and accepts 16-character machine IDs", t => {
  const f = fixture(t), request = f.request(); delete (request as any).archive_path;
  const command = agentUpdateStartCommand({ endpoint: "https://example.test", machineID: "a".repeat(16), operationID: request.operation_id, scripts: { "update.sh": "1".repeat(64), "update-runner.mjs": "2".repeat(64) }, bundleSHA: request.target.artifact_sha256, request: request as any });
  assert(command.includes("update-runner.mjs")); assert(command.includes("sha256sum --check --status"));
  assert(command.includes(".update-bootstrap.")); assert(!command.includes("test-private-control"));
  assert(!command.includes("--location"));
});
test("production root path validation accepts root-owned paths without a double-slash prefix", () => {
  const production = new AgentMaintenance();
  assert.equal(production.checkManaged("/", "directory"), "/");
});
test("uncertain systemd dispatch keeps accepted receipt and lifecycle fence for reconciliation", async t => {
  const f = fixture(t), request = f.request();
  f.maintenance.launch = () => { throw Error("dispatch transport uncertain"); };
  await assert.rejects(f.maintenance.start(request));
  assert.equal(f.maintenance.state(request.operation_id).status, "accepted");
  assert.equal(f.maintenance.ownsLock(request.operation_id), true);
  assert.equal(fs.realpathSync(f.p("opt/lightmoni-agent/current")), f.old);
  f.preserve();
});
test("schema migrations and explicit rollback to an old unobservable program are rejected", async t => {
  const f = fixture(t, { legacy: true }), request = f.request();
  request.target.state_schema = 2;
  await assert.rejects(f.maintenance.start(request), /invalid_target/);
  request.target.state_schema = 1;
  request.action = "rollback";
  Object.assign(request.target, { source_revision: "", build_id: "", artifact_sha256: "", fingerprint: request.expected_fingerprint });
  await assert.rejects(f.maintenance.start(request), /invalid_target/);
  assert.equal(f.maintenance.probe().lifecycle_locked, false);
  f.preserve();
});
test("a manual Node change invalidates the approved current fingerprint", async t => {
  const f = fixture(t), request = f.request();
  fs.appendFileSync(join(f.old, "node"), "changed runtime\n");
  await assert.rejects(f.maintenance.start(request), /installation_changed/);
  f.preserve();
});

for (const beforeActive of [true, false]) test(`source ${beforeActive ? "active to inactive" : "inactive to active"} change rejects start without a transaction or cutover`, async t => {
  const f = fixture(t); f.setActive(beforeActive);
  const request = f.request(); f.setActive(!beforeActive);
  await assert.rejects(f.maintenance.start(request), /service_state_changed/);
  assert.equal(fs.existsSync(f.p("opt/lightmoni-agent/updates/" + request.operation_id)), false);
  assert.equal(f.maintenance.probe().lifecycle_locked, false);
  assert.equal(fs.realpathSync(f.p("opt/lightmoni-agent/current")), f.old);
  assert.equal(f.calls.some(([, args]) => args[0] === "stop" || args[0] === "restart"), false);
  f.preserve();
});

for (const beforeActive of [true, false]) test(`source ${beforeActive ? "active to inactive" : "inactive to active"} change before worker cutover fails without changing service state`, async t => {
  const f = fixture(t); f.setActive(beforeActive);
  const request = f.request(); await f.maintenance.start(request);
  f.setActive(!beforeActive);
  const result = await f.maintenance.worker(request.operation_id);
  assert.equal(result.status, "failed"); assert.equal(result.error_code, "service_state_changed");
  assert.equal(f.maintenance.probe().service_active, !beforeActive);
  assert.equal(f.maintenance.probe().lifecycle_locked, false);
  assert.equal(fs.realpathSync(f.p("opt/lightmoni-agent/current")), f.old);
  assert.equal(f.calls.some(([, args]) => args[0] === "stop" || args[0] === "restart"), false);
  f.preserve();
});

test("source service state is required and cannot be omitted or coerced", async t => {
  const f = fixture(t), request = f.request();
  for (const value of [undefined, "true", 1, null]) {
    (request as any).expected_service_active = value;
    await assert.rejects(f.maintenance.start(request), /invalid_request/);
  }
  assert.equal(fs.existsSync(f.p("opt/lightmoni-agent/updates/" + request.operation_id)), false);
  assert.equal(f.maintenance.probe().lifecycle_locked, false);
  f.preserve();
});
