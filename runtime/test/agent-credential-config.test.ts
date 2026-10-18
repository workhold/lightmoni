import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/agent/agent.js";
import { defaultConfig, validateConfig } from "../src/agent/config.js";
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
    key: "",
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

test("Agent config rejects only one node credential and keeps legacy key compatibility", () => {
  const base = { ...defaultConfig(), endpoint: "https://monitor.example.test" };
  assert.throws(() => validateConfig({ ...base, key: "", control_credential: "only-control", data_credential: "" }), /both control_credential/);
  assert.doesNotThrow(() => validateConfig({ ...base, key: "legacy-key", control_credential: "", data_credential: "" }));
});
