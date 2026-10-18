import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { parseJSON, stringifyJSON } from "../src/shared/json.js";
import type { Dependencies, Table } from "../src/shared/types.js";
import { Alerts } from "../src/domains/alerts.js";
import { AlertCapabilities, AlertCapabilityError, alertVersion } from "../src/domains/alert-capabilities.js";
import { responseActiveSeconds, silenceActive } from "../src/domains/alert-policy.js";
import { encode } from "../src/domains/common.js";

const admin = { id: "a", role: "admin" }, member = { id: "m", role: "member" }, outsider = { id: "o", role: "member" };
const ruleInput = () => ({ name: "Errors", kind: "sql", enabled: true,
  sql: "SELECT count() AS value FROM log_app WHERE $__timeFilter(event_time)",
  source_table_ids: ["log_app"], group_ids: [], services: ["api"], label_fields: [],
  value_field: "value", threshold: "1", operator: "gt", interval_seconds: 10,
  window_seconds: 60, for_count: 1, for_seconds: 0, severity: "P2" });
async function fixture() {
  const db = new DB(":memory:"), errors: unknown[] = [], router = new Router((e) => errors.push(e));
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,active INTEGER,role TEXT); INSERT INTO users VALUES('a','Admin',1,'admin'),('m','Member',1,'member'),('o','Other',1,'member');");
  let now = new Date("2026-10-18T08:00:00Z");
  const tables: Table[] = [{ id: "log_app", name: "log_app", logical_name: "app", kind: "log",
    columns: [{ name: "event_time", type: "DateTime64(9)" }], services: ["api"], system: false,
    retention_days: null, effective_retention_days: 7 }];
  const deps: Dependencies = {
    db, router, cat: { list: async () => tables }, ch: {} as any, reader: {} as any,
    query: async () => ({ request_id: "q", results: [] }), referencedTables: async (sql) => tables.filter((t) => sql.includes(t.name)).map((t) => t.name),
    auth: { master: Buffer.alloc(32), user: (req) => ({ ...(req.headers["x-user"] === "m" ? member : req.headers["x-user"] === "o" ? outsider : admin), name: "User" }),
      requireAdmin: (c) => { if (c.user.role !== "admin") c.error(403, "admin required"); }, validateKey: () => { throw Error("unused"); } },
    externalURL: "http://localhost", encrypt: (x) => x, decrypt: (x) => x, now: () => now,
    logger: { info() {}, warn() {}, error() {} },
  };
  router.auth = deps.auth;
  const alerts = new Alerts(deps), cap = new AlertCapabilities(alerts);
  for (const [key, members] of [["g", ["m"]], ["h", ["o"]]] as const)
    db.run("INSERT INTO alert_groups VALUES(?,?,?)", key, key, encode({ id: key, name: key, enabled: true, members, policies: {}, targets: [] }));
  const server = createServer((req, res) => { void router.handle(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  const request = async (path: string, method = "GET", body?: any, user = "a") => {
    const response = await fetch(url + path, { method, headers: { "Content-Type": "application/json", "x-user": user },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : stringifyJSON(body) }) });
    return { status: response.status, body: parseJSON<any>(await response.text()) };
  };
  const createRule = async () => {
    const save = await cap.prepareRuleSave(admin, ruleInput());
    return db.transaction(() => cap.commitRuleSave(admin, save));
  };
  const createSilence = async (actor = admin, input: any = {}) => {
    const change = await cap.prepare(actor, "silence.create", { silence: { scope: "group", group_id: "g", from: "2026-10-18T08:00:00Z", until: "2026-10-18T09:00:00Z", reason: "Maintenance", ...input } });
    return db.transaction(() => cap.commit(actor, change));
  };
  return { db, alerts, cap, request, tables, errors, createRule, createSilence,
    setNow: (value: Date) => { now = value; },
    close: async () => { await alerts.close(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); db.close(); } };
}
const status = (n: number) => (e: any) => e instanceof AlertCapabilityError && e.status === n;

test("shared rule prepare is read-only; commit preserves state and queue effects and rejects stale versions", async () => {
  const f = await fixture();
  try {
    const r = await f.createRule();
    f.db.run("INSERT INTO alert_states VALUES(?,?,?)", r.id, "fp", encode({ rule_id: r.id, fingerprint: "fp", status: "pending", health: "ok", consecutive_failures: 2 }));
    f.db.run("INSERT INTO alert_events VALUES(?,?,?,?)", "e", r.id, "2026-10-18T08:00:00Z", "{}");
    f.db.run("INSERT INTO alert_outbox VALUES(?,?,?,?,?,?,?,?)", "q", "e", "c", "t", "queued", "", "", "{}");
    const change = await f.cap.prepare(member, "rule.update", { id: r.id, revision: r.revision, patch: { threshold: "3" } });
    assert.equal(f.cap.getRule(admin, r.id).threshold, "1");
    assert.equal(f.db.get<any>("SELECT status FROM alert_outbox WHERE id='q'")!.status, "queued");
    const saved = f.db.transaction(() => f.cap.commit(member, change));
    assert.equal(saved.threshold, "3");
    assert.equal(saved.revision, 2);
    assert.equal(f.db.all("SELECT * FROM alert_states").length, 0);
    assert.equal(f.db.get<any>("SELECT status FROM alert_outbox WHERE id='q'")!.status, "cancelled");
    assert.throws(() => f.db.transaction(() => f.cap.commit(member, change)), status(409));
    await assert.rejects(f.cap.prepare(admin, "rule.update", { id: r.id, revision: 1, patch: { enabled: false } }), status(409));
  } finally { await f.close(); }
});

test("HTTP rule create/save and rule silence delegate to shared capabilities and retain old forms", async () => {
  const f = await fixture();
  try {
    const made = await f.request("/api/v1/alerts/rules", "POST", ruleInput(), "m");
    assert.equal(made.status, 200);
    assert.ok(made.body.version);
    const key = made.body.id;
    assert.equal((await f.request("/api/v1/alerts/rules/" + key)).body.id, key);
    const saved = await f.request("/api/v1/alerts/rules/" + key, "PUT", { ...made.body, name: "Updated" });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 2);
    const silenced = await f.request("/api/v1/alerts/rules/" + key + "/silence", "POST", { until: "2026-10-18T09:00:00Z" });
    assert.equal(silenced.status, 200);
    assert.equal(silenced.body.revision, 3);
    assert.equal((await f.request("/api/v1/alerts/rules/" + key + "/silence", "POST", { revision: 2, until: "" })).status, 409);
    assert.equal((await f.request("/api/v1/alerts/rules/missing")).status, 404);
    assert.equal(f.errors.length, 0);
  } finally { await f.close(); }
});

test("silence scope permissions reject creator escalation and recheck membership at commit", async () => {
  const f = await fixture();
  try {
    const s = await f.createSilence(member);
    const create = { silence: { scope: "all", from: s.from, until: s.until } };
    await assert.rejects(f.cap.prepare(member, "silence.create", create), status(403));
    for (const patch of [{ scope: "all" }, { group_id: "h" }])
      await assert.rejects(f.cap.prepare(member, "silence.update", { id: s.id, version: s.version, patch }), status(403));
    await assert.rejects(f.cap.prepare(outsider, "silence.end", { id: s.id, version: s.version }), status(403));
    const byAdmin = await f.createSilence(admin);
    const pending = await f.cap.prepare(member, "silence.update", { id: byAdmin.id, version: byAdmin.version, patch: { reason: "Change" } });
    const ownPending = await f.cap.prepare(member, "silence.update", { id: s.id, version: s.version, patch: { until: "2026-10-18T10:00:00Z" } });
    f.db.run("UPDATE alert_groups SET body=? WHERE id='g'", encode({ id: "g", name: "g", members: [], policies: {}, targets: [] }));
    assert.throws(() => f.cap.commit(member, pending), status(403));
    assert.throws(() => f.cap.commit(member, ownPending), status(403));
    await assert.rejects(f.cap.revalidate(member, parseJSON(encode(ownPending))), status(403));
    for (const patch of [{ until: "2026-10-18T10:00:00Z" }, { priorities: [] }, { reason: "Change own window" }])
      await assert.rejects(f.cap.prepare(member, "silence.update", { id: s.id, version: s.version, patch }), status(403));
    const endOwn = await f.cap.prepare(member, "silence.end", { id: s.id, version: s.version });
    const ended = f.db.transaction(() => f.cap.commit(member, endOwn));
    assert.ok(ended.ended_at);
    const global = await f.createSilence(admin, { scope: "all" });
    const demoted = { ...admin, role: "member" };
    await assert.rejects(f.cap.prepare(demoted, "silence.update", { id: global.id, version: global.version, patch: { until: "2026-10-18T10:00:00Z" } }), status(403));
    const endGlobal = await f.cap.prepare(demoted, "silence.end", { id: global.id, version: global.version });
    assert.ok(f.db.transaction(() => f.cap.commit(demoted, endGlobal)).ended_at);
    const groups = f.cap.listGroups(admin);
    assert.deepEqual(Object.keys(groups[0]).sort(), ["enabled", "id", "name"]);
  } finally { await f.close(); }
});

test("legacy silence fingerprints detect updates without revision and derived transport version is ignored", async () => {
  const f = await fixture();
  try {
    const old = { id: "legacy", scope: "all", from: "2026-10-18T08:00:00Z", until: "2026-10-18T09:00:00Z", timezone: "UTC", reason: "Old", created_by: "a" };
    f.db.run("INSERT INTO alert_silences VALUES(?,?)", old.id, encode(old));
    const read = f.cap.getSilence(admin, old.id);
    assert.equal(read.version, alertVersion({ ...old, version: "ignored" }));
    assert.equal((await f.request("/api/v1/alerts/silences/legacy", "PUT", { patch: { reason: "No version" } })).status, 400);
    assert.equal(f.cap.getSilence(admin, old.id).reason, "Old");
    const pending = await f.cap.prepare(admin, "silence.end", { id: old.id, version: read.version });
    f.db.run("UPDATE alert_silences SET body=? WHERE id=?", encode({ ...old, reason: "Direct change" }), old.id);
    assert.throws(() => f.cap.commit(admin, pending), status(409));
    const saved = await f.request("/api/v1/alerts/silences/legacy", "PUT", { version: f.cap.getSilence(admin, old.id).version, patch: { reason: "Updated" } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 1);
    assert.equal((await f.request("/api/v1/alerts/silences/legacy", "PUT", { version: read.version, patch: { reason: "Stale" } })).status, 409);
    assert.equal((await f.request("/api/v1/alerts/silences/legacy", "PUT", { revision: saved.body.revision, patch: { reason: "Explicit revision" } })).status, 200);
  } finally { await f.close(); }
});

test("future and recurring silences really end immediately, including before their start", async () => {
  const f = await fixture();
  try {
    for (const input of [
      { from: "2026-10-19T08:00:00Z", until: "2026-10-19T09:00:00Z" },
      { from: "2026-10-19T08:00:00Z", until: "", daily_start: "09:00", daily_end: "18:00", timezone: "UTC" },
    ]) {
      const s = await f.createSilence(admin, input);
      const ended = await f.cap.prepare(admin, "silence.end", { id: s.id, version: s.version });
      f.setNow(new Date("2026-10-18T08:05:00Z"));
      const saved = f.db.transaction(() => f.cap.commit(admin, ended));
      assert.ok(saved.ended_at);
      assert.equal(Date.parse(saved.until), Date.parse("2026-10-18T08:05:00Z"));
      assert.equal(saved.ended_at, saved.until);
      assert.equal(silenceActive(saved, new Date("2026-10-19T10:00:00Z")), false);
      assert.equal(silenceActive(saved, new Date("2026-10-19T08:30:00Z")), false);
    }
  } finally { await f.close(); }
});

test("ending a silence preserves its historical suppression interval for response accounting", async () => {
  const f = await fixture();
  try {
    const s = await f.createSilence();
    const ended = await f.cap.prepare(admin, "silence.end", { id: s.id, version: s.version });
    f.setNow(new Date("2026-10-18T08:05:00Z"));
    const saved = f.db.transaction(() => f.cap.commit(admin, ended));
    const response = { group_id: "g", priority: "P2", event: { state: { labels: {} } }, group: { timezone: "UTC", policies: { P2: { start: "", end: "", weekdays: [] } } } };
    assert.equal(silenceActive(saved, new Date("2026-10-18T08:04:00Z")), true);
    assert.equal(silenceActive(saved, new Date("2026-10-18T08:05:00Z")), false);
    assert.equal(silenceActive(saved, new Date("2026-10-18T08:06:00Z")), false);
    assert.equal(responseActiveSeconds(response, Date.parse("2026-10-18T08:04:00Z"), Date.parse("2026-10-18T08:06:00Z"), [saved]), 60);
    const separateBoundary = { ...saved, until: s.until, ended_at: "2026-10-18T08:05:30Z" };
    assert.equal(responseActiveSeconds(response, Date.parse("2026-10-18T08:04:00Z"), Date.parse("2026-10-18T08:06:00Z"), [separateBoundary]), 30);
  } finally { await f.close(); }
});

test("durable change revalidation preserves displayed IDs/times and never applies tampered data", async () => {
  const f = await fixture();
  try {
    const p = await f.cap.prepare(admin, "silence.create", { silence: { scope: "all", until: "2026-10-18T09:00:00Z" } });
    const serialized = parseJSON(encode(p));
    f.setNow(new Date("2026-10-18T08:05:00Z"));
    const verified = await new AlertCapabilities(f.alerts).revalidate(admin, serialized);
    assert.equal(verified.target_id, p.target_id);
    assert.equal(verified.after.from, p.after.from);
    assert.deepEqual(verified, p);
    p.after.scope = "service";
    assert.throws(() => f.cap.commit(admin, p), status(400));
    const cap = new AlertCapabilities(f.alerts);
    const ready = await cap.revalidate(admin, serialized);
    f.db.transaction(() => cap.commit(admin, ready));
    assert.equal(f.cap.getSilence(admin, p.target_id).from, serialized.after.from);
    const r = await f.createRule();
    const change = await f.cap.prepare(admin, "rule.update", { id: r.id, revision: r.revision, patch: { threshold: "4" } });
    f.tables.length = 0;
    await assert.rejects(f.cap.revalidate(admin, parseJSON(encode(change))), status(400));
  } finally { await f.close(); }
});

test("business commits roll back with caller receipts and reject malformed/prototype/host patches", async () => {
  const f = await fixture();
  try {
    const r = await f.createRule();
    const change = await f.cap.prepare(admin, "rule.update", { id: r.id, revision: r.revision, patch: { threshold: "5" } });
    assert.throws(() => f.db.transaction(() => { f.cap.commit(admin, change); throw Error("receipt failure"); }), /receipt failure/);
    assert.equal(f.cap.getRule(admin, r.id).threshold, "1");
    for (const patch of [{ id: "other" }, { revision: 9 }, { enabled: "false" }, { enabled: null }, { source_table_ids: "log_app" }, parseJSON('{"__proto__":{"polluted":true}}'), { params: parseJSON('{"constructor":{"type":"String","value":"x"}}') }])
      await assert.rejects(f.cap.prepare(admin, "rule.update", { id: r.id, revision: r.revision, patch }), status(400));
    assert.equal(({} as any).polluted, undefined);
    const s = await f.createSilence();
    await assert.rejects(f.cap.prepare(admin, "silence.update", { id: s.id, version: s.version, patch: { created_by: "m" } }), status(400));
    assert.equal((await f.request("/api/v1/alerts/silences", "POST", { id: "client", created_by: "m", scope: "group", group_id: "g", until: s.until }, "m")).status, 200);
  } finally { await f.close(); }
});
