import { CloudError, zoneFor } from "./cloud.js";
import { registerObservability } from "./observability.js";
import { applicationCatalog, applicationCategories, catalogInstallation } from "./catalog.js";
import { HTTPError, fail } from "../shared/http.js";
import { OperationRejectedError } from "../operations/errors.js";
import type { Dependencies, Handler, Module } from "../shared/types.js";
import type { AgentJobStore } from "../server/agent-jobs.js";
import { OperationsPlatformStore, safeObject, cleanResult } from "./store.js";
import { createCertificateController, getCertificateMaterial, publicCertificateMaterial, type CertificateControllerOptions } from "./certificates.js";
import { createWorkloadController } from "./workloads.js";
import type { DomainController, ResourceKind } from "./types.js";

/** One host-owned control plane; every domain shares authentication, revisions and Agent jobs. */
export function registerOperationsPlatform(
  deps: Dependencies,
  options: {
    jobs: AgentJobStore;
    dataDir: string;
    fetch?: typeof fetch;
    intervalMs?: number;
    certificate?: Pick<CertificateControllerOptions, "acmeClientFactory" | "resolveChallenge">;
  },
) {
  const store = new OperationsPlatformStore(deps, options.jobs);
  const domainOptions = {
    store,
    deps,
    dataDir: options.dataDir,
    fetch: options.fetch,
  };
  const certificates = createCertificateController({...domainOptions, ...options.certificate});
  const workloads = createWorkloadController({
    ...domainOptions,
    ensureCertificateMaterial: async (certificateID, actor) => {
      const certificate = store.get(certificateID, "certificate");
      const result = await certificates.perform(
        certificate,
        "issue",
        {},
        actor,
      );
      if (result.state !== "succeeded")
        fail(409, "website_certificate_issuance_failed");
    },
  });
  const domains: DomainController[] = [certificates, workloads];
  const { router } = deps;
  let timer: ReturnType<typeof setInterval> | undefined,
    closed = false;
  const domainTicks = new Map<DomainController, Promise<void>>();
  const safe =
    (fn: Handler): Handler =>
    async (ctx) => {
      try {
        if (closed) fail(503, "platform_shutting_down");
        deps.auth.requireAdmin(ctx);
        await fn(ctx);
      } catch (error: any) {
        if (error instanceof CloudError) {
          ctx.json({ error: error.code }, 400);
          return;
        }
        if (error instanceof HTTPError)
          ctx.json({ error: error.message }, error.status);
        else if (error instanceof OperationRejectedError)
          ctx.json({ error: error.message }, 400);
        else if (
          error instanceof Error &&
          /UNIQUE constraint failed/.test(error.message)
        )
          ctx.json({ error: "platform_name_or_allocation_conflict" }, 409);
        else {
          deps.logger.error("Operations platform request failed");
          ctx.json({ error: "platform_request_failed" }, 500);
        }
      }
    };
  registerObservability(deps, store, safe, options.jobs);
  // Include rejection responses in the no-store boundary, before the admin guard.
  const certificateResponse = (fn: Handler): Handler => ctx => {
    ctx.res.setHeader("Cache-Control", "no-store");
    ctx.res.setHeader("X-Content-Type-Options", "nosniff");
    return safe(fn)(ctx);
  };
  router.get("/api/v1/ops/resources/:id/certificate", certificateResponse(ctx => {
    ctx.json({certificate: publicCertificateMaterial(getCertificateMaterial(store, ctx.params.id))});
  }));
  router.post("/api/v1/ops/resources/:id/certificate/download", certificateResponse(async ctx => {
    const body = safeObject(await ctx.body());
    if (typeof body.version !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(body.version))
      fail(400, "invalid_certificate_version");
    if (!["cert", "chain", "fullchain", "private_key"].includes(body.format))
      fail(400, "invalid_certificate_download_format");
    const material = getCertificateMaterial(store, ctx.params.id, body.version);
    const view = publicCertificateMaterial(material);
    const files = {
      cert: ["cert.pem", view.certificate_pem],
      chain: ["chain.pem", view.chain_pem],
      fullchain: ["fullchain.pem", view.fullchain_pem],
      private_key: ["privkey.pem", material.private_key_pem],
    };
    const [name, pem] = files[body.format as keyof typeof files];
    if (!pem) fail(409, body.format === "chain" ? "certificate_chain_unavailable" : "certificate_material_invalid");
    const resourceID = ctx.params.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0,160);
    ctx.res.setHeader("Content-Type", "application/x-pem-file");
    ctx.res.setHeader("Content-Disposition", `attachment; filename="${resourceID}-${body.version}-${name}"`);
    ctx.res.end(pem);
  }));
  const publicKinds = new Set([
    "credential",
    "dns_zone",
    "acme_account",
    "certificate",
    "certificate_target",
    "cluster",
    "application",
    "website",
  ]);
  const kind = (v: string | null) => {
    if (v && (!store.definitions.has(v as ResourceKind) || !publicKinds.has(v)))
      fail(400, "unsupported_platform_resource_kind");
    return v as ResourceKind | undefined;
  };
  const inCluster = (
    resource: ReturnType<typeof store.get>,
    cid: string | null,
  ) => {
    if (!cid) return true;
    if (resource.kind === "cluster") return resource.id === cid;
    if (resource.kind === "application")
      return (
        resource.spec.deployments?.some((d: any) => d.cluster_id === cid) ??
        false
      );
    if (resource.kind === "website")
      return (resource.status.actual_cluster_ids ?? resource.spec.cluster_ids)?.includes(cid) ?? false;
    return true; // Credentials, certificates and managed domains are shared.
  };
  const agents = () =>
    deps.db.all<any>(
      "SELECT id,host_id,hostname,version,platform,arch,last_seen,group_id FROM agents WHERE NOT EXISTS (SELECT 1 FROM agent_lifecycle l WHERE l.agent_id=agents.id AND l.state='removed') ORDER BY last_seen DESC,id LIMIT 1000",
    );
  const machines = () => {
    if (
      !deps.db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='managed_machines'",
      )
    )
      return [];
    return deps.db
      .all<any>(
        "SELECT m.id,m.name,m.address,m.agent_id,c.cluster_id FROM managed_machines m LEFT JOIN ops_platform_cluster_members c ON c.machine_id=m.id ORDER BY m.name,m.id",
      )
      .map((m) => ({
        ...m,
        agent_status:
          m.agent_id &&
          deps.db.get(
            "SELECT id FROM agents WHERE id=? AND last_seen>?",
            m.agent_id,
            new Date(deps.now().getTime() - 120000).toISOString(),
          )
            ? "online"
            : "offline",
      }));
  };
  router.get(
    "/api/v1/ops/catalog",
    safe((ctx) => ctx.json({ templates: applicationCatalog, categories: applicationCategories })),
  );
  router.post(
    "/api/v1/ops/catalog/:id/install",
    safe(async (ctx) => {
      const b = safeObject(await ctx.body());
      if (b.confirmed !== undefined && typeof b.confirmed !== "boolean")
        fail(400, "platform_confirmation_required");
      const installation = catalogInstallation(ctx.params.id, b);
      const resource = store.create(
        "application",
        installation.name,
        installation.spec,
        ctx.user.id,
      );
      let result: Record<string, any> = {};
      if (b.confirmed === true) {
        try {
          result = await workloads.perform(resource, "deploy", {}, ctx.user.id);
        } catch (error) {
          const candidate =
            error instanceof HTTPError ||
            error instanceof OperationRejectedError
              ? error.message.split(":", 1)[0]
              : "platform_deployment_failed";
          const code = /^[a-zA-Z][a-zA-Z0-9_.-]{0,179}$/.test(candidate)
            ? candidate
            : "platform_deployment_failed";
          store.patchStatus(resource.id, {
            last_error: code,
            last_error_at: deps.now().toISOString(),
          });
          result = { runs: store.actions(resource.id), deployment_error: code };
        }
      }
      ctx.json(
        { resource: store.public(store.get(resource.id)), ...result },
        201,
      );
    }),
  );
  router.get(
    "/api/v1/ops/overview",
    safe((ctx) =>
      ctx.json({
        resources: store
          .list()
          .filter(
            (r) =>
              publicKinds.has(r.kind) &&
              inCluster(r, ctx.url.searchParams.get("cluster_id")),
          )
          .slice(0, 1000)
          .map((r) => store.public(r)),
        agents: agents(),
        machines: machines(),
        runs: store.actions(),
        capabilities: {
          kinds: [...publicKinds],
          dns_providers: ["aliyun", "dnspod"],
          certificate_cloud_providers: ["aliyun", "tencent", "volcengine"],
          agent_capability: "operations.platform",
        },
        total: store
          .list()
          .filter(
            (r) =>
              publicKinds.has(r.kind) &&
              inCluster(r, ctx.url.searchParams.get("cluster_id")),
          ).length,
        limit: 1000,
      }),
    ),
  );
  router.get(
    "/api/v1/ops/resources",
    safe((ctx) => {
      const k = kind(ctx.url.searchParams.get("kind")),
        resources = store
          .list(k)
          .filter(
            (r) =>
              publicKinds.has(r.kind) &&
              inCluster(r, ctx.url.searchParams.get("cluster_id")),
          ),
        offset = Number(ctx.url.searchParams.get("offset") ?? 0),
        limit = Number(ctx.url.searchParams.get("limit") ?? 1000);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        fail(400, "invalid_platform_pagination");
      ctx.json({
        resources: resources
          .slice(offset, offset + limit)
          .map((r) => store.public(r)),
        limit,
        offset,
        next_offset: offset + limit < resources.length ? offset + limit : null,
        total: resources.length,
      });
    }),
  );
  router.get(
    "/api/v1/ops/resources/:id",
    safe((ctx) =>
      ctx.json({ resource: store.public(store.get(ctx.params.id)) }),
    ),
  );
  router.post(
    "/api/v1/ops/resources",
    safe(async (ctx) => {
      const b = safeObject(await ctx.body());
      if (b.kind === "application" && !b.spec?.deployments)
        fail(400, "application_deployment_required");
      if (b.kind === "website" && !b.spec?.cluster_ids)
        fail(400, "website_cluster_required");
      if (b.kind === "website" && !b.spec?.bindings)
        fail(400, "website_binding_required");
      const resource = store.create(kind(b.kind)!, b.name, safeObject(b.spec), ctx.user.id);
      const run = resource.kind === "certificate" ? certificates.startIssue(resource, "issue", ctx.user.id) : undefined;
      ctx.json({resource: store.public(store.get(resource.id)), ...(run ? {run} : {})}, 201);
    }),
  );
  router.put(
    "/api/v1/ops/resources/:id",
    safe(async (ctx) => {
      const b = safeObject(await ctx.body());
      if (!Number.isSafeInteger(b.revision))
        fail(400, "platform_revision_required");
      ctx.json({
        resource: store.public(
          store.update(
            ctx.params.id,
            b.revision,
            b.name ?? store.get(ctx.params.id).name,
            safeObject(b.spec),
            ctx.user.id,
          ),
        ),
      });
    }),
  );
  router.delete(
    "/api/v1/ops/resources/:id",
    safe(async (ctx) => {
      const b = safeObject(await ctx.body());
      store.remove(ctx.params.id, b.revision);
      ctx.json({ deleted: true, remote_data_deleted: false });
    }),
  );
  router.get('/api/v1/ops/runs/:id', safe(ctx => ctx.json(store.action(ctx.params.id))));
  router.get('/api/v1/ops/runs/:id/events', safe(ctx => {
    const events = store.runEvents(ctx.params.id, Number(ctx.url.searchParams.get('after') ?? 0));
    ctx.json({run: store.action(ctx.params.id), events, next_after: events.at(-1)?.sequence ?? Number(ctx.url.searchParams.get('after') ?? 0)});
  }));
  router.get(
    "/api/v1/ops/resources/:id/dns-lines",
    safe(async (ctx) => {
      const { zone, client } = zoneFor(domainOptions, ctx.params.id);
      ctx.json(await client.dnsLines(zone.spec.domain));
    }),
  );
  router.get(
    "/api/v1/ops/runs",
    safe((ctx) =>
      ctx.json({
        runs: store.actions(
          ctx.url.searchParams.get("resource_id") ?? undefined,
        ),
        limit: 100,
      }),
    ),
  );
  router.get(
    "/api/v1/ops/resources/:id/actions",
    safe((ctx) => {
      const r = store.get(ctx.params.id);
      ctx.json({ actions: domains.flatMap((d) => d.actions(r)) });
    }),
  );
  router.post(
    "/api/v1/ops/resources/:id/actions",
    safe(async (ctx) => {
      const b = safeObject(await ctx.body()),
        r = store.get(ctx.params.id);
      if (b.revision !== r.revision) fail(409, "platform_revision_conflict");
      if (b.confirmed !== true) fail(400, "platform_confirmation_required");
      if (typeof b.action !== "string") fail(400, "platform_action_required");
      if (
        (["service", "node_pool", "gateway_group"].includes(r.kind) ||
          (r.kind === "application" && !r.spec.deployments)) &&
        ["deploy", "reconcile"].includes(b.action)
      )
        fail(409, "legacy_deployment_requires_cluster_migration");
      const domain = domains.find((d) => d.actions(r).includes(b.action));
      if (!domain) fail(400, "unsupported_platform_action");
      const input = safeObject(b.input ?? {});
      const result = r.kind === "certificate" && ["issue", "renew"].includes(b.action)
        ? certificates.startIssue(r, b.action, ctx.user.id)
        : await domain.perform(r, b.action, input, ctx.user.id);
      ctx.json(
        cleanResult(
          result?.id && result?.state ? { run: result } : (result ?? {}),
        ),
        202,
      );
    }),
  );
  function tick(): Promise<void> {
    if (closed) return Promise.resolve();
    for (const domain of domains) {
      if (domainTicks.has(domain)) continue;
      const pending = Promise.resolve()
        .then(() => domain.tick?.())
        .catch(() => {
          deps.logger.warn("Operations reconciliation needs attention");
        })
        .finally(() => {
          domainTicks.delete(domain);
        });
      domainTicks.set(domain, pending);
    }
    return Promise.allSettled([...domainTicks.values()]).then(() => undefined);
  }
  return {
    store,
    resolvePayload: store.resolvePayload.bind(store),
    tick,
    start() {
      if (timer) return;
      timer = setInterval(
        () => void tick(),
        Math.max(1000, options.intervalMs ?? 15000),
      );
      timer.unref?.();
      void tick();
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await Promise.allSettled([...domainTicks.values()]);
      for (const d of domains) await d.close?.();
      await store.close();
    },
  } satisfies Module & {
    store: OperationsPlatformStore;
    resolvePayload: OperationsPlatformStore["resolvePayload"];
    tick: () => Promise<void>;
  };
}
