import { HTTPError, fail } from "../shared/http.js";
import { OperationRejectedError } from "../operations/errors.js";
import type { Dependencies, Handler, Module } from "../shared/types.js";
import type { AgentJobStore } from "../server/agent-jobs.js";
import { OperationsPlatformStore, safeObject, cleanResult } from "./store.js";
import { createCertificateController } from "./certificates.js";
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
  },
) {
  const store = new OperationsPlatformStore(deps, options.jobs);
  const domainOptions = {
    store,
    deps,
    dataDir: options.dataDir,
    fetch: options.fetch,
  };
  const certificates = createCertificateController(domainOptions);
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
  const kind = (v: string | null) => {
    if (v && !store.definitions.has(v as ResourceKind))
      fail(400, "unsupported_platform_resource_kind");
    return v as ResourceKind | undefined;
  };
  const agents = () =>
    deps.db.all<any>(
      "SELECT id,host_id,hostname,version,platform,arch,last_seen,group_id FROM agents WHERE NOT EXISTS (SELECT 1 FROM agent_lifecycle l WHERE l.agent_id=agents.id AND l.state='removed') ORDER BY last_seen DESC,id LIMIT 1000",
    );
  router.get(
    "/api/v1/ops/overview",
    safe((ctx) =>
      ctx.json({
        resources: store
          .list()
          .slice(0, 1000)
          .map((r) => store.public(r)),
        agents: agents(),
        runs: store.actions(),
        capabilities: {
          kinds: [...store.definitions.keys()],
          dns_providers: ["aliyun", "dnspod"],
          certificate_cloud_providers: ["aliyun", "tencent", "volcengine"],
          agent_capability: "operations.platform",
        },
        total: Number(
          deps.db.get<any>("SELECT COUNT(*) AS n FROM ops_platform_resources")
            ?.n ?? 0,
        ),
        limit: 1000,
      }),
    ),
  );
  router.get(
    "/api/v1/ops/resources",
    safe((ctx) => {
      const k = kind(ctx.url.searchParams.get("kind")),
        resources = store.list(k),
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
        total: Number(
          (k
            ? deps.db.get<any>(
                "SELECT COUNT(*) AS n FROM ops_platform_resources WHERE kind=?",
                k,
              )
            : deps.db.get<any>(
                "SELECT COUNT(*) AS n FROM ops_platform_resources",
              )
          )?.n ?? 0,
        ),
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
      ctx.json(
        {
          resource: store.public(
            store.create(
              kind(b.kind)!,
              b.name,
              safeObject(b.spec),
              ctx.user.id,
            ),
          ),
        },
        201,
      );
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
      const domain = domains.find((d) => d.actions(r).includes(b.action));
      if (!domain) fail(400, "unsupported_platform_action");
      const result = await domain.perform(
        r,
        b.action,
        safeObject(b.input ?? {}),
        ctx.user.id,
      );
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
