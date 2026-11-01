import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EXECUTOR_JOURNAL_COLUMNS } from "../src/shared/privileged-executor.js";

const repo = resolve(import.meta.dirname, "../..");
const { ExecutorMaintenance, JOURNAL_COLUMNS } = await import(pathToFileURL(join(repo, "deploy/executor/maintenance.mjs")).href);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const releaseKeys = ["version", "build_id", "source_revision", "artifact_sha256", "state_schema", "arch", "fingerprint"];
const select = (value: any) => Object.fromEntries(releaseKeys.map(key => [key, value[key]]));

/** Real filesystem, crypto, tar parser and read-only SQLite; root ownership,
 * systemd and writer flock are injected. No host service or network is used. */
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "lm-executor-runner-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = (value: string) => join(root, value);
  for (const dir of ["opt/lightmoni-executor/releases", "etc/lightmoni-executor", "etc/systemd/system", "usr/local/bin", "usr/local/sbin", "var/lib/lightmoni-executor", "run/lightmoni-executor-maintenance.fixture"])
    fs.mkdirSync(p(dir), { recursive: true, mode: 0o755 });
  fs.chmodSync(p("var/lib/lightmoni-executor"), 0o700);
  const keys = generateKeyPairSync("ed25519");
  const config = { version: 1, executor_id: "exec-fixture", machine_id: "machine-fixture", agent_id: "agent-fixture", center_instance_id: "center-fixture", install_generation: 3, data_dir: "/var/lib/lightmoni-executor", output_key: "f".repeat(64), private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), local_policy: { generation: 4 } };
  fs.writeFileSync(p("etc/lightmoni-executor/config.json"), JSON.stringify(config), { mode: 0o600 });
  const journal = p("var/lib/lightmoni-executor/journal.sqlite");
  const db = new DatabaseSync(journal);
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE jobs(job_id TEXT PRIMARY KEY,digest TEXT NOT NULL,grant_id TEXT NOT NULL,lease_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','intent','running','succeeded','failed','unknown')),plan_json TEXT NOT NULL,payload_json TEXT NOT NULL,unit TEXT NOT NULL DEFAULT '',nonce TEXT NOT NULL DEFAULT '',permit_id TEXT NOT NULL DEFAULT '',result_json TEXT NOT NULL DEFAULT '{}'); CREATE TABLE consumed_grants(grant_id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE,digest TEXT NOT NULL); CREATE TABLE requests(slot TEXT PRIMARY KEY,id TEXT NOT NULL,digest TEXT NOT NULL); CREATE TABLE resources(resource_id TEXT PRIMARY KEY,value_json TEXT NOT NULL); INSERT INTO metadata VALUES('schema','1'),('initialized','1'),('policy_generation','4');"); db.close(); fs.chmodSync(journal, 0o600);
  const launcher = fs.readFileSync(join(repo, "deploy/executor/launcher.sh"), "utf8"), unit = fs.readFileSync(join(repo, "deploy/executor/lightmoni-executor.service"), "utf8");
  const writeRelease = (directory: string, build: string, installation = true) => {
    fs.mkdirSync(join(directory, "app/runtime/dist/privileged-executor"), { recursive: true, mode: 0o755 });
    fs.mkdirSync(join(directory, "executor"), { mode: 0o755 });
    fs.writeFileSync(join(directory, "node"), "synthetic root node " + build, { mode: 0o755 });
    fs.writeFileSync(join(directory, "app/runtime/dist/privileged-executor/main.js"), "// " + build);
    const manifest = { version: build === "old" ? "1.0.0" : "1.1.0", build_id: build, source_revision: (build === "old" ? "a" : "b").repeat(40), state_schema: 1, platform: "linux", arch: "arm64" };
    fs.writeFileSync(join(directory, "release.json"), JSON.stringify(manifest));
    fs.writeFileSync(join(directory, "executor/launcher.sh"), launcher, { mode: 0o755 });
    fs.writeFileSync(join(directory, "executor/lightmoni-executor.service"), unit);
    fs.writeFileSync(join(directory, "executor/uninstall.sh"), "#!/bin/sh\n# " + build, { mode: 0o755 });
    fs.writeFileSync(join(directory, "executor/maintenance.mjs"), "// synthetic supervisor " + build);
    if (installation) fs.writeFileSync(join(directory, "installation.json"), JSON.stringify({ schema: 1, artifact_sha256: "1".repeat(64) }));
    return manifest;
  };
  const old = p("opt/lightmoni-executor/releases/old"); writeRelease(old, "old");
  fs.symlinkSync(old, p("opt/lightmoni-executor/current"));
  fs.writeFileSync(p("usr/local/bin/lightmoni-executor"), launcher, { mode: 0o755 });
  fs.writeFileSync(p("usr/local/sbin/lightmoni-executor-uninstall"), fs.readFileSync(join(old, "executor/uninstall.sh")), { mode: 0o755 });
  fs.writeFileSync(p("etc/systemd/system/lightmoni-executor.service"), unit);
  let active = true, locked = false, failStart = false, onStop: undefined | (() => void), now = Date.now();
  const calls: string[] = [];
  const runner = new ExecutorMaintenance({ root, uid: process.getuid?.() ?? 0, arch: "arm64", now: () => now,
    writer: async (work: () => any) => { calls.push("lock"); assert.equal(active, false); locked = true; try { return await work(); } finally { locked = false; calls.push("unlock"); } },
    command: (file: string, args: string[]) => {
      assert.equal(file, "/usr/bin/systemctl");
      if (args[0] === "show") {
        if (args.includes("--property=FragmentPath")) return fs.existsSync(p("etc/systemd/system/lightmoni-executor.service")) ? p("etc/systemd/system/lightmoni-executor.service") : "";
        if (args.includes("--property=DropInPaths")) return "";
        if (args.includes("--property=ActiveState")) return active ? "active" : "inactive";
        throw Error("unexpected property");
      }
      calls.push(args[0]);
      if (args[0] === "stop") { active = false; onStop?.(); if (!fs.existsSync(p("etc/systemd/system/lightmoni-executor.service"))) throw Error("Unit is not loaded"); }
      if (args[0] === "start") { assert.equal(locked, false, "writer released before service starts"); if (failStart) throw Error("private error must not escape"); active = true; }
      return "";
    },
  });
  runner.recordInstallPhase("enrollment_pending", old, "1".repeat(64)); runner.recordInstallPhase("program", old, "1".repeat(64)); runner.recordInstallPhase("ready", old, "1".repeat(64));
  const source = runner.probe();
  const packageDir = p("package"), runtime = join(packageDir, "lightmoni-agent-runtime");
  const manifest = writeRelease(runtime, "new", false); fs.writeFileSync(join(runtime, "padding"), randomBytes(4096));
  const archive = p("run/lightmoni-executor-maintenance.fixture/bundle.tar.gz");
  const repack = () => execFileSync("tar", ["-czf", archive, "-C", packageDir, "lightmoni-agent-runtime"], { env: { ...process.env, COPYFILE_DISABLE: "1" } }); repack();
  const request = (action = "upgrade", target?: any) => ({ operation_id: randomUUID(), action, executor_id: source.executor_id, machine_id: source.machine_id, agent_id: source.agent_id, center_instance_id: source.center_instance_id, public_key_sha256: source.public_key_sha256, install_generation: source.install_generation, expected_fingerprint: runner.probe().current.fingerprint, expected_policy_generation: 4, target: target ?? { ...manifest, artifact_sha256: sha(fs.readFileSync(archive)) }, archive_path: action === "upgrade" ? archive : undefined, start_deadline: new Date(now + 60000).toISOString() });
  const mutateJournal = (sql: string) => { const db = new DatabaseSync(journal); try { db.exec(sql); } finally { db.close(); } };
  return { root, p, runner, source, old, runtime, archive, request, calls, repack, mutateJournal, get active() { return active; }, set active(value: boolean) { active = value; }, set onStop(value: (() => void) | undefined) { onStop = value; }, set failStart(value: boolean) { failStart = value; }, advance(ms: number) { now += ms; } };
}

test("standalone required journal columns match the shared runtime contract", () => {
  assert.deepEqual(JOURNAL_COLUMNS, EXECUTOR_JOURNAL_COLUMNS);
});

test("probe binds full root release, complete identity and read-only journal policy", t => {
  const f = fixture(t), before = fs.readFileSync(f.p("var/lib/lightmoni-executor/journal.sqlite"));
  assert.equal(f.source.agent_id, "agent-fixture"); assert.equal(f.source.center_instance_id, "center-fixture"); assert.match(f.source.public_key_sha256, /^[a-f0-9]{64}$/); assert.equal(f.source.policy_generation, 4); assert.equal(f.source.phase, "ready");
  assert.equal(f.runner.status({ operation_id: randomUUID() }).receipt, null);
  assert.deepEqual(fs.readFileSync(f.p("var/lib/lightmoni-executor/journal.sqlite")), before);
  fs.writeFileSync(join(f.old, "loaded-dependency.js"), "injected dependency");
  assert.throws(() => f.runner.probe(), /executor_release_changed/);
});

for (const [name, sql] of [
  ["missing schema", "DELETE FROM metadata WHERE key='schema'"],
  ["future schema", "UPDATE metadata SET value='2' WHERE key='schema'"],
  ["missing initialized", "DELETE FROM metadata WHERE key='initialized'"],
  ["changed initialized sentinel", "UPDATE metadata SET value='other' WHERE key='initialized'"],
  ["missing resource registry", "DROP TABLE resources"],
  ["missing job result column", "ALTER TABLE jobs DROP COLUMN result_json"],
  ["missing consumed grant digest", "ALTER TABLE consumed_grants DROP COLUMN digest"],
] as const) test(`journal ${name} is refused before any service stop`, async t => {
  const f = fixture(t), request = f.request(); f.mutateJournal(sql); const before = fs.readFileSync(f.p("var/lib/lightmoni-executor/journal.sqlite"));
  await assert.rejects(() => f.runner.apply(request), /executor_journal_corrupt/); assert.deepEqual(f.calls, []); assert.deepEqual(fs.readFileSync(f.p("var/lib/lightmoni-executor/journal.sqlite")), before);
});

test("upgrade and exact rollback retain all private state and release writer before start", async t => {
  const f = fixture(t), names = ["etc/lightmoni-executor/config.json", "var/lib/lightmoni-executor/journal.sqlite"], saved = names.map(name => fs.readFileSync(f.p(name)));
  const request = f.request(), result = await f.runner.apply(request);
  assert.equal(result.receipt.status, "started"); assert.equal(result.observation.current.build_id, "new"); assert.deepEqual(result.observation.previous, f.source.current);
  assert.equal(result.receipt.activation_id, request.operation_id); assert.equal(result.observation.activation_id, request.operation_id); assert.notEqual(result.observation.activation_id, f.source.activation_id);
  assert.deepEqual(fs.readFileSync(f.runner.uninstaller), fs.readFileSync(f.p("opt/lightmoni-executor/releases/new/executor/uninstall.sh")));
  assert.deepEqual(f.calls, ["stop", "lock", "unlock", "daemon-reload", "enable", "start"]);
  for (let i = 0; i < names.length; i++) assert.deepEqual(fs.readFileSync(f.p(names[i])), saved[i]);
  const queried = f.runner.status({ operation_id: request.operation_id }); assert.equal(queried.receipt.status, "started");
  const rollback = await f.runner.apply(f.request("rollback", queried.observation.previous));
  assert.equal(rollback.receipt.status, "started"); assert.deepEqual(rollback.observation.current, f.source.current); assert.equal(rollback.observation.previous.build_id, "new");
  assert.deepEqual(fs.readFileSync(f.runner.uninstaller), fs.readFileSync(join(f.old, "executor/uninstall.sh")));
  await assert.rejects(() => f.runner.apply(request), /executor_operation_already_exists/);
});

test("stop-to-writer race with fence is unknown and never switches or restarts", async t => {
  const f = fixture(t); f.onStop = () => f.mutateJournal("INSERT INTO jobs(job_id,digest,grant_id,lease_id,state,plan_json,payload_json) VALUES('unresolved-root-task','','','','unknown','{}','{}')");
  const result = await f.runner.apply(f.request());
  assert.equal(result.receipt.status, "unknown"); assert.equal(result.receipt.code, "executor_journal_not_clean"); assert.equal(result.observation.current.build_id, "old"); assert.equal(f.active, false); assert.ok(!f.calls.includes("start"));
  assert.deepEqual({ ...result.observation.fenced }, { job_id: "unresolved-root-task", state: "unknown" });
});

test("policy generation is rechecked under writer and never lowered", async t => {
  const f = fixture(t); f.onStop = () => f.mutateJournal("UPDATE metadata SET value='5' WHERE key='policy_generation'");
  const result = await f.runner.apply(f.request()); assert.equal(result.receipt.status, "unknown"); assert.equal(result.observation.policy_generation, 5); assert.equal(result.observation.current.build_id, "old"); assert.ok(!f.calls.includes("start"));
  assert.equal(result.observation.repairable, true); f.onStop = undefined;
  const request = { ...f.request("repair", result.observation.current), expected_policy_generation: 5 }, repaired = await f.runner.apply(request); assert.equal(repaired.receipt.status, "started"); assert.equal(repaired.observation.policy_generation, 5); assert.equal(repaired.observation.activation_id, request.operation_id);
});

test("start failure preserves switched program, durable unknown and provable repair", async t => {
  const f = fixture(t); f.failStart = true; const request = f.request(), failed = await f.runner.apply(request);
  assert.equal(failed.receipt.status, "unknown"); assert.equal(failed.observation.current.build_id, "new"); assert.equal(failed.observation.phase, "start"); assert.equal(failed.observation.repairable, true); assert.ok(!JSON.stringify(failed).includes("private error"));
  const bytes = fs.readFileSync(f.runner.opFile(request.operation_id)); f.runner.status({ operation_id: request.operation_id }); assert.deepEqual(fs.readFileSync(f.runner.opFile(request.operation_id)), bytes);
  f.failStart = false; const repaired = await f.runner.apply(f.request("repair", failed.observation.current));
  assert.equal(repaired.receipt.status, "started"); assert.equal(repaired.observation.phase, "ready"); assert.equal(repaired.observation.previous.build_id, "old");
});

test("interrupted switch records actual target and repairs missing program link and unit", async t => {
  const f = fixture(t), atomic = f.runner.atomic.bind(f.runner); let interrupted = false;
  f.runner.atomic = (filename: string, value: any, mode?: number) => { if (!interrupted && filename === f.runner.unit) { interrupted = true; throw Error("simulated power loss after current rename"); } return atomic(filename, value, mode); };
  const failed = await f.runner.apply(f.request());
  assert.equal(failed.receipt.status, "unknown"); assert.equal(failed.observation.current.build_id, "new"); assert.equal(failed.observation.phase, "program"); assert.equal(failed.observation.repairable, true);
  fs.rmSync(f.p("opt/lightmoni-executor/current")); fs.rmSync(f.runner.launcher); fs.rmSync(f.runner.unit); fs.rmSync(f.runner.uninstaller);
  const partial = f.runner.probe(); assert.equal(partial.current.build_id, "new"); assert.equal(partial.repairable, true);
  const repaired = await f.runner.apply(f.request("repair", partial.current)); assert.equal(repaired.receipt.status, "started"); assert.equal(repaired.observation.previous.build_id, "old");
});

test("partial program evidence stays readable while a real journal fence blocks repair", t => {
  const f = fixture(t), state = JSON.parse(fs.readFileSync(f.runner.installState, "utf8")); state.phase = "program"; fs.writeFileSync(f.runner.installState, JSON.stringify(state));
  f.active = false; fs.rmSync(f.p("opt/lightmoni-executor/current")); fs.rmSync(f.runner.unit); f.mutateJournal("INSERT INTO jobs(job_id,digest,grant_id,lease_id,state,plan_json,payload_json) VALUES('real-unknown','','','','unknown','{}','{}')");
  const observation = f.runner.probe(); assert.equal(observation.repairable, false); assert.equal(observation.fenced.job_id, "real-unknown"); assert.equal(observation.current.build_id, "old"); assert.equal(observation.service_active, false);
});

test("busy writer produces durable unknown without switching or restarting", async t => {
  const f = fixture(t); f.runner.writer = async () => { throw Object.assign(Error(), { safeCode: "executor_writer_busy" }); };
  const result = await f.runner.apply(f.request()); assert.equal(result.receipt.status, "unknown"); assert.equal(result.receipt.code, "executor_writer_busy"); assert.equal(result.observation.current.build_id, "old"); assert.deepEqual(f.calls, ["stop"]);
  assert.equal(result.observation.repairable, true); assert.equal(result.observation.activation_id, f.source.activation_id);
  f.runner.writer = async (work: () => any) => work(); const request = f.request("repair", result.observation.current), repaired = await f.runner.apply(request); assert.equal(repaired.receipt.status, "started"); assert.equal(repaired.observation.activation_id, request.operation_id);
});

test("interrupted copy never publishes its stage and permits reviewed repair of source", async t => {
  const f = fixture(t); f.runner.copyRelease = (_source: string, destination: string) => { fs.mkdirSync(destination); fs.writeFileSync(join(destination, "partial"), "interrupted bytes"); throw Error("copy interrupted"); };
  const request = f.request(), failed = await f.runner.apply(request);
  assert.equal(failed.receipt.status, "unknown"); assert.equal(failed.observation.current.build_id, "old"); assert.equal(failed.observation.phase, "start"); assert.equal(failed.observation.repairable, true);
  assert.equal(fs.existsSync(f.p("opt/lightmoni-executor/releases/new")), false); assert.equal(fs.existsSync(f.p("opt/lightmoni-executor/releases/.stage." + request.operation_id)), true);
  const repaired = await f.runner.apply(f.request("repair", failed.observation.current)); assert.equal(repaired.receipt.status, "started"); assert.equal(repaired.observation.current.build_id, "old");
});

test("Linux copy directory modes are restored before fsync under umask 077", async t => {
  const f = fixture(t), request = f.request(), staging = f.p("opt/lightmoni-executor/releases/.stage." + request.operation_id);
  const mutableFs = createRequire(import.meta.url)("node:fs") as typeof fs;
  const originalCopy = mutableFs.cpSync, originalSync = f.runner.syncTree.bind(f.runner);
  let simulatedLinuxCopy = false, checkedBeforeSync = false;
  // macOS can preserve cpSync directory modes despite umask. Mask the copied
  // stage explicitly at the builtin boundary, before production restoration.
  const copyWithLinuxModes = (source: string, destination: string, options: any) => {
    originalCopy(source, destination, options);
    if (destination !== staging) return;
    const maskDirectories = (directory: string) => {
      const info = fs.lstatSync(directory); if (!info.isDirectory()) return;
      fs.chmodSync(directory, (info.mode & 0o777) & ~process.umask());
      for (const name of fs.readdirSync(directory)) maskDirectories(join(directory, name));
    };
    maskDirectories(destination); simulatedLinuxCopy = true;
    for (const name of ["", "app", "executor"]) assert.equal(fs.lstatSync(join(staging, name)).mode & 0o777, 0o700);
  };
  f.runner.syncTree = (filename: string) => {
    if (filename === staging) {
      for (const name of ["", "app", "app/runtime/dist/privileged-executor", "executor"]) assert.equal(fs.lstatSync(join(staging, name)).mode & 0o777, 0o755);
      for (const [name, mode] of [["node", 0o755], ["executor/launcher.sh", 0o755], ["release.json", 0o644], ["app/runtime/dist/privileged-executor/main.js", 0o644]] as const) assert.equal(fs.lstatSync(join(staging, name)).mode & 0o777, mode);
      checkedBeforeSync = true;
    }
    originalSync(filename);
  };
  const previousUmask = process.umask(0o077);
  try {
    mutableFs.cpSync = copyWithLinuxModes as typeof fs.cpSync; syncBuiltinESMExports();
    const result = await f.runner.apply(request);
    assert.equal(result.receipt.status, "started", "masked copy modes must be restored before fingerprint verification");
    assert.equal(simulatedLinuxCopy, true); assert.equal(checkedBeforeSync, true);
  } finally { mutableFs.cpSync = originalCopy; syncBuiltinESMExports(); process.umask(previousUmask); }
});

test("umask 077 extraction reuses the exact root release after rollback", async t => {
  const f = fixture(t), first = await f.runner.apply(f.request()); assert.equal(first.receipt.status, "started");
  const rollback = await f.runner.apply(f.request("rollback", first.observation.previous)); assert.equal(rollback.receipt.status, "started");
  // Each server dispatch normally supplies a fresh /run mktemp; discard only
  // this test's previous extraction output to reuse its archive fixture.
  fs.rmSync(f.p("run/lightmoni-executor-maintenance.fixture/unpacked"), { recursive: true });
  f.runner.copyRelease = () => assert.fail("matching retained release must be reused without overwrite");
  const previousUmask = process.umask(0o077);
  try {
    const second = await f.runner.apply(f.request()); assert.equal(second.receipt.status, "started"); assert.equal(second.observation.current.fingerprint, first.observation.current.fingerprint);
    const staged = f.p("run/lightmoni-executor-maintenance.fixture/unpacked/lightmoni-agent-runtime");
    for (const directory of [staged, join(staged, "app"), join(staged, "app/runtime/dist/privileged-executor"), join(staged, "executor")]) assert.equal(fs.lstatSync(directory).mode & 0o777, 0o755);
    for (const [name, mode] of [["node", 0o755], ["executor/launcher.sh", 0o755], ["release.json", 0o644], ["app/runtime/dist/privileged-executor/main.js", 0o644]] as const) assert.equal(fs.lstatSync(join(staged, name)).mode & 0o777, mode);
    assert.equal(fs.lstatSync(f.p("run/lightmoni-executor-maintenance.fixture/unpacked")).mode & 0o777, 0o700);
  } finally { process.umask(previousUmask); }
});

test("baseline requires new protocol receipts and the complete bundled supervisor", t => {
  const f = fixture(t); f.runner.assertSupervisor(join(f.old, "executor/maintenance.mjs"), join(f.old, "node"));
  assert.throws(() => f.runner.assertSupervisor(join(f.old, "executor/maintenance.mjs"), process.execPath), /executor_untrusted_supervisor/);
  const state = JSON.parse(fs.readFileSync(f.runner.releaseState, "utf8")); delete state.maintenance_protocol; fs.writeFileSync(f.runner.releaseState, JSON.stringify(state)); assert.throws(() => f.runner.probe(), /executor_invalid_release_receipt/);
  fs.rmSync(join(f.old, "executor/maintenance.mjs")); assert.throws(() => f.runner.tree(f.old));
});

test("repair requires exact interrupted phase, identity and complete journal", async t => {
  const f = fixture(t); await assert.rejects(() => f.runner.apply(f.request("repair", f.source.current)), /executor_not_repairable/);
  const state = JSON.parse(fs.readFileSync(f.runner.installState, "utf8")); state.phase = "start"; state.identity.agent_id = "different-agent"; fs.writeFileSync(f.runner.installState, JSON.stringify(state));
  assert.equal(f.runner.probe().repairable, false); await assert.rejects(() => f.runner.apply(f.request("repair", f.source.current)), /executor_not_repairable/);
  state.phase = "enrollment_pending"; state.identity = null; fs.writeFileSync(f.runner.installState, JSON.stringify(state)); assert.equal(f.runner.probe().repairable, false);
  fs.rmSync(f.p("var/lib/lightmoni-executor/journal.sqlite")); assert.throws(() => f.runner.probe()); assert.equal(fs.existsSync(f.p("var/lib/lightmoni-executor/journal.sqlite")), false); assert.deepEqual(f.calls, []);
});

test("wrong source, key, schema, rollback fingerprint or expired approval stops before side effects", async t => {
  const f = fixture(t);
  for (const change of [ { expected_fingerprint: "0".repeat(64) }, { public_key_sha256: "0".repeat(64) }, { agent_id: undefined }, { center_instance_id: undefined }, { public_key_sha256: undefined }, { target: { ...f.request().target, state_schema: 2 } }, { action: "rollback", target: { ...f.source.current, fingerprint: "0".repeat(64) } }, { action: "repair", target: { ...f.source.current, fingerprint: undefined } }, { start_deadline: new Date(0).toISOString() } ]) await assert.rejects(() => f.runner.apply({ ...f.request(), ...change }));
  assert.deepEqual(f.calls, []);
});

test("unsafe unit/drop-in and full-tree permissions are refused before stop", async t => {
  const f = fixture(t); fs.mkdirSync(f.p("etc/systemd/system/lightmoni-executor.service.d")); assert.throws(() => f.runner.probe(), /executor_unmanaged_service/); fs.rmSync(f.p("etc/systemd/system/lightmoni-executor.service.d"), { recursive: true });
  fs.chmodSync(join(f.old, "app/runtime/dist/privileged-executor/main.js"), 0o666); assert.throws(() => f.runner.probe(), /executor_unsafe_release/); assert.deepEqual(f.calls, []);
});

function tar(entries: Array<{ name: string; type?: string; link?: string; body?: string }>) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), body = Buffer.from(entry.body ?? ""); header.write(entry.name); header.write("0000755\0", 100); header.write(body.length.toString(8).padStart(11, "0") + "\0", 124); header[156] = (entry.type ?? "0").charCodeAt(0); if (entry.link) header.write(entry.link, 157); header.fill(32, 148, 156); const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148); parts.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(parts));
}

for (const [name, entries] of [
  ["parent traversal", [{ name: "lightmoni-agent-runtime/../outside" }]],
  ["hard link", [{ name: "lightmoni-agent-runtime/hard", type: "1", link: "node" }]],
  ["duplicate", [{ name: "lightmoni-agent-runtime/file" }, { name: "lightmoni-agent-runtime/file" }]],
  ["escaping link", [{ name: "lightmoni-agent-runtime/link", type: "2", link: "../../outside" }]],
  ["symlink parent", [{ name: "lightmoni-agent-runtime/link", type: "2", link: "inside" }, { name: "lightmoni-agent-runtime/link/file" }]],
] as const) test(`archive ${name} is rejected before writing extraction output`, t => {
  const f = fixture(t), output = f.p("run/rejected-extraction"); assert.throws(() => f.runner.extract(tar(entries as any), output)); assert.equal(fs.existsSync(output), false); assert.deepEqual(f.calls, []);
});
