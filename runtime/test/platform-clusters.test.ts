import { ReconciliationRegistry } from "../src/reconciliation/registry.js";
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
import { registerAgentJobs } from "./helpers/domain-jobs.js";
import { registerOperationsPlatform } from "../src/ops/index.js";
import { extendedDefinitions } from "../src/ops/catalog/index.js";
import { applicationCatalog,catalogInstallation } from "../src/ops/catalog.js";
import type { Dependencies } from "../src/shared/types.js";
import { registryCacheFor, registryTemplateSpec } from "../src/ops/registry-runtime.js";
import { createPrivateRegistryController } from "../src/ops/private-registry.js";
import {createApplicationTelemetry} from '../src/ops/application-telemetry.js';
import {automaticEntry} from '../src/ops/automatic-entry.js';
import {selfSignedCertificate} from '../src/ops/certificates.js';
import {desiredJSON} from '../src/shared/desired-state.js';
async function fixture(t: any, fetcher?: typeof fetch, reconciliationEnabled=false) {
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
  const reconciliation=new ReconciliationRegistry(deps);
  const jobs = registerAgentJobs(deps, {
      agentCredentials: { has: () => true } as any,
    }),
    platform = registerOperationsPlatform(deps, {
      jobs,
      dataDir: "/tmp/cluster-tests",
      fetch: fetcher,
      intervalMs: 1000000,
      ...(reconciliationEnabled?{reconciliation}:{}),
    }),
    store = platform.store;
  const server = createServer((req, res) => void router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}}));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const req = async (
    path: string,
    method = "GET",
    body?: any,
    role = "admin",
  ) => {
    const r = await fetch(base + (path.startsWith('/machines/')?'/api/v1':"/api/v1/ops") + path, {
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
    const job = jobs.claim(agentID, ["operations.platform","operations.platform.registry.v1","operations.platform.readiness.v1","operations.platform.image-refresh.v1","operations.platform.image-cache.v1","operations.platform.image-sources.v1","operations.platform.instance-recovery.v1","operations.platform.reconciliation.v1"]);
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
    await reconciliation.close();
    await platform.close();
    jobs.close?.();
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return {
    reconciliation,
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
  assert.deepEqual(Object.keys(payload.resource.config.application.compose.services),['registry']);
  assert.equal(payload.resource.config.application.mounts.length,1);
  assert.equal(payload.resource.config.application.compose.services.registry.ports[0].target,5000);
  assert(!payload.resource.config.application.compose.services.origin_cache);
  assert.equal(
    payload.resource.config.application.compose.services.registry.ports[0]
      .host_ip,
    "10.0.0.1",
  );
  assert.equal(payload.resource.config.health.host, "10.0.0.1");
  assert.equal(payload.resource.config.health.port, Number(payload.resource.config.application.compose.services.registry.ports[0].published));
  const inspect = await f.action(view.application, "inspect", { cluster_id: c.id });
  assert.equal(inspect.status, 202, JSON.stringify(inspect.body));
  assert.equal(f.finish("a").payload.resource.config.health.host, "10.0.0.1");
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
test('system registry keeps one storage location and preserves its port across redeployment',async t=>{
 const f=await fixture(t),a=f.createCluster(['ma'],'A'),b=f.createCluster(['mb'],'B');
 const deploy=async(c:any,m:string,address:string,host_ports:any,revision:number)=>f.req('/private-registry/deployments','POST',{confirmed:true,trusted_network_acknowledged:true,revision,cluster_id:c.id,machine_id:m,address,...(host_ports===undefined?{}:{host_ports})});
 let r=await deploy(a,'ma','10.0.0.1',{registry:15000},0);assert.equal(r.status,201,JSON.stringify(r.body));
 let payload=f.finish('a').payload;assert.equal(payload.resource.config.application.compose.services.registry.ports[0].published,'15000');
 const rejected=await deploy(b,'mb','10.0.0.2',{registry:16000},r.body.revision);assert.equal(rejected.status,409);assert.equal(rejected.body.error,'registry_data_migration_required');
 r=await deploy(a,'ma','10.0.0.1',undefined,r.body.revision);assert.equal(r.status,201,JSON.stringify(r.body));payload=f.finish('a').payload;assert.equal(payload.resource.config.application.compose.services.registry.ports[0].published,'15000');
 const view=(await f.req('/private-registry')).body;
 assert.equal(view.deployments.find((d:any)=>d.cluster_id===a.id).host_ports.registry,15000);
 assert.equal(view.deployments.length,1);
 assert.equal(view.deployments.find((d:any)=>d.cluster_id===a.id).endpoint,'http://10.0.0.1:15000');
 for(const ports of [{registry:5000,'hub-cache':5000},{registry:'5000'},{unknown:5000}]){
  const bad=await deploy(a,'ma','10.0.0.1',ports,view.revision);assert.equal(bad.status,400,JSON.stringify(bad.body));
 }
 assert.equal((await f.req('/private-registry')).body.revision,view.revision);
 const changed=await deploy(a,'ma','10.0.0.1',{registry:15005},view.revision);
 assert.equal(changed.status,201);
 assert(f.db.get('SELECT * FROM ops_platform_ports WHERE agent_id=? AND port=?','a',15000),'previous binding remains reserved while replacement is in flight');
 const next=f.finish('a').payload;
 assert.equal(next.resource.config.application.compose.services.registry.ports[0].published,'15005');
 assert.equal(f.db.get('SELECT * FROM ops_platform_ports WHERE agent_id=? AND port=?','a',15000),undefined,'verified replacement releases previous binding');
 assert.equal((await f.req('/private-registry')).body.deployments.length,1);
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
      cache_enabled: true,
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
  // The global reconciler canonicalizes config before dispatch. The same cache
  // policy must remain authorized after that real encrypted JSON round trip.
  assert.equal((await f.action(consumer, 'deploy')).status, 202);
  const cacheRun=f.db.get<any>('SELECT * FROM ops_platform_runs WHERE resource_id=? ORDER BY created_at DESC LIMIT 1',consumer.id)!;
  const cachePayload=JSON.parse(f.deps.decrypt(cacheRun.payload_cipher));
  const cacheJob=f.jobs.get(cacheRun.job_id);
  const saveCache=(policy:any)=>f.db.run('UPDATE ops_platform_runs SET payload_cipher=? WHERE id=?',f.deps.encrypt(desiredJSON({...cachePayload,resource:{...cachePayload.resource,config:{...cachePayload.resource.config,image_cache:policy}}})),cacheRun.id);
  saveCache(cachePayload.resource.config.image_cache);
  assert.deepEqual(f.platform.resolvePayload(cacheJob).resource.config.image_cache,JSON.parse(JSON.stringify(direct)));
  for(const change of [{origin_endpoint:'http://10.0.0.99:21000'},{origin_host:'other.example.test'},{origin_mode:'cache'},{allow_upstream:false},{version:2},{extra:true}]){
    saveCache({...cachePayload.resource.config.image_cache,...change});
    assert.throws(()=>f.platform.resolvePayload(cacheJob),/private_registry_cache_policy_changed/);
  }
  saveCache(cachePayload.resource.config.image_cache);
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
    409,
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
  assert.equal(added.status, 409);
  assert.equal(added.body.error, "registry_data_migration_required");
  view = (await f.req("/private-registry")).body;
  assert.equal(view.deployments.length, 1);
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
});
test("a single writable registry does not turn Hub images into a separate cache deployment",async t=>{
 const f=await fixture(t),c=f.createCluster();
 await f.req('/private-registry/deployments','POST',{confirmed:true,revision:0,cluster_id:c.id,machine_id:'ma',cache_enabled:true});
 const registry=f.finish('a').payload.resource.config.application;
 assert.deepEqual(Object.keys(registry.compose.services),['registry']);assert.equal(registry.mounts.length,1);
 assert.equal(registry.compose.services.registry.environment.REGISTRY_PROXY_REMOTEURL,undefined);
 const a=f.app(c);assert.equal((await f.action(a,'deploy')).status,202);
 const job=f.jobs.claim('a',['operations.platform','operations.platform.readiness.v1']);assert(job);
 assert.equal(f.platform.resolvePayload(job).resource.config.image_cache,undefined);
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
  const job = f.jobs.claim("a", ["operations.platform","operations.platform.readiness.v1"]);
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
test("named ports reserve atomically and verified manual endpoints survive observation expiry", async (t) => {
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
    2,
  );
});
test("manual nodes stay fixed and managed failover waits for grace and ready replacement", async (t) => {
  const f = await fixture(t), c = f.createCluster(), manual = f.app(c);
  await f.action(manual, 'deploy'); f.finish('a');
  const managed = f.app(c, {deployment_mode:'managed', machine_ids:[], replicas:1});
  await f.action(managed,'deploy'); f.finish('a');
  const old = f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',managed.id)!;
  f.advance(240000); f.heartbeat('b'); await f.platform.tick();
  assert.equal(f.db.all('SELECT id FROM ops_cluster_instances WHERE owner_id=?',managed.id).length,1);
  assert.equal(f.store.get(managed.id).status.instances[0].availability,'grace');
  assert.equal(f.store.get(managed.id).status.endpoints.length,2);
  f.advance(61000); f.heartbeat('b'); await f.platform.tick();
  const attempts = f.db.all<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=? AND retired=0',managed.id);
  assert.equal(attempts.length,2);
  assert.equal(attempts.find(i=>i.slot.startsWith('surge-')).machine_id,'mb');
  assert.equal(f.db.get<any>('SELECT retired FROM ops_cluster_instances WHERE id=?',old.id).retired,0);
  assert.ok(f.store.get(managed.id).status.endpoints.every((e:any)=>e.machine_id==='ma'));
  f.finish('b'); await f.platform.tick();
  const active = f.db.all<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=? AND retired=0',managed.id);
  assert.equal(active.length,1); assert.equal(active[0].machine_id,'mb'); assert.equal(active[0].slot,'0');
  assert.equal(f.db.get<any>('SELECT retired FROM ops_cluster_instances WHERE id=?',old.id).retired,1);
  assert.equal(f.db.all('SELECT id FROM ops_cluster_instances WHERE owner_id=?',manual.id).length,1);
  assert.ok(f.store.get(managed.id).status.endpoints.every((e:any)=>e.machine_id==='mb'));
  f.heartbeat('a'); await f.platform.tick();
  assert.ok(!f.store.actions(managed.id).some(r=>r.action==='stop'));
  f.advance(30000); f.heartbeat('a');f.heartbeat('b');await f.platform.tick();
  assert.ok(f.store.actions(managed.id).some(r=>r.action==='stop'));
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
  assert.equal((await f.req("/catalog")).body.templates.length, 35);
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
  const websiteSpec = website(a);
  websiteSpec.bindings.push({...websiteSpec.bindings[0],domains:['api-second.example.test']});
  const site = f.store.create("website", "API", websiteSpec, "admin");
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
  const fragments=result.payload.resource.config.sites;
  assert.equal(fragments.length,2);
  assert.notEqual(fragments[0].id,fragments[1].id);
  assert(fragments.every((fragment:any)=>fragment.website_id===site.id&&fragment.id!==site.id));
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
test("managed rolling update drains one replica before mutation and waits for its ready receipt", async t=>{
 const f=await fixture(t),c=f.createCluster(),a=f.app(c,{deployment_mode:'managed',deployments:[{cluster_id:c.id,replicas:2,min_available_percent:50}]});
 await f.action(a,'deploy');f.finish('a');f.finish('b');
 const changed=f.store.update(a.id,1,a.name,{...a.spec,image:'example:2'},'admin');
 const started=await f.action(changed,'deploy');assert.equal(started.body.runs.length,0);assert.equal(started.body.pending,'traffic_drain_pending');
 assert.equal(f.store.actions(a.id).filter(r=>r.action==='apply').length,2);
 assert.ok(f.store.get(a.id).status.endpoints.every((e:any)=>e.machine_id==='mb'));
 f.advance(30000);f.heartbeat('a');f.heartbeat('b');await f.platform.tick();
 assert.equal(f.store.actions(a.id).filter(r=>r.action==='apply').length,3);
 await f.platform.tick();assert.equal(f.store.actions(a.id).filter(r=>r.action==='apply').length,3);
 f.finish('a');f.finish('b');await f.platform.tick();
 assert.equal(f.store.actions(a.id).filter(r=>r.action==='apply').length,3);
 f.advance(30000);f.heartbeat('a');f.heartbeat('b');await f.platform.tick();
 assert.equal(f.store.actions(a.id).filter(r=>r.action==='apply').length,4);
 // Drain any earlier observational job on this Agent before its apply receipt.
 for(let n=0;n<4 && f.db.get("SELECT id FROM agent_jobs WHERE agent_id='b' AND state='queued'");n++)f.finish('b');
 const endpoints=(await f.req('/resources/'+a.id+'/endpoints?cluster_id='+c.id)).body.endpoints;
 assert.ok(endpoints.every((e:any)=>e.version==='2'));
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
    if(data.Action === "DescribeDomainInfo")body={RecordLines:{RecordLine:[{LineCode:"default",LineDisplayName:"默认"}]}};
    else if (data.Action === "DescribeDomainRecords")
      body = { TotalCount: records.length, DomainRecords: { Record: records } };
    else if (data.Action === "AddDomainRecord") {
      const RecordId = String(++sequence);
      records.push({
        RecordId,
        RR: data.RR,
        Type: data.Type,
        Line: data.Line,
        Value: data.Value,
        TTL: Number(data.TTL),
        Status: "ENABLE",
      });
      body = { RecordId };
    } else if(data.Action === "SetDNSSLBStatus"){for(const r of records.filter(r=>r.RR+".example.test"===data.SubDomain))r.LbaStatus=true;}
    else if(data.Action === "UpdateDNSSLBWeight"){records.find(r=>r.RecordId===data.RecordId).Weight=Number(data.Weight);}
    else if (data.Action === "DeleteDomainRecord")
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
    f.store.get(entry.id).spec.deployments.map((d:any)=>d.gateway_domain).sort(),
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
    f.store.get(entry.id).spec.deployments.map((d:any)=>d.gateway_domain).sort(),
    "queued reload keeps the last verified DNS leases",
  );
  f.finish("a", { healthy: true, running: true, digest: "updated-a" });
  f.finish("b", { healthy: true, running: true, digest: "updated-b" });
  const beforeGrace = records.map(r=>[r.RR,r.Type,r.Value]).sort();
  f.advance(240000); f.heartbeat('b'); f.heartbeat('c');
  await f.platform.tick(); f.finish('b'); await settle();
  assert.deepEqual(records.map(r=>[r.RR,r.Type,r.Value]).sort(),beforeGrace,'four-minute heartbeat gap keeps entry and website DNS unchanged');
  assert.equal(f.db.get<any>("SELECT count(*) n FROM ops_cluster_instances WHERE owner_id=? AND retired=1",entry.id).n,0);
  f.advance(61000);
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
    f.store.get(entry.id).spec.deployments.map((d:any)=>d.gateway_domain).sort(),
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
 const r=await f.req('/private-registry/deployments','POST',{confirmed:true,revision:0,cluster_id:c.id,machine_id:'ma',host_ports:{registry:15000},cache_enabled:true});
 assert.equal(r.status,201,JSON.stringify(r.body));const view=(await f.req('/private-registry')).body;assert.equal(view.deployments[0].address,'10.55.0.9');assert.equal(view.deployments[0].cache_scope,'cluster');
 const {payload}=f.finish('a');assert.equal(payload.resource.config.application.compose.services.registry.ports[0].host_ip,'10.55.0.9');
 const saved=await f.req('/resources/'+c.id,'PUT',{revision:f.store.get(c.id).revision,spec:{...f.store.get(c.id).spec,nodes:c.spec.nodes.map((n:any)=>({...n,address:'another-ssh.example.test',public_address:'203.0.113.99'}))}});
 assert.equal(saved.status,200,JSON.stringify(saved.body));assert(!saved.body.resource.spec.nodes[0].address);
 const workload=f.app(c,{image:'alpine:3.23',machine_ids:['mb']});assert.equal((await f.action(workload,'deploy')).status,202);
 assert.equal(f.finish('b').payload.resource.config.image_cache,undefined);
});
test('public-only host installs a local registry without IP gates and never sends loopback cache to a peer',async t=>{
 const f=await fixture(t),c=f.createCluster();
 f.db.run("UPDATE managed_machines SET address='ssh.example.test' WHERE id='ma'");
 recordHostNetwork(f.db,'ma','a',normalizeNetworkAddresses([{interface:'eth0',address:'198.51.100.42'},{interface:'br-docker',address:'172.17.0.1'}]),undefined,f.deps.now().toISOString());
 const r=await f.req('/private-registry/deployments','POST',{confirmed:true,revision:0,cluster_id:c.id,machine_id:'ma',address:'198.51.100.42',cache_enabled:true});
 assert.equal(r.status,201,JSON.stringify(r.body));const view=(await f.req('/private-registry')).body;assert.equal(view.deployments[0].address,'127.0.0.1');assert.equal(view.deployments[0].cache_scope,'machine');f.finish('a');
 const local=f.app(c,{image:'alpine:3.23',machine_ids:['ma']});assert.equal((await f.action(local,'deploy')).status,202);assert.equal(f.finish('a').payload.resource.config.image_cache,undefined);
 const peer=f.app(c,{image:'alpine:3.23',machine_ids:['mb']});assert.equal((await f.action(peer,'deploy')).status,202);assert.equal(f.finish('b').payload.resource.config.image_cache,undefined);
});

test('all approved catalog applications save through HTTP, isolate identity and redact secrets', async t => {
 const f=await fixture(t),c=f.createCluster(['ma']);
 const list=await f.req('/catalog');assert.equal(list.body.templates.length,35);
 for(const {template} of extendedDefinitions){
  const parameters=Object.fromEntries(template.parameters.filter(p=>p.required||p.default!==undefined).map(p=>[p.key,p.default??p.example??(p.type==='password'?'qa_secret_2026_long':p.format==='url'?'http://app.example.test':p.format==='ip'?'192.0.2.10':p.format==='host'?'broker.example.test':'app')]));
  const result=await f.req('/catalog/'+template.id+'/install','POST',{parameters,deployments:[{cluster_id:c.id,machine_ids:['ma'],cpu:.25,memory_mb:128}],confirmed:false});
  assert.equal(result.status,201,template.id+':'+JSON.stringify(result.body));
  assert.equal(result.body.resource.spec.source.template_id,template.id);
  assert.doesNotMatch(JSON.stringify(result.body),/qa_secret_2026/);
  assert.doesNotMatch(JSON.stringify(f.db.get<any>('SELECT spec_cipher FROM ops_platform_resources WHERE id=?',result.body.resource.id)),/qa_secret_2026/);
  assert.equal(f.store.get(result.body.resource.id).spec.deployment_mode,'manual');
  if(['meilisearch','searxng','firecrawl','rustfs'].includes(template.id)){
   const privateSpec=f.store.get(result.body.resource.id).spec;
   const secrets=Object.values<any>(privateSpec.compose.services).flatMap(service=>Object.entries<any>(service.environment??{}).filter(([key])=>/PASSWORD|SECRET|KEY|REDIS_URL|REDIS_RATE_LIMIT_URL|RABBITMQ_URL/.test(key)).map(([,value])=>value));
   const publicRead=JSON.stringify((await f.req('/resources/'+result.body.resource.id)).body);
   const cipher=String(f.db.get<any>('SELECT spec_cipher FROM ops_platform_resources WHERE id=?',result.body.resource.id).spec_cipher);
   for(const secret of secrets){assert.ok(typeof secret==='string'&&secret.length>0);assert.ok(!publicRead.includes(secret),template.id);assert.ok(!cipher.includes(secret),template.id);}
  }
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
  recordHostNetwork(f.db,'ma','c',normalizeNetworkAddresses([{interface:'eth0',address:'10.0.0.1'}]),undefined,'2026-10-29T02:00:00.000Z');
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

test('catalog rejects duplicate cluster deployments without side effects and accepts corrected Gitea targets',async t=>{
 const f=await fixture(t),first=f.createCluster(['ma'],'First'),second=f.createCluster(['mb'],'Second');
 const target={cluster_id:first.id,machine_ids:['ma'],cpu:1,memory_mb:1024};
 const body={parameters:{external_url:'https://git.example.test'},confirmed:false,request_id:'gitea-target-correction',deployments:[target,{...target}]};
 const count=f.store.list().length,runs=f.store.actions().length;
 const invalid=await f.req('/catalog/gitea/install','POST',body);
 assert.equal(invalid.status,400);assert.equal(invalid.body.error,'duplicate_application_deployment');
 assert.equal(f.store.list().length,count);assert.equal(f.store.actions().length,runs);
 const valid=await f.req('/catalog/gitea/install','POST',{...body,deployments:[target,{...target,cluster_id:second.id,machine_ids:['mb']}]});
 assert.equal(valid.status,201,JSON.stringify(valid.body));
 assert.deepEqual(valid.body.resource.spec.deployments.map((d:any)=>[d.cluster_id,d.machine_ids]),[[first.id,['ma']],[second.id,['mb']]]);
 const retry=await f.req('/catalog/gitea/install','POST',{...body,deployments:[target,{...target,cluster_id:second.id,machine_ids:['mb']}]});
 assert.equal(retry.body.resource.id,valid.body.resource.id);assert.equal(f.store.list().length,count+1);
 const automatic=await f.req('/catalog/gitea/install','POST',{parameters:body.parameters,confirmed:false});
 assert.equal(automatic.status,201,JSON.stringify(automatic.body));assert.equal(automatic.body.resource.spec.deployments.length,1);
});

test('quick HTTP installation chooses an online target, generates entry DNS and keeps request identity',async t=>{
 const f=await fixture(t),c=f.createCluster();
 const credential=f.store.create('credential','DNS',{provider:'aliyun',access_key_id:'fixture',access_key_secret:'private-fixture'},'admin');
 const root=f.store.create('dns_zone','Root',{domain:'example.test',credential_id:credential.id},'admin');
 const zone=f.store.create('dns_zone','Scoped',{domain:'example.test',scope:'apps.example.test',credential_id:credential.id},'admin');
 f.store.create('acme_account','CA',{email:'ops@example.test',terms_agreed:true},'admin');
 const body={domain:'dbx.apps.example.test',parameters:{password:'private-install-password'},confirmed:true,request_id:'quick-install-request-1'};
 const result=await f.req('/catalog/dbx/install','POST',body);assert.equal(result.status,201,JSON.stringify(result.body));
 const app=f.store.get(result.body.resource.id),q=app.status.quick_install;
 assert.equal(app.spec.deployments[0].cluster_id,c.id);assert.equal(app.spec.deployments[0].machine_ids.length,1);
 assert.equal(q.state,'awaiting_backend');assert.equal(f.store.get(q.certificate_id).spec.dns_zone_ids[0],zone.id);
 const entry=f.store.get(q.gateway_id);assert.match(entry.spec.deployments[0].gateway_domain,/^edge-[a-f0-9]{16}\.apps\.example\.test$/);
 assert.deepEqual(automaticEntry(f.store,c.id,zone.id),automaticEntry(f.store,c.id,zone.id));
 assert.equal(f.store.get(q.website_id).spec.dns_record_mode,'cname');
 assert.equal(f.store.get(q.website_id).spec.bindings[0].dns_zone_id,zone.id);
 assert(app.spec.ports.every((p:any)=>p.host_port===0));
 const count=f.store.list().length,again=await f.req('/catalog/dbx/install','POST',body);
 assert.equal(again.body.resource.id,app.id);assert.equal(f.store.list().length,count);
 assert.doesNotMatch(JSON.stringify(result.body),/private-install-password|private-fixture/);
 assert.equal(root.spec.scope,'example.test');
});
test('quick installation validates prerequisites before creating any application',async t=>{
 const f=await fixture(t);
 assert.equal((await f.req('/catalog/dbx/install','POST',{confirmed:true,parameters:{}})).body.error,'catalog_parameter_required');
 assert.equal((await f.req('/catalog/registry/install','POST',{confirmed:true,host_ports:{unknown:15000}})).body.error,'invalid_host_ports');
 f.createCluster();
 const body={domain:'app.example.test',parameters:{password:'private-password'},confirmed:true};
 const before=f.store.list().length;
 assert.equal((await f.req('/catalog/dbx/install','POST',body)).body.error,'quick_install_domain_not_hosted');
 const credential=f.store.create('credential','DNS',{provider:'aliyun',access_key_id:'fixture',access_key_secret:'secret'},'admin');
 f.store.create('dns_zone','Domain',{domain:'example.test',credential_id:credential.id},'admin');
 assert.equal((await f.req('/catalog/dbx/install','POST',body)).body.error,'quick_install_acme_account_required');
 assert.equal(f.store.list('application').length,0);assert.equal(f.store.list().length,before+2);
 const expired=await selfSignedCertificate(['app.example.test'],1,new Date(f.deps.now().getTime()-3*86400000));
 f.store.create('certificate','Expired upload',{source:'uploaded',domains:['app.example.test'],...expired},'admin');
 assert.equal((await f.req('/catalog/dbx/install','POST',body)).body.error,'quick_install_acme_account_required');
 assert.equal(f.store.list('application').length,0);
 assert.equal((await f.req('/catalog/dbx/install','POST',{...body,domain:'example.test'})).body.error,'quick_install_cname_subdomain_required');
});
test('deployment SDK material is encrypted, per-instance, overridable and revoked with application removal',async t=>{
 const f=await fixture(t),c=f.createCluster();f.deps.externalURL='https://moni.example.test';
 f.db.exec("CREATE TABLE ingest_keys(id TEXT PRIMARY KEY,name TEXT,token_hash TEXT,active INTEGER DEFAULT 1,created_at TEXT)");
 const app=f.app(c,{environment:{LIGHTMONI_SERVICE:'custom-service'}});
 await f.action(app,'deploy');const {payload}=f.finish('a'),env=payload.resource.config.application.environment;
 assert.equal(env.LIGHTMONI_SERVICE,'custom-service');assert.equal(env.LIGHTMONI_MACHINE_NAME,'Machine A');assert.equal(env.LIGHTMONI_HOST_ID,'ha');assert.equal(env.LIGHTMONI_MACHINE_ID,'ma');assert.equal(env.LIGHTMONI_ENDPOINT,'https://moni.example.test');assert.match(env.LIGHTMONI_KEY,/^lm_/);
 const saved=f.db.get<any>('SELECT * FROM ops_application_sdk WHERE application_id=?',app.id)!;
 assert(!saved.secret_cipher.includes(env.LIGHTMONI_KEY));assert(!JSON.stringify(f.store.public(f.store.get(app.id))).includes(env.LIGHTMONI_KEY));
 const helper=createApplicationTelemetry(f.store),instance=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',app.id)!;
 assert.equal(helper.environment(app,instance).LIGHTMONI_KEY,env.LIGHTMONI_KEY);
 f.db.run('UPDATE ingest_keys SET active=0 WHERE id=?',saved.key_id);assert.throws(()=>helper.environment(app,instance),/application_sdk_key_disabled/);
 helper.remove(app.id);assert.equal(f.db.get('SELECT * FROM ops_application_sdk WHERE application_id=?',app.id),undefined);assert.equal(f.db.get<any>('SELECT active FROM ingest_keys WHERE id=?',saved.key_id)!.active,0);
});
test('nested synchronous resource writes roll back with their owning installation',async t=>{
 const f=await fixture(t);assert.throws(()=>f.db.transaction(()=>{f.db.transaction(()=>f.db.run("INSERT INTO users VALUES('rollback','admin',1)"));throw Error('reject installation')}),/reject installation/);
 assert.equal(f.db.get("SELECT id FROM users WHERE id='rollback'"),undefined);
});

test('quick installation publishes the retained website, verifies CNAME and retries without creating resources',async t=>{
 const records:any[]=[];let seq=0;
 const fetcher:typeof fetch=async(_url,init)=>{
  const b=Object.fromEntries(new URLSearchParams(String(init?.body)));let result:any={};
  if(b.Action==='DescribeDomainRecords')result={TotalCount:records.length,DomainRecords:{Record:records}};
  else if(b.Action==='AddDomainRecord'){const RecordId=String(++seq);records.push({RecordId,RR:b.RR,Type:b.Type,Value:b.Value,TTL:Number(b.TTL),Line:b.Line,Status:'ENABLE'});result={RecordId}}
  else if(b.Action==='DeleteDomainRecord'){const i=records.findIndex(r=>r.RecordId===b.RecordId);if(i>=0)records.splice(i,1)}
  else throw Error('unexpected DNS action '+b.Action);
  return new Response(JSON.stringify(result));
 };
 const f=await fixture(t,fetcher),cluster=f.createCluster(['ma']);
 const cred=f.store.create('credential','DNS',{provider:'aliyun',access_key_id:'fixture',access_key_secret:'private-fixture'},'admin');
 f.store.create('dns_zone','Domain',{domain:'example.test',credential_id:cred.id},'admin');
 const material=await selfSignedCertificate(['quick.example.test'],90,f.deps.now());
 const cert=f.store.create('certificate','Pre-existing certificate',{source:'uploaded',domains:['quick.example.test'],...material},'admin');
 const legacyEntry=catalogInstallation('openresty',{deployments:[{cluster_id:cluster.id,machine_ids:['ma'],gateway_domain:'external-entry.legacy.test'}]});
 const existingGateway=f.store.create('application',legacyEntry.name,legacyEntry.spec,'admin');
 const installed=await f.req('/catalog/dbx/install','POST',{domain:'quick.example.test',parameters:{password:'private-password'},confirmed:true,request_id:'full-quick-install'});
 assert.equal(installed.status,201,JSON.stringify(installed.body));const appID=installed.body.resource.id;
 const gatewayID=f.store.get(appID).status.quick_install.gateway_id;
 assert.equal(gatewayID,existingGateway.id);assert(f.store.get(gatewayID).spec.deployments[0].gateway_dns_zone_id);
 assert.match(f.store.get(gatewayID).spec.deployments[0].gateway_domain,/^edge-/);

 f.finish('a');f.finish('a');await f.platform.tick();
 assert.equal(f.store.get(appID).status.quick_install.certificate_id,cert.id);
 assert.equal(f.store.get(appID).status.quick_install.state,'publishing');f.finish('a'); // Legacy failed default weighting must not keep requesting a paid SLB feature.
 const siteID=f.store.get(appID).status.quick_install.website_id,zoneID=f.store.get(siteID).spec.bindings[0].dns_zone_id,entryDomain=f.store.get(gatewayID).spec.deployments[0].gateway_domain;
 records.push({RecordId:'legacy-default-cname',RR:'quick',Type:'CNAME',Value:entryDomain,TTL:600,Line:'default',Status:'ENABLE'});
 f.db.run("INSERT INTO ops_dns_owned(id,zone_id,owner_id,record_id,name,type,value,ttl,state,updated_at,line,weight) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",'legacy-weight',zoneID,siteID,'legacy-default-cname','quick','CNAME',entryDomain,600,'verifying',f.deps.now().toISOString(),'default',1);

 for(let n=0;n<4;n++){await f.platform.tick();for(let k=0;k<20;k++)await new Promise<void>(r=>setImmediate(r))}
 const app=f.store.get(appID),q=app.status.quick_install;
 assert.equal(q.state,'ready',JSON.stringify(q));
 assert.equal(f.db.get<any>("SELECT weight FROM ops_dns_owned WHERE id='legacy-weight'")!.weight,null);
 const target=f.store.get(q.gateway_id).spec.deployments[0].gateway_domain;
 assert(records.some(r=>r.RR==='quick'&&r.Type==='CNAME'&&r.Value===target));
 assert(!records.some(r=>r.RR==='quick'&&r.Type==='A'));
 const gateway=f.store.get(q.gateway_id);assert(gateway.status.dns[0].records.some((r:any)=>r.fqdn===target));
 const count=f.store.list().length;
 f.store.patchStatus(q.gateway_id,{dns_error:'provider_access_denied'});
 f.store.patchStatus(appID,{quick_install:{...q,state:'verifying_dns',error:''}});
 await f.platform.tick();assert.equal(f.store.get(appID).status.quick_install.error,'provider_access_denied');
 assert.equal(f.store.get(appID).status.quick_install.state,'failed');
 assert.equal((await f.action(f.store.get(appID),'quick-install-retry')).status,202);
 assert.equal(f.store.list().length,count);assert.equal(f.store.get(appID).status.quick_install.website_id,q.website_id);
 assert.equal(f.store.get(appID).spec.deployments[0].cluster_id,cluster.id);
});

test('application upgrades preview latest store images, preserve durable configuration, reject stale reviews and submit refresh jobs',async t=>{
 const f=await fixture(t),c=f.createCluster(),template=applicationCatalog.find(t=>t.id==='redis')!,previous=structuredClone(template);
 t.after(()=>Object.assign(template,previous));
 const recipe=catalogInstallation('redis',{name:'Upgrade Redis',service_name:'upgrade-redis',parameters:{password:'private-fixture-password'},deployments:[{cluster_id:c.id,machine_ids:['ma'],replicas:1,cpu:0.25,memory_mb:128}]});
 const app=f.store.create('application',recipe.name,recipe.spec,'admin'),before=structuredClone(app.spec),path='/resources/'+app.id+'/upgrade';
 template.version='next-store-release';template.versions=['next-store-release'];template.spec.image='redis:fixture-new';
 const preview=await f.req(path);assert.equal(preview.status,200);assert.equal(preview.body.available,true);assert.equal(preview.body.current_version,previous.version);assert.equal(preview.body.target_images.app,'redis:fixture-new');
 assert(!JSON.stringify(preview.body).includes('private-fixture-password'));
 assert.equal((await f.req(path,'POST',{revision:1,confirmed:true,target_version:template.version,target_fingerprint:preview.body.target_fingerprint},'member')).status,403);
 assert.equal((await f.req(path,'POST',{revision:1,target_version:template.version,target_fingerprint:preview.body.target_fingerprint})).status,400);
 assert.equal((await f.req(path,'POST',{revision:1,confirmed:true,target_version:'stale'})).status,409);
 template.spec.image='redis:changed-with-same-version';assert.equal((await f.req(path,'POST',{revision:1,confirmed:true,target_version:template.version,target_fingerprint:preview.body.target_fingerprint})).body.error,'application_template_changed');template.spec.image='redis:fixture-new';
 f.db.run("UPDATE agents SET heartbeat=? WHERE id='a'",JSON.stringify({operations_capabilities:['operations.platform.image-refresh.v1']}));
 const result=await f.req(path,'POST',{revision:1,confirmed:true,target_version:template.version,target_fingerprint:preview.body.target_fingerprint});assert.equal(result.status,202,JSON.stringify(result.body));
 const saved=f.store.get(app.id);assert.equal(saved.revision,2);assert.equal(saved.spec.image,'redis:fixture-new');assert.equal(saved.spec.source.template_version,template.version);assert.equal(saved.spec.image_pull_policy,'always');
 for(const key of ['environment','ports','mounts','deployments','service_name','command'])assert.deepEqual(saved.spec[key],before[key]);
 assert.equal(result.body.resource.spec.environment.REDIS_PASSWORD,'[redacted]');assert.equal(result.body.runs.length,1,JSON.stringify(result.body));
 const job=f.jobs.get(result.body.runs[0].job_id),payload=f.platform.resolvePayload(job);assert.equal(payload.resource.config.refresh_images,true);assert.equal(payload.resource.config.force_recreate,true);assert(job.capabilities.includes('operations.platform.image-refresh.v1'));
 assert.equal((await f.req(path,'POST',{revision:1,confirmed:true,target_version:template.version,target_fingerprint:preview.body.target_fingerprint})).status,409);
 assert.equal((await f.req(path,'POST',{revision:2,confirmed:true,target_version:template.version,target_fingerprint:preview.body.target_fingerprint})).body.error,'platform_resource_busy');
 assert.equal((await f.req(path)).body.available,false);
});

test('custom upgrades update each declared service, allow same tags and reject missing, injected, topology or foreign fields',async t=>{
 const f=await fixture(t),c=f.createCluster();f.db.run("UPDATE agents SET heartbeat=? WHERE id='a'",JSON.stringify({operations_capabilities:['operations.platform.image-refresh.v1']}));
 const app=f.app(c,{mode:'compose',compose:{services:{web:{image:'example/web:old',environment:{PASSWORD:'keep-secret'}},worker:{image:'example/worker:old'}}},ports:[],mounts:[]}),path='/resources/'+app.id+'/upgrade';
 for(const images of [{web:'example/web:new'},{web:'example/web:new',worker:'example/worker:new',foreign:'example:1'},{web:'$(touch /tmp/oops)',worker:'example:1'},{web:'--bad',worker:'example:1'}])assert.equal((await f.req(path,'POST',{revision:1,confirmed:true,images})).status,400);
 assert.equal((await f.req(path,'POST',{revision:1,confirmed:true,images:{web:'example:1',worker:'example:1'},command:['evil']})).status,400);
 const result=await f.req(path,'POST',{revision:1,confirmed:true,images:{web:'example/web:new',worker:'example/worker:old'}});assert.equal(result.status,202,JSON.stringify(result.body));
 const saved=f.store.get(app.id);assert.equal(saved.spec.compose.services.web.image,'example/web:new');assert.equal(saved.spec.compose.services.worker.image,'example/worker:old');assert.equal(saved.spec.compose.services.web.environment.PASSWORD,'keep-secret');assert.deepEqual(saved.spec.deployments,app.spec.deployments);
 const single=f.app(c,{service_name:'same-tag'});const response=await f.req('/resources/'+single.id+'/upgrade','POST',{revision:1,confirmed:true,images:{app:'example:1'}});assert.equal(response.status,202);assert.equal(f.store.get(single.id).revision,2);
 const template=applicationCatalog.find(t=>t.id==='redis')!,previous=structuredClone(template);t.after(()=>Object.assign(template,previous));
 const installed=f.app(c,{service_name:'store-upgrade-blocked',source:{type:'store',template_id:'redis',template_version:template.version}});template.spec.mode='compose';template.spec.compose={services:{redis:{image:'redis:new'},sidecar:{image:'alpine:3'}}};
 const blocked=await f.req('/resources/'+installed.id+'/upgrade');assert.equal(blocked.body.blocked_reason,'upgrade_service_topology_changed');assert.equal((await f.req('/resources/'+installed.id+'/upgrade','POST',{revision:1,confirmed:true,target_version:template.version})).status,409);assert.equal(f.store.get(installed.id).revision,1);
});

test('container targets are bound to current application, machine and full container identity and reject stale or retired instances',async t=>{
 const f=await fixture(t),c=f.createCluster(),a=f.app(c);await f.action(a,'deploy');f.finish('a');
 const i=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id),cid='a'.repeat(64),foreign='b'.repeat(64);
 f.db.exec('DROP VIEW privileged_executors');
 const heartbeat=(at=f.deps.now().toISOString())=>JSON.stringify({collectors_status:{applications:'ok'},docker_inventory:{state:'ready',observed_at:at,containers:[{id:cid,name:'app-one',image:'example:1',state:'running',deployment_id:i.id},{id:foreign,name:'external',image:'example:1',state:'running',deployment_id:'foreign'}]}});
 f.db.run("UPDATE agents SET heartbeat=? WHERE id='a'",heartbeat());
 const path='/resources/'+a.id+'/terminal-targets',listed=await f.req(path);assert.equal(listed.status,200);assert.equal(listed.body.hosts.length,1);assert.deepEqual(listed.body.hosts[0].containers.map((c:any)=>c.id),[cid]);
 assert.equal((await f.req(path,'GET',undefined,'member')).status,403);
 const input={application_id:a.id,instance_id:i.id,container_id:cid,shell:'bash'};
 assert.equal(f.platform.resolveContainerTarget('ma',input).revision,1);
 assert.throws(()=>f.platform.resolveContainerTarget('mb',input),/unavailable/);assert.throws(()=>f.platform.resolveContainerTarget('ma',{...input,container_id:foreign}),/unavailable/);
 f.db.run('UPDATE ops_cluster_instances SET retired=1 WHERE id=?',i.id);assert.throws(()=>f.platform.resolveContainerTarget('ma',input),/unavailable/);
 f.db.run('UPDATE ops_cluster_instances SET retired=0 WHERE id=?',i.id);f.db.run("UPDATE agents SET heartbeat=? WHERE id='a'",heartbeat('2000-01-01T00:00:00Z'));assert.equal((await f.req(path)).body.hosts.length,0);
});

test('application upgrades reject an old executor before changing configuration',async t=>{
 const f=await fixture(t),c=f.createCluster(),a=f.app(c);await f.action(a,'deploy');f.finish('a');
 const result=await f.req('/resources/'+a.id+'/upgrade','POST',{revision:1,confirmed:true,images:{app:'example:2'}});
 assert.equal(result.status,409);assert.equal(result.body.error,'image_refresh_agent_upgrade_required');assert.equal(f.store.get(a.id).revision,1);assert.equal(f.store.get(a.id).spec.image,'example:1');
});

test('managed 60 percent retains two of three published members across repeated ticks and controller restart', async t=>{
 const f=await fixture(t), c=f.createCluster();
 const a=f.app(c,{deployment_mode:'managed',deployments:[{cluster_id:c.id,replicas:3,min_available_percent:60}]});
 await f.action(a,'deploy'); f.finish('a'); f.finish('b'); f.finish('a');
 assert.equal(f.store.get(a.id).status.deployments[c.id].ready_instances,3);
 f.advance(301000); await f.platform.tick(); await f.platform.tick();
 const saved=f.store.get(a.id);assert.equal(saved.status.deployments[c.id].minimum_available,2);
 assert.equal(saved.status.deployments[c.id].ready_instances,0);
 assert.equal(new Set(saved.status.endpoints.map((e:any)=>e.instance_id)).size,2);
 assert.equal(saved.status.instances.filter((i:any)=>i.availability==='protected').length,2);
 const {createAvailability}=await import('../src/ops/availability.js');
 const policy=createAvailability(f.db,f.deps.now,id=>f.db.get<any>('SELECT * FROM agents WHERE id=?',id),id=>f.db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',id)!.agent_id);
 const rows=f.db.all<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id);
 const restored=policy.refresh({...a,spec:{...a.spec,...a.spec.deployments[0]}},rows);
 assert.equal(restored.filter(i=>i.serving).length,2);assert.ok(restored.filter(i=>i.serving).every(i=>!i.ready));
});

test('a failed or unknown surge cannot retire the old protected instance or create further copies',async t=>{
 for(const result of ['failed','unknown']){
  const f=await fixture(t),c=f.createCluster(),a=f.app(c,{deployment_mode:'managed',replicas:1});
  await f.action(a,'deploy');f.finish('a');
  f.advance(301000);f.heartbeat('b');await f.platform.tick();
  f.finish('b',{code:'WORKLOAD_READINESS_NOT_VERIFIED'},result);
  await f.platform.tick();await f.platform.tick();
  const instances=f.db.all<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id);
  assert.equal(instances.length,2);assert.ok(instances.every(i=>!i.retired));
  assert.ok(f.store.get(a.id).status.endpoints.every((e:any)=>e.machine_id==='ma'));
  if(result==='failed'){
   await f.action(a,'deploy');f.finish('b');await f.platform.tick();
   assert.equal(f.db.all('SELECT id FROM ops_cluster_instances WHERE owner_id=?',a.id).length,2);
   assert.ok(f.store.get(a.id).status.endpoints.every((e:any)=>e.machine_id==='mb'));
  }
 }
});

test('100 percent single replica upgrades start on another machine and switch only after readiness',async t=>{
 const f=await fixture(t),c=f.createCluster(),a=f.app(c,{deployment_mode:'managed',deployments:[{cluster_id:c.id,replicas:1,min_available_percent:100}]});
 await f.action(a,'deploy');f.finish('a');
 const changed=f.store.update(a.id,a.revision,a.name,{...a.spec,image:'example:2'},'admin');
 await f.action(changed,'deploy');
 assert.equal(f.store.get(a.id).status.endpoints[0].machine_id,'ma');
 assert.ok(!f.store.actions(a.id).some(r=>r.action==='stop'));
 const {payload}=f.finish('b');assert.equal(payload.resource.config.application.image,'example:2');
 await f.platform.tick();
 const endpoints=f.store.get(a.id).status.endpoints;
 assert.ok(endpoints.length);assert.ok(endpoints.every((e:any)=>e.machine_id==='mb'&&e.version==='2'));
});

test('health policy is validated and reaches immutable apply and periodic inspect payloads in manual mode',async t=>{
 const f=await fixture(t),c=f.createCluster();
 const health={type:'http',port_name:'http',path:'/ready',expected_statuses:[200,204],interval_seconds:5,timeout_seconds:2};
 const a=f.app(c,{health});await f.action(a,'deploy');
 assert.equal(f.jobs.claim('a',['operations.platform']),null,'older Agent cannot report HTTP readiness without enforcing configured statuses');
 const apply=f.finish('a').payload.resource.config;
 assert.deepEqual(apply.health,{...health,host:'0.0.0.0',port:21000});
 f.advance(5000);await f.platform.tick();
 const inspected=f.finish('a').payload.resource.config;
 assert.equal(inspected.task,'workload.inspect');assert.deepEqual(inspected.health,apply.health);
 for(const bad of [{heartbeat_grace_minutes:0},{heartbeat_grace_minutes:1.5},{deployments:[{cluster_id:c.id,replicas:3,min_available_percent:101}]},{health:{...health,path:'//other/ready'}},{health:{...health,path:'/ready\r\nHost:evil'}},{health:{...health,expected_statuses:[200,200]}},{health:{...health,timeout_seconds:31}}])assert.throws(()=>f.app(c,bad));
});

test('retired service waits for the gateway to acknowledge replacement routes before stopping',async t=>{
 const f=await fixture(t),c=f.createCluster(),a=f.app(c,{deployment_mode:'managed',deployments:[{cluster_id:c.id,replicas:1,min_available_percent:100}]});
 await f.action(a,'deploy');f.finish('a');
 const old=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id)!;
 const gateway=f.store.create('application','Entry',catalogInstallation('openresty',{deployment_mode:'manual',deployments:[{cluster_id:c.id,machine_ids:['ma','mb']}]}).spec,'admin');
 await f.action(gateway,'deploy');f.finish('a');f.finish('b');
 const site=f.store.create('website','Service',{cluster_ids:[c.id],routing_mode:'managed',service_application_id:a.id,service_port_name:'http',bindings:[{domains:['smooth.example.test'],locations:[{path:'/',action:'proxy'}]}]},'admin');
 await f.action(site,'deploy');f.finish('a');f.finish('b');
 const changed=f.store.update(a.id,a.revision,a.name,{...a.spec,image:'example:2'},'admin');
 await f.action(changed,'deploy');f.finish('b');await f.platform.tick();
 f.advance(31000);f.heartbeat('a');f.heartbeat('b');await f.platform.tick();
 assert.equal(f.db.get<any>('SELECT state FROM ops_cluster_instances WHERE id=?',old.id).state,'running');
 assert.ok(!f.store.actions(a.id).some(r=>r.action==='stop'));
 for(const agent of ['a','b'])for(let n=0;n<8 && f.db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state='queued'",agent);n++)f.finish(agent);
 await f.platform.tick();
 assert.ok(f.store.actions(a.id).some(r=>r.action==='stop'));
});

test('minimum retained membership is isolated per application cluster',async t=>{
 const f=await fixture(t),south=f.createCluster(['ma'],'South'),north=f.createCluster(['mb'],'North');
 const a=f.app(south,{deployment_mode:'managed',deployments:[{cluster_id:south.id,replicas:3,min_available_percent:60},{cluster_id:north.id,replicas:3,min_available_percent:100}]});
 await f.action(a,'deploy');for(let n=0;n<3;n++){f.finish('a');f.finish('b');}
 f.advance(301000);await f.platform.tick();
 const status=f.store.get(a.id).status;
 assert.equal(status.deployments[south.id].serving_instances,2);
 assert.equal(status.deployments[north.id].serving_instances,3);
});


test('click upgrade preserves refresh and HTTP readiness through managed route acknowledgement and drain',async t=>{
 const f=await fixture(t),c=f.createCluster();
 const capabilities=['operations.platform','operations.platform.readiness.v1','operations.platform.image-refresh.v1'];
 f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify({operations_capabilities:capabilities}));
 const health={type:'http',port_name:'http',path:'/ready',expected_statuses:[200,204],interval_seconds:5,timeout_seconds:2};
 const a=f.app(c,{deployment_mode:'managed',health,deployments:[{cluster_id:c.id,replicas:1,min_available_percent:100}]});
 await f.action(a,'deploy');f.finish('a');
 const old=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id)!;
 const gateway=f.store.create('application','Entry',catalogInstallation('openresty',{deployment_mode:'manual',deployments:[{cluster_id:c.id,machine_ids:['ma','mb']}]}).spec,'admin');
 await f.action(gateway,'deploy');f.finish('a');f.finish('b');
 const site=f.store.create('website','Upgrade route',{cluster_ids:[c.id],routing_mode:'managed',service_application_id:a.id,service_port_name:'http',bindings:[{domains:['upgrade.example.test'],locations:[{path:'/',action:'proxy'}]}]},'admin');
 await f.action(site,'deploy');f.finish('a');f.finish('b');
 const result=await f.req('/resources/'+a.id+'/upgrade','POST',{revision:1,confirmed:true,images:{app:'example:2'}});
 assert.equal(result.status,202,JSON.stringify(result.body));assert(!result.body.deploy_error,JSON.stringify(result.body));
 assert.ok(f.store.get(a.id).status.endpoints.every((e:any)=>e.machine_id==='ma'));
 const queued=f.db.get<any>("SELECT * FROM agent_jobs WHERE agent_id='b' AND state='queued'");assert.ok(queued);
 assert.ok(JSON.parse(queued.capabilities_json).includes('operations.platform.image-refresh.v1'));
 assert.ok(JSON.parse(queued.capabilities_json).includes('operations.platform.readiness.v1'));
 assert.equal(f.jobs.claim('b',['operations.platform','operations.platform.readiness.v1']),null);
 assert.equal(f.jobs.claim('b',['operations.platform','operations.platform.image-refresh.v1']),null);
 const payload=f.finish('b').payload.resource.config;
 assert.equal(payload.refresh_images,true);assert.equal(payload.force_recreate,true);
 assert.equal(payload.application.image,'example:2');assert.equal(payload.health.path,'/ready');assert.deepEqual(payload.health.expected_statuses,[200,204]);
 await f.platform.tick();assert.ok(f.store.get(a.id).status.endpoints.every((e:any)=>e.machine_id==='mb'));
 f.advance(31000);f.heartbeat('a');f.heartbeat('b');await f.platform.tick();
 assert.equal(f.db.get<any>('SELECT state FROM ops_cluster_instances WHERE id=?',old.id).state,'running');
 assert.ok(!f.store.actions(a.id).some(r=>r.action==='stop'));
 for(const agent of ['a','b'])for(let n=0;n<8 && f.db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state='queued'",agent);n++)f.finish(agent);
 await f.platform.tick();assert.ok(f.store.actions(a.id).some(r=>r.action==='stop'));
});

test('registered deployment inventory verifies current content, repairs manual instances and retains desired work while offline',async t=>{
  const f=await fixture(t,undefined,true),c=f.createCluster(),app=f.app(c);
  f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify({operations_capabilities:['operations.platform.reconciliation.v1']}));
  await f.action(app,'deploy');f.finish('a');f.advance(5001);f.heartbeat('a');await f.reconciliation.tick();
  let inspected=f.finish('a',{healthy:false,running:true,configuration_matches:false,containers:[{running:true}]});
  assert.equal(inspected.payload.resource.config.task,'workload.inspect');assert.ok(inspected.payload.resource.config.application);
  f.advance(5001);f.heartbeat('a');await f.reconciliation.tick();const apply=f.finish('a');assert.equal(apply.payload.resource.config.task,'workload.apply');assert.equal(apply.payload.resource.config.force_recreate,true);
  f.advance(5001);f.heartbeat('a');await f.reconciliation.tick();f.finish('a',{healthy:true,running:true,configuration_matches:true,containers:[{running:true}]});
  f.advance(5001);f.heartbeat('a');await f.reconciliation.tick();
  let resource=f.reconciliation.inventory('ma').resources.find(r=>r.owner_id===app.id)!;assert.equal(resource.state,'in_sync');assert.equal(resource.summary.ports.length,2);
  f.advance(60001);f.heartbeat('a');await f.reconciliation.tick();inspected=f.finish('a',{healthy:true,running:true,configuration_matches:true,containers:[{running:true}]});
  assert.equal(inspected.payload.resource.config.reconciliation_hash,resource.desired_hash);
  // A source edit fences an old inspection; a receipt cannot acknowledge the changed content.
  const current=f.store.get(app.id);f.store.update(app.id,current.revision,current.name,{...current.spec,image:'example:2'},'admin');
  await f.action(f.store.get(app.id),'deploy');f.finish('a');f.reconciliation.refresh();
  resource=f.reconciliation.inventory('ma').resources.find(r=>r.owner_id===app.id)!;assert.ok(resource.generation>1);assert.equal(resource.observed_generation,0);
  const second=f.app(c,{service_name:'offline-desired'});f.advance(121000);
  const response=await f.action(second,'deploy');assert.equal(response.status,202);f.reconciliation.refresh();
  assert(f.reconciliation.inventory('ma').resources.some(r=>r.owner_id===second.id));
  f.advance(60001);await f.reconciliation.tick();assert.equal(f.reconciliation.inventory('ma').resources.find(r=>r.owner_id===second.id)?.code,'agent_offline');
});

test('removed and stopped inspections retain the intended state without accumulating running-health failures',async t=>{
 for(const [intent,result,expected,failures,runState] of [
  ['removed',{running:false,present:false,containers:[]},'removed',0],
  ['removed',{running:false,containers:[{running:false}]},'stopped',0],
  ['stopped',{running:false,containers:[{running:false}]},'stopped',0],
  ['running',{running:false,present:false,containers:[]},'stopped',1],
  ['removed',{running:false,present:false,containers:[]},'running',1,'failed'],
  ['removed',{running:false,present:false,containers:[]},'running',1,'unknown'],
 ] as const){
  const f=await fixture(t,undefined,true),c=f.createCluster(),app=f.app(c);
  f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify({operations_capabilities:['operations.platform.reconciliation.v1']}));
  await f.action(app,'deploy');f.finish('a');
  const instance=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',app.id)!;
  f.db.run('UPDATE ops_cluster_instances SET desired_state=? WHERE id=?',intent,instance.id);
  f.advance(5001);f.heartbeat('a');await f.reconciliation.tick();
  const inspected=f.finish('a',{healthy:false,...result},runState??'succeeded');assert.equal(inspected.payload.resource.config.task,'workload.inspect');
  let row=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE id=?',instance.id)!;
  assert.equal(row.state,expected);assert.equal(row.health_failures,failures);assert.equal(row.healthy,0);
 }
});

test('new accepted lifecycle actions clear stale installation errors without hiding current placement failures',async t=>{
 const f=await fixture(t),c=f.createCluster(),app=f.app(c);
 for(const action of ['deploy','stop','deploy','remove']){
  f.store.patchStatus(app.id,{last_error:'old_install_failure',last_error_at:'2020-01-01T00:00:00Z'});
  if(action!=='deploy')f.db.run("UPDATE ops_platform_application_deployments SET status_json=? WHERE application_id=?",JSON.stringify({last_error:'old_placement_failure',pending:'old_pending'}),app.id);
  const response=await f.action(app,action);assert.equal(response.status,202,JSON.stringify(response.body));
  const current=f.store.get(app.id);assert.equal(current.status.last_error,'');assert.equal(current.status.last_error_at,'');
  assert.equal(current.status.deployments[c.id].last_error,'');assert.equal(current.status.deployments[c.id].pending,'');
  f.finish('a',action==='stop'?{running:false,containers:[{running:false}]}:action==='remove'?{running:false,containers:[]}:{healthy:true,running:true,containers:[{running:true}]});
 }
 const oversized=f.app(c,{cpu:5});const rejected=await f.action(oversized,'deploy');assert.equal(rejected.status,409);
 assert.match(f.store.get(oversized.id).status.deployments[c.id].last_error,/capacity/);
 assert.equal(f.store.actions(app.id).filter(r=>['apply','stop','remove'].includes(r.action)).length,4,'history remains available');
});

test('deep reconciliation preserves managed stateful minimum availability and keeps old Agent health checks during rollout',async t=>{
  const f=await fixture(t,undefined,true),c=f.createCluster(),a=f.app(c,{deployment_mode:'managed',stateful:true,deployments:[{cluster_id:c.id,replicas:1,stateful_acknowledged:true,min_available_percent:100}]});
  f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify({operations_capabilities:['operations.platform.reconciliation.v1']}));
  await f.action(a,'deploy');f.finish('a');f.advance(5001);f.heartbeat('a');f.heartbeat('b');await f.reconciliation.tick();
  f.finish('a',{healthy:false,running:true,configuration_matches:false,containers:[{running:true}]});
  f.advance(301000);f.heartbeat('a');f.heartbeat('b');await f.reconciliation.tick();
  f.finish('a',{healthy:false,running:true,configuration_matches:false,containers:[{running:true}]});
  f.advance(5001);f.heartbeat('a');f.heartbeat('b');await f.reconciliation.tick();
  assert.equal(f.reconciliation.inventory('ma').resources[0].code,'minimum_availability_protected');
  assert.equal(f.db.all("SELECT id FROM ops_cluster_instances WHERE owner_id=?",a.id).length,1);
  assert.equal(f.db.all("SELECT id FROM ops_platform_runs WHERE resource_id=? AND action='apply'",a.id).length,1);
  const old=await fixture(t,undefined,true),cluster=old.createCluster(),manual=old.app(cluster);
  await old.action(manual,'deploy');old.finish('a');old.advance(31000);old.heartbeat('a');await old.platform.tick();
  const health=old.finish('a');assert.equal(health.payload.resource.config.task,'workload.inspect');assert.equal(health.payload.resource.config.reconciliation_hash,undefined);
  await old.reconciliation.tick();assert.equal(old.reconciliation.inventory('ma').resources[0].code,'reconciliation_agent_upgrade_required');
});

test('manual published members survive long outages, stopped observations and controller rebuild',async t=>{
 const f=await fixture(t),c=f.createCluster(),a=f.app(c,{deployments:[{cluster_id:c.id,machine_ids:['ma','mb'],min_available_percent:0}]});
 await f.action(a,'deploy');f.finish('a');f.finish('b');
 const before=f.store.get(a.id).status.endpoints;assert.equal(before.length,4);
 f.advance(7200000);await f.platform.tick();
 const status=f.store.get(a.id).status;
 assert.deepEqual(status.endpoints,before);assert.equal(status.deployments[c.id].ready_instances,0);
 assert.equal(status.deployments[c.id].serving_instances,2);
 assert.ok(status.instances.every((i:any)=>i.availability==='retained'&&!i.healthy&&i.serving));
 assert.equal(f.store.actions(a.id).filter(r=>r.action!=='inspect').length,2);
 // Recover members withdrawn by the previous health-only policy using durable successful evidence.
 f.db.run("UPDATE ops_cluster_instances SET serving=0,state='stopped',healthy=0 WHERE owner_id=?",a.id);
 const {createAvailability}=await import('../src/ops/availability.js');
 const policy=createAvailability(f.db,f.deps.now,id=>f.db.get<any>('SELECT * FROM agents WHERE id=?',id),id=>f.db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',id)!.agent_id);
 const restored=policy.refresh({...a,spec:{...a.spec,...a.spec.deployments[0]}},f.db.all<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',a.id));
 assert.equal(restored.filter(i=>i.serving).length,2);assert.ok(restored.every(i=>!i.ready&&i.availability==='retained'));
 assert.deepEqual((await f.req('/resources/'+a.id+'/endpoints?cluster_id='+c.id)).body.endpoints,before);
 f.db.run("UPDATE managed_machines SET agent_id='replacement' WHERE id='ma'");
 assert.ok((await f.req('/resources/'+a.id+'/endpoints?cluster_id='+c.id)).body.endpoints.every((e:any)=>e.machine_id==='mb'));
});

test('manual membership needs prior readiness and explicit stop or removal still withdraws it',async t=>{
 for(const action of ['stop','remove']){
  const f=await fixture(t),c=f.createCluster(),a=f.app(c);
  await f.action(a,'deploy');f.finish('a',{},'failed');
  assert.equal(f.store.get(a.id).status.endpoints.length,0);
  await f.action(a,'deploy');f.finish('a');assert.equal(f.store.get(a.id).status.endpoints.length,2);
  await f.action(a,action);assert.equal((await f.req('/resources/'+a.id+'/endpoints?cluster_id='+c.id)).body.endpoints.length,0);
  f.finish('a',{running:false,healthy:false,containers:[]});await f.platform.tick();
  assert.equal(f.store.get(a.id).status.endpoints.length,0);
 }
});

test('manual reconciliation restores missing containers on the original machine without changing center intent',async t=>{
 const f=await fixture(t,undefined,true),c=f.createCluster(),a=f.app(c);
 f.db.run('UPDATE agents SET heartbeat=?',JSON.stringify({operations_capabilities:['operations.platform.reconciliation.v1']}));
 await f.action(a,'deploy');f.finish('a');
 const initial=f.store.get(a.id),before=structuredClone(initial.spec),members=structuredClone(initial.status.endpoints);
 f.advance(5001);f.heartbeat('a');await f.reconciliation.tick();
 f.finish('a',{healthy:false,running:false,configuration_matches:false,containers:[]});
 assert.deepEqual(f.store.get(a.id).spec,before);
 f.advance(5001);f.heartbeat('a');await f.reconciliation.tick();
 const restored=f.finish('a');assert.equal(restored.payload.resource.config.task,'workload.apply');assert.equal(restored.payload.resource.config.force_recreate,true);
 assert.equal(restored.payload.resource.config.application.image,before.image);
 assert.equal(f.db.all('SELECT id FROM ops_cluster_instances WHERE owner_id=?',a.id).length,1);
 assert.equal(f.db.get<any>('SELECT machine_id FROM ops_cluster_instances WHERE owner_id=?',a.id).machine_id,'ma');
 f.advance(5001);f.heartbeat('a');await f.reconciliation.tick();
 f.finish('a',{healthy:true,running:true,configuration_matches:true,containers:[{running:true}]});
 f.advance(5001);f.heartbeat('a');await f.reconciliation.tick();
 assert.equal(f.reconciliation.inventory('ma').resources.find(r=>r.owner_id===a.id)?.state,'in_sync');
 assert.equal(f.store.get(a.id).revision,initial.revision);assert.deepEqual(f.store.get(a.id).spec,before);
 assert.deepEqual(f.store.get(a.id).status.endpoints,members);
});

test('managed center restores three desired replicas after a machine outage without lowering its target',async t=>{
 const f=await fixture(t),c=f.createCluster(),a=f.app(c,{deployment_mode:'managed',deployments:[{cluster_id:c.id,replicas:3,min_available_percent:60}]});
 await f.action(a,'deploy');f.finish('a');f.finish('b');f.finish('a');
 const before=structuredClone(f.store.get(a.id).spec);
 f.advance(301000);f.heartbeat('b');
 for(let n=0;n<18;n++){
  await f.platform.tick();
  for(let pending=0;pending<8&&f.db.get("SELECT id FROM agent_jobs WHERE agent_id='b' AND state='queued'");pending++)f.finish('b');
  f.advance(31000);f.heartbeat('b');
  const active=f.db.all<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=? AND retired=0',a.id);
  if(active.length===3&&active.every(i=>i.machine_id==='mb'&&!i.slot.startsWith('surge-')&&i.healthy))break;
 }
 await f.platform.tick();
 const status=f.store.get(a.id).status;
 assert.equal(status.deployments[c.id].minimum_available,2);
 assert.equal(status.deployments[c.id].ready_instances,3);
 const active=f.db.all<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=? AND retired=0',a.id);
 assert.equal(active.length,3);assert.ok(active.every(i=>i.machine_id==='mb'&&!i.slot.startsWith('surge-')&&i.healthy),JSON.stringify({active:active.map(i=>({slot:i.slot,machine:i.machine_id,state:i.state,healthy:i.healthy,run:i.current_run_id})),status:status.deployments[c.id]}));
 assert.deepEqual(f.store.get(a.id).spec,before);assert.equal(f.store.get(a.id).revision,1);
});

async function reviewFixture(t:any,count=1){
 const f=await fixture(t),c=f.createCluster(['ma']),apps=[];
 for(let n=0;n<count;n++){const a=f.app(c,{stateful:true,service_name:'recovery-'+n,deployments:[{cluster_id:c.id,machine_ids:['ma'],cpu:.1,memory_mb:16}]});apps.push(a);await f.action(a,'deploy');f.finish('a');}
 rebindForRecovery(f);
 f.db.run('UPDATE agents SET heartbeat=? WHERE id=?',JSON.stringify({operations_capabilities:['operations.platform.instance-recovery.v1','operations.platform.instance-recovery-review.v1']}),'c');
 const prefix='/machines/ma/workload-recoveries';
 const create=async()=>{const r=await f.req(prefix+'/plan','POST',{reason:'Verified retained original containers and data after approved Agent reinstallation'});assert.equal(r.status,201,JSON.stringify(r));return r.body;};
 const proof=(p:any,stage='plan')=>({recovery_plan_id:p.id,stage,observed_at:'2026-10-29T02:00:00.000Z',instances:p.snapshot.instances.map((i:any)=>({instance_id:i.instance_id,containers:['a'.repeat(64)],mounts:[],owned:true,managed_state:true,data_present:true,data_path:'/var/lib/lightmoni-managed/operations/platform/workloads/'+i.instance_id,state_sha256:'b'.repeat(64),inventory_sha256:'c'.repeat(64)}))});
 const read=async(p:any)=>(await f.req(prefix+'/'+p.id)).body;
 const ready=async()=>{const p=await create();f.finish('c',proof(p));return read(p);};
 const apply=(p:any)=>f.req(prefix+'/'+p.id+'/apply','POST',{revision:p.revision,confirm:true});
 return {...f,apps,prefix,create,proof,read,ready,apply};
}
test('reviewed stateful recovery rechecks all instances, preserves center intent and data identity, and transfers port reservations once',async t=>{
 const f=await reviewFixture(t,2),original=f.db.all<any>('SELECT * FROM ops_cluster_instances ORDER BY id'),specs=f.apps.map(a=>f.store.get(a.id).spec);
 const plan=await f.ready();assert.equal(plan.status,'awaiting_approval');assert.equal(plan.proof.length,2);
 assert.ok(f.db.all<any>('SELECT agent_id FROM ops_cluster_instances').every(i=>i.agent_id==='a'),'read-only plan must not transfer bindings');
 const approved=await f.apply(plan);assert.equal(approved.status,200,JSON.stringify(approved));assert.equal(approved.body.status,'verifying');
 const runs=f.db.all('SELECT id FROM ops_platform_runs WHERE agent_id=?','c').length;await f.apply(plan);assert.equal(f.db.all('SELECT id FROM ops_platform_runs WHERE agent_id=?','c').length,runs);
 f.finish('c',f.proof(plan,'apply'));const done=await f.read(plan);assert.equal(done.status,'succeeded',JSON.stringify(done));assert.equal(done.approved_by,'admin');assert.equal(done.receipt.data_retained,true);
 const after=f.db.all<any>('SELECT * FROM ops_cluster_instances ORDER BY id');assert.deepEqual(after.map(i=>i.id),original.map(i=>i.id));
 for(let n=0;n<after.length;n++){
  assert.equal(after[n].agent_id,'c');assert.equal(after[n].healthy,0);assert.equal(after[n].last_seen,'');assert.equal(after[n].current_run_id,'');assert.equal(after[n].observed_generation,'');
  assert.equal(after[n].desired_state,original[n].desired_state);assert.equal(after[n].last_ready_at,original[n].last_ready_at);assert.equal(after[n].cluster_id,original[n].cluster_id);
  assert.equal(JSON.parse(after[n].observed_json).agent_recovery.previous_agent_id,'a');
 }
 assert.ok(f.db.all<any>('SELECT agent_id FROM ops_platform_ports').every(p=>p.agent_id==='c'));
 assert.deepEqual(f.apps.map(a=>f.store.get(a.id).spec),specs);assert.equal((await f.apply(plan)).body.status,'succeeded');
 assert.equal(f.db.all('SELECT id FROM ops_platform_runs WHERE agent_id=?','c').length,runs);
 assert.equal((await f.action(f.apps[0],'deploy')).body.pending,undefined,'reviewed instances no longer block normal deployment');
});
test('workload recovery requires administrator review, exact host and revision, and current capability',async t=>{
 const f=await reviewFixture(t);
 assert.equal((await f.req(f.prefix+'/plan','POST',{reason:'review'},'member')).status,403);
 assert.equal((await f.req(f.prefix+'/plan','POST',{reason:''})).status,400);
 const p=await f.create();assert.equal((await f.apply(p)).status,409);assert.equal((await f.req('/machines/mb/workload-recoveries/'+p.id)).status,404);
 f.finish('c',f.proof(p));const ready=await f.read(p);
 assert.equal((await f.req(f.prefix+'/'+p.id+'/apply','POST',{revision:'wrong',confirm:true})).status,409);
 assert.equal((await f.req(f.prefix+'/'+p.id+'/apply','POST',{revision:ready.revision,confirm:false})).status,409);
 const response=await fetch(f.base+'/api/v1'+f.prefix+'/'+p.id,{headers:{'x-role':'member'}});assert.equal(response.status,403);assert.equal(response.headers.get('cache-control'),'no-store');
 await f.req(f.prefix+'/'+p.id+'/cancel','POST',{});
 f.db.run("UPDATE agents SET heartbeat='{}' WHERE id='c'");assert.equal((await f.req(f.prefix+'/plan','POST',{reason:'review'})).body.error,'workload_recovery_agent_upgrade_required');
});
test('workload recovery refuses changed targets, expired reviews, changed inventory and missing managed data',async t=>{
 for(const mode of ['target','resource','expired','inventory','missing-state','foreign']){
  const f=await reviewFixture(t),p=await f.create();
  const proof=f.proof(p);if(mode==='missing-state')proof.instances[0].managed_state=false,proof.instances[0].state_sha256='';if(mode==='foreign')proof.instances[0].owned=false;
  f.finish('c',proof);let ready=await f.read(p);
  if(['missing-state','foreign'].includes(mode)){assert.equal(ready.status,'failed');continue;}
  assert.equal(ready.status,'awaiting_approval');
  if(mode==='target')f.db.run("UPDATE managed_machines SET address='10.0.0.9' WHERE id='ma'");
  if(mode==='resource')f.store.update(f.apps[0].id,1,'Changed',f.store.get(f.apps[0].id).spec,'admin');
  if(mode==='expired')f.advance(300001);
  const applied=await f.apply(ready);
  if(mode==='inventory'){assert.equal(applied.status,200);const changed=f.proof(p,'apply');changed.instances[0].inventory_sha256='d'.repeat(64);f.finish('c',changed);ready=await f.read(p);assert.equal(ready.status,'failed');assert.equal(ready.error,'workload_recovery_inventory_changed');}
  else assert.equal(applied.status,409,JSON.stringify({mode,applied}));
  assert.equal(f.db.get<any>('SELECT agent_id FROM ops_cluster_instances WHERE owner_id=?',f.apps[0].id).agent_id,'a');
 }
});
test('a cancelled preparation and a stale queued review cannot transfer bindings',async t=>{
 for(const mode of ['cancel','target','authorization']){
  const f=await reviewFixture(t),p=await f.create();
  if(mode==='cancel')await f.req(f.prefix+'/'+p.id+'/cancel','POST',{});
  if(mode==='target')f.db.run("UPDATE managed_machines SET ssh_target_generation=1 WHERE id='ma'");
  if(mode==='authorization')f.db.run("UPDATE users SET active=0 WHERE id='admin'");
  assert.throws(()=>f.finish('c',f.proof(p)),/workload_recovery_target_changed|platform_payload_authorization_required/);
  assert.equal(f.db.get<any>('SELECT agent_id FROM ops_cluster_instances WHERE owner_id=?',f.apps[0].id).agent_id,'a');
 }
});
test('unknown old execution needs the precise successful state-recovery audit before a review can proceed',async t=>{
 const f=await reviewFixture(t),old=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',f.apps[0].id),run=f.db.get<any>('SELECT * FROM ops_platform_runs WHERE id=?',old.current_run_id);
 f.db.run("UPDATE agent_jobs SET state='unknown' WHERE id=?",run.job_id);f.db.run("UPDATE ops_platform_runs SET state='unknown' WHERE id=?",run.id);f.db.run("UPDATE ops_cluster_instances SET state='unknown' WHERE id=?",old.id);
 assert.equal((await f.req(f.prefix+'/plan','POST',{reason:'review'})).body.error,'agent_reinstall_execution_unresolved');
 f.db.exec("CREATE TABLE machine_state_recoveries(id TEXT PRIMARY KEY,machine_id TEXT,agent_id TEXT,status TEXT,expires_at TEXT DEFAULT '');CREATE TABLE machine_state_recovery_jobs(recovery_id TEXT,machine_id TEXT,agent_id TEXT,job_id TEXT);");
 f.db.run("INSERT INTO machine_state_recoveries(id,machine_id,agent_id,status) VALUES('review-audit','ma','a','succeeded')");f.db.run("INSERT INTO machine_state_recovery_jobs VALUES('review-audit','mb','a',?)",run.job_id);
 assert.equal((await f.req(f.prefix+'/plan','POST',{reason:'review'})).body.error,'agent_reinstall_execution_unresolved');
 f.db.run("UPDATE machine_state_recovery_jobs SET machine_id='ma'");const p=await f.ready();assert.equal(p.status,'awaiting_approval');assert.equal(f.db.get<any>('SELECT state FROM ops_platform_runs WHERE id=?',run.id).state,'unknown');
});

test('reviewed recovery rolls back all instance and reservation changes when receipt storage fails',async t=>{
 const f=await reviewFixture(t,2),p=await f.ready();assert.equal((await f.apply(p)).status,200);
 const before=f.db.all('SELECT * FROM ops_cluster_instances ORDER BY id'),ports=f.db.all('SELECT * FROM ops_platform_ports ORDER BY port');
 const last=f.db.get<any>('SELECT id FROM ops_cluster_instances ORDER BY id DESC LIMIT 1').id;
 f.db.exec("CREATE TRIGGER fail_recovery_write BEFORE UPDATE OF agent_id ON ops_cluster_instances WHEN OLD.id='"+last+"' BEGIN SELECT RAISE(ABORT,'simulated_recovery_storage_failure');END;");
 assert.throws(()=>f.finish('c',f.proof(p,'apply')),/simulated_recovery_storage_failure/);
 assert.deepEqual(f.db.all('SELECT * FROM ops_cluster_instances ORDER BY id'),before);assert.deepEqual(f.db.all('SELECT * FROM ops_platform_ports ORDER BY port'),ports);
 assert.equal((await f.read(p)).status,'verifying');
});

test('only reviewed empty records without prior running data are retired; fresh data and port conflicts still block transfer',async t=>{
 for(const mode of ['empty','missing-data','port-conflict','stale-proof','old-online']){
  const f=await reviewFixture(t),old=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',f.apps[0].id);
  if(mode==='old-online'){f.heartbeat('a');assert.equal((await f.req(f.prefix+'/plan','POST',{reason:'review'})).body.error,'agent_reinstall_execution_unresolved');continue;}
  if(mode==='empty')f.db.run("UPDATE ops_cluster_instances SET last_ready_at='',healthy=0,state='stopped' WHERE id=?",old.id);
  const p=await f.create(),proof=f.proof(p);
  if(['empty','missing-data'].includes(mode))Object.assign(proof.instances[0],{containers:[],managed_state:false,data_present:false,state_sha256:''});
  if(mode==='stale-proof'){f.advance(100000);f.heartbeat('c');}
  f.finish('c',proof);const ready=await f.read(p);
  if(['missing-data','stale-proof'].includes(mode)){assert.equal(ready.status,'failed');assert.equal(f.db.get<any>('SELECT retired FROM ops_cluster_instances WHERE id=?',old.id).retired,0);continue;}
  assert.equal(ready.status,'awaiting_approval');
  if(mode==='port-conflict'){const port=f.db.get<any>('SELECT * FROM ops_platform_ports WHERE instance_id=?',old.id);f.db.run('INSERT INTO ops_platform_ports VALUES(?,?,?,?)','c',port.protocol,port.port,'other-instance');}
  assert.equal((await f.apply(ready)).status,200);f.finish('c',{...proof,stage:'apply'});const final=await f.read(p);
  if(mode==='port-conflict'){assert.equal(final.status,'failed');assert.equal(final.error,'workload_recovery_port_conflict');assert.equal(f.db.get<any>('SELECT agent_id FROM ops_cluster_instances WHERE id=?',old.id).agent_id,'a');}
  else{assert.equal(final.status,'succeeded');assert.equal(final.receipt.instances[0].action,'retire_absent');const row=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE id=?',old.id);assert.equal(row.retired,1);assert.equal(row.desired_state,old.desired_state);assert.equal(f.db.get('SELECT * FROM ops_platform_ports WHERE instance_id=?',old.id),undefined);}
 }
});

test('removed records with retained directories retire without blocking verified bindings; active intent and changed evidence still refuse',async t=>{
 for(const mode of ['mixed','running','new-container','intent-changed']){
  const f=await reviewFixture(t,2),old=f.db.get<any>('SELECT * FROM ops_cluster_instances ORDER BY id LIMIT 1');
  if(mode!=='running')f.db.run("UPDATE ops_cluster_instances SET desired_state='removed' WHERE id=?",old.id);
  const p=await f.create(),proof=f.proof(p),retained=proof.instances.find((i:any)=>i.instance_id===old.id)!;
  Object.assign(retained,{containers:[],managed_state:false,state_sha256:''});
  f.finish('c',proof);const ready=await f.read(p);
  if(mode==='running'){assert.equal(ready.status,'failed');assert.equal(ready.error,'workload_recovery_managed_state_required');continue;}
  assert.equal(ready.status,'awaiting_approval');assert.equal(ready.proof.find((i:any)=>i.instance_id===old.id).action,'retire_retained');
  if(mode==='intent-changed'){
   f.db.run("UPDATE ops_cluster_instances SET desired_state='running' WHERE id=?",old.id);
   assert.equal((await f.apply(ready)).body.error,'workload_recovery_target_changed');continue;
  }
  assert.equal((await f.apply(ready)).status,200);
  const finalProof=structuredClone(proof);finalProof.stage='apply';
  if(mode==='new-container')Object.assign(finalProof.instances.find((i:any)=>i.instance_id===old.id),{containers:['d'.repeat(64)],managed_state:true,state_sha256:'b'.repeat(64),inventory_sha256:'e'.repeat(64)});
  f.finish('c',finalProof);const done=await f.read(p),row=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE id=?',old.id);
  if(mode==='new-container'){assert.equal(done.status,'failed');assert.equal(done.error,'workload_recovery_inventory_changed');assert.equal(row.retired,0);assert.ok(f.db.all<any>('SELECT agent_id FROM ops_cluster_instances').every(i=>i.agent_id==='a'));continue;}
  assert.equal(done.status,'succeeded');assert.equal(done.receipt.data_retained,true);assert.equal(done.receipt.remote_writes,false);
  assert.equal(row.agent_id,'a');assert.equal(row.retired,1);assert.equal(row.desired_state,'removed');assert.equal(row.state,'removed');
  assert.equal(JSON.parse(row.observed_json).agent_recovery.action,'retire_retained');
  assert.equal(f.db.get('SELECT * FROM ops_platform_ports WHERE instance_id=?',old.id),undefined);
  const other=f.db.get<any>('SELECT * FROM ops_cluster_instances WHERE id!=?',old.id);assert.equal(other.agent_id,'c');assert.equal(other.retired,0);
  assert.equal(done.receipt.instances.find((i:any)=>i.instance_id===old.id).data_path,retained.data_path);
 }
});

async function registryContentFixture(t:any) {
 const f=await fixture(t),c=f.createCluster(['ma']);
 f.db.run('UPDATE agents SET heartbeat=? WHERE id=?',JSON.stringify({operations_capabilities:['operations.platform.registry.v1']}),'a');
 const installed=await f.req('/private-registry/deployments','POST',{confirmed:true,revision:0,cluster_id:c.id,machine_id:'ma'});assert.equal(installed.status,201);f.finish('a');
 return {...f,c,registry:f.store.get(installed.body.application.id,'application')};
}
test('registry content requires admin, a registered deployment and the new executor capability',async t=>{
 const f=await registryContentFixture(t);
 assert.equal(f.registry.spec.compose.services.registry.environment.REGISTRY_STORAGE_DELETE_ENABLED,'true');
 assert.equal(registryTemplateSpec().compose.services.registry.environment.REGISTRY_STORAGE_DELETE_ENABLED,'false');
 assert.equal((await f.req('/private-registry/images/query','POST',{cluster_id:f.c.id},'member')).status,403);
 assert.equal((await f.req('/private-registry/images/query','POST',{cluster_id:'unknown'})).status,400);
 assert.equal((await f.req('/private-registry/images/query','POST',{cluster_id:f.c.id,repository:'../bad'})).status,400);
 assert.equal((await f.req('/private-registry/images/cleanup','POST',{cluster_id:f.c.id,revision:f.registry.revision})).status,400);
 assert.equal((await f.req('/private-registry/images/cleanup','POST',{cluster_id:f.c.id,confirmed:true,revision:0})).status,409);
 const r=await f.req('/private-registry/images/query','POST',{cluster_id:f.c.id,endpoint:'http://attacker',repository:'team/api'});assert.equal(r.status,202);
 const {payload}=f.finish('a',{repository:'team/api',versions:[],next:null});assert.equal(payload.resource.config.task,'registry.inspect');assert.ok(payload.resource.config.endpoint.startsWith('http://10.0.0.1:'));assert.equal(payload.resource.config.repository,'team/api');
 f.db.run("UPDATE agents SET heartbeat='{}' WHERE id='a'");assert.equal((await f.req('/private-registry/images/query','POST',{cluster_id:f.c.id})).body.error,'registry_executor_upgrade_required');
});
test('cleanup captures Compose and old observed references and freezes application writes until completion',async t=>{
 const f=await registryContentFixture(t),host=new URL((await f.req('/private-registry')).body.deployments[0].endpoint).host;
 const a=f.app(f.c,{service_name:'api',image:host+'/team/api:v1'});await f.action(a,'deploy');f.finish('a');
 f.store.update(a.id,a.revision,a.name,{...a.spec,image:host+'/team/api:v2'},'admin');
 f.app(f.c,{service_name:'worker',mode:'compose',compose:{services:{worker:{image:host+'/worker:release'}}}});
 const other=f.createCluster(['mb'],'Other cluster');f.app(other,{service_name:'other-api',image:host+'/team/api:v3',deployments:[{cluster_id:other.id,machine_ids:['mb'],cpu:0.25,memory_mb:128}]});
 const r=await f.req('/private-registry/images/cleanup','POST',{cluster_id:f.c.id,confirmed:true,revision:f.registry.revision});assert.equal(r.status,202,JSON.stringify(r.body));assert.equal((await f.req('/private-registry')).body.cleanup_run.id,r.body.id);
 assert.throws(()=>f.app(f.c,{service_name:'new-app'}),/registry_cleanup_in_progress/);
 const current=f.store.get(a.id);assert.throws(()=>f.store.update(a.id,current.revision,current.name,current.spec,'admin'),/registry_cleanup_in_progress/);assert.throws(()=>f.store.remove(a.id,current.revision),/registry_cleanup_in_progress/);assert.throws(()=>f.store.queue(current,'a','apply',{task:'workload.apply'},'admin'),/registry_cleanup_in_progress/);
 assert.equal((await f.req('/private-registry/images/cleanup','POST',{cluster_id:f.c.id,confirmed:true,revision:f.registry.revision})).body.error,'registry_cleanup_in_progress');
 const {payload}=f.finish('a',{deleted:2,deleted_tags:2,retained:3,failed:0});assert.deepEqual(new Set(payload.resource.config.references.map((r:any)=>r.repository+':'+r.reference)),new Set(['team/api:v1','team/api:v2','team/api:v3','worker:release']));assert.equal((await f.req('/private-registry')).body.cleanup_run,null);f.app(f.c,{service_name:'after-cleanup'});
});
test('registry cleanup claim revalidates references even against out-of-band storage changes',async t=>{
 const f=await registryContentFixture(t),host=new URL((await f.req('/private-registry')).body.deployments[0].endpoint).host,a=f.app(f.c,{service_name:'api',image:host+'/api:v1'});
 const r=await f.req('/private-registry/images/cleanup','POST',{cluster_id:f.c.id,confirmed:true,revision:f.registry.revision});assert.equal(r.status,202);
 f.db.run('UPDATE ops_platform_resources SET spec_cipher=? WHERE id=?',f.deps.encrypt(JSON.stringify({...a.spec,image:host+'/api:new'})),a.id);
 const job=f.jobs.claim('a',['operations.platform','operations.platform.registry.v1']);assert.ok(job);assert.throws(()=>f.platform.resolvePayload(job),/registry_usage_changed/);
});

test('registry cleanup unknown retains a durable fence until the exact managed job is audited',async t=>{
 const f=await registryContentFixture(t);
 const queued=await f.req('/private-registry/images/cleanup','POST',{cluster_id:f.c.id,revision:f.registry.revision,confirmed:true});assert.equal(queued.status,202);
 const {job}=f.finish('a',{code:'registry_delete_unknown'},'unknown');
 assert.throws(()=>f.app(f.c,{service_name:'while-unknown'}),/registry_cleanup_in_progress/);
 f.db.exec("CREATE TABLE privileged_jobs(id TEXT PRIMARY KEY,agent_id TEXT,task_run_id TEXT,capability TEXT,state TEXT,resolved_at TEXT,resolved_by TEXT,resolution_reason TEXT)");
 f.db.run("INSERT INTO privileged_jobs VALUES(?,?,?,'operations.managed.v1','unknown','2026-10-29T02:00:00Z','admin','Inspected registry')",job.id,'wrong-agent',job.id);
 assert.throws(()=>f.app(f.c,{service_name:'wrong-audit'}),/registry_cleanup_in_progress/);
 f.db.run("UPDATE privileged_jobs SET agent_id='a' WHERE id=?",job.id);
 assert.equal((await f.req('/private-registry')).body.cleanup_run,null);
 f.app(f.c,{service_name:'after-audited-unknown'});
});
