import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { Auth } from "../src/server/auth.js";
import { Catalog } from "../src/server/catalog.js";
import { Ingest } from "../src/server/ingest.js";
import { registerCore } from "../src/server/core.js";
import { registerSettings } from "../src/server/settings.js";
import { registerTemplates } from "../src/server/templates.js";
import { registerInstall } from "../src/server/install.js";
import { registerNodes } from "../src/server/nodes.js";
import { registerAssistant } from "../src/assistant/index.js";
import { registerDashboards } from "../src/domains/dashboards.js";
import { registerLogs } from "../src/domains/logs.js";
import { registerAlerts } from "../src/domains/alerts.js";
import type { Dependencies } from "../src/shared/types.js";
test("current public routes retain their authentication boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-routes-")),
    db = new DB(":memory:");
  try {
    const router = new Router(),
      auth = new Auth(db, dir, "http://localhost", router),
      ch = {
        exec: async () => {},
        query: async () => ({ meta: [], data: [], rows: 0 }),
        insert: async () => {},
      },
      cat = new Catalog(db, ch, ch),
      deps: Dependencies = {
        db,
        router,
        auth,
        ch,
        reader: ch,
        cat,
        query: async () => ({ request_id: "fixture", results: [] }),
        referencedTables: async () => [],
        externalURL: "http://localhost",
        encrypt: auth.encrypt,
        decrypt: auth.decrypt,
        now: () => new Date(),
        logger: console,
      };
    auth.register();
    registerSettings(deps);
    new Ingest(cat, auth).register();
    registerCore(deps);
    registerTemplates(deps);
    registerInstall(deps, dir);
    registerNodes(deps);
    registerAssistant(deps);
    registerDashboards(deps);
    registerLogs(deps);
    registerAlerts(deps);
    const canonical = (s: string) =>
      s.replace(/:[^/]+/g, ":param").replace(/\/$/, "");
    const routes = router.list();
    const publicPaths = new Set([
      "/healthz",
      "/api/v1/setup",
      "/api/v1/auth/login",
      "/api/v1/auth/logout",
      "/api/v1/auth/providers",
      "/api/v1/auth/oauth/:id/start",
      "/api/v1/auth/oauth/:id/callback",
      "/api/v1/agents/register",
      "/api/v1/agents/enroll",
      "/api/v1/agents/:id/activate",
      "/api/v1/agents/:id/heartbeat",
      "/api/v1/agents/:id/config",
      "/v1/center-identity",
      "/v1/center-endpoints",
      "/v1/sdk-config",
      "/v1/logs",
      "/v1/metrics",
      "/v1/traces",
      "/downloads/agent/:file",
      "/downloads/sdk/:file",
    ]);
    for (const r of routes)
      if (r.public)
        assert(
          publicPaths.has(r.path) || /callback/.test(r.path),
          "unexpected public route " + r.path,
        );
    for (const r of routes.filter((r) =>
      r.path.startsWith("/api/v1/assistant"),
    ))
      assert.equal(r.public, false);

  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
