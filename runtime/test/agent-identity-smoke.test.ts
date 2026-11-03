import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { AgentTaskRunner } from "../src/agent/task-runner.js";
import { ordinaryTaskRunnerStatus } from "../src/agent/managed.js";
import { ExecutorClient } from "../src/privileged-executor/client.js";
import { ExecutorJournal } from "../src/privileged-executor/journal.js";
import { assertAgentRuntimeIdentity } from "../src/shared/execution-role.js";
import { EXECUTOR_SIGNATURE_HEADER, verifyJWS } from "../src/shared/privileged-executor.js";

test("both Agent modes run as an ordinary non-root OS identity", () => {
  for (const mode of ["root", "user"] as const) {
    assert.deepEqual(assertAgentRuntimeIdentity(mode, 3, 1001, 1001, 1001, "linux"), {
      mode, permission_generation: 3, uid: 1001, gid: 1001,
    });
  }
});

test("helper reports persisted ordinary task recovery state", () => {
  assert.deepEqual(ordinaryTaskRunnerStatus({}), { active: false, state: "idle" });
  assert.deepEqual(ordinaryTaskRunnerStatus({ id: "01234567-0123-4567-89ab-0123456789ab", lease_token: "b".repeat(64) }),
    { active: true, state: "running", run_id: "01234567-0123-4567-89ab-0123456789ab" });
  assert.deepEqual(ordinaryTaskRunnerStatus({ id: "01234567-0123-4567-89ab-0123456789ab", lease_token: "b".repeat(64), receipt: {
    lease_token: "b".repeat(64), state: "unknown", code: "control_lost", summary: "review", stdout: "", stderr: "", exit_code: null,
  } }), { active: true, state: "result_pending", run_id: "01234567-0123-4567-89ab-0123456789ab" });
});

test("full-management helper claims tasks with its signed executor identity", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-helper-identity-smoke-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519");
  const config = {
    endpoint: "https://center.example.test", center_instance_id: "center", executor_id: "executor",
    install_generation: 4, private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  } as any;
  const journal = new ExecutorJournal(dataDir, Buffer.alloc(32, 7), true);
  t.after(() => journal.close());
  const headers: Record<string, string>[] = [];
  const client = new ExecutorClient(config, journal, async (_url, options) => {
    headers.push(options.headers);
    return { run: null };
  });
  const runner = new AgentTaskRunner({
    endpoint: config.endpoint, agentID: "agent", executorID: config.executor_id, executorInstallGeneration: 4,
    permissionGeneration: 3, dataDir,
    executionIdentity: { account: "lightmoni-task", uid: 1001, gid: 1001, permission_generation: 3 },
  }, {
    request: (route, body, signal, slot) => client.request(route, body, slot, signal),
    clearRequest: slot => journal.clearRequest(slot),
  });

  assert.equal(await runner.pollOnce(), null);
  assert.equal(headers.length, 1);
  const claims = verifyJWS(headers[0][EXECUTOR_SIGNATURE_HEADER], pair.publicKey, "executor") as any;
  assert.equal(claims.path, "/api/v1/privileged-executors/executor/task-runs/claim");
  assert.equal(journal.hasRequest("task-runs-claim"), false);
});
