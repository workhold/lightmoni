import { realpathSync,existsSync } from "node:fs";
import { rootPath } from "./security.js";
import { ExecutorApplicationObserver } from './observation.js';
import { readDockerInventory } from "../agent/docker.js";
import { operationCommand } from "../agent/operations.js";
import { runManaged,releaseManagedOperationLock,type ManagedRunContext } from "./managed.js";
import type { ManagedExecutionPayload } from "../shared/managed-execution.js";
import { operationCapabilities } from "../agent/operations.js";
import { randomBytes } from "node:crypto";
import { canonicalJSON, strictRecord, type PrivilegedPlan, type PrivilegedPayload } from "../shared/privileged-executor.js";
import { ExecutorClient } from "./client.js";
import { type ExecutorConfig } from "./config.js";
import { ExecutorJournal, type JournalJob } from "./journal.js";
import { ManagedDockerExecutor, inspectManagedDockerDaemon, type ManagedDockerResource } from "./docker.js";
import { executeScript, interpreterDigest, interpreterPath, localAccount, sameAccount, productionScriptHost, scriptDependenciesReady, type ExecutionStartGuard, type ScriptHost, type ScriptOutcome } from "./scripts.js";
import { refuse, sha256, linuxBootClock, type BootClock } from "./security.js";

export interface ExecutorRelease { version: string; activation_id:string; release: { build_id: string; source_revision: string; artifact_sha256: string; state_schema: 1 } }
export interface RunnerHost {
  scripts: ScriptHost;
  inventory?:()=>Promise<unknown>;
  managed?:(payload:ManagedExecutionPayload,context:ManagedRunContext)=>Promise<ScriptOutcome>;
  docker: Pick<ManagedDockerExecutor, "execute">;
  profiles(config: ExecutorConfig): Promise<{ capabilities: string[]; account_profiles: ReturnType<typeof localAccount>[]; interpreter_profiles: {runtime: string; sha256: string}[] }>;
}
export function productionRunnerHost(config: ExecutorConfig): RunnerHost {
  return { inventory:async()=>{
      if(!config.daemon_id||(await inspectManagedDockerDaemon()).daemon_id!==config.daemon_id)refuse('docker_daemon_changed');
      const docker=['/usr/local/bin/docker','/usr/bin/docker'].find(path=>existsSync(path));if(!docker)refuse('docker_cli_missing');const executable=rootPath(realpathSync(docker!));
      return readDockerInventory((_file,args,options)=>operationCommand(executable,['--host=unix:///var/run/docker.sock',...(args[0]==='--context'&&args[1]==='default'?args.slice(2):args)],options));
    },managed:runManaged,scripts: productionScriptHost(), docker: new ManagedDockerExecutor({ daemon_id: config.daemon_id || "not-configured" }),
    async profiles() {
      const accounts = config.accounts.filter(account => { try { return sameAccount(localAccount(account.name), account); } catch { return false; } });
      const interpreters: { runtime: string; sha256: string }[] = [];
      for (const runtime of ["shell", "node"] as const) { try { interpreters.push({ runtime, sha256: interpreterDigest(interpreterPath(runtime)) }); } catch {} }
      const capabilities: string[] = [];
      if (accounts.length && interpreters.length && scriptDependenciesReady()) capabilities.push("script.elevated.v1");
      if (config.daemon_id) { try { if ((await inspectManagedDockerDaemon()).daemon_id === config.daemon_id) capabilities.push("container.managed.v1"); } catch {} }
      if(scriptDependenciesReady())capabilities.push("operations.managed.v1");
      return { capabilities, account_profiles: accounts, interpreter_profiles: interpreters };
    },
  };
}
const safeCode = (error: unknown) => error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : "executor_refused";
const failure = (state: "failed" | "unknown", code: string): ScriptOutcome => ({ state, code, summary: state === "unknown" ? "Execution outcome requires read-only reconciliation" : "Approved execution refused", exit_code: null, stdout: "", stderr: "" });

export class PrivilegedExecutorRunner {
  private observations?:ExecutorApplicationObserver;
  close(){this.observations?.close();}
  constructor(readonly config: ExecutorConfig, readonly journal: ExecutorJournal, readonly client: ExecutorClient,
    readonly release: ExecutorRelease, private readonly host: RunnerHost = productionRunnerHost(config), private readonly clock: BootClock = linuxBootClock) {}
  async heartbeat(): Promise<void> {
    const profiles = await this.host.profiles(this.config), current = this.journal.policy();
    let inventory:unknown;
    if(current.capabilities.includes('operations.managed.v1')&&this.host.inventory)try{inventory=await this.host.inventory();}catch{}
    const response = await this.client.request("heartbeat", { ...this.release, boot_id: this.clock.bootID(), policy_generation: current.generation,
      ...(inventory?{docker_inventory:inventory}:{}),capabilities: profiles.capabilities.filter(c => current.capabilities.includes(c)), operations_capabilities:profiles.capabilities.includes("operations.managed.v1")?[...operationCapabilities]:[],account_profiles: profiles.account_profiles, interpreter_profiles: profiles.interpreter_profiles });
    if (response.center_instance_id !== this.config.center_instance_id) refuse("principal_mismatch");
    this.client.applyPolicy(response.policy);
  }
  async once(signal: AbortSignal = new AbortController().signal): Promise<void> {
    await this.heartbeat();
    if(this.host.managed===runManaged&&this.config.daemon_id&&this.journal.policy().capabilities.includes('operations.managed.v1')){
      this.observations??=new ExecutorApplicationObserver(this.config);
      try{await this.observations.collect(signal);}catch{/* retained outbox/cursors retry; no ordinary principal fallback */}
    }
    // A previous process may have submitted an intent. Never resume its script,
    // even when no PID exists, or replace its start nonce after a reboot.
    for (const row of this.journal.all()) {
      if (row.state === "prepared") this.journal.finish(row.job_id, "failed", failure("failed", "prepared_interrupted"));
    }
    for (const row of this.journal.all()) if (["failed", "succeeded", "unknown"].includes(row.state) && !this.journal.reported(row.job_id)) await this.report(row);
    const fence = this.journal.fenced();
    if (fence) { await this.reconcile(fence); if (this.journal.fenced()) return; }
    if (signal.aborted || !this.journal.policy().capabilities.length && !this.journal.hasRequest("claim")) return;
    const response = await this.client.request("jobs/claim", {}, "claim"); strictRecord(response, ["job"]);
    if (!response.job) { this.journal.clearRequest("claim"); return; }
    strictRecord(response.job, ["plan", "payload"]);
    const plan = this.client.verifyPlanSnapshot(response.job.plan, response.job.payload);
    const job = this.journal.prepare(plan.job_id, plan.request_sha256, plan.authorization_id, plan.lease_id, plan, response.job.payload);
    this.journal.clearRequest("claim");
    if (job.state !== "prepared") { if (!this.journal.reported(job.job_id)) await this.report(job); return; }
    try { if (job.lease_id !== plan.lease_id) refuse("replay_conflict"); this.client.verifyPlan(response.job.plan, response.job.payload); }
    catch (error) {
      // A cached claim may be delivered after its lease expired or policy was
      // revoked. Persist the zero-execution outcome and reconcile it; never
      // replay this slot forever, silently obtain a new lease, or start it.
      this.journal.finish(plan.job_id, "failed", failure("failed", safeCode(error)));
      await this.report(this.journal.get(plan.job_id)!); return;
    }
    await this.execute(plan, response.job.payload, signal);
  }
  private async execute(plan: PrivilegedPlan, payload: PrivilegedPayload, outerSignal: AbortSignal): Promise<void> {
    const controller = new AbortController(), abort = () => controller.abort(); outerSignal.addEventListener("abort", abort, { once: true });
    if (outerSignal.aborted) controller.abort();
    const unit = "lightmoni-exec-" + sha256(plan.job_id + ":" + plan.request_sha256).slice(0, 32);
    let intent = false, permitUsed = false, renewing = false, leaseLost = false, runtimeExceeded = false;
    let startGuard: ExecutionStartGuard | undefined;
    let lastLease = this.clock.now() - (45_000 - this.client.remainingLeaseMS(plan)), lastClock = this.clock.now(); const boot = this.clock.bootID(), began = lastClock;
    const renew = async () => {
      if (renewing) return; renewing = true;
      try {
        const requested = this.clock.now();
        const response = await this.client.request("jobs/" + plan.job_id + "/renew", { lease_id: plan.lease_id });
        if (typeof response.cancel_requested !== "boolean" || !Number.isFinite(Date.parse(response.lease_expires_at))) refuse("invalid_lease");
        if (response.cancel_requested) controller.abort();
        lastLease = requested; // response latency never extends the lease window
        await this.heartbeat();
        const effective = this.journal.policy();
        if (effective.generation !== plan.policy_generation || !effective.capabilities.includes(plan.capability)) controller.abort();
      } catch { leaseLost = true; controller.abort(); }
      finally { renewing = false; }
    };
    const timer = setInterval(() => {
      try {
        const now = this.clock.now();
        if (!Number.isFinite(now) || now < lastClock || this.clock.bootID() !== boot) { leaseLost = true; controller.abort(); return; }
        lastClock = now;
        if (now - lastLease >= 45_000) { leaseLost = true; controller.abort(); return; }
        if (now - began >= plan.max_runtime_ms) { runtimeExceeded = true; controller.abort(); return; }
        if (now - lastLease >= 15_000) void renew();
      } catch { leaseLost = true; controller.abort(); }
    }, 250); timer.unref();
    const before = async (step: string) => {
      if (permitUsed || step !== (payload.kind === "script" ? "execute" : payload.kind === "managed" ? "managed.execute" : "docker." + payload.operation)) refuse("unexpected_execution_step");
      if (controller.signal.aborted || leaseLost) refuse("lease_unavailable");
      const nonce = randomBytes(32).toString("hex"); this.journal.nonce(plan.job_id, nonce);
      const result = await this.client.permit(plan, nonce);
      if (controller.signal.aborted || leaseLost) refuse("lease_unavailable");
      result.deadline.assert();
      this.journal.intent(plan.job_id, result.permit.permit_id, nonce, unit); intent = true;
      result.deadline.assert(); this.journal.running(plan.job_id); permitUsed = true;
      startGuard = { assert() { if (controller.signal.aborted || leaseLost) refuse("lease_unavailable"); result.deadline.assert(); }, snapshot: () => result.deadline.snapshot() };
    };
    let result: ScriptOutcome;
    try {
      if (payload.kind === "script") {
        // Validate identity before requesting authority, then the production host
        // repeats it immediately before start and the launcher repeats on entry.
        const profiles = await this.host.profiles(this.config);
        if (!profiles.capabilities.includes("script.elevated.v1")) refuse("dependency_unavailable");
        if (!this.config.accounts.some(account => sameAccount(account, payload.account)) || !sameAccount(this.host.scripts.account(payload.account.name), payload.account)) refuse("account_changed");
        await before("execute");
        result = await executeScript(payload, unit, this.config.accounts, this.host.scripts, controller.signal, startGuard);
      } else if(payload.kind==='managed') {
        const managed=this.host.managed;if(!managed)refuse('managed_adapter_unavailable');
        await before('managed.execute');
        result=await managed!(payload,{config:this.config,plan,unit,signal:controller.signal,guard:startGuard!});
      } else {
        const action = payload.operation, body: any = action === "list" ? { operation: action } : action === "pull" ? { operation: action, image: payload.image, platform: payload.platform }
          : action === "create" ? { operation: action, resource_id: payload.resource_id, revision: payload.resource_revision, image: payload.image, platform: payload.platform }
          : { operation: action, resource_id: payload.resource_id, revision: payload.resource_revision };
        // Even readonly list is explicitly authorized/audited once, whereas
        // mutating adapters request the permit after all readonly preflights.
        if (action === "list") await before("docker.list");
        const value = await this.host.docker.execute(body, { resources: this.journal.resources() as ManagedDockerResource[], beforeStep: before, assertStart: () => { if (!startGuard) refuse("start_permit_required"); startGuard!.assert(); } }, controller.signal);
        this.journal.setResources(value.resources); // durable before a success reply
        const { resources: _resources, ...summary } = value;
        const stdout = canonicalJSON(summary);
        result = { state: "succeeded", code: "container_succeeded", summary: "Approved container operation completed", exit_code: 0, stdout, stderr: "" };
      }
      if (leaseLost) result = failure("unknown", "lease_lost");
      else if (runtimeExceeded && result.state !== "unknown") result = { ...result, state: "failed", code: "timeout", summary: "Approved execution exceeded its runtime limit" };
      if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > payload.max_output_bytes) result = failure(intent ? "unknown" : "failed", "output_limit");
    } catch (error) { result = failure(intent ? "unknown" : "failed", safeCode(error)); }
    finally { clearInterval(timer); outerSignal.removeEventListener("abort", abort); }
    // Journal errors are fatal: do not report success or clear a fence if fsync
    // cannot prove that the final result/resource identity was persisted.
    this.journal.finish(plan.job_id, result.state, result);
    await this.report(this.journal.get(plan.job_id)!);
  }
  private async report(row: JournalJob): Promise<void> {
    const r = row.result;
    try {
      const response = await this.client.request("jobs/" + row.job_id + "/result", { lease_id: row.lease_id, state: r.state, code: r.code, summary: r.summary, exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr }, "result:" + row.job_id);
      if (!response.job || response.job.id !== row.job_id) refuse("invalid_result_acknowledgment");
      this.journal.acknowledge(row.job_id); this.journal.clearRequest("result:" + row.job_id);
    } catch (error) {
      // The center may already have fenced an expired lease. Its explicit
      // reconciliation endpoint can acknowledge that fact, never overwrite it.
      const response = await this.client.request("jobs/" + row.job_id + "/reconcile", { lease_id: row.lease_id });
      if (!response.job || response.job.id !== row.job_id) throw error;
      if (["succeeded", "failed", "cancelled", "unknown"].includes(response.job.state)) this.journal.acknowledge(row.job_id); else throw error;
      if (row.state === "unknown" && response.release_fence === true) {if(this.host.managed===runManaged)releaseManagedOperationLock(row);this.journal.releaseFence(row.job_id);}
    }
  }
  private async reconcile(row: JournalJob): Promise<void> {
    const response = await this.client.request("jobs/" + row.job_id + "/reconcile", { lease_id: row.lease_id });
    if (!response.job || response.job.id !== row.job_id || typeof response.release_fence !== "boolean") refuse("invalid_reconciliation");
    if (row.state === "unknown" && response.release_fence) {if(this.host.managed===runManaged)releaseManagedOperationLock(row);this.journal.releaseFence(row.job_id);}
  }
}
