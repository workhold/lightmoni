import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJSON } from "../shared/io.js";
import { CapabilityExecutor, type ExecutorJob, type ExecutionReceipt } from "./executor.js";
import { operationCommand } from "./operations.js";
import type { OperationExecutionContext } from "../operations/types.js";
import { executeDocker } from './docker.js';

// This production entry has no configuration switch for legacy host writes.
// Domain adapters remain reusable, but only the independent executor may gain
// authority for a migrated privileged action.
export const ORDINARY_JOB_CAPABILITIES = Object.freeze([
  "health.systemd", "health.http", "health.tcp", "systemd.probe", "docker.inventory",
]);
const ordinaryReadOnlyJob = (job: any): boolean => {
  if (!Array.isArray(job?.capabilities) || !Array.isArray(job.actions) || !job.actions.length
    || job.capabilities.some((cap: unknown) => typeof cap !== "string" || !ORDINARY_JOB_CAPABILITIES.includes(cap))) return false;
  return job.actions.every((action: any) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) return false;
    if (action.kind === "docker") return job.actions.length === 1 && action.operation === "inventory"
      && Object.keys(action).every(key => ["kind", "operation"].includes(key)) && job.capabilities.includes("docker.inventory");
    if (action.kind === "systemd_probe") return job.capabilities.includes("systemd.probe");
    if (action.kind === "health_check") {
      const capability = action.check?.kind === "systemd-active" ? "health.systemd"
        : action.check?.kind === "http" ? "health.http" : action.check?.kind === "tcp" ? "health.tcp" : "";
      return !!capability && job.capabilities.includes(capability);
    }
    return false;
  });
};

export interface JobClientConfig {
  endpoint: string;
  agentID: string;
  controlCredential: string;
  dataDir: string;
  pollIntervalMs?: number;
  /** Lease heartbeat period; override only for deterministic tests. */
  leaseHeartbeatIntervalMs?: number;
  now?: () => Date;
}
export interface JobClientIO {
  fetch?: typeof fetch;
  command?: OperationExecutionContext['command'];
  emit?: (event: { phase: string; code?: string; summary: string; snapshot?: Record<string, unknown> }) => Promise<void> | void;
}

/** Pulls one centre job at a time and keeps a small crash-recovery marker. */
export class AgentJobRunner {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly statePath: string;
  private cursor = "";
  private stopped = false;
  constructor(readonly config: JobClientConfig, readonly io: JobClientIO = {}) {
    this.fetcher = io.fetch ?? fetch;
    this.now = config.now ?? (() => new Date());
    this.statePath = join(config.dataDir, "agent-job-state.json");
  }
  private async request(path: string, body: Record<string, unknown>) {
    const response = await this.fetcher(this.config.endpoint.replace(/\/$/, "") + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + this.config.controlCredential },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await response.text();
    let value: any = {};
    try { value = raw ? JSON.parse(raw) : {}; } catch { throw Error("invalid agent job response"); }
    if (!response.ok) throw Error(value.error || `agent job HTTP ${response.status}`);
    return value;
  }
  private persist(job: any) {
    try { atomicJSON(this.statePath, job); } catch { /* queue telemetry reports storage failure elsewhere */ }
  }
  private load(): any | undefined {
    try { return existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, "utf8")) : undefined; } catch { return undefined; }
  }
  async recoverUnknown(): Promise<void> {
    const active = this.load();
    if (!active?.id || !active.lease_id) return;
    try {
      await this.request(`/api/v1/agents/${encodeURIComponent(this.config.agentID)}/jobs/${encodeURIComponent(active.id)}/result`, {
        lease_id: active.lease_id,
        state: "unknown",
        code: "unknown_execution_result",
        summary: "Agent restarted while a deployment action was in progress",
        started_at: active.started_at || "",
        finished_at: this.now().toISOString(),
        snapshot: {},
      });
      this.clear();
    } catch {
      // The lease can have expired while the process was down. Keep no stale
      // local command state; the centre will already mark that lease unknown.
      this.clear();
    }
  }
  private clear() {
    try { atomicJSON(this.statePath, {}); } catch {}
  }
  async pollOnce(): Promise<ExecutionReceipt | null> {
    if (!this.config.controlCredential) return null;
    const reply = await this.request(`/api/v1/agents/${encodeURIComponent(this.config.agentID)}/jobs/claim`, {
      capabilities: [...ORDINARY_JOB_CAPABILITIES],
      receipt_cursor: this.cursor,
    });
    const job = reply.job;
    if (!job) return null;
    this.cursor = job.id;
    this.persist({ id: job.id, lease_id: job.lease_id, started_at: this.now().toISOString() });
    // A stale or compromised control response cannot re-enable removed write
    // capabilities, even if this account accidentally has Docker/sudo access.
    if (!ordinaryReadOnlyJob(job)) {
      const result: ExecutionReceipt = { state: "failed", code: "privileged_executor_required",
        summary: "This action requires a separately authorized privileged executor",
        snapshot: {}, started_at: this.now().toISOString(), finished_at: this.now().toISOString() };
      await this.request(`/api/v1/agents/${encodeURIComponent(this.config.agentID)}/jobs/${encodeURIComponent(job.id)}/result`, { lease_id: job.lease_id, ...result });
      this.clear();
      return result;
    }
    const controller = new AbortController();
    let sequence = Number(job.next_sequence ?? 0);
    let activePhase = "accepted";
    let active = true;
    let renewalPending = false;
    let eventTail: Promise<void> = Promise.resolve();
    const enqueueEvent = (event: { phase: string; code?: string; summary: string; snapshot?: Record<string, unknown> }) => {
      const terminalEvent = ["succeeded", "failed", "cancelled", "unknown"].includes(event.phase);
      if (terminalEvent) active = false;
      // Once lease authority is lost, do not send a terminal event/result. Let
      // the executor unwind as unknown and leave the durable marker for recovery.
      if (terminalEvent && controller.signal.aborted) return Promise.resolve();
      const send = eventTail.then(async () => {
        if (controller.signal.aborted) throw controller.signal.reason ?? Error("agent job lease is no longer active");
        const next = sequence + 1;
        await this.request(`/api/v1/agents/${encodeURIComponent(this.config.agentID)}/jobs/${encodeURIComponent(job.id)}/events`, {
          lease_id: job.lease_id,
          sequence: next,
          phase: event.phase,
          code: event.code ?? "",
          summary: event.summary,
          snapshot: event.snapshot ?? {},
        });
        sequence = next;
        if (["accepted", "preflighting", "staging", "activating", "verifying"].includes(event.phase)) activePhase = event.phase;
        else active = false;
      });
      // Keep the queue usable for a terminal receipt attempt, while preserving
      // the error for this caller and stopping execution through the abort signal.
      eventTail = send.then(() => undefined, (error) => {
        if (!controller.signal.aborted) controller.abort(error);
      });
      return send;
    };
    const heartbeatMs = Math.max(10, this.config.leaseHeartbeatIntervalMs ?? 15000);
    const heartbeatTimer = setInterval(() => {
      if (!active || renewalPending || controller.signal.aborted) return;
      renewalPending = true;
      void enqueueEvent({ phase: activePhase, summary: "Agent is still executing the registered job" })
        .catch(() => {})
        .finally(() => { renewalPending = false; });
    }, heartbeatMs);
    heartbeatTimer.unref?.();
    const executor = new CapabilityExecutor({
      now: this.now,
      command: this.io.command ? (file, args, timeoutMs, signal) => this.io.command!(file, args, { timeoutMs, signal }) : undefined,
      emit: enqueueEvent,
    });
    const targetConfig = job.target?.config ?? {};
    const target = {
      releaseDirectory: String(targetConfig.release_directory ?? targetConfig.releaseDirectory ?? ""),
      unit: String(targetConfig.unit ?? ""),
    };
    let result: ExecutionReceipt;
    try {
      if (job.actions?.length === 1 && job.actions[0]?.kind === 'docker') {
        const action=job.actions[0];
        if(!job.capabilities?.includes('docker.inventory')||action.operation!=='inventory'||Date.parse(job.expires_at)<=this.now().getTime())throw Error('docker_job_mismatch');
        result=await executeDocker(action,job.id,{dataDir:this.config.dataDir,signal:controller.signal,now:this.now,command:this.io.command??operationCommand},enqueueEvent);
      } else {
        result = await executor.execute({ id: job.id, expires_at: job.expires_at, capabilities: job.capabilities, actions: job.actions, target } as ExecutorJob, controller.signal);
      }
    } finally {
      clearInterval(heartbeatTimer);
      await eventTail;
    }
    if (controller.signal.aborted) throw controller.signal.reason ?? Error("agent job lease is no longer active");
    await this.request(`/api/v1/agents/${encodeURIComponent(this.config.agentID)}/jobs/${encodeURIComponent(job.id)}/result`, {
      lease_id: job.lease_id,
      ...result,
    });
    this.clear();
    return result;
  }
  async run(signal: AbortSignal): Promise<void> {
    await this.recoverUnknown();
    // No website/Docker reconciliation runs here. A cached legacy marker must
    // never become fresh authority to mutate a host after an Agent restart.
    const delay = Math.max(1000, this.config.pollIntervalMs ?? 5000);
    while (!signal.aborted && !this.stopped) {
      try { await this.pollOnce(); } catch { /* next poll retries; centre retains the lease */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
  stop() { this.stopped = true; }
}
