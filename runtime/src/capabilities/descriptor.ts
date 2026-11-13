import type { InvocationContext, Principal } from "./types.js";

export type CapabilityRisk = "R0" | "R1" | "R2" | "R3";
export type OperationKind = "center_read" | "telemetry_query" | "remote_probe" | "domain_change" | "long_running";
export interface TargetRef { kind: "host" | "task" | "execution" | "proposal"; id: string; revision?: string | number }
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
const listOutput = (field: string, extra: Record<string, any> = {}) => data({
  [field]: arrayOfRecords, total: count, truncated: flag, next_offset: nullOr(count), ...extra,
}, [field]);
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
      ...(input?.task_id ? [{ kind: "task" as const, id: input.task_id }] : []),
      ...(input?.run_id ? [{ kind: "execution" as const, id: input.run_id }] : []),
    ],
  },
  lightmoni_proposals_get: {
    id: "tasks.proposal.get", outputSchema: data({ proposal: record }, ["proposal"]), risk: "R0", operationKind: "center_read",
    approvalPolicy: "none", idempotencyPolicy: "none",
    targetResolver: input => input?.id ? [{ kind: "proposal", id: input.id }] : [],
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
    risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
  lightmoni_alerts_list: {
    id: "alerts.list", outputSchema: data({ rules: arrayOfRecords, limit: count }, ["rules", "limit"]),
    risk: "R0", operationKind: "center_read", approvalPolicy: "none", idempotencyPolicy: "none", targetResolver: () => [],
  },
};

export function defineCapability(seed: CapabilityDefinitionSeed): CapabilityDefinition {
  const metadata = METADATA[seed.name];
  if (!metadata) throw Error("Missing capability metadata: " + seed.name);
  return {
    ...seed, ...metadata, version: 1, exposure: {...ALL}, executionMode: "sync", limits: {...DEFAULT_LIMITS},
    resultProjection: value => value, auditPolicy: "digest_only",
  };
}

export function validateCapabilityRegistry(definitions: CapabilityDefinition[]): void {
  const ids = new Set<string>(), names = new Set<string>();
  for (const d of definitions) {
    if (!/^[a-z][a-z0-9_.]{1,80}$/.test(d.id) || d.version !== 1 || ids.has(d.id) || names.has(d.name)
      || d.executionMode !== "sync" || !d.outputSchema || !d.targetResolver || !d.exposure || !d.limits
      || !d.resultProjection || d.auditPolicy !== "digest_only")
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
