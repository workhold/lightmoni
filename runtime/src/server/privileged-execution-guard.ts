import type { DB } from "../shared/sqlite.js";
import { fail } from "../shared/http.js";

/** Root jobs own a host-wide write fence, including unresolved outcomes. */
export function hasPendingExecutorLifecycle(db: DB,machineID="",agentID=""):boolean {
  if (db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='machine_executor_bootstraps'")
    && db.get(`SELECT id FROM machine_executor_bootstraps WHERE ((?<>'' AND machine_id=?) OR (?<>'' AND agent_id=?)) AND status IN ('running','verifying','unknown') LIMIT 1`,machineID,machineID,agentID,agentID)) return true;
  if (db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='machine_executor_maintenance'")
    && db.get(`SELECT id FROM machine_executor_maintenance WHERE (machine_id=? OR (?<>'' AND machine_id IN (SELECT id FROM managed_machines WHERE agent_id=?))) AND status IN ('awaiting_approval','running','unknown') LIMIT 1`,machineID,agentID,agentID)) return true;
  return false;
}
export function hasPrivilegedExecution(db: DB, machineID = "", agentID = ""): boolean {
  if(hasPendingExecutorLifecycle(db,machineID,agentID)) return true;
  if (!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_runs'")) return false;
  return !!db.get(`SELECT id FROM task_runs WHERE execution_principal='privileged_executor'
    AND ((?<>'' AND host_id=?) OR (?<>'' AND agent_id=?))
    AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='')) LIMIT 1`, machineID, machineID, agentID, agentID);
}
export function assertNoPrivilegedExecution(db: DB, machineID = "", agentID = "") {
  if (hasPrivilegedExecution(db, machineID, agentID)) fail(409, "privileged_execution_pending: 请先结束或核对主机的提权任务");
}
