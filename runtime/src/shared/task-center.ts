/** Versioned, outbound-only control protocol for finite script task executions. */
export const SCRIPT_TASK_CAPABILITY = "task.script.v1";
export const TASK_LEASE_SECONDS = 60;
export type TaskRunState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface TaskScript {
  runtime: "shell" | "node";
  code: string;
  timeout_seconds: number;
  max_output_bytes: number;
}
export interface TaskRunSnapshot {
  task_id: string;
  task_name: string;
  host_id: string;
  host_name: string;
  agent_id: string;
  script: TaskScript;
}
export interface TaskRun {
  id: string;
  task_id: string;
  task_name: string;
  host_id: string;
  host_name: string;
  agent_id: string;
  state: TaskRunState;
  trigger: "manual" | "schedule" | "retry";
  retry_of: string;
  superseded_by: string;
  resolved_at: string;
  resolved_by: string;
  resolution_reason: string;
  requested_by: string;
  created_at: string;
  started_at: string;
  finished_at: string;
  lease_expires_at: string;
  cancel_requested: boolean;
  code: string;
  summary: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  snapshot: TaskRunSnapshot;
}
export interface ClaimedTaskRun extends TaskRun { lease_token: string }
export interface TaskRunResult {
  lease_token: string;
  state: "succeeded" | "failed" | "cancelled" | "unknown";
  code: string;
  summary: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
}
export function validateTaskScript(value: unknown): asserts value is TaskScript {
  const s = value as TaskScript;
  if (!s || typeof s !== "object" || Array.isArray(s)
    || !["shell", "node"].includes(s.runtime)
    || typeof s.code !== "string" || !s.code.trim() || Buffer.byteLength(s.code) > 65536 || s.code.includes("\0")
    || !Number.isInteger(s.timeout_seconds) || s.timeout_seconds < 1 || s.timeout_seconds > 3600
    || !Number.isInteger(s.max_output_bytes) || s.max_output_bytes < 1024 || s.max_output_bytes > 262144)
    throw Error("invalid script: shell/node, 64 KiB code, 1–3600 seconds, 1–256 KiB output required");
}
