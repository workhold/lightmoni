import { AssistantError, object, type Tool } from "./types.js";
import type { OperationResource, OperationsStore } from "../operations/types.js";

const RESULT_LIMIT = 28 << 10;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// Public configurations are suitable for the administrator UI, but website and
// Compose bodies are neither necessary nor safe to copy into model context.
function resourceForModel(resource: OperationResource): OperationResource {
  const config = { ...resource.config };
  if (config.static_files && typeof config.static_files === "object") {
    const bodies = Object.values(config.static_files);
    config.static_files_summary = {
      file_count: bodies.length,
      content_bytes: bodies.reduce<number>((total, body) => total + (typeof body === "string" ? Buffer.byteLength(body) : 0), 0),
      body_omitted: true,
    };
    delete config.static_files;
  }
  if (config.compose && typeof config.compose === "object") {
    const compose = config.compose;
    config.compose_summary = {
      service_count: Object.keys(compose.services ?? {}).length,
      services: Object.entries(compose.services ?? {}).map(([name, service]: [string, any]) => ({ name, image: service.image })),
      volume_count: Object.keys(compose.volumes ?? {}).length,
      network_count: Object.keys(compose.networks ?? {}).length,
      document_bytes: size(compose),
      body_omitted: true,
    };
    delete config.compose;
  }
  return { ...resource, config };
}

function runMetadata(run: Record<string, any>): Record<string, any> {
  return Object.fromEntries([
    "id", "resource_id", "resource_revision", "operation", "state", "created_at",
    "expires_at", "created_by", "approved_by", "job_id", "review_url",
  ].filter(key => run[key] !== undefined).map(key => [key, run[key]]));
}

function runForModel(saved: Record<string, any>): Record<string, any> {
  // Business logs may contain credentials that pattern redaction cannot cover.
  const sensitive = saved.operation === "logs" || saved.receipt?.snapshot?.operations?.data?.sensitive_logs;
  const run = structuredClone(sensitive ? { ...saved, receipt: null } : saved);
  if (sensitive) run.receipt_omitted = "Sensitive application logs are available only in the administrator review UI.";
  if (run.preview?.resource) run.preview.resource = resourceForModel(run.preview.resource);

  const data = run.receipt?.snapshot?.operations?.data;
  const fields = ["backups", "removed", "versions", "containers", "discovered_containers", "volumes", "networks", "history"];
  const original = new Map<string, number>();
  if (data && typeof data === "object") {
    for (const key of fields) if (Array.isArray(data[key])) original.set(key, data[key].length);
    const omissions: Record<string, { received: number; returned: number }> = {};
    while (size({ run }) > RESULT_LIMIT) {
      const key = fields.filter(field => Array.isArray(data[field]) && data[field].length)
        .sort((a, b) => size(data[b]) - size(data[a]))[0];
      if (!key) break;
      const count = Math.floor(data[key].length / 2);
      // Compose history is chronological, so retain the most recent entries.
      data[key] = key === "history" ? count ? data[key].slice(-count) : [] : data[key].slice(0, count);
      omissions[key] = { received: original.get(key)!, returned: count };
      run.model_truncated_lists = omissions;
    }
  }
  if (size({ run }) <= RESULT_LIMIT) return run;

  // Preserve the actual state and review link even if an unexpected large
  // scalar or future receipt shape cannot be safely reduced as a known list.
  return { ...runMetadata(run), details_omitted: "Details exceed the model context limit; inspect the administrator review URL." };
}

export function operationTools(store: OperationsStore): Tool[] {
  const admin = (user?: { id: string; role: string }) => { if (!user?.id || user.role !== "admin") throw new AssistantError(403, "administrator required"); return user.id; };
  const schema = (properties: Record<string, any>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
  const str = { type: "string" };
  return [
    {
      name: "list_operations_resources", effect: "read",
      description: "Read registered websites, certificates, Compose projects or backup policies. Website and Compose bodies are omitted. This is saved configuration, not live host discovery; inspect successful operation receipts for observed state. Follow next_offset when the context budget shortens a page.",
      schema: schema({ kind: { type: "string", enum: ["website", "certificate", "compose", "backup"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
      execute: async (input, _signal, user) => {
        admin(user); object(input, ["kind", "offset", "limit"]);
        const offset = input.offset ?? 0, limit = input.limit ?? 20;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new AssistantError(400, "invalid pagination");
        const saved = store.list(input.kind), resources = saved.slice(offset, offset + limit).map(resourceForModel);
        const result = () => ({ resources, total: saved.length, offset, limit, returned: resources.length,
          next_offset: offset + resources.length < saved.length ? offset + resources.length : null,
          model_truncated: resources.length < Math.min(limit, Math.max(0, saved.length - offset)) });
        while (resources.length > 1 && size(result()) > RESULT_LIMIT) resources.pop();
        if (resources.length && size(result()) > RESULT_LIMIT) {
          resources[0] = { ...resources[0], config: { details_omitted: "Configuration exceeds the model context limit; inspect it in the administrator UI." } };
        }
        return result();
      },
    },
    {
      name: "get_operations_run", effect: "read",
      description: "Read an operations plan or real Agent receipt by run ID. queued is not success; unknown requires host inspection. Website/Compose bodies and raw business logs are omitted; large receipt lists are explicitly truncated. Administrators can inspect full details at review_url. This cannot approve or execute operations.",
      schema: schema({ id: str }, ["id"]),
      execute: async (input, _signal, user) => {
        admin(user); object(input, ["id"], ["id"]);
        return { run: runForModel(store.getRun(String(input.id))) };
      },
    },
    {
      name: "propose_operations_action", effect: "draft",
      description: "Create a reviewable plan for an EXISTING registered website/certificate/Compose/backup resource. Never approves or executes. The administrator must open review_url and confirm. Use generation/hash from an observed receipt for guarded operations. If inputs are uncertain ask the user; do not invent IDs, generations or backup digests.",
      schema: schema({ resource_id: str, operation: str, input: { type: "object", additionalProperties: true } }, ["resource_id", "operation"]),
      execute: async (input, _signal, user) => {
        const actor = admin(user); object(input, ["resource_id", "operation", "input"], ["resource_id", "operation"]);
        const run = store.plan(String(input.resource_id), String(input.operation), input.input ?? {}, actor);
        // Once persisted, a draft must always return its ID and review URL.
        // Returning only bounded metadata avoids post-write context-size errors.
        return { run: runMetadata(run) };
      },
    },
  ];
}
