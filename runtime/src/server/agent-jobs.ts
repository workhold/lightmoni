import { id, token } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import type { Context, Dependencies, Handler, Module } from "../shared/types.js";
import type { AgentCredentialStore } from "./agent-credentials.js";

/**
 * Durable, pull based execution jobs.  A job is immutable after enqueue: the
 * Agent can only lease it and report an event/result for the exact actions
 * that the centre stored.  This module intentionally does not execute host
 * commands; that boundary belongs to the Agent capability executor.
 */
export type AgentJobState =
  | "queued"
  | "leased"
  | "accepted"
  | "preflighting"
  | "staging"
  | "activating"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type AgentJobEventPhase = Exclude<AgentJobState, "queued" | "leased">;

export interface AgentJobInput {
  agentID: string;
  deploymentID: string;
  operationID: string;
  actions: unknown[];
  capabilities?: string[];
  target?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export interface AgentJobUpdate {
  agentID: string;
  deploymentID: string;
  operationID: string;
  jobID: string;
  phase: AgentJobEventPhase;
  code: string;
  healthVerified?: boolean;
  previousState?: AgentJobState;
  snapshot?: Record<string, unknown>;
}

export interface AgentJobStore {
  enqueue(input: AgentJobInput): Record<string, any>;
  claim(agentID: string, capabilities: string[], receiptCursor?: string): Record<string, any> | null;
  event(agentID: string, jobID: string, input: Record<string, any>): Record<string, any>;
  result(agentID: string, jobID: string, input: Record<string, any>): Record<string, any>;
  cancel(jobID: string, actor: string): Record<string, any>;
  /** Cancel only an unclaimed job belonging to this deployment operation. */
  cancelQueuedDeployment(deploymentID: string, operationID: string, actor: string): Record<string, any>;
  get(jobID: string): Record<string, any>;
  /** Internal synchronous observer; invoked inside the job's SQLite transaction. */
  onUpdate(listener: (update: AgentJobUpdate) => void): () => void;
}

const MAX_JSON_BYTES = 128 << 10;
const MAX_SUMMARY_BYTES = 1000;
const LEASE_SECONDS = 45;
const JOB_SECONDS = 15 * 60;
const CAPABILITY = /^[a-z][a-z0-9_.-]{0,63}$/;
const STATES = new Set<AgentJobState>([
  "queued", "leased", "accepted", "preflighting", "staging", "activating", "verifying",
  "succeeded", "failed", "cancelled", "unknown",
]);
const EVENT_PHASES = new Set<AgentJobEventPhase>([
  "accepted", "preflighting", "staging", "activating", "verifying", "succeeded", "failed", "cancelled", "unknown",
]);
const terminal = (state: AgentJobState) => ["succeeded", "failed", "cancelled", "unknown"].includes(state);
const EVENT_ORDER: Partial<Record<AgentJobEventPhase, number>> = { accepted: 0, preflighting: 1, staging: 1, activating: 2, verifying: 3 };
const readOnlyPreflight = (job: any) => {
  try {
    const actions = JSON.parse(job.actions_json || "[]"), caps = JSON.parse(job.capabilities_json || "[]");
    return actions.length === 1 && actions[0]?.kind === "systemd_probe" && /^[a-f0-9]{32}$/.test(actions[0]?.preflightID ?? "")
      && /^[a-f0-9]{64}$/i.test(actions[0]?.targetRevision ?? "") && caps.length === 1 && caps[0] === "systemd.probe";
  } catch { return false; }
};
const preflightAction = (job: any) => {
  try {
    const actions = JSON.parse(job.actions_json || "[]"), caps = JSON.parse(job.capabilities_json || "[]");
    return actions.length === 1 && actions[0]?.kind === "systemd_probe" && caps.length === 1 && caps[0] === "systemd.probe" ? actions[0] : undefined;
  } catch { return undefined; }
};
const preflightSnapshot = (input: any, job: any, now: Date) => {
  const value = input?.preflight;
  if (!value || value.provider !== "systemd" || typeof value.ready !== "boolean"
    || typeof value.systemd_available !== "boolean" || typeof value.unit_exists !== "boolean"
    || typeof value.filesystem_check_supported !== "boolean"
    || typeof value.release_directory_exists !== "boolean" || typeof value.release_directory_writable !== "boolean"
    || !(value.enabled === true || value.enabled === false || value.enabled === "unknown")
    || !["enabled", "enabled-runtime", "disabled", "static", "indirect", "masked", "masked-runtime", "linked", "linked-runtime", "alias", "generated", "transient", "unknown"].includes(value.unit_file_state)
    || !["active", "reloading", "inactive", "failed", "activating", "deactivating", "maintenance", "refreshing", "unknown"].includes(value.active_state)
    || typeof value.current_version !== "string" || (value.current_version !== "" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.current_version))
    || typeof value.observed_at !== "string" || !Number.isFinite(Date.parse(value.observed_at))) return undefined;
  const action = preflightAction(job), observedAt = Date.parse(value.observed_at);
  const createdAt = Date.parse(job.created_at);
  if (!action || value.preflight_id !== action.preflightID || value.target_revision !== action.targetRevision
    || !Number.isFinite(createdAt) || observedAt < createdAt - 60_000 || observedAt > now.getTime() + 60_000) return undefined;
  const ready = value.filesystem_check_supported && value.systemd_available && value.unit_exists && ["active", "inactive"].includes(value.active_state)
    && !["masked", "masked-runtime"].includes(value.unit_file_state)
    && value.release_directory_exists && value.release_directory_writable;
  if (value.ready !== ready) return undefined;
  return {
    health: { healthy: true },
    preflight: {
      provider: "systemd", ready, systemd_available: value.systemd_available,
      unit_exists: value.unit_exists, active_state: value.active_state, enabled: value.enabled, unit_file_state: value.unit_file_state,
      release_directory_exists: value.release_directory_exists,
      filesystem_check_supported: value.filesystem_check_supported, release_directory_writable: value.release_directory_writable,
      current_version: value.current_version, observed_at: new Date(value.observed_at).toISOString(),
      preflight_id: action.preflightID, target_revision: action.targetRevision,
    },
  };
};
const safePreflightCode = (code: string) => new Set([
  "job_expired", "capability_denied", "invalid_preflight_result", "systemd_failed",
  "execution_cancelled", "execution_failed", "unknown_execution_result", "prerequisites_missing",
]).has(code) ? code : "preflight_failed";

const object = (value: unknown, field: string): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, `invalid ${field}`);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_JSON_BYTES) fail(413, `${field} is too large`);
  return value as Record<string, any>;
};
const text = (value: unknown, field: string, max = 256, required = true) => {
  if (value == null && !required) return "";
  if (typeof value !== "string" || (required && !value.trim()) || Buffer.byteLength(value) > max)
    fail(400, `invalid ${field}`);
  return value.trim();
};
const eventSummary = (value: unknown) => text(value ?? "", "summary", MAX_SUMMARY_BYTES, false);
const iso = (deps: Dependencies, date = deps.now()) => date.toISOString();
const json = (value: unknown) => JSON.stringify(value ?? {});

function view(row: any): Record<string, any> {
  return {
    id: row.id,
    agent_id: row.agent_id,
    deployment_id: row.deployment_id,
    operation_id: row.operation_id,
    state: row.state,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    lease_expires_at: row.lease_expires_at || "",
    lease_id: row.lease_id || "",
    capabilities: JSON.parse(row.capabilities_json || "[]"),
    actions: JSON.parse(row.actions_json || "[]"),
    target: JSON.parse(row.target_json || "{}"),
    attempts: row.attempts || 0,
    receipt: JSON.parse(row.receipt_json || "{}"),
  };
}

export function registerAgentJobs(
  deps: Dependencies,
  options: { agentCredentials?: AgentCredentialStore; expirySweepIntervalMs?: number } = {},
): Module & AgentJobStore {
  const { db, router } = deps;
  const updateListeners = new Set<(update: AgentJobUpdate) => void>();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const notify = (job: any, phase: AgentJobEventPhase, code = "", details: { healthVerified?: boolean; previousState?: AgentJobState; snapshot?: Record<string, unknown> } = {}) => {
    const update: AgentJobUpdate = {
      agentID: String(job.agent_id),
      deploymentID: String(job.deployment_id),
      operationID: String(job.operation_id),
      jobID: String(job.id),
      phase,
      code,
      ...details,
    };
    for (const listener of updateListeners) listener(update);
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_jobs(
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      state TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      actions_json TEXT NOT NULL DEFAULT '[]',
      target_json TEXT NOT NULL DEFAULT '{}',
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL DEFAULT '',
      lease_id TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(deployment_id,operation_id)
    );
    CREATE INDEX IF NOT EXISTS agent_jobs_claim ON agent_jobs(agent_id,state,expires_at,created_at);
    CREATE TABLE IF NOT EXISTS agent_job_events(
      job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      phase TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      PRIMARY KEY(job_id,sequence)
    );
  `);

  const row = (jobID: string) => {
    const value = db.get<any>("SELECT * FROM agent_jobs WHERE id=?", jobID);
    if (!value) fail(404, "agent job not found");
    return value;
  };
  const ensureAgent = (agentID: string) => {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(agentID)) fail(400, "invalid agent_id");
    return agentID;
  };
  const capabilities = (value: unknown): string[] => {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 64 || value.some((v) => typeof v !== "string" || !CAPABILITY.test(v)))
      fail(400, "invalid capabilities");
    return [...new Set(value)].sort();
  };
  const actions = (value: unknown): unknown[] => {
    if (!Array.isArray(value) || value.length > 64) fail(400, "invalid actions");
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_JSON_BYTES) fail(413, "actions is too large");
    return value;
  };
  const authenticate = (ctx: Context, agentID: string) => {
    if (!options.agentCredentials) fail(503, "agent credentials unavailable");
    return options.agentCredentials.authenticate(ctx.req, ensureAgent(agentID), "control");
  };
  const expireLeases = () => {
    const at = iso(deps);
    for (const queued of db.all<any>(
      "SELECT id,state FROM agent_jobs WHERE state='queued' AND expires_at<=?",
      at,
    )) {
      db.transaction(() => {
        const changed = db.run(
          "UPDATE agent_jobs SET state='cancelled',receipt_json=?,updated_at=? WHERE id=? AND state='queued' AND expires_at<=?",
          json({ state: "cancelled", code: "job_expired", summary: "Agent job expired before it was claimed" }), at, queued.id, at,
        );
        if (changed.changes) {
          const next = Number(db.get<any>("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM agent_job_events WHERE job_id=?", queued.id)?.sequence ?? 1);
          db.run(
            "INSERT OR IGNORE INTO agent_job_events(job_id,sequence,phase,code,summary,occurred_at) VALUES(?,?,?,?,?,?)",
            queued.id, next, "cancelled", "job_expired", "Agent job expired before it was claimed", at,
          );
          notify(row(queued.id), "cancelled", "job_expired", { previousState: "queued" });
        }
      });
    }
    for (const old of db.all<any>(
      "SELECT id,state FROM agent_jobs WHERE state IN ('leased','accepted','preflighting','staging','activating','verifying') AND lease_expires_at<>'' AND lease_expires_at<=?",
      at,
    )) {
      db.transaction(() => {
        const changed = db.run(
          "UPDATE agent_jobs SET state='unknown',receipt_json=?,updated_at=?,lease_id='',lease_expires_at='' WHERE id=? AND state IN ('leased','accepted','preflighting','staging','activating','verifying')",
          json({ state: "unknown", code: "unknown_execution_result", summary: "Agent lease expired; execution result is unknown" }), at, old.id,
        );
        if (changed.changes) {
          const next = Number(db.get<any>("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM agent_job_events WHERE job_id=?", old.id)?.sequence ?? 1);
          db.run(
            "INSERT OR IGNORE INTO agent_job_events(job_id,sequence,phase,code,summary,occurred_at) VALUES(?,?,?,?,?,?)",
            old.id, next, "unknown", "unknown_execution_result", "Agent lease expired; execution result is unknown", at,
          );
          notify(row(old.id), "unknown", "unknown_execution_result", { previousState: old.state as AgentJobState });
        }
      });
    }
  };
  const enqueue = (input: AgentJobInput) => {
    const agentID = ensureAgent(input.agentID), deploymentID = text(input.deploymentID, "deployment_id"), operationID = text(input.operationID, "operation_id");
    const actionList = actions(input.actions), caps = capabilities(input.capabilities ?? []);
    const existing = db.get<any>("SELECT * FROM agent_jobs WHERE deployment_id=? AND operation_id=?", deploymentID, operationID);
    if (existing) return view(existing);
    const now = deps.now(), expires = new Date(now.getTime() + Math.min(Math.max(input.expiresInSeconds ?? JOB_SECONDS, 60), 24 * 60 * 60) * 1000), idValue = id();
    db.run(
      "INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,capabilities_json,actions_json,target_json,issued_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      idValue, agentID, deploymentID, operationID, "queued", json(caps), json(actionList), json(input.target ?? {}), iso(deps, now), iso(deps, expires), iso(deps, now), iso(deps, now),
    );
    return view(row(idValue));
  };
  const claim = (agentID: string, offered: string[], _cursor = "") => {
    ensureAgent(agentID);
    const caps = new Set(capabilities(offered));
    expireLeases();
    const at = deps.now(), nowText = iso(deps, at);
    const candidate = db.get<any>(
      "SELECT * FROM agent_jobs WHERE agent_id=? AND state='queued' AND expires_at>? ORDER BY created_at,id LIMIT 1",
      agentID, nowText,
    );
    if (!candidate) return null;
    const required = JSON.parse(candidate.capabilities_json || "[]") as string[];
    if (required.some((cap) => !caps.has(cap))) return null;
    const lease = token(), leaseExpires = new Date(at.getTime() + LEASE_SECONDS * 1000), changed = db.run(
      "UPDATE agent_jobs SET state='leased',lease_id=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='queued' AND expires_at>?",
      lease, iso(deps, leaseExpires), nowText, candidate.id, nowText,
    );
    if (!changed.changes) return null;
    return view(row(candidate.id));
  };
  const leaseRow = (agentID: string, jobID: string, leaseID: string) => {
    const value = row(jobID);
    if (value.agent_id !== agentID) fail(403, "agent job does not belong to agent");
    if (!leaseID || value.lease_id !== leaseID) fail(409, "agent job lease is invalid");
    if (value.lease_expires_at && Date.parse(value.lease_expires_at) <= deps.now().getTime()) {
      expireLeases();
      fail(409, "agent job lease expired");
    }
    return value;
  };
  const event = (agentID: string, jobID: string, input: Record<string, any>) => {
    const value = object(input, "event"), lease = text(value.lease_id, "lease_id", 256), stored = row(jobID);
    if (stored.agent_id !== agentID) fail(403, "agent job does not belong to agent");
    // Unknown is intentionally a hard boundary: a late completion after a
    // lease timeout must not overwrite the centre's need to re-probe. Other
    // terminal receipts are safe to return for idempotent retries.
    if (terminal(stored.state as AgentJobState) && stored.state !== "unknown") return view(stored);
    const current = leaseRow(agentID, jobID, lease);
    const sequence = value.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 100000) fail(400, "invalid sequence");
    const phase = text(value.phase, "phase", 32) as AgentJobEventPhase;
    if (!EVENT_PHASES.has(phase)) fail(400, "invalid phase");
    const isPreflight = readOnlyPreflight(stored);
    let hasPreflightAction = false;
    try { hasPreflightAction = JSON.parse(stored.actions_json || "[]").some((action: any) => action?.kind === "systemd_probe"); } catch {}
    if (hasPreflightAction && !isPreflight) fail(409, "systemd preflight job must be isolated");
    if ((isPreflight && ["staging", "activating", "verifying"].includes(phase)) || (!isPreflight && phase === "preflighting"))
      fail(409, "agent job phase does not match its actions");
    const originalSummary = eventSummary(value.summary), originalCode = text(value.code ?? "", "code", 128, false), originalSnapshot = value.snapshot == null ? {} : object(value.snapshot, "snapshot");
    const probeJob = readOnlyPreflight(current);
    const summary = probeJob ? (phase === "accepted" ? "Agent accepted read-only systemd preflight" : phase === "preflighting" ? "Agent inspected registered systemd target" : phase === "succeeded" ? "Read-only systemd preflight completed" : "Read-only systemd preflight state updated") : originalSummary;
    const code = probeJob ? (originalCode ? safePreflightCode(originalCode) : "") : originalCode;
    // A probe snapshot is accepted only from the final /result path, after the
    // strict whitelist below. Events never persist Agent-provided snapshot data.
    const snapshot = probeJob ? {} : originalSnapshot;
    const occurred = iso(deps);
    db.transaction(() => {
      const last = db.get<any>("SELECT * FROM agent_job_events WHERE job_id=? ORDER BY sequence DESC LIMIT 1", jobID);
      if (sequence <= Number(last?.sequence ?? 0)) {
        const duplicate = db.get<any>("SELECT * FROM agent_job_events WHERE job_id=? AND sequence=?", jobID, sequence);
        if (duplicate && duplicate.phase === phase && duplicate.code === code && duplicate.summary === summary && duplicate.snapshot_json === json(snapshot)) return;
        fail(409, "agent event sequence is not increasing");
      }
      if (sequence !== Number(last?.sequence ?? 0) + 1) fail(409, "agent event sequence has a gap");
      if (last && EVENT_ORDER[last.phase as AgentJobEventPhase] === undefined) fail(409, "agent job already has a terminal event");
      if (last && EVENT_ORDER[phase] !== undefined && EVENT_ORDER[last.phase as AgentJobEventPhase] !== undefined
        && EVENT_ORDER[phase]! < EVENT_ORDER[last.phase as AgentJobEventPhase]!) fail(409, "agent event phase cannot move backwards");
      if (phase === "succeeded" && current.state !== "verifying" && !(current.state === "preflighting" && readOnlyPreflight(current))) fail(409, "success event requires verification phase");
      db.run("INSERT INTO agent_job_events(job_id,sequence,phase,code,summary,snapshot_json,occurred_at) VALUES(?,?,?,?,?,?,?)", jobID, sequence, phase, code, summary, json(snapshot), occurred);
      // Terminal events are observations only; /result is authoritative.
      if (terminal(phase)) return;
      const allowed: AgentJobState[] = ["leased", "accepted", "preflighting", "staging", "activating", "verifying"];
      if (!allowed.includes(current.state as AgentJobState)) fail(409, "agent job is no longer running");
      const previousRank = current.state === "leased" ? -1 : EVENT_ORDER[current.state as AgentJobEventPhase];
      const nextRank = EVENT_ORDER[phase];
      if (previousRank == null || nextRank == null || nextRank < previousRank || nextRank > previousRank + 1)
        fail(409, "agent event phase is not a valid next step");
      db.run("UPDATE agent_jobs SET state=?,updated_at=?,lease_expires_at=? WHERE id=? AND lease_id=?", phase, occurred, iso(deps, new Date(deps.now().getTime() + LEASE_SECONDS * 1000)), jobID, lease);
      notify(row(jobID), phase, code, { previousState: current.state as AgentJobState, snapshot });
    });
    return view(row(jobID));
  };
  const result = (agentID: string, jobID: string, input: Record<string, any>) => {
    const value = object(input, "result"), lease = text(value.lease_id, "lease_id", 256), stored = row(jobID);
    if (stored.agent_id !== agentID) fail(403, "agent job does not belong to agent");
    // A lost HTTP response may cause the Agent to retry its final receipt.
    // Return the durable terminal receipt instead of requiring a lease that
    // was deliberately cleared after the first commit.
    // Unknown is intentionally a hard boundary: a late completion after a
    // lease timeout must not overwrite the centre's need to re-probe. Other
    // terminal receipts are safe to return for idempotent retries.
    if (terminal(stored.state as AgentJobState) && stored.state !== "unknown") return view(stored);
    const current = leaseRow(agentID, jobID, lease);
    let state = text(value.state, "state", 32) as AgentJobState;
    if (!["succeeded", "failed", "cancelled", "unknown"].includes(state)) fail(400, "invalid result state");
    let code = text(value.code ?? "", "code", 128, false), summary = eventSummary(value.summary), snapshot = value.snapshot == null ? {} : object(value.snapshot, "snapshot");
    if (readOnlyPreflight(current)) {
      code = code ? safePreflightCode(code) : "";
      summary = state === "succeeded" ? "Read-only systemd preflight completed" : state === "failed" ? "Read-only systemd preflight failed" : "Read-only systemd preflight result requires review";
      if (state === "succeeded") {
        const sanitized = preflightSnapshot(snapshot, current, deps.now());
        if (!sanitized) {
          state = "failed";
          code = "invalid_preflight_result";
          summary = "Read-only systemd preflight returned an invalid structured result";
          snapshot = {};
        } else snapshot = sanitized;
      } else snapshot = {};
    }
    const validSuccessPhase = readOnlyPreflight(current) ? current.state === "preflighting" : current.state === "verifying";
    if (state === "succeeded" && (!validSuccessPhase || (snapshot as any).health?.healthy !== true)) {
      state = "unknown";
      code = "invalid_agent_sequence";
      summary = "Agent success receipt did not include a completed healthy verification";
      snapshot = {};
    } else if (state === "cancelled") {
      state = "unknown";
      code = "unknown_execution_result";
      summary = "Agent reported cancellation after claiming the job; target state requires re-check";
      snapshot = {};
    }
    const receipt = {
      state, code, summary, snapshot, started_at: text(value.started_at ?? "", "started_at", 64, false), finished_at: text(value.finished_at ?? iso(deps), "finished_at", 64, false),
    };
    const occurred = iso(deps);
    db.transaction(() => {
      const changed = db.run("UPDATE agent_jobs SET state=?,receipt_json=?,updated_at=?,lease_id='',lease_expires_at='' WHERE id=? AND lease_id=? AND state NOT IN ('succeeded','failed','cancelled','unknown')", state, json(receipt), occurred, jobID, lease);
      if (!changed.changes) return;
      const next = Number(db.get<any>("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM agent_job_events WHERE job_id=?", jobID)?.sequence ?? 1);
      db.run("INSERT OR IGNORE INTO agent_job_events(job_id,sequence,phase,code,summary,snapshot_json,occurred_at) VALUES(?,?,?,?,?,?,?)", jobID, next, state, code, summary, json(receipt.snapshot), occurred);
      notify(row(jobID), state as AgentJobEventPhase, code, {
        healthVerified: state === "succeeded" && (snapshot as any).health?.healthy === true,
        previousState: current.state as AgentJobState,
        snapshot: snapshot as Record<string, unknown>,
      });
    });
    return view(row(jobID));
  };
  const cancel = (jobID: string, actor: string) => {
    const current = row(jobID);
    if (terminal(current.state as AgentJobState)) return view(current);
    const at = iso(deps);
    const safelyQueued = current.state === "queued";
    const state: AgentJobState = safelyQueued ? "cancelled" : "unknown";
    const code = safelyQueued ? "cancelled" : "unknown_execution_result";
    const summary = safelyQueued
      ? `cancelled by ${actor}`
      : `Cancellation requested by ${actor} after Agent claim; target state requires re-check`;
    db.transaction(() => {
      const changed = db.run("UPDATE agent_jobs SET state=?,receipt_json=?,updated_at=?,lease_id='',lease_expires_at='' WHERE id=? AND state NOT IN ('succeeded','failed','cancelled','unknown')", state, json({ state, code, summary }), at, jobID);
      if (!changed.changes) return;
      const next = Number(db.get<any>("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM agent_job_events WHERE job_id=?", jobID)?.sequence ?? 1);
      db.run("INSERT OR IGNORE INTO agent_job_events(job_id,sequence,phase,code,summary,occurred_at) VALUES(?,?,?,?,?,?)", jobID, next, state, code, summary.slice(0, MAX_SUMMARY_BYTES), at);
      notify(row(jobID), state, code, { previousState: current.state as AgentJobState });
    });
    return view(row(jobID));
  };
  const cancelQueuedDeployment = (deploymentID: string, operationID: string, actor: string) => {
    const current = db.get<any>(
      "SELECT id,state FROM agent_jobs WHERE deployment_id=? AND operation_id=?",
      deploymentID,
      operationID,
    );
    if (!current) fail(409, "deployment_job_not_found");
    if (current.state !== "queued") fail(409, "deployment_job_already_claimed");
    const at = iso(deps);
    db.transaction(() => {
      const receipt = { state: "cancelled", code: "cancelled", summary: `cancelled by ${actor}` };
      const changed = db.run(
        "UPDATE agent_jobs SET state='cancelled',receipt_json=?,updated_at=? WHERE id=? AND state='queued'",
        json(receipt), at, current.id,
      );
      if (!changed.changes) fail(409, "deployment_job_already_claimed");
      const next = Number(db.get<any>("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM agent_job_events WHERE job_id=?", current.id)?.sequence ?? 1);
      db.run(
        "INSERT INTO agent_job_events(job_id,sequence,phase,code,summary,occurred_at) VALUES(?,?,?,?,?,?)",
        current.id, next, "cancelled", "cancelled", "Deployment cancelled before Agent claim", at,
      );
      notify(row(current.id), "cancelled", "cancelled", { previousState: "queued" });
    });
    return view(row(current.id));
  };
  const safe = (handler: Handler): Handler => async (ctx) => {
    try { await handler(ctx); } catch (error) {
      if (error instanceof HTTPError) ctx.json({ error: error.message }, error.status);
      else { deps.logger.error(error); ctx.json({ error: "agent job unavailable" }, 500); }
    }
  };
  const body = async (ctx: Context) => object(await ctx.body(), "request");
  router.post("/api/v1/agents/:id/jobs/claim", safe(async (ctx) => {
    const value = await body(ctx); authenticate(ctx, ctx.params.id);
    ctx.json({ job: claim(ctx.params.id, value.capabilities ?? [], text(value.receipt_cursor ?? "", "receipt_cursor", 256, false) || undefined) });
  }), { public: true });
  router.post("/api/v1/agents/:id/jobs/:jobId/events", safe(async (ctx) => {
    authenticate(ctx, ctx.params.id);
    ctx.json(event(ctx.params.id, ctx.params.jobId, await body(ctx)));
  }), { public: true });
  router.post("/api/v1/agents/:id/jobs/:jobId/result", safe(async (ctx) => {
    authenticate(ctx, ctx.params.id);
    ctx.json(result(ctx.params.id, ctx.params.jobId, await body(ctx)));
  }), { public: true });
  router.post("/api/v1/agents/:id/jobs/:jobId/cancel", safe(async (ctx) => {
    authenticate(ctx, ctx.params.id);
    const value = await body(ctx), lease = text(value.lease_id, "lease_id", 256);
    leaseRow(ctx.params.id, ctx.params.jobId, lease);
    ctx.json(cancel(ctx.params.jobId, "agent:" + ctx.params.id));
  }), { public: true });
  router.post("/api/v1/agent-jobs/:jobId/cancel", safe(async (ctx) => {
    deps.auth.requireAdmin(ctx);
    const value = await body(ctx);
    ctx.json(cancel(ctx.params.jobId, ctx.user.id + (value.reason ? ": " + text(value.reason, "reason", 256, false) : "")));
  }));
  return {
    enqueue, claim, event, result, cancel, cancelQueuedDeployment, get: (jobID: string) => view(row(jobID)),
    start() {
      if (sweepTimer) return;
      sweepTimer = setInterval(() => {
        try { expireLeases(); } catch (error) { deps.logger.warn("agent job expiry sweep failed", error); }
      }, Math.max(10, Math.min(60_000, options.expirySweepIntervalMs ?? 5000)));
      sweepTimer.unref?.();
    },
    close() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = undefined;
    },
    onUpdate(listener: (update: AgentJobUpdate) => void) {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
  };
}
