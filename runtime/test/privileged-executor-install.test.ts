import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rewriteMaintenancePaths } from "./helpers/maintenance-shell.js";
import { executorHostLockShell } from "../src/server/executor-absence-shell.js";

type StatusResult = { status: number; stdout: string };
const cleanStatus = { executor_id: "fixture-executor", install_generation: 7, fenced: null, pending_results: 0 };
const statusResult = (value: unknown): StatusResult => ({ status: 0, stdout: JSON.stringify(value) });
const expectedRemovalArgs = ["--confirm-remove-executor", "--expected-executor-id", cleanStatus.executor_id, "--expected-install-generation", String(cleanStatus.install_generation)];

/** The actual shell/embedded JS execute against rewritten temporary roots. Ownership,
 * systemd and status replies are simulated; this does not verify real Linux root. */
function fixture(t: TestContext, installed = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lm-executor-maintenance-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = (path: string) => join(root, path);
  const commands = p("commands"), calls = p("calls.json"), status = p("status.json"), statusCalls = p("status-calls.json");
  const unit = p("etc/systemd/system/lightmoni-executor.service");
  for (const path of ["commands", "run/systemd/system", "opt", "etc/systemd/system", "var/lib", "usr/local/bin", "usr/local/sbin"])
    mkdirSync(p(path), { recursive: true, mode: 0o755 });
  for (const path of [calls, statusCalls]) writeFileSync(path, "[]");
  writeFileSync(status, JSON.stringify(statusResult(cleanStatus)));
  const command = (name: string, source: string) => writeFileSync(join(commands, name), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  command("id", 'process.stdout.write("0\\n");');
  command("uname", 'process.stdout.write("Linux\\n");');
  command("flock", 'process.exit(process.argv.at(-1)==="7"&&process.env.FIXTURE_WRITER_BUSY?1:0);');
  command("sleep", "process.exit(0);");
  command("systemd-run", "process.exit(0);");
  command("stat", `const fs=require("node:fs"),args=process.argv.slice(2),path=args.at(-1),fd=/^\\/dev\\/fd\\/(\\d+)$/.exec(path),s=fd?fs.fstatSync(Number(fd[1])):fs.lstatSync(path),format=args[1],mode=(s.mode&0o7777).toString(8);if(format==="%u")console.log("0");else if(format==="%a")console.log(mode);else if(format==="%d:%i:%u:%a")console.log([s.dev,s.ino+(fd&&process.env.FIXTURE_FD_MISMATCH?1:0),0,mode].join(":"));else process.exit(90);`);
  command("readlink", 'try{process.stdout.write(require("node:fs").realpathSync(process.argv.at(-1))+"\\n")}catch{process.exit(1)}');
  command("systemctl", `const fs=require("node:fs"),args=process.argv.slice(2),calls=${JSON.stringify(calls)},history=JSON.parse(fs.readFileSync(calls,"utf8"));history.push(args);fs.writeFileSync(calls,JSON.stringify(history));if(args[0]==="show"){if(args.includes("--property=FragmentPath")){console.log(process.env.FIXTURE_FRAGMENT||${JSON.stringify(unit)});process.exit(Number(process.env.FIXTURE_FRAGMENT_EXIT||0))}if(args.includes("--property=DropInPaths")){console.log(process.env.FIXTURE_DROPINS||"");process.exit(Number(process.env.FIXTURE_DROPINS_EXIT||0))}if(args.includes("--property=ActiveState")){console.log(process.env.FIXTURE_ACTIVE_STATE||"inactive");process.exit(Number(process.env.FIXTURE_ACTIVE_EXIT||0))}process.exit(91)}if(args[0]==="stop"&&process.env.FIXTURE_STATUS_AFTER_STOP)fs.copyFileSync(process.env.FIXTURE_STATUS_AFTER_STOP,${JSON.stringify(status)});`);
  command("install", `const cp=require("node:child_process"),input=process.argv.slice(2),args=[];for(let i=0;i<input.length;i++){if(input[i]==="-o"||input[i]==="-g"){i++;continue}args.push(input[i])}const result=cp.spawnSync("/usr/bin/install",args,{stdio:"inherit"});process.exit(result.status??1);`);

  // Run the script's real validation JS, with only synthetic root ownership and
  // a recorded status subprocess. Real lstat modes and symlink decisions remain.
  const nodeSource = `#!${process.execPath}
const fs=require("node:fs"),vm=require("node:vm"),source=process.argv[3];
if(process.argv[2]!=="-e")process.exit(90);
const syntheticFs={...fs,lstatSync(file){const s=fs.lstatSync(file);return Object.defineProperty(Object.create(s),"uid",{value:0});}};
const syntheticCp={spawnSync(command,args,options){const file=${JSON.stringify(statusCalls)},calls=JSON.parse(fs.readFileSync(file,"utf8"));calls.push({command,args,options});fs.writeFileSync(file,JSON.stringify(calls));return {...JSON.parse(fs.readFileSync(${JSON.stringify(status)},"utf8")),stderr:""};}};
vm.runInNewContext(source,{require(name){if(name==="node:fs")return syntheticFs;if(name==="node:child_process")return syntheticCp;return require(name);},process:{argv:[process.execPath,...process.argv.slice(4)],stdout:process.stdout,stderr:process.stderr,exit:process.exit.bind(process)}});
`;
  const writeRelease = (dir: string) => {
    for (const path of ["app/runtime/dist/privileged-executor", "executor"]) mkdirSync(join(dir, path), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, "node"), nodeSource, { mode: 0o755 });
    writeFileSync(join(dir, "app/runtime/dist/privileged-executor/main.js"), "fixture executor entrypoint\n", { mode: 0o644 });
    writeFileSync(join(dir, "release.json"), JSON.stringify({ state_schema: 1, build_id: "fixture-build", version: "1.0.0" }));
    for (const path of ["launcher.sh", "uninstall.sh", "lightmoni-executor.service"])
      writeFileSync(join(dir, "executor", path), rewriteMaintenancePaths(readFileSync(new URL(`../../deploy/executor/${path}`, import.meta.url), "utf8"), root), { mode: path.endsWith(".sh") ? 0o755 : 0o644 });
  };
  const release = installed ? p("opt/lightmoni-executor/releases/fixture-build") : p("release");
  writeRelease(release);
  if (installed) {
    for (const path of ["etc/lightmoni-executor", "var/lib/lightmoni-executor"]) mkdirSync(p(path), { mode: 0o700 });
    writeFileSync(p("etc/lightmoni-executor/config.json"), "preserve executor identity\n", { mode: 0o600 });
    writeFileSync(p("var/lib/lightmoni-executor/journal.sqlite"), "preserve execution journal\n", { mode: 0o600 });
    writeFileSync(unit, readFileSync(join(release, "executor/lightmoni-executor.service")), { mode: 0o644 });
    for (const [path, source] of [["usr/local/bin/lightmoni-executor", "launcher.sh"], ["usr/local/sbin/lightmoni-executor-uninstall", "uninstall.sh"]])
      writeFileSync(p(path), readFileSync(join(release, "executor", source)), { mode: 0o755 });
    symlinkSync(release, p("opt/lightmoni-executor/current"));
  }
  const run = (scriptName: "install" | "uninstall" = "uninstall", options: { args?: string[]; statusAfterStop?: unknown; fragment?: string; input?: string; env?: Record<string, string> } = {}) => {
    let script = readFileSync(new URL(`../../deploy/executor/${scriptName}.sh`, import.meta.url), "utf8");
    script = rewriteMaintenancePaths(script, root).replace(rewriteMaintenancePaths("PATH=/usr/sbin:/usr/bin:/sbin:/bin", root), `PATH=${JSON.stringify(commands + ":/usr/bin:/bin")}`).replaceAll("/proc/self/fd/", "/dev/fd/");
    const env: Record<string, string> = { PATH: commands + ":/usr/bin:/bin", ...options.env };
    if (options.statusAfterStop !== undefined) {
      env.FIXTURE_STATUS_AFTER_STOP = p("status-after-stop.json");
      writeFileSync(env.FIXTURE_STATUS_AFTER_STOP, JSON.stringify(statusResult(options.statusAfterStop)));
    }
    if (options.fragment) env.FIXTURE_FRAGMENT = options.fragment;
    const args = options.args ?? (scriptName === "uninstall" ? ["--confirm-remove-executor"] : ["--release-dir", release, "--artifact-sha256", "a".repeat(64)]);
    return spawnSync("sh", ["-c", script, scriptName + ".sh", ...args], { encoding: "utf8", env, input: options.input, timeout: 20_000 });
  };
  const history = () => JSON.parse(readFileSync(calls, "utf8")) as string[][];
  const retained = () => {
    assert.equal(readFileSync(p("etc/lightmoni-executor/config.json"), "utf8"), "preserve executor identity\n");
    assert.equal(readFileSync(p("var/lib/lightmoni-executor/journal.sqlite"), "utf8"), "preserve execution journal\n");
    assert.ok(existsSync(p("usr/local/bin/lightmoni-executor")));
    assert.ok(existsSync(unit));
    assert.ok(!history().some(call => ["disable", "daemon-reload"].includes(call[0])));
  };
  return { p, run, release, history, retained, setStatus(value: StatusResult) { writeFileSync(status, JSON.stringify(value)); }, statusHistory: () => JSON.parse(readFileSync(statusCalls, "utf8")) as unknown[] };
}

test("executor removal checks clean status twice and removes only the local installation", t => {
  const f = fixture(t), business = f.p("business-data");
  writeFileSync(business, "unrelated data");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /executor_uninstalled=local_only/);
  assert.match(result.stdout, /Revoke the executor identity in the platform separately/);
  assert.equal(f.statusHistory().length, 2);
  assert.deepEqual(f.history().map(call => call[0]), ["show", "show", "stop", "show", "disable", "daemon-reload"]);
  for (const path of ["opt/lightmoni-executor", "etc/lightmoni-executor", "var/lib/lightmoni-executor", "etc/systemd/system/lightmoni-executor.service", "usr/local/bin/lightmoni-executor", "usr/local/sbin/lightmoni-executor-uninstall"])
    assert.equal(existsSync(f.p(path)), false, path);
  assert.equal(readFileSync(business, "utf8"), "unrelated data");
});

test("executor removal accepts an exactly matching executor ID and install generation", t => {
  const f = fixture(t), result = f.run("uninstall", { args: expectedRemovalArgs });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /executor_uninstalled=local_only/);
  assert.equal(f.statusHistory().length, 2);
  assert.deepEqual(f.history().map(call => call[0]), ["show", "show", "stop", "show", "disable", "daemon-reload"]);
  for (const path of ["opt/lightmoni-executor", "etc/lightmoni-executor", "var/lib/lightmoni-executor", "etc/systemd/system/lightmoni-executor.service", "usr/local/bin/lightmoni-executor", "usr/local/sbin/lightmoni-executor-uninstall"])
    assert.equal(existsSync(f.p(path)), false, path);
});

for (const [name, state] of [
  ["executor ID", { ...cleanStatus, executor_id: "another-executor" }],
  ["install generation", { ...cleanStatus, install_generation: cleanStatus.install_generation + 1 }],
] as const) test(`executor ${name} mismatch blocks removal before service stop`, t => {
  const f = fixture(t); f.setStatus(statusResult(state));
  const result = f.run("uninstall", { args: expectedRemovalArgs });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_uninstall_blocked_unresolved_state/);
  assert.equal(f.statusHistory().length, 1);
  assert.deepEqual(f.history().map(call => call[0]), ["show", "show"]);
  f.retained();
});

for (const [name, state] of [
  ["executor ID", { ...cleanStatus, executor_id: "replacement-executor" }],
  ["install generation", { ...cleanStatus, install_generation: cleanStatus.install_generation + 1 }],
] as const) test(`executor ${name} changing during stop preserves the replacement installation`, t => {
  const f = fixture(t), result = f.run("uninstall", { args: expectedRemovalArgs, statusAfterStop: state });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_uninstall_blocked_unresolved_state/);
  assert.equal(f.statusHistory().length, 2);
  assert.deepEqual(f.history().map(call => call[0]), ["show", "show", "stop", "show"]);
  f.retained();
});

for (const [name, value] of [
  ["fenced execution", { ...cleanStatus, fenced: { attempt_id: "uncertain-attempt" } }],
  ["pending result", { ...cleanStatus, pending_results: 1 }],
] as const) test(`executor ${name} blocks removal before service stop`, t => {
  const f = fixture(t); f.setStatus(statusResult(value));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_uninstall_blocked_unresolved_state/);
  assert.deepEqual(f.history().map(call => call[0]), ["show", "show"]);
  f.retained();
});

for (const [name, value] of [
  ["invalid JSON", { status: 0, stdout: "{" }],
  ["failed status command", { status: 1, stdout: JSON.stringify(cleanStatus) }],
  ["missing identity", statusResult({ ...cleanStatus, executor_id: "" })],
  ["missing fence state", statusResult({ executor_id: "fixture-executor", pending_results: 0 })],
  ["fractional result count", statusResult({ ...cleanStatus, pending_results: 0.5 })],
  ["negative result count", statusResult({ ...cleanStatus, pending_results: -1 })],
] as const) test(`unverifiable executor status (${name}) preserves identity and journal`, t => {
  const f = fixture(t); f.setStatus(value);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_uninstall_blocked_unresolved_state/);
  assert.ok(!f.history().some(call => call[0] === "stop"));
  f.retained();
});

for (const [name, state] of [
  ["fence", { ...cleanStatus, fenced: { attempt_id: "arrived-before-stop" } }],
  ["result", { ...cleanStatus, pending_results: 1 }],
] as const) test(`executor ${name} appearing during stop blocks disable and deletion`, t => {
  const f = fixture(t), result = f.run("uninstall", { statusAfterStop: state });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_uninstall_blocked_unresolved_state/);
  assert.equal(f.statusHistory().length, 2);
  assert.deepEqual(f.history().map(call => call[0]), ["show", "show", "stop", "show"]);
  f.retained();
});

test("symlinked program root is refused without touching unrelated data", t => {
  const f = fixture(t), outside = f.p("outside");
  mkdirSync(outside); writeFileSync(join(outside, "business-data"), "preserve");
  rmSync(f.p("opt/lightmoni-executor"), { recursive: true });
  symlinkSync(outside, f.p("opt/lightmoni-executor"));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_unmanaged_installation/);
  assert.deepEqual(f.history(), []);
  assert.equal(readFileSync(join(outside, "business-data"), "utf8"), "preserve");
  f.retained();
});

test("current release outside managed releases is refused before status execution", t => {
  const f = fixture(t), outside = f.p("outside");
  mkdirSync(outside); writeFileSync(join(outside, "business-data"), "preserve");
  rmSync(f.p("opt/lightmoni-executor/current"));
  symlinkSync(outside, f.p("opt/lightmoni-executor/current"));
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(f.history(), []);
  assert.deepEqual(f.statusHistory(), []);
  assert.equal(readFileSync(join(outside, "business-data"), "utf8"), "preserve");
  f.retained();
});

test("symlinked runtime entrypoint cannot be executed to authorize executor deletion", t => {
  const f = fixture(t), entrypoint = join(f.release, "app/runtime/dist/privileged-executor/main.js"), outside = f.p("untrusted-entrypoint.js");
  writeFileSync(outside, "untrusted code"); rmSync(entrypoint); symlinkSync(outside, entrypoint);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_uninstall_blocked_unresolved_state/);
  assert.deepEqual(f.statusHistory(), []);
  assert.ok(!f.history().some(call => call[0] === "stop"));
  f.retained();
});

test("writable executor program directory blocks removal before service actions", t => {
  const f = fixture(t); chmodSync(f.p("opt/lightmoni-executor"), 0o777);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_unsafe_installation_permissions/);
  assert.deepEqual(f.history(), []);
  f.retained();
});

for (const path of ["etc/systemd", "etc/systemd/system"]) test(`writable ${path} ancestor blocks removal before service actions`, t => {
  const f = fixture(t); chmodSync(f.p(path), 0o777);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_unsafe_installation_permissions/);
  assert.deepEqual(f.history(), []);
  assert.deepEqual(f.statusHistory(), []);
  f.retained();
});

test("a systemd unit loaded from another path cannot be removed", t => {
  const f = fixture(t), result = f.run("uninstall", { fragment: f.p("other-service.service") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_unmanaged_service/);
  assert.deepEqual(f.statusHistory(), []);
  f.retained();
});

test("executor removal requires its exact explicit confirmation argument", t => {
  const f = fixture(t), result = f.run("uninstall", { args: [] });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--confirm-remove-executor/);
  assert.deepEqual(f.history(), []);
  f.retained();
});

test("install rejects a missing executor entrypoint before creating an installation", t => {
  const f = fixture(t, false); rmSync(join(f.release, "app/runtime/dist/privileged-executor/main.js"));
  const result = f.run("install");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_invalid_release/);
  assert.equal(existsSync(f.p("opt/lightmoni-executor")), false);
  assert.deepEqual(f.history(), []);
});

test("install rejects a release containing an external symlink", t => {
  const f = fixture(t, false), outside = f.p("business-data");
  writeFileSync(outside, "preserve"); symlinkSync(outside, join(f.release, "external"));
  const result = f.run("install");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_invalid_release/);
  assert.equal(existsSync(f.p("opt/lightmoni-executor")), false);
  assert.equal(readFileSync(outside, "utf8"), "preserve");
  assert.deepEqual(f.history(), []);
});

test("install refuses to overwrite an existing executor identity", t => {
  const f = fixture(t), result = f.run("install");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executor_existing_installation_requires_reviewed_maintenance/);
  assert.deepEqual(f.history(), []);
  f.retained();
});

test("successful install supplies bootstrap only to enrollment stdin", t => {
  const f = fixture(t, false), observation = f.p("enrollment-observation.json");
  const bootstrap = '{"bootstrap_token":"test-only-enrollment-value-not-a-real-secret"}\n';
  // Store a digest of observed stdin, never the bootstrap itself. The launcher is
  // a fixture executable, so no network enrollment or daemon is performed.
  writeFileSync(join(f.release, "executor/launcher.sh"), `#!${process.execPath}
const fs=require("node:fs"),crypto=require("node:crypto"),args=process.argv.slice(2),file=${JSON.stringify(observation)},calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):[];
const record={args,env:process.env};
if(args[0]==="enroll"){record.stdin_sha256=crypto.createHash("sha256").update(fs.readFileSync(0)).digest("hex");fs.writeFileSync(args[args.indexOf("--config")+1],JSON.stringify({executor_id:"fixture-executor"}),{mode:0o600});}
calls.push(record);fs.writeFileSync(file,JSON.stringify(calls),{mode:0o600});
`, { mode: 0o755 });
  const result = f.run("install", { input: bootstrap });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /executor_installation=ready/);
  const observed = JSON.parse(readFileSync(observation, "utf8")) as Array<{ args: string[]; env: Record<string, string>; stdin_sha256?: string }>;
  assert.deepEqual(observed.map(call => call.args[0]), ["enroll", "check"]);
  assert.equal(observed[0].stdin_sha256, createHash("sha256").update(bootstrap).digest("hex"));
  const token = "test-only-enrollment-value-not-a-real-secret";
  for (const call of observed) {
    assert.ok(!JSON.stringify(call.args).includes(token));
    assert.ok(!JSON.stringify(call.env).includes(token));
  }
  assert.ok(!(result.stdout + result.stderr + JSON.stringify(f.history())).includes(token));
  const verifyNoSavedToken = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) verifyNoSavedToken(path);
      else if (entry.isFile()) assert.ok(!readFileSync(path).includes(Buffer.from(token)), `bootstrap was persisted in ${path}`);
    }
  };
  verifyNoSavedToken(f.p(""));
  assert.equal(f.history().filter(call => call[0] === "is-active").length, 3);
  assert.equal(existsSync(f.p("opt/lightmoni-executor/current/installation.json")), true);
});

for (const scriptName of ["install", "uninstall"] as const) {
  test(`standalone ${scriptName} lifecycle lock matches the shared fixed helper`, () => {
    const source = readFileSync(new URL(`../../deploy/executor/${scriptName}.sh`, import.meta.url), "utf8");
    const shared = executorHostLockShell("lifecycle"), index = source.indexOf(shared);
    assert.ok(index >= 0, "standalone root lock protection must remain identical to the shared SSH helper");
    assert.equal(source.split(shared).length, 2, "the shared lock fragment must appear exactly once");
    assert.ok(!/exec\s+9>/.test(source.slice(0, index)), "the lock descriptor must not be opened before validating the shared lock boundary");
  });

  for (const problem of ["symlink", "writable", "directory", "fifo"] as const) test(`standalone ${scriptName} lifecycle lock refuses ${problem} without touching its data`, t => {
    const f = fixture(t, scriptName === "uninstall"), lock = f.p("run/lightmoni-executor-lifecycle.lock"), outside = f.p("protected-lock-data");
    let sentinel: string;
    if (problem === "fifo") {
      const created = spawnSync("/usr/bin/mkfifo", [lock], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr); sentinel = outside; writeFileSync(outside, "preserve lock data");
    } else if (problem === "symlink") {
      sentinel = outside; writeFileSync(outside, "preserve lock data"); symlinkSync(outside, lock);
    } else if (problem === "directory") {
      mkdirSync(lock); sentinel = join(lock, "preserved-file"); writeFileSync(sentinel, "preserve lock data");
    } else {
      sentinel = lock; writeFileSync(lock, "preserve lock data", { mode: 0o666 }); chmodSync(lock, 0o666);
    }
    const result = f.run(scriptName);
    assert.ok(!result.error, result.error?.message);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve lock data", "unsafe lock data must never be truncated or followed");
    assert.deepEqual(f.history(), [], "unsafe locks must be rejected before service changes");
    assert.deepEqual(f.statusHistory(), [], "unsafe locks must be rejected before executing the installed runtime");
    if (scriptName === "uninstall") f.retained();
    else {
      assert.equal(existsSync(f.p("opt/lightmoni-executor")), false);
      assert.equal(existsSync(f.p("etc/lightmoni-executor")), false);
      assert.equal(existsSync(f.p("var/lib/lightmoni-executor")), false);
    }
  });

  test(`standalone ${scriptName} lifecycle lock does not truncate existing bytes`, t => {
    const f = fixture(t, scriptName === "uninstall"), lock = f.p("run/lightmoni-executor-lifecycle.lock");
    writeFileSync(lock, "retained lock data\n", { mode: 0o600 });
    if (scriptName === "install") rmSync(join(f.release, "app/runtime/dist/privileged-executor/main.js"));
    const result = f.run(scriptName);
    assert.ok(!result.error, result.error?.message);
    if (scriptName === "uninstall") assert.equal(result.status, 0, result.stderr);
    else { assert.notEqual(result.status, 0); assert.match(result.stderr, /executor_invalid_release/); }
    assert.equal(readFileSync(lock, "utf8"), "retained lock data\n");
  });

  test(`standalone ${scriptName} lifecycle lock rejects descriptor identity mismatch`, t => {
    const f = fixture(t, scriptName === "uninstall"), lock = f.p("run/lightmoni-executor-lifecycle.lock");
    writeFileSync(lock, "retained lock data\n", { mode: 0o600 });
    const result = f.run(scriptName, { env: { FIXTURE_FD_MISMATCH: "1" } });
    assert.ok(!result.error, result.error?.message); assert.notEqual(result.status, 0);
    assert.equal(readFileSync(lock, "utf8"), "retained lock data\n");
    assert.deepEqual(f.history(), []); assert.deepEqual(f.statusHistory(), []);
    if (scriptName === "uninstall") f.retained();
    else assert.equal(existsSync(f.p("opt/lightmoni-executor")), false);
  });
}

test("standalone uninstall writer lock matches the shared fixed helper", () => {
  const source = readFileSync(new URL("../../deploy/executor/uninstall.sh", import.meta.url), "utf8");
  assert.ok(source.includes(executorHostLockShell("writer")));
});

for (const [name, env] of [
  ["FragmentPath query failure", { FIXTURE_FRAGMENT_EXIT: "1" }],
  ["DropInPaths query failure", { FIXTURE_DROPINS_EXIT: "1" }],
  ["registered service drop-in", { FIXTURE_DROPINS: "/etc/systemd/system/lightmoni-executor.service.d/custom.conf" }],
] as const) test(`uninstall refuses ${name} before stopping the executor`, t => {
  const f = fixture(t), result = f.run("uninstall", { env });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /executor_unmanaged_service/);
  assert.ok(!f.history().some(call => call[0] === "stop")); assert.deepEqual(f.statusHistory(), []);
  f.retained();
});

test("uninstall refuses changed fixed unit bytes before stopping the executor", t => {
  const f = fixture(t), path = f.p("etc/systemd/system/lightmoni-executor.service");
  const changed = readFileSync(path, "utf8").replace("User=root", "User=some-other-account");
  writeFileSync(path, changed);
  const result = f.run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /executor_unmanaged_service/);
  assert.deepEqual(f.history(), []); assert.deepEqual(f.statusHistory(), []); f.retained();
  assert.equal(readFileSync(path, "utf8"), changed);
});

test("uninstall refuses a busy writer lock after stop and retains all executor data", t => {
  const f = fixture(t), result = f.run("uninstall", { env: { FIXTURE_WRITER_BUSY: "1" } });
  assert.notEqual(result.status, 0);
  assert.equal(f.statusHistory().length, 1, "no second status or deletion while another local writer holds authority");
  assert.deepEqual(f.history().map(call => call[0]), ["show", "show", "stop", "show"]);
  f.retained();
});

for (const [name, env] of [
  ["still active", { FIXTURE_ACTIVE_STATE: "active" }],
  ["unknown active state", { FIXTURE_ACTIVE_STATE: "unknown" }],
  ["failed active-state query with inactive stdout", { FIXTURE_ACTIVE_EXIT: "1" }],
] as const) test(`uninstall refuses ${name} after stopping`, t => {
  const f = fixture(t), result = f.run("uninstall", { env });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /executor_service_not_stopped/);
  assert.equal(f.statusHistory().length, 1); f.retained();
});

for (const leaf of ["etc/systemd/system/lightmoni-executor.service", "etc/systemd/system/lightmoni-executor.service.d", "run/systemd/system/lightmoni-executor.service", "run/systemd/system/lightmoni-executor.service.d"])
  for (const dangling of [false, true]) test(`install refuses ${dangling ? "dangling" : "existing"} service override ${leaf}`, t => {
    const f = fixture(t, false), path = f.p(leaf), target = f.p("missing-service-override");
    if (dangling) symlinkSync(target, path);
    else if (leaf.endsWith(".d")) mkdirSync(path);
    else writeFileSync(path, "preserve unfamiliar unit\n");
    const result = f.run("install");
    assert.notEqual(result.status, 0); assert.match(result.stderr, /executor_existing_installation_requires_reviewed_maintenance/);
    assert.deepEqual(f.history(), []); assert.deepEqual(f.statusHistory(), []);
    assert.equal(existsSync(f.p("opt/lightmoni-executor")), false);
    if (!dangling && !leaf.endsWith(".d")) assert.equal(readFileSync(path, "utf8"), "preserve unfamiliar unit\n");
  });
