import { test } from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { cipher } from "../src/shared/crypto.js";
import { Router } from "../src/shared/http.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { OperationsPlatformStore } from "../src/ops/store.js";
import { createWorkloadController } from "../src/ops/workloads.js";
import type { Dependencies } from "../src/shared/types.js";

function setup(t: any, fetcher?: typeof fetch) {
  const db = new DB(":memory:");
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','admin',1);CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT,heartbeat TEXT);INSERT INTO agents VALUES('node-a','2026-10-29T02:00:00.000Z','{}'),('node-b','2026-10-29T02:00:00.000Z','{}')",
  );
  let now = new Date("2026-10-29T02:00:00Z");
  const deps = {
      db,
      router: new Router(),
      ...cipher(Buffer.alloc(32, 8)),
      now: () => now,
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as Dependencies,
    jobs = registerAgentJobs(deps),
    store = new OperationsPlatformStore(deps, jobs),
    controller = createWorkloadController({
      store,
      deps,
      dataDir: "/tmp/platform-test",
      fetch: fetcher,
    });
  t.after(async () => {
    await controller.close?.();
    await store.close();
    jobs.close?.();
    db.close();
  });
  const pool = () =>
    store.create(
      "node_pool",
      "Pool",
      {
        agent_ids: ["node-a", "node-b"],
        port_start: 21000,
        port_end: 21001,
        nodes: [
          { agent_id: "node-a", address: "10.1.0.1", cpu: 2, memory_mb: 2048 },
          { agent_id: "node-b", address: "10.1.0.2", cpu: 2, memory_mb: 2048 },
        ],
      },
      "admin",
    );
  const app = () =>
    store.create(
      "application",
      "Application",
      {
        mode: "container",
        image: "nginx:1.30.6-alpine",
        environment: { PASSWORD: "private-test" },
        mounts: [
          {
            type: "config",
            target: "/etc/app",
            files: { "settings.json": "{}" },
          },
        ],
      },
      "admin",
    );
  function finish(agentID: string, data: any, state = "succeeded") {
    const job = jobs.claim(agentID, ["operations.platform"]);
    assert.ok(job);
    const payload = store.resolvePayload(job);
    for (const [i, phase] of [
      "accepted",
      "staging",
      "activating",
      "verifying",
    ].entries())
      jobs.event(agentID, job.id, {
        lease_id: job.lease_id,
        sequence: i + 1,
        phase,
        summary: "test",
      });
    jobs.result(agentID, job.id, {
      lease_id: job.lease_id,
      state,
      summary: "fixture receipt",
      snapshot: {
        health: { healthy: state === "succeeded" },
        operations: {
          operation_id: payload.operation_id,
          resource_id: payload.resource.id,
          data,
        },
      },
    });
    return payload;
  }
  return {
    db,
    jobs,
    store,
    controller,
    pool,
    app,
    finish,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}
test("hosted replicas reserve distinct machine ports and publish only verified fresh endpoints", async (t) => {
  const f = setup(t),
    pool = f.pool(),
    app = f.app(),
    service = f.store.create(
      "service",
      "API",
      {
        application_id: app.id,
        node_pool_id: pool.id,
        replicas: 2,
        container_port: 8080,
        cpu: 1,
        memory_mb: 512,
      },
      "admin",
    );
  const deployment = await f.controller.perform(service, "deploy", {}, "admin");
  assert.equal(deployment.runs.length, 2);
  const rows = f.db.all<any>(
    "SELECT * FROM ops_platform_instances ORDER BY agent_id",
  );
  assert.deepEqual(
    rows.map((r) => r.agent_id),
    ["node-a", "node-b"],
  );
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 2);
  assert.deepEqual(f.store.get(service.id).status.endpoints, []);
  const p = f.finish("node-a", {
    healthy: true,
    containers: [{ running: true }],
    stats: [{ CPUPerc: "3%" }],
  });
  assert.equal(p.resource.config.application.ports[0].host_port, 21000);
  assert.equal(f.store.get(service.id).status.endpoints.length, 1);
  f.finish("node-b", { healthy: true, containers: [{ running: true }] });
  assert.equal(f.store.get(service.id).status.endpoints.length, 2);
  f.advance(121000);
  const endpoints = await f.controller.perform(
    f.store.get(service.id),
    "endpoints",
    {},
    "admin",
  );
  assert.equal(endpoints.result.endpoints.length, 0);
});
test("a removed node with a fresh heartbeat cannot receive a hosted service replica", async (t) => {
  const f = setup(t), pool = f.pool(), app = f.app();
  f.db.run("INSERT INTO agent_lifecycle(agent_id,state) VALUES('node-a','removed')");
  const service = f.store.create("service", "Active node only", {
    application_id: app.id, node_pool_id: pool.id, replicas: 1,
    container_port: 8080, cpu: 1, memory_mb: 512,
  }, "admin");
  const deployment = await f.controller.perform(service, "deploy", {}, "admin");
  assert.equal(deployment.runs.length, 1);
  assert.deepEqual(f.db.all<any>("SELECT agent_id FROM ops_platform_instances").map(row => row.agent_id), ["node-b"]);
  assert.equal(f.jobs.claim("node-b", ["operations.platform"])?.agent_id, "node-b");
});
test("unknown execution preserves port ownership and blocks automatic redeployment", async (t) => {
  const f = setup(t),
    pool = f.pool(),
    app = f.app(),
    service = f.store.create(
      "service",
      "API",
      {
        application_id: app.id,
        node_pool_id: pool.id,
        replicas: 1,
        container_port: 8080,
        cpu: 1,
        memory_mb: 512,
        stateful: true,
      },
      "admin",
    );
  await f.controller.perform(service, "deploy", {}, "admin");
  f.finish("node-a", {}, "unknown");
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 1);
  assert.equal(f.store.get(service.id).status.instances[0].state, "unknown");
  const before = f.store.actions().length;
  await f.controller.tick?.();
  assert.equal(
    f.store.actions().filter((r) => r.action === "deploy").length,
    1,
  );
  assert.equal(f.store.actions().length, before);
});
test("capacity and concurrent application host-port reservations reject conflicts without orphan jobs", async (t) => {
  const f = setup(t),
    a = f.store.create(
      "application",
      "First",
      {
        mode: "container",
        image: "nginx:1.30.6-alpine",
        agent_ids: ["node-a"],
        ports: [{ host_port: 22000, container_port: 80 }],
      },
      "admin",
    ),
    b = f.store.create(
      "application",
      "Second",
      {
        mode: "container",
        image: "nginx:1.30.6-alpine",
        agent_ids: ["node-a"],
        ports: [{ host_port: 22000, container_port: 80 }],
      },
      "admin",
    );
  await f.controller.perform(a, "deploy", {}, "admin");
  await assert.rejects(
    f.controller.perform(b, "deploy", {}, "admin"),
    /reserved/,
  );
  assert.equal(f.db.all("SELECT * FROM ops_platform_instances").length, 1);
  assert.equal(f.db.all("SELECT * FROM ops_platform_runs").length, 1);
  const p = f.pool(),
    app = f.app(),
    huge = f.store.create(
      "service",
      "Large",
      {
        application_id: app.id,
        node_pool_id: p.id,
        replicas: 1,
        container_port: 80,
        cpu: 3,
        memory_mb: 512,
      },
      "admin",
    );
  await assert.rejects(
    f.controller.perform(huge, "deploy", {}, "admin"),
    /capacity/,
  );
});
test("stop releases reservations only after a matching verified Agent receipt", async (t) => {
  const f = setup(t),
    a = f.store.create(
      "application",
      "Web",
      {
        mode: "container",
        image: "nginx:1.30.6-alpine",
        agent_ids: ["node-a"],
        ports: [{ host_port: 22000, container_port: 80 }],
      },
      "admin",
    );
  await f.controller.perform(a, "deploy", {}, "admin");
  f.finish("node-a", { healthy: true, containers: [{ running: true }] });
  await f.controller.perform(f.store.get(a.id), "stop", {}, "admin");
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 1);
  f.finish("node-a", {
    stopped: true,
    healthy: false,
    containers: [{ running: false }],
  });
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 0);
  assert.equal(f.store.get(a.id).status.instances[0].state, "stopped");
});
test("multi-gateway bundle includes all sites and blocks duplicate writers across website owners", async (t) => {
  const f = setup(t),
    g = f.store.create(
      "gateway_group",
      "Gateways",
      { agent_ids: ["node-a", "node-b"], http_port: 18080, https_port: 18443 },
      "admin",
    ),
    a = f.store.create(
      "website",
      "A",
      {
        gateway_group_id: g.id,
        domains: ["a.example.com"],
        mode: "static",
        static_files: { "index.html": "A" },
      },
      "admin",
    ),
    b = f.store.create(
      "website",
      "B",
      {
        gateway_group_id: g.id,
        domains: ["b.example.com"],
        mode: "proxy",
        upstreams: ["http://10.1.0.8:8080"],
      },
      "admin",
    );
  const deploy = await f.controller.perform(a, "deploy", {}, "admin");
  assert.equal(deploy.runs.length, 2);
  const second = await f.controller.perform(b, "deploy", {}, "admin");
  assert.equal(second.runs.length, 0);
  const payload = f.finish("node-a", {
    healthy: true,
    running: true,
    digest: "verified",
  });
  assert.equal(payload.resource.config.sites.length, 1);
  f.finish("node-b", { healthy: true, running: true, digest: "verified" });
  assert.equal(f.store.get(a.id).status.active, true);
  assert.notEqual(f.store.get(b.id).status.active, true);
  await f.controller.tick?.();
  const full = f.finish("node-a", {
    healthy: true,
    running: true,
    digest: "verified-new",
  });
  assert.equal(full.resource.config.sites.length, 2);
  f.finish("node-b", { healthy: true, running: true, digest: "verified-new" });
  assert.equal(f.store.get(b.id).status.active, true);
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 4);
});
test("saving revisions does not publish websites or update a deployed service application", async (t) => {
  const f = setup(t),
    g = f.store.create(
      "gateway_group",
      "Gateway",
      { agent_ids: ["node-a"], http_port: 18080, https_port: 18443 },
      "admin",
    ),
    site = f.store.create(
      "website",
      "Draft",
      {
        gateway_group_id: g.id,
        domains: ["draft.example.com"],
        mode: "static",
        static_files: { "index.html": "draft" },
      },
      "admin",
    );
  await f.controller.perform(g, "deploy", {}, "admin");
  assert.equal(
    f.finish("node-a", { healthy: true, running: true }).resource.config.sites
      .length,
    0,
  );
  await f.controller.perform(site, "deploy", {}, "admin");
  assert.equal(
    f.finish("node-a", { healthy: true, running: true }).resource.config
      .sites[0].static_files["index.html"],
    "draft",
  );
  const edited = f.store.update(
    site.id,
    1,
    site.name,
    { ...site.spec, static_files: { "index.html": "unpublished" } },
    "admin",
  );
  await f.controller.tick?.();
  assert.equal(f.store.actions().filter((r) => r.state === "queued").length, 0);
  assert.equal(f.store.get(edited.id).status.desired_revision, 1);
  const p = f.pool(),
    a = f.app(),
    service = f.store.create(
      "service",
      "API",
      {
        application_id: a.id,
        node_pool_id: p.id,
        replicas: 1,
        container_port: 80,
        cpu: 1,
        memory_mb: 128,
      },
      "admin",
    );
  await f.controller.perform(service, "deploy", {}, "admin");
  f.finish("node-a", { healthy: true, containers: [{ running: true }] });
  f.store.update(
    a.id,
    1,
    a.name,
    { ...a.spec, image: "nginx:unpublished" },
    "admin",
  );
  await f.controller.tick?.();
  assert.equal(
    f.store
      .actions()
      .filter((r) => r.action === "deploy" && r.state === "queued").length,
    0,
  );
  assert.equal(f.store.get(service.id).status.application_revision, 1);
});
test("duplicate gateway domains are rejected and stopped gateways reserve their ports again", async (t) => {
  const f = setup(t),
    g = f.store.create(
      "gateway_group",
      "Gateway",
      { agent_ids: ["node-a"], http_port: 18080, https_port: 18443 },
      "admin",
    );
  f.store.create(
    "website",
    "First",
    { gateway_group_id: g.id, domains: ["same.example.com"], mode: "static" },
    "admin",
  );
  assert.throws(
    () =>
      f.store.create(
        "website",
        "Conflict",
        {
          gateway_group_id: g.id,
          domains: ["same.example.com"],
          mode: "static",
        },
        "admin",
      ),
    /domain_conflict/,
  );
  await f.controller.perform(g, "deploy", {}, "admin");
  f.finish("node-a", { healthy: true, running: true });
  await f.controller.perform(f.store.get(g.id), "stop", {}, "admin");
  f.finish("node-a", { stopped: true, running: false });
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 0);
  await f.controller.perform(f.store.get(g.id), "deploy", {}, "admin");
  assert.equal(f.db.all("SELECT * FROM ops_platform_ports").length, 2);
});
test("redacted application environment edits retain the encrypted original", (t) => {
  const f = setup(t),
    a = f.app(),
    visible = f.store.public(a);
  assert.equal(visible.spec.environment.PASSWORD, "[redacted]");
  const edited = f.store.update(
    a.id,
    1,
    a.name,
    { ...visible.spec, image: "nginx:1.30.6-alpine" },
    "admin",
  );
  assert.equal(edited.spec.environment.PASSWORD, "private-test");
  assert.equal(
    JSON.stringify(f.db.all("SELECT * FROM ops_platform_resources")).includes(
      "private-test",
    ),
    false,
  );
  const compose = f.store.create(
    "application",
    "Compose",
    {
      mode: "compose",
      compose: {
        services: {
          api: {
            image: "nginx:1.30.6-alpine",
            environment: { PASSWORD: "compose-private" },
          },
        },
      },
    },
    "admin",
  );
  const changed = f.store.update(
    compose.id,
    1,
    compose.name,
    {
      mode: "compose",
      compose:
        'services:\n  api:\n    image: nginx:1.30.6-alpine\n    environment:\n      PASSWORD: "[redacted]"\n',
    },
    "admin",
  );
  assert.equal(
    changed.spec.compose.services.api.environment.PASSWORD,
    "compose-private",
  );
});
test("one hundred large Agent observations remain bounded without rolling back their receipts", async (t) => {
  const f = setup(t),
    p = f.store.create(
      "node_pool",
      "Large pool",
      {
        agent_ids: ["node-a", "node-b"],
        port_start: 24000,
        port_end: 24100,
        nodes: [
          {
            agent_id: "node-a",
            address: "10.1.0.1",
            cpu: 100,
            memory_mb: 100000,
          },
          {
            agent_id: "node-b",
            address: "10.1.0.2",
            cpu: 100,
            memory_mb: 100000,
          },
        ],
      },
      "admin",
    ),
    a = f.app(),
    s = f.store.create(
      "service",
      "Many",
      {
        application_id: a.id,
        node_pool_id: p.id,
        replicas: 100,
        container_port: 80,
        cpu: 0.1,
        memory_mb: 4,
      },
      "admin",
    );
  await f.controller.perform(s, "deploy", {}, "admin");
  for (let i = 0; i < 100; i++)
    f.finish(i % 2 ? "node-b" : "node-a", {
      healthy: true,
      containers: [{ running: true, id: "x".repeat(1000) }],
      stats: [{ CPUPerc: "1%", MemUsage: "x".repeat(50000) }],
    });
  const resource = f.store.get(s.id);
  assert.equal(resource.status.instances_total, 100);
  assert.equal(resource.status.endpoints.length, 100);
  assert.ok(Buffer.byteLength(JSON.stringify(resource.status)) < 128 * 1024);
  assert.equal(
    f.store.actions(s.id).filter((r) => r.state === "succeeded").length,
    100,
  );
});
test("rolling update waits across reconciliation ticks for the preceding replica verification", async (t) => {
  const f = setup(t),
    p = f.pool(),
    a = f.app(),
    s = f.store.create(
      "service",
      "Rolling",
      {
        application_id: a.id,
        node_pool_id: p.id,
        replicas: 2,
        container_port: 80,
        cpu: 0.5,
        memory_mb: 128,
      },
      "admin",
    );
  await f.controller.perform(s, "deploy", {}, "admin");
  f.finish("node-a", { healthy: true, containers: [{ running: true }] });
  f.finish("node-b", { healthy: true, containers: [{ running: true }] });
  f.store.update(
    a.id,
    1,
    a.name,
    { ...a.spec, image: "nginx:1.30.7-alpine" },
    "admin",
  );
  const update = await f.controller.perform(
    f.store.get(s.id),
    "deploy",
    {},
    "admin",
  );
  assert.equal(update.runs.length, 1);
  await f.controller.tick?.();
  assert.equal(
    f.store
      .actions(s.id)
      .filter((r) => r.action === "deploy" && r.state === "queued").length,
    1,
  );
  f.finish("node-a", { healthy: true, containers: [{ running: true }] });
  await f.controller.tick?.();
  const pending = f.store
    .actions(s.id)
    .filter((r) => r.action === "deploy" && r.state === "queued");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].agent_id, "node-b");
});
test("a stalled DNS provider does not delay independent instance health observations", async (t) => {
  let rejectDNS!: (reason: Error) => void;
  let calls = 0;
  const f = setup(t, (async () => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      rejectDNS = reject;
    });
  }) as typeof fetch);
  f.store.register("credential", { validate: (s) => s });
  f.store.register("dns_zone", { validate: (s) => s });
  const credential = f.store.create(
    "credential",
    "DNS",
    {
      provider: "aliyun",
      access_key_id: "fixture-key",
      access_key_secret: "fixture-secret",
    },
    "admin",
  );
  const zone = f.store.create(
    "dns_zone",
    "Zone",
    {
      credential_id: credential.id,
      domain: "example.com",
      scope: "example.com",
    },
    "admin",
  );
  const group = f.store.create(
    "gateway_group",
    "Gateway",
    {
      agent_ids: ["node-a"],
      http_port: 18080,
      https_port: 18443,
      public_addresses: { "node-a": "192.0.2.1" },
    },
    "admin",
  );
  const site = f.store.create(
    "website",
    "Site",
    {
      gateway_group_id: group.id,
      mode: "static",
      domains: ["www.example.com"],
      dns_zone_id: zone.id,
    },
    "admin",
  );
  await f.controller.perform(site, "deploy", {}, "admin");
  f.finish("node-a", { healthy: true, running: true });
  await f.controller.tick?.();
  assert.equal(calls, 1);
  f.advance(31000);
  await f.controller.tick?.();
  assert.equal(calls, 1);
  assert.equal(
    f.store
      .actions(group.id)
      .filter((r) => r.action === "inspect" && r.state === "queued").length,
    1,
  );
  rejectDNS(new Error("fixture provider unavailable"));
});
test("an unconfigured machine pool discovers actual node capacity before scheduling", async (t) => {
  const f = setup(t),
    pool = f.store.create(
      "node_pool",
      "Discovered pool",
      { agent_ids: ["node-a", "node-b"], port_start: 25000, port_end: 25010 },
      "admin",
    ),
    application = f.app(),
    service = f.store.create(
      "service",
      "Discovered API",
      {
        application_id: application.id,
        node_pool_id: pool.id,
        replicas: 2,
        container_port: 80,
        cpu: 1,
        memory_mb: 128,
      },
      "admin",
    );
  const start = await f.controller.perform(service, "deploy", {}, "admin");
  assert.equal(start.pending, "node_capacity_discovery");
  assert.equal(start.runs.length, 2);
  assert.equal(f.db.all("SELECT * FROM ops_platform_instances").length, 0);
  const first = f.finish("node-a", {
    node: {
      cpu: 2,
      memory_mb: 2048,
      address: "10.1.0.1",
      docker_available: true,
    },
  });
  assert.equal(first.resource.config.task, "node.inspect");
  f.finish("node-b", {
    node: {
      cpu: 2,
      memory_mb: 2048,
      address: "10.1.0.2",
      docker_available: true,
    },
  });
  await f.controller.tick?.();
  assert.equal(f.db.all("SELECT * FROM ops_platform_instances").length, 2);
  assert.equal(
    f.store.actions(service.id).filter((run) => run.action === "deploy").length,
    2,
  );
});

test("per-path service discovery preserves independent manual routes and blocks nested service deletion", async (t) => {
  const f = setup(t),
    pool = f.pool(),
    app = f.app();
  const service = f.store.create(
    "service",
    "Route service",
    {
      application_id: app.id,
      node_pool_id: pool.id,
      replicas: 1,
      container_port: 8080,
    },
    "admin",
  );
  const group = f.store.create(
    "gateway_group",
    "Route gateways",
    { agent_ids: ["node-a"] },
    "admin",
  );
  const site = f.store.create(
    "website",
    "Routes",
    {
      domains: ["paths.example.test"],
      gateway_group_id: group.id,
      mode: "proxy",
      locations: [
        { path: "/api/", target: "service", service_id: service.id },
        { path: "/", upstreams: ["http://10.1.0.8:8080"] },
      ],
    },
    "admin",
  );
  assert.throws(
    () => f.store.remove(service.id, service.revision),
    /platform_resource_in_use/,
  );
  await f.controller.perform(site, "deploy", {}, "admin");
  const payload = f.finish("node-a", {
    healthy: true,
    running: true,
    digest: "test",
    task: "gateway.apply",
    instance_id: f.db.get<any>(
      "SELECT id FROM ops_platform_instances WHERE owner_id=?",
      group.id,
    )!.id,
  });
  const routes = payload.resource.config.sites[0].locations;
  assert.equal(routes[0].unavailable, true);
  assert.equal(routes[0].service_id, service.id);
  assert.equal(routes[1].upstreams[0].url, "http://10.1.0.8:8080");
});
