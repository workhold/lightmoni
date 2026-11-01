import {workloadContainersReady as ready} from './workload-readiness.js';
import {cachePolicy,prepareCachedImages} from './image-cache.js';
import {
  lstat,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { join, dirname, resolve, posix } from "node:path";
import { createServer, createConnection, isIP } from "node:net";
import { createSocket } from "node:dgram";
import {randomBytes} from "node:crypto";
import {hashSync} from "bcryptjs";
import {authMaterial,authScopes} from "./basic-auth.js";
import { X509Certificate } from "node:crypto";
import { cpus, freemem, totalmem, loadavg, networkInterfaces } from "node:os";
import { parse as parseYAML } from "yaml";
import type {
  OperationConfig,
  OperationDefinition,
  OperationExecutionContext,
  OperationExecutionResult,
  OperationPayload,
} from "./types.js";
import { OperationRejectedError } from "./errors.js";
import { installCause } from "./install-progress.js";
import {
  atomicFile,
  directory,
  hash,
  privateRoot,
  quote,
  readJSON,
  safeFile,
  safeID,
  probeHTTP,
} from "./website-files.js";
import { certificateMetadata } from "./certificates.js";
import {
  normalizeNginx,
  normalizeLocations,
  renderNginxOptions,
  renderLocations,
} from "./nginx.js";

const INSTANCE_LABEL = "io.lightmoni.platform.instance";
const OWNER_LABEL = "io.lightmoni.platform.owner";
const TASKS = [
  "node.inspect",
  "workload.apply",
  "workload.inspect",
  "workload.stop",
  "workload.remove",
  "workload.logs",
  "gateway.apply",
  "gateway.inspect",
  "gateway.stop",
  "gateway.remove",
  "gateway.logs",
  "certificate.install",
  "certificate.inspect",
  "hook.run",
  "hook.inspect",
];
const reject = (code: string): never => {
  throw new OperationRejectedError(code);
};
export const object = (v: unknown, name = "object"): Record<string, any> => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v))
  )
    reject("INVALID_" + name.toUpperCase());
  return v as Record<string, any>;
};
const text = (v: unknown, name: string, max = 4096): string => {
  if (typeof v !== "string" || !v || v.length > max || v.includes("\0"))
    reject("INVALID_" + name.toUpperCase());
  return v as string;
};
export const absolutePath = (v: unknown): string => {
  const p = text(v, "path", 1024);
  if (
    !p.startsWith("/") ||
    p === "/" ||
    p.split("/").some((x) => x === "..") ||
    /[\r\n\\]/.test(p)
  )
    reject("INVALID_ABSOLUTE_PATH");
  return resolve(p);
};
export const port = (v: unknown): number => {
  if (!Number.isInteger(v) || Number(v) < 1 || Number(v) > 65535)
    reject("INVALID_PORT");
  return Number(v);
};
export const files = (v: unknown, max = 512 * 1024): Record<string, string> => {
  const input = object(v, "files"),
    result: Record<string, string> = {};
  let bytes = 0;
  if (Object.keys(input).length > 300) reject("FILE_COUNT_LIMIT");
  for (const [name, body] of Object.entries(input)) {
    if (
      name.length > 240 ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((p) => !p || p === "." || p === "..") ||
      posix.normalize(name) !== name ||
      typeof body !== "string"
    )
      reject("INVALID_FILE_PATH");
    bytes += Buffer.byteLength(body);
    if (bytes > max) reject("FILE_CONTENT_LIMIT");
    result[name] = body;
  }
  return result;
};
const strings = (v: unknown, name: string, max = 128): string[] => {
  if (!Array.isArray(v) || v.length > max)
    reject("INVALID_" + name.toUpperCase());
  return (v as unknown[]).map((x) => text(x, name));
};
const environment = (v: unknown): Record<string, string> => {
  const env = object(v, "environment");
  if (Object.keys(env).length > 200) reject("ENVIRONMENT_LIMIT");
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) ||
        typeof v !== "string" ||
        v.length > 8192 ||
        v.includes("\0")
      )
        reject("INVALID_ENVIRONMENT");
      return [k, v];
    }),
  );
};
const finite = (v: unknown, min: number, max: number, name: string) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    reject("INVALID_" + name.toUpperCase());
  return v as number;
};
export function normalizeApplication(value: unknown): OperationConfig {
  const c = object(value, "application");
  if (!["container", "compose"].includes(c.mode))
    reject("INVALID_APPLICATION_MODE");
  const out: OperationConfig = { mode: c.mode };
  if (c.agent_ids !== undefined)
    out.agent_ids = strings(c.agent_ids, "agent_id", 100).map(safeID);
  if (c.mode === "container") {
    out.image = text(c.image, "image", 512);
    if (/[\s\r\n]/.test(out.image)) reject("INVALID_IMAGE");
    for (const k of ["command", "entrypoint"])
      if (c[k] !== undefined) out[k] = strings(c[k], k);
    if (c.environment !== undefined)
      out.environment = environment(c.environment);
    out.network_mode = c.network_mode ?? "bridge";
    if (!["bridge", "host", "none"].includes(out.network_mode))
      reject("INVALID_NETWORK_MODE");
    if (c.networks !== undefined)
      out.networks = strings(c.networks, "network", 32).map((n) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(n))
          reject("INVALID_NETWORK");
        return n;
      });
    if (out.network_mode !== "bridge" && out.networks?.length)
      reject("NETWORK_MODE_AND_NETWORKS_CONFLICT");
    if (out.network_mode === "host" && c.ports?.length)
      reject("HOST_NETWORK_HAS_NO_PORT_MAPPING");
    out.ports = (c.ports ?? []).map((p: unknown) => {
      const x = object(p, "port");
      const result: any = {
        container_port: port(x.container_port),
        host_port: port(x.host_port),
        protocol: x.protocol ?? "tcp",
        host_ip: x.host_ip ?? "0.0.0.0",
      };
      if (
        !["tcp", "udp"].includes(result.protocol) ||
        !isIP(result.host_ip)
      )
        reject("INVALID_PORT_MAPPING");
      return result;
    });
    if (out.ports.length > 64) reject("PORT_COUNT_LIMIT");
    for (const k of ["restart", "user", "working_dir"])
      if (c[k] !== undefined) out[k] = text(c[k], k, 256);
    if (c.read_only !== undefined) out.read_only = Boolean(c.read_only);
  } else {
    let doc: any;
    try {
      doc =
        typeof c.compose === "string"
          ? parseYAML(c.compose, { maxAliasCount: 20 })
          : structuredClone(c.compose);
    } catch {
      reject("INVALID_COMPOSE_DOCUMENT");
    }
    doc = object(doc, "compose");
    const services = object(doc.services, "compose_services");
    if (!Object.keys(services).length || Object.keys(services).length > 50)
      reject("INVALID_COMPOSE_SERVICES");
    // All local files must be supplied as managed mounts; centre/Agent ambient files are never read by Compose.
    if (doc.include || doc.name)
      reject("COMPOSE_INCLUDE_OR_NAME_NOT_SUPPORTED");
    for (const [name, v] of Object.entries(services)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name))
        reject("INVALID_COMPOSE_SERVICE");
      const s = object(v, "compose_service");
      if (!s.image || s.build || s.extends || s.env_file || s.profiles)
        reject("COMPOSE_REQUIRES_IMAGE_AND_MANAGED_FILES");
      text(s.image, "image", 512);
      if (s.network_mode === "host" && s.ports?.length)
        reject("HOST_NETWORK_HAS_NO_PORT_MAPPING");
      if (s.container_name) reject("COMPOSE_CONTAINER_NAME_RESERVED");
      if (s.environment) {
        if (Array.isArray(s.environment)) {
          const pairs = s.environment.map((entry: unknown) => {
            const literal = text(entry, "environment");
            const index = literal.indexOf("=");
            if (index < 1) reject("COMPOSE_ENVIRONMENT_MUST_BE_LITERAL");
            return [literal.slice(0, index), literal.slice(index + 1)];
          });
          s.environment = environment(Object.fromEntries(pairs));
        } else s.environment = environment(s.environment);
      }
    }
    for (const field of ["configs", "secrets"])
      for (const definition of Object.values(doc[field] ?? {}) as any[])
        if (definition.file || definition.environment)
          reject("COMPOSE_REQUIRES_MANAGED_FILES");
    if (Buffer.byteLength(JSON.stringify(doc)) > 256 * 1024)
      reject("COMPOSE_CONTENT_LIMIT");
    out.compose = doc;
  }
  out.mounts = (c.mounts ?? []).map((v: unknown) => {
    const m = object(v, "mount");
    if (!["config", "init", "data", "volume"].includes(m.type))
      reject("INVALID_MOUNT_TYPE");
    const result: any = {
      type: m.type,
      target: absolutePath(m.target),
      read_only: m.read_only ?? m.type === "config",
    };
    if (typeof result.read_only !== "boolean")
      reject("INVALID_MOUNT_READ_ONLY");
    if (m.service !== undefined) result.service = safeID(m.service);
    if (["config", "init"].includes(m.type))
      result.files = files(m.files ?? {});
    else if (m.type === "data") {
      if (m.source) result.source = absolutePath(m.source);
    } else {
      result.source = text(m.source, "volume", 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result.source))
        reject("INVALID_VOLUME_NAME");
    }
    return result;
  });
  if (out.mounts.length > 64) reject("MOUNT_COUNT_LIMIT");
  if (c.cpu !== undefined) out.cpu = finite(c.cpu, 0.01, 1024, "cpu");
  if (c.memory_mb !== undefined)
    out.memory_mb = finite(c.memory_mb, 4, 4 * 1024 * 1024, "memory");
  if (c.health !== undefined)
    out.health = structuredClone(object(c.health, "health"));
  if (Buffer.byteLength(JSON.stringify(out)) > 900 * 1024)
    reject("APPLICATION_CONTENT_LIMIT");
  return out;
}
export function applicationPorts(app: OperationConfig): Array<{
  host_port: number;
  container_port: number;
  protocol: string;
  host_ip: string;
}> {
  if (app.mode === "container") return app.ports ?? [];
  const result: Array<{
    host_port: number;
    container_port: number;
    protocol: string;
    host_ip: string;
  }> = [];
  for (const service of Object.values(app.compose.services) as any[])
    for (const value of service.ports ?? []) {
      if (typeof value === "number") continue;
      if (typeof value === "string") {
        const [bindings, protocol = "tcp"] = value.split("/"),
          parts = bindings.split(":");
        if (parts.length < 2) continue;
        result.push({
          host_port: port(Number(parts.at(-2))),
          container_port: port(Number(parts.at(-1))),
          protocol,
          host_ip:
            parts.length > 2
              ? parts
                  .slice(0, -2)
                  .join(":")
                  .replace(/^\[|\]$/g, "")
              : "0.0.0.0",
        });
      } else if (value.published !== undefined)
        result.push({
          host_port: port(Number(value.published)),
          container_port: port(Number(value.target)),
          protocol: value.protocol ?? "tcp",
          host_ip: value.host_ip ?? "0.0.0.0",
        });
    }
  if (result.some((p) => !["tcp", "udp"].includes(p.protocol)))
    reject("INVALID_PORT_PROTOCOL");
  return result;
}
export function applicationResources(app: OperationConfig): {
  cpu: number;
  memory_mb: number;
} {
  if (app.mode === "container")
    return { cpu: app.cpu ?? 0, memory_mb: app.memory_mb ?? 0 };
  let cpu = 0,
    memory_mb = 0;
  for (const service of Object.values(app.compose.services) as any[]) {
    cpu += Number(
      app.cpu ?? service.cpus ?? service.deploy?.resources?.limits?.cpus ?? 0,
    );
    const memory = app.memory_mb
      ? app.memory_mb * 1048576
      : (service.mem_limit ?? service.deploy?.resources?.limits?.memory ?? 0);
    if (typeof memory === "number") memory_mb += memory / 1048576;
    else {
      const match = /^([0-9.]+)\s*([bkmg])(?:i?b)?$/i.exec(memory);
      if (!match) reject("INVALID_COMPOSE_MEMORY");
      memory_mb +=
        Number(match![1]) *
        ({ b: 1 / 1048576, k: 1 / 1024, m: 1, g: 1024 }[
          match![2].toLowerCase()
        ] ?? 0);
    }
  }
  if (!Number.isFinite(cpu) || !Number.isFinite(memory_mb))
    reject("INVALID_COMPOSE_RESOURCES");
  return { cpu, memory_mb };
}
export const platformDefinition: OperationDefinition = {
  kind: "platform",
  operations: [
    "deploy",
    "apply",
    "install",
    "inspect",
    "stop",
    "remove",
    "logs",
    "disable",
    "reconcile",
    "sync",
    "run",
    "certificate.install",
    "hook.run",
  ],
  readOnly: ["inspect", "logs"],
  validate(v) {
    const c = object(v, "platform_config");
    if (!TASKS.includes(c.task)) reject("INVALID_PLATFORM_TASK");
    if (c.instance_id !== undefined) safeID(c.instance_id);
    if (c.task === "workload.apply") {normalizeApplication(c.application);if(c.image_cache)cachePolicy(c.image_cache);}
    return structuredClone(c);
  },
  publicConfig(c) {
    return { task: c.task, instance_id: c.instance_id };
  },
  validateInput(_operation, v) {
    return object(v ?? {}, "input");
  },
};

async function writeFiles(
  root: string,
  entries: Record<string, string>,
  initial = false,
) {
  await directory(root);
  for (const [name, body] of Object.entries(files(entries))) {
    const path = join(root, name);
    await directory(dirname(path));
    await safeFile(path);
    if (initial) {
      try {
        await writeFile(path, body, { flag: "wx", mode: 0o600 });
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
    } else await atomicFile(path, body);
  }
}
async function pointer(path: string, target: string) {
  let old: string | undefined;
  try {
    if (!(await lstat(path)).isSymbolicLink()) reject("UNSAFE_VERSION_POINTER");
    old = await readlink(path);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const temporary = path + "." + crypto.randomUUID();
  try {
    await symlink(target, temporary);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return old;
}
const composeArgs = (id: string, file: string) => [
  "compose",
  "--project-name",
  "lm-" + id,
  "--file",
  file,
];
async function inventory(
  context: OperationExecutionContext,
  instanceID: string,
): Promise<any[]> {
  const answer = await context.command(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      "label=com.docker.compose.project=lm-" + instanceID,
    ],
    { timeoutMs: 15000 },
  );
  const ids = answer.stdout.trim().split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  if (ids.length > 100 || ids.some((x) => !/^[a-f0-9]{12,64}$/.test(x)))
    reject("INVALID_DOCKER_INVENTORY");
  const result = JSON.parse(
    (await context.command("docker", ["inspect", ...ids], { timeoutMs: 15000 }))
      .stdout,
  );
  if (!Array.isArray(result)) reject("INVALID_DOCKER_INVENTORY");
  for (const c of result)
    if (c.Config?.Labels?.[INSTANCE_LABEL] !== instanceID)
      reject("WORKLOAD_OWNERSHIP_REQUIRED");
  return result;
}
const summarize = (containers: any[]) =>
  containers.map((c) => ({
    id: c.Id,
    name: String(c.Name ?? "").replace(/^\//, ""),
    service: c.Config?.Labels?.["com.docker.compose.service"] ?? "",
    image: c.Config?.Image ?? "",
    state: c.State?.Status ?? "unknown",
    running: c.State?.Running === true,
    health:
      c.State?.Health?.Status ?? (c.State?.Running ? "running" : "stopped"),
    restart_count: c.RestartCount ?? 0,
    ports: c.NetworkSettings?.Ports ?? {},
  }));
async function workloadSnapshot(
  context: OperationExecutionContext,
  instanceID: string,
) {
  const root = join(await privateRoot(context, 'platform'), 'workloads', instanceID);
  const state = await readJSON<any>(join(root, 'state.json'), null);
  const manifest = state?.manifest ? await readJSON<any>(state.manifest, null) : null;
  const raw = await inventory(context, instanceID);
  let stats: any[] = [];
  if (raw.some((c) => c.State?.Running)) {
    try {
      const output = await context.command(
        "docker",
        [
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          ...raw.filter((c) => c.State?.Running).map((c) => c.Id),
        ],
        { timeoutMs: 15000 },
      );
      stats = output.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      stats = [];
    }
  }
  return {
    containers: summarize(raw),
    stats,
    healthy: ready(raw, Object.keys(manifest?.services ?? {}).length || 1, manifest?.services),
    observed_at: context.now().toISOString(),
  };
}
async function checkReadiness(
  config: any,
  context: OperationExecutionContext,
): Promise<boolean> {
  if (!config.health) return true;
  const p = port(config.health.port ?? config.probe_port);
  context.signal.throwIfAborted();
  if (config.health.type === "http") {
    try {
      const response = await fetch(
        "http://127.0.0.1:" + p + (config.health.path ?? "/"),
        {
          redirect: "manual",
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(3000)]),
        },
      );
      await response.body?.cancel();
      return response.status >= 200 && response.status < 400;
    } catch {
      return false;
    }
  }
  if (config.health.type !== "tcp") reject("INVALID_HEALTH_TYPE");
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: p });
    let complete = false;
    const done = (v: boolean) => {
      if (complete) return;
      complete = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(3000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    context.signal.addEventListener("abort", () => done(false), { once: true });
  });
}
async function availablePort(p: any, context: OperationExecutionContext) {
  context.signal.throwIfAborted();
  await new Promise<void>((resolve, rejectPromise) => {
    const listener =
      p.protocol === "udp"
        ? createSocket(p.host_ip === "::" ? "udp6" : "udp4")
        : createServer();
    listener.once("error", () =>
      rejectPromise(new OperationRejectedError("HOST_PORT_OCCUPIED")),
    );
    listener.once("listening", () => listener.close(() => resolve()));
    if (p.protocol === "udp")
      (listener as ReturnType<typeof createSocket>).bind(
        p.host_port,
        p.host_ip,
      );
    else
      (listener as ReturnType<typeof createServer>).listen(
        p.host_port,
        p.host_ip,
      );
  });
}
export async function renderManifest(
  context: OperationExecutionContext,
  id: string,
  app: OperationConfig,
  revision: number,
): Promise<Record<string, any>> {
  const root = join(await privateRoot(context, "platform"), "workloads", id);
  await directory(root);
  const doc =
    app.mode === "compose"
      ? structuredClone(app.compose)
      : {
          services: {
            app: {
              image: app.image,
              restart: app.restart ?? "unless-stopped",
              ...(app.command ? { command: app.command } : {}),
              ...(app.entrypoint ? { entrypoint: app.entrypoint } : {}),
              ...(app.environment ? { environment: app.environment } : {}),
              ...(app.ports?.length
                ? {
                    ports: app.ports.map((p: any) => ({
                      target: p.container_port,
                      published: String(p.host_port),
                      protocol: p.protocol,
                      host_ip: p.host_ip,
                    })),
                  }
                : {}),
              ...(app.network_mode !== "bridge"
                ? { network_mode: app.network_mode }
                : {}),
              ...(app.user ? { user: app.user } : {}),
              ...(app.working_dir ? { working_dir: app.working_dir } : {}),
              ...(app.read_only ? { read_only: true } : {}),
              ...(app.networks?.length ? { networks: app.networks } : {}),
              ...(app.cpu ? { cpus: app.cpu } : {}),
              ...(app.memory_mb
                ? { mem_limit: app.memory_mb * 1024 * 1024 }
                : {}),
            },
          },
        };
  if (app.mode === "container" && app.networks?.length) {
    doc.networks = Object.fromEntries(
      app.networks.map((name: string) => [name, { external: true, name }]),
    );
    delete doc.services.app.network_mode;
  }
  const serviceNames = Object.keys(doc.services);
  for (const [name, s] of Object.entries(doc.services) as Array<
    [string, any]
  >) {
    s.labels = {
      ...(Array.isArray(s.labels)
        ? Object.fromEntries(
            s.labels.map((x: string) => {
              const i = x.indexOf("=");
              return [x.slice(0, i), x.slice(i + 1)];
            }),
          )
        : (s.labels ?? {})),
      [INSTANCE_LABEL]: id,
      [OWNER_LABEL]: "lightmoni",
    };
    if (app.cpu) s.cpus = app.cpu;
    if (app.memory_mb) s.mem_limit = app.memory_mb * 1024 * 1024;
  }
  for (let i = 0; i < app.mounts.length; i++) {
    const m = app.mounts[i],
      service = m.service ?? serviceNames[0];
    if (!doc.services[service]) reject("MOUNT_SERVICE_NOT_FOUND");
    let source: string,
      type = "bind";
    if (m.type === "volume") {
      source = m.source;
      type = "volume";
      doc.volumes ??= {};
      doc.volumes[source] ??= {};
    } else if (m.type === "data") {
      source = m.source ?? join(root, "data", String(i));
      await directory(source);
    } else {
      source = join(
        root,
        m.type === "init"
          ? "initial"
          : join("config", hash(JSON.stringify(m.files))),
        String(i),
      );
      await writeFiles(source, m.files, m.type === "init");
    }
    doc.services[service].volumes ??= [];
    doc.services[service].volumes.push({
      type,
      source,
      target: m.target,
      read_only: m.read_only,
    });
  }
  // Compose interpolation must never read the Agent process environment. Container shell variables remain literal here.
  const literal = (v: any): any =>
    typeof v === "string"
      ? v.replace(/\$/g, () => "$$")
      : Array.isArray(v)
        ? v.map(literal)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, literal(x)]),
            )
          : v;
  return literal(doc);
}
async function executeWorkload(
  payload: OperationPayload,
  context: OperationExecutionContext,
): Promise<OperationExecutionResult> {
  const c = payload.resource.config,
    id = safeID(c.instance_id),
    root = join(await privateRoot(context, "platform"), "workloads", id);
  await directory(root);
  const statePath = join(root, "state.json");
  const state = await readJSON<any>(statePath, null);
  if (c.task === "workload.inspect") {
    const snapshot = await workloadSnapshot(context, id);
    snapshot.healthy = snapshot.healthy && (await checkReadiness(c, context));
    return { verified: true, data: { instance_id: id, ...snapshot } };
  }
  if (c.task === "workload.logs") {
    const cs = await inventory(context, id);
    const container = c.container_id
      ? cs.find((x) => x.Id === c.container_id)
      : cs[0];
    if (!container) reject("CONTAINER_NOT_FOUND");
    const tail = Number(c.tail ?? 100);
    if (!Number.isInteger(tail) || tail < 1 || tail > 500)
      reject("INVALID_LOG_TAIL");
    const output = await context.command(
      "docker",
      ["logs", "--tail", String(tail), container.Id],
      { timeoutMs: 15000 },
    );
    return {
      verified: true,
      data: {
        instance_id: id,
        text: (output.stdout + output.stderr).slice(-32000),
        sensitive_logs: true,
      },
    };
  }
  if (c.task === "workload.stop" || c.task === "workload.remove") {
    let before: any[];
    try {
      before = await inventory(context, id);
    } catch (error) {
      if (error instanceof OperationRejectedError) throw error;
      throw Object.assign(new OperationRejectedError("DOCKER_PREREQUISITE_FAILED"), {diagnosticCode: installCause(error)});
    }
    if (before.length) {
      if (!state?.manifest) reject("WORKLOAD_STATE_REQUIRED");
      const args = composeArgs(id, state.manifest);
      await context.command(
        "docker",
        [
          ...args,
          ...(c.task === "workload.stop"
            ? ["stop", "--timeout", "20"]
            : ["down", "--remove-orphans", "--timeout", "20"]),
        ],
        { timeoutMs: 60000 },
      );
    }
    const after = await inventory(context, id);
    const okay =
      c.task === "workload.stop"
        ? after.every((x) => !x.State?.Running)
        : after.length === 0;
    if (!okay) throw Error("WORKLOAD_STOP_NOT_VERIFIED");
    await atomicFile(statePath, JSON.stringify({ ...state, stopped: true }));
    return {
      verified: true,
      data: {
        instance_id: id,
        stopped: true,
        removed: c.task === "workload.remove",
        ...(await workloadSnapshot(context, id)),
      },
    };
  }
  const app = normalizeApplication(c.application),
    manifest = await renderManifest(
      context,
      id,
      app,
      payload.resource.revision,
    );
  const imageSources=c.image_cache?await prepareCachedImages(manifest,c.image_cache,root,context):[];
  const digest = hash(JSON.stringify(manifest)),
    version = join(root, "versions", digest);
  await directory(version);
  const manifestPath = join(version, "compose.json");
  await atomicFile(manifestPath, JSON.stringify(manifest));
  let prior: any[];
  await context.progress?.("checking_docker");
  try {
    prior = await inventory(context, id);
  } catch (error) {
    if (error instanceof OperationRejectedError) throw error;
    throw Object.assign(new OperationRejectedError("DOCKER_PREREQUISITE_FAILED"), {diagnosticCode: installCause(error)});
  }
  // Check explicit mappings before Docker mutates anything; existing owned mappings are already reserved locally.
  const ownPorts = new Set(
    prior
      .filter((x) => x.State?.Running)
      .flatMap((x) =>
        Object.values(x.HostConfig?.PortBindings ?? {})
          .flatMap((v: any) => v ?? [])
          .map((x: any) => String(x.HostPort)),
      ),
  );
  await context.progress?.("checking_ports");
  for (const p of applicationPorts(app))
    if (!ownPorts.has(String(p.host_port))) await availablePort(p, context);
  await context.progress?.("validating_config");
  try {
    await context.command(
      "docker",
      [...composeArgs(id, manifestPath), "config", "--quiet"],
      { timeoutMs: 20000 },
    );
  } catch (error) {
    throw Object.assign(new OperationRejectedError("COMPOSE_PREFLIGHT_FAILED"), {diagnosticCode:installCause(error)});
  }
  await context.progress?.("starting_containers");
  try {
    await context.command(
      "docker",
      [
        ...composeArgs(id, manifestPath),
        "up",
        "--detach",
        "--remove-orphans",
        ...(c.force_recreate ? ["--force-recreate"] : []),
        "--wait",
        "--wait-timeout",
        "300",
      ],
      { timeoutMs: 600000 },
    );
    await context.progress?.("checking_health");
    const cs = await inventory(context, id);
    if (!ready(cs, Object.keys(manifest.services).length, manifest.services))
      throw Error("WORKLOAD_HEALTH_NOT_VERIFIED");
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await checkReadiness(c, context)) {
        healthy = true;
        break;
      }
      context.signal.throwIfAborted();
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!healthy) throw Error("WORKLOAD_READINESS_NOT_VERIFIED");
    await atomicFile(
      statePath,
      JSON.stringify({
        version: 1,
        instance_id: id,
        resource_id: payload.resource.id,
        revision: payload.resource.revision,
        manifest: manifestPath,
        digest,
        stopped: false,
        updated_at: context.now().toISOString(),
      }),
    );
    return {
      verified: true,
      data: {
        instance_id: id,
        revision: payload.resource.revision,
        digest,
        ...(await workloadSnapshot(context, id)),
        image_sources:imageSources,
      },
    };
  } catch (error) {
    await context.progress?.("restoring_previous", installCause(error));
    try {
      if (state?.manifest && prior.length) {
        await context.command(
          "docker",
          [
            ...composeArgs(id, state.manifest),
            "up",
            "--detach",
            "--remove-orphans",
            "--wait",
            "--wait-timeout",
            "60",
          ],
          { timeoutMs: 120000 },
        );
        if (!ready(await inventory(context, id), prior.length, (await readJSON<any>(state.manifest, null))?.services))
          throw Error("RESTORE_NOT_HEALTHY");
      } else {
        await context.command(
          "docker",
          [
            ...composeArgs(id, manifestPath),
            "down",
            "--remove-orphans",
            "--timeout",
            "10",
          ],
          { timeoutMs: 30000 },
        );
        if ((await inventory(context, id)).length)
          throw Error("REMOVE_NOT_VERIFIED");
      }
    } catch {
      throw Object.assign(Error("WORKLOAD_APPLY_RECOVERY_FAILED"), {diagnosticCode:installCause(error)});
    }
    throw Object.assign(new OperationRejectedError("WORKLOAD_APPLY_FAILED_RESTORED"), {diagnosticCode:installCause(error)});
  }
}

async function installCertificate(
  c: any,
  context: OperationExecutionContext,
): Promise<OperationExecutionResult> {
  const id = safeID(c.certificate_id),
    version = safeID(c.certificate_version ?? c.version),
    path = absolutePath(c.path);
  const certName = c.certificate_file ?? "fullchain.pem",
    keyName = c.private_key_file ?? "privkey.pem";
  for (const name of [certName, keyName])
    if (
      typeof name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
    )
      reject("INVALID_CERTIFICATE_FILENAME");
  if (certName === keyName) reject("DUPLICATE_CERTIFICATE_FILENAME");
  const meta = certificateMetadata(
    c.certificate_pem,
    c.private_key_pem,
    c.domains ?? [],
    context.now(),
  );
  if (c.fingerprint_sha256 && meta.fingerprint_sha256 !== c.fingerprint_sha256)
    reject("CERTIFICATE_FINGERPRINT_MISMATCH");
  let newPath = false;
  try {
    await lstat(path);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    newPath = true;
  }
  await directory(path);
  const managed = join(path, ".lightmoni-certificate-" + id);
  await directory(managed);
  const marker = await readJSON<any>(join(managed, "owner.json"), null);
  if (marker && marker.certificate_id !== id)
    reject("CERTIFICATE_DIRECTORY_OWNERSHIP_REQUIRED");
  await atomicFile(
    join(managed, "owner.json"),
    JSON.stringify({ certificate_id: id }),
  );
  const target = join(managed, "versions", version);
  await directory(target);
  if (
    !/^0?[0-7]{3}$/.test(c.mode ?? "0600") ||
    !/^0?[0-7]{3}$/.test(c.private_key_mode ?? "0600")
  )
    reject("INVALID_CERTIFICATE_PERMISSIONS");
  const certificateMode = parseInt(c.mode ?? "0600", 8),
    privateMode = parseInt(c.private_key_mode ?? "0600", 8);
  if (
    ![0o600, 0o640, 0o644].includes(certificateMode) ||
    ![0o600, 0o640].includes(privateMode)
  )
    reject("INVALID_CERTIFICATE_PERMISSIONS");
  for (const [name, body] of [
    [certName, c.certificate_pem],
    [keyName, c.private_key_pem],
  ]) {
    try {
      await safeFile(join(target, name));
      const existing = await readFile(join(target, name), "utf8");
      if (existing !== body) reject("CERTIFICATE_VERSION_IMMUTABLE");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await atomicFile(join(target, certName), c.certificate_pem, certificateMode);
  await atomicFile(join(target, keyName), c.private_key_pem, privateMode);
  const managedDirectories = [
    managed,
    join(managed, "versions"),
    target,
    ...(newPath ? [path] : []),
  ];
  for (const dir of managedDirectories)
    await chmod(dir, privateMode === 0o640 ? 0o750 : 0o700);
  for (const file of [
    join(target, certName),
    join(target, keyName),
    ...managedDirectories,
  ]) {
    for (const [field, command] of [
      ["owner", "chown"],
      ["group", "chgrp"],
    ] as const)
      if (c[field] !== undefined) {
        const val = String(c[field]);
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(val))
          reject("INVALID_CERTIFICATE_OWNER");
        await context.command(command, [val, file], { timeoutMs: 10000 });
      }
  }
  for (const name of [certName, keyName]) {
    const link = join(path, name),
      expected = join(".lightmoni-certificate-" + id, "current", name);
    try {
      if (
        !(await lstat(link)).isSymbolicLink() ||
        (await readlink(link)) !== expected
      )
        reject("CERTIFICATE_FILE_OWNERSHIP_REQUIRED");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      await symlink(expected, link);
    }
  }
  await pointer(join(managed, "current"), join("versions", version));
  const installed = new X509Certificate(await readFile(join(path, certName)));
  if (installed.fingerprint256 !== meta.fingerprint_sha256)
    throw Error("CERTIFICATE_INSTALL_NOT_VERIFIED");
  return {
    verified: true,
    data: {
      certificate_id: id,
      certificate_version: version,
      path,
      fingerprint_sha256: installed.fingerprint256,
      installed: true,
    },
  };
}
async function inspectCertificate(
  c: any,
  context: OperationExecutionContext,
): Promise<OperationExecutionResult> {
  const id = safeID(c.certificate_id),
    path = absolutePath(c.path),
    certName = c.certificate_file ?? "fullchain.pem",
    keyName = c.private_key_file ?? "privkey.pem";
  for (const name of [certName, keyName])
    if (
      typeof name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
    )
      reject("INVALID_CERTIFICATE_FILENAME");
  const managed = join(path, ".lightmoni-certificate-" + id),
    current = await readlink(join(managed, "current"));
  const match = /^versions\/([A-Za-z0-9_-]+)$/.exec(current);
  if (!match) reject("INVALID_CERTIFICATE_VERSION_POINTER");
  const meta = certificateMetadata(
    await readFile(join(managed, current, certName), "utf8"),
    await readFile(join(managed, current, keyName), "utf8"),
    c.domains ?? [],
    context.now(),
  );
  const verified =
    (!c.fingerprint_sha256 ||
      meta.fingerprint_sha256 === c.fingerprint_sha256) &&
    (!c.certificate_version || match![1] === c.certificate_version);
  return {
    verified,
    data: {
      certificate_id: id,
      certificate_version: match![1],
      fingerprint_sha256: meta.fingerprint_sha256,
      installed: true,
      ...(!verified ? { status: "unknown" } : {}),
    },
  };
}
async function runHook(
  payload: OperationPayload,
  context: OperationExecutionContext,
): Promise<OperationExecutionResult> {
  const c = payload.resource.config,
    script = text(c.script, "script", 256 * 1024),
    interpreter = c.interpreter ?? "/bin/sh";
  if (
    typeof interpreter !== "string" ||
    !/^\/[A-Za-z0-9_./-]+$/.test(interpreter) ||
    interpreter.includes("..")
  )
    reject("INVALID_SCRIPT_INTERPRETER");
  const timeout = finite(c.timeout_ms ?? 60000, 1000, 600000, "script_timeout");
  const env = environment(c.env ?? {}),
    root = join(
      await privateRoot(context, "platform"),
      "hooks",
      safeID(c.hook_id ?? payload.resource.id),
      safeID(payload.operation_id),
    );
  await directory(root);
  const scriptPath = join(root, "hook");
  await atomicFile(scriptPath, script, 0o700);
  if (c.certificate) {
    const material = object(c.certificate, "certificate");
    certificateMetadata(
      material.certificate_pem,
      material.private_key_pem,
      material.domains ?? [],
      context.now(),
    );
    await atomicFile(join(root, "fullchain.pem"), material.certificate_pem);
    await atomicFile(join(root, "privkey.pem"), material.private_key_pem);
    env.LIGHTMONI_CERTIFICATE_PATH = join(root, "fullchain.pem");
    env.LIGHTMONI_PRIVATE_KEY_PATH = join(root, "privkey.pem");
  }
  env.LIGHTMONI_CERTIFICATE_ID = String(c.certificate_id ?? "");
  env.LIGHTMONI_CERTIFICATE_VERSION = String(
    c.certificate_version ?? c.version ?? "",
  );
  await context.command(interpreter, [scriptPath], {
    cwd: root,
    env,
    timeoutMs: timeout,
    signal: context.signal,
  });
  await atomicFile(
    join(root, "result.json"),
    JSON.stringify({
      succeeded: true,
      operation_id: payload.operation_id,
      certificate_id: c.certificate_id,
      certificate_version: c.certificate_version ?? c.version,
      script_sha256: hash(script),
      finished_at: context.now().toISOString(),
    }),
  );
  return {
    verified: true,
    data: {
      hook_id: c.hook_id ?? payload.resource.id,
      certificate_id: c.certificate_id,
      certificate_version: c.certificate_version ?? c.version,
      script_sha256: hash(script),
      succeeded: true,
    },
  };
}
async function inspectHook(
  c: any,
  context: OperationExecutionContext,
): Promise<OperationExecutionResult> {
  const original = safeID(c.original_operation_id),
    root = join(
      await privateRoot(context, "platform"),
      "hooks",
      safeID(c.hook_id),
      original,
    ),
    marker = await readJSON<any>(join(root, "result.json"), null);
  const verified =
    marker?.succeeded === true &&
    marker.operation_id === original &&
    (!c.script_sha256 || marker.script_sha256 === c.script_sha256) &&
    (!c.script || marker.script_sha256 === hash(c.script)) &&
    (!c.certificate_version ||
      marker.certificate_version === c.certificate_version);
  return {
    verified,
    data: verified ? marker : { status: "unknown", succeeded: false },
  };
}

export function renderGateway(c: any, digest: string, preview = false): string {
  const base = "/etc/lightmoni/versions/" + digest,
    sites = c.sites ?? [],
    lines = [
      "worker_processes auto;",
      "pid /tmp/lightmoni-nginx.pid;",
      "error_log /dev/stderr warn;",
      "events { worker_connections 2048; }",
      "http {",
      "  include /usr/local/openresty/nginx/conf/mime.types;",
      "  default_type application/octet-stream;",
      `  log_format lightmoni_application escape=json '{"lightmoni_access":true,"website_id":"$lightmoni_website_id","status":$status,"request_time":$request_time,"upstream_addr":"$upstream_addr"}';`,
      '  map $server_name $lightmoni_website_id { default ""; }',
      "  access_log /dev/stdout lightmoni_application;",
      "  server_tokens off;",
      '  map $http_upgrade $lightmoni_connection_upgrade { default upgrade; "" ""; }',
      `  server { listen ${port(c.http_port ?? 80)} default_server; server_name _; location = /.well-known/lightmoni-gateway { default_type text/plain; return 200 ${quote(digest)}; } location / { return 404; } }`,
    ];
  for (const site of sites) {
    const siteID = safeID(site.id),
      proof = hash(JSON.stringify(site));
    const domains = strings(site.domains, "domain", 50);
    if (
      domains.some((d) => !/^\*?\.?[A-Za-z0-9.-]+$/.test(d) || d.includes(".."))
    )
      reject("INVALID_WEBSITE_DOMAIN");
    const settings = normalizeNginx(site.nginx);
    const rawRoutes =
      site.locations ??
      (site.mode === "static"
        ? []
        : [
            {
              path: "/",
              upstreams: site.upstreams ?? [],
              unavailable: site.unavailable,
            },
          ]);
    const routes = normalizeLocations(rawRoutes);
    const auth=authMaterial(site.auth), authBase=base+"/sites/"+siteID+"/auth";
    if(authScopes(site).length&&!site.certificate&&!preview)reject('WEBSITE_AUTH_REQUIRES_TLS');
    if(auth.mode==='basic'&&settings.server_snippet)reject("WEBSITE_AUTH_UNSAFE_COMBINATION");
    const rendered = renderLocations(routes, siteID, settings,{auth,base:authBase});
    lines.push(...rendered.upstreams);
    lines.push(
      "  server {",
      `    listen ${port(c.http_port ?? 80)};`,
      `    server_name ${domains.join(" ")};`,
      `    set $lightmoni_website_id "${siteID}";`,
      `    location = /.well-known/lightmoni-health { allow 127.0.0.1; allow ::1; deny all; access_log off; default_type text/plain; return 200 ${quote(proof)}; }`,
    );
    if(auth.mode==='basic')lines.push(`auth_basic ${quote(auth.realm)};`,`auth_basic_user_file ${quote(authBase+"/site.htpasswd")};`,"satisfy all;");
    for(const scope of authScopes(site))lines.push(`location = /.well-known/lightmoni-auth-${scope.key} { allow 127.0.0.1; allow ::1; deny all; satisfy all; auth_basic ${quote(scope.auth.realm)}; auth_basic_user_file ${quote(authBase+"/"+scope.key+".htpasswd")}; alias ${quote(authBase+"/proof.txt")}; access_log off; default_type text/plain; }`);
    if (site.certificate) {
      if (!preview)
        certificateMetadata(
          site.certificate.certificate_pem,
          site.certificate.private_key_pem,
          domains,
          undefined,
        );
      lines.push(
        `    listen ${port(c.https_port ?? 443)} ssl;`,
        `    ssl_protocols ${settings.tls_protocols.join(" ")};`,
        ...(settings.http2 ? ["    http2 on;"] : []),
        `    ssl_certificate ${quote(base + "/sites/" + siteID + "/fullchain.pem")};`,
        `    ssl_certificate_key ${quote(base + "/sites/" + siteID + "/privkey.pem")};`,
      );
    }
    lines.push(...renderNginxOptions(settings).map(line => line === 'access_log /dev/stdout;' ? 'access_log /dev/stdout lightmoni_application;' : line));
    const redirect =
      (settings.redirect_https || authScopes(site).length>0) && site.certificate
        ? `if ($scheme = http) { return 308 https://$host${Number(c.https_port ?? 443) === 443 ? "" : ":" + port(c.https_port)}$request_uri; }`
        : "";
    // Redirects belong to user locations so the internal deployment proof remains reachable.
    if (redirect)
      for (let n = 0; n < rendered.locations.length; n++)
        if (rendered.locations[n].startsWith("location "))
          rendered.locations.splice(++n, 0, redirect);
    if (site.mode === "static") {
      lines.push(
        `    root ${quote(base + "/sites/" + siteID + "/public")};`,
        `    index ${settings.index.join(" ")};`,
        `    autoindex ${settings.autoindex ? "on" : "off"};`,
        ...(settings.expires_seconds
          ? [`expires ${settings.expires_seconds}s;`]
          : []),
        ...(!routes.some(
          (r) =>
            r.path === "/" && ["prefix", "prefer_prefix"].includes(r.match),
        )
          ? [
              `location / { ${redirect} try_files $uri $uri/ ${settings.spa_fallback ? "/" + settings.index[0] : "=404"}; }`,
            ]
          : []),
      );
    } else if (
      !routes.some(
        (r) => r.path === "/" && ["prefix", "prefer_prefix"].includes(r.match),
      )
    )
      lines.push(`location / { ${redirect} return 404; }`);
    lines.push(...rendered.locations);
    lines.push("  }");
  }
  return lines.concat("}").join("\n") + "\n";
}
async function gatewayContainer(
  context: OperationExecutionContext,
  id: string,
) {
  const answer = await context.command(
    "docker",
    ["ps", "-aq", "--filter", "name=^lm-gateway-" + id + "$"],
    { timeoutMs: 15000 },
  );
  if (!answer.stdout.trim()) return null;
  const entries = JSON.parse(
    (
      await context.command("docker", ["inspect", "lm-gateway-" + id], {
        timeoutMs: 15000,
      })
    ).stdout,
  );
  const container = entries[0];
  if (container?.Config?.Labels?.[INSTANCE_LABEL] !== id)
    reject("GATEWAY_OWNERSHIP_REQUIRED");
  return container;
}
async function gatewayProof(
  c: any,
  digest: string,
  context: OperationExecutionContext,
) {
  const gateway = await probeHTTP(
    c.http_port ?? 80,
    "_",
    "/.well-known/lightmoni-gateway",
    false,
    context.signal,
  );
  if (gateway.status !== 200 || gateway.text !== digest)
    throw Error("GATEWAY_VERSION_NOT_ACTIVE");
  for (const s of c.sites ?? []) {
    const proof = await probeHTTP(
      c.http_port ?? 80,
      s.domains[0],
      "/.well-known/lightmoni-health",
      false,
      context.signal,
    );
    if (proof.status !== 200 || proof.text !== hash(JSON.stringify(s)))
      throw Error("WEBSITE_VERSION_NOT_ACTIVE");
    if(authScopes(s).length){
      const version=join(await privateRoot(context,"platform"),"gateways",safeID(c.instance_id),"versions",digest);
      const probe=await readJSON<any>(join(version,"auth-probe.json"),null);
      if(!probe)throw Error("WEBSITE_AUTH_PROOF_REQUIRED");
      for(const scope of authScopes(s)){
        const path="/.well-known/lightmoni-auth-"+scope.key;
        const anonymous=await probeHTTP(c.http_port??80,s.domains[0],path,false,context.signal);
        const positive=await probeHTTP(c.http_port??80,s.domains[0],path,false,context.signal,{Authorization:"Basic "+Buffer.from(probe.username+":"+probe.password).toString("base64")});
        if(anonymous.status!==401||positive.status!==200||positive.text!==digest)throw Error("WEBSITE_AUTH_NOT_ACTIVE");
      }
    }
    if (s.certificate) {
      const tls = await probeHTTP(
        c.https_port ?? 443,
        s.domains[0],
        "/.well-known/lightmoni-health",
        true,
        context.signal,
      );
      if (
        tls.peer_fingerprint_sha256 !==
          new X509Certificate(s.certificate.certificate_pem).fingerprint256 ||
        tls.text !== hash(JSON.stringify(s))
      )
        throw Error("WEBSITE_TLS_NOT_ACTIVE");
    }
  }
}
async function executeGateway(
  payload: OperationPayload,
  context: OperationExecutionContext,
): Promise<OperationExecutionResult> {
  const c = payload.resource.config,
    id = safeID(c.instance_id),
    name = "lm-gateway-" + id,
    root = join(await privateRoot(context, "platform"), "gateways", id);
  await directory(root);
  const statePath = join(root, "state.json"),
    state = await readJSON<any>(statePath, null);
  let existing: any;
  await context.progress?.("checking_docker");
  try {
    existing = await gatewayContainer(context, id);
  } catch (error) {
    if (error instanceof OperationRejectedError) throw error;
    throw Object.assign(new OperationRejectedError("DOCKER_PREREQUISITE_FAILED"), {diagnosticCode: installCause(error)});
  }
  if (c.task === "gateway.inspect") {
    let healthy = existing?.State?.Running === true && !!state;
    try {
      if (healthy) await gatewayProof(state.config, state.digest, context);
    } catch {
      healthy = false;
    }
    return {
      verified: true,
      data: {
        instance_id: id,
        running: existing?.State?.Running === true,
        healthy,
        digest: state?.digest ?? "",
        network_mode: existing?.HostConfig?.NetworkMode ?? "",
        observed_at: context.now().toISOString(),
      },
    };
  }
  if (c.task === "gateway.logs") {
    if (!existing) reject("CONTAINER_NOT_FOUND");
    const tail = Number(c.tail ?? 100);
    if (!Number.isInteger(tail) || tail < 1 || tail > 500)
      reject("INVALID_LOG_TAIL");
    const output = await context.command(
      "docker",
      ["logs", "--tail", String(tail), name],
      { timeoutMs: 15000 },
    );
    return {
      verified: true,
      data: {
        instance_id: id,
        text: (output.stdout + output.stderr).slice(-32000),
        sensitive_logs: true,
      },
    };
  }
  if (c.task === "gateway.remove") {
    if (existing)
      await context.command("docker", ["rm", "--force", name], {
        timeoutMs: 30000,
      });
    if (await gatewayContainer(context, id))
      throw Error("GATEWAY_REMOVE_NOT_VERIFIED");
    return {
      verified: true,
      data: { instance_id: id, removed: true, stopped: true, healthy: false },
    };
  }
  if (c.task === "gateway.stop") {
    if (existing)
      await context.command("docker", ["stop", "--time", "20", name], {
        timeoutMs: 30000,
      });
    if ((await gatewayContainer(context, id))?.State?.Running)
      throw Error("GATEWAY_STOP_NOT_VERIFIED");
    return {
      verified: true,
      data: { instance_id: id, stopped: true, healthy: false },
    };
  }
  if (!existing?.State?.Running)
    for (const p of [c.http_port ?? 80, c.https_port ?? 443])
      await availablePort(
        { host_port: p, protocol: "tcp", host_ip: "0.0.0.0" },
        context,
      );
  const image = text(
      c.image ?? "openresty/openresty:1.27.1.2-0-alpine",
      "image",
      512,
    ),
    digest = hash(
      JSON.stringify({
        image,
        sites: c.sites ?? [],
        http_port: c.http_port ?? 80,
        https_port: c.https_port ?? 443,
      }),
    ),
    version = join(root, "versions", digest);
  await directory(version);
  for (const path of [
    root,
    join(root, "versions"),
    version,
    join(version, "sites"),
  ]) {
    await directory(path, 0o755);
    await chmod(path, 0o755);
  }
  let authProbe=await readJSON<any>(join(version,"auth-probe.json"),null);
  if((c.sites??[]).some((s:any)=>authScopes(s).length)&&!authProbe){
    authProbe={username:"lm-probe-"+randomBytes(8).toString('hex'),password:randomBytes(32).toString('hex')};
    authProbe.password_hash=hashSync(authProbe.password,10);
    await atomicFile(join(version,"auth-probe.json"),JSON.stringify(authProbe));
  }
  for (const s of c.sites ?? []) {
    const target = join(version, "sites", safeID(s.id));
    await directory(target, 0o755);
    await chmod(target, 0o755);
    for(const scope of authScopes(s)){
      const authDir=join(target,"auth");await directory(authDir,0o755);
      // Private hashes and probe credentials never enter the static root or nginx text.
      await atomicFile(join(authDir,scope.key+".htpasswd"),scope.auth.users.map(u=>u.username+":"+u.password_hash).concat(authProbe.username+":"+authProbe.password_hash).join("\n")+"\n",0o644);
      await atomicFile(join(authDir,"proof.txt"),digest,0o644);
    }
    if (s.mode === "static") {
      const publicPath = join(target, "public");
      const entries = files(
        s.static_files ?? { "index.html": "<!doctype html><h1>LightMoni</h1>" },
      );
      for (const [name, body] of Object.entries(entries)) {
        const path = join(publicPath, name);
        await directory(dirname(path), 0o755);
        let parent = dirname(path);
        while (parent.startsWith(publicPath)) {
          await chmod(parent, 0o755);
          parent = dirname(parent);
        }
        await atomicFile(path, body, 0o644);
      }
    }
    if (s.certificate) {
      certificateMetadata(
        s.certificate.certificate_pem,
        s.certificate.private_key_pem,
        s.domains,
        context.now(),
      );
      await atomicFile(
        join(target, "fullchain.pem"),
        s.certificate.certificate_pem,
      );
      await atomicFile(
        join(target, "privkey.pem"),
        s.certificate.private_key_pem,
      );
    }
  }
  await atomicFile(join(version, "nginx.conf"), renderGateway(c, digest));
  const mount = "type=bind,src=" + root + ",dst=/etc/lightmoni,readonly";
  await context.progress?.("validating_gateway");
  try {
    await context.command(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "host",
        "--mount",
        mount,
        image,
        "openresty",
        "-t",
        "-c",
        "/etc/lightmoni/versions/" + digest + "/nginx.conf",
      ],
      { timeoutMs: 120000 },
    );
  } catch (error) {
    throw Object.assign(new OperationRejectedError("GATEWAY_PREFLIGHT_FAILED"), {diagnosticCode:installCause(error)});
  }
  const previous = await pointer(
    join(root, "current"),
    join("versions", digest),
  );
  let recreated = false;
  await context.progress?.("starting_gateway");
  try {
    if (existing && existing.Config.Image !== image) {
      await context.command("docker", ["rm", "--force", name], {
        timeoutMs: 30000,
      });
      recreated = true;
    }
    if (!existing || recreated)
      await context.command(
        "docker",
        [
          "run",
          "--detach",
          "--name",
          name,
          "--network",
          "host",
          "--restart",
          "unless-stopped",
          "--label",
          INSTANCE_LABEL + "=" + id,
          "--label",
          OWNER_LABEL + "=lightmoni",
          "--mount",
          mount,
          image,
          "openresty",
          "-g",
          "daemon off;",
          "-c",
          "/etc/lightmoni/current/nginx.conf",
        ],
        { timeoutMs: 120000 },
      );
    else if (!existing.State?.Running)
      await context.command("docker", ["start", name], { timeoutMs: 30000 });
    else
      await context.command(
        "docker",
        [
          "exec",
          name,
          "openresty",
          "-s",
          "reload",
          "-c",
          "/etc/lightmoni/current/nginx.conf",
        ],
        { timeoutMs: 30000 },
      );
    let okay = false;
    for (let i = 0; i < 30; i++) {
      try {
        await gatewayProof(c, digest, context);
        okay = true;
        break;
      } catch {
        context.signal.throwIfAborted();
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (!okay) throw Error("GATEWAY_VERIFICATION_FAILED");
    await atomicFile(
      statePath,
      JSON.stringify({
        version: 1,
        digest,
        image,
        config: c,
        updated_at: context.now().toISOString(),
      }),
    );
    return {
      verified: true,
      data: {
        instance_id: id,
        digest,
        healthy: true,
        running: true,
        network_mode: "host",
        websites: (c.sites ?? []).map((s: any) => ({
          id: s.id,
          domains: s.domains,
          https: !!s.certificate,
        })),
        observed_at: context.now().toISOString(),
      },
    };
  } catch (error) {
    await context.progress?.("restoring_previous", installCause(error));
    try {
      if (previous && state) {
        await pointer(join(root, "current"), previous);
        if (recreated) {
          await context.command("docker", ["rm", "--force", name], {
            timeoutMs: 30000,
          });
          await context.command(
            "docker",
            [
              "run",
              "--detach",
              "--name",
              name,
              "--network",
              "host",
              "--restart",
              "unless-stopped",
              "--label",
              INSTANCE_LABEL + "=" + id,
              "--label",
              OWNER_LABEL + "=lightmoni",
              "--mount",
              mount,
              state.image,
              "openresty",
              "-g",
              "daemon off;",
              "-c",
              "/etc/lightmoni/current/nginx.conf",
            ],
            { timeoutMs: 120000 },
          );
        } else
          await context.command(
            "docker",
            [
              "exec",
              name,
              "openresty",
              "-s",
              "reload",
              "-c",
              "/etc/lightmoni/current/nginx.conf",
            ],
            { timeoutMs: 30000 },
          );
        await gatewayProof(state.config, state.digest, context);
      } else {
        await context.command("docker", ["rm", "--force", name], {
          timeoutMs: 30000,
        });
        await unlink(join(root, "current")).catch(() => {});
      }
    } catch {
      throw Object.assign(Error("GATEWAY_APPLY_RECOVERY_FAILED"), {diagnosticCode:installCause(error)});
    }
    throw Object.assign(new OperationRejectedError("GATEWAY_APPLY_FAILED_RESTORED"), {diagnosticCode:installCause(error)});
  }
}
export async function executePlatform(
  payload: OperationPayload,
  context: OperationExecutionContext,
): Promise<OperationExecutionResult> {
  const c = platformDefinition.validate(payload.resource.config);
  payload = { ...payload, resource: { ...payload.resource, config: c } };
  if (c.task === "node.inspect") {
    const addresses = Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? [])
        .filter((address) => !address.internal)
        .map((address) => ({
          address: address.address,
          family: address.family,
        })),
    );
    let docker_version = "",
      docker_available = false;
    try {
      const response = await context.command(
        "docker",
        ["info", "--format", "{{json .ServerVersion}}"],
        { timeoutMs: 15000 },
      );
      docker_version = JSON.parse(response.stdout);
      docker_available =
        typeof docker_version === "string" && Boolean(docker_version);
    } catch {}
    return {
      verified: true,
      data: {
        node: {
          cpu: cpus().length,
          memory_mb: Math.floor(totalmem() / 1048576),
          memory_free_mb: Math.floor(freemem() / 1048576),
          load: loadavg(),
          address:
            addresses.find((a) => a.family === "IPv4")?.address ??
            addresses[0]?.address ??
            "",
          addresses,
          docker_available,
          docker_version,
        },
        observed_at: context.now().toISOString(),
      },
    };
  }
  if (c.task.startsWith("workload.")) return executeWorkload(payload, context);
  if (c.task.startsWith("gateway.")) return executeGateway(payload, context);
  if (c.task === "certificate.install") return installCertificate(c, context);
  if (c.task === "certificate.inspect") return inspectCertificate(c, context);
  if (c.task === "hook.run") return runHook(payload, context);
  if (c.task === "hook.inspect") return inspectHook(c, context);
  return reject("INVALID_PLATFORM_TASK");
}
