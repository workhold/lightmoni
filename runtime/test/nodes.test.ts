import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Dependencies } from "../src/shared/types.js";
import { Router, HTTPError } from "../src/shared/http.js";
import { DB } from "../src/shared/sqlite.js";
import { NodeStore } from "../src/server/nodes-model.js";
import { registerNodes, type NodesOptions } from "../src/server/nodes.js";
const at = new Date("2026-10-17T03:00:00Z");
const host = {
  collect_interval_seconds: 15,
  host_table: "machines",
  host_collectors: ["memory"],
  process_names: [],
};
const probe = (id = "health", target = "https://fixture.invalid/health") => ({
  id,
  kind: "http",
  target,
  interval_seconds: 60,
  timeout_ms: 1000,
  expected_status: [200],
});
async function fixture(
  t: any,
  options: NodesOptions = {},
  prepare?: (db: DB) => void,
) {
  const db = new DB(":memory:");
  prepare?.(db);
  const router = new Router(),
    user = { id: "admin", name: "fixture", role: "admin" },
    writeKey = {
      id: "key-id",
      name: "fixture",
      allowed_tables: ["business"],
      allow_all_tables: false,
    },
    deps = {
      db,
      router,
      now: () => at,
      auth: {
        user: () => user,
        requireAdmin: () => {},
        validateKey: (ctx: any) => {
          if (ctx.req.headers.authorization !== "Bearer fixture-key")
            throw new HTTPError(401, "bad key");
          return writeKey;
        },
        master: Buffer.alloc(32),
      },
      cat: { list: async () => [], ensure: async () => {} },
      ch: { insert: async () => {} },
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as Dependencies;
  router.auth = deps.auth;
  const agentCredentials = { authenticate(req: any, agentID: string) {
    if (req.headers.authorization !== "Bearer fixture-key") throw new HTTPError(401, "invalid control credential");
    return { credential_id: "key-id", agent_id: agentID, audience: "control", scope: "agent.control", expires_at: "", last_used_at: "" };
  } } as any;
  const module = registerNodes(deps, { agentCredentials, ...options }),
    server = createServer(async (req, res) => {
      if (!(await router.handle(req, res))) {
        res.writeHead(404);
        res.end();
      }
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => {
    await module.close?.();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });
  const request = async (
    path: string,
    method = "GET",
    body?: any,
    key = false,
  ) => {
    const response = await fetch(url + "/api/v1" + path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: "Bearer fixture-key" } : {}),
        },
      }),
      raw = await response.text();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    return { status: response.status, data, raw };
  };
  return { db, user, deps, module, request, writeKey };
}
async function label(f: any, name: string) {
  const result = await f.request("/agent-task-labels", "POST", { name });
  assert.equal(result.status, 201, result.raw);
  return result.data.id;
}
async function task(
  f: any,
  name: string,
  type: string,
  labels: string[],
  config: any,
  enabled = true,
) {
  const result = await f.request("/agent-tasks", "POST", {
    name,
    type,
    label_ids: labels,
    config,
    enabled,
  });
  assert.equal(result.status, 201, result.raw);
  return result.data;
}
async function node(f: any, id: string, group: string, extra: any = {}) {
  // Task tests use a trusted, server-reserved installation identity.
  f.db.exec("CREATE TABLE IF NOT EXISTS agent_enrollments(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT,machine_id TEXT,created_at TEXT)");
  f.db.run("INSERT OR IGNORE INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'deploy','direct_ssh',?,?,?)", "machine-" + id, id, id + ".example.test", id, at.toISOString(), at.toISOString());
  f.db.run("INSERT OR IGNORE INTO agent_enrollments VALUES(?,?,'active',?,'2026-10-01T00:00:00.000Z')", id, id, "machine-" + id);
  const result = await f.request(
    "/agents/register",
    "POST",
    {
      agent_id: id,
      hostname: id,
      host_id: "host-" + id,
      group_id: group,
      ...extra,
    },
    true,
  );
  assert.equal(result.status, 200, result.raw);
}
async function config(f: any, id: string) {
  const result = await f.request(
    "/agents/" + id + "/config",
    "GET",
    undefined,
    true,
  );
  assert.equal(result.status, 200, result.raw);
  return result.data;
}

test("independent labels/tasks compile ANY match once, stable config and empty-label withdrawal", async (t) => {
  const f = await fixture(t),
    a = await label(f, "生产"),
    b = await label(f, "订单");
  const h = await task(f, "指标", "host", [a], host),
    p = await task(f, "拨测", "probe", [a, b], {
      probe_table: "checks",
      probes: [probe()],
    }),
    l = await task(f, "日志", "log", [b], {
      log_table: "order_logs",
      log_sources: [{ directory: "/var/log/orders", pattern: "*.log*" }],
    });
  await node(f, "a", a);
  await node(f, "b", b);
  assert.deepEqual((await config(f, "a")).task_ids.sort(), [h.id, p.id].sort());
  assert.equal((await config(f, "b")).host_enabled, false);
  assert.equal(
    (await f.request("/agents/a/labels", "PUT", { label_ids: [a, b, a] }))
      .status,
    200,
  );
  const combined = await config(f, "a");
  assert.equal(combined.task_ids.length, 3);
  assert.equal(combined.probes.length, 1);
  assert.equal(combined.logs_enabled, true);
  assert.equal(combined.revision, (await config(f, "a")).revision);
  assert.equal(
    (await f.request("/agents/a/labels", "PUT", { label_ids: [] })).status,
    200,
  );
  const empty = await config(f, "a");
  assert.equal(empty.host_enabled, false);
  assert.equal(empty.logs_enabled, false);
  assert.deepEqual(empty.probes, []);
  assert.deepEqual(empty.task_ids, []);
  await f.request(
    "/agents/a/heartbeat",
    "POST",
    { group_id: b, hostname: "renamed" },
    true,
  );
  assert.deepEqual(
    (await f.request("/agents")).data.find((n: any) => n.id === "a").label_ids,
    [],
  );
  assert.equal(
    f.db.get<any>("SELECT host_id FROM agents WHERE id=?", "a").host_id,
    "host-a",
  );
});
test("all affected-node conflicts are rejected atomically and preserve original revision", async (t) => {
  const f = await fixture(t),
    a = await label(f, "a"),
    b = await label(f, "b");
  const h = await task(f, "主指标", "host", [a], host),
    other = await task(f, "其他指标", "host", [b], {
      ...host,
      collect_interval_seconds: 30,
    });
  await node(f, "a", a);
  const before = await config(f, "a");
  const conflict = await f.request("/agents/a/labels", "PUT", {
    label_ids: [a, b],
  });
  assert.equal(conflict.status, 409, conflict.raw);
  assert.deepEqual((await f.request("/agents")).data[0].label_ids, [a]);
  assert.equal((await config(f, "a")).revision, before.revision);
  assert.equal(
    (
      await f.request("/agent-tasks/" + other.id, "PUT", {
        ...other,
        label_ids: [a, b],
      })
    ).status,
    409,
  );
  assert.deepEqual(
    (await f.request("/agent-tasks")).data.find((t: any) => t.id === other.id)
      .label_ids,
    [b],
  );
  assert.equal((await f.request("/agent-tasks/" + h.id, "DELETE")).status, 200);
  assert.equal((await config(f, "a")).host_enabled, false);
});
test("probe id and log-source strategy conflicts reject, identical work deduplicates", async (t) => {
  const f = await fixture(t),
    a = await label(f, "a");
  await task(f, "p1", "probe", [a], { probes: [probe()] });
  await task(f, "p2", "probe", [a], { probes: [probe()] });
  await node(f, "node", a);
  assert.equal((await config(f, "node")).probes.length, 1);
  const bad = await f.request("/agent-tasks", "POST", {
    name: "bad",
    type: "probe",
    enabled: true,
    label_ids: [a],
    config: { probes: [probe("health", "https://other.invalid")] },
  });
  assert.equal(bad.status, 409, bad.raw);
  await task(f, "l1", "log", [a], {
    log_sources: [
      {
        directory: "/var/log/orders/../orders",
        pattern: "*.log*",
        from_beginning: false,
      },
    ],
  });
  await task(f, "l2", "log", [a], {
    log_sources: [
      {
        directory: "/var/log/orders",
        pattern: "*.log*",
        from_beginning: false,
      },
    ],
  });
  assert.equal((await config(f, "node")).log_sources.length, 1);
  assert.equal(
    (
      await f.request("/agent-tasks", "POST", {
        name: "l3",
        type: "log",
        enabled: true,
        label_ids: [a],
        config: {
          log_sources: [
            {
              directory: "/var/log/orders",
              pattern: "*.log*",
              from_beginning: true,
            },
          ],
        },
      })
    ).status,
    409,
  );
});
test("first registration conflicts leave no half node and existing registrations retain central labels", async (t) => {
  const f = await fixture(t),
    a = await label(f, "a"),
    b = await label(f, "b");
  await task(f, "p1", "probe", [a], { probes: [probe()] });
  await task(f, "p2", "probe", [a], {
    probes: [probe("health", "https://other.invalid")],
  });
  const first = await f.request(
    "/agents/register",
    "POST",
    { agent_id: "bad", group_id: a },
    true,
  );
  assert.equal(first.status, 409);
  assert.equal(f.db.get("SELECT id FROM agents WHERE id=?", "bad"), undefined);
  assert.equal(
    (
      await f.request(
        "/agents/register",
        "POST",
        { agent_id: "missing", group_id: "does-not-exist" },
        true,
      )
    ).status,
    400,
  );
  await node(f, "good", b);
  await f.request("/agents/good/labels", "PUT", { label_ids: [] });
  await node(f, "good", a);
  assert.deepEqual((await f.request("/agents")).data[0].label_ids, []);
});
test("new label starts with no tasks and cannot be deleted while referenced; read-only roles reject writes", async (t) => {
  const f = await fixture(t),
    a = await label(f, "a");
  assert.deepEqual(
    (await f.request("/agent-tasks")).data.filter((t: any) =>
      t.label_ids.includes(a),
    ),
    [],
  );
  const value = await task(f, "host", "host", [a], host);
  assert.equal(
    (await f.request("/agent-task-labels/" + a, "DELETE")).status,
    409,
  );
  assert.equal(
    (await f.request("/agent-task-labels/default", "DELETE")).status,
    409,
  );
  await f.request("/agent-tasks/" + value.id, "DELETE");
  assert.equal(
    (await f.request("/agent-task-labels/" + a, "DELETE")).status,
    200,
  );
  f.user.role = "member";
  for (const [path, method, body] of [
    ["/agent-task-labels", "POST", { name: "x" }],
    ["/agent-tasks", "POST", {}],
    ["/agent-groups", "POST", { name: "x" }],
    ["/agents/x/labels", "PUT", { label_ids: [] }],
    ["/agent-task-labels/default", "DELETE", undefined],
  ] as const)
    assert.equal((await f.request(path, method, body)).status, 403);
  assert.equal((await f.request("/agent-task-labels")).status, 200);
  assert.equal((await f.request("/agents/n/config")).status, 401);
  assert.equal(
    (await f.request("/agents/register", "POST", { agent_id: "x" })).status,
    401,
  );
});
test("legacy group API writes real tasks and guards independent/moved migration tasks", async (t) => {
  const f = await fixture(t),
    created = await f.request("/agent-groups", "POST", {
      name: "legacy",
      config: { ...host, host_enabled: true },
    });
  assert.equal(created.status, 201, created.raw);
  const group = created.data.id;
  await node(f, "legacy-node", group);
  assert.equal((await config(f, "legacy-node")).host_table, "host");
  const renamed = await f.request("/agent-groups/" + group, "PUT", {
    name: "renamed",
  });
  assert.equal(renamed.status, 200);
  assert.equal((await config(f, "legacy-node")).host_table, "host");
  const independent = await task(f, "independent", "probe", [group], {
    probes: [probe()],
  });
  const combined = (await f.request("/agent-groups")).data.find(
    (g: any) => g.id === group,
  );
  assert.equal(combined.config.probes.length, 1);
  assert.equal(
    (
      await f.request("/agent-groups/" + group, "PUT", {
        name: "legacy",
        config: combined.config,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("/agent-groups/" + group, "PUT", {
        name: "renamed again",
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/agent-tasks")).data.filter(
      (task: any) => task.type === "probe" && task.enabled,
    ).length,
    1,
  );
  await f.request("/agents/legacy-node/group", "PUT", { group_id: "default" });
  assert.equal(
    (await f.request("/agent-groups/" + group, "DELETE")).status,
    409,
  );
  await f.request("/agent-tasks/" + independent.id, "DELETE");
  const old = (await f.request("/agent-tasks")).data.find(
      (task: any) => task.id === `legacy:${group}:host`,
    ),
    b = await label(f, "b");
  await f.request("/agent-tasks/" + old.id, "PUT", { ...old, label_ids: [b] });
  assert.equal(
    (await f.request("/agent-groups/" + group, "DELETE")).status,
    409,
  );
  assert.equal(
    (
      await f.request("/agent-groups/" + group, "PUT", {
        name: "rename",
        config: created.data.config,
      })
    ).status,
    409,
  );
});
test("legacy schema migrates exact identities/settings once and restart never recreates deleted tasks", () => {
  const db = new DB(":memory:");
  try {
    db.exec(
      "CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT NOT NULL,hostname TEXT NOT NULL,version TEXT NOT NULL,platform TEXT NOT NULL,arch TEXT NOT NULL,last_seen TEXT NOT NULL,heartbeat TEXT NOT NULL); CREATE TABLE agent_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,config TEXT NOT NULL,created_at TEXT NOT NULL)",
    );
    db.run(
      "INSERT INTO agents VALUES(?,?,?,?,?,?,?,?)",
      "old-node",
      "identity",
      "old",
      "",
      "linux",
      "amd64",
      at.toISOString(),
      "{}",
    );
    db.run(
      "INSERT INTO agent_groups VALUES(?,?,?,?)",
      "default",
      "默认分组",
      JSON.stringify({
        revision: "old",
        collect_interval_seconds: 27,
        host_table: "old_hosts",
        probe_table: "old_probes",
        log_table: "old_files",
        host_enabled: false,
        host_collectors: [],
        probes: [],
        logs_enabled: false,
        log_sources: [],
      }),
      at.toISOString(),
    );
    const store = new NodeStore(db, () => at);
    assert.deepEqual(store.nodeLabels("old-node"), ["default"]);
    assert.equal(
      store.compile(["default"], "default").config.collect_interval_seconds,
      27,
    );
    assert.equal(
      store.compile(["default"], "default").config.host_table,
      "host",
    );
    assert.equal(store.labels()[0].name, "默认标签");
    assert.equal(store.tasks().length, 3);
    const t = store.tasks().find((t) => t.type === "probe")!;
    store.deleteTask(t.id);
    new NodeStore(db, () => at);
    assert.equal(store.tasks().length, 2);
    assert.equal(
      db.get<any>("SELECT count(*) AS n FROM agent_task_migrations").n,
      1,
    );
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
  } finally {
    db.close();
  }
});
test("runtime events are bounded/idempotent, persist through export failure and retain Go event IDs", async (t) => {
  let fail = true;
  const exports: any[] = [];
  const f = await fixture(t, {
    internalExporter: async (table, rows, batch) => {
      exports.push({ table, rows: structuredClone(rows), batch });
      if (fail) throw Error("fixture outage");
    },
  });
  const event = {
    id: "event-1",
    time: at.toISOString(),
    severity: "INFO",
    event: "started",
    body: "Agent started",
  };
  await node(f, "node", "default", {
    runtime_events: [event],
    queue_batches: 3,
    control_interval_seconds: 45,
    collectors_status: { cpu: "ok", file_logs: "permission denied" },
  });
  await node(f, "node", "default", {
    runtime_events: [event],
    queue_batches: 3,
    control_interval_seconds: 45,
    collectors_status: { cpu: "ok", file_logs: "permission denied" },
  });
  assert.equal(
    f.db.get<any>("SELECT count(*) AS n FROM agent_runtime_events").n,
    1,
  );
  await assert.rejects(f.module.publishTelemetry(), /outage/);
  assert.equal(
    f.db.get<any>("SELECT count(*) AS n FROM agent_runtime_events").n,
    1,
  );
  fail = false;
  await f.module.publishTelemetry();
  assert.equal(
    f.db.get<any>("SELECT count(*) AS n FROM agent_runtime_events").n,
    0,
  );
  const metrics = exports.find((v) => v.rows[0].kind === "metric").rows;
  assert.equal(
    metrics.find((m: any) => m.row.name === "lightmoni.agent.collector_errors")
      .row.value,
    1,
  );
  assert.equal(metrics[0].row.attributes.heartbeat_timeout_seconds, "135");
  const logs = exports.find((v) => v.rows[0].kind === "log").rows;
  assert.equal(logs[0].row.severity_number, 9);
  assert.equal(
    logs[0].row.event_id,
    "fd062a5a170c90199a296467a83f05186080b59cb78edcd75f21f442d9176d17",
  );
  const count = exports.length;
  await f.module.publishTelemetry();
  assert.equal(exports.length, count);
  const bad = await f.request(
    "/agents/node/heartbeat",
    "POST",
    {
      runtime_events: [
        { ...event, id: "future", time: "2030-01-01T00:00:00Z" },
      ],
    },
    true,
  );
  assert.equal(bad.status, 503);
  assert.equal(
    f.db.get<any>("SELECT count(*) AS n FROM agent_runtime_events").n,
    0,
  );
});
test("telemetry exporters do not overlap and graceful close aborts and awaits pending work", async (t) => {
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let calls = 0;
  const f = await fixture(t, {
    internalExporter: async (_table, _rows, _batch, signal) => {
      calls++;
      entered();
      await Promise.race([
        pending,
        new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    },
  });
  await node(f, "n", "default");
  const one = f.module.publishTelemetry(),
    two = f.module.publishTelemetry();
  await started;
  assert.equal(one, two);
  assert.equal(calls, 1);
  await f.module.close?.();
  release();
  await one;
});
// Golden digests produced with Go encoding/json over the original RemoteConfig,
// agentTask and nodeTaskLabel struct definitions; no Go executable is used here.
test("configuration revisions match legacy Go JSON field order, omissions and HTML escaping", () => {
  const db = new DB(":memory:");
  try {
    const store = new NodeStore(db, () => at);
    assert.equal(
      store.compile([], "default").config.revision,
      "a0bad55f72a6814061c1582aa87fcc872996844c8784b0fbbfb94b1c16535692",
    );
    store.label("生产&<客户>", "a", true);
    store.task(
      {
        name: "指标&<用户>",
        type: "host",
        enabled: true,
        label_ids: ["a"],
        config: host,
      },
      "host1",
      true,
    );
    assert.equal(
      store.compile(["a"], "a").config.revision,
      "518f4f1a211076dc494b25172855dcdcad836aa003c02088b2d9d85e1144aeb9",
    );
  } finally {
    db.close();
  }
});
