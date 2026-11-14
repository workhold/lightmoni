import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { Alerts } from "../src/domains/alerts.js";
import { AlertCapabilities } from "../src/domains/alert-capabilities.js";
import { encode } from "../src/domains/common.js";
import { AlertProposalService } from "../src/assistant/alert-proposals.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { registerAssistant } from "../src/assistant/index.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = { id: "admin", name: "Admin", role: "admin" };
const member: User = { id: "member", name: "Member", role: "member" };
async function fixture() {
  const db = new DB(":memory:"); accountSchema(db);
  db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const deps = { db, router: new Router(), now: () => new Date("2026-11-14T00:00:00Z"), externalURL: "https://moni.example.test",
    ...cipher(Buffer.alloc(32, 17)), cat: { list: async () => [{ id: "log_app", name: "log_app", logical_name: "app", kind: "log", columns: [], services: ["api"], system: false, retention_days: null, effective_retention_days: 7 }] },
    referencedTables: async () => ["log_app"], query: async () => ({request_id: "fixture", results: []}),
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  const alerts = new Alerts(deps), capabilities = new AlertCapabilities(alerts);
  const proposals = new AlertProposalService(db, capabilities, deps.now, deps.encrypt, deps.decrypt);
  const prepared = await capabilities.prepareRuleSave(admin, { name: "API errors", enabled: true, kind: "sql", severity: "P2",
    sql: "SELECT count() AS value FROM log_app WHERE $__timeFilter(event_time)", value_field: "value", source_table_ids: ["log_app"],
    threshold: "1", operator: "gt", interval_seconds: 10, window_seconds: 60, evidence_profile: {} });
  const rule = db.transaction(() => capabilities.commitRuleSave(admin, prepared));
  db.run("INSERT INTO alert_groups(id,name,body) VALUES('group-one','Ops',?)", encode({id: "group-one", name: "Ops", enabled: true, members: ["admin"], secret: "not-public"}));
  db.run("INSERT INTO alert_silences(id,body) VALUES('silence-one',?)", encode({id: "silence-one", scope: "rule", rule_id: rule.id,
    from: "2026-11-14T00:00:00Z", until: "2026-11-14T02:00:00Z", reason: "maintenance", created_by: "admin", version: "v1"}));
  const proposal = await proposals.create(admin, "session-one", { operation: "rule.update", target_id: rule.id, patch: {threshold: "2"}, reason: "review" }, new AbortController().signal);
  const runs = new TaskRunStore(deps);
  const principal: Principal = { user: admin, scopes: [...CAPABILITY_SCOPES], host_ids: null, credential_id: "token", grant_id: "grant", source: "mcp" };
  const access = new CapabilityAccess(deps, { validate() {}, validateGrant: () => structuredClone(principal) });
  const dispatcher = new CapabilityDispatcher(deps, access, { taskCenter: runs, alerts: capabilities, alertProposals: proposals });
  const invoke = (name: string, input: any, p = structuredClone(principal)) => dispatcher.invoke(p, name, input, { signal: new AbortController().signal });
  return { db, deps, alerts, capabilities, proposals, rule, proposal, access, dispatcher, invoke, principal,
    close: async () => { await alerts.close(); db.close(); } };
}

test("alert reads preserve filters, pagination, safe groups and owner-bound proposals", async () => {
  const f = await fixture();
  try {
    assert.equal(f.dispatcher.definitions.length, 25);
    const rules = await f.invoke("lightmoni_alert_rules_list", { search: "api", service: "api", enabled: true, limit: 1 });
    assert.equal(rules.data.total, 1); assert.equal(rules.data.items[0].id, f.rule.id);
    assert.equal(Object.hasOwn(rules.data.items[0], "sql"), false);
    const detail = await f.invoke("lightmoni_alert_rules_get", { id: f.rule.id });
    assert.match(detail.data.rule.sql, /log_app/);
    const silences = await f.invoke("lightmoni_alert_silences_list", { scope: "rule", target_id: f.rule.id });
    assert.equal(silences.data.items[0].id, "silence-one");
    assert.equal((await f.invoke("lightmoni_alert_silences_get", {id: "silence-one"})).data.silence.reason, "maintenance");
    const groups = await f.invoke("lightmoni_alert_groups_list", {});
    assert.deepEqual(groups.data.items, [{id: "group-one", name: "Ops", enabled: true}]);
    assert.equal(JSON.stringify(groups).includes("not-public"), false);
    assert.equal((await f.invoke("lightmoni_alert_proposals_get", {id: f.proposal.id})).data.proposal.status, "awaiting_approval");
    await assert.rejects(f.invoke("lightmoni_alert_proposals_get", {id: f.proposal.id}, {...structuredClone(f.principal), user: member}), /告警变更提案不存在/);
  } finally { await f.close(); }
});

test("alert detail scope, installation scope and member session boundaries are enforced", async () => {
  const f = await fixture();
  try {
    const ordinary = {...structuredClone(f.principal), scopes: ["alerts.read"]};
    assert.equal(f.dispatcher.list(ordinary).some(d => d.name === "lightmoni_alert_rules_get"), false);
    await assert.rejects(f.invoke("lightmoni_alert_rules_get", {id: f.rule.id}, ordinary), /capability_forbidden/);
    await assert.rejects(f.invoke("lightmoni_alert_proposals_get", {id: f.proposal.id}, ordinary), /capability_forbidden/);
    const detailOnly = {...structuredClone(f.principal), scopes: ["alerts.detail.read"]};
    await assert.rejects(f.invoke("lightmoni_alert_rules_list", {}, detailOnly), /capability_forbidden/);
    const hostScoped = {...structuredClone(f.principal), host_ids: ["one"]};
    assert.equal(f.dispatcher.list(hostScoped).some(d => d.id.startsWith("alerts.")), false);
    await assert.rejects(f.invoke("lightmoni_alert_rules_list", {}, hostScoped), /capability_forbidden/);

    const session = f.access.sessionPrincipal(member, "assistant");
    const memberRules = await f.invoke("lightmoni_alert_rules_list", {}, session);
    assert.equal(memberRules.data.total, 1);
    assert.equal(f.dispatcher.list(session).filter(d => d.id.startsWith("alerts.")).length, 11);
    await assert.rejects(f.invoke("lightmoni_tasks_list", {}, session), /capability_forbidden/);
  } finally { await f.close(); }
});

test("assistant alert aliases share dispatcher and do not duplicate native alert tools", async () => {
  const f = await fixture();
  try {
    const module = registerAssistant(f.deps, { capabilities: f.dispatcher, alerts: f.capabilities, alertProposals: f.proposals, runtime: async () => {} });
    await module.close?.();
    const tools = f.dispatcher.assistantTools();
    for (const name of ["list_alert_rules", "get_alert_rule", "list_alert_silences", "get_alert_silence", "list_alert_groups", "get_alert_proposal"])
      assert.ok(tools.some(tool => tool.name === name), name);
    const result = await tools.find(tool => tool.name === "get_alert_rule")!.execute({id: f.rule.id}, new AbortController().signal, admin, {session_id: "session-one"});
    assert.match(result.rule.sql, /log_app/);
    assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_alert_rules_get'"));
    assert.equal(f.dispatcher.definitions.some(d => /apply|approve|execute/.test(d.name)), false);
  } finally { await f.close(); }
});
