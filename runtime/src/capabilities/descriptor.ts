import type { InvocationContext, Principal } from "./types.js";

export type CapabilityRisk = "R0" | "R1" | "R2" | "R3";
export type OperationKind = "center_read" | "telemetry_query" | "remote_probe" | "domain_change" | "long_running";
export interface TargetRef { kind: "host" | "task" | "execution" | "proposal" | "table" | "alert_rule" | "alert_silence" | "log" | "trace" | "service" | "deployment" | "operation_resource" | "operation_run" | "operation_schedule" | "dashboard" | "instrumentation_plan" | "alert_incident" | "alert_delivery"; id: string; revision?: string | number }
export interface CapabilityLimits {
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  ratePerMinute: number;
  concurrency: number;
}
export interface CapabilityExposure { assistant: boolean; mcp: boolean; http: boolean }

export interface CapabilityDefinition {
  id: string;
  version: number;
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  scope: string;
  additionalScopes?: string[];
  roles: ("admin" | "member")[];
  allHosts?: boolean;
  effect: "read" | "propose";
  risk: CapabilityRisk;
  operationKind: OperationKind;
  exposure: CapabilityExposure;
  executionMode: "sync";
  approvalPolicy: "none" | "domain_native";
  idempotencyPolicy: "none" | "required_external";
  limits: CapabilityLimits;
  resultProjection(value: unknown): unknown;
  auditPolicy: "digest_only";
  targetResolver(input: any): TargetRef[];
  execute(p: Principal, input: any, context: InvocationContext): unknown | Promise<unknown>;
}
export type CapabilityDefinitionSeed = Pick<CapabilityDefinition,
  "name" | "description" | "inputSchema" | "scope" | "effect" | "execute"> & {allHosts?: boolean};

const record = { type: "object", properties: {}, additionalProperties: true };
const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const flag = { type: "boolean" };
const nullOr = (schema: Record<string, any>) => ({ anyOf: [schema, { type: "null" }] });
const data = (properties: Record<string, any>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});
const arrayOfRecords = { type: "array", items: record, maxItems: 10000 };
const stringArray = {type:"array",items:{type:"string",maxLength:512},maxItems:10000};
const listOutput = (field: string, extra: Record<string, any> = {}) => data({
  [field]: arrayOfRecords, total: count, truncated: flag, next_offset: nullOr(count), ...extra,
}, [field]);
const pageOutput = data({ items: arrayOfRecords, total: count, offset: count, limit: count, has_more: flag },
  ["items", "total", "offset", "limit", "has_more"]);
const DEFAULT_LIMITS: CapabilityLimits = {
  timeoutMs: 15_000, maxInputBytes: 16 << 10, maxOutputBytes: 64 << 10, ratePerMinute: 120, concurrency: 4,
};
const ALL: CapabilityExposure = { assistant: true, mcp: true, http: true };
const host = (input: any): TargetRef[] => input?.id ? [{ kind: "host", id: input.id }] : [];
const hostID = (input: any): TargetRef[] => input?.host_id ? [{ kind: "host", id: input.host_id }] : [];

interface Metadata {
  id: string;
  outputSchema: Record<string, any>;
  risk: CapabilityRisk;
  operationKind: OperationKind;
  approvalPolicy: "none" | "domain_native";
  idempotencyPolicy: "none" | "required_external";
  targetResolver(input: any): TargetRef[];
  roles?: ("admin" | "member")[];
  limits?: Partial<CapabilityLimits>;
  additionalScopes?: string[];
}
const METADATA: Record<string, Metadata> = {
  lightmoni_hosts_list: {
    id: "hosts.list", outputSchema: listOutput("hosts"), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
  lightmoni_hosts_get: {
    id: "hosts.get", outputSchema: data({ host: record }, ["host"]), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: host,
  },
  lightmoni_tasks_list: {
    id: "tasks.list", outputSchema: listOutput("tasks"), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: hostID,
  },
  lightmoni_tasks_get: {
    id: "tasks.get", outputSchema: data({ task: record }, ["task"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => [...hostID(input), ...(input?.id ? [{ kind: "task" as const, id: input.id }] : [])],
  },
  lightmoni_tasks_plan: {
    id: "tasks.plan", outputSchema: data({ proposal: record, idempotency_replayed: flag }, ["proposal"]),
    risk: "R2", operationKind: "domain_change", approvalPolicy: "domain_native", idempotencyPolicy: "required_external",
    targetResolver: input => [
      ...(Array.isArray(input?.host_ids) ? input.host_ids.map((id: string) => ({ kind: "host" as const, id })) : []),
      ...(Array.isArray(input?.task?.host_ids) ? input.task.host_ids.map((id: string) => ({ kind: "host" as const, id })) : []),
      ...(input?.task_id ? [{ kind: "task" as const, id: input.task_id }] : []),
      ...(input?.run_id ? [{ kind: "execution" as const, id: input.run_id }] : []),
    ],
  },
  lightmoni_proposals_get: {
    id: "tasks.proposal.get", outputSchema: data({ proposal: record }, ["proposal"]), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => input?.id ? [{ kind: "proposal", id: input.id }] : [],
  },
  lightmoni_domain_proposals_list: {
    id: "proposals.domain.list", outputSchema: data({items:arrayOfRecords,total:count,offset:count,limit:count,has_more:flag,truncated:flag},["items","total","offset","limit","has_more","truncated"]),
    risk: "R1", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
  lightmoni_domain_proposals_get: {
    id: "proposals.domain.get", outputSchema: data({proposal:record},["proposal"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: input => input?.id ? [{kind:"proposal",id:input.id}] : [],
  },
  lightmoni_domain_executions_list: {
    id: "executions.domain.list", outputSchema: data({items:arrayOfRecords,total:count,offset:count,limit:count,has_more:flag,truncated:flag},["items","total","offset","limit","has_more","truncated"]),
    risk: "R1", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
  lightmoni_domain_executions_get: {
    id: "executions.domain.get", outputSchema: data({execution:record},["execution"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: input => input?.id ? [{kind:"execution",id:input.id}] : [],
  },
  lightmoni_executions_list: {
    id: "executions.list", outputSchema: data({ executions: arrayOfRecords, output_omitted: flag }, ["executions", "output_omitted"]),
    risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: hostID,
  },
  lightmoni_executions_get: {
    id: "executions.get", outputSchema: data({ execution: record, output_omitted: flag }, ["execution", "output_omitted"]),
    risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => input?.id ? [{ kind: "execution", id: input.id }] : [],
  },
  lightmoni_telemetry_catalog: {
    id: "telemetry.catalog", outputSchema: data({ tables: arrayOfRecords, limit: count, truncated: flag }, ["tables", "limit", "truncated"]),
    risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [], roles: ["admin", "member"],
  },
  lightmoni_telemetry_describe: {
    id: "telemetry.describe", outputSchema: data({ table: record }, ["table"]),
    risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => input?.table ? [{ kind: "table", id: input.table }] : [], roles: ["admin", "member"],
  },
  lightmoni_telemetry_query: {
    id: "telemetry.query", outputSchema: data({ query: record, range: record, sample_limit: count,
      sample_truncated: flag, sample_byte_limit: count, sample_byte_limited: flag },
      ["query", "range", "sample_limit", "sample_truncated", "sample_byte_limit", "sample_byte_limited"]),
    risk: "R1", operationKind: "telemetry_query", approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: () => [], roles: ["admin", "member"], limits: {ratePerMinute: 30, concurrency: 2},
  },
  lightmoni_alerts_list: {
    id: "alerts.list", outputSchema: data({ rules: arrayOfRecords, limit: count }, ["rules", "limit"]),
    risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [], roles: ["admin", "member"],
  },
  lightmoni_alert_rules_list: {
    id: "alerts.rules.list", outputSchema: pageOutput, risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [], roles: ["admin", "member"],
  },
  lightmoni_alert_rules_get: {
    id: "alerts.rules.get", outputSchema: data({ rule: record }, ["rule"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", roles: ["admin", "member"],
    targetResolver: input => input?.id ? [{ kind: "alert_rule", id: input.id }] : [],
  },
  lightmoni_alert_silences_list: {
    id: "alerts.silences.list", outputSchema: pageOutput, risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [], roles: ["admin", "member"],
  },
  lightmoni_alert_silences_get: {
    id: "alerts.silences.get", outputSchema: data({ silence: record }, ["silence"]), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", roles: ["admin", "member"],
    targetResolver: input => input?.id ? [{ kind: "alert_silence", id: input.id }] : [],
  },
  lightmoni_alert_groups_list: {
    id: "alerts.groups.list", outputSchema: pageOutput, risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [], roles: ["admin", "member"],
  },
  lightmoni_alert_proposals_get: {
    id: "alerts.proposals.get", outputSchema: data({ proposal: record }, ["proposal"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", roles: ["admin", "member"],
    targetResolver: input => input?.id ? [{ kind: "proposal", id: input.id }] : [],
  },
  lightmoni_logs_search: {
    id: "logs.search", outputSchema: data({ frame: record, histogram: record, histogram_truncated: flag,
      session_id: {type:"string"}, next_cursor: {type:"string"}, total_loaded: count, truncated: flag,
      expires_at: {type:"string"}, generated_at: {type:"string"}, range: record, sql: {type:"string"}, count_sql: {type:"string"},
      histogram_sql: {type:"string"}, params: record, interval_ms: count, offset: count, scope: {type:"string"},
      anchor_found: flag, capability_truncated: flag }, ["frame", "histogram", "session_id", "next_cursor", "total_loaded", "truncated", "offset", "capability_truncated"]),
    risk: "R1", operationKind: "telemetry_query", approvalPolicy: "none", idempotencyPolicy: "none", roles: ["admin", "member"],
    limits: {ratePerMinute: 30, concurrency: 2},
    targetResolver: input => input?.spec?.table_id ? [{kind:"table", id:input.spec.table_id}] : [],
  },
  lightmoni_traces_get: {
    id: "traces.get", outputSchema: data({ trace_id: {type:"string"}, spans: {type:"array",items:record,maxItems:16000}, truncated: flag,
      incomplete: flag, missing_parents: count, from: {type:"string"}, to: {type:"string"} },
      ["trace_id", "spans", "truncated", "incomplete", "missing_parents", "from", "to"]),
    risk: "R1", operationKind: "telemetry_query", approvalPolicy: "none", idempotencyPolicy: "none", roles: ["admin", "member"],
    limits: {ratePerMinute: 30, concurrency: 2},
    targetResolver: input => Array.isArray(input?.tables) ? input.tables.map((id:string) => ({kind:"trace" as const,id})) : [],
  },
  lightmoni_services_list: {
    id: "services.list", outputSchema: data({services:arrayOfRecords},["services"]), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
  lightmoni_services_get: {
    id: "services.get", outputSchema: data({service:record,targets:arrayOfRecords,releases:arrayOfRecords},["service","targets","releases"]),
    risk: "R1", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => input?.service_id ? [{kind:"service",id:input.service_id}] : [],
  },
  lightmoni_deployments_list: {
    id: "deployments.list", outputSchema: pageOutput, risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => input?.service_id ? [{kind:"service",id:input.service_id}] : [],
  },
  lightmoni_deployments_get: {
    id: "deployments.get", outputSchema: data({deployment:record},["deployment"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => input?.deployment_id ? [{kind:"deployment",id:input.deployment_id}] : [],
  },
  lightmoni_deployments_events: {
    id: "deployments.events", outputSchema: data({deployment_id:{type:"string"},events:arrayOfRecords},["deployment_id","events"]),
    risk: "R1", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => input?.deployment_id ? [{kind:"deployment",id:input.deployment_id}] : [],
  },
  lightmoni_deployments_plan: {
    id: "deployments.plan", outputSchema: data({proposal:record,plan:record,idempotency_replayed:flag},["proposal","plan"]),
    risk: "R2", operationKind: "domain_change", approvalPolicy: "domain_native", idempotencyPolicy: "required_external",
    targetResolver: input => input?.service_id ? [{kind:"service",id:input.service_id}] : [], additionalScopes: ["deployments.read"],
  },
  lightmoni_operations_resources_list: {
    id: "operations.resources.list", outputSchema: data({resources:arrayOfRecords,total:count,offset:count,limit:count,returned:count,
      next_offset:nullOr(count),model_truncated:flag},["resources","total","offset","limit","returned","next_offset","model_truncated"]),
    risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
  lightmoni_operations_resources_get: {
    id: "operations.resources.get", outputSchema: data({resource:record},["resource"]), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: input => input?.id ? [{kind:"operation_resource",id:input.id}] : [],
  },
  lightmoni_operations_runs_list: {
    id: "operations.runs.list", outputSchema: pageOutput, risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => input?.resource_id ? [{kind:"operation_resource",id:input.resource_id}] : [],
  },
  lightmoni_operations_runs_get: {
    id: "operations.runs.get", outputSchema: data({run:record},["run"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: input => input?.id ? [{kind:"operation_run",id:input.id}] : [],
  },
  lightmoni_operations_plan: {
    id: "operations.plan", outputSchema: data({proposal:record,run:record,idempotency_replayed:flag},["proposal","run"]),
    risk: "R2", operationKind: "domain_change", approvalPolicy: "domain_native", idempotencyPolicy: "required_external",
    targetResolver: input => input?.resource_id ? [{kind:"operation_resource",id:input.resource_id}] : [], additionalScopes: ["operations.read"],
  },
  lightmoni_operations_schedules_list: {
    id: "operations.schedules.list", outputSchema: pageOutput, risk: "R1", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
  lightmoni_operations_schedules_get: {
    id: "operations.schedules.get", outputSchema: data({schedule:record,fires:arrayOfRecords},["schedule","fires"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: input => input?.id ? [{kind:"operation_schedule",id:input.id}] : [],
  },
  lightmoni_hosts_inventory: {
    id: "hosts.inventory", outputSchema: listOutput("machines"), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: hostID,
  },
  lightmoni_hosts_details_get: {
    id: "hosts.details.get", outputSchema: data({machine:record},["machine"]), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: host,
  },
  lightmoni_agent_releases_list: {
    id: "agents.releases.list", outputSchema: data({releases:arrayOfRecords},["releases"]), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
  lightmoni_agent_installations_get: {
    id: "agents.installations.get", outputSchema: data({installation:record},["installation"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
  lightmoni_agent_installations_plan: {
    id: "agents.installations.plan", outputSchema: data({proposal:record,plan:record,idempotency_replayed:flag},["proposal","plan"]),
    risk: "R2", operationKind: "domain_change", approvalPolicy: "domain_native", idempotencyPolicy: "required_external",
    targetResolver: input => input?.machine_id ? [{kind:"host",id:input.machine_id}] : [], additionalScopes: ["agents.read"],
  },
  lightmoni_agent_updates_get: {
    id: "agents.updates.get", outputSchema: data({update:record},["update"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: input => input?.machine_id ? [{kind:"host",id:input.machine_id}] : [],
  },
  lightmoni_dashboards_list: {
    id: "dashboards.list", outputSchema: pageOutput, risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: () => [], roles: ["admin", "member"],
  },
  lightmoni_dashboards_get: {
    id: "dashboards.get", outputSchema: data({dashboard:record},["dashboard"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", roles: ["admin", "member"],
    targetResolver: input => input?.id ? [{kind:"dashboard",id:input.id}] : [],
  },
  lightmoni_dashboards_versions: {
    id: "dashboards.versions", outputSchema: data({dashboard_id:{type:"string"},versions:arrayOfRecords},["dashboard_id","versions"]),
    risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", roles: ["admin", "member"],
    targetResolver: input => input?.id ? [{kind:"dashboard",id:input.id}] : [],
  },
  lightmoni_code_instrumentation_scan: {
    id: "code.instrumentation.scan", outputSchema: data({plan_id:{type:"string"},workspace:{type:"string"},base_revision:{type:"string"},state:{type:"string"},
      languages:stringArray,frameworks:stringArray,package_managers:stringArray,sdk:record,candidates:arrayOfRecords,warnings:stringArray,files_scanned:count},
      ["plan_id","workspace","base_revision","state","languages","frameworks","package_managers","sdk","candidates","warnings","files_scanned"]),
    risk: "R1", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
  lightmoni_code_instrumentation_get: {
    id: "code.instrumentation.get", outputSchema: data({plan:record,applied:nullOr(record)},["plan","applied"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => input?.plan_id ? [{kind:"instrumentation_plan",id:input.plan_id}] : [],
  },
  lightmoni_alert_incidents_list: {
    id: "alerts.incidents.list", outputSchema: pageOutput, risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [], roles: ["admin", "member"],
  },
  lightmoni_alert_incidents_get: {
    id: "alerts.incidents.get", outputSchema: data({incident:record,timeline:arrayOfRecords},["incident","timeline"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", roles: ["admin", "member"],
    targetResolver: input => input?.id ? [{kind:"alert_incident",id:input.id}] : [],
  },
  lightmoni_alert_deliveries_list: {
    id: "alerts.deliveries.list", outputSchema: pageOutput, risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [], roles: ["admin", "member"],
  },
  lightmoni_alert_response_statistics_get: {
    id: "alerts.statistics.get", outputSchema: data({from:{type:"string"},to:{type:"string"},users:arrayOfRecords,records:arrayOfRecords,truncated:flag,definition:{type:"string"}},
      ["from","to","users","records","truncated","definition"]), risk: "R1", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [], roles: ["admin", "member"],
  },
  lightmoni_alerts_plan: {
    id: "alerts.plan", outputSchema: data({proposal:record,idempotency_replayed:flag},["proposal"]),
    risk: "R2", operationKind: "domain_change", approvalPolicy: "domain_native", idempotencyPolicy: "required_external",
    targetResolver: input => input?.target_id ? [{kind:input.operation==="delivery.retry"?"alert_delivery":input.operation?.startsWith("incident.")?"alert_incident":input.operation?.startsWith("silence.")?"alert_silence":"alert_rule",id:input.target_id}] : [],
    additionalScopes: ["alerts.detail.read"],
  },
};

export function defineCapability(seed: CapabilityDefinitionSeed): CapabilityDefinition {
  const metadata = METADATA[seed.name];
  if (!metadata) throw Error("Missing capability metadata: " + seed.name);
  return {
    ...seed, ...metadata, version: 1, exposure: {...ALL}, executionMode: "sync",
    roles: metadata.roles ?? ["admin"], limits: {...DEFAULT_LIMITS, ...metadata.limits},
    resultProjection: value => value, auditPolicy: "digest_only",
  };
}

export function validateCapabilityRegistry(definitions: CapabilityDefinition[]): void {
  const ids = new Set<string>(), names = new Set<string>();
  for (const d of definitions) {
    if (!/^[a-z][a-z0-9_.]{1,80}$/.test(d.id) || d.version !== 1 || ids.has(d.id) || names.has(d.name)
      || d.executionMode !== "sync" || !d.outputSchema || !d.targetResolver || !d.exposure || !d.limits
      || !d.resultProjection || d.auditPolicy !== "digest_only" || !d.roles.length)
      throw Error("invalid capability registry");
    ids.add(d.id); names.add(d.name);
  }
}

export function mcpEnvelopeSchema(dataSchema: Record<string, any>): Record<string, any> {
  const success = data({
    schema_version: { type: "integer", minimum: 1, maximum: 1 },
    invocation_id: { type: "string", minLength: 1, maxLength: 128 },
    kind: { type: "string", enum: ["read", "proposal"] },
    status: { type: "string", enum: ["completed", "awaiting_approval"] },
    data: dataSchema,
  }, ["schema_version", "invocation_id", "kind", "status", "data"]);
  const failure = data({
    schema_version: { type: "integer", minimum: 1, maximum: 1 },
    error: data({ code: {type:"string"}, detail_code: {type:"string"}, message: {type:"string"}, retryable: flag },
      ["code", "detail_code", "message", "retryable"]),
  }, ["schema_version", "error"]);
  return { type: "object", anyOf: [success, failure] };
}

export function mcpAnnotations(d: Pick<CapabilityDefinition,"effect"|"risk"|"operationKind"|"idempotencyPolicy">) {
  return {
    readOnlyHint: d.effect === "read",
    destructiveHint: d.effect !== "read" && d.risk === "R3",
    idempotentHint: d.effect === "read" || d.idempotencyPolicy === "required_external",
    openWorldHint: d.operationKind === "remote_probe",
  };
}
