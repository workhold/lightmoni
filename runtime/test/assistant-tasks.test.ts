import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { cipher } from "../src/shared/crypto.js";
import { Router } from "../src/shared/http.js";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Dependencies } from "../src/shared/types.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { TaskProposalService, taskTools } from "../src/assistant/task-tools.js";
import { registerAssistant } from "../src/assistant/index.js";

const admin = { id: "alice", role: "admin" }, member = { id: "member", role: "member" };
function fixture(t: any) {
  const db = new DB(":memory:"), crypt = cipher(Buffer.alloc(32, 4));
  let at = new Date("2026-10-30T01:00:00Z");
  const deps = { db, ...crypt, router: new Router(), now: () => at,
    logger: { info() {}, warn() {}, error() {} } } as unknown as Dependencies;
  const runs = new TaskRunStore(deps), proposals = new TaskProposalService(deps, runs), nodes = runs.nodes;
  for (const id of ["one", "two"]) db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES(?,?,'fixture.invalid',22,'user','direct_ssh',?,?,?)", id, "Host " + id, "agent-" + id, at.toISOString(), at.toISOString());
  const definition = { name: "Fixture script", type: "script", enabled: true, label_ids: [], host_ids: ["one"], target_all: false,
    schedule: { mode: "once" }, script: { runtime: "node", code: "console.log('fixture')", timeout_seconds: 5, max_output_bytes: 4096 } };
  nodes.task(definition, "fixture-task", true);
  t.after(() => db.close());
  return { db, deps, nodes, runs, proposals, definition, tools: taskTools(proposals), advance(seconds: number) { at = new Date(at.getTime() + seconds * 1000); } };
}
const dispatch = { operation: "task.dispatch", task_id: "fixture-task", reason: "Run the reviewed fixture" };

test("AI calendar script creation uses the same reviewed definition as manual tasks and does not execute on drafting", async t => {
  const f = fixture(t), tool = f.tools.find(tool => tool.name === "propose_task_action")!;
  const definition = {...f.definition, name:"Daily backup", schedule:{mode:"cron",cron:"0 2 * * *",timezone:"Asia/Shanghai"},
    script:{...f.definition.script, runtime:"shell", code:"printf '%s\\n' \"$1\"", args:["daily backup"], cwd:"/var/tmp"},
    execution_policy:{max_concurrency:3,queue_timeout_seconds:1800,retry_count:0,retry_delay_seconds:60}};
  const drafted = await tool.execute({operation:"task.create",task:definition,reason:"Run the user reviewed backup at 02:00"},new AbortController().signal,admin,{session_id:"calendar-session"});
  assert.equal(drafted.proposal.status,"awaiting_approval");
  assert.equal(f.nodes.tasks().some(task=>task.name===definition.name),false);
  assert.equal(f.runs.list().length,0);
  const applied=f.proposals.apply(admin,drafted.proposal.id),saved=f.nodes.getTask(applied.task_id);
  assert.deepEqual(saved.schedule,definition.schedule);
  assert.deepEqual(saved.script,definition.script);
  assert.deepEqual(saved.execution_policy,definition.execution_policy);
  assert.equal(f.runs.list().length,0);
  assert.ok((tool.schema as any).properties.task.properties.schedule.properties.timezone);
});

test("an AI one-time plan that becomes past before approval must be rescheduled rather than silently replayed", t => {
  const f=fixture(t);
  const draft=f.proposals.create(admin,"session",{operation:"task.create",reason:"One future check",task:{...f.definition,name:"One-time check",schedule:{mode:"at",run_at:"2026-10-30T01:01:00Z"}}});
  f.advance(61);
  assert.throws(()=>f.proposals.apply(admin,draft.id),/必须晚于当前时间/);
  assert.equal(f.nodes.tasks().some(task=>task.name==="One-time check"),false);
  assert.equal(f.runs.list().length,0);
});

test("AI has draft and read tools but no apply or direct execution tool; draft does not queue a run", async t => {
  const f = fixture(t), tool = f.tools.find(tool => tool.name === "propose_task_action")!;
  assert.equal(tool.effect, "draft");
  assert.ok(f.tools.every(tool => !tool.name.includes("apply") && !tool.name.startsWith("execute")));
  const result = await tool.execute(dispatch, new AbortController().signal, admin, { session_id: "session" });
  assert.equal(result.proposal.status, "awaiting_approval");
  assert.match(result.proposal.review_url, /proposal=/);
  assert.equal(f.runs.list().length, 0);
  assert.equal(JSON.stringify(result).includes("console.log"), false);
  const stored = f.db.get<any>("SELECT body FROM assistant_task_proposals WHERE id=?", result.proposal.id)!;
  assert.equal(stored.body.includes("Fixture script"), false);
});

test("approved dispatch is atomic, owner-bound and idempotent; completing a proposal only queues execution", t => {
  const f = fixture(t), p = f.proposals.create(admin, "session", dispatch);
  assert.throws(() => f.proposals.get({ id: "other", role: "admin" }, p.id), /不存在/);
  assert.throws(() => f.proposals.apply(member, p.id), /管理员/);
  const applied = f.proposals.apply(admin, p.id);
  assert.equal(applied.status, "completed");
  assert.equal((applied.result as any).runs[0].state, "queued");
  assert.equal(f.proposals.apply(admin, p.id).status, "completed");
  assert.equal(f.runs.list().length, 1);
  assert.equal(f.db.all("SELECT * FROM assistant_task_audit").length, 1);
  assert.equal(JSON.stringify(applied.result).includes("console.log"), false);
});

test("task edits, single-host overrides and Agent rebinding invalidate a dispatch preview", t => {
  const f = fixture(t);
  let p = f.proposals.create(admin, "session", dispatch);
  const task = f.nodes.getTask("fixture-task");
  f.nodes.task({ ...task, script: { ...task.script, code: "console.log('changed')" } }, task.id, false);
  assert.throws(() => f.proposals.apply(admin, p.id), /变化/);
  p = f.proposals.create(admin, "session", dispatch);
  f.nodes.setOverride("one", task.id, { enabled: false });
  assert.throws(() => f.proposals.apply(admin, p.id), /变化/);
  f.nodes.setOverride("one", task.id, { enabled: true });
  p = f.proposals.create(admin, "session", dispatch);
  f.db.run("UPDATE managed_machines SET agent_id='replacement' WHERE id='one'");
  assert.throws(() => f.proposals.apply(admin, p.id), /变化/);
  assert.equal(f.runs.list().length, 0);
});

test("create and update proposals validate without persistence, commit once and reject stale source", t => {
  const f = fixture(t);
  const p = f.proposals.create(admin, "session", { operation: "task.create", reason: "Create a reviewed task", task: { ...f.definition, name: "AI draft" } });
  assert.throws(() => f.nodes.getTask(p.task_id), /不存在/);
  const applied = f.proposals.apply(admin, p.id);
  assert.equal((applied.result as any).name, "AI draft");
  f.proposals.apply(admin, p.id);
  assert.equal(f.nodes.tasks().filter(task => task.name === "AI draft").length, 1);
  const update = f.proposals.create(admin, "session", { operation: "task.update", task_id: p.task_id, task: { name: "Updated" }, reason: "Rename" });
  assert.equal(f.nodes.getTask(p.task_id).name, "AI draft");
  assert.equal((f.proposals.apply(admin, update.id).result as any).name, "Updated");
  const stale = f.proposals.create(admin, "session", { operation: "task.update", task_id: p.task_id, task: { name: "Never applied" }, reason: "Rename again" });
  f.nodes.task({ name: "Manual edit" }, p.task_id, false);
  assert.throws(() => f.proposals.apply(admin, stale.id), /变化/);
  assert.equal(f.nodes.getTask(p.task_id).name, "Manual edit");
});

test("expired and invalid task proposals cannot create scripts or runs", t => {
  const f = fixture(t), p = f.proposals.create(admin, "session", dispatch);
  f.advance(901);
  assert.throws(() => f.proposals.apply(admin, p.id), /过期/);
  assert.throws(() => f.proposals.create(admin, "session", { ...dispatch, host_ids: ["two"] }), /目标/);
  assert.throws(() => f.proposals.create(admin, "session", { operation: "task.create", reason: "Invalid", task: { ...f.definition, script: { runtime: "python", code: "bad" } } }), /脚本|script/);
  assert.equal(f.runs.list().length, 0);
});

test("cancel and retry proposals retain original receipts and create only one explicit retry", t => {
  const f = fixture(t), run = f.runs.dispatch("fixture-task", { confirm: true }, admin.id).runs[0];
  const cancel = f.proposals.create(admin, "session", { operation: "run.cancel", run_id: run.id, reason: "Cancel the fixture" });
  assert.equal(f.runs.get(run.id).state, "queued");
  f.proposals.apply(admin, cancel.id);
  assert.equal(f.runs.get(run.id).state, "cancelled");
  const retry = f.proposals.create(admin, "session", { operation: "run.retry", run_id: run.id, reason: "Retry after review" });
  const applied = f.proposals.apply(admin, retry.id);
  f.proposals.apply(admin, retry.id);
  assert.equal(f.runs.list().length, 2);
  assert.equal(f.runs.get(run.id).state, "cancelled");
  assert.equal(f.runs.get((applied.result as any).id).retry_of, run.id);
});

test("AI execution reads omit arbitrary script bodies, host output and lease credentials", async t => {
  const f = fixture(t), run = f.runs.dispatch("fixture-task", { confirm: true }, admin.id).runs[0];
  f.db.run("UPDATE task_runs SET stdout='private-output',stderr='private-error',lease_hash='private-lease',code='private-code',summary='private-summary' WHERE id=?", run.id);
  const read = f.tools.find(tool => tool.name === "get_task_run")!;
  const result = await read.execute({ id: run.id }, new AbortController().signal, admin);
  assert.equal(result.output_omitted, true);
  assert.equal(/private-output|private-error|private-lease|private-code|private-summary|console\.log/.test(JSON.stringify(result)), false);
  assert.equal(result.run.code, "agent_report");
  await assert.rejects(read.execute({ id: run.id }, new AbortController().signal, member), /管理员/);
});

test("manual resolution invalidates an AI retry proposal and remains a human-only operation", async t => {
  const f = fixture(t), run = f.runs.dispatch("fixture-task", { confirm: true }, admin.id).runs[0];
  f.db.run("UPDATE task_runs SET state='unknown' WHERE id=?", run.id);
  const retry = f.proposals.create(admin, "session", { operation: "run.retry", run_id: run.id, reason: "Retry after review" });
  f.runs.resolve(run.id, admin.id, "Verified the process has ended");
  assert.throws(() => f.proposals.apply(admin, retry.id), /变化/);
  assert.throws(() => f.proposals.create(admin, "session", { operation: "run.retry", run_id: run.id, reason: "Obsolete retry" }), /人工确认/);
  assert.throws(() => f.proposals.create(admin, "session", { operation: "run.cancel", run_id: run.id, reason: "Cannot cancel uncertainty" }), /不能通过取消/);
  assert.ok(f.tools.every(tool => !tool.name.includes("resolve")));
  const result = await f.tools.find(tool => tool.name === "get_task_run")!.execute({ id: run.id }, new AbortController().signal, admin);
  assert.equal(result.run.state, "unknown");
  assert.equal(result.run.resolved_by, admin.id);
  assert.equal(JSON.stringify(result).includes("Verified the process"), false);
  assert.equal(f.runs.list().length, 1);
});

test("the real assistant HTTP approval route requires an administrator and explicit confirmation", async t => {
  const f = fixture(t), user = { ...admin, name: "Alice" };
  f.deps.auth = { master: Buffer.alloc(32, 4), user: () => user,
    requireAdmin(ctx: any) { if (ctx.user.role !== "admin") throw Error("administrator required"); } } as any;
  f.deps.router.auth = f.deps.auth;
  const module = registerAssistant(f.deps, { taskCenter: f.runs, runtime: async () => {} });
  const server = createServer((req, res) => { void f.deps.router.handle(req, res).then(found => { if (!found) { res.statusCode = 404; res.end(); } }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const p = f.proposals.create(admin, "session", dispatch), path = base + "/api/v1/assistant/task-proposals/" + p.id;
    let response = await fetch(path);
    assert.equal(response.status, 200); assert.equal((await response.json() as any).status, "awaiting_approval");
    const apply = (input: any) => fetch(path + "/apply", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(input) });
    response = await apply({}); assert.equal(response.status, 400);
    assert.equal(f.runs.list().length, 0);
    user.role = "member";
    response = await apply({ confirm: true }); assert.equal(response.status, 403);
    user.role = "admin";
    response = await apply({ confirm: true }); assert.equal(response.status, 200);
    assert.equal((await response.json() as any).status, "completed");
    response = await apply({ confirm: true }); assert.equal(response.status, 200);
    assert.equal(f.runs.list().length, 1);
  } finally {
    await module.close?.(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
