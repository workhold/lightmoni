import { id } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import type { Dependencies, Handler, Module } from "../shared/types.js";
import type { OperationsStore } from "../operations/types.js";

const ALLOWED: Record<string, readonly string[]> = { backup: ["create", "verify", "prune"], certificate: ["renew"], website: ["inspect"], compose: ["inspect"] };
const ACTIVE = new Set(["awaiting_approval", "queued", "leased", "accepted", "preflighting", "staging", "activating", "verifying"]);
function field(value: string, min: number, max: number): Set<number> {
  const set = new Set<number>();
  for (const part of value.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part); if (!match) fail(400, "invalid cron expression");
    const step = match[2] == null ? 1 : Number(match[2]); if (step < 1 || step > max - min + 1) fail(400, "invalid cron step");
    let from: number, to: number;
    if (match[1] === "*") { from = min; to = max; } else { const range = match[1].split("-").map(Number); from = range[0]; to = range[1] ?? (match[2] ? max : from); }
    if (from < min || to > max || from > to) fail(400, "invalid cron range");
    for (let n = from; n <= to; n += step) set.add(n);
  }
  return set;
}
function parsed(cron: string) {
  const parts = cron.trim().split(/\s+/); if (parts.length !== 5) fail(400, "cron requires five fields");
  return { parts, fields: parts.map((p, i) => field(p, [0, 0, 1, 1, 0][i], [59, 23, 31, 12, 7][i])) };
}
function zone(timezone: string) { if (typeof timezone !== "string" || timezone.length > 128) fail(400, "invalid timezone"); try { return new Intl.DateTimeFormat("en-US", { timeZone: timezone, minute: "numeric", hour: "numeric", hourCycle: "h23", day: "numeric", month: "numeric", weekday: "short" }); } catch { return fail(400, "invalid IANA timezone"); } }
export function validateCron(cron: string, timezone: string) { if (typeof cron !== "string" || cron.length > 256) fail(400, "invalid cron expression"); parsed(cron); zone(timezone); return { cron: cron.trim().replace(/\s+/g, " "), timezone }; }
export function cronMatches(cron: string, timezone: string, at: Date) {
  const { fields: f, parts } = parsed(cron), p = Object.fromEntries(zone(timezone).formatToParts(at).map(v => [v.type, v.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), dom = f[2].has(Number(p.day)), dow = f[4].has(weekday) || (weekday === 0 && f[4].has(7));
  const day = parts[2] === "*" ? dow : parts[4] === "*" ? dom : dom || dow;
  return f[0].has(Number(p.minute)) && f[1].has(Number(p.hour)) && day && f[3].has(Number(p.month));
}
export function registerOperationSchedules(deps: Dependencies, ops: OperationsStore): Module & {
  create(v: any, actor: string): any; update(id: string, v: any, actor: string): any;
  get(id: string): any; list(): any[]; fires(id: string): any[]; tick(): void;
} {
  const { db, router } = deps;
  db.exec("CREATE TABLE IF NOT EXISTS ops_schedules(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision INTEGER NOT NULL,resource_id TEXT NOT NULL,resource_revision INTEGER NOT NULL,operation TEXT NOT NULL,input_json TEXT NOT NULL,cron TEXT NOT NULL,timezone TEXT NOT NULL,enabled INTEGER NOT NULL,disabled_reason TEXT NOT NULL DEFAULT '',authorized_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ops_schedule_fires(schedule_id TEXT NOT NULL,slot TEXT NOT NULL,run_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL,schedule_revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,PRIMARY KEY(schedule_id,slot));CREATE INDEX IF NOT EXISTS ops_schedule_fires_run ON ops_schedule_fires(schedule_id,created_at);");
  let timer: ReturnType<typeof setInterval> | undefined, lastMinute = Math.floor(deps.now().getTime() / 60000);
  const row = (scheduleID: string) => { const r = db.get<any>("SELECT * FROM ops_schedules WHERE id=?", scheduleID); if (!r) fail(404, "operation schedule not found"); return r; };
  const view = (r: any) => ({ id: r.id, name: r.name, revision: r.revision, resource_id: r.resource_id, resource_revision: r.resource_revision, operation: r.operation, input: JSON.parse(deps.decrypt(r.input_json)), cron: r.cron, timezone: r.timezone, enabled: !!r.enabled, disabled_reason: r.disabled_reason, authorized_by: r.authorized_by, created_at: r.created_at, updated_at: r.updated_at });
  const get = (scheduleID: string) => view(row(scheduleID));
  const list = () => db.all<any>("SELECT * FROM ops_schedules ORDER BY created_at DESC").map(view);
  const fires = (scheduleID: string) => { row(scheduleID); return db.all<any>("SELECT * FROM ops_schedule_fires WHERE schedule_id=? ORDER BY created_at DESC,slot DESC LIMIT 100", scheduleID).map(r => { if (r.run_id) { try { r.state = ops.getRun(r.run_id).state; } catch { r.state = "unknown"; } } return r; }); };
  function validate(v: any) {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(400, "invalid schedule");
    if (typeof v.resource_id !== "string" || v.resource_id.length > 128) fail(400, "invalid schedule resource_id");
    const resource = ops.get(v.resource_id); if (!resource) fail(404, "operation resource not found");
    if (!Number.isSafeInteger(v.resource_revision) || resource.revision !== v.resource_revision) fail(409, "resource revision changed");
    if (!ALLOWED[resource.kind]?.includes(v.operation)) fail(400, "operation is not allowed for scheduled execution");
    const input = ops.validateOperation(v.resource_id, v.operation, v.input ?? {});
    if (Buffer.byteLength(JSON.stringify(input)) > (16 << 10)) fail(400, "schedule input too large");
    if (v.enabled != null && typeof v.enabled !== "boolean") fail(400, "invalid schedule enabled");
    const name = v.name ?? resource.name ?? v.resource_id; if (typeof name !== "string" || !name.trim() || name.length > 128) fail(400, "invalid schedule name");
    return { resource, input, name: name.trim(), ...validateCron(v.cron, v.timezone) };
  }
  const disable = (scheduleID: string, reason: string) => db.run("UPDATE ops_schedules SET enabled=0,disabled_reason=?,updated_at=? WHERE id=?", reason, deps.now().toISOString(), scheduleID);
  const create = (v: any, actor: string) => {
    const checked = validate(v), scheduleID = id(), now = deps.now().toISOString();
    db.run("INSERT INTO ops_schedules(id,name,revision,resource_id,resource_revision,operation,input_json,cron,timezone,enabled,authorized_by,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?)", scheduleID, checked.name, v.resource_id, v.resource_revision, v.operation, deps.encrypt(JSON.stringify(checked.input)), checked.cron, checked.timezone, !!v.enabled, actor, now, now);
    return get(scheduleID);
  };
  const update = (scheduleID: string, v: any, actor: string) => {
    const old = row(scheduleID); if (v.revision !== old.revision) fail(409, "schedule revision changed");
    const combined = { ...view(old), ...v }, checked = validate(combined);
    db.run("UPDATE ops_schedules SET name=?,revision=revision+1,resource_id=?,resource_revision=?,operation=?,input_json=?,cron=?,timezone=?,enabled=?,disabled_reason='',authorized_by=?,updated_at=? WHERE id=? AND revision=?", checked.name, combined.resource_id, combined.resource_revision, combined.operation, deps.encrypt(JSON.stringify(checked.input)), checked.cron, checked.timezone, combined.enabled, actor, deps.now().toISOString(), scheduleID, old.revision);
    return get(scheduleID);
  };
  function fire(r: any, slot: string, actor: string) {
    const existing = db.get<any>("SELECT * FROM ops_schedule_fires WHERE schedule_id=? AND slot=?", r.id, slot); if (existing) return existing;
    const authority = db.get<any>("SELECT active,role FROM users WHERE id=?", r.authorized_by);
    if (!authority?.active || authority.role !== "admin") { disable(r.id, "authorizer_unavailable"); return null; }
    const resource = ops.get(r.resource_id); if (!resource || resource.revision !== r.resource_revision) { disable(r.id, "resource_changed"); return null; }
    let busy = false;
    for (const previous of db.all<any>("SELECT * FROM ops_schedule_fires WHERE schedule_id=? AND (state='dispatching' OR run_id<>'') ORDER BY created_at DESC", r.id)) {
      let state = previous.state; if (previous.run_id) { try { state = ops.getRun(previous.run_id).state; } catch { state = "unknown"; } }
      if ((state === "unknown" || state === "dispatching") && previous.schedule_revision === r.revision) { disable(r.id, "unknown_result"); return null; }
      if (ACTIVE.has(state)) busy = true;
    }
    const inserted = db.run("INSERT OR IGNORE INTO ops_schedule_fires(schedule_id,slot,state,schedule_revision,created_at) VALUES(?,?,?,?,?)", r.id, slot, busy ? "skipped_busy" : "dispatching", r.revision, deps.now().toISOString()); if (!inserted.changes) return null;
    if (busy) return { state: "skipped_busy" };
    let runID = "";
    try {
      const run = ops.plan(r.resource_id, r.operation, JSON.parse(deps.decrypt(r.input_json)), actor); runID = run.id;
      db.run("UPDATE ops_schedule_fires SET run_id=? WHERE schedule_id=? AND slot=?", runID, r.id, slot);
      const approved = ops.approve(runID, actor, r.resource_revision);
      db.run("UPDATE ops_schedule_fires SET state=? WHERE schedule_id=? AND slot=?", approved.state, r.id, slot);
      return { schedule_id: r.id, slot, run_id: runID, state: approved.state };
    } catch {
      // A dispatch can fail after the job transaction commits: freeze rather than replay.
      const state = runID ? "unknown" : "failed"; db.run("UPDATE ops_schedule_fires SET state=? WHERE schedule_id=? AND slot=?", state, r.id, slot); disable(r.id, runID ? "unknown_result" : "dispatch_failed"); return { state, run_id: runID };
    }
  }
  const tick = () => {
    const now = deps.now(), minute = Math.floor(now.getTime() / 60000); if (minute <= lastMinute) return; lastMinute = minute;
    const slot = new Date(minute * 60000).toISOString();
    for (const r of db.all<any>("SELECT * FROM ops_schedules WHERE enabled=1")) {
      try { const authority = db.get<any>("SELECT active,role FROM users WHERE id=?", r.authorized_by); if (!authority?.active || authority.role !== "admin") { disable(r.id, "authorizer_unavailable"); continue; } const resource = ops.get(r.resource_id); if (!resource || resource.revision !== r.resource_revision) { disable(r.id, "resource_changed"); continue; } if (cronMatches(r.cron, r.timezone, new Date(minute * 60000))) fire(r, slot, "schedule:" + r.authorized_by); }
      catch { disable(r.id, "resource_unavailable"); }
    }
  };
  const safe = (handler: Handler): Handler => async ctx => { deps.auth.requireAdmin(ctx); try { await handler(ctx); } catch (e) { if (e instanceof HTTPError) ctx.json({ error: e.message }, e.status); else ctx.json({ error: "operation schedule request failed" }, 500); } };
  router.get("/api/v1/operation-schedules", safe(ctx => ctx.json({ schedules: list() })));
  router.post("/api/v1/operation-schedules", safe(async ctx => ctx.json({ schedule: create(await ctx.body(), ctx.user.id) }, 201)));
  router.get("/api/v1/operation-schedules/:id", safe(ctx => ctx.json({ schedule: get(ctx.params.id), fires: fires(ctx.params.id) })));
  router.put("/api/v1/operation-schedules/:id", safe(async ctx => ctx.json({ schedule: update(ctx.params.id, await ctx.body(), ctx.user.id) })));
  router.delete("/api/v1/operation-schedules/:id", safe(async ctx => { const r = row(ctx.params.id), v = await ctx.body(); if (v.revision !== r.revision) fail(409, "schedule revision changed"); if (fires(r.id).some(f => ACTIVE.has(f.state))) fail(409, "schedule has an active run"); db.transaction(() => { db.run("DELETE FROM ops_schedule_fires WHERE schedule_id=?", r.id); db.run("DELETE FROM ops_schedules WHERE id=?", r.id); }); ctx.json({ ok: true }); }));
  router.post("/api/v1/operation-schedules/:id/run", safe(async ctx => { const r = row(ctx.params.id), v = await ctx.body(); if (v.revision !== r.revision) fail(409, "schedule revision changed"); if (r.disabled_reason === "unknown_result") fail(409, "unknown result requires explicit schedule reauthorization"); const result = fire(r, "manual:" + id(), ctx.user.id); if (!result) fail(409, "schedule authorization is no longer valid"); ctx.json({ fire: result }, 202); }));
  return { get, list, fires, create, update, tick,
    start() {
      if (timer) return;
      for (const r of db.all<any>("SELECT schedule_id FROM ops_schedule_fires WHERE state='dispatching'")) { disable(r.schedule_id, "unknown_result"); }
      db.run("UPDATE ops_schedule_fires SET state='unknown' WHERE state='dispatching'");
      lastMinute = Math.floor(deps.now().getTime() / 60000); timer = setInterval(tick, 5000); timer.unref();
    }, close() { if (timer) clearInterval(timer); timer = undefined; },
  };
}
