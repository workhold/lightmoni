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
test("SDK direct and Agent routes coexist; Agent ACK survives restart before platform delivery", { timeout: 15000 }, async () => {
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

    // The center is unavailable. A local durable ACK still lets the SDK finish.
    available = false;
    const relayed = createLightMoni({ ...common, service: "agent-orders", endpoint:agentEndpoint, key:"test-local-token" });
    clients.push(relayed);
    await record(relayed, "agent-orders");
    assert.equal(receipts.length, 3, "SDK Agent route must not contact the platform directly");
    assert.equal(agent.queue.stats().queue_batches, 3);
    await relayed.shutdown({ timeoutMs: 1000 });
    const identity = { ...agent.identity };
    const queuedIDs = agent.queue.db.all<{ id: string }>("SELECT id FROM batches ORDER BY id").map(b => b.id);
    await agent.close();
    agent = createAgent(config);
    assert.deepEqual(agent.identity, identity);
    assert.equal(agent.queue.stats().queue_batches, 3);
    await agent.forwardOnce();
    assert.equal(agent.queue.stats().queue_batches, 3, "failed upstream send must retain all batches");
    assert.equal(receipts.at(-1)?.authorization, "Bearer test-node-data");

    available = true;
    // Advance the retry eligibility without sleeping through the backoff.
    agent.queue.db.run("UPDATE batches SET next_ns=0");
    for (let n = 0; n < 3; n++) await agent.forwardOnce();
    assert.equal(agent.queue.stats().queue_batches, 0, agent.lastError);
    assert.deepEqual(receipts.slice(-3).map(r => r.batch).sort(), queuedIDs);
    assert(receipts.slice(-3).every(r => r.authorization === "Bearer test-node-data"));
    const agentRows = rows.filter(r => r.row.service === "agent-orders");
    assert.equal(agentRows.length, 3);
    assert(agentRows.every(r => r.row.key_id === "agent-data" && r.row.agent_id === identity.agent_id && r.row.host_id === identity.host_id));
    for (const service of ["direct-orders", "agent-orders"]) {
      const log = rows.find(r => r.table === "_lm_log_business" && r.row.service === service)!.row;
      const span = rows.find(r => r.table === "_lm_trace_business" && r.row.service === service)!.row;
      assert.equal(log.trace_id, span.trace_id);
      assert.equal(log.span_id, span.span_id);
    }
  } finally {
    for (const client of clients) await client.shutdown({ timeoutMs: 100 }).catch(() => {});
    await agent.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
