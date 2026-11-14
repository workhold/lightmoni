import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { defineCapability, validateCapabilityRegistry } from "../src/capabilities/descriptor.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import type { Dependencies, User } from "../src/shared/types.js";
import { taskHelperFixture } from "./helpers/task-helper.js";

const admin: User = { id: "admin", name: "Admin", role: "admin" };
function fixture() {
  const db = new DB(":memory:"); accountSchema(db);
  db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14')");
  const now = new Date("2026-11-14T00:00:00Z");
  const deps = { db, router: new Router(), now: () => now, externalURL: "https://moni.example.test",
    ...cipher(Buffer.alloc(32, 15)), cat: { list: async () => [] }, logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  const runs = new TaskRunStore(deps);
  for (const id of ["one", "two"]) db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'direct_ssh',?,?,?)", id, "Host " + id, id + ".test", "agent-" + id, now.toISOString(), now.toISOString());
  taskHelperFixture(deps, runs);
  runs.nodes.task({ name: "Fixture script", type: "script", enabled: true, target_all: false, host_ids: ["one"], label_ids: [],
    schedule: { mode: "once" }, script: { runtime: "node", code: "console.log('fixture')", timeout_seconds: 5, max_output_bytes: 4096 } }, "script-one", true);
  const principal: Principal = { user: admin, scopes: [...CAPABILITY_SCOPES], host_ids: null,
    credential_id: "token", grant_id: "grant", source: "mcp" };
  let validations = 0;
  const access = new CapabilityAccess(deps, {
    validate() { validations++; },
    validateGrant() { validations++; return structuredClone(principal); },
  });
  const dispatcher = new CapabilityDispatcher(deps, access, { taskCenter: runs });
  const invoke = (name: string, input: any, p = structuredClone(principal)) =>
    dispatcher.invoke(p, name, input, { signal: new AbortController().signal });
  return { db, runs, access, dispatcher, principal, invoke, validations: () => validations, close: () => db.close() };
}

test("every capability has a unique versioned descriptor and strict output contract", () => {
  const f = fixture();
  try {
    assert.equal(f.dispatcher.definitions.length, 15);
    for (const d of f.dispatcher.definitions) {
      assert.ok(d.id && d.version === 1 && d.outputSchema && d.targetResolver && d.limits && d.exposure && d.resultProjection);
      assert.equal(d.auditPolicy, "digest_only");
      assert.ok(d.risk && d.operationKind && d.executionMode && d.approvalPolicy && d.idempotencyPolicy);
    }
    validateCapabilityRegistry(f.dispatcher.definitions);
    assert.throws(() => validateCapabilityRegistry([f.dispatcher.definitions[0], f.dispatcher.definitions[0]]), /invalid capability registry/);
    assert.throws(() => defineCapability({ name: "unknown", description: "", inputSchema: {}, scope: "", effect: "read", execute: () => ({}) }), /Missing capability metadata/);
    const listed = f.dispatcher.list(f.principal);
    assert.ok(listed.every(d => d.outputSchema && d.version === 1));
  } finally { f.close(); }
});

test("exposure is enforced on discovery and direct invocation while host targets remain authorized", async () => {
  const f = fixture();
  try {
    const d = f.dispatcher.definitions.find(value => value.name === "lightmoni_hosts_get")!;
    d.exposure.mcp = false;
    assert.equal(f.dispatcher.list(f.principal).some(value => value.name === d.name), false);
    await assert.rejects(f.invoke(d.name, { id: "one" }), /capability_not_found/);
    const web = f.access.sessionPrincipal(admin, "web");
    const result = await f.invoke(d.name, { id: "one" }, web);
    assert.equal(result.data.host.id, "one");

    d.exposure.mcp = true;
    const scoped = { ...structuredClone(f.principal), scopes: ["hosts.read"], host_ids: ["two"] };
    await assert.rejects(f.invoke(d.name, { id: "one" }, scoped), /resource_not_found/);
  } finally { f.close(); }
});

test("output schema and size limits fail closed without returning unverified data", async () => {
  const f = fixture();
  try {
    const d = f.dispatcher.definitions.find(value => value.name === "lightmoni_hosts_get")!;
    d.outputSchema = { type: "object", properties: { missing: {type: "string"} }, required: ["missing"], additionalProperties: false };
    await assert.rejects(f.invoke(d.name, { id: "one" }), error => (error as any).status === 500 && (error as Error).message === "output_invalid");
    assert.equal(f.db.get<any>("SELECT code FROM capability_invocations WHERE capability=? ORDER BY rowid DESC LIMIT 1", d.name)!.code, "output_invalid");

    d.outputSchema = { type: "object", properties: { host: {type: "object", properties: {}, additionalProperties: true} }, required: ["host"], additionalProperties: false };
    d.limits.maxOutputBytes = 10;
    await assert.rejects(f.invoke(d.name, { id: "one" }), /result_too_large/);
    d.limits.maxOutputBytes = 64 << 10; d.limits.maxInputBytes = 1;
    await assert.rejects(f.invoke(d.name, { id: "one" }), /input_too_large/);
  } finally { f.close(); }
});

test("per-capability rate and concurrency limits are audited and release active slots", async () => {
  const f = fixture();
  try {
    const d = f.dispatcher.definitions.find(value => value.name === "lightmoni_hosts_list")!;
    d.limits.ratePerMinute = 1;
    await f.invoke(d.name, {});
    await assert.rejects(f.invoke(d.name, {}), /rate_limited/);
    d.limits.ratePerMinute = 120;

    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(r => { release = r; }), enteredSignal = new Promise<void>(r => { entered = r; });
    d.limits.concurrency = 1;
    d.execute = async () => { entered(); await waiting; return { hosts: [], total: 0, truncated: false, next_offset: null }; };
    const first = f.invoke(d.name, {});
    await enteredSignal;
    await assert.rejects(f.invoke(d.name, {}), /concurrency_limit/);
    release(); await first;
    assert.equal(f.db.get<any>("SELECT code FROM capability_invocations WHERE capability=? AND decision='denied' ORDER BY rowid DESC LIMIT 1", d.name)!.code, "concurrency_limit");
  } finally { f.close(); }
});

test("capability deadlines return a stable timeout and release concurrency", async () => {
  const f = fixture();
  try {
    const d = f.dispatcher.definitions.find(value => value.name === "lightmoni_hosts_list")!;
    d.limits.timeoutMs = 5;
    d.execute = (_p, _i, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(Error("fixture aborted")), { once: true });
    });
    await assert.rejects(f.invoke(d.name, {}), error => (error as any).status === 504 && (error as Error).message === "timeout");
    assert.equal(f.db.get<any>("SELECT code FROM capability_invocations WHERE capability=?", d.name)!.code, "timeout");
    d.limits.timeoutMs = 15_000; d.execute = async () => ({ hosts: [], total: 0, truncated: false, next_offset: null });
    assert.equal((await f.invoke(d.name, {})).status, "completed");
  } finally { f.close(); }
});

test("tool cursor pages are complete, reauthorized and bound to principal and catalog", () => {
  const f = fixture();
  try {
    const expected = f.dispatcher.list(f.principal).map(d => d.name);
    const actual: string[] = []; let cursor: string | undefined;
    do {
      const page = f.dispatcher.listPage(f.principal, cursor, 2);
      actual.push(...page.tools.map(d => d.name)); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(actual, expected);
    assert.ok(f.validations() >= expected.length / 2 + 1);

    const first = f.dispatcher.listPage(f.principal, undefined, 2);
    assert.throws(() => f.dispatcher.listPage(f.principal, "not-a-cursor", 2), /invalid_cursor/);
    assert.throws(() => f.dispatcher.listPage({ ...f.principal, credential_id: "other" }, first.nextCursor, 2), /invalid_cursor/);
    f.dispatcher.definitions[0].exposure.mcp = false;
    assert.throws(() => f.dispatcher.listPage(f.principal, first.nextCursor, 2), /invalid_cursor/);
  } finally { f.close(); }
});
