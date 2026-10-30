import { object, text, type Tool } from "./types.js";

/** Deliberately excludes apply, commit, rollback execution and download tickets. */
export interface AgentUpdateAssistantStore {
  listReleases(): any[];
  assistantPlan(machineID: string, input: { action: "upgrade" | "rollback"; target_sha256?: string; credential_id?: string }, actorID: string, signal: AbortSignal): Promise<any>;
  assistantGet(machineID: string, updateID: string): any;
}
const string = { type: "string" };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const admin = (user: {role?: string} | undefined) => { if (user?.role !== "admin") throw Error("administrator required"); };

export function agentUpdateTools(store: AgentUpdateAssistantStore): Tool[] {
  return [
    {
      name: "list_agent_releases", effect: "read",
      description: "List actually available Agent releases, architecture, source revision, build ID and immutable SHA256. A platform image update does not update existing host Agents. Compare build and SHA, not only version.",
      schema: schema({}),
      execute: async (input, _signal, user) => { admin(user); object(input, []); return { releases: store.listReleases() }; },
    },
    {
      name: "propose_agent_update", effect: "draft",
      description: "Prepare a reviewable Agent upgrade or rollback plan for a registered host. This performs a fixed read-only SSH probe using an existing credential; it never changes the host, starts an upgrade, or reveals secrets. Upgrade requires a target SHA256 from list_agent_releases. Rollback selects the retained previous release. Return review_url for the administrator to explicitly approve in host management.",
      schema: schema({ machine_id: string, action: { type: "string", enum: ["upgrade", "rollback"] }, target_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, credential_id: string }, ["machine_id", "action"]),
      execute: async (input, signal, user) => {
        admin(user); object(input, ["machine_id", "action", "target_sha256", "credential_id"], ["machine_id", "action"]);
        if (input.action !== "upgrade" && input.action !== "rollback") throw Error("invalid Agent update action");
        if (input.action === "upgrade" && (typeof input.target_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.target_sha256))) throw Error("reviewed target SHA256 required");
        if (input.action === "rollback" && input.target_sha256 != null) throw Error("rollback selects the retained previous release");
        return store.assistantPlan(text(input.machine_id), { action: input.action,
          ...(input.target_sha256 == null ? {} : { target_sha256: input.target_sha256 }),
          ...(input.credential_id == null ? {} : { credential_id: text(input.credential_id) }),
        }, user!.id, signal);
      },
    },
    {
      name: "get_agent_update", effect: "read",
      description: "Read a sanitized Agent upgrade/rollback plan and result. Only succeeded proves a confirmed target; rolled_back means the update failed and the previous program was restored. Unknown requires human reconciliation and must never be reported as success. No SSH output, control/data credentials, tickets or raw logs are returned.",
      schema: schema({ machine_id: string, update_id: string }, ["machine_id", "update_id"]),
      execute: async (input, _signal, user) => { admin(user); object(input, ["machine_id", "update_id"], ["machine_id", "update_id"]); return store.assistantGet(text(input.machine_id), text(input.update_id)); },
    },
  ];
}
