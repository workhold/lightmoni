import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const EXECUTOR_PROTOCOL = 1 as const;
export const EXECUTOR_SIGNATURE_HEADER = "x-lightmoni-executor-signature";
export const EXECUTOR_JWS_TYPE = "lightmoni-executor-v1";
export const EXECUTOR_LEASE_SECONDS = 45;
export const EXECUTOR_PERMIT_SECONDS = 30;
export const PRIVILEGED_CAPABILITIES = ["script.elevated.v1", "container.managed.v1"] as const;
export type PrivilegedCapability = typeof PRIVILEGED_CAPABILITIES[number];
export type PrivilegedState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface ExecutorAccount { name: string; uid: number; gid: number; groups: number[] }
export interface ScriptPayload {
  kind: "script"; runtime: "shell" | "node"; code: string; code_sha256: string;
  interpreter_sha256: string; args: string[]; cwd_profile: "private";
  environment: Record<string, string>; environment_sha256: string;
  account: ExecutorAccount; account_sha256: string; timeout_ms: number; max_output_bytes: number;
}
export interface ContainerPayload {
  kind: "container"; operation: "list" | "pull" | "create" | "start" | "stop" | "restart" | "remove";
  resource_id: string; resource_revision: number; image?: string; platform?: "linux/amd64" | "linux/arm64";
  timeout_ms: number; max_output_bytes: number;
}
export type PrivilegedPayload = ScriptPayload | ContainerPayload;
export interface ExecutorRequestClaims {
  version: 1; purpose: "request"; center_instance_id: string; executor_id: string;
  install_generation: number; method: "POST"; path: string; body_sha256: string;
  request_id: string; iat: number; exp: number;
}
export interface EnrollmentProof {
  version: 1; purpose: "enrollment"; token_sha256: string; public_key_sha256: string;
  executor_nonce: string; iat: number; exp: number;
}
export interface ExecutorPolicyClaims {
  version: 1; purpose: "policy"; center_instance_id: string; executor_id: string;
  machine_id: string; agent_id: string; install_generation: number; policy_generation: number;
  capabilities: PrivilegedCapability[]; iat: number; exp: number;
}
export interface PrivilegedPlan {
  version: 1; purpose: "plan"; center_instance_id: string; machine_id: string; agent_id: string;
  executor_id: string; install_generation: number; job_id: string; task_run_id: string;
  operation_id: string; lease_id: string; policy_generation: number; authorization_id: string;
  authorization_revision: string; capability: PrivilegedCapability; action: string;
  resource_id: string; resource_revision: string; request_sha256: string;
  iat: number; nbf: number; exp: number; max_runtime_ms: number;
}
export interface StartPermit extends Omit<PrivilegedPlan, "purpose"> {
  purpose: "start-permit"; step_id: string; permit_id: string; executor_nonce: string;
}
export interface ClaimedPrivilegedJob { plan: string; payload: PrivilegedPayload }
export interface ExecutorEnrollmentResult {
  version: 1; executor_id: string; machine_id: string; agent_id: string;
  install_generation: number; center_instance_id: string; endpoint: string;
  center_key_id: string; center_public_key: string; policy_generation: number;
  capabilities: PrivilegedCapability[];
  center_keys: { kid: string; public_key: string }[];
}
export interface PrivilegedResult {
  lease_id: string; state: Exclude<PrivilegedState, "queued" | "running">;
  code: string; summary: string; exit_code: number | null; stdout: string; stderr: string;
}

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => { throw Error(message); };
export function strictRecord(value: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_object");
  const record = value as Record<string, any>;
  if (Object.keys(record).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(record, k))) fail("unknown_or_missing_field");
  return record;
}
export const boundedText = (v: unknown, max = 128, allowEmpty = false): string => {
  if (typeof v !== "string" || (!allowEmpty && !v.length) || Buffer.byteLength(v) > max || /[\u0000-\u001f\u007f]/.test(v)) fail("invalid_text");
  return v as string;
};
const integer = (v: unknown, min: number, max: number): number => {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) fail("invalid_integer");
  return v as number;
};
export const digest = (v: unknown): string => {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) fail("invalid_digest");
  return v as string;
};
export const nonce = (v: unknown): string => {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(v)) fail("invalid_nonce");
  return v as string;
};
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonicalJSON((value as any)[k])).join(",") + "}";
  return fail("invalid_json_value");
}
/** A bounded JSON reader rejects duplicate keys before the native parser can erase them. */
export function parseStrictJSON(raw: string | Uint8Array, maxBytes = 1 << 20): any {
  const bytes = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw);
  if (!bytes.length || bytes.length > maxBytes) fail("invalid_json_size");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? "") && at < text.length) { if (!/[ \n\r\t]/.test(text[at])) fail("invalid_json"); at++; } };
  const string = (): string => {
    const begin = at++;
    while (at < text.length) { const c = text[at++]; if (c === "\\") at++; else if (c === '"') return JSON.parse(text.slice(begin, at)); }
    return fail("invalid_json_string");
  };
  const read = (depth: number): any => {
    if (depth > 32) fail("json_too_deep"); ws(); const c = text[at];
    if (c === '"') return string();
    if (c === "{") {
      at++; ws(); const object: Record<string, any> = Object.create(null), seen = new Set<string>();
      if (text[at] === "}") { at++; return object; }
      while (at < text.length) {
        ws(); if (text[at] !== '"') fail("invalid_json_object"); const key = string();
        if (seen.has(key)) fail("duplicate_json_field"); seen.add(key); ws();
        if (text[at++] !== ":") fail("invalid_json_object"); object[key] = read(depth + 1); ws();
        const next = text[at++]; if (next === "}") return object; if (next !== ",") fail("invalid_json_object");
      } return fail("invalid_json_object");
    }
    if (c === "[") {
      at++; ws(); const values: any[] = []; if (text[at] === "]") { at++; return values; }
      while (at < text.length) { values.push(read(depth + 1)); ws(); const next = text[at++]; if (next === "]") return values; if (next !== ",") fail("invalid_json_array"); }
      return fail("invalid_json_array");
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!match) fail("invalid_json_value"); at += match![0].length; const result = JSON.parse(match![0]);
    if (typeof result === "number" && !Number.isFinite(result)) fail("invalid_json_number"); return result;
  };
  const result = read(0); ws(); if (at !== text.length) fail("invalid_json_trailing_data"); return result;
}
const keyObject = (value: string | KeyObject, privatePart = false) => {
  const key = typeof value === "string" ? (privatePart ? createPrivateKey(value) : createPublicKey(value)) : value;
  if (key.asymmetricKeyType !== "ed25519") fail("invalid_key_type"); return key;
};
export function validatePublicKey(value: unknown): string {
  const pem = typeof value === "string" && Buffer.byteLength(value) <= 1024 ? value : fail("invalid_public_key");
  return keyObject(pem).export({ type: "spki", format: "pem" }).toString();
}
const decode64 = (s: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) fail("invalid_base64url");
  const bytes = Buffer.from(s, "base64url"); if (bytes.toString("base64url") !== s) fail("invalid_base64url"); return bytes;
};
export function signJWS(payload: unknown, privateKey: string | KeyObject, kid: string): string {
  boundedText(kid); const header = Buffer.from(canonicalJSON({ alg: "EdDSA", typ: EXECUTOR_JWS_TYPE, kid })).toString("base64url");
  const body = Buffer.from(canonicalJSON(payload)).toString("base64url"), input = header + "." + body;
  return input + "." + sign(null, Buffer.from(input), keyObject(privateKey, true)).toString("base64url");
}
export function verifyJWS<T = unknown>(jws: unknown, publicKey: string | KeyObject, kid: string, maxBytes = 1 << 20): T {
  if (typeof jws !== "string" || Buffer.byteLength(jws) > maxBytes * 2 + 1024) fail("invalid_signature");
  const parts = (jws as string).split("."); if (parts.length !== 3) fail("invalid_signature");
  const header = strictRecord(parseStrictJSON(decode64(parts[0]), 1024), ["alg", "typ", "kid"]);
  if (header.alg !== "EdDSA" || header.typ !== EXECUTOR_JWS_TYPE || header.kid !== kid) fail("invalid_signature");
  const signature = decode64(parts[2]);
  if (signature.length !== 64 || !verify(null, Buffer.from(parts[0] + "." + parts[1]), keyObject(publicKey), signature)) fail("invalid_signature");
  return parseStrictJSON(decode64(parts[1]), maxBytes) as T;
}
export function validateAccount(value: unknown): ExecutorAccount {
  const v = strictRecord(value, ["name", "uid", "gid", "groups"]);
  if (typeof v.name !== "string" || !/^[a-z_][a-z0-9_-]{0,31}\$?$/.test(v.name)) fail("invalid_account");
  integer(v.uid, 0, 0x7fffffff); integer(v.gid, 0, 0x7fffffff);
  if (!Array.isArray(v.groups) || v.groups.length > 64 || new Set(v.groups).size !== v.groups.length) fail("invalid_groups");
  v.groups.forEach((g: unknown) => integer(g, 0, 0x7fffffff));
  if (v.uid === 0 && (v.name !== "root" || v.gid !== 0)) fail("invalid_root_account");
  return v as ExecutorAccount;
}
export function normalizePrivilegedPayload(value: unknown): PrivilegedPayload {
  const source = value as any;
  if (source?.kind === "container") {
    const keys = ["kind", "operation", "resource_id", "resource_revision", "image", "platform", "timeout_ms", "max_output_bytes"];
    const v = strictRecord(value, keys, keys.filter(k => !["image", "platform"].includes(k)));
    if (!["list", "pull", "create", "start", "stop", "restart", "remove"].includes(v.operation) || !/^[A-Za-z0-9_-]{1,128}$/.test(v.resource_id)) fail("unsafe_container_spec");
    if (["pull", "create"].includes(v.operation)) {
      if (typeof v.image !== "string" || !/^[a-z0-9][a-z0-9./:_-]{0,254}@sha256:[a-f0-9]{64}$/.test(v.image) || !["linux/amd64", "linux/arm64"].includes(v.platform)) fail("unsafe_container_spec");
    } else if (v.image !== undefined || v.platform !== undefined) fail("unsafe_container_spec");
    integer(v.resource_revision, 1, Number.MAX_SAFE_INTEGER); integer(v.timeout_ms, 1000, 600_000); integer(v.max_output_bytes, 1024, 262144);
    return v as ContainerPayload;
  }
  const keys = ["kind", "runtime", "code", "code_sha256", "interpreter_sha256", "args", "cwd_profile", "environment", "environment_sha256", "account", "account_sha256", "timeout_ms", "max_output_bytes"];
  const v = strictRecord(value, keys, keys.filter(k => !["code_sha256", "environment_sha256", "account_sha256"].includes(k)));
  if (v.kind !== "script" || !["shell", "node"].includes(v.runtime) || v.cwd_profile !== "private") fail("invalid_script_profile");
  if (typeof v.code !== "string" || !v.code.length || Buffer.byteLength(v.code) > 262144 || v.code.includes("\0")) fail("invalid_script_code");
  digest(v.interpreter_sha256); integer(v.timeout_ms, 1000, 600_000); integer(v.max_output_bytes, 1024, 262144);
  if (!Array.isArray(v.args) || v.args.length > 64) fail("invalid_args");
  v.args.forEach((arg: unknown) => boundedText(arg, 4096, true));
  if (Buffer.byteLength(canonicalJSON(v.args)) > 16384) fail("invalid_args");
  strictRecord(v.environment, Object.keys(v.environment ?? {}));
  if (Object.keys(v.environment).length > 64) fail("invalid_environment");
  for (const [key, val] of Object.entries(v.environment)) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || /^(?:PATH|HOME|TMPDIR|SHELL|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PYTHON.*|PERL.*|RUBY.*|DOCKER_.*|LIGHTMONI_.*)$/.test(key)) fail("unsafe_environment");
    boundedText(val, 4096, true);
  }
  if (Buffer.byteLength(canonicalJSON(v.environment)) > 16384) fail("invalid_environment");
  const account = validateAccount(v.account);
  const hashes = { code_sha256: sha256(v.code), environment_sha256: sha256(canonicalJSON(v.environment)), account_sha256: sha256(canonicalJSON(account)) };
  for (const [key, hash] of Object.entries(hashes)) if (v[key] !== undefined && v[key] !== hash) fail("payload_digest_mismatch");
  return { ...v, ...hashes } as ScriptPayload;
}
export function validatePrivilegedPayload(value: unknown): asserts value is PrivilegedPayload {
  const normalized = normalizePrivilegedPayload(value);
  if (normalized.kind === "script") for (const field of ["code_sha256", "environment_sha256", "account_sha256"]) if (!Object.hasOwn(value as object, field)) fail("missing_payload_digest");
}
export function validateRequestClaims(value: unknown, atSeconds: number): ExecutorRequestClaims {
  const v = strictRecord(value, ["version", "purpose", "center_instance_id", "executor_id", "install_generation", "method", "path", "body_sha256", "request_id", "iat", "exp"]);
  if (v.version !== 1 || v.purpose !== "request" || v.method !== "POST") fail("principal_mismatch");
  boundedText(v.center_instance_id); boundedText(v.executor_id); nonce(v.request_id); digest(v.body_sha256); integer(v.install_generation, 1, Number.MAX_SAFE_INTEGER);
  if (typeof v.path !== "string" || !/^\/api\/v1\/privileged-executors\/[A-Za-z0-9_-]+\/[A-Za-z0-9_/-]+$/.test(v.path) || v.path.includes("//") || v.path.endsWith("/")) fail("invalid_request_path");
  integer(v.iat, 0, Number.MAX_SAFE_INTEGER); integer(v.exp, 0, Number.MAX_SAFE_INTEGER);
  if (v.exp <= v.iat || v.exp - v.iat > 60 || v.iat > atSeconds + 60 || v.exp < atSeconds - 60) fail("expired_signature");
  return v as ExecutorRequestClaims;
}
export function signExecutorRequest(input: Omit<ExecutorRequestClaims, "version" | "purpose" | "body_sha256"> & { body: string | Uint8Array }, privateKey: string | KeyObject): string {
  const { body, ...rest } = input;
  const claims: ExecutorRequestClaims = { version: 1, purpose: "request", ...rest, body_sha256: sha256(body) };
  validateRequestClaims(claims, input.iat); return signJWS(claims, privateKey, input.executor_id);
}
const PLAN_KEYS = ["version", "purpose", "center_instance_id", "machine_id", "agent_id", "executor_id", "install_generation", "job_id", "task_run_id", "operation_id", "lease_id", "policy_generation", "authorization_id", "authorization_revision", "capability", "action", "resource_id", "resource_revision", "request_sha256", "iat", "nbf", "exp", "max_runtime_ms"];
export function validatePlan(value: unknown, purpose: "plan" | "start-permit" = "plan"): PrivilegedPlan | StartPermit {
  const v = strictRecord(value, purpose === "plan" ? PLAN_KEYS : [...PLAN_KEYS, "step_id", "permit_id", "executor_nonce"]);
  if (v.version !== 1 || v.purpose !== purpose || !(PRIVILEGED_CAPABILITIES as readonly string[]).includes(v.capability)) fail("invalid_plan");
  for (const k of ["center_instance_id", "machine_id", "agent_id", "executor_id", "job_id", "task_run_id", "operation_id", "lease_id", "authorization_id", "action", "resource_id", "resource_revision"]) boundedText(v[k]);
  digest(v.authorization_revision); digest(v.request_sha256); integer(v.install_generation, 1, Number.MAX_SAFE_INTEGER); integer(v.policy_generation, 1, Number.MAX_SAFE_INTEGER);
  for (const k of ["iat", "nbf", "exp"]) integer(v[k], 0, Number.MAX_SAFE_INTEGER);
  integer(v.max_runtime_ms, 1000, 600_000);
  if (v.nbf !== v.iat || v.exp <= v.iat || (purpose === "start-permit" && v.exp - v.iat > 30)) fail("invalid_plan_lifetime");
  if (purpose === "start-permit") { boundedText(v.step_id); nonce(v.permit_id); nonce(v.executor_nonce); }
  return v as PrivilegedPlan | StartPermit;
}
export const parsePayload = normalizePrivilegedPayload;
export const requestClaims = validateRequestClaims;
export const planClaims = (value: unknown) => validatePlan(value, "plan") as PrivilegedPlan;
export const permitClaims = (value: unknown) => validatePlan(value, "start-permit") as StartPermit;
export function policyClaims(value: unknown): ExecutorPolicyClaims {
  const v = strictRecord(value, ["version", "purpose", "center_instance_id", "executor_id", "machine_id", "agent_id", "install_generation", "policy_generation", "capabilities", "iat", "exp"]);
  if (v.version !== 1 || v.purpose !== "policy") fail("invalid_policy");
  for (const k of ["center_instance_id", "executor_id", "machine_id", "agent_id"]) boundedText(v[k]);
  integer(v.install_generation, 1, Number.MAX_SAFE_INTEGER); integer(v.policy_generation, 1, Number.MAX_SAFE_INTEGER);
  integer(v.iat, 0, Number.MAX_SAFE_INTEGER); integer(v.exp, 0, Number.MAX_SAFE_INTEGER);
  if (v.exp <= v.iat || v.exp - v.iat > 60 || !Array.isArray(v.capabilities) || new Set(v.capabilities).size !== v.capabilities.length || v.capabilities.some((x: unknown) => !(PRIVILEGED_CAPABILITIES as readonly unknown[]).includes(x))) fail("invalid_policy");
  return v as ExecutorPolicyClaims;
}
