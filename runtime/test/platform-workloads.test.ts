import { test } from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { cipher } from "../src/shared/crypto.js";
import { HTTPError, Router } from "../src/shared/http.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { OperationsPlatformStore } from "../src/ops/store.js";
import { createWorkloadController } from "../src/ops/workloads.js";
import type { Dependencies } from "../src/shared/types.js";
import type { PlatformResource } from "../src/ops/types.js";
import {createHostNetworkSchema,recordHostNetwork} from "../src/server/host-network.js";
import {normalizeNetworkAddresses} from "../src/shared/host-network.js";

function setup(t: any, fetcher?: typeof fetch) {
  const db = new DB(":memory:");
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','admin',1);CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT,heartbeat TEXT);INSERT INTO agents VALUES('node-a','2026-10-29T02:00:00.000Z','{}'),('node-b','2026-10-29T02:00:00.000Z','{}')");
  let now = new Date("2026-10-29T02:00:00Z");
  const deps = { db, router: new Router(), ...cipher(Buffer.alloc(32, 8)), now: () => now,
    logger: { info() {}, warn() {}, error() {} } } as unknown as Dependencies,
    jobs = registerAgentJobs(deps, { agentCredentials: { has: () => true } as any }),
    store = new OperationsPlatformStore(deps, jobs),
    controller = createWorkloadController({ store, deps, dataDir: "/tmp/platform-test", fetch: fetcher });
  t.after(async () => { await controller.close?.(); await store.close(); jobs.close?.(); db.close(); });
  const pool = () => store.create("node_pool", "Pool", {
    agent_ids: ["node-a", "node-b"], port_start: 21000, port_end: 21001,
    nodes: [{ agent_id: "node-a", address: "10.1.0.1", cpu: 2, memory_mb: 2048 }, { agent_id: "node-b", address: "10.1.0.2", cpu: 2, memory_mb: 2048 }],
  }, "admin");
  const app = () => store.create("application", "Application", {
    mode: "container", image: "nginx:1.30.6-alpine", environment: { PASSWORD: "private-test" },
    mounts: [{ type: "config", target: "/etc/app", files: { "settings.json": "{}" } }],
  }, "admin");
  return { db, deps, jobs, store, controller, pool, app, advance(ms: number) { now = new Date(now.getTime() + ms); } };
}
type Fixture = ReturnType<typeof setup>;
function resources(f: Fixture) {
  const node_pool = f.pool(), application = f.app(),
    service = f.store.create("service", "API", { application_id: application.id, node_pool_id: node_pool.id, replicas: 2, container_port: 8080, cpu: 1, memory_mb: 512 }, "admin"),
    gateway_group = f.store.create("gateway_group", "Gateways", { agent_ids: ["node-a", "node-b"], http_port: 18080, https_port: 18443 }, "admin"),
    website = f.store.create("website", "Website", { gateway_group_id: gateway_group.id, domains: ["site.example.test"], mode: "static", static_files: { "index.html": "unpublished" } }, "admin");
  return { node_pool, application, service, gateway_group, website };
}
function databaseSnapshot(f: Fixture) {
  return f.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map(({ name }) => ({ name, rows: f.db.all('SELECT * FROM "' + name + '"') }));
}
function hostSnapshot(f: Fixture) {
  return ["ops_platform_instances", "ops_platform_ports", "ops_platform_nodes", "agent_jobs", "agent_job_events"]
    .map(name => ({ name, rows: f.db.all('SELECT * FROM "' + name + '"') }));
}
const profileUnavailable = (error: unknown) => error instanceof HTTPError && error.status === 409 && error.message === "privileged_profile_not_implemented";
async function rejected(f: Fixture, resource: PlatformResource, action: string) {
  const before = databaseSnapshot(f);
  await assert.rejects(f.controller.perform(resource, action, { confirmed: true }, "admin"), profileUnavailable);
  assert.deepEqual(databaseSnapshot(f), before, "a denied host profile must not reserve ports, change desired state, or create runs/jobs");
}
// These rows are completed or unresolved pre-removal evidence, never produced by a legacy enqueue/claim helper.
function historicalInstance(f: Fixture, owner: PlatformResource, id: string, options: Record<string, any> = {}) {
  const at = f.deps.now().toISOString();
  const data = { agent_id: "node-a", state: "running", healthy: 1, address: "10.1.0.1", port: 21000, last_seen: at, desired_state: "running", current_run_id: "", observed_json: "{}", ...options };
  f.db.run("INSERT INTO ops_platform_instances(id,owner_id,application_id,application_revision,agent_id,slot,cpu,memory_mb,address,port,desired_generation,observed_generation,state,healthy,last_seen,observed_json,current_run_id,desired_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, owner.id, owner.spec.application_id ?? owner.id, 1, data.agent_id, id, 0.5, 128, data.address, data.port, "historical-generation", "historical-generation", data.state, data.healthy, data.last_seen, data.observed_json, data.current_run_id, data.desired_state, at, at);
  f.db.run("INSERT INTO ops_platform_ports(agent_id,protocol,port,instance_id) VALUES(?,?,?,?)", data.agent_id, "tcp", data.port, id);
  return f.db.get<any>("SELECT * FROM ops_platform_instances WHERE id=?", id)!;
}
function historicalRun(f: Fixture, resource: PlatformResource, id: string, state = "succeeded") {
  const jobID = id + "-job", at = f.deps.now().toISOString(), result = { healthy: state === "succeeded", historical: true },
    payload = f.deps.encrypt(JSON.stringify({ resource: { config: { task: "workload.apply", application: { environment: { PASSWORD: "private-old-payload" } } } } }));
  f.db.run("INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,capabilities_json,actions_json,target_json,issued_at,expires_at,receipt_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    jobID, "node-a", resource.id, id, state, '["operations.platform"]', JSON.stringify([{ kind: "operations", operation_id: id, domain: "platform" }]), "{}", at, at,
    JSON.stringify({ state, snapshot: { operations: { operation_id: id, resource_id: resource.id, data: result } } }), at, at);
  f.db.run("INSERT INTO ops_platform_runs(id,resource_id,resource_revision,agent_id,action,state,payload_cipher,result_json,job_id,actor,dedupe_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, resource.id, resource.revision, "node-a", "deploy", state, payload, JSON.stringify(result), jobID, "admin", id, at, at);
  return { run: f.store.action(id), job: f.jobs.get(jobID) };
}

const blockedActions = {
  application: ["deploy", "inspect", "stop", "remove", "logs"],
  service: ["deploy", "reconcile", "inspect", "stop"],
  node_pool: ["inspect"],
  gateway_group: ["deploy", "inspect", "stop"],
  website: ["deploy", "disable"],
} as const;
for (const kind of Object.keys(blockedActions) as Array<keyof typeof blockedActions>)
  test(kind + " host actions reject the unimplemented typed profile before any database mutation", async t => {
    const f = setup(t), resource = resources(f)[kind];
    for (const action of blockedActions[kind]) await rejected(f, resource, action);
    assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n, 0);
    assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM ops_platform_runs")!.n, 0);
  });

test("stored service endpoints remain a center read and expose only verified fresh historical instances", async t => {
  const f = setup(t), { service } = resources(f);
  historicalInstance(f, service, "fresh-a");
  historicalInstance(f, service, "fresh-b", { agent_id: "node-b", address: "10.1.0.2", port: 21001 });
  historicalInstance(f, service, "unknown", { state: "unknown", port: 21002 });
  historicalInstance(f, service, "stopped", { state: "stopped", desired_state: "stopped", port: 21003 });
  const before = hostSnapshot(f), read = await f.controller.perform(service, "endpoints", {}, "admin");
  assert.equal(read.state, "succeeded");
  assert.deepEqual(read.result.endpoints.map((value: any) => value.ip), ["10.1.0.1", "10.1.0.2"]);
  assert.deepEqual(hostSnapshot(f), before);
  assert.equal(f.store.actions(service.id).length, 1, "the center read can retain its own audit result");
  f.advance(121000);
  const expired = await f.controller.perform(f.store.get(service.id), "endpoints", {}, "admin");
  assert.deepEqual(expired.result.endpoints, []);
  assert.deepEqual(hostSnapshot(f), before);
});

test("legacy service endpoint discovery uses current managed addresses without rewriting historical instances", async t => {
  const f = setup(t), { service } = resources(f);
  f.db.exec("CREATE TABLE managed_machines(id TEXT PRIMARY KEY,address TEXT,agent_id TEXT,ssh_target_generation INTEGER,host_key_fingerprint TEXT);INSERT INTO managed_machines VALUES('managed-a','ssh.example.test','node-a',0,'')");
  createHostNetworkSchema(f.db);
  const network = (ip: string) => recordHostNetwork(f.db, "managed-a", "node-a", normalizeNetworkAddresses([{ interface: "eth0", address: ip }]), undefined, "2026-10-29T02:00:00.000Z");
  const instance = historicalInstance(f, service, "managed-instance", { address: "10.55.0.8" });
  network("10.55.0.8");
  assert.equal((await f.controller.perform(service, "endpoints", {}, "admin")).result.endpoints[0].ip, "10.55.0.8");
  network("10.55.0.9");
  const before = hostSnapshot(f), discovered = await f.controller.perform(f.store.get(service.id), "endpoints", {}, "admin");
  assert.equal(discovered.result.endpoints[0].ip, "10.55.0.9");
  assert.deepEqual(f.db.get("SELECT * FROM ops_platform_instances WHERE id=?", instance.id), instance);
  assert.deepEqual(hostSnapshot(f), before);
});

test("a removed node with a fresh heartbeat never causes legacy failover or capacity discovery", async t => {
  const f = setup(t), { service } = resources(f);
  f.db.run("INSERT INTO agent_lifecycle(agent_id,state) VALUES('node-a','removed')");
  f.store.patchStatus(service.id, { enabled: true, desired_revision: 1, policy_actor: "admin" });
  await rejected(f, f.store.get(service.id), "deploy");
  const before = databaseSnapshot(f);
  await f.controller.tick?.();
  assert.deepEqual(databaseSnapshot(f), before);
});

test("unknown historical executions preserve instance and port ownership across rejected actions and reconciliation", async t => {
  const f = setup(t), { service } = resources(f), evidence = historicalRun(f, service, "uncertain-deployment", "unknown");
  historicalInstance(f, service, "uncertain-instance", { state: "unknown", healthy: 0, current_run_id: evidence.run.id });
  f.store.patchStatus(service.id, { enabled: true, desired_revision: 1, policy_actor: "admin", instances: [{ id: "uncertain-instance", state: "unknown" }] });
  const before = databaseSnapshot(f);
  for (const action of blockedActions.service) await rejected(f, f.store.get(service.id), action);
  for (let i = 0; i < 3; i++) { f.advance(31000); await f.controller.tick?.(); }
  assert.deepEqual(databaseSnapshot(f), before);
  assert.equal(f.db.get<any>("SELECT state FROM ops_platform_instances WHERE id='uncertain-instance'")!.state, "unknown");
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM ops_platform_ports")!.n, 1);
  assert.equal(f.store.action(evidence.run.id).state, "unknown");
});

test("host profile denial neither steals existing reservations nor starts legacy capacity preflights", async t => {
  const f = setup(t), { application, service } = resources(f);
  historicalInstance(f, application, "owned-port", { port: 22000 });
  const conflict = f.store.create("application", "Conflicting port", { mode: "container", image: "nginx:1.30.6-alpine", agent_ids: ["node-a"], ports: [{ host_port: 22000, container_port: 80 }] }, "admin");
  await rejected(f, conflict, "deploy");
  const p = f.store.create("node_pool", "Undiscovered pool", { agent_ids: ["node-a", "node-b"], port_start: 25000, port_end: 25010 }, "admin"),
    pending = f.store.create("service", "Undiscovered API", { ...service.spec, node_pool_id: p.id, cpu: 3 }, "admin");
  await rejected(f, pending, "deploy");
  await rejected(f, p, "inspect");
  const before = hostSnapshot(f);
  await f.controller.tick?.();
  assert.deepEqual(hostSnapshot(f), before);
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM ops_platform_nodes")!.n, 0);
});

test("retired stop and remove do not release historical reservations or rewrite verified evidence", async t => {
  const f = setup(t), { application } = resources(f), evidence = historicalRun(f, application, "completed-deployment");
  historicalInstance(f, application, "running-instance", { port: 22000, current_run_id: evidence.run.id });
  await rejected(f, application, "stop");
  await rejected(f, application, "remove");
  assert.throws(() => f.store.remove(application.id, application.revision), /platform_resource_in_use|stop_instances_before_deleting/);
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM ops_platform_ports")!.n, 1);
  assert.equal(f.store.action(evidence.run.id).state, "succeeded");
  assert.throws(() => f.jobs.claim("node-a", ["operations.platform"]), error => error instanceof HTTPError && error.status === 409 && error.message === "privileged_executor_required");
  assert.equal(f.jobs.claim("node-a", ["health.http"]), null);
  let decryptions = 0;
  f.deps.decrypt = () => { decryptions++; throw Error("legacy payload decryption is removed"); };
  assert.throws(() => f.store.resolvePayload(evidence.job), error => error instanceof HTTPError && error.status === 410 && error.message === "legacy_agent_payload_removed");
  assert.equal(decryptions, 0);
  assert.doesNotMatch(JSON.stringify(evidence), /private-old-payload|payload_cipher/);
});

test("duplicate gateway domains are still rejected without needing any deployment", async t => {
  const f = setup(t), { gateway_group, website } = resources(f), before = databaseSnapshot(f);
  assert.throws(() => f.store.create("website", "Conflict", { gateway_group_id: gateway_group.id, domains: website.spec.domains, mode: "static" }, "admin"), /domain_conflict/);
  assert.deepEqual(databaseSnapshot(f), before);
  assert.throws(() => f.store.create("gateway_group", "Invalid ports", { agent_ids: ["node-a"], http_port: 18080, https_port: 18080 }, "admin"), /duplicate_gateway_port/);
  assert.throws(() => f.store.create("node_pool", "Invalid pool", { agent_ids: ["node-a"], port_start: 25001, port_end: 25000 }, "admin"), /invalid_port_range/);
});

test("saving website and application revisions never publishes or queues a legacy rolling update", async t => {
  const f = setup(t), { service, application, website } = resources(f);
  historicalInstance(f, service, "old-service");
  f.store.patchStatus(service.id, { enabled: true, desired_revision: 1, application_revision: 1, policy_actor: "admin" });
  f.store.patchStatus(website.id, { desired_revision: 1, enabled: true, policy_actor: "admin" });
  f.store.update(website.id, 1, website.name, { ...website.spec, static_files: { "index.html": "unpublished revision" } }, "admin");
  f.store.update(application.id, 1, application.name, { ...application.spec, image: "nginx:unpublished" }, "admin");
  const before = databaseSnapshot(f);
  for (let i = 0; i < 3; i++) { f.advance(31000); await f.controller.tick?.(); }
  assert.deepEqual(databaseSnapshot(f), before);
  assert.equal(f.store.get(website.id).status.desired_revision, 1);
  assert.equal(f.store.get(service.id).status.application_revision, 1);
  assert.equal(f.store.get(website.id).spec.static_files["index.html"], "unpublished revision");
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

test("historical successful observations remain available without creating health checks or replaying payloads", async t => {
  const f = setup(t), { service } = resources(f);
  for (let i = 0; i < 100; i++) {
    const evidence = historicalRun(f, service, "historical-observation-" + i);
    historicalInstance(f, service, "historical-instance-" + i, { agent_id: i % 2 ? "node-b" : "node-a", port: 24000 + i, current_run_id: evidence.run.id,
      observed_json: JSON.stringify({ containers: [{ running: true, id: "x".repeat(1000) }], stats: [{ CPUPerc: "1%", MemUsage: "x".repeat(50000) }] }) });
  }
  const before = hostSnapshot(f);
  await f.controller.tick?.();
  const read = await f.controller.perform(service, "endpoints", {}, "admin");
  assert.equal(read.result.endpoints.length, 100);
  assert.ok(Buffer.byteLength(JSON.stringify(read.result)) < 128 * 1024);
  assert.deepEqual(hostSnapshot(f), before);
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM ops_platform_runs WHERE resource_id=? AND state='succeeded' AND action='deploy'", service.id)!.n, 100);
  assert.doesNotMatch(JSON.stringify(f.store.actions(service.id)), /private-old-payload|payload_cipher/);
});

test("center website DNS reconciliation continues while a stalled provider never queues host observations", async t => {
  let rejectDNS: ((reason: Error) => void) | undefined, calls = 0;
  const f = setup(t, (async () => { calls++; return new Promise<Response>((_resolve, reject) => { rejectDNS = reject; }); }) as typeof fetch);
  f.store.register("credential", { validate: s => s });
  f.store.register("dns_zone", { validate: s => s });
  const credential = f.store.create("credential", "DNS", { provider: "aliyun", access_key_id: "fixture-key", access_key_secret: "fixture-secret" }, "admin"),
    zone = f.store.create("dns_zone", "Zone", { credential_id: credential.id, domain: "example.com", scope: "example.com" }, "admin"),
    group = f.store.create("gateway_group", "DNS gateway", { agent_ids: ["node-a"], http_port: 18080, https_port: 18443, public_addresses: { "node-a": "192.0.2.1" } }, "admin"),
    site = f.store.create("website", "Published DNS site", { gateway_group_id: group.id, mode: "static", domains: ["www.example.com"], dns_zone_id: zone.id }, "admin");
  historicalInstance(f, group, "historical-gateway", { address: "192.0.2.1", port: 18080 });
  f.store.patchStatus(site.id, { active: true, enabled: true, desired_revision: 1, policy_actor: "admin" });
  const before = hostSnapshot(f);
  try {
    await f.controller.tick?.();
    assert.equal(calls, 1);
    f.advance(31000);
    await f.controller.tick?.();
    assert.equal(calls, 1, "a pending center DNS request remains deduplicated");
    assert.deepEqual(hostSnapshot(f), before);
    assert.equal(f.store.actions(group.id).length, 0, "the former gateway health inspection queue is removed");
    await rejected(f, group, "inspect");
  } finally { rejectDNS?.(new Error("fixture provider unavailable")); await f.controller.close?.(); }
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n, 0);
  assert.equal(f.store.get(site.id).status.dns_error, "cloud_request_failed");
  assert.doesNotMatch(JSON.stringify(f.store.public(f.store.get(site.id))), /fixture-secret|fixture provider unavailable/);
});

test("per-path stored routes preserve manual upstreams and service references without host execution", async t => {
  const f = setup(t), { service, gateway_group } = resources(f),
    site = f.store.create("website", "Routes", { domains: ["paths.example.test"], gateway_group_id: gateway_group.id, mode: "proxy",
      locations: [{ path: "/api/", target: "service", service_id: service.id }, { path: "/", upstreams: ["http://10.1.0.8:8080"] }] }, "admin");
  assert.throws(() => f.store.remove(service.id, service.revision), /platform_resource_in_use/);
  assert.equal(site.spec.locations[0].service_id, service.id);
  assert.equal(site.spec.locations[0].target, "service");
  assert.equal(site.spec.locations[1].upstreams[0].url, "http://10.1.0.8:8080");
  await rejected(f, site, "deploy");
  const before = hostSnapshot(f), inspected = await f.controller.perform(site, "inspect", {}, "admin");
  assert.equal(inspected.state, "succeeded");
  assert.deepEqual(hostSnapshot(f), before);
});
