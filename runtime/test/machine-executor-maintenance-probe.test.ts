import {inlineFixtureCommands} from './helpers/maintenance-shell.js';
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { executorMaintenanceAbsentCommand } from "../src/server/machine-executor-maintenance.js";

const marker = "executor_uninstalled=verified";
const lockPath = "run/lightmoni-executor-lifecycle.lock";
type Call = { command: string; args: string[] };

/** Execute the exported production shell against isolated temporary Linux roots.
 * Ownership, flock and systemd replies are synthetic; file kinds, permission bits,
 * descriptor inheritance and symlink behaviour are real. No real root or systemd. */
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lm-executor-maintenance-probe-")));
  const p = (path: string) => join(root, path), bin = p("fakebin"), history = p("history.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["fakebin", "run/systemd/system", "opt", "etc/systemd/system", "var/lib", "usr/local/bin", "usr/local/sbin"])
    mkdirSync(p(path), { recursive: true, mode: 0o755 });
  writeFileSync(history, "[]");
  const command = (name: string, source: string) => writeFileSync(join(bin, name), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  const record = `const fs=require("node:fs"),file=process.env.PROBE_HISTORY,calls=JSON.parse(fs.readFileSync(file,"utf8"));calls.push({command:require("node:path").basename(process.argv[1]),args:process.argv.slice(2)});fs.writeFileSync(file,JSON.stringify(calls));`;
  command("id", 'console.log("0");');
  command("stat", `const fs=require("node:fs"),args=process.argv.slice(2),path=args.at(-1),fd=/^\\/dev\\/fd\\/(\\d+)$/.exec(path),info=fd?fs.fstatSync(Number(fd[1])):fs.lstatSync(path),format=args[1],uid=path===process.env.PROBE_NON_ROOT?"123":"0",mode=(info.mode&0o7777).toString(8);if(format==="%u")console.log(uid);else if(format==="%a")console.log(mode);else if(format==="%u:%a")console.log(uid+":"+mode);else if(format==="%d:%i:%u:%a")console.log([info.dev,info.ino+(fd&&process.env.PROBE_FD_MISMATCH?1:0),uid,mode].join(":"));else process.exit(90);`);
  command("flock", record + 'process.exit(Number(process.env.PROBE_LOCK_EXIT||0));');
  command("systemctl", record + `
const args=process.argv.slice(2);
// The workflow's actual shell descriptor must survive into both queries.
try{const held=fs.fstatSync(9),lock=fs.lstatSync(process.env.PROBE_LOCK_PATH);if(!held.isFile()||held.ino!==lock.ino||held.dev!==lock.dev)process.exit(93)}catch{process.exit(93)}
if(args[0]!=="show"||!args.includes("lightmoni-executor.service")||!args.includes("--value"))process.exit(91);
if(args.includes("--property=LoadState")){console.log(process.env.PROBE_LOAD_STATE??"not-found");process.exit(Number(process.env.PROBE_LOAD_EXIT||0))}
if(args.includes("--property=ActiveState")){console.log(process.env.PROBE_ACTIVE_STATE??"inactive");process.exit(Number(process.env.PROBE_ACTIVE_EXIT||0))}
process.exit(92);
`);
  // Rewrite fixed roots in one pass, including the standalone / ancestor. Never
  // reinterpret an inserted temp root containing /var as another Linux target.
  const shell = executorMaintenanceAbsentCommand()
    .replace(/\/(run|opt|etc|var|usr)(?=[^A-Za-z0-9_.-]|$)|(?<=\s)\/(?=\s)/g, value => value === "/" ? root : p(value.slice(1)))
    .replaceAll(`PATH=${p("usr/sbin")}:${p("usr/bin")}:/sbin:/bin`, `PATH=${bin}`)
    .replaceAll("/proc/self/fd/", "/dev/fd/");
  assert.ok(shell.includes(`PATH=${bin}`));
  assert.ok(!/(?:^|[\s="'])\/(?:run|opt|etc|var|usr)(?:\/|\b)/.test(shell.replaceAll(root, "FIXTURE")), "all fixed Linux roots must be isolated");
  const run = (env: Record<string, string> = {}) => spawnSync("/bin/sh", ["-c", inlineFixtureCommands(bin)+shell], {
    encoding: "utf8", timeout: 15_000, env: { PATH: bin, PROBE_HISTORY: history, PROBE_LOCK_PATH: p(lockPath), ...env },
  });
  const calls = () => JSON.parse(readFileSync(history, "utf8")) as Call[];
  const refused = (env: Record<string, string> = {}) => {
    const result = run(env);
    assert.ok(!result.error, result.error?.message);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(marker), result.stdout);
    return result;
  };
  const noSystemd = () => assert.ok(!calls().some(call => call.command === "systemctl"));
  return { root, p, run, refused, calls, noSystemd };
}

test("clean maintenance absence holds FD9 while verifying both successful systemd show queries", t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, marker + "\n");
  assert.deepEqual(f.calls(), [
    { command: "flock", args: ["-n", "9"] },
    { command: "systemctl", args: ["show", "lightmoni-executor.service", "--property=LoadState", "--value"] },
    { command: "systemctl", args: ["show", "lightmoni-executor.service", "--property=ActiveState", "--value"] },
  ]);
  const lock = lstatSync(f.p(lockPath));
  assert.ok(lock.isFile());
  assert.equal(lock.mode & 0o077, 0, "created lifecycle lock must be private");
});

const ancestors = ["", "run", "opt", "etc", "var", "var/lib", "usr", "usr/local", "usr/local/bin", "usr/local/sbin", "etc/systemd", "etc/systemd/system", "run/systemd", "run/systemd/system"];
for (const ancestor of ancestors) {
  if (ancestor) test(`maintenance absence rejects dangling ancestor ${ancestor}`, t => {
    const f = fixture(t), path = f.p(ancestor), target = f.p("missing-ancestor-target");
    rmSync(path, { recursive: true, force: true }); symlinkSync(target, path);
    f.refused(); f.noSystemd();
    assert.ok(lstatSync(path).isSymbolicLink());
    assert.equal(readlinkSync(path), target);
    assert.equal(existsSync(target), false);
  });
  test(`maintenance absence rejects writable ancestor ${ancestor || "root"}`, t => {
    const f = fixture(t); chmodSync(ancestor ? f.p(ancestor) : f.root, 0o777);
    f.refused(); f.noSystemd();
  });
  test(`maintenance absence rejects non-root ancestor ${ancestor || "root"}`, t => {
    const f = fixture(t); f.refused({ PROBE_NON_ROOT: ancestor ? f.p(ancestor) : f.root }); f.noSystemd();
  });
}

const residualLeaves = [
  ["opt/lightmoni-executor", "directory"],
  ["etc/lightmoni-executor", "directory"],
  ["var/lib/lightmoni-executor", "directory"],
  ["usr/local/bin/lightmoni-executor", "file"],
  ["usr/local/sbin/lightmoni-executor-uninstall", "file"],
  ["etc/systemd/system/lightmoni-executor.service", "file"],
  ["etc/systemd/system/lightmoni-executor.service.d", "directory"],
  ["run/systemd/system/lightmoni-executor.service", "file"],
  ["run/systemd/system/lightmoni-executor.service.d", "directory"],
] as const;
for (const [leaf, kind] of residualLeaves) {
  test(`maintenance absence preserves and rejects residual ${kind} ${leaf}`, t => {
    const f = fixture(t), path = f.p(leaf);
    if (kind === "directory") mkdirSync(path);
    const sentinel = kind === "directory" ? join(path, "preserved-data") : path;
    writeFileSync(sentinel, "preserve residual installation\n");
    f.refused(); f.noSystemd();
    assert.equal(readFileSync(sentinel, "utf8"), "preserve residual installation\n");
  });
  test(`maintenance absence rejects dangling residual ${leaf}`, t => {
    const f = fixture(t), path = f.p(leaf), target = f.p("missing-residual-target");
    symlinkSync(target, path);
    f.refused(); f.noSystemd();
    assert.ok(lstatSync(path).isSymbolicLink());
    assert.equal(readlinkSync(path), target);
    assert.equal(existsSync(target), false);
  });
}

test("maintenance absence rejects a busy lifecycle lock before querying systemd", t => {
  const f = fixture(t); f.refused({ PROBE_LOCK_EXIT: "1" });
  assert.deepEqual(f.calls(), [{ command: "flock", args: ["-n", "9"] }]);
});

for (const dangling of [false, true]) test(`maintenance absence never opens a ${dangling ? "dangling " : ""}symlinked lifecycle lock`, t => {
  const f = fixture(t), target = f.p("outside-lock-target");
  if (!dangling) writeFileSync(target, "outside data stays unchanged\n");
  symlinkSync(target, f.p(lockPath));
  f.refused(); assert.deepEqual(f.calls(), []);
  if (dangling) assert.equal(existsSync(target), false);
  else assert.equal(readFileSync(target, "utf8"), "outside data stays unchanged\n");
  assert.ok(lstatSync(f.p(lockPath)).isSymbolicLink());
});

test("maintenance absence refuses a directory at the lifecycle lock path", t => {
  const f = fixture(t); mkdirSync(f.p(lockPath));
  writeFileSync(join(f.p(lockPath), "preserved-data"), "preserve lock directory");
  f.refused(); assert.deepEqual(f.calls(), []);
  assert.equal(readFileSync(join(f.p(lockPath), "preserved-data"), "utf8"), "preserve lock directory");
});

test("maintenance absence refuses a FIFO lifecycle lock without opening it", t => {
  const f = fixture(t), path = f.p(lockPath);
  const created = spawnSync("/usr/bin/mkfifo", [path], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  f.refused(); assert.deepEqual(f.calls(), []);
  assert.ok(lstatSync(path).isFIFO());
});

test("maintenance absence preserves bytes in an existing lifecycle lock", t => {
  const f = fixture(t), path = f.p(lockPath);
  writeFileSync(path, "retained lifecycle lock data\n", { mode: 0o600 });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, marker + "\n");
  assert.equal(readFileSync(path, "utf8"), "retained lifecycle lock data\n");
});

test("maintenance absence refuses a descriptor identity mismatch before flock", t => {
  const f = fixture(t), path = f.p(lockPath);
  writeFileSync(path, "retained lifecycle lock data\n", { mode: 0o600 });
  f.refused({ PROBE_FD_MISMATCH: "1" }); assert.deepEqual(f.calls(), []);
  assert.equal(readFileSync(path, "utf8"), "retained lifecycle lock data\n");
});

for (const problem of ["writable", "non-root"]) test(`maintenance absence refuses a ${problem} existing lock before truncating it`, t => {
  const f = fixture(t), path = f.p(lockPath);
  writeFileSync(path, "preserve existing lock data", { mode: 0o600 });
  if (problem === "writable") chmodSync(path, 0o666);
  f.refused(problem === "non-root" ? { PROBE_NON_ROOT: path } : {});
  assert.deepEqual(f.calls(), []);
  assert.equal(readFileSync(path, "utf8"), "preserve existing lock data");
});

for (const query of ["LOAD", "ACTIVE"]) test(`maintenance absence rejects failed ${query.toLowerCase()} query even with correct stdout`, t => {
  const f = fixture(t); f.refused({ [`PROBE_${query}_EXIT`]: "1" });
  assert.equal(f.calls().filter(call => call.command === "systemctl").length, query === "LOAD" ? 1 : 2);
});

for (const state of ["active", "activating", "unknown"]) test(`maintenance absence rejects ActiveState ${state}`, t => {
  fixture(t).refused({ PROBE_ACTIVE_STATE: state });
});

test("maintenance absence rejects a loaded inactive service", t => {
  const f = fixture(t); f.refused({ PROBE_LOAD_STATE: "loaded" });
  assert.equal(f.calls().filter(call => call.command === "systemctl").length, 1);
});
