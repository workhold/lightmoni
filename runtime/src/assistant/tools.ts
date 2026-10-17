import { randomBytes } from "node:crypto";
import type { Dependencies } from "../shared/types.js";
import { bytes, object, text, type Tool } from "./types.js";
const string = { type: "string" },
  obj = (properties: Record<string, any>, required: string[] = []) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
const rangeSchema = obj({ from: string, to: string }, ["from", "to"]);
const querySchema = obj(
  { refId: string, sql: string, params: { type: "object" } },
  ["refId", "sql"],
);
export function monitoringTools(deps: Dependencies): Tool[] {
  return [
    {
      name: "list_tables",
      description:
        "List available LightMoni telemetry tables, their kinds and services. Use this before constructing SQL.",
      effect: "read",
      schema: obj({}),
      execute: async (input, signal) => {
        object(input, []);
        try {
          return {
            tables: (await deps.cat.list(signal)).slice(0, 200),
            limit: 200,
          };
        } catch {
          throw Error("cannot read table catalog");
        }
      },
    },
    {
      name: "describe_table",
      description:
        "Read the columns and services of one known telemetry table. Accepts the table name or stable id.",
      effect: "read",
      schema: obj({ table: string }, ["table"]),
      execute: async (input, signal) => {
        object(input, ["table"]);
        const target = text(input.table);
        let tables;
        try {
          tables = await deps.cat.list(signal);
        } catch {
          throw Error("cannot read table catalog");
        }
        const table = tables.find(
          (item) => item.id === target || item.name === target,
        );
        if (!table) throw Error("table does not exist in the catalog");
        return table;
      },
    },
    {
      name: "run_query",
      description:
        "Execute one bounded read-only ClickHouse query. Include $__timeFilter(event_time) and supply an explicit UTC half-open time range. Up to 1000 result rows are shown to the assistant; truncation is explicit.",
      effect: "read",
      schema: obj(
        {
          sql: string,
          range: rangeSchema,
          interval_ms: { type: "integer", minimum: 1 },
          params: { type: "object" },
        },
        ["sql", "range", "interval_ms"],
      ),
      execute: async (input, signal) => {
        object(input, ["sql", "range", "interval_ms", "params"]);
        const sql = text(input.sql);
        if (
          !sql.trim() ||
          bytes(sql) > 16000 ||
          !Number.isInteger(input.interval_ms) ||
          input.interval_ms <= 0
        )
          throw Error("SQL and a positive interval_ms are required");
        object(input.range, ["from", "to"]);
        const { from, to } = input.range,
          a = Date.parse(from),
          b = Date.parse(to),
          rfc =
            /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
        if (
          !rfc.test(from) ||
          !rfc.test(to) ||
          !Number.isFinite(a) ||
          !Number.isFinite(b) ||
          a >= b ||
          b - a > 90 * 864e5
        )
          throw Error(
            "query range must be a valid increasing UTC range within 90 days",
          );
        if (input.params != null) {
          if (typeof input.params !== "object" || Array.isArray(input.params))
            throw Error("invalid tool input");
          for (const p of Object.values(input.params))
            object(p, ["type", "value"]);
        }
        const response = await deps.query(
          {
            request_id: randomBytes(16).toString("hex"),
            range: { from, to },
            interval_ms: input.interval_ms,
            source: "assistant",
            queries: [{ refId: "A", sql, params: input.params }],
          } as any,
          AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        );
        if (response.results.length !== 1)
          throw Error("query executor returned an unexpected result count");
        let remaining = 1000,
          sampled = false;
        for (const result of response.results) {
          if (["error", "cancelled"].includes(result.status))
            throw Error(result.error || "query did not complete successfully");
          for (const frame of result.frames) {
            if (frame.rows.length > remaining) {
              frame.rows = frame.rows.slice(0, remaining);
              sampled = true;
            }
            remaining -= frame.rows.length;
          }
        }
        return {
          query: response,
          range: input.range,
          sample_limit: 1000,
          sample_truncated: sampled,
        };
      },
    },
    {
      name: "draft_dashboard",
      description:
        "Propose a reviewable dashboard draft. This tool does NOT save it. Include concrete queries over verified tables; users will preview and explicitly save through the dashboard editor.",
      effect: "draft",
      schema: obj(
        {
          title: string,
          description: string,
          panels: {
            type: "array",
            maxItems: 12,
            items: obj(
              {
                id: string,
                title: string,
                type: {
                  type: "string",
                  enum: [
                    "timeseries",
                    "bar",
                    "pie",
                    "stat",
                    "table",
                    "heatmap",
                    "gauge",
                  ],
                },
                queries: { type: "array", items: querySchema },
                options: { type: "object" },
                grid: { type: "object" },
              },
              ["title", "type", "queries"],
            ),
          },
        },
        ["title", "panels"],
      ),
      execute: async (input) => {
        object(input, ["title", "description", "panels"]);
        const title = text(input.title),
          description = text(input.description);
        if (
          !title.trim() ||
          bytes(title) > 200 ||
          bytes(description) > 2000 ||
          !Array.isArray(input.panels) ||
          input.panels.length < 1 ||
          input.panels.length > 12
        )
          throw Error("draft requires a title and 1 to 12 panels");
        for (const panel of input.panels) {
          object(panel, ["id", "title", "type", "queries", "options", "grid"]);
          if (
            ![
              "timeseries",
              "bar",
              "pie",
              "stat",
              "table",
              "heatmap",
              "gauge",
            ].includes(panel.type) ||
            !text(panel.title).trim() ||
            !Array.isArray(panel.queries) ||
            !panel.queries.length ||
            panel.queries.length > 8
          )
            throw Error(
              "every panel needs a supported visualization, title and queries",
            );
          for (const query of panel.queries) {
            object(query, ["refId", "sql", "params"]);
            if (
              !text(query.refId) ||
              !text(query.sql).trim() ||
              bytes(query.sql) > 16000
            )
              throw Error("every draft query requires refId and SQL");
          }
          if (
            panel.options != null &&
            (typeof panel.options !== "object" || Array.isArray(panel.options))
          )
            throw Error("invalid tool input");
          if (
            panel.grid != null &&
            (typeof panel.grid !== "object" ||
              Array.isArray(panel.grid) ||
              Object.values(panel.grid).some(
                (value) => !Number.isInteger(value),
              ))
          )
            throw Error("invalid tool input");
          if (!panel.id) panel.id = randomBytes(16).toString("hex");
        }
        return { draft: input, saved: false, requires_review: true };
      },
    },
  ];
}
