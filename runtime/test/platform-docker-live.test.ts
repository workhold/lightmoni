import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeOperation, operationCommand } from "../src/agent/operations.js";
import { selfSignedCertificate } from "../src/ops/certificates.js";
import { probeHTTP } from "../src/operations/website-files.js";
import type {
  OperationPayload,
  OperationExecutionContext,
} from "../src/operations/types.js";

const live = process.env.LIGHTMONI_DOCKER_LIVE === "1";
async function setup(t: any) {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "lightmoni-platform-docker-")),
    ),
    dataDir = join(root, "agent"),
    instance = crypto.randomUUID().replaceAll("-", "");
  await mkdir(dataDir);
  const context: OperationExecutionContext = {
    dataDir,
    signal: new AbortController().signal,
    now: () => new Date(),
    command: operationCommand,
  };
  t.after(async () => {
    try {
      const ids = (
        await operationCommand("docker", [
          "ps",
          "-aq",
          "--filter",
          "label=io.lightmoni.platform.instance=" + instance,
        ])
      ).stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length)
        await operationCommand("docker", ["rm", "--force", ...ids]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  let revision = 0;
  const run = (config: any, operation = "apply") => {
    revision++;
    const payload: OperationPayload = {
      version: 1,
      operation_id: crypto.randomUUID().replaceAll("-", ""),
      operation,
      resource: {
        id: instance,
        kind: "platform",
        name: "Docker live validation",
        agent_id: "live",
        revision,
        config: { ...config, instance_id: instance },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      input: {},
    };
    return executeOperation(payload, context, async () => {});
  };
  return { root, dataDir, instance, context, run };
}
test(
  "real Docker single-container and Compose versions preserve initial and data files",
  { skip: !live, timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      application: any = {
        mode: "container",
        image: "alpine:3.23",
        command: ["sh", "-c", "while :; do sleep 30; done"],
        environment: { LITERAL: "$HOME literal" },
        mounts: [
          {
            type: "config",
            target: "/config",
            files: { "settings.json": '{"version":1}' },
          },
          { type: "init", target: "/initial", files: { value: "initial" } },
          { type: "data", target: "/data" },
        ],
      };
    let receipt = await f.run({ task: "workload.apply", application });
    assert.equal(receipt.state, "succeeded", JSON.stringify(receipt));
    let container = receipt.snapshot.operations.data.containers[0].id;
    assert.equal(
      (
        await operationCommand("docker", [
          "exec",
          container,
          "cat",
          "/config/settings.json",
        ])
      ).stdout,
      '{"version":1}',
    );
    assert.equal(
      (
        await operationCommand("docker", [
          "exec",
          container,
          "printenv",
          "LITERAL",
        ])
      ).stdout.trim(),
      "$HOME literal",
    );
    await operationCommand("docker", [
      "exec",
      container,
      "sh",
      "-c",
      "echo modified > /initial/value; echo durable > /data/value",
    ]);
    application.mounts[0].files["settings.json"] = '{"version":2}';
    application.mounts[1].files.value = "new-default";
    receipt = await f.run({ task: "workload.apply", application });
    assert.equal(receipt.state, "succeeded", JSON.stringify(receipt));
    container = receipt.snapshot.operations.data.containers[0].id;
    assert.equal(
      (
        await operationCommand("docker", [
          "exec",
          container,
          "cat",
          "/config/settings.json",
        ])
      ).stdout,
      '{"version":2}',
    );
    assert.equal(
      (
        await operationCommand("docker", [
          "exec",
          container,
          "cat",
          "/initial/value",
        ])
      ).stdout.trim(),
      "modified",
    );
    assert.equal(
      (
        await operationCommand("docker", [
          "exec",
          container,
          "cat",
          "/data/value",
        ])
      ).stdout.trim(),
      "durable",
    );
    const compose = {
      mode: "compose",
      compose:
        'services:\n  main:\n    image: alpine:3.23\n    command: ["sh", "-c", "while :; do sleep 30; done"]\n    environment:\n      LITERAL: "$HOME compose"\n',
      mounts: [
        { type: "config", target: "/config", files: { hello: "compose" } },
      ],
    };
    receipt = await f.run({ task: "workload.apply", application: compose });
    assert.equal(receipt.state, "succeeded", JSON.stringify(receipt));
    container = receipt.snapshot.operations.data.containers[0].id;
    assert.equal(
      (
        await operationCommand("docker", [
          "exec",
          container,
          "cat",
          "/config/hello",
        ])
      ).stdout,
      "compose",
    );
    assert.equal(
      (
        await operationCommand("docker", [
          "exec",
          container,
          "printenv",
          "LITERAL",
        ])
      ).stdout.trim(),
      "$HOME compose",
    );
    const inspected = await f.run({ task: "workload.inspect" }, "inspect");
    assert.equal(inspected.snapshot.operations.data.healthy, true);
    assert.ok(inspected.snapshot.operations.data.stats.length);
    assert.equal(
      (await f.run({ task: "workload.stop" }, "stop")).state,
      "succeeded",
    );
    assert.equal(
      (await f.run({ task: "workload.remove" }, "remove")).state,
      "succeeded",
    );
  },
);
test(
  "real host OpenResty serves static HTML and TLS, reloads a full bundle, and returns 503 for empty service discovery",
  {
    skip:
      !live || process.platform !== "linux"
        ? "requires an opted-in Linux executor sharing the Docker host network"
        : false,
    timeout: 180000,
  },
  async (t) => {
    const f = await setup(t),
      site = crypto.randomUUID().replaceAll("-", ""),
      material = await selfSignedCertificate(
        ["live.example.test"],
        3,
        new Date(),
      ),
      http_port = 23881,
      https_port = 23882,
      config: any = {
        task: "gateway.apply",
        image: "openresty/openresty:1.27.1.2-0-alpine",
        http_port,
        https_port,
        sites: [
          {
            id: site,
            domains: ["live.example.test"],
            mode: "static",
            static_files: { "index.html": "<h1>LightMoni real gateway</h1>" },
            certificate: { ...material, domains: ["live.example.test"] },
          },
        ],
      };
    let result = await f.run(config);
    assert.equal(result.state, "succeeded", JSON.stringify(result));
    assert.equal(result.snapshot.operations.data.network_mode, "host");
    assert.equal(
      (await probeHTTP(http_port, "live.example.test")).text,
      "<h1>LightMoni real gateway</h1>",
    );
    assert.equal(
      (await probeHTTP(https_port, "live.example.test", "/", true)).status,
      200,
    );
    config.sites[0].static_files["index.html"] = "<h1>Reloaded</h1>";
    result = await f.run(config);
    assert.equal(result.state, "succeeded", JSON.stringify(result));
    assert.equal(
      (await probeHTTP(http_port, "live.example.test")).text,
      "<h1>Reloaded</h1>",
    );
    config.sites[0] = {
      id: site,
      domains: ["live.example.test"],
      mode: "service",
      upstreams: [],
      unavailable: true,
      certificate: { ...material, domains: ["live.example.test"] },
    };
    result = await f.run(config);
    assert.equal(result.state, "succeeded", JSON.stringify(result));
    assert.equal((await probeHTTP(http_port, "live.example.test")).status, 503);
    assert.equal(
      (await f.run({ task: "gateway.stop" }, "stop")).state,
      "succeeded",
    );
  },
);

test(
  "real host OpenResty applies multi-path URI routing, CORS, headers, WebSocket and rejects a bad reload",
  { skip: !live || process.platform !== "linux", timeout: 180000 },
  async (t) => {
    const { createServer, request } = await import("node:http");
    const { createHash } = await import("node:crypto");
    let backendCount = 0;
    const backend = createServer(async (req, res) => {
      res.setHeader("X-Backend-Count", String(++backendCount));
      let body = "";
      for await (const chunk of req) body += chunk;
      res.setHeader("content-type", "application/json");
      res.setHeader("X-Upstream-Secret", "hidden");
      res.end(
        JSON.stringify({
          url: req.url,
          host: req.headers.host,
          request_id: req.headers["x-request-id"],
          body,
        }),
      );
    });
    const upgraded = new Set<any>();
    backend.on("upgrade", (req, socket) => {
      upgraded.add(socket);
      socket.once("close", () => upgraded.delete(socket));
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
          createHash("sha1")
            .update(
              String(req.headers["sec-websocket-key"]) +
                "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
            )
            .digest("base64") +
          "\r\n\r\n",
      );
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    t.after(async () => {
      for (const s of upgraded) s.destroy();
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    });
    const url = "http://127.0.0.1:" + (backend.address() as any).port,
      f = await setup(t),
      site = crypto.randomUUID().replaceAll("-", ""),
      http_port = 23891;
    const config: any = {
      task: "gateway.apply",
      http_port,
      https_port: 23892,
      sites: [
        {
          id: site,
          domains: ["paths.example.test"],
          mode: "proxy",
          nginx: {
            body_size_mb: 1,
            gzip: true,
            response_headers: { "X-Site": "site-value" },
            server_snippet: "client_body_timeout 15s;",
          },
          locations: [
            {
              path: "/api/",
              upstreams: [url],
              uri_mode: "strip_prefix",
              request_headers: { "X-Request-ID": "$request_id" },
              response_headers: { "X-Route": "api" },
              hide_headers: ["X-Upstream-Secret"],
              cors: {
                enabled: true,
                origin: "https://app.example.test",
                credentials: true,
              },
              buffering: false,
            },
            { path: "/raw/", upstreams: [url], host_header: "origin.internal" },
            {
              path: "/legacy/",
              upstreams: [url],
              uri_mode: "replace_prefix",
              uri_prefix: "/v2/",
            },
            {
              path: "/go",
              match: "exact",
              action: "return",
              return_status: 308,
              return_value: "https://example.test/new",
            },
            { path: "^/images/", match: "regex", upstreams: [url] },
            { path: "/ws", upstreams: [url], websocket: true },
            { path: "/private", upstreams: [url], deny: ["all"] },
            {
              path: "/cached/",
              upstreams: [url],
              cache: { enabled: true, ttl_seconds: 60, max_size_mb: 10 },
            },
            {
              path: "/limited/",
              upstreams: [url],
              requests_per_second: 1,
              connections: 10,
            },
          ],
        },
      ],
    };
    const get = (path: string, options: any = {}): Promise<Response> =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: http_port,
            path,
            method: options.method ?? "GET",
            headers: { Host: "paths.example.test", ...options.headers },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () =>
              resolve(
                new Response(
                  res.statusCode === 204 ? null : Buffer.concat(chunks),
                  {
                    status: res.statusCode,
                    headers: Object.fromEntries(
                      Object.entries(res.headers)
                        .filter(([, v]) => v !== undefined)
                        .map(([k, v]) => [
                          k,
                          Array.isArray(v) ? v.join(", ") : String(v),
                        ]),
                    ),
                  },
                ),
              ),
            );
          },
        );
        req.once("error", reject);
        req.end(options.body);
      });
    let receipt = await f.run(config);
    assert.equal(receipt.state, "succeeded", JSON.stringify(receipt));
    let response = await get("/api/items?x=1");
    assert.equal(response.status, 200);
    const data: any = await response.json();
    assert.equal(data.url, "/items?x=1");
    assert.match(data.request_id, /^[a-f0-9]{32}$/);
    assert.equal(response.headers.get("x-site"), "site-value");
    assert.equal(response.headers.get("x-route"), "api");
    assert.equal(response.headers.get("x-upstream-secret"), null);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "https://app.example.test",
    );
    response = await get("/raw/items");
    assert.deepEqual(await response.json(), {
      url: "/raw/items",
      host: "origin.internal",
      body: "",
    });
    assert.equal(
      ((await (await get("/legacy/items?x=2")).json()) as any).url,
      "/v2/items?x=2",
    );
    assert.equal(
      ((await (await get("/images/a.png")).json()) as any).url,
      "/images/a.png",
    );
    response = await get("/api/items", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.test" },
    });
    assert.equal(response.status, 204);
    assert.equal(
      response.headers.get("access-control-allow-credentials"),
      "true",
    );
    response = await get("/go");
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "https://example.test/new");
    assert.equal((await get("/unmatched")).status, 404);
    assert.equal((await get("/private")).status, 403);
    assert.equal(
      (
        await get("/api/upload", {
          method: "POST",
          body: "x".repeat(1024 * 1024 + 1),
        })
      ).status,
      413,
    );
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: http_port,
          path: "/ws",
          headers: {
            Host: "paths.example.test",
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": Buffer.alloc(16).toString("base64"),
            "Sec-WebSocket-Version": "13",
          },
        },
        (res) => reject(Error("upgrade returned " + res.statusCode)),
      );
      req.once("upgrade", (res, socket) => {
        assert.equal(res.statusCode, 101);
        socket.destroy();
        resolve();
      });
      req.once("error", reject);
      req.setTimeout(5000, () => req.destroy(Error("upgrade timeout")));
      req.end();
    });
    response = await get("/cached/item");
    assert.equal(response.headers.get("x-lightmoni-cache"), "MISS");
    const cachedCount = response.headers.get("x-backend-count");
    response = await get("/cached/item");
    assert.equal(response.headers.get("x-lightmoni-cache"), "HIT");
    assert.equal(response.headers.get("x-backend-count"), cachedCount);
    for (const headers of [
      { Authorization: "Bearer private-user-token" },
      { Cookie: "session=private-session" },
    ]) {
      response = await get("/cached/item", { headers });
      assert.equal(response.headers.get("x-lightmoni-cache"), "BYPASS");
      assert.notEqual(response.headers.get("x-backend-count"), cachedCount);
    }
    const limited = await Promise.all([
      get("/limited/a"),
      get("/limited/b"),
      get("/limited/c"),
    ]);
    assert.ok(limited.some((r) => r.status === 429));
    config.sites[0].nginx.server_snippet = "unknown_lightmoni_directive on;";
    receipt = await f.run(config);
    assert.equal(receipt.state, "failed");
    assert.equal(
      ((await (await get("/api/still-active")).json()) as any).url,
      "/still-active",
    );
    assert.equal(
      (await f.run({ task: "gateway.stop" }, "stop")).state,
      "succeeded",
    );
  },
);
