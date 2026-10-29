import type { DB } from "../shared/types.js";
import { fail } from "../shared/http.js";

export interface AgentLifecycle {
  lifecycle_state: "active" | "removed";
  removed_at: string;
  removal_reason: string;
}

/** Durable tombstones are independent of credentials and telemetry retention. */
export function createAgentLifecycleSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_lifecycle(
      agent_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('active','removed')),
      removed_at TEXT NOT NULL DEFAULT '',
      removed_by TEXT NOT NULL DEFAULT '',
      removal_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS agent_lifecycle_events(
      id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,event TEXT NOT NULL,
      actor_id TEXT NOT NULL,occurred_at TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',
      revoked_credentials INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS agent_lifecycle_events_agent ON agent_lifecycle_events(agent_id,occurred_at);
  `);
}

export const isAgentRemoved = (db: DB, agentID: string): boolean =>
  Boolean(db.get("SELECT agent_id FROM agent_lifecycle WHERE agent_id=? AND state='removed'", agentID));

export function agentLifecycle(db: DB, agentID: string): AgentLifecycle {
  const row = db.get<{ state: "active" | "removed"; removed_at: string; removal_reason: string }>(
    "SELECT state,removed_at,removal_reason FROM agent_lifecycle WHERE agent_id=?", agentID,
  );
  return { lifecycle_state: row?.state ?? "active", removed_at: row?.removed_at ?? "", removal_reason: row?.removal_reason ?? "" };
}

export function assertAgentActive(db: DB, agentID: string, status = 409): void {
  if (isAgentRemoved(db, agentID)) fail(status, "节点已移除；重新接入需要创建新的 Agent 身份");
}
