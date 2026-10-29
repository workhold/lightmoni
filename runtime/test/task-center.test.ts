import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import type { Dependencies } from "../src/shared/types.js";
import { TaskRunStore, registerTaskCenter } from "../src/server/task-center.js";
import { SCRIPT_TASK_CAPABILITY } from "../src/shared/task-center.js";
import { AgentTaskRunner, executeTaskScript } from "../src/agent/task-runner.js";

function fixture() {
  const db = new DB(":memory:"), router = new Router(), user = { id: "admin", name: "Admin", role: "admin" };
  let clock = new Date("2026-10-30T00:00:00Z");
  const deps = { db, router, now: () => clock,
    auth: { user: () => user, requireAdmin(ctx: any) { if (ctx.user.role !== "admin") fail(403, "admin required"); } },
    logger: { info() {}, warn() {}, error(...v: any[]) { console.error(...v); } },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const credentials = { has: () => true, authenticate(req: any, agent: string, audience: string) {
    if (audience !== "control" || req.headers.authorization !== "Bearer control-" + agent) fail(401, "control credentials required");
    return { agent_id: agent, audience: "control" };
  } } as any;
  const store = registerTaskCenter(deps, { agentCredentials: credentials });
  const host = (id: string, agent = "agent-" + id) => {
    db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'root','direct_ssh',?,?,?)", id, "Host " + id, id + ".example.test", agent, clock.toISOString(), clock.toISOString());
    return id;
  };
  host("one"); host("two"); host("empty", "");
  const task = (id = "script-one", options: any = {}) => store.nodes.task({ name: "Sample task", type: "script", enabled: true, target_all: false, host_ids: ["one"], label_ids: [],
    schedule: { mode: "once" }, script: { runtime: "node", code: "console.log('original')", timeout_seconds: 5, max_output_bytes: 4096 }, ...options }, id, true);
  return { db, deps, router, user, store, task, host,
    advance(seconds: number) { clock = new Date(clock.getTime() + seconds * 1000); },
    close() { store.close?.(); db.close(); } };
}
const capabilities = [SCRIPT_TASK_CAPABILITY];
const result = (lease: string, overrides: any = {}) => ({ lease_token: lease, state: "succeeded", code: "", summary: "done", stdout: "ok", stderr: "", exit_code: 0, ...overrides });

test("manual dispatch validates confirmation and targets atomically, snapshots code and hides lease tokens", () => {
  const f = fixture(); try {
    f.task();
    assert.throws(() => f.store.dispatch("script-one", {}, "admin"), /confirmation/);
    assert.throws(() => f.store.dispatch("script-one", { confirm: true, host_ids: ["two"] }, "admin"), /outside task targets/);
    const run = f.store.dispatch("script-one", { confirm: true, request_id: "safe-request" }, "admin").runs[0];
    assert.equal(run.state, "queued"); assert.equal(Object.hasOwn(run, "lease_token"), false);
    assert.equal(f.store.dispatch("script-one", { confirm: true, request_id: "safe-request" }, "admin").runs[0].id, run.id);
    assert.equal(f.store.list().length, 1);
    const updated = f.store.nodes.getTask("script-one");
    f.store.nodes.task({ ...updated, script: { ...updated.script, code: "console.log('changed')" } }, updated.id, false);
    assert.equal(f.store.get(run.id).snapshot.script.code, "console.log('original')");
    f.task("no-agent", { host_ids: ["one", "empty"] });
    assert.throws(() => f.store.dispatch("no-agent", { confirm: true }, "admin"), /enrolled Agent/);
    assert.equal(f.store.list({ task_id: "no-agent" }).length, 0);
  } finally { f.close(); }
});

test("claims require capability, serialize per Agent, bind hashed leases and accept only bounded valid receipts", () => {
  const f = fixture(); try {
    f.task(); const run = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    assert.equal(f.store.claim("agent-one", []), null);
    const claim = f.store.claim("agent-one", capabilities)!;
    assert.equal(claim.id, run.id); assert.equal(claim.state, "running");
    assert.notEqual(f.db.get<any>("SELECT lease_hash FROM task_runs WHERE id=?", run.id)!.lease_hash, claim.lease_token);
    assert.equal(f.store.claim("agent-one", capabilities), null);
    assert.throws(() => f.store.result("agent-two", run.id, result(claim.lease_token)), /another Agent/);
    assert.throws(() => f.store.result("agent-one", run.id, result("a".repeat(64))), /invalid task run lease/);
    assert.throws(() => f.store.result("agent-one", run.id, result(claim.lease_token, { stdout: "x".repeat(4097) })), /oversized/);
    assert.throws(() => f.store.result("agent-one", run.id, result(claim.lease_token, { exit_code: 1 })), /invalid/);
    assert.equal(f.store.result("agent-one", run.id, result(claim.lease_token)).state, "succeeded");
    assert.equal(f.store.result("agent-one", run.id, result(claim.lease_token, { state: "failed" })).state, "succeeded");
    assert.equal(Object.hasOwn(f.store.list()[0], "lease_hash"), false);
  } finally { f.close(); }
});

test("lease expiry is durable unknown, never automatic replay; explicit retry uses current definition", () => {
  const f = fixture(); try {
    f.task(); const run = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    const claim = f.store.claim("agent-one", capabilities)!;
    f.advance(61); assert.equal(f.store.get(run.id).state, "unknown");
    assert.equal(f.store.claim("agent-one", capabilities), null);
    assert.throws(() => f.store.result("agent-one", run.id, result(claim.lease_token)), /expired/);
    assert.throws(() => f.store.dispatch("script-one", { confirm: true }, "admin"), /unresolved/);
    const updated = f.store.nodes.getTask("script-one");
    f.store.nodes.task({ ...updated, script: { ...updated.script, code: "console.log('new version')" } }, updated.id, false);
    const retry = f.store.retry(run.id, "admin");
    assert.equal(retry.retry_of, run.id); assert.equal(retry.snapshot.script.code, "console.log('new version')");
    assert.equal(f.store.get(run.id).superseded_by, retry.id);
    assert.throws(() => f.store.retry(run.id, "admin"), /already has a retry/);
    assert.equal(f.store.claim("agent-one", capabilities)!.id, retry.id);
  } finally { f.close(); }
});

test("reviewed task revisions reject concurrent source edits before dispatch and retry", () => {
  const f = fixture(); try {
    const old = f.task();
    f.store.nodes.task({ ...old, script: { ...old.script, code: "console.log('unreviewed source')" } }, old.id, false);
    assert.throws(() => f.store.dispatch(old.id, { confirm: true, expected_task_revision: old.revision }, "admin"), /changed since review/);
    assert.equal(f.store.list().length, 0);
    const reviewed = f.store.nodes.getTask(old.id);
    const run = f.store.dispatch(old.id, { confirm: true, expected_task_revision: reviewed.revision }, "admin").runs[0];
    f.store.cancel(run.id, "admin");
    f.store.nodes.task({ ...reviewed, script: { ...reviewed.script, code: "console.log('edited again')" } }, old.id, false);
    assert.throws(() => f.store.retry(run.id, "admin", false, reviewed.revision), /changed since review/);
    assert.equal(f.store.get(run.id).superseded_by, ""); assert.equal(f.store.list().length, 1);
  } finally { f.close(); }
});

test("manual unknown resolution records an immutable audit without replaying or inventing success", () => {
  const f = fixture(); try {
    f.task(); const run = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    assert.throws(() => f.store.resolve(run.id, "admin", "Checked host"), /only an unknown/);
    const claim = f.store.claim("agent-one", capabilities)!;
    assert.throws(() => f.store.resolve(run.id, "admin", "Checked host"), /only an unknown/);
    f.advance(61); assert.equal(f.store.get(run.id).state, "unknown");
    assert.throws(() => f.store.resolve(run.id, "admin", " "), /reason/);
    assert.throws(() => f.store.resolve(run.id, "admin", "x".repeat(513)), /reason/);
    const resolved = f.store.resolve(run.id, "admin", "  Verified process ended on the host  ");
    assert.equal(resolved.state, "unknown"); assert.equal(resolved.code, "lease_expired");
    assert.equal(resolved.resolved_by, "admin"); assert.ok(resolved.resolved_at);
    assert.equal(resolved.resolution_reason, "Verified process ended on the host");
    assert.equal(f.store.resolve(run.id, "other-admin", "Another reason").resolution_reason, resolved.resolution_reason);
    assert.equal(f.store.get(run.id).resolved_by, "admin");
    assert.equal(f.store.list().length, 1); assert.equal(f.store.claim("agent-one", capabilities), null);
    assert.throws(() => f.store.retry(run.id, "admin"), /resolved/);
    assert.throws(() => f.store.result("agent-one", run.id, result(claim.lease_token)), /manually resolved/);
    const next = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    assert.notEqual(next.id, run.id); assert.equal(next.retry_of, "");
  } finally { f.close(); }
});

test("resolution-column upgrade preserves existing run snapshots, leases and receipts", () => {
  const f = fixture(); try {
    f.task(); const run = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    const claim = f.store.claim("agent-one", capabilities)!;
    for (const name of ["resolved_at", "resolved_by", "resolution_reason"]) f.db.exec(`ALTER TABLE task_runs DROP COLUMN ${name}`);
    const upgraded = new TaskRunStore(f.deps);
    const saved = upgraded.get(run.id);
    assert.equal(saved.state, "running"); assert.deepEqual(saved.snapshot, run.snapshot);
    assert.equal(saved.resolved_at, ""); assert.equal(saved.resolution_reason, "");
    assert.equal(upgraded.result("agent-one", run.id, result(claim.lease_token)).state, "succeeded");
  } finally { f.close(); }
});

test("cancellation waits for Agent receipt, removed targets cancel before claim and rebound identities cannot submit", () => {
  const f = fixture(); try {
    f.task(); const run = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    const claim = f.store.claim("agent-one", capabilities)!;
    assert.equal(f.store.cancel(run.id, "admin").state, "running");
    assert.equal(f.store.heartbeat("agent-one", run.id, { lease_token: claim.lease_token }).cancel_requested, true);
    assert.equal(f.store.result("agent-one", run.id, result(claim.lease_token, { state: "cancelled", exit_code: null })).state, "cancelled");
    const queued = f.store.dispatch("script-one", { confirm: true }, "admin").runs[0];
    f.db.run("UPDATE managed_machines SET agent_id='new-agent' WHERE id='one'");
    assert.equal(f.store.get(queued.id).code, "agent_binding_changed");
    assert.throws(() => f.store.result("agent-one", run.id, result(claim.lease_token)), /binding changed/);
    assert.equal(f.store.claim("new-agent", capabilities), null);
  } finally { f.close(); }
});

test("interval scheduling persists next due, skips overlaps and missed periods, and honors host overrides", () => {
  const f = fixture(); try {
    f.task("periodic", { schedule: { mode: "interval", interval_seconds: 10 } });
    f.store.tick(); assert.equal(f.store.list().length, 0);
    f.advance(10); f.store.tick(); assert.equal(f.store.list().length, 1);
    const queued = f.store.list()[0]; assert.equal(queued.trigger, "schedule");
    f.advance(3600); f.store.tick(); assert.equal(f.store.list().length, 1);
    const store2 = new TaskRunStore(f.deps); store2.tick(); assert.equal(store2.list().length, 1);
    const claim = f.store.claim("agent-one", capabilities)!;
    f.store.result("agent-one", claim.id, result(claim.lease_token));
    f.advance(10); f.store.tick(); assert.equal(f.store.list().length, 2);
    f.store.cancel(f.store.list()[0].id, "admin");
    f.store.nodes.setOverride("one", "periodic", { enabled: false });
    f.advance(10); f.store.tick(); assert.equal(f.store.list().length, 2);
  } finally { f.close(); }
});

test("scheduler rechecks a definition edited after its scan before dispatching a due interval", () => {
  const f = fixture(); try {
    f.task("periodic", { schedule: { mode: "interval", interval_seconds: 10 } });
    f.store.tick(); f.advance(10);
    const staleScan = f.store.nodes.tasks(), current = f.store.nodes.getTask("periodic");
    f.store.nodes.task({ ...current, schedule: { mode: "once" } }, current.id, false);
    const actual = f.store.nodes.tasks.bind(f.store.nodes);
    f.store.nodes.tasks = () => { f.store.nodes.tasks = actual; return staleScan; };
    f.store.tick();
    assert.equal(f.store.list().length, 0, "an old interval scan cannot execute a task now configured for explicit dispatch");
  } finally { f.close(); }
});

test("script executor isolates environment and enforces exit, timeout, output and cancellation", async t => {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-script-executor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  process.env.LIGHTMONI_CONTROL_CREDENTIAL_TEST = "must-not-inherit";
  try {
    const base = { runtime: "node" as const, code: "console.log(process.env.LIGHTMONI_CONTROL_CREDENTIAL_TEST ?? 'clean'); console.log('secret-value')", timeout_seconds: 2, max_output_bytes: 1024 };
    const ok = await executeTaskScript(base, { dataDir: directory, runID: "test", secrets: ["secret-value"] });
    assert.equal(ok.state, "succeeded"); assert.equal(ok.stdout, "clean\n[redacted]\n");
    const timeout = await executeTaskScript({ ...base, code: "setInterval(()=>{},1000)", timeout_seconds: 1 }, { dataDir: directory, runID: "timeout" });
    assert.equal(timeout.code, "timeout"); assert.equal(timeout.state, "failed");
    const big = await executeTaskScript({ ...base, code: "process.stdout.write('x'.repeat(1000000));setInterval(()=>{},1000)" }, { dataDir: directory, runID: "limit" });
    assert.equal(big.code, "output_limit"); assert.ok(Buffer.byteLength(big.stdout) + Buffer.byteLength(big.stderr) <= 1024);
    const cancelled = new AbortController(); cancelled.abort(Object.assign(Error(), { code: "cancel_requested" }));
    const stopped = await executeTaskScript({ ...base, code: "throw Error('must not execute')" }, { dataDir: directory, runID: "cancel", signal: cancelled.signal });
    assert.equal(stopped.state, "cancelled"); assert.equal(stopped.exit_code, null);
    const shell = await executeTaskScript({ ...base, runtime: "shell", code: "printf shell-ok" }, { dataDir: directory, runID: "shell" });
    assert.equal(shell.stdout, "shell-ok");
  } finally { delete process.env.LIGHTMONI_CONTROL_CREDENTIAL_TEST; }
});

test("relative Agent data directories resolve before changing script working directories", async t => {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-task-relative-data-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataDir = relative(process.cwd(), directory);
  for (const runtime of ["node", "shell"] as const) {
    const outcome = await executeTaskScript({ runtime, code: runtime === "node" ? "console.log('path-ok')" : "printf path-ok", timeout_seconds: 3, max_output_bytes: 1024 }, { dataDir, runID: "relative-data" });
    assert.equal(outcome.state, "succeeded"); assert.equal(outcome.stdout.trim(), "path-ok");
  }
});

test("real HTTP control enforces user roles/control audience and executes a script through Agent pull", async t => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "lightmoni-task-http-"));
  const server = createServer(async (req, res) => { if (!await f.router.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (path: string, method = "GET", body?: unknown, bearer?: string) => {
    const r = await fetch(endpoint + "/api/v1" + path, { method, headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  f.task("http-script", { script: { runtime: "node", code: "console.log('through real HTTP')", timeout_seconds: 3, max_output_bytes: 1024 } });
  f.user.role = "member";
  assert.equal((await request("/agent-tasks/http-script/dispatch", "POST", { confirm: true })).status, 403);
  assert.equal((await request("/task-runs")).status, 200);
  f.user.role = "admin";
  assert.equal((await request("/agent-tasks/http-script/dispatch", "POST", {})).status, 400);
  const dispatched = await request("/agent-tasks/http-script/dispatch", "POST", { confirm: true, expected_task_revision: (f.store.nodes.getTask("http-script") as any).revision });
  assert.equal(dispatched.status, 201);
  assert.equal((await request("/agents/agent-one/task-runs/claim", "POST", { capabilities }, "data-agent-one")).status, 401);
  const runner = new AgentTaskRunner({ endpoint, agentID: "agent-one", controlCredential: "control-agent-one", dataCredential: "data-agent-one", dataDir: directory });
  const outcome = await runner.pollOnce(); assert.equal(outcome!.state, "succeeded");
  const runs = await request("/task-runs?task_id=http-script");
  assert.equal(runs.body[0].state, "succeeded"); assert.equal(runs.body[0].stdout, ""); assert.equal(runs.body[0].details_omitted, true);
  const detail = await request("/task-runs/" + runs.body[0].id);
  assert.equal(detail.body.stdout, "through real HTTP\n");
  assert.equal(Object.hasOwn(runs.body[0], "lease_token"), false);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "task-run-state.json"), "utf8")), {});
  const uncertain = f.store.dispatch("http-script", { confirm: true }, "admin").runs[0];
  const leased = f.store.claim("agent-one", capabilities)!; f.advance(61);
  assert.equal(f.store.get(uncertain.id).state, "unknown");
  f.user.role = "member";
  assert.equal((await request(`/task-runs/${uncertain.id}/resolve`, "POST", { confirm: true, reason: "Checked process ended" })).status, 403);
  f.user.role = "admin";
  assert.equal((await request(`/task-runs/${uncertain.id}/resolve`, "POST", { reason: "Checked process ended" })).status, 400);
  assert.equal((await request(`/task-runs/${uncertain.id}/resolve`, "POST", { confirm: true, reason: " " })).status, 400);
  const confirmed = await request(`/task-runs/${uncertain.id}/resolve`, "POST", { confirm: true, reason: "Checked process ended" });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.state, "unknown"); assert.equal(confirmed.body.resolved_by, "admin");
  assert.equal((await request(`/agents/agent-one/task-runs/${uncertain.id}/result`, "POST", result(leased.lease_token), "control-agent-one")).status, 409);
});

test("crash recovery submits unknown rather than replaying saved source", async t => {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-task-recovery-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secret = "a".repeat(64), calls: any[] = [];
  writeFileSync(join(directory, "task-run-state.json"), JSON.stringify({ id: "crashed", lease_token: secret }));
  const runner = new AgentTaskRunner({ endpoint: "https://center.test", agentID: "agent", controlCredential: "control", dataDir: directory }, { fetch: (async (url: any, opts: any) => {
    const body = JSON.parse(opts.body); calls.push({ url, body });
    return Response.json(url.endsWith("/claim") ? { run: null } : { state: "unknown" });
  }) as typeof fetch });
  assert.equal(await runner.pollOnce(), null);
  assert.equal(calls[0].body.state, "unknown"); assert.equal(calls[0].body.code, "agent_restarted"); assert.equal(calls[1].url.endsWith("/claim"), true);
});

test("a lost result response retries the durable receipt without executing the script twice", async t => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "lightmoni-task-lost-result-")), count = join(directory, "count");
  const server = createServer(async (req, res) => { if (!await f.router.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.close(); rmSync(directory, { recursive: true, force: true }); });
  f.task("receipt-test", { script: { runtime: "node", code: `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(count)},'executed\\n');console.log('done')`, timeout_seconds: 3, max_output_bytes: 1024 } });
  const run = f.store.dispatch("receipt-test", { confirm: true }, "admin").runs[0];
  let lost = false;
  const runner = new AgentTaskRunner({ endpoint: `http://127.0.0.1:${(server.address() as any).port}`, agentID: "agent-one", controlCredential: "control-agent-one", dataDir: directory }, {
    fetch: (async (url: any, options: any) => {
      const response = await fetch(url, options);
      if (String(url).endsWith("/result") && !lost) { lost = true; await response.arrayBuffer(); throw Error("simulated lost HTTP response after commit"); }
      return response;
    }) as typeof fetch,
  });
  await assert.rejects(runner.pollOnce(), /lost HTTP response/);
  assert.equal(f.store.get(run.id).state, "succeeded");
  assert.ok(JSON.parse(readFileSync(join(directory, "task-run-state.json"), "utf8")).receipt);
  assert.equal(await runner.pollOnce(), null);
  assert.equal(readFileSync(count, "utf8"), "executed\n");
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "task-run-state.json"), "utf8")), {});
});

test("Agent heartbeat cancellation and control loss terminate live scripts and preserve honest final states", async t => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "lightmoni-task-live-control-"));
  const server = createServer(async (req, res) => { if (!await f.router.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.close(); rmSync(directory, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const mode of ["cancel", "lost"] as const) {
    const pidFile = join(directory, mode + ".pid");
    f.task(mode, { script: { runtime: "node", code: `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`, timeout_seconds: 10, max_output_bytes: 1024 } });
    const run = f.store.dispatch(mode, { confirm: true }, "admin").runs[0];
    let loseControl = false;
    const runner = new AgentTaskRunner({ endpoint, agentID: "agent-one", controlCredential: "control-agent-one", dataDir: directory, heartbeatIntervalMs: 10 }, { fetch: (async (url: any, opts: any) => {
      if (loseControl && String(url).endsWith("/heartbeat")) throw Error("simulated control disconnect");
      return fetch(url, opts);
    }) as typeof fetch });
    const pending = runner.pollOnce();
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(existsSync(pidFile), true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (mode === "cancel") f.store.cancel(run.id, "admin"); else loseControl = true;
    const outcome = await pending;
    assert.equal(outcome!.state, mode === "cancel" ? "cancelled" : "unknown");
    assert.equal(f.store.get(run.id).state, outcome!.state);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  }
});

test("supervisor kills a running script when its Agent process crashes", async t => {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-task-parent-crash-")), pidFile = join(directory, "script.pid");
  const moduleURL = new URL("../src/agent/task-runner.ts", import.meta.url).href;
  const script = { runtime: "node", code: `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`, timeout_seconds: 30, max_output_bytes: 1024 };
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {executeTaskScript} from ${JSON.stringify(moduleURL)};await executeTaskScript(${JSON.stringify(script)},{dataDir:${JSON.stringify(directory)},runID:'crash-test'})`], { stdio: "ignore", cwd: new URL("..", import.meta.url) });
  let scriptPID = 0;
  t.after(() => { child.kill("SIGKILL"); if (scriptPID) try { process.kill(scriptPID, "SIGKILL"); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const end = Date.now() + 5000;
  while (!existsSync(pidFile) && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.equal(existsSync(pidFile), true); scriptPID = Number(readFileSync(pidFile, "utf8"));
  child.kill("SIGKILL"); await once(child, "close");
  const alive = () => { try { process.kill(scriptPID, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 4000;
  while (alive() && Date.now() < deadline) await new Promise(r => setTimeout(r, 30));
  assert.equal(alive(), false, "script must not survive Agent crash until its configured deadline");
});
