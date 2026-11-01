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
import { registryCacheFor } from "../src/ops/registry-runtime.js";
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
  const finish = (
    agentID: string,
    data: any = {
      healthy: true,
      running: true,
      containers: [{ running: true }],
    },
    state = "succeeded",
  ) => {
    const job = jobs.claim(agentID, ["operations.platform","operations.platform.image-cache.v1","operations.platform.image-sources.v1","operations.platform.instance-recovery.v1"]);
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
    finish,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    heartbeat(id: string) {
      db.run("UPDATE agents SET last_seen=? WHERE id=?", now.toISOString(), id);
    },
  };
}
test("private registry registration is host owned, coexists with business registries and shares the cluster cache switch", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  assert.equal(
    (await f.req("/private-registry", "GET", undefined, "member")).status,
    403,
  );
  assert.equal((await f.req("/private-registry")).body.application, null);
  assert.throws(
    () => f.app(c, { service_name: "sys-stolen" }),
    /system_service_name_reserved/,
  );
  assert.throws(
    () => f.app(c, { role: "registry" }),
    /system_registry_management_required/,
  );
  assert.equal(
    (
      await f.req("/private-registry/clusters/" + c.id + "/cache", "PUT", {
        revision: c.revision,
        enabled: true,
      })
    ).status,
    409,
  );
  for (let n = 0; n < 2; n++)
    f.store.create(
      "application",
      "Business registry",
      catalogInstallation("registry", {
        deployments: [{ cluster_id: c.id, machine_ids: ["ma"] }],
      }).spec,
      "admin",
    );
  assert.equal((await f.req("/private-registry")).body.application, null);
  const installed = await f.req("/private-registry/deployments", "POST", {
    confirmed: true,
    trusted_network_acknowledged: true,
    revision: 0,
    cluster_id: c.id,
    machine_id: "ma",
    address: "10.0.0.1",
    cache_enabled: true,
  });
  assert.equal(installed.status, 201, JSON.stringify(installed.body));
  let view = (await f.req("/private-registry")).body;
  assert.equal(view.application.spec.service_name, "sys-docker-registry");
  assert.equal(view.deployments[0].cache_enabled, true);
  const { payload } = f.finish("a");
  assert.equal(
    payload.resource.config.application.compose.services.hub_cache.environment
      .REGISTRY_PROXY_REMOTEURL,
    "https://registry-1.docker.io",
  );
  assert(!payload.resource.config.application.compose.services.origin_cache);
  assert.equal(
    payload.resource.config.application.compose.services.registry.ports[0]
      .host_ip,
    "10.0.0.1",
  );
  // The ordinary cluster editor uses the same cache setting and publishes the new runtime.
  const cluster = f.store.get(c.id),
    saved = await f.req("/resources/" + c.id, "PUT", {
      revision: cluster.revision,
      spec: { ...cluster.spec, image_cache: { enabled: false } },
    });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  view = (await f.req("/private-registry")).body;
  assert.equal(view.deployments[0].cache_enabled, false);
  assert.equal(
    view.application.spec.deployments[0].registry_cache_enabled,
    false,
  );
  assert.equal(
    (
      await f.req("/resources/" + view.application.id, "PUT", {
        revision: view.application.revision,
        spec: view.application.spec,
      })
    ).status,
    403,
  );
  f.finish("a");
  assert.throws(
    () => f.store.remove(view.application.id, view.application.revision),
    /system_registry_in_use/,
  );
});
test('registry ports are independently persisted per cluster and survive resource-only redeployment',async t=>{
 const f=await fixture(t),a=f.createCluster(['ma'],'A'),b=f.createCluster(['mb'],'B');
 const deploy=async(c:any,m:string,address:string,host_ports:any,revision:number)=>f.req('/private-registry/deployments','POST',{confirmed:true,trusted_network_acknowledged:true,revision,cluster_id:c.id,machine_id:m,address,...(host_ports===undefined?{}:{host_ports})});
 let r=await deploy(a,'ma','10.0.0.1',{registry:15000,'hub-cache':15001,'origin-cache':15002},0);assert.equal(r.status,201,JSON.stringify(r.body));
 let payload=f.finish('a').payload;assert.equal(payload.resource.config.application.compose.services.registry.ports[0].published,'15000');
 r=await deploy(b,'mb','10.0.0.2',{registry:16000,'hub-cache':16001,'origin-cache':16002},r.body.revision);assert.equal(r.status,201,JSON.stringify(r.body));f.finish('b');
 r=await deploy(a,'ma','10.0.0.1',undefined,r.body.revision);assert.equal(r.status,201,JSON.stringify(r.body));payload=f.finish('a').payload;assert.equal(payload.resource.config.application.compose.services.registry.ports[0].published,'15000');
 const view=(await f.req('/private-registry')).body;
 assert.equal(view.deployments.find((d:any)=>d.cluster_id===a.id).host_ports.registry,15000);
 assert.equal(view.deployments.find((d:any)=>d.cluster_id===b.id).host_ports.registry,16000);
 assert.equal(view.deployments.find((d:any)=>d.cluster_id===a.id).endpoint,'http://10.0.0.1:15000');
 for(const ports of [{registry:5000,'hub-cache':5000},{registry:'5000'},{unknown:5000}]){
  const bad=await deploy(a,'ma','10.0.0.1',ports,view.revision);assert.equal(bad.status,400,JSON.stringify(bad.body));
 }
 assert.equal((await f.req('/private-registry')).body.revision,view.revision);
 const changed=await deploy(a,'ma','10.0.0.1',{registry:15005,'hub-cache':15001,'origin-cache':15002},view.revision);
 assert.equal(changed.status,201);
 assert(f.db.get('SELECT * FROM ops_platform_ports WHERE agent_id=? AND port=?','a',15000),'previous binding remains reserved while replacement is in flight');
 const next=f.finish('a').payload;
 assert.equal(next.resource.config.application.compose.services.registry.ports[0].published,'15005');
 assert.equal(f.db.get('SELECT * FROM ops_platform_ports WHERE agent_id=? AND port=?','a',15000),undefined,'verified replacement releases previous binding');
 assert.equal((await f.req('/private-registry')).body.deployments.find((d:any)=>d.cluster_id===b.id).host_ports.registry,16000);
});
test('generic cluster port overrides reach the immutable Agent payload without changing other clusters',async t=>{
 const f=await fixture(t),a=f.createCluster(['ma'],'A'),b=f.createCluster(['mb'],'B');
 const app=f.app(a,{deployments:[{cluster_id:a.id,machine_ids:['ma'],host_ports:{http:18080,admin:19090}},{cluster_id:b.id,machine_ids:['mb'],host_ports:{http:28080,admin:29090}}]});
 assert.equal((await f.action(app,'deploy',{cluster_id:a.id})).status,202);
 assert.equal((await f.action(app,'deploy',{cluster_id:b.id})).status,202);
 assert.equal(f.finish('a').payload.resource.config.application.ports.find((p:any)=>p.container_port===8080).host_port,18080);
 assert.equal(f.finish('b').payload.resource.config.application.ports.find((p:any)=>p.container_port===8080).host_port,28080);
});
test("registry external entry owns one HTTPS/Basic website and cannot silently switch storage or remove its protection", async (t) => {
  const f = await fixture(t),
    c = f.createCluster(["ma"], "Source"),
    other = f.createCluster(["mb"], "Other");
  const install = () =>
    f.req("/private-registry/deployments", "POST", {
      confirmed: true,
      trusted_network_acknowledged: true,
      revision: 0,
      cluster_id: c.id,
      machine_id: "ma",
      address: "10.0.0.1",
    });
  assert.equal((await install()).status, 201);
  f.finish("a");
  const cert = f.store.create(
    "certificate",
    "TLS",
    {
      source: "self_signed",
      domains: ["registry.example.test"],
      validity_days: 3,
    },
    "admin",
  );
  const input = {
    confirmed: true,
    revision: 0,
    carrier_cluster_id: c.id,
    domain: "registry.example.test",
    certificate_id: cert.id,
    username: "builder",
    password: "qa-strong-password",
    install_openresty: true,
  };
  const configured = await f.req("/private-registry/external", "PUT", input);
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  let view = (await f.req("/private-registry")).body,
    site = view.external.website;
  assert.equal(view.external.carrier_cluster_id, c.id);
  assert.equal(site.spec.auth.mode, "basic");
  assert.equal(site.spec.bindings[0].https, true);
  assert(!JSON.stringify(view).includes("password_hash"));
  assert(!JSON.stringify(view).includes(input.password));
  assert.equal(
    f.store.list("application").find((a) => a.spec.role === "openresty")!.spec
      .service_name,
    "sys-openresty",
  );
  const consumer = f.app(c, { image: "registry.example.test/team/private:v1" });
  const direct = registryCacheFor(f.store, {
    ...consumer,
    spec: { ...consumer.spec, cluster_id: c.id },
  });
  assert.equal(direct?.origin_mode, "direct");
  assert.equal(direct?.origin_endpoint, "http://10.0.0.1:21000");
  assert.equal(direct?.hub_endpoint, undefined);
  const unmatched = f.app(c, { image: "nginx:alpine" });
  assert.equal(
    registryCacheFor(f.store, {
      ...unmatched,
      spec: { ...unmatched.spec, cluster_id: c.id },
    }),
    undefined,
  );
  const tampered = await f.req("/resources/" + site.id, "PUT", {
    revision: site.revision,
    spec: { ...site.spec, auth: { mode: "off" } },
  });
  assert.equal(tampered.status, 409);
  assert.throws(
    () => f.store.remove(site.id, site.revision),
    /registry_website_in_use|platform_resource_busy/,
  );
  const hash = f.store.get(site.id).spec.auth.users[0].password_hash;
  const updated = await f.req("/private-registry/external", "PUT", {
    ...input,
    revision: view.external.revision,
    website_revision: site.revision,
    password: "",
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(f.store.get(site.id).spec.auth.users[0].password_hash, hash);
  view = (await f.req("/private-registry")).body;
  assert.equal(
    (
      await f.req("/private-registry/deployments", "POST", {
        confirmed: true,
        trusted_network_acknowledged: true,
        revision: view.revision,
        cluster_id: c.id,
        machine_id: "mb",
        address: "10.0.0.2",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.req("/private-registry/external", "PUT", {
        ...input,
        revision: view.external.revision,
        website_revision: view.external.website.revision,
        carrier_cluster_id: other.id,
      })
    ).status,
    400,
  );
  const added = await f.req("/private-registry/deployments", "POST", {
    confirmed: true,
    trusted_network_acknowledged: true,
    revision: view.revision,
    cluster_id: other.id,
    machine_id: "mb",
    address: "10.0.0.2",
  });
  assert.equal(added.status, 201);
  view = (await f.req("/private-registry")).body;
  assert.equal(view.deployments.length, 2);
  assert.equal(
    (
      await f.req("/private-registry/external", "PUT", {
        ...input,
        revision: view.external.revision,
        website_revision: view.external.website.revision,
        carrier_cluster_id: other.id,
      })
    ).status,
    409,
  );
});
test("cache payloads require the new Agent capability and revalidate the current cluster policy at delivery", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  await f.req("/private-registry/deployments", "POST", {
    confirmed: true,
    trusted_network_acknowledged: true,
    revision: 0,
    cluster_id: c.id,
    machine_id: "ma",
    address: "10.0.0.1",
    cache_enabled: true,
  });
  f.finish("a");
  const a = f.app(c);
  assert.equal((await f.action(a, "deploy")).status, 202);
  assert.equal(f.jobs.claim("a", ["operations.platform"]), null);
  const job = f.jobs.claim("a", [
    "operations.platform",
    "operations.platform.image-cache.v1",
  ]);
  assert(job);
  const payload = f.platform.resolvePayload(job);
  assert.equal(
    payload.resource.config.image_cache.hub_endpoint,
    "http://10.0.0.1:21001",
  );
  const current = f.store.get(c.id);
  assert.equal(
    (
      await f.req("/private-registry/clusters/" + c.id + "/cache", "PUT", {
        revision: current.revision,
        enabled: false,
      })
    ).status,
    200,
  );
  assert.throws(
    () => f.platform.resolvePayload(job),
    /private_registry_cache_policy_changed/,
  );
});
test("a cache switch saved during a leased registry operation stays pending and reconciles after the writer completes", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  await f.req("/private-registry/deployments", "POST", {
    confirmed: true,
    trusted_network_acknowledged: true,
    revision: 0,
    cluster_id: c.id,
    machine_id: "ma",
    address: "10.0.0.1",
  });
  const job = f.jobs.claim("a", ["operations.platform"]);
  assert(job);
  const payload = f.platform.resolvePayload(job);
  const saved = await f.req(
    "/private-registry/clusters/" + c.id + "/cache",
    "PUT",
    { revision: c.revision, enabled: true },
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.body.cache_pending, "platform_resource_busy");
  assert.equal(
    (await f.req("/private-registry")).body.deployments[0].status.cache_pending,
    true,
  );
  for (const [n, phase] of [
    "accepted",
    "staging",
    "activating",
    "verifying",
  ].entries())
    f.jobs.event("a", job.id, {
      lease_id: job.lease_id,
      sequence: n + 1,
      phase,
      summary: "test",
    });
  f.jobs.result("a", job.id, {
    lease_id: job.lease_id,
    state: "succeeded",
    summary: "test",
    snapshot: {
      health: { healthy: true },
      operations: {
        operation_id: payload.operation_id,
        resource_id: payload.resource.id,
        data: { healthy: true, running: true },
      },
    },
  });
  await f.platform.tick();
  const view = (await f.req("/private-registry")).body;
  assert.equal(
    view.application.spec.deployments[0].registry_cache_enabled,
    true,
  );
  assert.equal(view.deployments[0].status.cache_pending, false);
});
test("cache publication failures after saving a snapshot remain pending and retry without another application revision", async (t) => {
  const f = await fixture(t),
    c = f.createCluster();
  await f.req("/private-registry/deployments", "POST", {
    confirmed: true,
    trusted_network_acknowledged: true,
    revision: 0,
    cluster_id: c.id,
    machine_id: "ma",
    address: "10.0.0.1",
  });
  f.finish("a");
  const cluster = f.store.update(
    c.id,
    c.revision,
    c.name,
    { ...c.spec, image_cache: { enabled: true } },
    "admin",
  );
  let calls = 0;
  const controller = createPrivateRegistryController(f.store, {
    perform: async () => {
      if (++calls === 1) fail(409, "injected_dispatch_failure");
      return {};
    },
  } as any);
  await controller.syncClusterCache(cluster, "admin");
  const pending = controller.overview();
  assert.equal(pending.deployments[0].status.cache_pending, true);
  const revision = pending.application!.revision;
  await controller.tick();
  assert.equal(calls, 2);
  assert.equal(controller.overview().application!.revision, revision);
  assert.equal(
    controller.overview().deployments[0].status.cache_pending,
    false,
  );
});
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

test('system registry installs with ordinary fields, follows machine inventory and decouples cluster route names',async t=>{
 const f=await fixture(t),c=f.createCluster();
 f.db.run("UPDATE managed_machines SET address='ssh.example.test' WHERE id='ma'");
 recordHostNetwork(f.db,'ma','a',normalizeNetworkAddresses([{interface:'docker0',address:'172.17.0.1'},{interface:'eth0',address:'10.55.0.9'},{interface:'eth0',address:'198.51.100.9'}]),undefined,f.deps.now().toISOString());
 const r=await f.req('/private-registry/deployments','POST',{confirmed:true,revision:0,cluster_id:c.id,machine_id:'ma',host_ports:{registry:15000,'hub-cache':15001,'origin-cache':15002},cache_enabled:true});
 assert.equal(r.status,201,JSON.stringify(r.body));const view=(await f.req('/private-registry')).body;assert.equal(view.deployments[0].address,'10.55.0.9');assert.equal(view.deployments[0].cache_scope,'cluster');
 const {payload}=f.finish('a');assert.equal(payload.resource.config.application.compose.services.registry.ports[0].host_ip,'10.55.0.9');
 const saved=await f.req('/resources/'+c.id,'PUT',{revision:f.store.get(c.id).revision,spec:{...f.store.get(c.id).spec,nodes:c.spec.nodes.map((n:any)=>({...n,address:'another-ssh.example.test',public_address:'203.0.113.99'}))}});
 assert.equal(saved.status,200,JSON.stringify(saved.body));assert(!saved.body.resource.spec.nodes[0].address);
 const workload=f.app(c,{image:'alpine:3.23',machine_ids:['mb']});assert.equal((await f.action(workload,'deploy')).status,202);
 assert.equal(f.finish('b').payload.resource.config.image_cache.hub_endpoint,'http://10.55.0.9:15001');
});
test('public-only host installs a local registry without IP gates and never sends loopback cache to a peer',async t=>{
 const f=await fixture(t),c=f.createCluster();
 f.db.run("UPDATE managed_machines SET address='ssh.example.test' WHERE id='ma'");
 recordHostNetwork(f.db,'ma','a',normalizeNetworkAddresses([{interface:'eth0',address:'198.51.100.42'},{interface:'br-docker',address:'172.17.0.1'}]),undefined,f.deps.now().toISOString());
 const r=await f.req('/private-registry/deployments','POST',{confirmed:true,revision:0,cluster_id:c.id,machine_id:'ma',address:'198.51.100.42',cache_enabled:true});
 assert.equal(r.status,201,JSON.stringify(r.body));const view=(await f.req('/private-registry')).body;assert.equal(view.deployments[0].address,'127.0.0.1');assert.equal(view.deployments[0].cache_scope,'machine');f.finish('a');
 const local=f.app(c,{image:'alpine:3.23',machine_ids:['ma']});assert.equal((await f.action(local,'deploy')).status,202);assert.match(f.finish('a').payload.resource.config.image_cache.hub_endpoint,/127\.0\.0\.1/);
 const peer=f.app(c,{image:'alpine:3.23',machine_ids:['mb']});assert.equal((await f.action(peer,'deploy')).status,202);assert.equal(f.finish('b').payload.resource.config.image_cache,undefined);
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
test('reinstalled Agent proves old containers absent, releases only old reservations and rebuilds cleanly',async t=>{
  for(const mode of ['manual','managed']) {
    const f=await fixture(t),c=f.createCluster(['ma']),a=f.app(c,{deployment_mode:mode});
    await f.action(a,'deploy');f.finish('a');const old=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id)!;
    rebindForRecovery(f);
    const requested=await f.action(a,'deploy');assert.equal(requested.status,202);assert.equal(requested.body.pending,'agent_reinstall_inspecting');
    assert.equal(f.db.get<any>('SELECT state FROM ops_cluster_instances WHERE id=?',old.id)?.state,'running');
    const proof=f.finish('c',{instance_id:old.id,absent:true,container_count:0,observed_at:'2026-10-29T02:00:00.000Z'});
    assert.equal(proof.payload.resource.config.task,'instance.recovery.inspect');
    const retired=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE id=?',old.id)!;assert.equal(retired.retired,1);assert.equal(retired.state,'stopped');assert.equal(retired.current_run_id,'');
    assert.equal(f.db.all('SELECT * FROM ops_platform_ports WHERE instance_id=?',old.id).length,0);assert.equal(JSON.parse(retired.observed_json).agent_recovery.current_agent_id,'c');
    const retry=await f.action(a,'deploy');assert.equal(retry.status,202,JSON.stringify(retry));
    const current=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=? AND retired=0',a.id)!;assert.notEqual(current.id,old.id);assert.equal(current.agent_id,'c');
  }
});
test('recovery retains stopped containers, unknown execution and stateful data instead of clearing rows',async t=>{
  for(const block of ['containers','unknown','job_unknown','stateful']) {
    const f=await fixture(t),c=f.createCluster(['ma']),a=f.app(c,{stateful:block==='stateful'});
    await f.action(a,'deploy');f.finish('a');const old=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id)!;rebindForRecovery(f);
    if(block==='job_unknown')f.db.run("UPDATE agent_jobs SET state='unknown' WHERE agent_id='a'");
    if(block==='unknown')f.db.run("UPDATE ops_platform_runs SET state='unknown' WHERE id=?",old.current_run_id);
    const requested=await f.action(a,'deploy');assert.equal(requested.status,202);
    if(block==='containers') {f.finish('c',{instance_id:old.id,absent:false,container_count:1,observed_at:'2026-10-29T02:00:00.000Z'});const next=await f.action(a,'deploy');assert.equal(next.body.pending,'agent_reinstall_containers_remain');}
    else assert.equal(requested.body.pending,['unknown','job_unknown'].includes(block)?'agent_reinstall_execution_unresolved':'agent_reinstall_stateful_review_required');
    assert.equal(f.db.get<any>('SELECT retired FROM ops_cluster_instances WHERE id=?',old.id)?.retired,0);assert(f.db.get('SELECT instance_id FROM ops_platform_ports WHERE instance_id=?',old.id));
  }
});
test('queued recovery revalidates machine target and rejects stale absent receipts',async t=>{
  const f=await fixture(t),c=f.createCluster(['ma']),a=f.app(c);
  await f.action(a,'deploy');f.finish('a');const old=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id)!;rebindForRecovery(f);await f.action(a,'deploy');
  const job=f.jobs.claim('c',['operations.platform','operations.platform.instance-recovery.v1']);assert(job);const payload=f.platform.resolvePayload(job);
  f.db.run("UPDATE managed_machines SET address='10.0.0.99' WHERE id='ma'");
  assert.throws(()=>f.platform.resolvePayload(job),/instance_recovery_target_changed/);
  f.jobs.result('c',job.id,{lease_id:job.lease_id,state:'succeeded',summary:'empty',snapshot:{operations:{operation_id:payload.operation_id,resource_id:a.id,data:{instance_id:old.id,absent:true,container_count:0,observed_at:'2026-10-29T02:00:00.000Z'}}}});
  assert.equal(f.db.get<any>('SELECT retired FROM ops_cluster_instances WHERE id=?',old.id)?.retired,0);
});
test('global image source settings have admin CAS and queued payload policy revalidation',async t=>{
  const f=await fixture(t);assert.equal((await f.req('/image-sources','GET',undefined,'member')).status,403);
  const settings=await f.req('/image-sources');assert.deepEqual(settings.body.rules,[]);
  const rule={source:'docker.io',target:'https://mirror.example.test/docker.io',allow_upstream:false};
  const saved=await f.req('/image-sources','PUT',{revision:0,rules:[rule]});assert.equal(saved.status,200);assert.equal(saved.body.revision,1);
  assert.equal((await f.req('/image-sources','PUT',{revision:0,rules:[]})).status,409);
  assert.equal((await f.req('/image-sources','PUT',{revision:1,rules:[{...rule,target:'http://bad.test'}]})).status,400);
  const c=f.createCluster(['ma']),a=f.app(c);
  const outdated=await f.action(a,'deploy');assert.match(JSON.stringify(outdated.body),/image_sources_agent_upgrade_required/);
  f.db.run("UPDATE agents SET heartbeat=? WHERE id='a'",JSON.stringify({operations_capabilities:['operations.platform.image-sources.v1']}));
  await f.action(a,'deploy');
  assert.equal(f.jobs.claim('a',['operations.platform']),null);
  const job=f.jobs.claim('a',['operations.platform','operations.platform.image-sources.v1']);assert(job);
  assert.equal(f.platform.resolvePayload(job).resource.config.image_sources.rules[0].source,'docker.io');
  await f.req('/image-sources','PUT',{revision:1,rules:[]});assert.throws(()=>f.platform.resolvePayload(job),/image_sources_policy_changed/);
});

test('persistent mounts require review after reinstallation even if stateful was not selected',async t=>{
 const f=await fixture(t),c=f.createCluster(['ma']),a=f.app(c,{mounts:[{type:'data',target:'/data'}]});
 await f.action(a,'deploy');f.finish('a');rebindForRecovery(f);
 const result=await f.action(a,'deploy');assert.equal(result.body.pending,'agent_reinstall_stateful_review_required');
 assert.equal(f.db.all('SELECT * FROM ops_instance_recoveries').length,0);
});
test('a recovery-blocked machine does not stall unrelated placement on healthy cluster peers',async t=>{
 const f=await fixture(t),c=f.createCluster(),old=f.app(c,{machine_ids:['ma'],stateful:true});
 await f.action(old,'deploy');f.finish('a');rebindForRecovery(f);
 const healthy=f.app(c,{service_name:'healthy-peer',deployment_mode:'managed'});
 const result=await f.action(healthy,'deploy');assert.equal(result.status,202,JSON.stringify(result.body));
 const instance=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',healthy.id)!;assert.equal(instance.machine_id,'mb');assert.equal(instance.agent_id,'b');
});

test('a storage failure rolls back both instance retirement and reservation release with the receipt',async t=>{
 const f=await fixture(t),c=f.createCluster(['ma']),a=f.app(c);
 await f.action(a,'deploy');f.finish('a');const old=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id)!;rebindForRecovery(f);await f.action(a,'deploy');
 f.db.exec("CREATE TRIGGER qa_fail_release BEFORE DELETE ON ops_platform_ports BEGIN SELECT RAISE(ABORT,'qa_storage_failure'); END;");
 assert.throws(()=>f.finish('c',{instance_id:old.id,absent:true,container_count:0,observed_at:'2026-10-29T02:00:00.000Z'}),/qa_storage_failure/);
 assert.equal(f.db.get<any>('SELECT retired FROM ops_cluster_instances WHERE id=?',old.id)?.retired,0);assert(f.db.get('SELECT instance_id FROM ops_platform_ports WHERE instance_id=?',old.id));
 assert.equal(f.db.get<any>('SELECT status FROM ops_instance_recoveries WHERE instance_id=?',old.id)?.status,'agent_reinstall_inspecting');
});
