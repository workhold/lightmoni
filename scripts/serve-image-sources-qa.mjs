/** Disposable loopback UI acceptance with real operations policy APIs and in-memory SQLite. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { DB } from "../runtime/dist/shared/sqlite.js";
import { cipher } from "../runtime/dist/shared/crypto.js";
import { Router, fail } from "../runtime/dist/shared/http.js";
import { registerAgentJobs } from "../runtime/dist/server/agent-jobs.js";
import { registerOperationsPlatform } from "../runtime/dist/ops/index.js";
const db = new DB(":memory:");
db.exec(
  `CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT INTO users VALUES('qa-admin','admin',1);CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);`,
);
const router = new Router(),
  deps = {
    db,
    router,
    ...cipher(Buffer.alloc(32, 75)),
    now: () => new Date(),
    logger: { info() {}, warn() {}, error() {} },
    auth: {
      requireAdmin(ctx) {
        if (ctx.user.role !== "admin") fail(403, "administrator_required");
      },
      user() {
        return { id: "qa-admin", name: "Disposable QA", role: "admin" };
      },
    },
  };
router.auth = deps.auth;
const jobs = registerAgentJobs(deps, { agentCredentials: { has: () => true } }),
  platform = registerOperationsPlatform(deps, {
    jobs,
    dataDir: ".local-dev/075-ui",
    intervalMs: 1000000,
  });
const fixtures = {
  "/api/v1/setup": { required: false },
  "/api/v1/auth/providers": [],
  "/api/v1/auth/me": { id: "qa-admin", name: "Disposable QA", role: "admin" },
  "/api/v1/auth/profile": {},
  "/api/v1/catalog/tables": [],
  "/api/v1/dashboards": [],
};
const publicDir = resolve("runtime/public");
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/__qa/conflict" && req.method === "POST") {
      db.run("UPDATE ops_image_sources SET revision=revision+1 WHERE id=1");
      res.end("ok");
      return;
    }
    if (Object.hasOwn(fixtures, path)) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(fixtures[path]));
      return;
    }
    if (path.startsWith("/api/")) {
      if (await router.handle(req, res)) return;
      res.setHeader("content-type", "application/json");
      res.end("[]");
      return;
    }
    const file = path.startsWith("/assets/")
      ? resolve(publicDir, "." + path)
      : resolve(publicDir, "index.html");
    if (!file.startsWith(publicDir + "/")) throw Error("path");
    res.setHeader(
      "content-type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      }[extname(file)] ?? "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(500);
    res.end("QA server error");
  }
});
server.listen(19875, "127.0.0.1", () =>
  console.log(
    "Disposable image source QA: http://127.0.0.1:19875/image-sources",
  ),
);
process.on("SIGTERM", async () => {
  server.close();
  await platform.close();
  jobs.close?.();
  db.close();
  process.exit(0);
});
