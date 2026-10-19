import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLightMoni, createLightMoniFromEnv, type ConnectionMode } from "../src/index.js";

const connectionVariables = ["LIGHTMONI_MODE", "LIGHTMONI_ENDPOINT", "LIGHTMONI_DATA_KEY", "LIGHTMONI_DATA_KEY_FILE", "LIGHTMONI_KEY", "LIGHTMONI_AGENT_ENDPOINT", "LIGHTMONI_LOCAL_TOKEN", "LIGHTMONI_LOCAL_TOKEN_FILE"];

test("Agent local token is optional for parsed loopback hosts, including localhost and IPv6", async () => {
  const options = { service: "local-agent", table: "business", mode: "agent" as const, selfTelemetry: false, remoteConfig: false };
  for (const agentEndpoint of ["http://localhost:4318", "http://[::1]:4318", "http://127.0.0.2:4318", "https://127.0.0.1:4318"]) {
    const client = createLightMoni({ ...options, agentEndpoint });
    await client.shutdown();
  }
  for (const agentEndpoint of ["http://127.0.0.1.remote.example:4318", "http://127.0.0.1@remote.example:4318", "http://remote-agent:4318"]) {
    assert.throws(() => createLightMoni({ ...options, agentEndpoint }), /local token for non-loopback/);
  }
});
async function environment(values: Record<string, string>, run: () => void | Promise<void>) {
  const previous = new Map(connectionVariables.map(name => [name, process.env[name]]));
  for (const name of connectionVariables) delete process.env[name];
  Object.assign(process.env, values);
  try { await run(); } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}
async function receiver(t: TestContext) {
  const requests: { method?: string; path?: string; authorization?: string; batchId?: string; body: string }[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8"); req.on("data", chunk => body += chunk);
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, batchId: req.headers["x-lightmoni-batch-id"] as string | undefined, body });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(req.method === "GET" ? JSON.stringify({ revision: "local-fixture", log_sampling: {}, disable_rules: [] }) : "{}");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, status(value: number) { status = value; } };
}

test("explicit SDK routes isolate unused credentials and send telemetry/config only to the selected receiver", async t => {
  for (const mode of ["direct", "agent"] as const) await t.test(mode, async t => {
    const platform = await receiver(t), agent = await receiver(t);
    await environment({
      LIGHTMONI_MODE: mode, LIGHTMONI_ENDPOINT: platform.endpoint, LIGHTMONI_AGENT_ENDPOINT: agent.endpoint,
      LIGHTMONI_DATA_KEY: "data-key", LIGHTMONI_LOCAL_TOKEN: "local-token",
      ...(mode === "direct" ? { LIGHTMONI_LOCAL_TOKEN_FILE: "/missing-lightmoni-unused-local" } : { LIGHTMONI_DATA_KEY_FILE: "/missing-lightmoni-unused-data", LIGHTMONI_KEY: "conflicting-unused-legacy" }),
    }, async () => {
      const client = createLightMoniFromEnv({ service: "route-test", table: "business", selfTelemetry: false, remoteConfig: false,
        ...(mode === "direct" ? { localToken: "conflicting-unused-local" } : { key: "conflicting-unused-data" }),
      });
      try {
        await client.refreshConfig(); client.log("info", "selected route"); await client.flush();
        const selected = mode === "direct" ? platform : agent, unused = mode === "direct" ? agent : platform;
        assert.deepEqual(selected.requests.map(row => [row.method, row.path, row.authorization]), [
          ["GET", "/v1/sdk-config", `Bearer ${mode === "direct" ? "data-key" : "local-token"}`],
          ["POST", "/v1/logs", `Bearer ${mode === "direct" ? "data-key" : "local-token"}`],
        ]);
        assert.equal(unused.requests.length, 0); assert.equal(client.stats().selectedRoute, mode);
        assert.equal(client.stats().configRevision, "local-fixture");
      } finally { await client.shutdown(); }
    });
  });
});

test("selected credentials still reject missing files, source conflicts and invalid modes before reading secrets", async t => {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-connection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "secret"); writeFileSync(file, "file-value\n");
  for (const mode of ["direct", "agent"] as const) {
    const variable = mode === "direct" ? "LIGHTMONI_DATA_KEY" : "LIGHTMONI_LOCAL_TOKEN";
    const base = { LIGHTMONI_MODE: mode, LIGHTMONI_ENDPOINT: "http://127.0.0.1:1", LIGHTMONI_AGENT_ENDPOINT: "http://127.0.0.1:2" };
    await environment({ ...base, [`${variable}_FILE`]: "/missing-lightmoni-selected-secret" }, () => {
      assert.throws(() => createLightMoniFromEnv({ service: "route-test", table: "business" }), /ENOENT|file/);
    });
    await environment({ ...base, [variable]: "env-value", [`${variable}_FILE`]: file }, () => {
      assert.throws(() => createLightMoniFromEnv({ service: "route-test", table: "business" }), /credential_source_conflict/);
    });
    await environment({ ...base, [variable]: "env-value" }, () => {
      assert.throws(() => createLightMoniFromEnv({ service: "route-test", table: "business", ...(mode === "direct" ? { key: "explicit-value" } : { localToken: "explicit-value" }) }), /credential_source_conflict/);
    });
  }
  await environment({ LIGHTMONI_MODE: "invalid", LIGHTMONI_DATA_KEY_FILE: "/missing-data", LIGHTMONI_LOCAL_TOKEN_FILE: "/missing-local" }, () => {
    assert.throws(() => createLightMoniFromEnv({ service: "route-test", table: "business" }), /mode must be/);
  });
  await environment({ LIGHTMONI_MODE: "direct", LIGHTMONI_ENDPOINT: "http://127.0.0.1:1", LIGHTMONI_DATA_KEY: "new", LIGHTMONI_KEY: "old" }, () => {
    assert.throws(() => createLightMoniFromEnv({ service: "route-test", table: "business" }), /credential_source_conflict: LIGHTMONI_KEY/);
  });
  await environment({ LIGHTMONI_MODE: "auto", LIGHTMONI_LOCAL_TOKEN_FILE: "/missing-auto-secret" }, () => {
    assert.throws(() => createLightMoniFromEnv({ service: "route-test", table: "business" }), /ENOENT|file/);
  });
});

test("explicit route failures retry the same batch without contacting the other receiver", async t => {
  for (const mode of ["direct", "agent"] as const) await t.test(mode, async t => {
    const platform = await receiver(t), agent = await receiver(t);
    const selected = mode === "direct" ? platform : agent, unused = mode === "direct" ? agent : platform;
    selected.status(503);
    await environment({ LIGHTMONI_MODE: mode, LIGHTMONI_ENDPOINT: platform.endpoint, LIGHTMONI_DATA_KEY: "data-key", LIGHTMONI_AGENT_ENDPOINT: agent.endpoint, LIGHTMONI_LOCAL_TOKEN: "local-token" }, async () => {
      const client = createLightMoniFromEnv({ service: "retry-test", table: "business", selfTelemetry: false, remoteConfig: false, retryMinMs: 1, retryMaxMs: 2 });
      try {
        client.log("info", "retained batch"); await assert.rejects(client.flush({ timeoutMs: 50 }), /timeout/);
        assert.ok(selected.requests.length > 0); assert.equal(unused.requests.length, 0);
        selected.status(200); await client.flush();
        assert.ok(selected.requests.every(row => row.method === "POST" && row.path === "/v1/logs"));
        assert.equal(new Set(selected.requests.map(row => row.batchId)).size, 1);
        assert.equal(new Set(selected.requests.map(row => row.body)).size, 1);
        assert.equal(unused.requests.length, 0);
      } finally { selected.status(200); await client.shutdown(); }
    });
  });
});

test("explicit agent configuration stays on Agent while auto retains its separate config endpoint", async t => {
  const platform = await receiver(t), agent = await receiver(t);
  for (const mode of ["agent", "auto"] as ConnectionMode[]) {
    const client = createLightMoni({ service: "config-route", table: "business", mode, endpoint: platform.endpoint,
      configEndpoint: platform.endpoint, key: "data-key", agentEndpoint: agent.endpoint, localToken: "local-token", selfTelemetry: false, remoteConfig: false });
    try {
      const platformBefore = platform.requests.length, agentBefore = agent.requests.length;
      await client.refreshConfig();
      const selected = mode === "agent" ? agent : platform;
      assert.equal(selected.requests.at(-1)?.authorization, `Bearer ${mode === "agent" ? "local-token" : "data-key"}`);
      assert.equal(platform.requests.length - platformBefore, mode === "agent" ? 0 : 1);
      assert.equal(agent.requests.length - agentBefore, mode === "agent" ? 1 : 0);
    } finally { await client.shutdown(); }
  }
  const custom = createLightMoni({ service: "custom-config", table: "business", mode: "agent", exporter: { async deliver() {} }, configEndpoint: platform.endpoint, key: "custom-config-key", selfTelemetry: false, remoteConfig: false });
  try {
    const before = agent.requests.length;
    await custom.refreshConfig();
    assert.equal(platform.requests.at(-1)?.authorization, "Bearer custom-config-key");
    assert.equal(agent.requests.length, before);
  } finally { await custom.shutdown(); }
});

test("fromEnv preserves a custom exporter's explicit config credentials without reading direct secrets", async t => {
  const platform = await receiver(t), agent = await receiver(t);
  for (const address of ["configEndpoint", "endpoint"] as const) {
    await environment({ LIGHTMONI_MODE: "agent", LIGHTMONI_ENDPOINT: "http://unused-platform:1", LIGHTMONI_DATA_KEY: "unused-data-key", LIGHTMONI_DATA_KEY_FILE: "/missing-unused-data-key", LIGHTMONI_KEY: "unused-legacy-key", LIGHTMONI_AGENT_ENDPOINT: agent.endpoint }, async () => {
      let deliveries = 0;
      const client = createLightMoniFromEnv({ service: "custom-from-env", table: "business", exporter: { async deliver() { deliveries++; } }, [address]: platform.endpoint, key: "custom-config-key", selfTelemetry: false, remoteConfig: false });
      try {
        await client.refreshConfig(); client.log("info", "custom delivery"); await client.flush();
        assert.equal(platform.requests.at(-1)?.authorization, "Bearer custom-config-key");
        assert.equal(platform.requests.at(-1)?.path, "/v1/sdk-config");
        assert.equal(agent.requests.length, 0);
        assert.equal(deliveries, 1);
      } finally { await client.shutdown(); }
    });
  }
});
