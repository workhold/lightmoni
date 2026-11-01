import { randomBytes } from "node:crypto";
import {
  canonicalJSON, EXECUTOR_SIGNATURE_HEADER, parseStrictJSON, planClaims, permitClaims, sha256, signExecutorRequest, signJWS,
  strictRecord, verifyJWS, validatePrivilegedPayload, type PrivilegedPlan, type PrivilegedPayload, type StartPermit,
} from "../shared/privileged-executor.js";
import { type ExecutorBootstrap, type ExecutorConfig, executorPublicKey, policy } from "./config.js";
import { ExecutorJournal } from "./journal.js";
import { refuse, StartDeadline, linuxBootClock, type BootClock } from "./security.js";

export type ExecutorTransport = (url: string, options: { body: string; headers: Record<string,string>; signal: AbortSignal }) => Promise<unknown>;
async function productionTransport(url: string, options: { body: string; headers: Record<string,string>; signal: AbortSignal }): Promise<unknown> {
  const response = await fetch(url, { method: "POST", redirect: "error", headers: options.headers, body: options.body, signal: options.signal });
  if (!response.ok) { await response.body?.cancel(); return refuse("executor_http_" + response.status); }
  if (!response.body) return refuse("empty_response");
  const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 1 << 20) refuse("response_too_large"); chunks.push(Buffer.from(next.value)); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return parseStrictJSON(Buffer.concat(chunks), 1 << 20);
}
export class ExecutorClient {
  constructor(readonly config: ExecutorConfig, readonly journal: ExecutorJournal, private readonly transport: ExecutorTransport = productionTransport,
    private readonly wall: () => number = Date.now, readonly clock: BootClock = linuxBootClock) {}
  remainingLeaseMS(plan: PrivilegedPlan): number { return Math.max(0, Math.min(45_000, plan.exp * 1000 - this.wall())); }
  async enroll(bootstrap: ExecutorBootstrap): Promise<void> {
    const publicKey = executorPublicKey(this.config), now = Math.floor(this.wall() / 1000);
    const proof = signJWS({ version: 1, purpose: "enrollment", token_sha256: sha256(bootstrap.enrollment_token), public_key_sha256: sha256(publicKey), executor_nonce: randomBytes(32).toString("base64url"), iat: now, exp: now + 60 }, this.config.private_key, this.config.executor_id);
    const body = canonicalJSON({ token: bootstrap.enrollment_token, public_key: publicKey, proof });
    const response: any = await this.transport(this.config.endpoint + "/api/v1/privileged-executors/enroll", { body, headers: { "Content-Type": "application/json", Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    strictRecord(response, ["version", "executor_id", "machine_id", "agent_id", "install_generation", "center_instance_id", "endpoint", "center_key_id", "center_public_key", "policy_generation", "capabilities", "center_keys"]);
    for (const name of ["executor_id", "machine_id", "agent_id", "install_generation", "center_instance_id", "endpoint"] as const) if (response[name] !== this.config[name]) refuse("enrollment_binding_mismatch");
    if (response.version !== 1 || response.policy_generation !== this.config.local_policy.generation || canonicalJSON([...response.capabilities].sort()) !== canonicalJSON([...this.config.local_policy.capabilities].sort())
      || !this.config.center_keys.some(k => k.kid === response.center_key_id && k.public_key === response.center_public_key)
      || canonicalJSON(response.center_keys) !== canonicalJSON(this.config.center_keys)) refuse("enrollment_trust_mismatch");
  }
  async request(route: string, value: unknown, slot?: string): Promise<any> {
    if (!/^[A-Za-z0-9_/-]+$/.test(route) || route.includes("//") || route.endsWith("/")) refuse("invalid_request_path");
    const body = canonicalJSON(value), path = "/api/v1/privileged-executors/" + this.config.executor_id + "/" + route;
    const requestID = slot ? this.journal.request(slot, sha256(path + "\n" + body)) : randomBytes(24).toString("base64url"), now = Math.floor(this.wall() / 1000);
    const signature = signExecutorRequest({ center_instance_id: this.config.center_instance_id, executor_id: this.config.executor_id, install_generation: this.config.install_generation, method: "POST", path, body, request_id: requestID, iat: now, exp: now + 60 }, this.config.private_key);
    return this.transport(this.config.endpoint + path, { body, headers: { "Content-Type": "application/json", Accept: "application/json", [EXECUTOR_SIGNATURE_HEADER]: signature }, signal: AbortSignal.timeout(10_000) });
  }
  verify<T>(signed: unknown, max = 1 << 20): T {
    // Never use kid from an untrusted JWS to load files/URLs or new keys.
    for (const key of this.config.center_keys) { try { return verifyJWS<T>(signed, key.public_key, key.kid, max); } catch {} }
    return refuse("invalid_center_signature");
  }
  applyPolicy(signed: unknown): void {
    const p = strictRecord(this.verify(signed, 8192), ["version", "purpose", "center_instance_id", "executor_id", "machine_id", "agent_id", "install_generation", "policy_generation", "capabilities", "iat", "exp"]);
    if (p.version !== 1 || p.purpose !== "policy") refuse("invalid_policy");
    for (const key of ["center_instance_id", "executor_id", "machine_id", "agent_id", "install_generation"] as const) if (p[key] !== this.config[key]) refuse("principal_mismatch");
    const now = Math.floor(this.wall() / 1000);
    if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) || p.iat > now || p.exp <= now || p.exp - p.iat > 60) refuse("expired_policy");
    this.journal.policy(policy({ generation: p.policy_generation, capabilities: p.capabilities }));
  }
  verifyPlan(signed: unknown, payload: unknown): PrivilegedPlan {
    const p = this.verifyPlanSnapshot(signed, payload);
    this.target(p);
    const now = Math.floor(this.wall() / 1000);
    if (p.iat > now || p.nbf > now || p.exp <= now || p.exp - p.iat > 45) refuse("expired_plan");
    return p;
  }
  /** Authenticate a recovered claim without granting permission to execute it.
   * Its freshness/current policy is checked separately before any start. */
  verifyPlanSnapshot(signed: unknown, payload: unknown): PrivilegedPlan {
    const p = planClaims(this.verify(signed)); validatePrivilegedPayload(payload);
    this.identity(p);
    const value = payload as PrivilegedPayload;
    if (sha256(canonicalJSON(payload)) !== p.request_sha256 || p.max_runtime_ms !== value.timeout_ms || p.action !== (value.kind === "script" ? "execute" : value.operation)
      || p.capability !== (value.kind === "script" ? "script.elevated.v1" : "container.managed.v1")
      || value.kind === "container" && (p.resource_id !== value.resource_id || p.resource_revision !== String(value.resource_revision))) refuse("plan_payload_mismatch");
    if (p.exp - p.iat > 45) refuse("invalid_plan_lifetime");
    return p;
  }
  private identity(p: PrivilegedPlan | StartPermit): void {
    for (const key of ["center_instance_id", "executor_id", "machine_id", "agent_id", "install_generation"] as const) if (p[key] !== this.config[key]) refuse("principal_mismatch");
    if (p.task_run_id !== p.job_id || p.operation_id !== p.job_id) refuse("invalid_job_lineage");
  }
  private target(p: PrivilegedPlan | StartPermit): void {
    this.identity(p);
    const current = this.journal.policy();
    if (p.policy_generation !== current.generation || !current.capabilities.includes(p.capability)) refuse("policy_disabled");
  }
  async permit(plan: PrivilegedPlan, executorNonce: string): Promise<{ permit: StartPermit; deadline: StartDeadline }> {
    // This deadline begins BEFORE the network request. A delayed reply cannot
    // start a fresh 30s clock, even when wall time is skewed or the host suspends.
    const deadline = new StartDeadline(this.clock);
    const step = plan.capability === "script.elevated.v1" ? "execute" : "docker." + plan.action;
    const response = await this.request("jobs/" + plan.job_id + "/start-permits", { lease_id: plan.lease_id, step_id: step, executor_nonce: executorNonce }, "permit:" + plan.job_id);
    strictRecord(response, ["permit"]); const p = permitClaims(this.verify(response.permit)); this.target(p);
    for (const key of ["center_instance_id", "machine_id", "agent_id", "executor_id", "install_generation", "job_id", "task_run_id", "operation_id", "lease_id", "policy_generation", "authorization_id", "authorization_revision", "capability", "action", "resource_id", "resource_revision", "request_sha256", "max_runtime_ms"] as const)
      if (p[key] !== plan[key]) refuse("permit_plan_mismatch");
    const now = Math.floor(this.wall() / 1000);
    if (p.executor_nonce !== executorNonce || p.step_id !== step || p.iat > now || p.nbf > now || p.exp <= now) refuse("expired_permit");
    deadline.shorten(Math.min(30_000, (p.exp - now) * 1000)); deadline.assert(); return { permit: p, deadline };
  }
}
