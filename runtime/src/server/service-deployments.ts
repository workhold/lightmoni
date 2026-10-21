import { id } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import type { Context, Dependencies, Handler, Module } from "../shared/types.js";
import { deploymentAdapters } from "../deployment/index.js";
import type { AgentJobStore } from "./agent-jobs.js";

/**
 * Service delivery metadata.
 *
 * This module owns the durable service/release/target/deployment records. It
 * deliberately stops at an approval-ready deployment plan; execution belongs
 * to an Agent adapter and is added in a later slice. Keeping the plan and
 * receipt here gives the UI and the assistant one stable contract without
 * allowing an assistant request to run arbitrary commands on a host.
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
  rollback_pending: ["rolling_back", "cancelled"],
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
  manifest: parse(row.manifest_json, {}),
  status: row.status,
  created_at: row.created_at,
  created_by: row.created_by,
});
const deploymentView = (row: any) => ({
  id: row.id,
  service_id: row.service_id,
  target_id: row.target_id,
  release_id: row.release_id,
  adapter: row.adapter,
  status: row.status,
  state: row.status,
  phase: row.phase || row.status,
  operation_id: row.operation_id || "",
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

/** Register service inventory and approval-ready delivery plan APIs. */
export function registerServiceDeployments(
  deps: Dependencies,
  options: { jobs?: AgentJobStore } = {},
): Module & ServiceDeploymentStore {
  const { db, router } = deps;
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
    CREATE TABLE IF NOT EXISTS releases(
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      artifact_digest TEXT NOT NULL DEFAULT '',
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
      error TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      phase TEXT NOT NULL DEFAULT 'awaiting_approval',
      operation_id TEXT NOT NULL DEFAULT '',
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
    ["approved_by", "TEXT NOT NULL DEFAULT ''"],
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
    if (row.status !== "ready") fail(409, "服务版本未就绪");
    return row;
  };
  const service = (idValue: string) => serviceView(ensureService(idValue));
  const targets = (serviceID: string) => {
    ensureService(serviceID);
    return db.all<any>(
      `SELECT t.*,m.name AS machine_name FROM service_targets t JOIN managed_machines m ON m.id=t.machine_id WHERE t.service_id=? ORDER BY t.updated_at DESC,t.id`,
      serviceID,
    ).map(targetView);
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
  const appendEvent = (deploymentID: string, phase: DeploymentStatus, state: DeploymentStatus, actor: string, summary: string, code = "") => {
    db.run(
      "INSERT INTO deployment_events(id,deployment_id,phase,state,code,summary,actor,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id(), deploymentID, phase, state, code, summary.slice(0, 1000), actor, nowISO(deps),
    );
  };
  const transition = (deploymentID: string, next: DeploymentStatus, actor: string, summary: string, code = "", options: { operationID?: string; approvedBy?: string; finished?: boolean } = {}) => {
    const current = deploymentRow(deploymentID), from = deploymentState(current);
    if (!canTransitionDeployment(from, next)) fail(409, `部署状态不能从 ${from} 变更为 ${next}`);
    const operationID = options.operationID ?? current.operation_id ?? "";
    const at = nowISO(deps);
    db.transaction(() => {
      const set = ["status=?", "phase=?", "error_code=?", "error=?", "operation_id=?"];
      const params: any[] = [next, next, code, code ? summary : "", operationID];
      if (options.approvedBy !== undefined) {
        set.push("approved_by=?", "approved_at=?");
        params.push(options.approvedBy, at);
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
    });
    return deploymentView(deploymentRow(deploymentID));
  };
  const machineAgentReady = (machineID: string) => {
    const machine = ensureMachine(machineID);
    if (!machine.agent_id) return false;
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
  const body = async (ctx: Context) => record(await ctx.body());

  const createPlan = (serviceID: string, targetID: string, releaseID: string, actorID: string) => {
    const target = ensureTarget(serviceID, targetID);
    const release = ensureRelease(serviceID, releaseID);
    if (!ADAPTERS.has(target.adapter)) fail(400, "unsupported deployment provider");
    if (target.status === "disabled") fail(409, "服务目标已禁用");
    const machine = ensureMachine(target.machine_id), at = nowISO(deps), deploymentID = id();
    const plan = {
      version: "service-deployment/v1",
      adapter: target.adapter,
      provider_plan_status: "generic",
      provider_plan_reason: "agent_preflight_required",
      service_id: serviceID,
      target_id: target.id,
      release_id: release.id,
      machine: { id: machine.id, name: machine.name, address: machine.address, port: machine.port, username: machine.username },
      release: { version: release.version, source_type: release.source_type, source_ref: release.source_ref, artifact_digest: release.artifact_digest },
      steps: ["校验制品与部署目标", "由 Agent 暂存不可变制品", "切换服务版本", "执行健康检查", "验证 LightMoni 遥测", "失败时回滚到上一版本"],
      safety: ["仅在管理员确认后执行", "Agent 只接受签名任务和能力白名单", "AI 不直接执行生产 Shell 或读取凭据"],
    };
    const previous = target.desired_release_id ? { release_id: target.desired_release_id } : {};
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
    const config = jsonObject(input.config, "config");
    const at = nowISO(deps), targetID = id();
    db.run("INSERT INTO service_targets(id,service_id,machine_id,adapter,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", targetID, serviceID, machine.id, adapter, JSON.stringify(config), at, at);
    ctx.json(targetView(db.get<any>("SELECT t.*,m.name AS machine_name FROM service_targets t JOIN managed_machines m ON m.id=t.machine_id WHERE t.id=?", targetID)!), 201);
  }));
  router.patch("/api/v1/services/:id/targets/:targetId", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const current = ensureTarget(ctx.params.id, ctx.params.targetId), input = await body(ctx);
    const adapter = text(input.adapter ?? current.adapter, "adapter", 32) as ServiceAdapter;
    if (!ADAPTERS.has(adapter)) fail(400, "unsupported deployment adapter");
    const config = jsonObject(input.config ?? parse(current.config_json, {}), "config"), status = text(input.status ?? current.status, "status", 32);
    if (!["unknown", "ready", "degraded", "disabled"].includes(status)) fail(400, "invalid target status");
    const at = nowISO(deps);
    db.run("UPDATE service_targets SET adapter=?,config_json=?,status=?,updated_at=? WHERE id=? AND service_id=?", adapter, JSON.stringify(config), status, at, current.id, current.service_id);
    ctx.json(targetView(db.get<any>("SELECT t.*,m.name AS machine_name FROM service_targets t JOIN managed_machines m ON m.id=t.machine_id WHERE t.id=?", current.id)!));
  }));

  router.get("/api/v1/services/:id/releases", safe(deps, (ctx) => { admin(deps, ctx); ctx.json(releases(ctx.params.id)); }));
  router.post("/api/v1/services/:id/releases", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const serviceID = ctx.params.id, input = await body(ctx);
    ensureService(serviceID);
    const version = text(input.version, "version", 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/.test(version)) fail(400, "invalid version");
    const sourceType = text(input.source_type ?? "artifact", "source_type", 32);
    if (!["artifact", "git", "container"].includes(sourceType)) fail(400, "invalid source_type");
    const sourceRef = text(input.source_ref, "source_ref", 2048);
    const digest = text(input.artifact_digest ?? "", "artifact_digest", 256, false);
    const manifest = jsonObject(input.manifest, "manifest");
    const at = nowISO(deps), releaseID = id();
    db.run("INSERT INTO releases(id,service_id,version,source_type,source_ref,artifact_digest,manifest_json,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)", releaseID, serviceID, version, sourceType, sourceRef, digest, JSON.stringify(manifest), at, ctx.user.id);
    ctx.json(releaseView(db.get<any>("SELECT * FROM releases WHERE id=?", releaseID)!), 201);
  }));

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
  router.post("/api/v1/deployments/:deploymentId/approve", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const input = await body(ctx), deployment = deploymentRow(ctx.params.deploymentId);
    if (input.confirm !== true) fail(400, "必须明确确认部署计划");
    const expected = input.expected_state == null ? "awaiting_approval" : text(input.expected_state, "expected_state", 32);
    if (deployment.status !== expected) fail(409, "部署计划状态已变化，请重新查看");
    // Approval does not start a service. It only authorizes the next Agent
    // phase. The executor/job protocol is intentionally a later SDD slice.
    const target = db.get<any>("SELECT machine_id FROM service_targets WHERE id=?", deployment.target_id);
    if (!target || !machineAgentReady(String(target.machine_id))) {
      fail(409, "agent_not_ready");
    }
    const operationID = deployment.operation_id || id();
    // Enqueue the immutable job before advancing the centre state. If job
    // persistence fails, approval remains awaiting_approval and can be safely
    // retried; no host action is started by this request.
    if (options.jobs) {
      const targetRow = db.get<any>("SELECT * FROM service_targets WHERE id=?", deployment.target_id);
      const plan = parse<any>(deployment.plan_json, {});
      options.jobs.enqueue({
        agentID: String(target?.machine_id ? (db.get<any>("SELECT agent_id FROM managed_machines WHERE id=?", target.machine_id)?.agent_id ?? "") : ""),
        deploymentID: deployment.id,
        operationID,
        actions: Array.isArray(plan.actions) ? plan.actions : [],
        capabilities: Array.isArray(plan.capabilities) ? plan.capabilities : [],
        target: targetRow ? { id: targetRow.id, config: parse(targetRow.config_json, {}) } : {},
      });
    }
    const result = transition(deployment.id, "agent_ready", ctx.user.id, "管理员已批准部署计划，等待 Agent 执行", "", { operationID, approvedBy: ctx.user.id });
    ctx.json({ ...result, operation_id: operationID });
  }));
  router.post("/api/v1/deployments/:deploymentId/rollback", safe(deps, async (ctx) => {
    admin(deps, ctx);
    const input = await body(ctx), deployment = deploymentRow(ctx.params.deploymentId);
    if (input.confirm !== true) fail(400, "必须明确确认回滚");
    const reason = text(input.reason ?? "管理员请求回滚", "reason", 1000, false) || "管理员请求回滚";
    if (deployment.status === "rollback_pending") {
      let operationID = deployment.operation_id || "";
      if (!operationID) {
        const candidate = id();
        const updated = db.run("UPDATE deployments SET operation_id=? WHERE id=? AND status='rollback_pending' AND operation_id=''", candidate, deployment.id);
        operationID = updated.changes === 1 ? candidate : String(deploymentRow(deployment.id).operation_id || "");
      }
      const current = deploymentRow(deployment.id);
      ctx.json({ ...deploymentView(current), operation_id: current.operation_id || operationID });
      return;
    }
    if (!(DEPLOYMENT_TRANSITIONS[deployment.status as DeploymentStatus] ?? []).includes("rollback_pending"))
      fail(409, "当前部署状态不允许回滚");
    const operationID = id();
    const result = transition(deployment.id, "rollback_pending", ctx.user.id, reason, "rollback_requested", { operationID });
    ctx.json({ ...result, operation_id: operationID });
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
