import { createHash } from "node:crypto";
import { Client } from "ssh2";
import { hostKeyAlgorithms } from "./machine-host-keys.js";
import { MAX_NETWORK_ADDRESSES, normalizeNetworkAddresses, type HostNetworkAddress } from "../shared/host-network.js";
import type { MachineSummary } from "./managed-machines.js";

export interface SSHRunInput {
  machine: MachineSummary;
  privateKey: string;
  /** SSH password stays in this in-memory connection input, never argv/env/stdin. */
  password?: string;
  command: string;
  credentialID?: string;
  /** Synchronous, atomic host identity check from this exact SSH handshake. */
  verifyHostKey?: (key: Buffer) => boolean;
  enrollmentToken?: string;
  /** Non-secret fixed script input, never used for a password. */
  stdin?: string;
  signal: AbortSignal;
  port: number;
  timeoutMs?: number;
}
export type SSHRunner = (input: SSHRunInput) => Promise<{ stdout: string; stderr: string; stages: string[] }>;
export class SSHError extends Error {
  constructor(readonly code: "ssh_failed" | "host_key_mismatch" | "timed_out" | "cancelled" | "invalid_response") {
    super(code);
  }
}

// Match a fixed pin; kept as a pure parser for existing tooling and tests.
export function pinnedHostKeys(scanned: string, expected: string): string {
  const matches = scanned.split("\n").filter(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3 || parts[0].startsWith("#") || !/^[A-Za-z0-9+/]+=*$/.test(parts[2])) return false;
    const digest = createHash("sha256").update(Buffer.from(parts[2], "base64")).digest("base64").replace(/=+$/, "");
    return `SHA256:${digest}` === expected;
  });
  if (!matches.length) throw new SSHError("host_key_mismatch");
  return matches.join("\n") + "\n";
}

export async function defaultSSHRunner(input: SSHRunInput) {
  return fixedCommandSSHRunner(input);
}

/**
 * Run a platform-owned fixed command with an SSH password.
 *
 * This deliberately uses ssh2 instead of an ssh/sshpass subprocess: the
 * password never becomes a command-line argument, environment variable, or
 * process stdin. Reusable credentials may authenticate fixed installation,
 * removal and verification plans. The enrollment token travels separately
 * through the authenticated exec channel's stdin.
 */
export async function passwordSSHRunner(input: SSHRunInput) {
  if (!input.password) throw new SSHError("ssh_failed");
  return fixedCommandSSHRunner(input);
}

/** One handshake supplies both host verification and password/private-key auth. */
async function fixedCommandSSHRunner(input: SSHRunInput) {
  if (input.password === undefined && !input.privateKey) throw new SSHError("ssh_failed");
  const timeoutMs = input.timeoutMs ?? 30 * 60_000;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
  if (signal.aborted) throw new SSHError(input.signal.aborted ? "cancelled" : "timed_out");
  const client = new Client();
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let mismatch = false;
  let verifiedHostKey: Buffer | undefined;
  let stdout = "", stderr = "";
  const finish = (error?: SSHError, result?: { stdout: string; stderr: string; stages: string[] }) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    client.destroy();
    if (error) rejectPromise?.(error);
    else resolvePromise?.(result!);
  };
  let resolvePromise: ((value: { stdout: string; stderr: string; stages: string[] }) => void) | undefined;
  let rejectPromise: ((error: SSHError) => void) | undefined;
  const promise = new Promise<{ stdout: string; stderr: string; stages: string[] }>((resolve, reject) => {
    resolvePromise = resolve; rejectPromise = reject;
  });
  const abort = () => finish(new SSHError(input.signal.aborted ? "cancelled" : "timed_out"));
  timer = setTimeout(() => finish(new SSHError("timed_out")), timeoutMs);
  signal.addEventListener("abort", abort, { once: true });
  client.on("error", (error: Error & { level?: string }) => {
    finish(new SSHError(mismatch ? "host_key_mismatch" : error.level === "client-authentication" ? "ssh_failed" : "ssh_failed"));
  });
  client.on("close", () => { if (!settled) finish(new SSHError("ssh_failed")); });
  const stillVerified = () => {
    if (settled || signal.aborted || !verifiedHostKey) return false;
    try { return input.verifyHostKey ? input.verifyHostKey(verifiedHostKey) : true; } catch { return false; }
  };
  client.on("ready", () => {
    if (settled) return;
    if (!stillVerified()) return finish(new SSHError("ssh_failed"));
    client.exec(input.command, (error, stream) => {
      if (error || !stream) return finish(new SSHError("ssh_failed"));
      if (!stillVerified()) { stream.destroy(); return finish(new SSHError("ssh_failed")); }
      stream.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-12_000); });
      stream.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-12_000); });
      stream.on("error", () => finish(new SSHError("ssh_failed")));
      stream.on("close", (code: number | null) => {
        if (code !== 0) return finish(new SSHError("ssh_failed"));
        finish(undefined, { stdout, stderr, stages: ["checking_host_key", "host_key_confirmed", "connecting_ssh", "remote_command_completed"] });
      });
      // Only the fixed command's input is sent here. Password authentication
      // is performed by ssh2.connect() below, before this channel exists.
      stream.end(input.stdin ?? (input.enrollmentToken == null ? undefined : input.enrollmentToken + "\n"));
    });
  });
  try {
    const machine = input.machine;
    client.connect({
      host: machine.address.replace(/^\[|\]$/g, ""), port: input.port, username: machine.username,
      ...(input.password !== undefined ? { password: input.password, tryKeyboard: false } : { privateKey: input.privateKey }),
      algorithms: hostKeyAlgorithms(machine), readyTimeout: Math.min(timeoutMs, 20_000), tryKeyboard: false,
      hostVerifier(key: Buffer) {
        if (settled || signal.aborted) return false;
        const actual = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
        try { mismatch = input.verifyHostKey ? !input.verifyHostKey(key) : !machine.host_key_fingerprint || actual !== machine.host_key_fingerprint; }
        catch { mismatch = true; }
        if (!mismatch) verifiedHostKey = key;
        return !mismatch;
      },
    });
  } catch { finish(new SSHError("ssh_failed")); }
  return promise;
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export const CHECK_NAMES = ["linux", "supported_arch", "curl", "tar", "gzip", "sha256sum", "systemd", "install_privilege", "platform_https"] as const;
export type SSHChecks = Record<typeof CHECK_NAMES[number], boolean>;
export interface SSHDiscovery {
  status: "succeeded" | "unavailable";
  hostname: string;
  addresses: HostNetworkAddress[];
  observed_at: string;
}
export const unavailableSSHDiscovery = (): SSHDiscovery => ({ status: "unavailable", hostname: "", addresses: [], observed_at: "" });
const DISCOVERY_BEGIN = "LMNET_BEGIN=1", DISCOVERY_END = "LMNET_END=1";
const MAX_DISCOVERY_JSON_BYTES = 8192;

/** Optional, read-only metadata in the same authenticated exec channel. */
function discoveryCommand(): string[] {
  return [
    `printf '${DISCOVERY_BEGIN}\\n'`,
    // These tools are optional. Never install them, start another SSH session,
    // or let a slow discovery command consume the main preflight deadline.
    "if command -v ip >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 && command -v head >/dev/null 2>&1 && command -v od >/dev/null 2>&1 && command -v tr >/dev/null 2>&1; then",
    "  LM_SSH_DISCOVERY_HOST=$(timeout 2 uname -n 2>/dev/null | head -c 129 | od -An -tx1 | tr -d ' \\n')",
    `  LM_SSH_DISCOVERY_ADDR=$(timeout 3 ip -j -brief address show 2>/dev/null | head -c ${MAX_DISCOVERY_JSON_BYTES + 1})`,
    "  printf 'hostname_hex=%s\\naddresses_json=%s\\n' \"$LM_SSH_DISCOVERY_HOST\" \"$LM_SSH_DISCOVERY_ADDR\"",
    "fi",
    `printf '${DISCOVERY_END}\\n'`,
    ":",
  ];
}

function parseDiscovery(lines: string[], observedAt: string): SSHDiscovery {
  try {
    if (lines.at(-1) !== DISCOVERY_END || Buffer.byteLength(lines.join("\n")) > MAX_DISCOVERY_JSON_BYTES + 512) return unavailableSSHDiscovery();
    const hex = /^hostname_hex=([a-f0-9]+)$/.exec(lines[0] ?? "")?.[1];
    if (!hex || hex.length % 2 || hex.length > 258) return unavailableSSHDiscovery();
    const hostname = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(hex, "hex")).trim();
    if (!hostname || Buffer.byteLength(hostname) > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(hostname)) return unavailableSSHDiscovery();
    const serialized = lines.slice(1, -1).join("\n");
    if (!serialized.startsWith("addresses_json=")) return unavailableSSHDiscovery();
    const json = serialized.slice("addresses_json=".length);
    if (Buffer.byteLength(json) > MAX_DISCOVERY_JSON_BYTES) return unavailableSSHDiscovery();
    const inventory = JSON.parse(json);
    if (!Array.isArray(inventory) || inventory.length > 128) return unavailableSSHDiscovery();
    const values: { interface: string; address: string; family?: "IPv4" | "IPv6" }[] = [];
    for (const item of inventory) {
      if (!item || typeof item !== "object" || typeof item.ifname !== "string" || !Array.isArray(item.addr_info)) return unavailableSSHDiscovery();
      for (const address of item.addr_info) {
        if (!address || typeof address !== "object" || address.family !== undefined && !["inet", "inet6"].includes(address.family) || typeof address.local !== "string") return unavailableSSHDiscovery();
        values.push({ interface: item.ifname, address: address.local,
          ...(address.family === undefined ? {} : { family: address.family === "inet" ? "IPv4" : "IPv6" }) });
        if (values.length > MAX_NETWORK_ADDRESSES) return unavailableSSHDiscovery();
      }
    }
    if (!Number.isFinite(Date.parse(observedAt))) return unavailableSSHDiscovery();
    return { status: "succeeded", hostname, addresses: normalizeNetworkAddresses(values)!, observed_at: observedAt };
  } catch { return unavailableSSHDiscovery(); }
}

export function preflightCommand(endpoint: string) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("platform HTTPS URL required");
  const health = endpoint.replace(/\/$/, "") + "/healthz";
  return [
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH; LC_ALL=C; export LC_ALL",
    "printf 'LMSSH=1\\n'",
    "case $(uname -s) in Linux) printf 'platform=linux\\nlinux=1\\n';; *) printf 'platform=unsupported\\nlinux=0\\n';; esac",
    "case $(uname -m) in x86_64) printf 'arch=amd64\\nsupported_arch=1\\n';; aarch64|arm64) printf 'arch=arm64\\nsupported_arch=1\\n';; *) printf 'arch=unsupported\\nsupported_arch=0\\n';; esac",
    ...["curl", "tar", "gzip", "sha256sum"].map(name => `if command -v ${name} >/dev/null 2>&1; then echo '${name}=1'; else echo '${name}=0'; fi`),
    "if command -v systemctl >/dev/null 2>&1 && test -d /run/systemd/system; then echo 'systemd=1'; else echo 'systemd=0'; fi",
    "if test \"$(id -u)\" = 0 || sudo -n /bin/sh -c 'test \"$(id -u)\" = 0' </dev/null >/dev/null 2>&1; then echo 'install_privilege=1'; else echo 'install_privilege=0'; fi",
    "if test \"$(id -u)\" = 0; then sh -c 'if test -e /usr/local/bin/lightmoni-agent || test -L /usr/local/bin/lightmoni-agent || test -e /opt/lightmoni-agent || test -e /etc/systemd/system/lightmoni-agent.service || test -e /etc/lightmoni-agent/config.json || test -e /var/lib/lightmoni-agent/identity.json; then echo agent_installation=present; else echo agent_installation=absent; fi'; elif sudo -n /bin/sh -c 'if test -e /usr/local/bin/lightmoni-agent || test -L /usr/local/bin/lightmoni-agent || test -e /opt/lightmoni-agent || test -e /etc/systemd/system/lightmoni-agent.service || test -e /etc/lightmoni-agent/config.json || test -e /var/lib/lightmoni-agent/identity.json; then echo agent_installation=present; else echo agent_installation=absent; fi' </dev/null 2>/dev/null; then :; else echo agent_installation=unknown; fi",
    url.protocol === "https:" ? `if curl --fail --silent --proto '=https' --tlsv1.2 --connect-timeout 5 --max-time 10 --output /dev/null ${quote(health)} </dev/null 2>/dev/null; then echo 'platform_https=1'; else echo 'platform_https=0'; fi` : "echo 'platform_https=0'",
    ...discoveryCommand(),
  ].join("\n");
}
export function parsePreflight(output: string, observedAt = new Date().toISOString()) {
  const lines = output.trim().split(/\r?\n/), optionalAt = lines.indexOf(DISCOVERY_BEGIN);
  const values = new Map<string, string>();
  for (const line of optionalAt < 0 ? lines : lines.slice(0, optionalAt)) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)=([a-z0-9]+)$/.exec(line);
    if (!match || values.has(match[1])) throw new SSHError("invalid_response");
    values.set(match[1], match[2]);
  }
  const installation = values.get("agent_installation") ?? "unknown";
  if (!["present", "absent", "unknown"].includes(installation)) throw new SSHError("invalid_response");
  if (values.size !== CHECK_NAMES.length + 3 + Number(values.has("agent_installation")) || values.get("LMSSH") !== "1" ||
      !["linux", "unsupported"].includes(values.get("platform") ?? "") ||
      !["amd64", "arm64", "unsupported"].includes(values.get("arch") ?? "") ||
      CHECK_NAMES.some(name => !["0", "1"].includes(values.get(name) ?? ""))) throw new SSHError("invalid_response");
  const checks = Object.fromEntries(CHECK_NAMES.map(name => [name, values.get(name) === "1"])) as SSHChecks;
  if (checks.linux !== (values.get("platform") === "linux") || checks.supported_arch !== (values.get("arch") !== "unsupported")) throw new SSHError("invalid_response");
  return { platform: values.get("platform")!, arch: values.get("arch")!, agent_installation: { state: installation as "present" | "absent" | "unknown" }, checks, ready: Object.values(checks).every(Boolean),
    discovery: optionalAt < 0 ? unavailableSSHDiscovery() : parseDiscovery(lines.slice(optionalAt + 1), observedAt) };
}
