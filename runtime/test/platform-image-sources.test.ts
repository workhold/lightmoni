import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  imageSourceRules,
  imageSourceReference,
  preparePlatformImages,
} from "../src/operations/image-sources.js";
import { executePlatform } from "../src/operations/platform.js";
import { commandDiagnostic } from "../src/operations/install-progress.js";
const id = "sha256:" + "a".repeat(64),
  digest = "sha256:" + "b".repeat(64);
const rules = imageSourceRules([
  {
    source: "docker.io",
    target: "https://mirror.example.test/docker.io",
    allow_upstream: false,
  },
  {
    source: "ghcr.io",
    target: "https://mirror.example.test/ghcr.io",
    allow_upstream: true,
  },
]);
const policy = { version: 1, revision: 1, rules };
test("source proxies match complete canonical registries, preserve tags/digests, and reject unsafe configurations", () => {
  assert.equal(
    imageSourceReference("alpine:3.23", rules)?.mapped,
    "mirror.example.test/docker.io/library/alpine:3.23",
  );
  assert.equal(
    imageSourceReference("index.docker.io/openresty/openresty:v1", rules)
      ?.mapped,
    "mirror.example.test/docker.io/openresty/openresty:v1",
  );
  assert.equal(
    imageSourceReference("ghcr.io/team/app:tag@" + digest, rules)?.mapped,
    "mirror.example.test/ghcr.io/team/app@" + digest,
  );
  assert.equal(
    imageSourceReference("evilghcr.io/team/app:v1", rules),
    undefined,
  );
  assert.equal(imageSourceReference(id, rules), undefined);
  const port = imageSourceRules([
    {
      source: "private.test:5443",
      target: "https://proxy.test:5444/prefix",
      allow_upstream: false,
    },
  ]);
  assert.equal(
    imageSourceReference("private.test:5443/a_b/app:1", port)?.mapped,
    "proxy.test:5444/prefix/a_b/app:1",
  );
  assert.equal(imageSourceReference("private.test/a_b/app:1", port), undefined);
  for (const target of [
    "http://proxy.test",
    "https://user:secret@proxy.test",
    "https://proxy.test/?x=1",
    "https://proxy.test/#f",
    "https://proxy.test/a/../b",
    "https://proxy.test/a\\b",
    "https://docker.io",
  ])
    assert.throws(
      () =>
        imageSourceRules([
          { source: "docker.io", target, allow_upstream: false },
        ]),
      undefined,
      target,
    );
  assert.throws(() =>
    imageSourceRules([rules[0], { ...rules[0], source: "index.docker.io" }]),
  );
  assert.throws(() =>
    imageSourceRules([{ ...rules[0], source: "docker.io/evil" }]),
  );
});
test("proxy preparation uses fixed verified IDs, honors platform/digest, and never retags or forwards credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lm-proxy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[][] = [];
  let pulled = false,
    wrong = false;
  const context: any = {
    signal: new AbortController().signal,
    command: async (file: string, args: string[]) => {
      assert.equal(file, "docker");
      calls.push(args);
      if (args[0] === "info") return { stdout: "linux/amd64", stderr: "" };
      if (args[1] === "pull") {
        pulled = true;
        return { stdout: "", stderr: "" };
      }
      if (args[1] === "inspect" && pulled && args.at(-1)?.startsWith("mirror."))
        return {
          stdout: JSON.stringify({
            Id: id,
            Os: "linux",
            Architecture: wrong ? "arm64" : "amd64",
            RepoDigests: [
              "mirror.example.test/docker.io/library/alpine@" + digest,
            ],
          }),
          stderr: "",
        };
      throw Error("No such image");
    },
  };
  const manifest = {
    services: {
      a: { image: "alpine@" + digest },
      b: { image: "unmapped.test/app:1" },
    },
  };
  const result = await preparePlatformImages(
    manifest,
    { image_sources: policy },
    root,
    context,
  );
  assert.equal(manifest.services.a.image, id);
  assert.equal((manifest.services.a as any).pull_policy, "never");
  assert.equal(manifest.services.b.image, "unmapped.test/app:1");
  assert.equal(result[0].source, "registry-proxy");
  assert(calls.some((a) => a[1] === "pull" && a[2].endsWith("@" + digest)));
  assert(!calls.some((a) => a.includes("tag") || a.includes("login")));
  wrong = true;
  pulled = false;
  await assert.rejects(
    preparePlatformImages(
      { services: { a: { image: "alpine@" + digest } } },
      { image_sources: policy },
      root,
      context,
    ),
    /IMAGE_PROXY_FAILED/,
  );
});
test("origin fallback is explicit, local reuse precedes proxy and strict cache cannot be bypassed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lm-proxy-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let local = false,
    pulls = 0;
  const context: any = {
    signal: new AbortController().signal,
    command: async (_: string, args: string[]) => {
      if (args[0] === "info") return { stdout: "linux/amd64", stderr: "" };
      if (args[1] === "inspect" && local && args.at(-1) === "alpine:3.23")
        return {
          stdout: JSON.stringify({
            Id: id,
            Os: "linux",
            Architecture: "amd64",
          }),
          stderr: "",
        };
      if (args[1] === "pull") {
        pulls++;
        throw Object.assign(Error("network"), {
          diagnosticCode: "image_network_failed",
        });
      }
      throw Error("No such image");
    },
  };
  await assert.rejects(
    preparePlatformImages(
      { services: { a: { image: "alpine:3.23" } } },
      { image_sources: policy },
      root,
      context,
    ),
    /IMAGE_PROXY_FAILED/,
  );
  const fallback = { services: { a: { image: "ghcr.io/team/app:v1" } } };
  const result = await preparePlatformImages(
    fallback,
    { image_sources: policy },
    root,
    context,
  );
  assert.equal(result[0].source, "upstream-fallback");
  assert.equal(fallback.services.a.image, "ghcr.io/team/app:v1");
  local = true;
  const manifest = { services: { a: { image: "alpine:3.23" } } };
  await preparePlatformImages(
    manifest,
    { image_sources: policy },
    root,
    context,
  );
  assert.equal(manifest.services.a.image, id);
  assert.equal(pulls, 2);
  local = false;
  await assert.rejects(
    preparePlatformImages(
      { services: { a: { image: "alpine:3.23" } } },
      {
        image_sources: policy,
        image_cache: {
          version: 1,
          allow_upstream: false,
          hub_endpoint: "http://127.0.0.1:1",
        },
      },
      root,
      context,
    ),
  );
  assert.equal(pulls, 2);
});
test("recovery inspection is read only, checks stopped containers and all ownership selectors, and rejects invalid inventory", async () => {
  const instance = "a".repeat(32),
    calls: string[][] = [];
  let mode = "empty";
  const payload: any = {
    resource: {
      config: { task: "instance.recovery.inspect", instance_id: instance },
    },
  };
  const context: any = {
    signal: new AbortController().signal,
    now: () => new Date(),
    command: async (_: string, args: string[]) => {
      calls.push(args);
      return {
        stdout:
          mode === "empty"
            ? ""
            : mode === "stopped"
              ? "f".repeat(64)
              : "invalid",
        stderr: "",
      };
    },
  };
  assert.equal((await executePlatform(payload, context)).data.absent, true);
  assert.equal(calls.length, 3);
  assert(calls.every((args) => args[0] === "ps" && args[1] === "-aq"));
  mode = "stopped";
  assert.equal(
    (await executePlatform(payload, context)).data.container_count,
    1,
  );
  mode = "bad";
  await assert.rejects(
    executePlatform(payload, context),
    /INVALID_DOCKER_INVENTORY/,
  );
});
test("Docker Hub header timeout produces a useful safe diagnostic", () => {
  assert.equal(
    commandDiagnostic(
      'Get "https://registry-1.docker.io/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)',
      true,
    ),
    "image_network_failed",
  );
});
