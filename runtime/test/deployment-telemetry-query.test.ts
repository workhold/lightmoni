import { test } from "node:test";
import assert from "node:assert/strict";
import type { Table } from "../src/shared/types.js";
import { queryDeploymentTelemetry, validateTelemetryBinding } from "../src/deployment/telemetry-query.js";

const binding = { table: "log_orders", service: "orders-sdk", instance_id: "node-a" };
const from = "2026-10-23T00:00:00.000Z";
const now = new Date("2026-10-23T00:02:00.000Z");
const row = { service: binding.service, instance_id: binding.instance_id, service_version: "v2", event_time: "2026-10-23 00:00:30.123456789", ingested_at: "2026-10-23 00:00:31.123456789" };
const table: Table = {
  id: "orders-log", name: binding.table, logical_name: "orders", kind: "log", metric_type: "",
  columns: ["service", "instance_id", "service_version", "event_time", "ingested_at"].map(name => ({
    name, type: name === "event_time" || name === "ingested_at" ? "DateTime64(9,'UTC')" : "String",
  })), services: [], system: false, retention_days: 7, effective_retention_days: 7,
};

function fixture(options: { tables?: Table[]; rows?: Record<string, unknown>[]; failure?: "catalog" | "query"; count?: number } = {}) {
  const calls: { sql: string; params?: Record<string, string>; signal?: AbortSignal }[] = [];
  let catalogCalls = 0;
  const cat = { async list(signal?: AbortSignal) {
    catalogCalls++;
    assert.ok(signal);
    if (options.failure === "catalog") throw Error("secret catalog path");
    return options.tables ?? [table];
  } };
  const reader = { async query(sql: string, params?: Record<string, string>, signal?: AbortSignal) {
    calls.push({ sql, params, signal });
    if (options.failure === "query") throw Error("secret SQL credential");
    const data = options.rows ?? [row];
    return { meta: table.columns.map(({ name, type }) => ({ name, type })), data, rows: options.count ?? data.length };
  } };
  const query = (overrides: Partial<Parameters<typeof queryDeploymentTelemetry>[0]> = {}) => queryDeploymentTelemetry({
    reader, cat, serviceId: "platform-service", deploymentId: "deployment-1", binding, serviceVersion: "v2", finishedAt: from, now, ...overrides,
  });
  return { query, calls, get catalogCalls() { return catalogCalls; } };
}

test("telemetry binding validates strict fields, UTF-8 limits and safe table identifiers", () => {
  assert.deepEqual(validateTelemetryBinding(binding), binding);
  assert.deepEqual(validateTelemetryBinding({ ...binding, service: "订单服务", instance_id: "pod/节点-a" }).service, "订单服务");
  for (const invalid of [null, [], {}, { ...binding, command: "ls" }, { ...binding, table: "_lm_log_orders" },
    { ...binding, table: "log_orders; DROP TABLE users" }, { ...binding, table: "a".repeat(129) },
    { ...binding, service: " x" }, { ...binding, service: "" }, { ...binding, instance_id: "x\n" },
    { ...binding, service: "订".repeat(86) }, { ...binding, instance_id: "订".repeat(43) },
    { ...binding, service: "\ud800" }, { ...binding, instance_id: "x\u0085" }]) {
    assert.throws(() => validateTelemetryBinding(invalid), { message: "invalid_telemetry_binding" });
  }
});

test("bounded reader query parameterizes exact SDK selector/version and returns only a fixed summary", async () => {
  const f = fixture();
  const result = await f.query();
  assert.equal(result.state, "verified");
  assert.equal(result.observedSamples, 1);
  assert.equal(result.minSamples, 1);
  assert.equal(result.serviceId, "platform-service");
  assert.equal(result.serviceVersion, "v2");
  assert.deepEqual(result.selector, binding);
  assert.equal(Date.parse(result.from), Date.parse(from));
  assert.equal(Date.parse(result.to), Date.parse(from) + 300_000);
  assert.equal(Date.parse(result.deadline), Date.parse(from) + 360_000);
  assert.equal(result.checkedAt, now.toISOString());
  assert.equal(f.calls.length, 1);
  const { sql, params, signal } = f.calls[0];
  assert.match(sql, /^SELECT service, instance_id, service_version, event_time, ingested_at FROM `log_orders`/);
  assert.doesNotMatch(sql, /SELECT \*|\bbody\b|resource_json|FINAL/);
  assert.doesNotMatch(sql, /orders-sdk|node-a|v2/);
  assert.match(sql, /LIMIT 1000/);
  for (const constraint of ["max_execution_time=3", "max_memory_usage=67108864", "max_rows_to_read=1000000", "read_overflow_mode='throw'", "result_overflow_mode='throw'"])
    assert.ok(sql.includes(constraint));
  assert.deepEqual(params, { service: binding.service, instance: binding.instance_id, version: "v2", from: "2026-10-23 00:00:00", to: "2026-10-23 00:02:00.000", now: "2026-10-23 00:02:00.000" });
  assert.ok(signal);
  assert.equal(signal.aborted, false);
  assert.deepEqual(Object.keys(result).sort(), ["state", "serviceId", "deploymentId", "selector", "serviceVersion", "observedSamples", "minSamples", "from", "to", "deadline", "checkedAt", "code"].sort());
});

test("catalog validation rejects missing, system, aliases, internal and malformed public views before reader access", async () => {
  const unsafeTables = [[], [{ ...table, system: true }], [{ ...table, logical_name: "lightmoni" }],
    [{ ...table, logical_name: "unknown" }], [{ ...table, name: "_lm_log_orders" }],
    [{ ...table, kind: "invalid" }], [{ ...table, kind: "metric", metric_type: "weird" }],
    [{ ...table, is_compat_alias: 1 } as Table], [table, table],
    [{ ...table, columns: table.columns.filter(c => c.name !== "service_version") }],
    [{ ...table, columns: table.columns.map(c => c.name === "service" ? { ...c, type: "UInt64" } : c) }],
    [{ ...table, columns: table.columns.map(c => c.name === "event_time" ? { ...c, type: "DateTime64(9,'Asia/Shanghai')" } : c) }],
    [{ ...table, columns: table.columns.map(c => c.name === "instance_id" ? { ...c, nullable: true } : c) }],
  ];
  for (const tables of unsafeTables) {
    const f = fixture({ tables });
    assert.equal((await f.query()).state, "invalid");
    assert.equal(f.calls.length, 0);
  }
});

test("canonical metric and trace views with UTC columns are supported", async () => {
  for (const [kind, metric_type] of [["trace", ""], ["metric", "sum"], ["metric", "gauge"], ["metric", "histogram"]]) {
    const name = `${kind}_orders${metric_type ? "_" + metric_type : ""}`;
    const f = fixture({ tables: [{ ...table, name, kind, metric_type, columns: table.columns.map(c => c.name === "service" ? { ...c, type: "LowCardinality(String)" } : c) }] });
    assert.equal((await f.query({ binding: { ...binding, table: name } })).state, "verified");
  }
});

test("evidence recheck excludes wrong identity, version, before-window ingestion and future timestamps", async () => {
  const f = fixture({ rows: [
    { ...row, service: "platform-service" }, { ...row, instance_id: "other" }, { ...row, service_version: "v1" },
    { ...row, event_time: "2026-10-22 23:59:59.999999999" }, { ...row, event_time: "2026-10-23 00:05:00" },
    { ...row, event_time: "2026-10-23 00:02:00.000000001" },
    { ...row, ingested_at: "2026-10-22 23:59:59.999999999" },
    { ...row, ingested_at: "2026-10-23 00:02:00.000000001" }, { ...row, ingested_at: undefined },
    { ...row, event_time: "2026-02-30 00:00:30" },
  ] });
  const result = await f.query();
  assert.equal(result.state, "waiting");
  assert.equal(result.observedSamples, 0);
});

test("fixed windows remain unchanged on late retry and timeout can later verify delayed ingestion", async () => {
  const f = fixture({ rows: [] });
  const timedOut = await f.query({ now: new Date("2026-10-23T01:00:00Z") });
  assert.equal(timedOut.state, "timed_out");
  assert.equal(f.calls[0].params?.to, "2026-10-23 00:05:00");
  const later = fixture({ rows: [{ ...row, ingested_at: "2026-10-23 00:10:00" }] });
  const verified = await later.query({ now: new Date("2026-10-23T01:00:00Z") });
  assert.equal(verified.state, "verified");
  assert.equal(verified.deadline, timedOut.deadline);
  assert.equal(verified.to, timedOut.to);
});

test("now at or before window start skips both catalog and reader", async () => {
  const f = fixture();
  for (const time of [from, "2026-10-22T23:59:59Z"]) {
    const result = await f.query({ now: new Date(time) });
    assert.equal(result.state, "waiting");
  }
  assert.equal(f.catalogCalls, 0);
  assert.equal(f.calls.length, 0);
});

test("reader/catalog failures and cancellation are fixed unavailable summaries without SQL or raw errors", async () => {
  for (const failure of ["catalog", "query"] as const) {
    const result = await fixture({ failure }).query();
    assert.equal(result.state, "unavailable");
    assert.equal(result.code, "query_unavailable");
    assert.doesNotMatch(JSON.stringify(result), /secret|SELECT|credential|path/);
  }
  const controller = new AbortController();
  controller.abort(Error("secret cancellation"));
  const f = fixture();
  assert.equal((await f.query({ signal: controller.signal })).state, "unavailable");
  assert.equal(f.catalogCalls, 0);
});

test("invalid requests, inconsistent replies and oversized evidence cannot verify", async () => {
  for (const overrides of [{ finishedAt: "2026-02-30T00:00:00Z" }, { serviceId: "bad\nID" },
    { serviceVersion: "" }, { now: new Date("invalid") }, { binding: { ...binding, table: "a.b" } }]) {
    const f = fixture();
    assert.equal((await f.query(overrides)).state, "invalid");
    assert.equal(f.calls.length, 0);
    assert.equal(f.catalogCalls, 0);
  }
  assert.equal((await fixture({ count: 2 }).query()).state, "unavailable");
  const tooMany = await fixture({ rows: Array.from({ length: 1001 }, () => row) }).query();
  assert.equal(tooMany.state, "invalid");
  assert.equal(tooMany.code, "too_many_rows");
  assert.equal(tooMany.observedSamples, 0);
});
