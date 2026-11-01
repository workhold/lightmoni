import { test } from "node:test";
import assert from "node:assert/strict";
import { operationTools } from "../src/assistant/operation-tools.js";
import { websiteDefinition } from "../src/operations/websites.js";
import { composeDefinition } from "../src/operations/containers.js";
import { registerOperations } from "../src/server/operations.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { DB } from "../src/shared/sqlite.js";
import { HTTPError, Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import type { Dependencies } from "../src/shared/types.js";
import type { OperationResource, OperationsStore } from "../src/operations/types.js";

const admin = { id: "admin", role: "admin" }, signal = new AbortController().signal;
const resource = (config: Record<string, any>, kind: OperationResource["kind"] = "website", id = "site-one"): OperationResource => ({
  id, kind, name: id, agent_id: "agent-one", revision: 1, config, created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z",
});
const tool = (store: Partial<OperationsStore>, name: string) => operationTools(store as OperationsStore).find(value => value.name === name)!;

test("AI summarizes maximum-size website and Compose bodies without forwarding their contents", async () => {
  const body = "private static body ".repeat(27_000).slice(0, 512 * 1024);
  const site = resource(websiteDefinition.validate({ domains: ["example.test"], mode: "static", static_files: { "index.html": body } }));
  const config = composeDefinition.validate({ project_name: "app", compose: { services: { app: { image: "node:24", environment: { PASSWORD: "private-env-value" }, command: ["private-command-value"], labels: { note: "private-label-value" }, healthcheck: { test: ["CMD", "private-healthcheck-value"] } } }, volumes: { data: {} } } });
  const compose = resource(composeDefinition.publicConfig(config), "compose", "compose-one");
  const result = await tool({ list: () => [site, compose] }, "list_operations_resources").execute({}, signal, admin);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 28 * 1024);
  assert.deepEqual(result.resources[0].config.static_files_summary, { file_count: 1, content_bytes: Buffer.byteLength(body), body_omitted: true });
  assert.equal(result.resources[0].config.static_files, undefined);
  assert.equal(result.resources[1].config.compose, undefined);
  assert.deepEqual(result.resources[1].config.compose_summary.services, [{ name: "app", image: "node:24" }]);
  assert.equal(result.resources[1].config.compose_summary.volume_count, 1);
  for (const secret of ["private static body", "private-env-value", "private-command-value", "private-label-value", "private-healthcheck-value"]) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(site.config.static_files["index.html"], body, "model summaries must not mutate saved data");
  const run = { id: "run-one", operation: "apply", state: "awaiting_approval", preview: { resource: site }, receipt: null, review_url: "/operations?run=run-one" };
  const got = await tool({ getRun: () => run }, "get_operations_run").execute({ id: run.id }, signal, admin);
  assert.equal(got.run.preview.resource.config.static_files, undefined);
  assert.equal(got.run.preview.resource.config.static_files_summary.content_bytes, Buffer.byteLength(body));
  assert.equal(run.preview.resource.config.static_files["index.html"], body);
});

test("AI resource pagination fits the context budget and provides an offset without skipping resources", async () => {
  const domains = Array.from({ length: 30 }, (_, i) => `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${i}.test`);
  const saved = Array.from({ length: 50 }, (_, i) => resource({ domains, mode: "static" }, "website", `site-${i}`));
  const list = tool({ list: () => saved }, "list_operations_resources");
  const ids: string[] = [];
  let offset: number | null = 0, pages = 0;
  while (offset !== null) {
    const result = await list.execute({ offset, limit: 50 }, signal, admin);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 28 * 1024);
    assert.equal(result.total, 50);
    assert.equal(result.returned, result.resources.length);
    assert.ok(result.returned > 0);
    ids.push(...result.resources.map((r: OperationResource) => r.id));
    offset = result.next_offset;
    if (++pages > 50) assert.fail("pagination did not advance");
  }
  assert.ok(pages > 1);
  assert.deepEqual(ids, saved.map(r => r.id));
});

test("AI truncates known receipt lists explicitly while preserving current CAS evidence and the saved receipt", async () => {
  const history = Array.from({ length: 100 }, (_, i) => ({ generation: i + 1, description: "historical version ".repeat(20) }));
  const backups = Array.from({ length: 100 }, (_, i) => ({ backup_id: `backup-${i}`, object_version: "v".repeat(128), sha256: "a".repeat(64) }));
  const run = { id: "run-one", resource_id: "backup-one", state: "succeeded", operation: "inspect", receipt: { snapshot: { operations: { resource_id: "backup-one", operation_id: "run-one", data: { generation: 100, inventory_sha256: "b".repeat(64), current_target_sha256: "c".repeat(64), history, backups } } } }, review_url: "/operations?run=run-one" };
  const result = await tool({ getRun: () => run }, "get_operations_run").execute({ id: run.id }, signal, admin);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 28 * 1024);
  const data = result.run.receipt.snapshot.operations.data;
  assert.equal(data.generation, 100);
  assert.equal(data.inventory_sha256, "b".repeat(64));
  assert.equal(data.current_target_sha256, "c".repeat(64));
  assert.equal(result.run.receipt.snapshot.operations.operation_id, run.id);
  assert.ok(data.history.length < 100);
  assert.equal(data.history.at(-1).generation, 100);
  assert.deepEqual(result.run.model_truncated_lists.history, { received: 100, returned: data.history.length });
  assert.equal(history.length, 100);
  assert.equal(backups.length, 100);
});

test("AI rejects a legacy large-site proposal before persisting a run or ordinary Agent job", async t => {
  const db = new DB(":memory:"), crypto = cipher(Buffer.alloc(32, 9));
  const deps = { db, router: new Router(), ...crypto, now: () => new Date("2026-10-27T00:00:00Z") } as unknown as Dependencies;
  const credentials = { has: () => true } as any, jobs = registerAgentJobs(deps, { agentCredentials: credentials });
  const ops = registerOperations(deps, { definitions: [websiteDefinition], credentials, jobs });
  t.after(() => { ops.close?.(); jobs.close?.(); db.close(); });
  const config = websiteDefinition.validate({ domains: ["example.test"], mode: "static", static_files: { "index.html": "x".repeat(512 * 1024) } });
  db.run("INSERT INTO ops_resources(id,kind,name,agent_id,revision,config_cipher,created_at,updated_at,created_by) VALUES(?,?,?,?,1,?,?,?,?)", "site-one", "website", "Site", "agent-one", crypto.encrypt(JSON.stringify(config)), "", "", "admin");
  const saved = db.get<any>("SELECT * FROM ops_resources WHERE id='site-one'");
  deps.decrypt = () => { throw Error("retired proposals must not decrypt saved website bodies"); };
  await assert.rejects(
    tool(ops, "propose_operations_action").execute({ resource_id: "site-one", operation: "apply" }, signal, admin),
    error => error instanceof HTTPError && error.status === 409 && error.message === "privileged_profile_not_implemented",
  );
  assert.equal(db.get<any>("SELECT count(*) n FROM ops_runs").n, 0);
  assert.equal(db.get<any>("SELECT count(*) n FROM agent_jobs").n, 0);
  assert.deepEqual(db.get("SELECT * FROM ops_resources WHERE id='site-one'"), saved);
  assert.equal(JSON.parse(crypto.decrypt(saved.config_cipher)).static_files["index.html"].length, 512 * 1024);
});

test("AI omits whole sensitive log receipts and rejects members before reading or drafting", async () => {
  const run = { id: "run-one", operation: "inspect", state: "succeeded", receipt: { snapshot: { operations: { data: { sensitive_logs: true, logs: "private application password" } } } }, review_url: "/operations?run=run-one" };
  let calls = 0;
  const store = { getRun: () => { calls++; return run; }, list: () => { calls++; return []; }, plan: () => { calls++; return run; } };
  const result = await tool(store, "get_operations_run").execute({ id: run.id }, signal, admin);
  assert.equal(result.run.receipt, null);
  assert.ok(result.run.receipt_omitted);
  assert.equal(JSON.stringify(result).includes("private application password"), false);
  assert.ok(run.receipt);
  const member = { id: "member", role: "member" };
  for (const name of ["list_operations_resources", "get_operations_run", "propose_operations_action"]) await assert.rejects(tool(store, name).execute({}, signal, member), /administrator required/);
  assert.equal(calls, 1);
});
