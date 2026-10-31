import {
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, isAbsolute, normalize } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { isIP } from "node:net";
import { atomicJSON } from "../shared/io.js";

export const VERSION = "0.1.0";
export interface Probe {
  id: string;
  kind: "http" | "tcp";
  target: string;
  interval_seconds: number;
  timeout_ms: number;
  expected_status?: number[];
}
export interface LogSource {
  directory: string;
  pattern: string;
  recursive: boolean;
  from_beginning: boolean;
}
export interface Config {
  listen: string;
  endpoint: string;
  /** Node-bound control credential issued by Agent enrollment. */
  control_credential: string;
  /** Node-bound data credential issued by Agent enrollment. */
  data_credential: string;
  group_id: string;
  local_token: string;
  data_dir: string;
  max_batch_bytes: number;
  max_queue_bytes: number;
  max_queue_batches: number;
  min_free_bytes: number;
  max_receipts: number;
  max_age_seconds: number;
  receipt_seconds: number;
  collect_interval_seconds: number;
  control_interval_seconds: number;
  process_names: string[];
  probes: Probe[];
}
export interface RemoteConfig {
  revision: string;
  collect_interval_seconds: number;
  probes: Probe[];
  host_enabled: boolean;
  host_collectors: string[];
  host_table: string;
  probe_table: string;
  process_names: string[];
  group_id: string;
  logs_enabled: boolean;
  log_table: string;
  log_sources: LogSource[];
}
export interface Identity {
  agent_id: string;
  host_id: string;
}
export const validTable = (s: string) =>
  typeof s === "string" &&
  /^[a-z][a-z0-9_]{0,47}$/.test(s) &&
  !/^(log|metric|trace)_/.test(s);
export const systemTable = (s: string) =>
  ["lightmoni", "lightmoni_center", "lightmoni_agent", "lightmoni_sdk", "lightmoni_application"].includes(s);
export const digest = (v: Uint8Array | string) =>
  createHash("sha256").update(v).digest("hex");
export function defaultConfig(): Config {
  return {
    listen: "127.0.0.1:4318",
    endpoint: "",
    control_credential: "",
    data_credential: "",
    group_id: "",
    local_token: "",
    data_dir: "./agent-data",
    max_batch_bytes: 4 << 20,
    max_queue_bytes: 256 << 20,
    max_queue_batches: 10000,
    min_free_bytes: 32 << 20,
    max_receipts: 100000,
    max_age_seconds: 86400,
    receipt_seconds: 172800,
    collect_interval_seconds: 15,
    control_interval_seconds: 30,
    process_names: [],
    probes: [],
  };
}
export function listenAddress(value: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(value);
  if (!match || Number(match[3]) > 65535)
    throw Error("listen: expected host:port");
  return { host: match[1] ?? match[2], port: Number(match[3]) };
}
/** Match Go filepath.Match, including escaped characters and negated ranges. */
export function glob(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (c === "\\") {
      if (++i === pattern.length) throw Error("invalid glob");
      source += escape(pattern[i]);
    } else if (c === "[") {
      let bracket = "[";
      if (pattern[i + 1] === "^") {
        bracket += "^";
        i++;
      }
      let count = 0;
      for (i++; i < pattern.length && pattern[i] !== "]"; i++) {
        if (pattern[i] === "\\") {
          if (++i === pattern.length) throw Error("invalid glob");
          bracket += "\\" + pattern[i];
        } else bracket += pattern[i];
        count++;
      }
      if (i >= pattern.length || count === 0) throw Error("invalid glob");
      source += bracket + "]";
    } else source += escape(c);
  }
  return new RegExp(source + "$", "u");
}
function escape(c: string) {
  return c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
export function validateProbes(probes: Probe[]): void {
  if (!Array.isArray(probes) || probes.length > 128)
    throw Error("at most 128 probes are allowed");
  const seen = new Set<string>();
  for (const p of probes) {
    if (!p.id?.trim() || Buffer.byteLength(p.id) > 128 || seen.has(p.id))
      throw Error("probe IDs must be unique nonempty values <=128 bytes");
    seen.add(p.id);
    if (
      !Number.isInteger(p.interval_seconds) ||
      p.interval_seconds < 1 ||
      p.interval_seconds > 86400 ||
      !Number.isInteger(p.timeout_ms) ||
      p.timeout_ms < 1 ||
      p.timeout_ms > 120000
    )
      throw Error(`probe ${p.id} has invalid interval or timeout`);
    if (p.kind === "http") {
      let u: URL;
      try {
        u = new URL(p.target);
      } catch {
        throw Error("probe requires an http(s) URL");
      }
      if (
        !["http:", "https:"].includes(u.protocol) ||
        !u.host ||
        u.username ||
        u.password
      )
        throw Error(
          "probe requires an http(s) URL without embedded credentials",
        );
    } else if (p.kind === "tcp") {
      const { host, port } = listenAddress(p.target);
      if (!host.trim() || port < 1) throw Error("probe requires host:port");
    } else throw Error("probe kind must be http or tcp");
    if (
      (p.expected_status ?? []).some(
        (s) => !Number.isInteger(s) || s < 100 || s > 599,
      )
    )
      throw Error("invalid expected status");
  }
}
export interface ConfigValidation { pendingEnrollment?: boolean }
export function validateConfig(c: Config, options: ConfigValidation = {}): void {
  let u: URL;
  try {
    u = new URL(c.endpoint);
  } catch {
    throw Error("endpoint must be an http(s) URL");
  }
  if (
    !["http:", "https:"].includes(u.protocol) ||
    !u.host ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw Error("endpoint must be an http(s) URL");
  if (Object.hasOwn(c, "key"))
    throw Error("shared key configuration is not supported; enroll Agent through a registered host");
  for (const value of [c.control_credential, c.data_credential])
    if (typeof value !== "string" || Buffer.byteLength(value) > 4096 || /[\u0000-\u0020\u007f]/.test(value))
      throw Error("invalid Agent credential");
  if ((!c.control_credential || !c.data_credential)
    && !(options.pendingEnrollment && !c.control_credential && !c.data_credential))
    throw Error("both control_credential and data_credential are required");
  if (Buffer.byteLength(c.group_id) > 64) throw Error("invalid agent group");
  const { host } = listenAddress(c.listen);
  if (
    host !== "localhost" &&
    host !== "::1" &&
    !(isIP(host) === 4 && host.startsWith("127.")) &&
    !c.local_token
  )
    throw Error("non-loopback receiver requires local_token");
  const positive = [
    "max_batch_bytes",
    "max_queue_bytes",
    "max_queue_batches",
    "max_receipts",
    "max_age_seconds",
    "receipt_seconds",
    "collect_interval_seconds",
    "control_interval_seconds",
  ] as const;
  if (
    !c.data_dir ||
    positive.some((k) => !Number.isSafeInteger(c[k]) || c[k] <= 0) ||
    !Number.isSafeInteger(c.min_free_bytes) ||
    c.min_free_bytes < 0 ||
    c.max_queue_bytes < c.max_batch_bytes ||
    c.receipt_seconds < c.max_age_seconds
  )
    throw Error("invalid storage limits or intervals");
  validateMatchers(c.process_names);
  validateProbes(c.probes);
}
function validateMatchers(patterns: string[]) {
  if (!Array.isArray(patterns) || patterns.length > 32)
    throw Error("at most 32 process matchers are allowed");
  for (const p of patterns) {
    if (!p || Buffer.byteLength(p) > 128)
      throw Error("invalid process matcher");
    glob(p);
  }
}
export function loadConfig(path: string, options: ConfigValidation = {}): Config {
  const c = { ...defaultConfig(), ...JSON.parse(readFileSync(path, "utf8")) };
  validateConfig(c, options);
  return c;
}
export function saveConfig(path: string, c: Config, options: ConfigValidation = {}): void {
  validateConfig(c, options);
  atomicJSON(path, c);
}
export function loadIdentity(dir: string): Identity {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "identity.json");
  if (existsSync(path)) {
    const id = JSON.parse(readFileSync(path, "utf8"));
    if (!id.agent_id || !id.host_id) throw Error("invalid identity file");
    return id;
  }
  const id = { agent_id: randomUUID(), host_id: randomUUID() };
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(id));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const d = openSync(dir, "r");
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
  return id;
}
export function normalizeRemote(c: Partial<RemoteConfig>): RemoteConfig {
  return {
    revision: c.revision ?? "",
    collect_interval_seconds: c.collect_interval_seconds ?? 0,
    probes: c.probes ?? [],
    host_enabled: c.host_enabled ?? true,
    host_collectors: c.host_collectors ?? [
      "cpu",
      "memory",
      "filesystem",
      "disk",
      "network",
      "system",
      ...(c.process_names?.length ? ["process"] : []),
    ],
    host_table: "host",
    probe_table: "probe",
    process_names: c.process_names ?? [],
    group_id: c.group_id ?? "",
    logs_enabled: c.logs_enabled ?? false,
    log_table: "files",
    log_sources: (c.log_sources ?? []).map((s) => ({
      ...s,
      directory: s.directory.trim(),
      pattern: s.pattern || "*.log*",
      recursive: s.recursive ?? false,
      from_beginning: s.from_beginning ?? false,
    })),
  };
}
export function logSourceID(s: LogSource): string {
  return digest(`${normalize(s.directory)}\0${s.pattern}\0${s.recursive}`);
}
export function validateRemote(c: RemoteConfig): void {
  if (
    !c.revision ||
    !Number.isInteger(c.collect_interval_seconds) ||
    c.collect_interval_seconds < 1 ||
    c.collect_interval_seconds > 86400
  )
    throw Error("invalid remote configuration revision or interval");
  validateProbes(c.probes);
  validateMatchers(c.process_names);
  for (const t of [c.host_table, c.probe_table, c.log_table]) {
    if (!validTable(t)) throw Error("invalid logical table");
    if (systemTable(t)) throw Error("system table is reserved");
  }
  if (c.host_enabled && !c.host_collectors.length)
    throw Error("at least one host collector is required");
  const known = [
    "cpu",
    "memory",
    "filesystem",
    "disk",
    "network",
    "system",
    "process",
  ];
  if (
    c.host_collectors.some((x) => !known.includes(x)) ||
    new Set(c.host_collectors).size !== c.host_collectors.length
  )
    throw Error("invalid or repeated host collector");
  if (
    c.host_enabled &&
    c.host_collectors.includes("process") &&
    !c.process_names.length
  )
    throw Error("process names are required");
  if (c.log_sources.length > 32 || (c.logs_enabled && !c.log_sources.length))
    throw Error("invalid log source count");
  const seen = new Set<string>();
  for (const s of c.log_sources) {
    if (
      !isAbsolute(s.directory) ||
      Buffer.byteLength(s.directory) > 4096 ||
      Buffer.byteLength(s.pattern) > 256 ||
      /[\/\\]/.test(s.pattern)
    )
      throw Error("invalid log directory or pattern");
    glob(s.pattern);
    const id = logSourceID(s);
    if (seen.has(id)) throw Error("duplicate log source");
    seen.add(id);
  }
}
