import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  canonicalJSON,
  parseStrictJSON,
  strictRecord,
} from "../shared/privileged-executor.js";
import {
  MANAGED_AGENT_CONFIG,
  MANAGED_AGENT_DATA_DIR,
  loadConfig,
  newConfig,
  parseBootstrap,
  saveInitialConfig,
  executorPublicKey,
  type ExecutorConfig,
} from "../privileged-executor/config.js";
import {
  boundedFile,
  durableWrite,
  refuse,
  rootPath,
  sha256,
  assertRoot,
} from "../privileged-executor/security.js";
import { readExecutorRelease } from "../privileged-executor/release.js";
import { ExecutorJournal } from "../privileged-executor/journal.js";
import { ExecutorClient } from "../privileged-executor/client.js";
import { PrivilegedExecutorRunner } from "../privileged-executor/runner.js";
import { executorStatus } from "../privileged-executor/status.js";
import { inspectManagedDockerDaemon } from "../privileged-executor/docker.js";
import type { Config } from "./config.js";

export const MANAGED_AGENT_ACTIVATION =
  "/etc/lightmoni-agent/managed-activation.json";
/** Root never imports mutable Agent plugins or runs code owned by its task user. */
export function assertRootAgentProgram(
  directory = dirname(fileURLToPath(import.meta.url)),
): void {
  assertRoot();
  rootPath(realpathSync(process.execPath));
  const walk = (path: string) => {
    rootPath(path, lstatSync(path).isDirectory() ? "directory" : "file");
    if (lstatSync(path).isDirectory())
      for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(dirname(directory));
}
export function assertManagedAgentBinding(
  agent: Config,
  config: ExecutorConfig,
  agentID: string,
): void {
  if (
    agent.runtime_mode !== "root" ||
    agent.data_dir !== "/var/lib/lightmoni-agent" ||
    config.data_dir !== MANAGED_AGENT_DATA_DIR ||
    config.agent_id !== agentID ||
    config.endpoint !==
      (agent.endpoint.endsWith("/")
        ? agent.endpoint.slice(0, -1)
        : agent.endpoint)
  )
    refuse("managed_agent_binding_mismatch");
}
function managedConfig(agent: Config): ExecutorConfig {
  if (
    agent.runtime_mode !== "root" ||
    agent.data_dir !== "/var/lib/lightmoni-agent"
  )
    refuse("managed_agent_requires_root_mode");
  const config = loadConfig(MANAGED_AGENT_CONFIG);
  const id = parseStrictJSON(
    boundedFile(join(agent.data_dir, "identity.json"), 8192, true),
    8192,
  ) as { agent_id?: string };
  assertManagedAgentBinding(agent, config, id.agent_id ?? "");
  return config;
}
function activationIdentity(config: ExecutorConfig) {
  return {
    agent_id: config.agent_id,
    machine_id: config.machine_id,
    executor_id: config.executor_id,
    install_generation: config.install_generation,
    public_key_sha256: sha256(executorPublicKey(config)),
  };
}
export function activateManagedAgent(agent: Config): string {
  assertRoot();
  const config = managedConfig(agent),
    release = readExecutorRelease();
  const activation_id = randomUUID();
  durableWrite(
    MANAGED_AGENT_ACTIVATION,
    canonicalJSON({
      schema: 1,
      activation_id,
      permission_generation: agent.permission_generation,
      identity: activationIdentity(config),
      ...release,
    }),
  );
  return activation_id;
}
export function validateManagedAgentActivation(
  value: unknown,
  agent: Config,
  config: ExecutorConfig,
  release = readExecutorRelease(),
): string {
  const record = strictRecord(value, [
    "schema",
    "activation_id",
    "permission_generation",
    "identity",
    "version",
    "release",
  ]);
  if (
    record.schema !== 1 ||
    !/^[a-f0-9-]{36}$/.test(record.activation_id) ||
    record.permission_generation !== agent.permission_generation ||
    canonicalJSON(record.identity) !==
      canonicalJSON(activationIdentity(config)) ||
    canonicalJSON({ version: record.version, release: record.release }) !==
      canonicalJSON(release)
  )
    refuse("managed_agent_activation_mismatch");
  return record.activation_id;
}
export function readManagedAgentActivation(
  agent: Config,
  config: ExecutorConfig,
): string {
  return validateManagedAgentActivation(
    parseStrictJSON(boundedFile(MANAGED_AGENT_ACTIVATION, 16384, true), 16384),
    agent,
    config,
  );
}
export async function managedAgentCommand(
  command: string,
  agent: Config,
  io: { input: AsyncIterable<Uint8Array | string>; write(value: string): void },
): Promise<void> {
  assertRoot();
  if (
    agent.runtime_mode !== "root" ||
    agent.data_dir !== "/var/lib/lightmoni-agent"
  )
    refuse("managed_agent_requires_root_mode");
  if (command === "managed-enroll") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const value of io.input) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > 65536) refuse("bootstrap_too_large");
      chunks.push(chunk);
    }
    const bootstrap = parseBootstrap(
      parseStrictJSON(Buffer.concat(chunks), 65536),
    );
    const id = parseStrictJSON(
      boundedFile(join(agent.data_dir, "identity.json"), 8192, true),
      8192,
    ) as { agent_id?: string };
    if (
      bootstrap.agent_id !== id.agent_id ||
      bootstrap.endpoint !==
        (agent.endpoint.endsWith("/")
          ? agent.endpoint.slice(0, -1)
          : agent.endpoint)
    )
      refuse("managed_agent_binding_mismatch");
    let daemon = "";
    try {
      daemon = (await inspectManagedDockerDaemon()).daemon_id;
    } catch {
      /* unavailable capability remains unavailable */
    }
    const config = newConfig(bootstrap, daemon, MANAGED_AGENT_DATA_DIR);
    saveInitialConfig(MANAGED_AGENT_CONFIG, config);
    const activation_id = activateManagedAgent(agent),
      release = readExecutorRelease();
    const journal = new ExecutorJournal(
      config.data_dir,
      Buffer.from(config.output_key, "hex"),
    );
    const client = new ExecutorClient(config, journal),
      runner = new PrivilegedExecutorRunner(config, journal, client, {
        ...release,
        activation_id,
      });
    try {
      await client.enroll(bootstrap);
      await runner.heartbeat();
      io.write(
        JSON.stringify({
          enrolled: true,
          agent_id: config.agent_id,
          executor_id: config.executor_id,
          install_generation: config.install_generation,
          activation_id,
        }) + "\n",
      );
    } finally {
      runner.close();
      journal.close();
    }
    return;
  }
  if (command === "managed-activate") {
    io.write(
      JSON.stringify({ activation_id: activateManagedAgent(agent) }) + "\n",
    );
    return;
  }
  const config = managedConfig(agent);
  readManagedAgentActivation(agent, config);
  if (command === "managed-check") {
    io.write("managed Agent configuration valid\n");
    return;
  }
  if (command === "managed-status") {
    io.write(JSON.stringify(executorStatus(config)) + "\n");
    return;
  }
  refuse("unknown_managed_agent_command");
}
/** One in-process loop, not a second CLI worker or independently installed service. */
export async function runManagedAgent(
  agent: Config,
  signal: AbortSignal,
  report: (message: string) => void,
): Promise<void> {
  if (agent.runtime_mode !== "root" || !existsSync(MANAGED_AGENT_CONFIG))
    return;
  const config = managedConfig(agent),
    activation_id = readManagedAgentActivation(agent, config);
  const journal = new ExecutorJournal(
    config.data_dir,
    Buffer.from(config.output_key, "hex"),
  );
  const runner = new PrivilegedExecutorRunner(
    config,
    journal,
    new ExecutorClient(config, journal),
    { ...readExecutorRelease(), activation_id },
  );
  try {
    while (!signal.aborted) {
      try {
        await runner.once(signal);
      } catch (error) {
        report(
          error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)
            ? error.message
            : "managed_agent_cycle_refused",
        );
      }
      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 5000);
          signal.addEventListener("abort", done, { once: true });
        });
    }
  } finally {
    runner.close();
    journal.close();
  }
}
