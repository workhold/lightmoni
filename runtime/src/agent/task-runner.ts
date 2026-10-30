import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicJSON } from "../shared/io.js";
import { SCRIPT_TASK_CAPABILITY, validateTaskScript, type ClaimedTaskRun, type TaskRunResult, type TaskScript } from "../shared/task-center.js";

export interface ScriptOutcome {
  state: "succeeded" | "failed" | "cancelled" | "unknown";
  code: string;
  summary: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
}
const utf8Prefix = (v: string, max: number) => {
  const b = Buffer.from(v); if (b.length <= max) return v;
  let end = max; while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString("utf8");
};
// A separate supervisor keeps its own deadline and observes reparenting if the
// Agent is killed. The user script shares this process group, without IPC.
const SUPERVISOR = `import {spawn} from 'node:child_process';
const [runtime,file,seconds,parent]=process.argv.slice(2);
const stop=()=>{try{if(process.platform!=='win32')process.kill(-process.pid,'SIGKILL');else child.kill('SIGKILL')}catch{}process.exit(1)};
const child=spawn(runtime==='node'?process.execPath:'/bin/sh',[file],{stdio:['ignore','inherit','inherit'],env:process.env});
child.once('error',()=>{process.send?.({type:'complete',exit_code:null,spawn_error:true})});
child.once('exit',code=>{process.send?.({type:'complete',exit_code:code})});
setInterval(()=>{if(process.ppid!==Number(parent))stop()},200);
setTimeout(stop,Number(seconds)*1000+1000);
process.on('disconnect',stop);
`;

/** Bounded subprocess execution. This is not an OS sandbox: it runs as the Agent user. */
export async function executeTaskScript(script: TaskScript, options: {
  dataDir: string; runID: string; signal?: AbortSignal; secrets?: string[];
}): Promise<ScriptOutcome> {
  validateTaskScript(script);
  if (options.signal?.aborted) {
    const cancelled = (options.signal.reason as any)?.code === "cancel_requested";
    return { state: cancelled ? "cancelled" : "unknown", code: cancelled ? "cancel_requested" : "control_lost",
      summary: "Script was not started because execution was stopped", stdout: "", stderr: "", exit_code: null };
  }
  if (script.runtime === "shell" && process.platform === "win32")
    return { state: "failed", code: "runtime_unavailable", summary: "POSIX shell is unavailable", stdout: "", stderr: "", exit_code: null };
  const root = resolve(options.dataDir, "task-work"); mkdirSync(root, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(root, "run-"));
  const file = join(work, script.runtime === "node" ? "task.mjs" : "task.sh");
  writeFileSync(file, script.code, { mode: 0o600 });
  const supervisor = join(work, "supervisor.mjs");
  writeFileSync(supervisor, SUPERVISOR, { mode: 0o600 });
  const secrets = (options.secrets ?? []).filter(Boolean).sort((a, b) => b.length - a.length);
  const scrub = (value: string) => { for (const secret of secrets) value = value.split(secret).join("[redacted]"); return value; };
  try {
    return await new Promise<ScriptOutcome>(resolve => {
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), received = 0, reason = "", done = false;
      let timeout: NodeJS.Timeout | undefined, force: NodeJS.Timeout | undefined;
      let scriptExit: number | null | undefined, spawnError = false;
      const child = spawn(process.execPath, [supervisor, script.runtime, file, String(script.timeout_seconds), String(process.pid)], {
        cwd: work, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work, TMPDIR: work, LANG: "C.UTF-8", LIGHTMONI_TASK_RUN_ID: options.runID },
      });
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* process may have exited before the group signal */ }
      };
      const stop = (code: string) => {
        if (reason || done) return; reason = code; kill("SIGTERM");
        force = setTimeout(() => kill("SIGKILL"), 300); force.unref?.();
      };
      const abort = () => stop((options.signal?.reason as any)?.code === "cancel_requested" ? "cancel_requested" : "control_lost");
      const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
        const remaining = Math.max(0, script.max_output_bytes - received);
        received += chunk.length;
        const part = chunk.subarray(0, remaining);
        if (stream === "stdout") stdout = Buffer.concat([stdout, part]); else stderr = Buffer.concat([stderr, part]);
        if (received > script.max_output_bytes) stop("output_limit");
      };
      child.stdout!.on("data", (b: Buffer) => append("stdout", b));
      child.stderr!.on("data", (b: Buffer) => append("stderr", b));
      child.on("message", (message: any) => {
        if (message?.type !== "complete" || !(message.exit_code === null || Number.isInteger(message.exit_code))) return;
        scriptExit = message.exit_code; spawnError = !!message.spawn_error;
        // User code is done; close the full group so background descendants
        // cannot outlive a successful task or hold the output pipes open.
        kill("SIGKILL");
      });
      const finish = (exit: number | null, failedSpawn = false) => {
        if (done) return; done = true;
        if (timeout) clearTimeout(timeout); if (force) clearTimeout(force);
        options.signal?.removeEventListener("abort", abort);
        // Kill any same-group descendants even if their parent exited normally.
        kill("SIGKILL");
        let out = utf8Prefix(scrub(stdout.toString("utf8")), script.max_output_bytes);
        const err = utf8Prefix(scrub(stderr.toString("utf8")), script.max_output_bytes - Buffer.byteLength(out));
        const code = reason || (failedSpawn ? "runtime_unavailable" : exit === 0 ? "" : "script_failed");
        const state = code === "cancel_requested" ? "cancelled" : code === "control_lost" ? "unknown" : code || exit !== 0 ? "failed" : "succeeded";
        const summaries: Record<string, string> = { timeout: "Script exceeded its time limit", output_limit: "Script exceeded its output limit", cancel_requested: "Script cancelled by platform request", control_lost: "Script stopped after control authority was lost", runtime_unavailable: "Script runtime could not start", script_failed: "Script exited unsuccessfully" };
        resolve({ state, code, summary: summaries[code] ?? "Script completed", stdout: out, stderr: err, exit_code: exit });
      };
      child.once("error", () => finish(null, true)); child.once("close", exit => finish(scriptExit === undefined ? exit : scriptExit, spawnError));
      timeout = setTimeout(() => stop("timeout"), script.timeout_seconds * 1000);
      timeout.unref?.();
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    });
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export interface TaskRunnerConfig {
  endpoint: string; agentID: string; controlCredential: string; dataCredential?: string;
  dataDir: string; pollIntervalMs?: number; heartbeatIntervalMs?: number;
}
class TaskHTTPError extends Error { constructor(readonly status: number) { super("task control HTTP " + status); } }
interface Recovery { id: string; lease_token: string; receipt?: TaskRunResult }

/** Pulls a single task at a time; a crash marker prevents local script replay. */
export class AgentTaskRunner {
  private readonly statePath: string;
  private readonly fetcher: typeof fetch;
  private polling = false;
  constructor(readonly config: TaskRunnerConfig, io: { fetch?: typeof fetch } = {}) {
    this.fetcher = io.fetch ?? fetch; this.statePath = resolve(config.dataDir, "task-run-state.json");
  }
  private async request(path: string, body: unknown, parent?: AbortSignal) {
    const response = await this.fetcher(this.config.endpoint.replace(/\/$/, "") + path, {
      method: "POST", redirect: "error",
      headers: { authorization: "Bearer " + this.config.controlCredential, "content-type": "application/json" },
      body: JSON.stringify(body), signal: parent ? AbortSignal.any([parent, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new TaskHTTPError(response.status); }
    if (!response.body) throw Error("empty task control response");
    const reader = response.body.getReader(), chunks: Buffer[] = []; let bytes = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
        if (bytes > 1_048_576) { await reader.cancel(); throw Error("oversized task control response"); }
        chunks.push(Buffer.from(part.value)); }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private path(id: string, action: string) { return `/api/v1/agents/${encodeURIComponent(this.config.agentID)}/task-runs/${encodeURIComponent(id)}/${action}`; }
  private save(value: Recovery | Record<string, never>) { atomicJSON(this.statePath, value); }
  private recovery(): Recovery | undefined {
    if (!existsSync(this.statePath)) return;
    const v = JSON.parse(readFileSync(this.statePath, "utf8"));
    if (typeof v.id === "string" && typeof v.lease_token === "string" && /^[a-f0-9]{64}$/.test(v.lease_token)) return v;
    if (Object.keys(v).length) throw Error("invalid task recovery marker");
  }
  private async recover(parent?: AbortSignal) {
    const value = this.recovery(); if (!value) return;
    const receipt: TaskRunResult = value.receipt ?? { lease_token: value.lease_token, state: "unknown", code: "agent_restarted", summary: "Agent restarted during task execution; script was not replayed", stdout: "", stderr: "", exit_code: null };
    try { await this.request(this.path(value.id, "result"), receipt, parent); }
    catch (error) {
      if (!(error instanceof TaskHTTPError) || ![404, 409].includes(error.status)) throw error;
      // The centre has no active lease to accept a receipt. Its expiry sweep
      // preserves uncertainty and never requeues the command.
    }
    this.save({});
  }
  async pollOnce(parent?: AbortSignal): Promise<ScriptOutcome | null> {
    if (this.polling || !this.config.controlCredential || parent?.aborted) return null;
    this.polling = true;
    try {
      await this.recover(parent);
      const value = await this.request(`/api/v1/agents/${encodeURIComponent(this.config.agentID)}/task-runs/claim`, { capabilities: [SCRIPT_TASK_CAPABILITY] }, parent);
      const run = value.run as ClaimedTaskRun | null; if (!run) return null;
      if (typeof run.id !== "string" || !/^[a-f0-9]{64}$/.test(run.lease_token) || run.agent_id !== this.config.agentID
        || run.snapshot?.agent_id !== this.config.agentID || run.snapshot?.host_id !== run.host_id || run.snapshot?.task_id !== run.task_id)
        throw Error("invalid claimed task binding");
      validateTaskScript(run.snapshot.script);
      this.save({ id: run.id, lease_token: run.lease_token });
      const controller = new AbortController();
      const parentAbort = () => controller.abort(Object.assign(Error("Agent stopping"), { code: "control_lost" }));
      if (parent?.aborted) parentAbort(); else parent?.addEventListener("abort", parentAbort, { once: true });
      let pending = false;
      const heartbeat = async () => {
        const response = await this.request(this.path(run.id, "heartbeat"), { lease_token: run.lease_token }, parent);
        if (response.state !== "running") throw Error("task is no longer running");
        if (response.cancel_requested) controller.abort(Object.assign(Error("Platform cancellation requested"), { code: "cancel_requested" }));
      };
      let timer: NodeJS.Timeout | undefined, outcome: ScriptOutcome;
      try {
        // Confirm authority once before spawning and periodically while running.
        await heartbeat();
        timer = setInterval(() => {
          if (pending || controller.signal.aborted) return; pending = true;
          void heartbeat().catch(() => controller.abort(Object.assign(Error("Task control lease lost"), { code: "control_lost" }))).finally(() => { pending = false; });
        }, Math.max(10, this.config.heartbeatIntervalMs ?? 15000)); timer.unref?.();
        outcome = await executeTaskScript(run.snapshot.script, { dataDir: this.config.dataDir, runID: run.id,
          signal: controller.signal, secrets: [this.config.controlCredential, this.config.dataCredential ?? ""] });
      } catch {
        outcome = { state: "unknown", code: "control_lost", summary: "Task authority could not be confirmed; execution outcome requires review", stdout: "", stderr: "", exit_code: null };
      } finally { if (timer) clearInterval(timer); parent?.removeEventListener("abort", parentAbort); }
      const receipt: TaskRunResult = { lease_token: run.lease_token, ...outcome };
      this.save({ id: run.id, lease_token: run.lease_token, receipt });
      // Save before HTTP: a lost response re-submits the receipt, never code.
      await this.recover(parent?.aborted ? undefined : parent);
      return outcome;
    } finally { this.polling = false; }
  }
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.pollOnce(signal); } catch { /* no further claim until recovery succeeds */ }
      await new Promise<void>(resolve => {
        if (signal.aborted) return resolve();
        const abort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.max(1000, this.config.pollIntervalMs ?? 5000));
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
