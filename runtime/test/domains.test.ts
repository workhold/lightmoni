import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTCPServer } from "node:net";
import { createHash, createCipheriv } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { parseJSON, stringifyJSON } from "../src/shared/json.js";
import type {
  Dependencies,
  QueryRequest,
  QueryResponse,
  Table,
} from "../src/shared/types.js";
import {
  Dashboards,
  normalizeDashboard,
  validateQueryOptions,
} from "../src/domains/dashboards.js";
import { Logs } from "../src/domains/logs.js";
import {
  Alerts,
  applyNoData,
  breached,
  fingerprint,
  transition,
} from "../src/domains/alerts.js";
import {
  allowedResponse,
  defaultPolicies,
  onCall,
  policy,
  responseActiveSeconds,
  windowAllowed,
} from "../src/domains/alert-policy.js";
import {
  internationalPhone,
  smsSignature,
  tencentAuthorization,
} from "../src/domains/alert-notify.js";
import {
  collectEvidence,
  syncDirectory,
} from "../src/domains/alert-evidence.js";
import {
  encode,
  id,
  stamp,
  timeNanos,
  parseTime,
} from "../src/domains/common.js";
const fields = [
  "event_id",
  "event_time",
  "service",
  "body",
  "severity",
  "source_id",
  "source_seq",
  "attributes_json",
  "trace_id",
  "span_id",
  "severity_number",
];
const logTable: Table = {
  id: "log_app",
  name: "log_app",
  logical_name: "app",
  kind: "log",
  columns: fields.map((name) => ({
    name,
    type:
      name === "source_seq"
        ? "Nullable(UInt64)"
        : name === "severity_number"
          ? "UInt8"
          : "String",
  })),
  services: ["api"],
  system: false,
  retention_days: null,
  effective_retention_days: 7,
};
function result(
  queries: QueryRequest["queries"],
  frames: any[],
): QueryResponse {
  return {
    request_id: "x",
    results: queries.map((q, i) => ({
      refId: q.refId,
      status: "success",
      complete: true,
      truncated: false,
      elapsed_ms: 0,
      frames: [
        frames[i] ?? {
          columns: [{ name: "value", type: "Int64" }],
          rows: [["2"]],
        },
      ],
    })),
  };
}
async function fixture(
  options: {
    path?: string;
    fetcher?: typeof fetch;
  } = {},
) {
  const db = new DB(options.path ?? ":memory:");
  db.exec(
    "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT,active INTEGER,role TEXT);INSERT OR IGNORE INTO users VALUES('u','User',1,'admin'),('v','Peer',1,'member');CREATE TABLE IF NOT EXISTS external_identities(provider_id TEXT,subject TEXT,user_id TEXT);",
  );
  let now = new Date("2026-10-17T04:00:00Z");
  const calls: QueryRequest[] = [],
    network: any[] = [],
    errors: any[] = [],
    router = new Router((e) => errors.push(e)),
    master = Buffer.alloc(32, 7),
    crypt = cipher(master),
    tables: Table[] = [structuredClone(logTable)];
  let query = (q: QueryRequest) => Promise.resolve(result(q.queries, []));
  const auth: any = {
    master,
    user: (req: any) => ({
      id: req.headers["x-user"] || "u",
      name: "User",
      role: req.headers["x-user"] === "v" ? "member" : "admin",
    }),
    requireAdmin: (ctx: any) => {
      if (ctx.user.role !== "admin") ctx.error(403, "administrator required");
    },
  };
  router.auth = auth;
  const deps: Dependencies = {
    db,
    router,
    query: async (q) => {
      calls.push(q);
      return query(q);
    },
    referencedTables: async (sql) =>
      tables.filter((t) => sql.includes(t.name)).map((t) => t.name),
    cat: { list: async () => tables },
    ch: {} as any,
    reader: {} as any,
    auth,
    externalURL: "http://localhost:8080",
    ...crypt,
    now: () => now,
    logger: {
      info() {},
      warn() {},
      error(...e) {
        errors.push(e);
      },
    },
  };
  const dashboards = new Dashboards(deps),
    logs = new Logs(deps),
    alerts = new Alerts(
      deps,
      options.fetcher ??
        ((async (url, init) => {
          network.push({ url, init });
          return new Response("{}", { status: 200 });
        }) as typeof fetch),
    );
  const server = createServer((req, res) => {
    void router.handle(req, res).then((found) => {
      if (!found) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  const request = async (
    path: string,
    method = "GET",
    body?: any,
    user = "u",
    extraHeaders: Record<string, string> = {},
  ) => {
    const response = await fetch(url + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-user": user,
        ...extraHeaders,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : stringifyJSON(body) }),
    });
    return {
      status: response.status,
      body: parseJSON<any>(await response.text()),
    };
  };
  return {
    db,
    deps,
    router,
    dashboards,
    logs,
    alerts,
    tables,
    calls,
    network,
    errors,
    request,
    setQuery: (f: typeof query) => (query = f),
    setNow: (d: Date) => (now = d),
    async close() {
      await alerts.close();
      logs.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
const spec = {
  table_id: "log_app",
  range: { from: "2026-10-17T03:00:00Z", to: "2026-10-17T04:00:00Z" },
};
const dashboard = (title = "Board") => ({
  title,
  panels: [
    {
      id: "p",
      title: "Count",
      type: "stat",
      queries: [{ refId: "A", sql: "SELECT count() FROM log_app" }],
      options: {},
      grid: { x: 0, y: 0, w: 6, h: 6 },
    },
  ],
  variables: [],
  range: { from: "now-1h", to: "now" },
  refresh: 10,
});
const rule = () => ({
  name: "Errors",
  kind: "sql",
  enabled: true,
  sql: "SELECT count() AS value FROM log_app WHERE $__timeFilter(event_time)",
  value_field: "value",
  source_table_ids: ["log_app"],
  threshold: "1",
  operator: "gt",
  interval_seconds: 10,
  window_seconds: 60,
  for_count: 1,
  for_seconds: 0,
  recovery_seconds: 0,
  repeat_seconds: 0,
  group_ids: [],
  label_fields: [],
  services: ["api"],
  severity: "P2",
});
async function makeLegacyGroup(f: Awaited<ReturnType<typeof fixture>>) {
  const channel = await f.request("/api/v1/notify/channels", "POST", {
    name: "Hook",
    type: "webhook",
    enabled: true,
    config: { url: "http://controlled.invalid/hook", secret: "private" },
  });
  assert.equal(channel.status, 200);
  const group = await f.request("/api/v1/alerts/groups", "POST", {
    name: "Group",
    enabled: true,
    targets: [
      {
        channel_id: channel.body.id,
        recipient: { kind: "channel", value: "bound" },
      },
    ],
  });
  assert.equal(group.status, 200);
  return { channel: channel.body, group: group.body };
}
test("dashboard revisions, durable versions, copies and seed deletion survive reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-domains-")),
    path = join(dir, "db.sqlite");
  let f = await fixture({ path });
  try {
    assert.equal((await f.request("/api/v1/dashboards")).body.length, 3);
    const created = await f.request("/api/v1/dashboards", "POST", dashboard());
    assert.equal(created.status, 201);
    const d = created.body;
    const changed = await f.request("/api/v1/dashboards/" + d.id, "PUT", {
      ...d,
      title: "Changed",
    });
    assert.equal(changed.body.revision, 2);
    const conflict = await f.request("/api/v1/dashboards/" + d.id, "PUT", d);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.current.title, "Changed");
    const overwritten = await f.request("/api/v1/dashboards/" + d.id, "PUT", {
      ...d,
      title: "Resolved",
      overwrite_revision: 2,
    });
    assert.equal(overwritten.body.revision, 3);
    const versions = await f.request(
      "/api/v1/dashboards/" + d.id + "/versions",
    );
    assert.deepEqual(
      versions.body.map((v: any) => [v.revision, v.overwritten]),
      [
        [3, true],
        [2, false],
        [1, false],
      ],
    );
    const copy = await f.request(
      "/api/v1/dashboards/" + d.id + "/copy",
      "POST",
      {},
    );
    assert.equal(copy.status, 201);
    assert.notEqual(copy.body.panels[0].id, d.panels[0].id);
    assert.equal(
      (await f.request("/api/v1/dashboards/" + d.id + "?revision=1", "DELETE"))
        .status,
      409,
    );
    assert.equal(
      (await f.request("/api/v1/dashboards/system-center?revision=1", "DELETE"))
        .status,
      200,
    );
    await f.close();
    f = await fixture({ path });
    assert.equal(
      (await f.request("/api/v1/dashboards/system-center")).status,
      404,
    );
    assert.equal(
      (await f.request("/api/v1/dashboards/" + d.id)).body.title,
      "Resolved",
    );
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("dashboard validates query options, real variable cycles and ignores references inside comments", () => {
  assert.throws(() => validateQueryOptions({ query_interval: "0s" }));
  assert.throws(() => validateQueryOptions({ query_min_interval: "366d" }));
  assert.throws(() => validateQueryOptions({ query_max_points: 1.5 }));
  const d = dashboard();
  (d.variables as any) = [
    { name: "a", type: "query", sql: "SELECT {b:String}" },
    { name: "b", type: "query", sql: "SELECT {a:String}" },
  ];
  assert.throws(() => normalizeDashboard(d), /循环/);
  d.variables[1].sql = "SELECT 'literal {a:String}' -- {a:String}";
  assert.doesNotThrow(() => normalizeDashboard(d));
  assert.throws(() =>
    normalizeDashboard({
      ...d,
      links: [{ title: "Bad", url: "javascript:alert(1)" }],
    }),
  );
});
test("dashboard retains exact large numeric parameter literals and nanosecond ranges", async () => {
  const f = await fixture();
  try {
    const source = stringifyJSON(dashboard()).replace(
      '"sql":"SELECT count() FROM log_app"',
      '"sql":"SELECT count() FROM log_app","params":{"n":{"type":"UInt64","value":18446744073709551615}}',
    );
    const saved = await f.request("/api/v1/dashboards", "POST", source);
    assert.equal(saved.status, 201);
    assert.equal(
      String(saved.body.panels[0].queries[0].params.n.value),
      "18446744073709551615",
    );
    assert.equal(
      timeNanos("2026-10-17T00:00:00.000000001Z") -
        timeNanos("2026-10-17T00:00:00Z"),
      1n,
    );
  } finally {
    await f.close();
  }
});
test("log sessions freeze pages, isolate owners, expire, and aggregate over the whole range", async () => {
  const f = await fixture();
  try {
    const rows = Array.from({ length: 5 }, (_, i) => [
      "e" + i,
      "2026-10-17 03:30:00.000000001",
      "api",
      "body" + i,
    ]);
    f.setQuery(async (q) =>
      result(
        q.queries,
        q.queries[0].refId === "rows"
          ? [
              {
                columns: ["event_id", "event_time", "service", "body"].map(
                  (name) => ({ name, type: "String" }),
                ),
                rows,
              },
              {
                columns: [
                  { name: "time", type: "String" },
                  { name: "severity", type: "String" },
                  { name: "count", type: "UInt64" },
                ],
                rows: [["time", "ERROR", "99999"]],
              },
            ]
          : q.queries[0].refId === "groups"
            ? [
                {
                  columns: [
                    { name: "value", type: "String" },
                    { name: "value_type", type: "String" },
                    { name: "count", type: "UInt64" },
                  ],
                  rows: [["9007199254740993", "UInt64", "9999"]],
                },
                {
                  columns: [
                    { name: "total", type: "UInt64" },
                    { name: "present", type: "UInt64" },
                  ],
                  rows: [["99999", "99999"]],
                },
              ]
            : [],
      ),
    );
    const first = await f.request("/api/v1/logs/search", "POST", {
      spec,
      limit: 2,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.next_cursor, "2");
    const count = f.calls.length;
    const second = await f.request("/api/v1/logs/search", "POST", {
      session_id: first.body.session_id,
      cursor: "2",
      limit: 2,
    });
    assert.equal(second.body.frame.rows[0][0], "e2");
    assert.equal(f.calls.length, count);
    assert.equal(
      (
        await f.request(
          "/api/v1/logs/search",
          "POST",
          { session_id: first.body.session_id, cursor: "0" },
          "v",
        )
      ).status,
      410,
    );
    const aggregate = await f.request("/api/v1/logs/aggregate", "POST", {
      spec,
      field: "attr:integer",
      limit: 10,
    });
    assert.equal(aggregate.body.total, "99999");
    assert.equal(aggregate.body.frame.rows[0][0], "9007199254740993");
    assert.match(f.calls.at(-1)!.queries[0].sql, /JSONExtractRaw/);
    f.setNow(new Date("2026-10-17T04:02:01Z"));
    assert.equal(
      (
        await f.request("/api/v1/logs/search", "POST", {
          session_id: first.body.session_id,
          cursor: "0",
        })
      ).status,
      410,
    );
  } finally {
    await f.close();
  }
});
test("log SQL filters bind exact integers, reject wrong tables and preserve attribute type checks", async () => {
  const f = await fixture();
  try {
    const b = await f.logs.compile({
      ...spec,
      filters: [
        {
          scope: "attribute",
          field: "n",
          type: "number",
          op: "eq",
          value: "9007199254740993",
        },
        {
          scope: "column",
          field: "source_seq",
          type: "number",
          op: "gt",
          value: "18446744073709551614",
        },
        {
          scope: "attribute",
          field: "ok",
          type: "boolean",
          op: "eq",
          value: true,
        },
      ],
    });
    assert.match(b.sql, /toDecimal128OrNull/);
    assert.equal(b.params.lm_log_0_value.value, "9007199254740993");
    assert.equal(b.params.lm_log_1_value.type, "UInt64");
    assert.match(b.sql, /JSONType.*Bool/);
    await assert.rejects(() =>
      f.logs.compile({
        ...spec,
        mode: "sql",
        sql: "SELECT * FROM another_table",
      }),
    );
    await assert.rejects(() =>
      f.logs.compile({
        ...spec,
        filters: [
          {
            scope: "column",
            field: "source_seq",
            type: "number",
            op: "eq",
            value: "18446744073709551616",
          },
        ],
      }),
    );
    assert.equal(
      (
        await f.request("/api/v1/logs/search", "POST", {
          spec: { ...spec, interval_ms: 1000 },
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test("saved log searches enforce revisions and tail validates bounded time cursor", async () => {
  const f = await fixture();
  try {
    const saved = await f.request("/api/v1/logs/saved-searches", "POST", {
      title: "Recent",
      spec,
      view: { columns: ["body"] },
    });
    assert.equal(saved.status, 200);
    const v = saved.body;
    assert.equal(
      (
        await f.request("/api/v1/logs/saved-searches/" + v.id, "PUT", {
          ...v,
          title: "Changed",
        })
      ).body.revision,
      2,
    );
    assert.equal(
      (await f.request("/api/v1/logs/saved-searches/" + v.id, "PUT", v)).status,
      409,
    );
    assert.equal(
      (
        await f.request("/api/v1/logs/tail", "POST", {
          spec,
          since: "2026-10-17T03:57:59Z",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request("/api/v1/logs/tail", "POST", {
          spec: { ...spec, mode: "sql" },
          since: "2026-10-17T04:00:00Z",
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test("exact rational thresholds, missing-data policy and consecutive count state transitions", () => {
  assert.equal(breached("9007199254740993", "9007199254740992", "gt"), true);
  assert.equal(
    breached("1/3", "0.33333333333333333333333333333333333333333333333", "gt"),
    true,
  );
  const r = { ...rule(), id: "r", for_count: 3, for_seconds: 0 },
    input = {
      fingerprint: "f",
      labels: { host: "a" },
      health: "ok",
      status: "firing",
      value: "2",
    };
  let s: any = {};
  for (let n = 0; n < 3; n++) {
    const out = transition(s, input, r, new Date(100000 + n * 10000));
    assert.equal(out.kinds.includes("firing"), n === 2);
    s = out.state;
  }
  const recover = transition(
    s,
    { ...input, status: "normal", value: "0" },
    r,
    new Date(140000),
  );
  assert.deepEqual(recover.kinds, ["resolved"]);
  const no = applyNoData(
    { health: "no_data" },
    { ...r, no_data_policy: "value", no_data_value: "2" },
  );
  assert.equal(no.status, "firing");
  const failure = applyNoData(
    { health: "error" },
    { ...r, no_data_policy: "zero" },
  );
  assert.equal(failure.health, "error");
});
test("alert CRUD keeps provider credentials encrypted and cancels changed measurements", async () => {
  const f = await fixture();
  try {
    const { channel, group } = await makeLegacyGroup(f);
    assert.equal(channel.config.url, undefined);
    assert.equal(channel.config.secret, undefined);
    const raw = f.db.get<any>(
      "SELECT secret FROM alert_channels WHERE id=?",
      channel.id,
    )!.secret;
    assert.ok(!raw.includes("controlled.invalid"));
    assert.equal(f.alerts.channel(channel.id, true).config.secret, "private");
    const saved = await f.request("/api/v1/alerts/rules", "POST", {
      ...rule(),
      group_ids: [group.id],
    });
    assert.equal(saved.status, 200);
    await f.alerts.evaluate(saved.body);
    assert.equal((await f.request("/api/v1/alerts/events")).body.length, 1);
    assert.equal((await f.request("/api/v1/notify/deliveries")).body.length, 1);
    assert.equal(
      (
        await f.request("/api/v1/alerts/rules/" + saved.body.id, "PUT", {
          ...saved.body,
          threshold: "3",
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request("/api/v1/notify/deliveries")).body[0].status,
      "cancelled",
    );
    assert.equal(
      (
        await f.request(
          "/api/v1/alerts/rules/" + saved.body.id,
          "PUT",
          saved.body,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(
          "/api/v1/notify/channels/" + channel.id,
          "DELETE",
          undefined,
          "v",
        )
      ).status,
      403,
    );
    assert.equal(f.network.length, 0);
  } finally {
    await f.close();
  }
});
test("legacy deliveries preserve unknown submission semantics, require explicit retry confirmation, and rate-limit one account per tick", async () => {
  const f = await fixture();
  try {
    const { channel } = await makeLegacyGroup(f);
    for (let i = 0; i < 2; i++)
      await f.request(
        "/api/v1/notify/channels/" + channel.id + "/test",
        "POST",
        { recipient: { kind: "channel", value: "bound" } },
      );
    await f.alerts.sendPending();
    assert.equal(f.network.length, 1);
    const ds = (await f.request("/api/v1/notify/deliveries")).body;
    assert.equal(ds.filter((d: any) => d.status === "accepted").length, 1);
    const failed = ds.find((d: any) => d.status === "queued");
    failed.status = "unknown";
    failed.error = "ambiguous";
    f.alerts.updateDelivery(failed);
    assert.equal(
      (
        await f.request(
          "/api/v1/notify/deliveries/" + failed.id + "/retry",
          "POST",
          {},
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(
          "/api/v1/notify/deliveries/" + failed.id + "/retry",
          "POST",
          { confirm_possible_duplicate: true },
        )
      ).body.status,
      "queued",
    );
  } finally {
    await f.close();
  }
});
test("response group paging, acknowledgement, assignment statistics and recovery target previous responders", async () => {
  const f = await fixture();
  try {
    const { channel } = await makeLegacyGroup(f);
    const group = await f.request("/api/v1/alerts/groups", "POST", {
      name: "On call",
      enabled: true,
      members: ["u", "v"],
      primary: ["u"],
      backup: ["v"],
      channel_ids: [channel.id],
      policies: {
        P2: {
          methods: ["webhook"],
          repeat_seconds: 10,
          max_rounds: 3,
          handling_seconds: 60,
        },
      },
    });
    assert.equal(group.status, 200);
    const saved = await f.request("/api/v1/alerts/rules", "POST", {
      ...rule(),
      group_ids: [group.body.id],
      evidence_profile: {},
    });
    await f.alerts.evaluate(saved.body);
    let incidents = (await f.request("/api/v1/alerts/incidents")).body;
    assert.equal(incidents.length, 1);
    await f.alerts.tickResponses();
    await f.alerts.sendPending();
    assert.equal(f.network.length, 1);
    const ack = await f.request(
      "/api/v1/alerts/incidents/" + incidents[0].id + "/ack",
      "POST",
      {},
    );
    assert.equal(ack.body.state, "acknowledged");
    assert.equal(
      (
        await f.request(
          "/api/v1/alerts/incidents/" + incidents[0].id + "/ack",
          "POST",
          {},
          "v",
        )
      ).status,
      409,
    );
    const stats = (await f.request("/api/v1/alerts/response-statistics")).body;
    assert.equal(
      stats.users.find((v: any) => v.user_id === "u").acknowledged,
      1,
    );
    f.setQuery(async (q) =>
      result(q.queries, [
        { columns: [{ name: "value", type: "UInt64" }], rows: [["0"]] },
      ]),
    );
    f.setNow(new Date("2026-10-17T04:00:10Z"));
    await f.alerts.evaluate(saved.body);
    incidents = (await f.request("/api/v1/alerts/incidents")).body;
    assert.equal(incidents[0].state, "resolved");
    await f.alerts.tick();
    assert.equal(
      (await f.request("/api/v1/alerts/incidents")).body[0].resolution_notified,
      true,
    );
  } finally {
    await f.close();
  }
});
test("notification window accounting, DST rotations, silences and defaults preserve legacy policies", () => {
  assert.equal(
    windowAllowed(new Date("2026-10-16T23:30:00Z"), "UTC", "22:00", "02:00", [
      5,
    ]),
    true,
  );
  assert.equal(
    windowAllowed(new Date("2026-10-17T01:30:00Z"), "UTC", "22:00", "02:00", [
      5,
    ]),
    true,
  );
  assert.equal(
    windowAllowed(new Date("2026-10-17T02:00:00Z"), "UTC", "22:00", "02:00", [
      5,
    ]),
    false,
  );
  const g: any = {
    members: ["u", "v"],
    primary: ["u"],
    backup: [],
    timezone: "UTC",
    policies: { P2: { methods: ["webhook"], start: "09:00", end: "10:00" } },
  };
  const r = {
    priority: "P2",
    group: g,
    event: { state: { labels: {} } },
    group_id: "g",
  };
  assert.equal(
    responseActiveSeconds(
      r,
      Date.parse("2026-10-17T08:59:30Z"),
      Date.parse("2026-10-17T10:00:30Z"),
      [],
    ),
    3600,
  );
  assert.match(
    allowedResponse(r, new Date("2026-10-17T09:30:00Z"), [
      {
        scope: "all",
        from: "2026-10-17T09:00:00Z",
        until: "2026-10-17T10:00:00Z",
        reason: "maintenance",
      },
    ]),
    /maintenance/,
  );
  g.schedule = {
    mode: "daily",
    timezone: "America/New_York",
    anchor: "2026-10-31T09:00:00-04:00",
    shifts: [{ primary: ["u"] }, { primary: ["v"] }],
  };
  assert.deepEqual(onCall(g, new Date("2026-11-01T09:00:00-05:00")).primary, [
    "v",
  ]);
  assert.deepEqual(defaultPolicies().P0.methods, ["voice", "sms"]);
  assert.deepEqual(policy({ members: ["u"] }, "P0").methods, [
    "voice",
    "sms",
    "chat",
  ]);
});
test("evidence binds explicit services, redacts secrets and preserves trace identifiers", async () => {
  const f = await fixture();
  try {
    const { group } = await makeLegacyGroup(f);
    const saved = await f.request("/api/v1/alerts/rules", "POST", {
      ...rule(),
      group_ids: [group.id],
    });
    f.setQuery(async (q) =>
      result(q.queries, [
        {
          columns: ["event_time", "severity", "body", "trace_id"].map(
            (name) => ({ name, type: "String" }),
          ),
          rows: [
            [
              "time",
              "ERROR",
              "authorization=secret password=hidden",
              "trace-1",
            ],
          ],
        },
      ]),
    );
    const response = {
        rule_id: saved.body.id,
        event: { range: spec.range, state: { labels: { service: "api" } } },
      },
      e = await collectEvidence(f.alerts, response, {
        log_table_id: "log_app",
        lookback_seconds: 120,
        trace_table_ids: [],
      });
    assert.equal(e.status, "ready");
    assert.match(e.logs[0].body, /\[redacted\]/);
    assert.ok(!e.logs[0].body.includes("secret"));
    assert.deepEqual(e.trace_ids, ["trace-1"]);
    assert.match(f.calls.at(-1)!.queries[0].sql, /toString\(`service`\)/);
  } finally {
    await f.close();
  }
});
test("directory sync applies contacts atomically and preserves manually configured profiles", async () => {
  const response = {
    members: [
      { user_id: "u", profile: { email: "directory@example.test" } },
      { user_id: "v", profile: { email: "peer@example.test" } },
    ],
    primary: ["u"],
    backup: ["v"],
  };
  const f = await fixture({
    fetcher: (async () =>
      new Response(encode(response), { status: 200 })) as typeof fetch,
  });
  try {
    const { channel } = await makeLegacyGroup(f),
      group = (
        await f.request("/api/v1/alerts/groups", "POST", {
          name: "Directory",
          enabled: true,
          members: ["u", "v"],
          primary: ["u"],
          backup: ["v"],
          channel_ids: [channel.id],
        })
      ).body;
    f.db.run(
      "INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?)",
      "u",
      encode({ email: "manual@example.test", source: "manual" }),
    );
    const source = (
      await f.request(
        "/api/v1/settings/alert-directory-sources/source",
        "PUT",
        {
          name: "Source",
          url: "https://controlled.invalid",
          group_id: group.id,
          enabled: true,
          interval_seconds: 60,
          token: "private",
        },
      )
    ).body;
    await syncDirectory(f.alerts, source);
    assert.equal(f.alerts.member("u").profile.email, "manual@example.test");
    assert.equal(f.alerts.member("v").profile.email, "peer@example.test");
    assert.equal(f.alerts.group(group.id).revision, group.revision + 1);
  } finally {
    await f.close();
  }
});
test("provider signatures and phone formatting match fixed protocol vectors", () => {
  assert.equal(internationalPhone("13800000000"), "+8613800000000");
  assert.throws(() => internationalPhone("invalid"));
  assert.equal(
    smsSignature({ Action: "SendSms", PhoneNumbers: "13800000000" }, "secret"),
    "EILGAGxMBCwbB/vAJylYYYvJYf8=",
  );
  assert.match(
    tencentAuthorization(
      "id",
      "secret",
      "sms",
      "sms.tencentcloudapi.com",
      "{}",
      new Date("2026-10-17T00:00:00Z"),
    ),
    /^TC3-HMAC-SHA256 Credential=id\/2026-10-17\/sms\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/,
  );
  assert.equal(
    fingerprint({ b: "x", a: "<" }),
    fingerprint({ a: "<", b: "x" }),
  );
});
test("Tencent authorization matches the existing Go and independent Python vector byte-for-byte", () => {
  const body =
    '{"TemplateId":"123","TemplateParamSet":["CPU"],"CalledNumber":"+8613800000000","VoiceSdkAppid":"1400000000"}';
  assert.equal(
    tencentAuthorization(
      "test-id",
      "test-secret",
      "vms",
      "vms.tencentcloudapi.com",
      body,
      new Date(1791757800 * 1000),
    ),
    "TC3-HMAC-SHA256 Credential=test-id/2026-10-11/vms/tc3_request, SignedHeaders=content-type;host, Signature=8b4a0ca7003540f7f28a681fe49b384ba098db228b7ce1101cb811d94937d076",
  );
});
test("log context uses exact source sequence and tail retains nanosecond overlap bounds", async () => {
  const f = await fixture();
  try {
    const columns = [
      "event_id",
      "event_time",
      "service",
      "source_id",
      "source_seq",
      "body",
    ].map((name) => ({ name, type: "String" }));
    f.setQuery(async (q) =>
      result(
        q.queries,
        q.queries[0].refId === "anchor"
          ? [
              {
                columns,
                rows: [
                  [
                    "anchor",
                    "2026-10-17 03:30:00.123456789",
                    "api",
                    "file",
                    "18446744073709551614",
                    "anchor",
                  ],
                ],
              },
            ]
          : q.queries[0].refId === "before"
            ? [
                { columns, rows: [["b2"], ["b1"]] },
                { columns, rows: [["a1"]] },
              ]
            : [{ columns, rows: [] }],
      ),
    );
    const context = await f.request("/api/v1/logs/context", "POST", {
      spec: {
        ...spec,
        keyword: "removed",
        filters: [{ field: "severity", op: "eq", value: "ERROR" }],
      },
      event_id: "anchor",
    });
    assert.equal(context.status, 200);
    assert.deepEqual(
      context.body.frame.rows.map((r: any) => r[0]),
      ["b1", "b2", "anchor", "a1"],
    );
    assert.equal(context.body.order, "source_seq");
    assert.equal(
      f.calls[1].queries[0].params!.lm_log_seq.value,
      "18446744073709551614",
    );
    assert.ok(!f.calls[0].queries[0].sql.includes("lm_log_keyword"));
    const tail = await f.request("/api/v1/logs/tail", "POST", {
      spec,
      since: "2026-10-17T03:59:30.123456789Z",
    });
    assert.equal(tail.status, 200);
    assert.equal(
      f.calls.at(-1)!.queries[0].params!.lm_log_since.value,
      "2026-10-17T03:59:15.123456789Z",
    );
  } finally {
    await f.close();
  }
});
test("all native paid providers bind configured templates and distinguish ambiguous vendor results", async () => {
  const submissions: any[] = [],
    f = await fixture({
      fetcher: (async (url, init) => {
        submissions.push({ url, init });
        const u = String(url);
        return new Response(
          u.includes("aliyun")
            ? '{"Code":"OK","CallId":"call","BizId":"sms"}'
            : u.includes("tencent")
              ? '{"Response":{"SendStatus":{"CallId":"call"},"SendStatusSet":[{"Code":"Ok","SerialNo":"sms"}]}}'
              : '{"code":"000000","result":[{"status":"000000","smsMsgId":"sms"}]}',
        );
      }) as typeof fetch,
    });
  try {
    const d = {
      id: "notification",
      event_id: "event",
      recipient: { kind: "phone", value: "13800000000" },
      payload: {
        rule_name: "CPU",
        kind: "firing",
        state: { value: "2" },
        message: "test",
      },
      priority: "P0",
      ack_url: "http://claim",
    };
    for (const type of [
      "aliyun_sms",
      "aliyun_voice",
      "tencent_sms",
      "tencent_voice",
      "huawei_sms",
    ]) {
      const cfg: any = {
        endpoint: "http://" + type.split("_")[0] + ".controlled.invalid/",
        access_key_id: "ALI",
        access_key_secret: "SECRET",
        template_code: "tpl",
        sign_name: "name",
        template_id: "tpl",
        sdk_app_id: "app",
        secret_id: "TENCENT",
        secret_key: "SECRET",
        app_key: "HUAWEI",
        app_secret: "SECRET",
        sender: "sender",
        template_params: type.startsWith("aliyun")
          ? '{"name":"{{rule}}"}'
          : '["{{rule}}","{{priority}}"]',
      };
      const out = await f.alerts.notifications.send(
        { id: type, type, config: cfg },
        d,
      );
      assert.equal(out.status, "accepted", type);
    }
    const forms = submissions
      .slice(0, 2)
      .map((v) => new URLSearchParams(v.init.body));
    assert.equal(forms[0].get("TemplateParam"), '{"name":"CPU"}');
    assert.equal(forms[1].get("TtsParam"), '{"name":"CPU"}');
    assert.equal(forms[1].get("OutId"), "notification");
    assert.equal(
      JSON.parse(submissions[2].init.body).PhoneNumberSet[0],
      "+8613800000000",
    );
    assert.match(submissions[2].init.headers.Authorization, /TC3-HMAC-SHA256/);
    assert.match(submissions[4].init.headers["X-WSSE"], /PasswordDigest=/);
    assert.equal(
      new URLSearchParams(submissions[4].init.body).get("templateParas"),
      '["CPU","P0"]',
    );
  } finally {
    await f.close();
  }
});
test("Feishu, DingTalk, WeCom, Pushplus and Webhook preserve provider-specific payload contracts", async () => {
  const sent: any[] = [],
    f = await fixture({
      fetcher: (async (url, init) => {
        sent.push({ url: String(url), init });
        return new Response(
          String(url).includes("pushplus")
            ? '{"code":200,"data":"short"}'
            : String(url).includes("feishu")
              ? '{"code":0}'
              : '{"errcode":0}',
        );
      }) as typeof fetch,
    });
  try {
    const d = {
      id: "n",
      event_id: "e",
      recipient: {
        kind: "channel",
        value: "bound",
        mentions: ["13800000000", "user"],
      },
      payload: { rule_name: "Alarm", kind: "firing", message: "message" },
      ack_url: "http://claim",
      response_id: "r",
    };
    for (const type of ["feishu", "dingtalk", "wecom", "pushplus", "webhook"]) {
      const out = await f.alerts.notifications.send(
        {
          type,
          config: {
            url: "http://" + type + ".invalid",
            endpoint:
              type === "pushplus" ? "http://pushplus.invalid" : undefined,
            secret: "SIGN",
            token: "TOKEN",
            push_channel: "app",
          },
        },
        d,
      );
      assert.equal(out.status, "accepted", type);
    }
    assert.equal(JSON.parse(sent[0].init.body).msg_type, "interactive");
    assert.ok(JSON.parse(sent[0].init.body).sign);
    assert.ok(new URL(sent[1].url).searchParams.get("sign"));
    assert.equal(
      JSON.parse(sent[1].init.body).actionCard.singleURL,
      "http://claim",
    );
    assert.equal(JSON.parse(sent[2].init.body).msgtype, "markdown");
    assert.equal(JSON.parse(sent[3].init.body).channel, "app");
    assert.match(sent[4].init.headers["X-LightMoni-Signature"], /^sha256=/);
  } finally {
    await f.close();
  }
});
test("uncertain network submission never automatically retries a paid notification", async () => {
  const f = await fixture({
    fetcher: (async () => {
      throw Error("connection reset after write");
    }) as typeof fetch,
  });
  try {
    const result = await f.alerts.notifications.send(
      {
        type: "aliyun_voice",
        config: {
          access_key_id: "id",
          access_key_secret: "secret",
          template_code: "t",
        },
      },
      {
        id: "n",
        recipient: { value: "13800000000" },
        payload: { rule_name: "Alarm", kind: "firing", state: { value: "1" } },
      },
    );
    assert.equal(result.status, "unknown");
    assert.ok(!result.retryable);
  } finally {
    await f.close();
  }
});
test("SMTP submits UTF-8 mail to a controlled local server with a durable notification Message-ID", async () => {
  let message = "",
    data = false;
  const sockets = new Set<any>();
  const smtp = createTCPServer((socket) => {
    sockets.add(socket);
    socket.write("220 localhost ESMTP\r\n");
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      for (;;) {
        const n = pending.indexOf("\r\n");
        if (n < 0) break;
        const line = pending.slice(0, n);
        pending = pending.slice(n + 2);
        if (data) {
          if (line === ".") {
            data = false;
            socket.write("250 queued\r\n");
          } else message += line + "\n";
        } else if (line.startsWith("EHLO"))
          socket.write("250-localhost\r\n250 SIZE 1000000\r\n");
        else if (line.startsWith("MAIL") || line.startsWith("RCPT"))
          socket.write("250 ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("250 ok\r\n");
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  smtp.listen(0, "127.0.0.1");
  await once(smtp, "listening");
  const f = await fixture();
  try {
    const out = await f.alerts.notifications.send(
      {
        type: "smtp",
        config: {
          host: "127.0.0.1",
          port: String((smtp.address() as any).port),
          tls: "none",
          from: "sender@example.test",
        },
      },
      {
        id: "stable-notification",
        recipient: { kind: "email", value: "target@example.test" },
        payload: {
          rule_name: "中文告警",
          kind: "firing",
          message: "Error details",
        },
        ack_url: "http://claim",
      },
    );
    assert.equal(out.status, "accepted");
    assert.match(message, /Message-ID: <stable-notification@lightmoni>/i);
    assert.match(message, /target@example.test/);
  } finally {
    await f.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  }
});
test("voice callbacks authenticate, deduplicate receipts, acknowledge the recipient and preserve answered state against a late writer", async () => {
  const f = await fixture({
    fetcher: (async () =>
      new Response('{"Code":"OK","CallId":"call-id"}')) as typeof fetch,
  });
  try {
    f.db.run(
      "INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?)",
      "u",
      encode({ phone: "+8613800000000" }),
    );
    const channel = (
      await f.request("/api/v1/notify/channels", "POST", {
        name: "Voice",
        type: "aliyun_voice",
        enabled: true,
        config: {
          endpoint: "http://voice.controlled.invalid",
          access_key_id: "key",
          access_key_secret: "secret",
          template_code: "tpl",
        },
      })
    ).body;
    const group = (
      await f.request("/api/v1/alerts/groups", "POST", {
        name: "Voice group",
        enabled: true,
        members: ["u"],
        primary: ["u"],
        channel_ids: [channel.id],
        policies: {
          P0: {
            methods: ["voice"],
            repeat_seconds: 10,
            max_rounds: 2,
            handling_seconds: 60,
          },
        },
      })
    ).body;
    const saved = (
      await f.request("/api/v1/alerts/rules", "POST", {
        ...rule(),
        severity: "P0",
        group_ids: [group.id],
        evidence_profile: {},
      })
    ).body;
    await f.alerts.evaluate(saved);
    await f.alerts.tickResponses();
    await f.alerts.sendPending();
    const d = (await f.request("/api/v1/notify/deliveries")).body[0],
      token = f.alerts.channel(channel.id, true).config.callback_token,
      url = "/api/v1/notify/callbacks/" + channel.id + "/";
    assert.equal(
      (
        await f.request(url + "wrong", "POST", [
          { call_id: "call-id", duration: 5 },
        ])
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(url + token, "POST", [
          { call_id: "call-id", duration: 5 },
        ])
      ).status,
      200,
    );
    assert.equal(
      (await f.request("/api/v1/alerts/incidents")).body[0].ack_method,
      "phone_answered",
    );
    assert.equal(
      (
        await f.request(url + token, "POST", [
          { call_id: "call-id", duration: 5 },
        ])
      ).status,
      200,
    );
    assert.equal(
      f.db.get<any>("SELECT count(*) AS n FROM alert_voice_receipts")!.n,
      1,
    );
    d.status = "accepted";
    d.next_attempt = stamp(new Date("2026-10-17T04:01:00Z"));
    f.alerts.updateDelivery(d);
    const latest = (await f.request("/api/v1/notify/deliveries")).body[0];
    assert.equal(latest.status, "confirmed");
    assert.equal(latest.delivery_status, "answered");
    assert.equal(latest.next_attempt, "");
  } finally {
    await f.close();
  }
});
test("Feishu callbacks require the saved verification token and support challenge validation", async () => {
  const f = await fixture();
  try {
    const ch = (
        await f.request("/api/v1/notify/channels", "POST", {
          name: "Application",
          type: "feishu_app",
          enabled: true,
          config: {
            app_id: "app",
            app_secret: "secret",
            verification_token: "verify",
          },
        })
      ).body,
      token = f.alerts.channel(ch.id, true).config.callback_token,
      path = "/api/v1/notify/callbacks/" + ch.id + "/" + token;
    assert.equal(
      (await f.request(path, "POST", { token: "bad", challenge: "challenge" }))
        .status,
      403,
    );
    assert.deepEqual(
      (
        await f.request(path, "POST", {
          token: "verify",
          challenge: "challenge",
        })
      ).body,
      { challenge: "challenge" },
    );
    assert.equal(
      (
        await f.request(path, "POST", {
          token: "verify",
          header: { app_id: "other" },
          challenge: "challenge",
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});
test("night rounds count fresh continuing detections after firing and do not inflate on worker scans", async () => {
  const f = await fixture();
  try {
    f.setNow(new Date("2026-10-17T14:00:00Z"));
    const { channel } = await makeLegacyGroup(f),
      p = {
        ...defaultPolicies().P1,
        methods: ["webhook"],
        night_methods: ["webhook"],
        repeat_seconds: 60,
      },
      g = (
        await f.request("/api/v1/alerts/groups", "POST", {
          name: "Night",
          enabled: true,
          members: ["u"],
          primary: ["u"],
          channel_ids: [channel.id],
          policies: { P1: p },
        })
      ).body,
      r = (
        await f.request("/api/v1/alerts/rules", "POST", {
          ...rule(),
          severity: "P1",
          for_count: 3,
          group_ids: [g.id],
          evidence_profile: {},
        })
      ).body;
    for (let n = 0; n < 3; n++) {
      f.setNow(new Date(Date.parse("2026-10-17T14:00:00Z") + n * 10000));
      await f.alerts.evaluate(r);
      await f.alerts.tickResponses();
    }
    let incident = (await f.request("/api/v1/alerts/incidents")).body[0];
    assert.equal(incident.night_count, 1);
    assert.equal(incident.round, 0);
    for (let n = 0; n < 3; n++) await f.alerts.tickResponses();
    assert.equal(
      (await f.request("/api/v1/alerts/incidents")).body[0].night_count,
      1,
    );
    for (let n = 3; n <= 8; n++) {
      f.setNow(new Date(Date.parse("2026-10-17T14:00:00Z") + n * 10000));
      await f.alerts.evaluate(r);
      await f.alerts.tickResponses();
    }
    incident = (await f.request("/api/v1/alerts/incidents")).body[0];
    assert.equal(incident.night_count, 2);
    assert.equal(incident.round, 0);
    for (let n = 9; n <= 14; n++) {
      f.setNow(new Date(Date.parse("2026-10-17T14:00:00Z") + n * 10000));
      await f.alerts.evaluate(r);
      await f.alerts.tickResponses();
    }
    incident = (await f.request("/api/v1/alerts/incidents")).body[0];
    assert.equal(incident.night_count, 3);
    assert.equal(incident.round, 1);
    await f.alerts.sendPending();
    assert.equal(f.network.length, 1);
  } finally {
    await f.close();
  }
});
test("grouped no-data marks each known instance missing while query errors cannot silently recover it", async () => {
  const f = await fixture();
  try {
    const { group } = await makeLegacyGroup(f),
      r = (
        await f.request("/api/v1/alerts/rules", "POST", {
          ...rule(),
          label_fields: ["host"],
          group_ids: [group.id],
          no_data_policy: "zero",
          evidence_profile: {},
        })
      ).body;
    f.setQuery(async (q) =>
      result(q.queries, [
        {
          columns: [
            { name: "host", type: "String" },
            { name: "value", type: "Int64" },
          ],
          rows: [
            ["a", "2"],
            ["b", "2"],
          ],
        },
      ]),
    );
    await f.alerts.evaluate(r);
    f.setNow(new Date("2026-10-17T04:00:10Z"));
    f.setQuery(async (q) =>
      result(q.queries, [
        {
          columns: [
            { name: "host", type: "String" },
            { name: "value", type: "Int64" },
          ],
          rows: [],
        },
      ]),
    );
    await f.alerts.evaluate(r);
    let states = (await f.request("/api/v1/alerts/instances")).body;
    assert.equal(states.length, 2);
    assert.ok(
      states.every((v: any) => v.status === "normal" && v.value === "0"),
    );
    f.setQuery(async (q) => {
      const out = result(q.queries, []);
      out.results[0].status = "error";
      out.results[0].error = "storage unavailable";
      return out;
    });
    f.setNow(new Date("2026-10-17T04:00:20Z"));
    await f.alerts.evaluate(r);
    states = (await f.request("/api/v1/alerts/instances")).body;
    assert.ok(states.every((v: any) => v.health === "error"));
  } finally {
    await f.close();
  }
});
test("annotation filtering happens before global history limits and preserves nanosecond boundaries", async () => {
  const f = await fixture();
  try {
    const { group } = await makeLegacyGroup(f),
      r = (
        await f.request("/api/v1/alerts/rules", "POST", {
          ...rule(),
          group_ids: [group.id],
        })
      ).body;
    f.db.transaction(() => {
      for (let n = 0; n < 600; n++) {
        const e = {
          id: "new-" + n,
          rule_id: r.id,
          kind: "firing",
          created_at: "2026-10-17T04:00:00.000000000Z",
        };
        f.db.run(
          "INSERT INTO alert_events(id,rule_id,created_at,body) VALUES(?,?,?,?)",
          e.id,
          r.id,
          e.created_at,
          encode(e),
        );
      }
      const e = {
        id: "old",
        rule_id: r.id,
        kind: "firing",
        created_at: "2026-10-01T00:00:00.123456789Z",
      };
      f.db.run(
        "INSERT INTO alert_events(id,rule_id,created_at,body) VALUES(?,?,?,?)",
        e.id,
        r.id,
        e.created_at,
        encode(e),
      );
    });
    const out = await f.request(
      "/api/v1/alerts/annotations?rule_id=" +
        r.id +
        "&from=2026-10-01T00%3A00%3A00.123456789Z&to=2026-10-01T00%3A00%3A00.123456790Z",
    );
    assert.equal(out.status, 200);
    assert.equal(out.body.events.length, 1);
    assert.equal(out.body.events[0].id, "old");
  } finally {
    await f.close();
  }
});

test("claim rechecks terminal state after async routing", async () => {
  const f = await fixture();
  try {
    const { channel } = await makeLegacyGroup(f),
      group = (
        await f.request("/api/v1/alerts/groups", "POST", {
          name: "Race",
          enabled: true,
          members: ["u"],
          primary: ["u"],
          channel_ids: [channel.id],
        })
      ).body,
      saved = (
        await f.request("/api/v1/alerts/rules", "POST", {
          ...rule(),
          group_ids: [group.id],
          evidence_profile: {},
        })
      ).body;
    await f.alerts.evaluate(saved);
    const incident = (await f.request("/api/v1/alerts/incidents")).body[0],
      original = f.alerts.ruleGroups.bind(f.alerts);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.alerts.ruleGroups = async (r) => {
      const groups = await original(r);
      await gate;
      return groups;
    };
    const pending = f.alerts.acknowledge(incident.id, "u", "web");
    const latest = f.alerts.response(incident.id);
    latest.state = "resolved";
    latest.generation++;
    f.alerts.saveResponse(latest);
    release();
    await assert.rejects(pending, /告警已恢复/);
    assert.equal(f.alerts.response(incident.id).state, "resolved");
  } finally {
    await f.close();
  }
});
test("RFC3339 dates reject impossible calendar days and preserve pre-epoch nanoseconds", () => {
  assert.ok(Number.isNaN(parseTime("2026-02-30T00:00:00Z")));
  assert.ok(Number.isNaN(parseTime("2026-02-29T00:00:00Z")));
  assert.ok(Number.isFinite(parseTime("2024-02-29T00:00:00Z")));
  assert.equal(timeNanos("1969-12-31T23:59:59.999999999Z"), -1n);
});
test("encrypted Feishu callbacks validate signature, freshness and decrypted token", async () => {
  const f = await fixture();
  try {
    const encryptKey = "encrypt-key",
      saved = (
        await f.request("/api/v1/notify/channels", "POST", {
          name: "Encrypted",
          type: "feishu_app",
          enabled: true,
          config: {
            app_id: "app",
            app_secret: "secret",
            verification_token: "verify",
            encrypt_key: encryptKey,
          },
        })
      ).body,
      token = f.alerts.channel(saved.id, true).config.callback_token,
      path = "/api/v1/notify/callbacks/" + saved.id + "/" + token;
    const iv = Buffer.alloc(16, 3),
      cipher = createCipheriv(
        "aes-256-cbc",
        createHash("sha256").update(encryptKey).digest(),
        iv,
      ),
      encrypted = Buffer.concat([
        iv,
        cipher.update(
          encode({ token: "verify", challenge: "encrypted-challenge" }),
        ),
        cipher.final(),
      ]).toString("base64"),
      body = { encrypt: encrypted },
      timestamp = String(Date.parse("2026-10-17T04:00:00Z") / 1000),
      nonce = "nonce",
      headers = {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": createHash("sha256")
          .update(timestamp + nonce + encryptKey + encode(body))
          .digest("hex"),
      };
    assert.deepEqual((await f.request(path, "POST", body, "u", headers)).body, {
      challenge: "encrypted-challenge",
    });
    assert.equal(
      (
        await f.request(path, "POST", body, "u", {
          ...headers,
          "x-lark-signature": "invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(path, "POST", body, "u", {
          ...headers,
          "x-lark-request-timestamp": "1",
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("slow evaluation does not block response and delivery worker", async (t) => {
  const f = await fixture();
  let release!: () => void;
  try {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const gate = new Promise<void>((resolve) => (release = resolve));
    let evaluations = 0,
      dispatches = 0;
    f.alerts.evaluateDue = async () => {
      evaluations++;
      await gate;
    };
    f.alerts.workDue = async () => {
      dispatches++;
    };
    f.alerts.start();
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(evaluations, 1);
    assert.equal(dispatches, 1);
    release();
    await f.alerts.close();
  } finally {
    release?.();
    t.mock.timers.reset();
    await f.close();
  }
});
test("existing built-in Go runtime panel migrates once without replacing dashboard edits", async () => {
  const f = await fixture();
  try {
    const row = f.db.get<any>(
        "SELECT body FROM dashboards WHERE id='system-center'",
      )!,
      d = parseJSON<any>(row.body);
    d.title = "My center";
    d.panels[0].title = "Custom QPS";
    d.panels = d.panels.filter((p: any) => p.id !== "system-center-event-loop");
    const panel = d.panels.find((p: any) => p.id === "system-center-k");
    panel.title = "运行协程数";
    panel.queries[0].sql = panel.queries[0].sql.replace(
      "lightmoni.center.active_resources",
      "lightmoni.center.goroutines",
    );
    f.db.run(
      "UPDATE dashboards SET title=?,body=? WHERE id=?",
      d.title,
      encode(d),
      d.id,
    );
    f.db.run(
      "DELETE FROM system_dashboard_seeds WHERE id='node-runtime-center-v1'",
    );
    f.dashboards.seed();
    const migrated = parseJSON<any>(
      f.db.get<any>("SELECT body FROM dashboards WHERE id='system-center'")!
        .body,
    );
    assert.equal(migrated.title, "My center");
    assert.equal(migrated.panels[0].title, "Custom QPS");
    assert.equal(migrated.revision, 2);
    assert.equal(
      migrated.panels.find((p: any) => p.id === "system-center-k").title,
      "Node 活跃资源数",
    );
    assert.ok(
      migrated.panels.some((p: any) => p.id === "system-center-event-loop"),
    );
    f.dashboards.seed();
    assert.equal(
      parseJSON<any>(
        f.db.get<any>("SELECT body FROM dashboards WHERE id='system-center'")!
          .body,
      ).revision,
      2,
    );
  } finally {
    await f.close();
  }
});
