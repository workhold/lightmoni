/** Opt-in real Docker/Registry/OpenResty acceptance. Run inside a Linux QA executor
 * sharing the Docker host network and an identically mounted checkout path. */
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  operationCommand,
  executeOperation,
} from "../runtime/dist/agent/operations.js";
import { importCachedImage } from "../runtime/dist/operations/image-cache.js";
import { normalizeWebsiteAuth } from "../runtime/dist/ops/website-auth.js";
import { selfSignedCertificate } from "../runtime/dist/ops/certificates.js";
import { probeHTTP } from "../runtime/dist/operations/website-files.js";
if (process.env.LIGHTMONI_REGISTRY_LIVE !== "1" || process.platform !== "linux")
  throw Error("Explicit Linux Docker QA executor required");
const root = resolve(
    ".local-dev/registry-live-" + randomBytes(6).toString("hex"),
  ),
  id = randomBytes(16).toString("hex"),
  names = [],
  tags = [],
  checks = [];
await mkdir(root, { recursive: true });
await mkdir(join(root, "agent"));
const controller = new AbortController();
const qaCommand = async (file, args, options = {}) => {
  try {
    const pending = promisify(execFile)(file, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 30000,
      signal: options.signal,
      maxBuffer: 1048576,
    });
    if (options.stdin !== undefined) pending.child.stdin.end(options.stdin);
    return await pending;
  } catch (e) {
    throw Error(
      "QA_COMMAND_FAILED " +
        args.slice(0, 2).join(" ") +
        ": " +
        String(e.stderr ?? e.message).slice(0, 2000),
    );
  }
};
const context = {
  dataDir: join(root, "agent"),
  signal: controller.signal,
  now: () => new Date(),
  command: qaCommand,
};
const docker = async (args) => qaCommand("docker", args, { timeoutMs: 120000 });
const base = 24060,
  http = 24070,
  tls = 24071;
let revision = 0,
  backend;
const run = async (config) =>
  executeOperation(
    {
      version: 1,
      operation_id: randomBytes(16).toString("hex"),
      operation: "apply",
      resource: {
        id,
        kind: "platform",
        name: "Isolated Registry acceptance",
        agent_id: "qa",
        revision: ++revision,
        config: { instance_id: id, ...config },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      input: {},
    },
    context,
    async () => {},
  );
const wait = async (url) => {
  for (let n = 0; n < 60; n++) {
    try {
      if ((await fetch(url)).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Registry did not become ready");
};
async function registry(name, port, remote) {
  names.push(name);
  await docker([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    "host",
    "--env",
    "REGISTRY_HTTP_ADDR=127.0.0.1:" + port,
    "--env",
    "REGISTRY_HTTP_DEBUG_ADDR=127.0.0.1:0",
    "--env",
    "REGISTRY_HTTP_RELATIVEURLS=true",
    ...(remote ? ["--env", "REGISTRY_PROXY_REMOTEURL=" + remote] : []),
    "registry:3.0.0",
  ]);
  await wait("http://127.0.0.1:" + port + "/v2/");
}
const report = {
  scope:
    "One isolated Linux QA executor on a shared Docker host; not a production multi-region failover certification",
  checks,
};
try {
  const source = "lm-059-source-" + id,
    cache = "lm-059-cache-" + id;
  await registry(source, base);
  const repository = "qa/image-" + id;
  const tag = "127.0.0.1:" + base + "/" + repository + ":one";
  tags.push(tag);
  await docker(["tag", "alpine:3.23", tag]);
  await docker(["push", tag]);
  checks.push(
    "Real Registry v3 accepts a Docker push over its isolated internal endpoint",
  );
  const direct = await importCachedImage(
    "registry.example.test/" + repository + ":one",
    {
      version: 1,
      allow_upstream: false,
      origin_host: "registry.example.test",
      origin_endpoint: "http://127.0.0.1:" + base,
      origin_mode: "direct",
    },
    root,
    context,
  );
  assert.equal(direct.source, "cluster-registry");
  checks.push(
    "The publishing cluster imports its own private image directly without enabling a proxy cache or Docker login",
  );
  await registry(cache, base + 1, "http://127.0.0.1:" + base);
  const policy = {
    version: 1,
    allow_upstream: false,
    origin_host: "registry.example.test",
    origin_endpoint: "http://127.0.0.1:" + (base + 1),
  };
  const first = await importCachedImage(
    "registry.example.test/" + repository + ":one",
    policy,
    root,
    context,
  );
  assert.match(first.image_id, /^sha256:/);
  checks.push(
    "Agent imports a real cached image after manifest/config/blob/diff-id verification",
  );
  await docker(["stop", source]);
  const offline = await importCachedImage(
    "registry.example.test/" + repository + "@" + first.manifest_digest,
    policy,
    root,
    context,
  );
  assert.equal(offline.image_id, first.image_id);
  checks.push(
    "A cached digest remains readable after the upstream registry stops",
  );
  const receipt = await run({
    task: "workload.apply",
    image_cache: policy,
    application: {
      mode: "container",
      image:
        "registry.example.test/" + repository + "@" + first.manifest_digest,
      command: ["sh", "-c", "while :; do sleep 30; done"],
      mounts: [],
    },
  });
  assert.equal(receipt.state, "succeeded", JSON.stringify(receipt));
  assert.equal(
    receipt.snapshot.operations.data.image_sources[0].source,
    "cluster-cache",
  );
  checks.push(
    "Real workload executor starts Compose from the verified image ID without a daemon mirror change",
  );
  const workloadIDs = (
    await docker([
      "ps",
      "-aq",
      "--filter",
      "label=io.lightmoni.platform.instance=" + id,
    ])
  ).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (workloadIDs.length) await docker(["rm", "--force", ...workloadIDs]);
  let forwarded = "unset";
  backend = createServer((req, res) => {
    forwarded = req.headers.authorization;
    res.writeHead(200);
    res.end("protected upstream");
  });
  backend.listen(base + 2, "127.0.0.1");
  await once(backend, "listening");
  const secret = randomBytes(16).toString("hex"),
    auth = normalizeWebsiteAuth(
      { mode: "basic", users: [{ username: "publisher", password: secret }] },
      undefined,
    ),
    material = await selfSignedCertificate(
      ["registry.example.test"],
      2,
      new Date(),
    );
  const gateway = {
    task: "gateway.apply",
    image: "openresty/openresty:1.27.1.2-0-alpine",
    http_port: http,
    https_port: tls,
    sites: [
      {
        id: "a".repeat(32),
        domains: ["registry.example.test"],
        mode: "proxy",
        auth,
        certificate: material,
        locations: [
          { path: "/", upstreams: ["http://127.0.0.1:" + (base + 2)] },
          {
            path: "/public",
            match: "exact",
            auth: { mode: "off" },
            action: "return",
            return_status: 200,
            return_value: "public",
          },
        ],
      },
    ],
  };
  if (process.env.LIGHTMONI_REGISTRY_CLIENT_TLS === "1") {
    const localMaterial = await selfSignedCertificate(
      ["localhost"],
      2,
      new Date(),
    );
    const caDir = "/etc/docker/certs.d/localhost:" + tls;
    await mkdir(caDir, { recursive: true });
    await writeFile(join(caDir, "ca.crt"), localMaterial.certificate_pem, {
      mode: 0o600,
    });
    await docker(["start", source]);
    await wait("http://127.0.0.1:" + base + "/v2/");
    gateway.sites.push({
      id: "b".repeat(32),
      domains: ["localhost"],
      mode: "proxy",
      auth,
      certificate: localMaterial,
      nginx: { body_size_mb: 0 },
      locations: [
        {
          path: "/",
          upstreams: ["http://127.0.0.1:" + base],
          request_buffering: false,
          buffering: false,
          websocket: false,
          body_size_mb: 0,
        },
      ],
    });
  }
  const active = await run(gateway);
  assert.equal(active.state, "succeeded", JSON.stringify(active));
  assert.equal(
    (await probeHTTP(tls, "registry.example.test", "/", true)).status,
    401,
  );
  assert.equal(
    (
      await probeHTTP(tls, "registry.example.test", "/", true, undefined, {
        Authorization:
          "Basic " + Buffer.from("publisher:wrong").toString("base64"),
      })
    ).status,
    401,
  );
  const good = await probeHTTP(
    tls,
    "registry.example.test",
    "/",
    true,
    undefined,
    {
      Authorization:
        "Basic " + Buffer.from("publisher:" + secret).toString("base64"),
    },
  );
  assert.equal(good.status, 200);
  assert.equal(good.text, "protected upstream");
  assert.equal(forwarded, undefined);
  assert.equal(
    (await probeHTTP(tls, "registry.example.test", "/public", true)).text,
    "public",
  );
  checks.push(
    "Real OpenResty TLS: anonymous/wrong password 401, correct password 200, path opt-out works, upstream Authorization stripped; deployment includes positive/negative proof",
  );
  assert(!(await readdir(root)).some((n) => n.startsWith("image-cache-")));
  checks.push(
    "Bounded image import removes its temporary download/archive directories",
  );
  if (process.env.LIGHTMONI_REGISTRY_CLIENT_TLS === "1") {
    const client = join(root, "docker-client");
    await mkdir(client, { mode: 0o700 });
    const args = [
      "--config",
      client,
      "login",
      "localhost:" + tls,
      "--username",
      "publisher",
      "--password-stdin",
    ];
    await assert.rejects(
      qaCommand("docker", args, {
        stdin: "incorrect-password\n",
        timeoutMs: 30000,
      }),
    );
    await qaCommand("docker", args, { stdin: secret + "\n", timeoutMs: 30000 });
    const publishRepository = "qa/through-nginx-" + id;
    const publishTag = "localhost:" + tls + "/" + publishRepository + ":one";
    tags.push(publishTag);
    await docker(["tag", "alpine:3.23", publishTag]);
    await qaCommand("docker", ["--config", client, "push", publishTag], {
      timeoutMs: 120000,
    });
    const pushed = await fetch(
      "http://127.0.0.1:" +
        base +
        "/v2/" +
        publishRepository +
        "/manifests/one",
      {
        headers: {
          Accept:
            "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
        },
      },
    );
    assert.equal(pushed.status, 200);
    assert.equal((await probeHTTP(http, "localhost", "/v2/")).status, 308);
    checks.push(
      "Dedicated Docker daemon trusts only the QA CA: wrong login denied; correct TLS login and Docker push through OpenResty succeed; HTTP redirects to HTTPS",
    );
    report.scope =
      "Dedicated isolated Docker 27 daemon plus Linux executor, no production socket or public network; separate shared-host run covers Docker 29 containerd image ID compatibility";
  }
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = error.message;
  throw error;
} finally {
  backend?.closeAllConnections();
  backend?.close();
  for (const name of [...names, "lm-gateway-" + id])
    await docker(["rm", "--force", name]).catch(() => {});
  const ids = (
    await docker([
      "ps",
      "-aq",
      "--filter",
      "label=io.lightmoni.platform.instance=" + id,
    ])
  ).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length) await docker(["rm", "--force", ...ids]).catch(() => {});
  for (const tag of tags) await docker(["image", "rm", tag]).catch(() => {});
  const out = resolve("specs/059-service-image-lifecycle/evidence");
  await mkdir(out, { recursive: true });
  await writeFile(
    join(
      out,
      process.env.LIGHTMONI_REGISTRY_CLIENT_TLS === "1"
        ? "docker-live-isolated.json"
        : "docker-live.json",
    ),
    JSON.stringify(report, null, 2),
  );
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
