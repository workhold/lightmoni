import {
  imageSourcePolicy,
  imageSourceReference,
  imageSourceRules,
} from "../operations/image-sources.js";
import { fail } from "../shared/http.js";
import type { Handler } from "../shared/types.js";
import type { PlatformStore } from "./types.js";

export function createImageSourcesSchema(store: PlatformStore) {
  store.deps.db
    .exec(`CREATE TABLE IF NOT EXISTS ops_image_sources(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,rules_json TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT OR IGNORE INTO ops_image_sources VALUES(1,0,'[]','','');`);
}
export function imageSources(store: PlatformStore) {
  const row = store.deps.db.get<any>(
    "SELECT * FROM ops_image_sources WHERE id=1",
  );
  return {
    revision: row.revision,
    rules: JSON.parse(row.rules_json),
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}
export function imageSourcesFor(store: PlatformStore, config: any) {
  if (!["workload.apply", "gateway.apply"].includes(config.task)) return;
  const saved = imageSources(store);
  if (!saved.rules.length) return;
  const app = config.application;
  const images =
    config.task === "gateway.apply"
      ? [config.image ?? "openresty/openresty:1.27.1.2-0-alpine"]
      : app?.mode === "container"
        ? [app.image]
        : Object.values<any>(app?.compose?.services ?? {}).map((s) => s.image);
  const rules = saved.rules.filter((rule: any) =>
    images.some((image) => !!imageSourceReference(image, [rule])),
  );
  return rules.length
    ? { version: 1, revision: saved.revision, rules }
    : undefined;
}
export function validateImageSourcesPayload(store: PlatformStore, config: any) {
  const expected = imageSourcesFor(store, config);
  if (JSON.stringify(expected) !== JSON.stringify(config.image_sources))
    fail(409, "image_sources_policy_changed");
  if (config.image_sources) imageSourcePolicy(config.image_sources);
}
export function registerImageSources(
  store: PlatformStore,
  safe: (fn: Handler) => Handler,
) {
  const { router, db } = store.deps,
    base = "/api/v1/ops/image-sources";
  router.get(
    base,
    safe((ctx) => ctx.json(imageSources(store))),
  );
  router.put(
    base,
    safe(async (ctx) => {
      const input = await ctx.body();
      if (
        !input ||
        typeof input !== "object" ||
        Object.keys(input).some((k) => !["rules", "revision"].includes(k)) ||
        !Number.isSafeInteger(input.revision) ||
        input.revision < 0
      )
        fail(400, "invalid_image_sources");
      const rules = imageSourceRules(input.rules);
      const changed = db.run(
        "UPDATE ops_image_sources SET revision=revision+1,rules_json=?,updated_by=?,updated_at=? WHERE id=1 AND revision=?",
        JSON.stringify(rules),
        ctx.user.id,
        store.deps.now().toISOString(),
        input.revision,
      );
      if (!changed.changes) fail(409, "image_sources_revision_conflict");
      ctx.json(imageSources(store));
    }),
  );
}
