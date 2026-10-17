import { parse, format } from "@clickhouse/parser";
import { isLosslessNumber } from "lossless-json";
import { Semaphore } from "../shared/serial.js";
import { id } from "../shared/crypto.js";
import { parseNanoTime, formatNanoTime } from "../shared/otlp.js";
import type {
  ClickHouse,
  Catalog,
  QueryRequest,
  QueryResponse,
} from "../shared/types.js";
const identifier = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
export function expand(
  sql: string,
  range: QueryRequest["range"],
  interval: number,
) {
  if (typeof sql !== "string" || Buffer.byteLength(sql) > 2 << 20)
    throw Error("invalid SQL");
  let from: bigint, to: bigint;
  try {
    from = parseNanoTime(range.from);
    to = parseNanoTime(range.to);
  } catch {
    throw Error("invalid time range");
  }
  if (to <= from) throw Error("invalid time range");
  const date = (n: bigint) =>
    formatNanoTime(n).replace("T", " ").replace(/Z$/, "");
  const params: Record<string, string> = {
    __lm_from: date(from),
    __lm_to: date(to),
    __lm_interval: String(
      interval > 0 && Number.isSafeInteger(interval) ? interval : 60000,
    ),
  };
  let result = "";
  for (let i = 0; i < sql.length; ) {
    const start = i;
    if (["'", '"', "`"].includes(sql[i])) {
      const quote = sql[i++];
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i++] === quote) {
          if (sql[i] === quote) {
            i++;
            continue;
          }
          closed = true;
          break;
        }
      }
      if (!closed) throw Error("unterminated SQL string");
      result += sql.slice(start, i);
      continue;
    }
    if (sql.startsWith("--", i) || sql[i] === "#") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
      result += sql.slice(start, i);
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw Error("unterminated SQL comment");
      i = end + 2;
      result += sql.slice(start, i);
      continue;
    }
    let matched = false;
    for (const macro of ["$__timeFilter(", "$__timeInterval("])
      if (sql.startsWith(macro, i)) {
        const begin = i + macro.length,
          end = sql.indexOf(")", begin);
        if (end < 0) throw Error("unterminated time macro");
        const column = sql.slice(begin, end).trim();
        if (!identifier.test(column))
          throw Error("time macro requires a field identifier");
        result +=
          macro === "$__timeFilter("
            ? `(${column}>={__lm_from:DateTime64(9,'UTC')} AND ${column}<{__lm_to:DateTime64(9,'UTC')})`
            : `toStartOfInterval(${column}, toIntervalMillisecond({__lm_interval:Int64}))`;
        i = end + 1;
        matched = true;
        break;
      }
    if (!matched) result += sql[i++];
  }
  return { sql: result, params };
}
function checkedSQL(
  sql: string,
  allowed: Set<string>,
): { tables: string[]; sql: string } {
  if (typeof sql !== "string" || Buffer.byteLength(sql) > 2 << 20)
    throw Error("invalid SQL");
  const statements: any[] = parse(sql, { locations: false });
  if (statements.length !== 1) throw Error("only one SQL statement is allowed");
  if (
    ![
      "SelectQuery",
      "SelectWithUnionQuery",
      "SelectIntersectExceptQuery",
    ].includes(statements[0].type)
  )
    throw Error("only SELECT/WITH queries are allowed");
  const refs = new Set<string>();
  const visit = (node: any, scope: Set<string>) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v, scope);
      return;
    }
    if (node.type === "SelectQuery") {
      scope = new Set(scope);
      // A non-recursive CTE is hidden while its definition is resolved. Otherwise
      // WITH private AS (SELECT * FROM private) could conceal a physical table.
      for (const cte of node.with ?? []) {
        if (cte.type === "WithElement" && cte.subquery) {
          const definition = new Set(scope);
          definition.delete(cte.name);
          if (
            node.recursive_with &&
            cte.subquery.query?.type === "SelectWithUnionQuery" &&
            cte.subquery.query.selects.length > 1
          ) {
            visit(cte.subquery.query.selects[0], definition);
            definition.add(cte.name);
          }
          visit(cte.subquery, definition);
          scope.add(cte.name);
        } else visit(cte, scope);
      }
    }
    if (
      ["settings", "format", "into_outfile", "outfile", "out_file"].some(
        (key) => Object.hasOwn(node, key),
      )
    )
      throw Error("SQL SETTINGS/FORMAT/OUTFILE are controlled by LightMoni");
    if (node.type === "TableExpression" && node.table_function)
      throw Error("table functions are not allowed");
    if (node.type === "TableIdentifier") {
      if (
        typeof node.name !== "string" ||
        (node.database != null && typeof node.database !== "string")
      )
        throw Error("table identifiers must be explicit");
      if (node.database && node.database !== "lightmoni")
        throw Error("only LightMoni tables are allowed");
      if (!node.database && scope.has(node.name)) return;
      if (!allowed.has(node.name))
        throw Error("table " + node.name + " is not in the public catalog");
      refs.add(node.name);
    }
    if (node.type === "Function") {
      const name = String(node.name).toLowerCase();
      if (
        ["in", "notin", "globalin", "globalnotin"].includes(name) &&
        node.arguments?.[1]?.type === "Identifier"
      ) {
        const parts = node.arguments[1].name_parts ?? [node.arguments[1].name];
        if (
          parts.length > 2 ||
          (parts.length === 2 && parts[0] !== "lightmoni")
        )
          throw Error("only LightMoni tables are allowed");
        const table = parts.at(-1);
        if (!scope.has(table) || parts.length === 2) {
          if (!allowed.has(table))
            throw Error("named IN sources must be public catalog tables");
          refs.add(table);
        }
      }
      if (
        name.startsWith("dict") ||
        name.includes("file") ||
        name === "url" ||
        name.startsWith("remote")
      )
        throw Error("external access functions are not allowed");
    }
    for (const [key, v] of Object.entries(node)) {
      if (/comments$/i.test(key)) {
        delete node[key];
        continue;
      }
      if (
        key !== "parent" &&
        key !== "location" &&
        !(node.type === "SelectQuery" && key === "with")
      )
        visit(v, scope);
    }
  };
  visit(statements[0], new Set());
  return {
    tables: [...refs].sort(),
    sql: format(statements).trim().replace(/;$/, ""),
  };
}
export function referencedTables(sql: string, allowed: Set<string>): string[] {
  return checkedSQL(sql, allowed).tables;
}
export function parameter(p: { type: string; value: any }): string {
  const value = p.value,
    s = String(value);
  if (p.type === "String" && typeof value === "string") return value;
  if (["Int64", "UInt64", "UInt8"].includes(p.type) && /^-?[0-9]+$/.test(s)) {
    const n = BigInt(s);
    if (
      (p.type === "Int64" && n >= -(1n << 63n) && n < 1n << 63n) ||
      (p.type === "UInt64" && n >= 0n && n < 1n << 64n) ||
      (p.type === "UInt8" && n >= 0n && n <= 255n)
    )
      return s;
  }
  if (p.type === "Bool" && ["true", "false", "1", "0"].includes(s))
    return s === "true" || s === "1" ? "1" : "0";
  if (
    ["Float32", "Float64"].includes(p.type) &&
    s.trim() !== "" &&
    Number.isFinite(Number(s))
  )
    return s;
  if (p.type === "Decimal(38,9)" && /^-?[0-9]{1,29}(\.[0-9]{1,9})?$/.test(s))
    return s;
  if (
    p.type === "Array(String)" &&
    Array.isArray(value) &&
    value.every((v) => typeof v === "string")
  )
    return (
      "[" +
      value
        .map((v) => "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'")
        .join(",") +
      "]"
    );
  throw Error("unsupported/invalid parameter type " + p.type);
}
export class Executor {
  private slots = new Semaphore(4);
  constructor(
    readonly reader: ClickHouse,
    readonly catalog: Catalog,
  ) {}
  async referencedTables(sql: string, signal?: AbortSignal) {
    const now = new Date(),
      from = new Date(+now - 3600000);
    return referencedTables(
      expand(sql, { from: from.toISOString(), to: now.toISOString() }, 60000)
        .sql,
      new Set((await this.catalog.list(signal)).map((t) => t.name)),
    );
  }
  async execute(
    req: QueryRequest,
    signal?: AbortSignal,
  ): Promise<QueryResponse> {
    if (
      !Array.isArray(req.queries) ||
      req.queries.length < 1 ||
      req.queries.length > 8
    )
      throw Error("one to eight queries are required");
    const response: QueryResponse = {
        request_id: req.request_id || id(),
        results: [],
      },
      allowed = new Set((await this.catalog.list(signal)).map((t) => t.name));
    for (const q of req.queries) {
      const start = Date.now(),
        r: QueryResponse["results"][number] = {
          refId: q.refId,
          status: "error",
          frames: [],
          complete: false,
          truncated: false,
          elapsed_ms: 0,
        };
      try {
        const expanded = expand(q.sql, req.range, req.interval_ms);
        const validated = checkedSQL(expanded.sql, allowed);
        for (const [k, p] of Object.entries(q.params ?? {})) {
          if (k.startsWith("__lm_") || !identifier.test(k))
            throw Error("invalid parameter name");
          expanded.params[k] = parameter(p);
        }
        const data = await this.slots.run(
          () =>
            this.reader.query(
              validated.sql,
              expanded.params,
              signal
                ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
                : AbortSignal.timeout(10000),
            ),
          signal,
        );
        r.truncated = data.data.length > 10000;
        const frame = {
          columns: data.meta.map((c) => ({
            ...c,
            nullable: c.type.startsWith("Nullable("),
          })),
          rows: data.data.slice(0, 10000).map((row) =>
            data.meta.map((c) => {
              const v = row[c.name];
              if (
                c.type.includes("DateTime") &&
                typeof v === "string" &&
                /^\d{4}-\d\d-\d\d /.test(v)
              )
                return v.replace(" ", "T") + "Z";
              return isLosslessNumber(v) ? v.toString() : v;
            }),
          ),
        };
        r.frames = [frame];
        r.complete = !r.truncated;
        r.status = frame.rows.length ? "success" : "empty";
      } catch (e) {
        r.error = e instanceof Error ? e.message : String(e);
        if (signal?.aborted) r.status = "cancelled";
      }
      r.elapsed_ms = Date.now() - start;
      response.results.push(r);
    }
    return response;
  }
}
