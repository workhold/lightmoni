import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { cipher } from "../src/shared/crypto.js";
import { Router, fail } from "../src/shared/http.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { registerOperationsPlatform } from "../src/ops/index.js";
import { catalogInstallation } from "../src/ops/catalog.js";
import type { Dependencies } from "../src/shared/types.js";
async function fixture(t: any, fetcher?: typeof fetch) {
  const db = new DB(":memory:");
  db.exec(
    `CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','admin',1),('member','member',1);CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);INSERT INTO agents VALUES('a','ha','A','1','linux','amd64','2026-10-29T02:00:00.000Z','default','{}'),('b','hb','B','1','linux','amd64','2026-10-29T02:00:00.000Z','default','{}');CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT,address TEXT,agent_id TEXT);INSERT INTO managed_machines VALUES('ma','Machine A','10.0.0.1','a'),('mb','Machine B','10.0.0.2','b');`,
  );
  let now = new Date("2026-10-29T02:00:00Z");
  const router = new Router();
  const deps = {
    db,
    router,
    ...cipher(Buffer.alloc(32, 12)),
    now: () => now,
    logger: { error() {}, warn() {}, info() {} },
    auth: {
      requireAdmin(ctx: any) {
        if (ctx.user.role !== "admin") fail(403, "administrator_required");
      },
      user(req: any) {
        return {
          id: req.headers["x-role"] ?? "admin",
          role: req.headers["x-role"] ?? "admin",
        };
      },
    },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const jobs = registerAgentJobs(deps, {
      agentCredentials: { has: () => true } as any,
    }),
    platform = registerOperationsPlatform(deps, {
      jobs,
      dataDir: "/tmp/cluster-tests",
      fetch: fetcher,
      intervalMs: 1000000,
    }),
    store = platform.store;
  const server = createServer((req, res) => void router.handle(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const req = async (
    path: string,
    method = "GET",
    body?: any,
    role = "admin",
  ) => {
    const r = await fetch(base + "/api/v1/ops" + path, {
      method,
      headers: { "content-type": "application/json", "x-role": role },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const createCluster = (ids = ["ma", "mb"], name = "Cluster") =>
    store.create(
      "cluster",
      name,
      {
        machine_ids: ids,
        port_start: 21000,
        port_end: 21020,
        nodes: ids.map((id, n) => ({
          machine_id: id,
          address: "10.0.0." + ({ ma: 1, mb: 2, mc: 3 }[id] ?? n + 1),
          public_address: "203.0.113." + ({ ma: 1, mb: 2, mc: 3 }[id] ?? n + 1),
          cpu: 4,
          memory_mb: 4096,
        })),
      },
      "admin",
    );
  const app = (c: any, overrides: any = {}) =>
    store.create(
      "application",
      "Same name",
      {
        deployments: overrides.deployments ?? [
          {
            cluster_id: c.id,
            machine_ids: overrides.machine_ids ?? ["ma"],
            replicas: overrides.replicas ?? 1,
            cpu: overrides.cpu ?? 0.25,
            memory_mb: overrides.memory_mb ?? 128,
          },
        ],
        source: { type: "custom" },
        deployment_mode: "manual",
        machine_ids: ["ma"],
        role: "generic",
        mode: "container",
        image: "example:1",
        mounts: [],
        ports: [
          {
            name: "http",
            container_port: 8080,
            host_port: 0,
            protocol: "tcp",
            app_protocol: "http",
          },
          {
            name: "admin",
            container_port: 9090,
            host_port: 0,
            protocol: "tcp",
            app_protocol: "http",
          },
        ],
        cpu: 0.25,
        memory_mb: 128,
        ...overrides,
      },
      "admin",
    );
  const action = (r: any, name: string, input: any = {}) =>
    req("/resources/" + r.id + "/actions", "POST", {
      revision: r.revision,
      confirmed: true,
      action: name,
      input,
    });
  const finish = (
    agentID: string,
    data: any = {
      healthy: true,
      running: true,
      containers: [{ running: true }],
    },
    state = "succeeded",
  ) => {
    const job = jobs.claim(agentID, ["operations.platform"]);
    assert.ok(job);
    const payload = platform.resolvePayload(job);
    for (const [n, phase] of [
      "accepted",
      "staging",
      "activating",
      "verifying",
    ].entries())
      jobs.event(agentID, job.id, {
        lease_id: job.lease_id,
        sequence: n + 1,
        phase,
        summary: "test",
      });
    jobs.result(agentID, job.id, {
      lease_id: job.lease_id,
      state,
      ...(data.code ? { code: data.code } : {}),
      summary: "test",
      snapshot: {
        health: { healthy: state === "succeeded" },
        operations: {
          operation_id: payload.operation_id,
          resource_id: payload.resource.id,
          data,
        },
      },
    });
    return { job, payload };
  };
  t.after(async () => {
    await platform.close();
    jobs.close?.();
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return {
    db,
    deps,
    store,
    platform,
    jobs,
    req,
    createCluster,
    app,
    action,
    finish,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    heartbeat(id: string) {
      db.run("UPDATE agents SET last_seen=? WHERE id=?", now.toISOString(), id);
    },
  };
}
test("stable membership is unique, survives Agent identity changes and rejects moving active machines", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  assert.throws(
    () => f.createCluster(["ma"], "Other"),
    /machine_already_in_cluster/,
  );
  f.db.run("UPDATE managed_machines SET agent_id='b' WHERE id='ma'");
  assert.equal(
    f.db.get<any>(
      "SELECT cluster_id FROM ops_platform_cluster_members WHERE machine_id='ma'",
    )!.cluster_id,
    c.id,
  );
  f.db.run("UPDATE managed_machines SET agent_id='a' WHERE id='ma'");
  const a = f.app(c);
  assert.equal((await f.action(a, "deploy")).status, 202);
  assert.throws(
    () =>
      f.store.update(
        c.id,
        1,
        c.name,
        {
          ...c.spec,
          machine_ids: ["mb"],
          nodes: c.spec.nodes.filter((n: any) => n.machine_id === "mb"),
        },
        "admin",
      ),
    /cluster_machine_in_use/,
  );
  assert.throws(() => f.store.remove(c.id, 1), /in_use|not_empty/);
});
test("duplicate display names use unique immutable transactional service identities", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(),
    a = f.app(c),
    b = f.app(c);
  assert.equal(a.name, b.name);
  assert.equal(a.spec.service_name, "app-1");
  assert.equal(b.spec.service_name, "app-2");
  assert.throws(
    () => f.app(c, { service_name: a.spec.service_name }),
    /service_name_conflict/,
  );
  assert.throws(
    () => f.app(c, { service_name: "中文" }),
    /invalid_service_name/,
  );
  assert.throws(
    () =>
      f.store.update(
        a.id,
        1,
        "Rename",
        { ...a.spec, service_name: "changed" },
        "admin",
      ),
    /service_name_immutable/,
  );
  assert.equal(
    f.db.all("SELECT * FROM ops_platform_application_keys").length,
    2,
  );
});
test("named ports reserve atomically and matching verified receipts publish fresh endpoints", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(),
    a = f.app(c);
  assert.equal((await f.action(a, "deploy")).status, 202);
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 2);
  assert.equal(
    (await f.req("/resources/" + a.id + "/endpoints?cluster_id=" + c.id)).body
      .endpoints.length,
    0,
  );
  const { payload } = f.finish("a");
  assert.equal(payload.resource.config.application.ports.length, 2);
  const found = await f.req(
    "/resources/" + a.id + "/endpoints?cluster_id=" + c.id + "&port_name=admin",
  );
  assert.equal(found.body.endpoints.length, 1);
  assert.equal(found.body.endpoints[0].machine_id, "ma");
  const b = f.app(c, {
    ports: [
      { name: "one", container_port: 1, host_port: 22000 },
      { name: "two", container_port: 2, host_port: 21000 },
    ],
  });
  assert.equal((await f.action(b, "deploy")).status, 409);
  assert.equal(
    f.db.all("SELECT * FROM ops_cluster_instances WHERE owner_id=?", b.id)
      .length,
    0,
  );
  assert.equal(
    f.db.all("SELECT * FROM ops_platform_ports WHERE port=22000").length,
    0,
  );
  assert.equal(f.store.actions(b.id).length, 0);
  f.advance(121000);
  assert.equal(
    (await f.req("/resources/" + a.id + "/endpoints?cluster_id=" + c.id)).body
      .endpoints.length,
    0,
  );
});
test("manual nodes stay fixed while managed offline replicas retire and move to a healthy machine", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(),
    manual = f.app(c);
  await f.action(manual, "deploy");
  f.finish("a");
  const managed = f.app(c, {
    deployment_mode: "managed",
    machine_ids: [],
    replicas: 1,
  });
  await f.action(managed, "deploy");
  f.finish("a");
  f.advance(121000);
  f.heartbeat("b");
  await f.platform.tick();
  const active = f.db.all<any>(
    "SELECT * FROM ops_cluster_instances WHERE owner_id=? AND retired=0",
    managed.id,
  );
  assert.equal(active.length, 1);
  assert.equal(active[0].machine_id, "mb");
  assert.equal(
    f.db.all(
      "SELECT * FROM ops_cluster_instances WHERE owner_id=? AND retired=1",
      managed.id,
    ).length,
    1,
  );
  assert.equal(
    f.db.all("SELECT * FROM ops_cluster_instances WHERE owner_id=?", manual.id)
      .length,
    1,
  );
  assert.equal(
    f.store.actions(manual.id).filter((r) => r.action === "apply").length,
    1,
  );
  f.finish("b");
  assert.equal(
    (await f.req("/resources/" + managed.id + "/endpoints?cluster_id=" + c.id))
      .body.endpoints.length,
    2,
  );
  f.heartbeat("a");
  await f.platform.tick();
  assert.equal(
    f.store.actions(managed.id).some((r) => r.action === "stop"),
    true,
  );
});
test("unknown execution keeps port ownership and never creates a duplicate managed attempt", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(),
    a = f.app(c, { deployment_mode: "managed", machine_ids: [], replicas: 1 });
  await f.action(a, "deploy");
  f.finish("a", {}, "unknown");
  f.advance(121000);
  f.heartbeat("b");
  await f.platform.tick();
  assert.equal(
    f.db.all("SELECT * FROM ops_cluster_instances WHERE owner_id=?", a.id)
      .length,
    1,
  );
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 2);
  assert.equal(
    (await f.req("/resources/" + a.id + "/endpoints?cluster_id=" + c.id)).body
      .endpoints.length,
    0,
  );
});
test("catalog installs multiple ordinary MySQL applications with healthcheck and redacts secrets", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  assert.equal((await f.req("/catalog")).body.templates.length, 3);
  for (let n = 0; n < 2; n++) {
    const r = await f.req("/catalog/mysql/install", "POST", {
      deployments: [{ cluster_id: c.id, machine_ids: ["ma"] }],
      parameters: { password: "private-root", user_password: "private-user" },
    });
    assert.equal(r.status, 201, JSON.stringify(r));
    assert.equal(r.body.resource.name, "MySQL");
    assert.ok(r.body.resource.spec.compose.services.mysql.healthcheck);
    assert.equal(JSON.stringify(r).includes("private-root"), false);
    assert.equal(JSON.stringify(r).includes("private-user"), false);
  }
  assert.equal(
    f.db.all(
      "SELECT * FROM ops_platform_application_keys WHERE service_name LIKE 'mysql-%'",
    ).length,
    2,
  );
  assert.equal(
    (
      await f.req("/catalog/mysql/install", "POST", {
        deployments: [{ cluster_id: c.id, machine_ids: ["ma"] }],
        version: "invalid",
        parameters: { password: "x", user_password: "y" },
      })
    ).status,
    400,
  );
});
test("OpenResty singleton and website application references enforce cluster and named-port boundaries", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(["ma"]),
    other = f.createCluster(["mb"], "Other");
  const open = f.store.create(
    "application",
    "OpenResty",
    catalogInstallation("openresty", {
      deployments: [{ cluster_id: c.id, machine_ids: ["ma"] }],
    }).spec,
    "admin",
  );
  assert.throws(
    () =>
      f.store.create(
        "application",
        "Another",
        catalogInstallation("openresty", {
          deployments: [{ cluster_id: c.id, machine_ids: ["ma"] }],
        }).spec,
        "admin",
      ),
    /openresty_already_installed/,
  );
  const a = f.app(c),
    b = f.app(other, { machine_ids: ["mb"] });
  const website = (app: any, port = "http") => ({
    cluster_ids: [c.id],
    bindings: [
      {
        domains: ["api.example.test"],
        locations: [
          {
            path: "/",
            cluster_targets: [
              {
                cluster_id: c.id,
                target: "application",
                application_id: app.id,
                port_name: port,
              },
            ],
          },
        ],
      },
    ],
  });
  assert.throws(
    () => f.store.create("website", "Bad", website(b), "admin"),
    /application_not_deployed_in_cluster/,
  );
  assert.throws(
    () => f.store.create("website", "Bad", website(a, "absent"), "admin"),
    /application_port_not_found/,
  );
  const site = f.store.create("website", "API", website(a), "admin");
  assert.deepEqual(site.spec.cluster_ids, [c.id]);
  assert.throws(
    () =>
      f.store.update(
        a.id,
        1,
        a.name,
        {
          ...a.spec,
          ports: a.spec.ports.filter((p: any) => p.name !== "http"),
        },
        "admin",
      ),
    /application_port_in_use/,
  );
  assert.equal(
    (await f.action(site, "deploy")).body.pending,
    "openresty_application_not_deployed",
  );
  await f.action(open, "deploy");
  f.finish("a", { healthy: true, running: true, digest: "first" });
  await f.action(a, "deploy");
  f.finish("a");
  assert.equal((await f.action(site, "deploy")).status, 202);
  const result = f.finish("a", {
    healthy: true,
    running: true,
    digest: "website",
  });
  assert.equal(
    result.payload.resource.config.sites[0].locations[0].upstreams.length,
    1,
  );
  assert.equal(f.store.get(site.id).status.active, true);
});
test("HTTP returns stable machines and scoped resources, denies member access and new legacy resources", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  f.app(c);
  const view = await f.req("/overview");
  assert.equal(view.body.machines[0].id, "ma");
  assert.equal(view.body.machines[0].cluster_id, c.id);
  assert.equal(view.body.capabilities.kinds.includes("gateway_group"), false);
  for (const kind of ["service", "node_pool", "gateway_group"])
    assert.equal(
      (await f.req("/resources", "POST", { kind, name: "Legacy", spec: {} }))
        .status,
      400,
    );
  assert.equal(
    (
      await f.req("/resources", "POST", {
        kind: "application",
        name: "No cluster",
        spec: { mode: "container", image: "a" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.req("/catalog", "GET", undefined, "member")).status,
    403,
  );
  assert.equal(
    (await f.req("/resources?cluster_id=" + c.id)).body.resources.length,
    2,
  );
});
test("catalog role cannot bypass OpenResty uniqueness and historical unscoped apps cannot deploy through HTTP", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  assert.throws(
    () =>
      f.app(c, {
        source: { type: "store", template_id: "openresty" },
        role: "generic",
      }),
    /template_role_mismatch/,
  );
  assert.throws(
    () =>
      f.app(c, {
        image: "openresty/openresty:1.27.1.2-0-alpine",
        role: "generic",
      }),
    /openresty_role_required/,
  );
  const legacy = f.store.create(
    "application",
    "Historic",
    { mode: "container", image: "nginx:1", agent_ids: ["a"] },
    "admin",
  );
  assert.equal((await f.action(legacy, "deploy")).status, 409);
  assert.equal(f.store.actions(legacy.id).length, 0);
  assert.equal(
    (
      await f.req("/catalog/redis/install", "POST", {
        confirmed: "true",
        deployments: [{ cluster_id: c.id, machine_ids: ["ma"] }],
        parameters: { password: "secret" },
      })
    ).status,
    400,
  );
});
test("managed rolling update waits for preceding replica receipt across reconciliation ticks", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(),
    a = f.app(c, { deployment_mode: "managed", machine_ids: [], replicas: 2 });
  assert.equal((await f.action(a, "deploy")).status, 202);
  f.finish("a");
  f.finish("b");
  const changed = f.store.update(
    a.id,
    1,
    a.name,
    { ...a.spec, image: "example:2" },
    "admin",
  );
  assert.equal((await f.action(changed, "deploy")).body.runs.length, 1);
  await f.platform.tick();
  assert.equal(
    f.store.actions(a.id).filter((r) => r.action === "apply").length,
    3,
  );
  f.finish("a");
  await f.platform.tick();
  assert.equal(
    f.store.actions(a.id).filter((r) => r.action === "apply").length,
    4,
  );
  f.finish("b");
  assert.equal(
    (
      await f.req("/resources/" + a.id + "/endpoints?cluster_id=" + c.id)
    ).body.endpoints.every((e: any) => e.version === "2"),
    true,
  );
});
test("offline stop persists intent and executes after the original machine reconnects", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(),
    a = f.app(c);
  await f.action(a, "deploy");
  f.finish("a");
  f.advance(121000);
  assert.equal((await f.action(f.store.get(a.id), "stop")).body.runs.length, 0);
  assert.equal(
    f.db.get<any>(
      "SELECT desired_state FROM ops_cluster_instances WHERE owner_id=?",
      a.id,
    )!.desired_state,
    "stopped",
  );
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 2);
  f.heartbeat("a");
  await f.platform.tick();
  const { payload } = f.finish("a", {
    healthy: false,
    running: false,
    stopped: true,
  });
  assert.equal(payload.resource.config.task, "workload.stop");
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 0);
});
test("many multiport receipts keep status summaries bounded without rolling back receipt acceptance", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  const expanded = f.store.update(
    c.id,
    1,
    c.name,
    { ...c.spec, port_end: 26000 },
    "admin",
  );
  const a = f.app(expanded, {
    deployment_mode: "managed",
    machine_ids: [],
    replicas: 15,
    cpu: 0.01,
    memory_mb: 4,
    ports: Array.from({ length: 64 }, (_, n) => ({
      name: "port-" + n,
      container_port: 8000 + n,
      host_port: 0,
      protocol: "tcp",
    })),
  });
  assert.equal((await f.action(a, "deploy")).status, 202);
  for (let n = 0; n < 15; n++) f.finish(n % 2 === 0 ? "a" : "b");
  const status = f.store.get(a.id).status;
  assert.equal(status.instances_total, 15);
  assert.equal(status.instances_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) < 128 * 1024);
  assert.equal(
    f.db.all(
      "SELECT id FROM ops_platform_runs WHERE resource_id=? AND state='succeeded'",
      a.id,
    ).length,
    15,
  );
});
test("catalog reports a saved application separately from failed deployment so a retry can reuse it", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  f.advance(121000);
  const r = await f.req("/catalog/redis/install", "POST", {
    deployments: [{ cluster_id: c.id, machine_ids: ["ma"] }],
    parameters: { password: "private-password" },
    confirmed: true,
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.deployment_error.endsWith("target_agent_offline"));
  assert.ok(r.body.resource.id);
  assert.equal(
    r.body.resource.status.deployments[c.id].last_error,
    "target_agent_offline",
  );
  assert.equal(r.body.runs.length, 0);
  assert.equal(f.store.list("application").length, 1);
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 0);
  assert.equal(JSON.stringify(r).includes("private-password"), false);
});
test("one service identity freezes independent cluster revisions, resources and endpoint namespaces", async (t) => {
  const f = await fixture(t),
    a = f.createCluster(["ma"], "A"),
    b = f.createCluster(["mb"], "B");
  const app = f.app(a, {
    deployments: [
      { cluster_id: a.id, machine_ids: ["ma"], cpu: 0.5, memory_mb: 128 },
      { cluster_id: b.id, machine_ids: ["mb"], cpu: 1.5, memory_mb: 512 },
    ],
  });
  await f.action(app, "deploy", { cluster_id: a.id });
  const first = f.finish("a").payload;
  assert.equal(first.resource.config.cluster_id, a.id);
  assert.equal(first.resource.config.application.cpu, 0.5);
  assert.equal(
    f.store.get(app.id).status.deployments[b.id].desired_revision,
    0,
  );
  const next = f.store.update(
    app.id,
    1,
    app.name,
    { ...app.spec, image: "example:2" },
    "admin",
  );
  await f.action(next, "deploy", { cluster_id: b.id });
  const second = f.finish("b").payload;
  assert.equal(second.resource.config.application.image, "example:2");
  assert.equal(second.resource.config.application.cpu, 1.5);
  assert.equal(second.resource.config.cluster_id, b.id);
  assert.equal(
    f.store.get(app.id).status.deployments[a.id].desired_revision,
    1,
  );
  assert.equal(
    f.store.get(app.id).status.deployments[b.id].desired_revision,
    2,
  );
  await f.platform.tick();
  assert.equal(
    f.store.actions(app.id).filter((r) => r.action === "apply").length,
    2,
  );
  assert.equal(
    (await f.req("/resources/" + app.id + "/endpoints")).status,
    400,
  );
  const ea = (
      await f.req("/resources/" + app.id + "/endpoints?cluster_id=" + a.id)
    ).body.endpoints,
    eb = (await f.req("/resources/" + app.id + "/endpoints?cluster_id=" + b.id))
      .body.endpoints;
  assert.ok(ea.every((e: any) => e.cluster_id === a.id && e.version === "1"));
  assert.ok(eb.every((e: any) => e.cluster_id === b.id && e.version === "2"));
  assert.equal(
    (await f.req("/resources?cluster_id=" + b.id)).body.resources.some(
      (r: any) => r.id === app.id,
    ),
    true,
  );
  const scope = {
    cluster_ids: [a.id, b.id],
    bindings: [
      {
        domains: ["global.example.test"],
        locations: [
          {
            path: "/",
            proxy_read_timeout: 45,
            cluster_targets: [
              {
                cluster_id: a.id,
                target: "application",
                application_id: app.id,
                port_name: "http",
              },
              {
                cluster_id: b.id,
                target: "application",
                application_id: app.id,
                port_name: "admin",
              },
            ],
          },
        ],
      },
    ],
  };
  const site = f.store.create("website", "Global", scope, "admin");
  const ca = await f.req("/resources/" + site.id + "/nginx?cluster_id=" + a.id),
    cb = await f.req("/resources/" + site.id + "/nginx?cluster_id=" + b.id);
  assert.equal(ca.status, 200);
  assert.ok(ca.body.config.includes("10.0.0.1"));
  assert.ok(!ca.body.config.includes("10.0.0.2"));
  assert.ok(cb.body.config.includes("10.0.0.2"));
  assert.ok(!cb.body.config.includes("10.0.0.1"));
  assert.throws(
    () =>
      f.store.update(
        app.id,
        2,
        app.name,
        { ...next.spec, deployments: [next.spec.deployments[0]] },
        "admin",
      ),
    /application_deployment_in_use/,
  );
  const invalid = structuredClone(scope);
  invalid.bindings[0].locations[0].cluster_targets[1].proxy_read_timeout = 9;
  assert.throws(
    () => f.store.create("website", "Invalid", invalid, "admin"),
    /website_cluster_override_not_supported/,
  );
  const single = f.app(a);
  const missing = structuredClone(scope);
  missing.bindings[0].locations[0].cluster_targets[1].application_id =
    single.id;
  assert.throws(
    () => f.store.create("website", "Missing", missing, "admin"),
    /application_not_deployed_in_cluster/,
  );
});
test("managed fixed-port scheduling skips known conflicts and retries another node after a real-agent conflict receipt", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(),
    block = f.app(c, {
      ports: [{ name: "fixed", container_port: 9000, host_port: 24000 }],
    });
  await f.action(block, "deploy");
  f.finish("a");
  const a = f.app(c, {
    deployment_mode: "managed",
    machine_ids: [],
    replicas: 1,
    ports: [
      {
        name: "http",
        container_port: 8080,
        host_port: 24000,
        app_protocol: "http",
      },
    ],
  });
  await f.action(a, "deploy");
  const p = f.finish("b").payload;
  assert.equal(p.resource.config.application.ports[0].host_port, 24000);
  const open = f.store.create(
    "application",
    "Entry",
    catalogInstallation("openresty", {
      deployment_mode: "managed",
      deployments: [{ cluster_id: c.id, replicas: 1 }],
    }).spec,
    "admin",
  );
  await f.action(open, "deploy");
  f.finish("a", { code: "HOST_PORT_OCCUPIED" }, "failed");
  await f.platform.tick();
  assert.equal(
    f.db.get<any>(
      "SELECT agent_id FROM ops_cluster_instances WHERE owner_id=? AND retired=0",
      open.id,
    )!.agent_id,
    "b",
  );
  const moved = f.finish("b").payload;
  assert.equal(moved.resource.config.http_port, 80);
  assert.equal(moved.resource.config.https_port, 443);
  assert.equal(moved.resource.config.cluster_id, c.id);
  assert.ok(
    f.db.get(
      "SELECT port FROM ops_platform_node_conflicts WHERE agent_id='a' AND port=80",
    ),
  );
});
test("website DNS aggregates all ready cluster gateways and follows managed failover without deleting external records", async (t) => {
  let records: any[] = [
      {
        RecordId: "external",
        RR: "manual",
        Type: "A",
        Value: "198.51.100.8",
        TTL: 600,
        Status: "ENABLE",
      },
    ],
    sequence = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const data = Object.fromEntries(
      new URLSearchParams(String(init?.body ?? new URL(String(input)).search)),
    );
    let body: any = {};
    if (data.Action === "DescribeDomainRecords")
      body = { TotalCount: records.length, DomainRecords: { Record: records } };
    else if (data.Action === "AddDomainRecord") {
      const RecordId = String(++sequence);
      records.push({
        RecordId,
        RR: data.RR,
        Type: data.Type,
        Value: data.Value,
        TTL: Number(data.TTL),
        Status: "ENABLE",
      });
      body = { RecordId };
    } else if (data.Action === "DeleteDomainRecord")
      records = records.filter((r) => r.RecordId !== data.RecordId);
    else throw Error("unexpected mocked DNS action");
    return new Response(JSON.stringify(body));
  };
  const f = await fixture(t, fetcher);
  f.db.exec(
    "INSERT INTO agents SELECT 'c','hc','C',version,platform,arch,last_seen,group_id,heartbeat FROM agents WHERE id='a';INSERT INTO managed_machines VALUES('mc','Machine C','10.0.0.3','c')",
  );
  const a = f.createCluster(["ma", "mc"], "A"),
    b = f.createCluster(["mb"], "B"),
    entry = f.store.create(
      "application",
      "Entry",
      catalogInstallation("openresty", {
        deployment_mode: "managed",
        deployments: [
          { cluster_id: a.id, replicas: 1 },
          { cluster_id: b.id, replicas: 1 },
        ],
      }).spec,
      "admin",
    );
  await f.action(entry, "deploy");
  f.finish("a", { healthy: true, running: true, digest: "a" });
  f.finish("b", { healthy: true, running: true, digest: "b" });
  const credential = f.store.create(
      "credential",
      "DNS",
      {
        provider: "aliyun",
        access_key_id: "fixture",
        access_key_secret: "private-fixture",
      },
      "admin",
    ),
    zone = f.store.create(
      "dns_zone",
      "Zone",
      { domain: "example.test", credential_id: credential.id },
      "admin",
    );
  const site = f.store.create(
    "website",
    "Global DNS",
    {
      cluster_ids: [a.id, b.id],
      bindings: [
        {
          domains: ["global.example.test"],
          dns_zone_id: zone.id,
          dns_enabled: true,
          locations: [
            {
              path: "/",
              action: "return",
              return_status: 200,
              return_value: "hello",
            },
          ],
        },
      ],
    },
    "admin",
  );
  await f.action(site, "deploy");
  f.finish("a", { healthy: true, running: true, digest: "site-a" });
  f.finish("b", { healthy: true, running: true, digest: "site-b" });
  const settle = async () => {
    for (let n = 0; n < 15; n++)
      await new Promise<void>((r) => setImmediate(r));
  };
  await f.platform.tick();
  await settle();
  assert.deepEqual(
    records
      .filter((r) => r.RR === "global")
      .map((r) => r.Value)
      .sort(),
    ["203.0.113.1", "203.0.113.2"],
  );
  const changed = f.store.update(
    site.id,
    site.revision,
    site.name,
    { ...site.spec, nginx: { ...site.spec.nginx, gzip: true } },
    "admin",
  );
  await f.action(changed, "deploy");
  await f.platform.tick();
  await settle();
  assert.deepEqual(
    records
      .filter((r) => r.RR === "global")
      .map((r) => r.Value)
      .sort(),
    ["203.0.113.1", "203.0.113.2"],
    "queued reload keeps the last verified DNS leases",
  );
  f.finish("a", { healthy: true, running: true, digest: "updated-a" });
  f.finish("b", { healthy: true, running: true, digest: "updated-b" });
  f.advance(121000);
  f.heartbeat("b");
  f.heartbeat("c");
  await f.platform.tick();
  f.finish("b");
  f.finish("c", { healthy: true, running: true, digest: "site-c" });
  await settle();
  await f.platform.tick();
  await settle();
  assert.deepEqual(
    records
      .filter((r) => r.RR === "global")
      .map((r) => r.Value)
      .sort(),
    ["203.0.113.2", "203.0.113.3"],
  );
  assert.ok(records.some((r) => r.RecordId === "external"));
  assert.ok(
    f.db.get(
      "SELECT port FROM ops_platform_ports WHERE agent_id='a' AND port=80",
    ),
  );
  assert.equal(f.store.get(site.id).status.deployments[a.id].active, true);
  assert.equal(f.store.get(site.id).status.deployments[b.id].active, true);
});
test("single-cluster 042 state normalizes in place without changing instances, storage identity or creating jobs", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(["ma"]),
    app = f.app(c, { environment: { PASSWORD: "migration-secret" } });
  await f.action(app, "deploy");
  f.finish("a");
  const instance = f.db.get<any>(
      "SELECT id FROM ops_cluster_instances WHERE owner_id=?",
      app.id,
    )!.id,
    old = { ...app.spec, ...app.spec.deployments[0] };
  delete old.deployments;
  f.db.run(
    "UPDATE ops_platform_resources SET spec_cipher=?,status_json=? WHERE id=?",
    f.deps.encrypt(JSON.stringify(old)),
    JSON.stringify({
      desired_revision: 1,
      enabled: true,
      policy_actor: "admin",
    }),
    app.id,
  );
  f.db.run(
    "UPDATE ops_platform_revisions SET spec_cipher=? WHERE resource_id=? AND revision=1",
    f.deps.encrypt(JSON.stringify(old)),
    app.id,
  );
  f.db.run(
    "UPDATE ops_cluster_instances SET cluster_id='' WHERE owner_id=?",
    app.id,
  );
  f.db.run(
    "DELETE FROM ops_platform_application_deployments WHERE application_id=?",
    app.id,
  );
  const count = f.store.actions(app.id).length;
  await f.platform.close();
  const router = new Router(),
    deps = { ...f.deps, router } as Dependencies;
  router.auth = deps.auth;
  const migrated = registerOperationsPlatform(deps, {
    jobs: f.jobs,
    dataDir: "/tmp/cluster-migration",
    intervalMs: 1000000,
  });
  try {
    const read = migrated.store.get(app.id);
    assert.equal(read.id, app.id);
    assert.equal(read.spec.deployments[0].cluster_id, c.id);
    assert.equal(read.spec.cluster_id, undefined);
    assert.equal(migrated.store.actions(app.id).length, count);
    assert.equal(
      f.db.get<any>(
        "SELECT id,cluster_id FROM ops_cluster_instances WHERE owner_id=?",
        app.id,
      )!.id,
      instance,
    );
    assert.equal(
      f.db.get<any>(
        "SELECT cluster_id FROM ops_cluster_instances WHERE id=?",
        instance,
      )!.cluster_id,
      c.id,
    );
    assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 2);
    assert.equal(
      JSON.stringify(migrated.store.public(read)).includes("migration-secret"),
      false,
    );
  } finally {
    await migrated.close();
  }
});
test("leases for one logical application remain bound to the correct cluster Agent and hide private configuration", async (t) => {
  const f = await fixture(t),
    a = f.createCluster(["ma"], "A"),
    b = f.createCluster(["mb"], "B");
  const app = f.app(a, {
    environment: { PASSWORD: "private-lease-value" },
    deployments: [
      { cluster_id: a.id, machine_ids: ["ma"] },
      { cluster_id: b.id, machine_ids: ["mb"] },
    ],
  });
  await f.action(app, "deploy");
  const ja = f.jobs.claim("a", ["operations.platform"])!,
    jb = f.jobs.claim("b", ["operations.platform"])!;
  assert.equal(f.platform.resolvePayload(ja).resource.config.cluster_id, a.id);
  assert.equal(f.platform.resolvePayload(jb).resource.config.cluster_id, b.id);
  assert.equal(JSON.stringify(ja).includes("private-lease-value"), false);
  assert.equal(JSON.stringify(jb).includes("private-lease-value"), false);
  assert.throws(
    () => f.platform.resolvePayload({ ...ja, agent_id: "b" }),
    /authorization|mismatch/,
  );
  assert.throws(() =>
    f.jobs.event("a", jb.id, {
      lease_id: jb.lease_id,
      sequence: 1,
      phase: "accepted",
      summary: "wrong cluster",
    }),
  );
  assert.equal(
    f.db.get<any>(
      "SELECT healthy FROM ops_cluster_instances WHERE owner_id=? AND cluster_id=?",
      app.id,
      b.id,
    )!.healthy,
    0,
  );
});
