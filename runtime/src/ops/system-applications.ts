import type { PlatformStore } from "./types.js";
import { fail } from "../shared/http.js";

export type SystemApplicationKind = "openresty" | "registry";
export const SYSTEM_SERVICE_NAMES = {
  openresty: "sys-openresty",
  registry: "sys-docker-registry",
} as const;

export function systemApplicationID(
  store: Pick<PlatformStore, "deps">,
  kind: SystemApplicationKind,
): string | undefined {
  return store.deps.db.get<{ application_id: string }>(
    "SELECT application_id FROM ops_system_applications WHERE kind=?",
    kind,
  )?.application_id;
}
export function systemApplicationKind(
  store: Pick<PlatformStore, "deps">,
  applicationID: string,
): SystemApplicationKind | undefined {
  return store.deps.db.get<{ kind: SystemApplicationKind }>(
    "SELECT kind FROM ops_system_applications WHERE application_id=?",
    applicationID,
  )?.kind;
}
export function ensureSystemTables(store: Pick<PlatformStore, "deps">) {
  store.deps.db
    .exec(`CREATE TABLE IF NOT EXISTS ops_system_applications(kind TEXT PRIMARY KEY,application_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_system_application_aliases(service_name TEXT PRIMARY KEY,application_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_private_registry_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,carrier_cluster_id TEXT NOT NULL DEFAULT '',website_id TEXT NOT NULL DEFAULT '');
    INSERT OR IGNORE INTO ops_private_registry_settings(id,revision) VALUES(1,0);`);
}

/** Identity-only migration: running instances, immutable history and desired revisions stay intact. */
export function migrateSystemApplications(store: PlatformStore) {
  for (const app of store
    .list("application")
    .filter((a) => a.spec.role === "openresty")) {
    const fixed = SYSTEM_SERVICE_NAMES.openresty;
    const occupied = store.deps.db.get<{ resource_id: string }>(
      "SELECT resource_id FROM ops_platform_application_keys WHERE service_name=? AND resource_id!=?",
      fixed,
      app.id,
    );
    if (occupied) {
      store.patchStatus(app.id, {
        system_name_migration_error: "system_service_name_conflict",
      });
      continue;
    }
    store.deps.db.transaction(() => {
      store.deps.db.run(
        "INSERT OR IGNORE INTO ops_system_applications VALUES(?,?,?)",
        "openresty",
        app.id,
        store.deps.now().toISOString(),
      );
      if (app.spec.service_name === fixed) return;
      if (app.spec.service_name)
        store.deps.db.run(
          "INSERT OR IGNORE INTO ops_system_application_aliases VALUES(?,?)",
          app.spec.service_name,
          app.id,
        );
      const spec = { ...app.spec, service_name: fixed };
      store.deps.db.run(
        "UPDATE ops_platform_resources SET spec_cipher=? WHERE id=?",
        store.deps.encrypt(JSON.stringify(spec)),
        app.id,
      );
      store.deps.db.run(
        "UPDATE ops_platform_application_keys SET service_name=? WHERE resource_id=?",
        fixed,
        app.id,
      );
    });
  }
}

export function requireSystemRegistry(store: PlatformStore) {
  const id = systemApplicationID(store, "registry");
  if (!id) fail(409, "private_registry_install_required");
  return store.get(id, "application");
}
