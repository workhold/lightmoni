import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { CapabilityAccess, scopesForUser } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { TelemetryService, TELEMETRY_SAMPLE_BYTES } from "../src/domains/telemetry.js";
import { registerAssistant } from "../src/assistant/index.js";
import type { Dependencies, QueryRequest, QueryResponse, Table, User } from "../src/shared/types.js";

const admin: User = { id: "admin", name: "Admin", role: "admin" };
const table: Table = { id: "table-one", name: "log_app", logical_name: "log_app", kind: "log", columns: [{name: "body", type: "String"}], services: ["orders"], system: false, retention_days: 7, effective_retention_days: 7 };
const range = { from: "2026-11-13T00:00:00Z", to: "2026-11-14T00:00:00Z" };
const response = (rows: any[][] = [[1, "ok"]]): QueryResponse => ({ request_id: "query-one", results: [{ refId: "A", status: "success", complete: true, truncated: false, elapsed_ms: 1, frames: [{ columns: [{name: "id", type: "UInt64"}, {name: "body", type: "String"}], rows }] }] });

function fixture(rows?: any[][]) {
  const db = new DB(":memory:"); accountSchema(db);
  db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const requests: QueryRequest[] = [];
  const deps = { db, router: new Router(), now: () => new Date("2026-11-14T00:00:00Z"), externalURL: "https://moni.example.test",
    ...cipher(Buffer.alloc(32, 16)), cat: { list: async () => [table] },
    query: async (request: QueryRequest) => { requests.push(request); return response(rows); },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  const runs = new TaskRunStore(deps), telemetry = new TelemetryService(deps);
  const principal: Principal = { user: admin, scopes: [...CAPABILITY_SCOPES], host_ids: null, credential_id: "token", grant_id: "grant", source: "mcp" };
  const access = new CapabilityAccess(deps, { validate() {}, validateGrant: () => structuredClone(principal) });
  const dispatcher = new CapabilityDispatcher(deps, access, { taskCenter: runs, telemetry });
  const invoke = (name: string, input: any, p = structuredClone(principal)) => dispatcher.invoke(p, name, input, { signal: new AbortController().signal });
  return { db, deps, runs, access, dispatcher, requests, principal, invoke, close: () => db.close() };
}

test("catalog, describe and query share telemetry service and require their distinct installation scopes", async () => {
  const f = fixture();
  try {
    const catalog = await f.invoke("lightmoni_telemetry_catalog", {});
    assert.equal(catalog.data.tables[0].name, "log_app");
    const described = await f.invoke("lightmoni_telemetry_describe", { table: "table-one" });
    assert.equal(described.data.table.services[0], "orders");
    const queried = await f.invoke("lightmoni_telemetry_query", { sql: "SELECT body FROM log_app WHERE $__timeFilter(event_time)", range, interval_ms: 1000, params: { service: {type: "String", value: "orders"} } });
    assert.equal(queried.data.query.results[0].frames[0].rows[0][1], "ok");
    assert.equal(f.requests[0].source, "mcp");
    assert.equal(f.requests[0].queries[0].params?.service.value, "orders");
    await assert.rejects(f.invoke("lightmoni_telemetry_query", { sql: "SELECT 1", range, interval_ms: 1000,
      params: {service: {type: "String", value: "orders", unexpected: true}} }), /invalid_input/);
    assert.equal(f.requests.length, 1);

    const catalogOnly = { ...structuredClone(f.principal), scopes: ["telemetry.catalog.read"] };
    await assert.rejects(f.invoke("lightmoni_telemetry_query", { sql: "SELECT 1", range, interval_ms: 1000 }, catalogOnly), /capability_forbidden/);
    const hostScoped = { ...structuredClone(f.principal), scopes: ["telemetry.catalog.read", "telemetry.query"], host_ids: ["one"] };
    assert.equal(f.dispatcher.list(hostScoped).some(d => d.id.startsWith("telemetry.")), false);
    for (const name of ["lightmoni_telemetry_catalog", "lightmoni_telemetry_describe", "lightmoni_telemetry_query"])
      await assert.rejects(f.invoke(name, name.endsWith("query") ? { sql: "SELECT 1", range, interval_ms: 1000 } : name.endsWith("describe") ? {table: "log_app"} : {}, hostScoped), /capability_forbidden/);
  } finally { f.close(); }
});

test("assistant legacy names use the dispatcher without duplicate registration and preserve member read access", async () => {
  const f = fixture();
  try {
    const module = registerAssistant(f.deps, { capabilities: f.dispatcher, runtime: async () => {} });
    await module.close?.();
    const tools = f.dispatcher.assistantTools();
    assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
    const member = f.access.sessionPrincipal({ id: "member", name: "Member", role: "member" }, "assistant");
    const query = tools.find(tool => tool.name === "run_query")!;
    const result = await query.execute({ sql: "SELECT body FROM log_app", range, interval_ms: 1000 }, new AbortController().signal,
      { id: "member", role: "member" }, { session_id: "member-session" });
    assert.equal(result.sample_limit, 1000);
    assert.equal(f.requests[0].source, "assistant");
    assert.deepEqual(member.scopes, ["telemetry.catalog.read", "telemetry.query", "alerts.read", "alerts.detail.read", "logs.read", "traces.read", "dashboards.read", "dashboards.detail.read", "alerts.incidents.read", "alerts.notifications.read", "alerts.statistics.read"]);
    assert.deepEqual(scopesForUser({ id: "member", name: "Member", role: "member" }), []);
    assert.equal(f.dispatcher.list(member).every(d => d.id.startsWith("telemetry.")), true);
    await assert.rejects(f.dispatcher.invoke(member, "lightmoni_tasks_list", {}, { signal: new AbortController().signal }), /capability_forbidden/);
    assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_telemetry_query'"));
  } finally { f.close(); }
});

test("query sampling bounds both rows and bytes with explicit truncation", async () => {
  const f = fixture(Array.from({ length: 1200 }, (_, i) => [i, "x".repeat(2000)]));
  try {
    const result = await f.invoke("lightmoni_telemetry_query", { sql: "SELECT body FROM log_app", range, interval_ms: 1000 });
    assert.equal(result.data.sample_limit, 1000);
    assert.equal(result.data.sample_truncated, true);
    assert.equal(result.data.sample_byte_limited, true);
    assert.equal(result.data.sample_byte_limit, TELEMETRY_SAMPLE_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 << 10);
    assert.ok(result.data.query.results[0].frames[0].rows.length < 1000);
    f.deps.query = async () => ({ request_id: "oversized-metadata", results: [{ refId: "A", status: "success", complete: true,
      truncated: false, elapsed_ms: 1, frames: [{ columns: [{name: "x".repeat(70_000), type: "String"}], rows: [] }] }] });
    await assert.rejects(f.invoke("lightmoni_telemetry_query", { sql: "SELECT 1", range, interval_ms: 1000 }), /result_too_large/);
  } finally { f.close(); }
});

test("semantic query failures occur before the checked Query service and errors are not success", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.invoke("lightmoni_telemetry_query", { sql: "SELECT 1", range: {from: range.to, to: range.from}, interval_ms: 1000 }), /query range/);
    assert.equal(f.requests.length, 0);
    f.deps.query = async () => ({ request_id: "failed", results: [{ refId: "A", status: "error", complete: false, truncated: false, elapsed_ms: 1, frames: [], error: "fixture query error" }] });
    await assert.rejects(f.invoke("lightmoni_telemetry_query", { sql: "SELECT 1", range, interval_ms: 1000 }), /fixture query error/);
  } finally { f.close(); }
});
