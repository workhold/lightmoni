import type { DB } from "../shared/types.js";
import { fail } from "../shared/http.js";
import { pendingAgentRuntime } from './machine-agent-runtime-guard.js';
import { pendingMaintenancePreparation } from './machine-maintenance.js';

export function hasPendingAgentUpdate(db: DB, agentID: string, machineID = "", preparationToken = ""): boolean {
  if(pendingMaintenancePreparation(db,agentID,machineID,preparationToken))return true;
  if(pendingAgentRuntime(db,machineID,agentID))return true;
  if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='machine_agent_updates'")) return false;
  return Boolean(db.get("SELECT id FROM machine_agent_updates WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND status IN ('awaiting_approval','running','verifying','unknown') LIMIT 1", agentID, machineID, machineID));
}
export function assertNoPendingAgentUpdate(db: DB, agentID: string, machineID = "", preparationToken = ""): void {
  if (hasPendingAgentUpdate(db, agentID, machineID,preparationToken)) fail(409, "Agent 有待审批、运行中或结果未知的升级/回退，请先完成、取消或核对");
}
