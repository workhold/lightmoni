import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher, registerCapabilities } from "../src/capabilities/index.js";
import type { Principal } from "../src/capabilities/types.js";
import type { Dependencies, User } from "../src/shared/types.js";
import { taskHelperFixture } from "./helpers/task-helper.js";

const admin: User = { id: "admin", name: "Admin", role: "admin" };
const dispatch = { operation: "task.dispatch", task_id: "script-one", host_ids: ["one"], reason: "Run the reviewed fixture" };

function fixture() {
  const db = new DB(":memory:");
  accountSchema(db);
  db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14')");
  const now = new Date("2026-11-14T00:00:00Z");
  const deps = {
    db, router: new Router(), now: () => now, externalURL: "http://192.0.2.1",
    ...cipher(Buffer.alloc(32, 14)), cat: { list: async () => [] },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  const runs = new TaskRunStore(deps);
  db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES('one','Host one','one.test',22,'direct_ssh','agent-one',?,?)", now.toISOString(), now.toISOString());
  taskHelperFixture(deps, runs);
  runs.nodes.task({ name: "Fixture script", type: "script", enabled: true, target_all: false, host_ids: ["one"], label_ids: [],
    schedule: { mode: "once" }, script: { runtime: "node", code: "console.log('fixture')", timeout_seconds: 5, max_output_bytes: 4096 } }, "script-one", true);
  const access = new CapabilityAccess(deps);
  const dispatcher = new CapabilityDispatcher(deps, access, { taskCenter: runs });
  registerCapabilities(deps, dispatcher, access);
  return { db, deps, runs, access, dispatcher, close: () => db.close() };
}

test("capability core, HTTP registration and assistant tools work without MCP access", async () => {
  const f = fixture();
  try {
    assert.equal(f.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_access_grants'"), undefined);
    const routes = f.deps.router.list?.() ?? [];
    assert.ok(routes.some((route: any) => route.path === "/api/v1/capabilities"));
    assert.ok(routes.some((route: any) => route.path === "/api/v1/capabilities/:name/invoke"));

    const web = f.access.sessionPrincipal(admin, "web");
    const hosts = await f.dispatcher.invoke(web, "lightmoni_hosts_list", {}, { signal: new AbortController().signal });
    assert.deepEqual(hosts.data.hosts.map((host: any) => host.id), ["one"]);

    const list = f.dispatcher.assistantTools().find(tool => tool.name === "list_tasks")!;
    const result = await list.execute({ type: "script" }, new AbortController().signal, admin, { session_id: "session-one" });
    assert.ok(result.tasks.some((task: any) => task.id === "script-one"));
    const audit = f.db.get<any>("SELECT source,capability,decision FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_tasks_list'");
    assert.deepEqual(audit, { source: "assistant", capability: "lightmoni_tasks_list", decision: "allowed" });
  } finally { f.close(); }
});

test("session-authenticated capability HTTP discovery and invocation do not require MCP", async () => {
  const f = fixture();
  f.deps.router.auth = { user: () => admin } as any;
  const server = createServer((req, res) => {
    void f.deps.router.handle(req, res).then(found => {
      if (!found) { res.statusCode = 404; res.end(); }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const discovered = await fetch(base + "/api/v1/capabilities");
    assert.equal(discovered.status, 200);
    const tools = await discovered.json() as any[];
    assert.ok(tools.some(tool => tool.name === "lightmoni_tasks_list"));

    const invoked = await fetch(base + "/api/v1/capabilities/lightmoni_tasks_list/invoke", {
      method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ type: "script" }),
    });
    assert.equal(invoked.status, 200);
    const result = await invoked.json() as any;
    assert.ok(result.data.tasks.some((task: any) => task.id === "script-one"));
    assert.equal(f.db.get<any>("SELECT source FROM capability_invocations WHERE capability='lightmoni_tasks_list'")!.source, "web");

    const plan = { ...dispatch, idempotency_key: "http-operation" };
    const create = (body: any) => fetch(base + "/api/v1/capabilities/lightmoni_tasks_plan/invoke", {
      method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body),
    });
    assert.equal((await create(plan)).status, 200);
    const conflict = await create({ ...plan, reason: "Changed intention" });
    assert.equal(conflict.status, 409);
    const error = await conflict.json() as any;
    assert.equal(error.code, "conflict");
    assert.equal(error.detail_code, "idempotency_conflict");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.close();
  }
});

test("session principals refresh account role while missing MCP access cannot authorize an external principal", async () => {
  const f = fixture();
  try {
    const principal = f.access.sessionPrincipal(admin, "assistant");
    f.db.run("UPDATE users SET role='member' WHERE id='admin'");
    await assert.rejects(f.dispatcher.invoke(principal, "lightmoni_hosts_list", {}, { signal: new AbortController().signal }), /capability_forbidden/);
    assert.equal(principal.user.role, "member");
    assert.deepEqual(principal.scopes, ["telemetry.catalog.read", "telemetry.query", "alerts.read", "alerts.detail.read", "logs.read", "traces.read", "dashboards.read", "dashboards.detail.read"]);

    const external = { ...f.access.sessionPrincipal(admin, "web"), source: "mcp" as const, credential_id: "external", grant_id: "external" };
    await assert.rejects(f.dispatcher.invoke(external, "lightmoni_hosts_list", {}, { signal: new AbortController().signal }), error =>
      (error as any).status === 503 && /外部授权校验不可用/.test((error as Error).message));
  } finally { f.close(); }
});

test("external task proposals fail closed without MCP while native assistant approval remains unchanged", () => {
  const f = fixture();
  try {
    const external = f.dispatcher.proposals.createFrom(admin, { source: "mcp", grant_id: "external-grant" }, dispatch);
    assert.throws(() => f.dispatcher.proposals.apply(admin, external.id), error =>
      (error as any).status === 503 && /外部授权校验不可用/.test((error as Error).message));
    assert.equal(f.dispatcher.proposals.get(admin, external.id).status, "awaiting_approval");
    assert.equal(f.runs.list().length, 0);
    assert.equal(f.db.get<any>("SELECT count(*) n FROM assistant_task_audit")!.n, 0);

    const internal = f.dispatcher.proposals.create(admin, "session-one", dispatch);
    assert.equal(f.dispatcher.proposals.apply(admin, internal.id).status, "completed");
    assert.equal(f.runs.list().length, 1);
  } finally { f.close(); }
});

test("capability access delegates MCP credentials and stable grants without changing external proposals", async () => {
  const f = fixture();
  try {
    const principal: Principal = { user: admin, scopes: ["tasks.propose"], host_ids: null,
      credential_id: "external-token", grant_id: "external-grant", source: "mcp" };
    let validations = 0;
    const access = new CapabilityAccess(f.deps, {
      validate(value) { validations++; assert.equal(value.grant_id, principal.grant_id); },
      validateGrant(grantID, userID) {
        validations++; assert.equal(grantID, principal.grant_id); assert.equal(userID, admin.id);
        return structuredClone(principal);
      },
    });
    const dispatcher = new CapabilityDispatcher(f.deps, access, { taskCenter: f.runs });
    const created = await dispatcher.invoke(structuredClone(principal), "lightmoni_tasks_plan",
      { ...dispatch, idempotency_key: "external-operation" }, { signal: new AbortController().signal });
    const proposal = created.data.proposal;
    assert.equal(proposal.status, "awaiting_approval");
    assert.equal(f.runs.list().length, 0);
    assert.equal(dispatcher.proposals.apply(admin, proposal.id).status, "completed");
    assert.equal(f.runs.list().length, 1);
    assert.equal(validations, 2);
    assert.equal(f.db.get<any>("SELECT source FROM capability_invocations WHERE proposal_id=?", proposal.id)!.source, "mcp");
  } finally { f.close(); }
});
