import { agentBootstrapCommand, agentProbeCommand, parseAgentProbe } from "./machine-agent-lifecycle.js";
import { createAgentLifecycleSchema, assertAgentActive } from "./agent-lifecycle.js";
import { createUninstallationSchema, registerMachineUninstallations, type UninstallationStatus } from "./machine-uninstallations.js";
import { id, hash } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import type { Context, Dependencies, Handler, Module } from "../shared/types.js";
import type {
  AgentCredentialStore,
  AgentEnrollmentIssued,
} from "./agent-credentials.js";

import { defaultSSHRunner, passwordSSHRunner, SSHError, preflightCommand, parsePreflight, type SSHRunner } from "./machine-ssh.js";
export type { SSHRunInput, SSHRunner } from "./machine-ssh.js";

export type ConnectionMethod = "direct_ssh" | "bastion" | "ssm" | "manual_script";
export type CredentialMethod = "ssh_key" | "password" | "manual_script";
export type CredentialRetention = "temporary" | "managed" | "one_time" | "none";
export type CredentialClearReason = "expired" | "revoked" | "consumed" | "agent_activated";
export type MachineCapabilityReason = "host_busy" | "direct_ssh_required" | "host_fingerprint_required" | "ssh_credential_required" | "ssh_key_required" | "agent_not_linked" | "agent_task_busy" | "uninstallation_pending" | "uninstallation_unknown" | "";
export interface MachineCapability { available: boolean; reason: MachineCapabilityReason }
export type MachineStatus = "unknown" | "online" | "offline" | "installing" | "uninstalled" | "removed" | "error";
export type DeploymentStatus = "awaiting_approval" | "running" | "succeeded" | "failed" | "cancelled";

const MACHINE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const ARCHES = new Set(["amd64", "arm64"]);
const CONNECTIONS = new Set<ConnectionMethod>(["direct_ssh", "bastion", "ssm", "manual_script"]);
const CREDENTIALS = new Set<CredentialMethod>(["ssh_key", "password", "manual_script"]);
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/=_-]{16,128}$/;
const PASSWORD_MAX_SECONDS = 60 * 60;
const TEMPORARY_KEY_SECONDS = 60 * 60;
const MANAGED_KEY_DEFAULT_SECONDS = 90 * 24 * 60 * 60;
const KEY_MAX_SECONDS = 365 * 24 * 60 * 60;
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
const safeFingerprint = (value: unknown, required = false) => {
  const fingerprint = text(value, "host_key_fingerprint", 160, required);
  if (fingerprint && !FINGERPRINT.test(fingerprint)) fail(400, "invalid host_key_fingerprint");
  return fingerprint;
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
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  connection_method: ConnectionMethod;
  host_key_fingerprint: string;
  host_key_status: "unconfigured" | "confirmed";
  platform: string;
  arch: string;
  agent_id: string;
  agent_status: MachineStatus;
  credential_count: number;
  active_credential_count: number;
  active_ssh_credential_count: number;
  active_ssh_key_count: number;
  ssh_recovery_available: boolean;
  capabilities: { terminal: MachineCapability; ssh_check: MachineCapability; deploy_agent: MachineCapability; uninstall_agent: MachineCapability };
  last_deployment_status: DeploymentStatus | "";
  last_uninstallation_status: UninstallationStatus | "";
  updated_at: string;
  created_at: string;
}

export interface SSHCheckResult {
  id: string; machine_id: string; credential_id: string; connected: boolean; ready: boolean;
  platform: string; arch: string; checks: Record<string, boolean>; error_code: string;
  checked_at: string; expires_at: string;
  agent_installation: { state: "present" | "absent" | "unknown" };
}
export interface InstallPlanInput {
  check_id: string; credential_id?: string; version: string; arch: string; initial_label_id?: string;
}

export interface ManagedMachineStore {
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
}

export interface TerminalLease {
  machine: MachineSummary;
  credentialID: string;
  credentialMethod: "ssh_key" | "password";
  privateKey: string;
  password: string;
  valid(): boolean;
  markUsed(): void;
  release(): void;
}
export interface MachineTerminalAccess {
  acquireTerminal(machineID: string, credentialID: string | undefined, invalidate: () => void): TerminalLease;
}

export function registerManagedMachines(deps: Dependencies, options: ManagedMachinesOptions = {}): Module & ManagedMachineStore & MachineTerminalAccess {
  const { db, router } = deps;
  createAgentLifecycleSchema(db);
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
  createUninstallationSchema(deps);
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
  db.run("UPDATE machine_credentials SET retention='none' WHERE method='manual_script' AND policy_source='legacy'");
  // Password hashes would allow offline dictionary guesses; only SSH key
  // fingerprints are retained, including after upgrading an older database.
  db.run("UPDATE machine_credentials SET secret_fingerprint='' WHERE method='password' AND secret_fingerprint!=''");
  const now = () => deps.now();
  const busy = new Set<string>();
  const terminals = new Map<string, { credentialID: string; invalidate: () => void }>();
  const clearCredential = (credentialID: string, reason: CredentialClearReason, actorID = "system", withinTransaction = false) => {
    let invalidatedMachine = "";
    const mutate = () => {
      const credential = db.get<any>("SELECT * FROM machine_credentials WHERE id=?", credentialID);
      if (!credential) return;
      const at = iso(now());
      // Keep the first reason and event even when expiry/revoke/release race.
      // A repeated cleanup still removes any accidentally restored envelope.
      db.run(`UPDATE machine_credentials SET secret_encrypted='',
        secret_cleared_at=CASE WHEN secret_cleared_at='' THEN ? ELSE secret_cleared_at END,
        clear_reason=CASE WHEN clear_reason='' THEN ? ELSE clear_reason END,
        revoked_at=CASE WHEN ?='expired' THEN revoked_at ELSE COALESCE(revoked_at,?) END WHERE id=?`,
        at, reason, reason, at, credentialID);
      if (!credential.secret_cleared_at) db.run("INSERT INTO machine_credential_events(id,machine_id,credential_id,event,actor_id,created_at) VALUES(?,?,?,?,?,?)",
        id(), credential.machine_id, credentialID, reason, actorID, at);
      db.run("UPDATE machine_deployments SET status='cancelled',finished_at=?,error=? WHERE credential_id=? AND status='awaiting_approval'",
        at, "连接凭据已失效，请添加凭据后重新检查并生成部署计划", credentialID);
      db.run("UPDATE machine_uninstallations SET status='cancelled',finished_at=?,error=? WHERE credential_id=? AND status='awaiting_approval'", at, "连接凭据已失效，请重新检查卸载计划", credentialID);
      if (terminals.get(credential.machine_id)?.credentialID === credentialID) invalidatedMachine = credential.machine_id;
    };
    if (withinTransaction) mutate(); else db.transaction(mutate);
    // Closing a password terminal calls lease.release(), which can safely run
    // the same idempotent cleanup without nesting it inside this transaction.
    if (invalidatedMachine) terminals.get(invalidatedMachine)?.invalidate();
  };
  const cleanupInvalidCredentials = () => {
    const at = iso(now());
    const invalid = db.all<any>(`SELECT id,revoked_at FROM machine_credentials
      WHERE (revoked_at IS NOT NULL OR expires_at<=?) AND (secret_encrypted!='' OR secret_cleared_at='')`, at);
    for (const credential of invalid) clearCredential(credential.id, credential.revoked_at ? "revoked" : "expired");
  };
  cleanupInvalidCredentials();
  const cleanupTimer = setInterval(() => {
    try { cleanupInvalidCredentials(); } catch (error) { deps.logger.error(error); }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  const idle = (machineID: string) => { cleanupInvalidCredentials(); if (busy.has(machineID)) fail(409, "此主机有终端、检查或部署正在进行，请先结束后重试"); };
  const targetRevision = (machine: any) => hash(JSON.stringify([machine.address, machine.port, machine.username, machine.connection_method, machine.host_key_fingerprint, deps.externalURL]));
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
  const machineSelect = `SELECT m.*,COALESCE((SELECT count(*) FROM machine_credentials c WHERE c.machine_id=m.id),0) credential_count,
      COALESCE((SELECT count(*) FROM machine_credentials c WHERE c.machine_id=m.id AND c.revoked_at IS NULL AND c.expires_at>? AND c.secret_cleared_at='' AND (c.method='manual_script' OR c.secret_encrypted!='')),0) active_credential_count,
      COALESCE((SELECT count(*) FROM machine_credentials c WHERE c.machine_id=m.id AND c.revoked_at IS NULL AND c.expires_at>? AND c.secret_cleared_at='' AND c.method IN ('ssh_key','password') AND c.secret_encrypted!=''),0) active_ssh_credential_count,
      COALESCE((SELECT count(*) FROM machine_credentials c WHERE c.machine_id=m.id AND c.revoked_at IS NULL AND c.expires_at>? AND c.secret_cleared_at='' AND c.method='ssh_key' AND c.secret_encrypted!=''),0) active_ssh_key_count,
      COALESCE((SELECT d.status FROM machine_deployments d WHERE d.machine_id=m.id ORDER BY d.created_at DESC LIMIT 1),'') last_deployment_status,
      COALESCE((SELECT u.status FROM machine_uninstallations u WHERE u.machine_id=m.id ORDER BY u.created_at DESC,u.id DESC LIMIT 1),'') last_uninstallation_status,
      COALESCE(a.last_seen,'') AS node_last_seen,COALESCE(l.state,'active') AS node_lifecycle_state
     FROM managed_machines m LEFT JOIN agents a ON a.id=m.agent_id LEFT JOIN agent_lifecycle l ON l.agent_id=m.agent_id`;
  const row = (machineID: string) => {
    cleanupInvalidCredentials();
    const at = iso(now());
    return db.get<any>(machineSelect + " WHERE m.id=?", at, at, at, machineID);
  };
  const summary = (value: any): MachineSummary => {
    if (!value) fail(404, "主机不存在");
    const activeSSH = Number(value.active_ssh_credential_count ?? 0), activeKeys = Number(value.active_ssh_key_count ?? 0);
    const capability = (keyRequired = false): MachineCapability => {
      const reason: MachineCapabilityReason = busy.has(value.id) ? "host_busy"
        : value.connection_method !== "direct_ssh" ? "direct_ssh_required"
        : !value.host_key_fingerprint ? "host_fingerprint_required"
        : (keyRequired ? !activeKeys : !activeSSH) ? (keyRequired ? "ssh_key_required" : "ssh_credential_required") : "";
      return { available: !reason, reason };
    };
    const pendingUninstall = uninstallations.pending(value.id);
    const uninstallReason = pendingUninstall ? (pendingUninstall.status === "unknown" ? "uninstallation_unknown" : "uninstallation_pending")
      : uninstallations.taskBusy(value.agent_id) ? "agent_task_busy" : "";
    const uninstallCapability = capability(true);
    if (uninstallCapability.available && uninstallReason) { uninstallCapability.available = false; uninstallCapability.reason = uninstallReason; }
    const deployCapability = capability(true);
    if (deployCapability.available && uninstallReason) { deployCapability.available = false; deployCapability.reason = uninstallReason; }
    return {
      id: value.id, name: value.name, address: value.address, port: Number(value.port), username: value.username,
      connection_method: value.connection_method, host_key_fingerprint: value.host_key_fingerprint,
      host_key_status: value.host_key_fingerprint ? "confirmed" : "unconfigured",
      platform: value.platform, arch: value.arch, agent_id: value.agent_id,
      agent_status: statusOf(value, now()), credential_count: Number(value.credential_count ?? 0),
      active_credential_count: Number(value.active_credential_count ?? 0),
      active_ssh_credential_count: activeSSH, active_ssh_key_count: activeKeys,
      ssh_recovery_available: value.connection_method === "direct_ssh" && Boolean(value.host_key_fingerprint) && activeSSH > 0,
      capabilities: { terminal: capability(), ssh_check: capability(), deploy_agent: deployCapability, uninstall_agent: uninstallCapability },
      last_deployment_status: value.last_deployment_status || "", last_uninstallation_status: value.last_uninstallation_status || "", updated_at: value.updated_at, created_at: value.created_at,
    };
  };
  const list = () => {
    cleanupInvalidCredentials();
    const at = iso(now());
    return db.all<any>(machineSelect + " ORDER BY m.updated_at DESC,m.id", at, at, at).map(summary);
  };
  const get = (machineID: string) => summary(row(machineID));
  const credentialRows = (machineID: string) => {
    cleanupInvalidCredentials();
    return db.all<any>(
      `SELECT id,method,secret_fingerprint,retention,policy_source,secret_cleared_at,clear_reason,created_at,expires_at,revoked_at,last_used_at,created_by
       FROM machine_credentials WHERE machine_id=? ORDER BY created_at DESC`, machineID,
    );
  };
  const ensureMachine = (machineID: string) => {
    if (!MACHINE_ID.test(machineID) || !db.get("SELECT id FROM managed_machines WHERE id=?", machineID)) fail(404, "主机不存在");
    return row(machineID)!;
  };
  const ensureDeletable = (machineID: string) => {
    ensureMachine(machineID);
    uninstallations.assertFree(machineID);
    // Keep the existing in-flight lease guard first so an active terminal,
    // check, or deployment receives the precise busy error.
    idle(machineID);
    if (db.get("SELECT id FROM machine_credentials WHERE machine_id=? AND revoked_at IS NULL AND expires_at>? LIMIT 1", machineID, iso(now())))
      fail(409, "请先撤销或等待所有有效连接凭据失效后再删除主机");
    if (db.get("SELECT id FROM machine_deployments WHERE machine_id=? AND status IN ('awaiting_approval','running') LIMIT 1", machineID))
      fail(409, "该主机有未结束的部署任务，请先完成或取消后再删除");
  };
  const ensureCredential = (machineID: string, credentialID: string, cleanup = true) => {
    if (cleanup) cleanupInvalidCredentials();
    const value = db.get<any>("SELECT * FROM machine_credentials WHERE id=? AND machine_id=?", credentialID, machineID);
    if (!value) fail(404, "连接凭据不存在");
    if (value.revoked_at) fail(409, "连接凭据已撤销");
    if (Date.parse(value.expires_at) <= now().getTime()) fail(409, "连接凭据已过期");
    if (value.secret_cleared_at || (value.method !== "manual_script" && !value.secret_encrypted)) fail(409, "连接凭据秘密已清除，请添加新凭据");
    return value;
  };
  const validateMachine = (input: Record<string, any>, existing?: any) => {
    const name = text(input.name ?? existing?.name, "name", 128);
    const address = safeAddress(input.address ?? existing?.address);
    const port = integer(input.port ?? existing?.port, "port", 1, 65535, 22);
    const username = safeUsername(input.username ?? existing?.username);
    const connectionMethod = String(input.connection_method ?? existing?.connection_method ?? "manual_script") as ConnectionMethod;
    if (!CONNECTIONS.has(connectionMethod)) fail(400, "invalid connection_method");
    const fingerprint = safeFingerprint(input.host_key_fingerprint ?? existing?.host_key_fingerprint, false);
    const platform = text(input.platform ?? existing?.platform ?? "", "platform", 64, false);
    const arch = text(input.arch ?? existing?.arch ?? "", "arch", 16, false);
    if (arch && !ARCHES.has(arch)) fail(400, "invalid arch");
    return { name, address, port, username, connectionMethod, fingerprint, platform, arch };
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
    idle(ctx.params.id);
    uninstallations.assertFree(ctx.params.id);
    const existing = ensureMachine(ctx.params.id), input = await machineBody(ctx), value = validateMachine(input, existing), at = iso(now());
    idle(ctx.params.id);
    db.run(
      `UPDATE managed_machines SET name=?,address=?,port=?,username=?,connection_method=?,host_key_fingerprint=?,platform=?,arch=?,updated_at=? WHERE id=?`,
      value.name, value.address, value.port, value.username, value.connectionMethod, value.fingerprint, value.platform, value.arch, at, ctx.params.id,
    );
    ctx.json(get(ctx.params.id));
  };
  const addCredential = async (ctx: Context) => {
    admin(ctx);
    ensureMachine(ctx.params.id);
    const input = parameters(await machineBody(ctx), ["method", "secret", "expires_in_seconds", "retention", "confirm_managed"]), method = text(input.method, "method", 32) as CredentialMethod;
    if (!CREDENTIALS.has(method)) fail(400, "invalid credential method");
    let secret: string;
    if (method === "password") {
      // Whitespace is part of an SSH password; validation must not trim or
      // otherwise rewrite authentication material before encryption/use.
      if (typeof input.secret !== "string" || input.secret.length === 0 || Buffer.byteLength(input.secret) > 4096) fail(400, "invalid secret");
      secret = input.secret;
    } else secret = text(input.secret, "secret", method === "ssh_key" ? 64 << 10 : 4096, method !== "manual_script");
    if (method === "ssh_key" && !/PRIVATE KEY/.test(secret)) fail(400, "SSH 凭据必须是私钥内容");
    if (input.retention !== undefined && typeof input.retention !== "string") fail(400, "invalid retention");
    const retention = (input.retention ?? (method === "password" ? "one_time" : method === "manual_script" ? "none" : "temporary")) as CredentialRetention;
    if (method === "ssh_key" && retention !== "temporary" && retention !== "managed") fail(400, "SSH 私钥只支持临时接入或明确确认的长期托管");
    if (method === "password" && retention !== "one_time") fail(400, "密码只支持一次性使用，不能长期托管");
    if (method === "manual_script" && retention !== "none") fail(400, "手动脚本不保存秘密，不支持凭据托管策略");
    if (retention === "managed" && input.confirm_managed !== true) fail(400, "长期托管需要明确确认 confirm_managed=true");
    if (input.confirm_managed !== undefined && typeof input.confirm_managed !== "boolean") fail(400, "invalid confirm_managed");
    if (retention !== "managed" && input.confirm_managed === true) fail(400, "只有长期托管私钥可以确认长期保存");
    if (method === "manual_script" && secret) fail(400, "手动脚本模式不能保存秘密");
    const maxSeconds = retention === "managed" ? KEY_MAX_SECONDS : method === "password" ? PASSWORD_MAX_SECONDS : TEMPORARY_KEY_SECONDS;
    const defaultSeconds = retention === "managed" ? MANAGED_KEY_DEFAULT_SECONDS : method === "password" ? 900 : TEMPORARY_KEY_SECONDS;
    if (retention === "temporary" && Number(input.expires_in_seconds) > TEMPORARY_KEY_SECONDS) fail(400, "临时 SSH 私钥最长保存 1 小时；如需更长时间，请明确选择长期托管并确认");
    const requested = integer(input.expires_in_seconds, "expires_in_seconds", 60, maxSeconds, defaultSeconds);
    const policySource = input.retention === undefined ? "default" : "explicit";
    const at = now(), expires = new Date(at.getTime() + requested * 1000), credentialID = id();
    const envelope = method === "manual_script" ? "" : deps.encrypt(JSON.stringify({ machine_id: ctx.params.id, credential_id: credentialID, secret }));
    const fingerprint = method === "ssh_key" ? hash(secret).slice(0, 20) : "";
    db.transaction(() => {
      db.run(
      `INSERT INTO machine_credentials(id,machine_id,method,secret_encrypted,secret_fingerprint,retention,policy_source,created_at,expires_at,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?)`, credentialID, ctx.params.id, method, envelope, fingerprint, retention, policySource, iso(at), iso(expires), ctx.user.id,
      );
      db.run("INSERT INTO machine_credential_events(id,machine_id,credential_id,event,actor_id,created_at) VALUES(?,?,?,?,?,?)",
        id(), ctx.params.id, credentialID, "created", ctx.user.id, iso(at));
    });
    const warning = method === "password"
      ? "密码仅建议一次性使用，不要长期保存；自动 SSH 部署不使用密码凭据。"
      : method === "manual_script"
        ? "手动脚本模式不会保存秘密；请在目标主机执行一次性脚本，自动 SSH 部署只支持 SSH 私钥。"
        : retention === "managed" ? "已明确确认长期托管；建议按需轮换，Agent 激活后仍保留此 SSH 恢复通道。" : "临时私钥最长保存 1 小时，Agent 激活后自动清除；建议不要长期保存。";
    ctx.json({ credential_id: credentialID, method, retention, policy_source: policySource, secret_cleared_at: "", clear_reason: "", secret_fingerprint: fingerprint, expires_at: iso(expires), warning }, 201);
  };
  const deployments = (machineID: string) => db.all<any>(
    `SELECT id,machine_id,credential_id,status,version,arch,initial_label_id,plan_json,receipt_json,error,created_at,created_by,approved_at,started_at,finished_at FROM machine_deployments WHERE machine_id=? ORDER BY created_at DESC LIMIT 100`, machineID,
  ).map((value) => ({ id: value.id, machine_id: value.machine_id, credential_id: value.credential_id, status: value.status, version: value.version, arch: value.arch, initial_label_id: value.initial_label_id, plan: parseJSON(value.plan_json, {}), receipt: parseJSON(value.receipt_json, {}), error: value.error, created_at: value.created_at, created_by: value.created_by, approved_at: value.approved_at, started_at: value.started_at, finished_at: value.finished_at }));
  const sshCredential = (machineID: string, credentialID?: string, allowPassword = false) => {
    const machine = get(machineID);
    if (machine.connection_method !== "direct_ssh") fail(400, "自动 SSH 目前仅支持直接 SSH；跳板机和 SSM 请使用手动脚本");
    if (!machine.host_key_fingerprint) fail(400, "请先确认主机公钥指纹");
    let selected = credentialID;
    if (!selected) {
      const methods = allowPassword ? ["ssh_key", "password"] : ["ssh_key"];
      const keys = credentialRows(machineID).filter(c => methods.includes(c.method) && !c.revoked_at && !c.secret_cleared_at && Date.parse(c.expires_at) > now().getTime());
      if (!keys.length) fail(400, allowPassword ? "请先添加有效的 SSH 私钥或一次性密码凭据" : "请先添加有效的 SSH 私钥；密码和手动脚本不能用于自动 SSH");
      if (keys.length > 1) fail(409, allowPassword ? "存在多个有效 SSH 凭据，请明确选择 credential_id" : "存在多个有效 SSH 私钥，请明确选择 credential_id");
      selected = keys[0].id;
    }
    const credential = ensureCredential(machineID, text(selected, "credential_id", 64));
    if (credential.method !== "ssh_key" && !(allowPassword && credential.method === "password")) fail(400, "当前自动 SSH 只支持私钥；密码仅用于一次性 SSH 检查，手动脚本请在目标主机上执行");
    return { machine, credential };
  };
  const decryptKey = (machineID: string, credential: any) => {
    try {
      const envelope = parseJSON<{machine_id?: string; credential_id?: string; secret?: string}>(deps.decrypt(credential.secret_encrypted), {});
      if (envelope.machine_id !== machineID || envelope.credential_id !== credential.id || !envelope.secret) throw Error();
      return envelope.secret;
    } catch { fail(500, "凭据解密或绑定校验失败，请重新登记私钥"); }
  };
  const acquireTerminal: MachineTerminalAccess["acquireTerminal"] = (machineID, credentialID, invalidate) => {
    idle(machineID);
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
      markUsed() { db.run("UPDATE machine_credentials SET last_used_at=? WHERE id=?", iso(now()), credential.id); },
      release() {
        if (released) return;
        released = true;
        lease.privateKey = ""; lease.password = "";
        if (credential.method === "password") clearCredential(credential.id, "consumed");
        terminals.delete(machineID);
        busy.delete(machineID);
      },
    };
    const revision = targetRevision(machine);
    let released = false;
    busy.add(machineID);
    terminals.set(machineID, { credentialID: credential.id, invalidate });
    return lease;
  };
  const decryptSecret = (machineID: string, credential: any) => {
    try {
      const envelope = parseJSON<{machine_id?: string; credential_id?: string; secret?: string}>(deps.decrypt(credential.secret_encrypted), {});
      if (envelope.machine_id !== machineID || envelope.credential_id !== credential.id || !envelope.secret) throw Error();
      return envelope.secret;
    } catch { fail(500, "凭据解密或绑定校验失败，请重新登记连接凭据"); }
  };
  const checkSSH = async (machineID: string, input: { credential_id?: string }, actorID: string, signal: AbortSignal): Promise<SSHCheckResult> => {
    parameters(record(input), ["credential_id"]);
    idle(machineID);
    const { machine, credential } = sshCredential(machineID, input.credential_id, true);
    let command: string;
    try { command = preflightCommand(deps.externalURL); } catch { fail(400, "请先将平台外部地址配置为目标机器可访问的 HTTPS 地址"); }
    const at = now();
    const result: SSHCheckResult = { id: id(), machine_id: machineID, credential_id: credential.id,
      connected: false, ready: false, platform: "", arch: "", checks: {}, error_code: "",
      agent_installation: { state: "unknown" }, checked_at: iso(at), expires_at: iso(new Date(at.getTime() + PLAN_SECONDS * 1000)) };
    busy.add(machineID);
    const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
    try {
      signal.throwIfAborted();
      const output = await (options.sshRunner ?? (credential.method === "password" ? passwordSSHRunner : defaultSSHRunner))({
        machine,
        privateKey: credential.method === "ssh_key" ? decryptKey(machineID, credential) : "",
        password: credential.method === "password" ? decryptSecret(machineID, credential) : undefined,
        command, signal: checkSignal, port: machine.port, timeoutMs: CHECK_TIMEOUT_MS,
      });
      result.connected = true;
      Object.assign(result, parsePreflight(output.stdout));
      if (!result.ready) result.error_code = "prerequisites_missing";
      db.run("UPDATE machine_credentials SET last_used_at=? WHERE id=?", iso(now()), credential.id);
    } catch (error) {
      result.error_code = signal.aborted ? "cancelled" : checkSignal.aborted ? "timed_out" : error instanceof SSHError ? error.code : "ssh_failed";
    } finally {
      // Password credentials are deliberately one-shot: even a failed login
      // attempt must not leave a reusable password stored in the platform.
      if (credential.method === "password") clearCredential(credential.id, "consumed", actorID);
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
    if (credentialID && credentialID !== saved.credential_id) fail(409, "所选私钥与 SSH 检查不一致，请重新检查");
    return result;
  };
  const uninstallations = registerMachineUninstallations(deps, { get, idle, revision: targetRevision, checked, credential: sshCredential, decrypt: decryptKey, busy, runner: options.sshRunner ?? defaultSSHRunner, safe });
  const linkAgent = async (ctx: Context) => {
    admin(ctx);
    const input = parameters(record(await ctx.body()), ["agent_id", "credential_id"]);
    const agentID = text(input.agent_id, "agent_id", 256);
    if (!/^[A-Za-z0-9._:-]+$/.test(agentID)) fail(400, "invalid agent_id");
    idle(ctx.params.id); uninstallations.assertFree(ctx.params.id);
    const { machine, credential } = sshCredential(ctx.params.id, input.credential_id);
    const revision = targetRevision(machine), previousAgent = machine.agent_id;
    const assertTarget = () => {
      assertAgentActive(db, agentID);
      if (!db.get("SELECT id FROM agents WHERE id=?", agentID)) fail(404, "节点不存在");
      const independent = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_credentials'");
      if (!independent || !["control", "data"].every(audience => db.get("SELECT id FROM agent_credentials WHERE agent_id=? AND audience=? AND revoked_at IS NULL AND expires_at>? LIMIT 1", agentID, audience, iso(now()))))
        fail(409, "节点没有有效的独立 control/data 凭据，请重新接入后关联");
      const fresh = db.get<any>("SELECT * FROM managed_machines WHERE id=?", machine.id);
      if (!fresh) fail(404, "主机不存在");
      if (targetRevision(fresh) !== revision || fresh.agent_id !== previousAgent) fail(409, "主机连接或节点关联已变化，请重新核对");
      if (fresh.agent_id && fresh.agent_id !== agentID) fail(409, "此主机已关联其他节点，不能覆盖关联");
      if (db.get("SELECT id FROM managed_machines WHERE agent_id=? AND id!=? LIMIT 1", agentID, machine.id)) fail(409, "此节点已关联另一主机，请先核对身份");
      if (db.get("SELECT id FROM machine_deployments WHERE machine_id=? AND status IN ('awaiting_approval','running') LIMIT 1", machine.id)) fail(409, "请先完成或取消 Agent 安装计划");
      uninstallations.assertFree(machine.id);
      if (db.get("SELECT id FROM machine_uninstallations WHERE agent_id=? AND status IN ('awaiting_approval','running','unknown') LIMIT 1", agentID) || uninstallations.taskBusy(agentID))
        fail(409, "节点有未结束或结果未知的任务或卸载，请先完成或核对");
      ensureCredential(machine.id, credential.id, false);
    };
    assertTarget(); busy.add(machine.id);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
    try {
      const output = await (options.sshRunner ?? defaultSSHRunner)({ machine, privateKey: decryptKey(machine.id, credential), command: agentProbeCommand(), signal, port: machine.port, timeoutMs: CHECK_TIMEOUT_MS });
      signal.throwIfAborted();
      const observed = parseAgentProbe(output.stdout);
      if (observed.agent_id !== agentID) fail(409, "远端 Agent 身份与所选节点不一致，未建立关联");
      if (observed.installation !== "present" || !observed.program_complete || !observed.unit_managed || !observed.data_retained || observed.lifecycle_locked || observed.operation_lock)
        fail(409, "远端 Agent 不是完整受管安装或有未完成操作，请人工核对");
      // Expiry cleanup has its own audit transaction; complete it before the
      // atomic identity recheck, whose reads must never open nested transactions.
      cleanupInvalidCredentials();
      db.transaction(() => {
        assertTarget();
        const at = iso(now());
        db.run("UPDATE managed_machines SET agent_id=?,agent_last_seen='',last_error='',updated_at=? WHERE id=?", agentID, at, machine.id);
        db.run("UPDATE machine_credentials SET last_used_at=? WHERE id=?", at, credential.id);
        db.run("INSERT INTO machine_agent_link_events(id,machine_id,agent_id,credential_id,actor_id,verified_at) VALUES(?,?,?,?,?,?)", id(), machine.id, agentID, credential.id, ctx.user.id, at);
      });
      ctx.json(get(machine.id));
    } catch (error) {
      if (error instanceof HTTPError) throw error;
      if (error instanceof SSHError) fail(502, "SSH 身份核验失败，未建立关联：" + error.code);
      if (ctx.signal.aborted) fail(409, "身份核验已取消，未建立关联");
      if (signal.aborted) fail(504, "SSH 身份核验超时，未建立关联");
      fail(502, "SSH 身份核验失败，未建立关联");
    } finally { busy.delete(machine.id); }
  };
  const createPlan = (machineID: string, input: InstallPlanInput, actorID: string) => {
    parameters(record(input), ["check_id", "credential_id", "version", "arch", "initial_label_id"]);
    idle(machineID);
    uninstallations.assertFree(machineID);
    const current = get(machineID), check = checked(current, input.check_id, input.credential_id);
    const { machine, credential } = sshCredential(machineID, check.credential_id);
    if (machine.agent_id || check.agent_installation?.state !== "absent") fail(409, "已发现或无法排除已有 Agent 安装，请先核对现有节点，不可覆盖安装");
    const version = text(input.version ?? "0.1.0", "version", 64), arch = text(input.arch ?? check.arch, "arch", 16);
    if (!VERSION.test(version) || !ARCHES.has(arch)) fail(400, "invalid version or arch");
    if (arch !== check.arch) fail(409, "所选架构与 SSH 检查结果不一致");
    const at = now(), deploymentID = id();
    const planBody = {
      machine: { id: machine.id, name: machine.name, address: machine.address, port: machine.port, username: machine.username, agent_id: machine.agent_id },
      credential: { id: credential.id, method: credential.method, retention: credential.retention, expires_at: credential.expires_at },
      check_id: check.id, target_revision: targetRevision(machine), preflight: check,
      version, arch, initial_label_id: text(input.initial_label_id ?? "", "initial_label_id", 128, false), expires_at: check.expires_at,
      steps: ["确认主机公钥指纹", "建立受限 SSH 连接", "下载固定版本 Agent 并校验 SHA256", "通过 stdin 注入一次性 enrollment token", "安装独立 systemd Agent", "等待 Agent 激活回执"],
      warnings: ["AI 不会读取或发送 SSH 秘密。", "用户确认后才执行固定部署流程。", "SSH 密码建议只使用一次，不要长期保存。", "Agent 激活后日常操作优先使用 Agent 通道。"],
    };
    db.run(`INSERT INTO machine_deployments(id,machine_id,credential_id,status,version,arch,initial_label_id,plan_json,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
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
    uninstallations.assertFree(ctx.params.id);
    const machine = ensureMachine(ctx.params.id), deployment = db.get<any>("SELECT * FROM machine_deployments WHERE id=? AND machine_id=?", ctx.params.deploymentId, machine.id);
    if (!deployment) fail(404, "部署计划不存在");
    if (deployment.status !== "awaiting_approval") fail(409, "部署计划已执行或不可用");
    const savedPlan = parseJSON<any>(deployment.plan_json, {});
    if (!Number.isFinite(Date.parse(savedPlan.expires_at)) || Date.parse(savedPlan.expires_at) <= now().getTime()) {
      db.run("UPDATE machine_deployments SET status='cancelled',finished_at=?,error=? WHERE id=?", iso(now()), "部署计划已过期", deployment.id);
      fail(409, "部署计划已过期，请重新生成");
    }
    if (!savedPlan.target_revision || savedPlan.target_revision !== targetRevision(machine)) fail(409, "主机连接已变更，请重新检查并生成部署计划");
    checked(get(machine.id), savedPlan.check_id, deployment.credential_id);
    const credential = ensureCredential(machine.id, deployment.credential_id);
    if (credential.method !== "ssh_key") fail(400, "当前只支持 SSH 私钥自动部署；密码建议一次性手动使用，不要长期保存");
    if (!options.agentCredentials) fail(503, "Agent enrollment 尚未配置");
    if (!machine.host_key_fingerprint) fail(400, "请先确认主机公钥指纹");
    const started = db.run("UPDATE machine_deployments SET status='running',approved_at=?,started_at=? WHERE id=? AND status='awaiting_approval'", iso(now()), iso(now()), deployment.id);
    if (!started.changes) fail(409, "部署计划已被其他请求执行");
    busy.add(machine.id);
    let enrollment: AgentEnrollmentIssued | undefined;
    let privateKey = "";
    try {
      privateKey = decryptKey(machine.id, credential);
      const observed = await (options.sshRunner ?? defaultSSHRunner)({ machine: get(machine.id), privateKey, command: preflightCommand(deps.externalURL), signal: ctx.signal, port: machine.port, timeoutMs: CHECK_TIMEOUT_MS });
      const fresh = parsePreflight(observed.stdout);
      if (!fresh.ready || fresh.agent_installation.state !== "absent" || get(machine.id).agent_id) fail(409, "发现已有 Agent 或安装条件已变化，未签发新身份");
      ensureCredential(machine.id, credential.id); checked(get(machine.id), savedPlan.check_id, credential.id);
      enrollment = options.agentCredentials.issueEnrollment({ endpoint_origin: deps.externalURL, version: deployment.version, allowed_arch: [deployment.arch], initial_label_id: deployment.initial_label_id, created_by: ctx.user.id });
      const command = agentBootstrapCommand(deps.externalURL.replace(/\/$/, ""), deployment.version);
      const result = await (options.sshRunner ?? defaultSSHRunner)({ machine, privateKey, command, enrollmentToken: enrollment.token_display_once, signal: ctx.signal, port: machine.port });
      const status = options.agentCredentials.enrollmentStatus(enrollment.enrollment_id);
      if (!status || status.status !== "active" || !status.agent_id) throw Error("Agent 未完成激活回执");
      const receipt = { stages: result.stages, stdout: redact(result.stdout, [enrollment.token_display_once, privateKey]), stderr: redact(result.stderr, [enrollment.token_display_once, privateKey]), enrollment_id: enrollment.enrollment_id, agent_id: status.agent_id };
      db.transaction(() => {
        db.run("UPDATE machine_deployments SET status='succeeded',finished_at=?,receipt_json=?,error='' WHERE id=?", iso(now()), JSON.stringify(receipt), deployment.id);
        db.run("UPDATE managed_machines SET agent_id=?,agent_last_seen=?,last_error='',updated_at=? WHERE id=?", status.agent_id, iso(now()), iso(now()), machine.id);
        db.run("UPDATE machine_credentials SET last_used_at=? WHERE id=?", iso(now()), credential.id);
        for (const temporary of db.all<{ id: string }>("SELECT id FROM machine_credentials WHERE machine_id=? AND retention IN ('temporary','one_time')", machine.id))
          clearCredential(temporary.id, "agent_activated", ctx.user.id, true);
      });
      ctx.json({ id: deployment.id, status: "succeeded", receipt: { ...receipt, stdout: receipt.stdout.slice(-4000), stderr: receipt.stderr.slice(-4000) } });
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "部署失败", [enrollment?.token_display_once ?? "", privateKey]);
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
      db.run("UPDATE machine_deployments SET status='failed',finished_at=?,error=?,receipt_json=? WHERE id=?", iso(now()), failure.slice(0, 1000), JSON.stringify({ stages: ["failed"], error: failure.slice(0, 1000), ...(activatedAgent ? { agent_id: activatedAgent, credentials_revoked: revokedCredentials } : {}) }), deployment.id);
      db.run("UPDATE managed_machines SET last_error=?,updated_at=? WHERE id=?", failure.slice(0, 1000), iso(now()), machine.id);
      throw new HTTPError(502, failure);
    } finally { busy.delete(machine.id); }
  };
  router.get("/api/v1/machines", safe((ctx) => { admin(ctx); ctx.json(list()); }));
  router.post("/api/v1/machines", safe(createMachine));
  router.get("/api/v1/machines/:id", safe((ctx) => { admin(ctx); ensureMachine(ctx.params.id); ctx.json({ machine: get(ctx.params.id), credentials: credentialRows(ctx.params.id), deployments: deployments(ctx.params.id), uninstallations: uninstallations.list(ctx.params.id) }); }));
  router.put("/api/v1/machines/:id", safe(updateMachine));
  router.delete("/api/v1/machines/:id", safe((ctx) => { admin(ctx); ensureDeletable(ctx.params.id); db.run("DELETE FROM managed_machines WHERE id=?", ctx.params.id); ctx.json({ ok: true }); }));
  router.post("/api/v1/machines/:id/ssh-check", safe(async ctx => { admin(ctx); ctx.json(await checkSSH(ctx.params.id, await machineBody(ctx), ctx.user.id, ctx.signal)); }));
  router.post("/api/v1/machines/:id/agent-link", safe(linkAgent));
  router.get("/api/v1/machines/:id/credentials", safe((ctx) => { admin(ctx); ensureMachine(ctx.params.id); ctx.json(credentialRows(ctx.params.id)); }));
  router.post("/api/v1/machines/:id/credentials", safe(addCredential));
  router.delete("/api/v1/machines/:id/credentials/:credentialId", safe((ctx) => {
    admin(ctx);
    ensureMachine(ctx.params.id);
    const credential = db.get<any>("SELECT id FROM machine_credentials WHERE id=? AND machine_id=?", ctx.params.credentialId, ctx.params.id);
    if (!credential) fail(404, "连接凭据不存在");
    clearCredential(credential.id, "revoked", ctx.user.id);
    ctx.json({ ok: true, warning: "凭据已撤销；如需继续接入，请生成新的凭据或使用手动脚本。" });
  }));
  router.get("/api/v1/machines/:id/deployments", safe((ctx) => { admin(ctx); ensureMachine(ctx.params.id); ctx.json(deployments(ctx.params.id)); }));
  router.post("/api/v1/machines/:id/deployments/plan", safe(plan));
  router.get("/api/v1/machines/:id/deployments/:deploymentId", safe((ctx) => { admin(ctx); ensureMachine(ctx.params.id); const value = deployments(ctx.params.id).find((item) => item.id === ctx.params.deploymentId); if (!value) fail(404, "部署计划不存在"); ctx.json(value); }));
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
  const assistantSafe = (machine: MachineSummary) => ({ ...machine, host_key_fingerprint: "" });
  const assistantList = () => list().map(assistantSafe);
  const assistantGet = (machineID: string) => ({ ...assistantSafe(get(machineID)), ssh_credentials: credentialRows(machineID)
    .filter(c => c.method === "ssh_key" && !c.revoked_at && !c.secret_cleared_at && Date.parse(c.expires_at) > now().getTime())
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
    return { id: value.id, machine_id: value.machine_id, status: value.status, version: value.version, arch: value.arch, plan: parseJSON(value.plan_json, {}), receipt, error: value.error, created_at: value.created_at, started_at: value.started_at, finished_at: value.finished_at };
  };
  return { list, get, assistantList, assistantGet, checkSSH, assistantPlan, assistantDeployment, acquireTerminal,
    close() {
      clearInterval(cleanupTimer);
      for (const terminal of [...terminals.values()]) terminal.invalidate();
    },
  };
}
