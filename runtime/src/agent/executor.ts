import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, basename, isAbsolute, join, normalize, relative } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { connect as connectTCP } from "node:net";
import type { DeploymentAction, HealthCheck } from "../deployment/types.js";

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,126}\.service$/;
const CAPABILITIES = new Set([
  "artifact.stage", "artifact.activate_release", "systemd.daemon_reload",
  "systemd.enable", "systemd.disable", "systemd.start", "systemd.restart", "systemd.stop",
  "health.systemd", "health.http", "health.tcp",
]);

export interface ExecutorTarget {
  releaseDirectory: string;
  unit: string;
}
export interface ExecutorJob {
  id: string;
  expires_at: string;
  capabilities: string[];
  actions: DeploymentAction[];
  target: ExecutorTarget;
}
export interface ExecutionEvent {
  phase: "accepted" | "staging" | "activating" | "verifying" | "succeeded" | "failed" | "unknown";
  code?: string;
  summary: string;
  snapshot?: Record<string, unknown>;
}
export interface ExecutionReceipt {
  state: "succeeded" | "failed" | "unknown";
  code?: string;
  summary: string;
  snapshot: Record<string, unknown>;
  started_at: string;
  finished_at: string;
}
export interface ExecutorOptions {
  now?: () => Date;
  command?: (file: string, args: string[], timeoutMs: number, signal: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
  emit?: (event: ExecutionEvent) => Promise<void> | void;
}

const safePath = (value: string) => {
  if (!isAbsolute(value) || value.includes("\0") || value.split(/[\\/]/).includes("..")) return false;
  return normalize(value) === value;
};
const inside = (root: string, value: string) => {
  const rel = relative(root, value);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${value.includes("\\") ? "\\" : "/"}`) && !isAbsolute(rel));
};
const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? Error("execution cancelled");
};
const digestFile = async (path: string, signal: AbortSignal) => {
  checkAbort(signal);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    checkAbort(signal);
    hash.update(chunk);
  }
  return hash.digest("hex");
};
const defaultCommand = async (file: string, args: string[], timeoutMs: number, signal: AbortSignal) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 << 10, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
};
const tcpHealth = (host: string, port: number, timeoutMs: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
  const socket = connectTCP({ host, port });
  let done = false;
  const finish = (value: boolean) => { if (done) return; done = true; socket.destroy(); resolve(value); };
  socket.setTimeout(timeoutMs, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  if (signal.aborted) finish(false);
  else signal.addEventListener("abort", () => finish(false), { once: true });
});

/**
 * Executes only the typed capabilities issued in an Agent job.  Every action
 * is checked against the registered target and job expiry before it touches
 * the host. No shell string is accepted by this class.
 */
export class CapabilityExecutor {
  private readonly now: () => Date;
  private readonly runCommand: NonNullable<ExecutorOptions["command"]>;
  private readonly emit?: ExecutorOptions["emit"];
  constructor(options: ExecutorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.runCommand = options.command ?? defaultCommand;
    this.emit = options.emit;
  }
  private event(value: ExecutionEvent) { return this.emit?.(value); }
  private validateJob(job: ExecutorJob) {
    if (!job || !job.id || !Array.isArray(job.actions) || !Array.isArray(job.capabilities)) throw Error("invalid agent job");
    if (!job.actions.length) throw Object.assign(Error("deployment plan has no executable actions"), { code: "invalid_plan" });
    if (!safePath(job.target.releaseDirectory) || !UNIT.test(job.target.unit)) throw Error("invalid deployment target");
    if (Date.parse(job.expires_at) <= this.now().getTime()) throw Object.assign(Error("job expired"), { code: "job_expired" });
    const caps = new Set(job.capabilities);
    for (const cap of caps) if (!CAPABILITIES.has(cap)) throw Object.assign(Error("capability denied"), { code: "capability_denied" });
    for (const action of job.actions) {
      if (!action || typeof action !== "object" || !("kind" in action)) throw Error("invalid deployment action");
      const kind = (action as any).kind;
      const needed = kind === "stage_artifact" ? "artifact.stage" : kind === "activate_release" ? "artifact.activate_release" : kind === "systemd" ? `systemd.${String((action as any).operation).replace(/-/g, "_")}` : kind === "health_check" ? `health.${(action as any).check?.kind === "systemd-active" ? "systemd" : (action as any).check?.kind}` : "";
      if (!needed || !caps.has(needed)) throw Object.assign(Error("capability denied"), { code: "capability_denied" });
    }
  }
  private async stage(action: Extract<DeploymentAction, { kind: "stage_artifact" }>, target: ExecutorTarget, signal: AbortSignal) {
    if (!safePath(action.source) || !safePath(action.destination) || !inside(target.releaseDirectory, action.destination)) throw Object.assign(Error("artifact path is outside release directory"), { code: "invalid_target" });
    if (!SHA256.test(action.sha256)) throw Object.assign(Error("artifact digest is invalid"), { code: "invalid_artifact" });
    const info = await stat(action.source);
    if (!info.isFile() || info.size > 2 * 1024 * 1024 * 1024) throw Object.assign(Error("artifact source is not a regular file"), { code: "invalid_artifact" });
    const observed = await digestFile(action.source, signal);
    if (observed.toLowerCase() !== action.sha256.toLowerCase()) throw Object.assign(Error("artifact digest mismatch"), { code: "digest_mismatch" });
    await mkdir(action.destination, { recursive: true, mode: 0o750 });
    const destination = join(action.destination, basename(action.source));
    if (!inside(target.releaseDirectory, destination)) throw Object.assign(Error("artifact destination is invalid"), { code: "invalid_target" });
    const temporary = `${destination}.partial-${process.pid}`;
    await new Promise<void>((resolve, reject) => {
      const input = createReadStream(action.source), output = createWriteStream(temporary, { mode: 0o640 });
      input.once("error", reject); output.once("error", reject); output.once("finish", () => resolve()); input.pipe(output);
    });
    await rename(temporary, destination);
    return { staged_path: destination, sha256: observed };
  }
  private async activate(action: Extract<DeploymentAction, { kind: "activate_release" }>, target: ExecutorTarget) {
    if (!safePath(action.releaseDirectory) || action.releaseDirectory !== target.releaseDirectory || !VERSION.test(action.version)) throw Object.assign(Error("release activation target is invalid"), { code: "invalid_target" });
    const release = join(target.releaseDirectory, "releases", action.version);
    if (!inside(target.releaseDirectory, release) || !existsSync(release)) throw Object.assign(Error("release is not staged"), { code: "artifact_conflict" });
    const pointer = join(target.releaseDirectory, "current");
    await mkdir(target.releaseDirectory, { recursive: true, mode: 0o750 });
    const temp = `${pointer}.partial-${process.pid}`;
    await writeFile(temp, action.version + "\n", { mode: 0o640 });
    await rename(temp, pointer);
    return { current_version: action.version };
  }
  private async systemd(action: Extract<DeploymentAction, { kind: "systemd" }>, target: ExecutorTarget, signal: AbortSignal) {
    if (action.unit !== target.unit || !UNIT.test(action.unit)) throw Object.assign(Error("systemd unit is not registered target"), { code: "capability_denied" });
    const operation = action.operation;
    // `daemon-reload` is a manager-wide systemd operation and does not take a
    // unit argument. All other operations remain pinned to the registered
    // unit, so the executor never turns model input into an arbitrary command.
    const args = operation === "daemon-reload" ? [operation] : [operation, action.unit];
    const result = await this.runCommand("systemctl", args, 15000, signal);
    if (result.stderr.trim() && operation !== "daemon-reload") throw Object.assign(Error("systemd operation failed"), { code: "systemd_failed" });
    return { unit: action.unit, operation };
  }
  private async health(check: HealthCheck, target: ExecutorTarget, signal: AbortSignal) {
    if (check.kind === "systemd-active") {
      if (check.unit !== target.unit) throw Object.assign(Error("health unit is not target"), { code: "capability_denied" });
      try { await this.runCommand("systemctl", ["is-active", "--quiet", check.unit], 15000, signal); return { healthy: true }; } catch { return { healthy: false }; }
    }
    if (check.kind === "http") {
      const url = new URL(check.url);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) throw Object.assign(Error("health URL is invalid"), { code: "invalid_target" });
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(check.timeoutMs ?? 5000, 30000))]) });
      await response.body?.cancel();
      return { healthy: response.status === (check.expectedStatus ?? 200), status: response.status };
    }
    if (check.kind === "tcp") {
      if (!Number.isInteger(check.port) || check.port < 1 || check.port > 65535 || !check.host || /[^A-Za-z0-9_.:-]/.test(check.host)) throw Object.assign(Error("health endpoint is invalid"), { code: "invalid_target" });
      return { healthy: await tcpHealth(check.host, check.port, Math.min(check.timeoutMs ?? 5000, 30000), signal) };
    }
    throw Object.assign(Error("health capability denied"), { code: "capability_denied" });
  }
  async execute(job: ExecutorJob, signal: AbortSignal = new AbortController().signal): Promise<ExecutionReceipt> {
    const started = this.now().toISOString();
    try {
      this.validateJob(job);
      await this.event({ phase: "accepted", summary: "Agent accepted the typed deployment job" });
      const snapshot: Record<string, unknown> = {};
      for (const action of job.actions) {
        checkAbort(signal);
        if (Date.parse(job.expires_at) <= this.now().getTime()) throw Object.assign(Error("job expired"), { code: "job_expired" });
        if (action.kind === "stage_artifact") { await this.event({ phase: "staging", summary: "Staging immutable release artifact" }); Object.assign(snapshot, await this.stage(action, job.target, signal)); }
        else if (action.kind === "activate_release") { await this.event({ phase: "activating", summary: "Activating registered release" }); Object.assign(snapshot, await this.activate(action, job.target)); }
        else if (action.kind === "systemd") { await this.event({ phase: "activating", summary: "Applying registered systemd operation" }); Object.assign(snapshot, await this.systemd(action, job.target, signal)); }
        else if (action.kind === "health_check") { await this.event({ phase: "verifying", summary: "Running registered health check" }); const health = await this.health(action.check, job.target, signal); Object.assign(snapshot, { health }); if (!health.healthy) throw Object.assign(Error("health check failed"), { code: "health_check_failed" }); }
      }
      const receipt = { state: "succeeded" as const, summary: "Typed deployment actions completed", snapshot, started_at: started, finished_at: this.now().toISOString() };
      await this.event({ phase: "succeeded", summary: receipt.summary, snapshot });
      return receipt;
    } catch (error) {
      const e = error as Error & { code?: string };
      const code = e.code ?? (signal.aborted ? "execution_cancelled" : "execution_failed");
      const state = code === "unknown_execution_result" ? "unknown" as const : "failed" as const;
      const receipt = { state, code, summary: e.message.slice(0, 1000), snapshot: {}, started_at: started, finished_at: this.now().toISOString() };
      await this.event({ phase: state, code, summary: receipt.summary });
      return receipt;
    }
  }
}
