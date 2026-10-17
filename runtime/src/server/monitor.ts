import { hostname } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createLightMoni } from "@lightmoni/sdk";
import { decodeOTLP, nowNano } from "../shared/otlp.js";
import { normalize, stamp, type Ingest } from "./ingest.js";
import type { Catalog } from "./catalog.js";
export class RuntimeMonitor {
  readonly client;
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private timer?: NodeJS.Timeout;
  private readonly requests;
  private readonly records;
  private readonly bytes;
  private readonly duration;
  private readonly gauges;
  constructor(
    readonly ingest: Ingest,
    readonly secrets: string[] = [],
  ) {
    this.client = createLightMoni({
      service: "lightmoni-center",
      table: "lightmoni_center",
      resource: { "host.name": hostname() },
      selfTelemetry: false,
      remoteConfig: false,
      intervalMs: 10000,
      exporter: {
        deliver: async (b, signal) =>
          ingest.internal(
            b.table,
            normalize(
              b.signal,
              decodeOTLP(b.signal, b.payload, b.contentType),
              stamp(nowNano()),
              "system",
            ),
            b.id,
            signal,
          ),
      },
    });
    this.requests = this.client.counter("lightmoni.center.ingest_requests", {
      unit: "{request}",
    });
    this.records = this.client.counter("lightmoni.center.received_records", {
      unit: "{record}",
    });
    this.bytes = this.client.counter("lightmoni.center.received_bytes", {
      unit: "By",
    });
    this.duration = this.client.histogram("lightmoni.center.ingest_duration", {
      unit: "ms",
    });
    this.gauges = Object.fromEntries(
      [
        "heartbeat",
        "heap_bytes",
        "active_resources",
        "event_loop_delay_ms",
        "pending_batches",
        "dropped_records",
      ].map((name) => [name, this.client.gauge("lightmoni.center." + name)]),
    );
  }
  accepted(signal: string, records: number, bytes: number) {
    this.records.add(records, { signal });
    this.bytes.add(bytes, { signal });
  }
  request(signal: string, status: number, elapsed: number) {
    this.requests.add(1, { signal, status });
    this.duration.record(elapsed, { signal, status });
  }
  log(level: string, message: string) {
    let body = message;
    for (const secret of this.secrets)
      if (secret) body = body.split(secret).join("[redacted]");
    this.client.log(level, body.slice(0, 4096), {
      "lightmoni.component": "center",
    });
  }
  async start() {
    for (const [table, entries] of Object.entries({
      lightmoni_center: [
        "metric:sum",
        "metric:gauge",
        "metric:histogram",
        "log:",
      ],
      lightmoni_agent: ["metric:gauge", "log:"],
      lightmoni_sdk: ["metric:gauge", "log:"],
    }))
      for (const entry of entries) {
        const [kind, type] = entry.split(":");
        await this.ingest.cat.ensure(
          table,
          kind,
          type,
          table === "lightmoni_center"
            ? "lightmoni-center"
            : table === "lightmoni_agent"
              ? "lightmoni-agent"
              : "",
        );
      }
    this.loop.enable();
    const tick = () => {
      const stats = this.client.stats();
      this.gauges.heartbeat.record(1);
      this.gauges.heap_bytes.record(process.memoryUsage().heapUsed);
      this.gauges.active_resources.record(
        process.getActiveResourcesInfo().length,
      );
      this.gauges.event_loop_delay_ms.record(
        Number.isFinite(this.loop.mean) ? this.loop.mean / 1e6 : 0,
      );
      this.loop.reset();
      this.gauges.pending_batches.record(stats.pendingBatches);
      this.gauges.dropped_records.record(stats.droppedRecords);
    };
    tick();
    this.timer = setInterval(tick, 10000);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    this.loop.disable();
    await this.client.shutdown({ timeoutMs: 3000 });
  }
}
