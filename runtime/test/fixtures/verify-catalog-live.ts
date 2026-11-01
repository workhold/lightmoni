/** Explicit opt-in local Docker acceptance; creates only disposable loopback projects. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  executeOperation,
  operationCommand,
} from "../../src/agent/operations.js";
import { catalogInstallation } from "../../src/ops/catalog.js";
if (process.env.LIGHTMONI_CATALOG_LIVE !== "1")
  throw Error(
    "Set LIGHTMONI_CATALOG_LIVE=1 for disposable local Docker acceptance",
  );
const root = await realpath(
    await mkdtemp(join(tmpdir(), "lightmoni-catalog-live-")),
  ),
  checks: any[] = [],
  instances: string[] = [];
const context: any = {
  dataDir: root,
  signal: new AbortController().signal,
  now: () => new Date(),
  command: async (file: string, args: string[], opts: any) => {
    try {
      return await operationCommand(file, args, opts);
    } catch (e) {
      console.log("failed_command", file, args[0], args[1]);
      throw e;
    }
  },
};
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const p = (server.address() as any).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return p;
}
async function run(instance: string, config: any) {
  return executeOperation(
    {
      version: 1,
      operation_id: crypto.randomUUID().replaceAll("-", ""),
      operation: "apply",
      resource: {
        id: instance,
        kind: "platform",
        name: "Catalog local smoke",
        agent_id: "local-qa",
        revision: 1,
        config: { ...config, instance_id: instance },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      input: {},
    },
    context,
    async () => {},
  );
}
async function cleanup(instance: string) {
  const state = JSON.parse(
    await readFile(
      join(root, "operations", "platform", "workloads", instance, "state.json"),
      "utf8",
    ).catch(() => "null"),
  );
  // The real executor uses platform/ below its private operations directory; find its known manifest deterministically.
  const location =
    state?.manifest ??
    join(
      root,
      "operations",
      "platform",
      "workloads",
      instance,
      "versions",
      "1",
      "compose.json",
    );
  try {
    await operationCommand(
      "docker",
      [
        "compose",
        "--project-name",
        "lm-" + instance,
        "-f",
        location,
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      { timeoutMs: 30000 },
    );
  } catch {
    const ids = (
      await operationCommand("docker", [
        "ps",
        "-aq",
        "--filter",
        "label=com.docker.compose.project=lm-" + instance,
      ])
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length) await operationCommand("docker", ["rm", "--force", ...ids]);
    const volumes = (
      await operationCommand("docker", [
        "volume",
        "ls",
        "-q",
        "--filter",
        "label=com.docker.compose.project=lm-" + instance,
      ])
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (volumes.length)
      await operationCommand("docker", ["volume", "rm", ...volumes]);
    const networks = (
      await operationCommand("docker", [
        "network",
        "ls",
        "-q",
        "--filter",
        "label=com.docker.compose.project=lm-" + instance,
      ])
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (networks.length)
      await operationCommand("docker", ["network", "rm", ...networks]);
  }
}
try {
  const image = JSON.parse(
    (
      await operationCommand("docker", [
        "image",
        "inspect",
        "docker.cnb.cool/dbxio.com/dbx:0.6.62",
      ])
    ).stdout,
  )[0];
  const expected =
    image.Architecture === "arm64"
      ? "sha256:64def6b1262ff92a75645e3cdba6da9ecc4ebbcf5cff3ebe59e6bcdbe5e17f12"
      : "sha256:97c5f0e08d27fa8e00b5178091a0d9cef41909e4fd7a409c14201c8b3a14d83b";
  assert.equal(
    image.Descriptor.digest,
    "sha256:baa67c973db2146b013b44558484df6070b9cb818f2779c5669bd49b28af6a46",
  );
  await operationCommand("docker", ["tag", image.Id, "t8y2/dbx:0.6.62"]);
  const instance = crypto.randomUUID().replaceAll("-", ""),
    hostPort = await freePort(),
    password = randomBytes(24).toString("hex");
  instances.push(instance);
  const spec = catalogInstallation("dbx", {
    parameters: { password },
    host_ports: { http: hostPort },
    listen_ip: "127.0.0.1",
  }).spec;
  spec.compose.services.dbx.ports = [
    {
      target: 4224,
      published: String(hostPort),
      host_ip: "127.0.0.1",
      protocol: "tcp",
    },
  ];
  let receipt = await run(instance, {
    task: "workload.apply",
    application: spec,
    health: { type: "http", port: hostPort, path: "/api/auth/check" },
  });
  assert.equal(receipt.state, "succeeded", JSON.stringify(receipt));
  assert.equal(receipt.snapshot.operations.data.healthy, true);
  const endpoint = "http://127.0.0.1:" + hostPort;
  const auth = (await (
    await fetch(endpoint + "/api/auth/check")
  ).json()) as any;
  assert.equal(auth.required, true);
  assert.equal(auth.authenticated, false);
  const denied = await fetch(endpoint + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "incorrect-qa-password" }),
  });
  assert.ok(denied.status >= 400);
  const login = await fetch(endpoint + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.ok(login.ok);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const authorized = (await (
    await fetch(endpoint + "/api/auth/check", { headers: { cookie } })
  ).json()) as any;
  assert.equal(authorized.authenticated, true);
  const container = receipt.snapshot.operations.data.containers[0].id;
  await operationCommand("docker", [
    "exec",
    container,
    "bash",
    "-c",
    "printf catalog-persistent > /app/data/catalog-smoke-marker",
  ]);
  const connection = {
    id: "lightmoni-qa-sqlite",
    name: "LightMoni QA SQLite",
    db_type: "sqlite",
    host: "/app/data/lightmoni-qa.sqlite",
    port: 0,
    username: "",
    password: "",
    database: null,
  };
  const saved = await fetch(endpoint + "/api/connection/save", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ configs: [connection], removedIds: [] }),
  });
  assert.ok(saved.ok);
  const beforeConnections = (await (
    await fetch(endpoint + "/api/connection/list", { headers: { cookie } })
  ).json()) as any[];
  assert.ok(
    beforeConnections.some(
      (c) => c.id === connection.id && c.host === connection.host,
    ),
  );
  receipt = await run(instance, {
    task: "workload.apply",
    application: spec,
    force_recreate: true,
    health: { type: "http", port: hostPort, path: "/api/auth/check" },
  });
  assert.equal(receipt.state, "succeeded", JSON.stringify(receipt));
  const next = receipt.snapshot.operations.data.containers[0].id;
  assert.equal(
    (
      await operationCommand("docker", [
        "exec",
        next,
        "cat",
        "/app/data/catalog-smoke-marker",
      ])
    ).stdout,
    "catalog-persistent",
  );
  const relogin = await fetch(endpoint + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.ok(relogin.ok);
  const nextCookie = relogin.headers.get("set-cookie")!.split(";")[0];
  const afterConnections = (await (
    await fetch(endpoint + "/api/connection/list", {
      headers: { cookie: nextCookie },
    })
  ).json()) as any[];
  assert.ok(
    afterConnections.some(
      (c) => c.id === connection.id && c.host === connection.host,
    ),
  );
  checks.push({
    application: "dbx",
    image: "t8y2/dbx:0.6.62",
    source: "official CNB, platform manifest/config/layers equal to Hub",
    architecture: image.Architecture,
    platform_config_digest: expected,
    index_digest: image.Id,
    receipt: "succeeded",
    login_required: true,
    wrong_password_rejected: true,
    login_succeeded: true,
    data_and_connection_survive_recreate: true,
  });
  const initInstance = crypto.randomUUID().replaceAll("-", ""),
    webPort = await freePort();
  instances.push(initInstance);
  const app = {
    mode: "compose",
    mounts: [],
    ports: [],
    compose: {
      services: {
        init: {
          image: "nginx:1.30.6-alpine",
          entrypoint: ["sh", "-ec"],
          command: ["printf catalog-ready > /data/index.html"],
          restart: "no",
          labels: { "io.lightmoni.platform.oneshot": "true" },
          volumes: [{ type: "volume", source: "html", target: "/data" }],
        },
        web: {
          image: "nginx:1.30.6-alpine",
          depends_on: { init: { condition: "service_completed_successfully" } },
          ports: [
            { target: 80, published: String(webPort), host_ip: "127.0.0.1" },
          ],
          volumes: [
            { type: "volume", source: "html", target: "/usr/share/nginx/html" },
          ],
        },
      },
      volumes: { html: {} },
    },
  };
  const result = await run(initInstance, {
    task: "workload.apply",
    application: app,
    health: { type: "http", port: webPort },
  });
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.equal(result.snapshot.operations.data.healthy, true);
  assert.equal(
    result.snapshot.operations.data.containers.find(
      (c: any) => c.service === "init",
    ).state,
    "exited",
  );
  const inspection = await run(initInstance, {
    task: "workload.inspect",
    health: { type: "http", port: webPort },
  });
  assert.equal(inspection.snapshot.operations.data.healthy, true);
  assert.equal(
    await (await fetch("http://127.0.0.1:" + webPort)).text(),
    "catalog-ready",
  );
  checks.push({
    application: "one-shot plus nginx",
    actual_agent_apply: true,
    init_exited_zero: true,
    apply_healthy: true,
    subsequent_inspect_healthy: true,
  });
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  for (const id of instances) await cleanup(id);
  const remaining = [];
  for (const id of instances) {
    const cs = (
      await operationCommand("docker", [
        "ps",
        "-aq",
        "--filter",
        "label=com.docker.compose.project=lm-" + id,
      ])
    ).stdout.trim();
    const vs = (
      await operationCommand("docker", [
        "volume",
        "ls",
        "-q",
        "--filter",
        "label=com.docker.compose.project=lm-" + id,
      ])
    ).stdout.trim();
    const ns = (
      await operationCommand("docker", [
        "network",
        "ls",
        "-q",
        "--filter",
        "label=com.docker.compose.project=lm-" + id,
      ])
    ).stdout.trim();
    if (cs || vs || ns) remaining.push(id);
  }
  const out = resolve(
    import.meta.dirname,
    "../../../specs/066-app-catalog-expansion/evidence",
  );
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "docker-live.json"),
    JSON.stringify(
      { checks, remaining_owned_resources: remaining.length },
      null,
      2,
    ) + "\n",
  );
  await rm(root, { recursive: true, force: true });
  assert.equal(remaining.length, 0);
}
