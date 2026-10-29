import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { registerManagedMachines } from "../src/server/managed-machines.js";
import type { Dependencies } from "../src/shared/types.js";

test("manual Agent association is retired and cannot execute SSH or mutate assets", async t => {
  const db = new DB(":memory:"), router = new Router(), user = { id: "admin", name: "Admin", role: "admin" };
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '')");
  const deps = { db, router, ...cipher(Buffer.alloc(32, 7)), now: () => new Date(), auth: {
    user: () => user, requireAdmin(ctx: any) { if (ctx.user.role !== "admin") fail(403, "administrator required"); },
  } } as unknown as Dependencies;
  router.auth = deps.auth;
  let calls = 0;
  const machines = registerManagedMachines(deps, { sshRunner: async () => { calls++; throw Error("must not execute"); } });
  const server = createServer(async (req, res) => { if (!await router.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { machines.close?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/v1/machines/old/agent-link`;
  for (const body of [{ agent_id: "node-one" }, { machine_id: "target", command: "id", credential_id: "secret" }]) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 410); assert.match((await response.json() as any).error, /手工关联 Agent 已移除/);
  }
  user.role = "member"; assert.equal((await fetch(url, { method: "POST" })).status, 403);
  assert.equal(calls, 0); assert.equal(db.get<any>("SELECT count(*) n FROM managed_machines")!.n, 0);
});
