import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJSON } from "../shared/io.js";
import { CapabilityExecutor, type ExecutorJob, type ExecutionReceipt } from "./executor.js";
import type { DeploymentAction } from "../deployment/types.js";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const ARTIFACT_FORMAT = "lightmoni-release-v1.tar.gz";

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
  private async downloadArtifact(job: any, action: Extract<DeploymentAction, { kind: "stage_artifact" }>, signal: AbortSignal): Promise<Buffer> {
    if (typeof job?.lease_id !== "string" || !job.lease_id || typeof job.id !== "string" || !job.id)
      throw Object.assign(Error("artifact download requires the active job lease"), { code: "artifact_unavailable" });
    if (!Number.isSafeInteger(action.size) || action.size < 1 || action.size > MAX_ARTIFACT_BYTES)
      throw Object.assign(Error("artifact size is invalid"), { code: "invalid_artifact" });
    const path = `/api/v1/agents/${encodeURIComponent(this.config.agentID)}/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(action.release_id)}`;
    const response = await this.fetcher(this.config.endpoint.replace(/\/$/, "") + path, {
      method: "GET",
      headers: {
        authorization: "Bearer " + this.config.controlCredential,
        "X-LightMoni-Job-Lease": job.lease_id,
      },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(Error(`artifact download HTTP ${response.status}`), { code: "artifact_unavailable" });
    }
    const contentLength = response.headers.get("content-length");
    const expectedDigest = response.headers.get("x-artifact-sha256");
    const format = response.headers.get("x-artifact-format");
    if (!contentLength || !/^\d+$/.test(contentLength) || Number(contentLength) !== action.size
      || !expectedDigest || expectedDigest.toLowerCase() !== action.sha256.toLowerCase()
      || format !== ARTIFACT_FORMAT) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(Error("artifact response metadata does not match the approved release"), { code: "invalid_artifact" });
    }
    if (!response.body) throw Object.assign(Error("artifact response body is empty"), { code: "invalid_artifact" });
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) throw signal.reason ?? Object.assign(Error("artifact download cancelled"), { code: "execution_cancelled" });
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > action.size || total > MAX_ARTIFACT_BYTES)
          throw Object.assign(Error("artifact response exceeds the approved size"), { code: "invalid_artifact" });
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    if (total !== action.size) throw Object.assign(Error("artifact response size mismatch"), { code: "size_mismatch" });
    return Buffer.concat(chunks, total);
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
      capabilities: [
        "artifact.stage", "artifact.activate_release", "systemd.daemon_reload", "systemd.enable", "systemd.disable", "systemd.start", "systemd.restart", "systemd.stop",
        "health.systemd", "health.http", "health.tcp", "systemd.probe",
      ],
      receipt_cursor: this.cursor,
    });
    const job = reply.job;
    if (!job) return null;
    this.cursor = job.id;
    this.persist({ id: job.id, lease_id: job.lease_id, started_at: this.now().toISOString() });
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
      downloadArtifact: (action, signal) => this.downloadArtifact(job, action, signal),
      emit: enqueueEvent,
    });
    const targetConfig = job.target?.config ?? {};
    const target = {
      releaseDirectory: String(targetConfig.release_directory ?? targetConfig.releaseDirectory ?? ""),
      unit: String(targetConfig.unit ?? ""),
    };
    let result: ExecutionReceipt;
    try {
      result = await executor.execute({ id: job.id, expires_at: job.expires_at, capabilities: job.capabilities, actions: job.actions, target } as ExecutorJob, controller.signal);
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
