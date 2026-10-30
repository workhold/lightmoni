import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context, Dependencies, Handler, Module } from "../shared/types.js";
import { fail, HTTPError } from "../shared/http.js";
import { NodeError, NodeStore, type Task } from "./nodes-model.js";
import type { AgentCredentialStore } from "./agent-credentials.js";
import { assertAgentActive, isAgentRemoved } from "./agent-lifecycle.js";
import { SCRIPT_TASK_CAPABILITY, TASK_LEASE_SECONDS, validateTaskScript,
  type ClaimedTaskRun, type TaskRun, type TaskRunResult, type TaskRunSnapshot } from "../shared/task-center.js";

const terminal = (s: string) => ["succeeded", "failed", "cancelled", "unknown"].includes(s);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid task request");
  return value as Record<string, any>;
};
const text = (v: unknown, name: string, max = 128) => {
  if (typeof v !== "string" || !v || Buffer.byteLength(v) > max || /[\u0000-\u001f]/.test(v)) fail(400, "invalid " + name);
  return v;
};
const fields = (v: Record<string, any>, allowed: string[]) => {
  if (Object.keys(v).some(k => !allowed.includes(k))) fail(400, "unknown task request field");
};
const confirm = (v: Record<string, any>) => { if (v.confirm !== true) fail(400, "task action requires explicit confirmation"); };

/** Finite script jobs deliberately do not share deployment health-verification states. */
export class TaskRunStore {
  readonly nodes: NodeStore;
  /** Rechecks a persisted external grant immediately before a queued run starts. */
  beforeStart?: (run: {id:string;host_id:string;requested_by:string}) => boolean;
  constructor(readonly deps: Dependencies, readonly credentials?: AgentCredentialStore) {
    this.nodes = new NodeStore(deps.db, deps.now);
    deps.db.exec(`CREATE TABLE IF NOT EXISTS task_runs(
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,host_id TEXT NOT NULL,agent_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,state TEXT NOT NULL,trigger TEXT NOT NULL,retry_of TEXT NOT NULL DEFAULT '',
      superseded_by TEXT NOT NULL DEFAULT '',request_id TEXT NOT NULL,requested_by TEXT NOT NULL,
      created_at TEXT NOT NULL,started_at TEXT NOT NULL DEFAULT '',finished_at TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL,lease_hash TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',
      cancel_requested INTEGER NOT NULL DEFAULT 0,code TEXT NOT NULL DEFAULT '',summary TEXT NOT NULL DEFAULT '',
      stdout TEXT NOT NULL DEFAULT '',stderr TEXT NOT NULL DEFAULT '',exit_code INTEGER,
      resolved_at TEXT NOT NULL DEFAULT '',resolved_by TEXT NOT NULL DEFAULT '',resolution_reason TEXT NOT NULL DEFAULT '',
      UNIQUE(task_id,host_id,request_id));
      CREATE INDEX IF NOT EXISTS task_runs_agent_state ON task_runs(agent_id,state,created_at);
      CREATE INDEX IF NOT EXISTS task_runs_host_state ON task_runs(host_id,state);
      CREATE TABLE IF NOT EXISTS task_schedules(task_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,next_due TEXT NOT NULL);`);
    const columns = new Set(deps.db.all<{name:string}>("PRAGMA table_info(task_runs)").map(row => row.name));
    for (const name of ["resolved_at", "resolved_by", "resolution_reason"])
      if (!columns.has(name)) deps.db.exec(`ALTER TABLE task_runs ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  }
  private now() { return this.deps.now().toISOString(); }
  private row(id: string): any {
    const r = this.deps.db.get<any>("SELECT * FROM task_runs WHERE id=?", id);
    if (!r) fail(404, "task run not found");
    return r;
  }
  private view(r: any): TaskRun {
    const snapshot = JSON.parse(r.snapshot_json) as TaskRunSnapshot;
    return { id: r.id, task_id: r.task_id, task_name: snapshot.task_name,
      host_id: r.host_id, host_name: snapshot.host_name, agent_id: r.agent_id,
      state: r.state, trigger: r.trigger, retry_of: r.retry_of, superseded_by: r.superseded_by,
      resolved_at: r.resolved_at, resolved_by: r.resolved_by, resolution_reason: r.resolution_reason,
      requested_by: r.requested_by, created_at: r.created_at, started_at: r.started_at,
      finished_at: r.finished_at, lease_expires_at: r.lease_expires_at,
      cancel_requested: !!r.cancel_requested, code: r.code, summary: r.summary,
      stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code ?? null, snapshot };
  }
  get(id: string) { this.sweep(); return this.view(this.row(id)); }
  list(filters: { task_id?: string; host_id?: string; state?: string; limit?: number } = {}): TaskRun[] {
    this.sweep();
    const clauses: string[] = [], args: any[] = [];
    for (const key of ["task_id", "host_id", "state"] as const) if (filters[key]) {
      if (key === "state" && !["queued", "running", "succeeded", "failed", "cancelled", "unknown"].includes(filters[key]!)) fail(400, "invalid task run state");
      clauses.push(key + "=?"); args.push(text(filters[key], key));
    }
    const limit = filters.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(400, "task run limit must be 1–200");
    return this.deps.db.all<any>("SELECT * FROM task_runs" + (clauses.length ? " WHERE " + clauses.join(" AND ") : "") + " ORDER BY created_at DESC,rowid DESC LIMIT ?", ...args, limit).map(r => this.view(r));
  }
  private host(id: string) {
    const h = this.deps.db.get<{ id: string; name: string; agent_id: string }>("SELECT id,name,agent_id FROM managed_machines WHERE id=?", id);
    if (!h) fail(404, "host not found");
    return h;
  }
  private validBinding(hostID: string, agentID: string): boolean {
    return !isAgentRemoved(this.deps.db, agentID)
      && (!this.credentials || this.credentials.has(agentID, "control"))
      && !!this.deps.db.get("SELECT id FROM managed_machines WHERE id=? AND agent_id=?", hostID, agentID);
  }
  private eligible(taskID: string, hostID: string): Task {
    const task = this.nodes.effectiveHostTasks(hostID).find(t => t.id === taskID);
    if (!task || !task.enabled) fail(409, "task is disabled or no longer targets this host");
    if (task.type !== "script") fail(400, "continuous built-in tasks are reconciled through Agent configuration, not finite script dispatch");
    if (task.status === "upgrade_required") fail(409, "Agent upgrade required for script task execution");
    try { validateTaskScript(task.script); } catch (e) { fail(400, (e as Error).message); }
    return task;
  }
  private active(taskID: string, hostID: string, includeUnknown = true) {
    return this.deps.db.get<any>("SELECT id,state FROM task_runs WHERE task_id=? AND host_id=? AND (state IN ('queued','running')" + (includeUnknown ? " OR (state='unknown' AND superseded_by='' AND resolved_at='')" : "") + ") ORDER BY created_at DESC LIMIT 1", taskID, hostID);
  }
  private insert(task: Task, hostID: string, trigger: "manual" | "schedule" | "retry", actor: string, requestID: string, retryOf = ""): TaskRun {
    const existing = this.deps.db.get<any>("SELECT * FROM task_runs WHERE task_id=? AND host_id=? AND request_id=?", task.id, hostID, requestID);
    if (existing) return this.view(existing);
    const h = this.host(hostID);
    if (!h.agent_id || !this.validBinding(h.id, h.agent_id)) fail(409, "host requires an active enrolled Agent");
    if (this.active(task.id, h.id, trigger !== "retry")) fail(409, "task already queued, running, or unresolved; explicitly retry an unknown run after review");
    validateTaskScript(task.script);
    const snapshot: TaskRunSnapshot = { task_id: task.id, task_name: task.name,
      host_id: h.id, host_name: h.name, agent_id: h.agent_id, script: structuredClone(task.script) };
    const id = randomUUID(), at = this.now();
    this.deps.db.run("INSERT INTO task_runs(id,task_id,host_id,agent_id,snapshot_json,state,trigger,retry_of,request_id,requested_by,created_at,expires_at) VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?)",
      id, task.id, h.id, h.agent_id, JSON.stringify(snapshot), trigger, retryOf, requestID, actor, at,
      new Date(this.deps.now().getTime() + 86400_000).toISOString());
    return this.view(this.row(id));
  }
  dispatch(taskID: string, input: Record<string, any>, actor: string, inTransaction = false): { runs: TaskRun[] } {
    fields(input, ["host_ids", "confirm", "request_id", "expected_task_revision"]); confirm(input); this.sweep();
    if (input.expected_task_revision != null && (typeof input.expected_task_revision !== "string" || !/^[a-f0-9]{64}$/.test(input.expected_task_revision))) fail(400, "invalid reviewed task revision");
    const task = this.nodes.getTask(taskID);
    if (!task.enabled || task.type !== "script") fail(409, "only enabled script tasks can be dispatched");
    const all = this.deps.db.all<{ id: string }>("SELECT id FROM managed_machines ORDER BY id").map(h => h.id);
    const targets = all.filter(id => this.nodes.effectiveHostTasks(id).some(t => t.id === taskID && t.enabled));
    const requested = input.host_ids;
    if (requested != null && (!Array.isArray(requested) || !requested.length || requested.length > 200 || requested.some(x => typeof x !== "string"))) fail(400, "host_ids must contain 1–200 host IDs");
    const selected: string[] = requested == null ? targets : [...new Set(requested)] as string[];
    if (!selected.length) fail(409, "task has no matching hosts");
    if (selected.length > 200) fail(413, "dispatch at most 200 hosts at once");
    if (selected.some(id => !targets.includes(id))) fail(409, "selected host is outside task targets");
    const requestID = input.request_id == null ? randomUUID() : text(input.request_id, "request_id");
    const write = () => {
      if (input.expected_task_revision != null && this.nodes.getTask(taskID).revision !== input.expected_task_revision)
        fail(409, "task changed since review; reload and review the current definition");
      return { runs: selected.map(id => this.insert(this.eligible(taskID, id), id, "manual", actor, requestID)) };
    };
    return inTransaction ? write() : this.deps.db.transaction(write);
  }
  cancel(id: string, actor: string, inTransaction = false): TaskRun {
    this.sweep();
    const write = () => {
      const r = this.row(id);
      if (!terminal(r.state)) {
        if (r.state === "queued") this.deps.db.run("UPDATE task_runs SET state='cancelled',cancel_requested=1,finished_at=?,code='cancelled',summary=? WHERE id=?", this.now(), "Cancelled before Agent claim by " + actor, id);
        else this.deps.db.run("UPDATE task_runs SET cancel_requested=1,summary=? WHERE id=?", "Cancellation requested by " + actor, id);
      }
      return this.view(this.row(id));
    };
    return inTransaction ? write() : this.deps.db.transaction(write);
  }
  retry(id: string, actor: string, inTransaction = false, expectedRevision?: string): TaskRun {
    this.sweep();
    const write = () => {
      const r = this.row(id);
      if (!terminal(r.state)) fail(409, "only terminal task runs can be retried");
      if (r.resolved_at) fail(409, "manually resolved task runs cannot be retried; dispatch a new reviewed task instead");
      if (r.superseded_by) fail(409, "this run already has a retry");
      if (expectedRevision != null && this.nodes.getTask(r.task_id).revision !== expectedRevision)
        fail(409, "task changed since review; reload and review the current definition");
      const task = this.eligible(r.task_id, r.host_id);
      // Retry is a fresh explicit dispatch of the CURRENT task definition.
      const run = this.insert(task, r.host_id, "retry", actor, randomUUID(), id);
      this.deps.db.run("UPDATE task_runs SET superseded_by=? WHERE id=?", run.id, id);
      return run;
    };
    return inTransaction ? write() : this.deps.db.transaction(write);
  }
  resolve(id: string, actor: string, reason: unknown, inTransaction = false): TaskRun {
    if (typeof reason !== "string" || !reason.trim() || Buffer.byteLength(reason.trim()) > 512 || reason.includes("\0"))
      fail(400, "manual resolution requires a reason of 1–512 bytes");
    this.sweep();
    const write = () => {
      const r = this.row(id);
      if (r.state !== "unknown") fail(409, "only an unknown task run can be manually resolved");
      if (r.superseded_by) fail(409, "task run was already superseded by an explicit retry");
      if (r.resolved_at) return this.view(r);
      this.deps.db.run("UPDATE task_runs SET resolved_at=?,resolved_by=?,resolution_reason=? WHERE id=? AND state='unknown' AND resolved_at='' AND superseded_by=''",
        this.now(), actor, reason.trim(), id);
      return this.view(this.row(id));
    };
    return inTransaction ? write() : this.deps.db.transaction(write);
  }
  sweep() {
    const now = this.now();
    this.deps.db.run("UPDATE task_runs SET state='unknown',finished_at=?,code='lease_expired',summary='Agent lease expired; execution outcome requires review' WHERE state='running' AND lease_expires_at<=?", now, now);
    this.deps.db.run("UPDATE task_runs SET state='cancelled',finished_at=?,code='queue_expired',summary='Task expired before Agent claim' WHERE state='queued' AND expires_at<=?", now, now);
    this.deps.db.run("UPDATE task_runs SET state='cancelled',finished_at=?,code='agent_binding_changed',summary='Host Agent binding changed before claim' WHERE state='queued' AND (NOT EXISTS (SELECT 1 FROM managed_machines m WHERE m.id=task_runs.host_id AND m.agent_id=task_runs.agent_id) OR EXISTS (SELECT 1 FROM agent_lifecycle l WHERE l.agent_id=task_runs.agent_id AND l.state='removed'))", now);
  }
  claim(agentID: string, capabilities: string[]): ClaimedTaskRun | null {
    this.sweep(); assertAgentActive(this.deps.db, agentID, 401);
    if (!Array.isArray(capabilities) || capabilities.length > 32 || capabilities.some(x => typeof x !== "string")) fail(400, "invalid task capabilities");
    if (!capabilities.includes(SCRIPT_TASK_CAPABILITY)) return null;
    return this.deps.db.transaction(() => {
      if (this.deps.db.get("SELECT id FROM task_runs WHERE agent_id=? AND state='running'", agentID)) return null;
      const pending = this.deps.db.all<any>("SELECT * FROM task_runs WHERE agent_id=? AND state='queued' ORDER BY created_at,rowid LIMIT 200", agentID);
      for (const r of pending) {
        const external = this.deps.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capability_run_authorizations'")
          && this.deps.db.get("SELECT 1 FROM capability_run_authorizations WHERE run_id=?", r.id);
        if (external && (!this.beforeStart || !this.beforeStart(r))) {
          this.deps.db.run("UPDATE task_runs SET state='cancelled',finished_at=?,code='authorization_revoked',summary='External authorization is no longer valid before Agent claim' WHERE id=? AND state='queued'", this.now(), r.id);
          continue;
        }
        try { this.eligible(r.task_id, r.host_id); } catch (error) {
          if (!(error instanceof NodeError || error instanceof HTTPError)) throw error;
          this.deps.db.run("UPDATE task_runs SET state='cancelled',finished_at=?,code='task_no_longer_eligible',summary='Task disabled, removed, or target changed before claim' WHERE id=?", this.now(), r.id);
          continue;
        }
        if (!this.validBinding(r.host_id, agentID)) continue;
        const secret = randomBytes(32).toString("hex");
        const expires = new Date(this.deps.now().getTime() + TASK_LEASE_SECONDS * 1000).toISOString();
        this.deps.db.run("UPDATE task_runs SET state='running',started_at=?,lease_hash=?,lease_expires_at=? WHERE id=? AND state='queued'", this.now(), sha(secret), expires, r.id);
        return { ...this.view(this.row(r.id)), lease_token: secret };
      }
      return null;
    });
  }
  private leased(agentID: string, id: string, secret: unknown): any {
    this.sweep(); assertAgentActive(this.deps.db, agentID, 401);
    const r = this.row(id);
    if (r.agent_id !== agentID) fail(403, "task run belongs to another Agent");
    if (!this.validBinding(r.host_id, agentID)) fail(409, "host Agent binding changed");
    if (r.resolved_at) fail(409, "task run was manually resolved; late Agent receipts are rejected");
    if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret) || !r.lease_hash
      || !timingSafeEqual(Buffer.from(sha(secret)), Buffer.from(r.lease_hash))) fail(403, "invalid task run lease");
    if (r.code === "lease_expired" || r.state === "queued") fail(409, "task run lease expired");
    return r;
  }
  heartbeat(agentID: string, id: string, input: Record<string, any>) {
    fields(input, ["lease_token"]);
    return this.deps.db.transaction(() => {
      const r = this.leased(agentID, id, input.lease_token);
      if (r.state !== "running") return { state: r.state, cancel_requested: !!r.cancel_requested, lease_expires_at: r.lease_expires_at };
      let cancelled = !!r.cancel_requested;
      try { this.eligible(r.task_id, r.host_id); } catch (error) {
        if (!(error instanceof NodeError || error instanceof HTTPError)) throw error;
        cancelled = true;
      }
      const expires = new Date(this.deps.now().getTime() + TASK_LEASE_SECONDS * 1000).toISOString();
      this.deps.db.run("UPDATE task_runs SET cancel_requested=?,lease_expires_at=? WHERE id=?", cancelled, expires, id);
      return { state: "running", cancel_requested: cancelled, lease_expires_at: expires };
    });
  }
  result(agentID: string, id: string, input: Record<string, any>): TaskRun {
    fields(input, ["lease_token", "state", "code", "summary", "stdout", "stderr", "exit_code"]);
    return this.deps.db.transaction(() => {
      const r = this.leased(agentID, id, input.lease_token);
      if (terminal(r.state)) return this.view(r);
      const s = JSON.parse(r.snapshot_json).script;
      const value = input as TaskRunResult;
      if (!["succeeded", "failed", "cancelled", "unknown"].includes(value.state)
        || typeof value.code !== "string" || Buffer.byteLength(value.code) > 128
        || typeof value.summary !== "string" || Buffer.byteLength(value.summary) > 1024
        || typeof value.stdout !== "string" || typeof value.stderr !== "string"
        || Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > s.max_output_bytes
        || !(value.exit_code == null || Number.isInteger(value.exit_code) && Math.abs(value.exit_code) <= 255)
        || value.state === "succeeded" && value.exit_code !== 0) fail(400, "invalid or oversized task run result");
      if (value.state === "cancelled" && !r.cancel_requested) fail(409, "cancellation was not requested");
      this.deps.db.run("UPDATE task_runs SET state=?,finished_at=?,code=?,summary=?,stdout=?,stderr=?,exit_code=? WHERE id=? AND state='running'",
        value.state, this.now(), value.code, value.summary, value.stdout, value.stderr, value.exit_code, id);
      return this.view(this.row(id));
    });
  }
  tick() {
    this.sweep();
    for (const candidate of this.nodes.tasks().filter(t => t.type === "script" && t.schedule.mode === "interval")) {
      this.deps.db.transaction(() => {
        // Another centre writer can edit a definition after the outer scan.
        // Re-read under the writer lock before deciding whether it is due.
        const t = this.nodes.getTask(candidate.id);
        if (t.type !== "script" || t.schedule.mode !== "interval") return;
        const seconds = t.schedule.interval_seconds!;
        if (!Number.isInteger(seconds) || seconds < 10 || seconds > 2_592_000) return;
        const fingerprint = sha(JSON.stringify(t));
        const at = this.deps.now(), next = new Date(at.getTime() + seconds * 1000).toISOString();
        const old = this.deps.db.get<any>("SELECT * FROM task_schedules WHERE task_id=?", t.id);
        if (!t.enabled || !old || old.fingerprint !== fingerprint) {
          this.deps.db.run("INSERT INTO task_schedules(task_id,fingerprint,next_due) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET fingerprint=excluded.fingerprint,next_due=excluded.next_due", t.id, fingerprint, next);
          return;
        }
        if (old.next_due > at.toISOString()) return;
        // Move directly to the next future slot, never replay missed periods.
        this.deps.db.run("UPDATE task_schedules SET next_due=? WHERE task_id=?", next, t.id);
        const hosts = this.deps.db.all<{ id: string; agent_id: string }>("SELECT id,agent_id FROM managed_machines WHERE agent_id<>'' ORDER BY id");
        for (const h of hosts) {
          if (!this.validBinding(h.id, h.agent_id) || this.active(t.id, h.id)) continue;
          const effective = this.nodes.effectiveHostTasks(h.id).find(v => v.id === t.id && v.enabled && v.status !== "upgrade_required");
          if (effective) this.insert(effective, h.id, "schedule", "scheduler", "schedule:" + old.next_due);
        }
      });
    }
  }
}

export function registerTaskCenter(deps: Dependencies, options: { agentCredentials?: AgentCredentialStore; sweepIntervalMs?: number } = {}): Module & TaskRunStore {
  const store = new TaskRunStore(deps, options.agentCredentials);
  const safe = (fn: Handler): Handler => async ctx => {
    try { await fn(ctx); } catch (error) {
      if (error instanceof HTTPError || error instanceof NodeError) ctx.json({ error: error.message }, error.status);
      else { deps.logger.error("task center request failed", error); ctx.json({ error: "task center unavailable" }, 500); }
    }
  };
  const admin = (ctx: Context) => { if (ctx.user.role !== "admin") fail(403, "administrator required"); deps.auth.requireAdmin(ctx); };
  const input = async (ctx: Context) => object(await ctx.body());
  const auth = (ctx: Context) => {
    if (!options.agentCredentials) fail(401, "Agent control credentials unavailable");
    options.agentCredentials.authenticate(ctx.req, ctx.params.id, "control");
    assertAgentActive(deps.db, ctx.params.id, 401);
  };
  deps.router.get("/api/v1/task-runs", safe(ctx => {
    const q = ctx.url.searchParams;
    ctx.json(store.list({ task_id: q.get("task_id") ?? undefined, host_id: q.get("host_id") ?? undefined,
      state: q.get("state") ?? undefined, limit: q.has("limit") ? Number(q.get("limit")) : undefined }).map(run => ({
        ...run, stdout: "", stderr: "", details_omitted: true,
        snapshot: { ...run.snapshot, script: { ...run.snapshot.script, code: "" } },
      })));
  }));
  deps.router.get("/api/v1/task-runs/:id", safe(ctx => ctx.json(store.get(ctx.params.id))));
  deps.router.post("/api/v1/agent-tasks/:id/dispatch", safe(async ctx => { admin(ctx); const v = await input(ctx);
    if (typeof v.expected_task_revision !== "string" || !/^[a-f0-9]{64}$/.test(v.expected_task_revision)) fail(400, "reviewed task revision required");
    ctx.json(store.dispatch(ctx.params.id, v, ctx.user.id), 201); }));
  deps.router.post("/api/v1/task-runs/:id/cancel", safe(async ctx => { admin(ctx); const v = await input(ctx); fields(v, ["confirm"]); confirm(v); ctx.json(store.cancel(ctx.params.id, ctx.user.id)); }));
  deps.router.post("/api/v1/task-runs/:id/retry", safe(async ctx => { admin(ctx); const v = await input(ctx); fields(v, ["confirm", "expected_task_revision"]); confirm(v);
    if (typeof v.expected_task_revision !== "string" || !/^[a-f0-9]{64}$/.test(v.expected_task_revision)) fail(400, "reviewed task revision required");
    ctx.json(store.retry(ctx.params.id, ctx.user.id, false, v.expected_task_revision), 201); }));
  deps.router.post("/api/v1/task-runs/:id/resolve", safe(async ctx => { admin(ctx); const v = await input(ctx); fields(v, ["confirm", "reason"]); confirm(v);
    ctx.json(store.resolve(ctx.params.id, ctx.user.id, v.reason)); }));
  deps.router.post("/api/v1/agents/:id/task-runs/claim", safe(async ctx => { auth(ctx); const v = await input(ctx); fields(v, ["capabilities"]); ctx.json({ run: store.claim(ctx.params.id, v.capabilities) }); }), { public: true });
  deps.router.post("/api/v1/agents/:id/task-runs/:runId/heartbeat", safe(async ctx => { auth(ctx); ctx.json(store.heartbeat(ctx.params.id, ctx.params.runId, await input(ctx))); }), { public: true });
  deps.router.post("/api/v1/agents/:id/task-runs/:runId/result", safe(async ctx => { auth(ctx); ctx.json(store.result(ctx.params.id, ctx.params.runId, await input(ctx))); }), { public: true });
  let timer: NodeJS.Timeout | undefined;
  return Object.assign(store, {
    start() {
      if (timer) return;
      const tick = () => { try { store.tick(); } catch (error) { deps.logger.warn("task schedule scan failed", error); } };
      tick(); timer = setInterval(tick, Math.max(10, options.sweepIntervalMs ?? 5000)); timer.unref?.();
    },
    close() { if (timer) clearInterval(timer); timer = undefined; },
  });
}
