import type { Dependencies } from "../shared/types.js";
import { fail } from "../shared/http.js";
import { bytes, frameMaps, id, validRange } from "./common.js";

const ident = (s: string) => "`" + s.replaceAll("`", "``") + "`";
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");
export const TRACE_CAPABILITY_BYTES = 60 << 10;
export interface TraceReadInput { trace_id: string; tables: string[]; from: string; to: string }

/** Shared Trace read path for the existing HTTP route and capability adapters. */
export class TraceReadService {
  constructor(private readonly deps: Dependencies) {}
  async get(input: TraceReadInput, signal: AbortSignal, bounded = false) {
    const trace = input.trace_id;
    if (!trace || typeof trace !== "string" || bytes(trace) > 256) fail(400, "无效的Trace ID");
    const range = {from: input.from, to: input.to};
    try { validRange(range, 1); } catch (error) { fail(400, (error as Error).message); }
    if (!Array.isArray(input.tables) || input.tables.length < 1 || input.tables.length > 8) fail(400, "Trace数据表超限");
    const tables = await this.deps.cat.list(signal), spans: any[] = [];
    let truncated = false;
    for (const tid of input.tables) {
      const table = tables.find(t => t.id === tid && t.kind === "trace");
      if (!table) fail(400, "需要指定有效的Trace表");
      const cols = ["event_id", "service", "trace_id", "span_id", "parent_span_id", "name", "kind", "start_time", "end_time", "duration_ns", "status", "attributes_json", "events_json"]
        .filter(name => table.columns.some(c => c.name === name));
      if (!cols.length) continue;
      let data;
      try {
        data = frameMaps(await this.deps.query({ request_id: id(), source: "interactive", range, interval_ms: 60000,
          queries: [{ refId: "trace", sql: `SELECT ${cols.map(ident).join(",")} FROM ${ident(table.name)} WHERE trace_id={trace_id:String} AND $__timeFilter(event_time) ORDER BY start_time,span_id LIMIT 2001`,
            params: {trace_id: {type: "String", value: trace}} }] }, signal));
      } catch (error) { if ((error as any)?.status) throw error; fail(502, (error as Error).message); }
      truncated ||= data.truncated || data.values.length > 2000;
      for (const span of data.values.slice(0, 2000)) spans.push({...span, table_id: tid});
    }
    const known = new Set(spans.map(v => v.span_id));
    const missing = spans.filter(v => v.parent_span_id && v.parent_span_id !== "0000000000000000" && !known.has(v.parent_span_id)).length;
    const output = {trace_id: trace, spans, truncated, incomplete: missing > 0 || truncated || !spans.length, missing_parents: missing, ...range};
    if (!bounded) return output;
    while (size(output) > TRACE_CAPABILITY_BYTES && output.spans.length > 1) {
      output.spans = output.spans.slice(0, -Math.max(1, Math.ceil(output.spans.length / 4)));
      output.truncated = true; output.incomplete = true;
    }
    if (size(output) > TRACE_CAPABILITY_BYTES) fail(413, "result_too_large");
    return output;
  }
}
