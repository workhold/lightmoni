/** Opt-in acceptance inside a disposable Linux Docker engine. */
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { executePlatform } from "../runtime/dist/operations/platform.js";
import { preparePlatformImages } from "../runtime/dist/operations/image-sources.js";
if (
  process.env.LIGHTMONI_IMAGE_SOURCES_LIVE !== "1" ||
  process.platform !== "linux"
)
  throw Error("Explicit disposable Linux Docker engine required");
const output = resolve(
  process.env.LIGHTMONI_IMAGE_SOURCES_OUTPUT ??
    "specs/075-agent-reinstall-image-sources/evidence",
);
const root = resolve(
  ".local-dev/image-sources-live-" + randomBytes(6).toString("hex"),
);
await mkdir(root, { recursive: true });
const instance = randomBytes(16).toString("hex"),
  commands = [],
  checks = [];
const command = async (file, args, options = {}) => {
  commands.push({ file, args });
  const child = promisify(execFile)(file, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 30000,
    signal: options.signal,
    maxBuffer: 1048576,
  });
  if (options.stdin !== undefined) child.child.stdin.end(options.stdin);
  return child;
};
const context = {
  dataDir: root,
  now: () => new Date(),
  signal: new AbortController().signal,
  command,
};
const image =
  "openresty/openresty@sha256:acbf6c163eef0312e624dc8c24edc7e2f1d33bca77a9e4793714d8e4affab5c5";
const policy = {
  version: 1,
  revision: 1,
  rules: [
    {
      source: "docker.io",
      target: "https://m.daocloud.io/docker.io",
      allow_upstream: false,
    },
  ],
};
const payload = (config) => ({
  version: 1,
  operation_id: randomBytes(16).toString("hex"),
  operation: config.task.split(".").at(-1),
  resource: {
    id: instance,
    kind: "platform",
    agent_id: "qa",
    revision: 1,
    config: { instance_id: instance, ...config },
  },
  input: {},
});
try {
  const manifest = { services: { gateway: { image } } };
  const sources = await preparePlatformImages(
    manifest,
    { image_sources: policy },
    root,
    context,
  );
  const imageID = manifest.services.gateway.image;
  assert.match(imageID, /^sha256:[a-f0-9]{64}$/);
  assert.equal(sources[0].source, "registry-proxy");
  assert(
    commands.some(
      (c) =>
        c.args[1] === "pull" &&
        c.args[2].startsWith("m.daocloud.io/docker.io/"),
    ),
  );
  checks.push(
    "isolated engine pulled pinned official OpenResty through the configured proxy",
  );
  const applied = await executePlatform(
    payload({
      task: "gateway.apply",
      image,
      http_port: 24080,
      https_port: 24081,
      sites: [],
      image_sources: policy,
    }),
    context,
  );
  assert.equal(applied.verified, true);
  assert.equal(applied.data.running, true);
  const info = JSON.parse(
    (await command("docker", ["inspect", "lm-gateway-" + instance])).stdout,
  )[0];
  assert.equal(info.Image, imageID);
  assert.equal(info.Config.Image, imageID);
  const starts = commands.filter((c) => c.args[0] === "run");
  assert(starts.length >= 2);
  assert(
    starts.every((c) => c.args.includes(imageID) && c.args.includes("never")),
  );
  checks.push(
    "OpenResty nginx preflight and live startup used the same verified image ID, with pulling disabled",
  );
  const present = await executePlatform(
    payload({ task: "instance.recovery.inspect" }),
    context,
  );
  assert.equal(present.data.absent, false);
  assert.equal(present.data.container_count, 1);
  checks.push("read-only recovery found the running gateway");
  await executePlatform(payload({ task: "gateway.stop" }), context);
  const stopped = await executePlatform(
    payload({ task: "instance.recovery.inspect" }),
    context,
  );
  assert.equal(stopped.data.absent, false);
  checks.push("stopped containers still prevent automatic cleanup");
  await executePlatform(payload({ task: "gateway.remove" }), context);
  const absent = await executePlatform(
    payload({ task: "instance.recovery.inspect" }),
    context,
  );
  assert.equal(absent.data.absent, true);
  checks.push(
    "read-only recovery confirmed zero containers after explicit removal",
  );
  const reuse = { services: { gateway: { image } } };
  const before = commands.length;
  await preparePlatformImages(reuse, { image_sources: policy }, root, context);
  assert.equal(reuse.services.gateway.image, imageID);
  assert(!commands.slice(before).some((c) => c.args[1] === "pull"));
  checks.push("verified proxy image reused without another network pull");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "docker.json"),
    JSON.stringify(
      {
        checks,
        image,
        proxy: policy.rules[0].target,
        image_id: imageID,
        platform: (
          await command("docker", [
            "info",
            "--format",
            "{{.OSType}}/{{.Architecture}}",
          ])
        ).stdout.trim(),
        scope:
          "disposable Docker-in-Docker engine; no production host modified",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks: checks.length, output }));
} finally {
  await command("docker", ["rm", "--force", "lm-gateway-" + instance]).catch(
    () => {},
  );
  await rm(root, { recursive: true, force: true });
}
