import { fail } from "../shared/http.js";
import { HTTPError } from "../shared/http.js";
import type { Handler } from "../shared/types.js";
import type {
  DomainController,
  PlatformResource,
  PlatformStore,
} from "./types.js";
import { safeObject, type OperationsPlatformStore } from "./store.js";
import {
  systemApplicationID,
  requireSystemRegistry,
} from "./system-applications.js";
import {
  registryTemplateSpec,
  registeredRegistryEndpoint,
} from "./registry-runtime.js";
import { automaticRegistryAddress, registryCacheScope } from "./registry-runtime.js";
import { catalogInstallation } from "./catalog.js";
type Row = Record<string, any>;
/** Only this host controller can register the system's image source. Business registries remain ordinary apps. */
export function createPrivateRegistryController(
  store: OperationsPlatformStore,
  workloads: DomainController,
) {
  const db = store.deps.db;
  const settings = () =>
    db.get<Row>("SELECT * FROM ops_private_registry_settings WHERE id=1")!;
  const revision = (supplied: any, actual: number) => {
    if (!Number.isSafeInteger(supplied))
      fail(400, "platform_revision_required");
    if (supplied !== actual) fail(409, "platform_revision_conflict");
  };
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
  const publish = async (app: PlatformResource, cid: string, actor: string) =>
    workloads.perform(app, "deploy", { cluster_id: cid }, actor);
  async function syncClusterCache(cluster: PlatformResource, actor: string) {
    const key = systemApplicationID(store, "registry");
    if (!key) return {};
    let app = store.get(key, "application");
    const d = app.spec.deployments.find(
      (d: Row) => d.cluster_id === cluster.id,
    );
    if (!d) return {};
    const changed =
      d.registry_cache_enabled !== (cluster.spec.image_cache?.enabled === true);
    if (!changed && cluster.status.image_cache?.state !== "pending") return {};
    try {
      if (changed)
        app = store.updateSystemApplication(
          app.id,
          app.revision,
          app.name,
          app.spec,
          actor,
        );
      const result = await publish(app, cluster.id, actor);
      store.patchStatus(cluster.id, {
        image_cache: { state: "submitted", error: "" },
      });
      return result;
    } catch (error) {
      if (!(error instanceof HTTPError)) throw error;
      store.patchStatus(cluster.id, {
        image_cache: { state: "pending", error: error.message },
      });
      return { cache_pending: error.message };
    }
  }
  async function deploy(b: Row, actor: string) {
    if (b.confirmed !== true)
      fail(400, "registry_confirmation_required");
    if (b.cache_enabled !== undefined && typeof b.cache_enabled !== "boolean")
      fail(400, "invalid_cluster_image_cache");
    const key = systemApplicationID(store, "registry");
    let app = key ? store.get(key, "application") : undefined;
    revision(b.revision, app?.revision ?? 0);
    const cluster = store.get(b.cluster_id, "cluster");
    if (
      typeof b.machine_id !== "string" ||
      !cluster.spec.machine_ids.includes(b.machine_id)
    )
      fail(400, "registry_machine_not_in_cluster");
    const prior = app?.spec.deployments.find(
      (d: Row) => d.cluster_id === cluster.id,
    );
    const ip = automaticRegistryAddress(store, b.machine_id, prior?.registry_address ?? b.address);
    const deployment = {
      cluster_id: cluster.id,
      machine_ids: [b.machine_id],
      registry_address: ip,
      host_ports: b.host_ports === undefined ? prior?.host_ports : b.host_ports,
      cpu: b.cpu ?? 0.25,
      memory_mb: b.memory_mb ?? 256,
    };
    const deployments = [
      ...(app?.spec.deployments ?? []).filter(
        (d: Row) => d.cluster_id !== cluster.id,
      ),
      deployment,
    ];
    app = app
      ? store.updateSystemApplication(
          app.id,
          app.revision,
          app.name,
          { ...app.spec, deployments },
          actor,
        )
      : store.createSystemApplication(
          "registry",
          "系统镜像仓库",
          { ...registryTemplateSpec(), deployments },
          actor,
        );
    // Cluster is the single source of truth. A newly registered deployment must exist before enabling it.
    if (b.cache_enabled !== undefined) {
      if (typeof b.cache_enabled !== "boolean")
        fail(400, "invalid_cluster_image_cache");
      const current = store.get(cluster.id, "cluster");
      if (current.spec.image_cache?.enabled !== b.cache_enabled) {
        store.update(
          current.id,
          current.revision,
          current.name,
          { ...current.spec, image_cache: { enabled: b.cache_enabled } },
          actor,
        );
        app = store.updateSystemApplication(
          app.id,
          app.revision,
          app.name,
          app.spec,
          actor,
        );
      }
    }
    const result = await publish(app, cluster.id, actor);
    return { ...overview(), ...result, created: !prior };
  }
  async function setCache(cid: string, b: Row, actor: string) {
    const c = store.get(cid, "cluster");
    revision(b.revision, c.revision);
    if (typeof b.enabled !== "boolean")
      fail(400, "invalid_cluster_image_cache");
    if (b.enabled && !systemApplicationID(store, "registry"))
      fail(409, "private_registry_install_required");
    const updated = store.update(
      c.id,
      c.revision,
      c.name,
      { ...c.spec, image_cache: { enabled: b.enabled } },
      actor,
    );
    const result = await syncClusterCache(updated, actor);
    return { ...overview(), cluster: store.public(updated), ...result };
  }
  async function external(b: Row, actor: string) {
    if (b.confirmed !== true) fail(400, "platform_confirmation_required");
    const cfg = settings();
    revision(b.revision, cfg.revision);
    let app = requireSystemRegistry(store);
    const cid = b.carrier_cluster_id,
      d = app.spec.deployments.find((d: Row) => d.cluster_id === cid);
    if (!d) fail(400, "registry_carrier_deployment_required");
    if (cfg.carrier_cluster_id && cfg.carrier_cluster_id !== cid)
      fail(409, "registry_data_migration_required");
    const oldSite = cfg.website_id
      ? store.get(cfg.website_id, "website")
      : undefined;
    if (oldSite && b.website_revision !== oldSite.revision)
      fail(409, "platform_revision_conflict");
    const spec = {
      mode: "proxy",
      routing_mode: "manual",
      cluster_ids: [cid],
      auth: {
        mode: "basic",
        realm: "Private Registry",
        users: [{ username: b.username, password: b.password ?? "" }],
      },
      nginx: { redirect_https: true, body_size_mb: 0 },
      bindings: [
        {
          domains: [b.domain],
          https: true,
          certificate_id: b.certificate_id,
          locations: [
            {
              path: "/",
              auth: { mode: "inherit" },
              body_size_mb: 0,
              websocket: false,
              request_buffering: false,
              buffering: false,
              read_timeout_seconds: 900,
              send_timeout_seconds: 900,
              cluster_targets: [
                {
                  cluster_id: cid,
                  target: "application",
                  application_id: app.id,
                  port_name: "registry",
                },
              ],
            },
          ],
        },
      ],
    };
    // Validate the complete website before installing a gateway or touching any persistent pointer.
    store
      .definition("website")
      .validate(spec, oldSite?.spec, { id: oldSite?.id ?? "" });
    const upstream = registeredRegistryEndpoint(store, cid);
    if (!upstream) fail(409, "registry_deployment_not_started");
    const gatewayID = systemApplicationID(store, "openresty");
    let gateway = gatewayID ? store.get(gatewayID, "application") : undefined;
    if (!gateway?.spec.deployments.some((p: Row) => p.cluster_id === cid)) {
      if (b.install_openresty !== true)
        fail(409, "registry_openresty_install_confirmation_required");
      const gd = {
        cluster_id: cid,
        machine_ids: [d.machine_ids[0]],
        cpu: 0.25,
        memory_mb: 128,
      };
      const installation = catalogInstallation("openresty", {
        name: "网站网关",
        deployments: [gd],
        deployment_mode: "manual",
      });
      gateway = gateway
        ? store.updateSystemApplication(
            gateway.id,
            gateway.revision,
            gateway.name,
            { ...gateway.spec, deployments: [...gateway.spec.deployments, gd] },
            actor,
          )
        : store.createSystemApplication(
            "openresty",
            installation.name,
            installation.spec,
            actor,
          );
    }
    const site = oldSite
      ? store.update(oldSite.id, oldSite.revision, oldSite.name, spec, actor)
      : store.create("website", "私有镜像仓库入口", spec, actor);
    db.run(
      "UPDATE ops_private_registry_settings SET revision=revision+1,carrier_cluster_id=?,website_id=? WHERE id=1",
      cid,
      site.id,
    );
    if (app.spec.registry_upstream !== upstream) {
      app = store.updateSystemApplication(
        app.id,
        app.revision,
        app.name,
        { ...app.spec, registry_upstream: upstream },
        actor,
      );
    }
    const results = [];
    results.push(await publish(gateway!, cid, actor));
    results.push(
      await workloads.perform(site, "deploy", { cluster_id: cid }, actor),
    );
    for (const deployment of app.spec.deployments)
      if (deployment.cluster_id !== cid && deployment.registry_cache_enabled)
        results.push(await publish(app, deployment.cluster_id, actor));
    return { ...overview(), results };
  }
  function register(safe: (fn: Handler) => Handler) {
    const r = store.deps.router,
      base = "/api/v1/ops/private-registry";
    r.get(
      base,
      safe((ctx) => ctx.json(overview())),
    );
    r.post(
      base + "/deployments",
      safe(async (ctx) =>
        ctx.json(await deploy(safeObject(await ctx.body()), ctx.user.id), 201),
      ),
    );
    r.put(
      base + "/clusters/:id/cache",
      safe(async (ctx) =>
        ctx.json(
          await setCache(
            ctx.params.id,
            safeObject(await ctx.body()),
            ctx.user.id,
          ),
        ),
      ),
    );
    r.put(
      base + "/external",
      safe(async (ctx) =>
        ctx.json(await external(safeObject(await ctx.body()), ctx.user.id)),
      ),
    );
  }
  const tick = async () => {
    const key = systemApplicationID(store, "registry");
    if (!key) return;
    for (const d of store.get(key, "application").spec.deployments) {
      const c = store.get(d.cluster_id, "cluster");
      if (
        d.registry_cache_enabled !== (c.spec.image_cache?.enabled === true) ||
        c.status.image_cache?.state === "pending"
      )
        await syncClusterCache(c, c.authorized_by);
    }
  };
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
