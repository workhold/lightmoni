import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  symlink,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeOperation, operationCommand } from "../src/agent/operations.js";
import { normalizeApplication } from "../src/operations/platform.js";
import { selfSignedCertificate } from "../src/ops/certificates.js";
import { certificateMetadata } from "../src/operations/certificates.js";
import type {
  OperationPayload,
  OperationExecutionContext,
} from "../src/operations/types.js";
const resourceID = "a".repeat(32);
async function setup(t: any) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lightmoni-platform-executor-")),
  );
  const dataDir = join(root, "agent");
  await mkdir(dataDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    dataDir,
    context: {
      dataDir,
      signal: new AbortController().signal,
      now: () => new Date(),
      command: operationCommand,
    } as OperationExecutionContext,
  };
}
const payload = (config: any, operation = "apply"): OperationPayload => ({
  version: 1,
  operation_id: crypto.randomUUID().replaceAll("-", ""),
  operation,
  resource: {
    id: resourceID,
    kind: "platform",
    name: "test",
    agent_id: "node-a",
    revision: 1,
    config,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  input: {},
});
test("application validation accepts host mounts and Compose but rejects ambient file dependencies and traversal", () => {
  const app = normalizeApplication({
    mode: "container",
    image: "nginx:1.30.6-alpine",
    mounts: [
      { type: "data", source: "/srv/data", target: "/data" },
      { type: "config", target: "/etc/app", files: { "a/config.json": "{}" } },
    ],
  });
  assert.equal(app.mounts.length, 2);
  assert.throws(
    () =>
      normalizeApplication({
        mode: "compose",
        compose:
          "services:\n  app:\n    image: nginx:1.30.6-alpine\n    env_file: /etc/private",
      }),
    /MANAGED_FILES/,
  );
  assert.throws(
    () =>
      normalizeApplication({
        mode: "container",
        image: "nginx:1",
        mounts: [
          { type: "config", target: "/etc/app", files: { "../secret": "x" } },
        ],
      }),
    /FILE_PATH/,
  );
  assert.throws(
    () =>
      normalizeApplication({
        mode: "container",
        image: "nginx:1",
        network_mode: "host",
        ports: [{ host_port: 80, container_port: 80 }],
      }),
    /PORT_MAPPING/,
  );
});
test("certificate directory publishes a matching atomic pair and refuses unrelated files or immutable version replacement", async (t) => {
  const f = await setup(t),
    material = await selfSignedCertificate(["example.com"], 7, new Date()),
    meta = certificateMetadata(
      material.certificate_pem,
      material.private_key_pem,
      ["example.com"],
    ),
    path = join(f.root, "certs"),
    config = {
      task: "certificate.install",
      certificate_id: resourceID,
      certificate_version: "v1",
      path,
      domains: ["example.com"],
      fingerprint_sha256: meta.fingerprint_sha256,
      ...material,
    };
  const result = await executeOperation(
    payload(config, "install"),
    f.context,
    async () => {},
  );
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.equal(
    await readFile(join(path, "fullchain.pem"), "utf8"),
    material.certificate_pem,
  );
  assert.equal((await lstat(join(path, "privkey.pem"))).isSymbolicLink(), true);
  assert.equal(
    JSON.stringify(result).includes(material.private_key_pem),
    false,
  );
  const other = await selfSignedCertificate(["example.com"], 7, new Date());
  const rejected = await executeOperation(
    payload({ ...config, ...other, fingerprint_sha256: undefined }, "install"),
    f.context,
    async () => {},
  );
  assert.equal(rejected.state, "failed");
  assert.equal(
    await readFile(join(path, "privkey.pem"), "utf8"),
    material.private_key_pem,
  );
  const unrelated = join(f.root, "unrelated");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "fullchain.pem"), "user-owned");
  const conflict = await executeOperation(
    payload({ ...config, path: unrelated }, "install"),
    f.context,
    async () => {},
  );
  assert.equal(conflict.state, "failed");
  assert.equal(
    await readFile(join(unrelated, "fullchain.pem"), "utf8"),
    "user-owned",
  );
});
test("certificate hook runs a real script with explicit environment and file context without returning output or process secrets", async (t) => {
  const f = await setup(t),
    material = await selfSignedCertificate(["example.com"], 7, new Date()),
    output = join(f.root, "proof");
  process.env.LIGHTMONI_TEST_AMBIENT_SECRET = "ambient-private-value";
  t.after(() => delete process.env.LIGHTMONI_TEST_AMBIENT_SECRET);
  const config = {
    task: "hook.run",
    hook_id: resourceID,
    certificate_id: resourceID,
    certificate_version: "v7",
    interpreter: "/bin/sh",
    timeout_ms: 5000,
    env: { OUTPUT: output, EXPLICIT: "requested" },
    script:
      'test -s "$LIGHTMONI_CERTIFICATE_PATH"\ntest -s "$LIGHTMONI_PRIVATE_KEY_PATH"\nprintf "%s:%s:%s" "$EXPLICIT" "$LIGHTMONI_CERTIFICATE_VERSION" "$LIGHTMONI_TEST_AMBIENT_SECRET" > "$OUTPUT"\necho should-not-be-returned',
    certificate: { ...material, domains: ["example.com"] },
  };
  const result = await executeOperation(
    payload(config, "run"),
    f.context,
    async () => {},
  );
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.equal(await readFile(output, "utf8"), "requested:v7:");
  assert.equal(
    JSON.stringify(result).includes("should-not-be-returned"),
    false,
  );
  assert.equal(
    JSON.stringify(result).includes(material.private_key_pem),
    false,
  );
});
test("interrupted hook is unknown and leaves the durable writer fence", async (t) => {
  const f = await setup(t),
    config = {
      task: "hook.run",
      hook_id: resourceID,
      script: "sleep 4",
      timeout_ms: 1000,
    };
  const result = await executeOperation(
    payload(config, "run"),
    f.context,
    async () => {},
  );
  assert.equal(result.state, "unknown");
  assert.equal(
    JSON.parse(
      await readFile(join(f.dataDir, "operations", "execution.lock"), "utf8"),
    ).state,
    "unknown",
  );
});
test("managed file traversal cannot follow a symlink into another directory", async (t) => {
  const f = await setup(t),
    outside = join(f.root, "outside");
  await mkdir(outside);
  await mkdir(join(f.dataDir, "operations"));
  await symlink(outside, join(f.dataDir, "operations", "platform"));
  const result = await executeOperation(
    payload({ task: "hook.run", script: "echo x" }, "run"),
    f.context,
    async () => {},
  );
  assert.equal(result.state, "failed");
});
test("explicit hook inspection confirms completion while retaining an unknown node writer fence", async (t) => {
  const f = await setup(t);
  const original = payload(
    {
      task: "hook.run",
      hook_id: resourceID,
      certificate_id: resourceID,
      certificate_version: "v1",
      script: "true",
    },
    "run",
  );
  const completed = await executeOperation(original, f.context, async () => {});
  assert.equal(completed.state, "succeeded");
  const lock = join(f.dataDir, "operations", "execution.lock");
  await writeFile(
    lock,
    JSON.stringify({
      state: "unknown",
      operation_id: original.operation_id,
      pid: process.pid,
    }),
  );
  const inspected = await executeOperation(
    payload(
      {
        task: "hook.inspect",
        hook_id: resourceID,
        original_operation_id: original.operation_id,
        certificate_version: "v1",
        script_sha256: completed.snapshot.operations.data.script_sha256,
      },
      "inspect",
    ),
    f.context,
    async () => {},
  );
  assert.equal(inspected.state, "succeeded");
  assert.equal(inspected.snapshot.operations.data.certificate_id, resourceID);
  assert.equal(JSON.parse(await readFile(lock, "utf8")).state, "unknown");
});
test("node discovery reads real OS capacity and reports Docker capability without a writer lock", async (t) => {
  const f = await setup(t);
  const result = await executeOperation(
    payload({ task: "node.inspect" }, "inspect"),
    {
      ...f.context,
      command: async () => ({ stdout: '"fixture-engine"', stderr: "" }),
    },
    async () => {},
  );
  assert.equal(result.state, "succeeded");
  const node = result.snapshot.operations.data.node;
  assert.ok(node.cpu > 0);
  assert.ok(node.memory_mb > 0);
  assert.equal(node.docker_available, true);
  await assert.rejects(
    readFile(join(f.dataDir, "operations", "execution.lock"), "utf8"),
    { code: "ENOENT" },
  );
});
test("Docker configuration preflight failures retain the active state and release the writer fence", async (t) => {
  const f = await setup(t),
    calls: string[][] = [];
  const context = {
    ...f.context,
    command: async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "ps") return { stdout: "", stderr: "" };
      throw Object.assign(Error("fixture failed read-only preflight"), {
        code: "operation_command_failed",
      });
    },
  };
  const app = await executeOperation(
    payload({
      task: "workload.apply",
      instance_id: resourceID,
      application: { mode: "container", image: "alpine:3.23", mounts: [] },
    }),
    context,
    async () => {},
  );
  assert.equal(app.state, "failed");
  assert.equal(app.code, "compose_preflight_failed");
  const gateway = await executeOperation(
    payload({
      task: "gateway.apply",
      instance_id: resourceID,
      image: "openresty/openresty:1.27.1.2-0-alpine",
      sites: [],
    }),
    context,
    async () => {},
  );
  assert.equal(gateway.state, "failed");
  assert.equal(gateway.code, "gateway_preflight_failed");
  assert.equal(
    calls.some((args) => args.includes("--detach")),
    false,
  );
  await assert.rejects(
    readFile(join(f.dataDir, "operations", "execution.lock"), "utf8"),
    { code: "ENOENT" },
  );
});
