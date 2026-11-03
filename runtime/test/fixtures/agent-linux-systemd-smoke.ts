/** Destructive integration fixture. Run only in a fresh disposable systemd container. */
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { once } from "node:events";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DB } from "../../src/shared/sqlite.js";
import { Router, fail } from "../../src/shared/http.js";
import { cipher } from "../../src/shared/crypto.js";
import type { Dependencies } from "../../src/shared/types.js";
import { registerTaskCenter } from "../../src/server/task-center.js";
import { registerAgentCredentials } from "../../src/server/agent-credentials.js";
import { registerManagedMachines } from "../../src/server/managed-machines.js";
import { registerNodes } from "../../src/server/nodes.js";
import { registerPrivilegedExecutors } from "../../src/server/privileged-executors.js";
import { registerInstall } from "../../src/server/install.js";

if (process.env.LIGHTMONI_LINUX_SYSTEMD_SMOKE !== "disposable-container"
  || process.platform !== "linux" || process.getuid?.() !== 0
  || !existsSync("/.dockerenv") || !existsSync("/run/systemd/system")
  || existsSync("/opt/lightmoni-agent") || existsSync("/usr/local/bin")
  || spawnSync("id", ["lightmoni-agent"], {stdio: "ignore"}).status === 0
  || spawnSync("getent", ["group", "lightmoni-agent"], {stdio: "ignore"}).status === 0)
  throw Error("fresh_disposable_systemd_container_without_agent_account_required");

const finalReleaseDir = resolve(process.argv[2] ?? "/qa/releases"), output = resolve(process.argv[3] ?? "/qa/linux-report.json");
const previousReleaseDir = process.argv[4] ? resolve(process.argv[4]) : undefined;
const releaseDir = "/qa/active-downloads";
const selectDownloads = (directory: string) => {rmSync(releaseDir, {force: true}); symlinkSync(directory, releaseDir);};
selectDownloads(finalReleaseDir);
const origin = "https://localhost:19443", user = {id: "qa-admin", name: "QA Admin", role: "admin"};
const db = new DB(":memory:"), router = new Router();
const deps = {
  db, router, ...cipher(randomBytes(32)), now: () => new Date(), externalURL: origin,
  auth: {master: randomBytes(32), user: (req: any) => req.headers.cookie === "lm_session=qa" ? user : undefined,
    requireAdmin(ctx: any) {if (ctx.user.role !== "admin") fail(403, "admin_required");}},
  logger: {info() {}, warn() {}, error() {}},
} as unknown as Dependencies;
router.auth = deps.auth;
db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER)");
db.run("INSERT INTO users VALUES(?,?,?,1)", user.id, user.name, user.role);
const credentials = registerAgentCredentials(deps);
const shell = (command: string, username = "root", stdin = "") => new Promise<{stdout: string; stderr: string; stages: string[]}>((accept, reject) => {
  const child = spawn(username === "root" ? "/bin/sh" : "/usr/sbin/runuser",
    username === "root" ? ["-c", command] : ["-u", username, "--", "/bin/sh", "-c", command],
    {stdio: ["pipe", "pipe", "pipe"], env: process.env});
  let stdout = "", stderr = "";
  child.stdout.on("data", value => {stdout += value;}); child.stderr.on("data", value => {stderr += value;});
  child.once("error", reject);
  child.once("exit", code => {
    if (code === 0) accept({stdout, stderr, stages: []});
    else {writeFileSync("/qa/fixed-command-failure.txt", stderr + "\n" + stdout, {mode: 0o600});
      reject(Error("local_fixed_command_failed:" + code + ":" + stderr.slice(-2500)));}
  });
  child.stdin.end(stdin);
});
const machines = registerManagedMachines(deps, {agentCredentials: credentials, dataDir: "/qa/center", downloadsDir: releaseDir,
  updatePollIntervalMs: 250, updateHealthTimeoutMs: 180_000,
  // Exercise the exact fixed SSH command and protected input, using a local
  // login identity. This fixture does not test the SSH network/auth transport.
  sshRunner: input => shell(input.command, input.machine.username, input.stdin ?? (input.enrollmentToken ? input.enrollmentToken + "\n" : "")),
});
const nodes = registerNodes(deps, {agentCredentials: credentials});
const tasks = registerTaskCenter(deps, {agentCredentials: credentials});
const executors = registerPrivilegedExecutors(deps, {dataDir: "/qa/center"});
tasks.ordinaryTaskIdentity = (machineID, agentID, executorID, generation) => executors.ordinaryTaskIdentity(machineID, agentID, executorID, generation);
tasks.nodes.taskScriptCapabilities = executors.ordinaryTaskCapabilities.bind(executors);
nodes.setTaskScriptCapabilities(executors.ordinaryTaskCapabilities.bind(executors));
executors.taskRuns = tasks;
const bootstrap = machines.registerExecutorBootstrap(executors);
// The current platform's unmodified installer installs the previous immutable
// bundle first, then its normal update API serves the final image's bundle.
router.get("/downloads/agent/install.sh", c => {
  const bearer = String(c.req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!credentials.canDownloadWithEnrollmentToken(bearer)) fail(401, "host_bound_enrollment_required");
  c.res.writeHead(200, {"content-type": "application/octet-stream", "cache-control": "no-store"});
  c.res.end(readFileSync(resolve(finalReleaseDir, "install.sh")));
}, {public: true});
registerInstall(deps, releaseDir, credentials);
// Telemetry transport is accepted by an in-memory fixture sink. This avoids
// false last_error values during update health checks without claiming storage.
for (const signal of ["metrics", "logs", "traces"]) router.post("/v1/" + signal, async c => {
  await c.raw(8 << 20); c.json({});
}, {public: true});
router.get("/healthz", ctx => ctx.json({status: "ok"}), {public: true});
const server = createServer({key: readFileSync("/qa/tls/key.pem"), cert: readFileSync("/qa/tls/cert.pem")}, async (req, res) => {
  if (!(await router.handle(req, res))) {res.writeHead(404); res.end();}
});
server.listen(19443, "127.0.0.1");
await once(server, "listening");
const report: any = {date: new Date().toISOString(), platform: process.platform, arch: process.arch,
  node: process.version, systemd: execFileSync("systemctl", ["--version"], {encoding: "utf8"}).split("\n")[0],
  center_source_revision: process.env.LIGHTMONI_LINUX_CENTER_REVISION ?? "unrecorded",
  source_revision: JSON.parse(readFileSync(resolve(finalReleaseDir, "agent-releases.json"), "utf8")).releases[0].source_revision,
  final_arm64_release: JSON.parse(readFileSync(resolve(finalReleaseDir, "agent-releases.json"), "utf8")).releases.find((value: any) => value.arch === "arm64"),
  ...(previousReleaseDir ? {previous_source_revision: JSON.parse(readFileSync(resolve(previousReleaseDir, "agent-releases.json"), "utf8")).releases[0].source_revision} : {}),
  host_baseline: "no Agent account or /usr/local/bin before either installation; USERGROUPS_ENAB=no",
  scope: "real Linux/root/systemd, original installer and fixed commands, production enrollment and signed task modules; local login adapter replaces SSH transport; no ClickHouse or real Docker daemon",
  checks: []};
const check = (name: string, observed?: any) => {report.checks.push({name, status: "passed", ...(observed ? {observed} : {})}); console.log("PASS " + name);};
const request = async (path: string, method = "GET", body?: any) => {
  const response = await fetch(origin + "/api/v1" + path, {method,
    headers: {cookie: "lm_session=qa", ...(body === undefined ? {} : {"content-type": "application/json"})},
    body: body === undefined ? undefined : JSON.stringify(body)});
  const text = await response.text();
  assert.ok(response.ok, method + " " + path + ": " + response.status + " " + text);
  return text ? JSON.parse(text) : undefined;
};
const wait = async <T>(action: () => T | Promise<T>, predicate: (value: T) => boolean, message: string, seconds = 90): Promise<T> => {
  const deadline = Date.now() + seconds * 1000;
  while (true) {const value = await action(); if (predicate(value)) return value;
    if (Date.now() > deadline) throw Error(message + ":" + JSON.stringify(value));
    await new Promise(resolve => setTimeout(resolve, 250));}
};
const system = (args: string[]) => execFileSync("systemctl", args, {encoding: "utf8"}).trim();
try {
  for (const [mode, login] of [["root", "root"], ["user", "qa-deploy"]] as const) {
    selectDownloads(mode === "root" && previousReleaseDir ? previousReleaseDir : finalReleaseDir);
    assert.notEqual(spawnSync("id", ["lightmoni-agent"], {stdio: "ignore"}).status, 0);
    assert.notEqual(spawnSync("getent", ["group", "lightmoni-agent"], {stdio: "ignore"}).status, 0);
    assert.equal(existsSync("/usr/local/bin"), false);
    const host = await request("/machines", "POST", {name: "Systemd QA " + mode, address: "localhost", connection_method: "direct_ssh"});
    const account = await request("/machines/" + host.id + "/accounts", "POST", {username: login, make_default: true});
    db.run("UPDATE managed_machines SET host_key_fingerprint='SHA256:abcdefghijklmnop' WHERE id=?", host.id);
    const credential = await request("/machines/" + host.id + "/accounts/" + account.id + "/credentials", "POST", {method: "password", secret: "isolated-local-login-fixture", retention: "permanent", confirm_permanent: true});
    const inspected = await request("/machines/" + host.id + "/ssh-check", "POST", {credential_id: credential.credential_id});
    assert.equal(inspected.ready, true);
    assert.equal(inspected.privilege.state, login === "root" ? "root" : "sudo_noninteractive");
    check(mode + " fixed preflight observes actual " + inspected.privilege.state);
    const planned = await request("/machines/" + host.id + "/deployments/plan", "POST", {check_id: inspected.id, credential_id: credential.credential_id, version: "0.1.0", arch: "arm64", runtime_mode: mode});
    const applied = await request("/machines/" + host.id + "/deployments/" + planned.id + "/apply", "POST", {confirm: true});
    assert.equal(applied.status, "succeeded");
    const agentID = db.get<{agent_id: string}>("SELECT agent_id FROM managed_machines WHERE id=?", host.id)!.agent_id;
    assert.equal(system(["is-active", "lightmoni-agent.service"]), "active");
    const daemonUID = Number(system(["show", "lightmoni-agent.service", "--property=MainPID", "--value"]));
    const status = readFileSync("/proc/" + daemonUID + "/status", "utf8");
    const uid = Number(execFileSync("id", ["-u", "lightmoni-agent"], {encoding: "utf8"}).trim());
    assert.equal(execFileSync("id", ["-gn", "lightmoni-agent"], {encoding: "utf8"}).trim(), "lightmoni-agent");
    assert.ok(uid > 0); assert.match(status, new RegExp("^Uid:\\s+" + uid + "\\s+" + uid, "m"));
    assert.match(status, /^NoNewPrivs:\s+1$/m);
    assert.match(status, /^CapEff:\s+0+$/m);
    check(mode + " original installer starts actual non-root Agent", {uid, pid: daemonUID});
    if (mode === "root") {
      assert.equal(system(["is-active", "lightmoni-agent-helper.service"]), "active");
      const pid = Number(system(["show", "lightmoni-agent-helper.service", "--property=MainPID", "--value"]));
      assert.match(readFileSync("/proc/" + pid + "/status", "utf8"), /^Uid:\s+0\s+0/m);
      check("root helper starts under systemd and private absolute-path guard");
      await wait(() => executors.getStatus(host.id), value => value.script_profiles.accounts.length > 0, "helper heartbeat missing");
      const task = tasks.nodes.task({name: "Real ordinary identity", type: "script", enabled: true, target_all: false,
        host_ids: [host.id], label_ids: [], schedule: {mode: "once"}, script: {runtime: "node", code: "import fs from 'node:fs';const groups=fs.readFileSync('/proc/self/status','utf8').split('\\n').find(line=>line.startsWith('Groups:')).slice(7).trim().split(/\\s+/).filter(Boolean).map(Number);console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups}))", timeout_seconds: 5, max_output_bytes: 4096}}, "qa-real-ordinary", true);
      const run = tasks.dispatch(task.id, {confirm: true, expected_task_revision: task.revision}, user.id).runs[0];
      const result = await wait(() => tasks.get(run.id), value => ["succeeded", "failed", "unknown"].includes(value.state), "ordinary script did not finish");
      assert.equal(result.state, "succeeded", JSON.stringify(result));
      const observed = JSON.parse(result.stdout.trim()); assert.equal(observed.uid, uid); assert.deepEqual(observed.groups, []);
      assert.equal(result.requested_by, user.id); assert.equal(result.snapshot.execution_identity?.uid, uid);
      check("signed ordinary task runs as same Agent UID and records actor/identity", observed);
      const policy = executors.preparePolicyPlan(host.id, {capabilities: ["script.elevated.v1"]}, user.id);
      executors.applyPolicy(host.id, policy.id, {confirm: true, expected_revision: policy.revision}, user.id);
      const privilegedReady = await wait(() => executors.getStatus(host.id), value => value.capabilities["script.elevated.v1"].effective === "ready", "privileged policy not observed");
      const root = privilegedReady.script_profiles.accounts.find((value: {name: string}) => value.name === "root")!;
      const interpreter = privilegedReady.script_profiles.interpreters.shell;
      assert.ok(root); assert.ok(interpreter);
      const plan = executors.plan({host_ids: [host.id], capability: "script.elevated.v1", payload: {kind: "script", runtime: "shell", code: "id -u", args: [], cwd_profile: "private", environment: {}, account: root, interpreter_sha256: interpreter, timeout_ms: 5000, max_output_bytes: 4096}}, user.id);
      const job = executors.apply(plan.id, {confirm: true, expected_revision: plan.revision, request_id: "qa-real-root-task"}, user.id).jobs[0];
      const finished = await wait(() => executors.get(job.id), value => ["succeeded", "failed", "unknown"].includes(value.state), "approved root task did not finish");
      assert.equal(finished.state, "succeeded", JSON.stringify(finished));
      assert.equal(executors.output(job.id, user.id).stdout.trim(), "0");
      assert.ok(db.get("SELECT id FROM privileged_audit WHERE job_id=?", job.id));
      check("approved signed root script executes through actual systemd transient unit and audits");
      if (previousReleaseDir) {
        const target = JSON.parse(readFileSync(resolve(finalReleaseDir, "agent-releases.json"), "utf8")).releases.find((value: any) => value.arch === "arm64");
        const previous = JSON.parse(readFileSync(resolve(previousReleaseDir, "agent-releases.json"), "utf8")).releases.find((value: any) => value.arch === "arm64");
        assert.notEqual(target.sha256, previous.sha256);
        selectDownloads(finalReleaseDir);
        const maintain = async (action: "upgrade" | "rollback") => {
          const before = executors.getStatus(host.id).executor!;
          const plan = await request("/machines/" + host.id + "/agent-updates/plan", "POST", {action, credential_id: credential.credential_id,
            ...(action === "upgrade" ? {target_sha256: target.sha256} : {})});
          await request("/machines/" + host.id + "/agent-updates/" + plan.id + "/apply", "POST", {confirm: true});
          const result = await wait(() => request("/machines/" + host.id + "/agent-updates/" + plan.id),
            value => ["succeeded", "failed", "unknown", "rolled_back"].includes(value.status), action + " did not finish", 180);
          assert.equal(result.status, "succeeded", JSON.stringify(result));
          const after = executors.getStatus(host.id).executor!;
          const expected = action === "upgrade" ? target : previous;
          assert.equal(after.id, before.id); assert.notEqual(after.activation_id, before.activation_id);
          assert.equal(after.release?.source_revision, expected.source_revision);
          assert.equal(after.release?.build_id, expected.build_id); assert.equal(after.release?.artifact_sha256, expected.sha256);
          check("root " + action + " confirms both actual services, signed target build and new helper activation", {source_revision: expected.source_revision, artifact_sha256: expected.sha256});
        };
        await maintain("upgrade"); await maintain("rollback"); await maintain("upgrade");
      }
    } else {
      assert.equal(existsSync("/etc/systemd/system/lightmoni-agent-helper.service"), false);
      assert.equal(existsSync("/etc/lightmoni-agent-helper"), false);
      assert.deepEqual(executors.ordinaryTaskCapabilities(host.id, agentID), []);
      check("monitoring mode installs no helper or custom-script channel");
    }
    const switchMode = async (target: "root" | "user") => {
      const plan = await request("/machines/" + host.id + "/agent-runtime/plans", "POST", {runtime_mode: target, credential_id: credential.credential_id});
      await request("/machines/" + host.id + "/agent-runtime/plans/" + plan.id + "/apply", "POST", {confirm: true, expected_revision: plan.revision, request_id: randomUUID()});
      const result = await wait(() => request("/machines/" + host.id + "/agent-runtime/plans/" + plan.id),
        value => ["succeeded", "failed", "unknown"].includes(value.status), "mode switch did not finish", 120);
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      assert.equal(system(["is-active", "lightmoni-agent.service"]), "active");
      assert.equal(existsSync("/etc/systemd/system/lightmoni-agent-helper.service"), target === "root");
      if (target === "root") {
        assert.equal(system(["is-active", "lightmoni-agent-helper.service"]), "active");
        const task = tasks.nodes.task({name: "Task after mode switch", type: "script", enabled: true, target_all: false,
          host_ids: [host.id], label_ids: [], schedule: {mode: "once"}, script: {runtime: "node", code: "console.log(process.getuid())", timeout_seconds: 5, max_output_bytes: 4096}}, "qa-after-mode-" + host.id, true);
        const run = tasks.dispatch(task.id, {confirm: true, expected_task_revision: task.revision}, user.id).runs[0];
        const completed = await wait(() => tasks.get(run.id), value => ["succeeded", "failed", "unknown"].includes(value.state), "script after mode switch did not finish");
        assert.equal(completed.state, "succeeded", JSON.stringify(completed)); assert.equal(completed.stdout.trim(), String(uid));
        check(login + " ordinary task after root transition uses newly signed identity and same Agent UID");
      }
      check(login + " reviewed mode switch to " + target + " confirms actual service identity and permission generation");
    };
    await switchMode(mode === "root" ? "user" : "root");
    await switchMode(mode);
    writeFileSync("/var/lib/lightmoni-agent/qa-retained-data", "preserved business data");
    const recheck = await request("/machines/" + host.id + "/ssh-check", "POST", {credential_id: credential.credential_id});
    const removal = await request("/machines/" + host.id + "/uninstallations/plan", "POST", {credential_id: credential.credential_id, check_id: recheck.id});
    const removed = await request("/machines/" + host.id + "/uninstallations/" + removal.id + "/apply", "POST", {confirm: true});
    assert.equal(removed.status, "succeeded");
    assert.equal(existsSync("/opt/lightmoni-agent"), false);
    assert.equal(existsSync("/etc/lightmoni-agent-helper"), false);
    assert.equal(existsSync("/etc/systemd/system/lightmoni-agent-helper.service"), false);
    assert.equal(readFileSync("/var/lib/lightmoni-agent/qa-retained-data", "utf8"), "preserved business data");
    assert.equal(db.get<any>("SELECT count(*) n FROM agent_credentials WHERE revoked_at IS NULL AND agent_id=?", agentID)!.n, 0);
    check(mode + " original platform removal stops both services, revokes credentials and retains data");
    // This container hosts a second fresh independent asset next. The ordinary
    // production uninstaller intentionally retains data; cleanup is fixture-only.
    await shell("rm -rf /var/lib/lightmoni-agent /etc/lightmoni-agent; userdel lightmoni-agent; if getent group lightmoni-agent >/dev/null; then groupdel lightmoni-agent; fi; rmdir /usr/local/bin");
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = (error as Error).message; throw error;
} finally {
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  await bootstrap.close?.(); await executors.close?.(); await tasks.close?.(); await nodes.close?.(); await machines.close?.(); await credentials.close?.();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close();
}
