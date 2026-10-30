import { id } from "../shared/crypto.js";
import { fail } from "../shared/http.js";
import type { Dependencies } from "../shared/types.js";
import type { AgentJobStore, AgentJobUpdate } from "../server/agent-jobs.js";
import type { OperationPayload } from "../operations/types.js";
import type {
  PlatformStore,
  PlatformResource,
  PlatformRun,
  ResourceKind,
  ResourceDefinition,
} from "./types.js";

const ACTIVE = [
  "queued",
  "leased",
  "accepted",
  "preflighting",
  "staging",
  "activating",
  "verifying",
  "running",
];
export const safeObject = (value: unknown): Record<string, any> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Buffer.byteLength(JSON.stringify(value)) > 1_100_000
  )
    fail(400, "invalid_platform_input");
  return value as Record<string, any>;
};
export const cleanResult = (value: any, depth = 0): any => {
  if (depth > 15) return "[omitted]";
  if (typeof value === "string")
    return /-----BEGIN[\s\S]*?PRIVATE KEY-----/.test(value)
      ? "[redacted]"
      : value.slice(0, 16384);
  if (Array.isArray(value))
    return value.slice(0, 1000).map((v) => cleanResult(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(private_key|private_key_pem|certificate_pem|certificate_chain|secret|secret_key|access_key_secret|secret_access_key|session_token|password|token|credentials|environment|env|script|stdout|stderr)$/i.test(
          k,
        )
          ? "[redacted]"
          : cleanResult(v, depth + 1),
      ]),
    );
  return value;
};
const validateName = (value: string) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    /[\x00-\x1f]/.test(value)
  )
    fail(400, "invalid_platform_name");
  return value.trim();
};

/** Encrypted desired state and immutable executions shared by all operations domains. */
export class OperationsPlatformStore implements PlatformStore {
  readonly definitions = new Map<ResourceKind, ResourceDefinition>();
  private listeners = new Set<
    (
      run: PlatformRun,
      config: Record<string, any>,
      update: AgentJobUpdate,
    ) => void
  >();
  private unsubscribe: () => void;
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  constructor(
    readonly deps: Dependencies,
    readonly jobs: AgentJobStore,
  ) {
    deps.db.exec(`CREATE TABLE IF NOT EXISTS ops_platform_resources(
   id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,spec_cipher TEXT NOT NULL,
   status_json TEXT NOT NULL,created_by TEXT NOT NULL,authorized_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
   UNIQUE(kind,name));
   CREATE TABLE IF NOT EXISTS ops_platform_revisions(resource_id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,
   spec_cipher TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(resource_id,revision));
   CREATE TABLE IF NOT EXISTS ops_platform_runs(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,resource_revision INTEGER NOT NULL,
   agent_id TEXT NOT NULL,action TEXT NOT NULL,state TEXT NOT NULL,payload_cipher TEXT NOT NULL,result_json TEXT NOT NULL,
   job_id TEXT NOT NULL,actor TEXT NOT NULL,dedupe_key TEXT UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS ops_platform_run_resource ON ops_platform_runs(resource_id,created_at);
   CREATE INDEX IF NOT EXISTS ops_platform_run_job ON ops_platform_runs(job_id);`);
    // Display names of deployments are labels; service_name is their unique identity.
    const original =
      deps.db.get<any>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='ops_platform_resources'",
      )?.sql ?? "";
    if (/UNIQUE\s*\(kind\s*,\s*name\)/i.test(original)) {
      deps.db.transaction(() => {
        deps.db
          .exec(`ALTER TABLE ops_platform_resources RENAME TO ops_platform_resources_legacy_names;
          CREATE TABLE ops_platform_resources(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,spec_cipher TEXT NOT NULL,status_json TEXT NOT NULL,created_by TEXT NOT NULL,authorized_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
          INSERT INTO ops_platform_resources SELECT * FROM ops_platform_resources_legacy_names;
          DROP TABLE ops_platform_resources_legacy_names;`);
      });
    }
    deps.db
      .exec(`CREATE UNIQUE INDEX IF NOT EXISTS ops_platform_named_resource ON ops_platform_resources(kind,name) WHERE kind!='application';
      CREATE TABLE IF NOT EXISTS ops_platform_application_keys(resource_id TEXT PRIMARY KEY,service_name TEXT NOT NULL UNIQUE,cluster_id TEXT NOT NULL,role TEXT NOT NULL);
      DROP INDEX IF EXISTS ops_platform_openresty_cluster;`);
    // A previous process may have completed a cloud request before persisting its receipt.
    deps.db.run(
      "UPDATE ops_platform_runs SET state='unknown',result_json=?,updated_at=? WHERE state='running' AND job_id=''",
      JSON.stringify({ code: "center_restarted_during_execution" }),
      this.at(),
    );
    this.unsubscribe = jobs.onUpdate((update) => this.onJob(update));
  }
  private at() {
    return this.deps.now().toISOString();
  }
  register(kind: ResourceKind, definition: ResourceDefinition) {
    if (this.definitions.has(kind))
      throw Error("duplicate_platform_resource_kind");
    this.definitions.set(kind, definition);
  }
  private definition(kind: ResourceKind) {
    const d = this.definitions.get(kind);
    if (!d) fail(400, "unsupported_platform_resource_kind");
    return d;
  }
  private row(id: string) {
    const r = this.deps.db.get<any>(
      "SELECT * FROM ops_platform_resources WHERE id=?",
      id,
    );
    if (!r) fail(404, "platform_resource_not_found");
    return r;
  }
  private resource(r: any): PlatformResource {
    return {
      ...r,
      revision: Number(r.revision),
      spec: JSON.parse(this.deps.decrypt(r.spec_cipher)),
      status: JSON.parse(r.status_json),
      spec_cipher: undefined,
      status_json: undefined,
    };
  }
  get(id: string, kind?: ResourceKind) {
    const r = this.resource(this.row(id));
    if (kind && r.kind !== kind) fail(400, "platform_resource_kind_mismatch");
    return r;
  }
  list(kind?: ResourceKind) {
    if (kind) this.definition(kind);
    return (
      kind
        ? this.deps.db.all(
            "SELECT * FROM ops_platform_resources WHERE kind=? ORDER BY updated_at DESC,id",
            kind,
          )
        : this.deps.db.all(
            "SELECT * FROM ops_platform_resources ORDER BY updated_at DESC,id",
          )
    ).map((r) => this.resource(r));
  }
  public(resource: PlatformResource): PlatformResource {
    const d = this.definition(resource.kind);
    const { spec_cipher: _, status_json: __, ...rest } = resource as any;
    return {
      ...rest,
      spec: d.publicSpec
        ? d.publicSpec(structuredClone(resource.spec))
        : cleanResult(resource.spec),
      status: cleanResult(resource.status),
    };
  }
  authorized(actor: string) {
    return !!this.deps.db.get(
      "SELECT id FROM users WHERE id=? AND active=1 AND role='admin'",
      actor,
    );
  }
  private requireActor(actor: string) {
    if (this.closed) fail(503, "platform_shutting_down");
    if (!this.authorized(actor)) fail(403, "platform_authorization_required");
  }
  create(
    kind: ResourceKind,
    name: string,
    spec: Record<string, any>,
    actor: string,
  ) {
    this.requireActor(actor);
    const key = id(),
      at = this.at();
    this.deps.db.transaction(() => {
      const valid = this.definition(kind).validate(
        safeObject(spec),
        undefined,
        { id: key },
      );
      const cipher = this.deps.encrypt(JSON.stringify(valid));
      this.deps.db.run(
        "INSERT INTO ops_platform_resources(id,kind,name,revision,spec_cipher,status_json,created_by,authorized_by,created_at,updated_at) VALUES(?,?,?,1,?,?,?,?,?,?)",
        key,
        kind,
        validateName(name),
        cipher,
        "{}",
        actor,
        actor,
        at,
        at,
      );
      this.deps.db.run(
        "INSERT INTO ops_platform_revisions VALUES(?,1,?,?,?,?)",
        key,
        validateName(name),
        cipher,
        actor,
        at,
      );
      this.syncKeys(this.get(key));
      this.definition(kind).afterSave?.(this.get(key));
    });
    return this.get(key);
  }
  update(
    key: string,
    revision: number,
    name: string,
    spec: Record<string, any>,
    actor: string,
  ) {
    this.requireActor(actor);
    this.deps.db.transaction(() => {
      const previous = this.get(key);
      if (previous.revision !== revision)
        fail(409, "platform_revision_conflict");
      if (
        this.deps.db.get(
          "SELECT r.id FROM ops_platform_runs r LEFT JOIN agent_jobs j ON j.id=r.job_id WHERE r.resource_id=? AND (r.state='running' OR j.state IN ('leased','accepted','preflighting','staging','activating','verifying')) AND r.action NOT LIKE '%inspect%' AND r.action NOT LIKE '%logs%'",
          key,
        )
      )
        fail(409, "platform_resource_busy");
      const valid = this.definition(previous.kind).validate(
          safeObject(spec),
          previous.spec,
          { id: key },
        ),
        cipher = this.deps.encrypt(JSON.stringify(valid)),
        at = this.at();
      this.deps.db.run(
        "UPDATE ops_platform_resources SET name=?,revision=revision+1,spec_cipher=?,authorized_by=?,updated_at=? WHERE id=? AND revision=?",
        validateName(name),
        cipher,
        actor,
        at,
        key,
        revision,
      );
      this.deps.db.run(
        "INSERT INTO ops_platform_revisions VALUES(?,?,?,?,?,?)",
        key,
        revision + 1,
        validateName(name),
        cipher,
        actor,
        at,
      );
      this.syncKeys(this.get(key));
      this.definition(previous.kind).afterSave?.(this.get(key), previous);
      return this.get(key);
    });
    // Cancel only unclaimed old tasks after the resource transaction; claim races
    // are rejected by the private payload's revision check, never force-cancelled.
    for (const run of this.deps.db.all<any>(
      "SELECT id FROM ops_platform_runs WHERE resource_id=? AND state='queued'",
      key,
    )) {
      try {
        this.jobs.cancelQueuedDeployment("platform-" + key, run.id, actor);
      } catch {}
    }
    return this.get(key);
  }
  patchStatus(key: string, status: Record<string, any>) {
    const r = this.get(key),
      safe = cleanResult({ ...r.status, ...safeObject(status) });
    if (Buffer.byteLength(JSON.stringify(safe)) > 128 * 1024)
      fail(400, "platform_status_limit");
    this.deps.db.run(
      "UPDATE ops_platform_resources SET status_json=? WHERE id=?",
      JSON.stringify(safe),
      key,
    );
  }
  remove(key: string, revision: number) {
    if (this.closed) fail(503, "platform_shutting_down");
    this.deps.db.transaction(() => {
      const r = this.get(key);
      if (r.revision !== revision) fail(409, "platform_revision_conflict");
      if (
        this.deps.db.get(
          "SELECT r.id FROM ops_platform_runs r LEFT JOIN agent_jobs j ON j.id=r.job_id WHERE r.resource_id=? AND (r.state='running' OR j.state IN ('queued','leased','accepted','preflighting','staging','activating','verifying'))",
          key,
        )
      )
        fail(409, "platform_resource_busy");
      this.definition(r.kind).beforeDelete?.(r);
      const references = (value: any): boolean =>
        value === key ||
        (Array.isArray(value) && value.some(references)) ||
        (value &&
          typeof value === "object" &&
          Object.entries(value).some(
            ([k, v]) =>
              ![
                "static_files",
                "files",
                "script",
                "environment",
                "env",
              ].includes(k) && references(v),
          ));
      for (const other of this.list())
        if (other.id !== key && references(other.spec))
          fail(409, "platform_resource_in_use");
      if (r.status.active === true) fail(409, "platform_stop_before_delete");
      this.deps.db.run("DELETE FROM ops_platform_resources WHERE id=?", key);
      this.deps.db.run(
        "DELETE FROM ops_platform_application_keys WHERE resource_id=?",
        key,
      );
      this.definition(r.kind).afterDelete?.(r);
    });
  }
  private syncKeys(resource: PlatformResource) {
    if (
      resource.kind !== "application" ||
      (!resource.spec.deployments && !resource.spec.cluster_id)
    )
      return;
    const { service_name, role } = resource.spec;
    const cluster_id = "";
    const duplicate = this.deps.db.get<any>(
      "SELECT resource_id FROM ops_platform_application_keys WHERE service_name=? AND resource_id!=?",
      service_name,
      resource.id,
    );
    if (duplicate) fail(409, "service_name_conflict");

    this.deps.db.run(
      "INSERT INTO ops_platform_application_keys VALUES(?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET service_name=excluded.service_name,cluster_id=excluded.cluster_id,role=excluded.role",
      resource.id,
      service_name,
      cluster_id,
      role,
    );
  }
  private runRow(key: string) {
    const r = this.deps.db.get<any>(
      "SELECT * FROM ops_platform_runs WHERE id=?",
      key,
    );
    if (!r) fail(404, "platform_run_not_found");
    return r;
  }
  private runView(row: any): PlatformRun {
    const { payload_cipher: _, result_json: __, ...r } = row;
    return {
      ...r,
      resource_revision: Number(r.resource_revision),
      result: cleanResult(JSON.parse(row.result_json || "{}")),
    };
  }
  action(id: string) {
    return this.runView(this.runRow(id));
  }
  actions(resourceID?: string) {
    return (
      resourceID
        ? this.deps.db.all(
            "SELECT * FROM ops_platform_runs WHERE resource_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
            resourceID,
          )
        : this.deps.db.all(
            "SELECT * FROM ops_platform_runs ORDER BY created_at DESC,rowid DESC LIMIT 100",
          )
    ).map((r) => this.runView(r));
  }
  private duplicate(key?: string) {
    if (!key) return undefined;
    const r = this.deps.db.get<any>(
      "SELECT * FROM ops_platform_runs WHERE dedupe_key=?",
      key,
    );
    return r ? this.runView(r) : undefined;
  }
  queue(
    resource: PlatformResource,
    agentID: string,
    action: string,
    config: Record<string, any>,
    actor: string,
    idempotencyKey?: string,
  ) {
    this.requireActor(actor);
    return this.deps.db.transaction(() => {
      const duplicate = this.duplicate(idempotencyKey);
      if (duplicate) return duplicate;
      const current = this.get(resource.id);
      if (current.revision !== resource.revision)
        fail(409, "platform_revision_conflict");
      if (!this.deps.db.get("SELECT id FROM agents WHERE id=?", agentID))
        fail(400, "platform_agent_required");
      const key = id(),
        at = this.at(),
        operation = String(config.task ?? action)
          .split(".")
          .at(-1)!;
      const payload: OperationPayload = {
        version: 1,
        operation_id: key,
        operation,
        resource: {
          id: resource.id,
          kind: "platform",
          name: resource.name,
          agent_id: agentID,
          revision: resource.revision,
          config: safeObject(config),
          created_at: at,
          updated_at: at,
        },
        input: {},
      };
      if (Buffer.byteLength(JSON.stringify(payload)) > 1_100_000)
        fail(400, "platform_payload_limit");
      const job = this.jobs.enqueue({
        agentID,
        deploymentID: "platform-" + resource.id,
        operationID: key,
        actions: [
          { kind: "operations", operation_id: key, domain: "platform" },
        ],
        capabilities: ["operations.platform"],
        target: { operations_resource_id: resource.id },
        expiresInSeconds: 900,
      });
      this.deps.db.run(
        "INSERT INTO ops_platform_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        key,
        resource.id,
        resource.revision,
        agentID,
        action,
        "queued",
        this.deps.encrypt(JSON.stringify(payload)),
        "{}",
        job.id,
        actor,
        idempotencyKey ?? null,
        at,
        at,
      );
      return this.runView(this.runRow(key));
    });
  }
  async run(
    resource: PlatformResource,
    action: string,
    actor: string,
    work: () => Promise<Record<string, any>>,
    idempotencyKey?: string,
    input: Record<string, any> = {},
  ) {
    this.requireActor(actor);
    const duplicate = this.duplicate(idempotencyKey);
    if (duplicate) return duplicate;
    if (this.get(resource.id).revision !== resource.revision)
      fail(409, "platform_revision_conflict");
    const key = id(),
      at = this.at();
    this.deps.db.run(
      "INSERT INTO ops_platform_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      key,
      resource.id,
      resource.revision,
      "",
      action,
      "running",
      this.deps.encrypt(
        JSON.stringify({
          resource_snapshot: resource,
          input: safeObject(input),
        }),
      ),
      "{}",
      "",
      actor,
      idempotencyKey ?? null,
      at,
      at,
    );
    const execution = (async () => {
      try {
        const result = cleanResult(await work());
        this.deps.db.run(
          "UPDATE ops_platform_runs SET state=?,result_json=?,updated_at=? WHERE id=?",
          ["unknown", "failed", "verifying"].includes(result.state)
            ? result.state
            : result.verified === false
              ? "unknown"
              : "succeeded",
          JSON.stringify(result),
          this.at(),
          key,
        );
      } catch (error: any) {
        const code =
          typeof error?.code === "string" &&
          /^[a-zA-Z][a-zA-Z0-9_.-]{0,179}$/.test(error.code)
            ? error.code
            : "platform_action_failed";
        const state =
          error?.state === "unknown" || /unknown|timeout/i.test(code)
            ? "unknown"
            : "failed";
        this.deps.db.run(
          "UPDATE ops_platform_runs SET state=?,result_json=?,updated_at=? WHERE id=?",
          state,
          JSON.stringify({ code }),
          this.at(),
          key,
        );
      }
      return this.runView(this.runRow(key));
    })();
    this.pending.add(execution);
    try {
      return await execution;
    } finally {
      this.pending.delete(execution);
    }
  }
  subscribe(
    listener: (
      run: PlatformRun,
      config: Record<string, any>,
      update: AgentJobUpdate,
    ) => void,
  ) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private onJob(update: AgentJobUpdate) {
    const row = this.deps.db.get<any>(
      "SELECT * FROM ops_platform_runs WHERE id=? AND job_id=? AND agent_id=?",
      update.operationID,
      update.jobID,
      update.agentID,
    );
    if (!row) return;
    const job = this.jobs.get(update.jobID);
    const result = cleanResult(
      job.receipt?.snapshot?.operations?.data ??
        update.snapshot?.operations ??
        {},
    );
    this.deps.db.run(
      "UPDATE ops_platform_runs SET state=?,result_json=?,updated_at=? WHERE id=?",
      update.phase,
      JSON.stringify({
        ...result,
        ...(update.code ? { code: update.code } : {}),
      }),
      this.at(),
      row.id,
    );
    const payload = JSON.parse(this.deps.decrypt(row.payload_cipher));
    for (const listener of this.listeners)
      listener(
        this.runView(this.runRow(row.id)),
        payload.resource.config,
        update,
      );
  }
  resolvePayload(job: Record<string, any>): OperationPayload {
    const row = this.deps.db.get<any>(
      "SELECT * FROM ops_platform_runs WHERE id=? AND job_id=? AND agent_id=?",
      job.actions?.[0]?.operation_id,
      job.id,
      job.agent_id,
    );
    if (!row || !this.authorized(row.actor) || !ACTIVE.includes(row.state))
      fail(403, "platform_payload_authorization_required");
    const current = this.get(row.resource_id);
    if (Number(row.resource_revision) !== current.revision)
      fail(403, "platform_payload_revision_changed");
    const payload = JSON.parse(this.deps.decrypt(row.payload_cipher));
    if (
      payload.resource.kind !== "platform" ||
      payload.resource.agent_id !== job.agent_id ||
      payload.resource.id !== job.target?.operations_resource_id ||
      payload.operation_id !== job.actions[0].operation_id ||
      !job.capabilities?.includes("operations.platform")
    )
      fail(403, "platform_payload_mismatch");
    return payload;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    this.unsubscribe();
    this.listeners.clear();
  }
}
