import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { runInNewContext } from "node:vm";
import { readAgentRelease } from "../src/agent/release.js";
import { agentUpdateProbeSource, agentUpdateStartCommand, parseAgentUpdateProbe, parseAgentUpdateStatus, USER_AGENT_SERVICE_SHA256 as SSH_ORDINARY_SERVICE_SHA256 } from "../src/server/machine-agent-update-ssh.js";
const repo = resolve(import.meta.dirname, "../..");
const { AgentMaintenance, ORDINARY_AGENT_SERVICE_SHA256 } = await import(pathToFileURL(join(repo, "deploy/agent/update-runner.mjs")).href);
const {buildAgentService}=await import(pathToFileURL(join(repo,'deploy/agent/service-unit.mjs')).href);
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");

/** Execute the production SSH probe against the same isolated installation as
 * the executor. Only fixed paths, root ownership and command effects are mapped;
 * the fingerprint implementation itself is not reimplemented or replaced. */
function sshProbe(f: ReturnType<typeof fixture>) {
  let source = agentUpdateProbeSource;
  source = source.replace(/\/opt\/lightmoni-agent|\/etc\/systemd\/system\/lightmoni-agent(?:-helper)?\.service|\/etc\/lightmoni-agent(?:-helper)?|\/usr\/local\/bin\/lightmoni-agent|\/var\/lib\/lightmoni-agent(?:-helper)?|\/run\/lightmoni-agent-lifecycle\.lock/g, value => f.p(value));
  const fixturePath = (filename: string) => {
    if (filename !== f.root && !filename.startsWith(f.root + "/")) throw Error("probe attempted a non-fixture read");
    return filename;
  };
  let stdout = "";
  const process = { arch: "arm64", stdout: { write(value: string) { stdout += value; } }, exitCode: 0 };
  runInNewContext(source, { process, Buffer, require(name: string) {
    if (name === "node:path") return path;
    if (name === "node:crypto") return { createHash };
    if (name === "node:child_process") return { execFileSync: f.maintenance.command };
    if (name === "node:fs") return {
      readFileSync: (filename: string, options?: any) => fs.readFileSync(fixturePath(filename), options),
      openSync: (filename:string,flags:any)=>fs.openSync(fixturePath(filename),flags),
      readSync: fs.readSync, closeSync:fs.closeSync, fstatSync:fs.fstatSync,
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
  try{return parseAgentUpdateProbe(stdout);}catch(error){throw Error(String(error)+' probe='+stdout);}
}

function fixture(t: any, options: { legacy?: boolean; failTarget?: boolean; failRollback?: boolean; oldHelper?:boolean; targetHelper?:boolean; targetPermissions?:boolean; failPermissionPreparation?:boolean; privilegedService?:boolean; runtimeMode?:'root'|'user' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "lm-update-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = (name: string) => join(root, name);
  for (const name of ["opt/lightmoni-agent/releases/old/app/runtime/dist/agent", "etc/systemd/system", "etc/lightmoni-agent", "var/lib/lightmoni-agent", "usr/local/bin", "usr/local/sbin", "run", "staging"])
    fs.mkdirSync(p(name), { recursive: true, mode: 0o755 });
  const old = p("opt/lightmoni-agent/releases/old"), arch = "arm64";
  fs.writeFileSync(join(old, "node"), "synthetic trusted Node\n", { mode: 0o755 });
  fs.writeFileSync(join(old, "app/runtime/dist/agent/main.js"), "// old code\n");
  if(options.oldHelper??!options.legacy){
    fs.mkdirSync(p("usr/local/sbin"),{recursive:true,mode:0o755});
    fs.writeFileSync(join(old,"uninstall.sh"),"#!/bin/sh\n# old offline helper\n",{mode:0o755});
    fs.writeFileSync(p("usr/local/sbin/lightmoni-agent-uninstall"),"#!/bin/sh\n# old offline helper\n",{mode:0o750});
  }
  fs.writeFileSync(join(old,"deployment-permissions.mjs"),"// current ordinary permission verifier fixture\n");
  fs.writeFileSync(join(old, "release.json"), JSON.stringify(options.legacy ? { version: "0.1.0", platform: "linux", arch, node_version: "24.15.0", requires: "glibc >= 2.28", node_sha256: "e".repeat(64) } : { version: "0.1.0", platform: "linux", arch, source_revision: "a".repeat(40), build_id: "old-build", state_schema: 1 }));
  if (!options.legacy) fs.writeFileSync(join(old, "installation.json"), JSON.stringify({ schema: 1, artifact_sha256: "1".repeat(64) }));
  fs.symlinkSync(old, p("opt/lightmoni-agent/current"));
  fs.writeFileSync(p("usr/local/bin/lightmoni-agent"), "#!/bin/sh\n# old launcher\n", { mode: 0o755 });
  fs.writeFileSync(p("etc/systemd/system/lightmoni-agent.service"), fs.readFileSync(join(repo,options.privilegedService?"runtime/test/fixtures/forbidden-privileged-agent.service":"deploy/agent/lightmoni-agent.service")));
  fs.writeFileSync(p("etc/lightmoni-agent/config.json"), '{"control_credential":"test-private-control","data_credential":"test-private-data"}\n', { mode: 0o600 });
  if(options.runtimeMode){fs.writeFileSync(p('etc/systemd/system/lightmoni-agent.service'),buildAgentService(options.runtimeMode));fs.writeFileSync(p('etc/lightmoni-agent/config.json'),JSON.stringify({control_credential:'test-private-control',data_credential:'test-private-data',runtime_mode:options.runtimeMode,permission_generation:7}),{mode:0o600});}
  if(options.runtimeMode==='root'){
    fs.mkdirSync(p('etc/lightmoni-agent-helper'),{recursive:true,mode:0o700});
    fs.mkdirSync(p('var/lib/lightmoni-agent-helper/managed'),{recursive:true,mode:0o711});
    fs.mkdirSync(p('var/lib/lightmoni-agent-helper/tasks'),{recursive:true,mode:0o711});
    fs.writeFileSync(p('etc/lightmoni-agent-helper/helper.json'),JSON.stringify({permission_generation:7,agent_id:'fixture-agent'}),{mode:0o600});
    fs.writeFileSync(p('etc/lightmoni-agent-helper/managed.json'),JSON.stringify({executor_id:'signed-identity',install_generation:3,agent_id:'fixture-agent'}),{mode:0o600});
    fs.writeFileSync(p('etc/systemd/system/lightmoni-agent-helper.service'),fs.readFileSync(join(repo,'deploy/agent/lightmoni-agent-helper.service')));
    fs.writeFileSync(p('var/lib/lightmoni-agent-helper/managed/journal.json'),'{"fenced":null}');
  }
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
  if(options.targetPermissions!==false)fs.writeFileSync(join(runtime,"deployment-permissions.mjs"),"// trusted permission helper fixture\n");
  fs.writeFileSync(join(runtime, "padding"), randomBytes(4096));
  fs.writeFileSync(join(packageDir, "lightmoni-agent"), "#!/bin/sh\n# new launcher\n", { mode: 0o755 });
  fs.writeFileSync(join(packageDir, "lightmoni-agent.service"), fs.readFileSync(join(repo,"deploy/agent/lightmoni-agent.service")));
  fs.writeFileSync(join(packageDir, "lightmoni-agent-helper.service"), fs.readFileSync(join(repo,"deploy/agent/lightmoni-agent-helper.service")));
  const archive = p("staging/bundle.tar.gz");
  const repack = () => execFileSync("tar", ["-czf", archive, "-C", packageDir, "lightmoni-agent", "lightmoni-agent.service", "lightmoni-agent-helper.service", "lightmoni-agent-runtime"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  repack();
  let now = Date.now(), active = true, helperActive=options.runtimeMode==='root', boot = randomUUID(), restarts = 0;
  const calls: Array<[string, string[]]> = [];
  let onSleep: undefined | (() => void);
  const maintenance = new AgentMaintenance({ root, arch, uid: process.getuid?.() ?? 0, now: () => now, sleep: async (ms: number) => { now += ms; onSleep?.(); }, launch: () => {},
    command: (file: string, args: string[]) => {
      calls.push([file, args]);
      if(args[0]?.endsWith('/deployment-permissions.mjs')&&args[1]==='prepare'&&options.failPermissionPreparation)throw Error('private permission setup failure');
      if (file === "systemctl") {
        if (args[0] === "show") {
          const helper=args.includes('lightmoni-agent-helper.service');
          if (args.includes("--property=ActiveState")) return (helper?helperActive:active) ? "active" : "inactive";
          if (args.includes("--property=FragmentPath")) return helper?(fs.existsSync(p('etc/systemd/system/lightmoni-agent-helper.service'))?p('etc/systemd/system/lightmoni-agent-helper.service'):''):p("etc/systemd/system/lightmoni-agent.service");
          if (args.includes("--property=LoadState")) return helper?(fs.existsSync(p('etc/systemd/system/lightmoni-agent-helper.service'))?'loaded':'not-found'):'loaded';
          if (args.includes("--property=DropInPaths")) return '';
        }
        if (args[0] === "stop") {if(args[1]==='lightmoni-agent-helper.service')helperActive=false;else active = false;}
        if (args[0] === "restart") {
          if(args[1]==='lightmoni-agent-helper.service')helperActive=true;
          else {restarts++; boot = randomUUID();
            const current = fs.realpathSync(p("opt/lightmoni-agent/current"));
            if (options.failTarget && current !== old || options.failRollback && current === old && restarts > 1) throw Error("synthetic restart failure must not leak");
            active = true;
          }
        }
        return "";
      }
      if (args[0] === "status") {
        const current = fs.realpathSync(p("opt/lightmoni-agent/current"));
        const meta = maintenance.metadata(current);
        const config=JSON.parse(fs.readFileSync(p('etc/lightmoni-agent/config.json'),'utf8'));
        return JSON.stringify({ agent_id: "fixture-agent", runtime:{uid:19999,gid:19998,mode:config.runtime_mode||'user',permission_generation:config.permission_generation||1}, ...(options.legacy && current === old ? {} : { boot_id: boot, release: meta }) });
      }
      if(args[0]==='managed-status'||args[0]==='helper-status')return JSON.stringify({executor_id:'signed-identity',install_generation:3,permission_generation:JSON.parse(fs.readFileSync(p('etc/lightmoni-agent/config.json'),'utf8')).permission_generation??1,fenced:null,pending_results:0,ordinary_task_identity:{account:'lightmoni-agent',uid:19999,gid:19998},ordinary_task_runner:{active:false,state:'idle'}});
      return "configuration valid";
    },
  });
  // Simulate the already-reviewed runtime transition. The tests below isolate
  // maintenance candidate selection; the runtime transition itself has its own
  // real implementation fixtures in agent-runtime-maintenance.test.ts.
  const setRuntimeMode = (mode: 'user'|'root') => {
    const file=p('etc/lightmoni-agent/config.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
    const generation=(config.permission_generation??1)+1;
    fs.writeFileSync(file,JSON.stringify({...config,runtime_mode:mode,permission_generation:generation}),{mode:0o600});
    if(mode==='root') {
      fs.mkdirSync(p('etc/lightmoni-agent-helper'),{recursive:true,mode:0o700});
      fs.mkdirSync(p('var/lib/lightmoni-agent-helper/managed'),{recursive:true,mode:0o711});
      fs.mkdirSync(p('var/lib/lightmoni-agent-helper/tasks'),{recursive:true,mode:0o711});
      fs.writeFileSync(p('etc/lightmoni-agent-helper/helper.json'),JSON.stringify({permission_generation:generation,agent_id:'fixture-agent'}),{mode:0o600});
      fs.writeFileSync(p('etc/lightmoni-agent-helper/managed.json'),JSON.stringify({executor_id:'signed-identity',install_generation:3,agent_id:'fixture-agent'}),{mode:0o600});
      fs.writeFileSync(p('etc/systemd/system/lightmoni-agent-helper.service'),fs.readFileSync(join(repo,'deploy/agent/lightmoni-agent-helper.service')));
      fs.writeFileSync(p('var/lib/lightmoni-agent-helper/managed/journal.json'),'{}');
    } else {
      fs.rmSync(p('etc/lightmoni-agent-helper'),{recursive:true,force:true});
      fs.rmSync(p('var/lib/lightmoni-agent-helper'),{recursive:true,force:true});
      fs.rmSync(p('etc/systemd/system/lightmoni-agent-helper.service'),{force:true});
    }
    helperActive=mode==='root';
  };
  const request = () => ({ operation_id: randomBytes(16).toString("hex"), expected_agent_id: "fixture-agent", expected_fingerprint: maintenance.probe().current.fingerprint, expected_service_active: active, start_deadline: new Date(now + 180000).toISOString(), action: "upgrade", target: { version: manifest.version, source_revision: manifest.source_revision, build_id: manifest.build_id, state_schema: 1, arch, artifact_sha256: sha(fs.readFileSync(archive)) }, archive_path: archive, confirm_timeout_seconds: 10 });
  const preserve = () => { for (const [name, bytes] of Object.entries(saved)) assert.deepEqual(fs.readFileSync(p(name)), bytes, name + " retained"); };
  return { root, p, old, runtime, packageDir, archive, manifest, maintenance, request, calls, repack, preserve, setRuntimeMode, setActive: (value: boolean) => { active = value; }, setHelperActive: (value: boolean) => { helperActive = value; }, onSleep: (callback: () => void) => { onSleep = callback; }, helperIsActive:()=>helperActive };
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

test("both probes bind offline helper bytes and refuse a redirected release helper", t => {
  const f = fixture(t), original = sshProbe(f).current.fingerprint;
  fs.appendFileSync(join(f.old, "uninstall.sh"), "# changed helper\n");
  const changed = sshProbe(f).current.fingerprint;
  assert.notEqual(changed, original);
  assert.equal(changed, f.maintenance.probe().current.fingerprint);
  fs.unlinkSync(join(f.old, "uninstall.sh"));
  fs.symlinkSync(f.p("etc/lightmoni-agent/config.json"), join(f.old, "uninstall.sh"));
  assert.throws(() => sshProbe(f), /未通过受管指纹/);
  assert.throws(() => f.maintenance.probe(), /unsafe_managed_path/);
  assert.equal(f.calls.some(([, args]) => args[0] === "stop"), false);
  f.preserve();
});

test("maintenance receipt preserves absent helper evidence and rejects non-boolean synchronization flags", async t => {
  const f = fixture(t), request = f.request(), accepted = await f.maintenance.start(request);
  assert.equal(parseAgentUpdateStatus(JSON.stringify(accepted)).uninstaller_updated, undefined);
  assert.equal(parseAgentUpdateStatus(JSON.stringify(accepted)).local_health.helper_active, false);
  for (const value of [null, 0, "false", {}])
    assert.throws(() => parseAgentUpdateStatus(JSON.stringify({ ...accepted, uninstaller_updated: value })), /invalid_response/);
  for (const value of [undefined, null, 0, "true"])
    assert.throws(() => parseAgentUpdateStatus(JSON.stringify({ ...accepted, local_health: { ...accepted.local_health, helper_active: value } })), /invalid_response/);
  f.preserve();
});

for(const kind of ['unknown','changed-known','symlink','writable','effective-external'])test(`maintenance preserves and rejects ${kind} override before acquiring lifecycle lock`,async t=>{
  const f=fixture(t),request=f.request(),directory=f.p('etc/systemd/system/lightmoni-agent.service.d'),file=join(directory,kind==='unknown'?'10-administrator.conf':'20-lightmoni-docker.conf');
  fs.mkdirSync(directory,{mode:0o755});const bytes='[Service]\nSupplementaryGroups=docker\n';
  if(kind==='symlink')fs.symlinkSync(f.p('etc/lightmoni-agent/config.json'),file);else fs.writeFileSync(file,kind==='changed-known'?bytes+'# changed\n':bytes,{mode:0o644});
  if(kind==='writable')fs.chmodSync(file,0o666);
  if(kind==='effective-external'){const command=f.maintenance.command;f.maintenance.command=(program:string,args:string[])=>program==='systemctl'&&args.includes('--property=DropInPaths')?'/run/systemd/system/lightmoni-agent.service.d/external.conf':command(program,args);}
  await assert.rejects(()=>f.maintenance.start(request),/agent_service_override_not_allowed|unsafe_managed_path/);
  assert.equal(fs.existsSync(file),true);assert.equal(fs.existsSync(f.maintenance.lock),false);assert.equal(f.calls.some(([program,args])=>program==='systemctl'&&args[0]==='stop'),false);f.preserve();
});


test("maintenance and SSH probes bind the exact checked-in least-privilege unit",()=>{
  const actual=sha(fs.readFileSync(join(repo,"deploy/agent/lightmoni-agent.service")));
  assert.equal(actual,ORDINARY_AGENT_SERVICE_SHA256);assert.equal(actual,SSH_ORDINARY_SERVICE_SHA256);
  assert.notEqual(sha(fs.readFileSync(join(repo,"runtime/test/fixtures/forbidden-privileged-agent.service"))),actual);
});
const legacyUserService=()=>fs.readFileSync(join(repo,'deploy/agent/lightmoni-agent.service'),'utf8').replace('RuntimeDirectory=lightmoni-agent\nRuntimeDirectoryMode=0700\n','').replace('ExecStart=/usr/bin/flock --no-fork --exclusive --nonblock /run/lightmoni-agent/runner.lock /usr/local/bin/lightmoni-agent run','ExecStart=/usr/local/bin/lightmoni-agent run');
test('SSH update probe explicitly refuses the old user service before offering an executable upgrade',t=>{const f=fixture(t),old=legacyUserService();assert.equal(sha(old),'651b2b126af0e96dfd26bbe6fc3e438f2f1a71814cff4009ec8fdeeaadb21bbf');fs.writeFileSync(f.p('etc/systemd/system/lightmoni-agent.service'),old);assert.throws(()=>sshProbe(f),/旧安装不支持统一生命周期，请先使用原版本受管卸载，再重新安装/);assert.equal(f.calls.some(([,args])=>args[0]==='stop'||args[0]==='restart'),false);});
test('SSH update probe never offers an old user service as a retained rollback target',async t=>{const f=fixture(t),request=f.request();await f.maintenance.start(request);f.onSleep(()=>{const s=f.maintenance.state(request.operation_id);if(s.status==='waiting_confirmation')f.maintenance.commit({operation_id:request.operation_id,expected_boot_id:s.local_health.boot_id,expected_target_sha256:request.target.artifact_sha256});});assert.equal((await f.maintenance.worker(request.operation_id)).status,'succeeded');const directory=f.p('opt/lightmoni-agent/updates/'+request.operation_id);fs.writeFileSync(join(directory,'previous-service'),legacyUserService());const previousFile=f.p('opt/lightmoni-agent/previous.json'),previous=JSON.parse(fs.readFileSync(previousFile,'utf8'));previous.fingerprint=f.maintenance.fingerprint(f.old,join(directory,'previous-launcher'),join(directory,'previous-service')).fingerprint;fs.writeFileSync(previousFile,JSON.stringify(previous));assert.equal(sshProbe(f).previous,null);assert.equal(f.maintenance.previous(),null);});

test("a candidate privileged unit is refused before executing its old permission helper",async t=>{
  const f=fixture(t,{targetPermissions:true});
  fs.writeFileSync(join(f.packageDir,"lightmoni-agent.service"),fs.readFileSync(join(repo,"runtime/test/fixtures/forbidden-privileged-agent.service")));f.repack();
  const request=f.request();await f.maintenance.start(request);const result=await f.maintenance.worker(request.operation_id);
  assert.equal(result.status,"failed");assert.equal(result.error_code,"agent_service_override_not_allowed");
  assert.equal(f.calls.some(([,args])=>args[1]==="prepare"),false);assert.equal(f.calls.some(([file,args])=>file==="systemctl"&&args[0]==="stop"),false);f.preserve();
});

test('root Agent upgrade preserves the selected account, permission generation and embedded identity',async t=>{
 const f=fixture(t,{runtimeMode:'root'}),request=f.request(),unit=fs.readFileSync(f.p('etc/systemd/system/lightmoni-agent.service')),helper=fs.readFileSync(f.p('etc/systemd/system/lightmoni-agent-helper.service')),managed=fs.readFileSync(f.p('etc/lightmoni-agent-helper/managed.json'));
 const before=sshProbe(f);assert.equal(before.runtime_mode,'root');assert.equal(before.permission_generation,7);
 await f.maintenance.start(request);f.onSleep(()=>{const s=f.maintenance.state(request.operation_id);if(s.status==='waiting_confirmation')f.maintenance.commit({operation_id:request.operation_id,expected_boot_id:s.local_health.boot_id,expected_target_sha256:request.target.artifact_sha256})});
 const result=await f.maintenance.worker(request.operation_id);assert.equal(result.status,'succeeded');assert.deepEqual(fs.readFileSync(f.p('etc/systemd/system/lightmoni-agent.service')),unit);assert.deepEqual(fs.readFileSync(f.p('etc/systemd/system/lightmoni-agent-helper.service')),helper);assert.deepEqual(fs.readFileSync(f.p('etc/lightmoni-agent-helper/managed.json')),managed);assert.equal(f.helperIsActive(),true);const after=sshProbe(f);assert.equal(after.runtime_mode,'root');assert.equal(after.permission_generation,7);f.preserve();
});

test('root Agent rollback restarts the helper and ordinary Agent together',async t=>{
 const f=fixture(t,{runtimeMode:'root',failTarget:true}),request=f.request();await f.maintenance.start(request);
 const result=await f.maintenance.worker(request.operation_id);assert.equal(result.status,'rolled_back');assert.equal(f.maintenance.system('ActiveState'),'active');assert.equal(f.helperIsActive(),true);assert.equal(sshProbe(f).runtime_mode,'root');f.preserve();
});

test('losing the root helper after initial health prevents commit and rolls both components back',async t=>{
 const f=fixture(t,{runtimeMode:'root'}),request=f.request();let checked=false;
 await f.maintenance.start(request);
 f.onSleep(()=>{const state=f.maintenance.state(request.operation_id);if(state.status!=='waiting_confirmation'||checked)return;checked=true;
   f.setHelperActive(false);
   assert.throws(()=>f.maintenance.commit({operation_id:request.operation_id,expected_boot_id:state.local_health.boot_id,expected_target_sha256:request.target.artifact_sha256}),/commit_health_changed/);
 });
 const result=await f.maintenance.worker(request.operation_id);
 assert.equal(checked,true);assert.equal(result.status,'rolled_back');assert.equal(result.error_code,'local_health_lost');
 assert.equal(result.local_health.helper_active,true);assert.equal(f.maintenance.currentPath(),f.old);assert.equal(f.helperIsActive(),true);f.preserve();
});

test('losing the root helper after commit request cannot produce a successful receipt',async t=>{
 const f=fixture(t,{runtimeMode:'root'}),request=f.request();let requested=false;
 await f.maintenance.start(request);
 f.onSleep(()=>{const state=f.maintenance.state(request.operation_id);if(state.status!=='waiting_confirmation'||requested)return;requested=true;
   f.maintenance.commit({operation_id:request.operation_id,expected_boot_id:state.local_health.boot_id,expected_target_sha256:request.target.artifact_sha256});
   f.setHelperActive(false);
 });
 const result=await f.maintenance.worker(request.operation_id);
 assert.equal(requested,true);assert.equal(result.status,'rolled_back');assert.equal(result.error_code,'commit_health_changed');
 assert.equal(result.local_health.helper_active,true);assert.equal(f.maintenance.currentPath(),f.old);f.preserve();
});


const completeMaintenance = async (f: ReturnType<typeof fixture>, request: any) => {
  await f.maintenance.start(request);
  f.onSleep(() => {
    const state=f.maintenance.state(request.operation_id);
    if(state.status==='waiting_confirmation')f.maintenance.commit({operation_id:request.operation_id,expected_boot_id:state.local_health.boot_id,expected_target_sha256:request.target.artifact_sha256});
  });
  return f.maintenance.worker(request.operation_id);
};

test('monitor-only upgrade followed by complete management hides an incomplete rollback and explains the required mode',async t=>{
  const f=fixture(t),upgrade=f.request();
  assert.equal((await completeMaintenance(f,upgrade)).status,'succeeded');
  const previous=sshProbe(f).previous;
  assert.ok(previous);
  assert.equal(fs.existsSync(f.p('opt/lightmoni-agent/updates/'+upgrade.operation_id+'/previous-helper-service')),false);
  f.setRuntimeMode('root');
  for(const probe of [sshProbe(f),f.maintenance.probe()]) {
    assert.equal(probe.runtime_mode,'root');assert.equal(probe.previous,null);
    assert.equal(probe.previous_unavailable_reason,'previous_helper_snapshot_missing');
  }
  const before=f.maintenance.currentPath(),calls=f.calls.length,rollback={...f.request(),action:'rollback',target:previous,archive_path:undefined};
  await assert.rejects(f.maintenance.start(rollback),/previous_helper_snapshot_missing/);
  assert.equal(fs.existsSync(f.p('opt/lightmoni-agent/updates/'+rollback.operation_id)),false);
  assert.equal(f.maintenance.currentPath(),before);assert.equal(f.helperIsActive(),true);
  assert.equal(f.calls.slice(calls).some(([file,args])=>file==='systemctl'&&['stop','restart'].includes(args[0])),false);
  assert.equal(f.maintenance.probe().lifecycle_locked,false);
});

test('reviewed return to monitor-only restores the retained rollback without restoring former permissions',async t=>{
  const f=fixture(t),upgrade=f.request();assert.equal((await completeMaintenance(f,upgrade)).status,'succeeded');
  f.setRuntimeMode('root');assert.equal(sshProbe(f).previous,null);
  f.setRuntimeMode('user');const before=sshProbe(f);assert.ok(before.previous);assert.equal(before.previous_unavailable_reason,undefined);
  const config=fs.readFileSync(f.p('etc/lightmoni-agent/config.json')),identity=fs.readFileSync(f.p('var/lib/lightmoni-agent/identity.json'));
  const rollback={...f.request(),action:'rollback',target:before.previous,archive_path:undefined};
  assert.equal((await completeMaintenance(f,rollback)).status,'succeeded');
  assert.equal(f.maintenance.currentPath(),f.old);assert.equal(sshProbe(f).runtime_mode,'user');assert.equal(f.helperIsActive(),false);
  assert.deepEqual(fs.readFileSync(f.p('etc/lightmoni-agent/config.json')),config);assert.deepEqual(fs.readFileSync(f.p('var/lib/lightmoni-agent/identity.json')),identity);
});

test('complete-management program rollback still updates both components and preserves its approved generation',async t=>{
  const f=fixture(t,{runtimeMode:'root'}),upgrade=f.request();assert.equal((await completeMaintenance(f,upgrade)).status,'succeeded');
  const before=sshProbe(f);assert.ok(before.previous);
  const rollback={...f.request(),action:'rollback',target:before.previous,archive_path:undefined};
  assert.equal((await completeMaintenance(f,rollback)).status,'succeeded');
  const after=sshProbe(f);assert.equal(after.runtime_mode,'root');assert.equal(after.permission_generation,7);assert.equal(after.helper_active,true);assert.equal(f.maintenance.currentPath(),f.old);f.preserve();
});

for(const change of ['missing','modified'] as const)test('rollback worker rejects '+change+' retained helper before stopping either service',async t=>{
  const f=fixture(t,{runtimeMode:'root'}),upgrade=f.request();assert.equal((await completeMaintenance(f,upgrade)).status,'succeeded');
  const before=sshProbe(f),rollback={...f.request(),action:'rollback',target:before.previous,archive_path:undefined};
  await f.maintenance.start(rollback);
  const helper=f.p('opt/lightmoni-agent/updates/'+upgrade.operation_id+'/previous-helper-service');
  if(change==='missing')fs.unlinkSync(helper);else fs.appendFileSync(helper,'# changed after approval\n');
  const current=f.maintenance.currentPath(),calls=f.calls.length,result=await f.maintenance.worker(rollback.operation_id);
  assert.equal(result.status,'failed');assert.equal(result.error_code,change==='missing'?'previous_release_changed':'helper_service_override_not_allowed');
  assert.equal(f.maintenance.currentPath(),current);assert.equal(f.helperIsActive(),true);
  assert.equal(f.calls.slice(calls).some(([file,args])=>file==='systemctl'&&['stop','restart'].includes(args[0])),false);
  assert.equal(fs.existsSync(f.p('run/lightmoni-agent-lifecycle.lock')),false);f.preserve();
});

test('SSH probe parser accepts only a consistent fixed rollback-unavailability reason',t=>{
  const f=fixture(t,{runtimeMode:'root'}),probe=f.maintenance.probe();
  const unavailable={...probe,previous:null,previous_unavailable_reason:'previous_helper_snapshot_missing'};
  assert.equal(parseAgentUpdateProbe(JSON.stringify(unavailable)).previous_unavailable_reason,'previous_helper_snapshot_missing');
  for(const changed of [{previous_unavailable_reason:'unknown_reason'},{previous_unavailable_reason:1},{previous:probe.current},{runtime_mode:'user',helper_active:false}])
    assert.throws(()=>parseAgentUpdateProbe(JSON.stringify({...unavailable,...changed})),/invalid_response/);
});

for (const status of ['preparing', 'switching', 'waiting_confirmation']) test('duplicate worker preserves the '+status+' owner, receipt and artifacts', async t => {
  const f=fixture(t),request=f.request();await f.maintenance.start(request);
  f.maintenance.save(request.operation_id,{status});
  const directory=f.p('opt/lightmoni-agent/updates/'+request.operation_id),receipt=fs.readFileSync(join(directory,'status.json')),archive=fs.readFileSync(join(directory,'bundle.tar.gz'));
  const lock=f.p('run/lightmoni-agent-lifecycle.lock/owner.json'),owner=fs.readFileSync(lock),files=fs.readdirSync(directory);
  await assert.rejects(f.maintenance.worker(request.operation_id),/operation_conflict/);
  assert.deepEqual(fs.readFileSync(join(directory,'status.json')),receipt);assert.deepEqual(fs.readFileSync(join(directory,'bundle.tar.gz')),archive);
  assert.deepEqual(fs.readFileSync(lock),owner);assert.deepEqual(fs.readdirSync(directory),files);assert.equal(f.maintenance.currentPath(),f.old);f.preserve();
});

test('worker without the lifecycle owner never performs failed-operation cleanup', async t => {
  const f=fixture(t),request=f.request();await f.maintenance.start(request);
  const directory=f.p('opt/lightmoni-agent/updates/'+request.operation_id),receipt=fs.readFileSync(join(directory,'status.json')),archive=fs.readFileSync(join(directory,'bundle.tar.gz'));
  const lock=f.p('run/lightmoni-agent-lifecycle.lock/owner.json');fs.writeFileSync(lock,JSON.stringify({operation_id:'f'.repeat(32)}));const owner=fs.readFileSync(lock);
  await assert.rejects(f.maintenance.worker(request.operation_id),/operation_conflict/);
  assert.deepEqual(fs.readFileSync(join(directory,'status.json')),receipt);assert.deepEqual(fs.readFileSync(join(directory,'bundle.tar.gz')),archive);assert.deepEqual(fs.readFileSync(lock),owner);f.preserve();
});

test('cooperative preparing cancellation retains both running components and clears only its own temporary operation', async t => {
  const f=fixture(t,{runtimeMode:'root'}),controller=new AbortController();
  fs.writeFileSync(join(f.runtime,'large'),Buffer.alloc(16<<20,65));f.repack();
  const request=f.request();await f.maintenance.start(request);
  const copied=f.p('opt/lightmoni-agent/updates/'+request.operation_id+'/unpacked/lightmoni-agent-runtime/large');
  const timer=setInterval(()=>{if(fs.existsSync(copied))controller.abort();},1);
  let result;try{result=await f.maintenance.worker(request.operation_id,{signal:controller.signal});}finally{clearInterval(timer);}
  assert.equal(result.status,'failed');assert.equal(result.error_code,'maintenance_cancelled');assert.equal(f.maintenance.currentPath(),f.old);assert.equal(f.helperIsActive(),true);
  assert.equal(f.calls.some(([file,args])=>file==='systemctl'&&['stop','restart'].includes(args[0])),false);
  assert.equal(fs.existsSync(f.p('run/lightmoni-agent-lifecycle.lock')),false);
  for(const name of ['unpacked','bundle.tar.gz'])assert.equal(fs.existsSync(f.p('opt/lightmoni-agent/updates/'+request.operation_id+'/'+name)),false);
  f.preserve();
});

test('maintenance dispatch applies the measured bounded worker resources and yields CPU and IO priority', async t => {
  const f=fixture(t),request=f.request();f.maintenance.launch=undefined;await f.maintenance.start(request);
  const dispatch=f.calls.find(([file])=>file==='systemd-run');assert.ok(dispatch);
  assert.ok(dispatch[1].includes('--property=Nice=10'));assert.ok(dispatch[1].includes('--property=IOSchedulingClass=idle'));
  for(const property of ['MemoryHigh=384M','MemoryMax=512M','MemorySwapMax=0','CPUQuota=50%','TasksMax=64'])assert.ok(dispatch[1].includes('--property='+property));
});

test('an actual SIGTERM during preparing produces a durable cancelled receipt and releases its own lock', {timeout:15000}, async t => {
  const f=fixture(t),large=join(f.runtime,'large');fs.writeFileSync(large,Buffer.alloc(64<<20,65));f.repack();
  const request=f.request();await f.maintenance.start(request);
  const childFile=f.p('cancel-worker.mjs');
  fs.writeFileSync(childFile,`import {AgentMaintenance} from ${JSON.stringify(pathToFileURL(join(repo,'deploy/agent/update-runner.mjs')).href)};
const runner=new AgentMaintenance({root:process.argv[2],uid:process.getuid(),command:()=>{throw Error('No external commands permitted in cancellation test');}});
console.log(JSON.stringify(await runner.worker(process.argv[3],{handleSignals:true})));\n`);
  const child=spawn(process.execPath,[childFile,f.root,request.operation_id],{stdio:['ignore','pipe','pipe'],env:{}});
  let stdout='',stderr='',sent=false;child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});
  const unpacked=f.p('opt/lightmoni-agent/updates/'+request.operation_id+'/unpacked');
  const timer=setInterval(()=>{if(!sent&&fs.existsSync(unpacked)&&fs.readdirSync(unpacked).some(name=>name.startsWith('.maintenance-'))){sent=true;child.kill('SIGTERM');}},1);
  const deadline=setTimeout(()=>child.kill('SIGKILL'),10000);
  let exit;try{exit=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));}finally{clearInterval(timer);clearTimeout(deadline);}
  assert.equal(sent,true);assert.deepEqual(exit,{code:0,signal:null},stderr);
  const result=JSON.parse(stdout);assert.equal(result.status,'failed');assert.equal(result.error_code,'maintenance_cancelled');
  assert.equal(f.maintenance.state(request.operation_id).error_code,'maintenance_cancelled');
  assert.equal(fs.existsSync(f.p('run/lightmoni-agent-lifecycle.lock')),false);assert.equal(fs.existsSync(unpacked),false);
  assert.equal(f.maintenance.currentPath(),f.old);f.preserve();
});

test('a retained atomic claim prevents replay even when a dead worker left accepted status', async t => {
  const f=fixture(t),request=f.request();await f.maintenance.start(request);
  const directory=f.p('opt/lightmoni-agent/updates/'+request.operation_id),claim=join(directory,'worker-claim.json');
  fs.writeFileSync(claim,JSON.stringify({schema:1,operation_id:request.operation_id,pid:999999,claimed_at:new Date().toISOString()}),{flag:'wx',mode:0o600});
  const saved=Object.fromEntries(['status.json','bundle.tar.gz','worker-claim.json'].map(name=>[name,fs.readFileSync(join(directory,name))]));
  const lock=f.p('run/lightmoni-agent-lifecycle.lock/owner.json'),owner=fs.readFileSync(lock);
  await assert.rejects(f.maintenance.worker(request.operation_id),/operation_conflict/);
  for(const [name,bytes] of Object.entries(saved))assert.deepEqual(fs.readFileSync(join(directory,name)),bytes);
  assert.deepEqual(fs.readFileSync(lock),owner);assert.equal(f.maintenance.currentPath(),f.old);f.preserve();
});

test('two independent workers racing the same accepted receipt have exactly one durable claim and no losing-worker cleanup', {timeout:15000}, async t => {
  const f=fixture(t),request=f.request();await f.maintenance.start(request);
  const directory=f.p('opt/lightmoni-agent/updates/'+request.operation_id),gate=f.p('race-gate'),release=f.p('race-release'),worker=f.p('race-worker.mjs');
  fs.writeFileSync(worker,`import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentMaintenance} from ${JSON.stringify(pathToFileURL(join(repo,'deploy/agent/update-runner.mjs')).href)};
const [root,id,index]=process.argv.slice(2);
class RacingMaintenance extends AgentMaintenance {
  first=true;
  state(operation) {
    const state=super.state(operation);
    if(this.first&&state.status==='accepted'){
      this.first=false;fs.writeFileSync(root+'/race-ready-'+index,'ready');
      const deadline=Date.now()+5000,wait=new Int32Array(new SharedArrayBuffer(4));
      while(!fs.existsSync(root+'/race-gate')){if(Date.now()>deadline)throw Error('race gate timeout');Atomics.wait(wait,0,0,5);}
    }
    return state;
  }
  async extract(){
    console.log(JSON.stringify({outcome:'claim_held',index}));
    const deadline=Date.now()+5000;
    while(!fs.existsSync(root+'/race-release')){if(Date.now()>deadline)throw Error('release gate timeout');await delay(5);}
    throw Object.assign(Error('controlled preparing end'),{safeCode:'fixture_preparing_stopped'});
  }
}
const runner=new RacingMaintenance({root,uid:process.getuid(),command:()=>{throw Error('No external commands permitted in claim test');}});
try{const result=await runner.worker(id);console.log(JSON.stringify({outcome:'completed',status:result.status,error_code:result.error_code}));}
catch(error){console.log(JSON.stringify({outcome:'rejected',error_code:error.safeCode||error.code||'unexpected'}));}\n`);
  const workers=[0,1].map(index=>{
    const child=spawn(process.execPath,[worker,f.root,request.operation_id,String(index)],{stdio:['ignore','pipe','pipe'],env:{}});
    const result={child,stdout:'',stderr:'',closed:undefined as any};
    child.stdout.on('data',value=>{result.stdout+=value;});child.stderr.on('data',value=>{result.stderr+=value;});
    result.closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    return result;
  });
  const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('worker race condition timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
  try{
    await until(()=>workers.every((_,index)=>fs.existsSync(f.p('race-ready-'+index))));
    fs.writeFileSync(gate,'go');
    await until(()=>workers.some(value=>value.stdout.includes('"outcome":"rejected"'))&&workers.some(value=>value.stdout.includes('"outcome":"claim_held"')));
    assert.equal(workers.filter(value=>value.stdout.includes('"outcome":"rejected"')).length,1);
    const rejected=workers.find(value=>value.stdout.includes('"outcome":"rejected"'))!;
    assert.equal(JSON.parse(rejected.stdout.trim()).error_code,'operation_conflict');
    assert.equal(f.maintenance.state(request.operation_id).status,'preparing');
    assert.equal(f.maintenance.ownsLock(request.operation_id),true);assert.equal(fs.existsSync(join(directory,'bundle.tar.gz')),true);
    const claimFile=join(directory,'worker-claim.json'),claim=fs.readFileSync(claimFile);
    assert.equal(fs.statSync(claimFile).mode&0o777,0o600);assert.equal(JSON.parse(claim.toString()).operation_id,request.operation_id);
    fs.writeFileSync(release,'finish');
    const exits=await Promise.all(workers.map(value=>value.closed));
    for(let index=0;index<exits.length;index++)assert.deepEqual(exits[index],{code:0,signal:null},workers[index].stderr);
    assert.equal(f.maintenance.state(request.operation_id).status,'failed');assert.equal(f.maintenance.state(request.operation_id).error_code,'fixture_preparing_stopped');
    assert.equal(f.maintenance.ownsLock(request.operation_id),false);assert.deepEqual(fs.readFileSync(claimFile),claim);
    assert.equal(f.maintenance.currentPath(),f.old);f.preserve();
  }finally{
    try{fs.writeFileSync(release,'finish');}catch{}
    for(const value of workers)if(value.child.exitCode===null)value.child.kill('SIGKILL');
    await Promise.all(workers.map(value=>value.closed));
  }
});

test('synchronous program hashes match SHA-256 for empty files, whole blocks and final short blocks', t => {
  const f=fixture(t),file=join(f.old,'hash-fixture');
  for(const size of [0,(64<<10)-1,64<<10,(64<<10)+1,5*(64<<10)+17]){
    const bytes=randomBytes(size);fs.writeFileSync(file,bytes);
    assert.equal(f.maintenance.fileDigest(file),sha(bytes),'hash covers all '+size+' bytes');
  }
});

function bufferedProgramFingerprint(f:ReturnType<typeof fixture>) {
  const release=f.maintenance.metadata(f.old);
  let helper='';try{helper=sha(fs.readFileSync(f.p('etc/systemd/system/lightmoni-agent-helper.service')));}catch(error:any){if(error.code!=='ENOENT')throw error;}
  return sha(JSON.stringify({release_path:f.old,release,
    manifest:sha(fs.readFileSync(join(f.old,'release.json'))),launcher:sha(fs.readFileSync(f.p('usr/local/bin/lightmoni-agent'))),
    service:sha(fs.readFileSync(f.p('etc/systemd/system/lightmoni-agent.service'))),helper_service:helper,
    node:sha(fs.readFileSync(join(f.old,'node'))),entrypoint:sha(fs.readFileSync(join(f.old,'app/runtime/dist/agent/main.js'))),
    uninstaller:sha(fs.readFileSync(join(f.old,'uninstall.sh'))),
  }));
}

test('multi-block program fingerprints remain identical to the original formula and SSH probe', t => {
  const f=fixture(t,{runtimeMode:'root'});
  for(const [index,file] of ['node','app/runtime/dist/agent/main.js','uninstall.sh'].entries())fs.writeFileSync(join(f.old,file),randomBytes((index+5)*(64<<10)+17),{mode:0o755});
  const manifestFile=join(f.old,'release.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  fs.writeFileSync(manifestFile,JSON.stringify({...manifest,node_binary_sha256:sha(fs.readFileSync(join(f.old,'node')))}));
  assert.equal(f.maintenance.fingerprint(f.old).fingerprint,bufferedProgramFingerprint(f));
  assert.equal(f.maintenance.probe().current.fingerprint,sshProbe(f).current.fingerprint);
});

for(const file of ['node','app/runtime/dist/agent/main.js','uninstall.sh'])test('multi-block '+file+' tampering is detected beyond the first hash block',t=>{
  const f=fixture(t),filename=join(f.old,file),bytes=randomBytes(5*(64<<10)+17);fs.writeFileSync(filename,bytes,{mode:0o755});
  if(file==='node'){
    const manifestFile=join(f.old,'release.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    fs.writeFileSync(manifestFile,JSON.stringify({...manifest,node_binary_sha256:sha(bytes)}));
  }
  const before=f.maintenance.fingerprint(f.old).fingerprint;assert.equal(before,bufferedProgramFingerprint(f));
  const descriptor=fs.openSync(filename,'r+');try{fs.writeSync(descriptor,Buffer.from([bytes[(64<<10)+9]^1]),0,1,(64<<10)+9);}finally{fs.closeSync(descriptor);}
  if(file==='node')assert.throws(()=>f.maintenance.metadata(f.old),/runtime_checksum_mismatch/);
  else{
    const after=f.maintenance.fingerprint(f.old).fingerprint;assert.notEqual(after,before);assert.equal(after,bufferedProgramFingerprint(f));
    assert.equal(f.maintenance.probe().current.fingerprint,sshProbe(f).current.fingerprint);
  }
});

const recoveryRequest=(f:ReturnType<typeof fixture>,request:any)=>({operation_id:request.operation_id,expected_agent_id:request.expected_agent_id,expected_fingerprint:request.expected_fingerprint,
  expected_runtime_mode:f.maintenance.runtimeMode(),expected_permission_generation:f.maintenance.runtimeGeneration(),
  expected_target:Object.fromEntries(['version','source_revision','build_id','state_schema','artifact_sha256','arch'].map(key=>[key,request.target[key]]))});
function stoppedWorker(f:ReturnType<typeof fixture>,overrides:Record<string,string>={}) {
  fs.mkdirSync(f.p('proc'),{mode:0o755,recursive:true});
  const run=f.maintenance.command;
  f.maintenance.command=(file:string,args:string[])=>file==='systemctl'&&args.some(value=>/^lightmoni-agent-update-[a-f0-9]{32}\.service$/.test(value))
    ?Object.entries({LoadState:'not-found',ActiveState:'inactive',MainPID:'0',ControlPID:'0',ControlGroup:'',Job:'0',...overrides}).map(([key,value])=>key+'='+value).join('\n')
    :run(file,args);
}
const candidatePath=(f:ReturnType<typeof fixture>,request:any)=>f.p('opt/lightmoni-agent/releases/'+request.target.version+'-'+request.target.artifact_sha256.slice(0,16)+'-'+request.operation_id);

for(const milliseconds of [300000,300001])test('preparing at '+milliseconds+'ms fails without touching running components',async t=>{
  const f=fixture(t,{runtimeMode:'root'}),request=f.request();let elapsed=0;f.maintenance.elapsed=()=>elapsed;
  await f.maintenance.start(request);const extract=f.maintenance.extract.bind(f.maintenance);
  f.maintenance.extract=async(...args:any[])=>{elapsed=milliseconds;return extract(...args);};
  const result=await f.maintenance.worker(request.operation_id);
  assert.equal(result.status,'failed');assert.equal(result.error_code,'preparing_timeout');assert.equal(f.maintenance.currentPath(),f.old);assert.equal(f.helperIsActive(),true);
  assert.equal(f.calls.some(([file,args])=>file==='systemctl'&&['stop','restart'].includes(args[0])),false);assert.equal(f.maintenance.ownsLock(request.operation_id),false);f.preserve();
});

test('preparing just inside its soft deadline can finish with a complete confirmation and restore reserve',async t=>{
  const f=fixture(t),request=f.request();let elapsed=0;f.maintenance.elapsed=()=>elapsed;
  await f.maintenance.start(request);const extract=f.maintenance.extract.bind(f.maintenance);
  f.maintenance.extract=async(...args:any[])=>{elapsed=299999;return extract(...args);};
  f.onSleep(()=>{const s=f.maintenance.state(request.operation_id);if(s.status==='waiting_confirmation')f.maintenance.commit({operation_id:request.operation_id,expected_boot_id:s.local_health.boot_id,expected_target_sha256:request.target.artifact_sha256});});
  assert.equal((await f.maintenance.worker(request.operation_id)).status,'succeeded');f.preserve();
});

test('a pause between final preparing validation and cutover cannot consume the recovery reserve',async t=>{
  const f=fixture(t),request={...f.request(),confirm_timeout_seconds:180};let elapsed=0;f.maintenance.elapsed=()=>elapsed;
  await f.maintenance.start(request);const check=f.maintenance.checkBudget.bind(f.maintenance);
  f.maintenance.checkBudget=()=>{check();if(fs.existsSync(f.p('opt/lightmoni-agent/updates/'+request.operation_id+'/approved-target.json')))elapsed=600001;};
  const result=await f.maintenance.worker(request.operation_id);assert.equal(result.status,'failed');assert.equal(result.error_code,'maintenance_budget_exhausted');
  assert.equal(f.calls.some(([file,args])=>file==='systemctl'&&['stop','restart'].includes(args[0])),false);assert.equal(fs.existsSync(candidatePath(f,request)),false);f.preserve();
});

test('failed preparing cleans only its own unreferenced candidate',async t=>{
  const f=fixture(t,{failPermissionPreparation:true}),request=f.request(),unrelated=f.p('opt/lightmoni-agent/releases/unrelated');fs.mkdirSync(unrelated);fs.writeFileSync(join(unrelated,'keep'),'other release');
  await f.maintenance.start(request);assert.equal((await f.maintenance.worker(request.operation_id)).status,'failed');
  assert.equal(fs.existsSync(candidatePath(f,request)),false);assert.equal(fs.readFileSync(join(unrelated,'keep'),'utf8'),'other release');assert.equal(f.maintenance.currentPath(),f.old);
});

for(const reference of ['current','previous','active_operation'])test('candidate cleanup preserves a '+reference+' reference',async t=>{
  const f=fixture(t,{failPermissionPreparation:true}),request=f.request(),candidate=candidatePath(f,request);await f.maintenance.start(request);
  const cleanup=f.maintenance.cleanupCandidate.bind(f.maintenance);
  f.maintenance.cleanupCandidate=(id:string)=>{
    assert.equal(fs.existsSync(candidate),true);
    if(reference==='current')f.maintenance.switchCurrent(candidate);
    else if(reference==='previous')fs.writeFileSync(f.p('opt/lightmoni-agent/previous.json'),JSON.stringify({schema:1,release_path:candidate}));
    else{
      const other='c'.repeat(32),directory=f.p('opt/lightmoni-agent/updates/'+other);fs.mkdirSync(directory);
      fs.writeFileSync(join(directory,'status.json'),JSON.stringify({schema:1,operation_id:other,agent_id:'fixture-agent',status:'preparing'}));
      fs.writeFileSync(join(directory,'request.json'),JSON.stringify({previous_path:candidate}));
    }
    cleanup(id);
  };
  assert.equal((await f.maintenance.worker(request.operation_id)).status,'failed');assert.equal(fs.existsSync(candidate),true);
});

test('exit evidence shell is bounded, normalizes untrusted enums and never changes status, artifacts or locks',async t=>{
  const f=fixture(t),request=f.request();await f.maintenance.start(request);
  const directory=f.p('opt/lightmoni-agent/updates/'+request.operation_id),script=join(directory,'exit-evidence.sh'),before=fs.readFileSync(join(directory,'status.json')),owner=fs.readFileSync(f.p('run/lightmoni-agent-lifecycle.lock/owner.json'));
  assert.ok(fs.statSync(script).size<4096);
  execFileSync('/bin/sh',[script],{env:{PATH:'/usr/bin:/bin',SERVICE_RESULT:'oom-kill',EXIT_CODE:'killed',EXIT_STATUS:'KILL'}});
  const exit=f.maintenance.state(request.operation_id).worker_exit;assert.equal(exit.result,'oom-kill');assert.equal(exit.exit_code,'killed');assert.equal(exit.exit_status,9);
  execFileSync('/bin/sh',[script],{env:{PATH:'/usr/bin:/bin',SERVICE_RESULT:'secret-value',EXIT_CODE:'$(exit 1)',EXIT_STATUS:'9999999999'}});
  const normalized=f.maintenance.state(request.operation_id).worker_exit;assert.equal(normalized.result,'unknown');assert.equal(normalized.exit_code,'unknown');assert.equal(normalized.exit_status,0);
  assert.deepEqual(fs.readFileSync(join(directory,'status.json')),before);assert.deepEqual(fs.readFileSync(f.p('run/lightmoni-agent-lifecycle.lock/owner.json')),owner);assert.equal(fs.existsSync(join(directory,'bundle.tar.gz')),true);
  assert.equal(fs.statSync(join(directory,'unit-exit.json')).mode&0o777,0o600);
});

test('explicit recovery archives an interrupted preparing worker, retaining evidence and never reinstalling',async t=>{
  const f=fixture(t,{runtimeMode:'root'}),request=f.request();await f.maintenance.start(request);f.maintenance.save(request.operation_id,{status:'preparing'});
  const directory=f.p('opt/lightmoni-agent/updates/'+request.operation_id);fs.writeFileSync(join(directory,'worker-claim.json'),'partial original claim',{mode:0o600});
  const original=fs.readFileSync(join(directory,'status.json')),bundle=fs.readFileSync(join(directory,'bundle.tar.gz'));stoppedWorker(f);
  const input=recoveryRequest(f,request),result=await f.maintenance.recover(input);assert.equal(result.status,'failed');assert.equal(result.error_code,'worker_interrupted_before_switch');assert.equal(result.recovery.action,'archive_preparing');
  assert.deepEqual(fs.readFileSync(join(directory,'status-before-recovery.json')),original);assert.deepEqual(fs.readFileSync(join(directory,'bundle.tar.gz')),bundle);assert.equal(fs.readFileSync(join(directory,'worker-claim.json'),'utf8'),'partial original claim');
  assert.equal(f.maintenance.ownsLock(request.operation_id),false);assert.equal(f.calls.some(([file,args])=>file==='systemctl'&&['stop','restart'].includes(args[0])),false);
  const receipt=fs.readFileSync(join(directory,'status.json'));assert.deepEqual(await f.maintenance.recover(input),result);assert.deepEqual(fs.readFileSync(join(directory,'status.json')),receipt);f.preserve();
});

for(const [name,overrides] of [['active unit',{ActiveState:'active',MainPID:'42'}],['control PID',{ControlPID:'42'}],['queued job',{Job:'12 /org/freedesktop/systemd1/job/12'}]] as const)test('recovery refuses '+name+' without modifying the operation',async t=>{
  const f=fixture(t),request=f.request();await f.maintenance.start(request);f.maintenance.save(request.operation_id,{status:'preparing'});stoppedWorker(f,overrides);
  const before=f.maintenance.state(request.operation_id);await assert.rejects(f.maintenance.recover(recoveryRequest(f,request)),/recovery_worker_running/);assert.deepEqual(f.maintenance.state(request.operation_id),before);assert.equal(f.maintenance.ownsLock(request.operation_id),true);
});

for(const kind of ['process','cgroup','other_owner','task','identity','generation','unknown_field'])test('recovery refuses '+kind+' without clearing the lifecycle fence',async t=>{
  const f=fixture(t),request=f.request();await f.maintenance.start(request);f.maintenance.save(request.operation_id,{status:'preparing'});stoppedWorker(f);
  const input=recoveryRequest(f,request),directory=f.p('opt/lightmoni-agent/updates/'+request.operation_id),receipt=fs.readFileSync(join(directory,'status.json'));
  if(kind==='process'){fs.mkdirSync(f.p('proc/123'));fs.writeFileSync(f.p('proc/123/cmdline'),Buffer.from('node\0'+join(directory,'worker.mjs')+'\0worker\0'+request.operation_id+'\0'));}
  if(kind==='cgroup'){
    const group='/system.slice/lightmoni-agent-update-'+request.operation_id+'.service';fs.mkdirSync(f.p('sys/fs/cgroup'+group),{recursive:true});fs.writeFileSync(f.p('sys/fs/cgroup'+group+'/cgroup.events'),'populated 1\n');fs.writeFileSync(f.p('sys/fs/cgroup'+group+'/cgroup.procs'),'123\n');stoppedWorker(f,{ControlGroup:group});
  }
  if(kind==='other_owner')fs.writeFileSync(f.p('run/lightmoni-agent-lifecycle.lock/owner.json'),JSON.stringify({operation_id:'f'.repeat(32)}));
  if(kind==='task')fs.writeFileSync(f.p('var/lib/lightmoni-agent/task-run-state.json'),JSON.stringify({id:'active-task'}));
  if(kind==='identity')input.expected_agent_id='other-agent';
  if(kind==='generation')input.expected_permission_generation++;
  if(kind==='unknown_field')(input as any).command='arbitrary';
  const owner=fs.readFileSync(f.p('run/lightmoni-agent-lifecycle.lock/owner.json'));
  await assert.rejects(f.maintenance.recover(input));assert.deepEqual(fs.readFileSync(join(directory,'status.json')),receipt);assert.deepEqual(fs.readFileSync(f.p('run/lightmoni-agent-lifecycle.lock/owner.json')),owner);
});

async function killedWorker(t:any,phase:'preparing'|'cutover'|'waiting_confirmation'){
  const f=fixture(t,{runtimeMode:'root'}),request=f.request();await f.maintenance.start(request);
  const script=f.p('fault-worker.mjs'),marker=f.p('fault-marker');
  fs.writeFileSync(script,`import fs from 'node:fs';import {randomUUID} from 'node:crypto';
import {AgentMaintenance} from ${JSON.stringify(pathToFileURL(join(repo,'deploy/agent/update-runner.mjs')).href)};
const [root,id,phase]=process.argv.slice(2);let active=true,helper=true,boot=randomUUID();let runner;
runner=new AgentMaintenance({root,uid:process.getuid(),command:(file,args)=>{
 if(file==='systemctl'){
  if(args[0]==='show'){
   const isHelper=args.includes('lightmoni-agent-helper.service');
   if(args.includes('--property=ActiveState'))return (isHelper?helper:active)?'active':'inactive';
   if(args.includes('--property=LoadState'))return 'loaded';
   if(args.includes('--property=FragmentPath'))return root+'/etc/systemd/system/'+(isHelper?'lightmoni-agent-helper.service':'lightmoni-agent.service');
   if(args.includes('--property=DropInPaths'))return '';
  }
  if(args[0]==='stop'){if(args[1]==='lightmoni-agent-helper.service')helper=false;else active=false;}
  if(args[0]==='restart'){if(args[1]==='lightmoni-agent-helper.service')helper=true;else{active=true;boot=randomUUID();}}
  return '';
 }
 const generation=runner.runtimeGeneration();
 if(args[0]==='helper-status')return JSON.stringify({permission_generation:generation,fenced:null,pending_results:0,ordinary_task_runner:{active:false,state:'idle'}});
 if(args[0]==='status')return JSON.stringify({agent_id:'fixture-agent',runtime:{uid:995,gid:995,mode:'root',permission_generation:generation},release:runner.metadata(runner.currentPath()),boot_id:boot});
 return 'valid';
}});
const save=runner.save.bind(runner);runner.save=(id,update)=>{const value=save(id,update);if(update.status===phase||(phase==='cutover'&&update.uninstaller_updated===true)){
 fs.writeFileSync(root+'/fault-marker','reached');const wait=new Int32Array(new SharedArrayBuffer(4));for(;;)Atomics.wait(wait,0,0,1000);
}return value;};
await runner.worker(id,{handleSignals:true});\n`);
  const child=spawn(process.execPath,[script,f.root,request.operation_id,phase],{stdio:['ignore','pipe','pipe'],env:{}});let stderr='';child.stderr.on('data',value=>{stderr+=value;});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try{
    const deadline=Date.now()+10000;while(!fs.existsSync(marker)){if(child.exitCode!==null||Date.now()>deadline)throw Error('fault boundary not reached: '+stderr);await new Promise(resolve=>setTimeout(resolve,2));}
    child.kill('SIGKILL');assert.deepEqual(await closed,{code:null,signal:'SIGKILL'});
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
  if(phase==='cutover'){f.setActive(false);f.setHelperActive(false);}stoppedWorker(f);
  return {...f,request};
}

for(const phase of ['preparing','cutover','waiting_confirmation'] as const)test('explicit recovery after actual SIGKILL at '+phase+' verifies and preserves the original transaction', {timeout:15000},async t=>{
  const f=await killedWorker(t,phase),directory=f.p('opt/lightmoni-agent/updates/'+f.request.operation_id),status=fs.readFileSync(join(directory,'status.json')),claim=fs.readFileSync(join(directory,'worker-claim.json')),bundle=fs.readFileSync(join(directory,'bundle.tar.gz'));
  const result=await f.maintenance.recover(recoveryRequest(f,f.request));
  assert.equal(result.status,phase==='preparing'?'failed':'rolled_back');assert.equal(result.recovery.action,phase==='preparing'?'archive_preparing':'restore_previous');
  assert.equal(f.maintenance.currentPath(),f.old);assert.equal(f.helperIsActive(),true);assert.equal(f.maintenance.system('ActiveState'),'active');assert.equal(f.maintenance.ownsLock(f.request.operation_id),false);
  assert.deepEqual(fs.readFileSync(join(directory,'status-before-recovery.json')),status);assert.deepEqual(fs.readFileSync(join(directory,'worker-claim.json')),claim);assert.deepEqual(fs.readFileSync(join(directory,'bundle.tar.gz')),bundle);
  if(phase!=='preparing')assert.equal(fs.existsSync(candidatePath(f,f.request)),true);
  const commands=f.calls.length;assert.deepEqual(await f.maintenance.recover(recoveryRequest(f,f.request)),result);assert.equal(f.calls.length,commands);f.preserve();
});

for(const corruption of ['original_helper','target','unknown_current'])test('cutover recovery refuses '+corruption+' before stopping either component', {timeout:15000},async t=>{
  const f=await killedWorker(t,'cutover'),directory=f.p('opt/lightmoni-agent/updates/'+f.request.operation_id),input=recoveryRequest(f,f.request);
  if(corruption==='original_helper')fs.unlinkSync(join(directory,'previous-helper-service'));
  if(corruption==='target')fs.appendFileSync(join(candidatePath(f,f.request),'app/runtime/dist/agent/main.js'),'tampered');
  if(corruption==='unknown_current'){const other=f.p('opt/lightmoni-agent/releases/unapproved');fs.mkdirSync(other);f.maintenance.switchCurrent(other);}
  const status=fs.readFileSync(join(directory,'status.json')),owner=fs.readFileSync(f.p('run/lightmoni-agent-lifecycle.lock/owner.json')),calls=f.calls.length;
  await assert.rejects(f.maintenance.recover(input));assert.deepEqual(fs.readFileSync(join(directory,'status.json')),status);assert.deepEqual(fs.readFileSync(f.p('run/lightmoni-agent-lifecycle.lock/owner.json')),owner);
  assert.equal(f.calls.slice(calls).some(([file,args])=>file==='systemctl'&&['stop','restart'].includes(args[0])),false);
  assert.equal(fs.existsSync(join(directory,'recovery.json')),false);
});

for(const wrong of ['missing_status','wrong_runtime'])test('restored '+wrong+' cannot be marked healthy or unlock the interrupted transaction',{timeout:15000},async t=>{
  const f=await killedWorker(t,'cutover'),localStatus=f.maintenance.localStatus.bind(f.maintenance);
  f.maintenance.localStatus=()=>wrong==='missing_status'?{}:{...localStatus(),runtime:{uid:0,gid:0,mode:'root',permission_generation:7}};
  await assert.rejects(f.maintenance.recover(recoveryRequest(f,f.request)),/recovery_original_unhealthy/);
  assert.equal(f.maintenance.state(f.request.operation_id).status,'switching');assert.equal(f.maintenance.ownsLock(f.request.operation_id),true);
  assert.equal(f.maintenance.currentPath(),f.old);
});

test('recover response loss after successful restore is finalized without a second restore',{timeout:15000},async t=>{
  const f=await killedWorker(t,'cutover'),atomic=f.maintenance.atomic.bind(f.maintenance);let lose=true;
  f.maintenance.atomic=(file:string,value:any,mode?:number)=>{if(lose&&file.endsWith('/recovery.json')&&value.status==='succeeded'){lose=false;throw Error('simulated lost recovery response');}return atomic(file,value,mode);};
  const input=recoveryRequest(f,f.request);await assert.rejects(f.maintenance.recover(input),/simulated lost recovery response/);
  assert.equal(f.maintenance.state(f.request.operation_id).status,'rolled_back');const stops=f.calls.filter(([file,args])=>file==='systemctl'&&args[0]==='stop').length;
  const result=await f.maintenance.recover(input);assert.equal(result.status,'rolled_back');assert.equal(result.recovery.status,'succeeded');assert.equal(f.calls.filter(([file,args])=>file==='systemctl'&&args[0]==='stop').length,stops);
});

test('an actual SIGKILL during a started recovery preserves its nonterminal fence and never replays restore or worker',{timeout:15000},async t=>{
  const f=await killedWorker(t,'cutover'),input=recoveryRequest(f,f.request),directory=f.p('opt/lightmoni-agent/updates/'+f.request.operation_id);
  const script=f.p('fault-recovery.mjs'),marker=f.p('recovery-fault-marker'),events=f.p('recovery-events.jsonl'),requestFile=f.p('recovery-request.json');
  const status=fs.readFileSync(join(directory,'status.json')),claim=fs.readFileSync(join(directory,'worker-claim.json')),bundle=fs.readFileSync(join(directory,'bundle.tar.gz'));
  fs.writeFileSync(requestFile,JSON.stringify(input),{mode:0o600});
  fs.writeFileSync(script,`import fs from 'node:fs';
import {AgentMaintenance} from ${JSON.stringify(pathToFileURL(join(repo,'deploy/agent/update-runner.mjs')).href)};
const [root,requestFile]=process.argv.slice(2);const events=root+'/recovery-events.jsonl';let runner;
const record=value=>fs.appendFileSync(events,JSON.stringify(value)+'\\n',{mode:0o600});
runner=new AgentMaintenance({root,uid:process.getuid(),command:(file,args)=>{
 record({event:'command',file,args});
 if(file==='systemctl'){
  if(args[0]==='show'){
   if(args.some(value=>/^lightmoni-agent-update-[a-f0-9]{32}\\.service$/.test(value)))return 'LoadState=not-found\\nActiveState=inactive\\nMainPID=0\\nControlPID=0\\nControlGroup=\\nJob=0';
   const helper=args.includes('lightmoni-agent-helper.service');
   if(args.includes('--property=ActiveState'))return 'inactive';
   if(args.includes('--property=LoadState'))return 'loaded';
   if(args.includes('--property=FragmentPath'))return root+'/etc/systemd/system/'+(helper?'lightmoni-agent-helper.service':'lightmoni-agent.service');
   if(args.includes('--property=DropInPaths'))return '';
  }
  return '';
 }
 if(args[0]==='helper-status')return JSON.stringify({permission_generation:runner.runtimeGeneration(),fenced:null,pending_results:0,ordinary_task_runner:{active:false,state:'idle'}});
 throw Error('unexpected recovery command');
}});
const restore=runner.restore.bind(runner);runner.restore=async(...args)=>{record({event:'restore'});return restore(...args);};
const atomic=runner.atomic.bind(runner);runner.atomic=(file,value,mode)=>{const result=atomic(file,value,mode);if(file===root+'/usr/local/bin/lightmoni-agent'){
 record({event:'partial_restore'});fs.writeFileSync(root+'/recovery-fault-marker','reached');const wait=new Int32Array(new SharedArrayBuffer(4));for(;;)Atomics.wait(wait,0,0,1000);
}return result;};
await runner.recover(JSON.parse(fs.readFileSync(requestFile,'utf8')));\n`);
  const child=spawn(process.execPath,[script,f.root,requestFile],{stdio:['ignore','pipe','pipe'],env:{}});let stderr='';child.stderr.on('data',value=>{stderr+=value;});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try{
    const deadline=Date.now()+10000;while(!fs.existsSync(marker)){if(child.exitCode!==null||Date.now()>deadline)throw Error('recovery fault boundary not reached: '+stderr);await new Promise(resolve=>setTimeout(resolve,2));}
    child.kill('SIGKILL');assert.deepEqual(await closed,{code:null,signal:'SIGKILL'});
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
  const journal=fs.readFileSync(join(directory,'recovery.json')),owner=fs.readFileSync(f.p('run/lightmoni-agent-lifecycle.lock/owner.json')),commands=fs.readFileSync(events);
  assert.equal(JSON.parse(journal.toString()).status,'started');assert.equal(f.maintenance.state(f.request.operation_id).status,'switching');
  assert.equal(f.maintenance.currentPath(),f.old);assert.equal(fs.readFileSync(f.p('usr/local/bin/lightmoni-agent'),'utf8'),'#!/bin/sh\n# old launcher\n');
  assert.match(fs.readFileSync(f.p('usr/local/sbin/lightmoni-agent-uninstall'),'utf8'),/new offline helper/);
  assert.deepEqual(fs.readFileSync(join(directory,'status-before-recovery.json')),status);
  assert.equal(commands.toString().trim().split('\n').map(line=>JSON.parse(line)).filter(value=>value.event==='restore').length,1);
  let restores=0,workers=0;f.maintenance.restore=async()=>{restores++;throw Error('restore must not replay');};f.maintenance.worker=async()=>{workers++;throw Error('worker must not replay');};
  const calls=f.calls.length;
  for(let retry=0;retry<2;retry++)await assert.rejects(f.maintenance.recover(input),/recovery_interrupted/);
  assert.equal(restores,0);assert.equal(workers,0);assert.equal(f.maintenance.ownsLock(f.request.operation_id),true);
  assert.equal(f.calls.slice(calls).some(([file,args])=>file==='systemctl'&&['stop','restart'].includes(args[0])),false);
  assert.deepEqual(fs.readFileSync(join(directory,'recovery.json')),journal);assert.deepEqual(fs.readFileSync(join(directory,'status.json')),status);
  assert.deepEqual(fs.readFileSync(f.p('run/lightmoni-agent-lifecycle.lock/owner.json')),owner);assert.deepEqual(fs.readFileSync(events),commands);
  assert.deepEqual(fs.readFileSync(join(directory,'worker-claim.json')),claim);assert.deepEqual(fs.readFileSync(join(directory,'bundle.tar.gz')),bundle);
  assert.equal(fs.existsSync(candidatePath(f,f.request)),true);f.preserve();
});

test('a concurrent explicit recover cannot enter an already started restore',{timeout:15000},async t=>{
  const f=await killedWorker(t,'cutover'),restore=f.maintenance.restore.bind(f.maintenance);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  f.maintenance.restore=async(...args:any[])=>{await gate;return restore(...args);};
  const input=recoveryRequest(f,f.request),first=f.maintenance.recover(input);
  await assert.rejects(f.maintenance.recover(input),/recovery_guard_busy/);release();assert.equal((await first).status,'rolled_back');
});

test('failed recovery validation releases only a newly acquired lock and does not poison the journal',async t=>{
  const f=fixture(t),request=f.request();await f.maintenance.start(request);f.maintenance.save(request.operation_id,{status:'preparing'});f.maintenance.unlock(request.operation_id);stoppedWorker(f);
  f.setActive(false);await assert.rejects(f.maintenance.recover(recoveryRequest(f,request)),/recovery_original_unhealthy/);
  assert.equal(fs.existsSync(f.p('run/lightmoni-agent-lifecycle.lock')),false);assert.equal(fs.existsSync(f.p('opt/lightmoni-agent/updates/'+request.operation_id+'/recovery.json')),false);
  f.setActive(true);assert.equal((await f.maintenance.recover(recoveryRequest(f,request))).status,'failed');
});

test('SSH update probe identifies historical root daemons and never offers an executable upgrade',t=>{
 for(const locked of [true,false]){
  const f=fixture(t);let unit=fs.readFileSync(join(repo,'deploy/agent/lightmoni-agent.service'),'utf8');
  if(!locked)unit=legacyUserService();
  unit=unit.replace('User=lightmoni-agent','User=root').replace('Group=lightmoni-agent','Group=root').replace('CapabilityBoundingSet=\n','').replace('ProtectSystem=strict\n','').replace('ProtectHome=read-only\n','').replace('PrivateTmp=true\n','').replace('ReadWritePaths=/var/lib/lightmoni-agent\n','');
  assert.equal(sha(unit),locked?'19f0b122cfff85f5397b5cc4afeeb6342df36634a35f981c562a1ab6f3ef826e':'70a336b1c16132d5c688f3d0c21712db0c9b67418af99e9613474c6ffeaed68f');
  fs.writeFileSync(f.p('etc/systemd/system/lightmoni-agent.service'),unit);
  assert.throws(()=>sshProbe(f),/旧安装不支持统一生命周期/);
  assert.equal(f.calls.some(([,args])=>args[0]==='stop'||args[0]==='restart'),false);
 }
});
test('unknown installation probe reports fixed guidance without promoting remote output',t=>{
 const f=fixture(t);fs.appendFileSync(f.p('etc/systemd/system/lightmoni-agent.service'),'# private fixture override');
 assert.throws(()=>sshProbe(f),e=>/未通过受管指纹/.test(String(e))&&!String(e).includes('private fixture override'));
});
