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
