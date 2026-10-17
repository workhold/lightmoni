import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { parseJSON, stringifyJSON } from "../src/shared/json.js";

// Opt-in: point only at an isolated QA center. No paid or external providers run.
const base = process.env.LIGHTMONI_DOMAINS_URL;
test(
  "live ClickHouse: OTLP, logs, trace, dashboard and alert response lifecycle",
  { skip: !base, timeout: 45000 },
  async (t) => {
    let cookie = "";
    const request = async (
      path: string,
      method = "GET",
      body?: any,
      extra: Record<string, string> = {},
      expected = 200,
    ) => {
      const response = await fetch(base! + path, {
        method,
        headers: { "Content-Type": "application/json", cookie, ...extra },
        ...(body === undefined ? {} : { body: stringifyJSON(body) }),
      });
      const text = await response.text();
      assert.equal(
        response.status,
        expected,
        method + " " + path + ": " + text,
      );
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return text ? parseJSON<any>(text) : undefined;
    };
    const admin = await request("/api/v1/auth/login", "POST", {
      name: process.env.LIGHTMONI_DOMAINS_USER || "node-qa-admin",
      password:
        process.env.LIGHTMONI_DOMAINS_PASSWORD || "node-qa-password-123",
    });
    const suffix = randomBytes(4).toString("hex"),
      name = "qa_domain_" + suffix,
      service = name,
      table = "log_" + name,
      traceTable = "trace_" + name,
      traceID = "1234567890abcdef1234567890abcdef",
      spanID = "1234567890abcdef";
    const key = await request(
      "/api/v1/keys",
      "POST",
      { name, allowed_tables: [name] },
      {},
      201,
    );
    const now = Date.now(),
      nano = BigInt(now - 1000) * 1000000n,
      range = {
        from: new Date(now - 60000).toISOString(),
        to: new Date(now + 60000).toISOString(),
      },
      resource = {
        attributes: [{ key: "service.name", value: { stringValue: service } }],
      };
    const receipts: any[] = [];
    const hook = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      receipts.push(parseJSON(raw));
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    hook.listen(0, "127.0.0.1");
    await once(hook, "listening");
    let dashboard: any, channel: any, group: any, rule: any, saved: any;
    try {
      await t.test(
        "OTLP stores exact attributes and source sequences",
        async () => {
          await request(
            "/v1/logs",
            "POST",
            {
              resourceLogs: [
                {
                  resource,
                  scopeLogs: [
                    {
                      logRecords: [0, 1, 2].map((n) => ({
                        timeUnixNano: String(nano + BigInt(n)),
                        severityNumber: 17,
                        severityText: "ERROR",
                        body: {
                          stringValue: "qa log " + n + " password=private",
                        },
                        traceId: traceID,
                        spanId: spanID,
                        attributes: [
                          {
                            key: "lightmoni.source_id",
                            value: { stringValue: "qa-file" },
                          },
                          {
                            key: "lightmoni.source_seq",
                            value: {
                              intValue: String(9007199254740993n + BigInt(n)),
                            },
                          },
                          {
                            key: "large",
                            value: { intValue: "9007199254740993" },
                          },
                        ],
                      })),
                    },
                  ],
                },
              ],
            },
            { Authorization: "Bearer " + key.key, "X-Lightmoni-Table": name },
          );
          await request(
            "/v1/traces",
            "POST",
            {
              resourceSpans: [
                {
                  resource,
                  scopeSpans: [
                    {
                      spans: [
                        {
                          traceId: traceID,
                          spanId: spanID,
                          parentSpanId: "aaaaaaaaaaaaaaaa",
                          name: "qa span",
                          startTimeUnixNano: String(nano),
                          endTimeUnixNano: String(nano + 1000000n),
                          kind: 2,
                          status: { code: 2 },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            { Authorization: "Bearer " + key.key, "X-Lightmoni-Table": name },
          );
          assert.ok(
            (await request("/api/v1/catalog/tables")).some(
              (v: any) => v.id === table,
            ),
          );
        },
      );
      await t.test(
        "log session, independent aggregation, context, tail and saved search",
        async () => {
          const spec = { table_id: table, range },
            first = await request("/api/v1/logs/search", "POST", {
              spec,
              limit: 2,
            });
          assert.equal(first.frame.rows.length, 2);
          assert.equal(first.next_cursor, "2");
          const page = await request("/api/v1/logs/search", "POST", {
            session_id: first.session_id,
            cursor: first.next_cursor,
            limit: 2,
          });
          assert.equal(page.frame.rows.length, 1);
          const agg = await request("/api/v1/logs/aggregate", "POST", {
            spec,
            field: "attr:large",
          });
          assert.equal(String(agg.total), "3");
          assert.equal(String(agg.frame.rows[0][0]), "9007199254740993");
          const exact = await request("/api/v1/logs/search", "POST", {
            spec: {
              ...spec,
              filters: [
                {
                  scope: "attribute",
                  field: "large",
                  type: "number",
                  op: "eq",
                  value: "9007199254740993",
                },
              ],
            },
          });
          assert.equal(exact.frame.rows.length, 3);
          const eventIndex = first.frame.columns.findIndex(
              (v: any) => v.name === "event_id",
            ),
            event = first.frame.rows[0][eventIndex],
            context = await request("/api/v1/logs/context", "POST", {
              spec,
              event_id: event,
            });
          assert.equal(context.order, "source_seq");
          assert.equal(context.frame.rows.length, 3);
          const detail = await request(
            "/api/v1/logs/" +
              table +
              "/events/" +
              event +
              "?from=" +
              encodeURIComponent(range.from) +
              "&to=" +
              encodeURIComponent(range.to),
          );
          assert.ok(detail);
          const tail = await request("/api/v1/logs/tail", "POST", {
            spec,
            since: new Date(now - 5000).toISOString(),
          });
          assert.equal(tail.frame.rows.length, 3);
          saved = await request("/api/v1/logs/saved-searches", "POST", {
            title: name,
            spec,
            view: { columns: ["body"] },
          });
          assert.equal(saved.revision, 1);
        },
      );
      await t.test(
        "trace reconstruction identifies a missing parent",
        async () => {
          const trace = await request(
            "/api/v1/traces/" +
              traceID +
              "?tables=" +
              traceTable +
              "&from=" +
              encodeURIComponent(range.from) +
              "&to=" +
              encodeURIComponent(range.to),
          );
          assert.equal(trace.spans.length, 1);
          assert.equal(trace.missing_parents, 1);
          assert.equal(trace.incomplete, true);
        },
      );
      await t.test(
        "dashboard versions and real query execute against the ingested view",
        async () => {
          const sql =
            "SELECT count() AS value FROM " +
            table +
            " WHERE $__timeFilter(event_time)";
          dashboard = await request(
            "/api/v1/dashboards",
            "POST",
            {
              title: name,
              range: { from: "now-1h", to: "now" },
              panels: [
                {
                  id: "p",
                  title: "Count",
                  type: "stat",
                  queries: [{ refId: "A", sql }],
                  options: { y: "value" },
                  grid: { x: 0, y: 0, w: 6, h: 6 },
                },
              ],
            },
            {},
            201,
          );
          dashboard = await request(
            "/api/v1/dashboards/" + dashboard.id,
            "PUT",
            { ...dashboard, title: name + " edited" },
          );
          assert.equal(dashboard.revision, 2);
          assert.equal(
            (await request("/api/v1/dashboards/" + dashboard.id + "/versions"))
              .length,
            2,
          );
          const query = await request("/api/v1/query", "POST", {
            range,
            interval_ms: 1000,
            queries: [{ refId: "A", sql }],
          });
          assert.equal(query.results[0].status, "success");
          assert.equal(String(query.results[0].frames[0].rows[0][0]), "3");
        },
      );
      await t.test(
        "real SQL alert fires, posts locally, is claimed and recovers",
        async () => {
          channel = await request("/api/v1/notify/channels", "POST", {
            name,
            type: "webhook",
            enabled: true,
            config: {
              url: "http://127.0.0.1:" + (hook.address() as any).port + "/hook",
            },
          });
          group = await request("/api/v1/alerts/groups", "POST", {
            name,
            enabled: true,
            members: [admin.id],
            primary: [admin.id],
            channel_ids: [channel.id],
            policies: {
              P2: {
                methods: ["webhook"],
                repeat_seconds: 60,
                max_rounds: 1,
                handling_seconds: 60,
              },
            },
          });
          const gate = Math.floor(Date.now() / 1000) + 5;
          const input = {
            name,
            kind: "sql",
            enabled: true,
            sql:
              "SELECT count()*if(now()<toDateTime({gate:UInt64}),1,0) AS value FROM " +
              table +
              " WHERE $__timeFilter(event_time)",
            params: { gate: { type: "UInt64", value: gate } },
            value_field: "value",
            source_table_ids: [table],
            threshold: "0",
            operator: "gt",
            interval_seconds: 1,
            window_seconds: 120,
            for_count: 1,
            recovery_seconds: 0,
            severity: "P2",
            group_ids: [group.id],
            services: [service],
            evidence_profile: {
              log_table_id: table,
              trace_table_ids: [traceTable],
              lookback_seconds: 10,
            },
          };
          const preview = await request(
            "/api/v1/alerts/preview",
            "POST",
            input,
          );
          assert.equal(
            preview.states[0].status,
            "firing",
            stringifyJSON(preview),
          );
          rule = await request("/api/v1/alerts/rules", "POST", input);
          const waitFor = async (fn: () => Promise<any>, message: string) => {
            const until = Date.now() + 12000;
            while (Date.now() < until) {
              const value = await fn();
              if (value) return value;
              await new Promise((resolve) => setTimeout(resolve, 150));
            }
            assert.fail(message);
          };
          const incident = await waitFor(async () => {
            const rows = await request("/api/v1/alerts/incidents");
            return rows.find((v: any) => v.rule_id === rule.id);
          }, "alert did not fire");
          await waitFor(
            async () => receipts.length > 0,
            "local webhook was not delivered",
          );
          const ack = await request(
            "/api/v1/alerts/incidents/" + incident.id + "/ack",
            "POST",
            {},
          );
          assert.equal(ack.state, "acknowledged");
          await waitFor(async () => {
            const rows = await request("/api/v1/alerts/incidents");
            return rows.find(
              (v: any) => v.id === incident.id && v.state === "resolved",
            );
          }, "alert did not recover");
          assert.ok(
            (await request("/api/v1/alerts/events?rule_id=" + rule.id)).some(
              (v: any) => v.kind === "resolved",
            ),
          );
        },
      );
    } finally {
      try {
        if (rule) await request("/api/v1/alerts/rules/" + rule.id, "DELETE");
        if (group) await request("/api/v1/alerts/groups/" + group.id, "DELETE");
        if (channel)
          await request("/api/v1/notify/channels/" + channel.id, "DELETE");
        if (saved)
          await request("/api/v1/logs/saved-searches/" + saved.id, "DELETE");
        if (dashboard)
          await request(
            "/api/v1/dashboards/" +
              dashboard.id +
              "?revision=" +
              dashboard.revision,
            "DELETE",
          );
        await request("/api/v1/keys/" + key.id, "PUT", { active: false });
      } finally {
        hook.closeAllConnections();
        await new Promise<void>((resolve) => hook.close(() => resolve()));
      }
    }
  },
);
