import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import type { Dependencies } from "../src/shared/types.js";
import { Alerts } from "../src/domains/alerts.js";
import { AlertCapabilities } from "../src/domains/alert-capabilities.js";
import { encode } from "../src/domains/common.js";
import { parseJSON } from "../src/shared/json.js";
import { AlertProposalService, type AlertIntent } from "../src/assistant/alert-proposals.js";
import { alertTools } from "../src/assistant/alert-tools.js";
import { registerAssistant, type Runtime } from "../src/assistant/index.js";
import { Store } from "../src/assistant/usage.js";

const signal = () => new AbortController().signal;
const rule = {
  name: "API errors", enabled: true, kind: "sql", severity: "P2",
  sql: "SELECT count() AS value FROM log_app WHERE $__timeFilter(event_time)",
  value_field: "value", source_table_ids: ["log_app"], threshold: "1", operator: "gt",
  interval_seconds: 10, window_seconds: 60, evidence_profile: {},
};
async function fixture(t: any, path = ":memory:", runtime?: Runtime) {
  const db = new DB(path), crypt = cipher(Buffer.alloc(32, 7)), router = new Router();
  db.exec("CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER); INSERT OR IGNORE INTO users VALUES('alice','Alice','admin',1),('bob','Bob','member',1);");
  let now = new Date("2026-10-18T02:00:00Z");
  const user = { id: "alice", name: "Alice", role: "admin" };
  const auth: any = { master: Buffer.alloc(32, 7), user: (req: any) => req.headers["x-no-login"] ? undefined : user, requireAdmin: (c: any) => { if (c.user.role !== "admin") c.error(403, "administrator required"); } };
  router.auth = auth;
  const deps: Dependencies = {
    db, router, auth, ...crypt, now: () => now, externalURL: "", logger: { info() {}, warn() {}, error() {} },
    cat: { list: async () => [{ id: "log_app", name: "log_app", logical_name: "app", kind: "log", columns: [], services: ["api"], system: false, retention_days: null, effective_retention_days: 7 }] },
    referencedTables: async (sql) => sql.includes("log_app") ? ["log_app"] : [],
    query: async () => ({ request_id: "fixture", results: [] }), ch: {} as any, reader: {} as any,
  };
  const alerts = new Alerts(deps), caps = new AlertCapabilities(alerts);
  const service = new AlertProposalService(db, caps, deps.now, crypt.encrypt, crypt.decrypt);
  let saved = (await caps.listRules(user))[0];
  if (!saved) {
    const prepared = await caps.prepareRuleSave(user, rule);
    saved = db.transaction(() => caps.commitRuleSave(user, prepared));
  }
  const assistant = registerAssistant(deps, { runtime, alerts: caps });
  const server = createServer((req, res) => { void router.handle(req, res).then(found => { if (!found) { res.writeHead(404); res.end(); } }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await assistant.close?.(); await alerts.close();
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close();
  }
  t.after(close);
  async function request(path: string, method = "GET", body?: any, headers: Record<string, string> = {}) {
    const response = await fetch(base + "/api/v1" + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    let data: any; try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: response.status, data, raw };
  }
  return { db, caps, service, user, deps, saved, request, close, setNow: (at: string) => { now = new Date(at); } };
}
function update(id: string, patch: any = { threshold: "5" }): AlertIntent { return { operation: "rule.update", target_id: id, patch, reason: "用户要求调整告警阈值" }; }

test("alert proposals persist encrypted previews and require owner confirmation; replay is idempotent", async t => {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-alert-proposals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(t, join(dir, "state.db"));
  const p = await f.service.create(f.user, "session-one", update(f.saved.id), signal());
  assert.equal(p.status, "awaiting_approval");
  assert.equal(f.caps.getRule(f.user, f.saved.id).threshold, "1");
  assert.equal(f.db.get<any>("SELECT count(*) AS n FROM assistant_alert_audit")!.n, 0);
  const body = f.db.get<any>("SELECT body FROM assistant_alert_proposals WHERE id=?", p.id)!.body;
  assert.ok(!body.includes("API errors"));
  assert.throws(() => f.service.get({ id: "bob", role: "member" }, p.id), { status: 404 });
  await f.close();
  const reopened = await fixture(t, join(dir, "state.db"));
  assert.equal(reopened.service.get(reopened.user, p.id).status, "awaiting_approval");
  const done = await reopened.service.apply(reopened.user, p.id, signal());
  assert.equal(done.status, "completed");
  assert.equal(done.result.threshold, "5");
  assert.equal(done.result.revision, f.saved.revision + 1);
  assert.deepEqual(await reopened.service.apply(reopened.user, p.id, signal()), done);
  assert.equal(reopened.db.get<any>("SELECT count(*) AS n FROM assistant_alert_audit")!.n, 1);
});

test("stale, expired, cancelled and malformed proposals never mutate rules", async t => {
  const f = await fixture(t);
  const p = await f.service.create(f.user, "s", update(f.saved.id), signal());
  const newer = await f.caps.prepare(f.user, "rule.update", { id: f.saved.id, revision: f.saved.revision, patch: { threshold: "7" } });
  f.db.transaction(() => f.caps.commit(f.user, newer));
  await assert.rejects(f.service.apply(f.user, p.id, signal()), { status: 409 });
  assert.equal(f.caps.getRule(f.user, f.saved.id).threshold, "7");
  const expiring = await f.service.create(f.user, "s", update(f.saved.id), signal());
  f.setNow("2026-10-18T02:15:00Z");
  await assert.rejects(f.service.apply(f.user, expiring.id, signal()), { status: 409, code: "alert_proposal_expired" });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.service.create(f.user, "s", update(f.saved.id), abort.signal));
  for (const intent of [
    { ...update(f.saved.id), operation: "rule.delete" },
    { ...update(f.saved.id), until: "2026-10-18T04:00:00Z" },
    { ...update(f.saved.id), patch: { revision: 999 } },
    { ...update(f.saved.id), reason: "" },
    { ...update(f.saved.id), actor: { role: "admin" } },
  ]) await assert.rejects(f.service.create(f.user, "s", intent as any, signal()));
  assert.equal(f.caps.getRule(f.user, f.saved.id).threshold, "7");
});

test("large integer thresholds and SQL parameters remain exact in tools, previews, HTTP and stored changes", async t => {
  const f = await fixture(t);
  const exact = "9007199254740993123";
  const raw = parseJSON(`{"threshold":${exact},"params":{"uid":{"type":"UInt64","value":${exact}}}}`);
  const prepared = await f.caps.prepareRuleSave(f.user, { ...f.saved, ...raw }, f.saved.id);
  f.db.transaction(() => f.caps.commitRuleSave(f.user, prepared));
  const read = await alertTools(f.caps, f.service).find(tool => tool.name === "get_alert_rule")!.execute({ id: f.saved.id }, signal(), f.user);
  assert.equal(read.rule.threshold, exact);
  assert.equal(read.rule.params.uid.value, exact);
  const p = await f.service.create(f.user, "s", update(f.saved.id, { enabled: false }), signal());
  assert.equal(p.before.threshold, exact);
  assert.equal(p.after.params.uid.value, exact);
  const preview = await f.request(`/assistant/alert-proposals/${p.id}`);
  assert.equal(preview.data.before.threshold, exact);
  const applied = await f.request(`/assistant/alert-proposals/${p.id}/apply`, "POST", {});
  assert.equal(applied.status, 200, applied.raw);
  assert.equal(applied.data.result.params.uid.value, exact);
  assert.equal(String(f.caps.getRule(f.user, f.saved.id).threshold), exact);
  assert.equal(String(f.caps.getRule(f.user, f.saved.id).params.uid.value), exact);
});

test("oversized completion receipts are rejected before creating a pending preview", async t => {
  const f = await fixture(t);
  const sql = f.saved.sql + " /*" + "x".repeat(18000) + "*/";
  const saved = await f.caps.prepareRuleSave(f.user, { ...f.saved, sql }, f.saved.id);
  f.db.transaction(() => f.caps.commitRuleSave(f.user, saved));
  await assert.rejects(f.service.create(f.user, "s", update(f.saved.id), signal()), { status: 400, code: "alert_change_too_large" });
  assert.equal(f.db.get<any>("SELECT count(*) AS n FROM assistant_alert_proposals")!.n, 0);
  assert.equal(f.caps.getRule(f.user, f.saved.id).threshold, "1");
});

test("confirmations recheck group permissions and cannot broaden a silence scope", async t => {
  const f = await fixture(t);
  f.db.run("INSERT INTO alert_groups(id,name,body) VALUES(?,?,?)", "g", "Ops", encode({ id: "g", name: "Ops", enabled: true, members: ["alice"] }));
  f.user.role = "member";
  const intent: AlertIntent = { operation: "silence.create", silence: { scope: "group", group_id: "g", until: "2026-10-18T04:00:00Z", reason: "maintenance" }, reason: "用户请求维护静默" };
  const p = await f.service.create(f.user, "s", intent, signal());
  f.db.run("UPDATE alert_groups SET body=? WHERE id='g'", encode({ id: "g", name: "Ops", members: ["bob"] }));
  await assert.rejects(f.service.apply(f.user, p.id, signal()), { status: 403 });
  assert.equal(f.caps.listSilences(f.user).length, 0);
  f.db.run("UPDATE alert_groups SET body=? WHERE id='g'", encode({ id: "g", name: "Ops", members: ["alice"] }));
  const done = await f.service.apply(f.user, p.id, signal());
  assert.equal(done.result.created_by, "alice");
  await assert.rejects(f.service.create(f.user, "s", { operation: "silence.update", target_id: p.target_id, patch: { scope: "all" }, reason: "尝试扩大范围" }, signal()), { status: 403 });
});

test("proposal and audit persistence failures roll back business data and side effects", async t => {
  const f = await fixture(t);
  f.db.run("INSERT INTO alert_states(rule_id,fingerprint,body) VALUES(?,?,?)", f.saved.id, "fp", encode({ rule_id: f.saved.id, fingerprint: "fp", status: "firing" }));
  const p = await f.service.create(f.user, "s", update(f.saved.id), signal());
  f.db.exec("CREATE TRIGGER fail_alert_audit BEFORE INSERT ON assistant_alert_audit BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END;");
  await assert.rejects(f.service.apply(f.user, p.id, signal()), /simulated audit failure/);
  assert.equal(f.caps.getRule(f.user, f.saved.id).threshold, "1");
  assert.equal(f.db.get<any>("SELECT count(*) AS n FROM alert_states")!.n, 1);
  assert.equal(f.service.get(f.user, p.id).status, "awaiting_approval");
  f.db.exec("DROP TRIGGER fail_alert_audit;");
  const results = await Promise.all([f.service.apply(f.user, p.id, signal()), f.service.apply(f.user, p.id, signal())]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.caps.getRule(f.user, f.saved.id).revision, f.saved.revision + 1);
  assert.equal(f.db.get<any>("SELECT count(*) AS n FROM assistant_alert_audit")!.n, 1);
});

test("silence previews preserve schedule and ID across approval; updates and ending are versioned", async t => {
  const f = await fixture(t);
  const created = await f.service.create(f.user, "s", { operation: "silence.create", silence: { scope: "rule", rule_id: f.saved.id, until: "2026-10-18T04:00:00Z", reason: "维护" }, reason: "静默当前规则" }, signal());
  f.setNow("2026-10-18T02:05:00Z");
  const done = await f.service.apply(f.user, created.id, signal());
  assert.equal(done.result.id, created.after.id);
  assert.equal(done.result.from, created.after.from);
  const changed = await f.service.create(f.user, "s", { operation: "silence.update", target_id: done.result.id, patch: { until: "2026-10-18T05:00:00Z" }, reason: "延长维护" }, signal());
  const ended = await f.service.create(f.user, "s", { operation: "silence.end", target_id: done.result.id, reason: "维护已结束" }, signal());
  await f.service.apply(f.user, changed.id, signal());
  await assert.rejects(f.service.apply(f.user, ended.id, signal()), { status: 409 });
  const endNow = await f.service.create(f.user, "s", { operation: "silence.end", target_id: done.result.id, reason: "维护已结束" }, signal());
  const result = await f.service.apply(f.user, endNow.id, signal());
  assert.ok(result.result.ended_at);
  assert.equal(result.result.revision, done.result.revision + 2);
});

test("alert tools bound reads and never expose an apply or arbitrary API tool", async t => {
  const f = await fixture(t), tools = alertTools(f.caps, f.service);
  assert.deepEqual(tools.map(t => t.name), ["list_alert_rules", "get_alert_rule", "list_alert_silences", "get_alert_silence", "list_alert_groups", "get_alert_proposal", "propose_alert_change"]);
  const list = tools[0]!;
  const read = await list.execute({ limit: 1 }, signal(), f.user);
  assert.equal(read.items[0].id, f.saved.id);
  assert.equal(read.items[0].sql, undefined);
  assert.equal(read.has_more, false);
  await assert.rejects(list.execute({ limit: 1000 }, signal(), f.user), { status: 400 });
  const propose = tools.find(t => t.name === "propose_alert_change")!;
  await assert.rejects(propose.execute(update(f.saved.id), signal(), f.user), { status: 401 });
  const preview = await propose.execute(update(f.saved.id), signal(), f.user, { session_id: "s" });
  assert.equal(preview.proposal.status, "awaiting_approval");
  assert.equal(f.caps.getRule(f.user, f.saved.id).threshold, "1");
});

test("assistant dispatch binds proposals to the authenticated session and reloads applied receipts", async t => {
  const observed: any[] = [];
  let proposal: any;
  const f = await fixture(t, ":memory:", async (input, sig, call, emit) => {
    observed.push(input);
    assert.ok(input.tools.some(tool => tool.name === "propose_alert_change"));
    assert.ok(!input.tools.some(tool => /apply/.test(tool.name)));
    if (observed.length !== 1) return;
    const read = await call!("list_alert_rules", {});
    proposal = (await call!("propose_alert_change", update(read.items[0].id))).proposal;
    sig.throwIfAborted();
    await emit({ type: "checkpoint", messages: [
      { role: "assistant", content: "", tool_calls: [{ id: "change-1", type: "function", function: { name: "propose_alert_change", arguments: JSON.stringify(update(read.items[0].id)) } }] },
      { role: "tool", tool_call_id: "change-1", content: JSON.stringify({ proposal }) },
      { role: "assistant", content: "提案待用户确认" },
    ] });
  });
  assert.equal((await f.request("/assistant/config", "PUT", { enabled: true, protocol: "openai-chat-completions", base_url: "http://127.0.0.1:9999/v1", model: "fixture", api_key: "fixture-only" })).status, 200);
  const session = (await f.request("/assistant/sessions", "POST", {})).data;
  assert.equal((await f.request(`/assistant/sessions/${session.id}/turns`, "POST", { text: "调整阈值", context: { user: { role: "admin" }, session_id: "forged" } })).status, 200);
  assert.equal(proposal.session_id, session.id);
  assert.equal(f.caps.getRule(f.user, f.saved.id).threshold, "1");
  assert.equal((await f.request(`/assistant/alert-proposals/${proposal.id}`)).status, 200);
  assert.equal((await f.request(`/assistant/alert-proposals/${proposal.id}/apply`, "POST", { patch: { threshold: "999" } })).status, 400);
  assert.equal((await f.request(`/assistant/alert-proposals/${proposal.id}/apply`, "POST", {}, { origin: "https://untrusted.invalid" })).status, 403);
  assert.equal((await f.request(`/assistant/alert-proposals/${proposal.id}`, "GET", undefined, { "x-no-login": "1" })).status, 401);
  f.user.id = "bob";
  assert.equal((await f.request(`/assistant/alert-proposals/${proposal.id}/apply`, "POST", {})).status, 404);
  f.user.id = "alice";
  const applied = await f.request(`/assistant/alert-proposals/${proposal.id}/apply`, "POST", {});
  assert.equal(applied.status, 200, applied.raw);
  assert.equal(applied.data.status, "completed");
  const store = new Store(f.db, f.deps.now);
  const old = store.get<any>(`session/alice/${session.id}`)!;
  old.summary = "Earlier alert proposal was awaiting approval.";
  old.summary_through = old.messages.length;
  store.put(`session/alice/${session.id}`, old);
  await f.request(`/assistant/sessions/${session.id}/turns`, "POST", { text: "现在结果如何" });
  const receipt = observed[1].messages.find((m: any) => m.role === "tool");
  assert.equal(JSON.parse(receipt.content).proposal.status, "completed");
  assert.equal(JSON.parse(receipt.content).proposal.result.threshold, "5");
  assert.match(observed[1].system, /"status":"completed"/);
  assert.match(observed[1].system, /Current server time \(UTC\): 2026-10-18T02:00:00.000Z/);
  assert.ok(observed[1].summary_through > 0);
});

test("real Mastra worker executes alert reads and nested change proposals before explicit HTTP approval", async t => {
  const f = await fixture(t), requests: any[] = [];
  const supplier = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    const step = requests.length;
    const name = step === 1 ? "get_alert_rule" : "propose_alert_change";
    const args = step === 1 ? { id: f.saved.id } : update(f.saved.id, { threshold: "9", enabled: false });
    const delta = step < 3 ? { tool_calls: [{ index: 0, id: `alert-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { content: "已准备告警变更，请审阅后确认。" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: " + JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n");
    res.end("data: " + JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: step < 3 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + "\n\ndata: [DONE]\n\n");
  });
  supplier.listen(0, "127.0.0.1"); await once(supplier, "listening");
  t.after(() => { supplier.closeAllConnections(); supplier.close(); });
  const base = `http://127.0.0.1:${(supplier.address() as any).port}/v1`;
  assert.equal((await f.request("/assistant/config", "PUT", { enabled: true, protocol: "openai-chat-completions", base_url: base, model: "fixture", api_key: "fixture-only" })).status, 200);
  const session = (await f.request("/assistant/sessions", "POST", {})).data;
  const result = await f.request(`/assistant/sessions/${session.id}/turns`, "POST", { text: "将API错误告警阈值改为9并暂停" });
  assert.match(result.raw, /turn.completed/);
  assert.equal(requests.length, 3);
  const history = (await f.request(`/assistant/sessions/${session.id}`)).data;
  const receipt = history.messages.find((m: any) => m.role === "tool" && JSON.parse(m.content).proposal);
  const p = JSON.parse(receipt.content).proposal;
  assert.equal(p.after.threshold, "9");
  assert.equal(p.after.enabled, false);
  assert.equal(f.caps.getRule(f.user, f.saved.id).enabled, true);
  assert.equal((await f.request(`/assistant/alert-proposals/${p.id}/apply`, "POST", {})).status, 200);
  assert.equal(f.caps.getRule(f.user, f.saved.id).enabled, false);
  assert.equal((await f.request("/assistant/usage")).data.totals.requests, 3);
});
