import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentJobRunner } from "../src/agent/jobs.js";

test("Agent job runner reports an in-flight marker as unknown after restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-job-restart-"));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "agent-job-state.json"), JSON.stringify({ id: "job-1", lease_id: "lease-1", started_at: "2026-10-22T00:00:00.000Z" }));
  const calls: any[] = [];
  const runner = new AgentJobRunner({ endpoint: "http://center", agentID: "agent-1", controlCredential: "secret", dataDir }, {
    fetch: (async (url: any, init: any) => {
      calls.push({ url, init: JSON.parse(init.body) });
      return new Response(JSON.stringify({ state: "unknown" }), { status: 200 });
    }) as typeof fetch,
  });
  await runner.recoverUnknown();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.state, "unknown");
  assert.equal(calls[0].init.code, "unknown_execution_result");
  assert.equal(JSON.parse(readFileSync(join(dataDir, "agent-job-state.json"), "utf8")).id, undefined);
  assert.equal(existsSync(join(dataDir, "agent-job-state.json")), true);
});
