import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { readAgentRelease } from "../src/agent/release.js";
import { agentUpdateProbeSource, agentUpdateStartCommand, parseAgentUpdateProbe, parseAgentUpdateStatus } from "../src/server/machine-agent-update-ssh.js";
const repo = resolve(import.meta.dirname, "../..");
const { AgentMaintenance } = await import(pathToFileURL(join(repo, "deploy/agent/update-runner.mjs")).href);
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");

/** Execute the production SSH probe against the same isolated installation as
 * the executor. Only fixed paths, root ownership and command effects are mapped;
 * the fingerprint implementation itself is not reimplemented or replaced. */
function sshProbe(f: ReturnType<typeof fixture>) {
  let source = agentUpdateProbeSource;
  for (const name of ["/opt/lightmoni-agent", "/etc/systemd/system/lightmoni-agent.service", "/usr/local/bin/lightmoni-agent", "/var/lib/lightmoni-agent", "/run/lightmoni-agent-lifecycle.lock"])
    source = source.replaceAll(name, f.p(name));
  const fixturePath = (filename: string) => {
    if (filename !== f.root && !filename.startsWith(f.root + "/")) throw Error("probe attempted a non-fixture read");
    return filename;
  };
  let stdout = "";
  const process = { arch: "arm64", stdout: { write(value: string) { stdout += value; } }, exitCode: 0 };
  runInNewContext(source, { process, require(name: string) {
    if (name === "node:path") return path;
    if (name === "node:crypto") return { createHash };
    if (name === "node:child_process") return { execFileSync: f.maintenance.command };
    if (name === "node:fs") return {
      readFileSync: (filename: string, options?: any) => fs.readFileSync(fixturePath(filename), options),
      realpathSync: (filename: string) => fs.realpathSync(fixturePath(filename)),
      existsSync: (filename: string) => fs.existsSync(fixturePath(filename)),
      lstatSync(filename: string) {
        if (filename === "/" || f.root.startsWith(filename + "/"))
          return { uid: 0, mode: 0o755, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
        const info = fs.lstatSync(fixturePath(filename));
        info.uid = 0; // Production paths are root owned; fixtures use the test user.
        return info;
      },
    };
    throw Error("unexpected probe module " + name);
  } }, { timeout: 1000 });
  return parseAgentUpdateProbe(stdout);
}

function fixture(t: any, options: { legacy?: boolean; failTarget?: boolean; failRollback?: boolean; oldHelper?:boolean; targetHelper?:boolean; targetPermissions?:boolean; failPermissionPreparation?:boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "lm-update-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = (name: string) => join(root, name);
  for (const name of ["opt/lightmoni-agent/releases/old/app/runtime/dist/agent", "etc/systemd/system", "etc/lightmoni-agent", "var/lib/lightmoni-agent", "usr/local/bin", "run", "staging"])
    fs.mkdirSync(p(name), { recursive: true, mode: 0o755 });
  const old = p("opt/lightmoni-agent/releases/old"), arch = "arm64";
  fs.writeFileSync(join(old, "node"), "synthetic trusted Node\n", { mode: 0o755 });
  fs.writeFileSync(join(old, "app/runtime/dist/agent/main.js"), "// old code\n");
  if(options.oldHelper??!options.legacy){
    fs.mkdirSync(p("usr/local/sbin"),{recursive:true,mode:0o755});
    fs.writeFileSync(join(old,"uninstall.sh"),"#!/bin/sh\n# old offline helper\n",{mode:0o755});
    fs.writeFileSync(p("usr/local/sbin/lightmoni-agent-uninstall"),"#!/bin/sh\n# old offline helper\n",{mode:0o750});
  }
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
  if(options.targetHelper!==false)fs.writeFileSync(join(runtime,"uninstall.sh"),"#!/bin/sh\n# new offline helper\n",{mode:0o755});
  if(options.targetPermissions)fs.writeFileSync(join(runtime,"deployment-permissions.mjs"),"// trusted permission helper fixture\n");
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
      if(args[0]?.endsWith('/deployment-permissions.mjs')&&args[1]==='prepare'&&options.failPermissionPreparation)throw Error('private permission setup failure');
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

test('upgrades validate ordinary account permissions before stopping the old Agent',async t=>{
  const f=fixture(t,{targetPermissions:true}),request=f.request();
  await f.maintenance.start(request);
  f.onSleep(()=>{const s=f.maintenance.state(request.operation_id);if(s.status==='waiting_confirmation')f.maintenance.commit({operation_id:request.operation_id,expected_boot_id:s.local_health.boot_id,expected_target_sha256:request.target.artifact_sha256});});
  assert.equal((await f.maintenance.worker(request.operation_id)).status,'succeeded');
  const prepare=f.calls.findIndex(([,args])=>args[0]?.endsWith('/deployment-permissions.mjs')&&args[1]==='prepare');
  const stop=f.calls.findIndex(([file,args])=>file==='systemctl'&&args[0]==='stop');
  assert.ok(prepare>=0&&stop>prepare);
  f.preserve();
});

test('failed ordinary permission validation leaves the old Agent and its state running',async t=>{
  const f=fixture(t,{targetPermissions:true,failPermissionPreparation:true}),request=f.request();
  await f.maintenance.start(request);
  const result=await f.maintenance.worker(request.operation_id);
  assert.equal(result.status,'failed');
  assert.equal(f.maintenance.currentPath(),f.old);
  assert(!f.calls.some(([file,args])=>file==='systemctl'&&args[0]==='stop'));
  assert.doesNotMatch(JSON.stringify(result),/private permission setup failure/);
  f.preserve();
});

test("same-version upgrade is bound to source/build/digest and commits only a new boot; identity, credentials and live queue survive", async t => {
  const f = fixture(t), request = f.request(), before = f.maintenance.probe();
  request.expected_fingerprint = sshProbe(f).current.fingerprint;
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
  const ssh = sshProbe(f);
  assert.equal(ssh.current.fingerprint, probe.current.fingerprint);
  assert.equal(ssh.previous!.fingerprint, probe.previous.fingerprint);
  assert.equal(probe.lifecycle_locked, false);
  assert.equal(fs.statSync(join(fs.realpathSync(f.p("opt/lightmoni-agent/current")), "installation.json")).mode & 0o777, 0o644);
  assert.equal(parseAgentUpdateProbe(JSON.stringify(probe)).current.build_id, "new-build");
  assert.equal(parseAgentUpdateStatus(JSON.stringify(result)).status, "succeeded");
  assert.equal(parseAgentUpdateStatus(JSON.stringify(result)).uninstaller_updated, true);
  assert.equal(result.uninstaller_updated,true);
  assert.match(fs.readFileSync(f.p("usr/local/sbin/lightmoni-agent-uninstall"),"utf8"),/new offline helper/);
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
  assert.match(fs.readFileSync(f.p("usr/local/sbin/lightmoni-agent-uninstall"),"utf8"),/old offline helper/);
  assert.equal(fs.statSync(f.p("usr/local/sbin/lightmoni-agent-uninstall")).mode&0o777,0o750);
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

test("an old target package retains the current offline helper without claiming synchronization",async t=>{
  const f=fixture(t,{targetHelper:false}),request=f.request(),helper=f.p("usr/local/sbin/lightmoni-agent-uninstall"),before=fs.readFileSync(helper);
  await f.maintenance.start(request);f.onSleep(()=>{const s=f.maintenance.state(request.operation_id);if(s.status==="waiting_confirmation")f.maintenance.commit({operation_id:request.operation_id,expected_boot_id:s.local_health.boot_id,expected_target_sha256:request.target.artifact_sha256});});
  const result=await f.maintenance.worker(request.operation_id);assert.equal(result.status,"succeeded");assert.equal(result.uninstaller_updated,false);assert.equal(parseAgentUpdateStatus(JSON.stringify(result)).uninstaller_updated,false);assert.deepEqual(fs.readFileSync(helper),before);f.preserve();
});
test("automatic restoration removes a newly introduced helper and its empty parent",async t=>{
  const f=fixture(t,{oldHelper:false,failTarget:true}),request=f.request();
  await f.maintenance.start(request);const result=await f.maintenance.worker(request.operation_id);
  assert.equal(result.status,"rolled_back");assert.equal(fs.existsSync(f.p("usr/local/sbin/lightmoni-agent-uninstall")),false);assert.equal(fs.existsSync(f.p("usr/local/sbin")),false);f.preserve();
});
test("explicit rollback selects the retained program's offline helper",async t=>{
  const f=fixture(t),first=f.request();
  const complete=async(request:any)=>{await f.maintenance.start(request);f.onSleep(()=>{const s=f.maintenance.state(request.operation_id);if(s.status==="waiting_confirmation")f.maintenance.commit({operation_id:request.operation_id,expected_boot_id:s.local_health.boot_id,expected_target_sha256:request.target.artifact_sha256});});return f.maintenance.worker(request.operation_id);};
  assert.equal((await complete(first)).status,"succeeded");
  const observed=sshProbe(f),rollback={...f.request(),expected_fingerprint:observed.current.fingerprint,action:"rollback",target:{...observed.previous},archive_path:undefined};
  assert.equal((await complete(rollback)).status,"succeeded");assert.equal(fs.realpathSync(f.p("opt/lightmoni-agent/current")),f.old);assert.match(fs.readFileSync(f.p("usr/local/sbin/lightmoni-agent-uninstall"),"utf8"),/old offline helper/);f.preserve();
});
test("a redirected helper is refused before stopping the current program",async t=>{
  const f=fixture(t),request=f.request(),helper=f.p("usr/local/sbin/lightmoni-agent-uninstall"),outside=f.p("business-script");
  fs.writeFileSync(outside,"business preserved");fs.unlinkSync(helper);fs.symlinkSync(outside,helper);
  await f.maintenance.start(request);const result=await f.maintenance.worker(request.operation_id);
  assert.equal(result.status,"failed");assert.equal(result.error_code,"unsafe_managed_path");assert.equal(f.calls.some(([,args])=>args[0]==="stop"),false);assert.equal(fs.readFileSync(outside,"utf8"),"business preserved");f.preserve();
});
for(const marker of ['{"id":null}','{"id":1}','[]','null','{"id":"","receipt":{}}'])test("uncertain task state also blocks upgrades: "+marker,async t=>{
  const f=fixture(t),request=f.request();fs.writeFileSync(f.p("var/lib/lightmoni-agent/task-run-state.json"),marker);
  await assert.rejects(f.maintenance.start(request),/operation_conflict/);assert.equal(f.calls.some(([,args])=>args[0]==="stop"),false);f.preserve();
});
test("a dangling operation lock remains a maintenance barrier",async t=>{
  const f=fixture(t),request=f.request();fs.mkdirSync(f.p("var/lib/lightmoni-agent/operations"));fs.symlinkSync(f.p("missing-operation"),f.p("var/lib/lightmoni-agent/operations/execution.lock"));
  await assert.rejects(f.maintenance.start(request),/operation_conflict/);f.preserve();
});
test("changing a retained offline helper invalidates the approved rollback source",async t=>{
  const f=fixture(t),request=f.request();await f.maintenance.start(request);
  f.onSleep(()=>{const s=f.maintenance.state(request.operation_id);if(s.status==="waiting_confirmation")f.maintenance.commit({operation_id:request.operation_id,expected_boot_id:s.local_health.boot_id,expected_target_sha256:request.target.artifact_sha256});});
  assert.equal((await f.maintenance.worker(request.operation_id)).status,"succeeded");
  fs.appendFileSync(join(f.old,"uninstall.sh"),"# unreviewed change\n");assert.throws(()=>f.maintenance.probe(),/previous_release_changed/);f.preserve();
});

for (const oldHelper of [false, true]) test(`SSH and executor fingerprints agree with ${oldHelper ? "an installed" : "no"} offline helper`, t => {
  const f = fixture(t, { oldHelper });
  assert.deepEqual(sshProbe(f).current, f.maintenance.probe().current);
  if (!oldHelper) {
    const release = f.maintenance.metadata(f.old);
    const expected = sha(JSON.stringify({ release_path: f.old, release,
      manifest: sha(fs.readFileSync(join(f.old, "release.json"))), launcher: sha(fs.readFileSync(f.p("usr/local/bin/lightmoni-agent"))),
      service: sha(fs.readFileSync(f.p("etc/systemd/system/lightmoni-agent.service"))), node: sha(fs.readFileSync(join(f.old, "node"))),
      entrypoint: sha(fs.readFileSync(join(f.old, "app/runtime/dist/agent/main.js"))) }));
    assert.equal(sshProbe(f).current.fingerprint, expected, "pre-helper approval fingerprints stay compatible");
  }
  f.preserve();
});

test("both probes bind offline helper bytes and refuse a redirected release helper", t => {
  const f = fixture(t), original = sshProbe(f).current.fingerprint;
  fs.appendFileSync(join(f.old, "uninstall.sh"), "# changed helper\n");
  const changed = sshProbe(f).current.fingerprint;
  assert.notEqual(changed, original);
  assert.equal(changed, f.maintenance.probe().current.fingerprint);
  fs.unlinkSync(join(f.old, "uninstall.sh"));
  fs.symlinkSync(f.p("etc/lightmoni-agent/config.json"), join(f.old, "uninstall.sh"));
  assert.throws(() => sshProbe(f), /invalid_response/);
  assert.throws(() => f.maintenance.probe(), /unsafe_managed_path/);
  assert.equal(f.calls.some(([, args]) => args[0] === "stop"), false);
  f.preserve();
});

test("maintenance receipt preserves absent helper evidence and rejects non-boolean synchronization flags", async t => {
  const f = fixture(t), request = f.request(), accepted = await f.maintenance.start(request);
  assert.equal(parseAgentUpdateStatus(JSON.stringify(accepted)).uninstaller_updated, undefined);
  for (const value of [null, 0, "false", {}])
    assert.throws(() => parseAgentUpdateStatus(JSON.stringify({ ...accepted, uninstaller_updated: value })), /invalid_response/);
  f.preserve();
});
