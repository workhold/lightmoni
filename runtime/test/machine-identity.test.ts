import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultConfig, loadConfig, validateConfig } from "../src/agent/config.js";
import { execute } from "../src/agent/main.js";
import { createAgent } from "../src/agent/agent.js";
import { decodeOTLP, resourceString } from "../src/shared/otlp.js";
import { agentBootstrapCommand } from "../src/server/machine-agent-lifecycle.js";

test("public machine metadata survives configure and Agent SDK reports it without replacing persistent identity", async t => {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-machine-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json"), name = "用户的主机 ' $HOME `literal`";
  await execute(["configure", "--config", path, "--endpoint", "http://127.0.0.1:1", "--require-data-dir", dir,
    "--machine-id", "machine_01", "--machine-name", name, "--key-stdin"], {
    input: (async function* () { yield "fixture-key"; })(), write() {},
  });
  const cfg = loadConfig(path);
  assert.equal(cfg.machine_id, "machine_01"); assert.equal(cfg.machine_name, name);
  const agent = createAgent({ ...cfg, listen: "127.0.0.1:0", min_free_bytes: 0 });
  const identity = { ...agent.identity };
  try {
    agent.applyRemote({ revision: "machine-identity-1", collect_interval_seconds: 15, host_collectors: ["memory"] });
    await agent.collectOnce();
    const batch = agent.queue.next()!;
    assert(batch);
    const data = decodeOTLP("metrics", batch.payload, batch.content_type);
    const resource = data.resourceMetrics[0].resource;
    assert.equal(resourceString(resource, "lightmoni.machine.id"), "machine_01");
    assert.equal(resourceString(resource, "lightmoni.machine.name"), name);
    assert.equal(resourceString(resource, "host.id"), identity.host_id);
    assert.notEqual(identity.host_id, "machine_01");
  } finally { await agent.close(); }
  await execute(["configure", "--config", path, "--group-id", "updated"], { input: (async function* () {})(), write() {} });
  assert.equal(loadConfig(path).machine_name, name);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "identity.json"), "utf8")), identity);
});

test("machine bootstrap quotes literal metadata and rejects invalid identifiers/control characters", () => {
  const name = "中文主机 ' $(touch /not-executed) `literal`";
  const command = agentBootstrapCommand("https://monitor.example", "0.1.0", { machine_id: "machine_01", machine_name: name });
  assert.match(command, /--machine-id/); assert.match(command, /--machine-name/);
  const parsed = spawnSync("/bin/sh", ["-n", "-c", command], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  for (const machine of [{ machine_id: "../unsafe", machine_name: "ok" }, { machine_id: "ok", machine_name: "line\nbreak" }, { machine_id: "ok", machine_name: "bad\u0085name" }, { machine_id: "ok", machine_name: "中".repeat(43) }]) {
    assert.throws(() => agentBootstrapCommand("https://monitor.example", "0.1.0", machine), /machine metadata/);
    assert.throws(() => validateConfig({ ...defaultConfig(), endpoint: "http://localhost", key: "fixture", ...machine }), /machine metadata/);
  }
});
