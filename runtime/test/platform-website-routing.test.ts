import {createHostNetworkSchema,recordHostNetwork,saveMachineServiceAddresses} from "../src/server/host-network.js";
import {normalizeNetworkAddresses} from "../src/shared/host-network.js";
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
import { renderGateway } from "../src/operations/platform.js";
import type { Dependencies } from "../src/shared/types.js";
async function fixture(t: any, fetcher?: typeof fetch) {
  const db = new DB(":memory:");
  db.exec(
    `CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','admin',1),('member','member',1);CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);INSERT INTO agents VALUES('a','ha','A','1','linux','amd64','2026-10-29T02:00:00.000Z','default','{}'),('b','hb','B','1','linux','amd64','2026-10-29T02:00:00.000Z','default','{}');CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT,address TEXT,agent_id TEXT);INSERT INTO managed_machines(id,name,address,agent_id) VALUES('ma','Machine A','10.0.0.1','a'),('mb','Machine B','10.0.0.2','b');`,
  );
  db.exec("ALTER TABLE managed_machines ADD COLUMN ssh_target_generation INTEGER NOT NULL DEFAULT 0; ALTER TABLE managed_machines ADD COLUMN host_key_fingerprint TEXT NOT NULL DEFAULT ''");
  createHostNetworkSchema(db);
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
  const createCluster = (ids = ["ma", "mb"], name = "Cluster") => {
    for(const machineID of ids){
      const machine=db.get<any>('SELECT * FROM managed_machines WHERE id=?',machineID);
      if(machine&&!db.get('SELECT machine_id FROM machine_network_observations WHERE machine_id=?',machineID))recordHostNetwork(db,machineID,machine.agent_id,normalizeNetworkAddresses([{interface:'eth0',address:machine.address},{interface:'eth0',address:'203.0.113.'+({ma:1,mb:2,mc:3}[machineID]??4)}]),undefined,now.toISOString());
    }
    return store.create(
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
  };
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

test("manual website upstream validation preserves saved resources after rejected URLs", async (t) => {
  const f = await fixture(t), cluster = f.createCluster(["ma"]);
  const spec = (upstreams: any[]) => ({
    cluster_ids: [cluster.id],
    bindings: [{ domains: ["registry.example.test"], locations: [{
      path: "/", cluster_targets: [{ cluster_id: cluster.id, target: "proxy", upstreams }],
    }] }],
  });
  const rejected = ["127.0.0.1:5000", "registry.internal:5000", "ftp://registry.internal:5000",
    "http://registry.internal:5000/v2/", "http://registry.internal:5000/?q=1",
    "http://registry.internal:5000/#v2", "http://user:password@registry.internal:5000"];
  for (const url of rejected) {
    const response = await f.req("/resources", "POST", { kind: "website", name: "Registry", spec: spec([{ url }]) });
    assert.equal(response.status, 400, url);
    assert.equal(response.body.error, "INVALID_WEBSITE_UPSTREAM", url);
    assert.equal(f.store.list("website").length, 0);
  }
  const created = await f.req("/resources", "POST", {
    kind: "website", name: "Registry", spec: spec([{ url: "http://127.0.0.1:5000/", weight: 2, max_fails: 3, fail_timeout_seconds: 5 }]),
  });
  assert.equal(created.status, 201);
  const site = created.body.resource;
  assert.deepEqual(site.spec.bindings[0].locations[0].cluster_targets[0].upstreams,
    [{ url: "http://127.0.0.1:5000", weight: 2, max_fails: 3, fail_timeout_seconds: 5, backup: false }]);
  for (const [upstreams, code] of [
    ...rejected.map(url => [[{ url }], "INVALID_WEBSITE_UPSTREAM"]),
    [[], "WEBSITE_UPSTREAM_REQUIRED"],
    [[{ url: "http://registry.internal:5000" }, { url: "https://registry.internal:5001" }], "MIXED_UPSTREAM_PROTOCOLS"],
  ] as const) {
    const response = await f.req("/resources/" + site.id, "PUT", {
      name: "Rejected edit", revision: site.revision, spec: spec(upstreams as any[]),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, code);
    const saved = (await f.req("/resources/" + site.id)).body.resource;
    assert.equal(saved.name, site.name);
    assert.equal(saved.revision, site.revision);
    assert.deepEqual(saved.spec, site.spec);
  }
  const updated = await f.req("/resources/" + site.id, "PUT", {
    name: site.name, revision: site.revision, spec: spec([{ url: "https://[fd00::1]:5443/" }]),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.resource.spec.bindings[0].locations[0].cluster_targets[0].upstreams[0].url,
    "https://[fd00::1]:5443");
});

test("domain routes validate scope and require manual backends only in bound clusters", async (t) => {
  const f = await fixture(t),
    a = f.createCluster(["ma"], "South"),
    b = f.createCluster(["mb"], "North");
  const spec = {
    cluster_ids: [a.id, b.id],
    domain_routes: [
      { domain: "south.example.test", cluster_ids: [a.id] },
      { domain: "north.example.test", cluster_ids: [b.id] },
    ],
    bindings: [
      {
        domains: ["south.example.test"],
        locations: [
          {
            path: "/",
            cluster_targets: [
              {
                cluster_id: a.id,
                target: "proxy",
                upstreams: ["http://10.0.0.1:8080"],
              },
            ],
          },
        ],
      },
      {
        domains: ["north.example.test"],
        locations: [
          {
            path: "/",
            cluster_targets: [
              {
                cluster_id: b.id,
                target: "proxy",
                upstreams: ["http://10.0.0.2:8080"],
              },
            ],
          },
        ],
      },
    ],
  };
  const result = await f.req("/resources", "POST", {
    kind: "website",
    name: "Scoped",
    spec,
  });
  assert.equal(result.status, 201);
  const site = result.body.resource;
  assert.deepEqual(site.spec.domain_routes, spec.domain_routes);
  for (const [routes, error] of [
    [
      [
        {
          domain: "south.example.test",
          cluster_ids: [a.id],
          cluster_policies: [null],
        },
      ],
      "invalid_website_cluster_policy",
    ],
    [
      [
        {
          domain: "south.example.test",
          cluster_ids: [a.id],
          cluster_policies: [{ cluster_id: a.id, lines: [null] }],
        },
      ],
      "invalid_dns_line",
    ],
    [
      [{ domain: "unknown.example.test", cluster_ids: [a.id] }],
      "invalid_website_domain_route",
    ],
    [
      [spec.domain_routes[0], spec.domain_routes[0]],
      "invalid_website_domain_route",
    ],
    [
      [{ domain: "south.example.test", cluster_ids: [] }],
      "website_domain_cluster_required",
    ],
    [
      [{ domain: "south.example.test", cluster_ids: ["outside"] }],
      "website_domain_cluster_mismatch",
    ],
    [
      [
        {
          domain: "south.example.test",
          cluster_ids: [a.id],
          cluster_policies: [{ cluster_id: a.id, weight: 0 }],
        },
      ],
      "invalid_website_cluster_weight",
    ],
  ] as const) {
    const response = await f.req("/resources/" + site.id, "PUT", {
      revision: site.revision,
      name: site.name,
      spec: { ...site.spec, domain_routes: routes },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, error);
  }
});

test("domains in one binding have isolated bundles, DNS and live policy; membership stays published", async (t) => {
  const dns = dnsMock(),
    f = await fixture(t, dns.fetcher),
    a = f.createCluster(["ma"], "South"),
    b = f.createCluster(["mb"], "North"),
    zone = dnsZone(f);
  const entry = f.store.create(
    "application",
    "Entry",
    catalogInstallation("openresty", {
      deployment_mode: "managed",
      deployments: [
        {
          cluster_id: a.id,
          replicas: 1,
          gateway_domain: "south.edge.example.test",
        },
        {
          cluster_id: b.id,
          replicas: 1,
          gateway_domain: "north.edge.example.test",
        },
      ],
    }).spec,
    "admin",
  );
  await f.action(entry, "deploy");
  f.finish("a");
  f.finish("b");
  const site = f.store.create(
    "website",
    "Scoped aliases",
    {
      cluster_ids: [a.id, b.id],
      dns_record_mode: "cname",
      domain_routes: [
        {
          domain: "south.example.test",
          cluster_ids: [a.id],
          cluster_policies: [{ cluster_id: a.id, weight: 2 }],
        },
        {
          domain: "north.example.test",
          cluster_ids: [b.id],
          cluster_policies: [{ cluster_id: b.id, weight: 3 }],
        },
      ],
      bindings: [
        {
          domains: ["south.example.test", "north.example.test"],
          dns_enabled: true,
          dns_zone_id: zone.id,
          locations: [
            {
              path: "/",
              action: "return",
              return_status: 200,
              return_value: "shared",
            },
          ],
        },
      ],
    },
    "admin",
  );
  await f.action(site, "deploy");
  const south = f.finish("a"),
    north = f.finish("b");
  assert.deepEqual(
    south.payload.resource.config.sites.flatMap((s: any) => s.domains),
    ["south.example.test"],
  );
  assert.deepEqual(
    north.payload.resource.config.sites.flatMap((s: any) => s.domains),
    ["north.example.test"],
  );
  assert.equal(
    south.payload.resource.config.sites[0].locations[0].return_value,
    "shared",
  );
  await f.platform.tick();
  await settle();
  const records = () =>
    dns.records
      .filter((r) => r.Type === "CNAME")
      .map((r) => [r.RR, r.Value, r.Weight])
      .sort();
  assert.deepEqual(records(), [
    ["north", "north.edge.example.test", 3],
    ["south", "south.edge.example.test", 2],
  ]);
  const update = (change: any) => {
    const old = f.store.get(site.id);
    return f.store.update(
      site.id,
      old.revision,
      old.name,
      { ...old.spec, ...change },
      "admin",
    );
  };
  update({
    domain_routes: [
      { ...site.spec.domain_routes[0], cluster_ids: [b.id] },
      { ...site.spec.domain_routes[1] },
    ],
    nginx: { ...site.spec.nginx, gzip: true },
  });
  await f.platform.tick();
  await settle();
  assert.deepEqual(
    records(),
    [
      ["north", "north.edge.example.test", 3],
      ["south", "south.edge.example.test", 2],
    ],
    "draft membership cannot move the live domain",
  );
  assert.deepEqual(
    f.store.get(site.id).status.domain_traffic["south.example.test"]
      .cluster_ids,
    [a.id],
  );
  update({
    domain_routes: site.spec.domain_routes.map((r: any) =>
      r.domain.startsWith("north")
        ? { ...r, cluster_policies: [{ cluster_id: b.id, weight: 7 }] }
        : r,
    ),
  });
  await f.platform.tick();
  await settle();
  assert.deepEqual(records(), [
    ["north", "north.edge.example.test", 7],
    ["south", "south.edge.example.test", 2],
  ]);
  update({
    domain_routes: site.spec.domain_routes.map((r: any) =>
      r.domain.startsWith("south")
        ? { ...r, cluster_policies: [{ cluster_id: a.id, enabled: false }] }
        : { ...r, cluster_policies: [{ cluster_id: b.id, weight: 7 }] },
    ),
  });
  await f.platform.tick();
  await settle();
  assert.deepEqual(records(), [["north", "north.edge.example.test", 7]]);
  update({ domain_routes: site.spec.domain_routes });
  await f.platform.tick();
  await settle();
  f.advance(121000);
  f.heartbeat("b");
  await f.platform.tick();
  f.finish("b");
  await settle();
  await f.platform.tick();
  await settle();
  assert.deepEqual(
    records(),
    [["north", "north.edge.example.test", 3]],
    "south-only domain must not fall back to an unbound north cluster",
  );
  f.heartbeat("a");
  for (let n = 0; n < 4; n++) {
    await f.platform.tick();
    for (const agent of ["a", "b"])
      if (
        f.db.get(
          "SELECT id FROM ops_platform_runs WHERE agent_id=? AND state='queued'",
          agent,
        )
      )
        f.finish(agent);
    await settle();
  }
  const moved = update({
    domain_routes: site.spec.domain_routes.map((r: any) => ({
      ...r,
      cluster_ids: [b.id],
      cluster_policies: undefined,
    })),
  });
  await f.action(moved, "deploy", { cluster_id: b.id });
  f.finish("b");
  await f.platform.tick();
  await settle();
  assert.deepEqual(
    new Set(
      f.store.get(site.id).status.domain_traffic[
        "south.example.test"
      ].cluster_ids,
    ),
    new Set([a.id, b.id]),
    "partial publication retains the old cluster until cleanup",
  );
  await f.action(moved, "deploy", { cluster_id: a.id });
  const cleaned = f.finish("a");
  assert.deepEqual(
    cleaned.payload.resource.config.sites,
    [],
    "old cluster receives an empty bundle to remove the domain",
  );
  await f.platform.tick();
  await settle();
  assert.deepEqual(records(), [
    ["north", "north.edge.example.test", 1],
    ["south", "north.edge.example.test", 1],
  ]);
  assert.deepEqual(f.store.get(site.id).status.actual_cluster_ids, [b.id]);
});

test("managed domain follow mode discovers new clusters while explicit selections stay fixed", async (t) => {
  const f = await fixture(t),
    a = f.createCluster(["ma"], "South"),
    b = f.createCluster(["mb"], "North"),
    app = f.app(a, {
      deployment_mode: "managed",
      deployments: [{ cluster_id: a.id, replicas: 1 }],
    });
  const site = f.store.create(
    "website",
    "Follow or pin",
    {
      routing_mode: "managed",
      service_application_id: app.id,
      service_port_name: "http",
      domain_routes: [{ domain: "fixed.example.test", cluster_ids: [a.id] }],
      bindings: [
        {
          domains: ["follow.example.test", "fixed.example.test"],
          locations: [{ path: "/" }],
        },
      ],
    },
    "admin",
  );
  await f.action(site, "deploy");
  let service = f.store.update(
    app.id,
    app.revision,
    app.name,
    {
      ...app.spec,
      deployments: [...app.spec.deployments, { cluster_id: b.id, replicas: 1 }],
    },
    "admin",
  );
  await f.platform.tick();
  let status = f.store.get(site.id).status;
  assert.deepEqual(status.domain_traffic["follow.example.test"].cluster_ids, [
    a.id,
    b.id,
  ]);
  assert.deepEqual(status.domain_traffic["fixed.example.test"].cluster_ids, [
    a.id,
  ]);
  service = f.store.update(
    service.id,
    service.revision,
    service.name,
    { ...service.spec, deployments: [{ cluster_id: b.id, replicas: 1 }] },
    "admin",
  );
  await f.platform.tick();
  status = f.store.get(site.id).status;
  assert.deepEqual(status.domain_traffic["follow.example.test"].cluster_ids, [
    b.id,
  ]);
  assert.deepEqual(
    status.domain_traffic["fixed.example.test"].cluster_ids,
    [],
    "removed fixed cluster does not turn into follow-all",
  );
});

test("OpenResty is a global singleton and deployment entry domains are editable", async (t) => {
  const f = await fixture(t),
    a = f.createCluster(["ma"], "South"),
    b = f.createCluster(["mb"], "North");
  const resty = f.store.create(
    "application",
    "OpenResty",
    catalogInstallation("openresty", {
      deployment_mode: "managed",
      deployments: [
        {
          cluster_id: a.id,
          replicas: 1,
          gateway_domain: "south.edge.example.test",
        },
      ],
      parameters: {},
    }).spec,
    "admin",
  );
  assert.equal(
    resty.spec.deployments[0].gateway_domain,
    "south.edge.example.test",
  );
  const updated = f.store.update(
    resty.id,
    resty.revision,
    "OpenResty",
    {
      ...resty.spec,
      deployments: [
        ...resty.spec.deployments,
        {
          cluster_id: b.id,
          replicas: 1,
          gateway_domain: "north.edge.example.test",
        },
      ],
    },
    "admin",
  );
  assert.equal(updated.spec.deployments.length, 2);
  const reduced = f.store.update(
    updated.id,
    updated.revision,
    updated.name,
    { ...updated.spec, deployments: [updated.spec.deployments[0]] },
    "admin",
  );
  assert.equal(
    reduced.spec.deployments.length,
    1,
    "stopped deployment configuration can be removed",
  );

  assert.throws(
    () =>
      f.app(b, {
        role: "openresty",
        image: "openresty/openresty:alpine",
        network_mode: "host",
        ports: [
          {
            name: "http",
            container_port: 80,
            host_port: 80,
            protocol: "tcp",
            app_protocol: "http",
          },
          {
            name: "https",
            container_port: 443,
            host_port: 443,
            protocol: "tcp",
            app_protocol: "https",
          },
        ],
      }),
    /openresty_already_installed/,
  );
});

test("managed website discovers service deployments and validates live traffic policy", async (t) => {
  const f = await fixture(t),
    a = f.createCluster(["ma"], "South"),
    b = f.createCluster(["mb"], "North");
  const app = f.app(a, {
    deployment_mode: "managed",
    deployments: [
      { cluster_id: a.id, replicas: 1 },
      { cluster_id: b.id, replicas: 1 },
    ],
  });
  const site = f.store.create(
    "website",
    "Managed",
    {
      routing_mode: "managed",
      service_application_id: app.id,
      service_port_name: "http",
      mode: "proxy",
      dns_record_mode: "cname",
      cluster_policies: [{ cluster_id: a.id, enabled: false, weight: 2 }],
      bindings: [{ domains: ["www.example.test"], locations: [{ path: "/" }] }],
    },
    "admin",
  );
  assert.deepEqual(site.spec.cluster_ids, [a.id, b.id]);
  assert.equal(site.spec.cluster_policies[0].enabled, false);
  assert.equal(site.spec.bindings[0].locations[0].cluster_targets.length, 2);
  assert.throws(
    () =>
      f.store.update(
        site.id,
        site.revision,
        site.name,
        { ...site.spec, cluster_policies: [{ cluster_id: a.id, weight: 0 }] },
        "admin",
      ),
    /invalid_website_cluster_weight/,
  );
  assert.throws(
    () =>
      f.store.update(
        site.id,
        site.revision,
        site.name,
        { ...site.spec, service_port_name: "missing" },
        "admin",
      ),
    /application_port_not_found/,
  );
});

for (const protocol of ["http", "https"]) {
  test(`${protocol} application upstreams use loopback only on the target gateway machine`, async (t) => {
    const f = await fixture(t),
      c = f.createCluster();
    recordHostNetwork(f.db,'mb','b',normalizeNetworkAddresses([{interface:'eth0',address:'fd00::2'},{interface:'eth0',address:'203.0.113.2'}]),undefined,'2026-10-29T02:00:00Z');
    const app = f.app(c, {
      machine_ids: ["ma", "mb"],
      ports: [
        {
          name: "http",
          container_port: 8080,
          host_port: 0,
          protocol: "tcp",
          app_protocol: protocol,
        },
        {
          name: "admin",
          container_port: 9090,
          host_port: 0,
          protocol: "tcp",
          app_protocol: "http",
        },
      ],
    });
    assert.equal((await f.action(app, "deploy")).status, 202);
    f.finish("a");
    f.finish("b");
    const discovery = await f.req(
      "/resources/" + app.id + "/endpoints?cluster_id=" + c.id,
    );
    assert.equal(discovery.status, 200);
    const discovered = discovery.body.endpoints;
    const port = (machineID: string, name: string) =>
      discovered.find(
        (e: any) => e.machine_id === machineID && e.port_name === name,
      ).port;
    assert.deepEqual(
      discovered
        .filter((e: any) => e.port_name === "http")
        .map((e: any) => e.ip)
        .sort(),
      ["10.0.0.1", "fd00::2"],
    );
    const resty = f.store.create(
      "application",
      "Entry",
      catalogInstallation("openresty", {
        deployments: [{ cluster_id: c.id, machine_ids: ["ma", "mb"] }],
      }).spec,
      "admin",
    );
    await f.action(resty, "deploy");
    f.finish("a");
    f.finish("b");
    const managed = f.store.create(
      "website",
      "Managed",
      {
        routing_mode: "managed",
        service_application_id: app.id,
        service_port_name: "http",
        dns_record_mode: "address",
        bindings: [
          { domains: ["managed.example.test"], locations: [{ path: "/" }] },
        ],
      },
      "admin",
    );
    await f.action(managed, "deploy");
    const a = f.finish("a").payload.resource.config,
      b = f.finish("b").payload.resource.config;
    assert.deepEqual(
      a.sites[0].locations[0].upstreams.sort(),
      [
        `${protocol}://127.0.0.1:${port("ma", "http")}`,
        `${protocol}://[fd00::2]:${port("mb", "http")}`,
      ].sort(),
    );
    assert.deepEqual(
      b.sites[0].locations[0].upstreams.sort(),
      [
        `${protocol}://10.0.0.1:${port("ma", "http")}`,
        `${protocol}://127.0.0.1:${port("mb", "http")}`,
      ].sort(),
    );
    const rendered = renderGateway(a, "test");
    assert.ok(rendered.includes(`server 127.0.0.1:${port("ma", "http")} `));
    assert.ok(rendered.includes(`server [fd00::2]:${port("mb", "http")} `));
    assert.ok(rendered.includes(`proxy_pass ${protocol}://`));
    const preview = await f.req(
      "/resources/" + managed.id + "/nginx?cluster_id=" + c.id,
    );
    assert.equal(preview.status, 200);
    assert.ok(
      preview.body.config.includes(`server 10.0.0.1:${port("ma", "http")} `),
    );
    assert.ok(
      preview.body.config.includes(`server [fd00::2]:${port("mb", "http")} `),
    );
    assert.ok(!preview.body.config.includes("server 127.0.0.1:"));

    const manual = f.store.create(
      "website",
      "Manual",
      {
        cluster_ids: [c.id],
        dns_record_mode: "address",
        bindings: [
          {
            domains: ["manual.example.test"],
            locations: [
              {
                path: "/app",
                cluster_targets: [
                  {
                    cluster_id: c.id,
                    target: "application",
                    application_id: app.id,
                    port_name: "admin",
                  },
                ],
              },
              {
                path: "/literal",
                cluster_targets: [
                  {
                    cluster_id: c.id,
                    target: "proxy",
                    upstreams: ["http://10.0.0.1:9191"],
                  },
                ],
              },
            ],
          },
        ],
      },
      "admin",
    );
    await f.action(manual, "deploy");
    const ma = f.finish("a").payload.resource.config,
      mb = f.finish("b").payload.resource.config;
    const routes = (config: any) =>
      config.sites.find((s: any) => s.domains.includes("manual.example.test"))
        .locations;
    assert.deepEqual(
      routes(ma)[0].upstreams.sort(),
      [
        `http://127.0.0.1:${port("ma", "admin")}`,
        `http://[fd00::2]:${port("mb", "admin")}`,
      ].sort(),
    );
    assert.deepEqual(
      routes(mb)[0].upstreams.sort(),
      [
        `http://10.0.0.1:${port("ma", "admin")}`,
        `http://127.0.0.1:${port("mb", "admin")}`,
      ].sort(),
    );
    for (const config of [ma, mb])
      assert.deepEqual(
        routes(config)[1].upstreams,
        manual.spec.bindings[0].locations[1].cluster_targets[0].upstreams,
      );
    const signatures = f.db.all<any>(
      "SELECT last_bundle_sig FROM ops_cluster_instances WHERE owner_id=?",
      resty.id,
    );
    assert.equal(signatures.length, 2);
    assert.notEqual(
      signatures[0].last_bundle_sig,
      signatures[1].last_bundle_sig,
    );
    await f.platform.tick();
    assert.ok(!f.jobs.claim("a", ["operations.platform"]));
    assert.ok(!f.jobs.claim("b", ["operations.platform"]));

    // Health changes must refresh each gateway's own bundle, including local removal.
    f.db.run(
      "UPDATE ops_cluster_instances SET healthy=0 WHERE owner_id=? AND machine_id='ma'",
      app.id,
    );
    await f.platform.tick();
    const unhealthyA = f.finish("a").payload.resource.config,
      unhealthyB = f.finish("b").payload.resource.config;
    assert.deepEqual(
      unhealthyA.sites.find((s: any) =>
        s.domains.includes("managed.example.test"),
      ).locations[0].upstreams,
      [`${protocol}://[fd00::2]:${port("mb", "http")}`],
    );
    assert.deepEqual(
      unhealthyB.sites.find((s: any) =>
        s.domains.includes("managed.example.test"),
      ).locations[0].upstreams,
      [`${protocol}://127.0.0.1:${port("mb", "http")}`],
    );
    f.db.run(
      "UPDATE ops_cluster_instances SET healthy=0 WHERE owner_id=?",
      app.id,
    );
    await f.platform.tick();
    for (const agent of ["a", "b"]) {
      const config = f.finish(agent).payload.resource.config;
      const location = config.sites.find((s: any) =>
        s.domains.includes("managed.example.test"),
      ).locations[0];
      assert.deepEqual(location.upstreams, []);
      assert.equal(location.unavailable, true);
      assert.match(renderGateway(config, "empty"), /return 503;/);
    }
    // A specific registry-style bind is used even by the local host-network gateway.
    f.db.run("UPDATE ops_cluster_instances SET healthy=1 WHERE owner_id=? AND machine_id='ma'",app.id);
    const bound=f.db.get<any>("SELECT id FROM ops_cluster_instances WHERE owner_id=? AND machine_id='ma'",app.id)!;
    f.db.run("UPDATE ops_platform_instance_ports SET host_ip='10.55.0.1' WHERE instance_id=? AND name='http'",bound.id);
    await f.platform.tick();
    for(const agent of ['a','b']){
      const config=f.finish(agent).payload.resource.config;
      assert.deepEqual(config.sites.find((s:any)=>s.domains.includes('managed.example.test')).locations[0].upstreams,[`${protocol}://10.55.0.1:${port('ma','http')}`]);
    }
    // A loopback-only service remains local; a peer gateway must return unavailable.
    f.db.run("UPDATE ops_platform_instance_ports SET host_ip='127.0.0.1' WHERE instance_id=? AND name='http'",bound.id);
    await f.platform.tick();
    for(const agent of ['a','b']){
      const config=f.finish(agent).payload.resource.config,location=config.sites.find((s:any)=>s.domains.includes('managed.example.test')).locations[0];
      assert.deepEqual(location.upstreams,agent==='a'?[`${protocol}://127.0.0.1:${port('ma','http')}`]:[]);
      assert.equal(location.unavailable,agent!=='a');
    }
  });
}

function dnsMock() {
  let seq = 0;
  const records: any[] = [
      {
        RecordId: "external",
        RR: "manual",
        Type: "TXT",
        Value: "keep",
        Line: "default",
        TTL: 600,
        Status: "Enable",
      },
    ],
    calls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const d = Object.fromEntries(new URLSearchParams(String(init?.body)));
    calls.push(d);
    let body: any = {};
    if (d.Action === "DescribeDomainInfo")
      body = {
        RecordLines: {
          RecordLine: [
            { LineCode: "default", LineDisplayName: "默认" },
            { LineCode: "south", LineDisplayName: "南方省份" },
            { LineCode: "north", LineDisplayName: "北方省份" },
          ],
        },
      };
    else if (d.Action === "DescribeDomainRecords")
      body = { TotalCount: records.length, DomainRecords: { Record: records } };
    else if (d.Action === "AddDomainRecord") {
      const RecordId = String(++seq);
      records.push({
        RecordId,
        RR: d.RR,
        Type: d.Type,
        Value: d.Value,
        TTL: Number(d.TTL),
        Line: d.Line,
        Status: "Enable",
      });
      body = { RecordId };
    } else if (d.Action === "UpdateDomainRecord") {
      Object.assign(
        records.find((r) => r.RecordId === d.RecordId),
        {
          RR: d.RR,
          Type: d.Type,
          Value: d.Value,
          TTL: Number(d.TTL),
          Line: d.Line,
        },
      );
      body = { RecordId: d.RecordId };
    } else if (d.Action === "SetDNSSLBStatus") {
      for (const r of records.filter(
        (r) => r.RR + ".example.test" === d.SubDomain && r.Line === d.Line,
      ))
        r.LbaStatus = true;
      body = { Open: true };
    } else if (d.Action === "UpdateDNSSLBWeight") {
      records.find((r) => r.RecordId === d.RecordId).Weight = Number(d.Weight);
      body = { RecordId: d.RecordId, Weight: Number(d.Weight) };
    } else if (d.Action === "DeleteDomainRecord") {
      const i = records.findIndex((r) => r.RecordId === d.RecordId);
      if (i >= 0) records.splice(i, 1);
    } else throw Error("unexpected DNS action " + d.Action);
    return new Response(JSON.stringify(body));
  };
  return { records, calls, fetcher };
}
const settle = async () => {
  for (let n = 0; n < 25; n++) await new Promise<void>((r) => setImmediate(r));
};
function dnsZone(f: any) {
  const cred = f.store.create(
    "credential",
    "DNS",
    {
      provider: "aliyun",
      access_key_id: "fixture",
      access_key_secret: "fixture-private",
    },
    "admin",
  );
  return f.store.create(
    "dns_zone",
    "Zone",
    { domain: "example.test", credential_id: cred.id },
    "admin",
  );
}

test("NAT hosts require confirmed public service addresses for entry DNS while internal endpoints stay private",async t=>{
 const dns=dnsMock(),f=await fixture(t,dns.fetcher),c=f.createCluster(['ma']),zone=dnsZone(f);
 recordHostNetwork(f.db,'ma','a',normalizeNetworkAddresses([{interface:'eth0',address:'10.0.0.1'}]),{source_ip:'172.24.0.1',source_kind:'direct'},'2026-10-29T02:00:01Z');
 const entry=f.store.create('application','NAT entry',catalogInstallation('openresty',{deployment_mode:'managed',deployments:[{cluster_id:c.id,replicas:1,gateway_domain:'nat.edge.example.test',gateway_dns_zone_id:zone.id}]}).spec,'admin');
 await f.action(entry,'deploy');f.finish('a',{healthy:true,running:true,digest:'nat'});
 const site=f.store.create('website','NAT site',{mode:'proxy',cluster_ids:[c.id],dns_record_mode:'cname',bindings:[{domains:['nat.example.test'],dns_enabled:true,dns_zone_id:zone.id,locations:[{path:'/',action:'return',return_status:200,return_value:'ready'}]}]},'admin');
 await f.action(site,'deploy');f.finish('a',{healthy:true,running:true,digest:'nat-site'});
 await f.platform.tick();await settle();
 assert.equal(f.store.get(entry.id).status.gateway_dns[c.id].state,'public_ip_required');
 assert.deepEqual(f.store.get(entry.id).status.gateway_dns[c.id].missing_public_machine_ids,['ma']);
 assert.equal(f.store.get(site.id).status.cluster_traffic[c.id].error,'machine_public_service_address_required');
 assert.ok(!dns.records.some(r=>r.RR==='nat.edge'||r.RR==='nat'));
 saveMachineServiceAddresses(f.db,'ma',{revision:0,target_generation:0,private:{mode:'auto',address:''},public:{mode:'manual',address:'8.8.4.4'}},'admin','2026-10-29T02:00:02Z');
 await f.platform.tick();await settle();
 assert.ok(dns.records.some(r=>r.RR==='nat.edge'&&r.Type==='A'&&r.Value==='8.8.4.4'));
 assert.ok(dns.records.some(r=>r.RR==='nat'&&r.Type==='CNAME'&&r.Value==='nat.edge.example.test'));
 const endpoints=await f.req('/resources/'+entry.id+'/endpoints?cluster_id='+c.id);
 assert.equal(endpoints.status,200);assert.equal(endpoints.body.endpoints.find((p:any)=>p.port_name==='http').ip,'10.0.0.1');
 assert.ok(!dns.records.some(r=>['10.0.0.1','172.24.0.1'].includes(r.Value)));
});

test("weighted CNAME defaults/provinces, immediate policies, health fallback and entry DNS", async (t) => {
  const dns = dnsMock(),
    f = await fixture(t, dns.fetcher),
    a = f.createCluster(["ma"], "South"),
    b = f.createCluster(["mb"], "North"),
    zone = dnsZone(f);
  const entry = f.store.create(
    "application",
    "Entry",
    catalogInstallation("openresty", {
      deployment_mode: "managed",
      deployments: [
        {
          cluster_id: a.id,
          replicas: 1,
          gateway_domain: "south.edge.example.test",
          gateway_dns_zone_id: zone.id,
        },
        {
          cluster_id: b.id,
          replicas: 1,
          gateway_domain: "north.edge.example.test",
          gateway_dns_zone_id: zone.id,
        },
      ],
    }).spec,
    "admin",
  );
  await f.action(entry, "deploy");
  f.finish("a", { healthy: true, running: true, digest: "a" });
  f.finish("b", { healthy: true, running: true, digest: "b" });
  const site = f.store.create(
    "website",
    "Traffic",
    {
      mode: "proxy",
      cluster_ids: [a.id, b.id],
      dns_record_mode: "cname",
      cluster_policies: [
        {
          cluster_id: a.id,
          weight: 1,
          lines: [{ id: "south", name: "南方省份" }],
        },
        {
          cluster_id: b.id,
          weight: 1,
          lines: [{ id: "north", name: "北方省份" }],
        },
      ],
      bindings: [
        {
          domains: ["www.example.test"],
          dns_enabled: true,
          dns_zone_id: zone.id,
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
  await f.platform.tick();
  await settle();
  assert.equal(f.store.get(site.id).status.dns_error, "");
  const cname = () => dns.records.filter((r) => r.RR === "www");
  assert.equal(cname().length, 4);
  assert.ok(
    cname().every((r) => r.Type === "CNAME" && r.Weight === 1 && r.LbaStatus),
  );
  assert.equal(dns.records.filter((r) => r.Type === "A").length, 2);
  const update = (policies: any[]) => {
    const old = f.store.get(site.id);
    return f.store.update(
      site.id,
      old.revision,
      old.name,
      {
        ...old.spec,
        nginx: { ...old.spec.nginx, gzip: true },
        cluster_policies: policies,
      },
      "admin",
    );
  };
  const paused = update(
    site.spec.cluster_policies.map((p: any) =>
      p.cluster_id === a.id ? { ...p, enabled: false } : p,
    ),
  );
  await f.platform.tick();
  await settle();
  assert.deepEqual(
    cname().map((r) => r.Value),
    ["north.edge.example.test", "north.edge.example.test"],
  );
  assert.equal(
    f.store.get(site.id).status.deployments[b.id].desired_revision,
    1,
    "traffic save cannot publish draft gzip",
  );
  update(
    paused.spec.cluster_policies.map((p: any) => ({
      ...p,
      enabled: true,
      weight: p.cluster_id === b.id ? 3 : 1,
    })),
  );
  await f.platform.tick();
  await settle();
  assert.equal(cname().length, 4);
  assert.ok(
    cname()
      .filter((r) => r.Value.startsWith("north"))
      .every((r) => r.Weight === 3),
  );
  f.advance(121000);
  f.heartbeat("b");
  await f.platform.tick();
  f.finish("b");
  await settle();
  await f.platform.tick();
  await settle();
  assert.equal(cname().length, 2);
  assert.ok(cname().every((r) => r.Value === "north.edge.example.test"));
  assert.equal(
    dns.records.some((r) => r.RR === "south.edge"),
    false,
  );
  f.heartbeat("a");
  await f.platform.tick();
  f.finish("a", { healthy: true, running: false });
  await f.platform.tick();
  f.finish("a", { healthy: true, running: true, digest: "recovered" });
  await f.platform.tick();
  await settle();
  assert.equal(cname().length, 4);
  assert.ok(dns.records.some((r) => r.RecordId === "external"));
});

test("unsupported lines preserve serving records and exact line ownership detects external changes", async (t) => {
  const { ensureDnsRecords } = await import("../src/ops/cloud.js");
  const dns = dnsMock(),
    f = await fixture(t, dns.fetcher),
    zone = dnsZone(f),
    options: any = {
      store: f.store,
      deps: f.deps,
      dataDir: "/tmp/routing-tests",
      fetch: dns.fetcher,
    };
  const rows = [
    {
      name: "www.example.test",
      type: "CNAME",
      value: "edge.example.test",
      line: "default",
      weight: 1,
    },
    {
      name: "www.example.test",
      type: "CNAME",
      value: "edge.example.test",
      line: "south",
      weight: 2,
    },
  ];
  assert.equal(
    (await ensureDnsRecords(options, zone.id, "owner", rows, "admin")).verified,
    true,
  );
  assert.equal(
    f.db.all("SELECT * FROM ops_dns_owned WHERE owner_id=?", "owner").length,
    2,
  );
  await assert.rejects(
    ensureDnsRecords(
      options,
      zone.id,
      "owner",
      [{ ...rows[0], line: "not-available" }],
      "admin",
    ),
    /dns_line_not_supported/,
  );
  assert.equal(dns.records.filter((r) => r.RR === "www").length, 2);
  dns.records.find((r) => r.RR === "www" && r.Line === "south").Line = "north";
  await assert.rejects(
    ensureDnsRecords(options, zone.id, "owner", rows, "admin"),
    /dns_owned_record_modified_externally/,
  );
  f.db.run("UPDATE users SET active=0 WHERE id='admin'");
  await assert.rejects(
    ensureDnsRecords(options, zone.id, "owner", rows, "admin"),
    /operations_authorization_revoked/,
  );
});

test("managed website follows new service clusters with the published revision", async (t) => {
  const f = await fixture(t),
    a = f.createCluster(["ma"], "South"),
    b = f.createCluster(["mb"], "North"),
    app = f.app(a, {
      deployment_mode: "managed",
      deployments: [{ cluster_id: a.id, replicas: 1 }],
    });
  const site = f.store.create(
    "website",
    "Discover",
    {
      routing_mode: "managed",
      service_application_id: app.id,
      service_port_name: "http",
      bindings: [
        { domains: ["auto.example.test"], locations: [{ path: "/" }] },
      ],
    },
    "admin",
  );
  await f.action(site, "deploy");
  f.store.update(
    site.id,
    site.revision,
    site.name,
    { ...site.spec, nginx: { ...site.spec.nginx, gzip: true } },
    "admin",
  );
  f.store.update(
    app.id,
    app.revision,
    app.name,
    {
      ...app.spec,
      deployments: [...app.spec.deployments, { cluster_id: b.id, replicas: 1 }],
    },
    "admin",
  );
  await f.platform.tick();
  assert.deepEqual(f.store.get(site.id).status.actual_cluster_ids, [
    a.id,
    b.id,
  ]);
  const row = f.db.get<any>(
    "SELECT * FROM ops_platform_website_deployments WHERE website_id=? AND cluster_id=?",
    site.id,
    b.id,
  );
  assert.equal(row.desired_revision, 1);
  assert.equal(row.enabled, 1);
});

test("DNSPod exposes only permitted nested lines and preserves weighted CNAME identity", async (t) => {
  const { ensureDnsRecords } = await import("../src/ops/cloud.js");
  const records: any[] = [],
    writes: any[] = [];
  let id = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const action = (init!.headers as any)["x-tc-action"],
      d = JSON.parse(String(init!.body));
    let result: any = {};
    if (action === "DescribeRecordLineCategoryList")
      result = {
        LineList: [
          {
            LineId: "0",
            LineName: "默认",
            Useful: true,
            SubGroup: [
              { LineId: "p1", LineName: "广东电信", Useful: true },
              { LineId: "p2", LineName: "套餐未授权", Useful: false },
            ],
          },
        ],
      };
    else if (action === "DescribeRecordList") result = { RecordList: records };
    else if (action === "CreateRecord") {
      writes.push(d);
      const RecordId = String(++id);
      records.push({
        RecordId,
        Name: d.SubDomain,
        Type: d.RecordType,
        Value: d.Value,
        Line: d.RecordLine,
        LineId: d.RecordLineId,
        TTL: d.TTL,
        Weight: d.Weight,
        Status: "ENABLE",
      });
      result = { RecordId };
    } else if (action === "ModifyRecord") {
      writes.push(d);
      Object.assign(
        records.find((r) => r.RecordId === String(d.RecordId)),
        { Weight: d.Weight, TTL: d.TTL },
      );
      result = { RecordId: d.RecordId };
    } else throw Error("unexpected action " + action);
    return new Response(JSON.stringify({ Response: result }));
  };
  const f = await fixture(t, fetcher),
    cred = f.store.create(
      "credential",
      "DNSPod",
      {
        provider: "tencent",
        access_key_id: "fixture",
        access_key_secret: "private-fixture",
      },
      "admin",
    ),
    zone = f.store.create(
      "dns_zone",
      "DNSPod zone",
      { domain: "example.test", credential_id: cred.id },
      "admin",
    ),
    options: any = {
      store: f.store,
      deps: f.deps,
      dataDir: "/tmp/routing-tests",
      fetch: fetcher,
    };
  const capability = await f.req("/resources/" + zone.id + "/dns-lines");
  assert.equal(capability.status, 200);
  assert.deepEqual(
    capability.body.lines.map((l: any) => l.id),
    ["0", "p1"],
  );
  assert.equal(
    (
      await f.req(
        "/resources/" + zone.id + "/dns-lines",
        "GET",
        undefined,
        "member",
      )
    ).status,
    403,
  );
  const desired = [
    {
      name: "api",
      type: "CNAME",
      value: "edge.example.test",
      line: "default",
      weight: 1,
    },
    {
      name: "api",
      type: "CNAME",
      value: "edge.example.test",
      line: "p1",
      weight: 3,
    },
  ];
  assert.equal(
    (await ensureDnsRecords(options, zone.id, "owner", desired, "admin"))
      .verified,
    true,
  );
  assert.equal(writes[1].RecordLineId, "p1");
  assert.equal(writes[1].Weight, 3);
  assert.equal(
    (
      await ensureDnsRecords(
        options,
        zone.id,
        "owner",
        desired.map((r) => ({ ...r, weight: 2 })),
        "admin",
      )
    ).verified,
    true,
  );
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.Weight === 2));
});

test("delayed indexing and failed separate weight calls cannot duplicate a known DNS record", async (t) => {
  const { ensureDnsRecords } = await import("../src/ops/cloud.js");
  const dns = dnsMock();
  let hidden = true,
    failWeight = true;
  const fetcher: typeof fetch = async (input, init) => {
    const d = Object.fromEntries(new URLSearchParams(String(init?.body)));
    if (d.Action === "UpdateDNSSLBWeight" && failWeight)
      return new Response(JSON.stringify({ Code: "InvalidParameter.Type" }));
    const response = await dns.fetcher(input, init);
    if (d.Action === "DescribeDomainRecords" && hidden) {
      const body = (await response.json()) as any;
      body.DomainRecords.Record = body.DomainRecords.Record.filter(
        (r: any) => r.RR !== "slow",
      );
      body.TotalCount = body.DomainRecords.Record.length;
      return new Response(JSON.stringify(body));
    }
    return response;
  };
  const f = await fixture(t, fetcher),
    zone = dnsZone(f),
    options: any = {
      store: f.store,
      deps: f.deps,
      dataDir: "/tmp/routing-tests",
      fetch: fetcher,
    },
    desired = [
      { name: "slow", type: "CNAME", value: "edge.example.test", weight: 1 },
    ];
  await assert.rejects(
    ensureDnsRecords(options, zone.id, "owner", desired, "admin"),
    /InvalidParameter.Type/,
  );
  assert.equal(dns.records.filter((r) => r.RR === "slow").length, 1);
  assert.ok(
    f.db.get<any>(
      "SELECT record_id FROM ops_dns_owned WHERE owner_id=?",
      "owner",
    ).record_id,
  );
  failWeight = false;
  assert.equal(
    (await ensureDnsRecords(options, zone.id, "owner", desired, "admin"))
      .verified,
    false,
  );
  assert.equal(dns.records.filter((r) => r.RR === "slow").length, 1);
  hidden = false;
  assert.equal(
    (await ensureDnsRecords(options, zone.id, "owner", desired, "admin"))
      .verified,
    true,
  );
  assert.equal(dns.records.filter((r) => r.RR === "slow").length, 1);
  dns.records.find((r) => r.RR === "slow").Weight = 7;
  await assert.rejects(
    ensureDnsRecords(options, zone.id, "owner", desired, "admin"),
    /dns_owned_record_modified_externally/,
  );
});

test("revocation between separate Aliyun SLB writes fences the remaining cloud mutation", async (t) => {
  const { ensureDnsRecords } = await import("../src/ops/cloud.js"),
    dns = dnsMock();
  let f: any;
  const fetcher: typeof fetch = async (input, init) => {
    const d = Object.fromEntries(new URLSearchParams(String(init?.body)));
    const result = await dns.fetcher(input, init);
    if (d.Action === "SetDNSSLBStatus")
      f.db.run("UPDATE users SET active=0 WHERE id='admin'");
    return result;
  };
  f = await fixture(t, fetcher);
  const zone = dnsZone(f),
    options: any = {
      store: f.store,
      deps: f.deps,
      dataDir: "/tmp/routing-tests",
      fetch: fetcher,
    };
  await assert.rejects(
    ensureDnsRecords(
      options,
      zone.id,
      "owner",
      [{ name: "api", type: "CNAME", value: "edge.example.test", weight: 1 }],
      "admin",
    ),
    /operations_authorization_revoked/,
  );
  assert.equal(
    dns.calls.some((c) => c.Action === "UpdateDNSSLBWeight"),
    false,
  );
});

test("draft service changes retain published discovery and its disabled traffic policy", async (t) => {
  const f = await fixture(t),
    a = f.createCluster(["ma"], "South"),
    b = f.createCluster(["mb"], "North"),
    old = f.app(a, {
      deployment_mode: "managed",
      deployments: [{ cluster_id: a.id, replicas: 1 }],
    }),
    next = f.app(b, {
      deployment_mode: "managed",
      deployments: [{ cluster_id: b.id, replicas: 1 }],
    });
  const site = f.store.create(
    "website",
    "Frozen service",
    {
      routing_mode: "managed",
      service_application_id: old.id,
      service_port_name: "http",
      cluster_policies: [{ cluster_id: a.id, enabled: false }],
      bindings: [
        { domains: ["frozen.example.test"], locations: [{ path: "/" }] },
      ],
    },
    "admin",
  );
  await f.action(site, "deploy");
  const draft = f.store.update(
    site.id,
    site.revision,
    site.name,
    { ...site.spec, service_application_id: next.id, cluster_policies: [] },
    "admin",
  );
  await f.platform.tick();
  assert.deepEqual(f.store.get(site.id).status.actual_cluster_ids, [a.id]);
  assert.equal(
    draft.spec.cluster_policies.find((p: any) => p.cluster_id === a.id).enabled,
    false,
  );
  assert.ok(
    (
      await f.req("/resources?kind=website&cluster_id=" + a.id)
    ).body.resources.some((r: any) => r.id === site.id),
  );
  assert.equal(
    f.db.get<any>(
      "SELECT enabled FROM ops_platform_website_deployments WHERE website_id=? AND cluster_id=?",
      site.id,
      b.id,
    ).enabled,
    0,
  );
});
