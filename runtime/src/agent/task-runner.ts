import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chownSync, lstatSync, chmodSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicJSON } from "../shared/io.js";
import { SCRIPT_TASK_CAPABILITIES, requiredTaskScriptCapability, validateTaskScript, type ClaimedTaskRun, type TaskRunResult, type TaskScript } from "../shared/task-center.js";
import { rootPath } from "../privileged-executor/security.js";
import { MANAGED_AGENT_DATA_DIR, MANAGED_AGENT_TASKS_DIR } from "../privileged-executor/config.js";

export interface OrdinaryTaskAccount { uid: number; gid: number }
export function ordinaryTaskAccount(): OrdinaryTaskAccount {
  rootPath("/usr/bin/id");
  const value = (flag: string) => execFileSync("/usr/bin/id", [flag, "lightmoni-agent"], {encoding: "utf8", timeout: 5000, maxBuffer: 1024, env: {PATH: "/usr/bin:/bin", LANG: "C"}}).trim();
  const uid = Number(value("-u")), gid = Number(value("-g"));
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0 || value("-gn") !== "lightmoni-agent") throw Error("ordinary_task_account_unavailable");
  return {uid, gid};
}
export function ordinaryTaskCapabilityDrop(raw: string): string {
  // Old libcap-ng rejects "all" when the kernel knows newer capabilities.
  // Enumerate the kernel's complete set, never truncate or guess its upper bound.
  const last = Number(raw);
  if (!Number.isInteger(last) || last < 0 || last > 63 || raw !== String(last) && raw !== String(last) + "\n")
    throw Error("ordinary_task_identity_check_failed");
  return Array.from({length: last + 1}, (_, index) => "-cap_" + index).join(",");
}
export function ordinaryTaskCommand(node: string, args: string[], account: OrdinaryTaskAccount,
  lastCapability = readFileSync("/proc/sys/kernel/cap_last_cap", "utf8")): {file: string; args: string[]} {
  if (!Number.isSafeInteger(account.uid) || !Number.isSafeInteger(account.gid) || account.uid <= 0 || account.gid <= 0) throw Error("invalid_ordinary_task_account");
  const drop = ordinaryTaskCapabilityDrop(lastCapability);
  return {file: "/usr/bin/setpriv", args: ["--reuid=" + account.uid, "--regid=" + account.gid, "--clear-groups", "--no-new-privs", "--bounding-set=" + drop, "--inh-caps=" + drop, "--ambient-caps=" + drop, "--", node, ...args]};
}

const IDENTITY_PROBE = `import fs from 'node:fs';const s=fs.readFileSync('/proc/self/status','utf8');const field=n=>{const m=s.match(new RegExp('^'+n+':[\\t ]*([^\\n]*)$','m'));if(!m)throw Error('missing_identity_field');return m[1].trim()};console.log(JSON.stringify({uid:process.getuid(),euid:process.geteuid(),gid:process.getgid(),groups:field('Groups').split(/[\\t ]+/).filter(Boolean).map(Number),nnp:field('NoNewPrivs'),caps:{inh:field('CapInh'),prm:field('CapPrm'),eff:field('CapEff'),bnd:field('CapBnd'),amb:field('CapAmb')}}));`;

/** Verify the exact setpriv profile on this Linux host without running user code. */
export function verifyOrdinaryTaskExecutionIdentity(expected = ordinaryTaskAccount()): void {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
    throw Error("task_helper_requires_linux_root");
  rootPath("/usr/bin/setpriv");
  const node = rootPath(realpathSync(process.execPath));
  const command = ordinaryTaskCommand(node, ["-e", IDENTITY_PROBE], expected);
  let raw: string;
  try {
    raw = execFileSync(command.file, command.args, {
      encoding: "utf8", timeout: 5000, maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/nonexistent" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { throw Error("ordinary_task_identity_check_failed"); }
  let value: any;
  try { value = JSON.parse(raw); } catch { throw Error("ordinary_task_identity_check_failed"); }
  if (value.uid !== expected.uid || value.euid !== expected.uid || value.gid !== expected.gid
    || !Array.isArray(value.groups) || value.groups.length !== 0 || value.nnp !== "1"
    || !value.caps || Object.keys(value.caps).sort().join(",") !== "amb,bnd,eff,inh,prm"
    || Object.values(value.caps).some(v => typeof v !== "string" || !/^[a-fA-F0-9]+$/.test(v) || BigInt("0x" + v) !== 0n))
    throw Error("ordinary_task_identity_check_failed");
}

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
/** The root helper drops ordinary scripts to the same unprivileged account as the daemon.
 * Scripts are trusted administration code: environment scrubbing does not isolate
 * them from this account's readable Agent credentials or writable local state. */
export async function executeTaskScript(script: TaskScript, options: {
  dataDir: string; runID: string; signal?: AbortSignal; expectedAccount: OrdinaryTaskAccount;
}): Promise<ScriptOutcome> {
  validateTaskScript(script);
  if (options.signal?.aborted) {
    const cancelled = (options.signal.reason as any)?.code === "cancel_requested";
    return { state: cancelled ? "cancelled" : "unknown", code: cancelled ? "cancel_requested" : "control_lost",
      summary: "Script was not started because execution was stopped", stdout: "", stderr: "", exit_code: null };
  }
  if (script.runtime === "shell" && process.platform === "win32")
    return { state: "failed", code: "runtime_unavailable", summary: "POSIX shell is unavailable", stdout: "", stderr: "", exit_code: null };
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw Error("task_helper_requires_linux_root");
  rootPath("/usr/bin/setpriv");
  const account = ordinaryTaskAccount();
  if (options.expectedAccount.uid !== account.uid || options.expectedAccount.gid !== account.gid)
    throw Error("ordinary_task_identity_changed");
  const root = MANAGED_AGENT_TASKS_DIR;
  rootPath(root, "directory");
  const parent = lstatSync(MANAGED_AGENT_DATA_DIR);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) throw Error("unsafe_task_state_directory");
  const info = lstatSync(root); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o111) !== 0o111) throw Error("unsafe_task_temporary_directory");
  const work = mkdtempSync(join(root, "lightmoni-agent-"));
  const file = join(work, script.runtime === "node" ? "task.mjs" : "task.sh");
  writeFileSync(file, script.code, { mode: 0o600 });
  chownSync(file, account.uid, account.gid);
  chownSync(work, account.uid, account.gid);
  chmodSync(work, 0o700);
  const scrub = (value: string) => value;
  try {
    return await new Promise<ScriptOutcome>(resolve => {
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), received = 0, reason = "", done = false;
      let timeout: NodeJS.Timeout | undefined, force: NodeJS.Timeout | undefined;
      let scriptExit: number | null | undefined, spawnError = false;
      const executable = script.runtime === "node" ? process.execPath : "/bin/sh";
      const command = ordinaryTaskCommand(executable, [file, ...(script.args ?? [])], account);
      const child = spawn(command.file, command.args, {
        cwd: script.cwd || work, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
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
      child.once("error", () => { spawnError = true; });
      child.once("exit", code => { scriptExit = code; kill("SIGKILL"); });
      child.once("close", exit => finish(scriptExit === undefined ? exit : scriptExit, spawnError));
      timeout = setTimeout(() => stop("timeout"), script.timeout_seconds * 1000);
      timeout.unref?.();
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    });
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export interface TaskRunnerConfig {
  endpoint: string; agentID: string; executorID: string; executorInstallGeneration: number;
  dataDir: string; pollIntervalMs?: number; heartbeatIntervalMs?: number;
  permissionGeneration: number;
  executionIdentity: { account: "lightmoni-agent"; uid: number; gid: number; permission_generation: number };
}
interface Recovery { id: string; lease_token: string; receipt?: TaskRunResult }

/** Pulls a single task at a time; a crash marker prevents local script replay. */
export class AgentTaskRunner {
  private readonly statePath: string;
  private polling = false;
  constructor(readonly config: TaskRunnerConfig, io: { request: (route: string, body: unknown, parent?: AbortSignal, slot?: string) => Promise<any>; clearRequest: (slot: string) => void }) {
    this.requester = io.request; this.clearRequest = io.clearRequest; this.statePath = resolve(config.dataDir, "task-run-state.json");
    if (!config.executorID || !Number.isSafeInteger(config.executorInstallGeneration) || config.executorInstallGeneration < 1
      || !Number.isSafeInteger(config.permissionGeneration) || config.permissionGeneration < 1
      || config.executionIdentity.account !== "lightmoni-agent" || config.executionIdentity.permission_generation !== config.permissionGeneration
      || !Number.isSafeInteger(config.executionIdentity.uid) || config.executionIdentity.uid <= 0
      || !Number.isSafeInteger(config.executionIdentity.gid) || config.executionIdentity.gid <= 0)
      throw Error("invalid_signed_helper_identity");
  }
  private readonly requester: (route: string, body: unknown, parent?: AbortSignal, slot?: string) => Promise<any>;
  private readonly clearRequest: (slot: string) => void;
  private async request(path: string, body: unknown, parent?: AbortSignal, slot?: string) {
    return this.requester(path, body, parent, slot);
  }
  private path(id: string, action: string) {
    return `task-runs/${encodeURIComponent(id)}/${action}`;
  }
  private claimPath() { return "task-runs/claim"; }
  private save(value: Recovery | Record<string, never>) { atomicJSON(this.statePath, value); }
  private recovery(): Recovery | undefined {
    if (!existsSync(this.statePath)) return;
    const v = JSON.parse(readFileSync(this.statePath, "utf8"));
    if (typeof v.id === "string" && typeof v.lease_token === "string" && /^[a-f0-9]{64}$/.test(v.lease_token)) return v;
    if (Object.keys(v).length) throw Error("invalid task recovery marker");
  }
  private async recover(parent?: AbortSignal) {
    const value = this.recovery(); if (!value) return;
    const receipt: TaskRunResult = value.receipt ?? { lease_token: value.lease_token, state: "unknown", code: "helper_restarted", summary: "Helper restarted during task execution; script was not replayed", stdout: "", stderr: "", exit_code: null };
    const resultSlot = "task-run-result:" + value.id;
    try { await this.request(this.path(value.id, "result"), receipt, parent, resultSlot); }
    catch {
      const slot = "task-run-reconcile:" + value.id;
      const reconciliation = await this.request(this.path(value.id, "reconcile"), { lease_token: value.lease_token }, parent, slot);
      if (reconciliation.acknowledged !== true || !["succeeded", "failed", "cancelled", "unknown"].includes(reconciliation.state)) {
        this.clearRequest(slot);
        throw Error("task_result_reconciliation_pending");
      }
      this.clearRequest(slot);
    }
    this.save({});
    this.clearRequest(resultSlot);
    this.clearRequest("task-run-reconcile:" + value.id);
    this.clearRequest("task-runs-claim");
  }
  async pollOnce(parent?: AbortSignal): Promise<ScriptOutcome | null> {
    if (this.polling || parent?.aborted) return null;
    this.polling = true;
    try {
      await this.recover(parent);
      const claimSlot = "task-runs-claim";
      const value = await this.request(this.claimPath(), { capabilities: [...SCRIPT_TASK_CAPABILITIES] }, parent, claimSlot);
      const run = value.run as ClaimedTaskRun | null;
      if (!run) { this.clearRequest(claimSlot); return null; }
      if (typeof run.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(run.id)
        || typeof run.lease_token !== "string" || !/^[a-f0-9]{64}$/.test(run.lease_token))
        throw Error("invalid claimed task lease");
      // Persist the lease before validating any other server-supplied field:
      // even a malformed snapshot must never be claimed a second time.
      this.save({ id: run.id, lease_token: run.lease_token });
      this.clearRequest(claimSlot);
      if (run.agent_id !== this.config.agentID
        || run.snapshot?.agent_id !== this.config.agentID || run.snapshot?.host_id !== run.host_id || run.snapshot?.task_id !== run.task_id)
        throw Error("invalid claimed task binding");
      validateTaskScript(run.snapshot.script);
      const identity = run.snapshot.execution_identity;
      const expectedIdentity = this.config.executionIdentity;
      if (identity && (identity.account !== expectedIdentity.account || identity.privilege !== "user"
        || identity.uid !== expectedIdentity.uid
        || identity.gid !== expectedIdentity.gid
        || identity.permission_generation !== expectedIdentity.permission_generation
        || identity.executor_id !== this.config.executorID
        || identity.install_generation !== this.config.executorInstallGeneration
        || !Number.isSafeInteger(identity.permission_generation) || identity.permission_generation < 1
        || identity.permission_generation !== this.config.permissionGeneration))
        throw Error("ordinary_task_identity_mismatch");
      if (!identity) throw Error("ordinary_task_identity_missing");
      if (!(SCRIPT_TASK_CAPABILITIES as readonly string[]).includes(requiredTaskScriptCapability(run.snapshot.script)))
        throw Error("unsupported claimed script capability");
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
          signal: controller.signal, expectedAccount: { uid: this.config.executionIdentity.uid, gid: this.config.executionIdentity.gid } });
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
