import {machineServiceAddresses} from "../server/host-network.js";
import {networkScope} from "../shared/host-network.js";
import { effectiveAuth } from "../operations/basic-auth.js";
import { normalizeWebsiteAuth } from "./website-auth.js";
import { catalogTemplate } from "./catalog.js";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { id } from "../shared/crypto.js";
import { fail } from "../shared/http.js";
import { hash } from "../operations/website-files.js";
import {
  normalizeApplication,
  applicationResources,
  applicationPorts,
  renderGateway,
  files,
  port,
} from "../operations/platform.js";
import { normalizeLocations, normalizeNginx } from "../operations/nginx.js";
import { getCertificateMaterial } from "./certificates.js";
import {
  SYSTEM_SERVICE_NAMES,
  systemApplicationID,
  systemApplicationKind,
} from "./system-applications.js";
import { privateRegistryAddress } from "../operations/registry-address.js";
import { registryRuntime, registryCacheFor } from "./registry-runtime.js";
import { hostPortOverrides } from './application-ports.js';
import { ensureDnsRecords, normalizeDomain, CloudError } from "./cloud.js";
import type {
  PlatformOptions,
  PlatformResource,
  PlatformRun,
} from "./types.js";

type Row = Record<string, any>;
const ACTIVE = new Set([
  "queued",
  "leased",
  "accepted",
  "preflighting",
  "staging",
  "activating",
  "verifying",
]);
const label = (v: unknown, error = "invalid_service_name") => {
  if (
    typeof v !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v)
  )
    fail(400, error);
  return v as string;
};
const list = (v: any, field: string): string[] => {
  if (
    !Array.isArray(v) ||
    v.length > 100 ||
    v.some((x) => typeof x !== "string" || !x)
  )
    fail(400, "invalid_" + field);
  return [...new Set(v)] as string[];
};
const num = (v: any, fallback: number, min: number, max: number) => {
  const n = v ?? fallback;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)
    fail(400, "invalid_application_number");
  return n;
};
const names = (value: any) =>
  list(value, "domains").map((v) => {
    const d = domainToASCII(v.toLowerCase());
    if (
      !d ||
      d.length > 253 ||
      !d
        .split(".")
        .every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))
    )
      fail(400, "invalid_website_domain");
    return d;
  });
const domainClusters = (
  spec: Row,
  domain: string,
  available: string[],
): string[] => {
  const selected = spec.domain_routes?.find(
    (r: Row) => r.domain === domain,
  )?.cluster_ids;
  return selected === undefined
    ? available
    : available.filter((cid) => selected.includes(cid));
};
const domainNames = (spec: Row): string[] =>
  (spec.bindings ?? []).flatMap((b: Row) => b.domains);
const policyFor = (spec: Row, cid: string, domain?: string): Row => ({
  enabled: true,
  weight: 1,
  default: true,
  lines: [],
  ...(spec.cluster_policies ?? []).find((p: Row) => p.cluster_id === cid),
  ...(domain
    ? spec.domain_routes
        ?.find((r: Row) => r.domain === domain)
        ?.cluster_policies?.find((p: Row) => p.cluster_id === cid)
    : {}),
});
export function createClusterWorkloads(
  options: PlatformOptions & {
    ensureCertificateMaterial?: (id: string, actor: string) => Promise<void>;
  },
) {
  const { store, deps } = options,
    { db } = deps;
  const at = () => deps.now().toISOString();
  let closed = false;
  const dnsPending = new Map<string, Promise<void>>();
  db.exec(`CREATE TABLE IF NOT EXISTS ops_platform_cluster_members(machine_id TEXT PRIMARY KEY,cluster_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ops_platform_cluster_members_cluster ON ops_platform_cluster_members(cluster_id);
    CREATE TABLE IF NOT EXISTS ops_cluster_instances(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,slot TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 1,retired INTEGER NOT NULL DEFAULT 0,cpu REAL NOT NULL DEFAULT 0,memory_mb REAL NOT NULL DEFAULT 0,address TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'pending',healthy INTEGER NOT NULL DEFAULT 0,last_seen TEXT NOT NULL DEFAULT '',desired_generation TEXT NOT NULL DEFAULT '',observed_generation TEXT NOT NULL DEFAULT '',current_run_id TEXT NOT NULL DEFAULT '',desired_state TEXT NOT NULL DEFAULT 'running',observed_json TEXT NOT NULL DEFAULT '{}',last_bundle_sig TEXT NOT NULL DEFAULT '',health_failures INTEGER NOT NULL DEFAULT 0,restart_count INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);

    CREATE INDEX IF NOT EXISTS ops_cluster_instance_machine ON ops_cluster_instances(machine_id);
    CREATE TABLE IF NOT EXISTS ops_platform_instance_ports(instance_id TEXT NOT NULL,name TEXT NOT NULL,service TEXT NOT NULL DEFAULT '',container_port INTEGER NOT NULL,host_port INTEGER NOT NULL,protocol TEXT NOT NULL,app_protocol TEXT NOT NULL DEFAULT '',host_ip TEXT NOT NULL DEFAULT '0.0.0.0',PRIMARY KEY(instance_id,name));`);
  const columns = db.all<Row>("PRAGMA table_info(ops_cluster_instances)");
  if (!columns.some((c) => c.name === "cluster_id"))
    db.exec(
      "ALTER TABLE ops_cluster_instances ADD COLUMN cluster_id TEXT NOT NULL DEFAULT ''",
    );
  db.exec(`DROP INDEX IF EXISTS ops_cluster_instance_slot;
    CREATE UNIQUE INDEX IF NOT EXISTS ops_cluster_instance_cluster_slot ON ops_cluster_instances(owner_id,cluster_id,slot) WHERE retired=0;
    CREATE TABLE IF NOT EXISTS ops_platform_application_deployments(application_id TEXT NOT NULL,cluster_id TEXT NOT NULL,role TEXT NOT NULL,desired_revision INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 0,policy_actor TEXT NOT NULL DEFAULT '',status_json TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(application_id,cluster_id));
    CREATE UNIQUE INDEX IF NOT EXISTS ops_platform_cluster_openresty ON ops_platform_application_deployments(cluster_id) WHERE role='openresty';
    CREATE TABLE IF NOT EXISTS ops_platform_website_deployments(website_id TEXT NOT NULL,cluster_id TEXT NOT NULL,desired_revision INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 0,policy_actor TEXT NOT NULL DEFAULT '',status_json TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(website_id,cluster_id));
    CREATE TABLE IF NOT EXISTS ops_platform_node_conflicts(agent_id TEXT NOT NULL,protocol TEXT NOT NULL,port INTEGER NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(agent_id,protocol,port));`);
  const normalizeLegacy = (kind: string, input: Row) => {
    const s = structuredClone(input);
    if (kind === "application" && s.cluster_id && !s.deployments) {
      s.deployments = [
        {
          cluster_id: s.cluster_id,
          machine_ids: s.machine_ids ?? [],
          replicas: s.replicas ?? 1,
          cpu: s.cpu ?? 0.25,
          memory_mb: s.memory_mb ?? 256,
          stateful_acknowledged: s.stateful_acknowledged === true,
        },
      ];
      for (const k of [
        "cluster_id",
        "machine_ids",
        "replicas",
        "cpu",
        "memory_mb",
        "stateful_acknowledged",
      ])
        delete s[k];
    }
    if (kind === "website" && s.cluster_id && s.bindings && !s.cluster_ids) {
      s.cluster_ids = [s.cluster_id];
      for (const b of s.bindings)
        for (const l of b.locations ?? []) {
          if (l.target !== "static" && l.action !== "return")
            l.cluster_targets = [
              {
                cluster_id: s.cluster_id,
                target: l.target,
                application_id: l.application_id,
                port_name: l.port_name,
                upstreams: l.upstreams,
              },
            ];
          for (const k of [
            "target",
            "application_id",
            "port_name",
            "upstreams",
            "service_id",
          ])
            delete l[k];
        }
      delete s.cluster_id;
      delete s.openresty_application_id;
    }
    return s;
  };
  // Normalize the 042 single-cluster schema in place: no new revisions or container recreation.
  db.transaction(() => {
    for (const resource of db.all<Row>(
      "SELECT * FROM ops_platform_resources WHERE kind IN ('application','website')",
    )) {
      const original = JSON.parse(deps.decrypt(resource.spec_cipher)),
        spec = normalizeLegacy(resource.kind, original),
        status = JSON.parse(resource.status_json);
      if (JSON.stringify(spec) !== JSON.stringify(original))
        db.run(
          "UPDATE ops_platform_resources SET spec_cipher=? WHERE id=?",
          deps.encrypt(JSON.stringify(spec)),
          resource.id,
        );
      if (spec.deployments)
        for (const d of spec.deployments) {
          db.run(
            "INSERT OR IGNORE INTO ops_platform_application_deployments(application_id,cluster_id,role,desired_revision,enabled,policy_actor,status_json) VALUES(?,?,?,?,?,?,?)",
            resource.id,
            d.cluster_id,
            spec.role ?? "generic",
            status.desired_revision ?? 0,
            status.enabled === true ? 1 : 0,
            status.policy_actor ?? resource.authorized_by,
            JSON.stringify({}),
          );
          if (original.cluster_id)
            db.run(
              "UPDATE ops_cluster_instances SET cluster_id=? WHERE owner_id=? AND cluster_id=''",
              d.cluster_id,
              resource.id,
            );
        }
      if (spec.cluster_ids && spec.bindings)
        for (const cid of spec.cluster_ids) {
          const instances: Row = {};
          for (const i of db.all<Row>(
            "SELECT id,machine_id FROM ops_cluster_instances WHERE cluster_id=?",
            cid,
          ))
            if (status.machines?.[i.machine_id])
              instances[i.id] = status.machines[i.machine_id];
          db.run(
            "INSERT OR IGNORE INTO ops_platform_website_deployments(website_id,cluster_id,desired_revision,enabled,policy_actor,status_json) VALUES(?,?,?,?,?,?)",
            resource.id,
            cid,
            status.desired_revision ?? 0,
            status.enabled === true ? 1 : 0,
            status.policy_actor ?? resource.authorized_by,
            JSON.stringify({ instances }),
          );
        }
    }
    for (const revision of db.all<Row>(
      "SELECT v.resource_id,v.revision,v.spec_cipher,r.kind FROM ops_platform_revisions v JOIN ops_platform_resources r ON r.id=v.resource_id WHERE r.kind IN ('application','website')",
    )) {
      const original = JSON.parse(deps.decrypt(revision.spec_cipher)),
        spec = normalizeLegacy(revision.kind, original);
      if (JSON.stringify(spec) !== JSON.stringify(original))
        db.run(
          "UPDATE ops_platform_revisions SET spec_cipher=? WHERE resource_id=? AND revision=?",
          deps.encrypt(JSON.stringify(spec)),
          revision.resource_id,
          revision.revision,
        );
    }
  });
  const deploymentRow = (
    kind: string,
    owner: string,
    cid: string,
  ): Row | undefined =>
    db.get<Row>(
      kind === "application"
        ? "SELECT * FROM ops_platform_application_deployments WHERE application_id=? AND cluster_id=?"
        : "SELECT * FROM ops_platform_website_deployments WHERE website_id=? AND cluster_id=?",
      owner,
      cid,
    );
  const deploymentStatus = (r: Row) => ({
    ...JSON.parse(r.status_json),
    desired_revision: r.desired_revision,
    enabled: r.enabled === 1,
    policy_actor: r.policy_actor,
  });
  const patchDeployment = (
    kind: string,
    owner: string,
    cid: string,
    patch: Row,
  ) => {
    const d = deploymentRow(kind, owner, cid);
    if (!d) fail(400, "application_not_deployed_in_cluster");
    const next = { ...deploymentStatus(d!), ...patch },
      { desired_revision, enabled, policy_actor, ...status } = next;
    db.run(
      kind === "application"
        ? "UPDATE ops_platform_application_deployments SET desired_revision=?,enabled=?,policy_actor=?,status_json=? WHERE application_id=? AND cluster_id=?"
        : "UPDATE ops_platform_website_deployments SET desired_revision=?,enabled=?,policy_actor=?,status_json=? WHERE website_id=? AND cluster_id=?",
      desired_revision ?? 0,
      enabled ? 1 : 0,
      policy_actor ?? "",
      JSON.stringify(status),
      owner,
      cid,
    );
  };
  const project = (r: PlatformResource, cid: string) => {
    if (r.kind === "website")
      return {
        ...r,
        spec: { ...r.spec, cluster_id: cid },
        status: deploymentRow(r.kind, r.id, cid)
          ? deploymentStatus(deploymentRow(r.kind, r.id, cid)!)
          : {},
      };
    const d = r.spec.deployments?.find((d: Row) => d.cluster_id === cid);
    if (!d) fail(400, "application_not_deployed_in_cluster");
    return {
      ...r,
      spec: {
        ...r.spec,
        ...d,
        ports: (r.spec.ports??[]).map((p:Row)=>({...p,host_port:d.host_ports&&Object.hasOwn(d.host_ports,p.name)?d.host_ports[p.name]:p.host_port})),
        ...(r.spec.role === "openresty"
          ? { service_name: SYSTEM_SERVICE_NAMES.openresty }
          : {}),
        cluster_id: cid,
      },
      status: deploymentRow(r.kind, r.id, cid)
        ? deploymentStatus(deploymentRow(r.kind, r.id, cid)!)
        : {},
    };
  };
  const tableExists = (table: string) =>
    !!db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      table,
    );
  const machine = (key: string): Row => {
    const m = tableExists("managed_machines")
      ? db.get<Row>("SELECT * FROM managed_machines WHERE id=?", key)
      : undefined;
    if (!m) fail(400, "registered_machine_required");
    return m;
  };
  const agent = (key: string): Row | undefined =>
    db.get<Row>(
      "SELECT * FROM agents WHERE id=? AND NOT EXISTS (SELECT 1 FROM agent_lifecycle l WHERE l.agent_id=agents.id AND l.state='removed')",
      key,
    );
  const online = (key: string) => {
    const a = agent(key);
    return !!a && deps.now().getTime() - Date.parse(a.last_seen) < 120000;
  };
  const rows = (owner: string, retired = false, cid?: string) =>
    db.all<Row>(
      "SELECT * FROM ops_cluster_instances WHERE owner_id=?" +
        (cid ? " AND cluster_id=?" : "") +
        (retired ? "" : " AND retired=0") +
        " ORDER BY cluster_id,slot,attempt",
      ...[owner, ...(cid ? [cid] : [])],
    );
  const row = (key: string) =>
    db.get<Row>("SELECT * FROM ops_cluster_instances WHERE id=?", key)!;
  const ports = (key: string) =>
    db.all<Row>(
      "SELECT * FROM ops_platform_instance_ports WHERE instance_id=? ORDER BY name",
      key,
    );
  const desired = (r: PlatformResource, cid?: string): PlatformResource => {
    const clusterID = cid ?? r.spec.cluster_id;
    const d = clusterID ? deploymentRow(r.kind, r.id, clusterID) : undefined;
    const version = Number(d?.desired_revision || r.revision);
    let saved = r;
    if (version !== r.revision) {
      const old = db.get<Row>(
        "SELECT name,spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision=?",
        r.id,
        version,
      );
      if (!old) fail(409, "authorized_revision_missing");
      saved = {
        ...r,
        name: old.name,
        revision: version,
        spec: normalizeLegacy(
          r.kind,
          JSON.parse(deps.decrypt(old.spec_cipher)),
        ),
      };
    }
    return clusterID ? project(saved, clusterID) : saved;
  };
  const snapshots = (r: PlatformResource) => [
    r.spec,
    ...db
      .all<Row>(
        r.kind === "application"
          ? "SELECT DISTINCT desired_revision FROM ops_platform_application_deployments WHERE application_id=? AND desired_revision>0"
          : "SELECT DISTINCT desired_revision FROM ops_platform_website_deployments WHERE website_id=? AND desired_revision>0 AND enabled=1",
        r.id,
      )
      .map((d) => {
        const old = db.get<Row>(
          "SELECT spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision=?",
          r.id,
          d.desired_revision,
        );
        return old
          ? normalizeLegacy(r.kind, JSON.parse(deps.decrypt(old.spec_cipher)))
          : r.spec;
      }),
  ];
  const cluster = (key: string) => store.get(key, "cluster");
  const member = (clusterID: string, key: string) => {
    if (!cluster(clusterID).spec.machine_ids.includes(key))
      fail(409, "cluster_resource_mismatch");
    return machine(key);
  };
  const capacity = (c: PlatformResource, key: string) => {
    const m = machine(key),
      override = c.spec.nodes.find((n: Row) => n.machine_id === key) ?? {};
    const cached = db.get<Row>(
      "SELECT node_json FROM ops_platform_nodes WHERE agent_id=?",
      m.agent_id,
    );
    let heart: Row = {};
    try {
      heart = JSON.parse(agent(m.agent_id)?.heartbeat ?? "{}");
    } catch {}
    return {
      machine_id: key,
      agent_id: m.agent_id,
      cpu: Number(heart.cpu_count ?? heart.cpu?.cores ?? 0),
      memory_mb: Number(
        heart.memory_total_mb ??
          (heart.memory?.total ? heart.memory.total / 1048576 : 0),
      ),
      ...(cached ? JSON.parse(cached.node_json) : {}),
      ...override,
      ...machineServiceAddresses(db,key),
    };
  };
  const busy = (i: Row) =>
    !!i.current_run_id &&
    ACTIVE.has(
      db.get<Row>(
        "SELECT state FROM ops_platform_runs WHERE id=?",
        i.current_run_id,
      )?.state,
    );
  const fresh = (i: Row) =>
    machine(i.machine_id).agent_id === i.agent_id &&
    i.healthy === 1 &&
    i.state === "running" &&
    i.desired_state === "running" &&
    !i.retired &&
    online(i.agent_id) &&
    deps.now().getTime() - Date.parse(i.last_seen) < 120000;
  const endpoints = (resourceID: string, name?: string, cid?: string) =>
    rows(resourceID, false, cid)
      .filter(fresh)
      .flatMap((i) =>
        ports(i.id)
          .filter((p) => !name || p.name === name)
          .map((p) => ({
            cluster_id: i.cluster_id,
            instance_id: i.id,
            agent_id: i.agent_id,
            machine_id: i.machine_id,
            ip: p.host_ip && !['0.0.0.0','::'].includes(p.host_ip) ? p.host_ip : machineServiceAddresses(db,i.machine_id).address,
            host_ip: p.host_ip,
            port: p.host_port,
            port_name: p.name,
            protocol: p.protocol,
            ...(p.app_protocol ? { app_protocol: p.app_protocol } : {}),
            version: i.observed_generation,
          })),
      );
  const publish = (key: string) => {
    const r = store.get(key),
      instances = rows(key, true),
      summaries: Row[] = [];
    let bytes = 0;
    for (const i of instances) {
      const observation = JSON.parse(i.observed_json),
        summary = {
          id: i.id,
          cluster_id: i.cluster_id,
          machine_id: i.machine_id,
          agent_id: i.agent_id,
          slot: i.slot,
          attempt: i.attempt,
          retired: !!i.retired,
          address: i.address,
          cpu: i.cpu,
          memory_mb: i.memory_mb,
          state: i.state,
          healthy: fresh(i),
          ports: ports(i.id),
          desired_generation: i.desired_generation,
          observed_generation: i.observed_generation,
          last_seen: i.last_seen,
          health_failures: i.health_failures,
          restart_count: i.restart_count,
          observed: {
            digest: observation.digest ?? "",
            container_count: observation.containers?.length ?? 0,
          },
        };
      const size = Buffer.byteLength(JSON.stringify(summary));
      if (summaries.length >= 100 || bytes + size > 65000) break;
      summaries.push(summary);
      bytes += size;
    }
    const discovered = endpoints(key);
    const deployments = Object.fromEntries(
      db
        .all<Row>(
          "SELECT * FROM ops_platform_application_deployments WHERE application_id=?",
          key,
        )
        .map((d) => [
          d.cluster_id,
          {
            ...deploymentStatus(d),
            instances_total: rows(key, false, d.cluster_id).length,
            applied_revision: rows(key, false, d.cluster_id)
              .filter((i) => i.desired_state === "running")
              .every(
                (i) =>
                  i.observed_generation === String(d.desired_revision) &&
                  fresh(i),
              )
              ? d.desired_revision
              : 0,
          },
        ]),
    );
    store.patchStatus(key, {
      ...r.status,
      deployments,
      instances: summaries,
      instances_total: instances.length,
      instances_truncated: summaries.length < instances.length,
      endpoints: discovered.slice(0, 100),
      endpoints_total: discovered.length,
      last_reconciled_at: at(),
    });
  };
  const usedMachine = (key: string) =>
    db.get(
      "SELECT id FROM ops_cluster_instances WHERE machine_id=? AND state NOT IN ('stopped','removed') LIMIT 1",
      key,
    ) ||
    (tableExists("ops_platform_instances") &&
      db.get(
        "SELECT i.id FROM ops_platform_instances i JOIN managed_machines m ON m.agent_id=i.agent_id WHERE m.id=? AND i.state NOT IN ('stopped','removed') LIMIT 1",
        key,
      ));
  store.register("cluster", {
    validate(s, previous, context) {
      const ids = list(s.machine_ids ?? [], "machine_ids");
      for (const key of ids) {
        machine(key);
        const current = db.get<Row>(
          "SELECT cluster_id FROM ops_platform_cluster_members WHERE machine_id=?",
          key,
        );
        if (current && current.cluster_id !== context?.id)
          fail(409, "machine_already_in_cluster");
      }
      for (const key of previous?.machine_ids ?? [])
        if (!ids.includes(key) && usedMachine(key))
          fail(409, "cluster_machine_in_use");
      const start = port(s.port_start ?? 20000),
        end = port(s.port_end ?? 29999);
      if (start > end) fail(400, "invalid_port_range");
      const nodes = (s.nodes ?? []).map((n: Row) => {
        if (!ids.includes(n.machine_id)) fail(409, "cluster_resource_mismatch");
        return {
          machine_id: n.machine_id,
          ...(n.cpu !== undefined ? { cpu: num(n.cpu, 0, 0.01, 1024) } : {}),
          ...(n.memory_mb !== undefined
            ? { memory_mb: num(n.memory_mb, 0, 4, 4194304) }
            : {}),
        };
      });
      if (new Set(nodes.map((n: Row) => n.machine_id)).size !== nodes.length)
        fail(400, "duplicate_cluster_node");
      const registered = systemApplicationID(store, "registry");
      const registryDeployment = registered
        ? store
            .get(registered, "application")
            .spec.deployments?.find((d: Row) => d.cluster_id === context?.id)
        : undefined;
      if (
        registryDeployment &&
        !ids.includes(registryDeployment.machine_ids[0])
      )
        fail(409, "registry_data_migration_required");
      if (
        s.image_cache?.enabled !== undefined &&
        typeof s.image_cache.enabled !== "boolean"
      )
        fail(400, "invalid_cluster_image_cache");
      if (s.image_cache?.enabled === true) {
        const rid = systemApplicationID(store, "registry");
        if (
          !rid ||
          !store
            .get(rid, "application")
            .spec.deployments?.some((d: Row) => d.cluster_id === context?.id)
        )
          fail(409, "private_registry_install_required");
      }
      return {
        machine_ids: ids,
        port_start: start,
        port_end: end,
        nodes,
        image_cache: { enabled: s.image_cache?.enabled === true },
      };
    },
    afterSave(r) {
      db.run(
        "DELETE FROM ops_platform_cluster_members WHERE cluster_id=?",
        r.id,
      );
      for (const key of r.spec.machine_ids)
        db.run(
          "INSERT INTO ops_platform_cluster_members VALUES(?,?)",
          key,
          r.id,
        );
    },
    beforeDelete(r) {
      if (
        store
          .list()
          .some(
            (x) =>
              (x.id !== r.id && x.spec.cluster_id === r.id) ||
              x.spec.deployments?.some((d: Row) => d.cluster_id === r.id) ||
              x.spec.cluster_ids?.includes(r.id),
          )
      )
        fail(409, "platform_resource_in_use");
      if (r.spec.machine_ids.length) fail(409, "cluster_not_empty");
    },
    afterDelete(r) {
      db.run(
        "DELETE FROM ops_platform_cluster_members WHERE cluster_id=?",
        r.id,
      );
    },
  });
  function validateApplication(
    input: Row,
    old?: Row,
    context?: { id: string; systemKind?: "openresty" | "registry" },
  ) {
    const s = normalizeLegacy("application", input),
      previous = old ? normalizeLegacy("application", old) : undefined;
    const mode = s.deployment_mode ?? "manual",
      source = s.source ?? { type: "custom" },
      role = s.role ?? "generic";
    if (!["manual", "managed"].includes(mode))
      fail(400, "invalid_deployment_mode");
    if (!["store", "custom"].includes(source.type))
      fail(400, "invalid_application_source");
    if (!["generic", "openresty", "registry"].includes(role))
      fail(400, "invalid_application_role");
    if (role === "registry" && context?.systemKind !== "registry")
      fail(403, "system_registry_management_required");
    if (s.system_kind !== undefined || s.system_managed !== undefined)
      fail(400, "system_identity_host_owned");
    if (
      role === "openresty" &&
      store
        .list("application")
        .some((a) => a.id !== context?.id && a.spec.role === "openresty")
    )
      fail(409, "openresty_already_installed");
    if (previous && previous.role !== role)
      fail(409, "application_role_immutable");
    if (source.type === "store") {
      const template = catalogTemplate(source.template_id);
      if ((template.id === "openresty") !== (role === "openresty"))
        fail(400, "application_template_role_mismatch");
      if (
        source.template_version &&
        !template.versions.includes(source.template_version)
      )
        fail(400, "unsupported_template_version");
    }
    if (
      previous &&
      previous.deployment_mode !== mode &&
      rows(context?.id ?? "", true).some(
        (i) => !["stopped", "removed"].includes(i.state),
      )
    )
      fail(409, "stop_before_changing_deployment_mode");
    let serviceName = s.service_name;
    if (role === "openresty" || role === "registry")
      serviceName = SYSTEM_SERVICE_NAMES[role as "openresty" | "registry"];
    else if (typeof serviceName === "string" && serviceName.startsWith("sys-"))
      fail(409, "system_service_name_reserved");
    if (previous && serviceName !== previous.service_name)
      fail(409, "service_name_immutable");
    if (!serviceName) {
      const raw = source.template_id ?? "app",
        base = /^[a-z0-9-]+$/.test(raw) ? raw.slice(0, 52) : "app";
      let n = 1;
      while (
        db.get(
          "SELECT resource_id FROM ops_platform_application_keys WHERE service_name=?",
          base + "-" + n,
        )
      )
        n++;
      serviceName = base + "-" + n;
    }
    label(serviceName);
    if (
      db.get(
        "SELECT resource_id FROM ops_platform_application_keys WHERE service_name=? AND resource_id!=?",
        serviceName,
        context?.id ?? "",
      )
    )
      fail(409, "service_name_conflict");
    const declared = (s.ports ?? []).map((p: Row) => ({
      name: label(p.name, "invalid_port_name"),
      container_port: port(p.container_port),
      host_port: p.host_port ? port(p.host_port) : 0,
      protocol: p.protocol ?? "tcp",
      app_protocol: p.app_protocol ?? "",
      host_ip: p.host_ip ?? "0.0.0.0",
      ...(p.service ? { service: p.service } : {}),
    }));
    if (
      declared.length > 64 ||
      new Set(declared.map((p: Row) => p.name)).size !== declared.length
    )
      fail(400, "duplicate_application_port");
    for (const p of declared)
      if (
        !["tcp", "udp"].includes(p.protocol) ||
        !["", "http", "https", "tcp", "udp"].includes(p.app_protocol) ||
        !isIP(p.host_ip)
      )
        fail(400, "invalid_port_mapping");
    const runtime = normalizeApplication({
      ...s,
      ports:
        role === "openresty" && s.network_mode === "host"
          ? []
          : declared.map((p: Row) => ({
              ...p,
              host_port: p.host_port || p.container_port,
            })),
    });
    const imageIsOpenResty = (image: unknown) =>
      typeof image === "string" && /(?:^|\/)openresty(?:[/:@]|$)/i.test(image);
    if (
      role !== "openresty" &&
      (imageIsOpenResty(runtime.image) ||
        (runtime.compose &&
          Object.values(runtime.compose.services).some((v: any) =>
            imageIsOpenResty(v.image),
          )))
    )
      fail(400, "openresty_role_required");
    if (runtime.mode === "compose")
      for (const [name, service] of Object.entries(
        runtime.compose.services,
      ) as [string, Row][]) {
        service.ports = declared
          .filter(
            (p: Row) =>
              (p.service ?? Object.keys(runtime.compose.services)[0]) === name,
          )
          .map((p: Row) => ({
            target: p.container_port,
            published: String(p.host_port || p.container_port),
            protocol: p.protocol,
            host_ip: p.host_ip,
          }));
      }
    if (runtime.network_mode === "host" && role !== "openresty")
      fail(400, "cluster_application_requires_port_mapping");
    const stateful = Boolean(
      s.stateful ||
        runtime.mounts.some((m: Row) => ["data", "volume"].includes(m.type)) ||
        (runtime.compose &&
          Object.values(runtime.compose.services).some(
            (v: any) => v.volumes?.length,
          )),
    );
    if (
      !Array.isArray(s.deployments) ||
      !s.deployments.length ||
      s.deployments.length > 100
    )
      fail(400, "application_deployment_required");
    const deployments = s.deployments.map((d: Row) => {
      const hostPorts=hostPortOverrides(d.host_ports,declared);
      if(role==='openresty'&&hostPorts&&Object.keys(hostPorts).length)fail(400,'openresty_fixed_host_ports');
      const c = cluster(d.cluster_id),
        targets = list(d.machine_ids ?? [], "machine_ids");
      const template = source.type === 'store' ? catalogTemplate(source.template_id) : undefined;
      if (template?.deployment_modes && !template.deployment_modes.includes(mode)) fail(400, 'catalog_deployment_mode_unsupported');
      if (template?.architectures) for (const key of targets) {
        const machine = member(c.id, key), arch = agent(machine.agent_id)?.arch;
        if (arch && !template.architectures.includes(arch === 'x86_64' ? 'amd64' : arch === 'aarch64' ? 'arm64' : arch)) fail(400, 'catalog_architecture_unsupported');
      }
      targets.forEach((key) => {
        const m = member(c.id, key);
        if (!m.agent_id || !agent(m.agent_id))
          fail(400, "registered_agent_required");
      });
      if (mode === "manual" && !targets.length)
        fail(400, "target_machines_required");
      if (role === "registry") {
        if (mode !== "manual" || targets.length !== 1)
          fail(400, "registry_requires_one_fixed_machine");
        const prior = previous?.deployments.find(
          (p: Row) => p.cluster_id === c.id,
        );
        if (
          prior &&
          prior.machine_ids[0] !== targets[0]
        )
          fail(409, "registry_data_migration_required");

      }
      const replicas = num(d.replicas, 1, 0, 100);
      if (!Number.isInteger(replicas)) fail(400, "invalid_replicas");
      if (mode === "managed" && stateful && d.stateful_acknowledged !== true)
        fail(400, "stateful_managed_acknowledgement_required");
      if (
        role === "openresty" &&
        db.get(
          "SELECT application_id FROM ops_platform_application_deployments WHERE cluster_id=? AND role='openresty' AND application_id!=?",
          c.id,
          context?.id ?? "",
        )
      )
        fail(409, "openresty_already_installed");
      const gateway: Row = {};
      if (role === "openresty" && d.gateway_domain) {
        gateway.gateway_domain = normalizeDomain(d.gateway_domain);
        if (d.gateway_dns_zone_id) {
          const zone = store.get(d.gateway_dns_zone_id, "dns_zone");
          if (
            gateway.gateway_domain !== zone.spec.scope &&
            !gateway.gateway_domain.endsWith("." + zone.spec.scope)
          )
            fail(400, "gateway_domain_outside_dns_scope");
          gateway.gateway_dns_zone_id = zone.id;
        }
      } else if (d.gateway_dns_zone_id)
        fail(400, "openresty_cluster_domain_required");
      return {
        ...gateway,
        ...(hostPorts?{host_ports:hostPorts}:{}),
        ...(role === "registry"
          ? {
              registry_address: privateRegistryAddress(d.registry_address),
              registry_cache_enabled: c.spec.image_cache?.enabled === true,
            }
          : {}),
        cluster_id: c.id,
        machine_ids: targets,
        replicas,
        cpu: num(d.cpu, 0.25, role === "registry" ? 0.03 : 0.01, 1024),
        memory_mb: num(d.memory_mb, 256, role === "registry" ? 64 : 4, 4194304),
        stateful_acknowledged: d.stateful_acknowledged === true,
      };
    });
    const gatewayNames = deployments
      .map((d: Row) => d.gateway_domain)
      .filter(Boolean);
    if (new Set(gatewayNames).size !== gatewayNames.length)
      fail(400, "duplicate_gateway_domain");
    for (const site of store.list("website"))
      for (const saved of snapshots(site))
        for (const b of saved.bindings ?? [])
          if (b.domains.some((name: string) => gatewayNames.includes(name)))
            fail(400, "gateway_domain_conflicts_with_website");
    if (
      new Set(deployments.map((d: Row) => d.cluster_id)).size !==
      deployments.length
    )
      fail(400, "duplicate_application_deployment");
    if (
      role === "openresty" &&
      (runtime.mode !== "container" ||
        declared.length !== 2 ||
        !declared.some(
          (p: Row) =>
            p.name === "http" &&
            p.host_port === 80 &&
            p.container_port === 80 &&
            p.protocol === "tcp",
        ) ||
        !declared.some(
          (p: Row) =>
            p.name === "https" &&
            p.host_port === 443 &&
            p.container_port === 443 &&
            p.protocol === "tcp",
        ))
    )
      fail(400, "openresty_requires_standard_ports");
    if (
      s.health &&
      (!["tcp", "http"].includes(s.health.type) ||
        !declared.some(
          (p: Row) => p.name === s.health.port_name && p.protocol === "tcp",
        ) ||
        (s.health.path !== undefined &&
          (typeof s.health.path !== "string" ||
            !s.health.path.startsWith("/") ||
            /[\r\n]/.test(s.health.path))))
    )
      fail(400, "invalid_health_check");
    if (previous) {
      for (const prior of previous.deployments)
        if (
          !deployments.some((d: Row) => d.cluster_id === prior.cluster_id) &&
          rows(context?.id ?? "", true, prior.cluster_id).some(
            (i) => !["stopped", "removed"].includes(i.state),
          )
        )
          fail(409, "application_deployment_in_use");
      for (const site of store.list("website"))
        for (const spec of snapshots(site))
          for (const b of spec.bindings ?? [])
            for (const l of b.locations ?? [])
              for (const target of l.cluster_targets ?? []) {
                if (target.application_id !== context?.id) continue;
                if (
                  spec.routing_mode === "managed" &&
                  spec.service_application_id === context?.id
                ) {
                  if (
                    !declared.some(
                      (p: Row) => p.name === spec.service_port_name,
                    )
                  )
                    fail(409, "application_port_in_use");
                  continue;
                }
                if (
                  !deployments.some(
                    (d: Row) => d.cluster_id === target.cluster_id,
                  )
                )
                  fail(409, "application_deployment_in_use");
                if (!declared.some((p: Row) => p.name === target.port_name))
                  fail(409, "application_port_in_use");
              }
    }
    delete runtime.cpu;
    delete runtime.memory_mb;
    return {
      ...runtime,
      ...(s.configuration_mode ? {configuration_mode:s.configuration_mode} : {}),
      ports: declared,
      service_name: serviceName,
      source: {
        type: source.type,
        ...(source.template_id
          ? { template_id: String(source.template_id) }
          : {}),
        ...(source.template_version
          ? { template_version: String(source.template_version) }
          : {}),
      },
      role,
      deployment_mode: mode,
      deployments,
      stateful,
      ...(role === "registry"
        ? {
            registry_upstream:
              typeof s.registry_upstream === "string"
                ? s.registry_upstream
                : "",
          }
        : {}),
      ...(s.health
        ? {
            health: {
              type: s.health.type,
              port_name: s.health.port_name,
              path: s.health.path ?? "/",
              interval_seconds: num(s.health.interval_seconds, 30, 5, 3600),
            },
          }
        : {}),
    };
  }
  function afterSaveApplication(
    r: PlatformResource,
    previous?: PlatformResource,
  ) {
    if (previous && previous.spec.deployment_mode !== r.spec.deployment_mode) {
      for (const d of r.spec.deployments) {
        const existing = rows(r.id, false, d.cluster_id).filter((i) =>
          ["stopped", "removed"].includes(i.state),
        );
        for (const i of existing)
          db.run(
            "UPDATE ops_cluster_instances SET slot=? WHERE id=?",
            "mode-swap-" + i.id,
            i.id,
          );
        const seen = new Set<string>();
        for (const [i, row] of existing.entries()) {
          const slot =
            r.spec.deployment_mode === "managed" ? String(i) : row.machine_id;
          db.run(
            "UPDATE ops_cluster_instances SET slot=?,retired=? WHERE id=?",
            slot,
            seen.has(slot) ? 1 : 0,
            row.id,
          );
          seen.add(slot);
        }
      }
    }
    const ids = r.spec.deployments.map((d: Row) => d.cluster_id);
    for (const d of db.all<Row>(
      "SELECT cluster_id FROM ops_platform_application_deployments WHERE application_id=?",
      r.id,
    ))
      if (!ids.includes(d.cluster_id))
        db.run(
          "DELETE FROM ops_platform_application_deployments WHERE application_id=? AND cluster_id=?",
          r.id,
          d.cluster_id,
        );
    for (const d of r.spec.deployments)
      db.run(
        "INSERT INTO ops_platform_application_deployments(application_id,cluster_id,role) VALUES(?,?,?) ON CONFLICT(application_id,cluster_id) DO UPDATE SET role=excluded.role",
        r.id,
        d.cluster_id,
        r.spec.role,
      );
  }
  function beforeDeleteApplication(r: PlatformResource) {
    if (systemApplicationKind(store, r.id) === "registry")
      fail(409, "system_registry_in_use");
    if (dnsPending.has(r.id)) fail(409, "application_dns_refresh_in_progress");
    if (
      tableExists("ops_dns_owned") &&
      db.get("SELECT id FROM ops_dns_owned WHERE owner_id=?", r.id)
    )
      fail(409, "dns_records_cleanup_pending");
    if (rows(r.id, true).some((i) => !["stopped", "removed"].includes(i.state)))
      fail(409, "stop_instances_before_deleting");
    for (const site of store.list("website"))
      for (const spec of snapshots(site))
        if (
          spec.bindings?.some((b: Row) =>
            b.locations.some((l: Row) =>
              l.cluster_targets?.some((t: Row) => t.application_id === r.id),
            ),
          )
        )
          fail(409, "platform_resource_in_use");
  }
  function normalizeTrafficPolicies(inputs: Row[]): Row[] {
    if (!Array.isArray(inputs) || inputs.length > 100)
      fail(400, "invalid_website_cluster_policy");
    const policies = inputs.map((p: Row) => {
      if (!p || typeof p !== "object" || Array.isArray(p))
        fail(400, "invalid_website_cluster_policy");
      cluster(p.cluster_id);
      if (
        !Number.isInteger(p.weight ?? 1) ||
        (p.weight ?? 1) < 1 ||
        (p.weight ?? 1) > 100
      )
        fail(400, "invalid_website_cluster_weight");
      if (
        (p.enabled !== undefined && typeof p.enabled !== "boolean") ||
        (p.default !== undefined && typeof p.default !== "boolean")
      )
        fail(400, "invalid_website_cluster_policy");
      if (!Array.isArray(p.lines ?? []) || (p.lines ?? []).length > 100)
        fail(400, "invalid_dns_line");
      const lines = (p.lines ?? []).map((l: Row) => {
        if (
          !l ||
          typeof l !== "object" ||
          typeof l.id !== "string" ||
          !l.id ||
          l.id.length > 99 ||
          /[\r\n\0]/.test(l.id) ||
          typeof l.name !== "string" ||
          !l.name ||
          l.name.length > 100
        )
          fail(400, "invalid_dns_line");
        return { id: l.id, name: l.name };
      });
      if (new Set(lines.map((l: Row) => l.id)).size !== lines.length)
        fail(400, "invalid_dns_line");
      return {
        cluster_id: p.cluster_id,
        enabled: p.enabled !== false,
        weight: p.weight ?? 1,
        default: p.default !== false,
        lines,
      };
    });
    if (
      new Set(policies.map((p: Row) => p.cluster_id)).size !== policies.length
    )
      fail(400, "duplicate_website_cluster_policy");
    return policies;
  }
  function validateWebsite(
    input: Row,
    previous?: Row,
    context?: { id: string; stored?: boolean },
  ) {
    const s = normalizeLegacy("website", input);
    const siteAuth = normalizeWebsiteAuth(
      s.auth,
      previous?.auth,
      false,
      context?.stored,
    );
    if (s.cluster_overrides || s.scope || s.openresty_application_id)
      fail(400, "website_cluster_override_not_supported");
    const routing = s.routing_mode ?? "manual",
      dnsMode = s.dns_record_mode ?? "address";
    if (!["manual", "managed"].includes(routing))
      fail(400, "invalid_website_routing_mode");
    if (!["address", "cname"].includes(dnsMode))
      fail(400, "invalid_website_dns_mode");
    let service: PlatformResource | undefined;
    if (routing === "managed") {
      service = store.get(s.service_application_id, "application");
      const p = service.spec.ports.find(
        (p: Row) =>
          p.name === s.service_port_name &&
          p.protocol === "tcp" &&
          ["http", "https"].includes(p.app_protocol),
      );
      if (service.spec.role === "openresty" || !p)
        fail(400, "application_port_not_found");
      if (s.mode === "static") fail(400, "invalid_website_routing_mode");
    }
    const ids = service
      ? (service.spec.deployments.map((d: Row) => d.cluster_id) as string[])
      : list(s.cluster_ids ?? [], "cluster_ids");
    if (!ids.length) fail(400, "website_cluster_required");
    ids.forEach(cluster);
    if (
      !Array.isArray(s.bindings) ||
      !s.bindings.length ||
      s.bindings.length > 50
    )
      fail(400, "website_binding_required");
    const allNames = new Set<string>();
    for (const binding of s.bindings)
      for (const domain of names(binding.domains)) {
        if (allNames.has(domain)) fail(409, "website_domain_conflict");
        allNames.add(domain);
      }
    if (
      !Array.isArray(s.domain_routes ?? []) ||
      (s.domain_routes ?? []).length > 5000
    )
      fail(400, "invalid_website_domain_route");
    const seenRoutes = new Set<string>();
    const domainRoutes = (s.domain_routes ?? []).map((route: Row) => {
      if (
        !route ||
        typeof route !== "object" ||
        typeof route.domain !== "string"
      )
        fail(400, "invalid_website_domain_route");
      const domain = names([route.domain])[0];
      if (!allNames.has(domain) || seenRoutes.has(domain))
        fail(400, "invalid_website_domain_route");
      seenRoutes.add(domain);
      const out: Row = { domain };
      if (route.cluster_ids !== undefined) {
        out.cluster_ids = list(route.cluster_ids, "domain_cluster_ids");
        if (!out.cluster_ids.length)
          fail(400, "website_domain_cluster_required");
        if (out.cluster_ids.some((cid: string) => !ids.includes(cid)))
          fail(400, "website_domain_cluster_mismatch");
      }
      if (route.cluster_policies !== undefined)
        out.cluster_policies = normalizeTrafficPolicies(route.cluster_policies);
      return out;
    });
    const domainSpec = { ...s, domain_routes: domainRoutes };
    const bindings = s.bindings.map((b: Row) => {
      const domains = names(b.domains);
      if (!domains.length) fail(400, "website_domain_required");
      const bindingIds = ids.filter((cid) =>
        domains.some((domain) =>
          domainClusters(domainSpec, domain, ids).includes(cid),
        ),
      );
      const locations = (b.locations ?? []).map((raw: Row) => {
        if (
          [
            "target",
            "application_id",
            "port_name",
            "upstreams",
            "cluster_overrides",
          ].some((k) => raw[k] !== undefined)
        )
          fail(400, "website_cluster_target_required");
        const noUpstream =
          s.mode === "static" ||
          raw.action === "return" ||
          raw.action === "deny";
        const normalized = normalizeLocations([
          {
            ...raw,
            auth: normalizeWebsiteAuth(
              raw.auth,
              previous?.bindings
                ?.find((p: Row) => p.domains.join() === b.domains.join())
                ?.locations?.find(
                  (p: Row) =>
                    p.path === raw.path && p.match === (raw.match ?? "prefix"),
                )?.auth,
              true,
              context?.stored,
            ),
            target: "upstream",
            upstreams: [],
            unavailable: true,
          },
        ])[0];
        delete normalized.target;
        delete normalized.upstreams;
        delete normalized.unavailable;
        const targets = noUpstream
          ? []
          : (service
              ? bindingIds.map((cluster_id) => ({
                  cluster_id,
                  target: "application",
                  application_id: service!.id,
                  port_name: s.service_port_name,
                }))
              : (raw.cluster_targets ?? []).filter(
                  (t: Row) =>
                    !ids.includes(t.cluster_id) ||
                    bindingIds.includes(t.cluster_id),
                )
            ).map((t: Row) => {
              if (
                Object.keys(t).some(
                  (k) =>
                    ![
                      "cluster_id",
                      "target",
                      "application_id",
                      "port_name",
                      "upstreams",
                    ].includes(k),
                )
              )
                fail(400, "website_cluster_override_not_supported");
              if (
                !ids.includes(t.cluster_id) ||
                !["application", "proxy"].includes(t.target)
              )
                fail(400, "invalid_website_cluster_target");
              if (t.target === "application") {
                const app = store.get(t.application_id, "application");
                if (
                  !app.spec.deployments?.some(
                    (d: Row) => d.cluster_id === t.cluster_id,
                  )
                )
                  fail(400, "application_not_deployed_in_cluster");
                const p = app.spec.ports.find(
                  (p: Row) => p.name === t.port_name,
                );
                if (
                  !p ||
                  p.protocol !== "tcp" ||
                  !["http", "https"].includes(p.app_protocol)
                )
                  fail(400, "application_port_not_found");
                return {
                  cluster_id: t.cluster_id,
                  target: "application",
                  application_id: app.id,
                  port_name: p.name,
                };
              }
              const route = normalizeLocations([
                {
                  path: raw.path ?? "/",
                  target: "upstream",
                  upstreams: t.upstreams,
                },
              ])[0];
              return {
                cluster_id: t.cluster_id,
                target: "proxy",
                upstreams: route.upstreams,
              };
            });
        if (
          new Set(targets.map((t: Row) => t.cluster_id)).size !==
            targets.length ||
          (!noUpstream &&
            bindingIds.some(
              (cid) => !targets.some((t: Row) => t.cluster_id === cid),
            ))
        )
          fail(400, "website_cluster_target_required");
        return { ...normalized, cluster_targets: targets };
      });
      if (s.mode !== "static" && !locations.length)
        fail(400, "website_location_required");
      const out: Row = {
        domains,
        https: Boolean(b.https ?? b.certificate_id),
        dns_enabled: Boolean(b.dns_enabled ?? b.dns_zone_id),
        locations,
      };
      if (out.https) {
        const cert = store.get(b.certificate_id, "certificate");
        if (
          domains.some(
            (d) =>
              !cert.spec.domains.some(
                (p: string) =>
                  p === d ||
                  (p.startsWith("*.") &&
                    d.endsWith(p.slice(1)) &&
                    d.split(".").length === p.split(".").length),
              ),
          )
        )
          fail(400, "website_certificate_domain_mismatch");
        out.certificate_id = cert.id;
      }
      if (out.dns_enabled) {
        const zone = store.get(b.dns_zone_id, "dns_zone");
        if (
          domains.some(
            (d) => d !== zone.spec.scope && !d.endsWith("." + zone.spec.scope),
          )
        )
          fail(400, "website_domain_outside_dns_scope");
        out.dns_zone_id = zone.id;
      }
      for (const l of locations) {
        if (
          effectiveAuth(siteAuth, l.auth).mode === "basic" &&
          (l.action === "return" ||
            l.cors ||
            l.cache ||
            l.custom_config ||
            s.nginx?.server_snippet)
        )
          fail(400, "website_auth_unsafe_combination");
      }
      return out;
    });
    const registryWebsite = db.get<Row>(
      "SELECT * FROM ops_private_registry_settings WHERE id=1",
    );
    if (
      registryWebsite?.website_id &&
      registryWebsite.website_id === context?.id
    ) {
      const rid = systemApplicationID(store, "registry");
      if (
        siteAuth.mode !== "basic" ||
        ids.length !== 1 ||
        ids[0] !== registryWebsite.carrier_cluster_id ||
        bindings.some(
          (b: Row) =>
            !b.https ||
            b.locations.length !== 1 ||
            b.locations[0].path !== "/" ||
            effectiveAuth(siteAuth, b.locations[0].auth).mode !== "basic" ||
            b.locations[0].cluster_targets.some(
              (t: Row) =>
                t.application_id !== rid || t.port_name !== "registry",
            ),
        )
      )
        fail(409, "registry_website_security_required");
    }
    const protectedSite =
      siteAuth.mode === "basic" ||
      bindings.some((b: Row) =>
        b.locations.some((l: Row) => l.auth.mode === "basic"),
      );
    if (protectedSite && bindings.some((b: Row) => !b.https))
      fail(400, "website_auth_requires_https");
    for (const other of store.list("website"))
      if (
        other.id !== context?.id &&
        snapshots(other).some(
          (spec) =>
            spec.cluster_ids?.some((cid: string) => ids.includes(cid)) &&
            spec.bindings?.some((b: Row) =>
              b.domains.some((d: string) => allNames.has(d)),
            ),
        )
      )
        fail(409, "website_domain_conflict");
    for (const cid of previous?.cluster_ids ?? [])
      if (
        !ids.includes(cid) &&
        routing !== "managed" &&
        deploymentRow("website", context?.id ?? "", cid)?.enabled
      )
        fail(409, "website_deployment_in_use");
    if (
      !Array.isArray(s.cluster_policies ?? []) ||
      (s.cluster_policies ?? []).length > 100
    )
      fail(400, "invalid_website_cluster_policy");
    const policyInputs = [...(s.cluster_policies ?? [])];
    // Editing a draft service selection must not reset the traffic switch of a
    // cluster that still serves the previously published website.
    for (const policy of previous?.cluster_policies ?? [])
      if (
        !ids.includes(policy.cluster_id) &&
        !policyInputs.some((p) => p.cluster_id === policy.cluster_id) &&
        deploymentRow("website", context?.id ?? "", policy.cluster_id)?.enabled
      )
        policyInputs.push(policy);
    const policies = normalizeTrafficPolicies(policyInputs);
    if (dnsMode === "cname")
      for (const binding of bindings.filter((b: Row) => b.dns_enabled))
        for (const domain of binding.domains) {
          const domainIds = domainClusters(domainSpec, domain, ids),
            enabled = domainIds.filter(
              (cid) =>
                policyFor(
                  { ...domainSpec, cluster_policies: policies },
                  cid,
                  domain,
                ).enabled !== false,
            );
          if (
            enabled.length &&
            !enabled.some(
              (cid) =>
                policyFor(
                  { ...domainSpec, cluster_policies: policies },
                  cid,
                  domain,
                ).default !== false,
            )
          )
            fail(400, "website_default_cluster_required");
          for (const cid of enabled) {
            const gateway = store
              .list("application")
              .find((a) => a.spec.role === "openresty")
              ?.spec.deployments.find((d: Row) => d.cluster_id === cid);
            if (!gateway?.gateway_domain)
              fail(400, "openresty_cluster_domain_required");
            if (allNames.has(gateway.gateway_domain))
              fail(400, "gateway_domain_conflicts_with_website");
          }
        }
    return {
      routing_mode: routing,
      dns_record_mode: dnsMode,
      cluster_policies: policies,
      ...(domainRoutes.length ? { domain_routes: domainRoutes } : {}),
      ...(service
        ? {
            service_application_id: service.id,
            service_port_name: s.service_port_name,
          }
        : {}),
      cluster_ids: ids,
      bindings,
      nginx: normalizeNginx(s.nginx),
      auth: siteAuth,
      mode: s.mode ?? "proxy",
      ...(s.static_files || s.mode === "static"
        ? {
            static_files: files(
              s.static_files ?? { "index.html": "<h1>LightMoni</h1>" },
            ),
          }
        : {}),
    };
  }
  function websiteClusters(r: PlatformResource): string[] {
    if (r.spec.routing_mode === "managed")
      return store
        .get(r.spec.service_application_id, "application")
        .spec.deployments.map((d: Row) => d.cluster_id);
    return r.spec.cluster_ids ?? [];
  }
  function publishedDomainMemberships(r: PlatformResource): Row {
    const records = db.all<Row>(
      "SELECT cluster_id FROM ops_platform_website_deployments WHERE website_id=? AND desired_revision>0",
      r.id,
    );
    const result: Row = {},
      preferred = websiteClusters(publishedWebsite(r));
    for (const domain of domainNames(publishedWebsite(r).spec))
      result[domain] = [];
    if (!records.length) {
      const available = websiteClusters(r);
      for (const domain of domainNames(r.spec))
        result[domain] = domainClusters(r.spec, domain, available);
      return result;
    }
    // Independently published clusters may still serve different frozen revisions.
    // Include each published range until that cluster receives its cleanup package.
    for (const record of records) {
      const site = desired(r, record.cluster_id),
        available = websiteClusters(site);
      for (const domain of domainNames(site.spec)) {
        result[domain] ??= [];
        if (
          domainClusters(site.spec, domain, available).includes(
            record.cluster_id,
          ) &&
          !result[domain].includes(record.cluster_id)
        )
          result[domain].push(record.cluster_id);
      }
    }
    for (const ids of Object.values(result) as string[][])
      ids.sort((a, b) => {
        const ai = preferred.indexOf(a),
          bi = preferred.indexOf(b);
        return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi) || a.localeCompare(b);
      });
    return result;
  }
  function publishedWebsite(r: PlatformResource) {
    const latest = db.get<Row>(
      "SELECT cluster_id FROM ops_platform_website_deployments WHERE website_id=? AND desired_revision>0 ORDER BY desired_revision DESC LIMIT 1",
      r.id,
    );
    return latest ? desired(r, latest.cluster_id) : r;
  }
  function followManagedWebsite(r: PlatformResource) {
    const source = publishedWebsite(r);
    if (source.spec.routing_mode !== "managed") return;
    const ids = websiteClusters(source),
      existing = db.all<Row>(
        "SELECT * FROM ops_platform_website_deployments WHERE website_id=?",
        r.id,
      );
    const published = existing
      .filter((d) => d.enabled && d.desired_revision > 0)
      .sort((a, b) => b.desired_revision - a.desired_revision)[0];
    for (const cid of ids) {
      const row = existing.find((d) => d.cluster_id === cid);
      if (row) {
        if (!row.desired_revision && published)
          patchDeployment("website", r.id, cid, {
            desired_revision: published.desired_revision,
            enabled: true,
            policy_actor: published.policy_actor,
          });
        continue;
      }
      db.run(
        "INSERT INTO ops_platform_website_deployments(website_id,cluster_id,desired_revision,enabled,policy_actor) VALUES(?,?,?,?,?)",
        r.id,
        cid,
        published?.desired_revision ?? 0,
        published ? 1 : 0,
        published?.policy_actor ?? "",
      );
    }
    for (const d of existing)
      if (!ids.includes(d.cluster_id) && d.enabled)
        patchDeployment("website", r.id, d.cluster_id, {
          enabled: false,
          active: false,
        });
    store.patchStatus(r.id, {
      actual_cluster_ids: [
        ...new Set<string>(
          Object.values(publishedDomainMemberships(r)).flat() as string[],
        ),
      ],
    });
  }
  function afterSaveWebsite(r: PlatformResource) {
    for (const d of db.all<Row>(
      "SELECT * FROM ops_platform_website_deployments WHERE website_id=?",
      r.id,
    ))
      if (!r.spec.cluster_ids.includes(d.cluster_id) && !d.desired_revision)
        db.run(
          "DELETE FROM ops_platform_website_deployments WHERE website_id=? AND cluster_id=?",
          r.id,
          d.cluster_id,
        );
    for (const cid of r.spec.cluster_ids)
      db.run(
        "INSERT OR IGNORE INTO ops_platform_website_deployments(website_id,cluster_id) VALUES(?,?)",
        r.id,
        cid,
      );
  }
  function beforeDeleteWebsite(r: PlatformResource) {
    if (
      db.get<Row>(
        "SELECT website_id FROM ops_private_registry_settings WHERE id=1",
      )?.website_id === r.id
    )
      fail(409, "registry_website_in_use");
    if (dnsPending.has(r.id)) fail(409, "website_dns_refresh_in_progress");
    if (
      tableExists("ops_dns_owned") &&
      db.get("SELECT id FROM ops_dns_owned WHERE owner_id=?", r.id)
    )
      fail(409, "dns_records_cleanup_pending");
    if (
      db.get(
        "SELECT website_id FROM ops_platform_website_deployments WHERE website_id=? AND enabled=1",
        r.id,
      )
    )
      fail(409, "disable_website_before_deleting");
  }
  const effective = (a: PlatformResource, i: Row) => {
    const app = structuredClone(a.spec),
      mapping = ports(i.id);
    app.ports = mapping.map((p) => ({
      container_port: p.container_port,
      host_port: p.host_port,
      protocol: p.protocol,
      host_ip: p.host_ip,
    }));
    if (app.mode === "compose")
      for (const [name, service] of Object.entries(app.compose.services) as [
        string,
        Row,
      ][])
        service.ports = mapping
          .filter(
            (p) => (p.service || Object.keys(app.compose.services)[0]) === name,
          )
          .map((p) => ({
            target: p.container_port,
            published: String(p.host_port),
            protocol: p.protocol,
            host_ip: p.host_ip,
          }));
    return registryRuntime(a, app);
  };
  const usage = (agentID: string) => {
    const a = db.get<Row>(
      "SELECT COALESCE(SUM(cpu),0) cpu,COALESCE(SUM(memory_mb),0) memory_mb FROM ops_cluster_instances WHERE agent_id=? AND state NOT IN ('stopped','removed')",
      agentID,
    )!;
    const b = db.get<Row>(
      "SELECT COALESCE(SUM(cpu),0) cpu,COALESCE(SUM(memory_mb),0) memory_mb FROM ops_platform_instances WHERE agent_id=? AND state NOT IN ('stopped','removed')",
      agentID,
    )!;
    return { cpu: a.cpu + b.cpu, memory_mb: a.memory_mb + b.memory_mb };
  };
  function reserve(i: Row, declarations: Row[], c: PlatformResource) {
    const old = ports(i.id),
      next: Row[] = [];
    for (const p of declarations) {
      let selected =
        p.host_port ||
        old.find((v) => v.name === p.name && v.protocol === p.protocol)
          ?.host_port ||
        0;
      if (!selected)
        for (let n = c.spec.port_start; n <= c.spec.port_end; n++) {
          if (
            !db.get(
              "SELECT instance_id FROM ops_platform_ports WHERE agent_id=? AND protocol=? AND port=?",
              i.agent_id,
              p.protocol,
              n,
            ) &&
            !db.get(
              "SELECT port FROM ops_platform_node_conflicts WHERE agent_id=? AND protocol=? AND port=? AND observed_at>?",
              i.agent_id,
              p.protocol,
              n,
              new Date(deps.now().getTime() - 300000).toISOString(),
            ) &&
            !next.some((v) => v.protocol === p.protocol && v.host_port === n)
          ) {
            selected = n;
            break;
          }
        }
      if (!selected) fail(409, "insufficient_node_capacity_or_ports");
      const owner = db.get<Row>(
        "SELECT instance_id FROM ops_platform_ports WHERE agent_id=? AND protocol=? AND port=?",
        i.agent_id,
        p.protocol,
        selected,
      );
      if (
        (owner && owner.instance_id !== i.id) ||
        next.some((v) => v.protocol === p.protocol && v.host_port === selected)
      )
        fail(409, "host_port_already_reserved");
      next.push({ ...p, host_port: selected });
      db.run(
        "INSERT OR IGNORE INTO ops_platform_ports VALUES(?,?,?,?)",
        i.agent_id,
        p.protocol,
        selected,
        i.id,
      );
    }
    db.run("DELETE FROM ops_platform_instance_ports WHERE instance_id=?", i.id);
    for (const p of next)
      db.run(
        "INSERT INTO ops_platform_instance_ports VALUES(?,?,?,?,?,?,?,?)",
        i.id,
        p.name,
        p.service ?? "",
        p.container_port,
        p.host_port,
        p.protocol,
        p.app_protocol ?? "",
        p.host_ip ?? "0.0.0.0",
      );
    // Old mappings remain reserved until a verified replacement receipt.
  }
  function prepare(a: PlatformResource, i: Row, c: PlatformResource) {
    const resources = applicationResources(
        registryRuntime(a, structuredClone(a.spec)),
      ),
      node = capacity(c, i.machine_id),
      use = usage(i.agent_id),
      active = !["stopped", "removed"].includes(i.state);
    if (
      (node.cpu && use.cpu - (active ? i.cpu : 0) + resources.cpu > node.cpu) ||
      (node.memory_mb &&
        use.memory_mb - (active ? i.memory_mb : 0) + resources.memory_mb >
          node.memory_mb)
    )
      fail(409, "insufficient_node_capacity");
    db.run(
      "UPDATE ops_cluster_instances SET cpu=?,memory_mb=?,address=? WHERE id=?",
      resources.cpu,
      resources.memory_mb,
      a.spec.role === "registry" ? a.spec.registry_address : node.address,
      i.id,
    );
    reserve(
      i,
      a.spec.role === "registry"
        ? a.spec.ports.map((p: Row) => ({
            ...p,
            host_ip: a.spec.registry_address,
          }))
        : a.spec.ports,
      c,
    );
  }
  function create(a: PlatformResource, key: string, slot: string) {
    const m = member(a.spec.cluster_id, key),
      c = cluster(a.spec.cluster_id),
      node = capacity(c, key),
      resources = applicationResources(
        registryRuntime(a, structuredClone(a.spec)),
      );
    if (!m.agent_id || !agent(m.agent_id)) fail(400, "machine_agent_required");
    const use = usage(m.agent_id);
    if (
      (node.cpu && use.cpu + resources.cpu > node.cpu) ||
      (node.memory_mb && use.memory_mb + resources.memory_mb > node.memory_mb)
    )
      fail(409, "insufficient_node_capacity");
    const keyID = id(),
      attempt =
        Number(
          db.get<Row>(
            "SELECT MAX(attempt) attempt FROM ops_cluster_instances WHERE owner_id=? AND cluster_id=? AND slot=?",
            a.id,
            a.spec.cluster_id,
            slot,
          )?.attempt ?? 0,
        ) + 1;
    db.run(
      "INSERT INTO ops_cluster_instances(id,owner_id,machine_id,agent_id,slot,attempt,cpu,memory_mb,address,created_at,updated_at,cluster_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      keyID,
      a.id,
      key,
      m.agent_id,
      slot,
      attempt,
      resources.cpu,
      resources.memory_mb,
      a.spec.role === "registry" ? a.spec.registry_address : node.address,
      at(),
      at(),
      a.spec.cluster_id,
    );
    const i = row(keyID);
    reserve(
      i,
      a.spec.role === "registry"
        ? a.spec.ports.map((p: Row) => ({
            ...p,
            host_ip: a.spec.registry_address,
          }))
        : a.spec.ports,
      c,
    );
    return i;
  }
  function dispatch(
    owner: PlatformResource,
    i: Row,
    task: string,
    config: Row,
    generation: string,
    actor: string,
  ) {
    if (busy(i)) return null;
    if (
      i.state === "unknown" &&
      !task.endsWith(".inspect") &&
      !task.endsWith(".logs")
    )
      fail(409, "instance_state_unknown_inspect_required");
    const run = store.queue(
      store.get(owner.id),
      i.agent_id,
      task.split(".")[1],
      {
        ...config,
        task,
        instance_id: i.id,
        modern_instance: true,
        cluster_id: i.cluster_id,
        generation,
      },
      actor,
    );
    db.run(
      "UPDATE ops_cluster_instances SET current_run_id=?,state=?,desired_generation=?,updated_at=? WHERE id=?",
      run.id,
      /\.(inspect|logs)$/.test(task) ? i.state : "queued",
      generation,
      at(),
      i.id,
    );
    return run;
  }
  function health(a: PlatformResource, i: Row) {
    const p =
      ports(i.id).find((p) => p.name === a.spec.health?.port_name) ??
      ports(i.id).find((p) => p.protocol === "tcp");
    return {
      health: a.spec.health
        ? { ...a.spec.health, port: p?.host_port }
        : undefined,
      probe_port: p?.host_port,
    };
  }
  function siteBundle(
    site: PlatformResource,
    cid: string,
    preview = false,
    gatewayMachineID?: string,
  ) {
    return site.spec.bindings.flatMap((b: Row, n: number) => {
      const domains = b.domains.filter((domain: string) =>
        domainClusters(site.spec, domain, websiteClusters(site)).includes(cid),
      );
      if (!domains.length) return [];
      const routes = b.locations.map((l: Row) => {
        const out = structuredClone(l),
          target =
            site.spec.routing_mode === "managed" &&
            l.action !== "return" &&
            l.action !== "deny"
              ? {
                  target: "application",
                  application_id: site.spec.service_application_id,
                  port_name: site.spec.service_port_name,
                }
              : l.cluster_targets?.find((t: Row) => t.cluster_id === cid);
        delete out.cluster_targets;
        out.target = "upstream";
        if (target?.target === "application") {
          const app = store.get(target.application_id, "application");
          if (
            !app.spec.deployments?.some((d: Row) => d.cluster_id === cid) &&
            site.spec.routing_mode !== "managed"
          )
            fail(400, "application_not_deployed_in_cluster");
          const p = app.spec.ports.find(
            (p: Row) => p.name === target.port_name,
          );
          if (!p) fail(400, "application_port_not_found");
          out.upstreams = endpoints(app.id, p.name, cid)
            .filter(e => e.ip && (e.machine_id === gatewayMachineID || networkScope(e.ip) !== 'loopback'))
            .map((e) => {
            // OpenResty uses host networking; preserve a specific bind IP, otherwise use loopback.
            const host =
              e.machine_id === gatewayMachineID ? (e.host_ip && !['0.0.0.0','::'].includes(e.host_ip) ? e.host_ip : "127.0.0.1") : e.ip;
            return (
              (e.app_protocol === "https" ? "https" : "http") +
              "://" +
              (isIP(host) === 6 ? "[" + host + "]" : host) +
              ":" +
              e.port
            );
          });
          out.unavailable = !out.upstreams.length;
        } else if (target?.target === "proxy") out.upstreams = target.upstreams;
        else {
          out.upstreams = [];
          out.unavailable = true;
        }
        if (preview) {
          if (out.custom_config)
            out.custom_config = "# Custom directives omitted from preview";
          for (const headers of [out.request_headers, out.response_headers])
            for (const key of Object.keys(headers ?? {}))
              if (/authorization|cookie|token|secret|api.?key/i.test(key))
                headers[key] = "[redacted]";
        }
        return out;
      });
      const nginx = structuredClone(site.spec.nginx);
      if (preview) {
        if (nginx.server_snippet)
          nginx.server_snippet = "# Custom directives omitted from preview";
        for (const k of Object.keys(nginx.response_headers ?? {}))
          if (/authorization|cookie|token|secret|api.?key/i.test(k))
            nginx.response_headers[k] = "[redacted]";
      }
      return {
        id: hash(site.id + ":" + n).slice(0, 32),
        domains,
        mode: site.spec.mode === "static" ? "static" : "proxy",
        locations: routes,
        nginx,
        auth: site.spec.auth,
        ...(site.spec.static_files
          ? { static_files: site.spec.static_files }
          : {}),
        ...(b.https
          ? {
              certificate: preview
                ? {}
                : getCertificateMaterial(store, b.certificate_id),
            }
          : {}),
      };
    });
  }
  const openresty = (cid: string) => {
    const d = db.get<Row>(
      "SELECT application_id FROM ops_platform_application_deployments WHERE cluster_id=? AND role='openresty'",
      cid,
    );
    return d ? store.get(d.application_id, "application") : undefined;
  };
  function gatewayConfig(a: PlatformResource, gateway: Row) {
    const sites: Row[] = [],
      revisions: Row = {},
      enabled: Row = {},
      cid = a.spec.cluster_id;
    for (const current of store.list("website")) {
      const d = deploymentRow("website", current.id, cid);
      if (!d || !d.desired_revision) continue;
      const site = desired(current, cid);
      revisions[site.id] = site.revision;
      enabled[site.id] = !!d.enabled;
      if (d.enabled)
        sites.push(...siteBundle(site, cid, false, gateway.machine_id));
    }
    return {
      image: a.spec.image,
      http_port: 80,
      https_port: 443,
      sites,
      website_revisions: revisions,
      website_enabled: enabled,
      openresty_application_id: a.id,
      cluster_id: cid,
    };
  }
  function apply(
    a: PlatformResource,
    i: Row,
    owner: PlatformResource,
    actor: string,
    force = false,
  ) {
    if (a.spec.role === "openresty") {
      const config = gatewayConfig(a, i),
        signature = hash(JSON.stringify(config));
      if (
        !force &&
        i.last_bundle_sig === signature &&
        i.observed_generation === String(a.revision) &&
        i.state === "running"
      )
        return null;
      return dispatch(
        owner,
        i,
        "gateway.apply",
        config,
        String(a.revision),
        actor,
      );
    }
    return dispatch(
      owner,
      i,
      "workload.apply",
      {
        application: effective(a, i),
        ...(registryCacheFor(store, a, i.machine_id)
          ? { image_cache: registryCacheFor(store, a, i.machine_id) }
          : {}),
        application_id: a.id,
        application_revision: a.revision,
        ...health(a, i),
        force_recreate: i.health_failures >= 3,
      },
      String(a.revision),
      actor,
    );
  }
  function inspect(a: PlatformResource, i: Row, actor: string) {
    const authRequired =
      a.spec.role === "openresty" &&
      store
        .list("website")
        .some((site) =>
          snapshots(site).some(
            (spec) =>
              spec.cluster_ids?.includes(i.cluster_id) &&
              (spec.auth?.mode === "basic" ||
                spec.bindings?.some((b: Row) =>
                  b.locations?.some((l: Row) => l.auth?.mode === "basic"),
                )),
          ),
        );
    return dispatch(
      store.get(a.id),
      i,
      a.spec.role === "openresty" ? "gateway.inspect" : "workload.inspect",
      { ...health(a, i), ...(authRequired ? { auth_required: true } : {}) },
      i.desired_generation,
      actor,
    );
  }
  function stop(a: PlatformResource, i: Row, actor: string, remove = false) {
    db.run(
      "UPDATE ops_cluster_instances SET desired_state=? WHERE id=?",
      remove ? "removed" : "stopped",
      i.id,
    );
    return dispatch(
      store.get(a.id),
      i,
      a.spec.role === "openresty"
        ? remove
          ? "gateway.remove"
          : "gateway.stop"
        : remove
          ? "workload.remove"
          : "workload.stop",
      {},
      i.desired_generation,
      actor,
    );
  }
  function reconcile(
    current: PlatformResource,
    cid: string,
    actor: string,
    explicit = false,
    owner = current,
  ) {
    const a = desired(current, cid),
      c = cluster(cid),
      runs: PlatformRun[] = [];
    for (const old of rows(a.id, true, cid).filter(
      (i) =>
        (i.retired || i.desired_state !== "running") &&
        !["stopped", "removed", "unknown"].includes(i.state) &&
        online(i.agent_id) &&
        !busy(i),
    )) {
      const run = stop(a, old, actor, old.desired_state === "removed");
      if (run) runs.push(run);
    }
    if (a.spec.deployment_mode === "managed") {
      const unknown = c.spec.machine_ids
        .map((key: string) => capacity(c, key))
        .filter(
          (n: Row) =>
            online(n.agent_id) && (!n.cpu || !n.memory_mb || !n.address),
        );
      if (unknown.length) {
        patchDeployment('application', a.id, cid, {pending:'node_capacity_discovery'});
        for (const n of unknown)
          if (
            !db.get(
              "SELECT id FROM ops_platform_runs WHERE resource_id=? AND agent_id=? AND state IN ('queued','leased','accepted','preflighting','staging','activating','verifying')",
              c.id,
              n.agent_id,
            )
          )
            runs.push(
              store.queue(
                c,
                n.agent_id,
                "inspect",
                { task: "node.inspect", modern_cluster: true, cluster_id: cid },
                actor,
              ),
            );
        return {
          cluster_id: cid,
          runs,
          endpoints: endpoints(a.id, undefined, cid),
          pending: "node_capacity_discovery",
        };
      }
    }
    let currentRows = rows(a.id, false, cid);
    if (a.spec.deployment_mode === "manual") {
      if (explicit) {
        for (const i of currentRows.filter(
          (i) =>
            !a.spec.machine_ids.includes(i.machine_id) &&
            !["stopped", "removed"].includes(i.state),
        )) {
          db.run(
            "UPDATE ops_cluster_instances SET desired_state='stopped' WHERE id=?",
            i.id,
          );
          if (online(i.agent_id)) {
            const run = stop(a, i, actor);
            if (run) runs.push(run);
          }
        }
        db.transaction(() => {
          for (const key of a.spec.machine_ids) {
            const m = member(cid, key);
            if (!online(m.agent_id)) fail(409, "target_agent_offline");
            let i = rows(a.id, false, cid).find((i) => i.machine_id === key);
            if (i && i.agent_id !== m.agent_id)
              fail(409, "machine_agent_changed_inspect_required");
            if (!i) i = create(a, key, key);
            else prepare(a, i, c);
            db.run(
              "UPDATE ops_cluster_instances SET desired_state='running' WHERE id=?",
              i.id,
            );
          }
        });
        for (const key of a.spec.machine_ids) {
          const i = rows(a.id, false, cid).find((i) => i.machine_id === key)!;
          const run = apply(a, i, owner, actor, true);
          if (run) runs.push(run);
        }
      } else if (a.spec.role === "openresty")
        for (const i of currentRows.filter(
          (i) =>
            a.spec.machine_ids.includes(i.machine_id) &&
            i.state === "running" &&
            online(i.agent_id) &&
            !busy(i),
        )) {
          const run = apply(a, i, owner, actor);
          if (run) runs.push(run);
        }
    } else {
      for (const i of currentRows) {
        if (Number(i.slot) >= a.spec.replicas) {
          db.run(
            "UPDATE ops_cluster_instances SET desired_state='stopped' WHERE id=?",
            i.id,
          );
          if (
            !busy(i) &&
            online(i.agent_id) &&
            !["stopped", "removed"].includes(i.state)
          ) {
            const run = stop(a, i, actor);
            if (run) runs.push(run);
          }
          continue;
        }
        if (
          (!online(i.agent_id) ||
            machine(i.machine_id).agent_id !== i.agent_id) &&
          i.state !== "unknown" &&
          !busy(i) &&
          !a.spec.stateful
        )
          db.run(
            "UPDATE ops_cluster_instances SET retired=1,healthy=0,state='orphaned',desired_state='stopped',updated_at=? WHERE id=?",
            at(),
            i.id,
          );
      }
      currentRows = rows(a.id, false, cid);
      let rolloutID = currentRows.find(
          (i) =>
            i.observed_generation &&
            i.desired_generation === String(a.revision) &&
            (busy(i) ||
              i.observed_generation !== String(a.revision) ||
              !i.healthy),
        )?.id,
        rolling = !!rolloutID;
      for (let slot = 0; slot < a.spec.replicas; slot++) {
        let i = currentRows.find((i) => i.slot === String(slot));
        if (!i) {
          const candidates = c.spec.machine_ids
            .map((key: string) => capacity(c, key))
            .filter(
              (n: Row) =>
                online(n.agent_id) &&
                n.address &&
                n.docker_available !== false &&
                !db.get(
                  "SELECT id FROM ops_cluster_instances WHERE machine_id=? AND retired=1 AND state NOT IN ('stopped','removed')",
                  n.machine_id,
                ) &&
                !a.spec.ports.some(
                  (p: Row) =>
                    p.host_port &&
                    db.get(
                      "SELECT port FROM ops_platform_node_conflicts WHERE agent_id=? AND protocol=? AND port=? AND observed_at>?",
                      n.agent_id,
                      p.protocol,
                      p.host_port,
                      new Date(deps.now().getTime() - 300000).toISOString(),
                    ),
                ),
            )
            .sort(
              (x: Row, y: Row) =>
                currentRows.filter((i) => i.machine_id === x.machine_id)
                  .length -
                  currentRows.filter((i) => i.machine_id === y.machine_id)
                    .length || x.machine_id.localeCompare(y.machine_id),
            );
          let last: any;
          for (const n of candidates) {
            try {
              i = db.transaction(() => create(a, n.machine_id, String(slot)));
              break;
            } catch (e) {
              last = e;
            }
          }
          if (!i) {
            const pending = a.spec.ports.some((p: Row) => p.host_port)
              ? "fixed_port_or_capacity_unavailable"
              : "insufficient_node_capacity_or_ports";
            patchDeployment("application", a.id, cid, {
              pending,
              last_error: last instanceof Error ? last.message : pending,
            });
            publish(a.id);
            return {
              cluster_id: cid,
              runs,
              endpoints: endpoints(a.id, undefined, cid),
              pending,
            };
          }
          currentRows.push(i);
        }
        if (busy(i) || !online(i.agent_id) || i.state === "unknown") continue;
        const outdated = i.observed_generation !== String(a.revision);
        if (
          !outdated &&
          i.state === "running" &&
          (i.healthy || i.health_failures < 3)
        ) {
          if (a.spec.role === "openresty") {
            const run = apply(a, i, owner, actor);
            if (run) runs.push(run);
          }
          continue;
        }
        if (
          !explicit &&
          i.restart_count >= 3 &&
          i.desired_generation === String(a.revision)
        )
          continue;
        if (i.observed_generation && rolling && rolloutID !== i.id) continue;
        if (i.observed_generation) {
          rolling = true;
          rolloutID = i.id;
        }
        db.transaction(() => {
          prepare(a, i!, c);
          db.run(
            "UPDATE ops_cluster_instances SET desired_state='running',restart_count=restart_count+1 WHERE id=?",
            i!.id,
          );
        });
        const run = apply(a, row(i.id), owner, actor, true);
        if (run) runs.push(run);
      }
    }
    patchDeployment("application", a.id, cid, { pending: "", last_error: "" });
    publish(a.id);
    return {
      cluster_id: cid,
      runs,
      service_name: a.spec.service_name,
      endpoints: endpoints(a.id, undefined, cid),
    };
  }
  function publishWebsite(siteID: string) {
    const current = store.get(siteID, "website"),
      deployments: Row = {};
    let bytes = 0;
    for (const d of db.all<Row>(
      "SELECT * FROM ops_platform_website_deployments WHERE website_id=? ORDER BY cluster_id",
      siteID,
    )) {
      const status = deploymentStatus(d),
        instances = Object.fromEntries(
          Object.entries(status.instances ?? {}).slice(-100),
        );
      const summary = { ...status, instances },
        size = Buffer.byteLength(JSON.stringify(summary));
      if (bytes + size > 85000) {
        deployments[d.cluster_id] = {
          desired_revision: d.desired_revision,
          enabled: !!d.enabled,
          phase: status.phase,
          instances_truncated: true,
        };
        continue;
      }
      deployments[d.cluster_id] = summary;
      bytes += size;
    }
    const all = Object.values(deployments) as Row[];
    store.patchStatus(siteID, {
      deployments,
      actual_cluster_ids: [
        ...new Set<string>(
          Object.values(publishedDomainMemberships(current)).flat() as string[],
        ),
      ],
      enabled: all.some((d) => d.enabled),
      active: all.some((d) => d.active),
      synchronized: all.length > 0 && all.every((d) => d.synchronized),
      phase: all.every((d) => !d.enabled)
        ? "disabled"
        : all.every((d) => d.active)
          ? "active"
          : all.some((d) => d.phase === "failed")
            ? "failed"
            : "pending",
    });
  }
  function websiteStatus(siteID: string, cid: string) {
    const current = store.get(siteID, "website"),
      d = deploymentRow("website", siteID, cid);
    if (!d) return;
    const site = desired(current, cid),
      app = openresty(cid),
      state = deploymentStatus(d),
      receipts = state.instances ?? {};
    const a = app ? desired(app, cid) : undefined,
      instances = a
        ? rows(a.id, false, cid).filter((i) => i.desired_state === "running")
        : [];
    const expected = a
      ? a.spec.deployment_mode === "managed"
        ? a.spec.replicas
        : a.spec.machine_ids.length
      : 0;
    const verified = instances.filter(
      (i) =>
        fresh(i) &&
        receipts[i.id]?.state === "succeeded" &&
        receipts[i.id]?.revision === site.revision,
    );
    const synchronized =
      expected > 0 &&
      instances.length >= expected &&
      verified.length === instances.length;
    const active = !!d.enabled && verified.length > 0;
    patchDeployment("website", siteID, cid, {
      active,
      synchronized,
      phase:
        !a || !instances.length
          ? "pending"
          : !d.enabled
            ? synchronized
              ? "disabled"
              : "disabling"
            : synchronized
              ? "active"
              : Object.values(receipts).some((r: any) =>
                    ["failed", "unknown"].includes(r.state),
                  )
                ? "failed"
                : "deploying",
    });
    publishWebsite(siteID);
  }
  const unsubscribe = store.subscribe((run, config, update) => {
    if (config.modern_cluster && config.task === "node.inspect") {
      if (run.state === "succeeded" && run.result.node) {
        db.run(
          "INSERT INTO ops_platform_nodes VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET node_json=excluded.node_json,last_seen=excluded.last_seen",
          run.agent_id,
          JSON.stringify(run.result.node),
          at(),
        );
        const c = cluster(run.resource_id);
        store.patchStatus(c.id, {
          nodes: c.spec.machine_ids.map((key: string) => ({
            ...capacity(c, key),
            online: online(machine(key).agent_id),
          })),
          last_observed_at: at(),
        });
      }
      return;
    }
    if (!config.modern_instance) return;
    const i = row(config.instance_id);
    if (
      !i ||
      i.current_run_id !== run.id ||
      i.desired_generation !== config.generation ||
      (config.cluster_id && config.cluster_id !== i.cluster_id)
    )
      return;
    if (!["succeeded", "failed", "unknown", "cancelled"].includes(run.state))
      return;
    const inspection = /\.(inspect|logs)$/.test(config.task),
      logs = config.task.endsWith(".logs");
    let state = i.state,
      healthy = i.healthy,
      observed = i.observed_generation,
      sig = i.last_bundle_sig;
    if (run.state === "succeeded" && !logs) {
      if (/\.(stop|remove)$/.test(config.task)) {
        state = config.task.endsWith(".remove") ? "removed" : "stopped";
        healthy = 0;
        db.run("DELETE FROM ops_platform_ports WHERE instance_id=?", i.id);
      } else {
        state =
          run.result.running === false ||
          run.result.containers?.length === 0 ||
          run.result.containers?.every((c: Row) => c.running === false)
            ? "stopped"
            : "running";
        healthy = run.result.healthy === true ? 1 : 0;
        if (!inspection) {
          observed = i.desired_generation;
          const actual = new Set(
            ports(i.id).map((p) => p.protocol + ":" + p.host_port),
          );
          for (const p of db.all<Row>(
            "SELECT * FROM ops_platform_ports WHERE instance_id=?",
            i.id,
          ))
            if (!actual.has(p.protocol + ":" + p.port))
              db.run(
                "DELETE FROM ops_platform_ports WHERE agent_id=? AND protocol=? AND port=? AND instance_id=?",
                p.agent_id,
                p.protocol,
                p.port,
                i.id,
              );
        }
        if (config.task === "gateway.apply")
          sig = hash(
            JSON.stringify(
              Object.fromEntries(
                Object.entries(config).filter(
                  ([k]) =>
                    ![
                      "task",
                      "instance_id",
                      "modern_instance",
                      "generation",
                    ].includes(k),
                ),
              ),
            ),
          );
      }
    } else if (run.state === "cancelled" && i.observed_generation) {
      state = "running";
    } else if (!logs) {
      if (!inspection) state = run.state === "unknown" ? "unknown" : "failed";
      healthy = 0;
    }
    const failed = !logs && (run.state !== "succeeded" || !healthy);
    db.run(
      "UPDATE ops_cluster_instances SET state=?,healthy=?,last_seen=?,observed_generation=?,observed_json=?,last_bundle_sig=?,health_failures=?,restart_count=?,updated_at=? WHERE id=?",
      state,
      healthy,
      run.state === "succeeded" && !logs ? at() : i.last_seen,
      observed,
      run.state === "succeeded" && !logs
        ? JSON.stringify(run.result)
        : i.observed_json,
      sig,
      failed ? i.health_failures + 1 : 0,
      healthy ? 0 : i.restart_count,
      at(),
      i.id,
    );
    const app = store.get(i.owner_id, "application"),
      a = desired(app, i.cluster_id),
      code = String(update.code ?? run.result.code ?? "");
    if (
      run.state === "failed" &&
      code === "HOST_PORT_OCCUPIED" &&
      a.spec.deployment_mode === "managed" &&
      !a.spec.stateful
    ) {
      for (const p of ports(i.id))
        db.run(
          "INSERT INTO ops_platform_node_conflicts VALUES(?,?,?,?) ON CONFLICT(agent_id,protocol,port) DO UPDATE SET observed_at=excluded.observed_at",
          i.agent_id,
          p.protocol,
          p.host_port,
          at(),
        );
      db.run(
        "UPDATE ops_cluster_instances SET retired=1,state='blocked',healthy=0,desired_state='stopped' WHERE id=?",
        i.id,
      );
      patchDeployment("application", i.owner_id, i.cluster_id, {
        pending: "host_port_already_reserved",
        last_error: "HOST_PORT_OCCUPIED",
      });
    }
    publish(i.owner_id);
    if (config.task === "gateway.apply")
      for (const [key, revision] of Object.entries(
        config.website_revisions ?? {},
      )) {
        const d = deploymentRow("website", key, i.cluster_id);
        if (!d || Number(d.desired_revision) !== Number(revision)) continue;
        const before = deploymentStatus(d),
          receipts = {
            ...before.instances,
            [i.id]: {
              machine_id: i.machine_id,
              agent_id: i.agent_id,
              run_id: run.id,
              state: run.state,
              revision,
              enabled: config.website_enabled?.[key] ?? !!d.enabled,
              digest: run.result.digest ?? "",
              updated_at: at(),
              error:
                run.state === "succeeded"
                  ? ""
                  : (update.code ?? "gateway_apply_failed"),
            },
          };
        patchDeployment("website", key, i.cluster_id, {
          instances: Object.fromEntries(Object.entries(receipts).slice(-100)),
        });
        websiteStatus(key, i.cluster_id);
      }
    if (config.task.startsWith("gateway."))
      for (const d of db.all<Row>(
        "SELECT website_id FROM ops_platform_website_deployments WHERE cluster_id=? AND desired_revision>0",
        i.cluster_id,
      ))
        websiteStatus(d.website_id, i.cluster_id);
  });
  const trafficPolicy = (
    r: PlatformResource,
    cid: string,
    domain?: string,
  ): Row => {
    if (
      domain &&
      (!domainNames(r.spec).includes(domain) ||
        !websiteClusters(r).includes(cid))
    ) {
      const source = publishedWebsite(r);
      const route = source.spec.domain_routes?.find(
        (v: Row) => v.domain === domain,
      );
      return policyFor(
        { ...r.spec, domain_routes: route ? [route] : [] },
        cid,
        domain,
      );
    }
    return policyFor(r.spec, cid, domain);
  };
  function servingGateway(i: Row) {
    return (
      !i.retired &&
      i.healthy === 1 &&
      i.desired_state === "running" &&
      !["stopped", "removed", "failed", "unknown"].includes(i.state) &&
      machine(i.machine_id).agent_id === i.agent_id &&
      online(i.agent_id) &&
      deps.now().getTime() - Date.parse(i.last_seen) < 120000
    );
  }
  function startGatewayDNS(app: PlatformResource) {
    const grouped = new Map<string, Row[]>();
    for (const d of app.spec.deployments) {
      if (!d.gateway_domain || !d.gateway_dns_zone_id) continue;
      if (!grouped.has(d.gateway_dns_zone_id))
        grouped.set(d.gateway_dns_zone_id, []);
      const deployment = deploymentRow("application", app.id, d.cluster_id);
      if (!deployment?.enabled) continue;
      for (const i of rows(app.id, false, d.cluster_id).filter(
        servingGateway,
      )) {
        const ip = capacity(cluster(d.cluster_id), i.machine_id).public_address;
        if (ip && isIP(ip))
          grouped.get(d.gateway_dns_zone_id)!.push({
            name: d.gateway_domain,
            type: isIP(ip) === 6 ? "AAAA" : "A",
            value: ip,
            ttl: 600,
          });
      }
    }
    syncDNS(app, grouped, app.authorized_by);
  }
  function startDNS(current: PlatformResource) {
    const grouped = new Map<string, Row[]>(),
      traffic: Row = {};
    let actor = current.authorized_by;
    const memberships = publishedDomainMemberships(current),
      actual = [
        ...new Set<string>(Object.values(memberships).flat() as string[]),
      ];
    const domainTraffic: Row = {};
    let domainBytes = 0,
      domainTruncated = false;
    for (const domain of Object.keys(memberships)) {
      const value = {
        cluster_ids: memberships[domain],
        eligible_cluster_ids: [] as string[],
      };
      domainBytes += Buffer.byteLength(JSON.stringify({ [domain]: value }));
      if (domainBytes > 12000) {
        domainTruncated = true;
        continue;
      }
      domainTraffic[domain] = value;
    }
    for (const cid of actual) {
      const app = openresty(cid),
        deployment = app?.spec.deployments.find(
          (d: Row) => d.cluster_id === cid,
        ),
        policy = trafficPolicy(current, cid);
      traffic[cid] = {
        ...policy,
        gateway_domain: deployment?.gateway_domain ?? "",
        eligible: false,
      };
    }
    for (const d of db.all<Row>(
      "SELECT * FROM ops_platform_website_deployments WHERE website_id=? AND desired_revision>0",
      current.id,
    )) {
      const site = desired(current, d.cluster_id),
        state = deploymentStatus(d),
        policy = trafficPolicy(current, d.cluster_id);
      actor = d.policy_actor || actor;
      for (const binding of site.spec.bindings.filter(
        (b: Row) => b.dns_enabled,
      ))
        if (!grouped.has(binding.dns_zone_id))
          grouped.set(binding.dns_zone_id, []);
      if (!d.enabled || !websiteClusters(site).includes(d.cluster_id)) continue;
      if (
        site.spec.routing_mode === "managed" &&
        !endpoints(
          site.spec.service_application_id,
          site.spec.service_port_name,
          d.cluster_id,
        ).length
      ) {
        if (traffic[d.cluster_id])
          traffic[d.cluster_id].error = "service_backend_not_ready";
        continue;
      }
      const app = openresty(d.cluster_id);
      if (!app) continue;
      traffic[d.cluster_id] ??= { ...policy, eligible: false };
      const deployment = app.spec.deployments.find(
        (p: Row) => p.cluster_id === d.cluster_id,
      );
      if (!deploymentRow("application", app.id, d.cluster_id)?.enabled)
        continue;
      for (const i of rows(app.id, false, d.cluster_id)) {
        const receipt = state.instances?.[i.id];
        if (
          !servingGateway(i) ||
          receipt?.state !== "succeeded" ||
          receipt.enabled === false
        )
          continue;
        const version = db.get<Row>(
          "SELECT spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision=?",
          current.id,
          receipt.revision,
        );
        if (!version) continue;
        const applied = normalizeLegacy(
          "website",
          JSON.parse(deps.decrypt(version.spec_cipher)),
        );
        const cname = applied.dns_record_mode === "cname",
          domain = deployment?.gateway_domain;
        if (cname && !domain) {
          traffic[d.cluster_id].error = "openresty_cluster_domain_required";
          continue;
        }
        const ip = capacity(cluster(d.cluster_id), i.machine_id).public_address;
        if (!cname && (!ip || !isIP(ip))) {
          traffic[d.cluster_id].error = "openresty_public_ip_required_for_dns";
          continue;
        }
        for (const binding of applied.bindings.filter(
          (b: Row) => b.dns_enabled,
        )) {
          if (!grouped.has(binding.dns_zone_id))
            grouped.set(binding.dns_zone_id, []);
          for (const name of binding.domains) {
            const wanted = site.spec.bindings.find(
              (b: Row) =>
                b.dns_enabled &&
                b.dns_zone_id === binding.dns_zone_id &&
                b.domains.includes(name),
            );
            // Both the desired published package and the successful applied
            // receipt must authorize this exact domain in this cluster.
            if (
              !wanted ||
              !domainClusters(site.spec, name, websiteClusters(site)).includes(
                d.cluster_id,
              ) ||
              !domainClusters(applied, name, websiteClusters(site)).includes(
                d.cluster_id,
              )
            )
              continue;
            const domainPolicy = trafficPolicy(current, d.cluster_id, name);
            if (domainPolicy.enabled === false) continue;
            traffic[d.cluster_id].eligible = true;
            const summary = domainTraffic[name];
            if (summary && !summary.eligible_cluster_ids.includes(d.cluster_id))
              summary.eligible_cluster_ids.push(d.cluster_id);
            const lines = cname
              ? [
                  ...(domainPolicy.default !== false
                    ? [{ id: "default", name: "default" }]
                    : []),
                  ...domainPolicy.lines,
                ]
              : [undefined];
            for (const line of lines)
              grouped.get(binding.dns_zone_id)!.push({
                name,
                type: cname ? "CNAME" : isIP(ip) === 6 ? "AAAA" : "A",
                value: cname ? domain : ip,
                ttl: 600,
                ...(cname
                  ? { line: line.id, weight: domainPolicy.weight }
                  : {}),
              });
          }
        }
      }
    }
    store.patchStatus(current.id, {
      actual_cluster_ids: actual,
      cluster_traffic: traffic,
      domain_traffic: domainTraffic,
      domain_traffic_truncated: domainTruncated,
    });
    syncDNS(current, grouped, actor);
  }
  function syncDNS(
    current: PlatformResource,
    grouped: Map<string, Row[]>,
    actor: string,
  ) {
    if (closed || dnsPending.has(current.id) || dnsPending.size >= 8) return;
    if (tableExists("ops_dns_owned"))
      for (const old of db.all<Row>(
        "SELECT DISTINCT zone_id FROM ops_dns_owned WHERE owner_id=?",
        current.id,
      ))
        if (!grouped.has(old.zone_id)) grouped.set(old.zone_id, []);
    for (const [zone, records] of grouped)
      grouped.set(
        zone,
        [
          ...new Map(
            records.map((r) => [
              [r.name, r.type, r.value, r.line ?? "", r.weight ?? ""].join(":"),
              r,
            ]),
          ).values(),
        ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
    const signature = hash(
      JSON.stringify([...grouped].sort(([a], [b]) => a.localeCompare(b))),
    );
    if (
      current.status.dns_signature === signature ||
      !grouped.size ||
      (current.status.dns_error_at &&
        deps.now().getTime() - Date.parse(current.status.dns_error_at) <
          30000) ||
      !store.authorized(actor)
    )
      return;
    const work = (async () => {
      try {
        const results = [];
        for (const [zone, records] of grouped)
          results.push(
            await ensureDnsRecords(
              options,
              zone,
              current.id,
              records as any,
              actor,
            ),
          );
        if (results.every((r) => r.verified))
          store.patchStatus(current.id, {
            dns: results,
            dns_signature: signature,
            dns_error: "",
            dns_updated_at: at(),
          });
        else
          store.patchStatus(current.id, {
            dns: results,
            dns_error: "dns_verification_pending",
            dns_error_at: at(),
          });
      } catch (error) {
        store.patchStatus(current.id, {
          dns_error:
            error instanceof CloudError ? error.code : errorCode(error),
          dns_error_at: at(),
        });
      } finally {
        dnsPending.delete(current.id);
      }
    })();
    dnsPending.set(current.id, work);
  }
  const handles = (r: PlatformResource) =>
    r.kind === "cluster" ||
    (r.kind === "application" && !!r.spec.deployments) ||
    (r.kind === "website" && !!r.spec.cluster_ids && !!r.spec.bindings);
  const actions = (r: PlatformResource) =>
    r.kind === "cluster"
      ? ["inspect"]
      : r.kind === "website"
        ? ["deploy", "inspect", "disable"]
        : [
            "deploy",
            "inspect",
            "stop",
            "remove",
            "logs",
            "endpoints",
            "reconcile",
          ];
  const errorCode = (error: unknown) => {
    const message =
      error instanceof Error
        ? error.message.split(":", 1)[0]
        : "workload_action_failed";
    return /^[a-zA-Z][a-zA-Z0-9_.-]{0,179}$/.test(message)
      ? message
      : "workload_action_failed";
  };
  async function perform(
    r: PlatformResource,
    action: string,
    input: Row,
    actor: string,
  ): Promise<any> {
    if (!actions(r).includes(action)) fail(400, "unsupported_workload_action");
    if (r.kind === "cluster") {
      const runs = r.spec.machine_ids.flatMap((key: string) => {
        const m = machine(key);
        return online(m.agent_id)
          ? [
              store.queue(
                r,
                m.agent_id,
                "inspect",
                {
                  task: "node.inspect",
                  modern_cluster: true,
                  cluster_id: r.id,
                },
                actor,
              ),
            ]
          : [];
      });
      return {
        runs,
        nodes: r.spec.machine_ids.map((key: string) => ({
          ...capacity(r, key),
          online: online(machine(key).agent_id),
        })),
      };
    }
    const ids =
      r.kind === "application"
        ? r.spec.deployments.map((d: Row) => d.cluster_id)
        : websiteClusters(r);
    if (input.cluster_id && !ids.includes(input.cluster_id))
      fail(
        400,
        r.kind === "application"
          ? "application_not_deployed_in_cluster"
          : "website_cluster_mismatch",
      );
    if (r.kind === "website") followManagedWebsite(r);
    const selected = input.cluster_id ? [input.cluster_id] : ids;
    if (action === "endpoints") {
      if (!input.cluster_id) fail(400, "cluster_required");
      return store.run(r, action, actor, async () => ({
        service_name: r.spec.service_name,
        endpoints: endpoints(r.id, input.port_name, input.cluster_id),
      }));
    }
    if (r.kind === "website" && action === "inspect")
      return store.run(r, action, actor, async () => ({
        deployments: Object.fromEntries(
          selected.map((cid: string) => [
            cid,
            deploymentStatus(deploymentRow("website", r.id, cid)!),
          ]),
        ),
        dns: r.status.dns ?? {},
      }));
    const results: Row[] = [];
    for (const cid of selected) {
      try {
        if (r.kind === "website") {
          if (action === "deploy")
            validateWebsite(r.spec, undefined, { id: r.id, stored: true });
          if (action === "deploy")
            for (const b of r.spec.bindings.filter((b: Row) => b.https)) {
              let available = false;
              try {
                available =
                  Date.parse(
                    getCertificateMaterial(store, b.certificate_id).expires_at,
                  ) > deps.now().getTime();
              } catch {}
              if (!available && options.ensureCertificateMaterial)
                await options.ensureCertificateMaterial(
                  b.certificate_id,
                  actor,
                );
              if (
                Date.parse(
                  getCertificateMaterial(store, b.certificate_id).expires_at,
                ) <= deps.now().getTime()
              )
                fail(409, "website_certificate_expired");
            }
          const prior = deploymentRow("website", r.id, cid)!;
          patchDeployment("website", r.id, cid, {
            enabled: action !== "disable",
            desired_revision:
              action === "disable"
                ? prior.desired_revision || r.revision
                : r.revision,
            policy_actor: actor,
            active: false,
            phase: "deploying",
          });
          const app = openresty(cid),
            runs: PlatformRun[] = [];
          if (app && deploymentRow("application", app.id, cid)?.enabled) {
            const a = desired(app, cid);
            for (const i of rows(a.id, false, cid).filter(
              (i) => i.desired_state === "running" && online(i.agent_id),
            )) {
              const run = apply(a, i, r, actor, true);
              if (run) runs.push(run);
            }
          }
          websiteStatus(r.id, cid);
          results.push({
            cluster_id: cid,
            runs,
            ...(!app || !rows(app.id, false, cid).length
              ? { pending: "openresty_application_not_deployed" }
              : {}),
          });
          continue;
        }
        if (action === "deploy") {
          patchDeployment("application", r.id, cid, {
            enabled: true,
            desired_revision: r.revision,
            policy_actor: actor,
            pending: "",
            last_error: "",
          });
          results.push(reconcile(r, cid, actor, true));
          continue;
        }
        if (action === "reconcile") {
          results.push(
            reconcile(r, cid, actor, r.spec.deployment_mode === "managed"),
          );
          continue;
        }
        const instances = rows(r.id, true, cid).filter(
            (i) => !input.instance_id || i.id === input.instance_id,
          ),
          runs: PlatformRun[] = [];
        if (!instances.length) fail(409, "resource_not_deployed");
        for (const i of instances) {
          if (action === "stop" || action === "remove")
            db.run(
              "UPDATE ops_cluster_instances SET desired_state=? WHERE id=?",
              action === "remove" ? "removed" : "stopped",
              i.id,
            );
          if (!online(i.agent_id)) continue;
          let run;
          if (action === "stop" || action === "remove")
            run = stop(desired(r, cid), i, actor, action === "remove");
          else if (action === "logs")
            run = dispatch(
              r,
              i,
              r.spec.role === "openresty" ? "gateway.logs" : "workload.logs",
              { tail: input.tail ?? 100, container_id: input.container_id },
              i.desired_generation,
              actor,
            );
          else run = inspect(desired(r, cid), i, actor);
          if (run) runs.push(run);
        }
        if (action === "stop" || action === "remove")
          patchDeployment("application", r.id, cid, { enabled: false });
        results.push({ cluster_id: cid, runs });
      } catch (error) {
        const code = errorCode(error);
        patchDeployment(r.kind, r.id, cid, { last_error: code });
        if (selected.length === 1) {
          if (r.kind === "application") publish(r.id);
          else publishWebsite(r.id);
          throw error;
        }
        results.push({ cluster_id: cid, runs: [], error: code });
      }
    }
    if (r.kind === "application") publish(r.id);
    else publishWebsite(r.id);
    const failures = results.filter((d) => d.error);
    return {
      runs: results.flatMap((d) => d.runs ?? []),
      deployments: results,
      ...(failures.length
        ? {
            deployment_error: failures
              .map((d) => d.cluster_id + ":" + d.error)
              .join(","),
            partial: failures.length < results.length,
          }
        : {}),
      ...(results.length === 1 && results[0].pending
        ? { pending: results[0].pending }
        : {}),
    };
  }
  async function tick() {
    if (closed) return;
    for (const r of store.list().filter(handles)) {
      if (r.kind === "application")
        for (const d of db.all<Row>(
          "SELECT * FROM ops_platform_application_deployments WHERE application_id=?",
          r.id,
        )) {
          const actor = d.policy_actor || r.authorized_by;
          if (!store.authorized(actor)) continue;
          try {
            if (d.enabled) {
              reconcile(r, d.cluster_id, actor);
              for (const i of rows(r.id, false, d.cluster_id).filter(
                (i) =>
                  !busy(i) &&
                  i.desired_state === "running" &&
                  online(i.agent_id) &&
                  deps.now().getTime() -
                    Date.parse(i.last_seen || i.created_at) >=
                    30000,
              ))
                inspect(desired(r, d.cluster_id), i, actor);
            } else
              for (const i of rows(r.id, true, d.cluster_id).filter(
                (i) =>
                  i.desired_state !== "running" &&
                  !["stopped", "removed", "unknown"].includes(i.state) &&
                  !busy(i) &&
                  online(i.agent_id),
              ))
                stop(
                  desired(r, d.cluster_id),
                  i,
                  actor,
                  i.desired_state === "removed",
                );
          } catch (error) {
            patchDeployment("application", r.id, d.cluster_id, {
              last_error: errorCode(error),
            });
          }
          publish(r.id);
        }
      if (r.kind === "application" && r.spec.role === "openresty")
        startGatewayDNS(r);
      if (r.kind === "website") {
        followManagedWebsite(r);
        for (const d of db.all<Row>(
          "SELECT cluster_id FROM ops_platform_website_deployments WHERE website_id=? AND desired_revision>0",
          r.id,
        ))
          websiteStatus(r.id, d.cluster_id);
        startDNS(store.get(r.id));
      }
    }
  }
  return {
    handles,
    actions,
    perform,
    tick,
    endpoints,
    validateApplication,
    validateWebsite,
    afterSaveApplication,
    afterSaveWebsite,
    beforeDeleteApplication,
    beforeDeleteWebsite,
    afterDeleteApplication(r: PlatformResource) {
      db.run(
        "DELETE FROM ops_platform_application_deployments WHERE application_id=?",
        r.id,
      );
    },
    afterDeleteWebsite(r: PlatformResource) {
      db.run(
        "DELETE FROM ops_platform_website_deployments WHERE website_id=?",
        r.id,
      );
    },
    preview(site: PlatformResource, cid: string) {
      if (!cid || !site.spec.cluster_ids.includes(cid))
        fail(400, "cluster_required");
      return renderGateway(
        { http_port: 80, https_port: 443, sites: siteBundle(site, cid, true) },
        "PREVIEW",
        true,
      );
    },
    async close() {
      closed = true;
      await Promise.allSettled([...dnsPending.values()]);
      unsubscribe();
    },
  };
}
