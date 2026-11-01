import {pngData,pngFixture} from './fixtures/application-logo.js';
import {createHostNetworkSchema,recordHostNetwork} from "../src/server/host-network.js";
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
import { extendedDefinitions } from "../src/ops/catalog/index.js";
import { catalogInstallation } from "../src/ops/catalog.js";
import type { Dependencies } from "../src/shared/types.js";
import { automaticRegistryAddress, registryCacheScope, registryTemplateSpec } from "../src/ops/registry-runtime.js";
import { migrateSystemApplications } from "../src/ops/system-applications.js";
import { createPrivateRegistryController } from "../src/ops/private-registry.js";
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
  t.after(async () => {
    await platform.close();
    jobs.close?.();
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return {
    base,
    db,
    deps,
    store,
    platform,
    jobs,
    req,
    createCluster,
    app,
    action,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    heartbeat(id: string) {
      db.run("UPDATE agents SET last_seen=? WHERE id=?", now.toISOString(), id);
    },
  };
}







test("OpenResty identity migration preserves immutable revisions and creates no deployment jobs", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(),
    gateway = f.store.create(
      "application",
      "Gateway",
      catalogInstallation("openresty", {
        deployments: [{ cluster_id: c.id, machine_ids: ["ma"] }],
      }).spec,
      "admin",
    );
  const legacy = { ...gateway.spec, service_name: "openresty-legacy" };
  f.db.run(
    "UPDATE ops_platform_resources SET spec_cipher=? WHERE id=?",
    f.deps.encrypt(JSON.stringify(legacy)),
    gateway.id,
  );
  f.db.run(
    "UPDATE ops_platform_application_keys SET service_name=? WHERE resource_id=?",
    "openresty-legacy",
    gateway.id,
  );
  const history = f.db.all(
      "SELECT * FROM ops_platform_revisions WHERE resource_id=?",
      gateway.id,
    ),
    jobs = f.db.all("SELECT * FROM agent_jobs");
  migrateSystemApplications(f.store);
  assert.equal(f.store.get(gateway.id).spec.service_name, "sys-openresty");
  assert.equal(f.store.get(gateway.id).revision, gateway.revision);
  assert.deepEqual(
    f.db.all(
      "SELECT * FROM ops_platform_revisions WHERE resource_id=?",
      gateway.id,
    ),
    history,
  );
  assert.deepEqual(f.db.all("SELECT * FROM agent_jobs"), jobs);
  assert.equal(
    f.db.get<any>(
      "SELECT application_id FROM ops_system_application_aliases WHERE service_name=?",
      "openresty-legacy",
    ).application_id,
    gateway.id,
  );
});
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
  historicalApplication(f,a);
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



test("catalog installs multiple ordinary MySQL applications with healthcheck and redacts secrets", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  assert.equal((await f.req("/catalog")).body.templates.length, 31);
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
  const before=databaseSnapshot(f);
  for(const resource of [site,open,a]) {
   const response=await f.action(resource,'deploy');assert.equal(response.status,409);assert.equal(response.body.error,'privileged_profile_not_implemented');
  }
  assert.deepEqual(databaseSnapshot(f),before);
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



test('confirmed catalog deployment refuses before saving an application while draft registration remains available',async t=>{
 const f=await fixture(t),c=f.createCluster();
 const input={deployments:[{cluster_id:c.id,machine_ids:['ma']}],parameters:{password:'private-password'}};
 const before=databaseSnapshot(f),response=await f.req('/catalog/redis/install','POST',{...input,confirmed:true});
 assert.equal(response.status,409);assert.equal(response.body.error,'privileged_profile_not_implemented');assert.deepEqual(databaseSnapshot(f),before);
 const draft=await f.req('/catalog/redis/install','POST',input);assert.equal(draft.status,201);assert.ok(draft.body.resource.id);assert.equal(f.store.list('application').length,1);
 assert.equal(f.db.all('SELECT * FROM agent_jobs').length,0);assert.equal(f.db.all('SELECT * FROM ops_platform_runs').length,0);
 assert.doesNotMatch(JSON.stringify(draft),/private-password/);
});

test("center website DNS reads historical gateway evidence without scheduling failover or changing reservations", async (t) => {
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
    "INSERT INTO agents SELECT 'c','hc','C',version,platform,arch,last_seen,group_id,heartbeat FROM agents WHERE id='a';INSERT INTO managed_machines(id,name,address,agent_id) VALUES('mc','Machine C','10.0.0.3','c')",
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
  historicalApplication(f,entry,{[a.id]:["ma"],[b.id]:["mb"]});
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
  historicalWebsite(f,site);
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
  assert.equal((await f.action(changed,"deploy")).status,409);
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

  f.advance(121000);
  f.heartbeat("b");
  f.heartbeat("c");
  f.db.run("UPDATE ops_cluster_instances SET last_seen=? WHERE agent_id='b'",f.deps.now().toISOString());
  const historical=f.db.all("SELECT * FROM ops_cluster_instances");
  await f.platform.tick();
  await settle();
  await f.platform.tick();
  await settle();
  assert.deepEqual(
    records
      .filter((r) => r.RR === "global")
      .map((r) => r.Value)
      .sort(),
    ["203.0.113.2"],
  );
  assert.ok(records.some((r) => r.RecordId === "external"));
  assert.ok(
    f.db.get(
      "SELECT port FROM ops_platform_ports WHERE agent_id='a' AND port=80",
    ),
  );
  assert.equal(f.store.get(site.id).status.deployments[a.id].active, false);
  assert.equal(f.store.get(site.id).status.deployments[b.id].active, true);
  assert.deepEqual(f.db.all("SELECT * FROM ops_cluster_instances"),historical);
  assert.equal(f.db.all("SELECT * FROM agent_jobs").length,0);
});
test("single-cluster 042 state normalizes in place without changing instances, storage identity or creating jobs", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(["ma"]),
    app = f.app(c, { environment: { PASSWORD: "migration-secret" } });
  historicalApplication(f,app);
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



test('all approved catalog applications save through HTTP, isolate identity and redact secrets', async t => {
 const f=await fixture(t),c=f.createCluster(['ma']);
 const list=await f.req('/catalog');assert.equal(list.body.templates.length,31);
 for(const {template} of extendedDefinitions){
  const parameters=Object.fromEntries(template.parameters.filter(p=>p.required||p.default!==undefined).map(p=>[p.key,p.default??p.example??(p.type==='password'?'qa_secret_2026':p.format==='url'?'http://app.example.test':p.format==='ip'?'192.0.2.10':p.format==='host'?'broker.example.test':'app')]));
  const result=await f.req('/catalog/'+template.id+'/install','POST',{parameters,deployments:[{cluster_id:c.id,machine_ids:['ma'],cpu:.25,memory_mb:128}],confirmed:false});
  assert.equal(result.status,201,template.id+':'+JSON.stringify(result.body));
  assert.equal(result.body.resource.spec.source.template_id,template.id);
  assert.doesNotMatch(JSON.stringify(result.body),/qa_secret_2026/);
  assert.doesNotMatch(JSON.stringify(f.db.get<any>('SELECT spec_cipher FROM ops_platform_resources WHERE id=?',result.body.resource.id)),/qa_secret_2026/);
  assert.equal(f.store.get(result.body.resource.id).spec.deployment_mode,'manual');
 }
 const bad=await f.req('/catalog/dbx/install','POST',{parameters:{password:'short'},deployments:[{cluster_id:c.id,machine_ids:['ma']}]});assert.equal(bad.status,400);
 f.db.run("UPDATE agents SET arch='arm64' WHERE id='a'");
 const badArch=await f.req('/catalog/harbor/install','POST',{parameters:{external_url:'https://registry.example.test',password:'qa_secret_2026'},deployments:[{cluster_id:c.id,machine_ids:['ma']}]});
 assert.equal(badArch.status,400);assert.equal(badArch.body.error,'catalog_architecture_unsupported');
});

test('application logos save atomically through HTTP and remain independent of configuration and Agent jobs',async t=>{
 const f=await fixture(t),c=f.createCluster(),original=f.app(c);const {service_name,...spec}=original.spec;
 const created=await f.req('/resources','POST',{kind:'application',name:'Custom logo',spec,logo:pngData()});assert.equal(created.status,201);let r=created.body.resource;assert.equal(r.logo_revision,1);assert.equal(r.revision,1);assert.equal(r.spec.logo,undefined);
 const url=r.logo_url,raw=await fetch(f.base+url);assert.equal(raw.status,200);assert.equal(raw.headers.get('content-type'),'image/png');assert.equal(raw.headers.get('x-content-type-options'),'nosniff');assert.match(raw.headers.get('content-security-policy')!,/sandbox/);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),pngFixture());
 assert.equal((await fetch(f.base+url,{headers:{'if-none-match':raw.headers.get('etag')!}})).status,304);assert.equal((await fetch(f.base+url,{headers:{'x-role':'member','if-none-match':raw.headers.get('etag')!}})).status,403);
 const jobsBefore=f.db.get<any>('SELECT count(*) AS n FROM agent_jobs')!.n,revisionsBefore=f.db.get<any>('SELECT count(*) AS n FROM ops_platform_revisions')!.n;
 const updated=await f.req('/resources/'+r.id+'/logo','PUT',{revision:1,data_url:pngData(pngFixture(2,2,20))});assert.equal(updated.status,200);r=updated.body.resource;assert.equal(r.logo_revision,2);assert.equal(r.revision,1);assert.notEqual(r.logo_url,url);assert.equal((await fetch(f.base+url)).status,404);
 assert.equal(f.db.get<any>('SELECT count(*) AS n FROM agent_jobs')!.n,jobsBefore);assert.equal(f.db.get<any>('SELECT count(*) AS n FROM ops_platform_revisions')!.n,revisionsBefore);
 assert.equal((await f.req('/resources/'+r.id+'/logo','PUT',{revision:1,data_url:null})).status,409);assert.equal((await f.req('/resources/'+r.id+'/logo','PUT',{revision:2,data_url:null},'member')).status,403);
 const count=f.store.list('application').length;assert.equal((await f.req('/resources','POST',{kind:'application',name:'Invalid logo',spec,logo:'data:image/svg+xml;base64,PHN2Zy8+'})).status,400);assert.equal(f.store.list('application').length,count);
 assert.equal((await f.req('/resources/'+r.id+'/logo','PUT',{revision:2,data_url:null})).body.resource.logo_revision,3);assert.equal((await fetch(f.base+r.logo_url)).status,404);
});

test('advanced YAML preserves secrets and port identities while managed scheduling ignores published ports',async t=>{
 const f=await fixture(t),c=f.createCluster(),r=f.app(c,{mode:'compose',deployment_mode:'managed',compose:{services:{web:{image:'nginx:alpine',environment:{TOKEN:'qa-yaml-password'},ports:['8080:8080']}}},ports:[{name:'http',service:'web',container_port:8080,host_port:0,host_ip:'127.0.0.1',protocol:'tcp',app_protocol:'http'}]});
 const legacy=structuredClone(r.spec);legacy.compose['x-private-env']=legacy.compose.services.web.environment;f.db.run('UPDATE ops_platform_resources SET spec_cipher=? WHERE id=?',f.deps.encrypt(JSON.stringify(legacy)),r.id);const legacyRead=await f.req('/resources/'+r.id);assert.doesNotMatch(JSON.stringify(legacyRead.body),/qa-yaml-password/);assert.equal(legacyRead.body.resource.spec.compose['x-private-env'],undefined);
 const text='x-env: &shared\n  TOKEN: "[redacted]"\nservices:\n  web:\n    image: nginx:alpine\n    environment: *shared\n    ports:\n      - "12345:8080"\n      - "5123:5555/udp"\n    expose: [6379]\n';
 const saved=await f.req('/resources/'+r.id,'PUT',{revision:r.revision,spec:{...r.spec,configuration_mode:'yaml',compose:text}});assert.equal(saved.status,200);const result=saved.body.resource,actual=f.store.get(r.id).spec;
 assert.equal(actual.compose.services.web.environment.TOKEN,'qa-yaml-password');assert.doesNotMatch(JSON.stringify(result),/qa-yaml-password/);assert.equal(actual.compose['x-env'],undefined);
 assert.equal(actual.ports.length,2);assert.equal(actual.ports[0].name,'http');assert.equal(actual.ports[0].host_ip,'127.0.0.1');assert.ok(actual.ports.every((p:any)=>p.host_port===0));assert.equal(actual.ports[1].container_port,5555);assert.equal(actual.ports[1].protocol,'udp');assert.ok(!actual.ports.some((p:any)=>p.container_port===6379));assert.ok(!JSON.stringify(actual.compose.services.web.ports).includes('12345'));
 const bad=await f.req('/resources/'+r.id,'PUT',{revision:result.revision,spec:{...actual,compose:'services:\n  web:\n    image: nginx:alpine\n    environment:\n      NEW_TOKEN: "[redacted]"\n'}});assert.equal(bad.status,400);assert.equal(bad.body.error,'environment_value_required');assert.equal(f.store.get(r.id).revision,result.revision);
});

test('single-container advanced YAML keeps runtime type and managed mounts; manual YAML mappings take effect',async t=>{
 const f=await fixture(t),c=f.createCluster(),r=f.app(c,{environment:{TOKEN:'qa-single-secret'},mounts:[{type:'data',target:'/data'}]});
 const yaml='services:\n  app:\n    image: nginx:alpine\n    environment:\n      TOKEN: "[redacted]"\n    ports:\n      - "127.0.0.1:23456:8080"\n';
 const saved=await f.req('/resources/'+r.id,'PUT',{revision:r.revision,spec:{...r.spec,configuration_mode:'yaml',configuration_yaml:yaml}});assert.equal(saved.status,200);const spec=f.store.get(r.id).spec;assert.equal(spec.mode,'container');assert.equal(spec.environment.TOKEN,'qa-single-secret');assert.equal(spec.ports[0].name,'http');assert.equal(spec.ports[0].host_port,23456);assert.equal(spec.ports[0].host_ip,'127.0.0.1');assert.equal(spec.mounts[0].target,'/data');assert.equal(spec.configuration_yaml,undefined);
 const bad=await f.req('/resources/'+r.id,'PUT',{revision:saved.body.resource.revision,spec:{...spec,configuration_yaml:'services:\n  app:\n    image: nginx:alpine\n    volumes: ["/etc:/escape"]\n'}});assert.equal(bad.status,400);assert.equal(bad.body.error,'single_container_yaml_unsupported_field');
 const malformed=await f.req('/resources/'+r.id,'PUT',{revision:saved.body.resource.revision,spec:{...spec,configuration_yaml:'services: ['}});assert.equal(malformed.status,400);assert.equal(f.store.get(r.id).revision,saved.body.resource.revision);
});

function rebindForRecovery(f:any) {
  f.db.run("UPDATE agents SET last_seen='2020-01-01T00:00:00Z' WHERE id='a'");
  f.db.run("INSERT INTO agents SELECT 'c','hc','C',version,platform,arch,'2026-10-29T02:00:00.000Z',group_id,? FROM agents WHERE id='b'",JSON.stringify({operations_capabilities:['operations.platform.instance-recovery.v1']}));
  f.db.run("UPDATE managed_machines SET agent_id='c' WHERE id='ma'");
}



test('global image source settings preserve admin CAS without restoring Agent execution',async t=>{
  const f=await fixture(t);assert.equal((await f.req('/image-sources','GET',undefined,'member')).status,403);
  const settings=await f.req('/image-sources');assert.deepEqual(settings.body.rules,[]);
  const rule={source:'docker.io',target:'https://mirror.example.test/docker.io',allow_upstream:false};
  const saved=await f.req('/image-sources','PUT',{revision:0,rules:[rule]});assert.equal(saved.status,200);assert.equal(saved.body.revision,1);
  assert.equal((await f.req('/image-sources','PUT',{revision:0,rules:[]})).status,409);
  assert.equal((await f.req('/image-sources','PUT',{revision:1,rules:[{...rule,target:'http://bad.test'}]})).status,400);
  const c=f.createCluster(['ma']),a=f.app(c),before=databaseSnapshot(f);
  const rejected=await f.action(a,'deploy');assert.equal(rejected.status,409);assert.equal(rejected.body.error,'privileged_profile_not_implemented');assert.deepEqual(databaseSnapshot(f),before);
  f.db.run("UPDATE agents SET heartbeat=? WHERE id='a'",JSON.stringify({operations_capabilities:['operations.platform.image-sources.v1']}));
  const afterHeartbeat=databaseSnapshot(f),again=await f.action(a,'deploy');assert.equal(again.status,409);assert.deepEqual(databaseSnapshot(f),afterHeartbeat);
  assert.equal(f.db.all('SELECT * FROM agent_jobs').length,0);
  assert.equal((await f.req('/image-sources','PUT',{revision:1,rules:[]})).status,200);
});





function databaseSnapshot(f:any) {
 return f.db.all<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(({name}:any)=>({name,rows:f.db.all('SELECT * FROM "'+name+'"')}));
}
// Historical applied rows are fixture evidence, never a simulated response from a removed execution API.
function historicalApplication(f:any,application:any,assignments:Record<string,string[]>={}) {
 const at=f.deps.now().toISOString();
 for(const deployment of application.spec.deployments) {
  f.db.run("UPDATE ops_platform_application_deployments SET desired_revision=?,enabled=1,policy_actor='admin',status_json='{}' WHERE application_id=? AND cluster_id=?",application.revision,application.id,deployment.cluster_id);
  const cluster=f.store.get(deployment.cluster_id),keys=assignments[deployment.cluster_id]??(application.spec.deployment_mode==='manual'?deployment.machine_ids:cluster.spec.machine_ids.slice(0,deployment.replicas));
  for(const machineID of keys) {
   const machine=f.db.get<any>('SELECT * FROM managed_machines WHERE id=?',machineID),id=application.id+'-'+deployment.cluster_id+'-'+machineID;
   if(f.db.get('SELECT id FROM ops_cluster_instances WHERE id=?',id))continue;
   f.db.run(`INSERT INTO ops_cluster_instances(id,owner_id,machine_id,agent_id,slot,cluster_id,state,healthy,last_seen,desired_generation,observed_generation,observed_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,application.id,machineID,machine.agent_id,machineID,deployment.cluster_id,'running',1,at,'historical-generation','historical-generation',JSON.stringify({running:true,containers:[{running:true}]}),at,at);
   for(const p of application.spec.ports) {
    let port=deployment.host_ports?.[p.name]||p.host_port||21000;
    while(f.db.get('SELECT instance_id FROM ops_platform_ports WHERE agent_id=? AND protocol=? AND port=?',machine.agent_id,p.protocol,port))port++;
    f.db.run('INSERT INTO ops_platform_ports VALUES(?,?,?,?)',machine.agent_id,p.protocol,port,id);
    f.db.run('INSERT INTO ops_platform_instance_ports VALUES(?,?,?,?,?,?,?,?)',id,p.name,p.service??'',p.container_port,port,p.protocol,p.app_protocol??'',p.host_ip??'0.0.0.0');
   }
  }
 }
}
function historicalWebsite(f:any,site:any) {
 for(const cid of site.spec.cluster_ids) {
  const gateway=f.db.get<any>("SELECT application_id FROM ops_platform_application_deployments WHERE cluster_id=? AND role='openresty'",cid);
  const instances=Object.fromEntries((gateway?f.db.all<any>('SELECT id FROM ops_cluster_instances WHERE owner_id=? AND cluster_id=?',gateway.application_id,cid):[]).map((i:any)=>[i.id,{state:'succeeded',revision:site.revision,enabled:true}]));
  f.db.run('INSERT INTO ops_platform_website_deployments(website_id,cluster_id,desired_revision,enabled,policy_actor,status_json) VALUES(?,?,?,?,?,?) ON CONFLICT(website_id,cluster_id) DO UPDATE SET desired_revision=excluded.desired_revision,enabled=excluded.enabled,policy_actor=excluded.policy_actor,status_json=excluded.status_json',site.id,cid,site.revision,1,'admin',JSON.stringify({instances,active:true,synchronized:true}));
 }
}

test('all clustered host operations reject before mutating desired state, reservations, runs or jobs',async t=>{
 const f=await fixture(t),c=f.createCluster(),a=f.app(c),site=f.store.create('website','Draft site',{cluster_ids:[c.id],bindings:[{domains:['draft.example.test'],locations:[{path:'/',action:'return',return_status:200,return_value:'draft'}]}]},'admin');
 for(const [resource,actions] of [[c,['inspect']],[a,['deploy','inspect','stop','remove','logs']],[site,['deploy','disable']]] as const){
  for(const action of actions){const before=databaseSnapshot(f),response=await f.action(resource,action);assert.equal(response.status,409,action);assert.equal(response.body.error,'privileged_profile_not_implemented');assert.deepEqual(databaseSnapshot(f),before,action);}
 }
});

test('private registry HTTP and direct writes cannot publish settings, create apps or dispatch an Agent',async t=>{
 const f=await fixture(t),c=f.createCluster(),controller=createPrivateRegistryController(f.store,{} as any);
 for(const [path,method] of [['/deployments','POST'],['/external','PUT'],['/clusters/'+c.id+'/cache','PUT']]) {
  const before=databaseSnapshot(f),response=await f.req('/private-registry'+path,method,{confirmed:true,revision:0,cluster_id:c.id,machine_id:'ma',enabled:true});
  assert.equal(response.status,409);assert.equal(response.body.error,'privileged_profile_not_implemented');assert.deepEqual(databaseSnapshot(f),before);
 }
 for(const run of [()=>controller.deploy({},'admin'),()=>controller.setCache(c.id,{},'admin'),()=>controller.external({},'admin')]){
  const before=databaseSnapshot(f);await assert.rejects(run(),e=>(e as any).status===409&&(e as Error).message==='privileged_profile_not_implemented');assert.deepEqual(databaseSnapshot(f),before);
 }
 const before=databaseSnapshot(f);await controller.tick();assert.deepEqual(await controller.syncClusterCache(c,'admin'),{});assert.deepEqual(databaseSnapshot(f),before);
 const read=await f.req('/private-registry');assert.equal(read.status,200);assert.deepEqual(read.body.deployments,[]);assert.equal(read.body.application,null);
});

test('historical clustered unknown and stopped ownership is retained across rebind, ticks and rejected recovery',async t=>{
 for(const state of ['running','unknown','stopped']) {
  const f=await fixture(t),c=f.createCluster(['ma']),a=f.app(c,{stateful:state==='stopped'});
  historicalApplication(f,a);
  const old=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id),at=f.deps.now().toISOString(),runID='historical-'+state,jobID=runID+'-job';
  f.db.run('INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,capabilities_json,actions_json,target_json,issued_at,expires_at,attempts,receipt_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',jobID,'a',a.id,runID,state==='unknown'?'unknown':'succeeded','["operations.platform"]',JSON.stringify([{kind:'operations',operation_id:runID,domain:'platform'}]),'{}',at,at,1,JSON.stringify({historical:true}),at,at);
  f.db.run('INSERT INTO ops_platform_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',runID,a.id,1,'a','deploy',state==='unknown'?'unknown':'succeeded','unreadable-private-history',JSON.stringify({historical:true}),jobID,'admin',null,at,at);
  f.db.run('UPDATE ops_cluster_instances SET state=?,healthy=?,desired_state=?,current_run_id=? WHERE id=?',state,state==='running'?1:0,state==='stopped'?'stopped':'running',runID,old.id);
  rebindForRecovery(f);const before=databaseSnapshot(f);
  for(const action of ['deploy','inspect','stop','remove']){const r=await f.action(a,action);assert.equal(r.status,409);assert.equal(r.body.error,'privileged_profile_not_implemented');}
  for(let n=0;n<3;n++){f.advance(31000);await f.platform.tick();}
  assert.deepEqual(databaseSnapshot(f),before);assert.equal(f.db.get<any>('SELECT retired FROM ops_cluster_instances WHERE id=?',old.id).retired,0);assert.equal(f.db.all('SELECT * FROM ops_platform_ports WHERE instance_id=?',old.id).length,2);
  let privateReads=0;f.deps.decrypt=()=>{privateReads++;throw Error('private history decrypted');};
  assert.throws(()=>f.platform.resolvePayload(f.jobs.get(jobID)),e=>(e as any).status===410&&(e as Error).message==='legacy_agent_payload_removed');assert.equal(privateReads,0);
  assert.throws(()=>f.jobs.claim('c',['operations.platform','operations.platform.instance-recovery.v1']),/privileged_executor_required/);
 }
});

test('cluster endpoint read keeps frozen revisions, named ports and independent namespace without dispatch',async t=>{
 const f=await fixture(t),a=f.createCluster(['ma'],'A'),b=f.createCluster(['mb'],'B'),app=f.app(a,{deployments:[{cluster_id:a.id,machine_ids:['ma']},{cluster_id:b.id,machine_ids:['mb']}],environment:{PASSWORD:'historical-private'}});
 historicalApplication(f,app);const host=f.db.all('SELECT * FROM ops_cluster_instances'),ports=f.db.all('SELECT * FROM ops_platform_ports');
 for(const [cluster,machine] of [[a,'ma'],[b,'mb']] as const){const response=await f.req('/resources/'+app.id+'/endpoints?cluster_id='+cluster.id);assert.equal(response.status,200);assert.equal(response.body.endpoints.length,2);assert.ok(response.body.endpoints.every((p:any)=>p.cluster_id===cluster.id&&p.machine_id===machine));assert.deepEqual(response.body.endpoints.map((p:any)=>p.port_name).sort(),['admin','http']);assert.doesNotMatch(JSON.stringify(response),/historical-private/);}
 const changed=f.store.update(app.id,app.revision,app.name,{...app.spec,image:'example:2'},'admin');assert.equal(changed.revision,2);
 for(const row of f.db.all<any>('SELECT desired_revision FROM ops_platform_application_deployments WHERE application_id=?',app.id))assert.equal(row.desired_revision,1);
 assert.deepEqual(f.db.all('SELECT * FROM ops_cluster_instances'),host);assert.deepEqual(f.db.all('SELECT * FROM ops_platform_ports'),ports);assert.equal(f.db.all('SELECT * FROM agent_jobs').length,0);
});


test('registry identity, host networking and pure cache validation remain available without installation',async t=>{
 const f=await fixture(t),c=f.createCluster();
 assert.equal((await f.req('/private-registry','GET',undefined,'member')).status,403);
 assert.throws(()=>f.app(c,{service_name:'sys-stolen'}),/system_service_name_reserved/);
 assert.throws(()=>f.app(c,{role:'registry'}),/system_registry_management_required/);
 for(let n=0;n<2;n++)f.store.create('application','Business registry',catalogInstallation('registry',{deployments:[{cluster_id:c.id,machine_ids:['ma']}]}).spec,'admin');
 assert.equal((await f.req('/private-registry')).body.application,null);
 f.db.run("UPDATE managed_machines SET address='ssh.example.test' WHERE id='ma'");
 recordHostNetwork(f.db,'ma','a',normalizeNetworkAddresses([{interface:'docker0',address:'172.17.0.1'},{interface:'eth0',address:'10.55.0.9'},{interface:'eth0',address:'198.51.100.9'}]),undefined,f.deps.now().toISOString());
 assert.equal(automaticRegistryAddress(f.store,'ma'),'10.55.0.9');assert.equal(registryCacheScope('10.55.0.9'),'cluster');
 recordHostNetwork(f.db,'mb','b',normalizeNetworkAddresses([{interface:'eth0',address:'198.51.100.42'}]),undefined,f.deps.now().toISOString());
 assert.equal(automaticRegistryAddress(f.store,'mb'),'127.0.0.1');assert.equal(registryCacheScope('127.0.0.1'),'machine');
 const registry=f.store.createSystemApplication('registry','Historical system registry',{...registryTemplateSpec(),deployments:[{cluster_id:c.id,machine_ids:['ma'],registry_address:'10.55.0.9'}]},'admin');
 const changed=f.store.update(c.id,c.revision,c.name,{...c.spec,image_cache:{enabled:true}},'admin');
 const controller=createPrivateRegistryController(f.store,{perform:async()=>{throw Error('legacy registry publication attempted');}} as any),before=databaseSnapshot(f);
 assert.deepEqual(await controller.syncClusterCache(changed,'admin'),{cache_pending:'privileged_profile_not_implemented'});await controller.tick();assert.deepEqual(databaseSnapshot(f),before);
 assert.equal(controller.overview().application?.id,registry.id);assert.equal(controller.overview().deployments[0].status.cache_pending,true);
 assert.throws(()=>f.store.remove(registry.id,registry.revision),/system_registry_in_use/);
});

test('per-cluster port override validation persists without executing or altering other cluster mappings',async t=>{
 const f=await fixture(t),a=f.createCluster(['ma'],'A'),b=f.createCluster(['mb'],'B');
 const input={deployments:[{cluster_id:a.id,machine_ids:['ma'],host_ports:{http:18080,admin:19090}},{cluster_id:b.id,machine_ids:['mb'],host_ports:{http:28080,admin:29090}}]};
 const app=f.app(a,input);assert.deepEqual(app.spec.deployments.map((d:any)=>d.host_ports),input.deployments.map(d=>d.host_ports));
 for(const host_ports of [{http:5000,admin:5000},{http:'5000'},{unknown:5000}]) {
  const before=databaseSnapshot(f);assert.throws(()=>f.store.update(app.id,app.revision,app.name,{...app.spec,deployments:[{...app.spec.deployments[0],host_ports},app.spec.deployments[1]]},'admin'),/host_port|invalid/);assert.deepEqual(databaseSnapshot(f),before);
 }
 const before=databaseSnapshot(f);for(const cluster_id of [a.id,b.id]){const response=await f.action(app,'deploy',{cluster_id});assert.equal(response.status,409);assert.equal(response.body.error,'privileged_profile_not_implemented');}assert.deepEqual(databaseSnapshot(f),before);
});

test('multi-cluster website previews keep named-port scope and resource references without host execution',async t=>{
 const f=await fixture(t),a=f.createCluster(['ma'],'A'),b=f.createCluster(['mb'],'B'),app=f.app(a,{deployments:[{cluster_id:a.id,machine_ids:['ma'],cpu:0.5,memory_mb:128},{cluster_id:b.id,machine_ids:['mb'],cpu:1.5,memory_mb:512}]});
 historicalApplication(f,app);
 assert.equal(app.spec.deployments[0].cpu,0.5);assert.equal(app.spec.deployments[1].cpu,1.5);
 assert.equal((await f.req('/resources/'+app.id+'/endpoints')).status,400);
 assert.ok((await f.req('/resources?cluster_id='+b.id)).body.resources.some((r:any)=>r.id===app.id));
 const scope={cluster_ids:[a.id,b.id],bindings:[{domains:['global.example.test'],locations:[{path:'/',proxy_read_timeout:45,cluster_targets:[{cluster_id:a.id,target:'application',application_id:app.id,port_name:'http'},{cluster_id:b.id,target:'application',application_id:app.id,port_name:'admin'}]}]}]};
 const site=f.store.create('website','Global',scope,'admin'),before=f.db.all('SELECT * FROM ops_cluster_instances');
 const ca=await f.req('/resources/'+site.id+'/nginx?cluster_id='+a.id),cb=await f.req('/resources/'+site.id+'/nginx?cluster_id='+b.id);
 assert.equal(ca.status,200);assert.match(ca.body.config,/10\.0\.0\.1/);assert.doesNotMatch(ca.body.config,/10\.0\.0\.2/);
 assert.equal(cb.status,200);assert.match(cb.body.config,/10\.0\.0\.2/);assert.doesNotMatch(cb.body.config,/10\.0\.0\.1/);
 assert.throws(()=>f.store.update(app.id,1,app.name,{...app.spec,deployments:[app.spec.deployments[0]]},'admin'),/application_deployment_in_use/);
 const invalid:any=structuredClone(scope);invalid.bindings[0].locations[0].cluster_targets[1].proxy_read_timeout=9;
 assert.throws(()=>f.store.create('website','Invalid',invalid,'admin'),/website_cluster_override_not_supported/);
 const single=f.app(a),missing=structuredClone(scope);missing.bindings[0].locations[0].cluster_targets[1].application_id=single.id;
 assert.throws(()=>f.store.create('website','Missing',missing,'admin'),/application_not_deployed_in_cluster/);
 assert.deepEqual(f.db.all('SELECT * FROM ops_cluster_instances'),before);assert.equal(f.db.all('SELECT * FROM agent_jobs').length,0);
});
