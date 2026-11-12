import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";

test("static responses distinguish HTML, versioned assets, and missing assets", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lm-static-cache-"));
  const publicDir = join(directory, "public");
  mkdirSync(join(publicDir, "assets"), { recursive: true });
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>LightMoni</title>");
  writeFileSync(join(publicDir, "page.html"), "<!doctype html><title>Other</title>");
  writeFileSync(join(publicDir, "assets", "app-AbC123_d.js"), "export default 1;");
  writeFileSync(join(publicDir, "assets", "theme-xyZ456_-.css"), "body{}");
  writeFileSync(join(publicDir, "assets", "plain.js"), "export default 2;");
  writeFileSync(join(publicDir, "robots.txt"), "User-agent: *\n");
  const clickhouse = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"meta":[],"data":[],"rows":0}');
    });
  });
  await new Promise<void>((resolve) => clickhouse.listen(0, "127.0.0.1", resolve));
  const app = await createApp({
    dataDir: directory,
    publicDir,
    chURL: `http://127.0.0.1:${(clickhouse.address() as { port: number }).port}`,
    chUser: "writer",
    chPassword: "fixture-only",
    externalURL: "http://127.0.0.1:8080",
    monitor: false,
  });
  t.after(async () => {
    await app.close();
    clickhouse.closeAllConnections();
    await new Promise<void>((resolve) => clickhouse.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const cases: [string, number, string][] = [
    ["/", 200, "no-store"],
    ["/index.html", 200, "no-store"],
    ["/page.html", 200, "no-store"],
    ["/machines/host-1", 200, "no-store"],
    ["/assets/app-AbC123_d.js", 200, "public, max-age=31536000, immutable"],
    ["/assets/theme-xyZ456_-.css", 200, "public, max-age=31536000, immutable"],
    ["/assets/plain.js", 200, "public, max-age=3600"],
    ["/robots.txt", 200, "public, max-age=3600"],
    ["/assets/missing-AbC123_d.js", 404, "no-store"],
  ];
  for (const [path, status, cache] of cases) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, status, `${method} ${path}`);
      assert.equal(response.headers.get("cache-control"), cache, `${method} ${path}`);
      const body = await response.text();
      if (method === "HEAD" || status === 404) assert.equal(body, "", `${method} ${path}`);
      else assert.notEqual(body, "", `${method} ${path}`);
      if (path === "/machines/host-1")
        assert.match(response.headers.get("content-type") ?? "", /^text\/html/, `${method} ${path}`);
    }
  }
});
