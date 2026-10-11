import type { Parameter, QueryFrame, TimeRange } from "../../shared/types";
export interface Filter {
  scope: "column" | "attribute";
  field: string;
  type: "string" | "number" | "boolean";
  op: string;
  value?: unknown;
  disabled?: boolean;
}
export interface Spec {
  interval_ms?: number;
  table_id: string;
  range: TimeRange;
  services: string[];
  keyword: string;
  filters: Filter[];
  sort: "asc" | "desc";
  mode: "filters" | "sql";
  sql: string;
  params?: Record<string, Parameter>;
}
export interface View {
  columns: string[];
  pinned: string[];
  widths: Record<string, number>;
  lookback: number;
  aggregate_field?: string;
  explore_mode?: "logs" | "aggregate";
  chart_collapsed?: boolean;
  query_syntax?: "literal" | "expression";
  fields_collapsed?: boolean;
  row_lines?: number;
  refresh_seconds?: number;
}
export interface SearchResult {
  frame: QueryFrame;
  histogram: QueryFrame;
  histogram_truncated?: boolean;
  session_id: string;
  next_cursor: string;
  total_loaded: number;
  truncated: boolean;
  expires_at: string;
  generated_at: string;
  range: TimeRange;
  sql: string;
  count_sql: string;
  histogram_sql: string;
  params: Record<string, Parameter>;
  interval_ms: number;
  scope: string;
}
export interface Saved {
  id: string;
  title: string;
  spec: Spec;
  view: View;
  revision: number;
  updated_at: string;
}
export type LogRow = Record<string, unknown> & { event_id: string };
export const initialView: View = {
  columns: ["event_time", "severity", "service", "body"],
  pinned: ["event_time"],
  widths: { event_time: 210, severity: 95, service: 160, body: 520 },
  lookback: 60,
  query_syntax: "literal",
  row_lines: 1,
  refresh_seconds: 0,
};
export const timeRange = (minutes = 60): TimeRange => {
  const to = new Date();
  return {
    from: new Date(to.getTime() - minutes * 60000).toISOString(),
    to: to.toISOString(),
  };
};
export const initialSpec = (table_id = ""): Spec => ({
  table_id,
  range: timeRange(),
  services: [],
  keyword: "",
  filters: [],
  sort: "desc",
  mode: "filters",
  sql: "",
});
export function printable(v: unknown): string {
  return v === undefined
    ? "—"
    : v === null
      ? "null"
      : typeof v === "string"
        ? v
        : (JSON.stringify(v) ?? String(v));
}
export function asRows(frame: QueryFrame): LogRow[] {
  return frame.rows.map(
    (row) =>
      Object.fromEntries(
        frame.columns.map((c, i) => [c.name, row[i]]),
      ) as LogRow,
  );
}
export function attributes(row: LogRow): Record<string, unknown> {
  try {
    const raw = String(row.attributes_json ?? "{}");
    const exact = raw.replace(
      /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (token) =>
        !token.startsWith('"') &&
        /^-?\d+$/.test(token) &&
        !Number.isSafeInteger(Number(token))
          ? JSON.stringify(token)
          : token,
    );
    const parsed = JSON.parse(exact);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed;
  } catch {
    /* use normalized string attributes */
  }
  return (
    row.attributes && typeof row.attributes === "object" ? row.attributes : {}
  ) as Record<string, unknown>;
}
export function cell(row: LogRow, name: string): unknown {
  return name.startsWith("attr:") ? attributes(row)[name.slice(5)] : row[name];
}
export function mergeRows(
  old: LogRow[],
  incoming: LogRow[],
  limit = 5000,
): LogRow[] {
  const rows = new Map<string, LogRow>();
  for (const row of [...old, ...incoming])
    if (!rows.has(row.event_id)) rows.set(row.event_id, row);
  return [...rows.values()].slice(0, limit);
}
export function csv(rows: LogRow[], columns: string[]): string {
  const escape = (v: unknown) => {
    let s = printable(v);
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return [
    columns.map(escape).join(","),
    ...rows.map((row) => columns.map((c) => escape(cell(row, c))).join(",")),
  ].join("\r\n");
}
export function logURL(
  spec: Spec,
  event?: string,
  saved?: string,
  view?: View,
): string {
  const p = new URLSearchParams({
    table: spec.table_id,
    from: spec.range.from,
    to: spec.range.to,
  });
  if (spec.services?.length === 1) p.set("service", spec.services[0]);
  if (event) p.set("event", event);
  if (saved) p.set("saved", saved);
  else {
    const { table_id: _, range: __, ...query } = normalizeSpec(spec);
    p.set(
      "q",
      JSON.stringify({
        v: 1,
        query,
        ...(view ? { view: { ...view, lookback: 0, refresh_seconds: 0 } } : {}),
      }),
    );
  }
  return "/logs?" + p.toString();
}

// Shared links carry the applied query and display settings, never result rows,
// session cursors, credentials, or live polling state. Old links remain valid.
export function readLogURL(
  search: string,
  fallback: Spec,
): { spec: Spec; view?: View } {
  const p = new URLSearchParams(search);
  let spec = { ...fallback };
  if (p.has("from") && p.has("to"))
    spec.range = { from: p.get("from")!, to: p.get("to")! };
  if (p.has("service")) spec.services = [p.get("service")!];
  if (p.get("trace_id")) spec.filters = [...spec.filters, {scope:"column",field:"trace_id",type:"string",op:"eq",value:p.get("trace_id")!}];
  const raw = p.get("q");
  if (!raw) return { spec };
  try {
    if (raw.length > 65536) throw new Error();
    const payload = JSON.parse(raw),
      q = payload.query;
    if (
      payload.v !== 1 ||
      !q ||
      typeof q !== "object" ||
      typeof q.keyword !== "string" ||
      q.keyword.length > 1024 ||
      !Array.isArray(q.services) ||
      q.services.length > 64 ||
      q.services.some((s: unknown) => typeof s !== "string") ||
      !Array.isArray(q.filters) ||
      q.filters.length > 30 ||
      !["asc", "desc"].includes(q.sort) ||
      !["filters", "sql"].includes(q.mode)
    )
      throw new Error();
    for (const f of q.filters)
      if (
        !f ||
        !["column", "attribute"].includes(f.scope) ||
        typeof f.field !== "string" ||
        !["string", "number", "boolean"].includes(f.type) ||
        ![
          "eq",
          "ne",
          "in",
          "not_in",
          "exists",
          "not_exists",
          "gt",
          "gte",
          "lt",
          "lte",
        ].includes(f.op)
      )
        throw new Error();
    spec = normalizeSpec({ ...q, table_id: spec.table_id, range: spec.range });
    if (p.get('trace_id')&&!spec.filters.some(filter=>filter.scope==='column'&&filter.field==='trace_id'&&filter.op==='eq'&&filter.value===p.get('trace_id'))) spec.filters=[...spec.filters,{scope:'column',field:'trace_id',type:'string',op:'eq',value:p.get('trace_id')!}];
    const v = payload.view;
    if (!v) return { spec };
    if (
      !Array.isArray(v.columns) ||
      v.columns.length > 100 ||
      v.columns.some((s: unknown) => typeof s !== "string") ||
      !Array.isArray(v.pinned) ||
      v.pinned.some((s: unknown) => typeof s !== "string") ||
      !v.widths ||
      typeof v.widths !== "object"
    )
      throw new Error();
    return {
      spec,
      view: { ...initialView, ...v, lookback: 0, refresh_seconds: 0 },
    };
  } catch {
    throw new Error("检索链接中的条件无效，请检查链接或打开保存的检索。");
  }
}
export function fieldType(value: unknown): Filter["type"] {
  return typeof value === "number"
    ? "number"
    : typeof value === "boolean"
      ? "boolean"
      : "string";
}

export function sortRows(rows: LogRow[], direction: Spec["sort"]): LogRow[] {
  const fraction = (row: LogRow) =>
    String(row.event_time)
      .match(/\.(\d+)/)?.[1]
      .padEnd(9, "0") ?? "000000000";
  return [...rows].sort((a, b) => {
    const seconds =
      Math.floor(Date.parse(String(a.event_time)) / 1000) -
      Math.floor(Date.parse(String(b.event_time)) / 1000);
    const compare =
      seconds ||
      fraction(a).localeCompare(fraction(b)) ||
      a.event_id.localeCompare(b.event_id);
    return direction === "asc" ? compare : -compare;
  });
}

export function boundBuffer(
  rows: LogRow[],
  maxRows = 2000,
  maxBytes = 8 * 1024 * 1024,
): { rows: LogRow[]; truncated: boolean } {
  const encoder = new TextEncoder();
  const kept: LogRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).byteLength;
    if (kept.length === maxRows || bytes + size > maxBytes)
      return { rows: kept, truncated: true };
    kept.push(row);
    bytes += size;
  }
  return { rows: kept, truncated: false };
}

export function attributeType(row: LogRow, key: string): Filter["type"] {
  try {
    return fieldType(JSON.parse(String(row.attributes_json ?? "{}"))[key]);
  } catch {
    return fieldType(attributes(row)[key]);
  }
}

export function normalizeSpec(spec: Partial<Spec>): Spec {
  return {
    ...initialSpec(spec.table_id),
    ...spec,
    services: spec.services ?? [],
    filters: spec.filters ?? [],
    keyword: spec.keyword ?? "",
    sql: spec.sql ?? "",
  };
}
