import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfig,
  validateConfig,
  loadConfig,
} from "../src/agent/config.js";
import { ordinaryTaskCommand } from "../src/agent/task-runner.js";
import {
  assertTrustedAgentMetadata,
  requiresTrustedAgentStartup,
} from "../src/agent/entry.js";
import { managedSnapshotConfig } from "../src/privileged-executor/managed.js";
import {
  assertManagedAgentBinding,
  validateManagedAgentActivation,
} from "../src/agent/managed.js";
import { generateKeyPairSync, createHash } from "node:crypto";
import {
  executorPublicKey,
  type ExecutorConfig,
} from "../src/privileged-executor/config.js";
import { Agent } from "../src/agent/agent.js";
import { AgentTaskRunner } from "../src/agent/task-runner.js";
test("old Agent configuration defaults to user mode without implicit elevation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c: any = {
    ...defaultConfig(),
    endpoint: "https://center.test",
    control_credential: "control",
    data_credential: "data",
  };
  delete c.runtime_mode;
  delete c.permission_generation;
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(c));
  assert.equal(loadConfig(path).runtime_mode, "user");
  assert.equal(loadConfig(path).permission_generation, 1);
  for (const runtime_mode of ["root", "user"] as const)
    assert.doesNotThrow(() =>
      validateConfig({
        ...defaultConfig(),
        ...c,
        runtime_mode,
        permission_generation: 2,
      }),
    );
  for (const patch of [
    { runtime_mode: "sudo" },
    { permission_generation: 0 },
    { permission_generation: 1.5 },
  ])
    assert.throws(() => validateConfig({ ...defaultConfig(), ...c, ...patch }));
});
test("root bootstrap refuses mutable or non-root executable metadata", () => {
  assert.doesNotThrow(() =>
    assertTrustedAgentMetadata({ uid: 0, mode: 0o100755 }),
  );
  for (const info of [
    { uid: 999, mode: 0o100755 },
    { uid: 0, mode: 0o100775 },
    { uid: 0, mode: 0o100757 },
  ])
    assert.throws(() => assertTrustedAgentMetadata(info));
});
test("only execution entrypoints require installed root program ancestry", () => {
  for (const args of [
    [],
    ["run"],
    ["--config", "/etc/lightmoni-agent/config.json"],
    ["status"],
    ["quarantine"],
    ["managed-enroll"],
    ["managed-check"],
    ["managed-activate"],
  ])
    assert.equal(requiresTrustedAgentStartup(args), true);
  for (const command of ["configure", "check", "version"])
    assert.equal(requiresTrustedAgentStartup([command]), false);
});
test("managed operation workers load the unified Agent private configuration", () => {
  assert.equal(
    managedSnapshotConfig(
      "/var/lib/lightmoni-agent/managed/managed-jobs/" +
        "a".repeat(32) +
        ".json",
    ),
    "/etc/lightmoni-agent/managed.json",
  );
  assert.throws(() =>
    managedSnapshotConfig("/tmp/managed-jobs/" + "a".repeat(32) + ".json"),
  );
});
test("managed module binds Agent identity, endpoint and fixed private state directory", () => {
  const agent = {
    ...defaultConfig(),
    runtime_mode: "root" as const,
    data_dir: "/var/lib/lightmoni-agent",
    endpoint: "https://center.test",
  };
  const managed = {
    agent_id: "agent",
    endpoint: agent.endpoint,
    data_dir: "/var/lib/lightmoni-agent/managed",
  } as ExecutorConfig;
  assert.doesNotThrow(() => assertManagedAgentBinding(agent, managed, "agent"));
  for (const value of [
    { ...managed, agent_id: "other" },
    { ...managed, endpoint: "https://other.test" },
    { ...managed, data_dir: "/var/lib/lightmoni-executor" },
  ])
    assert.throws(() => assertManagedAgentBinding(agent, value, "agent"));
  assert.throws(() =>
    assertManagedAgentBinding(
      { ...agent, runtime_mode: "user" },
      managed,
      "agent",
    ),
  );
});
test("managed activation rejects changed generation, build and signing identity", () => {
  const agent = {
    ...defaultConfig(),
    runtime_mode: "root" as const,
    permission_generation: 3,
  };
  const key = generateKeyPairSync("ed25519");
  const managed = {
    agent_id: "agent",
    machine_id: "machine",
    executor_id: "internal-key",
    install_generation: 2,
    private_key: key.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  } as ExecutorConfig;
  const release = {
    version: "1",
    release: {
      build_id: "build",
      source_revision: "a".repeat(40),
      artifact_sha256: "b".repeat(64),
      state_schema: 1 as const,
    },
  };
  const record = {
    schema: 1,
    activation_id: "01234567-0123-4567-89ab-0123456789ab",
    permission_generation: 3,
    identity: {
      agent_id: managed.agent_id,
      machine_id: managed.machine_id,
      executor_id: managed.executor_id,
      install_generation: 2,
      public_key_sha256: createHash("sha256")
        .update(executorPublicKey(managed))
        .digest("hex"),
    },
    ...release,
  };
  assert.equal(
    validateManagedAgentActivation(record, agent, managed, release),
    record.activation_id,
  );
  for (const invalid of [
    { ...record, permission_generation: 2 },
    { ...record, identity: { ...record.identity, agent_id: "other" } },
    {
      ...record,
      release: { ...release.release, artifact_sha256: "c".repeat(64) },
    },
    { ...record, activation_id: "invalid" },
  ])
    assert.throws(() =>
      validateManagedAgentActivation(invalid, agent, managed, release),
    );
});
test("root Agent ordinary tasks explicitly drop identity, groups and capabilities", () => {
  const args = ["/var/tmp/task/supervisor.mjs", "node", "literal $(data)"];
  const command = ordinaryTaskCommand(
    "/opt/lightmoni-agent/current/node",
    args,
    { uid: 999, gid: 987 },
  );
  assert.equal(command.file, "/usr/bin/setpriv");
  assert.deepEqual(command.args, [
    "--reuid=999",
    "--regid=987",
    "--clear-groups",
    "--no-new-privs",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
    "/opt/lightmoni-agent/current/node",
    ...args,
  ]);
  for (const account of [
    { uid: 0, gid: 987 },
    { uid: 999, gid: 0 },
    { uid: NaN, gid: 987 },
  ])
    assert.throws(() => ordinaryTaskCommand("node", args, account));
  assert.deepEqual(ordinaryTaskCommand("node", args), { file: "node", args });
});
test("root Agent disables the old probe job worker while retaining ordinary script tasks", async (t) => {
  for (const runtime_mode of ["user", "root"] as const) {
    const data_dir = mkdtempSync(join(tmpdir(), "lightmoni-job-identity-"));
    const agent = new Agent({
      ...defaultConfig(),
      endpoint: "https://center.test",
      control_credential: "control",
      data_credential: "data",
      data_dir,
      runtime_mode,
      permission_generation: 3,
      min_free_bytes: 0,
    });
    try {
      assert.equal(!!agent.jobs, runtime_mode === "user");
      assert.ok(agent.taskRunner);
      assert.equal(agent.taskRunner.config.runtimeMode, runtime_mode);
      assert.equal(agent.taskRunner.config.permissionGeneration, 3);
    } finally {
      await agent.close();
      rmSync(data_dir, { recursive: true, force: true });
    }
  }
});
test("ordinary task runner refuses a different account, root privilege, or future generation before writing a crash marker", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-task-identity-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for (const execution_identity of [
    { account: "root", privilege: "user", permission_generation: 3 },
    { account: "lightmoni-agent", privilege: "root", permission_generation: 3 },
    { account: "lightmoni-agent", privilege: "user", permission_generation: 4 },
    { account: "lightmoni-agent", privilege: "user", permission_generation: 0 },
  ]) {
    const run = {
      id: "run",
      task_id: "task",
      host_id: "host",
      agent_id: "agent",
      lease_token: "a".repeat(64),
      snapshot: {
        task_id: "task",
        host_id: "host",
        agent_id: "agent",
        execution_identity,
        script: {
          runtime: "node",
          code: "throw Error('must not run')",
          timeout_seconds: 1,
          max_output_bytes: 4096,
        },
      },
    };
    const runner = new AgentTaskRunner(
      {
        endpoint: "https://center.test",
        agentID: "agent",
        controlCredential: "control",
        dataDir,
        permissionGeneration: 3,
      },
      { fetch: (async () => Response.json({ run })) as typeof fetch },
    );
    await assert.rejects(
      () => runner.pollOnce(),
      /ordinary_task_identity_mismatch/,
    );
    assert.equal(existsSync(join(dataDir, "task-run-state.json")), false);
  }
});
