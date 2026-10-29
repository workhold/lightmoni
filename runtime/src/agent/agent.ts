import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { hostname } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import protobuf from "protobufjs";
import {
  createLightMoni,
  DeliveryError,
  type LightMoni,
  type FrozenBatch,
} from "@lightmoni/sdk";
import { atomicWrite, atomicJSON } from "../shared/io.js";
import { stringifyJSON } from "../shared/json.js";
import {
  decodeOTLP,
  encodeOTLP,
  decodeOTLPResponse,
  resources,
  resourceString,
  resourceSet,
  inputHash,
  parseNanoTime,
  formatNanoTime,
  nowNano,
  type Signal,
} from "../shared/otlp.js";
import {
  VERSION,
  validateConfig,
  loadIdentity,
  normalizeRemote,
  validateRemote,
  listenAddress,
  validTable,
  type Config,
  type RemoteConfig,
} from "./config.js";
import {
  Queue,
  CapacityError,
  ConflictError,
  type Batch,
  type Queued,
  type LogCursor,
} from "./queue.js";
import { Collector } from "./collect.js";
import { FileLogReader } from "./file-logs.js";
import { checkProbe } from "./probe.js";
import { AgentJobRunner } from "./jobs.js";
import {
  ReceiveError,
  requestBytes,
  responseBytes,
  delay,
  validateSDKConfig,
} from "./util.js";
export interface RuntimeEvent {
  id: string;
  time: string;
  severity: string;
  event: string;
  body: string;
}
export class Agent {
  readonly identity;
  readonly queue: Queue;
  readonly sdk: LightMoni;
  readonly files: FileLogReader;
  readonly jobs?: AgentJobRunner;
  tasks: RemoteConfig;
  tasksReady = false;
  revision = "";
  collectors: Record<string, string> = {};
  lastError = "";
  lastSuccess = "0001-01-01T00:00:00Z";
  runtimeEvents: RuntimeEvent[] = [];
  server?: Server;
  private controller = new AbortController();
  private loops: Promise<void>[] = [];
  private sequence = 0;
  private runtimeInstance = nowNano().toString();
  private closed = false;
  private taskGeneration = 0;
  private relayPromise: Promise<{ status: number; body: Buffer }> | undefined;
  constructor(readonly config: Config) {
    validateConfig(config);
    this.identity = loadIdentity(config.data_dir);
    this.queue = new Queue(config);
    this.tasks = normalizeRemote({
      collect_interval_seconds: config.collect_interval_seconds,
      probes: config.probes,
      process_names: config.process_names,
    });
    this.runtimeEvent("INFO", "started", "Agent started");
    try {
      this.sdk = createLightMoni({
        service: "lightmoni-agent",
        table: "host",
        instanceId: this.identity.agent_id,
        selfTelemetry: false,
        // Telemetry and SDK configuration use the independent data audience.
        key: config.data_credential,
        // Agent task configuration is fetched through its authenticated control plane.
        remoteConfig: false,
        intervalMs: config.collect_interval_seconds * 1000,
        maxBatchBytes: Math.floor(config.max_batch_bytes / 2),
        exporter: {
          deliver: async (batch: FrozenBatch, signal: AbortSignal) => {
            if (signal.aborted) throw signal.reason;
            try {
              this.accept(
                {
                  id: batch.id,
                  signal: batch.signal,
                  table: batch.table,
                  service: batch.service,
                  created_at: batch.createdAt,
                  payload: Buffer.from(batch.payload),
                  content_type: batch.contentType,
                },
                true,
              );
            } catch (e) {
              if (e instanceof ReceiveError)
                throw new DeliveryError(
                  e.message,
                  e.status === 429 || e.status === 503,
                );
              throw e;
            }
          },
        },
      });
    } catch (e) {
      this.queue.close();
      throw e;
    }
    this.files = new FileLogReader(this);
    if (config.control_credential) {
      this.jobs = new AgentJobRunner({
        endpoint: config.endpoint,
        agentID: this.identity.agent_id,
        controlCredential: config.control_credential,
        dataDir: config.data_dir,
        pollIntervalMs: Math.max(5000, config.control_interval_seconds * 1000),
      });
    }
  }
  private safe(message: string) {
    for (const secret of [
      this.config.control_credential,
      this.config.data_credential,
      this.config.local_token,
    ])
      if (secret) message = message.split(secret).join("[redacted]");
    let raw = Buffer.from(message);
    if (raw.length > 1024) {
      raw = raw.subarray(0, 1024);
      while (raw.length && raw.toString("utf8").endsWith("�"))
        raw = raw.subarray(0, -1);
    }
    return raw.toString("utf8");
  }
  runtimeEvent(severity: string, event: string, body: string) {
    this.runtimeEvents.push({
      id: `${this.runtimeInstance}-${++this.sequence}`,
      time: formatNanoTime(nowNano()),
      severity,
      event,
      body: this.safe(body),
    });
    if (this.runtimeEvents.length > 64) this.runtimeEvents.shift();
  }
  setError(message: string) {
    if (this.lastError !== message)
      this.runtimeEvent("WARN", "execution_failed", message);
    this.lastError = this.safe(message);
  }
  collectorStatus(name: string, status: string) {
    const old = this.collectors[name];
    this.collectors[name] = this.safe(status);
    if (old !== status && status !== "ok" && status !== "disabled")
      this.runtimeEvent("WARN", "collector_failed", name + ": " + status);
  }
  status() {
    const stats = this.sdk.stats(),
      legacyStats = Object.fromEntries(
        Object.entries(stats).map(([k, v]) => [
          k[0].toUpperCase() + k.slice(1),
          v,
        ]),
      );
    return {
      agent_id: this.identity.agent_id,
      group_id: this.config.group_id,
      host_id: this.identity.host_id,
      hostname: hostname(),
      version: VERSION,
      platform: process.platform === "win32" ? "windows" : process.platform,
      arch: process.arch === "x64" ? "amd64" : process.arch,
      config_revision: this.revision,
      ...this.queue.stats(),
      last_error: this.lastError,
      last_success_at: this.lastSuccess,
      collectors_status: { ...this.collectors },
      sdk: legacyStats,
      runtime_events: [...this.runtimeEvents],
      control_interval_seconds: this.config.control_interval_seconds,
    };
  }
  accept(batch: Batch, owned: boolean, cursor?: LogCursor): void {
    if (!validTable(batch.table))
      throw new ReceiveError(
        400,
        "table must be a logical name matching [a-z][a-z0-9_]{0,47}, without signal prefix",
      );
    if (batch.payload.length > this.config.max_batch_bytes)
      throw new ReceiveError(413, "batch exceeds configured byte limit");
    if (
      !/^(?:urn:uuid:)?(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})$/i.test(
        batch.id,
      )
    )
      throw new ReceiveError(400, "invalid batch ID");
    let created: bigint;
    try {
      created = parseNanoTime(batch.created_at);
    } catch {
      throw new ReceiveError(
        400,
        "valid X-Lightmoni-Batch-Created-At required",
      );
    }
    const now = nowNano();
    if (now - created > BigInt(this.config.max_age_seconds) * 1000000000n)
      throw new ReceiveError(400, "expired: batch exceeds max_age_seconds");
    if (created > now + 300000000000n)
      throw new ReceiveError(400, "batch created_at is too far in the future");
    let msg: any;
    try {
      msg = decodeOTLP(batch.signal, batch.payload, batch.content_type);
    } catch (e) {
      throw new ReceiveError(
        400,
        "invalid OTLP payload: " + (e as Error).message,
      );
    }
    const rs = resources(batch.signal, msg);
    if (!rs.length) throw new ReceiveError(400, "empty resource request");
    const services = new Set<string>();
    for (const r of rs) {
      const service = resourceString(r, "service.name");
      if (!service || Buffer.byteLength(service) > 128)
        throw new ReceiveError(
          400,
          "service.name is required and at most 128 bytes",
        );
      services.add(service);
    }
    if (owned && services.size !== 1)
      throw new ReceiveError(
        400,
        "stable LightMoni batches must contain one service; split exports by service",
      );
    if (batch.service && !services.has(batch.service))
      throw new ReceiveError(400, "batch service differs from OTLP resource");
    const b = {
        ...batch,
        service: [...services].sort()[0],
        created_at: formatNanoTime(created),
      },
      hash = inputHash(b.signal, b.table, b.created_at, msg),
      receipt = this.queue.receipt(b.id);
    if (receipt && receipt.input_hash !== hash)
      throw new ReceiveError(
        409,
        "batch ID conflicts with previously accepted payload",
      );
    const identity = receipt?.identity ?? this.identity;
    for (const r of rs) {
      resourceSet(r, "host.id", identity.host_id);
      resourceSet(r, "lightmoni.agent_id", identity.agent_id);
    }
    b.payload = encodeOTLP(b.signal, msg);
    b.content_type = "application/x-protobuf";
    if (b.payload.length > this.config.max_batch_bytes)
      throw new ReceiveError(
        413,
        "enriched batch exceeds limit; lower SDK max_batch_bytes",
      );
    try {
      this.queue.enqueue(
        b,
        hash,
        identity,
        receipt?.received_ns ?? now,
        cursor,
      );
    } catch (e) {
      if (e instanceof CapacityError) throw new ReceiveError(503, e.message);
      if (e instanceof ConflictError) throw new ReceiveError(409, e.message);
      throw e;
    }
  }
  authorize(req: IncomingMessage, receiver = false) {
    const expected = this.config.local_token;
    if (!expected) return true;
    const header = String(req.headers.authorization ?? "");
    if (!receiver && !header.startsWith("Bearer ")) return false;
    const token = header.replace(/^Bearer /, "");
    const a = Buffer.from(token),
      b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  handler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname,
      method = req.method ?? "GET";
    const respond = (status: number, body: any, json = true) => {
      res.writeHead(status, {
        "Content-Type": json ? "application/json" : "text/plain",
      });
      res.end(json ? stringifyJSON(body) : body);
    };
    try {
      if (method === "GET" && path === "/healthz") {
        this.queue.stats();
        respond(200, "OK", false);
        return;
      }
      if (method === "GET" && path === "/status") {
        if (!this.authorize(req)) {
          respond(401, "local token required", false);
          return;
        }
        respond(200, this.status());
        return;
      }
      if (method === "GET" && path === "/v1/sdk-config") {
        if (!this.authorize(req)) {
          respond(401, "local token required", false);
          return;
        }
        const controller = new AbortController();
        res.once("close", () => {
          if (!res.writableFinished) controller.abort();
        });
        this.relayPromise ??= this.relaySDKConfig(controller.signal).finally(
          () => {
            this.relayPromise = undefined;
          },
        );
        const result = await this.relayPromise;
        res.writeHead(result.status, {
          "Content-Type":
            result.status === 200 ? "application/json" : "text/plain",
          "Cache-Control": "no-store",
        });
        if (result.status === 200 && new URL(req.url ?? '/', 'http://localhost').searchParams.get('metric_windows') !== '1') {
          const legacy = JSON.parse(result.body.toString());
          delete legacy.metric_windows;
          res.end(JSON.stringify(legacy));
        } else res.end(result.body);
        return;
      }
      const signal = path.slice(4) as Signal;
      if (
        method === "POST" &&
        ["logs", "metrics", "traces"].includes(signal) &&
        path === "/v1/" + signal
      ) {
        await this.receive(req, res, signal);
        return;
      }
      respond(404, "Not Found", false);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (path === "/healthz") respond(503, "Service Unavailable", false);
      else {
        this.setError("agent request failed: " + (e as Error).message);
        respond(503, "durable queue unavailable", false);
      }
    }
  };
  private async receive(
    req: IncomingMessage,
    res: ServerResponse,
    signal: Signal,
  ) {
    const contentType = String(
      req.headers["content-type"] ?? "application/x-protobuf",
    )
      .split(";")[0]
      .trim()
      .toLowerCase();
    const fail = (status: number, message: string) => {
      if (status === 429 || status === 503) res.setHeader("Retry-After", "2");
      res.writeHead(status, { "Content-Type": contentType });
      res.end(
        contentType === "application/json"
          ? JSON.stringify({ message })
          : Buffer.from(
              protobuf.Writer.create().uint32(18).string(message).finish(),
            ),
      );
    };
    try {
      if (!this.authorize(req, true))
        throw new ReceiveError(401, "local receiver token required");
      const payload = await requestBytes(req, this.config.max_batch_bytes),
        headerID = req.headers["x-lightmoni-batch-id"],
        owned = typeof headerID === "string" && headerID !== "";
      this.accept(
        {
          id: owned ? headerID : randomUUID(),
          signal,
          table: String(req.headers["x-lightmoni-table"] ?? ""),
          created_at: owned
            ? String(req.headers["x-lightmoni-batch-created-at"] ?? "")
            : formatNanoTime(nowNano()),
          payload,
          content_type: contentType,
        },
        owned,
      );
      res.writeHead(200, { "Content-Type": contentType });
      res.end(contentType === "application/json" ? "{}" : Buffer.alloc(0));
    } catch (e) {
      if (e instanceof ReceiveError) fail(e.status, e.message);
      else {
        this.setError("durable receive: " + (e as Error).message);
        fail(503, "durable queue unavailable");
      }
    }
  }
  private async relaySDKConfig(
    parent: AbortSignal,
  ): Promise<{ status: number; body: Buffer }> {
    const path = join(this.config.data_dir, "sdk-config.json");
    let raw: Buffer | undefined;
    try {
      const response = await fetch(
        this.config.endpoint.replace(/\/$/, "") + "/v1/sdk-config?metric_windows=1",
        {
          redirect: "manual",
          headers: {
            "X-Lightmoni-Agent-ID": this.identity.agent_id,
            Authorization:
              "Bearer " + this.config.control_credential,
          },
          signal: AbortSignal.any([parent, AbortSignal.timeout(5000)]),
        },
      );
      if (response.status !== 200 && response.status < 500) {
        await response.body?.cancel();
        return {
          status: response.status,
          body: Buffer.from("configuration access denied"),
        };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw Error("unavailable");
      }
      raw = await responseBytes(response, 1 << 20);
    } catch {
      try {
        raw = readFileSync(path);
      } catch {
        return { status: 503, body: Buffer.from("configuration unavailable") };
      }
    }
    try {
      const config = validateSDKConfig(raw);
      if (!existsSync(path) || !readFileSync(path).equals(raw))
        try {
          atomicWrite(path, raw);
        } catch {}
      return { status: 200, body: Buffer.from(stringifyJSON(config)) };
    } catch {
      return { status: 503, body: Buffer.from("invalid configuration") };
    }
  }
  applyRemote(config: Partial<RemoteConfig>, persist = true) {
    const c = normalizeRemote(config);
    validateRemote(c);
    if (persist)
      atomicJSON(join(this.config.data_dir, "remote-config.json"), c);
    this.tasks = c;
    this.revision = c.revision;
    this.collectors = {};
    this.tasksReady = true;
    this.taskGeneration++;
    this.runtimeEvent(
      "INFO",
      "configuration_applied",
      "Agent task configuration applied",
    );
  }
  private async controlRequest(path: string, method: string, body?: any) {
    const response = await fetch(
      this.config.endpoint.replace(/\/$/, "") + path,
      {
        method,
        redirect: "manual",
        headers: {
          Authorization:
            "Bearer " + this.config.control_credential,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(15000),
        ]),
      },
    );
    if (response.status === 304) {
      await response.body?.cancel();
      return undefined;
    }
    const raw = await responseBytes(response, 1 << 20);
    if (response.status < 200 || response.status >= 300)
      throw Error("control HTTP " + response.status);
    return raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
  }
  async controlOnce(registered: boolean): Promise<boolean> {
    const status = this.status();
    if (!registered) {
      await this.controlRequest("/api/v1/agents/register", "POST", status);
      registered = true;
      this.acknowledgeRuntime(status.runtime_events);
    }
    await this.controlRequest(
      "/api/v1/agents/" + this.identity.agent_id + "/heartbeat",
      "POST",
      status,
    );
    this.acknowledgeRuntime(status.runtime_events);
    const remote = await this.controlRequest(
      "/api/v1/agents/" + this.identity.agent_id + "/config",
      "GET",
    );
    if (
      remote &&
      (remote.revision !== this.revision ||
        remote.group_id !== this.tasks.group_id)
    )
      this.applyRemote(remote);
    return registered;
  }
  private acknowledgeRuntime(events: RuntimeEvent[]) {
    const sent = new Set(events.map((e) => e.id));
    this.runtimeEvents = this.runtimeEvents.filter((e) => !sent.has(e.id));
  }
  private async controlLoop() {
    const signal = this.controller.signal;
    try {
      const path = join(this.config.data_dir, "remote-config.json");
      if (existsSync(path))
        this.applyRemote(JSON.parse(readFileSync(path, "utf8")), false);
    } catch {
      this.setError("cached configuration invalid");
    }
    let registered = false;
    while (!signal.aborted) {
      try {
        registered = await this.controlOnce(registered);
      } catch (e) {
        if (!signal.aborted) this.setError("control: " + (e as Error).message);
      }
      await delay(this.config.control_interval_seconds * 1000, signal);
    }
  }
  async send(
    batch: Queued,
    parent = this.controller.signal,
  ): Promise<{ message: string; permanent?: boolean; retryAfter?: number }> {
    try {
      const response = await fetch(
        this.config.endpoint.replace(/\/$/, "") + "/v1/" + batch.signal,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": batch.content_type,
            "X-Lightmoni-Table": batch.table,
            "X-Lightmoni-Batch-ID": batch.id,
            "X-Lightmoni-Batch-Created-At": batch.created_at,
            "X-Lightmoni-Agent-ID": this.identity.agent_id,
            Authorization:
              "Bearer " + this.config.data_credential,
          },
          body: new Uint8Array(batch.payload),
          signal: AbortSignal.any([parent, AbortSignal.timeout(15000)]),
        },
      );
      const raw = await responseBytes(response, 4 << 20);
      if (response.status === 200) {
        let result: any;
        try {
          result = decodeOTLPResponse(
            batch.signal,
            raw,
            response.headers.get("Content-Type")?.startsWith("application/json")
              ? "application/json"
              : "application/x-protobuf",
          );
        } catch {
          return { message: "upstream invalid OTLP acknowledgment" };
        }
        if (result.partialSuccess !== undefined)
          return {
            message: "upstream partial success requires operator review",
            permanent: true,
          };
        return { message: "" };
      }
      return {
        message: `upstream HTTP ${response.status}`,
        permanent: ![401, 403, 429, 502, 503, 504].includes(response.status),
        retryAfter: [401, 403].includes(response.status)
          ? 30000
          : retryAfter(response.headers.get("Retry-After")),
      };
    } catch {
      return { message: "upstream network error" };
    }
  }
  async forwardOnce(): Promise<number> {
    const batch = this.queue.next();
    if (!batch) return 250;
    if (
      nowNano() - parseNanoTime(batch.created_at) >
      BigInt(this.config.max_age_seconds) * 1000000000n
    ) {
      this.queue.quarantine(batch.id, "expired: maximum replay age exceeded");
      return 0;
    }
    const result = await this.send(batch);
    if (this.controller.signal.aborted) return 0;
    if (!result.message) {
      this.queue.complete(batch.id);
      this.lastSuccess = formatNanoTime(nowNano());
      this.lastError = "";
      return 0;
    }
    if (result.permanent) {
      this.queue.quarantine(batch.id, result.message);
      this.setError(result.message);
      return 0;
    }
    const base = 1000 * 2 ** Math.min(batch.attempts, 6),
      ms = Math.max(
        Math.floor(base / 2 + (Math.random() * base) / 2),
        result.retryAfter ?? 0,
      );
    this.queue.retry(
      batch.id,
      result.message,
      nowNano() + BigInt(ms) * 1000000n,
    );
    this.setError(result.message);
    return ms;
  }
  private async forwardLoop() {
    while (!this.controller.signal.aborted) {
      let ms = 250;
      try {
        ms = await this.forwardOnce();
      } catch (e) {
        this.setError("queue update failed: " + (e as Error).message);
      }
      await delay(ms, this.controller.signal);
    }
  }
  private async waitTasks() {
    while (!this.tasksReady && !this.controller.signal.aborted)
      await delay(100, this.controller.signal);
    return !this.controller.signal.aborted;
  }
  async collectOnce() {
    const c = new Collector(
      this.sdk.withTable(this.tasks.host_table),
      this.identity.host_id,
      this.collectorStatus.bind(this),
    );
    await c.collect(
      this.tasks,
      () => this.queue.stats(),
      this.controller.signal,
    );
    await this.sdk.flush({ timeoutMs: 5000 });
  }
  private async collectLoop() {
    if (!(await this.waitTasks())) return;
    let collector: Collector | undefined,
      last = "";
    while (!this.controller.signal.aborted) {
      const tasks = this.tasks,
        settings = JSON.stringify([
          tasks.host_table,
          tasks.host_collectors,
          tasks.process_names,
          tasks.host_enabled,
        ]),
        generation = this.taskGeneration;
      if (!collector || last !== settings) {
        collector = new Collector(
          this.sdk.withTable(tasks.host_table),
          this.identity.host_id,
          this.collectorStatus.bind(this),
        );
        last = settings;
      }
      try {
        await collector.collect(
          tasks,
          () => this.queue.stats(),
          this.controller.signal,
        );
      } catch (e) {
        this.collectorStatus("host", (e as Error).message);
      }
      const deadline = Date.now() + tasks.collect_interval_seconds * 1000;
      while (
        !this.controller.signal.aborted &&
        generation === this.taskGeneration &&
        Date.now() < deadline
      )
        await delay(
          Math.min(250, deadline - Date.now()),
          this.controller.signal,
        );
    }
  }
  private async fileLogLoop() {
    if (!(await this.waitTasks())) return;
    try {
      while (!this.controller.signal.aborted) {
        try {
          this.files.poll(this.tasks, this.controller.signal);
          this.collectorStatus(
            "file_logs",
            this.tasks.logs_enabled ? "ok" : "disabled",
          );
        } catch (e) {
          this.collectorStatus("file_logs", (e as Error).message);
        }
        await delay(2000, this.controller.signal);
      }
    } finally {
      this.files.close();
    }
  }
  private async jobLoop() {
    if (!this.jobs) return;
    await this.jobs.run(this.controller.signal);
  }
  private async probeLoop() {
    if (!(await this.waitTasks())) return;
    const next = new Map<string, number>(),
      running = new Map<string, Promise<void>>();
    let version = "";
    try {
      while (!this.controller.signal.aborted) {
        const tasks = this.tasks,
          taskVersion = tasks.revision + "\0" + tasks.group_id;
        if (taskVersion !== version) {
          next.clear();
          version = taskVersion;
        }
        const active = new Set(tasks.probes.map((p) => p.id));
        for (const id of next.keys()) if (!active.has(id)) next.delete(id);
        const client = this.sdk.withTable(tasks.probe_table),
          success = client.gauge("probe.success", { unit: "1" }),
          attempts = client.counter("probe.attempts", { unit: "1" }),
          failures = client.counter("probe.failures", { unit: "1" }),
          skipped = client.counter("probe.skipped", { unit: "1" }),
          duration = client.histogram("probe.duration", {
            unit: "s",
            boundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
          });
        for (const p of tasks.probes) {
          const now = Date.now();
          if (now < (next.get(p.id) ?? 0)) continue;
          next.set(p.id, now + p.interval_seconds * 1000);
          const attrs = { probe_id: p.id, kind: p.kind };
          if (running.has(p.id) || running.size >= 16) {
            skipped.add(1, attrs);
            continue;
          }
          const task = (async () => {
            const result = await checkProbe(p, this.controller.signal);
            const resultAttrs = { ...attrs, result: result.reason };
            attempts.add(1, resultAttrs);
            if (!result.success) failures.add(1, resultAttrs);
            success.record(result.success ? 1 : 0, attrs);
            duration.record(result.duration, resultAttrs);
          })()
            .catch((e) => this.setError("probe: " + (e as Error).message))
            .finally(() => running.delete(p.id));
          running.set(p.id, task);
        }
        await delay(250, this.controller.signal);
      }
    } finally {
      await Promise.allSettled(running.values());
    }
  }
  async listen() {
    if (this.server) throw Error("agent already listening");
    const { host, port } = listenAddress(this.config.listen);
    this.server = createServer((req, res) => {
      void this.handler(req, res);
    });
    this.server.headersTimeout = 5000;
    this.server.requestTimeout = 20000;
    this.server.timeout = 20000;
    this.server.keepAliveTimeout = 60000;
    this.server.maxHeadersCount = 200;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        this.server!.removeListener("error", reject);
        this.server!.on("error", (error) => {
          this.setError("listener: " + error.message);
          this.controller.abort(error);
        });
        resolve();
      });
    });
    return this.server.address();
  }
  async start(parent?: AbortSignal) {
    if (parent) {
      if (parent.aborted) this.controller.abort(parent.reason);
      else
        parent.addEventListener(
          "abort",
          () => this.controller.abort(parent.reason),
          { once: true },
        );
    }
    await this.listen();
    this.loops = [
      this.forwardLoop(),
      this.controlLoop(),
      this.collectLoop(),
      this.probeLoop(),
      this.fileLogLoop(),
      this.jobLoop(),
    ];
  }
  async run(parent?: AbortSignal) {
    await this.start(parent);
    await new Promise<void>((resolve) => {
      if (this.controller.signal.aborted) resolve();
      else
        this.controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
    });
    await this.close();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    if (this.server) {
      this.server.closeIdleConnections();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.server!.closeAllConnections();
          resolve();
        }, 5000);
        this.server!.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await Promise.allSettled(this.loops);
    this.files.close();
    let error: unknown;
    try {
      await this.sdk.shutdown({ timeoutMs: 3000 });
    } catch (e) {
      error = e;
    } finally {
      this.queue.close();
    }
    if (error) throw error;
  }
}
export function createAgent(config: Config) {
  return new Agent(config);
}
function retryAfter(value: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, 2147483647);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, Math.min(date - Date.now(), 2147483647))
    : 0;
}
