import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  cacheReference,
  cachePolicy,
  importCachedImage,
  prepareCachedImages,
} from "../src/operations/image-cache.js";
test("cache references explicitly map Hub and selected publishing host; unknown registries keep their path", () => {
  const policy = {
    version: 1,
    allow_upstream: true,
    origin_host: "registry.example.test",
    hub_endpoint: "http://10.1.0.1:5001",
    origin_endpoint: "http://10.1.0.2:5002",
  };
  assert.deepEqual(cacheReference("alpine:3.23", policy), {
    endpoint: policy.hub_endpoint,
    repository: "library/alpine",
    reference: "3.23",
  });
  assert.equal(
    cacheReference("registry.example.test/team/app:v2", policy)?.repository,
    "team/app",
  );
  assert.equal(
    cacheReference("unrelated.example.test/team/app:v2", policy),
    undefined,
  );
  for (const endpoint of [
    "http://8.8.8.8:80",
    "http://169.254.169.254:80",
    "http://name.internal:5000",
    "http://10.0.0.1:5000/path",
    "http://user:secret@10.0.0.1:5000",
  ])
    assert.throws(() => cachePolicy({ ...policy, hub_endpoint: endpoint }));
});
test("cache import verifies content addresses, rejects redirects/corruption and cleans temporary data on every failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lm-cache-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = Buffer.from(
      JSON.stringify({
        os: "linux",
        architecture: "amd64",
        rootfs: { type: "layers", diff_ids: [] },
      }),
    ),
    digest = "sha256:" + createHash("sha256").update(config).digest("hex");
  const manifest = { schemaVersion: 2, config: { digest }, layers: [] };
  let mode = "ok";
  const server = createServer((req, res) => {
    if (mode === "redirect") {
      res.writeHead(302, { Location: "http://169.254.169.254/" });
      res.end();
      return;
    }
    res.end(
      req.url?.includes("/manifests/")
        ? JSON.stringify(manifest)
        : mode === "corrupt"
          ? "wrong"
          : config,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const policy = {
    version: 1,
    allow_upstream: false,
    origin_host: "registry.example.test",
    origin_endpoint: "http://127.0.0.1:" + (server.address() as any).port,
  };
  const commands: string[][] = [],
    context: any = {
      signal: new AbortController().signal,
      command: async (_: string, args: string[]) => {
        commands.push(args);
        return {
          stdout:
            args[0] === "info"
              ? "linux/amd64"
              : args[1] === "inspect"
                ? JSON.stringify({
                    Id: digest,
                    Os: "linux",
                    Architecture: "amd64",
                    RootFS: { Layers: [] },
                  })
                : "",
          stderr: "",
        };
      },
    };
  const imported = await importCachedImage(
    "registry.example.test/test:v1",
    policy,
    root,
    context,
  );
  assert.equal(imported?.image_id, digest);
  assert(commands.some((a) => a[1] === "load"));
  assert.deepEqual(await readdir(root), []);
  mode = "corrupt";
  await assert.rejects(
    importCachedImage("registry.example.test/test:v1", policy, root, context),
    /CACHE_DIGEST_MISMATCH/,
  );
  assert.deepEqual(await readdir(root), []);
  mode = "redirect";
  await assert.rejects(
    importCachedImage("registry.example.test/test:v1", policy, root, context),
  );
  assert.deepEqual(await readdir(root), []);
  const services = { app: { image: "registry.example.test/test:v1" } };
  const result = await prepareCachedImages(
    { services },
    { ...policy, allow_upstream: true },
    root,
    context,
  );
  assert.equal(result[0].source, "upstream-fallback");
  assert.equal(services.app.image, "registry.example.test/test:v1");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    importCachedImage("registry.example.test/test:v1", policy, root, {
      ...context,
      signal: aborted.signal,
    }),
  );
  assert.deepEqual(await readdir(root), []);
});
