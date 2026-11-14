import { AssistantError, object, type Tool } from "./types.js";
import type { OperationsStore } from "../operations/types.js";
import { OperationsReadService } from "../operations/read.js";

export function operationTools(store: OperationsStore): Tool[] {
  const reads = new OperationsReadService(store);
  const admin = (user?: { id: string; role: string }) => { if (!user?.id || user.role !== "admin") throw new AssistantError(403, "administrator required"); return user.id; };
  const schema = (properties: Record<string, any>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
  const str = { type: "string" };
  return [
    {
      name: "list_operations_resources", effect: "read",
      description: "Read registered websites, certificates, Compose projects or backup policies. Website and Compose bodies are omitted. This is saved configuration, not live host discovery; inspect successful operation receipts for observed state. Follow next_offset when the context budget shortens a page.",
      schema: schema({ kind: { type: "string", enum: ["website", "certificate", "compose", "backup"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
      execute: async (input, _signal, user) => { admin(user); object(input, ["kind", "offset", "limit"]); return reads.listResources(input); },
    },
    {
      name: "get_operations_run", effect: "read",
      description: "Read an operations plan or real Agent receipt by run ID. queued is not success; unknown requires host inspection. Website/Compose bodies and raw business logs are omitted; large receipt lists are explicitly truncated. Administrators can inspect full details at review_url. This cannot approve or execute operations.",
      schema: schema({ id: str }),
      execute: async (input, _signal, user) => { admin(user); object(input, ["id"]); return reads.getRun(String(input.id)); },
    },
    {
      name: "propose_operations_action", effect: "draft",
      description: "Create a reviewable plan for an EXISTING registered website/certificate/Compose/backup resource. Never approves or executes. The administrator must open review_url and confirm. Use generation/hash from an observed receipt for guarded operations. If inputs are uncertain ask the user; do not invent IDs, generations or backup digests.",
      schema: schema({ resource_id: str, operation: str, input: { type: "object", additionalProperties: true } }, ["resource_id", "operation"]),
      execute: async (input, _signal, user) => {
        const actor = admin(user); object(input, ["resource_id", "operation", "input"], ["resource_id", "operation"]);
        const run = store.plan(String(input.resource_id), String(input.operation), input.input ?? {}, actor);
        return { run: reads.metadata(run) };
      },
    },
  ];
}
