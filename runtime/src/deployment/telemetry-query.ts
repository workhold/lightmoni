import type { Catalog, ClickHouse, Table } from "../shared/types.js";
import { formatNanoTime, parseNanoTime } from "../shared/otlp.js";
import { publicTableName } from "../server/catalog.js";
import { systemTable, validTable } from "../server/auth.js";
import { verifyTelemetry, type TelemetryVerificationResult, type TelemetryVerificationRequest } from "./verification.js";

export interface TelemetryBinding {
  table: string;
  service: string;
  instance_id: string;
}

export interface DeploymentTelemetrySummary extends TelemetryVerificationResult {
  selector: TelemetryBinding;
  serviceVersion: string;
  deadline: string;
}

function text(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !/[\p{Cc}\p{Cs}]/u.test(value) && Buffer.byteLength(value, "utf8") <= bytes;
}

/** Validate syntax only; the actual reader catalog is checked on each query. */
export function validateTelemetryBinding(raw: unknown): TelemetryBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("invalid_telemetry_binding");
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "instance_id,service,table" ||
      !text(value.table, 128) || !/^[a-z][a-z0-9_]*$/.test(value.table) ||
      !text(value.service, 256) || !text(value.instance_id, 128)) {
    throw Error("invalid_telemetry_binding");
  }
  return { table: value.table, service: value.service, instance_id: value.instance_id };
}

const stringType = /^(?:String|LowCardinality\(String\))$/;
const timeType = /^DateTime64\([0-9],\s*'UTC'\)$/;

function usableTable(table: Table, binding: TelemetryBinding): boolean {
  if (table.name !== binding.table || table.system !== false ||
      !validTable(table.logical_name) || systemTable(table.logical_name) ||
      (table as Table & { is_compat_alias?: number | boolean }).is_compat_alias) return false;
  if (table.kind === "metric" ? !["sum", "gauge", "histogram"].includes(table.metric_type ?? "") :
      !["log", "trace"].includes(table.kind) || !!table.metric_type) return false;
  if (publicTableName(table.logical_name, table.kind, table.metric_type) !== table.name) return false;
  return ["service", "instance_id", "service_version", "event_time", "ingested_at"].every(name => {
    const columns = table.columns.filter(column => column.name === name);
    return columns.length === 1 && !columns[0].nullable &&
      (name.endsWith("_time") || name === "ingested_at" ? timeType : stringType).test(columns[0].type);
  });
}

function utcTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // ClickHouse JSON DateTime64 is UTC but omits a timezone. Never interpret it
  // using the centre host's local timezone or truncate nanosecond boundaries.
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,9})?$/.test(value)
    ? value.replace(" ", "T") + "Z" : value;
  try { parseNanoTime(normalized); return normalized; } catch { return undefined; }
}

export interface DeploymentTelemetryQuery {
  reader: Pick<ClickHouse, "query">;
  cat: Pick<Catalog, "list">;
  serviceId: string;
  deploymentId: string;
  binding: TelemetryBinding;
  serviceVersion: string;
  finishedAt: string;
  now?: Date;
  signal?: AbortSignal;
}

/** Bounded reader-only evidence lookup. No arbitrary SQL or row payload escapes. */
export async function queryDeploymentTelemetry(input: DeploymentTelemetryQuery): Promise<DeploymentTelemetrySummary> {
  const now = input.now ? new Date(input.now.getTime()) : new Date();
  let binding: TelemetryBinding, from: string, to: string, deadline: string;
  try {
    binding = validateTelemetryBinding(input.binding);
    const start = parseNanoTime(input.finishedAt);
    from = formatNanoTime(start);
    to = formatNanoTime(start + 300_000_000_000n);
    deadline = formatNanoTime(start + 360_000_000_000n);
  } catch {
    return {
      state: "invalid", serviceId: "", deploymentId: "", selector: { table: "", service: "", instance_id: "" },
      serviceVersion: "", observedSamples: 0, minSamples: 1, from: "", to: "", deadline: "",
      checkedAt: Number.isFinite(now.getTime()) ? now.toISOString() : "1970-01-01T00:00:00.000Z", code: "invalid_request",
    };
  }
  const request: TelemetryVerificationRequest = {
    serviceId: input.serviceId, deploymentId: input.deploymentId, selector: binding,
    serviceVersion: input.serviceVersion, from, to, deadline, minSamples: 1,
  };
  const summarize = (result: TelemetryVerificationResult): DeploymentTelemetrySummary => ({
    ...result, selector: binding, serviceVersion: input.serviceVersion, deadline,
  });
  const initial = verifyTelemetry(request, [], now);
  if (initial.state === "invalid" || now.getTime() <= Number(parseNanoTime(from) / 1_000_000n)) return summarize(initial);
  const timeout = AbortSignal.timeout(5000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    const tables = await input.cat.list(signal);
    signal.throwIfAborted();
    const matches = tables.filter(table => table.name === binding.table);
    if (matches.length !== 1 || !usableTable(matches[0], binding)) {
      return summarize({ ...initial, state: "invalid", code: "invalid_request" });
    }
    const upper = parseNanoTime(now.toISOString()) < parseNanoTime(to) ? now.toISOString() : to;
    const chTime = (value: string) => value.replace("T", " ").replace(/Z$/, "");
    const result = await input.reader.query(
      `SELECT service, instance_id, service_version, event_time, ingested_at FROM \`${binding.table}\`
WHERE service={service:String} AND instance_id={instance:String} AND service_version={version:String}
AND event_time>={from:DateTime64(9,'UTC')} AND event_time<{to:DateTime64(9,'UTC')}
AND ingested_at>={from:DateTime64(9,'UTC')} AND ingested_at<={now:DateTime64(9,'UTC')}
LIMIT 1000
SETTINGS max_execution_time=3, max_memory_usage=67108864, max_rows_to_read=1000000, read_overflow_mode='throw', max_result_rows=1000, result_overflow_mode='throw'`,
      { service: binding.service, instance: binding.instance_id, version: input.serviceVersion,
        from: chTime(from), to: chTime(upper), now: chTime(now.toISOString()) }, signal,
    );
    signal.throwIfAborted();
    if (!Array.isArray(result.data) || result.rows !== result.data.length) return summarize(verifyTelemetry(request, undefined, now));
    // The reader contract is bounded, but still reject an oversized upstream
    // reply before walking or transforming any untrusted rows.
    if (result.data.length > 1000) return summarize({ ...initial, state: "invalid", code: "too_many_rows" });
    const rows = result.data.map(row => ({
      service: row?.service, instanceId: row?.instance_id, serviceVersion: row?.service_version,
      eventTime: utcTimestamp(row?.event_time), ingestedAt: utcTimestamp(row?.ingested_at),
    }));
    return summarize(verifyTelemetry(request, rows, now));
  } catch {
    return summarize(verifyTelemetry(request, undefined, now));
  }
}
