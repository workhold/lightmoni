import { id } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import type { Context, Dependencies, Handler, Module } from "../shared/types.js";
import type { AgentJobStore } from "./agent-jobs.js";
import type { AgentCredentialStore } from "./agent-credentials.js";
import type { OperationDefinition, OperationPayload, OperationResource, OperationsStore } from "../operations/types.js";

const KINDS = new Set(["website", "certificate", "compose", "backup"]);
const ACTIVE = new Set(["queued", "leased", "accepted", "staging", "activating", "verifying"]);
const obj = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Buffer.byteLength(JSON.stringify(v)) > 1_200_000) fail(400, "invalid_operations_input");
  return v as Record<string, any>;
};
const text = (v: unknown, max = 160) => { if (typeof v !== "string" || !v.trim() || v.length > max || /[\x00-\x1f]/.test(v)) fail(400, "invalid_operations_input"); return v.trim(); };
const redact = (value: any): any => Array.isArray(value) ? value.map(redact) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /private_key|password|secret|token|credential/i.test(k) ? "[redacted]" : redact(v)]))
  : typeof value === "string" && /-----BEGIN.*PRIVATE KEY/.test(value) ? "[redacted]" : value;

export function registerOperations(deps: Dependencies, options: { jobs: AgentJobStore; credentials: AgentCredentialStore; definitions: OperationDefinition[]; resolvePayload?: (job: Record<string, any>) => OperationPayload }): Module & OperationsStore {
  const { db, router } = deps, definitions = new Map(options.definitions.map(d => [d.kind, d]));
  db.exec(`CREATE TABLE IF NOT EXISTS ops_resources(
    id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,agent_id TEXT NOT NULL,revision INTEGER NOT NULL,
    config_cipher TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,created_by TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ops_resources_kind ON ops_resources(kind,updated_at);
    CREATE TABLE IF NOT EXISTS ops_runs(
    id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,resource_revision INTEGER NOT NULL,operation TEXT NOT NULL,
    state TEXT NOT NULL,payload_cipher TEXT NOT NULL,preview_json TEXT NOT NULL,job_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,expires_at TEXT NOT NULL,created_by TEXT NOT NULL,approved_by TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ops_runs_resource ON ops_runs(resource_id,created_at);`);
  const at = () => deps.now().toISOString();
  const raw = (key: string): any => { const r = db.get("SELECT * FROM ops_resources WHERE id=?", key); if (!r) fail(404, "operations_resource_not_found"); return r; };
  const definition = (kind: string) => { const d = definitions.get(kind as any); if (!d) fail(400, "unsupported_operations_kind"); return d; };
  const configOf = (r: any) => JSON.parse(deps.decrypt(r.config_cipher));
  const view = (r: any): OperationResource => ({ id: r.id, kind: r.kind, name: r.name, agent_id: r.agent_id, revision: Number(r.revision), config: definition(r.kind).publicConfig(configOf(r)), created_at: r.created_at, updated_at: r.updated_at });
  const runRow = (key: string): any => { const r = db.get("SELECT * FROM ops_runs WHERE id=?", key); if (!r) fail(404, "operations_run_not_found"); return r; };
  const runView = (r: any) => {
    let job: any;
    if (r.job_id) job = options.jobs.get(r.job_id);
    return { id: r.id, resource_id: r.resource_id, resource_revision: Number(r.resource_revision), operation: r.operation,
      state: job?.state ?? r.state, preview: JSON.parse(r.preview_json), created_at: r.created_at, expires_at: r.expires_at,
      created_by: r.created_by, approved_by: r.approved_by, job_id: r.job_id,
      receipt: job ? redact(job.receipt) : null, review_url: "/operations?run=" + r.id };
  };
  const validateConfig = (kind: string, input: unknown) => {
    if (kind === "compose" && JSON.stringify(input)?.includes('"[redacted]"')) fail(400, "replace_redacted_compose_values_with_complete_configuration");
    try { return definition(kind).validate(input); } catch (e) { if (e instanceof HTTPError) throw e; fail(400, "invalid_" + kind + "_configuration"); }
  };
  const referenceCheck = (kind: string, config: any, agentID: string, resourceID = "") => {
    if (kind === "certificate" && resourceID) {
      for (const website of db.all<any>("SELECT * FROM ops_resources WHERE kind='website'")) {
        const site = configOf(website);
        if (site.certificate_id === resourceID && (site.domains ?? []).some((domain: string) => !(config.domains ?? []).includes(domain))) fail(409, "certificate_domains_in_use");
      }
    }
    if (kind === "website" && config.certificate_id) {
      const cert = raw(config.certificate_id);
      if (cert.kind !== "certificate" || cert.agent_id !== agentID) fail(400, "certificate_node_mismatch");
      const domains = configOf(cert).domains ?? [];
      if ((config.domains ?? []).some((d: string) => !domains.includes(d))) fail(400, "certificate_domain_mismatch");
    }
    if (config.service_id && !db.get("SELECT id FROM services WHERE id=?", config.service_id)) fail(400, "service_not_found");
    for (const other of db.all<any>("SELECT * FROM ops_resources WHERE agent_id=? AND kind=? AND id<>?", agentID, kind, resourceID)) {
      const c = configOf(other);
      if (kind === "compose" && c.project_name === config.project_name) fail(409, "compose_project_already_registered");
      if (kind === "website" && (config.domains ?? []).some((d: string) => (c.domains ?? []).includes(d)) && (c.listen_port ?? 8088) === (config.listen_port ?? 8088)) fail(409, "website_domain_port_conflict");
    }
  };
  const validateOperation = (resourceID: string, operation: string, input: unknown) => {
    const r = raw(resourceID), d = definition(r.kind);
    if (!d.operations.includes(operation)) fail(400, "unsupported_operations_action");
    try { return d.validateInput(operation, input ?? {}, configOf(r)); } catch (e) { if (e instanceof HTTPError) throw e; fail(400, "invalid_operations_action_input"); }
  };
  const store: Module & OperationsStore = {
    list(kind) { if (kind && !KINDS.has(kind)) fail(400, "unsupported_operations_kind"); return (kind ? db.all("SELECT * FROM ops_resources WHERE kind=? ORDER BY updated_at DESC,id LIMIT 1000", kind) : db.all("SELECT * FROM ops_resources ORDER BY updated_at DESC,id LIMIT 1000")).map(view); },
    get(key) { return view(raw(key)); },
    validateOperation,
    plan(resourceID, operation, input, actor) {
      const r = raw(resourceID), validated = validateOperation(resourceID, operation, input), key = id();
      referenceCheck(r.kind, configOf(r), r.agent_id, r.id);
      const payload: OperationPayload = { version: 1, operation_id: key, operation, resource: { ...view(r), config: configOf(r) }, input: validated };
      const preview = { resource: view(r), operation, input: redact(validated), read_only: definition(r.kind).readOnly.includes(operation), warning: "Review the target, action and configuration before approving. Remote actions may interrupt service. Rollback does not revert data migrations." };
      const expiry = new Date(deps.now().getTime() + 30 * 60_000).toISOString();
      db.run("INSERT INTO ops_runs(id,resource_id,resource_revision,operation,state,payload_cipher,preview_json,created_at,expires_at,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", key, r.id, r.revision, operation, "awaiting_approval", deps.encrypt(JSON.stringify(payload)), JSON.stringify(preview), at(), expiry, text(actor), at());
      return runView(runRow(key));
    },
    approve(key, actor, revision) {
      return db.transaction(() => {
        const r = runRow(key), resource = raw(r.resource_id);
        if (r.job_id) return runView(r);
        if (r.state !== "awaiting_approval" || Date.parse(r.expires_at) <= deps.now().getTime()) fail(409, "operations_plan_expired_or_closed");
        if (revision !== Number(r.resource_revision) || revision !== Number(resource.revision)) fail(409, "operations_revision_conflict");
        const pending = db.get<any>("SELECT id FROM ops_runs WHERE resource_id=? AND id<>? AND state IN ('queued','leased','accepted','staging','activating','verifying')", resource.id, key);
        if (pending) fail(409, "operations_resource_busy");
        const payload = JSON.parse(deps.decrypt(r.payload_cipher)) as OperationPayload;
        referenceCheck(resource.kind, payload.resource.config, resource.agent_id, resource.id);
        const job = options.jobs.enqueue({ agentID: resource.agent_id, deploymentID: "operations-" + resource.id, operationID: key,
          actions: [{ kind: "operations", operation_id: key, domain: resource.kind }], capabilities: ["operations." + resource.kind], target: { operations_resource_id: resource.id }, expiresInSeconds: 900 });
        db.run("UPDATE ops_runs SET state='queued',job_id=?,approved_by=?,updated_at=? WHERE id=?", job.id, text(actor), at(), key);
        return runView(runRow(key));
      });
    },
    getRun(key) { return runView(runRow(key)); },
    runs(resourceID) { return (resourceID ? db.all("SELECT * FROM ops_runs WHERE resource_id=? ORDER BY created_at DESC,id DESC LIMIT 100", resourceID) : db.all("SELECT * FROM ops_runs ORDER BY created_at DESC,id DESC LIMIT 100")).map(runView); },
  };
  const removeObserver = options.jobs.onUpdate(update => {
    const r = db.get<any>("SELECT id FROM ops_runs WHERE job_id=? AND id=?", update.jobID, update.operationID);
    if (r) db.run("UPDATE ops_runs SET state=?,updated_at=? WHERE id=?", update.phase, at(), r.id);
  });
  store.close = removeObserver;
  const safe = (fn: Handler): Handler => async ctx => {
    try { await fn(ctx); } catch (e) { if (e instanceof HTTPError) ctx.json({ error: e.message }, e.status); else { deps.logger.error("Operations request failed"); ctx.json({ error: "operations_request_failed" }, 500); } }
  };
  const admin = (fn: Handler) => safe(async ctx => { deps.auth.requireAdmin(ctx); await fn(ctx); });
  router.get("/api/v1/operations/resources", admin(ctx => ctx.json({ resources: store.list(ctx.url.searchParams.get("kind") ?? undefined) })));
  router.get("/api/v1/operations/agents", admin(ctx => ctx.json({ agents: db.all("SELECT id,host_id,last_seen FROM agents ORDER BY last_seen DESC,id LIMIT 1000") })));
  router.post("/api/v1/operations/resources", admin(async ctx => {
    const b = obj(await ctx.body()), kind = text(b.kind), name = text(b.name), agentID = text(b.agent_id), config = validateConfig(kind, b.config);
    if (!db.get("SELECT id FROM agents WHERE id=?", agentID)) fail(400, "registered_agent_required");
    referenceCheck(kind, config, agentID);
    const key = id();
    db.run("INSERT INTO ops_resources(id,kind,name,agent_id,revision,config_cipher,created_at,updated_at,created_by) VALUES(?,?,?,?,1,?,?,?,?)", key, kind, name, agentID, deps.encrypt(JSON.stringify(config)), at(), at(), ctx.user.id);
    ctx.json({ resource: store.get(key) }, 201);
  }));
  router.put("/api/v1/operations/resources/:id", admin(async ctx => {
    const b = obj(await ctx.body()), r = raw(ctx.params.id);
    if (b.revision !== Number(r.revision)) fail(409, "operations_revision_conflict");
    if (db.get("SELECT id FROM ops_runs WHERE resource_id=? AND state IN ('queued','leased','accepted','staging','activating','verifying')", r.id)) fail(409, "operations_resource_busy");
    const previous = configOf(r), changes = { ...obj(b.config) };
    if (changes.service_id === null || changes.service_id === "") changes.service_id = undefined;
    for (const key of Object.keys(changes)) if (/^has_/.test(key)) delete changes[key];
    // Empty secret controls mean reuse the encrypted value; no GET response includes it.
    for (const key of ["private_key_pem", "certificate_pem"]) if (changes[key] === "") delete changes[key];
    if (r.kind === "backup" && changes.storage) {
      const storage = { ...obj(changes.storage) }, old = previous.storage;
      delete storage.has_credentials;
      const same = old?.type === "s3" && storage.type === "s3" && ["endpoint", "bucket", "region", "prefix"].every(k => (storage[k] ?? (k === "region" ? "us-east-1" : k === "prefix" ? "lightmoni" : "")) === old[k]);
      if (same) for (const k of ["access_key_id", "secret_access_key", "session_token"]) if (!storage[k]) storage[k] = old[k];
      changes.storage = storage;
    }
    const config = validateConfig(r.kind, { ...previous, ...changes });
    if (r.kind === "compose" && config.project_name !== previous.project_name) fail(409, "compose_project_name_immutable");
    referenceCheck(r.kind, config, r.agent_id, r.id);
    const result = db.run("UPDATE ops_resources SET name=?,config_cipher=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", b.name == null ? r.name : text(b.name), deps.encrypt(JSON.stringify(config)), at(), r.id, b.revision);
    if (!result.changes) fail(409, "operations_revision_conflict");
    ctx.json({ resource: store.get(r.id) });
  }));
  router.delete("/api/v1/operations/resources/:id", admin(async ctx => {
    const b = obj(await ctx.body()), r = raw(ctx.params.id);
    if (b.revision !== Number(r.revision)) fail(409, "operations_revision_conflict");
    if (db.get("SELECT id FROM ops_runs WHERE resource_id=? AND state IN ('queued','leased','accepted','staging','activating','verifying')", r.id)) fail(409, "operations_resource_busy");
    const mutations = db.all<any>("SELECT * FROM ops_runs WHERE resource_id=? AND job_id<>'' ORDER BY rowid DESC", r.id).filter(run => !definition(r.kind).readOnly.includes(run.operation));
    if (r.kind === "website" && mutations.length && (mutations[0].operation !== "disable" || runView(mutations[0]).state !== "succeeded")) fail(409, "disable_website_before_removing_registration");
    if (r.kind === "compose" && mutations.length) fail(409, "retain_managed_compose_registration_for_data_and_history");
    if (r.kind === "certificate" && db.all<any>("SELECT * FROM ops_resources WHERE kind='website'").some(w => configOf(w).certificate_id === r.id)) fail(409, "certificate_in_use");
    if (db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_schedules'") && db.get("SELECT id FROM ops_schedules WHERE resource_id=?", r.id)) fail(409, "operations_schedule_in_use");
    db.run("DELETE FROM ops_resources WHERE id=? AND revision=?", r.id, b.revision);
    ctx.json({ deleted: true, remote_data_deleted: false });
  }));
  router.post("/api/v1/operations/resources/:id/plans", admin(async ctx => { const b = obj(await ctx.body()); ctx.json({ run: store.plan(ctx.params.id, text(b.operation), b.input ?? {}, ctx.user.id) }, 201); }));
  router.get("/api/v1/operations/runs", admin(ctx => ctx.json({ runs: store.runs(ctx.url.searchParams.get("resource_id") ?? undefined) })));
  router.get("/api/v1/operations/runs/:id", admin(ctx => ctx.json({ run: store.getRun(ctx.params.id) })));
  router.post("/api/v1/operations/runs/:id/approve", admin(async ctx => { const b = obj(await ctx.body()); ctx.json({ run: store.approve(ctx.params.id, ctx.user.id, b.revision) }); }));
  router.post("/api/v1/operations/runs/:id/cancel", admin(ctx => {
    const r = runRow(ctx.params.id);
    if (r.job_id) { const j = options.jobs.get(r.job_id); if (j.state !== "queued") fail(409, "operations_job_already_claimed"); options.jobs.cancel(r.job_id, ctx.user.id); }
    else if (r.state === "awaiting_approval") db.run("UPDATE ops_runs SET state='cancelled',updated_at=? WHERE id=?", at(), r.id);
    ctx.json({ run: store.getRun(r.id) });
  }));
  router.get("/api/v1/agents/:id/jobs/:jobId/operations", safe(ctx => {
    options.credentials.authenticate(ctx.req, ctx.params.id, "control");
    const job = options.jobs.get(ctx.params.jobId), lease = ctx.req.headers["x-lightmoni-job-lease"];
    if (job.agent_id !== ctx.params.id || !lease || lease !== job.lease_id || !ACTIVE.has(job.state) || Date.parse(job.lease_expires_at) <= deps.now().getTime() || Date.parse(job.expires_at) <= deps.now().getTime()) fail(403, "operations_job_lease_required");
    if (job.actions?.length !== 1 || job.actions[0]?.kind !== "operations") fail(403, "not_an_operations_job");
    if (job.actions[0].domain === "platform") {
      if (!options.resolvePayload) fail(403, "platform_payload_unavailable");
      ctx.res.setHeader("cache-control", "no-store");
      ctx.json({ payload: options.resolvePayload(job) });
      return;
    }
    const r = runRow(job.actions[0].operation_id);
    if (r.job_id !== job.id || r.state === "awaiting_approval" || !r.approved_by) fail(403, "operations_approval_required");
    ctx.res.setHeader("cache-control", "no-store");
    ctx.json({ payload: JSON.parse(deps.decrypt(r.payload_cipher)) });
  }), { public: true });
  return store;
}
