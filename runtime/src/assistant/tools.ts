import { randomBytes } from "node:crypto";
import type { Dependencies } from "../shared/types.js";
import { bytes, object, text, type Tool } from "./types.js";
import type { CodeTaskInput, CodeTaskResult } from "./code.js";
import type { User } from "../shared/types.js";
import type { ManagedMachineStore } from "../server/managed-machines.js";
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
export interface MonitoringToolOptions {
  codeTask?: {
    run(
      input: CodeTaskInput,
      owner: User,
      signal: AbortSignal,
    ): Promise<CodeTaskResult>;
  };
  machines?: ManagedMachineStore;
}
export function codeTaskReceipt(
  result: CodeTaskResult,
): CodeTaskResult & { diff_available: boolean; changed_file_count: number } {
  return {
    ...result,
    diff: "",
    diff_available: !!result.diff,
    changed_files: result.changed_files
      .slice(0, 20)
      .map((path) => path.slice(0, 512)),
    changed_file_count: result.changed_files.length,
    steps: result.steps.slice(-64),
    checks: result.checks
      .slice(-16)
      .map((check) => ({ ...check, output: check.output.slice(0, 512) })),
  };
}
export function monitoringTools(
  deps: Dependencies,
  options: MonitoringToolOptions = {},
): Tool[] {
  const tools: Tool[] = [
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
  if (options.machines) {
    const machines = options.machines;
    tools.push(
      {
        name: "list_managed_machines",
        description:
          "List administrator-managed host metadata and LightMoni Agent status. This never returns SSH usernames' secrets, private keys, passwords, host keys, or command output.",
        effect: "read",
        schema: obj({}),
        execute: async (_input, _signal, user) => {
          if (!user || user.role !== "admin") throw Error("administrator required");
          object(_input, []);
          return { machines: machines.assistantList() };
        },
      },
      {
        name: "get_managed_machine",
        description:
          "Read one managed host's metadata and Agent status by platform machine ID. Secrets are never returned.",
        effect: "read",
        schema: obj({ machine_id: string }, ["machine_id"]),
        execute: async (input, _signal, user) => {
          if (!user || user.role !== "admin") throw Error("administrator required");
          object(input, ["machine_id"]);
          return machines.assistantGet(text(input.machine_id));
        },
      },
      {
        name: "check_managed_machine_ssh",
        description:
          "Log in to a registered host through pinned SSH and run a fixed read-only Agent installation preflight. Returns only connection status, Linux/architecture, dependency, systemd, root/sudo and platform HTTPS checks. Use before proposing installation. No arbitrary commands or secrets. One valid private key is selected automatically; with multiple keys use an ID from get_managed_machine.",
        effect: "read",
        schema: obj({ machine_id: string, credential_id: string }, ["machine_id"]),
        execute: async (input, signal, user) => {
          if (!user || user.role !== "admin") throw Error("administrator required");
          object(input, ["machine_id", "credential_id"]);
          return machines.checkSSH(text(input.machine_id), {
            ...(input.credential_id == null ? {} : { credential_id: text(input.credential_id) }),
          }, user.id, signal);
        },
      },
      {
        name: "propose_agent_install",
        description:
          "Persist a reviewable LightMoni Agent installation plan using a successful fresh check_id from check_managed_machine_ssh and its observed architecture. Return the review_url to the administrator. This only drafts a fixed plan; it does not connect by SSH, execute commands, reveal credentials, or install anything. The administrator must confirm in the host management page.",
        effect: "draft",
        schema: obj(
          {
            machine_id: string,
            check_id: string,
            version: string,
            arch: { type: "string", enum: ["amd64", "arm64"] },
            initial_label_id: string,
          },
          ["machine_id", "check_id", "version", "arch"],
        ),
        execute: async (input, _signal, user) => {
          if (!user || user.role !== "admin") throw Error("administrator required");
          object(input, ["machine_id", "check_id", "version", "arch", "initial_label_id"]);
          return machines.assistantPlan(text(input.machine_id), {
            check_id: text(input.check_id),
            version: text(input.version),
            arch: text(input.arch),
            initial_label_id: input.initial_label_id == null ? "" : text(input.initial_label_id),
          }, user.id);
        },
      },
      {
        name: "get_agent_installation",
        description:
          "Read a sanitized Agent installation plan or receipt by deployment ID. Never claim installation succeeded unless the receipt status is succeeded.",
        effect: "read",
        schema: obj({ deployment_id: string }, ["deployment_id"]),
        execute: async (input, _signal, user) => {
          if (!user || user.role !== "admin") throw Error("administrator required");
          object(input, ["deployment_id"]);
          return machines.assistantDeployment(text(input.deployment_id));
        },
      },
    );
  }
  if (options.codeTask) {
    tools.push({
      name: "code_task",
      description:
        "Prepare a lightweight script or code change in an isolated workspace. The result is a reviewable diff and test receipt; it never applies changes automatically.",
      effect: "code",
      schema: obj(
        {
          task: { type: "string", minLength: 2, maxLength: 12000 },
          workspace: { type: "string", minLength: 1, maxLength: 512 },
          allowed_paths: { type: "array", items: string, maxItems: 128 },
          allowed_commands: { type: "array", items: string, maxItems: 16 },
          max_steps: { type: "integer", minimum: 1, maximum: 12 },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
        },
        ["task", "workspace"],
      ),
      execute: async (input, signal, user) => {
        if (!user || user.role !== "admin")
          throw Error("code task requires an administrator");
        object(
          input,
          [
            "task",
            "workspace",
            "allowed_paths",
            "allowed_commands",
            "max_steps",
            "timeout_ms",
          ],
          ["task", "workspace"],
        );
        const result = await options.codeTask!.run(
          input as CodeTaskInput,
          user as User,
          signal,
        );
        // Keep the private Mastra tool channel below 128 KiB. The authenticated
        // UI fetches the full preview by ID; source diffs need not return to the model.
        return codeTaskReceipt(result);
      },
    });
  }
  return tools;
}
