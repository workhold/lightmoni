import type { DB } from "../shared/types.js";
import { fail } from "../shared/http.js";
export function pendingAgentRuntime(
  db: DB,
  machineID = "",
  agentID = "",
  exclude = "",
) {
  if (
    !db.get(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='machine_agent_runtime_plans'",
    )
  )
    return undefined;
  return db.get<{ id: string; status: string }>(
    "SELECT id,status FROM machine_agent_runtime_plans WHERE ((?<>'' AND machine_id=?) OR (?<>'' AND agent_id=?)) AND id!=? AND status IN ('awaiting_approval','running','verifying','unknown') ORDER BY created_at,id LIMIT 1",
    machineID,
    machineID,
    agentID,
    agentID,
    exclude,
  );
}
export function assertNoPendingAgentRuntime(
  db: DB,
  machineID = "",
  agentID = "",
  exclude = "",
) {
  if (pendingAgentRuntime(db, machineID, agentID, exclude))
    fail(
      409,
      "agent_runtime_maintenance_pending: 请先完成、取消或核对 Agent 运行权限维护",
    );
}
