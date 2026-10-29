import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/agent/agent.js";
import { defaultConfig, validateConfig, loadConfig } from "../src/agent/config.js";
import { execute } from "../src/agent/main.js";
import { formatNanoTime, nowNano } from "../src/shared/otlp.js";

test("Agent accepts node credentials without legacy key and uses audience-specific headers", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-agent-credential-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const seen: string[] = [];
  const agentIDs: string[] = [];
  const remote = {
    revision: "fixture-revision",
    collect_interval_seconds: 15,
    probes: [],
    host_enabled: false,
    host_collectors: [],
    host_table: "host",
    probe_table: "probe",
    process_names: [],
    group_id: "default",
    logs_enabled: false,
    log_table: "files",
    log_sources: [],
  };
  const server = createServer(async (req, res) => {
    const authorization = String(req.headers.authorization ?? "");
    if (req.headers["x-lightmoni-agent-id"])
      agentIDs.push(String(req.headers["x-lightmoni-agent-id"]));
    if (req.url === "/api/v1/agents/register" || req.url?.includes("/heartbeat")) {
      seen.push("control:" + authorization);
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.url?.includes("/config")) {
      seen.push("control:" + authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(remote));
      return;
    }
    if (req.url === "/v1/logs") {
      seen.push("data:" + authorization);
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const config = {
    ...defaultConfig(),
    endpoint,
    data_dir: dataDir,
    control_credential: "control-fixture",
    data_credential: "data-fixture",
    listen: "127.0.0.1:0",
    min_free_bytes: 0,
    collect_interval_seconds: 3600,
  };
  validateConfig(config);
  const agent = createAgent(config);
  t.after(() => agent.close());
  assert.equal(await agent.controlOnce(false), true);
  const batch: any = {
    id: randomUUID(),
    signal: "logs",
    table: "business",
    created_at: formatNanoTime(nowNano()),
    content_type: "application/json",
    payload: Buffer.from(JSON.stringify({ resourceLogs: [] })),
  };
  await agent.send(batch);
  assert(seen.some((header) => header === "control:Bearer control-fixture"));
  assert(seen.some((header) => header === "data:Bearer data-fixture"));
  assert(agentIDs.length >= 1);
});

test("Agent config requires both independent credentials and rejects shared keys", () => {
  const base = { ...defaultConfig(), endpoint: "https://monitor.example.test" };
  assert.throws(() => validateConfig({ ...base, control_credential: "only-control", data_credential: "" }), /both control_credential/);
  assert.throws(() => validateConfig({ ...base, key: "legacy-key" } as any), /shared key configuration is not supported/);
  assert.doesNotThrow(() => validateConfig(base, { pendingEnrollment: true }));
  assert.throws(() => validateConfig({...base, listen: "0.0.0.0:4318"}, {pendingEnrollment: true}), /requires local_token/);
});

test("pending enrollment only permits local configure/check and cannot start or inspect an Agent", async t => {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-agent-pending-"));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const path = join(dir, "config.json"), dataDir = join(dir, "data"), output:string[]=[];
  const io = {input:(async function*(){ throw Error("stdin must not be read"); })(),write:(value:string)=>output.push(value)};
  await execute(["configure","--config",path,"--endpoint","https://monitor.example.test","--require-data-dir",dataDir,"--pending-enrollment"],io);
  const saved = JSON.parse(readFileSync(path,"utf8"));
  assert.equal(saved.control_credential, ""); assert.equal(saved.data_credential, ""); assert.equal(Object.hasOwn(saved,"key"),false);
  assert.equal(existsSync(dataDir),false,"configure does not create an identity, spool, or service");
  assert.throws(() => loadConfig(path), /both control_credential/);
  await execute(["check","--config",path,"--require-data-dir",dataDir,"--pending-enrollment"],io);
  for(const command of ["run","status","quarantine","version"]){
    await assert.rejects(execute([command,"--config",path,"--pending-enrollment"],io), /only allowed for configure and check/);
    await assert.rejects(execute([command,"--config",path,"--pending-enrollment=false"],io), /only allowed for configure and check/);
  }
  await assert.rejects(execute(["run","--config",path],io), /both control_credential/);
  await assert.rejects(execute(["status","--config",path],io), /both control_credential/);
  await assert.rejects(execute(["configure","--config",path,"--key-stdin"],io), /unknown flag key-stdin/);
  assert.equal(existsSync(dataDir),false,"failed run and status do not initialize local Agent state");
  assert(output.some(value=>value.includes("configuration valid")));
});
