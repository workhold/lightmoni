import { randomBytes } from "node:crypto";
import type { Dependencies, QueryResponse, Table } from "../shared/types.js";
import { fail } from "../shared/http.js";

export interface TelemetryQueryInput {
  sql: string;
  range: {from: string; to: string};
  interval_ms: number;
  params?: Record<string, {type: string; value: unknown}>;
}
export const TELEMETRY_SAMPLE_ROWS = 1000;
export const TELEMETRY_SAMPLE_BYTES = 60 << 10;
export const ASSISTANT_TELEMETRY_SAMPLE_BYTES = 16 << 10;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");
const assistantTimeMacro = /\$__timeFilter\(\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\s*\)/;

/** Shared telemetry application service for assistant, MCP and HTTP adapters. */
export class TelemetryService {
  constructor(private readonly deps: Dependencies) {}

  async list(signal: AbortSignal): Promise<Table[]> {
    try { return await this.deps.cat.list(signal); }
    catch { throw Error("cannot read table catalog"); }
  }

  async describe(reference: string, signal: AbortSignal): Promise<Table> {
    let tables: Table[];
    try { tables = await this.deps.cat.list(signal); }
    catch { throw Error("cannot read table catalog"); }
    const table = tables.find(item => item.id === reference || item.name === reference);
    if (!table) throw Error("table does not exist in the catalog");
    return table;
  }

  async query(input: TelemetryQueryInput, signal: AbortSignal, source: "assistant" | "mcp" | "web") {
    const sql = input.sql;
    if (typeof sql !== "string" || !sql.trim() || Buffer.byteLength(sql) > 16000
      || !Number.isSafeInteger(input.interval_ms) || input.interval_ms <= 0) throw Error("SQL and a positive interval_ms are required");
    if (!input.range || typeof input.range !== "object") throw Error("invalid tool input");
    const {from, to} = input.range, a = Date.parse(from), b = Date.parse(to);
    const rfc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
    if (!rfc.test(from) || !rfc.test(to) || !Number.isFinite(a) || !Number.isFinite(b) || a >= b || b - a > 90 * 864e5)
      throw Error("query range must be a valid increasing UTC range within 90 days");
    if (input.params != null) {
      if (typeof input.params !== "object" || Array.isArray(input.params)) throw Error("invalid tool input");
      for (const value of Object.values(input.params)) {
        if (!value || typeof value !== "object" || Array.isArray(value)
          || Object.keys(value).some(key => !["type", "value"].includes(key))) throw Error("invalid tool input");
      }
    }
    if (source === "assistant" && !assistantTimeMacro.test(sql))
      throw Error("assistant SQL must include $__timeFilter(column) with a verified time column");
    const response: QueryResponse = await this.deps.query({
      request_id: randomBytes(16).toString("hex"), range: {from, to}, interval_ms: input.interval_ms,
      source, queries: [{refId: "A", sql, params: input.params}],
    }, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    if (response.results.length !== 1) throw Error("query executor returned an unexpected result count");
    let remaining = TELEMETRY_SAMPLE_ROWS, sampled = false;
    for (const result of response.results) {
      if (["error", "cancelled"].includes(result.status)) throw Error(result.error || "query did not complete successfully");
      for (const frame of result.frames) {
        if (frame.rows.length > remaining) { frame.rows = frame.rows.slice(0, remaining); sampled = true; }
        remaining -= frame.rows.length;
      }
    }
    const byteLimit = source === "assistant" ? ASSISTANT_TELEMETRY_SAMPLE_BYTES : TELEMETRY_SAMPLE_BYTES;
    const output = { query: response, range: input.range, sample_limit: TELEMETRY_SAMPLE_ROWS,
      sample_truncated: sampled, sample_byte_limit: byteLimit, sample_byte_limited: false };
    const frames = response.results.flatMap(result => result.frames);
    while (size(output) > byteLimit) {
      const frame = frames.reduce((largest, item) => item.rows.length > (largest?.rows.length ?? 0) ? item : largest, frames[0]);
      if (!frame?.rows.length) break;
      frame.rows = frame.rows.slice(0, -Math.max(1, Math.ceil(frame.rows.length / 4)));
      output.sample_truncated = true; output.sample_byte_limited = true;
    }
    if (size(output) > byteLimit) fail(413, "result_too_large");
    return output;
  }
}
