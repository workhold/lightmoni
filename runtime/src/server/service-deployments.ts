import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { readFile } from "node:fs/promises";
import { id } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import { createAgentLifecycleSchema, isAgentRemoved } from "./agent-lifecycle.js";
import type { Context, Dependencies, Handler, Module } from "../shared/types.js";
import { deploymentAdapters } from "../deployment/index.js";
import { assertReleaseBundleHasNoCredentials, parseReleaseBundle } from "../deployment/release-bundle.js";
import { ReleaseArtifactError, ReleaseArtifactStore } from "../deployment/artifact-store.js";
import { queryDeploymentTelemetry, validateTelemetryBinding } from "../deployment/telemetry-query.js";
import type { AgentJobStore } from "./agent-jobs.js";

/**
 * Service delivery metadata.
 *
 * This module owns the durable service/release/target/deployment records.
 * Agent receipts may advance an approved deployment, but only through the
 * reviewed state graph and after a successful health-check receipt.
 */

export type ServiceAdapter = "systemd" | "docker_compose";
export type DeploymentStatus =
  | "draft"
  | "preflight"
  | "awaiting_approval"
  | "agent_ready"
  | "staging"
  | "activating"
  | "verifying"
  | "running"
  | "succeeded"
  | "failed"
  | "rollback_pending"
  | "rolling_back"
  | "rolled_back"
  | "cancelled";

/**
 * Deployment state is controlled by the centre.  Agent receipts may only
 * advance an operation along one of these edges; callers cannot jump from a
 * plan straight to succeeded.  `running` is retained for old machine-facing
 * records and is not a valid business deployment transition.
 */
export const DEPLOYMENT_TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  draft: ["preflight", "awaiting_approval", "cancelled"],
  preflight: ["awaiting_approval", "failed", "cancelled"],
  awaiting_approval: ["agent_ready", "cancelled"],
  agent_ready: ["staging", "failed", "rollback_pending", "cancelled"],
  staging: ["activating", "failed", "rollback_pending"],
  activating: ["verifying", "failed", "rollback_pending"],
  verifying: ["succeeded", "failed", "rollback_pending"],
  running: ["succeeded", "failed", "rollback_pending"],
  succeeded: ["rollback_pending"],
  failed: ["rollback_pending", "cancelled"],
  rollback_pending: ["rolling_back", "failed", "cancelled"],
  rolling_back: ["rolled_back", "failed"],
  rolled_back: [],
  cancelled: [],
};

export function canTransitionDeployment(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return DEPLOYMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

// Keep the API in lockstep with the provider registry. A provider name that
// only exists as a future type must not produce an apparently deployable plan.
const ADAPTERS = new Set<string>(deploymentAdapters.list());
const SERVICE_ID = /^[a-f0-9]{32}$/;
const MAX_JSON_BYTES = 64 << 10;
const PREFLIGHT_TTL_MS = 10 * 60_000;
const SYSTEMD_UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,126}\.service$/;
const RELEASE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const RELEASE_BUNDLE_CONTENT_TYPE = "application/vnd.lightmoni.release+gzip";

const nowISO = (deps: Dependencies) => deps.now().toISOString();
const record = (value: unknown, field = "request"): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, `invalid ${field}`);
  return value as Record<string, any>;
};
const text = (value: unknown, field: string, max: number, required = true) => {
  if (value == null && !required) return "";
  if (typeof value !== "string" || (required && !value.trim()))
    fail(400, `invalid ${field}`);
  if (Buffer.byteLength(value) > max) fail(400, `${field} is too long`);
  return value.trim();
};
const jsonObject = (value: unknown, field: string) => {
  const input = value == null ? {} : record(value, field);
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_JSON_BYTES)
    fail(400, `${field} is too large`);
  return input;
};
const parse = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
const admin = (deps: Dependencies, ctx: Context) => deps.auth.requireAdmin(ctx);
const safe = (deps: Dependencies, handler: Handler): Handler => async (ctx) => {
  try {
    await handler(ctx);
  } catch (error) {
    if (ctx.res.headersSent) {
      if (!ctx.res.writableEnded) ctx.res.end();
      return;
    }
    if (error instanceof HTTPError) ctx.json({ error: error.message }, error.status);
    else if (error instanceof Error && /UNIQUE constraint failed/.test(error.message))
      ctx.json({ error: "服务名称已存在" }, 409);
    else {
      deps.logger.error(error);
      ctx.json({ error: "服务部署管理操作失败" }, 500);
    }
  }
};

export interface ServiceDeploymentStore {
  /** Sanitized service inventory for assistant reads. */
  assistantServices(): ReturnType<typeof serviceView>[];
  /** Sanitized deployment record for assistant reads. */
  assistantDeployment(deploymentID: string): Record<string, any>;
  /** Sanitized append-only deployment events for assistant reads. */
  assistantDeploymentEvents(deploymentID: string): Record<string, any>[];
  /** Create an approval-ready plan without executing a host action. */
  assistantPlan(input: { service_id: string; target_id: string; release_id: string }, actorID: string): Record<string, any>;
}

const serviceView = (row: any) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  repository_url: row.repository_url,
  created_at: row.created_at,
  updated_at: row.updated_at,
  created_by: row.created_by,
});
const targetView = (row: any) => ({
  id: row.id,
  service_id: row.service_id,
  machine_id: row.machine_id,
  machine_name: row.machine_name ?? "",
  adapter: row.adapter,
  config: parse(row.config_json, {}),
  desired_release_id: row.desired_release_id || "",
  status: row.status,
  created_at: row.created_at,
  updated_at: row.updated_at,
});
const releaseView = (row: any) => ({
  id: row.id,
  service_id: row.service_id,
  version: row.version,
  source_type: row.source_type,
  source_ref: row.source_ref,
  artifact_digest: row.artifact_digest,
  artifact_size: Number(row.artifact_size || 0),
  artifact_format: row.artifact_format || "",
  manifest: parse(row.manifest_json, {}),
  status: row.status,
  created_at: row.created_at,
  created_by: row.created_by,
});
const baseDeploymentView = (row: any) => ({
  id: row.id,
  service_id: row.service_id,
  target_id: row.target_id,
  release_id: row.release_id,
  adapter: row.adapter,
  status: row.status,
  state: row.status,
  phase: row.phase || row.status,
  operation_id: row.operation_id || "",
  operation_kind: row.operation_kind || "deploy",
  plan: parse(row.plan_json, {}),
  previous: parse(row.previous_json, {}),
  target_snapshot: parse(row.target_snapshot_json, {}),
  receipt: parse(row.receipt_json, {}),
  error: row.error,
  error_code: row.error_code || "",
  created_at: row.created_at,
  created_by: row.created_by,
  approved_at: row.approved_at,
  started_at: row.started_at,
  finished_at: row.finished_at,
});

const preflightView = (row: any, current = false) => {
  const snapshot = parse<Record<string, any>>(row.snapshot_json, {});
  return {
    id: row.id,
    status: row.status,
    ready: snapshot.preflight?.ready === true,
    snapshot,
    error_code: row.error_code || "",
    created_at: row.created_at,
    completed_at: row.completed_at || "",
    expires_at: row.expires_at || "",
    current,
  };
};
const safeTargetConfig = (adapter: string, raw: Record<string, any>) => {
  if (adapter !== "systemd") fail(400, "unsupported deployment adapter");
  const unit = text(raw.unit, "config.unit", 128);
  const releaseDirectory = text(raw.release_directory ?? raw.releaseDirectory, "config.release_directory", 1024);
  if (!SYSTEMD_UNIT.test(unit)) fail(400, "invalid systemd unit");
  if (!isAbsolute(releaseDirectory) || releaseDirectory === "/" || normalize(releaseDirectory) !== releaseDirectory
    || releaseDirectory.includes("\\") || releaseDirectory.split("/").includes("..") || /[\s\u0000-\u001f\u007f]/.test(releaseDirectory))
    fail(400, "invalid systemd release directory");
  if (raw.telemetry === undefined) return { unit, release_directory: releaseDirectory };
  try {
    return { unit, release_directory: releaseDirectory, telemetry: validateTelemetryBinding(raw.telemetry) };
  } catch {
    fail(400, "invalid config.telemetry");
  }
};

/** Register service inventory and approval-ready delivery plan APIs. */
export function registerServiceDeployments(
  deps: Dependencies,
  options: { jobs?: AgentJobStore; artifacts?: ReleaseArtifactStore } = {},
): Module & ServiceDeploymentStore {
  const { db, router } = deps;
  createAgentLifecycleSchema(db);
  // Parsing a maximum-size bundle is synchronous and temporarily retains the
  // compressed archive, expanded tar, and copied entries. Admit one complete
  // upload/validation at a time per center process; do not build an unbounded
  // queue while the event loop is busy.
  let artifactWork: "upload" | "maintenance" | undefined;
  let telemetryWork = false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS services(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      repository_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS service_targets(
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,
      adapter TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      desired_release_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(service_id,machine_id)
    );
    CREATE INDEX IF NOT EXISTS service_targets_service ON service_targets(service_id,updated_at);
    CREATE INDEX IF NOT EXISTS service_targets_machine ON service_targets(machine_id,updated_at);
    CREATE TABLE IF NOT EXISTS service_target_preflights(
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES service_targets(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL DEFAULT '',
      target_revision TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS service_target_preflights_latest ON service_target_preflights(target_id,created_at);
    CREATE TABLE IF NOT EXISTS releases(
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      artifact_digest TEXT NOT NULL DEFAULT '',
      artifact_size INTEGER NOT NULL DEFAULT 0,
      artifact_format TEXT NOT NULL DEFAULT '',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      UNIQUE(service_id,version)
    );
    CREATE INDEX IF NOT EXISTS releases_service ON releases(service_id,created_at);
    CREATE TABLE IF NOT EXISTS deployments(
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES service_targets(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
      adapter TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_json TEXT NOT NULL DEFAULT '{}',
      previous_json TEXT NOT NULL DEFAULT '{}',
      target_snapshot_json TEXT NOT NULL DEFAULT '{}',
      receipt_json TEXT NOT NULL DEFAULT '{}',
      telemetry_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      phase TEXT NOT NULL DEFAULT 'awaiting_approval',
      operation_id TEXT NOT NULL DEFAULT '',
      operation_kind TEXT NOT NULL DEFAULT 'deploy',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      approved_at TEXT NOT NULL DEFAULT '',
      approved_by TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS deployments_service ON deployments(service_id,created_at);
    CREATE INDEX IF NOT EXISTS deployments_target ON deployments(target_id,created_at);
    CREATE TABLE IF NOT EXISTS deployment_events(
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      state TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deployment_events_deployment ON deployment_events(deployment_id,created_at,id);
  `);

  const releaseColumns = new Set(db.all<{ name: string }>("PRAGMA table_info(releases)").map((column) => column.name));
  if (!releaseColumns.has("artifact_size")) db.exec("ALTER TABLE releases ADD COLUMN artifact_size INTEGER NOT NULL DEFAULT 0");
  if (!releaseColumns.has("artifact_format")) db.exec("ALTER TABLE releases ADD COLUMN artifact_format TEXT NOT NULL DEFAULT ''");

  // Existing installations created before the approval slice need the new
  // metadata columns without a destructive migration. SQLite permits adding
  // these NOT NULL columns because every one has a constant default.
  const columns = new Set(db.all<{ name: string }>("PRAGMA table_info(deployments)").map((column) => column.name));
  for (const [name, definition] of [
    ["previous_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["target_snapshot_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["error_code", "TEXT NOT NULL DEFAULT ''"],
    ["phase", "TEXT NOT NULL DEFAULT 'awaiting_approval'"],
    ["operation_id", "TEXT NOT NULL DEFAULT ''"],
    ["operation_kind", "TEXT NOT NULL DEFAULT 'deploy'"],
    ["approved_by", "TEXT NOT NULL DEFAULT ''"],
    ["telemetry_json", "TEXT NOT NULL DEFAULT '{}'"],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE deployments ADD COLUMN ${name} ${definition}`);
  }
  // The default is useful for new plans, but an older completed row must not
  // be reported as if it were still awaiting approval after migration.
  db.run("UPDATE deployments SET phase=status WHERE phase='awaiting_approval' AND status<>'awaiting_approval'");

  const ensureService = (serviceID: string) => {
    if (!SERVICE_ID.test(serviceID)) fail(400, "invalid service_id");
    const row = db.get<any>("SELECT * FROM services WHERE id=?", serviceID);
    if (!row) fail(404, "服务不存在");
    return row;
  };
  const ensureMachine = (machineID: string) => {
    if (typeof machineID !== "string" || !machineID.trim()) fail(400, "invalid machine_id");
    const row = db.get<any>("SELECT id,name,address,port,username,agent_id FROM managed_machines WHERE id=?", machineID);
    if (!row) fail(404, "主机不存在");
    return row;
  };
  const ensureTarget = (serviceID: string, targetID: string) => {
    ensureService(serviceID);
    const row = db.get<any>(
      `SELECT t.*,m.name AS machine_name FROM service_targets t JOIN managed_machines m ON m.id=t.machine_id WHERE t.id=? AND t.service_id=?`,
      targetID,
      serviceID,
    );
    if (!row) fail(404, "服务目标不存在");
    return row;
  };
  const ensureRelease = (serviceID: string, releaseID: string) => {
    ensureService(serviceID);
    const row = db.get<any>("SELECT * FROM releases WHERE id=? AND service_id=?", releaseID, serviceID);
    if (!row) fail(404, "服务版本不存在");
    if (!new Set(["pending_artifact", "ready"]).has(row.status)) fail(409, "服务版本未就绪");
    return row;
  };
  const service = (idValue: string) => serviceView(ensureService(idValue));
  const targets = (serviceID: string) => {
    ensureService(serviceID);
    return db.all<any>(
      `SELECT t.*,m.name AS machine_name FROM service_targets t JOIN managed_machines m ON m.id=t.machine_id WHERE t.service_id=? ORDER BY t.updated_at DESC,t.id`,
      serviceID,
    ).map((row) => ({ ...targetView(row), preflight: latestPreflight(serviceID, String(row.id)).view ?? null }));
  };
  const releases = (serviceID: string) => {
    ensureService(serviceID);
    return db.all<any>("SELECT * FROM releases WHERE service_id=? ORDER BY created_at DESC,id", serviceID).map(releaseView);
  };
  const deployments = (serviceID: string) => {
    ensureService(serviceID);
    return db.all<any>("SELECT * FROM deployments WHERE service_id=? ORDER BY created_at DESC LIMIT 100", serviceID).map(deploymentView);
  };
  const eventView = (row: any) => ({
    id: row.id,
    deployment_id: row.deployment_id,
    phase: row.phase,
    state: row.state,
    code: row.code || "",
    summary: row.summary,
    actor: row.actor || "",
    created_at: row.created_at,
  });
  const events = (deploymentID: string) =>
    // `created_at` has second/millisecond precision supplied by the clock and
    // can legitimately be identical for two transitions. SQLite's insertion
    // rowid preserves the durable append order in that case.
    db.all<any>("SELECT * FROM deployment_events WHERE deployment_id=? ORDER BY created_at,rowid", deploymentID).map(eventView);
  const deploymentRow = (deploymentID: string) => {
    const value = db.get<any>("SELECT * FROM deployments WHERE id=?", deploymentID);
    if (!value) fail(404, "部署记录不存在");
    return value;
  };
  const deploymentState = (value: any): DeploymentStatus => {
    const state = value.status as DeploymentStatus;
    if (!(state in DEPLOYMENT_TRANSITIONS)) fail(500, "部署记录状态无效");
    return state;
  };
  const appendEvent = (deploymentID: string, phase: string, state: string, actor: string, summary: string, code = "") => {
    db.run(
      "INSERT INTO deployment_events(id,deployment_id,phase,state,code,summary,actor,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id(), deploymentID, phase, state, code, summary.slice(0, 1000), actor, nowISO(deps),
    );
  };
  const transitionInTransaction = (deploymentID: string, next: DeploymentStatus, actor: string, summary: string, code = "", options: { operationID?: string; operationKind?: "deploy" | "rollback"; approvedBy?: string; finished?: boolean; receipt?: Record<string, unknown> } = {}) => {
    const current = deploymentRow(deploymentID), from = deploymentState(current);
    if (!canTransitionDeployment(from, next)) fail(409, `部署状态不能从 ${from} 变更为 ${next}`);
    const operationID = options.operationID ?? current.operation_id ?? "";
    const at = nowISO(deps);
    const set = ["status=?", "phase=?", "error_code=?", "error=?", "operation_id=?", "operation_kind=?"];
    const params: any[] = [next, next, code, code ? summary : "", operationID, options.operationKind ?? current.operation_kind ?? "deploy"];
    if (options.approvedBy !== undefined) {
      set.push("approved_by=?", "approved_at=?");
      params.push(options.approvedBy, at);
    }
    if (options.receipt !== undefined) {
      set.push("receipt_json=?");
      params.push(JSON.stringify(options.receipt));
    }
    if (next !== "awaiting_approval" && next !== "agent_ready" && !current.started_at && ["staging", "activating", "verifying", "succeeded", "failed", "rollback_pending", "rolling_back", "rolled_back"].includes(next)) {
      set.push("started_at=?");
      params.push(at);
    }
    if (options.finished || ["succeeded", "failed", "rolled_back", "cancelled"].includes(next)) {
      set.push("finished_at=?");
      params.push(at);
    }
    params.push(deploymentID, from);
    const updated = db.run(`UPDATE deployments SET ${set.join(",")} WHERE id=? AND status=?`, ...params);
    if (updated.changes !== 1) fail(409, "部署状态已被其他操作更新");
    appendEvent(deploymentID, next, next, actor, summary, code);
    return deploymentView(deploymentRow(deploymentID));
  };
  const transition = (deploymentID: string, next: DeploymentStatus, actor: string, summary: string, code = "", options: { operationID?: string; operationKind?: "deploy" | "rollback"; approvedBy?: string; finished?: boolean; receipt?: Record<string, unknown> } = {}) =>
    db.transaction(() => transitionInTransaction(deploymentID, next, actor, summary, code, options));
  const machineAgentReady = (machineID: string) => {
    const machine = ensureMachine(machineID);
    if (!machine.agent_id) return false;
    if (isAgentRemoved(db, machine.agent_id)) return false;
    // Test fixtures and older databases may not have the agents table yet;
    // an explicit machine binding is sufficient in that compatibility mode.
    const hasAgents = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'");
    if (!hasAgents) return true;
    const agent = db.get<any>("SELECT id,last_seen FROM agents WHERE id=?", machine.agent_id);
    if (!agent) return false;
    const seen = Date.parse(agent.last_seen || "");
    const age = deps.now().getTime() - seen;
    return Number.isFinite(seen) && age >= 0 && age < 180_000;
  };
  const currentTarget = (serviceID: string, targetID: string) => {
    const target = ensureTarget(serviceID, targetID);
    const machine = ensureMachine(String(target.machine_id));
    const rawConfig = parse<Record<string, any>>(target.config_json, {});
    const config = {
      unit: typeof rawConfig.unit === "string" ? rawConfig.unit : "",
      release_directory: typeof rawConfig.release_directory === "string" ? rawConfig.release_directory : typeof rawConfig.releaseDirectory === "string" ? rawConfig.releaseDirectory : "",
      // Preserve revisions for old unbound targets; a new binding is part of
      // the reviewed configuration and invalidates earlier plans/preflights.
      ...(rawConfig.telemetry === undefined ? {} : { telemetry: rawConfig.telemetry }),
    };
    const revision = createHash("sha256").update(JSON.stringify({
      target_id: target.id, service_id: target.service_id, machine_id: target.machine_id,
      adapter: target.adapter, status: target.status, updated_at: target.updated_at, config, agent_id: machine.agent_id, address: machine.address,
      port: machine.port, username: machine.username,
    })).digest("hex");
    return { target, machine, config, revision };
  };
  const telemetryContext = (deployment: any) => {
    if (deployment.status !== "succeeded" || deployment.operation_kind !== "deploy"
      || !deployment.operation_id || !deployment.approved_at || !Number.isFinite(Date.parse(deployment.finished_at)))
      fail(409, "deployment_telemetry_not_ready");
    const receipt = parse<any>(deployment.receipt_json, {});
    if (!options.jobs || receipt.state !== "succeeded" || !receipt.job_id)
      fail(409, "deployment_health_unverified");
    const job = db.get<any>("SELECT rowid AS approval_order,* FROM agent_jobs WHERE id=? AND deployment_id=? AND operation_id=?", receipt.job_id, deployment.id, deployment.operation_id);
    if (!job || job.state !== "succeeded" || parse<any>(job.receipt_json, {}).snapshot?.health?.healthy !== true)
      fail(409, "deployment_health_unverified");
    const plan = parse<any>(deployment.plan_json, {});
    const snapshot = parse<any>(deployment.target_snapshot_json, {});
    const current = currentTarget(deployment.service_id, deployment.target_id);
    if (current.target.status === "disabled" || plan.target_revision !== current.revision
      || snapshot.id !== current.target.id || snapshot.service_id !== deployment.service_id
      || snapshot.machine_id !== current.target.machine_id || snapshot.adapter !== current.target.adapter
      || JSON.stringify(snapshot.config) !== JSON.stringify(parse(current.target.config_json, {})))
      fail(409, "deployment_target_changed");
    // Job rowid is the durable approval order, even when two approvals share
    // a clock timestamp or plans were created in the opposite order. Merely
    // drafting another deployment does not supersede a successful release.
    if (db.get("SELECT 1 FROM agent_jobs j JOIN deployments d ON d.id=j.deployment_id WHERE d.target_id=? AND j.rowid>? AND d.id<>? LIMIT 1", deployment.target_id, job.approval_order, deployment.id))
      fail(409, "deployment_superseded");
    const release = db.get<any>("SELECT * FROM releases WHERE id=? AND service_id=?", deployment.release_id, deployment.service_id);
    if (!release || release.status !== "ready" || !RELEASE_VERSION.test(release.version)
      || plan.release_id !== release.id || plan.release?.version !== release.version)
      fail(409, "deployment_release_changed");
    const guard = createHash("sha256").update(JSON.stringify({
      id: deployment.id, status: deployment.status, operation: deployment.operation_id, kind: deployment.operation_kind,
      finished: deployment.finished_at, approved: deployment.approved_at, plan: deployment.plan_json,
      snapshot: deployment.target_snapshot_json, receipt: deployment.receipt_json, revision: current.revision,
      release: { id: release.id, version: release.version, status: release.status, digest: release.artifact_digest, manifest: release.manifest_json },
      job: { id: job.id, receipt: job.receipt_json },
    })).digest("hex");
    return { guard, release, binding: snapshot.config?.telemetry };
  };
  const deploymentView = (row: any) => {
    const stored = parse<any>(row.telemetry_json, {});
    let telemetry = null;
    if (stored.result && typeof stored.guard === "string") {
      let stale = true;
      try { stale = telemetryContext(row).guard !== stored.guard; } catch { /* Historical evidence stays visibly stale. */ }
      telemetry = { ...stored.result, stale };
    }
    return { ...baseDeploymentView(row), telemetry };
  };
  const latestPreflight = (serviceID: string, targetID: string) => {
    const current = currentTarget(serviceID, targetID);
    const result = db.get<any>("SELECT * FROM service_target_preflights WHERE target_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", targetID);
    if (!result) return { current, result: undefined, view: undefined };
    const fresh = result.status === "completed" && result.target_revision === current.revision
      && Date.parse(result.expires_at || "") > deps.now().getTime();
    return { current, result, view: preflightView(result, fresh) };
  };
  const validatePreflightSnapshot = (snapshot: unknown, expected: { id: string; target_revision: string; created_at: string }) => {
    const value = (snapshot as any)?.preflight;
    if (!value || value.provider !== "systemd" || typeof value.ready !== "boolean"
      || typeof value.systemd_available !== "boolean" || typeof value.unit_exists !== "boolean"
      || typeof value.entrypoint_matches !== "boolean" || typeof value.current_pointer_valid !== "boolean"
      || typeof value.filesystem_check_supported !== "boolean"
      || typeof value.release_directory_exists !== "boolean" || typeof value.release_directory_writable !== "boolean"
      || !(value.enabled === true || value.enabled === false || value.enabled === "unknown")
      || !["enabled", "enabled-runtime", "disabled", "static", "indirect", "masked", "masked-runtime", "linked", "linked-runtime", "alias", "generated", "transient", "unknown"].includes(value.unit_file_state)
      || !["active", "reloading", "inactive", "failed", "activating", "deactivating", "maintenance", "refreshing", "unknown"].includes(value.active_state)
      || typeof value.current_version !== "string" || (value.current_version !== "" && !RELEASE_VERSION.test(value.current_version))
      || value.preflight_id !== expected.id || value.target_revision !== expected.target_revision
      || typeof value.observed_at !== "string" || !Number.isFinite(Date.parse(value.observed_at))) return undefined;
    const observedAt = Date.parse(value.observed_at), createdAt = Date.parse(expected.created_at), receivedAt = deps.now().getTime();
    if (observedAt < createdAt - 60_000 || observedAt > receivedAt + 60_000) return undefined;
    const ready = value.filesystem_check_supported && value.systemd_available && value.unit_exists && ["active", "inactive"].includes(value.active_state)
      && !["masked", "masked-runtime"].includes(value.unit_file_state)
      && value.release_directory_exists && value.release_directory_writable
      && value.entrypoint_matches && value.current_pointer_valid;
    if (value.ready !== ready) return undefined;
    return {
      provider: "systemd", ready, systemd_available: value.systemd_available,
      unit_exists: value.unit_exists, active_state: value.active_state, enabled: value.enabled, unit_file_state: value.unit_file_state,
      entrypoint_matches: value.entrypoint_matches, current_pointer_valid: value.current_pointer_valid,
      release_directory_exists: value.release_directory_exists,
      filesystem_check_supported: value.filesystem_check_supported, release_directory_writable: value.release_directory_writable,
      current_version: value.current_version, observed_at: new Date(value.observed_at).toISOString(),
    };
  };
  options.jobs?.onUpdate((update) => {
    if (!update.deploymentID || !update.operationID) return;
    const preflight = db.get<any>("SELECT * FROM service_target_preflights WHERE operation_id=?", update.operationID);
    if (preflight && update.deploymentID === `preflight:${preflight.id}`) {
      if (preflight.agent_id !== update.agentID || (preflight.job_id && preflight.job_id !== update.jobID)) return;
      const at = nowISO(deps);
      if (update.phase === "accepted") {
        db.run("UPDATE service_target_preflights SET status='running',job_id=? WHERE id=? AND status='queued'", update.jobID, preflight.id);
      } else if (update.phase === "succeeded") {
        const snapshot = validatePreflightSnapshot(update.snapshot, preflight);
        if (!snapshot) {
          db.run("UPDATE service_target_preflights SET status='failed',error_code='invalid_preflight_result',completed_at=? WHERE id=?", at, preflight.id);
        } else {
          const expiresAt = new Date(Date.parse(snapshot.observed_at) + PREFLIGHT_TTL_MS).toISOString();
          db.run("UPDATE service_target_preflights SET status='completed',snapshot_json=?,error_code=?,completed_at=?,expires_at=? WHERE id=?", JSON.stringify({ preflight: snapshot }), snapshot.ready ? "" : "prerequisites_missing", at, expiresAt, preflight.id);
        }
      } else if (update.phase === "failed" || update.phase === "unknown") {
        const code = /^[a-z][a-z0-9_.-]{0,63}$/.test(update.code) ? update.code : "preflight_failed";
        db.run("UPDATE service_target_preflights SET status=?,error_code=?,completed_at=? WHERE id=?", update.phase, code, at, preflight.id);
      } else if (update.phase === "cancelled") {
        db.run("UPDATE service_target_preflights SET status=?,error_code=?,completed_at=? WHERE id=?", update.previousState === "queued" ? "expired" : "unknown", update.code || "job_cancelled", at, preflight.id);
      }
      return;
    }
    const deployment = db.get<any>(
      "SELECT * FROM deployments WHERE id=? AND operation_id=?",
      update.deploymentID,
      update.operationID,
    );
    if (!deployment) return;
    const state = deploymentState(deployment);
    const isRollback = deployment.operation_kind === "rollback";
    const actor = "agent:" + update.agentID;
    const code = /^[a-z][a-z0-9_.-]{0,63}$/.test(update.code) ? update.code : "agent_error";
    const receipt = (phase: string, receiptCode: string, summary: string) => ({
      job_id: update.jobID, state: phase, code: receiptCode, summary, updated_at: nowISO(deps),
    });
    const appendObserved = (phase: string, summary: string, observedCode = "") => {
      db.run(
        "UPDATE deployments SET receipt_json=? WHERE id=? AND operation_id=?",
        JSON.stringify(receipt(phase, observedCode, summary)),
        update.deploymentID,
        update.operationID,
      );
      appendEvent(update.deploymentID, phase, state, actor, summary, observedCode);
    };
    if (update.code === "legacy_agent_write_removed") {
      const previous = JSON.parse(deployment.receipt_json || "{}");
      if (previous.job_id === update.jobID && previous.code === update.code && previous.state === update.phase) return;
      const phase = update.phase === "cancelled" ? "cancelled" : "unknown";
      const summary = phase === "cancelled" ? "旧普通 Agent 写任务未领取，已取消" : "旧普通 Agent 写任务执行结果未知，需人工核对主机";
      db.run("UPDATE deployments SET status=?,phase=?,error_code=?,error=?,receipt_json=? WHERE id=? AND operation_id=?",
        phase === "cancelled" && ["agent_ready", "rollback_pending"].includes(state) ? "cancelled" : state,
        phase, update.code, summary, JSON.stringify(receipt(phase, update.code, summary)), deployment.id, update.operationID);
      appendEvent(deployment.id, phase, phase === "cancelled" ? "cancelled" : state, actor, summary, update.code);
      return;
    }
    if (update.phase === "accepted") {
      appendObserved("accepted", "LightMoni Agent 已接收部署任务");
      return;
    }
    if (update.phase === "unknown") {
      const unknownCode = update.code === "invalid_agent_sequence" ? "invalid_agent_sequence" : "unknown_execution_result";
      const unknownSummary = isRollback
        ? "回滚执行结果未知，需检查主机并重新预检；系统不会自动重试"
        : update.code === "invalid_agent_sequence" ? "Agent 成功回执缺少有效健康检查证据，需重新检查目标主机" : "Agent 执行结果未知，需要重新检查目标主机";
      if (isRollback && (state === "rollback_pending" || state === "rolling_back")) {
        // End the operation as requiring operator review. A later explicit
        // rollback request is accepted only after a newer safe preflight and
        // only if the deployed version is still current.
        transitionInTransaction(update.deploymentID, "failed", actor, unknownSummary, unknownCode, {
          finished: true,
          receipt: receipt("unknown", unknownCode, unknownSummary),
        });
      } else {
        appendObserved("unknown", unknownSummary, unknownCode);
      }
      return;
    }
    if (update.phase === "cancelled") {
      if (state === "agent_ready" && update.previousState === "queued") {
        const code = update.code === "job_expired" ? "job_expired" : "cancelled";
        const summary = update.code === "job_expired" ? "Agent 未领取任务，任务已过期，部署已取消" : "Agent 在领取任务前取消部署任务";
        transitionInTransaction(update.deploymentID, "cancelled", actor, summary, code, {
          receipt: receipt("cancelled", code, summary),
        });
      } else if (isRollback && state === "rollback_pending" && update.previousState === "queued") {
        const summary = "Agent 未领取回滚任务，回滚未执行；重新预检后可由管理员重新请求";
        transitionInTransaction(update.deploymentID, "failed", actor, summary, "rollback_job_not_executed", {
          finished: true,
          receipt: receipt("failed", "rollback_job_not_executed", summary),
        });
      } else {
        appendObserved("unknown", "任务已被领取或执行期间取消，实际主机状态需要重新检查", "unknown_execution_result");
      }
      return;
    }
    if (isRollback) {
      if (update.phase === "activating") {
        if (state === "rollback_pending") {
          transitionInTransaction(update.deploymentID, "rolling_back", actor, "Agent 开始恢复已登记的 previous release", "", {
            receipt: receipt("activating", "", "Agent 开始恢复 previous release"),
          });
        } else if (state === "rolling_back") {
          appendObserved("activating", "Agent 正在切换回 previous release");
        }
        return;
      }
      if (update.phase === "verifying") {
        if (state === "rolling_back") appendObserved("verifying", "Agent 正在验证恢复版本健康");
        return;
      }
      if (update.phase === "succeeded") {
        const plan = parse<any>(deployment.plan_json, {});
        const previousVersion = String(plan.rollback?.previous_version || "");
        if (state === "rolling_back" && update.healthVerified === true && update.snapshot?.current_version === previousVersion) {
          const summary = `Agent 已恢复 ${previousVersion} 并回报 systemd 健康检查通过`;
          transitionInTransaction(update.deploymentID, "rolled_back", actor, summary, "", {
            finished: true,
            receipt: receipt("rolled_back", "", summary),
          });
        } else {
          const summary = "回滚回执未能同时证明 previous version 与健康状态；需检查主机并重新预检后再决定是否重试";
          transitionInTransaction(update.deploymentID, "failed", actor, summary, "invalid_rollback_receipt", {
            finished: true,
            receipt: receipt("unknown", "invalid_rollback_receipt", summary),
          });
        }
        return;
      }
      if (update.phase === "failed") {
        if (state === "rollback_pending" || state === "rolling_back") {
          const summary = "Agent 回滚任务失败，需检查目标主机后再决定是否重试";
          transitionInTransaction(update.deploymentID, "failed", actor, summary, code || "rollback_failed", {
            finished: true,
            receipt: receipt("failed", code || "rollback_failed", summary),
          });
        }
        return;
      }
      return;
    }
    let next: DeploymentStatus | undefined;
    let summary = "";
    let nextCode = "";
    switch (update.phase) {
      case "staging":
        next = "staging";
        summary = "Agent 开始暂存部署制品";
        break;
      case "activating":
        next = "activating";
        summary = "Agent 开始切换服务版本";
        break;
      case "verifying":
        next = "verifying";
        summary = "Agent 正在执行部署健康检查";
        break;
      case "succeeded":
        if (state === "verifying" && update.healthVerified === true) {
          next = "succeeded";
          summary = "Agent 已完成部署动作并回报健康检查通过";
        } else {
          appendObserved("unknown", "Agent 成功回执缺少有效健康检查证据，需重新检查目标主机", "invalid_agent_sequence");
          return;
        }
        break;
      case "failed":
        next = "failed";
        nextCode = code || "agent_execution_failed";
        summary = "Agent 执行部署任务失败";
        break;
      default:
        return;
    }
    if (!canTransitionDeployment(state, next)) {
      appendObserved(update.phase, "忽略与当前部署状态不匹配的 Agent 回执", "invalid_agent_sequence");
      return;
    }
    transitionInTransaction(update.deploymentID, next, actor, summary, nextCode, {
      finished: next === "succeeded" || next === "failed",
      receipt: receipt(update.phase, nextCode || code, summary),
    });
  });
  const body = async (ctx: Context) => record(await ctx.body());

  const createPlan = (serviceID: string, targetID: string, releaseID: string, actorID: string) => {
    const target = ensureTarget(serviceID, targetID);
    const release = ensureRelease(serviceID, releaseID);
    if (!ADAPTERS.has(target.adapter)) fail(400, "unsupported deployment provider");
    if (target.status === "disabled") fail(409, "服务目标已禁用");
    const machine = ensureMachine(target.machine_id), at = nowISO(deps), deploymentID = id();
    const preflight = latestPreflight(serviceID, targetID);
    const observed = preflight.view?.snapshot?.preflight;
    const previousVersion = typeof observed?.current_version === "string" ? observed.current_version : "";
    const previousRelease = previousVersion
      ? db.get<any>("SELECT id,version,status FROM releases WHERE service_id=? AND version=?", serviceID, previousVersion)
      : undefined;
    // Metadata/preflight can be reviewed, but the former ordinary-Agent apply
    // actions are no longer an executable deployment profile.
    const plan = {
      version: "service-deployment/v1",
      adapter: target.adapter,
      provider_plan_status: "blocked",
      provider_plan_reason: "privileged_profile_not_implemented",
      service_id: serviceID,
      target_id: target.id,
      target_revision: preflight.current.revision,
      preflight_id: preflight.view?.id ?? "",
      preflight: preflight.view,
      release_id: release.id,
      machine: { id: machine.id, name: machine.name, address: machine.address, port: machine.port, username: machine.username },
      release: { version: release.version, source_type: release.source_type, source_ref: release.source_ref, artifact_digest: release.artifact_digest, artifact_size: Number(release.artifact_size || 0), artifact_format: release.artifact_format || "" },
      actions: [],
      capabilities: [],
      rollback: {
        available: false,
        reason: "privileged_profile_not_implemented",
        previous_version: previousVersion,
        previous_release_id: previousRelease?.status === "ready" ? String(previousRelease.id) : "",
        actions: [],
        capabilities: [],
      },
      steps: ["登记服务、制品与部署目标", "执行只读 systemd 预检", "部署执行需等待新的受管提权 profile"],
      safety: ["当前计划仅供查看，不授权主机写入", "普通 Agent 仅执行固定只读任务"],
    };
    const previous = {
      desired_release_id: target.desired_release_id || "",
      version: previousVersion,
      release_id: previousRelease?.status === "ready" ? String(previousRelease.id) : "",
      active_state: observed?.active_state ?? "unknown",
    };
    const targetSnapshot = {
      id: target.id,
      service_id: target.service_id,
      machine_id: target.machine_id,
      machine_name: machine.name,
      adapter: target.adapter,
      config: parse(target.config_json, {}),
      desired_release_id: target.desired_release_id || "",
      status: target.status,
    };
    db.transaction(() => {
      db.run("INSERT INTO deployments(id,service_id,target_id,release_id,adapter,status,plan_json,previous_json,target_snapshot_json,phase,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", deploymentID, serviceID, target.id, release.id, target.adapter, "awaiting_approval", JSON.stringify(plan), JSON.stringify(previous), JSON.stringify(targetSnapshot), "awaiting_approval", at, actorID);
      appendEvent(deploymentID, "awaiting_approval", "awaiting_approval", actorID, "部署计划已生成");
    });
    return { id: deploymentID, service_id: serviceID, target_id: target.id, release_id: release.id, adapter: target.adapter, status: "awaiting_approval", state: "awaiting_approval", plan, review_url: `/services?service=${encodeURIComponent(serviceID)}&deployment=${encodeURIComponent(deploymentID)}` };
  };

  router.get("/api/v1/services", safe(deps, (ctx) => {
    admin(deps, ctx);
    ctx.json(db.all<any>("SELECT * FROM services ORDER BY updated_at DESC,id").map(serviceView));
  }));
  router.post("/api/v1/services", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const input = await body(ctx);
    const name = text(input.name, "name", 128);
    const description = text(input.description ?? "", "description", 4000, false);
    const repositoryURL = text(input.repository_url ?? "", "repository_url", 2048, false);
    if (/[\u0000-\u001f\u007f]/.test(name)) fail(400, "invalid name");
    const at = nowISO(deps), serviceID = id();
    db.run("INSERT INTO services(id,name,description,repository_url,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)", serviceID, name, description, repositoryURL, at, at, ctx.user.id);
    ctx.json(service(serviceID), 201);
  }));
  router.get("/api/v1/services/:id", safe(deps, (ctx) => {
    admin(deps, ctx);
    const serviceID = ctx.params.id;
    ctx.json({ service: service(serviceID), targets: targets(serviceID), releases: releases(serviceID), deployments: deployments(serviceID) });
  }));

  router.get("/api/v1/services/:id/targets", safe(deps, (ctx) => { admin(deps, ctx); ctx.json(targets(ctx.params.id)); }));
  router.post("/api/v1/services/:id/targets", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const serviceID = ctx.params.id, input = await body(ctx);
    ensureService(serviceID);
    const machine = ensureMachine(text(input.machine_id, "machine_id", 128));
    const adapter = text(input.adapter ?? "systemd", "adapter", 32) as ServiceAdapter;
    if (!ADAPTERS.has(adapter)) fail(400, "unsupported deployment adapter");
    const config = safeTargetConfig(adapter, jsonObject(input.config, "config"));
    const at = nowISO(deps), targetID = id();
    db.run("INSERT INTO service_targets(id,service_id,machine_id,adapter,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", targetID, serviceID, machine.id, adapter, JSON.stringify(config), at, at);
    ctx.json({ ...targetView(db.get<any>("SELECT t.*,m.name AS machine_name FROM service_targets t JOIN managed_machines m ON m.id=t.machine_id WHERE t.id=?", targetID)!), preflight: null }, 201);
  }));
  router.patch("/api/v1/services/:id/targets/:targetId", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const current = ensureTarget(ctx.params.id, ctx.params.targetId), input = await body(ctx);
    const adapter = text(input.adapter ?? current.adapter, "adapter", 32) as ServiceAdapter;
    if (!ADAPTERS.has(adapter)) fail(400, "unsupported deployment adapter");
    const config = safeTargetConfig(adapter, jsonObject(input.config ?? parse(current.config_json, {}), "config")), status = text(input.status ?? current.status, "status", 32);
    if (!["unknown", "ready", "degraded", "disabled"].includes(status)) fail(400, "invalid target status");
    const at = nowISO(deps);
    db.run("UPDATE service_targets SET adapter=?,config_json=?,status=?,updated_at=? WHERE id=? AND service_id=?", adapter, JSON.stringify(config), status, at, current.id, current.service_id);
    ctx.json({ ...targetView(db.get<any>("SELECT t.*,m.name AS machine_name FROM service_targets t JOIN managed_machines m ON m.id=t.machine_id WHERE t.id=?", current.id)!), preflight: null });
  }));

  router.get("/api/v1/services/:id/targets/:targetId/preflight", safe(deps, (ctx) => {
    admin(deps, ctx);
    const latest = latestPreflight(ctx.params.id, ctx.params.targetId);
    ctx.json(latest.view ?? null);
  }));
  router.post("/api/v1/services/:id/targets/:targetId/preflight", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const input = await body(ctx);
    if (Object.keys(input).some((key) => key !== "confirm") || input.confirm !== true) fail(400, "必须明确确认执行只读主机预检");
    const latest = latestPreflight(ctx.params.id, ctx.params.targetId), { target, machine, config, revision } = latest.current;
    if (target.status === "disabled") fail(409, "服务目标已禁用");
    if (!machine.agent_id || !machineAgentReady(String(target.machine_id))) fail(409, "agent_not_ready");
    if (!options.jobs) fail(503, "agent_jobs_unavailable");
    if (latest.result && latest.result.target_revision === revision && ["queued", "running"].includes(latest.result.status)) {
      ctx.json(latest.view);
      return;
    }
    const preflightID = id(), operationID = id(), at = nowISO(deps);
    const response = db.transaction(() => {
      db.run("INSERT INTO service_target_preflights(id,target_id,agent_id,operation_id,target_revision,status,created_at) VALUES(?,?,?,?,?,'queued',?)", preflightID, target.id, machine.agent_id, operationID, revision, at);
      const job = options.jobs!.enqueue({
        agentID: String(machine.agent_id), deploymentID: `preflight:${preflightID}`, operationID,
        actions: [{ kind: "systemd_probe", unit: config.unit, releaseDirectory: config.release_directory, preflightID, targetRevision: revision }],
        capabilities: ["systemd.probe"],
        target: { config: { unit: config.unit, release_directory: config.release_directory } },
        expiresInSeconds: 10 * 60,
      });
      db.run("UPDATE service_target_preflights SET job_id=? WHERE id=?", String(job.id), preflightID);
      return preflightView(db.get<any>("SELECT * FROM service_target_preflights WHERE id=?", preflightID)!, false);
    });
    ctx.json(response, 202);
  }));

  router.get("/api/v1/services/:id/releases", safe(deps, (ctx) => { admin(deps, ctx); ctx.json(releases(ctx.params.id)); }));
  router.post("/api/v1/services/:id/releases", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const serviceID = ctx.params.id, input = await body(ctx);
    ensureService(serviceID);
    const version = text(input.version, "version", 128);
    if (!RELEASE_VERSION.test(version)) fail(400, "invalid version");
    const sourceType = text(input.source_type ?? "artifact", "source_type", 32);
    if (!["artifact", "git", "container"].includes(sourceType)) fail(400, "invalid source_type");
    const sourceRef = text(input.source_ref, "source_ref", 2048);
    const at = nowISO(deps), releaseID = id();
    db.run("INSERT INTO releases(id,service_id,version,source_type,source_ref,artifact_digest,artifact_size,artifact_format,manifest_json,status,created_at,created_by) VALUES(?,?,?,?,?,'',0,'','{}','pending_artifact',?,?)", releaseID, serviceID, version, sourceType, sourceRef, at, ctx.user.id);
    ctx.json(releaseView(db.get<any>("SELECT * FROM releases WHERE id=?", releaseID)!), 201);
  }));
  router.put("/api/v1/services/:id/releases/:releaseId/artifact", safe(deps, async (ctx) => {
    admin(deps, ctx);
    if (!options.artifacts) fail(503, "release artifact storage unavailable");
    const serviceID = ctx.params.id;
    const release = db.get<any>("SELECT * FROM releases WHERE id=? AND service_id=?", ctx.params.releaseId, serviceID);
    if (!release) fail(404, "服务版本不存在");
    if (release.status === "ready") fail(409, "已就绪的服务版本不可替换");
    if (release.status !== "pending_artifact") fail(409, "服务版本状态不允许上传制品");
    const contentType = String(ctx.req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (contentType !== RELEASE_BUNDLE_CONTENT_TYPE) fail(415, "invalid_artifact_content_type");
    const lengthHeader = String(ctx.req.headers["content-length"] ?? "");
    if (!/^\d{1,9}$/.test(lengthHeader)) fail(411, "content_length_required");
    const contentLength = Number(lengthHeader);
    if (contentLength < 1 || contentLength > 64 * 1024 * 1024) fail(413, "artifact_too_large");
    const expectedSha256 = String(ctx.req.headers["x-artifact-sha256"] ?? "").trim();
    if (!SHA256.test(expectedSha256)) fail(400, "invalid_artifact_digest");

    if (artifactWork) {
      // The request body has not been consumed yet. Close this connection
      // after returning a bounded overload response instead of accepting an
      // unmetered body or retaining it in an in-memory wait queue.
      ctx.res.writeHead(503, {
        "cache-control": "no-store",
        "connection": "close",
        "content-type": "application/json; charset=utf-8",
      });
      ctx.res.end('{"error":"artifact_upload_busy"}\n');
      return;
    }
    artifactWork = "upload";
    try {
      let stored;
      try {
        stored = await options.artifacts.put(ctx.req, { contentLength, expectedSha256, signal: ctx.signal });
      } catch (error) {
        if (error instanceof ReleaseArtifactError) {
          const status = error.code === "artifact_too_large" ? 413 : error.code === "artifact_io" ? 500 : error.code === "digest_mismatch" ? 422 : 400;
          fail(status, error.code);
        }
        throw error;
      }
      let bundle;
      try {
        bundle = parseReleaseBundle(await readFile(stored.path));
        assertReleaseBundleHasNoCredentials(bundle);
      } catch {
        fail(422, "invalid_artifact");
      }
      if (bundle.manifest.service_id !== serviceID || bundle.manifest.version !== release.version) {
        fail(422, "artifact_release_mismatch");
      }
      if (release.artifact_digest && (!SHA256.test(release.artifact_digest) || release.artifact_digest.toLowerCase() !== stored.sha256))
        fail(422, "digest_mismatch");
      db.run("UPDATE releases SET artifact_digest=?,artifact_size=?,artifact_format=?,manifest_json=?,status='ready' WHERE id=? AND service_id=? AND status='pending_artifact'", stored.sha256, stored.size, "lightmoni-release-v1.tar.gz", JSON.stringify(bundle.manifest), ctx.params.releaseId, serviceID);
      const updated = db.get<any>("SELECT * FROM releases WHERE id=? AND service_id=?", ctx.params.releaseId, serviceID);
      if (!updated || updated.status !== "ready" || updated.artifact_digest !== stored.sha256) fail(409, "release_changed_during_upload");
      ctx.json({ release_id: updated.id, sha256: stored.sha256, size: stored.size, format: updated.artifact_format, status: "ready" }, 201);
    } finally {
      artifactWork = undefined;
    }
  }));

  router.post("/api/v1/admin/release-artifacts/gc", safe(deps, async (ctx) => {
    admin(deps, ctx);
    if (!options.artifacts) fail(503, "release artifact storage unavailable");
    const input = record(await body(ctx), "artifact collection request");
    if (Object.keys(input).some((key) => key !== "confirm" && key !== "cursor")
      || (Object.hasOwn(input, "confirm") && input.confirm !== true)
      || (Object.hasOwn(input, "cursor") && (typeof input.cursor !== "string" || !/^[a-f0-9-]{36}$/.test(input.cursor))))
      fail(400, "invalid artifact collection request");
    if (artifactWork) fail(503, "artifact_maintenance_busy");
    artifactWork = "maintenance";
    try {
      // Preserve every recorded digest, even for a release that is not ready;
      // a later upload or recovery path must never lose an object by GC.
      const references = new Set(
        db.all<{ artifact_digest: string }>("SELECT DISTINCT artifact_digest FROM releases WHERE artifact_digest!=''")
          .map((row) => String(row.artifact_digest).toLowerCase()),
      );
      const dryRun = input.confirm !== true;
      const retentionHours = 24;
      let collected;
      try {
        collected = await options.artifacts.collectUnreferenced(references, {
          olderThanMs: deps.now().getTime() - retentionHours * 60 * 60 * 1000,
          dryRun,
          cursor: input.cursor,
        });
      } catch (error) {
        if (error instanceof ReleaseArtifactError)
          fail(error.code === "invalid_artifact" ? 400 : 503, error.code === "invalid_artifact" ? "invalid_artifact_collection_cursor" : "artifact_collection_unavailable");
        throw error;
      }
      ctx.json({
        dry_run: dryRun,
        retention_hours: retentionHours,
        scanned_entries: collected.scannedEntries,
        eligible_count: collected.eligibleCount,
        eligible_bytes: collected.eligibleBytes,
        deleted_count: collected.deletedCount,
        deleted_bytes: collected.deletedBytes,
        failed_count: collected.failedCount,
        truncated: collected.truncated,
        ...(collected.cursor ? { cursor: collected.cursor } : {}),
      });
    } finally {
      artifactWork = undefined;
    }
  }));

  router.get("/api/v1/agents/:agentId/jobs/:jobId/artifacts/:releaseId", safe(deps, () => {
    fail(410, "legacy_agent_payload_removed");
  }), { public: true });

  router.get("/api/v1/services/:id/deployments", safe(deps, (ctx) => { admin(deps, ctx); ctx.json(deployments(ctx.params.id)); }));
  router.post("/api/v1/services/:id/deployments/plan", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const serviceID = ctx.params.id, input = await body(ctx);
    ctx.json(createPlan(serviceID, text(input.target_id, "target_id", 128), text(input.release_id, "release_id", 128), ctx.user.id), 201);
  }));
  router.get("/api/v1/services/:id/deployments/:deploymentId", safe(deps, (ctx) => {
    admin(deps, ctx);
    ensureService(ctx.params.id);
    const value = db.get<any>("SELECT * FROM deployments WHERE id=? AND service_id=?", ctx.params.deploymentId, ctx.params.id);
    if (!value) fail(404, "部署记录不存在");
    ctx.json(deploymentView(value));
  }));
  // A stable global lookup is useful to the assistant and to polling clients;
  // the service-scoped endpoint above remains the canonical UI route.
  router.get("/api/v1/deployments/:deploymentId", safe(deps, (ctx) => {
    admin(deps, ctx);
    const value = db.get<any>("SELECT * FROM deployments WHERE id=?", ctx.params.deploymentId);
    if (!value) fail(404, "部署记录不存在");
    ctx.json(deploymentView(value));
  }));
  router.get("/api/v1/deployments/:deploymentId/events", safe(deps, (ctx) => {
    admin(deps, ctx);
    deploymentRow(ctx.params.deploymentId);
    ctx.json(events(ctx.params.deploymentId));
  }));
  router.get("/api/v1/services/:id/deployments/:deploymentId/events", safe(deps, (ctx) => {
    admin(deps, ctx);
    ensureService(ctx.params.id);
    const deployment = deploymentRow(ctx.params.deploymentId);
    if (deployment.service_id !== ctx.params.id) fail(404, "部署记录不存在");
    ctx.json(events(ctx.params.deploymentId));
  }));
  router.post("/api/v1/deployments/:deploymentId/verify-telemetry", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const input = await body(ctx);
    if (Object.keys(input).length !== 0) fail(400, "invalid telemetry verification request");
    if (telemetryWork) fail(503, "telemetry_verification_busy");
    const deployment = deploymentRow(ctx.params.deploymentId);
    const before = telemetryContext(deployment);
    telemetryWork = true;
    try {
      const now = deps.now(), finished = Date.parse(deployment.finished_at);
      const result = before.binding === undefined ? {
        state: "unconfigured", code: "telemetry_unconfigured", serviceId: deployment.service_id, deploymentId: deployment.id,
        selector: null, serviceVersion: before.release.version, observedSamples: 0, minSamples: 1,
        from: new Date(finished).toISOString(), to: new Date(finished + 5 * 60_000).toISOString(),
        deadline: new Date(finished + 6 * 60_000).toISOString(), checkedAt: now.toISOString(),
      } : await queryDeploymentTelemetry({
        reader: deps.reader, cat: deps.cat, serviceId: deployment.service_id, deploymentId: deployment.id,
        binding: before.binding, serviceVersion: before.release.version, finishedAt: deployment.finished_at, now, signal: ctx.signal,
      });
      if (ctx.signal.aborted) fail(409, "telemetry_verification_cancelled");
      const view = db.transaction(() => {
        const current = deploymentRow(deployment.id);
        if (telemetryContext(current).guard !== before.guard) fail(409, "deployment_telemetry_context_changed");
        db.run("UPDATE deployments SET telemetry_json=? WHERE id=?", JSON.stringify({ guard: before.guard, result }), deployment.id);
        appendEvent(deployment.id, "telemetry", current.status, ctx.user.id, "管理员已核验部署完成后的匹配遥测；结果独立于服务健康状态", result.code);
        return deploymentView(deploymentRow(deployment.id));
      });
      ctx.json(view);
    } finally {
      telemetryWork = false;
    }
  }));
  router.post("/api/v1/deployments/:deploymentId/approve", safe(deps, (ctx) => {
    admin(deps, ctx);
    fail(409, "privileged_profile_not_implemented");
  }));

  router.post("/api/v1/deployments/:deploymentId/cancel", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const input = await body(ctx), deployment = deploymentRow(ctx.params.deploymentId);
    if (input.confirm !== true) fail(400, "必须明确确认取消部署");
    const expected = input.expected_state == null ? deployment.status : text(input.expected_state, "expected_state", 32);
    if (deployment.status !== expected) fail(409, "部署计划状态已变化，请重新查看");
    const state = deploymentState(deployment);
    if (state === "awaiting_approval") {
      ctx.json(transition(deployment.id, "cancelled", ctx.user.id, "管理员取消了尚未批准的部署计划", "cancelled"));
      return;
    }
    if (state !== "agent_ready") fail(409, "当前部署阶段不允许安全取消");
    if (!options.jobs) fail(503, "agent_jobs_unavailable");
    // Cancellation is safe only while the immutable job is still queued. The
    // job store checks and updates it atomically; once an Agent has claimed it,
    // we keep the operation visible for host verification instead of claiming
    // that a running process was interrupted.
    options.jobs.cancelQueuedDeployment(deployment.id, String(deployment.operation_id || ""), ctx.user.id);
    ctx.json(deploymentView(deploymentRow(deployment.id)));
  }));
  router.post("/api/v1/deployments/:deploymentId/rollback", safe(deps, (ctx) => {
    admin(deps, ctx);
    fail(409, "privileged_profile_not_implemented");
  }));

  const assistantServices = () => db.all<any>("SELECT * FROM services ORDER BY updated_at DESC,id").map(serviceView);
  const assistantDeployment = (deploymentID: string) => {
    const value = db.get<any>("SELECT * FROM deployments WHERE id=?", deploymentID);
    if (!value) fail(404, "部署记录不存在");
    return deploymentView(value);
  };
  const assistantDeploymentEvents = (deploymentID: string) => {
    deploymentRow(deploymentID);
    return events(deploymentID);
  };
  const assistantPlan = (input: { service_id: string; target_id: string; release_id: string }, actorID: string) =>
    createPlan(input.service_id, input.target_id, input.release_id, actorID);
  return { assistantServices, assistantDeployment, assistantDeploymentEvents, assistantPlan };
}
