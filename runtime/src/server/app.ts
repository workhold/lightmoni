import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync, statSync, createReadStream } from "node:fs";
import { resolve, join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { DB } from "../shared/sqlite.js";
import { ClickHouse } from "../shared/clickhouse.js";
import { Router } from "../shared/http.js";
import { hash } from "../shared/crypto.js";
import { stringifyJSON } from "../shared/json.js";
import type { Dependencies, Module } from "../shared/types.js";
import { Auth } from "./auth.js";
import { Catalog } from "./catalog.js";
import { Executor } from "./query.js";
import { Ingest } from "./ingest.js";
import { RuntimeMonitor } from "./monitor.js";
import { registerSettings } from "./settings.js";
import { registerInstall } from "./install.js";
import { registerTemplates } from "./templates.js";
import { registerCore } from "./core.js";
import { registerNodes } from "./nodes.js";
import { registerAgentCredentials } from "./agent-credentials.js";
import { registerMachineTerminal } from "./machine-terminal.js";
import { registerManagedMachines } from "./managed-machines.js";
import { registerServiceDeployments } from "./service-deployments.js";
import { registerAgentJobs } from "./agent-jobs.js";
import { registerTaskCenter } from "./task-center.js";
import { registerOperations } from "./operations.js";
import { registerOperationSchedules } from "./operation-schedules.js";
import { websiteDefinition } from "../operations/websites.js";
import { certificateDefinition } from "../operations/certificates.js";
import { composeDefinition } from "../operations/containers.js";
import { backupDefinition } from "../operations/backups.js";
import { ReleaseArtifactStore } from "../deployment/artifact-store.js";
import { registerAssistant } from "../assistant/index.js";
import { registerDashboards } from "../domains/dashboards.js";
import { registerLogs } from "../domains/logs.js";
import { registerAlerts } from "../domains/alerts.js";
import { AlertCapabilities } from "../domains/alert-capabilities.js";
export interface Config {
  dataDir: string;
  chURL: string;
  chUser: string;
  chPassword: string;
  externalURL: string;
  publicDir?: string;
  downloadsDir?: string;
  monitor?: boolean;
  trustedProxies?: string[];
}
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
export async function createApp(cfg: Config) {
  const db = new DB(join(cfg.dataDir, "lightmoni.db")),
    modules: Module[] = [];
  let monitor: RuntimeMonitor | undefined;
  const logger = {
    info: (...args: any[]) => {
      console.info(...args);
      monitor?.log("info", String(args[0] ?? ""));
    },
    warn: (...args: any[]) => {
      console.warn(...args);
      monitor?.log("warn", String(args[0] ?? ""));
    },
    error: (...args: any[]) => {
      console.error(...args);
      monitor?.log("error", String(args[0] ?? ""));
    },
  };
  const router = new Router(() => logger.error("HTTP request failed"));
  router.externalURL = cfg.externalURL;
  try {
    const auth = new Auth(db, cfg.dataDir, cfg.externalURL, router);
    router.auth = auth;
    auth.register();
    const ch = new ClickHouse(cfg.chURL, cfg.chUser, cfg.chPassword, "");
    await ch.exec("CREATE DATABASE IF NOT EXISTS lightmoni");
    ch.database = "lightmoni";
    const readerPassword = hash(auth.master),
      reader = new ClickHouse(cfg.chURL, "lightmoni_reader", readerPassword);
    await ch.exec(
      "CREATE USER IF NOT EXISTS lightmoni_reader IDENTIFIED WITH sha256_password BY '" +
        readerPassword +
        "'",
    );
    await ch.exec("ALTER USER lightmoni_reader SETTINGS readonly=2");
    const cat = new Catalog(db, ch, reader);
    await cat.migrate();
    const executor = new Executor(reader, cat),
      deps: Dependencies = {
        db,
        router,
        auth,
        cat,
        ch,
        reader,
        query: executor.execute.bind(executor),
        referencedTables: executor.referencedTables.bind(executor),
        externalURL: cfg.externalURL,
        encrypt: auth.encrypt,
        decrypt: auth.decrypt,
        now: () => new Date(),
        logger,
      };
    const agentCredentials = registerAgentCredentials(deps);
    // Agent jobs are registered before service deployments so an approved
    // deployment can enqueue its immutable pull-based job atomically with the
    // centre state transition. The job module itself never executes commands.
    const agentJobs = registerAgentJobs(deps, { agentCredentials });
    const managedMachines = registerManagedMachines(deps, { agentCredentials });
    modules.push(managedMachines);
    registerSettings(deps, agentCredentials);
    // Service delivery metadata is intentionally separate from Agent bootstrap
    // records: plans can be reviewed before an Agent executes them.
    const releaseArtifacts = new ReleaseArtifactStore(join(cfg.dataDir, "release-artifacts"));
    const serviceDeployments = registerServiceDeployments(deps, { jobs: agentJobs, artifacts: releaseArtifacts });
    modules.push(serviceDeployments);
    const operations = registerOperations(deps, { jobs: agentJobs, credentials: agentCredentials, definitions: [websiteDefinition, certificateDefinition, composeDefinition, backupDefinition] });
    modules.push(operations, registerOperationSchedules(deps, operations));
    const ingest = new Ingest(cat, auth, (...args) =>
      monitor?.accepted(...args),
      agentCredentials,
    );
    ingest.register();
    registerTemplates(deps);
    registerInstall(
      deps,
      cfg.downloadsDir ?? join(root, "downloads"),
      agentCredentials,
    );
    modules.push(
      registerNodes(deps, {
        internalExporter: ingest.internal.bind(ingest),
        agentCredentials,
        trustedProxies: cfg.trustedProxies,
      }),
    );
    modules.push(agentJobs);
    const taskCenter = registerTaskCenter(deps, { agentCredentials });
    modules.push(taskCenter);
    // Enrollment credentials are a separate migration boundary. Legacy
    // config.key based nodes keep working until they explicitly re-enroll.
    modules.push(agentCredentials);
    modules.push(registerDashboards(deps));
    modules.push(registerLogs(deps));
    const alerts = registerAlerts(deps);
    modules.push(alerts);
    modules.push(
      registerAssistant(deps, {
        machines: managedMachines,
        alerts: new AlertCapabilities(alerts),
        deployments: serviceDeployments,
        operations,
        taskCenter,
      }),
    );
    if (cfg.monitor !== false) {
      monitor = new RuntimeMonitor(ingest, [cfg.chPassword]);
      modules.unshift(monitor);
    }
    registerCore(deps);
    const publicDir = resolve(cfg.publicDir ?? join(root, "public"));
    const fallback = async (req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (
        path.startsWith("/api/") ||
        path.startsWith("/v1/") ||
        path.startsWith("/downloads/")
      ) {
        res.writeHead(path.startsWith("/api/") && !auth.user(req) ? 401 : 404, {
          "content-type": "application/json",
        });
        res.end(
          stringifyJSON({
            error:
              path.startsWith("/api/") && !auth.user(req)
                ? "请先登录"
                : "not found",
          }),
        );
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      let relative: string;
      try {
        relative = decodeURIComponent(path);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      let file = resolve(publicDir, "." + relative);
      if (file !== publicDir && !file.startsWith(publicDir + sep)) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (!existsSync(file) || !statSync(file).isFile())
        file = join(publicDir, "index.html");
      if (!existsSync(file)) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("Web assets are missing; run npm --prefix web run build");
        return;
      }
      res.writeHead(200, {
        "content-type": mime[extname(file)] ?? "application/octet-stream",
        "content-length": statSync(file).size,
        "cache-control":
          extname(file) === ".html"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      await pipeline(createReadStream(file), res);
    };
    const server = createServer((req, res) => {
      const start = performance.now();
      res.once("finish", () => {
        const signal = (req.url ?? "").split("?")[0].slice(4);
        if (
          req.method === "POST" &&
          ["logs", "metrics", "traces"].includes(signal)
        )
          monitor?.request(signal, res.statusCode, performance.now() - start);
      });
      void router
        .handle(req, res)
        .then((found) => (found ? undefined : fallback(req, res)))
        .catch(() => {
          if (!res.headersSent)
            res.writeHead(500, { "content-type": "application/json" });
          if (!res.writableEnded) res.end('{"error":"服务暂不可用"}');
        });
    });
    modules.push(registerMachineTerminal(deps, managedMachines, server));
    server.headersTimeout = 10000;
    server.requestTimeout = 30000;
    for (const module of modules) await module.start?.();
    let closed = false;
    return {
      server,
      deps,
      router,
      async close() {
        if (closed) return;
        closed = true;
        const closedServer = new Promise<void>((r) => {
          if (!server.listening) {
            r();
            return;
          }
          server.close(() => r());
        });
        const timer = setTimeout(() => server.closeAllConnections(), 10000);
        timer.unref();
        for (const module of [...modules].reverse())
          try {
            await module.close?.();
          } catch {
            logger.warn("Module shutdown failed");
          }
        await closedServer;
        clearTimeout(timer);
        db.close();
      },
    };
  } catch (error) {
    try {
      for (const module of [...modules].reverse())
        try {
          await module.close?.();
        } catch {
          logger.warn("Module cleanup failed");
        }
    } finally {
      db.close();
    }
    throw error;
  }
}
