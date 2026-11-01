import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { boundedText, canonicalJSON, parseStrictJSON, PRIVILEGED_CAPABILITIES, strictRecord, validateAccount, validatePublicKey, type PrivilegedCapability } from "../shared/privileged-executor.js";
import { boundedFile, durableWrite, refuse, rootPath, secureDirectory } from "./security.js";
import { type AccountProfile, localAccount } from "./scripts.js";
import { ExecutorJournal } from "./journal.js";

export const EXECUTOR_DATA_DIR = "/var/lib/lightmoni-executor";
export const EXECUTOR_CONFIG = "/etc/lightmoni-executor/config.json";
export interface ExecutorPolicy { generation: number; capabilities: PrivilegedCapability[] }
export interface ExecutorConfig {
  version: 1; endpoint: string; center_instance_id: string; machine_id: string; agent_id: string;
  executor_id: string; install_generation: number; center_keys: { kid: string; public_key: string }[];
  private_key: string; output_key: string; data_dir: string; local_policy: ExecutorPolicy;
  accounts: AccountProfile[]; daemon_id: string;
}
export interface ExecutorBootstrap {
  version: 1; endpoint: string; center_instance_id: string; machine_id: string; agent_id: string;
  executor_id: string; install_generation: number; enrollment_id: string; enrollment_token: string;
  trusted_center_public_key: string; center_key_id: string; center_keys: { kid: string; public_key: string }[];
  local_policy: ExecutorPolicy; expires_at: string;
}
export function httpsOrigin(value: unknown): string {
  if (typeof value !== "string") return refuse("https_center_origin_required");
  let u: URL; try { u = new URL(value); } catch { return refuse("https_center_origin_required"); }
  if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.hash || u.search || u.origin !== value.replace(/\/$/, "")) return refuse("https_center_origin_required");
  return u.origin;
}
export function policy(value: unknown): ExecutorPolicy {
  const p = strictRecord(value, ["generation", "capabilities"]);
  if (!Number.isSafeInteger(p.generation) || p.generation < 1 || !Array.isArray(p.capabilities) || p.capabilities.length > 2
    || new Set(p.capabilities).size !== p.capabilities.length || p.capabilities.some((c: unknown) => !(PRIVILEGED_CAPABILITIES as readonly unknown[]).includes(c))) refuse("invalid_policy");
  return { generation: p.generation, capabilities: [...p.capabilities].sort() };
}
function identity(v: Record<string, any>): void {
  for (const field of ["center_instance_id", "machine_id", "agent_id", "executor_id"]) { boundedText(v[field]); if (!/^[A-Za-z0-9_-]{1,128}$/.test(v[field])) refuse("invalid_identity"); }
  if (v.version !== 1 || !Number.isSafeInteger(v.install_generation) || v.install_generation < 1) refuse("invalid_config");
  if (!Array.isArray(v.center_keys) || v.center_keys.length < 1 || v.center_keys.length > 4) refuse("invalid_center_keys");
  const keys = new Set();
  for (const key of v.center_keys) { strictRecord(key, ["kid", "public_key"]); boundedText(key.kid); if (keys.has(key.kid) || validatePublicKey(key.public_key) !== key.public_key) refuse("invalid_center_keys"); keys.add(key.kid); }
  httpsOrigin(v.endpoint); policy(v.local_policy);
}
export function parseBootstrap(value: unknown, now = Date.now()): ExecutorBootstrap {
  const v = strictRecord(value, ["version", "endpoint", "center_instance_id", "machine_id", "agent_id", "executor_id", "install_generation", "enrollment_id", "enrollment_token", "trusted_center_public_key", "center_key_id", "center_keys", "local_policy", "expires_at"]);
  identity(v);
  if (typeof v.enrollment_token !== "string" || !/^lm_executor_enroll_[A-Za-z0-9_-]{40,128}$/.test(v.enrollment_token)
    || !v.center_keys.some((k: any) => k.kid === v.center_key_id && k.public_key === v.trusted_center_public_key)
    || !Number.isFinite(Date.parse(v.expires_at)) || Date.parse(v.expires_at) <= now || Date.parse(v.expires_at) > now + 360_000) refuse("invalid_bootstrap");
  boundedText(v.enrollment_id); return v as ExecutorBootstrap;
}
export function validateConfig(value: unknown): ExecutorConfig {
  const v = strictRecord(value, ["version", "endpoint", "center_instance_id", "machine_id", "agent_id", "executor_id", "install_generation", "center_keys", "private_key", "output_key", "data_dir", "local_policy", "accounts", "daemon_id"]);
  identity(v);
  if (v.data_dir !== EXECUTOR_DATA_DIR || typeof v.private_key !== "string" || Buffer.byteLength(v.private_key) > 1024 || createPrivateKey(v.private_key).asymmetricKeyType !== "ed25519"
    || typeof v.output_key !== "string" || !/^[a-f0-9]{64}$/.test(v.output_key) || typeof v.daemon_id !== "string" || !/^[A-Za-z0-9:_.-]{0,128}$/.test(v.daemon_id)
    || !Array.isArray(v.accounts) || !v.accounts.length || v.accounts.length > 32 || new Set(v.accounts.map((a: any) => a.name)).size !== v.accounts.length) refuse("invalid_config");
  v.accounts.forEach(validateAccount); return v as ExecutorConfig;
}
export function loadConfig(filename: string): ExecutorConfig {
  const v = validateConfig(parseStrictJSON(boundedFile(filename, 64 << 10, true), 64 << 10));
  rootPath(v.data_dir, "directory", true);
  for (const entry of readdirSync(v.data_dir)) {
    if (entry === "journal.sqlite" || entry === "journal.sqlite-wal" || entry === "journal.sqlite-shm" || entry === "writer.lock") rootPath(join(v.data_dir, entry), "file", true);
  }
  return v;
}
export function newConfig(bootstrap: ExecutorBootstrap, daemonID: string): ExecutorConfig {
  const key = generateKeyPairSync("ed25519");
  return validateConfig({ version: 1, endpoint: httpsOrigin(bootstrap.endpoint), center_instance_id: bootstrap.center_instance_id, machine_id: bootstrap.machine_id, agent_id: bootstrap.agent_id,
    executor_id: bootstrap.executor_id, install_generation: bootstrap.install_generation, center_keys: bootstrap.center_keys,
    private_key: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), output_key: randomBytes(32).toString("hex"), data_dir: EXECUTOR_DATA_DIR,
    local_policy: bootstrap.local_policy, accounts: [localAccount("root")], daemon_id: daemonID });
}
export const executorPublicKey = (config: ExecutorConfig) => createPublicKey(createPrivateKey(config.private_key)).export({ type: "spki", format: "pem" }).toString();
export function saveInitialConfig(filename: string, config: ExecutorConfig): void {
  validateConfig(config);
  if (resolve(filename) !== filename || existsSync(filename) || existsSync(join(config.data_dir, "journal.sqlite"))) refuse("executor_recovery_required");
  secureDirectory(dirname(filename)); secureDirectory(config.data_dir);
  // Write intent before enrollment. A lost enrollment reply requires SSH
  // recovery, never creating a second private identity with the same token.
  durableWrite(filename, canonicalJSON(config));
  const journal = new ExecutorJournal(config.data_dir, Buffer.from(config.output_key, "hex"), true);
  try { journal.policy(config.local_policy); } finally { journal.close(); }
}
