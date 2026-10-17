// Isolated fixture server for the existing ingestion/agent browser workflow.
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../runtime/dist/server/app.js";

const directory = mkdtempSync(join(tmpdir(), "lightmoni-table-key-qa-"));
const ch = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end('{"meta":[],"data":[],"rows":0}');
});
ch.listen(0, "127.0.0.1");
await once(ch, "listening");
let app;
try {
  app = await createApp({
    dataDir: directory,
    chURL: "http://127.0.0.1:" + ch.address().port,
    chUser: "qa",
    chPassword: "qa-fixture",
    externalURL: "http://127.0.0.1:5178",
    monitor: false,
  });
  for (const logical of ["web", "business", "host", "probe"])
    app.deps.db.run(
      "INSERT INTO catalog(id,name,logical_name,kind,metric_type,columns_json,services_json) VALUES(?,?,?,'log','','[]','[]')",
      "log_" + logical,
      "log_" + logical,
      logical,
    );
  app.deps.db.run(
    "INSERT INTO ingest_keys(id,name,token_hash,created_at) VALUES('qa-legacy','旧 Key 待配置',?,'2026-10-10')",
    createHash("sha256").update("qa-legacy-secret").digest("hex"),
  );
  app.server.listen(18882, "127.0.0.1");
  await once(app.server, "listening");
  console.info(
    "QA backend on 127.0.0.1:18882; isolated temporary SQLite; ClickHouse writes stubbed",
  );
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await app?.close();
  ch.closeAllConnections();
  await new Promise((resolve) => ch.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
