import { registerMachineDocker } from './machine-docker.js';
import { machineDockerEnvironment, type DockerEnvironment } from './docker-environment.js';
import { assertNoDockerInstallation, pendingDockerInstallation } from './machine-docker-guard.js';
import { connectionCredentials } from "./connection-credentials.js";
import { createHostNetworkSchema, machineNetwork, recordSSHHostNetwork, type MachineNetwork } from "./host-network.js";
import { recordMachineHostKey } from "./machine-host-keys.js";
import { agentBootstrapCommand } from "./machine-agent-lifecycle.js";
import { machineCredentialCurrent, machineCredentialCurrentSQL } from "./machine-credential-policy.js";
import { createAgentLifecycleSchema } from "./agent-lifecycle.js";
import { createAgentHostSchema, replaceableAgentBinding, hasActiveTaskRuns, currentAgentHostname } from "./agent-hosts.js";
import { NodeStore } from "./nodes-model.js";
import { join } from "node:path";
import { createAgentUpdatesSchema, registerMachineAgentUpdates, type AgentUpdateStore } from "./machine-agent-updates.js";
import { assertNoPendingAgentUpdate } from "./machine-agent-updates-guard.js";
import { registerMachineExecutorBootstrap } from "./machine-executor-bootstrap.js";
import type { PrivilegedExecutorStore } from "./privileged-executors.js";
import { registerMachineExecutorMaintenance } from "./machine-executor-maintenance.js";
import { createInstallationRecoverySchema, registerInstallationRecovery } from "./machine-installation-recovery.js";
import { assertNoPendingMachineInstallation, pendingMachineInstallation, unresolvedInstallationSQL } from "./machine-installations-guard.js";
import { createUninstallationSchema, registerMachineUninstallations, type UninstallationStatus } from "./machine-uninstallations.js";
import { id, hash } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import type { Context, Dependencies, Handler, Module } from "../shared/types.js";
import type {
  AgentCredentialStore,
  AgentEnrollmentIssued,
} from "./agent-credentials.js";

import { defaultSSHRunner, SSHError, preflightCommand, parsePreflight, unavailableSSHDiscovery, unknownSSHPrivilege, type SSHPrivilegeProbe, type SSHDiscovery, type SSHRunner } from "./machine-ssh.js";
export type { SSHRunInput, SSHRunner } from "./machine-ssh.js";

export type ConnectionMethod = "direct_ssh";
export type CredentialMethod = "ssh_key" | "password";
export type CredentialRetention = "temporary" | "managed" | "one_time" | "permanent";
export type CredentialClearReason = "expired" | "revoked" | "consumed" | "agent_activated";
export type MachineCapabilityReason = "host_busy" | "direct_ssh_required" | "ssh_credential_required" | "ssh_key_required" | "reusable_ssh_credential_required" | "agent_not_linked" | "agent_task_busy" | "agent_update_pending" | "uninstallation_pending" | "uninstallation_unknown" | "installation_pending" | "installation_unknown" | "";
export interface MachineCapability { available: boolean; reason: MachineCapabilityReason }
export type MachineStatus = "unknown" | "online" | "offline" | "installing" | "uninstalled" | "removed" | "error";
export type DeploymentStatus = "awaiting_approval" | "running" | "unknown" | "succeeded" | "failed" | "cancelled";

const MACHINE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const ARCHES = new Set(["amd64", "arm64"]);
const CONNECTIONS = new Set<ConnectionMethod>(["direct_ssh"]);
const CREDENTIALS = new Set<CredentialMethod>(["ssh_key", "password"]);
const CLEANUP_INTERVAL_MS = 30_000;
const PLAN_SECONDS = 15 * 60;
const CHECK_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 12_000;

const record = (value: any): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid request");
  return value;
};
const text = (value: unknown, field: string, max: number, required = true) => {
  if (value == null && !required) return "";
  if (typeof value !== "string" || (!value.trim() && required) || Buffer.byteLength(value) > max)
    fail(400, `invalid ${field}`);
  return value.trim();
};
const integer = (value: unknown, field: string, min: number, max: number, fallback?: number) => {
  if (value == null && fallback != null) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    fail(400, `invalid ${field}`);
  return Number(value);
};
const iso = (date: Date) => date.toISOString();
const parseJSON = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const shell = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const safeAddress = (value: unknown) => {
  const address = text(value, "address", 255);
  if (
    /[\u0000-\u001f\u007f\s/]/.test(address) ||
    address.includes("://") ||
    address.includes("@") ||
    address.startsWith("-") ||
    address === "169.254.169.254" ||
    address === "metadata.google.internal"
  ) fail(400, "address must be a host name or IP address");
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(address)) fail(400, "invalid address");
  return address;
};
const safeUsername = (value: unknown) => {
  const username = text(value, "username", 64);
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(username)) fail(400, "invalid username");
  return username;
};
const redact = (value: string, secrets: string[] = []) => {
  let output = value.slice(0, OUTPUT_LIMIT);
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join("[redacted]");
  return output.replace(/lm_(?:enroll|bootstrap|agent)_[A-Za-z0-9_-]+/g, "[redacted-token]");
};
const statusOf = (row: any, now: Date): MachineStatus => {
  if (row.node_lifecycle_state === "removed") return "removed";
  if (row.last_uninstallation_status === "succeeded") return "uninstalled";
  if (row.agent_id) {
    const last = Math.max(
      Date.parse(row.node_last_seen || "") || Number.NEGATIVE_INFINITY,
      Date.parse(row.agent_last_seen || "") || Number.NEGATIVE_INFINITY,
    );
    if (Number.isFinite(last) && now.getTime() - last < 180_000) return "online";
    return "offline";
  }
  return row.last_error ? "error" : "unknown";
};

export interface MachineSummary {
  docker_environment?: DockerEnvironment;
  id: string;
  name: string;
  observed_hostname: string;
  network: MachineNetwork;
  label_ids: string[];
  labels: {id:string;name:string}[];
  address: string;
  port: number;
  username: string;
  connection_method: ConnectionMethod;
  host_key_fingerprint: string;
  ssh_target_generation: number;
  host_key_public_key: string;
  host_key_observed_at: string;
  host_key_status: "unconfigured" | "confirmed" | "observed";
  platform: string;
  arch: string;
  agent_id: string;
  agent_status: MachineStatus;
  default_credential_id: string;
  credential_count: number;
  active_credential_count: number;
  active_ssh_credential_count: number;
  active_ssh_key_count: number;
  active_reusable_ssh_credential_count: number;
  ssh_recovery_available: boolean;
  capabilities: { terminal: MachineCapability; ssh_check: MachineCapability; deploy_agent: MachineCapability; uninstall_agent: MachineCapability; recovery_uninstall_agent: MachineCapability; update_agent: MachineCapability; rollback_agent: MachineCapability };
  agent_release: any;
  agent_update: any;
  last_deployment_status: DeploymentStatus | "";
  last_uninstallation_status: UninstallationStatus | "";
  updated_at: string;
  created_at: string;
}

export interface SSHCheckResult {
  id: string; machine_id: string; credential_id: string; connected: boolean; ready: boolean;
  platform: string; arch: string; checks: Record<string, boolean>; error_code: string;
  checked_at: string; expires_at: string;
  privilege: SSHPrivilegeProbe & { checked_at: string; expires_at: string; machine_revision: string; credential_binding_revision: string; endpoint_fingerprint: string };
  agent_installation: { state: "present" | "absent" | "unknown" };
  discovery: SSHDiscovery;
}
export interface InstallPlanInput {
  check_id: string; credential_id?: string; version: string; arch: string; initial_label_id?: string;
}

export interface ManagedMachineStore {
  agentUpdates?: AgentUpdateStore;
  registerExecutorBootstrap(store: PrivilegedExecutorStore): Module;
  list(): MachineSummary[];
  get(machineID: string): MachineSummary;
  assistantList(): MachineSummary[];
  assistantGet(machineID: string): MachineSummary & { ssh_credentials: { id: string; method: string; expires_at: string }[] };
  checkSSH(machineID: string, input: { credential_id?: string }, actorID: string, signal: AbortSignal): Promise<SSHCheckResult>;
  assistantPlan(machineID: string, input: InstallPlanInput, actorID: string): Record<string, any>;
  assistantDeployment(deploymentID: string): Record<string, any>;
}

export interface ManagedMachinesOptions {
  agentCredentials?: AgentCredentialStore;
  sshRunner?: SSHRunner;
  downloadsDir?: string;
  dataDir?: string;
  updatePollIntervalMs?: number;
  updateHealthTimeoutMs?: number;
}

export interface TerminalLease {
  machine: MachineSummary;
  credentialID: string;
  credentialMethod: "ssh_key" | "password";
  privateKey: string;
  password: string;
  valid(): boolean;
  markUsed(): void;
  verifyHostKey(key: Buffer): boolean;
  release(): void;
}
export interface MachineTerminalAccess {
  acquireTerminal(machineID: string, credentialID: string | undefined, invalidate: () => void): TerminalLease;
}

export function registerManagedMachines(deps: Dependencies, options: ManagedMachinesOptions = {}): Module & ManagedMachineStore & MachineTerminalAccess {
  const { db, router } = deps;
  createAgentLifecycleSchema(db);
  createAgentHostSchema(db);
  createHostNetworkSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_machines(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      connection_method TEXT NOT NULL,
      host_key_fingerprint TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      arch TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      agent_last_seen TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS machine_credentials(
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL DEFAULT '',
      secret_fingerprint TEXT NOT NULL DEFAULT '',
      retention TEXT NOT NULL,
      policy_source TEXT NOT NULL DEFAULT 'legacy',
      secret_cleared_at TEXT NOT NULL DEFAULT '',
      clear_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS machine_credentials_machine ON machine_credentials(machine_id);
    CREATE TABLE IF NOT EXISTS machine_deployments(
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL,
      status TEXT NOT NULL,
      version TEXT NOT NULL,
      arch TEXT NOT NULL,
      initial_label_id TEXT NOT NULL DEFAULT '',
      plan_json TEXT NOT NULL,
      receipt_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      approved_at TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS machine_deployments_machine ON machine_deployments(machine_id,created_at);
    CREATE TABLE IF NOT EXISTS machine_ssh_checks(
      id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL, target_revision TEXT NOT NULL, result_json TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS machine_ssh_checks_machine ON machine_ssh_checks(machine_id,created_at);

    CREATE TABLE IF NOT EXISTS machine_agent_link_events(
      id TEXT PRIMARY KEY,machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,credential_id TEXT NOT NULL,actor_id TEXT NOT NULL,verified_at TEXT NOT NULL
    );

  `);
  createInstallationRecoverySchema(deps);
  createUninstallationSchema(deps);
  createAgentUpdatesSchema(deps);
  // Adding the legacy default once marks only rows that predate this policy.
  // Every new insert supplies its source, so restarting never reclassifies it.
  const credentialColumns = new Set(db.all<{ name: string }>("PRAGMA table_info(machine_credentials)").map(column => column.name));
  for (const [name, definition] of [
    ["policy_source", "TEXT NOT NULL DEFAULT 'legacy'"],
    ["secret_cleared_at", "TEXT NOT NULL DEFAULT ''"],
    ["clear_reason", "TEXT NOT NULL DEFAULT ''"],
  ]) if (!credentialColumns.has(name)) db.exec(`ALTER TABLE machine_credentials ADD COLUMN ${name} ${definition}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS machine_credential_events(
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL,
      event TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS machine_credential_events_credential ON machine_credential_events(credential_id,created_at);
  `);
  // Password hashes would allow offline dictionary guesses; only SSH key
  // fingerprints are retained, including after upgrading an older database.
  db.run("UPDATE machine_credentials SET secret_fingerprint='' WHERE method='password' AND secret_fingerprint!=''");
  const now = () => deps.now();
  const busy = new Set<string>();
  const terminals = new Map<string, { credentialID: string; invalidate: () => void }>();
  const library = connectionCredentials(deps, (bindingID, reason, actorID) => clearCredential(bindingID, reason, actorID));
  const clearCredential = (credentialID: string, reason: CredentialClearReason, actorID = "system", withinTransaction = false) => {
    let invalidatedMachine = "";
    const mutate = () => {
      const credential = db.get<any>("SELECT * FROM machine_credentials WHERE id=?", credentialID);
      if (!credential) return;
      const at = iso(now());
      // Keep the first reason and event even when expiry/revoke/release race.
      // A repeated cleanup still removes any accidentally restored envelope.
      db.run(`UPDATE machine_credentials SET secret_encrypted='',quarantined_at='',
        secret_cleared_at=CASE WHEN secret_cleared_at='' THEN ? ELSE secret_cleared_at END,
        clear_reason=CASE WHEN clear_reason='' THEN ? ELSE clear_reason END,
        revoked_at=CASE WHEN ?='expired' THEN revoked_at ELSE COALESCE(revoked_at,?) END WHERE id=?`,
        at, reason, reason, at, credentialID);
      if (!credential.secret_cleared_at) db.run("INSERT INTO machine_credential_events(id,machine_id,credential_id,event,actor_id,created_at) VALUES(?,?,?,?,?,?)",
        id(), credential.machine_id, credentialID, reason, actorID, at);
      if (reason === "consumed" && credential.connection_credential_id) library.consumed(credential.connection_credential_id,actorID);
      db.run("UPDATE machine_deployments SET status='cancelled',finished_at=?,error=? WHERE credential_id=? AND status='awaiting_approval'",
        at, "连接凭据已失效，请添加凭据后重新检查并生成部署计划", credentialID);
      db.run("UPDATE machine_uninstallations SET status='cancelled',finished_at=?,error=? WHERE credential_id=? AND status='awaiting_approval'", at, "连接凭据已失效，请重新检查卸载计划", credentialID);
      db.run("UPDATE machine_agent_updates SET status='cancelled',finished_at=?,error=? WHERE credential_id=? AND status='awaiting_approval'", at, "连接凭据已失效，请重新生成 Agent 维护计划", credentialID);
      if (terminals.get(credential.machine_id)?.credentialID === credentialID) invalidatedMachine = credential.machine_id;
    };
    if (withinTransaction) mutate(); else db.transaction(mutate);
    // Closing a password terminal calls lease.release(), which can safely run
    // the same idempotent cleanup without nesting it inside this transaction.
    if (invalidatedMachine) terminals.get(invalidatedMachine)?.invalidate();
  };
  library.migrate();
  const cleanupInvalidCredentials = () => {
    library.cleanup();
    const at = iso(now());
    const invalid = db.all<any>(`SELECT id,revoked_at FROM effective_machine_credentials
      WHERE (revoked_at IS NOT NULL OR NOT ${machineCredentialCurrentSQL()}) AND (secret_encrypted!='' OR secret_cleared_at='')
      UNION SELECT id,revoked_at FROM machine_credentials WHERE quarantined_at!='' AND secret_encrypted!=''
      AND (revoked_at IS NOT NULL OR NOT ${machineCredentialCurrentSQL()})`, at, at);
    for (const credential of invalid) clearCredential(credential.id, credential.revoked_at ? "revoked" : "expired");
  };
  cleanupInvalidCredentials();
  const cleanupTimer = setInterval(() => {
    try { cleanupInvalidCredentials(); } catch (error) { deps.logger.error(error); }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  const idle = (machineID: string) => { cleanupInvalidCredentials(); assertNoDockerInstallation(db,machineID); if (busy.has(machineID)) fail(409, "此主机有终端、检查或部署正在进行，请先结束后重试"); };
  // A user label is not part of the SSH connection identity. Plans that show
  // that label are invalidated separately when the asset is renamed.
  const targetRevision = (machine: any) => hash(JSON.stringify([machine.address, machine.port, machine.username, machine.connection_method, machine.host_key_fingerprint, Number(machine.ssh_target_generation || 0), deps.externalURL]));
  const parameters = (input: Record<string, any>, allowed: string[]) => {
    if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, "unknown request parameter");
    return input;
  };
  const admin = (ctx: Context) => deps.auth.requireAdmin(ctx);
  const safe = (handler: Handler): Handler => async (ctx) => {
    try { await handler(ctx); }
    catch (error) {
      if (error instanceof HTTPError) ctx.json({ error: error.message }, error.status);
      else if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) ctx.json({ error: "主机名称或地址已存在" }, 409);
      else { deps.logger.error(error); ctx.json({ error: "主机管理操作失败" }, 500); }
    }
  };
  library.register(safe);
  const machineSelect = `SELECT m.*,COALESCE((SELECT count(*) FROM effective_machine_credentials c WHERE c.machine_id=m.id),0) credential_count,
      COALESCE((SELECT count(*) FROM effective_machine_credentials c WHERE c.machine_id=m.id AND c.revoked_at IS NULL AND ${machineCredentialCurrentSQL("c")} AND c.secret_cleared_at='' AND c.method IN ('ssh_key','password') AND c.secret_encrypted!=''),0) active_credential_count,
      COALESCE((SELECT count(*) FROM effective_machine_credentials c WHERE c.machine_id=m.id AND c.revoked_at IS NULL AND ${machineCredentialCurrentSQL("c")} AND c.secret_cleared_at='' AND c.method IN ('ssh_key','password') AND c.secret_encrypted!=''),0) active_ssh_credential_count,
      COALESCE((SELECT count(*) FROM effective_machine_credentials c WHERE c.machine_id=m.id AND c.revoked_at IS NULL AND ${machineCredentialCurrentSQL("c")} AND c.secret_cleared_at='' AND c.method='ssh_key' AND c.secret_encrypted!=''),0) active_ssh_key_count,
      COALESCE((SELECT count(*) FROM effective_machine_credentials c WHERE c.machine_id=m.id AND c.revoked_at IS NULL AND ${machineCredentialCurrentSQL("c")} AND c.secret_cleared_at='' AND c.secret_encrypted!='' AND (c.method='ssh_key' OR (c.method='password' AND c.retention IN ('temporary','managed','permanent')))),0) active_reusable_ssh_credential_count,
      COALESCE((SELECT d.status FROM machine_deployments d WHERE d.machine_id=m.id ORDER BY d.created_at DESC LIMIT 1),'') last_deployment_status,
      COALESCE((SELECT u.status FROM machine_uninstallations u WHERE u.machine_id=m.id AND u.agent_id=m.agent_id ORDER BY u.created_at DESC,u.id DESC LIMIT 1),'') last_uninstallation_status,
      COALESCE(a.last_seen,'') AS node_last_seen,COALESCE(l.state,'active') AS node_lifecycle_state
     FROM managed_machines m LEFT JOIN agents a ON a.id=m.agent_id LEFT JOIN agent_lifecycle l ON l.agent_id=m.agent_id`;
  const row = (machineID: string) => {
    cleanupInvalidCredentials();
    const at = iso(now());
    return db.get<any>(machineSelect + " WHERE m.id=?", at, at, at, at, machineID);
  };
  const hostLabels = (machineID: string) => {
    const available = db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='machine_host_labels'");
    const labels = available ? db.all<{id:string;name:string}>("SELECT l.id,l.name FROM machine_host_labels h JOIN agent_task_labels l ON l.id=h.label_id WHERE h.machine_id=? ORDER BY l.id", machineID) : [];
    return { label_ids: labels.map(label => label.id), labels };
  };
  const summary = (value: any): MachineSummary => {
    if (!value) fail(404, "主机不存在");
    const activeSSH = Number(value.active_ssh_credential_count ?? 0), activeKeys = Number(value.active_ssh_key_count ?? 0);
    const reusableSSH = Number(value.active_reusable_ssh_credential_count ?? 0);
    const capability = (reusableRequired = false): MachineCapability => {
      const reason: MachineCapabilityReason = (busy.has(value.id) || pendingDockerInstallation(db,value.id,value.agent_id)) ? "host_busy"
        : value.connection_method !== "direct_ssh" ? "direct_ssh_required"
        : (reusableRequired ? !reusableSSH : !activeSSH) ? (reusableRequired ? "reusable_ssh_credential_required" : "ssh_credential_required") : "";
      return { available: !reason, reason };
    };
    const pendingUninstall = uninstallations.pending(value.id);
    const pendingUpdate = agentUpdates.pending(value.id);
    const pendingInstall = pendingMachineInstallation(db,value.id);
    const uninstallReason = pendingUninstall ? (pendingUninstall.status === "unknown" ? "uninstallation_unknown" : "uninstallation_pending")
      : uninstallations.taskBusy(value.agent_id) || hasActiveTaskRuns(db, value.agent_id, value.id) ? "agent_task_busy" : "";
    const uninstallCapability = capability(true);
    if (uninstallCapability.available && uninstallReason) { uninstallCapability.available = false; uninstallCapability.reason = uninstallReason; }
    const deployCapability = capability(true);
    if (deployCapability.available && uninstallReason) { deployCapability.available = false; deployCapability.reason = uninstallReason; }
    const updateCapability = capability(true);
    const updateReason: MachineCapabilityReason = pendingUpdate ? "agent_update_pending" : !value.agent_id ? "agent_not_linked" : uninstallReason;
    if (updateCapability.available && updateReason) { updateCapability.available = false; updateCapability.reason = updateReason; }
    if (pendingUpdate) for (const current of [uninstallCapability, deployCapability]) { current.available = false; current.reason = "agent_update_pending"; }
    if (pendingInstall) for (const current of [uninstallCapability,deployCapability,updateCapability]) { current.available=false; if(current.reason!=="host_busy")current.reason=pendingInstall.status==="unknown"?"installation_unknown":"installation_pending"; }
    return {
      id: value.id, name: value.name, default_credential_id: value.default_credential_id || "", observed_hostname: currentAgentHostname(db, value.id, value.agent_id),
      network: machineNetwork(db,value.id),
      docker_environment: machineDockerEnvironment(db,value.agent_id,now()),
      ...hostLabels(value.id),
      address: value.address, port: Number(value.port), username: value.username,
      connection_method: value.connection_method, host_key_fingerprint: value.host_key_fingerprint, ssh_target_generation: Number(value.ssh_target_generation || 0),
      host_key_public_key: value.host_key_public_key || "", host_key_observed_at: value.host_key_observed_at || "",
      host_key_status: value.host_key_public_key ? "observed" : value.host_key_fingerprint ? "confirmed" : "unconfigured",
      platform: value.platform, arch: value.arch, agent_id: value.agent_id,
      agent_status: statusOf(value, now()), credential_count: Number(value.credential_count ?? 0),
      active_credential_count: Number(value.active_credential_count ?? 0),
      active_ssh_credential_count: activeSSH, active_ssh_key_count: activeKeys,
      active_reusable_ssh_credential_count: reusableSSH,
      ssh_recovery_available: value.connection_method === "direct_ssh" && activeSSH > 0,
      capabilities: { terminal: pendingUpdate ? { available: false, reason: "agent_update_pending" } : capability(), ssh_check: capability(), deploy_agent: deployCapability, uninstall_agent: uninstallCapability, recovery_uninstall_agent: { ...uninstallCapability }, update_agent: updateCapability, rollback_agent: { ...updateCapability } },
      ...agentUpdates.machineState(value.id, value.agent_id),
      last_deployment_status: value.last_deployment_status || "", last_uninstallation_status: value.last_uninstallation_status || "", updated_at: value.updated_at, created_at: value.created_at,
    };
  };
  const list = () => {
    cleanupInvalidCredentials();
    const at = iso(now());
    return db.all<any>(machineSelect + " ORDER BY m.updated_at DESC,m.id", at, at, at, at).map(summary);
  };
  const get = (machineID: string) => summary(row(machineID));
  const credentialRows = (machineID: string) => {
    cleanupInvalidCredentials();
    return db.all<any>(
      `SELECT id,connection_credential_id,name,method,secret_fingerprint,retention,policy_source,secret_cleared_at,clear_reason,created_at,expires_at,revoked_at,last_used_at,created_by,
       CASE WHEN id=(SELECT default_credential_id FROM managed_machines WHERE id=?) THEN 1 ELSE 0 END AS is_default
       FROM effective_machine_credentials WHERE machine_id=? ORDER BY created_at DESC`, machineID, machineID,
    );
  };
  const ensureMachine = (machineID: string) => {
    if (!MACHINE_ID.test(machineID) || !db.get("SELECT id FROM managed_machines WHERE id=?", machineID)) fail(404, "主机不存在");
    return row(machineID)!;
  };
  const ensureDeletable = (machineID: string) => {
    const machine = ensureMachine(machineID);
    assertNoPendingMachineInstallation(db,machineID,machine.agent_id);
    assertNoPendingAgentUpdate(db, machine.agent_id, machineID);
    uninstallations.assertFree(machineID);
    // Keep the existing in-flight lease guard first so an active terminal,
    // check, or deployment receives the precise busy error.
    idle(machineID);
    if (db.get(`SELECT id FROM effective_machine_credentials WHERE machine_id=? AND revoked_at IS NULL AND secret_cleared_at='' AND secret_encrypted!='' AND ${machineCredentialCurrentSQL()} LIMIT 1`, machineID, iso(now())))
      fail(409, "请先解绑本主机的有效连接凭据后再删除主机");
    if (db.get("SELECT id FROM machine_deployments WHERE machine_id=? AND status IN ('awaiting_approval','running') LIMIT 1", machineID))
      fail(409, "该主机有未结束的部署任务，请先完成或取消后再删除");
    assertAgentDeletionSafe(machineID, machine.agent_id);
  };
  const assertAgentDeletionSafe = (machineID: string, agentID: string) => {
    assertNoPendingAgentUpdate(db, agentID, machineID);
    if (db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='privileged_executors'") && db.get("SELECT id FROM privileged_executors WHERE machine_id=? AND state!='revoked' LIMIT 1",machineID))
      fail(409,"请先卸载并撤销该主机的 root 执行器身份，再删除主机");
    if (hasActiveTaskRuns(db, agentID, machineID)) fail(409, "主机有待执行、运行中或结果未知的任务中心记录，请先处理");
    if (!agentID || db.get("SELECT 1 FROM agent_lifecycle WHERE agent_id=? AND state='removed'", agentID)) return;
    const installed = db.get<{status:string}>("SELECT status FROM machine_uninstallations WHERE machine_id=? AND agent_id=? ORDER BY created_at DESC,id DESC LIMIT 1", machineID, agentID);
    const credentials = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_credentials'");
    const audiences = credentials ? db.all<{audience:string}>("SELECT DISTINCT audience FROM agent_credentials WHERE agent_id=?", agentID).map(row => row.audience) : [];
    if (installed?.status === "succeeded" && ["control", "data"].every(audience => audiences.includes(audience))
      && !db.get("SELECT id FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL AND expires_at>? LIMIT 1", agentID, iso(now()))) return;
    fail(409, "请先移除关联 Agent 或核验卸载完成并撤销身份，再删除主机");
  };
  const ensureCredential = (machineID: string, credentialID: string, cleanup = true) => {
    if (cleanup) cleanupInvalidCredentials();
    const value = db.get<any>("SELECT * FROM effective_machine_credentials WHERE id=? AND machine_id=?", credentialID, machineID);
    if (!value) fail(404, "连接凭据不存在");
    if (value.revoked_at) fail(409, "连接凭据已撤销");
    if (!machineCredentialCurrent(value, now())) fail(409, "连接凭据已过期或有效期无效");
    if (!CREDENTIALS.has(value.method)) fail(400, "连接凭据仅支持 SSH 私钥或密码，请添加有效凭据");
    if (value.secret_cleared_at || !value.secret_encrypted) fail(409, "连接凭据秘密已清除，请添加新凭据");
    return value;
  };
  const validateMachine = (input: Record<string, any>, existing?: any) => {
    if (Object.hasOwn(input, "id")) fail(400, "主机 ID 由平台自动生成，不能指定或修改");
    if (["host_key_fingerprint", "host_key_public_key", "host_key_observed_at", "host_key_status", "ssh_target_generation"].some(field => Object.hasOwn(input, field))) fail(400, "主机身份由 SSH 连接自动记录，不能手动指定或修改");
    const name = text(input.name ?? existing?.name, "name", 128);
    if (/[\u0000-\u001f\u007f-\u009f]/.test(input.name ?? existing?.name)) fail(400, "主机名称不能包含控制字符");
    const address = safeAddress(input.address ?? existing?.address);
    const port = integer(input.port ?? existing?.port, "port", 1, 65535, 22);
    const username = safeUsername(input.username ?? existing?.username);
    const connectionMethod = String(input.connection_method ?? existing?.connection_method ?? "direct_ssh") as ConnectionMethod;
    if (!CONNECTIONS.has(connectionMethod)) fail(400, "invalid connection_method");
    const endpointChanged = existing && (existing.address !== address || Number(existing.port) !== port);
    const fingerprint = !existing || endpointChanged ? "" : existing.host_key_fingerprint;
    const publicKey = !existing || endpointChanged ? "" : existing.host_key_public_key || "";
    const observedAt = !existing || endpointChanged ? "" : existing.host_key_observed_at || "";
    const platform = text(input.platform ?? existing?.platform ?? "", "platform", 64, false);
    const arch = text(input.arch ?? existing?.arch ?? "", "arch", 16, false);
    if (arch && !ARCHES.has(arch)) fail(400, "invalid arch");
    return { name, address, port, username, connectionMethod, fingerprint, publicKey, observedAt, platform, arch };
  };
  const machineBody = async (ctx: Context) => record(await ctx.body());
  const createMachine = async (ctx: Context) => {
    admin(ctx);
    const input = await machineBody(ctx), value = validateMachine(input), at = iso(now()), machineID = id().slice(0, 16);
    db.run(
      `INSERT INTO managed_machines(id,name,address,port,username,connection_method,host_key_fingerprint,platform,arch,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`, machineID, value.name, value.address, value.port, value.username, value.connectionMethod,
      value.fingerprint, value.platform, value.arch, at, at,
    );
    ctx.json(get(machineID), 201);
  };
  const updateMachine = async (ctx: Context) => {
    admin(ctx);
    assertNoPendingAgentUpdate(db, "", ctx.params.id);
    idle(ctx.params.id);
    uninstallations.assertFree(ctx.params.id);
    const input = await machineBody(ctx), at = iso(now());
    idle(ctx.params.id);
    ensureMachine(ctx.params.id);
    uninstallations.assertFree(ctx.params.id);
    db.transaction(() => {
      assertNoPendingMachineInstallation(db,ctx.params.id);
      uninstallations.assertFree(ctx.params.id);
      assertNoPendingAgentUpdate(db, "", ctx.params.id);
      const existing = db.get<any>("SELECT * FROM managed_machines WHERE id=?", ctx.params.id);
      if (!existing) fail(404, "主机不存在");
      const value = validateMachine(input, existing);
      const changed = ["address", "port", "username"].some(field => existing[field] !== value[field as "address" | "port" | "username"]) || existing.connection_method !== value.connectionMethod;
      const renamed = existing.name !== value.name;
      db.run(
        `UPDATE managed_machines SET name=?,address=?,port=?,username=?,connection_method=?,host_key_fingerprint=?,host_key_public_key=?,host_key_observed_at=?,platform=?,arch=?,ssh_target_generation=ssh_target_generation+?,updated_at=? WHERE id=?`,
        value.name, value.address, value.port, value.username, value.connectionMethod, value.fingerprint, value.publicKey, value.observedAt, value.platform, value.arch, Number(changed), at, ctx.params.id,
      );
      if (changed) db.run("DELETE FROM machine_ssh_checks WHERE machine_id=?", ctx.params.id);
      if (changed || renamed) {
        const reason = changed ? "主机连接已变化，请重新检查并生成计划" : "主机名称已变化，请重新审阅并生成计划";
        db.run("UPDATE machine_deployments SET status='cancelled',finished_at=?,error=? WHERE machine_id=? AND status='awaiting_approval'", at, reason, ctx.params.id);
        db.run("UPDATE machine_uninstallations SET status='cancelled',finished_at=?,error=? WHERE machine_id=? AND status='awaiting_approval'", at, reason, ctx.params.id);
      }
    });
    ctx.json(get(ctx.params.id));
  };
  const addCredential = async (ctx: Context) => {
    admin(ctx);
    ensureMachine(ctx.params.id);
    const input = parameters(await machineBody(ctx), ["name", "connection_credential_id", "make_default", "method", "secret", "expires_in_seconds", "retention", "confirm_managed", "confirm_permanent"]);
    if (input.make_default !== undefined && typeof input.make_default !== "boolean") fail(400, "invalid make_default");
    if (input.connection_credential_id !== undefined && Object.keys(input).some(key => !["connection_credential_id", "make_default"].includes(key))) fail(400, "选择已有凭据时不能同时提交新秘密或保存期限");
    const material=input.connection_credential_id === undefined ? {...input,name:input.name ?? get(ctx.params.id).name} : undefined;
    const requested=material ? library.lifetime(material) : undefined;
    let bindingID = "",reused=false;
    db.transaction(() => {
      if(!db.get("SELECT id FROM managed_machines WHERE id=?",ctx.params.id))fail(404,"主机不存在");
      const source = material ? library.create(material,ctx.user.id) : library.ensure(text(input.connection_credential_id,"connection_credential_id",64));
      reused=source.reused ?? false;
      bindingID = library.bind(ctx.params.id,source.id,ctx.user.id,input.make_default !== false,requested);
      if (input.connection_credential_id === undefined) db.run("UPDATE machine_credentials SET policy_source=? WHERE id=?",input.retention === undefined ? "default" : "explicit",bindingID);
    });
    const binding = credentialRows(ctx.params.id).find(value => value.id === bindingID)!;
    const warning = binding.retention === "permanent" ? "已确认无固定期限保存；建议优先短期保存，可随时撤销。" : "连接凭据按所选期限保存；建议不要长期保存。";
    ctx.json({...binding,credential_id:bindingID,reused,warning},201);
  };
  const deploymentView = (value: any) => ({ id: value.id, machine_id: value.machine_id, credential_id: value.credential_id, status: value.status, version: value.version, arch: value.arch, initial_label_id: value.initial_label_id, plan: parseJSON(value.plan_json, {}), receipt: parseJSON(value.receipt_json, {}), error: value.error, created_at: value.created_at, created_by: value.created_by, approved_at: value.approved_at, started_at: value.started_at, finished_at: value.finished_at,
    enrollment_id:value.enrollment_id,execution_stage:value.execution_stage,resolved_at:value.resolved_at,resolved_by:value.resolved_by,resolution_reason:value.resolution_reason });
  const deployments = (machineID: string) => db.all<any>("SELECT * FROM machine_deployments WHERE machine_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",machineID).map(deploymentView);
  const deploymentRecord = (machineID: string,deploymentID: string) => {
    const value=db.get<any>("SELECT * FROM machine_deployments WHERE machine_id=? AND id=?",machineID,deploymentID);
    if(!value)fail(404,"部署计划不存在"); return deploymentView(value);
  };
  const sshCredential = (machineID: string, credentialID?: string, allowOneTime = false) => {
    const machine = get(machineID);
    if (machine.connection_method !== "direct_ssh") fail(400, "仅支持直接 SSH 连接，请先更新主机连接配置");
    let selected = credentialID;
    if (!selected) {
      const keys = credentialRows(machineID).filter(c => (c.method === "ssh_key" || c.method === "password" && (allowOneTime || ["temporary", "managed", "permanent"].includes(c.retention))) && !c.revoked_at && !c.secret_cleared_at && machineCredentialCurrent(c, now()));
      if (machine.default_credential_id) {
        const preferred = keys.find(c => c.id === machine.default_credential_id);
        if (!preferred) fail(409, "主机默认连接凭据已失效，请更新默认凭据");
        selected = preferred.id;
      }
      if (!selected && !keys.length) fail(400, allowOneTime ? "请先添加有效的 SSH 私钥或密码凭据" : "请先添加有效的 SSH 私钥或可复用密码；一次性密码不能用于自动安装或卸载");
      if (!selected && keys.length > 1) fail(409, "存在多个有效 SSH 凭据，请明确选择 credential_id");
      selected ??= keys[0].id;
    }
    const credential = ensureCredential(machineID, text(selected, "credential_id", 64));
    if (credential.method !== "ssh_key" && !(credential.method === "password" && (allowOneTime || ["temporary", "managed", "permanent"].includes(credential.retention)))) fail(400, "自动 SSH 安装和卸载需要私钥或可复用密码；一次性密码仅用于单次检查或终端");
    return { machine, credential };
  };
  const decryptKey = (machineID: string, credential: any) => {
    try {
      const envelope = parseJSON<{machine_id?: string; credential_id?: string; connection_credential_id?: string; secret?: string}>(deps.decrypt(credential.secret_encrypted), {});
      if (!envelope.secret || (credential.connection_credential_id ? envelope.connection_credential_id !== credential.connection_credential_id : envelope.machine_id !== machineID || envelope.credential_id !== credential.id)) throw Error();
      return envelope.secret;
    } catch { fail(500, "凭据解密或绑定校验失败，请重新登记私钥"); }
  };
  const acquireTerminal: MachineTerminalAccess["acquireTerminal"] = (machineID, credentialID, invalidate) => {
    idle(machineID);
    assertNoPendingAgentUpdate(db, "", machineID);
    const { machine, credential } = sshCredential(machineID, credentialID, true);
    const lease: TerminalLease = {
      machine, credentialID: credential.id, credentialMethod: credential.method,
      privateKey: credential.method === "ssh_key" ? decryptKey(machineID, credential) : "",
      password: credential.method === "password" ? decryptSecret(machineID, credential) : "",
      valid() {
        if (released) return false;
        try {
          ensureCredential(machineID, credential.id);
          return targetRevision(get(machineID)) === revision;
        } catch { return false; }
      },
      verifyHostKey(key) {
        if (!lease.valid()) return false;
        const accepted = recordMachineHostKey(db, machine, key, iso(now()), () => {
          if (released) return false;
          try { ensureCredential(machineID, credential.id, false); return true; } catch { return false; }
        });
        if (accepted) revision = targetRevision(machine);
        return accepted;
      },
      markUsed() { db.run("UPDATE machine_credentials SET last_used_at=? WHERE id=?", iso(now()), credential.id); library.used(credential.id); },
      release() {
        if (released) return;
        released = true;
        lease.privateKey = ""; lease.password = "";
        if (credential.method === "password" && credential.retention === "one_time") clearCredential(credential.id, "consumed");
        terminals.delete(machineID);
        busy.delete(machineID);
      },
    };
    let revision = targetRevision(machine);
    let released = false;
    busy.add(machineID);
    terminals.set(machineID, { credentialID: credential.id, invalidate });
    return lease;
  };
  const decryptSecret = (machineID: string, credential: any) => {
    try {
      const envelope = parseJSON<{machine_id?: string; credential_id?: string; connection_credential_id?: string; secret?: string}>(deps.decrypt(credential.secret_encrypted), {});
      if (!envelope.secret || (credential.connection_credential_id ? envelope.connection_credential_id !== credential.connection_credential_id : envelope.machine_id !== machineID || envelope.credential_id !== credential.id)) throw Error();
      return envelope.secret;
    } catch { fail(500, "凭据解密或绑定校验失败，请重新登记连接凭据"); }
  };
  const authentication = (machineID: string, credential: any) => credential.method === "password"
    ? { privateKey: "", password: decryptSecret(machineID, credential), credentialID: credential.id }
    : { privateKey: decryptKey(machineID, credential), credentialID: credential.id };
  const markCredentialUsed = (credentialID: string) => {
    db.run("UPDATE machine_credentials SET last_used_at=? WHERE id=?", iso(now()), credentialID);
    library.used(credentialID);
  };
  const runSSH: SSHRunner = async input => {
    const target = input.machine;
    const verifyHostKey = (key: Buffer) => {
      if (input.signal.aborted) return false;
      try {
        if (input.credentialID) ensureCredential(target.id, input.credentialID);
        return recordMachineHostKey(db, target, key, iso(now()), () => {
          if (input.signal.aborted) return false;
          try { if (input.credentialID) ensureCredential(target.id, input.credentialID, false); return true; } catch { return false; }
        });
      } catch { return false; }
    };
    const output = await (options.sshRunner ?? defaultSSHRunner)({ ...input, verifyHostKey });
    input.signal.throwIfAborted();
    if (targetRevision(get(target.id)) !== targetRevision(target) || !target.host_key_fingerprint) throw new SSHError("host_key_mismatch");
    return output;
  };
  const checkSSH = async (machineID: string, input: { credential_id?: string }, actorID: string, signal: AbortSignal): Promise<SSHCheckResult> => {
    parameters(record(input), ["credential_id"]);
    idle(machineID);
    const { machine, credential } = sshCredential(machineID, input.credential_id, true);
    let command: string;
    try { command = preflightCommand(deps.externalURL); } catch { fail(400, "请先将平台外部地址配置为目标机器可访问的 HTTPS 地址"); }
    const at = now();
    const privilegeBinding = () => ({ checked_at: iso(at), expires_at: iso(new Date(at.getTime() + PLAN_SECONDS * 1000)),
      machine_revision: targetRevision(machine),
      credential_binding_revision: hash(JSON.stringify([credential.id, credential.connection_credential_id ?? "", credential.method, credential.secret_fingerprint, credential.retention, credential.expires_at, credential.revoked_at ?? "", credential.secret_cleared_at ?? ""])),
      endpoint_fingerprint: hash(JSON.stringify([machine.address, machine.port, machine.username, machine.host_key_fingerprint, deps.externalURL])) });
    const result: SSHCheckResult = { id: id(), machine_id: machineID, credential_id: credential.id,
      connected: false, ready: false, platform: "", arch: "", checks: {}, error_code: "",
      privilege: { ...unknownSSHPrivilege(), ...privilegeBinding() },
      agent_installation: { state: "unknown" }, discovery: unavailableSSHDiscovery(), checked_at: iso(at), expires_at: iso(new Date(at.getTime() + PLAN_SECONDS * 1000)) };
    busy.add(machineID);
    const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
    try {
      signal.throwIfAborted();
      const output = await runSSH({
        machine,
        privateKey: credential.method === "ssh_key" ? decryptKey(machineID, credential) : "",
        password: credential.method === "password" ? decryptSecret(machineID, credential) : undefined,
        command, credentialID: credential.id, signal: checkSignal, port: machine.port, timeoutMs: CHECK_TIMEOUT_MS,
      });
      result.connected = true;
      const parsed = parsePreflight(output.stdout, iso(now()));
      Object.assign(result, parsed, { privilege: { ...parsed.privilege, ...privilegeBinding() } });
      if (!result.ready) result.error_code = "prerequisites_missing";
      if (result.discovery.status === "succeeded") {
        try {
          const saved = recordSSHHostNetwork(db, machine, result.discovery, () => {
            checkSignal.throwIfAborted();
            ensureCredential(machineID, credential.id, false);
            const current = db.get<any>("SELECT * FROM managed_machines WHERE id=?", machineID);
            return !!current && targetRevision(current) === targetRevision(machine);
          });
          if (!saved) result.discovery = unavailableSSHDiscovery();
        } catch {
          // Optional metadata must never turn a successful installation check
          // into a failure, or survive cancellation/revocation/target changes.
          result.discovery = unavailableSSHDiscovery();
        }
      }
      db.run("UPDATE machine_credentials SET last_used_at=? WHERE id=?", iso(now()), credential.id); library.used(credential.id);
    } catch (error) {
      result.error_code = signal.aborted ? "cancelled" : checkSignal.aborted ? "timed_out" : error instanceof SSHError ? error.code : "ssh_failed";
    } finally {
      // Preserve explicitly selected reusable policies; legacy one-time
      // passwords are consumed even after a failed or cancelled attempt.
      if (credential.method === "password" && credential.retention === "one_time") clearCredential(credential.id, "consumed", actorID);
      busy.delete(machineID);
    }
    db.run("INSERT INTO machine_ssh_checks(id,machine_id,credential_id,target_revision,result_json,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      result.id, machineID, credential.id, targetRevision(machine), JSON.stringify(result), actorID, iso(at));
    return result;
  };
  const checked = (machine: MachineSummary, checkID: string, credentialID?: string) => {
    const saved = db.get<any>("SELECT * FROM machine_ssh_checks WHERE id=? AND machine_id=?", text(checkID, "check_id", 64), machine.id);
    if (!saved) fail(404, "SSH 检查记录不存在，请先执行安装检查");
    const result = parseJSON<SSHCheckResult | undefined>(saved.result_json, undefined);
    if (result?.ready !== true || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= now().getTime() || saved.target_revision !== targetRevision(machine)) fail(409, "SSH 检查未通过、已过期或主机连接已变更，请重新检查");
    if (credentialID && credentialID !== saved.credential_id) fail(409, "所选 SSH 凭据与 SSH 检查不一致，请重新检查");
    return result;
  };
  const uninstallations = registerMachineUninstallations(deps, { get, idle, revision: targetRevision, checked, credential: sshCredential, authentication, markCredentialUsed, busy, runner: runSSH, safe });
  const agentUpdates = registerMachineAgentUpdates(deps, { get, idle, revision: targetRevision, credential: sshCredential, authentication, markCredentialUsed, busy, runner: runSSH, safe }, {
    credentials: options.agentCredentials, downloadsDir: options.downloadsDir ?? join(process.cwd(), "downloads"), dataDir: options.dataDir ?? join(process.cwd(), ".local-dev"),
    pollIntervalMs: options.updatePollIntervalMs, healthTimeoutMs: options.updateHealthTimeoutMs,
  });
  const createPlan = (machineID: string, input: InstallPlanInput, actorID: string) => {
    parameters(record(input), ["check_id", "credential_id", "version", "arch", "initial_label_id"]);
    idle(machineID);
    assertNoPendingMachineInstallation(db,machineID);
    assertNoPendingAgentUpdate(db, "", machineID);
    uninstallations.assertFree(machineID);
    const current = get(machineID), check = checked(current, input.check_id, input.credential_id);
    const { machine, credential } = sshCredential(machineID, check.credential_id);
    if (!replaceableAgentBinding(db, machine.agent_id, iso(now())) || check.agent_installation?.state !== "absent") fail(409, "已发现或无法排除已有 Agent 安装，请先核对现有节点，不可覆盖安装");
    const version = text(input.version ?? "0.1.0", "version", 64), arch = text(input.arch ?? check.arch, "arch", 16);
    if (!VERSION.test(version) || !ARCHES.has(arch)) fail(400, "invalid version or arch");
    if (arch !== check.arch) fail(409, "所选架构与 SSH 检查结果不一致");
    const at = now(), deploymentID = id();
    const planBody = {
      machine: { id: machine.id, name: machine.name, address: machine.address, port: machine.port, username: machine.username, agent_id: machine.agent_id },
      credential: { id: credential.id, method: credential.method, retention: credential.retention, expires_at: credential.expires_at },
      check_id: check.id, target_revision: targetRevision(machine), preflight: check,
      version, arch, initial_label_id: text(input.initial_label_id ?? "", "initial_label_id", 128, false), expires_at: check.expires_at,
      steps: ["自动校验主机公钥", "建立受限 SSH 连接", "下载固定版本 Agent 并校验 SHA256", "通过 stdin 注入一次性 enrollment token", "安装独立 systemd Agent", "等待 Agent 激活回执"],
      warnings: ["AI 不会读取或发送 SSH 秘密。", "用户确认后才执行固定部署流程。", "SSH 密码建议只使用一次，不要长期保存。", "Agent 激活后日常操作优先使用 Agent 通道。"],
    };
    db.run(`INSERT INTO machine_deployments(id,machine_id,credential_id,status,version,arch,initial_label_id,plan_json,created_at,created_by,execution_stage) VALUES(?,?,?,?,?,?,?,?,?,?,'planned')`,
      deploymentID, machine.id, credential.id, "awaiting_approval", version, arch, planBody.initial_label_id, JSON.stringify(planBody), iso(at), actorID);
    return { id: deploymentID, machine_id: machineID, status: "awaiting_approval", plan: planBody,
      review_url: `/machines?machine=${encodeURIComponent(machineID)}&deployment=${encodeURIComponent(deploymentID)}` };
  };
  const plan = async (ctx: Context) => {
    admin(ctx);
    ctx.json(createPlan(ctx.params.id, await machineBody(ctx) as InstallPlanInput, ctx.user.id), 201);
  };
  const apply = async (ctx: Context) => {
    admin(ctx);
    const input = parameters(await machineBody(ctx), ["confirm"]);
    if (input.confirm !== true) fail(400, "必须明确确认部署计划");
    idle(ctx.params.id);
    assertNoPendingMachineInstallation(db,ctx.params.id);
    assertNoPendingAgentUpdate(db, "", ctx.params.id);
    uninstallations.assertFree(ctx.params.id);
    const machine = ensureMachine(ctx.params.id), deployment = db.get<any>("SELECT * FROM machine_deployments WHERE id=? AND machine_id=?", ctx.params.deploymentId, machine.id);
    if (!deployment) fail(404, "部署计划不存在");
    if (deployment.status !== "awaiting_approval") fail(409, "部署计划已执行或不可用");
    const savedPlan = parseJSON<any>(deployment.plan_json, {});
    if (!Number.isFinite(Date.parse(savedPlan.expires_at)) || Date.parse(savedPlan.expires_at) <= now().getTime()) {
      db.run("UPDATE machine_deployments SET status='cancelled',finished_at=?,error=? WHERE id=?", iso(now()), "部署计划已过期", deployment.id);
      fail(409, "部署计划已过期，请重新生成");
    }
    if (!savedPlan.target_revision || savedPlan.target_revision !== targetRevision(machine) || savedPlan.machine?.name !== machine.name) fail(409, "主机名称或连接已变更，请重新审阅并生成部署计划");
    if (savedPlan.machine?.agent_id !== machine.agent_id) fail(409, "主机 Agent 身份已变更，请重新检查并生成部署计划");
    checked(get(machine.id), savedPlan.check_id, deployment.credential_id);
    const credential = ensureCredential(machine.id, deployment.credential_id);
    if (credential.method !== "ssh_key" && !(credential.method === "password" && ["temporary", "managed", "permanent"].includes(credential.retention))) fail(400, "自动部署需要 SSH 私钥或可复用密码，一次性密码不能用于部署");
    if (!options.agentCredentials) fail(503, "Agent enrollment 尚未配置");
    const started = db.run(`UPDATE machine_deployments SET status='running',execution_stage='preflight',approved_at=?,started_at=? WHERE id=? AND status='awaiting_approval'
      AND NOT EXISTS (SELECT 1 FROM machine_deployments other WHERE other.machine_id=? AND other.id!=? AND ${unresolvedInstallationSQL(db,"other")})`, iso(now()), iso(now()), deployment.id,machine.id,deployment.id);
    if (!started.changes) fail(409, "部署计划已被其他请求执行");
    busy.add(machine.id);
    let enrollment: AgentEnrollmentIssued | undefined;
    let dispatched = false;
    let privateKey = "", password = "";
    try {
      const material = authentication(machine.id, credential);
      privateKey = material.privateKey; password = material.password ?? "";
      const observed = await runSSH({ credentialID: credential.id, machine: get(machine.id), privateKey, ...(password ? { password } : {}), command: preflightCommand(deps.externalURL), signal: ctx.signal, port: machine.port, timeoutMs: CHECK_TIMEOUT_MS });
      const fresh = parsePreflight(observed.stdout);
      const currentTarget = get(machine.id);
      if (!fresh.ready || fresh.agent_installation.state !== "absent" || currentTarget.agent_id !== machine.agent_id || !replaceableAgentBinding(db, currentTarget.agent_id, iso(now()))) fail(409, "发现已有 Agent 或安装条件已变化，未签发新身份");
      if (fresh.arch !== deployment.arch) fail(409, "主机架构与已审阅部署计划不一致，未签发新身份，请重新检查并生成计划");
      ensureCredential(machine.id, credential.id); checked(get(machine.id), savedPlan.check_id, credential.id);
      const issuing=db.run("UPDATE machine_deployments SET execution_stage='enrollment_issuing' WHERE id=? AND status='running' AND execution_stage='preflight' AND resolved_at=''",deployment.id);
      if(!issuing.changes)fail(409,"安装记录已进入恢复流程，旧请求不能签发新身份");
      if (deployment.initial_label_id && db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='machine_host_labels'")) {
        if (!db.get("SELECT 1 FROM agent_task_labels WHERE id=?", deployment.initial_label_id)) fail(409, "初始主机标签已删除，请重新生成部署计划");
        // The host may already have labels from an earlier installation. Use
        // the same atomic compiler validation as administrator label edits
        // before issuing an identity or installing a conflicting task set.
        const tasks = new NodeStore(db, now);
        tasks.setHostLabels(machine.id, [...tasks.hostLabels(machine.id), deployment.initial_label_id]);
      }
      enrollment = options.agentCredentials.issueEnrollment({ endpoint_origin: deps.externalURL, version: deployment.version, allowed_arch: [deployment.arch], initial_label_id: deployment.initial_label_id, created_by: ctx.user.id, machine_id: machine.id, previous_agent_id: machine.agent_id, deployment_id:deployment.id });
      const command = agentBootstrapCommand(deps.externalURL.replace(/\/$/, ""), deployment.version);
      const dispatching=db.run("UPDATE machine_deployments SET execution_stage='bootstrap_dispatched' WHERE id=? AND status='running' AND execution_stage='enrollment_issued' AND enrollment_id=? AND resolved_at=''",deployment.id,enrollment.enrollment_id);
      if(!dispatching.changes)fail(409,"安装记录已进入恢复流程，旧请求不能派发安装");
      dispatched = true;
      const result = await runSSH({ credentialID: credential.id, machine, privateKey, ...(password ? { password } : {}), command, enrollmentToken: enrollment.token_display_once, signal: ctx.signal, port: machine.port });
      const status = options.agentCredentials.enrollmentStatus(enrollment.enrollment_id);
      if (!status || status.status !== "active" || !status.agent_id) throw Error("Agent 未完成激活回执");
      const receipt = { stages: result.stages, stdout: redact(result.stdout, [enrollment.token_display_once, privateKey, password]), stderr: redact(result.stderr, [enrollment.token_display_once, privateKey, password]), enrollment_id: enrollment.enrollment_id, agent_id: status.agent_id };
      db.transaction(() => {
        const saved=db.run("UPDATE machine_deployments SET status='succeeded',finished_at=?,receipt_json=?,error='' WHERE id=? AND status='running' AND resolved_at=''", iso(now()), JSON.stringify(receipt), deployment.id);
        if(!saved.changes)fail(409,"安装记录已进入恢复流程，请只读核对，不覆盖已保存结果");
        db.run("UPDATE managed_machines SET agent_id=?,agent_last_seen=?,last_error='',updated_at=? WHERE id=?", status.agent_id, iso(now()), iso(now()), machine.id);
        db.run("UPDATE machine_credentials SET last_used_at=? WHERE id=?", iso(now()), credential.id); library.used(credential.id);
        for (const temporary of db.all<{ id: string }>("SELECT id FROM machine_credentials WHERE machine_id=? AND retention IN ('temporary','one_time')", machine.id))
          clearCredential(temporary.id, "agent_activated", ctx.user.id, true);
      });
      ctx.json({ id: deployment.id, status: "succeeded", receipt: { ...receipt, stdout: receipt.stdout.slice(-4000), stderr: receipt.stderr.slice(-4000) } });
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "部署失败", [enrollment?.token_display_once ?? "", privateKey, password]);
      if(dispatched){
        const failure="Agent 安装结果未知，请只读核对远端状态或人工检查后明确结束；不会自动重试";
        const saved=db.run("UPDATE machine_deployments SET status='unknown',error=?,receipt_json=? WHERE id=? AND status IN ('running','unknown') AND resolved_at=''",failure,JSON.stringify({stages:["bootstrap_dispatched"],enrollment_id:enrollment?.enrollment_id||"",error:failure}),deployment.id);
        if(saved.changes)db.run("UPDATE managed_machines SET last_error=?,updated_at=? WHERE id=?",failure,iso(now()),machine.id);
        throw new HTTPError(502,failure);
      }
      let activatedAgent = "", revokedCredentials = 0;
      if (enrollment) {
        const observed = options.agentCredentials.enrollmentStatus(enrollment.enrollment_id);
        if (observed?.status === "active" && observed.agent_id && observed.agent_id !== machine.agent_id) {
          activatedAgent = observed.agent_id;
          if (db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_enrollments'") && db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_credentials'"))
            revokedCredentials = db.run("UPDATE agent_credentials SET revoked_at=?,revoke_reason=? WHERE agent_id=(SELECT agent_id FROM agent_enrollments WHERE id=?) AND revoked_at IS NULL", iso(now()), "Agent installation failed or result could not be confirmed", enrollment.enrollment_id).changes;
        }
        options.agentCredentials.cancelEnrollment?.(enrollment.enrollment_id);
      }
      const failure = activatedAgent ? message + "；本次激活身份凭据已停用，请先核对远端安装状态后重新接入" : message;
      const failed=db.run("UPDATE machine_deployments SET status='failed',finished_at=?,error=?,receipt_json=? WHERE id=? AND status='running' AND resolved_at=''", iso(now()), failure.slice(0, 1000), JSON.stringify({ stages: ["failed"], error: failure.slice(0, 1000), ...(activatedAgent ? { agent_id: activatedAgent, credentials_revoked: revokedCredentials } : {}) }), deployment.id);
      if(failed.changes)db.run("UPDATE managed_machines SET last_error=?,updated_at=? WHERE id=?", failure.slice(0, 1000), iso(now()), machine.id);
      throw new HTTPError(502, failure);
    } finally { privateKey = ""; password = ""; busy.delete(machine.id); }
  };
  router.get("/api/v1/machines", safe((ctx) => { admin(ctx); ctx.json(list()); }));
  router.post("/api/v1/machines", safe(createMachine));
  router.get("/api/v1/machines/:id", safe((ctx) => { admin(ctx); ensureMachine(ctx.params.id); ctx.json({ machine: get(ctx.params.id), credentials: credentialRows(ctx.params.id), deployments: deployments(ctx.params.id), uninstallations: uninstallations.list(ctx.params.id), agent_updates: agentUpdates.list(ctx.params.id) }); }));
  router.put("/api/v1/machines/:id", safe(updateMachine));
  router.delete("/api/v1/machines/:id", safe((ctx) => {
    admin(ctx); ensureDeletable(ctx.params.id);
    db.transaction(() => {
      const target = db.get<{agent_id:string}>("SELECT agent_id FROM managed_machines WHERE id=?", ctx.params.id);
      if (!target) fail(404, "主机不存在");
      if (db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_platform_cluster_members'")
        && db.get("SELECT machine_id FROM ops_platform_cluster_members WHERE machine_id=?", ctx.params.id))
        fail(409, "主机仍属于集群，请先从集群移除");
      assertAgentDeletionSafe(ctx.params.id, target.agent_id);
      db.run("DELETE FROM managed_machines WHERE id=?", ctx.params.id);
    });
    ctx.json({ ok: true });
  }));
  router.post("/api/v1/machines/:id/ssh-check", safe(async ctx => { admin(ctx); ctx.json(await checkSSH(ctx.params.id, await machineBody(ctx), ctx.user.id, ctx.signal)); }));
  router.post("/api/v1/machines/:id/agent-link", safe(ctx => { admin(ctx); fail(410, "手工关联 Agent 已移除；请从已登记主机部署 Agent"); }));
  router.get("/api/v1/machines/:id/credentials", safe((ctx) => { admin(ctx); ensureMachine(ctx.params.id); ctx.json(credentialRows(ctx.params.id)); }));
  router.post("/api/v1/machines/:id/credentials", safe(addCredential));
  router.put("/api/v1/machines/:id/default-credential", safe(async ctx => {
    admin(ctx); ensureMachine(ctx.params.id);
    const input = parameters(await machineBody(ctx),["credential_id"]);
    const credential = ensureCredential(ctx.params.id,text(input.credential_id,"credential_id",64));
    db.run("UPDATE managed_machines SET default_credential_id=? WHERE id=?",credential.id,ctx.params.id);
    ctx.json(get(ctx.params.id));
  }));
  router.delete("/api/v1/machines/:id/credentials/:credentialId", safe((ctx) => {
    admin(ctx);
    ensureMachine(ctx.params.id);
    const credential = db.get<any>("SELECT id FROM machine_credentials WHERE id=? AND machine_id=?", ctx.params.credentialId, ctx.params.id);
    if (!credential) fail(404, "连接凭据不存在");
    clearCredential(credential.id, "revoked", ctx.user.id);
    ctx.json({ ok: true, warning: "已解除此主机的凭据绑定；凭据库中的共享凭据保持不变。" });
  }));
  router.get("/api/v1/machines/:id/deployments", safe((ctx) => { admin(ctx); ensureMachine(ctx.params.id); ctx.json(deployments(ctx.params.id)); }));
  router.post("/api/v1/machines/:id/deployments/plan", safe(plan));
  router.get("/api/v1/machines/:id/deployments/:deploymentId", safe((ctx) => { admin(ctx); ensureMachine(ctx.params.id); ctx.json(deploymentRecord(ctx.params.id,ctx.params.deploymentId)); }));
  router.post("/api/v1/machines/:id/deployments/:deploymentId/cancel", safe((ctx) => {
    admin(ctx);
    ensureMachine(ctx.params.id);
    idle(ctx.params.id);
    const deployment = db.get<any>("SELECT id,status FROM machine_deployments WHERE id=? AND machine_id=?", ctx.params.deploymentId, ctx.params.id);
    if (!deployment) fail(404, "部署计划不存在");
    if (deployment.status !== "awaiting_approval" && deployment.status !== "cancelled") fail(409, "只能取消尚未执行的部署计划");
    if (deployment.status === "awaiting_approval") db.run("UPDATE machine_deployments SET status='cancelled',finished_at=?,error=? WHERE id=? AND status='awaiting_approval'", iso(now()), "管理员已取消部署计划", deployment.id);
    ctx.json({ id: deployment.id, machine_id: ctx.params.id, status: "cancelled" });
  }));
  router.post("/api/v1/machines/:id/deployments/:deploymentId/apply", safe(apply));
  const dockerInstallations = registerMachineDocker(deps,{get,idle,credential:sshCredential,authentication,markCredentialUsed,busy,runner:runSSH,safe});
  registerInstallationRecovery(deps,{get,idle,revision:targetRevision,credential:sshCredential,authentication,markCredentialUsed,busy,runner:runSSH,safe,deployment:deploymentRecord,
    activated(machineID,actorID){for(const temporary of db.all<{id:string}>("SELECT id FROM machine_credentials WHERE machine_id=? AND retention IN ('temporary','one_time')",machineID))clearCredential(temporary.id,"agent_activated",actorID,true);}},options.agentCredentials);
  const assistantSafe = (machine: MachineSummary) => ({ ...machine, host_key_fingerprint: "", host_key_public_key: "", host_key_observed_at: "" });
  const assistantList = () => list().map(assistantSafe);
  const assistantGet = (machineID: string) => ({ ...assistantSafe(get(machineID)), ssh_credentials: credentialRows(machineID)
    .filter(c => (c.method === "ssh_key" || c.method === "password" && ["temporary", "managed", "permanent"].includes(c.retention)) && !c.revoked_at && !c.secret_cleared_at && machineCredentialCurrent(c, now()))
    .map(c => ({ id: c.id, method: c.method, expires_at: c.expires_at })) });
  const assistantPlan = createPlan;
  const assistantDeployment = (deploymentID: string) => {
    const value = db.get<any>("SELECT * FROM machine_deployments WHERE id=?", deploymentID);
    if (!value) fail(404, "部署记录不存在");
    const savedReceipt = parseJSON<any>(value.receipt_json, {});
    const receipt = {
      stages: Array.isArray(savedReceipt.stages) ? savedReceipt.stages.slice(0, 32).map((stage: unknown) => String(stage).slice(0, 128)) : [],
      ...(typeof savedReceipt.agent_id === "string" && savedReceipt.agent_id ? { agent_id: savedReceipt.agent_id } : {}),
      ...(typeof savedReceipt.enrollment_id === "string" && savedReceipt.enrollment_id ? { enrollment_id: savedReceipt.enrollment_id } : {}),
    };
    return { id: value.id, machine_id: value.machine_id, status: value.status, version: value.version, arch: value.arch, plan: parseJSON(value.plan_json, {}), receipt, error: value.error, created_at: value.created_at, started_at: value.started_at, finished_at: value.finished_at,
      enrollment_id:value.enrollment_id,execution_stage:value.execution_stage,resolved_at:value.resolved_at,resolved_by:value.resolved_by,resolution_reason:value.resolution_reason };
  };
  return { list, get, assistantList, assistantGet, checkSSH, assistantPlan, assistantDeployment, acquireTerminal, agentUpdates,
    registerExecutorBootstrap(store) {
      const access={get,idle,revision:targetRevision,credential:sshCredential,authentication,markCredentialUsed,busy,runner:runSSH,safe,check:checkSSH};
      const bootstrap=registerMachineExecutorBootstrap(deps,access,store,{
        downloadsDir:options.downloadsDir ?? join(process.cwd(),"downloads"),dataDir:options.dataDir ?? join(process.cwd(),".local-dev"),
      });
      const maintenance=registerMachineExecutorMaintenance(deps,access,store);
      return {async close(){await Promise.allSettled([bootstrap.close?.(),maintenance.close?.()]);}};
    },
    async close() {
      clearInterval(cleanupTimer);
      for (const terminal of [...terminals.values()]) terminal.invalidate();
      await dockerInstallations.close();
      await agentUpdates.close?.();
    },
  };
}
