import { gunzipSync } from "node:zlib";
import { LosslessNumber } from "lossless-json";
import {
  decodeOTLP,
  formatNanoTime,
  parseNanoTime,
  nowNano,
  goJSON,
  type Signal,
} from "../shared/otlp.js";
import { stringifyJSON } from "../shared/json.js";
import { hash, id } from "../shared/crypto.js";
import { Serial } from "../shared/serial.js";
import { fail } from "../shared/http.js";
import type { Context } from "../shared/types.js";
import { Auth, validTable, systemTable } from "./auth.js";
import { Catalog } from "./catalog.js";
export interface Normalized {
  kind: string;
  subtype: string;
  row: Record<string, any>;
}
export const stamp = (n: bigint | string | number) => {
  const ns = BigInt.asIntN(64, BigInt(n)),
    text = formatNanoTime(ns),
    parts = text.slice(0, -1).split(".");
  return parts[0].replace("T", " ") + "." + (parts[1] ?? "").padEnd(9, "0");
};
export function anyValue(v: any): any {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("boolValue" in v) return v.boolValue;
  if ("intValue" in v) return new LosslessNumber(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValue);
  if (v.kvlistValue) return attrs(v.kvlistValue.values);
  if ("bytesValue" in v)
    return Buffer.from(v.bytesValue, "base64").toString("hex");
  return null;
}
export const attrs = (values: any[] = []): Record<string, any> =>
  Object.fromEntries(values.map((v) => [v.key ?? "", anyValue(v.value)]));
const text = (v: any) => (v === undefined || v === null ? "" : String(v));
const attrText = (values: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      typeof v === "string" ? v : goJSON(v, true),
    ]),
  );
const temporality = (v: any) =>
  ["UNSPECIFIED", "DELTA", "CUMULATIVE"][Number(v ?? 0)] ?? String(v);
function base(
  resource: any,
  attributes: any[],
  at: string | number | bigint,
  received: string,
  key: string,
) {
  const a = attrs(attributes);
  return {
    event_time: stamp(at),
    ingested_at: received,
    service: text(resource["service.name"]),
    instance_id: text(resource["service.instance.id"]),
    host_id: text(resource["host.id"]),
    agent_id: text(resource["lightmoni.agent_id"]),
    key_id: key,
    resource_json: goJSON(resource, true),
    attributes: attrText(a),
    attributes_json: goJSON(a, true),
  };
}
export function normalize(
  signal: Signal,
  payload: any,
  received: string,
  key: string,
): Normalized[] {
  const out: Normalized[] = [];
  if (signal === "logs")
    for (const rs of payload.resourceLogs ?? []) {
      const resource = attrs(rs.resource?.attributes);
      for (const scope of rs.scopeLogs ?? [])
        for (const log of scope.logRecords ?? []) {
          const a = attrs(log.attributes),
            body = anyValue(log.body),
            at =
              BigInt(log.timeUnixNano ?? 0) ||
              BigInt(log.observedTimeUnixNano ?? 0) ||
              parseNanoTime(received.replace(" ", "T") + "Z");
          const row: any = base(resource, log.attributes, at, received, key);
          Object.assign(row, {
            severity:
              log.severityText ||
              [
                "UNSPECIFIED",
                "TRACE",
                "DEBUG",
                "INFO",
                "WARN",
                "ERROR",
                "FATAL",
              ][
                Math.min(
                  6,
                  Math.floor((Number(log.severityNumber ?? 0) + 3) / 4),
                )
              ],
            severity_number: Number(log.severityNumber ?? 0),
            body: typeof body === "string" ? body : goJSON(body, true),
            body_json: goJSON(body, true),
            trace_id: log.traceId ?? "",
            span_id: log.spanId ?? "",
            source_id:
              text(a["lightmoni.source_id"]) ||
              text(resource["service.instance.id"]),
            source_seq: a["lightmoni.source_seq"] ?? null,
          });
          out.push({ kind: "log", subtype: "", row });
        }
    }
  if (signal === "metrics")
    for (const rs of payload.resourceMetrics ?? []) {
      const resource = attrs(rs.resource?.attributes);
      for (const scope of rs.scopeMetrics ?? [])
        for (const metric of scope.metrics ?? []) {
          const subtype = metric.sum
            ? "sum"
            : metric.gauge
              ? "gauge"
              : metric.histogram
                ? "histogram"
                : "";
          if (!subtype)
            throw Error(
              "unsupported metric type; use Sum/Gauge/explicit Histogram",
            );
          const data = metric[subtype];
          for (const p of data.dataPoints ?? []) {
            const row: any = base(
              resource,
              p.attributes,
              p.timeUnixNano ?? 0,
              received,
              key,
            );
            Object.assign(row, {
              name: metric.name ?? "",
              unit: metric.unit ?? "",
              start_time: stamp(p.startTimeUnixNano ?? 0),
            });
            if (subtype === "histogram") {
              const bounds = p.explicitBounds ?? [],
                buckets = p.bucketCounts ?? [],
                count = BigInt(p.count ?? 0);
              if (buckets.length !== bounds.length + 1)
                throw Error("invalid histogram buckets");
              let total = 0n;
              for (const b of buckets) {
                total += BigInt(b);
                if (total > (1n << 64n) - 1n)
                  throw Error("histogram count overflow");
              }
              if (total !== count) throw Error("histogram count mismatch");
              if (
                bounds.some(
                  (b: number, i: number) =>
                    !Number.isFinite(b) || (i > 0 && b <= bounds[i - 1]),
                )
              )
                throw Error("invalid histogram bounds");
              for (const v of [p.sum, p.min, p.max])
                if (v !== undefined && !Number.isFinite(v))
                  throw Error("histogram values must be finite");
              Object.assign(row, {
                bounds,
                bucket_counts: buckets.map(
                  (n: any) => new LosslessNumber(String(n)),
                ),
                count: count.toString(),
                sum: p.sum ?? null,
                min: p.min ?? null,
                max: p.max ?? null,
                temporality: temporality(data.aggregationTemporality),
              });
            } else {
              if (p.asInt !== undefined)
                Object.assign(row, {
                  value: String(p.asInt),
                  value_type: "int",
                  value_int: String(p.asInt),
                  value_float: Number(p.asInt),
                });
              else if (p.asDouble !== undefined && Number.isFinite(p.asDouble))
                Object.assign(row, {
                  value:
                    Math.abs(p.asDouble) < 1e29
                      ? legacyDecimal(p.asDouble)
                      : "0",
                  value_type: "double",
                  value_int: null,
                  value_float: p.asDouble,
                });
              else throw Error("metric value must be finite and present");
              if (subtype === "sum")
                Object.assign(row, {
                  temporality: temporality(data.aggregationTemporality),
                  monotonic: data.isMonotonic ?? false,
                });
            }
            out.push({ kind: "metric", subtype, row });
          }
        }
    }
  if (signal === "traces")
    for (const rs of payload.resourceSpans ?? []) {
      const resource = attrs(rs.resource?.attributes);
      for (const scope of rs.scopeSpans ?? [])
        for (const span of scope.spans ?? []) {
          if (
            !/^[0-9a-f]{32}$/i.test(span.traceId ?? "") ||
            !/^[0-9a-f]{16}$/i.test(span.spanId ?? "") ||
            (span.parentSpanId && !/^[0-9a-f]{16}$/i.test(span.parentSpanId))
          )
            throw Error("invalid span IDs");
          const start = BigInt(span.startTimeUnixNano ?? 0),
            end = BigInt(span.endTimeUnixNano ?? 0);
          if (end < start) throw Error("invalid span duration");
          const row: any = base(
            resource,
            span.attributes,
            start,
            received,
            key,
          );
          Object.assign(row, {
            trace_id: span.traceId,
            span_id: span.spanId,
            parent_span_id: span.parentSpanId ?? "",
            name: span.name ?? "",
            kind:
              [
                "SPAN_KIND_UNSPECIFIED",
                "SPAN_KIND_INTERNAL",
                "SPAN_KIND_SERVER",
                "SPAN_KIND_CLIENT",
                "SPAN_KIND_PRODUCER",
                "SPAN_KIND_CONSUMER",
              ][Number(span.kind ?? 0)] ?? String(span.kind),
            start_time: stamp(start),
            end_time: stamp(end),
            duration_ns: String(end - start),
            status:
              ["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"][
                Number(span.status?.code ?? 0)
              ] ?? String(span.status?.code),
            events_json: goJSON(
              span.events?.length ? span.events.map(legacyEvent) : null,
            ),
            links_json: goJSON(
              span.links?.length ? span.links.map(legacyLink) : null,
            ),
          });
          out.push({ kind: "trace", subtype: "", row });
        }
    }
  if (out.some((n) => !n.row.service))
    throw Error("service.name resource is required");
  return out;
}
// Preserve the historical encoding/json shape inside trace event/link text.
function legacyKV(a: any): any {
  const out: any = {};
  if (a.key) out.key = a.key;
  if (a.value) out.value = legacyAny(a.value);
  return out;
}
function legacyAny(value: any): any {
  const fields = [
    "stringValue",
    "boolValue",
    "intValue",
    "doubleValue",
    "arrayValue",
    "kvlistValue",
    "bytesValue",
    "stringValueStrindex",
  ];
  for (const key of fields)
    if (value[key] !== undefined) {
      let v = value[key];
      if (key === "intValue") v = new LosslessNumber(String(v));
      else if (key === "arrayValue")
        v = v.values?.length ? { values: v.values.map(legacyAny) } : {};
      else if (key === "kvlistValue")
        v = v.values?.length ? { values: v.values.map(legacyKV) } : {};
      const label = key[0].toUpperCase() + key.slice(1);
      return { Value: { [label]: v } };
    }
  return { Value: null };
}
function legacyEvent(event: any): any {
  const out: any = {};
  if (BigInt(event.timeUnixNano ?? 0))
    out.time_unix_nano = new LosslessNumber(String(event.timeUnixNano));
  if (event.name) out.name = event.name;
  if (event.attributes?.length) out.attributes = event.attributes.map(legacyKV);
  if (event.droppedAttributesCount)
    out.dropped_attributes_count = event.droppedAttributesCount;
  return out;
}
function legacyLink(link: any): any {
  const out: any = {};
  if (link.traceId) out.trace_id = link.traceId;
  if (link.spanId) out.span_id = link.spanId;
  if (link.traceState) out.trace_state = link.traceState;
  if (link.attributes?.length) out.attributes = link.attributes.map(legacyKV);
  if (link.droppedAttributesCount)
    out.dropped_attributes_count = link.droppedAttributesCount;
  if (link.flags) out.flags = link.flags;
  return out;
}
// strconv.FormatFloat(...,'f',9,64) rounds the exact binary value, ties to even.
export function legacyDecimal(value: number): string {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value);
  const bits = bytes.readBigUInt64LE(),
    negative = bits >> 63n !== 0n,
    exponent = Number((bits >> 52n) & 2047n),
    mantissa = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n),
    power = (exponent || 1) - 1023 - 52;
  let n = mantissa * 1000000000n;
  if (power >= 0) n <<= BigInt(power);
  else {
    const denominator = 1n << BigInt(-power),
      q = n / denominator,
      remainder = n % denominator;
    n =
      q +
      (remainder * 2n > denominator ||
      (remainder * 2n === denominator && q % 2n === 1n)
        ? 1n
        : 0n);
  }
  const digits = n.toString().padStart(10, "0");
  return (negative ? "-" : "") + digits.slice(0, -9) + "." + digits.slice(-9);
}
export function sdkRuntime(n: Normalized, source: string) {
  const a = n.row.attributes;
  if (
    a["lightmoni.component"] !== "sdk" ||
    ![
      "go",
      "typescript",
      "python",
      "java",
      "dotnet",
      "php",
      "ruby",
      "rust",
    ].includes(a["sdk.language"])
  )
    return false;
  if (n.kind === "metric" && n.subtype === "gauge") {
    if (
      !/^lightmoni\.sdk\.(heartbeat|pending_batches|pending_bytes|retried_batches|dropped_records|rejected_records|invalid_records|overflow_records)$/.test(
        n.row.name,
      )
    )
      return false;
  } else if (n.kind === "log") {
    if (!["started", "diagnostics_changed"].includes(a.event)) return false;
  } else return false;
  a.source_table = source;
  n.row.attributes_json = goJSON(a, true);
  return true;
}
export class Ingest {
  private serial = new Serial();
  constructor(
    readonly cat: Catalog,
    readonly auth: Auth,
    readonly accepted?: (
      signal: string,
      records: number,
      bytes: number,
    ) => void,
  ) {}
  register() {
    for (const signal of ["logs", "metrics", "traces"] as const)
      this.auth.router.post("/v1/" + signal, (c) => this.receive(c, signal), {
        public: true,
      });
  }
  async internal(
    table: string,
    rows: Normalized[],
    batch = id(),
    signal?: AbortSignal,
  ) {
    if (!systemTable(table))
      throw Error("internal telemetry requires a system table");
    const grouped = new Map<string, any[]>();
    for (const [i, n] of rows.entries()) {
      const target =
        "_lm_" +
        (await this.cat.ensure(
          table,
          n.kind,
          n.subtype,
          n.row.service,
          signal,
        ));
      n.row.event_id ??= hash(batch + "/" + i);
      const data = grouped.get(target) ?? [];
      data.push(n.row);
      grouped.set(target, data);
    }
    for (const [target, data] of grouped)
      await this.cat.ch.insert(target, data, signal);
  }
  private success(c: Context) {
    if ((c.req.headers["content-type"] ?? "").includes("json")) c.json({});
    else {
      c.res.writeHead(200, { "content-type": "application/x-protobuf" });
      c.res.end();
    }
  }
  async receive(c: Context, signal: Signal) {
    const key = this.auth.validateKey(c),
      table = String(c.req.headers["x-lightmoni-table"] ?? "");
    if (!validTable(table))
      fail(400, "X-Lightmoni-Table requires a logical business name");
    if (systemTable(table)) fail(403, "系统内置表由内部监控链路写入");
    if (!key.allow_all_tables && !key.allowed_tables.includes(table)) {
      this.auth.recordKey(
        key.id,
        "",
        "rejected",
        "table not allowed: " + table,
      );
      fail(403, "Key 无权写入 table: " + table);
    }
    let raw = await c.raw(
      c.req.headers["content-encoding"] === "gzip"
        ? (4 << 20) + (64 << 10)
        : 4 << 20,
    );
    if (c.req.headers["content-encoding"] === "gzip")
      try {
        raw = gunzipSync(raw, { maxOutputLength: (4 << 20) + 1 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
          fail(413, "batch exceeds 4 MiB");
        fail(400, "invalid gzip");
      }
    if (raw.length > 4 << 20) fail(413, "batch exceeds 4 MiB");
    const batch = String(c.req.headers["x-lightmoni-batch-id"] ?? "") || id();
    if (batch.length > 128) fail(400, "invalid batch ID");
    const created = String(c.req.headers["x-lightmoni-batch-created-at"] ?? "");
    if (created) {
      let at: bigint;
      try {
        at = parseNanoTime(created);
      } catch {
        fail(400, "invalid batch creation time");
      }
      const age = nowNano() - at;
      if (age < -300000000000n) fail(400, "invalid batch creation time");
      if (age > 86400000000000n)
        fail(400, "batch expired beyond 24-hour replay window");
    }
    await this.serial.run(async () => {
      const digest = hash(
        Buffer.concat([Buffer.from(signal + "\0" + table + "\0"), raw]),
      );
      let old: any;
      try {
        old = this.cat.db.get<any>(
          "SELECT * FROM ingest_batches WHERE id=?",
          batch,
        );
      } catch {
        fail(503, "batch metadata store unavailable");
      }
      if (old && old.digest !== digest) {
        this.auth.recordKey(
          key.id,
          "",
          "rejected",
          "batch ID content conflict",
        );
        fail(400, "batch ID already has different content");
      }
      if (old?.completed) {
        this.success(c);
        return;
      }
      const received = old?.first_received_at ?? stamp(nowNano()),
        firstKey = old?.key_id ?? key.id;
      let rows: Normalized[];
      try {
        rows = normalize(
          signal,
          decodeOTLP(
            signal,
            raw,
            String(c.req.headers["content-type"] ?? "").includes("json")
              ? "application/json"
              : "application/x-protobuf",
          ),
          received,
          firstKey,
        );
      } catch (e) {
        this.auth.recordKey(
          key.id,
          "",
          "rejected",
          e instanceof Error ? e.message : "invalid OTLP",
        );
        fail(400, e instanceof Error ? e.message : "invalid OTLP");
      }
      const now = nowNano();
      for (const n of rows) {
        const at = parseNanoTime(n.row.event_time.replace(" ", "T") + "Z");
        if (
          at > now + 300000000000n ||
          at < now - BigInt(n.kind === "metric" ? 30 : 7) * 86400000000000n
        )
          fail(
            400,
            "event falls outside retention or is ahead of server clock",
          );
      }
      try {
        this.cat.db.run(
          "INSERT OR IGNORE INTO ingest_batches(id,digest,first_received_at,key_id) VALUES(?,?,?,?)",
          batch,
          digest,
          received,
          firstKey,
        );
      } catch {
        fail(503, "batch metadata store unavailable");
      }
      const grouped = new Map<string, any[]>();
      let service = "";
      try {
        for (const [i, n] of rows.entries()) {
          service = n.row.service;
          const route = sdkRuntime(n, table) ? "lightmoni_sdk" : table,
            target =
              "_lm_" +
              (await this.cat.ensure(
                route,
                n.kind,
                n.subtype,
                service,
                c.signal,
              ));
          n.row.event_id = hash(batch + "\0" + signal + "\0" + i);
          const data = grouped.get(target) ?? [];
          data.push(n.row);
          grouped.set(target, data);
        }
        for (const [target, data] of grouped)
          await this.cat.ch.insert(target, data, c.signal);
      } catch (e) {
        this.auth.recordKey(
          key.id,
          service,
          "error",
          "telemetry storage failed",
        );
        fail(503, "telemetry storage unavailable");
      }
      try {
        this.cat.db.run(
          "UPDATE ingest_batches SET completed=1 WHERE id=?",
          batch,
        );
      } catch {
        fail(503, "batch confirmation failed");
      }
      try {
        this.cat.db.run(
          "DELETE FROM ingest_batches WHERE first_received_at<?",
          stamp(now - 172800000000000n),
        );
      } catch {}
      this.auth.recordKey(
        key.id,
        service,
        "accepted",
        rows.length + " records",
      );
      this.accepted?.(signal, rows.length, raw.length);
      this.success(c);
    });
  }
}
