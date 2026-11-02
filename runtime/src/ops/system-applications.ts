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
    CREATE TABLE IF NOT EXISTS ops_private_registry_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,carrier_cluster_id TEXT NOT NULL DEFAULT '',website_id TEXT NOT NULL DEFAULT '');
    INSERT OR IGNORE INTO ops_private_registry_settings(id,revision) VALUES(1,0);`);
}

export function requireSystemRegistry(store: PlatformStore) {
  const id = systemApplicationID(store, "registry");
  if (!id) fail(409, "private_registry_install_required");
  return store.get(id, "application");
}
