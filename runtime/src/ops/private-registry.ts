import { fail } from "../shared/http.js";
import type { Handler } from "../shared/types.js";
import type {
  DomainController,
  PlatformResource,
} from "./types.js";
import type { OperationsPlatformStore } from "./store.js";
import {
  systemApplicationID,
} from "./system-applications.js";
import {
  registeredRegistryEndpoint,
} from "./registry-runtime.js";
import { registryCacheScope } from "./registry-runtime.js";
type Row = Record<string, any>;
/** Only this host controller can register the system's image source. Business registries remain ordinary apps. */
export function createPrivateRegistryController(
  store: OperationsPlatformStore,
  _workloads: DomainController,
) {
  const db = store.deps.db;
  const settings = () =>
    db.get<Row>("SELECT * FROM ops_private_registry_settings WHERE id=1")!;
  const overview = () => {
    const key = systemApplicationID(store, "registry"),
      app = key ? store.get(key, "application") : undefined,
      cfg = settings();
    return {
      revision: app?.revision ?? 0,
      application: app ? store.public(app) : null,
      external: {
        revision: cfg.revision,
        carrier_cluster_id: cfg.carrier_cluster_id,
        website: cfg.website_id
          ? store.public(store.get(cfg.website_id, "website"))
          : null,
      },
      deployments: (app?.spec.deployments ?? []).map((d: Row) => ({
        cluster_id: d.cluster_id,
        machine_id: d.machine_ids[0],
        address: d.registry_address,
        cache_scope: registryCacheScope(d.registry_address),
        host_ports: Object.fromEntries((app?.spec.ports??[]).map((p:Row)=>[p.name,d.host_ports?.[p.name]??p.host_port])),
        cache_enabled:
          store.get(d.cluster_id, "cluster").spec.image_cache?.enabled === true,
        endpoint: registeredRegistryEndpoint(store, d.cluster_id) ?? "",
        hub_cache_endpoint: d.registry_cache_enabled
          ? (registeredRegistryEndpoint(store, d.cluster_id, "hub-cache") ?? "")
          : "",
        status: {
          ...app?.status.deployments?.[d.cluster_id],
          cache_pending:
            d.registry_cache_enabled !==
              (store.get(d.cluster_id, "cluster").spec.image_cache?.enabled ===
                true) ||
            store.get(d.cluster_id, "cluster").status.image_cache?.state ===
              "pending",
        },
      })),
    };
  };
  const unavailable = (): never => fail(409, "privileged_profile_not_implemented");
  const deploy = async (_body: Row, _actor: string): Promise<Row> => unavailable();
  const setCache = async (_clusterID: string, _body: Row, _actor: string): Promise<Row> => unavailable();
  const external = async (_body: Row, _actor: string): Promise<Row> => unavailable();
  async function syncClusterCache(cluster: PlatformResource, _actor: string): Promise<Row> {
    const key = systemApplicationID(store, "registry");
    if (!key) return {};
    const deployment = store.get(key, "application").spec.deployments.find((d: Row) => d.cluster_id === cluster.id);
    if (!deployment || deployment.registry_cache_enabled === (cluster.spec.image_cache?.enabled === true) && cluster.status.image_cache?.state !== "pending") return {};
    return {cache_pending: "privileged_profile_not_implemented"};
  }
  function register(safe: (fn: Handler) => Handler) {
    const r = store.deps.router,
      base = "/api/v1/ops/private-registry";
    r.get(
      base,
      safe((ctx) => ctx.json(overview())),
    );
    r.post(base + "/deployments", safe(() => unavailable()));
    r.put(base + "/clusters/:id/cache", safe(() => unavailable()));
    r.put(base + "/external", safe(() => unavailable()));
  }
  const tick = async () => {};
  return {
    register,
    overview,
    deploy,
    setCache,
    syncClusterCache,
    external,
    tick,
  };
}
