import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  canonicalJSON,
  parseStrictJSON,
  strictRecord,
} from "../shared/privileged-executor.js";
import {
  MANAGED_AGENT_ACTIVATION,
  MANAGED_AGENT_CONFIG,
  MANAGED_AGENT_DATA_DIR,
  MANAGED_AGENT_HELPER_CONFIG,
  MANAGED_AGENT_HELPER_DATA_DIR,
  loadConfig as loadExecutorConfig,
  newConfig,
  parseBootstrap,
  saveInitialConfig,
  executorPublicKey,
  type ExecutorBootstrap,
  type ExecutorConfig,
} from "../privileged-executor/config.js";
import {
  boundedFile,
  durableWrite,
  refuse,
  rootPath,
  sha256,
  assertRoot,
  secureDirectory,
} from "../privileged-executor/security.js";
import { readExecutorRelease } from "../privileged-executor/release.js";
import { ExecutorJournal } from "../privileged-executor/journal.js";
import { ExecutorClient } from "../privileged-executor/client.js";
import { PrivilegedExecutorRunner } from "../privileged-executor/runner.js";
import { executorStatus } from "../privileged-executor/status.js";
import { inspectManagedDockerDaemon } from "../privileged-executor/docker.js";
import { defaultConfig, validateConfig, type Config } from "./config.js";
import { AgentTaskRunner, ordinaryTaskAccount, verifyOrdinaryTaskExecutionIdentity, type OrdinaryTaskAccount } from "./task-runner.js";

export const MANAGED_AGENT_HELPER_TASK_STATE = join(MANAGED_AGENT_DATA_DIR, "task-run-state.json");

interface HelperConfig {
  schema: 1;
  agent_id: string;
  endpoint: string;
  permission_generation: number;
  task_identity: { account: "lightmoni-agent"; uid: number; gid: number; permission_generation: number };
}

function normalizeEndpoint(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    return "";
  }
}

function parseTaskAccount(value: OrdinaryTaskAccount, permissionGeneration: number): HelperConfig["task_identity"] {
  if (!Number.isSafeInteger(value.uid) || !Number.isSafeInteger(value.gid) || value.uid <= 0 || value.gid <= 0)
    refuse("ordinary_task_account_unavailable");
  if (!Number.isSafeInteger(permissionGeneration) || permissionGeneration < 1) refuse("invalid_permission_generation");
  return { account: "lightmoni-agent", uid: value.uid, gid: value.gid, permission_generation: permissionGeneration };
}

function readHelperConfig(): HelperConfig {
  const record = strictRecord(
    parseStrictJSON(boundedFile(MANAGED_AGENT_HELPER_CONFIG, 16384, true), 16384),
    ["schema", "agent_id", "endpoint", "permission_generation", "task_identity"],
  );
  const identity = strictRecord(record.task_identity, ["account", "uid", "gid", "permission_generation"]);
  if (record.schema !== 1 || typeof record.agent_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.agent_id)
    || typeof record.endpoint !== "string" || normalizeEndpoint(record.endpoint) !== record.endpoint
    || !Number.isSafeInteger(record.permission_generation) || record.permission_generation < 1
    || identity.account !== "lightmoni-agent" || !Number.isSafeInteger(identity.uid) || identity.uid <= 0
    || !Number.isSafeInteger(identity.gid) || identity.gid <= 0
    || !Number.isSafeInteger(identity.permission_generation) || identity.permission_generation !== record.permission_generation)
    refuse("invalid_helper_config");
  const current = parseTaskAccount(ordinaryTaskAccount(), record.permission_generation as number);
  if (current.uid !== identity.uid || current.gid !== identity.gid || current.permission_generation !== identity.permission_generation)
    refuse("ordinary_task_identity_changed");
  verifyOrdinaryTaskExecutionIdentity(current);
  rootPath(MANAGED_AGENT_HELPER_DATA_DIR, "directory");
  rootPath(MANAGED_AGENT_DATA_DIR, "directory", true);
  return record as unknown as HelperConfig;
}

function helperConfigFromBootstrap(bootstrap: ExecutorBootstrap, config: Config): HelperConfig {
  validateConfig(config);
  if (config.runtime_mode !== "root" || config.data_dir !== "/var/lib/lightmoni-agent"
    || normalizeEndpoint(config.endpoint) !== bootstrap.endpoint)
    refuse("managed_agent_binding_mismatch");
  const taskIdentity = parseTaskAccount(ordinaryTaskAccount(), config.permission_generation);
  verifyOrdinaryTaskExecutionIdentity(taskIdentity);
  return {
    schema: 1,
    agent_id: bootstrap.agent_id,
    endpoint: bootstrap.endpoint,
    permission_generation: config.permission_generation,
    task_identity: taskIdentity,
  };
}

export function assertManagedAgentBinding(agent: Config, config: ExecutorConfig, agentID: string): void {
  if (agent.runtime_mode !== "root" || agent.data_dir !== "/var/lib/lightmoni-agent"
    || config.data_dir !== MANAGED_AGENT_DATA_DIR || config.agent_id !== agentID
    || config.endpoint !== normalizeEndpoint(agent.endpoint))
    refuse("managed_agent_binding_mismatch");
}

function helperExecutorConfig(helper: HelperConfig): ExecutorConfig {
  const config = loadExecutorConfig(MANAGED_AGENT_CONFIG);
  if (config.data_dir !== MANAGED_AGENT_DATA_DIR || config.agent_id !== helper.agent_id || config.endpoint !== helper.endpoint)
    refuse("managed_agent_binding_mismatch");
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

export function activateManagedAgent(): string {
  assertRoot();
  const helper = readHelperConfig(), config = helperExecutorConfig(helper), release = readExecutorRelease();
  const activation_id = randomUUID();
  durableWrite(
    MANAGED_AGENT_ACTIVATION,
    canonicalJSON({
      schema: 1,
      activation_id,
      permission_generation: helper.permission_generation,
      ordinary_task_identity: helper.task_identity,
      identity: activationIdentity(config),
      ...release,
    }),
  );
  return activation_id;
}

export function validateManagedAgentActivation(
  value: unknown,
  helper: HelperConfig,
  config: ExecutorConfig,
  release = readExecutorRelease(),
): string {
  const record = strictRecord(value, [
    "schema",
    "activation_id",
    "permission_generation",
    "ordinary_task_identity",
    "identity",
    "version",
    "release",
  ]);
  if (
    record.schema !== 1 ||
    !/^[a-f0-9-]{36}$/.test(record.activation_id) ||
    record.permission_generation !== helper.permission_generation ||
    canonicalJSON(record.ordinary_task_identity) !== canonicalJSON(helper.task_identity) ||
    canonicalJSON(record.identity) !== canonicalJSON(activationIdentity(config)) ||
    canonicalJSON({ version: record.version, release: record.release }) !== canonicalJSON(release)
  )
    refuse("managed_agent_activation_mismatch");
  return record.activation_id;
}

export function readManagedAgentActivation(helper: HelperConfig, config: ExecutorConfig): string {
  return validateManagedAgentActivation(
    parseStrictJSON(boundedFile(MANAGED_AGENT_ACTIVATION, 16384, true), 16384),
    helper,
    config,
  );
}

export function ordinaryTaskRunnerStatus(value: unknown): { active: boolean; state: "idle" | "running" | "result_pending"; run_id?: string } {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
    return { active: false, state: "idle" };
  const record = strictRecord(value, ["id", "lease_token", "receipt"], ["id", "lease_token"]);
  if (typeof record.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.id)
    || typeof record.lease_token !== "string" || !/^[a-f0-9]{64}$/.test(record.lease_token))
    refuse("invalid_ordinary_task_state");
  if (record.receipt !== undefined) {
    const receipt = strictRecord(record.receipt, ["lease_token", "state", "code", "summary", "stdout", "stderr", "exit_code"]);
    if (receipt.lease_token !== record.lease_token || !["succeeded", "failed", "cancelled", "unknown"].includes(String(receipt.state)))
      refuse("invalid_ordinary_task_state");
    return { active: true, state: "result_pending", run_id: record.id };
  }
  return { active: true, state: "running", run_id: record.id };
}

function readOrdinaryTaskRunnerStatus() {
  const filename = MANAGED_AGENT_HELPER_TASK_STATE;
  try {
    return ordinaryTaskRunnerStatus(parseStrictJSON(boundedFile(filename, 2 << 20, true), 2 << 20));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: false, state: "idle" as const };
    throw error;
  }
}

async function readBootstrap(io: { input: AsyncIterable<Uint8Array | string> }): Promise<ExecutorBootstrap> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of io.input) {
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > 65536) refuse("bootstrap_too_large");
    chunks.push(chunk);
  }
  return parseBootstrap(parseStrictJSON(Buffer.concat(chunks), 65536));
}

function readRootAgentConfig(): Config {
  const filename = "/etc/lightmoni-agent/config.json";
  // The installer gives lightmoni-agent read-only access to this file; it is
  // root-owned and non-writable by that group, so root may safely inspect the
  // root-selected mode/endpoint without copying bearer credentials to helper state.
  const bytes = boundedFile(filename, 65536, false);
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { return refuse("invalid_agent_config"); }
  const config = { ...defaultConfig(), ...(raw as Record<string, unknown>) } as Config;
  validateConfig(config);
  return config;
}

export async function managedAgentCommand(
  command: string,
  io: { input: AsyncIterable<Uint8Array | string>; write(value: string): void },
): Promise<void> {
  assertRoot();
  process.umask(0o077);
  if (command === "managed-enroll") {
    const bootstrap = await readBootstrap(io), agent = readRootAgentConfig();
    if (existsSync(MANAGED_AGENT_HELPER_CONFIG) || existsSync(MANAGED_AGENT_CONFIG) || existsSync(MANAGED_AGENT_ACTIVATION))
      refuse("managed_agent_recovery_required");
    const helper = helperConfigFromBootstrap(bootstrap, agent);
    let daemon = "";
    try {
      daemon = (await inspectManagedDockerDaemon()).daemon_id;
    } catch {
      /* unavailable capability remains unavailable */
    }
    const config = newConfig(bootstrap, daemon, MANAGED_AGENT_DATA_DIR);
    secureDirectory(dirname(MANAGED_AGENT_HELPER_CONFIG));
    durableWrite(MANAGED_AGENT_HELPER_CONFIG, canonicalJSON(helper));
    saveInitialConfig(MANAGED_AGENT_CONFIG, config);
    const activation_id = activateManagedAgent(), release = readExecutorRelease();
    const journal = new ExecutorJournal(config.data_dir, Buffer.from(config.output_key, "hex"));
    const client = new ExecutorClient(config, journal), runner = new PrivilegedExecutorRunner(config, journal, client,
      { ...release, activation_id }, undefined, undefined, helper.task_identity);
    try {
      await client.enroll(bootstrap);
      await runner.heartbeat();
      io.write(JSON.stringify({ enrolled: true, agent_id: config.agent_id, executor_id: config.executor_id,
        install_generation: config.install_generation, activation_id, ordinary_task_identity: helper.task_identity }) + "\n");
    } finally {
      runner.close();
      journal.close();
    }
    return;
  }

  if (command === "managed-activate") {
    const agent = readRootAgentConfig();
    // Bootstrap is intentionally not reconstructed from mutable Agent state.
    // Only the permission generation/task identity may be refreshed in place;
    // the Agent ID and center binding remain those enrolled by the center.
    const helper = readHelperConfig();
    if (agent.runtime_mode !== "root" || agent.data_dir !== "/var/lib/lightmoni-agent"
      || normalizeEndpoint(agent.endpoint) !== helper.endpoint)
      refuse("managed_agent_binding_mismatch");
    const activated: HelperConfig = { ...helper, permission_generation: agent.permission_generation,
      task_identity: parseTaskAccount(ordinaryTaskAccount(), agent.permission_generation) };
    durableWrite(MANAGED_AGENT_HELPER_CONFIG, canonicalJSON(activated));
    const refreshed = activateManagedAgent();
    io.write(JSON.stringify({ activation_id: refreshed }) + "\n");
    return;
  }
  const helper = readHelperConfig(), config = helperExecutorConfig(helper);
  const activation_id = readManagedAgentActivation(helper, config);
  if (command === "managed-check") {
    io.write("managed Agent helper configuration valid\n");
    return;
  }
  if (command === "managed-status") {
    io.write(JSON.stringify({ ...executorStatus(config), ordinary_task_identity: helper.task_identity,
      ordinary_task_runner: readOrdinaryTaskRunnerStatus(), permission_generation: helper.permission_generation, activation_id }) + "\n");
    return;
  }
  refuse("unknown_managed_agent_command");
}

/** Root helper runs both audited task channels; Agent itself remains unprivileged. */
export async function runManagedHelper(
  signal: AbortSignal,
  report: (message: string) => void,
): Promise<void> {
  assertRoot();
  process.umask(0o077);
  const helper = readHelperConfig(), config = helperExecutorConfig(helper), activation_id = readManagedAgentActivation(helper, config);
  const journal = new ExecutorJournal(config.data_dir, Buffer.from(config.output_key, "hex"));
  const client = new ExecutorClient(config, journal);
  const runner = new PrivilegedExecutorRunner(config, journal, client, { ...readExecutorRelease(), activation_id }, undefined, undefined, helper.task_identity);
  const taskRunner = new AgentTaskRunner({
    endpoint: helper.endpoint,
    agentID: helper.agent_id,
    dataDir: MANAGED_AGENT_DATA_DIR,
    pollIntervalMs: 5000,
    permissionGeneration: helper.permission_generation,
    executionIdentity: helper.task_identity,
    executorID: config.executor_id,
    executorInstallGeneration: config.install_generation,
  }, { request: (route, body, parent, slot) => client.request(route, body, slot, parent),
    clearRequest: slot => journal.clearRequest(slot) });
  const runExecutor = async () => {
    while (!signal.aborted) {
      try {
        await runner.observeOnce(signal);
      } catch (error) {
        report(error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : "managed_agent_cycle_refused");
      }
      if (!signal.aborted) await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 5000);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  };
  try {
    await Promise.all([taskRunner.run(signal), runExecutor()]);
  } finally {
    runner.close();
    journal.close();
  }
}

/** A centre-approved job is claimed only by a fixed SSH-invoked command. */
export async function runManagedOnce(jobID:string,signal:AbortSignal):Promise<void> {
  assertRoot();
  if(!/^[a-f0-9-]{32,36}$/.test(jobID))refuse('invalid_job_id');
  process.umask(0o077);
  const helper=readHelperConfig(),config=helperExecutorConfig(helper),activation_id=readManagedAgentActivation(helper,config);
  const journal=new ExecutorJournal(config.data_dir,Buffer.from(config.output_key,'hex'));
  const client=new ExecutorClient(config,journal);
  const runner=new PrivilegedExecutorRunner(config,journal,client,{...readExecutorRelease(),activation_id},undefined,undefined,helper.task_identity);
  try{await runner.once(signal,jobID);}finally{runner.close();journal.close();}
}

/** Manual script runs use SSH; scheduled runs remain on the helper timer. */
export async function runManagedTaskOnce(runID:string,signal:AbortSignal):Promise<void> {
  assertRoot();
  if(!/^[a-f0-9-]{36}$/.test(runID))refuse('invalid_run_id');
  process.umask(0o077);
  const helper=readHelperConfig(),config=helperExecutorConfig(helper);
  readManagedAgentActivation(helper,config);
  const journal=new ExecutorJournal(config.data_dir,Buffer.from(config.output_key,'hex'));
  const client=new ExecutorClient(config,journal);
  const taskRunner=new AgentTaskRunner({endpoint:helper.endpoint,agentID:helper.agent_id,dataDir:MANAGED_AGENT_DATA_DIR,stateFile:"task-run-ssh-state.json",
    pollIntervalMs:5000,permissionGeneration:helper.permission_generation,executionIdentity:helper.task_identity,
    executorID:config.executor_id,executorInstallGeneration:config.install_generation},
    {request:(route,body,parent,slot)=>client.request(route,body,slot,parent),clearRequest:slot=>journal.clearRequest(slot)});
  try{await taskRunner.pollOnce(signal,runID);}finally{journal.close();}
}
