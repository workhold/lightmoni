import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createLightMoni } from "@lightmoni/sdk";
import { createAgent } from "../src/agent/agent.js";
import { defaultConfig } from "../src/agent/config.js";

const base = process.env.LIGHTMONI_DOMAINS_URL;
const agentID = process.env.LIGHTMONI_AGENT_LIVE_ID;
const controlCredential = process.env.LIGHTMONI_AGENT_LIVE_CONTROL_CREDENTIAL;
const dataCredential = process.env.LIGHTMONI_AGENT_LIVE_DATA_CREDENTIAL;
const missingHostBoundFixture = !agentID || !controlCredential || !dataCredential;
test(
  "live Node Agent persists SDK batches, reopens identity and forwards to real ClickHouse exactly once",
  { skip: !base ? "LIGHTMONI_DOMAINS_URL is not set" : missingHostBoundFixture ? "A predeployed registered-host Agent fixture requires LIGHTMONI_AGENT_LIVE_ID and independent CONTROL_CREDENTIAL/DATA_CREDENTIAL variables" : false, timeout: 30000 },
  async (t) => {
    let cookie = "";
    const request = async (
      path: string,
      method = "GET",
      body?: any,
      expected = 200,
    ) => {
      const response = await fetch(base! + path, {
        method,
        headers: { cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      assert.equal(
        response.status,
        expected,
        method + " " + path + ": " + text,
      );
      if (response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie")!.split(";")[0];
      return text ? JSON.parse(text) : undefined;
    };
    await request("/api/v1/auth/login", "POST", {
      name: process.env.LIGHTMONI_DOMAINS_USER || "node-qa-admin",
      password:
        process.env.LIGHTMONI_DOMAINS_PASSWORD || "node-qa-password-123",
    });
    const table = "qa_agent_" + randomBytes(4).toString("hex"),
      directory = mkdtempSync(join(tmpdir(), "lightmoni-agent-live-"));
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
    const machines = await request("/api/v1/machines");
    assert(machines.some((machine:any) => machine.agent_id===agentID), "The supplied Agent fixture must already belong to a registered host");
    writeFileSync(join(directory,"identity.json"),JSON.stringify({agent_id:agentID,host_id:randomUUID()}),{mode:0o600});
    const config = {
      ...defaultConfig(),
      listen: "127.0.0.1:0",
      endpoint: base!,
      control_credential: controlCredential!,
      data_credential: dataCredential!,
      local_token: "fixture-local-token",
      data_dir: directory,
      min_free_bytes: 0,
      collect_interval_seconds: 3600,
    };
    let agent = createAgent(config),
      client: ReturnType<typeof createLightMoni> | undefined;
      try {
      const address = await agent.listen(),
        endpoint = "http://127.0.0.1:" + (address as any).port;
      assert.equal((await fetch(endpoint + "/status")).status, 401);
      client = createLightMoni({
        service: table,
        table,
        endpoint,
        key: config.local_token,
        selfTelemetry: false,
        remoteConfig: false,
        intervalMs: 3600000,
      });
      client.counter("node_migration_total").add(9007199254740993n);
      await client.withSpan("qa-agent-operation", async (scoped) =>
        scoped.log("info", "node agent live fixture", {
          exact: 9007199254740993n,
        }),
      );
      await client.flush();
      assert.equal(agent.queue.stats().queue_batches, 3);
      const identity = { ...agent.identity },
        first = agent.queue.next()!;
      await client.shutdown();
      client = undefined;
      await agent.close();
      agent = createAgent(config);
      assert.deepEqual(agent.identity, identity);
      assert.equal(agent.queue.stats().queue_batches, 3);
      assert.equal(await agent.controlOnce(false), true);
      assert(agent.revision);
      for (let n = 0; n < 6 && agent.queue.stats().queue_batches; n++)
        await agent.forwardOnce();
      assert.equal(agent.queue.stats().queue_batches, 0, agent.lastError);
      assert.equal((await agent.send(first)).message, "");
      const nodes = await request("/api/v1/agents");
      assert(
        nodes.some(
          (node: any) =>
            node.agent_id === identity.agent_id ||
            node.id === identity.agent_id,
        ),
      );
      const now = Date.now();
      const result = await request("/api/v1/query", "POST", {
        range: {
          from: new Date(now - 60000).toISOString(),
          to: new Date(now + 60000).toISOString(),
        },
        interval_ms: 1000,
        queries: [
          {
            refId: "A",
            sql: `SELECT sum(toDecimal256(value_int,0)) AS exact FROM metric_${table}_sum WHERE name='node_migration_total'`,
          },
          {
            refId: "B",
            sql: `SELECT count() AS n, any(trace_id) AS trace FROM log_${table}`,
          },
          {
            refId: "C",
            sql: `SELECT count() AS n, any(trace_id) AS trace FROM trace_${table}`,
          },
        ],
      });
      for (const frame of result.results)
        assert(!frame.error, JSON.stringify(frame));
      const frames = result.results.map((r: any) => r.frames[0].rows[0]);
      assert.equal(String(frames[0][0]), "9007199254740993");
      assert.equal(String(frames[1][0]), "1");
      assert.equal(String(frames[2][0]), "1");
      assert.match(frames[1][1], /^[a-f0-9]{32}$/);
      assert.equal(frames[1][1], frames[2][1]);
    } finally {
      await client?.shutdown();
      await agent.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
