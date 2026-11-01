import { assertImplementedHostProfile } from './host-profiles.js';
import {prepareApplicationYAML,stripComposeExtensions} from './application-yaml.js';
import {machineServiceAddresses} from "../server/host-network.js";
import {publicWebsiteSpec} from './website-auth.js';
import {registryCacheFor} from './registry-runtime.js';
import { createClusterWorkloads } from "./cluster-workloads.js";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { id } from "../shared/crypto.js";
import { fail } from "../shared/http.js";
import { hash } from "../operations/website-files.js";
import {
  applicationPorts,
  applicationResources,
  files,
  normalizeApplication,
  object,
  port,
  renderGateway,
} from "../operations/platform.js";
import { normalizeNginx, normalizeLocations } from "../operations/nginx.js";
import { getCertificateMaterial } from "./certificates.js";
import { ensureDnsRecords } from "./cloud.js";
import type {
  DomainController,
  PlatformOptions,
  PlatformResource,
  PlatformRun,
} from "./types.js";

type Instance = {
  id: string;
  owner_id: string;
  application_id: string;
  application_revision: number;
  agent_id: string;
  slot: string;
  cpu: number;
  memory_mb: number;
  address: string;
  port: number;
  protocol: string;
  desired_generation: string;
  observed_generation: string;
  state: string;
  healthy: number;
  last_seen: string;
  observed_json: string;
  affinity: number;
  current_run_id: string;
  desired_state: string;
  last_bundle_sig: string;
  health_failures: number;
  restart_count: number;
  created_at: string;
  updated_at: string;
};
const ACTIVE = new Set([
  "queued",
  "leased",
  "accepted",
  "preflighting",
  "staging",
  "activating",
  "verifying",
]);
const ownKinds = new Set([
  "application",
  "service",
  "node_pool",
  "gateway_group",
  "website",
]);
const values = (v: unknown, name: string, max = 100): string[] => {
  if (
    !Array.isArray(v) ||
    v.length > max ||
    v.some((x) => typeof x !== "string" || !x)
  )
    fail(400, "invalid_" + name);
  return [...new Set(v as string[])];
};
const number = (v: any, min: number, max: number, name: string) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    fail(400, "invalid_" + name);
  return v as number;
};
const endpoint = (v: unknown) => {
  if (
    typeof v !== "string" ||
    v.length > 253 ||
    !v ||
    /[^A-Za-z0-9.:[\]_-]/.test(v)
  )
    fail(400, "invalid_node_address");
  return v;
};
const domains = (v: unknown) =>
  values(v, "domains", 50).map((s) => {
    const ascii = domainToASCII(s.toLowerCase());
    if (
      !ascii ||
      ascii.length > 253 ||
      !ascii
        .split(".")
        .every((x) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))
    )
      fail(400, "invalid_website_domain");
    return ascii;
  });
const sanitizeEnvironment = (spec: any) => {
  const out = structuredClone(spec);
  if(out.compose&&typeof out.compose==='object')stripComposeExtensions(out.compose);
  if (out.environment)
    out.environment = Object.fromEntries(
      Object.keys(out.environment).map((k) => [k, "[redacted]"]),
    );
  if (out.compose?.services)
    for (const s of Object.values(out.compose.services) as any[])
      if (s.environment) {
        if (Array.isArray(s.environment))
          s.environment = s.environment.map(
            (entry: string) => entry.split("=", 1)[0] + "=[redacted]",
          );
        else
          s.environment = Object.fromEntries(
            Object.keys(s.environment).map((k) => [k, "[redacted]"]),
          );
      }
  return out;
};
function preserveEnvironment(input: any, previous: any) {
  const c = structuredClone(input);
  if (c.environment)
    for (const [k, v] of Object.entries(c.environment))
      if (v === "[redacted]") {
        const prior = previous?.environment?.[k] ?? (previous?.mode === 'compose' ? previous?.compose?.services?.app?.environment?.[k] : undefined);
        if (typeof prior !== "string")
          fail(400, "environment_value_required");
        c.environment[k] = prior;
      }
  if (c.compose && typeof c.compose === "object")
    for (const [name, s] of Object.entries(c.compose.services ?? {}) as Array<
      [string, any]
    >) {
      if (s.environment && !Array.isArray(s.environment))
        for (const [k, v] of Object.entries(s.environment))
          if (v === "[redacted]") {
            const old = previous?.compose?.services?.[name]?.environment?.[k] ?? (name === 'app' && previous?.mode === 'container' ? previous?.environment?.[k] : undefined);
            if (typeof old !== "string")
              fail(400, "environment_value_required");
            s.environment[k] = old;
          }
    }
  return c;
}
export interface WorkloadControllerOptions extends PlatformOptions {
  ensureCertificateMaterial?: (
    certificateID: string,
    actor: string,
  ) => Promise<void>;
}
export function createWorkloadController(
  options: WorkloadControllerOptions,
): DomainController {
  const { store, deps } = options,
    { db } = deps,
    at = () => deps.now().toISOString();
  const dnsPending = new Map<string, Promise<void>>();
  let closed = false;
  db.exec(`CREATE TABLE IF NOT EXISTS ops_platform_instances(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,application_id TEXT NOT NULL DEFAULT '',application_revision INTEGER NOT NULL DEFAULT 0,
 agent_id TEXT NOT NULL,slot TEXT NOT NULL,cpu REAL NOT NULL DEFAULT 0,memory_mb REAL NOT NULL DEFAULT 0,address TEXT NOT NULL DEFAULT '',port INTEGER NOT NULL DEFAULT 0,protocol TEXT NOT NULL DEFAULT 'tcp',
 desired_generation TEXT NOT NULL DEFAULT '',observed_generation TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'pending',healthy INTEGER NOT NULL DEFAULT 0,last_seen TEXT NOT NULL DEFAULT '',observed_json TEXT NOT NULL DEFAULT '{}',affinity INTEGER NOT NULL DEFAULT 0,current_run_id TEXT NOT NULL DEFAULT '',desired_state TEXT NOT NULL DEFAULT 'running',last_bundle_sig TEXT NOT NULL DEFAULT '',health_failures INTEGER NOT NULL DEFAULT 0,restart_count INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_id,slot));
 CREATE INDEX IF NOT EXISTS ops_platform_instances_agent ON ops_platform_instances(agent_id,state);
 CREATE TABLE IF NOT EXISTS ops_platform_ports(agent_id TEXT NOT NULL,protocol TEXT NOT NULL,port INTEGER NOT NULL,instance_id TEXT NOT NULL,PRIMARY KEY(agent_id,protocol,port));
 CREATE TABLE IF NOT EXISTS ops_platform_nodes(agent_id TEXT PRIMARY KEY,node_json TEXT NOT NULL,last_seen TEXT NOT NULL);`);
  const modern = createClusterWorkloads(options);
  const instances = (owner: string) =>
    db.all<Instance>(
      "SELECT * FROM ops_platform_instances WHERE owner_id=? ORDER BY slot,id",
      owner,
    );
  const revision = (
    resource: PlatformResource,
    version: number,
  ): PlatformResource => {
    if (resource.revision === version) return resource;
    const row = db.get<any>(
      "SELECT name,spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision=?",
      resource.id,
      version,
    );
    if (!row) fail(409, "authorized_revision_missing");
    return {
      ...resource,
      name: row.name,
      revision: version,
      spec: JSON.parse(deps.decrypt(row.spec_cipher)),
    };
  };
  const desired = (r: PlatformResource) =>
    revision(r, Number(r.status.desired_revision ?? r.revision));
  const instance = (key: string) =>
    db.get<Instance>("SELECT * FROM ops_platform_instances WHERE id=?", key)!;
  const agent = (key: string): any =>
    db.get(
      "SELECT * FROM agents WHERE id=? AND NOT EXISTS (SELECT 1 FROM agent_lifecycle l WHERE l.agent_id=agents.id AND l.state='removed')",
      key,
    );
  const online = (key: string) => {
    const a = agent(key);
    return (
      !!a &&
      Number.isFinite(Date.parse(a.last_seen)) &&
      deps.now().getTime() - Date.parse(a.last_seen) < 120000
    );
  };
  const checkAgents = (ids: string[]) => {
    if (!ids.length) fail(400, "target_agents_required");
    for (const key of ids)
      if (!agent(key)) fail(400, "registered_agent_required");
    return ids;
  };
  const managedAddresses = (agentID: string) => {
    if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_machines'")) return;
    const machine = db.get<{id:string}>('SELECT id FROM managed_machines WHERE agent_id=?',agentID);
    return machine ? machineServiceAddresses(db,machine.id) : undefined;
  };
  const gatewayAddress = (agentID: string, fallback?: string) => {
    const managed = managedAddresses(agentID);
    return managed ? managed.public_address : fallback ?? capacity(agentID).public_address ?? capacity(agentID).address ?? '';
  };
  const capacity = (agentID: string) => {
    for (const p of store.list("node_pool")) {
      const node = (p.spec.nodes ?? []).find(
        (n: any) => n.agent_id === agentID,
      );
      if (node) return {...node,...managedAddresses(agentID)};
    }
    const cached = db.get<any>(
      "SELECT node_json FROM ops_platform_nodes WHERE agent_id=?",
      agentID,
    );
    if (cached) return { agent_id: agentID, ...JSON.parse(cached.node_json),...managedAddresses(agentID) };
    const a = agent(agentID);
    let h: any = {};
    try {
      h = JSON.parse(a?.heartbeat ?? "{}");
    } catch {}
    let address = "";
    if (
      db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='managed_machines'",
      )
    )
      address =
        db.get<any>(
          "SELECT address FROM managed_machines WHERE agent_id=?",
          agentID,
        )?.address ?? "";
    return {
      agent_id: agentID,
      address: address || h.address || h.ip || "",
      ...managedAddresses(agentID),
      cpu: Number(h.cpu_count ?? h.cpu?.cores ?? 0),
      memory_mb: Number(
        h.memory_total_mb ??
          (h.memory?.total ? Number(h.memory.total) / 1048576 : 0),
      ),
    };
  };
  const usage = (agentID: string) =>
    db.get<any>(
      "SELECT COALESCE(SUM(cpu),0) cpu,COALESCE(SUM(memory_mb),0) memory_mb FROM ops_platform_instances WHERE agent_id=? AND state NOT IN ('stopped','removed')",
      agentID,
    )!;
  const result = (i: Instance) => ({
    ...i,
    healthy:
      i.healthy === 1 &&
      i.state === "running" &&
      deps.now().getTime() - Date.parse(i.last_seen) < 120000,
    observed: JSON.parse(i.observed_json),
    observed_json: undefined,
    cpu: Number(i.cpu),
    memory_mb: Number(i.memory_mb),
  });
  const endpoints = (resourceID: string) =>
    instances(resourceID)
      .map(result)
      .map(i => ({...i,address:managedAddresses(i.agent_id)?.address ?? i.address}))
      .filter(
        (i) =>
          i.healthy && i.address && i.port && i.desired_state === "running",
      )
      .map((i) => ({
        instance_id: i.id,
        agent_id: i.agent_id,
        ip: i.address,
        port: i.port,
        protocol: i.protocol,
        version: i.observed_generation,
      }));
  const publish = (ownerID: string) => {
    let r: PlatformResource;
    try {
      r = store.get(ownerID);
    } catch {
      return;
    }
    const current = instances(ownerID);
    const summaries = current.slice(0, 100).map((row) => {
      const i = result(row),
        observed = i.observed;
      return {
        id: i.id,
        agent_id: i.agent_id,
        address: i.address,
        port: i.port,
        state: i.state,
        healthy: i.healthy,
        cpu: i.cpu,
        memory_mb: i.memory_mb,
        desired_generation: i.desired_generation,
        observed_generation: i.observed_generation,
        last_seen: i.last_seen,
        affinity: i.affinity === 1,
        health_failures: i.health_failures,
        restart_count: i.restart_count,
        observed: {
          container_count: observed.containers?.length ?? 0,
          running_count:
            observed.containers?.filter((c: any) => c.running).length ?? 0,
          cpu_percent: (observed.stats ?? []).reduce(
            (total: number, s: any) =>
              total + (parseFloat(s.CPUPerc ?? "0") || 0),
            0,
          ),
          memory_usage: (observed.stats ?? [])
            .slice(0, 3)
            .map((s: any) => String(s.MemUsage ?? "").slice(0, 80)),
          digest: observed.digest ?? "",
        },
      };
    });
    store.patchStatus(ownerID, {
      ...r.status,
      instances: summaries,
      instances_total: current.length,
      instances_truncated: current.length > 100,
      ...(r.kind === "service"
        ? { endpoints: endpoints(ownerID).slice(0, 100) }
        : {}),
      last_reconciled_at: at(),
    });
  };
  const noLive = (r: PlatformResource) => {
    if (instances(r.id).some((i) => !["stopped", "removed"].includes(i.state)))
      fail(409, "stop_instances_before_deleting");
  };
  const referenced = (kind: string, key: string, field: string) => {
    if (
      store
        .list(kind as any)
        .some((r) =>
          [r.spec, desired(r).spec].some(
            (s) =>
              s[field] === key ||
              (field === "service_id" &&
                (s.locations ?? []).some((l: any) => l.service_id === key)),
          ),
        )
    )
      fail(409, "platform_resource_in_use");
  };
  store.register("application", {
    validatePayload(resource,config,agentID){
      if(!config.image_cache)return;
      const machineID=store.deps.db.get<{id:string}>("SELECT id FROM managed_machines WHERE agent_id=?",agentID)?.id;
      const expected=registryCacheFor(store,{...resource,spec:{...resource.spec,cluster_id:config.cluster_id}},machineID);
      if(JSON.stringify(expected)!==JSON.stringify(config.image_cache))fail(409,'private_registry_cache_policy_changed');
    },
    validate(spec, previous, context) {
      spec = prepareApplicationYAML(spec, previous);
      if (
        spec.deployments ||
        previous?.deployments ||
        spec.cluster_id ||
        previous?.cluster_id
      )
        return modern.validateApplication(
          preserveEnvironment(spec, previous),
          previous,
          context,
        );
      const c = normalizeApplication(
        preserveEnvironment(normalizeApplication(spec), previous),
      );
      applicationPorts(c);
      applicationResources(c);
      if (c.agent_ids?.length) checkAgents(c.agent_ids);
      return c;
    },
    afterSave(r, previous) {
      if (r.spec.deployments) modern.afterSaveApplication(r, previous);
    },
    afterDelete(r) {
      if (r.spec.deployments) modern.afterDeleteApplication(r);
    },
    publicSpec: sanitizeEnvironment,
    beforeDelete(r) {
      if (r.spec.deployments || r.spec.cluster_id)
        return modern.beforeDeleteApplication(r);
      referenced("service", r.id, "application_id");
      noLive(r);
    },
  });
  store.register("node_pool", {
    validate(spec) {
      const s = object(spec),
        ids = checkAgents(values(s.agent_ids, "agent_ids"));
      const start = port(s.port_start ?? 20000),
        end = port(s.port_end ?? 29999);
      if (start > end) fail(400, "invalid_port_range");
      const nodes = (s.nodes ?? []).map((v: any) => {
        const n = object(v);
        if (!ids.includes(n.agent_id)) fail(400, "node_not_in_pool");
        return {
          agent_id: n.agent_id,
          address: endpoint(n.address),
          ...(n.public_address
            ? { public_address: endpoint(n.public_address) }
            : {}),
          cpu: number(n.cpu, 0.01, 1024, "cpu"),
          memory_mb: number(n.memory_mb, 4, 4194304, "memory"),
        };
      });
      if (new Set(nodes.map((n: any) => n.agent_id)).size !== nodes.length)
        fail(400, "duplicate_pool_node");
      return { agent_ids: ids, port_start: start, port_end: end, nodes };
    },
    beforeDelete(r) {
      referenced("service", r.id, "node_pool_id");
    },
  });
  store.register("service", {
    validate(spec) {
      const s = object(spec);
      store.get(s.application_id, "application");
      store.get(s.node_pool_id, "node_pool");
      const replicas = number(s.replicas ?? 1, 0, 100, "replicas");
      if (!Number.isInteger(replicas)) fail(400, "invalid_replicas");
      const health = s.health
        ? {
            type: s.health.type,
            path: s.health.path ?? "/",
            interval_seconds: s.health.interval_seconds ?? 30,
          }
        : undefined;
      if (
        health &&
        (!["tcp", "http"].includes(health.type) ||
          typeof health.path !== "string" ||
          !health.path.startsWith("/") ||
          /[\r\n]/.test(health.path))
      )
        fail(400, "invalid_health_check");
      const app = store.get(s.application_id, "application");
      if (app.spec.mode !== "container")
        fail(400, "hosted_service_requires_single_container_application");
      if (app.spec.network_mode === "host")
        fail(400, "hosted_service_requires_port_mapping");
      return {
        application_id: s.application_id,
        node_pool_id: s.node_pool_id,
        replicas,
        container_port: port(s.container_port),
        cpu: number(s.cpu ?? app.spec.cpu ?? 0.25, 0.01, 1024, "cpu"),
        memory_mb: number(
          s.memory_mb ?? app.spec.memory_mb ?? 256,
          4,
          4194304,
          "memory",
        ),
        stateful: Boolean(s.stateful),
        ...(health ? { health } : {}),
      };
    },
    beforeDelete(r) {
      referenced("website", r.id, "service_id");
      noLive(r);
    },
  });
  store.register("gateway_group", {
    validate(spec) {
      const s = object(spec),
        ids = checkAgents(values(s.agent_ids, "agent_ids"));
      const http = port(s.http_port ?? 80),
        https = port(s.https_port ?? 443);
      if (http === https) fail(400, "duplicate_gateway_port");
      const addresses = object(s.public_addresses ?? {});
      for (const [key, v] of Object.entries(addresses)) {
        if (!ids.includes(key)) fail(400, "gateway_address_agent_mismatch");
        endpoint(v);
      }
      const image = s.image ?? "openresty/openresty:1.27.1.2-0-alpine";
      if (typeof image !== "string" || !image || /\s/.test(image))
        fail(400, "invalid_gateway_image");
      return {
        agent_ids: ids,
        image,
        http_port: http,
        https_port: https,
        public_addresses: addresses,
      };
    },
    beforeDelete(r) {
      referenced("website", r.id, "gateway_group_id");
      noLive(r);
    },
  });
  store.register("website", {
    publicSpec: publicWebsiteSpec,
    afterSave(r) {
      if (r.spec.cluster_ids) modern.afterSaveWebsite(r);
    },
    afterDelete(r) {
      if (r.spec.cluster_ids) modern.afterDeleteWebsite(r);
    },
    validate(spec, previous, context) {
      if (spec.bindings || previous?.bindings)
        return modern.validateWebsite(spec, previous, context);
      const s = object(spec),
        names = domains(s.domains);
      store.get(s.gateway_group_id, "gateway_group");
      for (const other of store.list("website")) {
        if (previous && JSON.stringify(other.spec) === JSON.stringify(previous))
          continue;
        if (
          other.spec.gateway_group_id === s.gateway_group_id &&
          other.spec.domains.some((d: string) => names.includes(d))
        )
          fail(409, "website_domain_conflict");
      }
      if (!["static", "proxy", "service"].includes(s.mode))
        fail(400, "invalid_website_mode");
      const out: any = {
        domains: names,
        mode: s.mode,
        gateway_group_id: s.gateway_group_id,
        https: Boolean(s.https ?? s.certificate_id),
        dns_enabled: Boolean(s.dns_enabled ?? s.dns_zone_id),
        nginx: normalizeNginx(s.nginx),
      };
      if (s.mode === "static")
        out.static_files = files(
          s.static_files ?? {
            "index.html":
              "<!doctype html><html><body><h1>LightMoni</h1></body></html>",
          },
        );
      if (
        s.mode === "static" &&
        out.nginx.spa_fallback &&
        !(out.nginx.index[0] in out.static_files)
      )
        fail(400, "spa_index_file_required");
      if (s.mode === "proxy") {
        out.locations = normalizeLocations(
          s.locations ?? [
            {
              path: "/",
              upstreams: s.upstreams ?? (s.upstream ? [s.upstream] : []),
            },
          ],
        );
        if (!out.locations.length) fail(400, "website_location_required");
      } else {
        out.locations = normalizeLocations(s.locations ?? []);
      }
      for (const location of out.locations)
        if (location.target === "service")
          store.get(location.service_id, "service");
      if (s.mode === "service") {
        store.get(s.service_id, "service");
        out.service_id = s.service_id;
      }
      if (out.https) {
        const cert = store.get(s.certificate_id, "certificate");
        if (
          names.some(
            (name) =>
              !(cert.spec.domains ?? []).some(
                (pattern: string) =>
                  pattern === name ||
                  (pattern.startsWith("*.") &&
                    name.endsWith(pattern.slice(1)) &&
                    name.split(".").length === pattern.split(".").length),
              ),
          )
        )
          fail(400, "website_certificate_domain_mismatch");
        out.certificate_id = s.certificate_id;
      }
      if (out.dns_enabled) {
        const zone = store.get(s.dns_zone_id, "dns_zone");
        if (
          names.some(
            (name) =>
              name !== zone.spec.scope && !name.endsWith("." + zone.spec.scope),
          )
        )
          fail(400, "website_domain_outside_dns_scope");
        out.dns_zone_id = s.dns_zone_id;
      }
      return out;
    },
    beforeDelete(r) {
      if (r.spec.bindings) return modern.beforeDeleteWebsite(r);
      if (dnsPending.has(r.id)) fail(409, "website_dns_refresh_in_progress");
      if (r.status.enabled !== false && r.status.active)
        fail(409, "disable_website_before_deleting");
    },
  });
  function createInstance(
    owner: PlatformResource,
    agentID: string,
    slot: string,
    application: PlatformResource | undefined,
    resources: { cpu: number; memory_mb: number },
    address: string,
    allocatedPort: number,
    affinity: boolean,
  ) {
    const key = id();
    db.run(
      "INSERT INTO ops_platform_instances(id,owner_id,application_id,application_revision,agent_id,slot,cpu,memory_mb,address,port,affinity,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      key,
      owner.id,
      application?.id ?? "",
      application?.revision ?? 0,
      agentID,
      slot,
      resources.cpu,
      resources.memory_mb,
      address,
      allocatedPort,
      affinity,
      at(),
      at(),
    );
    return instance(key);
  }
  function reservePort(i: Instance, p: number, protocol = "tcp") {
    const other = db.get<any>(
      "SELECT instance_id FROM ops_platform_ports WHERE agent_id=? AND protocol=? AND port=?",
      i.agent_id,
      protocol,
      p,
    );
    if (other && other.instance_id !== i.id)
      fail(409, "host_port_already_reserved");
    db.run(
      "INSERT OR IGNORE INTO ops_platform_ports(agent_id,protocol,port,instance_id) VALUES(?,?,?,?)",
      i.agent_id,
      protocol,
      p,
      i.id,
    );
  }
  function busy(i: Instance) {
    if (!i.current_run_id) return false;
    const run = db.get<any>(
      "SELECT state FROM ops_platform_runs WHERE id=?",
      i.current_run_id,
    );
    return !!run && ACTIVE.has(run.state);
  }
  function dispatch(
    resource: PlatformResource,
    i: Instance,
    action: string,
    config: any,
    actor: string,
    generation: string,
  ) {
    if (busy(i)) return null;
    if (
      i.state === "unknown" &&
      !["workload.inspect", "gateway.inspect", "workload.logs"].includes(
        config.task,
      )
    )
      fail(409, "instance_state_unknown_inspect_required");
    const run = store.queue(
      store.get(resource.id),
      i.agent_id,
      action,
      { ...config, instance_id: i.id },
      actor,
      `${i.id}:${generation}:${config.task}:${crypto.randomUUID()}`,
    );
    db.run(
      "UPDATE ops_platform_instances SET current_run_id=?,state=?,desired_generation=?,updated_at=? WHERE id=?",
      run.id,
      config.task.endsWith(".inspect") || config.task.endsWith(".logs")
        ? i.state
        : "queued",
      generation,
      at(),
      i.id,
    );
    return run;
  }
  function applyConfig(
    app: PlatformResource,
    i: Instance,
    service?: PlatformResource,
  ) {
    const application = structuredClone(app.spec);
    if (service) {
      application.cpu = service.spec.cpu;
      application.memory_mb = service.spec.memory_mb;
      application.ports = [
        {
          container_port: service.spec.container_port,
          host_port: i.port,
          protocol: "tcp",
          host_ip: "0.0.0.0",
        },
      ];
      application.network_mode = "bridge";
    }
    return {
      task: "workload.apply",
      application,
      application_id: app.id,
      application_revision: app.revision,
      health: service?.spec.health ?? application.health,
      probe_port:
        i.port ||
        applicationPorts(application).find((p) => p.protocol === "tcp")
          ?.host_port,
    };
  }
  const generation = (r: PlatformResource, app?: PlatformResource) =>
    String(r.revision) + (app ? ":" + app.revision : "");
  function discoverNodes(pool: PlatformResource, actor: string, force = false) {
    const runs: PlatformRun[] = [];
    for (const agentID of pool.spec.agent_ids) {
      if (!online(agentID)) continue;
      const known = capacity(agentID);
      if (!force && known.cpu > 0 && known.memory_mb > 0 && known.address)
        continue;
      if (
        db.get(
          "SELECT id FROM ops_platform_runs WHERE resource_id=? AND agent_id=? AND action='inspect' AND state IN ('queued','leased','accepted','staging','activating','verifying')",
          pool.id,
          agentID,
        )
      )
        continue;
      runs.push(
        store.queue(
          store.get(pool.id),
          agentID,
          "inspect",
          { task: "node.inspect", agent_id: agentID },
          actor,
        ),
      );
    }
    return runs;
  }
  function applicationDeploy(r: PlatformResource, input: any, actor: string) {
    const ids = checkAgents(
        values(input.agent_ids ?? r.spec.agent_ids ?? [], "agent_ids"),
      ),
      runs: PlatformRun[] = [];
    for (const agentID of ids) {
      if (!online(agentID)) fail(409, "target_agent_offline");
      let i = instances(r.id).find((i) => i.agent_id === agentID);
      db.transaction(() => {
        const primary =
          applicationPorts(r.spec).find((p) => p.protocol === "tcp")
            ?.host_port ?? 0;
        if (!i)
          i = createInstance(
            r,
            agentID,
            agentID,
            r,
            applicationResources(r.spec),
            capacity(agentID).address ?? "",
            primary,
            r.spec.mounts.some((m: any) => m.type === "data"),
          );
        for (const p of applicationPorts(r.spec))
          reservePort(i!, p.host_port, p.protocol);
        db.run(
          "UPDATE ops_platform_instances SET desired_state='running',cpu=?,memory_mb=?,port=? WHERE id=?",
          applicationResources(r.spec).cpu,
          applicationResources(r.spec).memory_mb,
          primary,
          i!.id,
        );
      });
      i = instance(i!.id);
      const run = dispatch(
        r,
        i!,
        "deploy",
        applyConfig(r, i!),
        actor,
        generation(r),
      );
      if (run) runs.push(run);
    }
    store.patchStatus(r.id, { ...r.status, enabled: true });
    publish(r.id);
    return { runs };
  }
  function serviceReconcile(
    currentResource: PlatformResource,
    actor: string,
    manual = false,
  ) {
    const r = desired(currentResource),
      app = revision(
        store.get(r.spec.application_id, "application"),
        Number(
          currentResource.status.application_revision ??
            store.get(r.spec.application_id).revision,
        ),
      ),
      pool = revision(
        store.get(r.spec.node_pool_id, "node_pool"),
        Number(
          currentResource.status.node_pool_revision ??
            store.get(r.spec.node_pool_id).revision,
        ),
      ),
      runs: PlatformRun[] = [];
    const required = Number(r.spec.replicas);
    let current = instances(r.id);
    if (
      pool.spec.agent_ids.some(
        (key: string) =>
          online(key) &&
          (!capacity(key).cpu ||
            !capacity(key).memory_mb ||
            !capacity(key).address),
      )
    ) {
      return {
        runs: discoverNodes(pool, actor),
        endpoints: endpoints(r.id),
        pending: "node_capacity_discovery",
      };
    }
    // Removed slots are deliberately stopped before their durable port reservation can be released.
    for (const i of current.filter(
      (x) =>
        Number(x.slot) >= required && !["stopped", "removed"].includes(x.state),
    )) {
      db.run(
        "UPDATE ops_platform_instances SET desired_state='stopped' WHERE id=?",
        i.id,
      );
      const run = dispatch(
        r,
        i,
        "stop",
        { task: "workload.stop" },
        actor,
        generation(r, app),
      );
      if (run) runs.push(run);
    }
    const wantedGeneration = generation(r, app);
    let rolloutID = current.find(
      (i) =>
        i.observed_generation &&
        i.desired_generation === wantedGeneration &&
        (busy(i) ||
          i.observed_generation !== wantedGeneration ||
          i.healthy !== 1),
    )?.id;
    let updating = Boolean(rolloutID);
    for (let slot = 0; slot < required; slot++) {
      let i = current.find((x) => x.slot === String(slot));
      if (i && i.state === "unknown") continue;
      if (!i) {
        db.transaction(() => {
          const candidates = pool.spec.agent_ids
            .filter((key: string) => online(key))
            .map((key: string) => ({
              key,
              node: capacity(key),
              use: usage(key),
              count: current.filter(
                (i) => i.agent_id === key && i.desired_state === "running",
              ).length,
            }))
            .filter(
              (c: any) =>
                c.node.docker_available !== false &&
                c.node.address &&
                c.node.cpu - c.use.cpu >= r.spec.cpu &&
                c.node.memory_mb - c.use.memory_mb >= r.spec.memory_mb,
            )
            .sort(
              (a: any, b: any) =>
                a.count - b.count ||
                a.use.cpu - b.use.cpu ||
                a.key.localeCompare(b.key),
            );
          let selected: any,
            selectedPort = 0;
          for (const c of candidates) {
            for (let p = pool.spec.port_start; p <= pool.spec.port_end; p++)
              if (
                !db.get(
                  "SELECT instance_id FROM ops_platform_ports WHERE agent_id=? AND protocol=? AND port=?",
                  c.key,
                  "tcp",
                  p,
                )
              ) {
                selected = c;
                selectedPort = p;
                break;
              }
            if (selected) break;
          }
          if (!selected) fail(409, "insufficient_node_capacity_or_ports");
          i = createInstance(
            r,
            selected.key,
            String(slot),
            app,
            { cpu: r.spec.cpu, memory_mb: r.spec.memory_mb },
            selected.node.address,
            selectedPort,
            r.spec.stateful ||
              app.spec.mounts.some((m: any) => m.type === "data"),
          );
          reservePort(i!, selectedPort);
        });
        current.push(i!);
      }
      if (!i) fail(500, "instance_reservation_failed");
      if (!online(i.agent_id)) continue;
      if (busy(i)) continue;
      const wanted = generation(r, app);
      if (
        i.observed_generation === wanted &&
        i.state === "running" &&
        i.desired_state === "running" &&
        (i.healthy === 1 || i.health_failures < 3)
      ) {
        if (manual) {
          const run = dispatch(
            r,
            i,
            "inspect",
            {
              task: "workload.inspect",
              health: r.spec.health,
              probe_port: i.port,
            },
            actor,
            wanted,
          );
          if (run) runs.push(run);
        }
        continue;
      }
      if (!manual && i.restart_count >= 3 && i.desired_generation === wanted)
        continue;
      // A rollout updates one existing live replica per pass; new replicas may start in parallel.
      if (i.observed_generation && updating && i.id !== rolloutID) continue;
      if (i.observed_generation) {
        updating = true;
        rolloutID = i.id;
      }
      db.transaction(() => {
        const use = usage(i!.agent_id),
          node = capacity(i!.agent_id);
        const oldActive = !["stopped", "removed"].includes(i!.state);
        if (
          (node.cpu &&
            use.cpu - (oldActive ? i!.cpu : 0) + r.spec.cpu > node.cpu) ||
          (node.memory_mb &&
            use.memory_mb - (oldActive ? i!.memory_mb : 0) + r.spec.memory_mb >
              node.memory_mb)
        )
          fail(409, "insufficient_node_capacity");
        reservePort(i!, i!.port);
        db.run(
          "UPDATE ops_platform_instances SET cpu=?,memory_mb=?,application_revision=?,desired_state='running',restart_count=restart_count+1 WHERE id=?",
          r.spec.cpu,
          r.spec.memory_mb,
          app.revision,
          i!.id,
        );
      });
      const run = dispatch(
        r,
        i,
        "deploy",
        { ...applyConfig(app, i, r), force_recreate: i.health_failures >= 3 },
        actor,
        wanted,
      );
      if (run) runs.push(run);
    }
    publish(r.id);
    return { runs, endpoints: endpoints(r.id) };
  }
  function gatewayInstance(group: PlatformResource, agentID: string) {
    let i = instances(group.id).find((x) => x.agent_id === agentID);
    db.transaction(() => {
      if (!i)
        i = createInstance(
          group,
          agentID,
          agentID,
          undefined,
          { cpu: 0, memory_mb: 0 },
          gatewayAddress(agentID,group.spec.public_addresses?.[agentID]),
          group.spec.http_port,
          false,
        );
      reservePort(i!, group.spec.http_port);
      reservePort(i!, group.spec.https_port);
      db.run(
        "UPDATE ops_platform_instances SET desired_state='running',port=?,address=? WHERE id=?",
        group.spec.http_port,
        gatewayAddress(agentID,group.spec.public_addresses?.[agentID]),
        i!.id,
      );
    });
    return instance(i!.id);
  }
  function siteBundle(site: PlatformResource, preview = false) {
    const s: any = {
      id: site.id,
      domains: site.spec.domains,
      mode: site.spec.mode,
      nginx: structuredClone(site.spec.nginx ?? {}),
      locations: structuredClone(site.spec.locations ?? []),
    };
    const serviceURLs = (key: string) =>
      endpoints(key).map(
        (e) =>
          "http://" +
          (isIP(e.ip) === 6 ? "[" + e.ip + "]" : e.ip) +
          ":" +
          e.port,
      );
    if (site.spec.mode === "static") s.static_files = site.spec.static_files;
    if (
      site.spec.mode === "service" &&
      !s.locations.some(
        (r: any) =>
          r.path === "/" &&
          ["prefix", "prefer_prefix"].includes(r.match ?? "prefix"),
      )
    )
      s.locations.unshift({
        path: "/",
        target: "service",
        service_id: site.spec.service_id,
      });
    if (site.spec.mode === "proxy" && !s.locations.length)
      s.locations = [{ path: "/", upstreams: site.spec.upstreams ?? [] }];
    for (const route of s.locations) {
      if (route.target === "service") {
        route.upstreams = serviceURLs(route.service_id);
        route.unavailable = !route.upstreams.length;
      }
      if (preview) {
        route.custom_config = route.custom_config
          ? "# Custom location directives omitted from preview"
          : "";
        for (const h of [route.request_headers, route.response_headers])
          for (const key of Object.keys(h ?? {}))
            if (/authorization|cookie|token|secret|api.?key/i.test(key))
              h[key] = "[redacted]";
      }
    }
    if (preview)
      for (const key of Object.keys(s.nginx.response_headers ?? {}))
        if (/authorization|cookie|token|secret|api.?key/i.test(key))
          s.nginx.response_headers[key] = "[redacted]";
    if (preview && s.nginx?.server_snippet)
      s.nginx = {
        ...s.nginx,
        server_snippet: "# Custom server directives omitted from preview",
      };
    if (site.spec.https)
      s.certificate = preview
        ? {}
        : getCertificateMaterial(store, site.spec.certificate_id);
    return s;
  }
  deps.router.get("/api/v1/ops/resources/:id/nginx", (ctx) => {
    deps.auth.requireAdmin(ctx);
    const site = store.get(ctx.params.id, "website");
    if (site.spec.bindings) {
      ctx.res.setHeader("cache-control", "no-store");
      ctx.json({
        revision: site.revision,
        config: modern.preview(
          site,
          ctx.url.searchParams.get("cluster_id") ?? "",
        ),
        redacted: true,
        validated: false,
      });
      return;
    }
    const group = store.get(site.spec.gateway_group_id, "gateway_group");
    ctx.res.setHeader("cache-control", "no-store");
    ctx.json({
      revision: site.revision,
      config: renderGateway(
        { ...group.spec, sites: [siteBundle(site, true)] },
        "PREVIEW",
        true,
      ),
      redacted: true,
      validated: false,
    });
  });
  function gatewayBundle(group: PlatformResource) {
    const sites: any[] = [],
      revisions: Record<string, number> = {};
    for (const current of store.list("website")) {
      const site = desired(current);
      if (
        site.spec.gateway_group_id !== group.id ||
        site.status.enabled === undefined
      )
        continue;
      revisions[site.id] = site.revision;
      if (site.status.enabled !== true) continue;
      sites.push(siteBundle(site));
    }
    const config = {
      task: "gateway.apply",
      image: group.spec.image,
      http_port: group.spec.http_port,
      https_port: group.spec.https_port,
      sites,
      website_revisions: revisions,
      gateway_group_id: group.id,
    };
    return { config, sig: hash(JSON.stringify(config)) };
  }
  function gatewayDeploy(
    currentGroup: PlatformResource,
    owner: PlatformResource,
    actor: string,
    force = false,
  ) {
    const group = desired(currentGroup),
      { config, sig } = gatewayBundle(group),
      runs: PlatformRun[] = [];
    for (const key of group.spec.agent_ids) {
      if (!online(key)) {
        if (force) fail(409, "gateway_agent_offline");
        continue;
      }
      const i = gatewayInstance(group, key);
      if (i.last_bundle_sig === sig && i.state === "running" && !force)
        continue;
      const run = dispatch(owner, i, "deploy", config, actor, sig);
      if (run) runs.push(run);
    }
    for (const i of instances(group.id).filter(
      (i) =>
        !group.spec.agent_ids.includes(i.agent_id) &&
        !["stopped", "removed"].includes(i.state),
    )) {
      db.run(
        "UPDATE ops_platform_instances SET desired_state='stopped' WHERE id=?",
        i.id,
      );
      if (online(i.agent_id)) {
        const run = dispatch(
          store.get(group.id),
          i,
          "stop",
          { task: "gateway.stop" },
          actor,
          i.desired_generation,
        );
        if (run) runs.push(run);
      }
    }
    store.patchStatus(group.id, { ...currentGroup.status, enabled: true });
    publish(group.id);
    return { runs };
  }
  const observer = store.subscribe((run, config, update) => {
    if (config.modern_cluster || config.modern_instance) return;
    if (config.task === "node.inspect") {
      if (run.state === "succeeded" && run.result.node) {
        db.run(
          "INSERT INTO ops_platform_nodes(agent_id,node_json,last_seen) VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET node_json=excluded.node_json,last_seen=excluded.last_seen",
          run.agent_id,
          JSON.stringify(run.result.node),
          at(),
        );
        const pool = store.get(run.resource_id, "node_pool");
        store.patchStatus(pool.id, {
          ...pool.status,
          nodes: pool.spec.agent_ids.map((agentID: string) => ({
            agent_id: agentID,
            online: online(agentID),
            capacity: capacity(agentID),
            reserved: usage(agentID),
          })),
          last_observed_at: at(),
        });
      }
      return;
    }
    if (!config.instance_id) return;
    const i = db.get<Instance>(
      "SELECT * FROM ops_platform_instances WHERE id=?",
      config.instance_id,
    );
    if (!i) return;
    const terminal = ["succeeded", "failed", "unknown", "cancelled"].includes(
      run.state,
    );
    const inspection = /\.(inspect|logs)$/.test(config.task);
    let state = i.state,
      healthy = i.healthy,
      lastSeen = i.last_seen,
      observedGeneration = i.observed_generation,
      bundle = i.last_bundle_sig;
    if (terminal) {
      if (run.state === "succeeded") {
        if (
          config.task.endsWith(".stop") ||
          config.task === "workload.remove"
        ) {
          state = config.task === "workload.remove" ? "removed" : "stopped";
          healthy = 0;
          db.run("DELETE FROM ops_platform_ports WHERE instance_id=?", i.id);
        } else if (config.task.endsWith(".logs")) {
        } else {
          state =
            run.result.running === false ||
            run.result.containers?.length === 0 ||
            run.result.containers?.every((c: any) => c.running === false)
              ? "stopped"
              : "running";
          healthy = run.result.healthy === true ? 1 : 0;
          lastSeen = at();
          if (!inspection) observedGeneration = i.desired_generation;
          if (config.task === "gateway.apply")
            bundle = hash(
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(config).filter(([k]) => k !== "instance_id"),
                ),
              ),
            );
          if (config.task === "workload.apply") {
            db.run("DELETE FROM ops_platform_ports WHERE instance_id=?", i.id);
            for (const p of applicationPorts(config.application))
              reservePort(i, p.host_port, p.protocol ?? "tcp");
          }
          if (config.task === "gateway.apply") {
            db.run("DELETE FROM ops_platform_ports WHERE instance_id=?", i.id);
            reservePort(i, config.http_port);
            reservePort(i, config.https_port);
          }
        }
      } else if (!inspection) {
        state = run.state === "unknown" ? "unknown" : "failed";
        healthy = 0;
      }
    }
    const failure =
      terminal &&
      !config.task.endsWith(".logs") &&
      (run.state !== "succeeded" || !healthy);
    db.run(
      "UPDATE ops_platform_instances SET state=?,healthy=?,last_seen=?,observed_generation=?,observed_json=?,last_bundle_sig=?,health_failures=?,restart_count=?,updated_at=? WHERE id=?",
      state,
      healthy,
      lastSeen,
      observedGeneration,
      terminal && run.state === "succeeded" && !config.task.endsWith(".logs")
        ? JSON.stringify(run.result)
        : i.observed_json,
      bundle,
      terminal ? (failure ? i.health_failures + 1 : 0) : i.health_failures,
      terminal && healthy ? 0 : i.restart_count,
      at(),
      i.id,
    );
    publish(i.owner_id);
    if (config.task === "gateway.apply" && terminal)
      for (const [siteID, revision] of Object.entries(
        config.website_revisions ?? {},
      )) {
        let site: PlatformResource;
        try {
          site = desired(store.get(siteID, "website"));
        } catch {
          continue;
        }
        const statuses = {
          ...(site.status.gateways ?? {}),
          [i.agent_id]: {
            run_id: run.id,
            state: run.state,
            revision,
            updated_at: at(),
            digest: run.result.digest ?? "",
            error: run.state === "succeeded" ? "" : update.code,
          },
        };
        const group = desired(
          store.get(site.spec.gateway_group_id, "gateway_group"),
        );
        const synchronized = group.spec.agent_ids.every(
          (key: string) =>
            statuses[key]?.state === "succeeded" &&
            statuses[key]?.revision === site.revision,
        );
        const active = site.status.enabled === true && synchronized;
        store.patchStatus(site.id, {
          ...site.status,
          gateways: statuses,
          active,
          synchronized,
          phase:
            site.status.enabled === false
              ? synchronized
                ? "disabled"
                : "disabling"
              : active
                ? "active"
                : run.state === "succeeded"
                  ? "deploying"
                  : "failed",
        });
      }
  });
  function dnsDesired(currentSite: PlatformResource) {
    const site = desired(currentSite);
    if (
      !site.spec.dns_enabled ||
      (!site.status.active &&
        !(site.status.enabled === false && site.status.synchronized))
    )
      return null;
    const group = desired(
      store.get(site.spec.gateway_group_id, "gateway_group"),
    );
    const healthyAgents =
      site.status.enabled === false
        ? []
        : group.spec.agent_ids.filter((key: string) => {
            const i = instances(group.id).find((i) => i.agent_id === key);
            // A queued reload still serves the last verified configuration. Keep its DNS lease until failure or observation expiry.
            return (
              i &&
              i.healthy === 1 &&
              !["stopped", "removed", "failed", "unknown"].includes(i.state) &&
              deps.now().getTime() - Date.parse(i.last_seen) < 120000
            );
          });
    const records = healthyAgents.flatMap((key: string) => {
      const address =
        gatewayAddress(key,group.spec.public_addresses?.[key] ?? instances(group.id).find((i) => i.agent_id === key)?.address);
      if (!address || !isIP(address))
        fail(400, "gateway_public_ip_required_for_dns");
      return site.spec.domains.map((name: string) => ({
        name,
        type: isIP(address) === 6 ? "AAAA" : "A",
        value: address,
        ttl: 600,
      }));
    });
    const signature = hash(JSON.stringify(records));
    return site.status.dns_signature === signature
      ? null
      : { site, records, signature };
  }
  function startDNS(resource: PlatformResource, actor: string) {
    if (closed || dnsPending.has(resource.id) || dnsPending.size >= 8) return;
    const plan = dnsDesired(resource);
    if (!plan) return;
    if (
      resource.status.dns_error_at &&
      deps.now().getTime() - Date.parse(resource.status.dns_error_at) < 30000
    )
      return;
    const work = ensureDnsRecords(
      options,
      plan.site.spec.dns_zone_id,
      resource.id,
      plan.records,
      actor,
    )
      .then((dns) => {
        store.patchStatus(resource.id, {
          ...store.get(resource.id).status,
          dns,
          ...(dns.verified
            ? { dns_signature: plan.signature, dns_error: "", dns_error_at: "" }
            : {}),
          dns_updated_at: at(),
        });
      })
      .catch((error) => {
        try {
          store.patchStatus(resource.id, {
            ...store.get(resource.id).status,
            dns_error:
              error instanceof Error ? error.message : "dns_refresh_failed",
            dns_error_at: at(),
          });
        } catch {}
      })
      .finally(() => {
        dnsPending.delete(resource.id);
      });
    dnsPending.set(resource.id, work);
  }
  deps.router.get("/api/v1/ops/resources/:id/endpoints", (ctx) => {
    deps.auth.requireAdmin(ctx);
    const app = store.get(ctx.params.id, "application");
    const name = ctx.url.searchParams.get("port_name") ?? undefined;
    if (name && !app.spec.ports.some((p: any) => p.name === name))
      fail(400, "application_port_not_found");
    ctx.res.setHeader("cache-control", "no-store");
    const cid = ctx.url.searchParams.get("cluster_id");
    if (!cid) fail(400, "cluster_required");
    if (!app.spec.deployments?.some((d: any) => d.cluster_id === cid))
      fail(400, "application_not_deployed_in_cluster");
    ctx.json({
      service_name: app.spec.service_name,
      endpoints: modern.endpoints(app.id, name, cid),
    });
  });
  const controller: DomainController = {
    actions(r) {
      if (modern.handles(r)) return modern.actions(r);
      if (r.kind === "application")
        return ["deploy", "inspect", "stop", "remove", "logs"];
      if (r.kind === "service")
        return ["deploy", "reconcile", "inspect", "stop", "endpoints"];
      if (r.kind === "node_pool") return ["inspect"];
      if (r.kind === "gateway_group") return ["deploy", "inspect", "stop"];
      if (r.kind === "website") return ["deploy", "inspect", "disable"];
      return [];
    },
    async perform(r, action, input, actor) {
      if (!this.actions(r).includes(action))
        fail(400, "unsupported_workload_action");
      assertImplementedHostProfile(r, action);
      if (modern.handles(r)) return modern.perform(r, action, input, actor);
      if (r.kind === "node_pool")
        return {
          runs: discoverNodes(r, actor, true),
          nodes: r.spec.agent_ids.map((key: string) => ({
            agent_id: key,
            online: online(key),
            capacity: capacity(key),
            reserved: usage(key),
          })),
        };
      if (r.kind === "service" && action === "endpoints")
        return store.run(r, action, actor, async () => ({
          endpoints: endpoints(r.id),
        }));
      if (r.kind === "application" && action === "deploy") {
        store.patchStatus(r.id, {
          ...r.status,
          desired_revision: r.revision,
          policy_actor: actor,
        });
        return applicationDeploy(store.get(r.id), input, actor);
      }
      if (r.kind === "service" && ["deploy", "reconcile"].includes(action)) {
        store.patchStatus(r.id, {
          ...r.status,
          enabled: true,
          desired_revision: r.revision,
          application_revision: store.get(r.spec.application_id).revision,
          node_pool_revision: store.get(r.spec.node_pool_id).revision,
          policy_actor: actor,
        });
        return serviceReconcile(store.get(r.id), actor, true);
      }
      if (r.kind === "gateway_group" && action === "deploy") {
        store.patchStatus(r.id, {
          ...r.status,
          desired_revision: r.revision,
          policy_actor: actor,
        });
        return gatewayDeploy(store.get(r.id), store.get(r.id), actor, true);
      }
      if (r.kind === "website") {
        const group = store.get(r.spec.gateway_group_id, "gateway_group");
        if (action === "inspect")
          return store.run(r, action, actor, async () => ({
            gateways: r.status.gateways ?? {},
            active: r.status.active ?? false,
            dns: r.status.dns ?? {},
            endpoints: r.spec.service_id
              ? endpoints(r.spec.service_id)
              : undefined,
          }));
        if (action === "deploy" && r.spec.https) {
          let available = false;
          try {
            available =
              Date.parse(
                getCertificateMaterial(store, r.spec.certificate_id).expires_at,
              ) > deps.now().getTime();
          } catch {}
          if (!available && options.ensureCertificateMaterial)
            await options.ensureCertificateMaterial(
              r.spec.certificate_id,
              actor,
            );
          const material = getCertificateMaterial(store, r.spec.certificate_id);
          if (Date.parse(material.expires_at) <= deps.now().getTime())
            fail(409, "website_certificate_expired");
        }
        store.patchStatus(r.id, {
          ...r.status,
          enabled: action !== "disable",
          desired_revision:
            action === "disable"
              ? (r.status.desired_revision ?? r.revision)
              : r.revision,
          policy_actor: actor,
          active: false,
          phase: "deploying",
        });
        if (!group.status.desired_revision)
          store.patchStatus(group.id, {
            ...group.status,
            desired_revision: group.revision,
            policy_actor: actor,
          });
        return gatewayDeploy(store.get(group.id), store.get(r.id), actor, true);
      }
      const rows = instances(r.id).filter(
        (i) => !input.instance_id || i.id === input.instance_id,
      );
      if (!rows.length) fail(409, "resource_not_deployed");
      const runs: PlatformRun[] = [];
      for (const i of rows) {
        const gateway = r.kind === "gateway_group",
          task = gateway
            ? "gateway." + (action === "inspect" ? "inspect" : "stop")
            : "workload." +
              (action === "remove"
                ? "remove"
                : action === "stop"
                  ? "stop"
                  : action === "logs"
                    ? "logs"
                    : "inspect");
        if (action === "stop" || action === "remove")
          db.run(
            "UPDATE ops_platform_instances SET desired_state='stopped' WHERE id=?",
            i.id,
          );
        const run = dispatch(
          r,
          i,
          action,
          {
            task,
            ...(action === "logs"
              ? { tail: input.tail ?? 100, container_id: input.container_id }
              : {}),
            health: r.spec.health,
            probe_port: i.port,
          },
          actor,
          i.desired_generation,
        );
        if (run) runs.push(run);
      }
      if (action === "stop" || action === "remove")
        store.patchStatus(r.id, { ...store.get(r.id).status, enabled: false });
      publish(r.id);
      return { runs };
    },
    async tick() {
      if (closed) return;
      await modern.tick();
      for (const r of store
        .list()
        .filter(
          (r) =>
            ownKinds.has(r.kind) &&
            !modern.handles(r) &&
            store.authorized(r.status.policy_actor ?? r.authorized_by),
        )) {
        const actor = r.status.policy_actor ?? r.authorized_by;
        try {
          if (r.kind === "website") startDNS(r, actor);
        } catch (e) {
          store.patchStatus(r.id, {
            ...store.get(r.id).status,
            last_error:
              e instanceof Error ? e.message : "workload_reconciliation_failed",
            last_error_at: at(),
          });
        }
      }
    },
    async close() {
      closed = true;
      await modern.close();
      await Promise.allSettled([...dnsPending.values()]);
      observer();
    },
  };
  return controller;
}
