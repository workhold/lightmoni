import { constants } from "node:fs";
import { open, mkdir, lstat, realpath, rename, rm, unlink } from "node:fs/promises";
import { OperationRejectedError } from "./errors.js";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import type { OperationConfig, OperationDefinition, OperationExecutionContext, OperationExecutionResult, OperationPayload } from "./types.js";

const OWNER = "io.lightmoni.operations.resource";
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const RESOURCE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const CID = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_CONFIG = 128 * 1024, MAX_OUTPUT = 512 * 1024, MAX_LOGS = 64 * 1024;
const operations = ["discover", "inspect", "logs", "adopt", "apply", "start", "stop", "restart", "rollback"] as const;
const readOnly: readonly string[] = ["discover", "inspect", "logs"];
type Config = { project_name: string; compose: Record<string, any>; service_id?: string };
type Snapshot = { generation: number; resource_revision: number; file: string; sha256: string; operation_id: string; operation: string; created_at: string };
type State = { version: 1; resource_id: string; project_name: string; generation: number; history: Snapshot[]; adopted_volumes: string[]; adopted_networks: string[] };
type Pending = { operation_id: string; generation: number; operation: string; candidate: string; sha256: string; adopted_volumes: string[]; adopted_networks: string[] };
type Inventory = { containers: any[]; volumes: Array<{ name: string; owner: string; project: string }>; networks: Array<{ id: string; name: string; owner: string; project: string }>; sha256: string };
function bad(message: string): never { throw new OperationRejectedError(`Compose: ${message}`); }
function object(value: unknown, field: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad(`${field} must be an object`);
  return value as Record<string, any>;
}
function only(value: Record<string, any>, allowed: readonly string[], field: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) bad(`${field} contains an unsupported field`);
}
function text(value: unknown, field: string, max = 1024): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) bad(`${field} is invalid`);
  return value;
}
function names(value: unknown, field: string, allowed: Set<string>): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((entry) => typeof entry !== "string" || !KEY.test(entry) || !allowed.has(entry))) bad(`${field} must contain registered names`);
  return [...new Set(value)] as string[];
}
function strings(value: unknown, field: string, maximum = 64): string[] {
  if (!Array.isArray(value) || value.length > maximum) bad(`${field} must be a bounded string array`);
  return value.map((entry) => text(entry, field, 4096));
}
function target(value: unknown): string {
  const result = text(value, "volume target", 512);
  if (!result.startsWith("/") || result === "/" || result.split("/").includes("..") || /[\r\n\\]/.test(result)) bad("volume target must be a container absolute path");
  return result;
}
function mount(value: unknown, registered: Set<string>): { source: string; target: string; read_only: boolean } {
  if (typeof value === "string") {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}):(\/[^:]+)(?::(ro|rw))?$/.exec(value);
    if (!match || !registered.has(match[1])) bad("only declared project-scoped named volume mounts are supported; host bind mounts are forbidden");
    return { source: match[1], target: target(match[2]), read_only: match[3] === "ro" };
  }
  const result = object(value, "volume mount");
  only(result, ["type", "source", "target", "read_only"], "volume mount");
  if (result.type !== "volume" || !registered.has(result.source) || result.read_only !== undefined && typeof result.read_only !== "boolean") bad("only declared project-scoped named volume mounts are supported");
  return { source: result.source, target: target(result.target), read_only: result.read_only === true };
}
function ports(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) bad("ports must be a bounded array");
  return value.map((port) => {
    if (typeof port !== "string" || !/^(?:(?:127\.0\.0\.1|0\.0\.0\.0):)?[1-9][0-9]{0,4}:[1-9][0-9]{0,4}(?:\/(?:tcp|udp))?$/.test(port)) bad("ports must use [127.0.0.1:|0.0.0.0:]published:target[/tcp|/udp]");
    if (port.replace(/\/(tcp|udp)$/, "").split(":").slice(-2).map(Number).some((n) => n > 65535)) bad("port is outside 1..65535");
    return port;
  });
}
function labels(value: unknown): Record<string, string> {
  const input = object(value, "labels"), result: Record<string, string> = {};
  if (Object.keys(input).length > 32) bad("too many labels");
  for (const [key, val] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.\/-]{0,127}$/.test(key) || /^(?:com\.docker\.compose\.|io\.lightmoni\.)/.test(key)) bad("reserved or invalid label");
    if (typeof val !== "string" || val.length > 512 || /[\0\r\n]/.test(val)) bad("invalid label value");
    result[key] = val;
  }
  return result;
}
function validate(value: unknown): Config {
  const config = object(value, "configuration");
  only(config, ["project_name", "compose", "service_id"], "configuration");
  if (typeof config.project_name !== "string" || !PROJECT.test(config.project_name)) bad("project_name must use lowercase letters, digits, underscores or hyphens (48 characters maximum)");
  if (config.service_id != null && config.service_id !== "" && (typeof config.service_id !== "string" || !RESOURCE.test(config.service_id))) bad("service_id is invalid");
  const doc = object(config.compose, "compose"); only(doc, ["services", "volumes", "networks"], "compose");
  const services = object(doc.services, "services");
  if (!Object.keys(services).length || Object.keys(services).length > 20 || Object.keys(services).some((key) => !KEY.test(key))) bad("compose must contain 1..20 valid service names");
  const volumes = doc.volumes === undefined ? {} : object(doc.volumes, "volumes"), networks = doc.networks === undefined ? {} : object(doc.networks, "networks");
  for (const [field, entries] of [["volumes", volumes], ["networks", networks]] as const) {
    if (Object.keys(entries).length > 20) bad(`too many ${field}`);
    for (const [name, definition] of Object.entries(entries)) {
      if (!KEY.test(name)) bad(`invalid ${field} name`);
      if (Object.keys(object(definition, field)).length) bad(`${field} only support empty project-scoped declarations; external names, drivers and host paths are forbidden`);
    }
  }
  const result: Config = { project_name: config.project_name, compose: { services: {} } };
  if (config.service_id != null && config.service_id !== "") result.service_id = config.service_id;
  if (Object.keys(volumes).length) result.compose.volumes = Object.fromEntries(Object.keys(volumes).map((key) => [key, {}]));
  if (Object.keys(networks).length) result.compose.networks = Object.fromEntries(Object.keys(networks).map((key) => [key, {}]));
  const volumeNames = new Set(Object.keys(volumes)), networkNames = new Set(["default", ...Object.keys(networks)]), serviceNames = new Set(Object.keys(services));
  for (const [name, value] of Object.entries(services)) {
    const service = object(value, "service");
    only(service, ["image", "restart", "ports", "volumes", "environment", "command", "entrypoint", "working_dir", "user", "healthcheck", "depends_on", "networks", "labels", "mem_limit", "cpus", "read_only", "init", "stop_grace_period", "cap_drop"], "service");
    const image = text(service.image, "image", 256), tag = image.slice(image.lastIndexOf("/") + 1);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9./_:-]*(?:@sha256:[a-f0-9]{64})?$/.test(image) || !image.includes("@sha256:") && (!tag.includes(":") || tag.slice(tag.lastIndexOf(":") + 1).toLowerCase() === "latest" || !tag.split(":").at(-1))) bad("image must have an explicit version tag or sha256 digest; latest and untagged images are forbidden");
    const output: Record<string, any> = { image };
    if (service.restart !== undefined) {
      if (typeof service.restart !== "string" || !/^(?:no|always|unless-stopped|on-failure(?::[1-9][0-9]?)?)$/.test(service.restart)) bad("invalid restart policy");
      output.restart = service.restart;
    }
    if (service.ports !== undefined) output.ports = ports(service.ports);
    if (service.volumes !== undefined) {
      if (!Array.isArray(service.volumes) || service.volumes.length > 20) bad("too many mounts");
      output.volumes = service.volumes.map((entry: unknown) => ({ type: "volume", ...mount(entry, volumeNames) }));
      if (new Set(output.volumes.map((entry: any) => entry.target)).size !== output.volumes.length) bad("duplicate volume targets");
    }
    if (service.environment !== undefined) {
      const env = object(service.environment, "environment");
      if (Object.keys(env).length > 100) bad("too many environment variables");
      output.environment = {};
      for (const [key, val] of Object.entries(env)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(key) || typeof val !== "string" || val.length > 4096 || val.includes("\0")) bad("environment must contain bounded literal string values");
        output.environment[key] = val;
      }
    }
    for (const field of ["command", "entrypoint"] as const) if (service[field] !== undefined) output[field] = strings(service[field], field);
    for (const field of ["working_dir", "user"] as const) if (service[field] !== undefined) output[field] = text(service[field], field, 256);
    if (output.working_dir && (!output.working_dir.startsWith("/") || output.working_dir.split("/").includes(".."))) bad("working_dir must be a container absolute path");
    if (output.user && !/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,127}$/.test(output.user)) bad("invalid container user");
    if (service.depends_on !== undefined) output.depends_on = names(service.depends_on, "depends_on", serviceNames);
    if (service.networks !== undefined) output.networks = names(service.networks, "networks", networkNames);
    if (service.labels !== undefined) output.labels = labels(service.labels);
    if (service.mem_limit !== undefined) {
      if (typeof service.mem_limit !== "string" || !/^[1-9][0-9]{0,8}[bkmg]$/i.test(service.mem_limit)) bad("mem_limit must be a bounded amount such as 512m");
      output.mem_limit = service.mem_limit;
    }
    if (service.cpus !== undefined) {
      if (typeof service.cpus !== "number" || !Number.isFinite(service.cpus) || service.cpus < 0.1 || service.cpus > 64) bad("cpus must be between 0.1 and 64");
      output.cpus = service.cpus;
    }
    for (const field of ["read_only", "init"] as const) if (service[field] !== undefined) {
      if (typeof service[field] !== "boolean") bad(`${field} must be boolean`);
      output[field] = service[field];
    }
    if (service.stop_grace_period !== undefined) {
      if (typeof service.stop_grace_period !== "string" || !/^[1-9][0-9]{0,2}s$/.test(service.stop_grace_period)) bad("stop_grace_period must be 1..999 seconds");
      output.stop_grace_period = service.stop_grace_period;
    }
    if (service.cap_drop !== undefined) {
      const drops = strings(service.cap_drop, "cap_drop", 40);
      if (drops.some((cap) => !/^[A-Z_]{2,32}$/.test(cap))) bad("invalid cap_drop");
      output.cap_drop = drops;
    }
    if (service.healthcheck !== undefined) {
      const health = object(service.healthcheck, "healthcheck"); only(health, ["test", "interval", "timeout", "retries", "start_period"], "healthcheck");
      const check = strings(health.test, "healthcheck.test", 32);
      if (!["CMD", "CMD-SHELL"].includes(check[0]) || check.length < 2) bad("healthcheck must use CMD or CMD-SHELL inside the container");
      output.healthcheck = { test: check };
      for (const field of ["interval", "timeout", "start_period"]) if (health[field] !== undefined) {
        if (typeof health[field] !== "string" || !/^[1-9][0-9]{0,3}(?:ms|s|m)$/.test(health[field])) bad("invalid healthcheck duration");
        output.healthcheck[field] = health[field];
      }
      if (health.retries !== undefined) {
        if (!Number.isSafeInteger(health.retries) || health.retries < 1 || health.retries > 20) bad("healthcheck retries must be 1..20");
        output.healthcheck.retries = health.retries;
      }
    }
    result.compose.services[name] = output;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_CONFIG) bad("configuration exceeds 128 KiB");
  return result;
}
function validateInput(operation: string, value: unknown, config: OperationConfig): OperationConfig {
  if (!(operations as readonly string[]).includes(operation)) bad("unsupported operation");
  const input = value == null ? {} : object(value, "input");
  const allowed = operation === "logs" ? ["container_id", "tail"] : readOnly.includes(operation) ? [] : ["expected_generation", ...(operation === "adopt" ? ["inventory_sha256", "acknowledge_recreate"] : []), ...(operation === "rollback" ? ["target_generation", "acknowledge_unknown"] : []), ...(operation === "apply" ? ["acknowledge_unknown"] : []), ...(["start", "stop", "restart"].includes(operation) ? ["service"] : [])];
  only(input, allowed, "input"); const result: Record<string, any> = {};
  if (!readOnly.includes(operation)) {
    if (!Number.isSafeInteger(input.expected_generation) || input.expected_generation < 0) bad("expected_generation is required and must be a nonnegative integer");
    result.expected_generation = input.expected_generation;
  }
  if (operation === "logs") {
    if (typeof input.container_id !== "string" || !CID.test(input.container_id)) bad("logs require a complete container_id");
    if (input.tail !== undefined && (!Number.isSafeInteger(input.tail) || input.tail < 1 || input.tail > 500)) bad("log tail must be between 1 and 500");
    result.container_id = input.container_id; result.tail = input.tail ?? 200;
  }
  if (input.service !== undefined) {
    if (typeof input.service !== "string" || !Object.hasOwn(config.compose.services, input.service)) bad("service is not declared in this project");
    result.service = input.service;
  }
  if (operation === "adopt") {
    if (input.expected_generation !== 0 || input.acknowledge_recreate !== true) bad("adopt requires generation zero and explicit acknowledgement that containers will be recreated");
    if (typeof input.inventory_sha256 !== "string" || !SHA.test(input.inventory_sha256)) bad("adopt requires the inspected inventory_sha256");
    result.inventory_sha256 = input.inventory_sha256; result.acknowledge_recreate = true;
  }
  if (operation === "rollback") {
    if (!Number.isSafeInteger(input.target_generation) || input.target_generation < 1 || input.target_generation > input.expected_generation) bad("target_generation must identify an existing earlier configuration");
    result.target_generation = input.target_generation;
  }
  if (input.acknowledge_unknown !== undefined) {
    if (typeof input.acknowledge_unknown !== "boolean") bad("acknowledge_unknown must be boolean");
    result.acknowledge_unknown = input.acknowledge_unknown;
  }
  return result;
}
export const composeDefinition: OperationDefinition = {
  kind: "compose", operations, readOnly, validate,
  publicConfig(config) {
    const visible = structuredClone(config);
    for (const service of Object.values(visible.compose.services) as any[]) {
      if (service.environment) service.environment = Object.fromEntries(Object.keys(service.environment).map((key) => [key, "[redacted]"]));
      if (service.command) service.command = "[redacted]";
      if (service.entrypoint) service.entrypoint = "[redacted]";
      if (service.healthcheck?.test) service.healthcheck.test = "[redacted]";
    }
    return visible;
  }, validateInput,
};
function sha(value: string) { return createHash("sha256").update(value).digest("hex"); }
function clean(value: unknown, max = 256) { return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, max) : ""; }
function summary(container: any) {
  const metadata = container.Config?.Labels ?? {};
  return { id: clean(container.Id, 64), name: clean(container.Name).replace(/^\//, ""), image: clean(container.Config?.Image), state: clean(container.State?.Status, 32), running: container.State?.Running === true, exit_code: Number.isInteger(container.State?.ExitCode) ? container.State.ExitCode : null, health: clean(container.State?.Health?.Status, 32) || null, project: clean(metadata["com.docker.compose.project"], 64), service: clean(metadata["com.docker.compose.service"], 64), managed_by: clean(metadata[OWNER], 128) || null, mounts: (container.Mounts ?? []).slice(0, 40).map((entry: any) => ({ type: clean(entry.Type, 16), target: clean(entry.Destination), volume: entry.Type === "volume" ? clean(entry.Name) : null })) };
}
async function docker(context: OperationExecutionContext, args: string[], options: Parameters<OperationExecutionContext["command"]>[2] = {}) {
  context.signal.throwIfAborted();
  try {
    // HOME may contain a persisted remote currentContext even after Docker
    // environment variables are removed. Always bind this Agent to default.
    const output = await context.command("docker", ["--context", "default", ...args], { timeoutMs: 90_000, signal: context.signal, ...options });
    if (Buffer.byteLength(output.stdout) > MAX_OUTPUT || Buffer.byteLength(output.stderr) > MAX_OUTPUT) bad("Docker output exceeds the bounded result limit");
    return output;
  } catch { bad("Docker command failed; inspect the node locally for details (command output withheld)"); }
}
function lines(value: string, max = 200): any[] {
  const entries = value.trim() ? value.trim().split("\n") : [];
  if (entries.length > max) bad("Docker inventory exceeds the supported project limit");
  try { return entries.map((entry) => JSON.parse(entry)); } catch { bad("Docker returned invalid inventory data"); }
}
async function preflight(context: OperationExecutionContext) {
  await docker(context, ["version", "--format", "{{json .Server.Version}}"]);
  const version = (await docker(context, ["compose", "version", "--short"])).stdout.trim().replace(/^v/, ""), parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!parts || Number(parts[1]) < 2 || Number(parts[1]) === 2 && Number(parts[2]) < 20) bad("Docker Compose v2.20 or newer is required");
}
async function inventory(config: Config, context: OperationExecutionContext): Promise<Inventory> {
  const rows = lines((await docker(context, ["ps", "--all", "--no-trunc", "--filter", `label=com.docker.compose.project=${config.project_name}`, "--format", "{{json .}}"])).stdout, 100), ids = rows.map((row) => row.ID);
  if (ids.some((id) => typeof id !== "string" || !CID.test(id)) || new Set(ids).size !== ids.length) bad("Docker returned invalid container identifiers");
  let containers: any[] = [];
  if (ids.length) {
    try { containers = JSON.parse((await docker(context, ["inspect", "--type", "container", ...ids])).stdout); } catch { bad("Docker container inspection failed"); }
    if (!Array.isArray(containers) || containers.length !== ids.length || containers.some((container) => !ids.includes(container.Id) || container.Config?.Labels?.["com.docker.compose.project"] !== config.project_name)) bad("Docker inventory changed during inspection");
  }
  const volumes = new Map<string, Inventory["volumes"][number]>(), networks = new Map<string, Inventory["networks"][number]>();
  // Include generated names: an unlabeled pre-existing volume must not be
  // silently reused by a freshly managed project.
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const volumeFilters = [`label=com.docker.compose.project=${config.project_name}`, ...Object.keys(config.compose.volumes ?? {}).map((name) => `name=^${escaped(`${config.project_name}_${name}`)}$`)];
  const networkNames = [...new Set(["default", ...Object.keys(config.compose.networks ?? {})])];
  const networkFilters = [`label=com.docker.compose.project=${config.project_name}`, ...networkNames.map((name) => `name=^${escaped(`${config.project_name}_${name}`)}$`)];
  for (const filter of volumeFilters) for (const row of lines((await docker(context, ["volume", "ls", "--filter", filter, "--format", "{{json .}}"])).stdout, 100)) {
    if (typeof row.Name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(row.Name)) bad("invalid Docker volume name");
    volumes.set(row.Name, { name: row.Name, owner: "", project: "" });
  }
  for (const filter of networkFilters) for (const row of lines((await docker(context, ["network", "ls", "--no-trunc", "--filter", filter, "--format", "{{json .}}"])).stdout, 100)) {
    if (typeof row.Name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(row.Name) || typeof row.ID !== "string") bad("invalid Docker network");
    networks.set(row.Name, { name: row.Name, id: row.ID, owner: "", project: "" });
  }
  for (const [type, entries] of [["volume", volumes], ["network", networks]] as const) if (entries.size) {
    let details: any[];
    try { details = JSON.parse((await docker(context, [type, "inspect", ...entries.keys()])).stdout); } catch { bad("Docker project storage inspection failed"); }
    if (!Array.isArray(details) || details.length !== entries.size) bad("Docker project storage inventory changed");
    for (const detail of details) {
      const item = entries.get(detail.Name);
      if (!item || detail.Driver !== (type === "volume" ? "local" : "bridge") || type === "volume" && detail.Options && Object.keys(detail.Options).length || type === "network" && (detail.Internal === true || detail.ConfigOnly === true)) bad("project storage or network has unsupported driver/options");
      item.owner = clean(detail.Labels?.[OWNER], 128); item.project = clean(detail.Labels?.["com.docker.compose.project"], 64);
    }
  }
  const fingerprint = { containers: containers.map((c) => ({ ...summary(c), mounts: (c.Mounts ?? []).map((m: any) => ({ type: m.Type, name: m.Name ?? "", source: m.Type === "bind" ? m.Source : "", target: m.Destination })) })).sort((a, b) => a.id.localeCompare(b.id)), volumes: [...volumes.values()].sort((a, b) => a.name.localeCompare(b.name)), networks: [...networks.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  return { containers, volumes: fingerprint.volumes, networks: fingerprint.networks, sha256: sha(JSON.stringify(fingerprint)) };
}
async function directory(path: string) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error: any) { if (error?.code !== "EEXIST") throw error; }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0 || metadata.uid !== (process.geteuid?.() ?? metadata.uid)) bad("managed directory must be owned by the Agent user, not symbolic and not writable by other users");
}
async function read(path: string): Promise<any | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 1024 * 1024 || (metadata.mode & 0o077) !== 0 || metadata.uid !== (process.geteuid?.() ?? metadata.uid)) bad("managed state file has unsafe ownership, permissions or size");
    const source = await file.readFile("utf8");
    try { return JSON.parse(source); } catch { bad("managed state file contains invalid JSON (contents withheld)"); }
  } catch (error: any) { if (error?.code === "ENOENT") return undefined; if (error?.code === "ELOOP") bad("managed file must not be a symbolic link"); throw error; }
  finally { await file?.close(); }
}
async function write(path: string, data: unknown) {
  const old = await lstat(path).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (old && (!old.isFile() || old.isSymbolicLink())) bad("managed file must be a regular file");
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`, file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(typeof data === "string" ? data : JSON.stringify(data, null, 2)); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, path); } finally { await rm(temp, { force: true }); }
}
function stateFrom(value: any, resourceID: string, project: string): State | undefined {
  if (value === undefined) return undefined;
  if (value.version !== 1 || value.resource_id !== resourceID || value.project_name !== project || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Array.isArray(value.history) || value.history.length > 1000 || !Array.isArray(value.adopted_volumes) || !Array.isArray(value.adopted_networks)) bad("managed project state is invalid or project_name changed; create a separate resource to rename a project");
  for (const snapshot of value.history) if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 || !/^generation-[1-9][0-9]*\.json$/.test(snapshot.file) || !SHA.test(snapshot.sha256 ?? "")) bad("invalid managed configuration history");
  if (!value.history.some((snapshot: Snapshot) => snapshot.generation === value.generation)) bad("managed project has no active configuration");
  return value;
}
function ownership(inv: Inventory, resourceID: string, config: Config, state?: Pick<State, "adopted_volumes" | "adopted_networks">, adopting = false) {
  for (const container of inv.containers) {
    const metadata = container.Config?.Labels ?? {};
    if (metadata[OWNER] && metadata[OWNER] !== resourceID || !adopting && metadata[OWNER] !== resourceID) bad("project ownership conflict; external projects require explicit adopt");
    const service = metadata["com.docker.compose.service"];
    if (typeof service !== "string" || !KEY.test(service)) bad("project contains an unidentified container");
    if (adopting) {
      const expected = config.compose.services[service];
      if (!expected || expected.image !== container.Config?.Image || metadata["com.docker.compose.oneoff"] === "True") bad("adopt configuration must match every existing service and image");
      if (container.HostConfig?.Privileged || container.HostConfig?.PidMode === "host" || container.HostConfig?.IpcMode === "host" || container.HostConfig?.NetworkMode === "host" || container.HostConfig?.CapAdd?.length || container.HostConfig?.Devices?.length) bad("existing project uses forbidden host privileges");
      const wanted = expected.volumes ?? [], existing = container.Mounts ?? [];
      if (existing.some((m: any) => m.Type !== "volume" || !wanted.some((e: any) => m.Name === `${config.project_name}_${e.source}` && m.Destination === e.target && (m.RW === undefined || m.RW === !e.read_only))) || wanted.some((e: any) => !existing.some((m: any) => m.Name === `${config.project_name}_${e.source}` && m.Destination === e.target))) bad("existing mounts do not match the safe project-scoped named volumes");
    }
  }
  if (adopting && (!inv.containers.length || Object.keys(config.compose.services).some((name) => !inv.containers.some((c) => c.Config?.Labels?.["com.docker.compose.service"] === name)))) bad("adopt requires the complete existing Compose service inventory");
  for (const [kind, entries] of [["volumes", inv.volumes], ["networks", inv.networks]] as const) for (const item of entries) {
    const keys = kind === "volumes" ? Object.keys(config.compose.volumes ?? {}) : ["default", ...Object.keys(config.compose.networks ?? {})];
    const expectedName = keys.some((name) => item.name === `${config.project_name}_${name}`), adopted = (kind === "volumes" ? state?.adopted_volumes : state?.adopted_networks)?.includes(item.name);
    if (item.owner && item.owner !== resourceID || item.project !== config.project_name || adopting && !expectedName || !adopting && item.owner !== resourceID && !adopted) bad("project storage/network ownership conflict; explicit safe adoption is required");
  }
}
function render(config: Config, resourceID: string, adopted?: Pick<State, "adopted_volumes" | "adopted_networks">) {
  const doc = structuredClone(config.compose); doc.name = config.project_name;
  for (const service of Object.values(doc.services) as any[]) service.labels = { ...service.labels, [OWNER]: resourceID };
  doc.networks ??= {}; doc.networks.default ??= {};
  // Compose v5 may offer to destroy/recreate a volume when labels change.
  // Previously verified adopted storage is referenced by its exact existing
  // name as external internally; user-supplied external names remain forbidden.
  for (const [kind, entries] of [["volumes", doc.volumes ?? {}], ["networks", doc.networks]] as const) for (const [name, entry] of Object.entries(entries) as Array<[string, any]>) {
    const existing = `${config.project_name}_${name}`;
    const retained = (kind === "volumes" ? adopted?.adopted_volumes : adopted?.adopted_networks)?.includes(existing);
    if (retained) entries[name] = { external: true, name: existing };
    else entry.labels = { [OWNER]: resourceID };
  }
  // Compose also interpolates JSON using the Agent's process environment.
  // Dollar escaping makes all user input literal and prevents host-env reads.
  const literal = (value: any): any => typeof value === "string" ? value.replaceAll("$", () => "$$") : Array.isArray(value) ? value.map(literal) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, val]) => [key, literal(val)])) : value;
  return JSON.stringify(literal(doc), null, 2);
}
function redact(value: string, config: Config) {
  let result = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  for (const service of Object.values(config.compose.services) as any[]) for (const secret of Object.values(service.environment ?? {}) as string[]) if (secret.length > 0) result = result.replaceAll(secret, "[redacted]");
  return result.replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"']+/ig, "$1[redacted]").replace(/((?:password|api[_-]?key|secret|token)\s*[:=]\s*)[^\s"']+/ig, "$1[redacted]");
}
function bounded(data: Record<string, any>): Record<string, any> {
  // The Agent receipt envelope is limited to 60 KiB. Keep JSON escaping and
  // multibyte text inside that envelope, not merely the raw text character count.
  const limit = 48 * 1024;
  if (Buffer.byteLength(JSON.stringify(data)) <= limit) return data;
  data.truncated = true;
  if (typeof data.logs === "string") {
    while (Buffer.byteLength(JSON.stringify(data)) > limit && data.logs.length) data.logs = data.logs.slice(0, Math.floor(data.logs.length * 0.8));
  }
  const fields = ["containers", "history", "volumes", "networks", "discovered_containers"];
  for (const field of fields) if (Array.isArray(data[field])) data[`${field}_total`] = data[field].length;
  while (Buffer.byteLength(JSON.stringify(data)) > limit) {
    const field = fields.filter((key) => Array.isArray(data[key]) && data[key].length).sort((a, b) => data[b].length - data[a].length)[0];
    if (!field) bad("structured Compose result exceeds the receipt limit");
    const count = Math.floor(data[field].length / 2);
    data[field] = field === "history" ? count ? data[field].slice(-count) : [] : data[field].slice(0, count);
  }
  return data;
}
async function configuration(dir: string, snapshot: Snapshot) {
  const doc = await read(join(dir, snapshot.file)), serialized = JSON.stringify(doc, null, 2);
  if (!doc || sha(serialized) !== snapshot.sha256) bad("managed configuration is missing or its checksum does not match");
  return serialized;
}

/** Strict JSON Compose operations. External projects require inventory-bound,
 * disruptive adoption. Configuration rollback never restores persistent data. */
export async function executeCompose(payload: OperationPayload, context: OperationExecutionContext): Promise<OperationExecutionResult> {
  if (payload.version !== 1 || payload.resource.kind !== "compose" || typeof payload.resource.id !== "string" || !RESOURCE.test(payload.resource.id) || typeof payload.operation_id !== "string" || !RESOURCE.test(payload.operation_id) || !Number.isSafeInteger(payload.resource.revision) || payload.resource.revision < 1) bad("invalid operation binding");
  const config = validate(payload.resource.config), input = validateInput(payload.operation, payload.input, config), base = await realpath(resolve(context.dataDir));
  await directory(join(base, "operations")); const root = join(base, "operations", "compose"); await directory(root);
  const dir = join(root, payload.resource.id); await directory(dir); const lock = join(root, `.lock-${config.project_name}`);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const metadata = await lstat(lock); if (!metadata.isDirectory() || metadata.isSymbolicLink()) bad("unsafe project lock directory");
    const holder = await read(join(lock, "owner.json")); let alive = true;
    if (holder && Number.isSafeInteger(holder.pid) && holder.pid > 0) try { process.kill(holder.pid, 0); } catch (err: any) { if (err.code === "ESRCH") alive = false; }
    if (alive) bad("project is locked by another operation");
    // Reclaiming by unlink/rename can remove a new owner's lock in a race.
    // An interrupted process therefore needs explicit local lock cleanup after
    // its project and pending journal have been inspected.
    bad("project lock belongs to an interrupted Agent process; inspect the project and remove the stale lock locally before retrying");
  }
  await write(join(lock, "owner.json"), { pid: process.pid, operation_id: payload.operation_id });
  try {
    const state = stateFrom(await read(join(dir, "state.json")), payload.resource.id, config.project_name), pending: Pending | undefined = await read(join(dir, "pending.json")), generation = state?.generation ?? 0;
    const completed = state?.history.find((snapshot) => snapshot.operation_id === payload.operation_id);
    if (completed && !readOnly.includes(payload.operation)) {
      if (completed.operation !== payload.operation || completed.resource_revision !== payload.resource.revision) bad("operation identity was reused with a different configuration or action");
      return { verified: true, data: { project_name: config.project_name, generation: completed.generation, configuration_sha256: completed.sha256, replayed_result: true, verification: "previously_verified_container_state", data_volumes_restored: false, application_health_verified: false } };
    }
    if (!readOnly.includes(payload.operation) && input.expected_generation !== generation) bad("expected_generation does not match the current remote generation");
    if (!readOnly.includes(payload.operation) && pending) {
      if (pending.operation_id === payload.operation_id) bad("this operation has an unknown result and must not be replayed");
      if (!["apply", "rollback"].includes(payload.operation) || input.acknowledge_unknown !== true) bad("previous operation result is unknown; inspect then approve a new apply or rollback with acknowledge_unknown");
    }
    await preflight(context); const inv = await inventory(config, context);
    if (readOnly.includes(payload.operation)) {
      if (payload.operation === "logs") {
        if (!inv.containers.some((c) => c.Id === input.container_id)) bad("container does not belong to this Compose project");
        const output = await docker(context, ["logs", "--tail", String(input.tail), "--timestamps", input.container_id]), combined = redact(output.stdout + (output.stderr ? `\n${output.stderr}` : ""), config);
        return { verified: true, data: bounded({ container_id: input.container_id, logs: combined.slice(0, MAX_LOGS), truncated: combined.length > MAX_LOGS, sensitive_logs: true }) };
      }
      let discovery: any[] | undefined;
      if (payload.operation === "discover") discovery = lines((await docker(context, ["ps", "--all", "--no-trunc", "--format", "{{json .}}"])).stdout, 500).slice(0, 200).map((row) => ({ id: clean(row.ID, 64), name: clean(row.Names), image: clean(row.Image), state: clean(row.State, 32), status: clean(row.Status) }));
      return { verified: true, data: bounded({ project_name: config.project_name, managed: !!state, generation, inventory_sha256: inv.sha256, containers: inv.containers.map(summary), volumes: inv.volumes, networks: inv.networks, history: state?.history.map(({ generation, resource_revision, sha256, operation, created_at }) => ({ generation, resource_revision, sha256, operation, created_at })) ?? [], pending_operation: pending ? { operation_id: pending.operation_id, operation: pending.operation, status: "unknown" } : null, ...(discovery ? { discovered_containers: discovery, discovery_limit: 200 } : {}) }) };
    }
    const registryPath = join(root, `project-${config.project_name}.json`), registration = await read(registryPath);
    if (registration && registration.resource_id !== payload.resource.id) bad("project ownership is reserved by a different LightMoni resource");
    if (!state && payload.operation !== "apply" && payload.operation !== "adopt") bad("project must be applied or explicitly adopted before mutation");
    if (payload.operation === "adopt") {
      if (state || pending) bad("project is already managed or has an unknown operation");
      if (input.inventory_sha256 !== inv.sha256) bad("inventory changed since approval; inspect again before adopt");
      ownership(inv, payload.resource.id, config, state, true);
    } else if (!state && !pending && (inv.containers.length || inv.volumes.length || inv.networks.length)) bad("external project exists; inspect and explicitly adopt before applying");
    else ownership(inv, payload.resource.id, config, state ?? pending);
    const adopted_volumes = state?.adopted_volumes ?? pending?.adopted_volumes ?? (payload.operation === "adopt" ? inv.volumes.map((v) => v.name) : []), adopted_networks = state?.adopted_networks ?? pending?.adopted_networks ?? (payload.operation === "adopt" ? inv.networks.map((n) => n.name) : []);
    let document: string;
    if (payload.operation === "rollback") {
      const snapshot = state!.history.find((entry) => entry.generation === input.target_generation); if (!snapshot) bad("target_generation is not present in the managed history");
      document = await configuration(dir, snapshot);
    } else if (["start", "stop", "restart"].includes(payload.operation)) {
      const snapshot = state!.history.find((entry) => entry.generation === generation)!;
      if (snapshot.resource_revision !== payload.resource.revision) bad("resource configuration changed; apply it before start, stop or restart");
      document = await configuration(dir, snapshot);
    } else document = render(config, payload.resource.id, { adopted_volumes, adopted_networks });
    if (state && state.history.length >= 1000) bad("configuration history limit reached; archive this resource before more mutations");
    const next = generation + 1, candidate = `generation-${next}.json`, candidatePath = join(dir, candidate);
    await write(candidatePath, document);
    const prefix = ["compose", "--project-name", config.project_name, "--project-directory", dir, "--file", candidatePath];
    await docker(context, [...prefix, "config", "--format", "json"], { cwd: dir });
    if (!registration) await write(registryPath, { version: 1, resource_id: payload.resource.id, project_name: config.project_name });
    await write(join(dir, "pending.json"), { operation_id: payload.operation_id, generation: next, operation: payload.operation, candidate, sha256: sha(document), adopted_volumes, adopted_networks } satisfies Pending);
    try {
      if (["apply", "adopt", "rollback"].includes(payload.operation)) await docker(context, [...prefix, "up", "--detach", "--wait", "--wait-timeout", "60", "--remove-orphans"], { cwd: dir });
      else await docker(context, [...prefix, payload.operation, ...(payload.operation === "start" ? ["--wait", "--wait-timeout", "60"] : ["--timeout", "30"]), ...(input.service ? [input.service] : [])], { cwd: dir });
      const activeDoc = JSON.parse(document), services = input.service ? [input.service] : Object.keys(activeDoc.services);
      let after = await inventory(config, context);
      const verified = () => services.every((service) => {
        const matches = after.containers.filter((c) => c.Config?.Labels?.["com.docker.compose.service"] === service);
        return matches.length === 1 && (payload.operation === "stop" ? matches.every((c) => !c.State?.Running) : matches.every((c) => c.State?.Running && (!c.State?.Health || c.State.Health.Status === "healthy")));
      });
      // restart has no Compose --wait option. Its process returning does not
      // mean container health checks have left the starting state.
      const deadline = Date.now() + (payload.operation === "restart" ? 60_000 : 0);
      while (!verified() && Date.now() < deadline) {
        context.signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const done = () => { clearTimeout(timer); context.signal.removeEventListener("abort", aborted); };
          const aborted = () => { done(); reject(new Error("operation aborted")); };
          const timer = setTimeout(() => { done(); resolve(); }, 500);
          context.signal.addEventListener("abort", aborted, { once: true });
        });
        after = await inventory(config, context);
      }
      if (after.containers.some((c) => c.Config?.Labels?.[OWNER] !== payload.resource.id)) bad("container ownership verification failed");
      if (!verified()) bad("container state verification failed");
      const snapshot: Snapshot = { generation: next, resource_revision: payload.resource.revision, file: candidate, sha256: sha(document), operation_id: payload.operation_id, operation: payload.operation, created_at: context.now().toISOString() };
      await write(join(dir, "state.json"), { version: 1, resource_id: payload.resource.id, project_name: config.project_name, generation: next, history: [...(state?.history ?? []), snapshot], adopted_volumes, adopted_networks } satisfies State);
      await unlink(join(dir, "pending.json"));
      return { verified: true, data: bounded({ project_name: config.project_name, generation: next, configuration_sha256: snapshot.sha256, verification: "container_state", containers: after.containers.map(summary), data_volumes_restored: false, application_health_verified: false, ...(payload.operation === "adopt" ? { recreated_existing_containers: true } : {}) }) };
    } catch {
      return { verified: false, data: { status: "unknown", project_name: config.project_name, generation, attempted_generation: next, operation_id: payload.operation_id, message: "Compose may have partially changed the project. Inspect the node and approve a new acknowledged apply or configuration rollback; this operation will not be replayed.", data_volumes_restored: false } };
    }
  } finally { await rm(lock, { recursive: true, force: true }); }
}
