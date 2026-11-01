import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import {
  applicationLogo,
  MAX_LOGO_BYTES,
} from "../src/ops/application-logos.js";
import { pngFixture, pngData, pngChunk } from "./fixtures/application-logo.js";
import { DB } from "../src/shared/sqlite.js";
import { cipher } from "../src/shared/crypto.js";
import { Router } from "../src/shared/http.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { OperationsPlatformStore } from "../src/ops/store.js";
import { applicationCatalog } from "../src/ops/catalog.js";
import type { Dependencies } from "../src/shared/types.js";

test("bounded PNG decoding rejects executable, malformed, oversized, invalid CRC and decompression inputs", () => {
  const png = pngFixture();
  assert.deepEqual(applicationLogo(pngData(png)).content, png);
  for (const v of [
    null,
    {},
    "https://example.test/logo.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,aaa",
    pngData(png.subarray(0, 30)),
    pngData(Buffer.concat([png, Buffer.from("trailing")])),
    pngData(pngFixture(513, 1)),
  ])
    assert.throws(() => applicationLogo(v));
  const corrupt = Buffer.from(png);
  corrupt[30] ^= 1;
  assert.throws(
    () => applicationLogo(pngData(corrupt)),
    /invalid_application_logo/,
  );
  const bombHeader = Buffer.from(png);
  bombHeader.writeUInt32BE(1, 16);
  bombHeader.writeUInt32BE(1, 20);
  bombHeader.writeUInt32BE(crc32(bombHeader.subarray(12, 29)), 29);
  assert.throws(
    () => applicationLogo(pngData(bombHeader)),
    /invalid_application_logo/,
  );
  assert.throws(
    () =>
      applicationLogo(
        "data:image/png;base64," + "A".repeat(MAX_LOGO_BYTES * 2),
      ),
    /application_logo_too_large/,
  );
  const metadata = Buffer.concat([
    png.subarray(0, 33),
    pngChunk("tEXt", Buffer.from("private metadata")),
    png.subarray(33),
  ]);
  assert.deepEqual(applicationLogo(pngData(metadata)).content, png);
});

test("31 local brand assets have exact source hashes, distinct identities and no external or executable SVG references", () => {
  const root = resolve(
      import.meta.dirname,
      "../../web/src/assets/application-logos",
    ),
    sources = JSON.parse(readFileSync(join(root, "sources.json"), "utf8"));
  assert.equal(sources.assets.length, 31);
  assert.deepEqual(
    sources.assets.map((a: any) => a.id).sort(),
    applicationCatalog.map((t) => t.id).sort(),
  );
  assert.equal(new Set(sources.assets.map((a: any) => a.sha256)).size, 31);
  for (const asset of sources.assets) {
    const raw = readFileSync(join(root, asset.file));
    assert.equal(createHash("sha256").update(raw).digest("hex"), asset.sha256);
    assert.ok(asset.source_url.startsWith("https://"));
    assert.ok(readFileSync(join(root, asset.license_file)).length);
    if (asset.file.endsWith(".svg"))
      assert.doesNotMatch(
        raw.toString(),
        /<script|foreignObject|<!DOCTYPE|<!ENTITY|\son[a-z]+=|(?:href|src)\s*=\s*["'](?:https?:|data:|\/\/)/i,
      );
  }
});

test("logo metadata is durable, atomic, versioned independently and removed with its application", (t) => {
  const root = mkdtempSync(join(tmpdir(), "lightmoni-logo-test-")),
    path = join(root, "state.db");
  let db: DB, store: OperationsPlatformStore, jobs: any;
  function open() {
    db = new DB(path);
    db.exec(
      "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT OR IGNORE INTO users VALUES('admin','admin',1),('member','member',1);CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY)",
    );
    const deps = {
      db,
      router: new Router(),
      ...cipher(Buffer.alloc(32, 9)),
      now: () => new Date("2026-11-01T10:00:00Z"),
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as Dependencies;
    jobs = registerAgentJobs(deps, {
      agentCredentials: { has: () => true } as any,
    });
    store = new OperationsPlatformStore(deps, jobs);
    store.register("application", { validate: (s) => s });
  }
  function close() {
    store.close();
    jobs.close?.();
    db.close();
  }
  open();
  t.after(() => {
    close();
    rmSync(root, { recursive: true, force: true });
  });
  const r = store.create(
    "application",
    "Logo app",
    { mode: "container", image: "nginx:alpine" },
    "admin",
    pngData(),
  );
  assert.equal(store.public(r).logo_revision, 1);
  assert.equal(r.revision, 1);
  assert.equal((r.spec as any).logo, undefined);
  assert.throws(
    () =>
      store.create(
        "application",
        "Bad logo",
        { image: "nginx:alpine" },
        "admin",
        "bad",
      ),
    /invalid_application_logo/,
  );
  assert.equal(store.list().length, 1);
  const counts = () => [
    db.get<any>("SELECT count(*) AS n FROM ops_platform_revisions")!.n,
    db.get<any>("SELECT count(*) AS n FROM agent_jobs")!.n,
  ];
  const before = counts();
  store.setApplicationLogo(r.id, 1, pngData(pngFixture(2, 2, 10)), "admin");
  assert.equal(store.get(r.id).revision, 1);
  assert.deepEqual(counts(), before);
  assert.throws(
    () => store.setApplicationLogo(r.id, 1, null, "admin"),
    /application_logo_conflict/,
  );
  assert.throws(
    () => store.setApplicationLogo(r.id, 2, null, "member"),
    /platform_authorization_required/,
  );
  const saved = store.readApplicationLogo(r.id).sha256;
  close();
  open();
  assert.equal(store.readApplicationLogo(r.id).sha256, saved);
  assert.equal(store.public(store.get(r.id)).logo_revision, 2);
  store.setApplicationLogo(r.id, 2, null, "admin");
  assert.equal(store.public(store.get(r.id)).logo_url, undefined);
  assert.equal(store.public(store.get(r.id)).logo_revision, 3);
  assert.throws(
    () => store.readApplicationLogo(r.id),
    /application_logo_not_found/,
  );
  assert.throws(
    () => store.setApplicationLogo(r.id, 0, pngData(), "admin"),
    /application_logo_conflict/,
  );
  store.remove(r.id, 1);
  assert.equal(
    db.get<any>("SELECT count(*) AS n FROM ops_application_logos")!.n,
    0,
  );
});
