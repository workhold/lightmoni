/** Disposable loopback harness for web/src/app/ops/verify-live-ui.mjs.
 * Uses real SQLite, encryption, HTTP routes and domain controllers. Authentication
 * is an explicit QA administrator; remote Agents and external cloud calls are disabled.
 * Run from runtime/: node --import tsx test/fixtures/platform-ui-server.ts
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../../src/shared/sqlite.js";
import { Router, fail } from "../../src/shared/http.js";
import { cipher } from "../../src/shared/crypto.js";
import { registerAgentJobs } from "../../src/server/agent-jobs.js";
import { registerOperations } from "../../src/server/operations.js";
import { registerOperationsPlatform } from "../../src/ops/index.js";

const port = Number(process.env.LIGHTMONI_OPS_QA_PORT ?? 19933);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("invalid_qa_port");
const root = await mkdtemp(join(tmpdir(), "lightmoni-platform-ui-"));
const db = new DB(join(root, "qa.db")),
  router = new Router();
db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);
  INSERT INTO users VALUES('qa-admin','QA Administrator','admin',1);
  CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);
  CREATE TABLE services(id TEXT PRIMARY KEY);`);
db.run(
  "INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?)",
  "qa-node",
  "qa-host",
  "QA Docker 节点",
  "qa-033",
  "linux",
  "amd64",
  new Date().toISOString(),
  "default",
  "{}",
);
const user = {
  id: "qa-admin",
  name: "QA Administrator",
  role: "admin",
  preferences: { default_homepage: "/operations" },
};
const deps: any = {
  db,
  router,
  ...cipher(randomBytes(32)),
  now: () => new Date(),
  logger: {
    info() {},
    warn() {},
    error() {
      process.stderr.write("QA operations request failed\n");
    },
  },
  auth: {
    requireAdmin(ctx: any) {
      if (ctx.user.role !== "admin") fail(403, "administrator_required");
    },
    user: () => user,
  },
};
router.auth = deps.auth;
const credentials: any = {
  authenticate() {
    fail(403, "qa_agent_not_enrolled");
  },
};
const jobs = registerAgentJobs(deps, { agentCredentials: credentials });
const platform = registerOperationsPlatform(deps, {
  jobs,
  dataDir: root,
  fetch: async () => {
    throw Error("qa_external_network_disabled");
  },
});
registerOperations(deps, {
  jobs,
  credentials,
  definitions: [],
  resolvePayload: platform.resolvePayload,
});
router.get("/api/v1/auth/me", (ctx) => ctx.json(user));
router.get("/api/v1/user/preferences", (ctx) =>
  ctx.json({ default_homepage: "/operations" }),
);
router.get("/api/v1/assistant/providers", (ctx) => ctx.json({ providers: [] }));
router.get("/api/v1/assistant/sessions", (ctx) => ctx.json({ sessions: [] }));
const server = createServer(async (req, res) => {
  if (!(await router.handle(req, res))) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "qa_route_not_registered" }));
  }
});
server.listen(port, "127.0.0.1", () =>
  process.stdout.write(`Disposable QA API: http://127.0.0.1:${port}\n`),
);
const timer = setInterval(
  () =>
    db.run(
      "UPDATE agents SET last_seen=? WHERE id=?",
      new Date().toISOString(),
      "qa-node",
    ),
  30000,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await platform.close();
  db.close();
  await rm(root, { recursive: true, force: true });
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
