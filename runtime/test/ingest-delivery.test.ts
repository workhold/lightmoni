import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { parse as parseLossless, LosslessNumber } from "lossless-json";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { Auth } from "../src/server/auth.js";
import { Catalog } from "../src/server/catalog.js";
import {
  Ingest,
  normalize,
  stamp,
} from "../src/server/ingest.js";
import { sdkConfiguration, sampling } from "../src/server/settings.js";
import { stableJSON, nowNano } from "../src/shared/otlp.js";
async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-ingest-compat-")),
    db = new DB(join(dir, "state.db")),
    router = new Router(),
    auth = new Auth(db, dir, "http://127.0.0.1:0", router);
  router.auth = auth;
  auth.register();
  const inserts: any[] = [];
  const ch = {
      user: "writer",
      exec: async () => {},
      query: async () => ({ meta: [], data: [], rows: 0 }),
      insert: async (table: string, rows: any[]) => {
        inserts.push({ table, rows });
      },
    },
    catalog = new Catalog(db, ch, { ...ch, user: "reader" });
  new Ingest(catalog, auth).register();
  const server = createServer((req, res) => void router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}}));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  router.externalURL = base;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const setup = await fetch(base + "/api/v1/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "admin", password: "password123" }),
  });
  assert.equal(setup.status, 201);
  await setup.text();
  const keyResponse = await fetch(base + "/api/v1/keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: setup.headers.get("set-cookie")!.split(";")[0],
    },
    body: JSON.stringify({ name: "fake key", }),
  });
  assert.equal(keyResponse.status, 201);
  const key = ((await keyResponse.json()) as any).key;
  const at = nowNano().toString(),
    payload = Buffer.from(
      JSON.stringify({
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "test" } },
              ],
            },
            scopeLogs: [
              {
                logRecords: [
                  { timeUnixNano: at, body: { stringValue: "hello" } },
                ],
              },
            ],
          },
        ],
      }),
    );
  async function send(
    id: string,
    raw: Buffer = payload,
    extra: Record<string, string> = {},
  ) {
    const response = await fetch(base + "/v1/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer " + key,
        "X-Lightmoni-Table": "app",
        "X-Lightmoni-Batch-ID": id,
        ...extra,
      },
      body: new Uint8Array(raw),
    });
    await response.text();
    return response.status;
  }
  return { db, inserts, send, payload };
}
test("center durable ACK returns retryable errors for failed metadata insert/commit and preserves replay IDs", async (t) => {
  const f = await fixture(t);
  f.db.exec(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON ingest_batches BEGIN SELECT RAISE(ABORT,'injected metadata failure'); END;",
  );
  assert.equal(await f.send("insert-failure"), 503);
  assert.equal(f.inserts.length, 0);
  f.db.exec("DROP TRIGGER reject_receipt");
  assert.equal(await f.send("insert-failure"), 200);
  assert.equal(f.inserts.length, 1);
  f.db.exec(
    "CREATE TRIGGER reject_completion BEFORE UPDATE OF completed ON ingest_batches BEGIN SELECT RAISE(ABORT,'injected metadata failure'); END;",
  );
  assert.equal(await f.send("commit-failure"), 503);
  assert.equal(f.inserts.length, 2);
  const event = f.inserts[1].rows[0].event_id;
  assert.equal(
    f.db.get<any>(
      "SELECT completed FROM ingest_batches WHERE id=?",
      "commit-failure",
    )!.completed,
    0,
  );
  f.db.exec("DROP TRIGGER reject_completion");
  assert.equal(await f.send("commit-failure"), 200);
  assert.equal(f.inserts.length, 3);
  assert.equal(f.inserts[2].rows[0].event_id, event);
  assert.equal(await f.send("commit-failure"), 200);
  assert.equal(f.inserts.length, 3);
});
test("center limits decompressed gzip to 4 MiB, rejects corrupt gzip, and accepts a valid compressed batch", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.send("gzip-valid", gzipSync(f.payload), {
      "Content-Encoding": "gzip",
    }),
    200,
  );
  assert.equal(
    await f.send("gzip-bomb", gzipSync(Buffer.alloc((4 << 20) + 2, 32)), {
      "Content-Encoding": "gzip",
    }),
    413,
  );
  assert.equal(
    await f.send("gzip-corrupt", Buffer.from("bad gzip"), {
      "Content-Encoding": "gzip",
    }),
    400,
  );
  assert.equal(
    await f.send("plain-large", Buffer.alloc((4 << 20) + 1, 32)),
    413,
  );
});
