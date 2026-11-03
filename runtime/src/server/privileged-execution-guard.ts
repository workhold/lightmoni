import type { DB } from "../shared/sqlite.js";
import { fail } from "../shared/http.js";
import { pendingAgentRuntime } from './machine-agent-runtime-guard.js';

/** Root jobs own a host-wide write fence, including unresolved outcomes. */
export function hasPendingExecutorLifecycle(db: DB,machineID="",agentID=""):boolean {
  if(pendingAgentRuntime(db,machineID,agentID))return true;
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

/** Admission may queue behind a proven managed job; claim still owns the host lane. */
export function assertManagedJobAdmission(db: DB, agentID: string) {
  if (hasPendingExecutorLifecycle(db, "", agentID)) fail(409, "privileged_execution_pending");
  if (!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_runs'")) return;
  const bridged = !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='privileged_jobs'");
  const blocked = db.get(`SELECT t.id FROM task_runs t WHERE t.agent_id=? AND t.execution_principal='privileged_executor'
    AND (t.state IN ('queued','running') OR (t.state='unknown' ${bridged ? `AND NOT EXISTS (
      SELECT 1 FROM privileged_jobs resolved
      WHERE resolved.id=t.id AND resolved.task_run_id=t.id AND resolved.agent_id=t.agent_id AND resolved.machine_id=t.host_id
        AND resolved.state='unknown'
        AND (resolved.capability<>'operations.managed.v1' OR EXISTS (SELECT 1 FROM agent_jobs original WHERE original.id=resolved.id
          AND original.state='unknown' AND original.agent_id=t.agent_id AND original.execution_principal='privileged_executor'))
        AND resolved.resolved_at<>'' AND resolved.resolved_by<>'' AND trim(resolved.resolution_reason)<>''
        AND t.resolved_at<>'' AND t.resolved_by<>'' AND trim(t.resolution_reason)<>'')` : ""}))
    ${bridged ? `AND NOT EXISTS (SELECT 1 FROM privileged_jobs p JOIN agent_jobs a ON a.id=p.id
      WHERE p.id=t.id AND p.task_run_id=t.id AND p.agent_id=t.agent_id AND a.agent_id=t.agent_id
        AND p.machine_id=t.host_id AND a.execution_principal='privileged_executor'
        AND p.capability='operations.managed.v1' AND p.state=t.state
        AND t.state IN ('queued','running') AND (a.state='queued' OR a.state IN ('leased','accepted','preflighting','staging','activating','verifying')))` : ""}
    LIMIT 1`, agentID);
  if (blocked) fail(409, "privileged_execution_pending: 请先结束或核对主机的提权任务");
}
