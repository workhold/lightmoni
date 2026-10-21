import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJSON } from "../shared/io.js";
import { CapabilityExecutor, type ExecutorJob, type ExecutionReceipt } from "./executor.js";

export interface JobClientConfig {
  endpoint: string;
  agentID: string;
  controlCredential: string;
  dataDir: string;
  pollIntervalMs?: number;
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
        "health.systemd", "health.http", "health.tcp",
      ],
      receipt_cursor: this.cursor,
    });
    const job = reply.job;
    if (!job) return null;
    this.cursor = job.id;
    this.persist({ id: job.id, lease_id: job.lease_id, started_at: this.now().toISOString() });
    const executor = new CapabilityExecutor({
      now: this.now,
      emit: async (event) => {
        await this.request(`/api/v1/agents/${encodeURIComponent(this.config.agentID)}/jobs/${encodeURIComponent(job.id)}/events`, {
          lease_id: job.lease_id,
          sequence: Number((job.next_sequence ?? 0)) + 1,
          phase: event.phase,
          code: event.code ?? "",
          summary: event.summary,
          snapshot: event.snapshot ?? {},
        });
        job.next_sequence = Number(job.next_sequence ?? 0) + 1;
      },
    });
    const targetConfig = job.target?.config ?? {};
    const target = {
      releaseDirectory: String(targetConfig.release_directory ?? targetConfig.releaseDirectory ?? ""),
      unit: String(targetConfig.unit ?? ""),
    };
    const result = await executor.execute({ id: job.id, expires_at: job.expires_at, capabilities: job.capabilities, actions: job.actions, target } as ExecutorJob);
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
