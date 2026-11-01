import { pendingDockerInstallation } from './machine-docker-guard.js';
import type { DB } from "../shared/types.js";
import { fail } from "../shared/http.js";
import { isAgentRemoved } from "./agent-lifecycle.js";
import { hasPendingAgentUpdate } from "./machine-agent-updates-guard.js";

/** Shared by node registration and host management, regardless of startup order. */
export function createAgentHostSchema(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS managed_machines(
    id TEXT PRIMARY KEY,name TEXT NOT NULL,address TEXT NOT NULL,port INTEGER NOT NULL,
    username TEXT NOT NULL,connection_method TEXT NOT NULL,host_key_fingerprint TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',arch TEXT NOT NULL DEFAULT '',agent_id TEXT NOT NULL DEFAULT '',
    agent_last_seen TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,observed_hostname TEXT NOT NULL DEFAULT ''
  );`);
  const columns = new Set(db.all<{name:string}>("PRAGMA table_info(managed_machines)").map(row => row.name));
  for (const [name, definition] of [
    ["observed_hostname", "TEXT NOT NULL DEFAULT ''"],
    ["host_key_public_key", "TEXT NOT NULL DEFAULT ''"],
    ["host_key_observed_at", "TEXT NOT NULL DEFAULT ''"],
    ["ssh_target_generation", "INTEGER NOT NULL DEFAULT 0"],
  ]) if (!columns.has(name)) db.exec(`ALTER TABLE managed_machines ADD COLUMN ${name} ${definition}`);
}

const observation = (value: unknown, max: number): string => {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  // Never let unbounded, client supplied strings become asset names or fields.
  return Buffer.byteLength(clean) <= max ? clean : "";
};
const table = (db: DB, name: string) => Boolean(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));

/** A host's unowned legacy cache must never identify its current Agent. */
export function currentAgentHostname(db: DB, machineID: string, agentID: string): string {
  if (!agentID || isAgentRemoved(db, agentID) || !table(db, "agents")) return "";
  const agent = db.get<Record<string, unknown>>(
    "SELECT a.* FROM managed_machines m JOIN agents a ON a.id=m.agent_id WHERE m.id=? AND m.agent_id=?",
    machineID, agentID,
  );
  return observation(agent?.hostname, 128);
}

/** Unknown attempts remain a barrier until explicitly retried or reviewed. */
export function hasActiveTaskRuns(db: DB, agentID: string, hostID = ""): boolean {
  if (table(db,"machine_executor_bootstraps") && db.get("SELECT id FROM machine_executor_bootstraps WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND status IN ('running','verifying','unknown') LIMIT 1",agentID,hostID,hostID)) return true;
  if (!table(db, "task_runs")) return false;
  return !!db.get("SELECT id FROM task_runs WHERE (agent_id=? OR (?<>'' AND host_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND superseded_by='' AND resolved_at='')) LIMIT 1", agentID, hostID, hostID);
}

/** A new identity may replace a retired one only after it can no longer act. */
export function replaceableAgentBinding(db: DB, agentID: string, at: string): boolean {
  if (!agentID) return true;
  if (hasPendingAgentUpdate(db, agentID) || pendingDockerInstallation(db,"",agentID)) return false;
  if (hasActiveTaskRuns(db, agentID)) return false;
  if (table(db, "agent_jobs") && db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1", agentID)) return false;
  if (table(db, "machine_uninstallations") && db.get("SELECT id FROM machine_uninstallations WHERE agent_id=? AND status IN ('awaiting_approval','running','unknown') LIMIT 1", agentID)) return false;
  if (isAgentRemoved(db, agentID)) return true;
  if (!table(db, "agent_credentials")) return false;
  const audiences = db.all<{audience:string}>("SELECT DISTINCT audience FROM agent_credentials WHERE agent_id=?", agentID).map(row => row.audience);
  return ["control", "data"].every(audience => audiences.includes(audience)) && !db.get("SELECT id FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL AND expires_at>? LIMIT 1", agentID, at);
}

/** Must run in the caller's write transaction, after authenticating the Agent. */
export function ensureAgentHost(db: DB, agentID: string, values: Record<string, unknown>, at: string): { machine_id: string; machine_name: string } {
  if (isAgentRemoved(db, agentID)) fail(401, "节点已移除；重新接入需要创建新的 Agent 身份");
  const hostname = observation(values.hostname, 128);
  const current = db.get<{id:string;name:string}>("SELECT id,name FROM managed_machines WHERE agent_id=? ORDER BY created_at,id LIMIT 1", agentID);
  // The target is recorded by the trusted SSH workflow before the installer can
  // activate. No value in an Agent heartbeat may choose a platform asset ID.
  const enrollmentColumns = table(db, "agent_enrollments") ? db.all<{name:string}>("PRAGMA table_info(agent_enrollments)") : [];
  const enrollment = enrollmentColumns.some(column => column.name === "machine_id")
    ? db.get<{machine_id:string}>("SELECT machine_id FROM agent_enrollments WHERE agent_id=? AND status='active' ORDER BY created_at DESC LIMIT 1", agentID)
    : undefined;
  if (!enrollment?.machine_id) fail(409, "registered_host_required: 请先登记主机，再从主机管理部署 Agent");
  const target = db.get<{id:string;name:string;agent_id:string}>("SELECT id,name,agent_id FROM managed_machines WHERE id=?", enrollment.machine_id);
  if (!target || target.agent_id !== agentID || current && current.id !== target.id)
    fail(409, "registered_host_required: 安装预约的主机已删除或关联已变化，请重新核对");
  db.run("UPDATE managed_machines SET observed_hostname=?,agent_last_seen=? WHERE id=?", hostname, at, target.id);
  return { machine_id: target.id, machine_name: target.name };
}
