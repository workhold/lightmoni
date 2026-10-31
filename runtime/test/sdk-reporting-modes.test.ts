import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLightMoni, type LightMoni } from "@lightmoni/sdk";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { hash } from "../src/shared/crypto.js";
import { Auth } from "../src/server/auth.js";
import { Catalog } from "../src/server/catalog.js";
import { Ingest } from "../src/server/ingest.js";
import { createAgent } from "../src/agent/agent.js";
import { defaultConfig } from "../src/agent/config.js";
import { registerAgentCredentials } from "../src/server/agent-credentials.js";
import { createAgentHostSchema } from "../src/server/agent-hosts.js";

// Real HTTP, Auth, Ingest and Agent SQLite queue; only ClickHouse storage is
// replaced with a receipt sink, so this test does not claim live DB coverage.
test("SDK reports directly; Agent rejects SDK relay and queues only its own collection", { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-dual-route-"));
  const db = new DB(":memory:"), router = new Router();
  const auth = new Auth(db, directory, "http://127.0.0.1", router);
  router.auth = auth;
  const rows: { table: string; row: Record<string, any> }[] = [];
  const receipts: { batch: string; authorization: string }[] = [];
  const ch = {
    user: "test-writer",
    exec: async () => {},
    query: async () => ({ meta: [], data: [], rows: 0 }),
    insert: async (table: string, records: Record<string, any>[]) => {
      rows.push(...records.map(row => ({ table, row })));
    },
  };
  const catalog = new Catalog(db, ch, ch);
  const credentials = registerAgentCredentials({ db, router, auth, now: () => new Date(), externalURL: "http://127.0.0.1", logger: { error() {} } } as any);
  createAgentHostSchema(db);
  new Ingest(catalog, auth, undefined, credentials).register();
  for (const [id, secret] of [["business-key", "test-business-data"]]) {
    db.run("INSERT INTO ingest_keys(id,name,token_hash,created_at,allowed_tables_json) VALUES(?,?,?,?,?)", id, id, hash(secret), new Date().toISOString(), '["business"]');
  }
  let available = true;
  const server = createServer(async (req, res) => {
    if(req.url==="/v1/center-endpoints"){res.writeHead(404);res.end();return;}
    receipts.push({ batch: String(req.headers["x-lightmoni-batch-id"] ?? ""), authorization: String(req.headers.authorization ?? "") });
    if (!available) { req.resume(); res.writeHead(503); res.end(); return; }
    if (!(await router.handle(req, res))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  const config = {
    ...defaultConfig(), endpoint, data_credential: "test-node-data",
    control_credential: "test-node-control", local_token: "test-local-token",
    data_dir: join(directory, "agent"), listen: "127.0.0.1:0", min_free_bytes: 0,
  };
  let agent = createAgent(config);
  const at = new Date().toISOString(), expires = new Date(Date.now() + 3600_000).toISOString();
  // A trusted platform installation has already activated this host-bound
  // identity. This test exercises data delivery, rather than enrollment.
  db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES('delivery-host','Delivery host','delivery.example.test',22,'deploy','direct_ssh',?,?,?)", agent.identity.agent_id, at, at);
  db.run("INSERT INTO agent_enrollments(id,token_hash,endpoint_origin,allowed_arch_json,version,scopes_json,status,expires_at,created_at,created_by,agent_id,machine_id) VALUES('delivery-enrollment',?,'http://127.0.0.1','[]','0.1.0','[]','active',?,?,'fixture',?,'delivery-host')", hash("delivery-enrollment-token"), expires, at, agent.identity.agent_id);
  for (const [audience, secret] of [["control", "test-node-control"], ["data", "test-node-data"]])
    db.run("INSERT INTO agent_credentials(id,agent_id,audience,scope,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)", "agent-" + audience, agent.identity.agent_id, audience, "agent." + audience, hash(secret), at, expires);
  const clients: LightMoni[] = [];
  const record = async (client: LightMoni, service: string) => {
    client.counter("orders_created").add(1, { route: service });
    await client.withSpan("create_order", scoped => scoped.log("info", service, { route: service }));
    await client.flush({ timeoutMs: 3000 });
  };
  const common = { table: "business", selfTelemetry: false, remoteConfig: false, intervalMs: 3600000 };
  try {
    const address = await agent.listen();
    const agentEndpoint = `http://127.0.0.1:${(address as any).port}`;
    const direct = createLightMoni({ ...common, service: "direct-orders", endpoint, key: "test-business-data" });
    clients.push(direct);
    await record(direct, "direct-orders");
    assert.equal(agent.queue.stats().queue_batches, 0);
    assert.equal(receipts.length, 3);
    assert(receipts.every(r => r.authorization === "Bearer test-business-data"));
    const directRows = rows.filter(r => r.row.service === "direct-orders");
    assert.equal(directRows.length, 3);
    assert(directRows.every(r => r.row.key_id === "business-key" && !r.row.agent_id));

    const rejected=await fetch(agentEndpoint+"/v1/logs",{method:"POST",body:"{}",headers:{Authorization:"Bearer test-local-token"}});
    assert.equal(rejected.status,404);assert.equal(agent.queue.stats().queue_batches,0);
    available=false;
    agent.sdk.withTable("host").log("info","own collector");await agent.sdk.flush();
    assert.equal(agent.queue.stats().queue_batches,1);
    await agent.forwardOnce();assert.equal(agent.queue.stats().queue_batches,1);
    available=true;agent.queue.db.run("UPDATE batches SET next_ns=0");await agent.forwardOnce();
    assert.equal(agent.queue.stats().queue_batches,0);assert(rows.some(r=>r.row.service==="lightmoni-agent"));
  } finally {
    for (const client of clients) await client.shutdown({ timeoutMs: 100 }).catch(() => {});
    await agent.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
