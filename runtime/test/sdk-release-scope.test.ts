import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { Auth } from "../src/server/auth.js";
import { registerInstall } from "../src/server/install.js";
import { registerSettings } from "../src/server/settings.js";
import type { Dependencies } from "../src/shared/types.js";

test("current SDK downloads expose the four record SDKs and reject stale legacy archives", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-sdk-release-"));
  const db = new DB(":memory:"), router = new Router();
  const auth = new Auth(db, directory, "http://localhost", router);
  router.auth = auth;
  auth.register();
  const deps = { db, router, auth, externalURL: "https://monitor.example/base" } as Dependencies;
  registerSettings(deps);
  registerInstall(deps, directory);
  for (const language of ["python", "ruby", "php", "go", "rust"])
    writeFileSync(join(directory, `lightmoni-${language}-sdk_0.1.0.tar.gz`), language);
  writeFileSync(join(directory, "lightmoni-sdk-0.1.0.tgz"), "typescript");
  const server = createServer(async (req, res) => {
    if (!(await router.handle(req, res))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(endpoint + "/api/v1/sdk-install")).status, 401);
    const setup = await fetch(endpoint + "/api/v1/setup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sdk-admin", password: "sdk-test-password" }),
    });
    assert.equal(setup.status, 201, await setup.text());
    const cookie = setup.headers.get("set-cookie")!;
    const response = await fetch(endpoint + "/api/v1/sdk-install", { headers: { cookie } });
    assert.equal(response.status, 200);
    const install = await response.json() as any;
    assert.deepEqual(install.packages.map((p: any) => p.id), ["go", "typescript", "python", "rust"]);
    assert(install.packages.every((p: any) => p.available));
    assert.equal(install.deferred,undefined);
    for (const pkg of install.packages) {
      const path = new URL(pkg.url).pathname;
      assert(path.startsWith("/base/downloads/sdk/"));
      const download = await fetch(endpoint + path.slice("/base".length));
      assert.equal(download.status, 200);
      assert.equal(await download.text(), pkg.id);
    }
    for (const language of ["php", "ruby"]) {
      const stale = await fetch(endpoint + `/downloads/sdk/lightmoni-${language}-sdk_0.1.0.tar.gz`);
      assert.equal(stale.status, 404, language);
      await stale.text();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
