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
