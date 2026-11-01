import type { PlatformResource, PlatformStore } from "./types.js";
import { systemApplicationID } from "./system-applications.js";
import { machineNetwork, machineServiceAddresses } from "../server/host-network.js";
import { networkScope } from "../shared/host-network.js";
import { privateRegistryAddress, registryEndpoint } from "../operations/registry-address.js";
import { cacheReference } from "../operations/image-cache.js";
type Row = Record<string, any>;
export const REGISTRY_IMAGE = "registry:3.0.0";
/** Service addresses come from host inventory, never the SSH connection target. */
export function automaticRegistryAddress(store: PlatformStore, machineID: string, legacy?: unknown): string {
  const network = machineNetwork(store.deps.db, machineID);
  const candidates = machineServiceAddresses(store.deps.db,machineID).private_ips;
  if (candidates.length) return candidates.includes(String(legacy)) ? String(legacy) : candidates[0];
  if (!network.addresses.length && legacy !== undefined) {
    try { return privateRegistryAddress(legacy); } catch {}
  }
  return '127.0.0.1';
}
export function registryCacheScope(address: string): 'machine' | 'cluster' {
  return networkScope(address) === 'loopback' ? 'machine' : 'cluster';
}

export function registryTemplateSpec() {
  const service = (port: number) => ({
    image: REGISTRY_IMAGE,
    restart: "unless-stopped",
    environment: {
      REGISTRY_HTTP_ADDR: `0.0.0.0:${port}`,
      REGISTRY_HTTP_DEBUG_ADDR: "127.0.0.1:0",
      REGISTRY_STORAGE_DELETE_ENABLED: "false",
      REGISTRY_HTTP_RELATIVEURLS: "true",
    },
  });
  return {
    mode: "compose",
    deployment_mode: "manual",
    stateful: true,
    role: "generic",
    compose: {
      services: {
        registry: service(5000),
        hub_cache: service(5001),
        origin_cache: service(5002),
      },
    },
    ports: [
      ["registry", 5000],
      ["hub-cache", 5001],
      ["origin-cache", 5002],
    ].map(([name, n]) => ({
      name,
      container_port: n,
      host_port: 0,
      protocol: "tcp",
      app_protocol: "http",
      host_ip: "127.0.0.1",
      service: String(name).replace("-", "_"),
    })),
    mounts: [
      { type: "data", service: "registry", target: "/var/lib/registry" },
      { type: "data", service: "hub_cache", target: "/var/lib/registry" },
      { type: "data", service: "origin_cache", target: "/var/lib/registry" },
    ],
    health: { type: "http", port_name: "registry", path: "/v2/" },
  };
}
export function registryRuntime(a: PlatformResource, app: Row): Row {
  if (a.spec.role !== "registry") return app;
  const enabled = a.spec.registry_cache_enabled === true;
  const keep = new Set([
    "registry",
    ...(enabled ? ["hub_cache"] : []),
    ...(enabled && a.spec.registry_upstream ? ["origin_cache"] : []),
  ]);
  for (const key of Object.keys(app.compose.services))
    if (!keep.has(key)) delete app.compose.services[key];
  // Placement budgets describe the entire deployment, not a separate full budget per helper.
  app.cpu = app.cpu / keep.size;
  app.memory_mb = app.memory_mb / keep.size;
  app.mounts = app.mounts.filter((m: Row) => keep.has(m.service));
  if (enabled) {
    app.compose.services.hub_cache.environment.REGISTRY_PROXY_REMOTEURL =
      "https://registry-1.docker.io";
    app.compose.services.hub_cache.environment.REGISTRY_PROXY_TTL = "168h";
    app.compose.services.hub_cache.environment.REGISTRY_STORAGE_DELETE_ENABLED =
      "true";
  }
  if (keep.has("origin_cache")) {
    app.compose.services.origin_cache.environment.REGISTRY_PROXY_REMOTEURL =
      a.spec.registry_upstream;
    app.compose.services.origin_cache.environment.REGISTRY_PROXY_TTL = "168h";
    app.compose.services.origin_cache.environment.REGISTRY_STORAGE_DELETE_ENABLED =
      "true";
  }
  return app;
}
export function registeredRegistryEndpoint(
  store: PlatformStore,
  cid: string,
  portName = "registry",
): string | undefined {
  const appID = systemApplicationID(store, "registry");
  if (!appID) return;
  const app = store.get(appID, "application");
  const d = app.spec.deployments?.find((d: Row) => d.cluster_id === cid);
  if (!d) return;
  const p = store.deps.db.get<Row>(
    `SELECT p.host_port,p.host_ip,i.address FROM ops_cluster_instances i JOIN ops_platform_instance_ports p ON p.instance_id=i.id WHERE i.owner_id=? AND i.cluster_id=? AND i.retired=0 AND i.desired_state='running' AND p.name=? ORDER BY i.created_at DESC LIMIT 1`,
    appID,
    cid,
    portName,
  );
  return p ? registryEndpoint(p.host_ip || p.address || d.registry_address, p.host_port) : undefined;
}
export function registryCacheFor(
  store: PlatformStore,
  a: PlatformResource,
  consumerMachineID?: string,
): Row | undefined {
  if (["registry", "openresty"].includes(a.spec.role)) return;
  const c = store.get(a.spec.cluster_id, "cluster");
  const appID = systemApplicationID(store, "registry");
  if (!appID) return;
  const app = store.get(appID, "application"),
    d = app.spec.deployments?.find((d: Row) => d.cluster_id === c.id);
  if (!d) return;
  const enabled =
    c.spec.image_cache?.enabled === true && d.registry_cache_enabled === true;
  const cfg = store.deps.db.get<Row>(
    "SELECT * FROM ops_private_registry_settings WHERE id=1",
  );
  let originHost = "";
  if (cfg?.website_id) {
    const site = store.get(cfg.website_id, "website");
    originHost = site.spec.bindings?.[0]?.domains?.[0] ?? "";
  }
  const endpointFor = (portName = 'registry') => {
    const endpoint = registeredRegistryEndpoint(store, c.id, portName);
    if (!endpoint) return;
    const address = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
    return registryCacheScope(address) === 'cluster' || consumerMachineID === d.machine_ids[0] ? endpoint : undefined;
  };
  const hub_endpoint = enabled ? endpointFor('hub-cache') : undefined;
  const origin_endpoint =
    originHost && cfg?.carrier_cluster_id === c.id
      ? endpointFor()
      : originHost && enabled
        ? endpointFor('origin-cache')
        : undefined;
  if (!hub_endpoint && !origin_endpoint) return;
  const policy = {
    version: 1,
    hub_endpoint,
    origin_endpoint,
    origin_host: originHost,
    origin_mode: cfg?.carrier_cluster_id === c.id ? "direct" : "cache",
    allow_upstream: true,
  };
  const images =
    a.spec.mode === "container"
      ? [a.spec.image]
      : Object.values<any>(a.spec.compose?.services ?? {}).map((s) => s.image);
  return images.some((image) => {
    try {
      return !!cacheReference(image, policy);
    } catch {
      return false;
    }
  })
    ? policy
    : undefined;
}
