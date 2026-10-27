import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeDefinition, executeCompose } from "../src/operations/containers.js";
import type { OperationExecutionContext, OperationPayload } from "../src/operations/types.js";

const owner = "io.lightmoni.operations.resource";
const cid = "a".repeat(64);
const basic = () => ({ project_name: "example", compose: { services: { web: { image: "nginx:1.27.5", ports: ["127.0.0.1:18080:80"], environment: { API_TOKEN: "secret-for-tests" }, command: ["echo", "$HOST_SECRET"] } } } });
function payload(operation: string, input: Record<string, any> = {}, config: Record<string, any> = basic(), revision = 1): OperationPayload {
  return { version: 1, operation_id: `run_${Math.random().toString(16).slice(2)}`, operation, input, resource: { id: "resource_1", kind: "compose", name: "Example", agent_id: "agent_1", revision, config, created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z" } };
}
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "lightmoni-compose-"));
  let containers: any[] = [];
  let failUp = false;
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  let document: any;
  const context: OperationExecutionContext = {
    dataDir, signal: new AbortController().signal, now: () => new Date("2026-10-27T00:00:00Z"),
    command: async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd });
      assert.equal(file, "docker");
      assert.deepEqual(args.slice(0, 2), ["--context", "default"]);
      args = args.slice(2);
      if (args[0] === "version") return { stdout: '"27.5.1"\n', stderr: "" };
      if (args[0] === "compose" && args[1] === "version") return { stdout: "2.32.4\n", stderr: "" };
      if (args[0] === "ps") return { stdout: containers.map((c) => JSON.stringify({ ID: c.Id })).join("\n"), stderr: "" };
      if (args[0] === "inspect") return { stdout: JSON.stringify(containers.filter((c) => args.includes(c.Id))), stderr: "" };
      if (["network", "volume"].includes(args[0])) return { stdout: "", stderr: "" };
      if (args[0] === "logs") return { stdout: "API_TOKEN=secret-for-tests\n" + "x".repeat(100_000), stderr: "warning secret-for-tests" };
      if (args[0] === "compose") {
        const f = args.indexOf("--file");
        document = JSON.parse(await readFile(args[f + 1], "utf8"));
        if (args.includes("config")) return { stdout: JSON.stringify(document), stderr: "" };
        if (args.includes("up")) {
          if (failUp) throw new Error("sensitive docker error secret-for-tests");
          containers = Object.entries(document.services).map(([name, service]: any, i) => ({ Id: (i ? "b" : "a").repeat(64), Name: `/example-${name}-1`, Config: { Image: service.image, Labels: { ...service.labels, "com.docker.compose.project": "example", "com.docker.compose.service": name }, Env: ["PRIVATE=do-not-expose"] }, State: { Status: "running", Running: true, ExitCode: 0 }, Mounts: [] }));
          return { stdout: "", stderr: "" };
        }
        if (args.includes("stop")) containers.forEach((c) => { c.State.Running = false; c.State.Status = "exited"; });
        if (args.includes("start") || args.includes("restart")) containers.forEach((c) => { c.State.Running = true; c.State.Status = "running"; });
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected Docker command: ${JSON.stringify(args)}`);
    },
  };
  return { dataDir, context, calls, get containers() { return containers; }, set containers(v: any[]) { containers = v; }, get document() { return document; }, set failUp(v: boolean) { failUp = v; }, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

test("compose validates a bounded safe subset, pinned images, and hides possible secrets", () => {
  const config = composeDefinition.validate(basic());
  assert.equal(composeDefinition.validate({ ...basic(), service_id: null }).service_id, undefined);
  assert.equal(composeDefinition.validate({ ...basic(), service_id: "" }).service_id, undefined);
  const visible = composeDefinition.publicConfig(config);
  assert.equal(visible.compose.services.web.environment.API_TOKEN, "[redacted]");
  assert.equal(visible.compose.services.web.command, "[redacted]");
  for (const service of [
    { image: "nginx" }, { image: "nginx:latest" }, { image: "nginx:1", privileged: true },
    { image: "nginx:1", volumes: ["/:/host"] }, { image: "nginx:1", volumes: ["/var/run/docker.sock:/sock"] },
    { image: "nginx:1", network_mode: "host" }, { image: "nginx:1", pid: "host" },
    { image: "nginx:1", cap_add: ["SYS_ADMIN"] }, { image: "nginx:1", env_file: "/etc/shadow" },
    { image: "nginx:1", labels: { [owner]: "other" } }, { build: "." },
  ]) assert.throws(() => composeDefinition.validate({ project_name: "example", compose: { services: { web: service } } }));
  assert.throws(() => composeDefinition.validate({ ...basic(), compose: { ...basic().compose, volumes: { data: { driver_opts: { device: "/" } } } } }));
  assert.throws(() => composeDefinition.validateInput("apply", {}, config), /generation/);
  assert.throws(() => composeDefinition.validateInput("logs", { container_id: "--help" }, config));
  assert.throws(() => composeDefinition.validateInput("adopt", { expected_generation: 0, acknowledge_recreate: true }, config), /inventory/);
});

test("compose applies JSON with literal dollars, protected files, ownership and optimistic generations", async () => {
  const f = await fixture();
  try {
    const original = payload("apply", { expected_generation: 0 });
    const applied = await executeCompose(original, f.context);
    assert.equal(applied.verified, true);
    assert.equal(applied.data.generation, 1);
    const previousCallCount = f.calls.length;
    const duplicate = await executeCompose(original, f.context);
    assert.equal(duplicate.data.replayed_result, true);
    assert.equal(f.calls.length, previousCallCount);
    assert.equal(f.document.services.web.labels[owner], "resource_1");
    assert.equal(f.document.services.web.command[1], "$$HOST_SECRET");
    assert.ok(f.calls.every((call) => !["sh", "bash", "sudo"].includes(call.file)));
    assert.ok(f.calls.every((call) => call.args[0] === "--context" && call.args[1] === "default"));
    const dir = join(f.dataDir, "operations", "compose", "resource_1");
    for (const entry of await readdir(dir)) if (entry.endsWith(".json")) assert.equal((await stat(join(dir, entry))).mode & 0o077, 0);
    const stopped = await executeCompose(payload("stop", { expected_generation: 1 }), f.context);
    assert.equal(stopped.verified, true);
    assert.equal(stopped.data.generation, 2);
    const count = f.calls.length;
    await assert.rejects(executeCompose(payload("start", { expected_generation: 1 }), f.context), /generation/);
    assert.equal(f.calls.length, count);
    const restored = await executeCompose(payload("rollback", { expected_generation: 2, target_generation: 1 }), f.context);
    assert.equal(restored.verified, true);
    assert.equal(restored.data.generation, 3);
    assert.equal(restored.data.data_volumes_restored, false);
    assert.ok(!f.calls.some((call) => call.args.includes("down") || call.args.includes("--volumes")));
    assert.ok(f.calls.flatMap((call) => call.args).filter((arg) => arg.startsWith("name=^")).every((arg) => arg.endsWith("$")));
  } finally { await f.cleanup(); }
});

test("external projects stay read only until exact inventory and recreation are approved", async () => {
  const f = await fixture();
  try {
    f.containers = [{ Id: cid, Name: "/example-web-1", Config: { Image: "nginx:1.27.5", Labels: { "com.docker.compose.project": "example", "com.docker.compose.service": "web" }, Env: ["SECRET=hidden"] }, State: { Status: "running", Running: true, ExitCode: 0 }, Mounts: [] }];
    const inspected = await executeCompose(payload("inspect"), f.context);
    assert.equal(inspected.data.managed, false);
    assert.ok(!JSON.stringify(inspected.data).includes("SECRET=hidden"));
    await assert.rejects(executeCompose(payload("apply", { expected_generation: 0 }), f.context), /adopt/);
    await assert.rejects(executeCompose(payload("adopt", { expected_generation: 0, inventory_sha256: "0".repeat(64), acknowledge_recreate: true }), f.context), /inventory/);
    const adopted = await executeCompose(payload("adopt", { expected_generation: 0, inventory_sha256: inspected.data.inventory_sha256, acknowledge_recreate: true }), f.context);
    assert.equal(adopted.verified, true);
    assert.equal(f.containers[0].Config.Labels[owner], "resource_1");
  } finally { await f.cleanup(); }
});

test("foreign ownership and unsafe existing mounts prevent taking over a project", async () => {
  const f = await fixture();
  try {
    f.containers = [{ Id: cid, Config: { Image: "nginx:1.27.5", Labels: { [owner]: "another_resource", "com.docker.compose.project": "example", "com.docker.compose.service": "web" } }, State: { Running: true }, Mounts: [] }];
    const result = await executeCompose(payload("inspect"), f.context);
    await assert.rejects(executeCompose(payload("adopt", { expected_generation: 0, inventory_sha256: result.data.inventory_sha256, acknowledge_recreate: true }), f.context), /ownership/);
    f.containers[0].Config.Labels[owner] = "";
    f.containers[0].Mounts = [{ Type: "bind", Source: "/", Destination: "/host" }];
    const unsafe = await executeCompose(payload("inspect"), f.context);
    await assert.rejects(executeCompose(payload("adopt", { expected_generation: 0, inventory_sha256: unsafe.data.inventory_sha256, acknowledge_recreate: true }), f.context), /mount/);
  } finally { await f.cleanup(); }
});

test("partial Compose failure is unknown and requires a new explicitly acknowledged operation", async () => {
  const f = await fixture();
  try {
    f.failUp = true;
    const original = payload("apply", { expected_generation: 0 });
    const failed = await executeCompose(original, f.context);
    assert.equal(failed.verified, false);
    assert.equal(failed.data.status, "unknown");
    assert.ok(!JSON.stringify(failed).includes("secret-for-tests"));
    f.failUp = false;
    await assert.rejects(executeCompose(payload("apply", { expected_generation: 0 }), f.context), /unknown/);
    await assert.rejects(executeCompose({ ...original, input: { expected_generation: 0, acknowledge_unknown: true } }, f.context), /operation/);
    const repaired = await executeCompose(payload("apply", { expected_generation: 0, acknowledge_unknown: true }), f.context);
    assert.equal(repaired.verified, true);
  } finally { await f.cleanup(); }
});

test("logs and inspection are project-bound, bounded and redact configured secrets", async () => {
  const f = await fixture();
  try {
    await executeCompose(payload("apply", { expected_generation: 0 }), f.context);
    const logs = await executeCompose(payload("logs", { container_id: cid, tail: 100 }), f.context);
    assert.equal(logs.verified, true);
    assert.ok(logs.data.logs.length <= 65_536);
    assert.ok(Buffer.byteLength(JSON.stringify(logs.data)) <= 48 * 1024);
    assert.ok(!JSON.stringify(logs).includes("secret-for-tests"));
    assert.equal(logs.data.truncated, true);
    await assert.rejects(executeCompose(payload("logs", { container_id: "b".repeat(64) }), f.context), /project/);
  } finally { await f.cleanup(); }
});

test("managed directory links and concurrent mutations are rejected", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "lightmoni-compose-outside-"));
  try {
    await mkdir(join(f.dataDir, "operations"), { mode: 0o700 });
    await symlink(outside, join(f.dataDir, "operations", "compose"));
    await assert.rejects(executeCompose(payload("apply", { expected_generation: 0 }), f.context), /symbolic|directory/);
    assert.deepEqual(await readdir(outside), []);
  } finally { await f.cleanup(); await rm(outside, { recursive: true, force: true }); }
});

test("a project lock rejects a simultaneous mutation before invoking Docker", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  const context: OperationExecutionContext = { ...f.context, command: async (...args) => {
    if (first) { first = false; entered(); await gate; }
    return f.context.command(...args);
  } };
  try {
    const active = executeCompose(payload("apply", { expected_generation: 0 }), context);
    await ready;
    const callCount = f.calls.length;
    await assert.rejects(executeCompose(payload("apply", { expected_generation: 0 }), f.context), /locked/);
    assert.equal(f.calls.length, callCount);
    release();
    assert.equal((await active).verified, true);
  } finally { release(); await f.cleanup(); }
});

test("adopted volumes retain their exact existing name without label-driven recreation", async () => {
  const f = await fixture();
  const config: Record<string, any> = basic();
  config.compose.volumes = { data: {} };
  config.compose.services.web.volumes = ["data:/data"];
  const existingVolume = { Name: "example_data", Driver: "local", Options: null, Labels: { "com.docker.compose.project": "example", "com.docker.compose.volume": "data" } };
  const context: OperationExecutionContext = { ...f.context, command: async (file, args, options) => {
    const dockerArgs = args.slice(2);
    if (dockerArgs[0] === "volume" && dockerArgs[1] === "ls") return { stdout: JSON.stringify({ Name: existingVolume.Name }), stderr: "" };
    if (dockerArgs[0] === "volume" && dockerArgs[1] === "inspect") return { stdout: JSON.stringify([existingVolume]), stderr: "" };
    return f.context.command(file, args, options);
  } };
  f.containers = [{ Id: cid, Config: { Image: "nginx:1.27.5", Labels: { "com.docker.compose.project": "example", "com.docker.compose.service": "web" } }, State: { Running: true }, Mounts: [{ Type: "volume", Name: "example_data", Destination: "/data", RW: true }] }];
  try {
    let inv = await executeCompose(payload("inspect", {}, config), context);
    assert.equal((await executeCompose(payload("adopt", { expected_generation: 0, inventory_sha256: inv.data.inventory_sha256, acknowledge_recreate: true }, config), context)).verified, true);
    assert.deepEqual(f.document.volumes.data, { external: true, name: "example_data" });
    assert.equal((await executeCompose(payload("apply", { expected_generation: 1 }, config), context)).verified, true);
    assert.deepEqual(f.document.volumes.data, { external: true, name: "example_data" });
    assert.ok(!f.calls.some((call) => call.args.includes("rm") || call.args.includes("--volumes")));
    assert.throws(() => composeDefinition.validate({ ...config, compose: { ...config.compose, volumes: { data: { external: true, name: "other_data" } } } }));
  } finally { await f.cleanup(); }
});

test("restart waits for a container health check to leave its starting state", async () => {
  const f = await fixture();
  let waiting = false, inspections = 0;
  const context: OperationExecutionContext = { ...f.context, command: async (file, args, options) => {
    const result = await f.context.command(file, args, options);
    const dockerArgs = args.slice(2);
    if (dockerArgs[0] === "compose" && args.includes("restart")) waiting = true;
    if (dockerArgs[0] === "inspect" && waiting) {
      inspections++;
      if (inspections === 1) {
        const containers = JSON.parse(result.stdout);
        containers[0].State.Health = { Status: "starting" };
        return { ...result, stdout: JSON.stringify(containers) };
      }
    }
    return result;
  } };
  try {
    await executeCompose(payload("apply", { expected_generation: 0 }), context);
    assert.equal((await executeCompose(payload("restart", { expected_generation: 1 }), context)).verified, true);
    assert.ok(inspections >= 2);
  } finally { await f.cleanup(); }
});
