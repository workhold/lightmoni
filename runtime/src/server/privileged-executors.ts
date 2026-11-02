import { dockerInventory } from "../shared/application-observation.js";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { Context, Dependencies, Module } from "../shared/types.js";
import { fail, HTTPError } from "../shared/http.js";
import {
  PRIVILEGED_CAPABILITIES, EXECUTOR_SIGNATURE_HEADER, EXECUTOR_LEASE_SECONDS,
  canonicalJSON, parseStrictJSON, strictRecord, boundedText, digest, nonce, sha256,
  normalizePrivilegedPayload, validateAccount, validatePublicKey, validateRequestClaims,
  signJWS, verifyJWS, type PrivilegedCapability, type PrivilegedPayload, type PrivilegedPlan,
  type StartPermit, type ExecutorEnrollmentResult, type ExecutorAccount, type PrivilegedResult,
} from "../shared/privileged-executor.js";
import { isAgentRemoved } from "./agent-lifecycle.js";
import { assertNoPendingMachineInstallation } from "./machine-installations-guard.js";
import { assertNoPendingMachineUninstallation } from "./machine-uninstallations-guard.js";
import { assertNoPendingAgentUpdate } from "./machine-agent-updates-guard.js";
import { assertNoDockerInstallation } from "./machine-docker-guard.js";
import { hasPendingExecutorLifecycle } from "./privileged-execution-guard.js";

type Row = Record<string, any>;
const terminal = (state: string) => ["succeeded", "failed", "cancelled", "unknown"].includes(state);
const plus = (at: Date, seconds: number) => new Date(at.getTime() + seconds * 1000).toISOString();
const object = (value: unknown, keys: readonly string[], required: readonly string[] = keys) => {
  try { return strictRecord(value, keys, required); } catch (e) { fail(400, (e as Error).message); }
};
const validate = <T>(fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof HTTPError) throw e; fail(400, (e as Error).message); } };
export interface ExecutorPolicyInput { capabilities: PrivilegedCapability[] }
export interface ExecutorBootstrap {
  version: 1; endpoint: string; center_instance_id: string; machine_id: string; agent_id: string;
  executor_id: string; install_generation: number; enrollment_id: string; enrollment_token: string;
  trusted_center_public_key: string; center_key_id: string; center_keys: { kid: string; public_key: string }[];
  local_policy: { generation: number; capabilities: PrivilegedCapability[] }; expires_at: string;
}

/** Independent execution principal. No ordinary Agent credential is accepted in this module. */
export interface ManagedExecutorBridge {
  prepare(executor:Row):void;
  validate(job:Row):void;
  claim(job:Row):void;
  sync(job:Row):void;
  event(job:Row,value:Row):void;
  result(job:Row,value:Row):void;
  artifact(job:Row,value:Row):Row;
}
export class PrivilegedExecutorStore {
  managed?:ManagedExecutorBridge;
  observations?:{targets:(executor:Row)=>unknown;accept:(executor:Row,value:Row)=>unknown};
  observationAuthority(id:string){const e=this.executor(id),p=this.policy(e.machine_id);if(p.agent_id!==e.agent_id||!JSON.parse(p.capabilities_json).includes('operations.managed.v1'))fail(403,'policy_disabled');this.actor(p.approved_by);return e;}

  private sweepTimer?: ReturnType<typeof setInterval>;
  readonly centerInstanceID: string;
  readonly centerKeyID: string;
  readonly centerPublicKey: string;
  private readonly centerPrivateKey: string;
  constructor(readonly deps: Dependencies, readonly options: { dataDir: string }) {
    const { db } = deps;
    db.exec(`
      CREATE TABLE IF NOT EXISTS privileged_center_identity(id INTEGER PRIMARY KEY CHECK(id=1),instance_id TEXT NOT NULL,key_id TEXT NOT NULL,public_key TEXT NOT NULL,private_key_enc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS privileged_machine_policies(machine_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,generation INTEGER NOT NULL,capabilities_json TEXT NOT NULL,approved_by TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS privileged_executors(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,install_generation INTEGER NOT NULL,public_key TEXT NOT NULL DEFAULT '',state TEXT NOT NULL,created_at TEXT NOT NULL,last_seen TEXT NOT NULL DEFAULT '',observation_enc TEXT NOT NULL DEFAULT '',UNIQUE(machine_id,install_generation));
      CREATE TABLE IF NOT EXISTS privileged_enrollments(id TEXT PRIMARY KEY,executor_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,policy_generation INTEGER NOT NULL,created_by TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL,used_at TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS privileged_policy_plans(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,revision TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS privileged_execution_plans(id TEXT PRIMARY KEY,snapshot_enc TEXT NOT NULL,revision TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT '',request_id TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS privileged_grants(id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE,revision TEXT NOT NULL,approved_by TEXT NOT NULL,state TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS privileged_jobs(id TEXT PRIMARY KEY,task_run_id TEXT NOT NULL UNIQUE,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,executor_id TEXT NOT NULL,install_generation INTEGER NOT NULL,policy_generation INTEGER NOT NULL,capability TEXT NOT NULL,payload_enc TEXT NOT NULL,payload_sha256 TEXT NOT NULL,authorization_id TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'queued',lease_id TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,expires_at TEXT NOT NULL,started_at TEXT NOT NULL DEFAULT '',finished_at TEXT NOT NULL DEFAULT '',cancel_requested INTEGER NOT NULL DEFAULT 0,code TEXT NOT NULL DEFAULT '',output_enc TEXT NOT NULL DEFAULT '',event_sequence INTEGER NOT NULL DEFAULT 0,resolved_at TEXT NOT NULL DEFAULT '',resolved_by TEXT NOT NULL DEFAULT '',resolution_reason TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS privileged_jobs_host ON privileged_jobs(machine_id,state);
      CREATE TABLE IF NOT EXISTS privileged_start_permits(job_id TEXT NOT NULL,step_id TEXT NOT NULL,executor_nonce TEXT NOT NULL,permit_id TEXT NOT NULL UNIQUE,permit_jws TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(job_id,step_id),UNIQUE(job_id,executor_nonce));
      CREATE TABLE IF NOT EXISTS privileged_request_nonces(executor_id TEXT NOT NULL,request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,response_enc TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(executor_id,request_id));
      CREATE TABLE IF NOT EXISTS privileged_audit(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,job_id TEXT NOT NULL DEFAULT '',actor_id TEXT NOT NULL,event TEXT NOT NULL,created_at TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}');
    `);
    let identity = db.get<Row>("SELECT * FROM privileged_center_identity WHERE id=1");
    if (!identity) {
      const keys = generateKeyPairSync("ed25519");
      const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      const priv = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      db.run("INSERT INTO privileged_center_identity(id,instance_id,key_id,public_key,private_key_enc) VALUES(1,?,?,?,?)", randomUUID(), randomUUID(), pub, deps.encrypt(priv));
      identity = db.get<Row>("SELECT * FROM privileged_center_identity WHERE id=1")!;
    }
    this.centerInstanceID = identity.instance_id; this.centerKeyID = identity.key_id;
    this.centerPublicKey = identity.public_key; this.centerPrivateKey = deps.decrypt(identity.private_key_enc);
  }
  private now() { return this.deps.now().toISOString(); }
  start() { this.sweepTimer ??= setInterval(() => { try { this.sweep(); } catch { this.deps.logger.error("privileged_execution_sweep_failed"); } }, 10_000); this.sweepTimer.unref(); }
  close() { if (this.sweepTimer) clearInterval(this.sweepTimer); this.sweepTimer = undefined; }
  private audit(machine: string, actor: string, event: string, job = "", detail: Row = {}) {
    this.deps.db.run("INSERT INTO privileged_audit(id,machine_id,job_id,actor_id,event,created_at,detail_json) VALUES(?,?,?,?,?,?,?)", randomUUID(), machine, job, actor, event, this.now(), canonicalJSON(detail));
  }
  private actor(actor: string) {
    if (!this.deps.db.get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1", actor)) fail(403, "active_human_admin_required");
  }
  private registeredHost(id: string): Row {
    const row = this.deps.db.get<Row>("SELECT id,name,agent_id FROM managed_machines WHERE id=?", id);
    if (!row) fail(409, "registered_host_required");
    return row;
  }
  private host(id: string): Row {
    const row = this.registeredHost(id);
    if (!row.agent_id) fail(409, "active_registered_host_required");
    if (isAgentRemoved(this.deps.db, row.agent_id)) fail(409, "agent_removed");
    if (this.hasTable("agent_credentials") && !this.deps.db.get("SELECT id FROM agent_credentials WHERE agent_id=? AND audience='control' AND (revoked_at IS NULL OR revoked_at='') AND (expires_at IS NULL OR expires_at='' OR expires_at>?)", row.agent_id, this.now())) fail(409, "active_agent_credential_required");
    return row;
  }
  private hasTable(name: string) { return !!this.deps.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name); }
  private idle(machine: string, agent: string, excludingJob = "") {
    if(hasPendingExecutorLifecycle(this.deps.db,machine,agent)) fail(409,"executor_lifecycle_pending");
    assertNoPendingMachineInstallation(this.deps.db, machine, agent);
    assertNoPendingMachineUninstallation(this.deps.db, machine, agent);
    assertNoPendingAgentUpdate(this.deps.db, agent, machine);
    assertNoDockerInstallation(this.deps.db, machine, agent);
    if (this.deps.db.get("SELECT id FROM privileged_jobs WHERE machine_id=? AND id<>? AND (state IN ('queued','running') OR (state='unknown' AND resolved_at=''))", machine, excludingJob)) fail(409, "machine_execution_locked");
    if(this.hasTable("agent_jobs")) {
      const queued="(state='queued' AND execution_principal='ordinary_agent')";
      if(this.deps.db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND id<>? AND (state IN ('leased','accepted','preflighting','staging','activating','verifying','unknown') OR "+queued+") LIMIT 1",agent,excludingJob))fail(409,"machine_execution_locked");
    }
    if (this.hasTable("task_runs") && this.deps.db.get("SELECT id FROM task_runs WHERE host_id=? AND id<>? AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='' AND superseded_by='')) LIMIT 1", machine, excludingJob)) fail(409, "machine_execution_locked");
  }
  private policy(machine: string): Row {
    return this.deps.db.get<Row>("SELECT * FROM privileged_machine_policies WHERE machine_id=?", machine) ?? { machine_id: machine, generation: 0, capabilities_json: "[]", agent_id: "" };
  }
  private executor(id: string): Row {
    const row = this.deps.db.get<Row>("SELECT * FROM privileged_executors WHERE id=?", id);
    if (!row || row.state !== "active") fail(401, "principal_mismatch");
    const host = this.host(row.machine_id);
    if (host.agent_id !== row.agent_id) fail(403, "stale_install_generation");
    const newest = this.deps.db.get<Row>("SELECT MAX(install_generation) generation FROM privileged_executors WHERE machine_id=?", row.machine_id)!;
    if (newest.generation !== row.install_generation) fail(403, "stale_install_generation");
    return row;
  }
  private capabilities(value: unknown): PrivilegedCapability[] {
    if (!Array.isArray(value) || value.length > PRIVILEGED_CAPABILITIES.length || value.some(x => !(PRIVILEGED_CAPABILITIES as readonly unknown[]).includes(x)) || new Set(value).size !== value.length) fail(400, "invalid_capabilities");
    return [...value].sort() as PrivilegedCapability[];
  }
  preparePolicyPlan(machineID: string, input: ExecutorPolicyInput, actor: string) {
    this.actor(actor); const v = object(input, ["capabilities"]), capabilities = this.capabilities(v.capabilities), h = capabilities.length ? this.host(machineID) : this.registeredHost(machineID), p = this.policy(machineID);
    const id = randomUUID();
    const snapshot = { machine_id: machineID, agent_id: h.agent_id, previous_generation: p.generation, generation: p.generation + 1, capabilities };
    const revision = sha256(canonicalJSON(snapshot)), expires = plus(this.deps.now(), 300);
    this.deps.db.run("INSERT INTO privileged_policy_plans(id,machine_id,snapshot_json,revision,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)", id, machineID, canonicalJSON(snapshot), revision, actor, this.now(), expires);
    return { id, revision, expires_at: expires, ...snapshot };
  }
  applyPolicy(machineID: string, planID: string, input: { confirm: true; expected_revision: string }, actor: string, inTransaction = false) {
    object(input, ["confirm", "expected_revision"]); this.actor(actor);
    if (input.confirm !== true) fail(400, "explicit_confirmation_required");
    const write = () => {
      const plan = this.deps.db.get<Row>("SELECT * FROM privileged_policy_plans WHERE id=? AND machine_id=?", planID, machineID);
      if (!plan || plan.revision !== input.expected_revision || plan.applied_at || plan.expires_at <= this.now()) fail(409, "stale_policy_plan");
      const snapshot = parseStrictJSON(plan.snapshot_json), host = snapshot.capabilities.length ? this.host(machineID) : this.registeredHost(machineID), previous = this.policy(machineID);
      if (snapshot.agent_id !== host.agent_id || snapshot.previous_generation !== previous.generation) fail(409, "stale_policy");
      this.deps.db.run("INSERT INTO privileged_machine_policies(machine_id,agent_id,generation,capabilities_json,approved_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET agent_id=excluded.agent_id,generation=excluded.generation,capabilities_json=excluded.capabilities_json,approved_by=excluded.approved_by,updated_at=excluded.updated_at", machineID, host.agent_id, snapshot.generation, canonicalJSON(snapshot.capabilities), actor, this.now());
      this.deps.db.run("UPDATE privileged_policy_plans SET applied_at=? WHERE id=?", this.now(), planID);
      this.deps.db.run("UPDATE privileged_grants SET revoked_at=? WHERE job_id IN (SELECT id FROM privileged_jobs WHERE machine_id=? AND state IN ('queued','running'))", this.now(), machineID);
      this.deps.db.run("UPDATE privileged_jobs SET cancel_requested=1 WHERE machine_id=? AND state IN ('queued','running')", machineID);
      const queued = this.deps.db.all<Row>("SELECT id FROM privileged_jobs WHERE machine_id=? AND state='queued'", machineID);
      for (const job of queued) { this.deps.db.run("UPDATE privileged_jobs SET state='cancelled',finished_at=?,code='policy_changed' WHERE id=?", this.now(), job.id); this.sync(this.row(job.id)); }
      this.audit(machineID, actor, "policy_applied", "", { generation: snapshot.generation, capabilities: snapshot.capabilities });
      return this.getStatus(machineID);
    };
    return inTransaction ? write() : this.deps.db.transaction(write);
  }
  getPolicyPlan(machineID: string, planID: string) {
    const row = this.deps.db.get<Row>("SELECT * FROM privileged_policy_plans WHERE id=? AND machine_id=?", planID, machineID);
    if (!row) fail(404, "policy_plan_not_found");
    return { id: row.id, revision: row.revision, created_at: row.created_at, expires_at: row.expires_at, applied_at: row.applied_at, ...parseStrictJSON(row.snapshot_json) };
  }
  /** Trusted SSH bootstrap only: never expose the returned token through browser/API JSON. */
  bootstrap(machineID: string, input: ExecutorPolicyInput, actor: string, inTransaction = false): ExecutorBootstrap {
    this.actor(actor); const h = this.host(machineID), p = this.policy(machineID), capabilities = this.capabilities(input.capabilities);
    if (!capabilities.length || p.agent_id !== h.agent_id || canonicalJSON(capabilities) !== p.capabilities_json) fail(409, "approved_execution_policy_required");
    this.idle(machineID, h.agent_id);
    const write = (): ExecutorBootstrap => {
      const generation = (this.deps.db.get<Row>("SELECT MAX(install_generation) generation FROM privileged_executors WHERE machine_id=?", machineID)?.generation ?? 0) + 1;
      const id = randomUUID(), enrollmentID = randomUUID(), token = "lm_executor_enroll_" + randomBytes(32).toString("base64url"), expires = plus(this.deps.now(), 300);
      this.deps.db.run("UPDATE privileged_executors SET state='revoked' WHERE machine_id=? AND state IN ('pending','active')", machineID);
      this.deps.db.run("UPDATE privileged_enrollments SET state='revoked' WHERE executor_id IN (SELECT id FROM privileged_executors WHERE machine_id=?) AND state='issued'", machineID);
      this.deps.db.run("INSERT INTO privileged_executors(id,machine_id,agent_id,install_generation,state,created_at) VALUES(?,?,?,?,'pending',?)", id, machineID, h.agent_id, generation, this.now());
      this.deps.db.run("INSERT INTO privileged_enrollments(id,executor_id,token_hash,policy_generation,created_by,expires_at,state) VALUES(?,?,?,?,?,?,'issued')", enrollmentID, id, sha256(token), p.generation, actor, expires);
      this.audit(machineID, actor, "executor_bootstrap_issued", "", { executor_id: id, install_generation: generation });
      return { version: 1, endpoint: this.endpoint(), center_instance_id: this.centerInstanceID, machine_id: machineID, agent_id: h.agent_id, executor_id: id, install_generation: generation, enrollment_id: enrollmentID, enrollment_token: token, trusted_center_public_key: this.centerPublicKey, center_key_id: this.centerKeyID, center_keys: [{ kid: this.centerKeyID, public_key: this.centerPublicKey }], local_policy: { generation: p.generation, capabilities }, expires_at: expires };
    };
    return inTransaction ? write() : this.deps.db.transaction(write);
  }
  issueBootstrap(machineID: string, capabilities: PrivilegedCapability[], actor: string, inTransaction = false) { return this.bootstrap(machineID, { capabilities }, actor, inTransaction); }
  private endpoint() {
    let url: URL; try { url = new URL(this.deps.externalURL); } catch { fail(409, "https_center_origin_required"); }
    if (url!.protocol !== "https:" || url!.username || url!.password || url!.pathname !== "/" || url!.search || url!.hash) fail(409, "https_center_origin_required");
    return url!.origin;
  }
  markBootstrapUnknown(executorID: string) {
    this.deps.db.run("UPDATE privileged_executors SET state='bootstrap_unknown' WHERE id=? AND state='pending'", executorID);
    this.deps.db.run("UPDATE privileged_enrollments SET state='revoked' WHERE executor_id=? AND state='issued'", executorID);
  }
  cancelBootstrap(executorID: string) {
    this.deps.db.run("UPDATE privileged_enrollments SET state='revoked' WHERE executor_id=? AND state='issued'", executorID);
    this.deps.db.run("UPDATE privileged_executors SET state='revoked' WHERE id=? AND state IN ('pending','active')", executorID);
  }
  /** Called only after the reviewed SSH maintenance workflow verifies removal. */
  revokeExecutor(machineID: string, executorID: string, actor: string, inTransaction = false) {
    this.actor(actor); this.sweep();
    const write = () => {
      const host = this.registeredHost(machineID), row = this.deps.db.get<Row>("SELECT * FROM privileged_executors WHERE id=? AND machine_id=?", executorID, machineID);
      if (!row || row.agent_id !== host.agent_id) fail(409, "executor_binding_changed");
      const latest = this.deps.db.get<Row>("SELECT id FROM privileged_executors WHERE machine_id=? ORDER BY install_generation DESC LIMIT 1", machineID);
      if (latest?.id !== executorID) fail(409, "stale_install_generation");
      if (row.state === "revoked") return this.getStatus(machineID);
      this.idle(machineID, host.agent_id);
      const previous = this.policy(machineID);
      this.deps.db.run("UPDATE privileged_executors SET state='revoked' WHERE id=?", executorID);
      this.deps.db.run("UPDATE privileged_enrollments SET state='revoked' WHERE executor_id=? AND state='issued'", executorID);
      this.deps.db.run("UPDATE privileged_machine_policies SET generation=?,capabilities_json='[]',approved_by=?,updated_at=? WHERE machine_id=?", previous.generation + 1, actor, this.now(), machineID);
      this.audit(machineID, actor, "executor_identity_revoked_after_verified_removal", "", { executor_id: executorID, install_generation: row.install_generation, policy_generation: previous.generation + 1 });
      return this.getStatus(machineID);
    };
    return inTransaction ? write() : this.deps.db.transaction(write);
  }
  enroll(value: unknown): ExecutorEnrollmentResult {
    const v = object(value, ["token", "public_key", "proof"]); boundedText(v.token, 256);
    return this.deps.db.transaction(() => {
      const enrollment = this.deps.db.get<Row>("SELECT * FROM privileged_enrollments WHERE token_hash=?", sha256(v.token));
      if (!enrollment || enrollment.state !== "issued" || enrollment.expires_at <= this.now()) fail(401, "invalid_enrollment_token");
      const row = this.deps.db.get<Row>("SELECT * FROM privileged_executors WHERE id=? AND state='pending'", enrollment.executor_id)!;
      if (!row) fail(401, "invalid_enrollment_token");
      const host = this.host(row.machine_id), policy = this.policy(row.machine_id); this.actor(enrollment.created_by);
      if (host.agent_id !== row.agent_id || policy.agent_id !== row.agent_id || policy.generation !== enrollment.policy_generation || !JSON.parse(policy.capabilities_json).length) fail(403, "stale_policy");
      const pub = validate(() => validatePublicKey(v.public_key));
      const proof = validate(() => object(verifyJWS(v.proof, pub, row.id, 4096), ["version", "purpose", "token_sha256", "public_key_sha256", "executor_nonce", "iat", "exp"]));
      const now = Math.floor(this.deps.now().getTime() / 1000);
      if (proof.version !== 1 || proof.purpose !== "enrollment" || proof.token_sha256 !== sha256(v.token) || proof.public_key_sha256 !== sha256(pub) || !Number.isSafeInteger(proof.iat) || !Number.isSafeInteger(proof.exp) || proof.exp <= proof.iat || proof.exp - proof.iat > 60 || proof.iat > now + 60 || proof.exp < now - 60) fail(401, "invalid_signature");
      validate(() => nonce(proof.executor_nonce));
      this.deps.db.run("UPDATE privileged_enrollments SET state='used',used_at=? WHERE id=?", this.now(), enrollment.id);
      this.deps.db.run("UPDATE privileged_executors SET state='active',public_key=? WHERE id=?", pub, row.id);
      this.audit(row.machine_id, enrollment.created_by, "executor_enrolled", "", { executor_id: row.id });
      return { version: 1, executor_id: row.id, machine_id: row.machine_id, agent_id: row.agent_id, install_generation: row.install_generation, center_instance_id: this.centerInstanceID, endpoint: this.endpoint(), center_key_id: this.centerKeyID, center_public_key: this.centerPublicKey, center_keys: [{ kid: this.centerKeyID, public_key: this.centerPublicKey }], policy_generation: policy.generation, capabilities: JSON.parse(policy.capabilities_json) };
    });
  }
  getStatus(machineID: string) {
    const policy = this.policy(machineID), row = this.deps.db.get<Row>("SELECT * FROM privileged_executors WHERE machine_id=? ORDER BY install_generation DESC LIMIT 1", machineID);
    const host = this.deps.db.get<Row>("SELECT agent_id FROM managed_machines WHERE id=?", machineID);
    let observation: Row = {}; if (row?.observation_enc) observation = parseStrictJSON(this.deps.decrypt(row.observation_enc));
    const binding = !!row && row.agent_id === host?.agent_id && !isAgentRemoved(this.deps.db, row.agent_id);
    const online = binding && row.state === "active" && !!row.last_seen && Date.parse(row.last_seen) > this.deps.now().getTime() - 60_000;
    const authorized = JSON.parse(policy.capabilities_json) as string[];
    return { machine_id: machineID, policy_generation: policy.generation, executor: row ? { id: row.id, state: row.state, install_generation: row.install_generation, online, last_seen: row.last_seen, version: observation.version ?? "", boot_id: observation.boot_id ?? "",activation_id:observation.activation_id??"",release:observation.release ?? null } : null,
      capabilities: Object.fromEntries(PRIVILEGED_CAPABILITIES.map(capability => [capability, { authorized: authorized.includes(capability), effective: !authorized.includes(capability) ? "disabled" : !row ? "pending" : !binding ? "blocked" : online && observation.policy_generation === policy.generation && observation.capabilities?.includes(capability) ? "ready" : "unavailable", policy_generation: policy.generation }])),
      ...(online && authorized.includes('operations.managed.v1') && observation.policy_generation===policy.generation && observation.capabilities?.includes('operations.managed.v1') && observation.docker_inventory?{docker_inventory:observation.docker_inventory}:{}),
      operations_capabilities:online && observation.policy_generation===policy.generation && observation.capabilities?.includes("operations.managed.v1")?observation.operations_capabilities??[]:[],
      account_profiles: online && observation.policy_generation === policy.generation ? observation.account_profiles ?? [] : [], interpreter_profiles: online && observation.policy_generation === policy.generation ? observation.interpreter_profiles ?? [] : [],
      script_profiles: { accounts: online && observation.policy_generation === policy.generation ? observation.account_profiles ?? [] : [], interpreters: online && observation.policy_generation === policy.generation ? Object.fromEntries((observation.interpreter_profiles ?? []).map((p: Row) => [p.runtime, p.sha256])) : {} } };
  }
  /** Authenticate exact bytes and transactionally cache the entire reply, including claim leases. */
  signedRequest(executorID: string, method: string, path: string, body: Uint8Array, signature: unknown, action: (executor: Row, input: Row) => unknown): unknown {
    const row = this.executor(executorID);
    let claims: ReturnType<typeof validateRequestClaims>;
    try { claims = validateRequestClaims(verifyJWS(signature, row.public_key, executorID, 8192), Math.floor(this.deps.now().getTime() / 1000)); }
    catch { fail(401, "invalid_signature"); }
    if (claims.executor_id !== executorID || claims.center_instance_id !== this.centerInstanceID || claims.install_generation !== row.install_generation || claims.method !== method || claims.path !== path || claims.body_sha256 !== sha256(body)) fail(403, "principal_mismatch");
    const { iat: _iat, exp: _exp, ...stableRequest } = claims;
    const requestHash = sha256(canonicalJSON(stableRequest)), input = validate(() => parseStrictJSON(body));
    return this.deps.db.transaction(() => {
      this.executor(executorID);
      const seen = this.deps.db.get<Row>("SELECT * FROM privileged_request_nonces WHERE executor_id=? AND request_id=?", executorID, claims.request_id);
      if (seen) {
        if (seen.request_sha256 !== requestHash) fail(409, "replay_conflict");
        // Acknowledgment recovery must not revive expired/revoked authority.
        // Claim snapshots retain their old lease solely for journal recovery;
        // every route that can start work or disclose additional bytes checks
        // current authority again, even for an identical signed request.
        const jobRoute=path.match(/\/jobs\/([a-f0-9]{32})\/(payload|artifacts|renew|start-permits)$/);
        if(jobRoute)this.leased(this.executor(executorID),jobRoute[1],input.lease_id,jobRoute[2]==='renew');
        if(jobRoute&&jobRoute[2]==='start-permits')return action(this.executor(executorID),input);
        return parseStrictJSON(this.deps.decrypt(seen.response_enc),2<<20);
      }
      const response = action(row, input);
      this.deps.db.run("INSERT INTO privileged_request_nonces(executor_id,request_id,request_sha256,response_enc,created_at) VALUES(?,?,?,?,?)", executorID, claims.request_id, requestHash, this.deps.encrypt(canonicalJSON(response)), this.now());
      return response;
    });
  }
  heartbeat(executor: Row, value: unknown) {
    const keys = ["version", "boot_id", "activation_id", "policy_generation", "capabilities", "account_profiles", "interpreter_profiles","release","operations_capabilities","docker_inventory"];
    const v = object(value, keys,keys.filter(k=>!["release","operations_capabilities","docker_inventory"].includes(k))); boundedText(v.version, 128); validate(() => nonce(v.boot_id));
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.activation_id))fail(400,"invalid_executor_activation");
    if (v.release!==undefined) {
      const release=object(v.release,["build_id","source_revision","artifact_sha256","state_schema"]);
      validate(()=>boundedText(release.build_id));
      if (!/^[a-f0-9]{40}$/.test(release.source_revision) || release.state_schema!==1) fail(400,"invalid_executor_release");
      validate(()=>digest(release.artifact_sha256));
    }
    if (!Number.isSafeInteger(v.policy_generation) || v.policy_generation < 1) fail(400, "invalid_policy_generation");
    if(v.docker_inventory!==undefined&&!dockerInventory(v.docker_inventory))fail(400,"invalid_docker_inventory");
    const capabilities = this.capabilities(v.capabilities);
    if(v.operations_capabilities!==undefined&&(!Array.isArray(v.operations_capabilities)||v.operations_capabilities.length>30||v.operations_capabilities.some((c:unknown)=>typeof c!=="string"||!/^operations\.[a-z0-9_.-]{1,64}$/.test(c))))fail(400,"invalid_operations_capabilities");
    if (!Array.isArray(v.account_profiles) || v.account_profiles.length > 32 || !Array.isArray(v.interpreter_profiles) || v.interpreter_profiles.length > 8) fail(400, "invalid_profiles");
    v.account_profiles.forEach((p: unknown) => validate(() => validateAccount(p)));
    v.interpreter_profiles.forEach((p: unknown) => { const profile = object(p, ["runtime", "sha256"]); if (!["shell", "node"].includes(profile.runtime)) fail(400, "invalid_runtime"); validate(() => digest(profile.sha256)); });
    if (new Set(v.account_profiles.map((p: ExecutorAccount) => p.name)).size !== v.account_profiles.length || new Set(v.interpreter_profiles.map((p: Row) => p.runtime)).size !== v.interpreter_profiles.length) fail(400, "duplicate_profiles");
    const policy = this.policy(executor.machine_id);
    this.deps.db.run("UPDATE privileged_executors SET last_seen=?,observation_enc=? WHERE id=?", this.now(), this.deps.encrypt(canonicalJSON({ ...v, capabilities })), executor.id);
    const iat = Math.floor(this.deps.now().getTime() / 1000), authorized = JSON.parse(policy.capabilities_json);
    const claims = { version: 1, purpose: "policy", center_instance_id: this.centerInstanceID, executor_id: executor.id, machine_id: executor.machine_id, agent_id: executor.agent_id, install_generation: executor.install_generation, policy_generation: policy.generation, capabilities: authorized, iat, exp: iat + 60 };
    return { center_instance_id: this.centerInstanceID, policy_generation: policy.generation, capabilities: authorized, policy: signJWS(claims, this.centerPrivateKey, this.centerKeyID), lease_seconds: EXECUTOR_LEASE_SECONDS, server_time: this.now() };
  }
  requireManagedReady(agentID:string) {
    const host=this.deps.db.get<Row>("SELECT id FROM managed_machines WHERE agent_id=?",agentID);
    if(!host||this.getStatus(host.id).capabilities['operations.managed.v1'].effective!=='ready')fail(409,'managed_operations_executor_required');
  }
  enqueueManaged(job:Row,payload:PrivilegedPayload,actor:string) {
    this.actor(actor);this.requireManagedReady(job.agent_id);
    if(payload.kind!=='managed'||payload.job.id!==job.id)fail(400,'managed_job_mismatch');
    const h=this.deps.db.get<Row>("SELECT id,name,agent_id FROM managed_machines WHERE agent_id=?",job.agent_id)!;
    this.idle(h.id,h.agent_id,job.id);
    const executor=this.getStatus(h.id).executor!,policy=this.policy(h.id),revision=sha256(canonicalJSON(payload)),authorization=randomUUID();
    this.deps.db.run("INSERT INTO privileged_grants(id,job_id,revision,approved_by,state,expires_at) VALUES(?,?,?,?,'reserved',?)",authorization,job.id,revision,actor,job.expires_at);
    this.deps.db.run("INSERT INTO privileged_jobs(id,task_run_id,machine_id,agent_id,executor_id,install_generation,policy_generation,capability,payload_enc,payload_sha256,authorization_id,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,'operations.managed.v1',?,?,?,'queued',?,?)",job.id,job.id,h.id,h.agent_id,executor.id,executor.install_generation,policy.generation,this.deps.encrypt(canonicalJSON(payload)),revision,authorization,this.now(),job.expires_at);
    const metadata={task_id:'managed:'+job.deployment_id,task_name:'受管主机运维',host_id:h.id,host_name:h.name,agent_id:h.agent_id,execution_principal:'privileged_executor',executor_id:executor.id,capability:'operations.managed.v1',request_sha256:revision,authorization_id:authorization,operation_id:job.operation_id};
    this.deps.db.run("INSERT INTO task_runs(id,task_id,host_id,agent_id,snapshot_json,state,trigger,request_id,requested_by,created_at,expires_at,execution_principal,executor_id,auto_retry_closed) VALUES(?,?,?,?,?,'queued','manual',?,?,?,?,'privileged_executor',?,1)",job.id,metadata.task_id,h.id,h.agent_id,canonicalJSON(metadata),job.id,actor,this.now(),job.expires_at,executor.id);
    this.audit(h.id,actor,'managed_execution_approved',job.id,{request_sha256:revision,operation_id:job.operation_id});
  }
  plan(value: unknown, actor: string) {
    this.actor(actor); this.sweep();
    const v = object(value, ["host_ids", "capability", "payload"]);
    if (!Array.isArray(v.host_ids) || !v.host_ids.length || v.host_ids.length > 50 || new Set(v.host_ids).size !== v.host_ids.length) fail(400, "explicit_host_ids_required");
    const payload = validate(() => normalizePrivilegedPayload(v.payload)), expected = payload.kind === "script" ? "script.elevated.v1" : "container.managed.v1";
    if (v.capability !== expected) fail(400, "principal_mismatch");
    if(payload.kind==='managed')fail(400,'managed_jobs_require_registered_operation');
    const targets = v.host_ids.map((id: unknown) => {
      validate(() => boundedText(id)); const h = this.host(id as string), policy = this.policy(h.id), status = this.getStatus(h.id);
      if (status.capabilities[expected].effective !== "ready") fail(409, "execution_capability_not_ready");
      this.idle(h.id, h.agent_id);
      if (payload.kind === "script") {
        if (!status.account_profiles.some((account: ExecutorAccount) => canonicalJSON(account) === canonicalJSON(payload.account))) fail(409, "account_changed");
        if (!status.interpreter_profiles.some((profile: Row) => profile.runtime === payload.runtime && profile.sha256 === payload.interpreter_sha256)) fail(409, "interpreter_changed");
      }
      return { machine_id: h.id, machine_name: h.name, agent_id: h.agent_id, executor_id: status.executor!.id, install_generation: status.executor!.install_generation, policy_generation: policy.generation };
    });
    const snapshot = { capability: expected, payload, targets }, revision = sha256(canonicalJSON(snapshot)), id = randomUUID(), expires = plus(this.deps.now(), 300);
    this.deps.db.run("INSERT INTO privileged_execution_plans(id,snapshot_enc,revision,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)", id, this.deps.encrypt(canonicalJSON(snapshot)), revision, actor, this.now(), expires);
    return { id, revision, expires_at: expires, ...snapshot, risk: payload.kind === "script" && payload.account.uid === 0 ? "full_host_root_code_execution" : "privileged_host_execution" };
  }
  apply(planID: string, value: unknown, actor: string) {
    this.actor(actor); this.sweep(); const v = object(value, ["confirm", "expected_revision", "request_id"]);
    if (v.confirm !== true) fail(400, "explicit_confirmation_required"); validate(() => nonce(v.request_id));
    return this.deps.db.transaction(() => {
      const plan = this.deps.db.get<Row>("SELECT * FROM privileged_execution_plans WHERE id=?", planID);
      if (!plan || plan.revision !== v.expected_revision) fail(409, "stale_execution_plan");
      if (plan.applied_at) {
        if (plan.request_id !== v.request_id) fail(409, "replay_conflict");
        return { jobs: this.deps.db.all<Row>("SELECT j.id FROM privileged_jobs j JOIN task_runs t ON t.id=j.task_run_id WHERE t.task_id=? ORDER BY j.id", "privileged:" + planID).map(r => this.get(r.id)) };
      }
      if (plan.expires_at <= this.now()) fail(409, "expired_execution_plan");
      const snapshot = parseStrictJSON(this.deps.decrypt(plan.snapshot_enc)), jobs = [];
      for (const target of snapshot.targets) {
        const executor = this.executor(target.executor_id), h = this.host(target.machine_id), policy = this.policy(h.id), status = this.getStatus(h.id);
        if (h.agent_id !== target.agent_id || executor.install_generation !== target.install_generation || policy.generation !== target.policy_generation || status.capabilities[snapshot.capability as PrivilegedCapability].effective !== "ready") fail(409, "stale_policy");
        this.idle(h.id, h.agent_id);
        const payload = normalizePrivilegedPayload(snapshot.payload);
        if (payload.kind === "script" && (!status.account_profiles.some((p: ExecutorAccount) => canonicalJSON(p) === canonicalJSON(payload.account)) || !status.interpreter_profiles.some((p: Row) => p.runtime === payload.runtime && p.sha256 === payload.interpreter_sha256))) fail(409, "account_or_interpreter_changed");
        const id = randomUUID(), authorization = randomUUID(), expires = plus(this.deps.now(), 300), taskName = payload.kind === "script" ? "提权脚本" : "受管容器操作";
        this.deps.db.run("INSERT INTO privileged_grants(id,job_id,revision,approved_by,state,expires_at) VALUES(?,?,?,?,'reserved',?)", authorization, id, plan.revision, actor, expires);
        this.deps.db.run("INSERT INTO privileged_jobs(id,task_run_id,machine_id,agent_id,executor_id,install_generation,policy_generation,capability,payload_enc,payload_sha256,authorization_id,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)", id, id, h.id, h.agent_id, executor.id, executor.install_generation, policy.generation, snapshot.capability, this.deps.encrypt(canonicalJSON(payload)), sha256(canonicalJSON(payload)), authorization, this.now(), expires);
        const metadata = { task_id: "privileged:" + planID, task_name: taskName, host_id: h.id, host_name: h.name, agent_id: h.agent_id, execution_principal: "privileged_executor", executor_id: executor.id, capability: snapshot.capability, request_sha256: sha256(canonicalJSON(payload)), authorization_id: authorization, task_revision: plan.revision };
        this.deps.db.run("INSERT INTO task_runs(id,task_id,host_id,agent_id,snapshot_json,state,trigger,request_id,requested_by,created_at,expires_at,execution_principal,executor_id,auto_retry_closed) VALUES(?,?,?,?,?,'queued','manual',?,?,?,?,'privileged_executor',?,1)", id, metadata.task_id, h.id, h.agent_id, canonicalJSON(metadata), v.request_id, actor, this.now(), expires, executor.id);
        this.audit(h.id, actor, "privileged_execution_approved", id, { capability: snapshot.capability, plan_revision: plan.revision }); jobs.push(this.get(id));
      }
      this.deps.db.run("UPDATE privileged_execution_plans SET applied_at=?,request_id=? WHERE id=?", this.now(), v.request_id, planID);
      return { jobs };
    });
  }
  private row(id: string): Row {
    const row = this.deps.db.get<Row>("SELECT * FROM privileged_jobs WHERE id=?", id); if (!row) fail(404, "privileged_job_not_found"); return row;
  }
  private authority(job: Row, executor: Row, allowTerminal = false) {
    if (job.executor_id !== executor.id || job.machine_id !== executor.machine_id || job.agent_id !== executor.agent_id || job.install_generation !== executor.install_generation) fail(403, "principal_mismatch");
    const policy = this.policy(job.machine_id), grant = this.deps.db.get<Row>("SELECT * FROM privileged_grants WHERE id=? AND job_id=?", job.authorization_id, job.id);
    if (!grant || grant.revoked_at || !["reserved", "consumed"].includes(grant.state)) fail(403, "privileged_script_not_authorized"); this.actor(grant.approved_by);
    if (policy.generation !== job.policy_generation || policy.agent_id !== job.agent_id) fail(403, "stale_policy");
    if (!JSON.parse(policy.capabilities_json).includes(job.capability)) fail(403, "policy_disabled");
    this.actor(policy.approved_by);
    if (!allowTerminal && (job.cancel_requested || terminal(job.state))) fail(409, "execution_not_active");
    if (job.state === "queued" && grant.expires_at <= this.now()) fail(403, "expired_authorization");
    if(job.capability==='operations.managed.v1')this.managed?.validate(job);
    return grant;
  }
  private sync(job: Row) {
    const summary = ({ queued: "等待执行器领取", running: "执行器正在运行", succeeded: "执行器报告完成", failed: "执行器报告失败", cancelled: "执行已取消", unknown: "执行结果未知，请核对主机" } as Row)[job.state];
    this.deps.db.run("UPDATE task_runs SET state=?,started_at=?,finished_at=?,lease_expires_at=?,cancel_requested=?,code=?,summary=?,resolved_at=?,resolved_by=?,resolution_reason=?,auto_retry_closed=1 WHERE id=? AND execution_principal='privileged_executor'", job.state, job.started_at, job.finished_at, job.lease_expires_at, job.cancel_requested, job.code, summary, job.resolved_at, job.resolved_by, job.resolution_reason, job.task_run_id);
    if(job.capability==='operations.managed.v1')this.managed?.sync(job);
  }
  sweep() {
    const rows = this.deps.db.all<Row>("SELECT * FROM privileged_jobs WHERE (state='queued' AND expires_at<=?) OR (state='running' AND lease_expires_at<=?)", this.now(), this.now());
    for (const row of rows) {
      this.deps.db.run("UPDATE privileged_jobs SET state=?,finished_at=?,code=? WHERE id=?", row.state === "queued" ? "cancelled" : "unknown", this.now(), row.state === "queued" ? "queue_expired" : "execution_unknown", row.id); this.sync(this.row(row.id));
    }
  }
  claim(executor: Row, value: unknown) {
    object(value, []); this.sweep();
    if (this.deps.db.get("SELECT id FROM privileged_jobs WHERE executor_id=? AND (state='running' OR (state='unknown' AND resolved_at=''))", executor.id)) return { job: null };
    this.managed?.prepare(executor);
    const jobs = this.deps.db.all<Row>("SELECT * FROM privileged_jobs WHERE executor_id=? AND state='queued' ORDER BY created_at,id LIMIT 50", executor.id);
    for (const job of jobs) {
      try { this.authority(job, executor); this.idle(job.machine_id, job.agent_id, job.id); }
      catch (error) {
        if (!(error instanceof HTTPError)) throw error;
        this.deps.db.run("UPDATE privileged_jobs SET state='cancelled',finished_at=?,code='authorization_unavailable' WHERE id=?", this.now(), job.id); this.sync(this.row(job.id)); continue;
      }
      const lease = randomBytes(32).toString("base64url"), expiry = plus(this.deps.now(), EXECUTOR_LEASE_SECONDS);
      this.deps.db.run("UPDATE privileged_jobs SET state='running',phase='accepted',lease_id=?,lease_expires_at=?,started_at=? WHERE id=?", lease, expiry, this.now(), job.id);
      const active = this.row(job.id); if(active.capability==='operations.managed.v1')this.managed?.claim(active); this.sync(active);
      return { job: { plan: signJWS(this.planClaims(active), this.centerPrivateKey, this.centerKeyID), payload: parseStrictJSON(this.deps.decrypt(active.payload_enc)) } };
    } return { job: null };
  }
  private planClaims(job: Row): PrivilegedPlan {
    const payload = parseStrictJSON(this.deps.decrypt(job.payload_enc)) as PrivilegedPayload, grant = this.deps.db.get<Row>("SELECT * FROM privileged_grants WHERE id=?", job.authorization_id)!;
    const at = Math.floor(this.deps.now().getTime() / 1000);
    return { version: 1, purpose: "plan", center_instance_id: this.centerInstanceID, machine_id: job.machine_id, agent_id: job.agent_id, executor_id: job.executor_id, install_generation: job.install_generation, job_id: job.id, task_run_id: job.task_run_id, operation_id: job.id, lease_id: job.lease_id, policy_generation: job.policy_generation, authorization_id: grant.id, authorization_revision: grant.revision, capability: job.capability, action: payload.kind === "script" ? "execute" : payload.operation, resource_id: payload.kind === "script" ? job.id : payload.resource_id, resource_revision: payload.kind === "script" ? grant.revision : String(payload.resource_revision), request_sha256: job.payload_sha256, iat: at, nbf: at, exp: at + EXECUTOR_LEASE_SECONDS, max_runtime_ms: payload.timeout_ms };
  }
  private leased(executor: Row, id: string, lease: unknown, permitTerminal = false) {
    this.sweep(); const job = this.row(id); this.authority(job, executor, permitTerminal);
    if (typeof lease !== "string" || lease !== job.lease_id || !lease) fail(403, "invalid_execution_lease");
    if (job.state === "unknown" || job.resolved_at || job.state === "queued" || job.state === "running" && job.lease_expires_at <= this.now()) fail(409, "execution_unknown");
    return job;
  }
  renew(executor: Row, id: string, value: unknown) {
    const v = object(value, ["lease_id"]), job = this.leased(executor, id, v.lease_id, true);
    if (terminal(job.state)) return { lease_expires_at: job.lease_expires_at, cancel_requested: true, state: job.state };
    this.deps.db.run("UPDATE privileged_jobs SET lease_expires_at=? WHERE id=?", plus(this.deps.now(), EXECUTOR_LEASE_SECONDS), id); const active = this.row(id); this.sync(active);
    return { lease_expires_at: active.lease_expires_at, cancel_requested: !!active.cancel_requested, state: active.state };
  }
  payload(executor: Row, id: string, value: unknown) {
    const v = object(value, ["lease_id"]), job = this.leased(executor, id, v.lease_id);
    return { payload: parseStrictJSON(this.deps.decrypt(job.payload_enc)), request_sha256: job.payload_sha256 };
  }
  reconcile(executor: Row, id: string, value: unknown) {
    const v = object(value, ["lease_id"]); this.sweep(); const job = this.row(id);
    if (job.executor_id !== executor.id || job.install_generation !== executor.install_generation || !job.lease_id || job.lease_id !== v.lease_id) fail(403, "principal_mismatch");
    return { job: this.get(id), release_fence: terminal(job.state) && (job.state !== "unknown" || !!job.resolved_at) };
  }
  startPermit(executor: Row, id: string, value: unknown) {
    const v = object(value, ["lease_id", "step_id", "executor_nonce"]), job = this.leased(executor, id, v.lease_id);
    const payload = parseStrictJSON(this.deps.decrypt(job.payload_enc)) as PrivilegedPayload;
    const expectedStep = payload.kind === "script" ? "execute" : payload.kind==='managed' ? 'managed.execute' : "docker." + payload.operation;
    validate(() => nonce(v.executor_nonce)); if (v.step_id !== expectedStep) fail(400, "unsupported_execution_step");
    this.idle(job.machine_id, job.agent_id, job.id);
    const previous = this.deps.db.get<Row>("SELECT * FROM privileged_start_permits WHERE job_id=? AND step_id=?", id, v.step_id);
    if (previous) {
      if (previous.executor_nonce !== v.executor_nonce) fail(409, "replay_conflict");
      if (Date.parse(previous.created_at) + 30_000 <= this.deps.now().getTime()) fail(409, "expired_permit"); return { permit: previous.permit_jws };
    }
    const grant = this.deps.db.get<Row>("SELECT * FROM privileged_grants WHERE id=? AND state='reserved' AND revoked_at=''", job.authorization_id);
    if (!grant || grant.expires_at <= this.now()) fail(403, "privileged_script_not_authorized");
    const claims = this.planClaims(job), permit: StartPermit = { ...claims, purpose: "start-permit", step_id: expectedStep, permit_id: randomBytes(24).toString("base64url"), executor_nonce: v.executor_nonce, exp: Math.min(claims.iat + 30, Math.floor(Date.parse(job.lease_expires_at) / 1000)) };
    if (permit.exp <= permit.iat) fail(409, "expired_permit");
    const signed = signJWS(permit, this.centerPrivateKey, this.centerKeyID);
    this.deps.db.run("UPDATE privileged_grants SET state='consumed' WHERE id=? AND state='reserved'", grant.id);
    this.deps.db.run("INSERT INTO privileged_start_permits(job_id,step_id,executor_nonce,permit_id,permit_jws,created_at) VALUES(?,?,?,?,?,?)", id, expectedStep, v.executor_nonce, permit.permit_id, signed, this.now());
    if(payload.kind!=='managed')this.deps.db.run("UPDATE privileged_jobs SET phase='activating' WHERE id=?", id);
    return { permit: signed };
  }
  events(executor: Row, id: string, value: unknown) {
    const v = object(value, ["lease_id", "sequence", "phase", "code", "detail"],["lease_id", "sequence", "phase", "code"]), job = this.leased(executor, id, v.lease_id, true);
    if(v.detail!==undefined&&(job.capability!=='operations.managed.v1'||!v.detail||typeof v.detail!=='object'||Buffer.byteLength(canonicalJSON(v.detail))>65536))fail(400,'invalid_managed_event');
    if (!Number.isSafeInteger(v.sequence) || v.sequence !== job.event_sequence + 1 || !["accepted", "preflighting", "staging", "activating", "verifying"].includes(v.phase) || typeof v.code !== "string" || !/^[a-z0-9_]{0,64}$/.test(v.code)) fail(409, "invalid_execution_event");
    const phases = ["accepted", "preflighting", "staging", "activating", "verifying"];
    if (phases.indexOf(v.phase) < phases.indexOf(job.phase) || terminal(job.state)) fail(409, "invalid_execution_phase");
    this.deps.db.run("UPDATE privileged_jobs SET event_sequence=?,phase=? WHERE id=?", v.sequence, v.phase, id);
    if(job.capability==='operations.managed.v1')this.managed?.event(job,v);
    return { sequence: v.sequence };
  }
  result(executor: Row, id: string, value: unknown) {
    const v = object(value, ["lease_id", "state", "code", "summary", "exit_code", "stdout", "stderr"]), job = this.leased(executor, id, v.lease_id, true);
    if (terminal(job.state)) return { job: this.get(id) };
    const payload = parseStrictJSON(this.deps.decrypt(job.payload_enc)) as PrivilegedPayload;
    if (!["succeeded", "failed", "cancelled", "unknown"].includes(v.state) || typeof v.code !== "string" || !/^[a-z0-9_]{0,64}$/.test(v.code) || typeof v.summary !== "string" || Buffer.byteLength(v.summary) > 1024 || typeof v.stdout !== "string" || typeof v.stderr !== "string" || Buffer.byteLength(v.stdout) + Buffer.byteLength(v.stderr) > payload.max_output_bytes || !(v.exit_code === null || Number.isInteger(v.exit_code) && Math.abs(v.exit_code) <= 255) || v.state === "succeeded" && v.exit_code !== 0) fail(400, "invalid_execution_result");
    if (v.state === "succeeded" && !this.deps.db.get("SELECT job_id FROM privileged_start_permits WHERE job_id=?", id)) fail(409, "execution_not_started");
    if (v.state === "cancelled" && !job.cancel_requested) fail(409, "cancellation_not_requested");
    this.deps.db.run("UPDATE privileged_jobs SET state=?,phase=?,finished_at=?,code=?,output_enc=? WHERE id=?", v.state, v.state, this.now(), v.code, this.deps.encrypt(canonicalJSON({ stdout: v.stdout, stderr: v.stderr, exit_code: v.exit_code })), id);
    if(payload.kind==='managed')this.managed?.result(job,v);
    this.sync(this.row(id)); this.audit(job.machine_id, executor.id, "executor_result", id, { state: v.state, code: v.code });
    return { job: this.get(id) };
  }
  managedArtifact(executor:Row,id:string,value:unknown) {
    const v=object(value,['lease_id','release_id','offset']),job=this.leased(executor,id,v.lease_id);
    if(job.capability!=='operations.managed.v1'||!this.managed)fail(403,'principal_mismatch');
    return this.managed.artifact(job,v);
  }
  get(id: string) {
    this.sweep(); const row = this.row(id);
    const task = this.deps.db.get<Row>("SELECT task_id,request_id FROM task_runs WHERE id=?", row.task_run_id), grant = this.deps.db.get<Row>("SELECT revision FROM privileged_grants WHERE id=?", row.authorization_id);
    return { id: row.id, task_run_id: row.task_run_id, plan_id: task?.task_id?.replace(/^privileged:/, "") ?? "", plan_revision: grant?.revision ?? "", request_id: task?.request_id ?? "", machine_id: row.machine_id, agent_id: row.agent_id, executor_id: row.executor_id, execution_principal: "privileged_executor", capability: row.capability, state: row.state, phase: row.phase, policy_generation: row.policy_generation, install_generation: row.install_generation, request_sha256: row.payload_sha256, authorization_id: row.authorization_id, created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at, cancel_requested: !!row.cancel_requested, code: row.code, resolved_at: row.resolved_at, resolved_by: row.resolved_by, resolution_reason: row.resolution_reason, has_output: !!row.output_enc };
  }
  list(machineID?: string) {
    this.sweep(); return this.deps.db.all<Row>("SELECT id FROM privileged_jobs" + (machineID ? " WHERE machine_id=?" : "") + " ORDER BY created_at DESC,id DESC LIMIT 100", ...(machineID ? [machineID] : [])).map(row => this.get(row.id));
  }
  cancel(id: string, actor: string) {
    this.actor(actor); const row = this.row(id);
    if (row.state === "queued") this.deps.db.run("UPDATE privileged_jobs SET state='cancelled',finished_at=?,cancel_requested=1,code='cancelled' WHERE id=?", this.now(), id);
    else if (row.state === "running") this.deps.db.run("UPDATE privileged_jobs SET cancel_requested=1 WHERE id=?", id);
    this.sync(this.row(id)); this.audit(row.machine_id, actor, "cancellation_requested", id); return this.get(id);
  }
  resolve(id: string, actor: string, reason: unknown) {
    this.actor(actor); const why = validate(() => boundedText(reason, 512)); this.sweep(); const row = this.row(id);
    if (row.state !== "unknown") fail(409, "only_unknown_can_be_reconciled");
    if (!row.resolved_at) this.deps.db.run("UPDATE privileged_jobs SET resolved_at=?,resolved_by=?,resolution_reason=? WHERE id=?", this.now(), actor, why, id);
    this.sync(this.row(id)); this.audit(row.machine_id, actor, "unknown_manually_reconciled", id); return this.get(id);
  }
  output(id: string, actor: string) {
    this.actor(actor); const job = this.row(id); this.audit(job.machine_id, actor, "sensitive_output_read", id);
    return job.output_enc ? parseStrictJSON(this.deps.decrypt(job.output_enc)) : { stdout: "", stderr: "", exit_code: null };
  }
}

export function registerPrivilegedExecutors(deps: Dependencies, options: { dataDir: string }): PrivilegedExecutorStore & Module {
  const store = new PrivilegedExecutorStore(deps, options), r = deps.router;
  const human = (c: Context) => {
    deps.auth.requireAdmin(c);
    if (c.req.headers.authorization || !c.req.headers.cookie?.split(";").some(p => p.trim().startsWith("lm_session=")) || (deps.auth.user(c.req)?.id !== c.user.id || deps.auth.user(c.req)?.role !== "admin" || !deps.db.get("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'",c.user.id))) fail(403, "human_admin_session_required");
  };
  const readBody = async (c: Context) => { const raw = await c.raw(1 << 20); return validate(() => parseStrictJSON(raw)); };
  // All privileged machine requests are public only to the session middleware;
  // each one authenticates the separate executor signature over the raw body.
  r.post("/api/v1/privileged-executors/enroll", async c => { const raw = await c.raw(1 << 20); c.json(store.enroll(validate(() => parseStrictJSON(raw)))); }, { public: true });
  const signed = (suffix: string, action: (e: Row, v: Row, c: Context) => unknown) => r.post("/api/v1/privileged-executors/:id/" + suffix, async c => {
    if (c.url.search || c.req.url !== c.url.pathname) fail(400, "invalid_request_path");
    const raw = await c.raw(1 << 20);
    c.json(store.signedRequest(c.params.id, c.req.method!, c.url.pathname, raw, c.req.headers[EXECUTOR_SIGNATURE_HEADER], (e, v) => action(e, v, c)));
  }, { public: true });
  signed("heartbeat", (e, v) => store.heartbeat(e, v));
  signed("jobs/claim", (e, v) => store.claim(e, v));
  signed("jobs/:jobId/renew", (e, v, c) => store.renew(e, c.params.jobId, v));
  signed("jobs/:jobId/payload", (e, v, c) => store.payload(e, c.params.jobId, v));
  signed("jobs/:jobId/reconcile", (e, v, c) => store.reconcile(e, c.params.jobId, v));
  signed("jobs/:jobId/start-permits", (e, v, c) => store.startPermit(e, c.params.jobId, v));
  signed("jobs/:jobId/events", (e, v, c) => store.events(e, c.params.jobId, v));
  signed("jobs/:jobId/result", (e, v, c) => store.result(e, c.params.jobId, v));
  signed("jobs/:jobId/artifacts", (e,v,c)=>store.managedArtifact(e,c.params.jobId,v));
  signed('observations/targets',(e,v)=>{object(v,[]);store.observationAuthority(e.id);if(!store.observations)fail(503,'executor_observation_unavailable');return store.observations!.targets(e);});
  signed('observations/batches',(e,v)=>{store.observationAuthority(e.id);if(!store.observations)fail(503,'executor_observation_unavailable');return store.observations!.accept(e,v);});
  r.get("/api/v1/machines/:id/execution-status", c => { deps.auth.requireAdmin(c); c.json(store.getStatus(c.params.id)); });
  r.post("/api/v1/machines/:id/execution-policy/plan", async c => { human(c); c.json(store.preparePolicyPlan(c.params.id, await readBody(c), c.user.id)); });
  r.get("/api/v1/machines/:id/execution-policy/plans/:planId", c => { deps.auth.requireAdmin(c); c.json(store.getPolicyPlan(c.params.id, c.params.planId)); });
  r.post("/api/v1/machines/:id/execution-policy/plans/:planId/apply", async c => { human(c); c.json(store.applyPolicy(c.params.id, c.params.planId, await readBody(c), c.user.id)); });
  r.post("/api/v1/privileged-execution/plans", async c => { human(c); c.json(store.plan(await readBody(c), c.user.id)); });
  r.post("/api/v1/privileged-execution/plans/:id/apply", async c => { human(c); c.json(store.apply(c.params.id, await readBody(c), c.user.id)); });
  r.get("/api/v1/privileged-execution/jobs", c => { deps.auth.requireAdmin(c); c.json({ jobs: store.list(c.url.searchParams.get("host_id") ?? undefined) }); });
  r.get("/api/v1/privileged-execution/jobs/:id", c => { deps.auth.requireAdmin(c); c.json({ job: store.get(c.params.id) }); });
  r.get("/api/v1/privileged-execution/jobs/:id/output", c => { human(c); c.json(store.output(c.params.id, c.user.id)); });
  r.post("/api/v1/privileged-execution/jobs/:id/cancel", async c => { human(c); const v = object(await readBody(c), ["confirm"]); if (v.confirm !== true) fail(400, "explicit_confirmation_required"); c.json({ job: store.cancel(c.params.id, c.user.id) }); });
  r.post("/api/v1/privileged-execution/jobs/:id/reconcile", async c => { human(c); const v = object(await readBody(c), ["confirm", "reason"]); if (v.confirm !== true) fail(400, "explicit_confirmation_required"); c.json({ job: store.resolve(c.params.id, c.user.id, v.reason) }); });
  return store;
}
