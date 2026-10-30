/** Versioned, outbound-only control protocol for finite script task executions. */
export const SCRIPT_TASK_CAPABILITY = "task.script.v1";
export const SCRIPT_TASK_V2_CAPABILITY = "task.script.v2";
export const SCRIPT_TASK_CAPABILITIES = [SCRIPT_TASK_CAPABILITY, SCRIPT_TASK_V2_CAPABILITY] as const;
export const TASK_LEASE_SECONDS = 60;
export type TaskRunState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface TaskScript {
  runtime: "shell" | "node";
  code: string;
  timeout_seconds: number;
  max_output_bytes: number;
  args?: string[];
  cwd?: string;
}
export interface TaskExecutionPolicy {
  max_concurrency: number;
  queue_timeout_seconds: number;
  retry_count: number;
  retry_delay_seconds: number;
}
export interface TaskRunSnapshot {
  task_id: string;
  task_name: string;
  host_id: string;
  host_name: string;
  agent_id: string;
  script: TaskScript;
  task_revision?: string;
  execution_policy?: TaskExecutionPolicy;
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
  automatic_attempt?: number;
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
    || Object.keys(s).some(key => !["runtime", "code", "timeout_seconds", "max_output_bytes", "args", "cwd"].includes(key))
    || !["shell", "node"].includes(s.runtime)
    || typeof s.code !== "string" || !s.code.trim() || Buffer.byteLength(s.code) > 65536 || s.code.includes("\0")
    || !Number.isInteger(s.timeout_seconds) || s.timeout_seconds < 1 || s.timeout_seconds > 3600
    || !Number.isInteger(s.max_output_bytes) || s.max_output_bytes < 1024 || s.max_output_bytes > 262144)
    throw Error("invalid script: shell/node, 64 KiB code, 1–3600 seconds, 1–256 KiB output required");
  if (s.args !== undefined && (!Array.isArray(s.args) || s.args.length > 32
    || s.args.some(arg => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 1024)
    || s.args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 8192))
    throw Error("invalid script arguments: at most 32 strings, 1 KiB each and 8 KiB total, without NUL");
  if (s.cwd !== undefined && (typeof s.cwd !== "string" || s.cwd.includes("\0")
    || Buffer.byteLength(s.cwd) > 4096 || s.cwd !== "" && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(s.cwd)))
    throw Error("invalid script working directory: an absolute remote path of at most 4096 bytes is required");
}

/** A v1 Agent must never silently discard execution options added by v2. */
export function requiredTaskScriptCapability(script?: Pick<TaskScript, "args" | "cwd">): typeof SCRIPT_TASK_CAPABILITY | typeof SCRIPT_TASK_V2_CAPABILITY {
  return script?.args?.length || script?.cwd ? SCRIPT_TASK_V2_CAPABILITY : SCRIPT_TASK_CAPABILITY;
}

/** v2 implements the base execution contract as well as optional argv/cwd. */
export function supportsTaskScript(capabilities: unknown, script?: Pick<TaskScript, "args" | "cwd">): boolean {
  if (!Array.isArray(capabilities)) return false;
  return capabilities.includes(SCRIPT_TASK_V2_CAPABILITY)
    || requiredTaskScriptCapability(script) === SCRIPT_TASK_CAPABILITY && capabilities.includes(SCRIPT_TASK_CAPABILITY);
}
