import type { DB } from "../shared/types.js";
import { fail } from "../shared/http.js";

export const hasUninstallationTable = (db: DB) => !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='machine_uninstallations'");
export function pendingMachineUninstallation(db: DB, machineID: string, agentID = "") {
  if (!hasUninstallationTable(db)) return undefined;
  return db.get<{id:string;status:string}>(`SELECT id,status FROM machine_uninstallations
    WHERE ((?<>'' AND machine_id=?) OR (?<>'' AND agent_id=?))
    AND status IN ('awaiting_approval','running','unknown') LIMIT 1`, machineID, machineID, agentID, agentID);
}
export function assertNoPendingMachineUninstallation(db: DB, machineID: string, agentID = "") {
  if (pendingMachineUninstallation(db, machineID, agentID)) fail(409, "主机有待审批、运行中或结果未知的 Agent 卸载，请先完成、取消或核对");
}
