import type { DB } from "../shared/types.js";
import { fail } from "../shared/http.js";

export const hasInstallationTable = (db: DB) => !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='machine_deployments'");
export function unresolvedInstallationSQL(db: DB, alias = "", approval = false): string {
  const prefix = alias ? alias + "." : "";
  const resolved = db.all<{name:string}>("PRAGMA table_info(machine_deployments)").some(column => column.name === "resolved_at");
  return `(${prefix}status IN (${approval ? "'awaiting_approval'," : ""}'running','unknown')${resolved ? ` AND ${prefix}resolved_at=''` : ""})`;
}
export function pendingMachineInstallation(db: DB, machineID: string, agentID = "", approval = false, excludeID = "") {
  if (!hasInstallationTable(db)) return undefined;
  return db.get<{id:string;status:string}>(`SELECT d.id,d.status FROM machine_deployments d
    WHERE (d.machine_id=? OR (?<>'' AND EXISTS (SELECT 1 FROM managed_machines m WHERE m.id=d.machine_id AND m.agent_id=?)))
    AND d.id!=? AND ${unresolvedInstallationSQL(db,"d",approval)} ORDER BY d.created_at,d.id LIMIT 1`, machineID, agentID, agentID, excludeID);
}
export function assertNoPendingMachineInstallation(db: DB, machineID: string, agentID = "", approval = false, excludeID = "") {
  if (pendingMachineInstallation(db,machineID,agentID,approval,excludeID)) fail(409,"主机有运行中或结果待核对的 Agent 安装，请先核对或明确结束");
}
