import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";
import type { MachineSummary } from "./managed-machines.js";

export interface SSHRunInput {
  machine: MachineSummary;
  privateKey: string;
  /** One-time password authentication is accepted only by the preflight runner. */
  password?: string;
  command: string;
  enrollmentToken?: string;
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

// Trust only keys matching the administrator's pin, never every scanned key.
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

function runProcess(command: string, args: string[], input: string | undefined, signal: AbortSignal, timeoutMs: number) {
  if (signal.aborted) return Promise.reject(new SSHError("cancelled"));
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", stopped: SSHError | undefined;
    const stop = (code: "cancelled" | "timed_out") => { stopped ??= new SSHError(code); child.kill("SIGKILL"); };
    const onAbort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timed_out"), timeoutMs);
    const clean = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-12_000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-12_000); });
    child.once("error", () => { clean(); reject(stopped ?? new SSHError("ssh_failed")); });
    child.once("close", code => { clean(); if (stopped || code !== 0) reject(stopped ?? new SSHError("ssh_failed")); else resolve({ stdout, stderr }); });
    child.stdin.on("error", () => {}); // An authentication failure can close stdin before its write.
    child.stdin.end(input);
    if (signal.aborted) onAbort();
  });
}

export async function defaultSSHRunner(input: SSHRunInput) {
  const dir = await mkdtemp(join(tmpdir(), "lightmoni-ssh-"));
  const keyPath = join(dir, "id"), knownPath = join(dir, "known_hosts");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 30 * 60_000)]);
  try {
    await writeFile(keyPath, input.privateKey + "\n", { mode: 0o600 });
    const scanned = await runProcess("ssh-keyscan", ["-T", "5", "-t", "rsa,ecdsa,ed25519", "-p", String(input.port), input.machine.address], undefined, signal, 15_000);
    await writeFile(knownPath, pinnedHostKeys(scanned.stdout, input.machine.host_key_fingerprint), { mode: 0o600 });
    const result = await runProcess("ssh", [
      "-F", "/dev/null", "-T", "-p", String(input.port),
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1",
      "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownPath}`,
      "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
      "-o", "PreferredAuthentications=publickey", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
      "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ProxyCommand=none", "-o", "ProxyJump=none",
      "-o", "ControlMaster=no", "-o", "LogLevel=ERROR", "-i", keyPath,
      `${input.machine.username}@${input.machine.address}`, input.command,
    ], input.enrollmentToken == null ? undefined : input.enrollmentToken + "\n", signal, input.timeoutMs ?? 30 * 60_000);
    return { ...result, stages: ["checking_host_key", "host_key_confirmed", "connecting_ssh", "remote_command_completed"] };
  } catch (error) {
    if (input.signal.aborted) throw new SSHError("cancelled");
    if (signal.aborted) throw new SSHError("timed_out");
    throw error instanceof SSHError ? error : new SSHError("ssh_failed");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run the fixed, read-only preflight with an SSH password.
 *
 * This deliberately uses ssh2 instead of an ssh/sshpass subprocess: the
 * password never becomes a command-line argument, environment variable, or
 * process stdin. Callers must provide a short-lived credential and this
 * runner is never selected by Agent deployment or the interactive terminal.
 */
export async function passwordSSHRunner(input: SSHRunInput) {
  if (!input.password) throw new SSHError("ssh_failed");
  const timeoutMs = input.timeoutMs ?? 60_000;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
  if (signal.aborted) throw new SSHError(input.signal.aborted ? "cancelled" : "timed_out");
  const client = new Client();
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let mismatch = false;
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
  client.on("ready", () => {
    if (settled) return;
    client.exec(input.command, (error, stream) => {
      if (error || !stream) return finish(new SSHError("ssh_failed"));
      stream.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-12_000); });
      stream.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-12_000); });
      stream.on("error", () => finish(new SSHError("ssh_failed")));
      stream.on("close", (code: number | null) => {
        if (code !== 0) return finish(new SSHError("ssh_failed"));
        finish(undefined, { stdout, stderr, stages: ["checking_host_key", "host_key_confirmed", "connecting_ssh", "remote_command_completed"] });
      });
    });
  });
  try {
    const machine = input.machine;
    client.connect({
      host: machine.address.replace(/^\[|\]$/g, ""), port: input.port, username: machine.username,
      password: input.password, readyTimeout: Math.min(timeoutMs, 20_000), tryKeyboard: false,
      hostVerifier(key: Buffer) {
        const actual = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
        mismatch = actual !== machine.host_key_fingerprint;
        return !mismatch;
      },
    });
  } catch { finish(new SSHError("ssh_failed")); }
  return promise;
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export const CHECK_NAMES = ["linux", "supported_arch", "curl", "tar", "gzip", "sha256sum", "systemd", "install_privilege", "platform_https"] as const;
export type SSHChecks = Record<typeof CHECK_NAMES[number], boolean>;
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
    url.protocol === "https:" ? `if curl --fail --silent --proto '=https' --tlsv1.2 --connect-timeout 5 --max-time 10 --output /dev/null ${quote(health)} </dev/null 2>/dev/null; then echo 'platform_https=1'; else echo 'platform_https=0'; fi` : "echo 'platform_https=0'",
  ].join("\n");
}
export function parsePreflight(output: string) {
  const values = new Map<string, string>();
  for (const line of output.trim().split(/\r?\n/)) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)=([a-z0-9]+)$/.exec(line);
    if (!match || values.has(match[1])) throw new SSHError("invalid_response");
    values.set(match[1], match[2]);
  }
  if (values.size !== CHECK_NAMES.length + 3 || values.get("LMSSH") !== "1" ||
      !["linux", "unsupported"].includes(values.get("platform") ?? "") ||
      !["amd64", "arm64", "unsupported"].includes(values.get("arch") ?? "") ||
      CHECK_NAMES.some(name => !["0", "1"].includes(values.get(name) ?? ""))) throw new SSHError("invalid_response");
  const checks = Object.fromEntries(CHECK_NAMES.map(name => [name, values.get(name) === "1"])) as SSHChecks;
  if (checks.linux !== (values.get("platform") === "linux") || checks.supported_arch !== (values.get("arch") !== "unsupported")) throw new SSHError("invalid_response");
  return { platform: values.get("platform")!, arch: values.get("arch")!, checks, ready: Object.values(checks).every(Boolean) };
}
