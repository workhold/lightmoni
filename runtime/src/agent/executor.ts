import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, basename, isAbsolute, join, normalize, parse, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { connect as connectTCP } from "node:net";
import type { DeploymentAction, HealthCheck } from "../deployment/types.js";

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,126}\.service$/;
const CAPABILITIES = new Set([
  "artifact.stage", "artifact.activate_release", "systemd.daemon_reload",
  "systemd.enable", "systemd.disable", "systemd.start", "systemd.restart", "systemd.stop",
  "health.systemd", "health.http", "health.tcp", "systemd.probe",
]);

export interface ExecutorTarget {
  releaseDirectory: string;
  unit: string;
}
export interface ExecutorJob {
  id: string;
  expires_at: string;
  capabilities: string[];
  actions: DeploymentAction[];
  target: ExecutorTarget;
}
export interface ExecutionEvent {
  phase: "accepted" | "preflighting" | "staging" | "activating" | "verifying" | "succeeded" | "failed" | "unknown";
  code?: string;
  summary: string;
  snapshot?: Record<string, unknown>;
}
export interface ExecutionReceipt {
  state: "succeeded" | "failed" | "unknown";
  code?: string;
  summary: string;
  snapshot: Record<string, unknown>;
  started_at: string;
  finished_at: string;
}
export interface ExecutorOptions {
  now?: () => Date;
  command?: (file: string, args: string[], timeoutMs: number, signal: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
  emit?: (event: ExecutionEvent) => Promise<void> | void;
}

const safePath = (value: string) => {
  if (!isAbsolute(value) || value.includes("\0") || value.split(/[\\/]/).includes("..")) return false;
  return normalize(value) === value;
};
// Deployment targets are Linux hosts. Resolve every path component relative
// to an already-open directory descriptor, with O_NOFOLLOW on each lookup.
// Re-checking a pathname with lstat/realpath and then using it would leave a
// symlink-swap window between the check and the read/write.
const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const descriptorPath = (handle: FileHandle) => {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
  throw Object.assign(Error("secure deployment filesystem operations require Linux"), { code: "unsupported_platform" });
};
const openDirectory = async (path: string) => open(path, DIRECTORY_FLAGS);
const duplicateDirectory = async (handle: FileHandle) => open(descriptorPath(handle), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
const openAbsoluteDirectory = async (path: string, create = false): Promise<FileHandle> => {
  if (process.platform !== "linux") throw Object.assign(Error("secure deployment filesystem operations require Linux"), { code: "unsupported_platform" });
  const root = parse(path).root;
  let current = await openDirectory(root);
  try {
    for (const component of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
      const childPath = join(descriptorPath(current), component);
      let next: FileHandle;
      try {
        next = await openDirectory(childPath);
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(childPath, { mode: 0o750 }).catch((mkdirError) => {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        });
        next = await openDirectory(childPath);
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => {});
    throw error;
  }
};
const openChildDirectory = async (parent: FileHandle, name: string, create = false) => {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw Error("invalid directory component");
  const path = join(descriptorPath(parent), name);
  try {
    return await openDirectory(path);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o750 }).catch((mkdirError) => {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    });
    return openDirectory(path);
  }
};
const openRelativeDirectory = async (base: FileHandle, path: string, create = false) => {
  let current = await duplicateDirectory(base);
  try {
    for (const component of path.split(/[\\/]/).filter(Boolean)) {
      const next = await openChildDirectory(current, component, create);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => {});
    throw error;
  }
};
const openAbsoluteFile = async (path: string, flags = constants.O_RDONLY) => {
  const parent = await openAbsoluteDirectory(dirname(path));
  try {
    return await openFileAt(parent, basename(path), flags);
  } finally {
    await parent.close();
  }
};
const openFileAt = (directory: FileHandle, name: string, flags: number, mode?: number) => {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw Error("invalid file component");
  return open(join(descriptorPath(directory), name), flags | NOFOLLOW, mode);
};
const renameAt = (directory: FileHandle, from: string, to: string) => rename(
  join(descriptorPath(directory), from), join(descriptorPath(directory), to),
);
const unlinkAt = (directory: FileHandle, name: string) => unlink(join(descriptorPath(directory), name));
const inside = (root: string, value: string) => {
  const rel = relative(root, value);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${value.includes("\\") ? "\\" : "/"}`) && !isAbsolute(rel));
};
const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? Error("execution cancelled");
};
const digestHandle = async (handle: FileHandle, signal: AbortSignal) => {
  checkAbort(signal);
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
    checkAbort(signal);
    hash.update(chunk);
  }
  return hash.digest("hex");
};
const defaultCommand = async (file: string, args: string[], timeoutMs: number, signal: AbortSignal) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 << 10, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
};
const tcpHealth = (host: string, port: number, timeoutMs: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
  const socket = connectTCP({ host, port });
  let done = false;
  const finish = (value: boolean) => { if (done) return; done = true; socket.destroy(); resolve(value); };
  socket.setTimeout(timeoutMs, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  if (signal.aborted) finish(false);
  else signal.addEventListener("abort", () => finish(false), { once: true });
});

/**
 * Executes only the typed capabilities issued in an Agent job.  Every action
 * is checked against the registered target and job expiry before it touches
 * the host. No shell string is accepted by this class.
 */
export class CapabilityExecutor {
  private readonly now: () => Date;
  private readonly runCommand: NonNullable<ExecutorOptions["command"]>;
  private readonly emit?: ExecutorOptions["emit"];
  constructor(options: ExecutorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.runCommand = options.command ?? defaultCommand;
    this.emit = options.emit;
  }
  private event(value: ExecutionEvent) { return this.emit?.(value); }
  private validateJob(job: ExecutorJob) {
    if (!job || !job.id || !Array.isArray(job.actions) || !Array.isArray(job.capabilities)) throw Error("invalid agent job");
    if (!job.actions.length) throw Object.assign(Error("deployment plan has no executable actions"), { code: "invalid_plan" });
    if (!safePath(job.target.releaseDirectory) || !UNIT.test(job.target.unit)) throw Error("invalid deployment target");
    if (Date.parse(job.expires_at) <= this.now().getTime()) throw Object.assign(Error("job expired"), { code: "job_expired" });
    const caps = new Set(job.capabilities);
    for (const cap of caps) if (!CAPABILITIES.has(cap)) throw Object.assign(Error("capability denied"), { code: "capability_denied" });
    for (const action of job.actions) {
      if (!action || typeof action !== "object" || !("kind" in action)) throw Error("invalid deployment action");
      const kind = (action as any).kind;
      const needed = kind === "systemd_probe" ? "systemd.probe" : kind === "stage_artifact" ? "artifact.stage" : kind === "activate_release" ? "artifact.activate_release" : kind === "systemd" ? `systemd.${String((action as any).operation).replace(/-/g, "_")}` : kind === "health_check" ? `health.${(action as any).check?.kind === "systemd-active" ? "systemd" : (action as any).check?.kind}` : "";
      if (!needed || !caps.has(needed)) throw Object.assign(Error("capability denied"), { code: "capability_denied" });
    }
    if (job.actions.some((action) => action.kind === "systemd_probe")
      && (job.actions.length !== 1 || caps.size !== 1 || !caps.has("systemd.probe")))
      throw Object.assign(Error("systemd preflight must be an isolated read-only job"), { code: "capability_denied" });
  }
  private async stage(action: Extract<DeploymentAction, { kind: "stage_artifact" }>, target: ExecutorTarget, signal: AbortSignal) {
    if (process.platform !== "linux") throw Object.assign(Error("artifact staging requires Linux directory-relative filesystem operations"), { code: "unsupported_platform" });
    if (!safePath(action.source) || !safePath(action.destination) || !inside(target.releaseDirectory, action.destination)) throw Object.assign(Error("artifact path is outside release directory"), { code: "invalid_target" });
    if (!SHA256.test(action.sha256)) throw Object.assign(Error("artifact digest is invalid"), { code: "invalid_artifact" });
    const source = await openAbsoluteFile(action.source).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw Object.assign(Error("artifact source traverses a symbolic link"), { code: "invalid_artifact" });
      throw error;
    });
    let releaseDirectory: FileHandle | undefined;
    let destinationDirectory: FileHandle | undefined;
    let output: FileHandle | undefined;
    let temporaryCreated = false;
    const fileName = basename(action.source);
    const temporaryName = `${fileName}.partial-${process.pid}-${randomUUID()}`;
    try {
      const info = await source.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024 * 1024) throw Object.assign(Error("artifact source is not a regular file"), { code: "invalid_artifact" });
      const observed = await digestHandle(source, signal);
      if (observed.toLowerCase() !== action.sha256.toLowerCase()) throw Object.assign(Error("artifact digest mismatch"), { code: "digest_mismatch" });

      releaseDirectory = await openAbsoluteDirectory(target.releaseDirectory, true).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw Object.assign(Error("artifact destination traverses a symbolic link"), { code: "invalid_target" });
        throw error;
      });
      const relativeDestination = relative(target.releaseDirectory, action.destination);
      if (relativeDestination === ".." || relativeDestination.startsWith("../") || isAbsolute(relativeDestination)) throw Object.assign(Error("artifact destination is invalid"), { code: "invalid_target" });
      destinationDirectory = await openRelativeDirectory(releaseDirectory, relativeDestination, true).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw Object.assign(Error("artifact destination traverses a symbolic link"), { code: "invalid_target" });
        throw error;
      });

      // Read-back hashing uses this same inode after streaming the copy.
      output = await openFileAt(destinationDirectory, temporaryName, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o640);
      temporaryCreated = true;
      await pipeline(source.createReadStream({ autoClose: false, start: 0 }), output.createWriteStream({ autoClose: false }), { signal });
      const stagedDigest = await digestHandle(output, signal);
      if (stagedDigest.toLowerCase() !== action.sha256.toLowerCase()) throw Object.assign(Error("staged artifact digest mismatch"), { code: "digest_mismatch" });
      await output.sync();
      await output.close();
      output = undefined;
      await renameAt(destinationDirectory, temporaryName, fileName);
      return { staged_path: join(action.destination, fileName), sha256: observed };
    } catch (error) {
      await output?.close().catch(() => {});
      if (temporaryCreated && destinationDirectory) await unlinkAt(destinationDirectory, temporaryName).catch(() => {});
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw Object.assign(Error("artifact destination traverses a symbolic link"), { code: "invalid_target" });
      throw error;
    } finally {
      await source.close().catch(() => {});
      await destinationDirectory?.close().catch(() => {});
      await releaseDirectory?.close().catch(() => {});
    }
  }
  private async activate(action: Extract<DeploymentAction, { kind: "activate_release" }>, target: ExecutorTarget) {
    if (process.platform !== "linux") throw Object.assign(Error("release activation requires Linux directory-relative filesystem operations"), { code: "unsupported_platform" });
    if (!safePath(action.releaseDirectory) || action.releaseDirectory !== target.releaseDirectory || !VERSION.test(action.version)) throw Object.assign(Error("release activation target is invalid"), { code: "invalid_target" });
    let root: FileHandle | undefined;
    let releases: FileHandle | undefined;
    let release: FileHandle | undefined;
    let pointer: FileHandle | undefined;
    const temporaryName = `current.partial-${process.pid}-${randomUUID()}`;
    try {
      root = await openAbsoluteDirectory(target.releaseDirectory, true).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw Object.assign(Error("release directory traverses a symbolic link"), { code: "invalid_target" });
        throw error;
      });
      releases = await openChildDirectory(root, "releases").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw Object.assign(Error("release path traverses a symbolic link"), { code: "invalid_target" });
        throw error;
      });
      release = await openChildDirectory(releases, action.version).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw Object.assign(Error("release path traverses a symbolic link"), { code: "invalid_target" });
        throw error;
      });
      pointer = await openFileAt(root, temporaryName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o640);
      await pointer.writeFile(action.version + "\n", "utf8");
      await pointer.sync();
      await pointer.close();
      pointer = undefined;
      await renameAt(root, temporaryName, "current");
      return { current_version: action.version };
    } catch (error) {
      await pointer?.close().catch(() => {});
      if (root) await unlinkAt(root, temporaryName).catch(() => {});
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(Error("release is not staged"), { code: "artifact_conflict" });
      throw error;
    } finally {
      await release?.close().catch(() => {});
      await releases?.close().catch(() => {});
      await root?.close().catch(() => {});
    }
  }
  private async systemd(action: Extract<DeploymentAction, { kind: "systemd" }>, target: ExecutorTarget, signal: AbortSignal) {
    if (action.unit !== target.unit || !UNIT.test(action.unit)) throw Object.assign(Error("systemd unit is not registered target"), { code: "capability_denied" });
    const operation = action.operation;
    // `daemon-reload` is a manager-wide systemd operation and does not take a
    // unit argument. All other operations remain pinned to the registered
    // unit, so the executor never turns model input into an arbitrary command.
    const args = operation === "daemon-reload" ? [operation] : [operation, action.unit];
    const result = await this.runCommand("systemctl", args, 15000, signal);
    if (result.stderr.trim() && operation !== "daemon-reload") throw Object.assign(Error("systemd operation failed"), { code: "systemd_failed" });
    return { unit: action.unit, operation };
  }
  private async probeSystemd(action: Extract<DeploymentAction, { kind: "systemd_probe" }>, target: ExecutorTarget, signal: AbortSignal) {
    if (action.unit !== target.unit || action.releaseDirectory !== target.releaseDirectory
      || !UNIT.test(action.unit) || !safePath(action.releaseDirectory) || action.releaseDirectory === "/")
      throw Object.assign(Error("systemd probe target is not registered"), { code: "capability_denied" });
    if (!/^[a-f0-9]{32}$/.test(action.preflightID) || !SHA256.test(action.targetRevision))
      throw Object.assign(Error("systemd probe binding is invalid"), { code: "invalid_target" });

    let systemdAvailable = true;
    let loadState = "unknown", activeState = "unknown", unitFileState = "unknown";
    try {
      const result = await this.runCommand("systemctl", [
        "show", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=UnitFileState", action.unit,
      ], 15000, signal);
      if (Buffer.byteLength(result.stdout) > 1024) throw Object.assign(Error("systemd probe response is too large"), { code: "invalid_preflight_result" });
      const properties = new Map<string, string>();
      for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
        const match = /^(LoadState|ActiveState|UnitFileState)=([a-z-]+)$/.exec(line);
        if (!match || properties.has(match[1]!)) throw Object.assign(Error("systemd probe response is invalid"), { code: "invalid_preflight_result" });
        properties.set(match[1]!, match[2]!);
      }
      loadState = properties.get("LoadState") ?? "unknown";
      if (!new Set(["loaded", "not-found", "error", "bad-setting", "merged", "masked", "stub"]).has(loadState))
        throw Object.assign(Error("systemd probe load state is invalid"), { code: "invalid_preflight_result" });
      if (loadState === "loaded") {
        activeState = properties.get("ActiveState") ?? "unknown";
        unitFileState = properties.get("UnitFileState") ?? "unknown";
        if (!new Set(["active", "reloading", "inactive", "failed", "activating", "deactivating", "maintenance", "refreshing"]).has(activeState)
          || !new Set(["enabled", "enabled-runtime", "disabled", "static", "indirect", "masked", "masked-runtime", "linked", "linked-runtime", "alias", "generated", "transient"]).has(unitFileState))
          throw Object.assign(Error("systemd probe properties are incomplete"), { code: "invalid_preflight_result" });
      }
    } catch (error) {
      if ((error as { code?: string }).code === "invalid_preflight_result") throw error;
      if (signal.aborted) throw Object.assign(Error("systemd preflight was cancelled"), { code: "execution_cancelled" });
      if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT" || (error as NodeJS.ErrnoException).code === "ABORT_ERR")
        throw Object.assign(Error("systemd preflight command timed out"), { code: "systemd_failed" });
      systemdAvailable = false;
    }

    let filesystemCheckSupported = process.platform === "linux";
    let releaseDirectoryExists = false, releaseDirectoryWritable = false, currentVersion = "";
    let releaseDirectory: FileHandle | undefined;
    let pointer: FileHandle | undefined;
    try {
      if (process.platform === "linux") {
        releaseDirectory = await openAbsoluteDirectory(action.releaseDirectory);
        const info = await releaseDirectory.stat();
        releaseDirectoryExists = info.isDirectory();
        if (releaseDirectoryExists) {
          await access(descriptorPath(releaseDirectory), constants.W_OK | constants.X_OK);
          releaseDirectoryWritable = true;
          // A FIFO named `current` must not block the single Agent job loop.
          // O_NONBLOCK is harmless for regular files and makes special files
          // observable without waiting for a writer.
          pointer = await openFileAt(releaseDirectory, "current", constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(() => undefined);
          const pointerInfo = await pointer?.stat();
          if (pointer && pointerInfo?.isFile() && pointerInfo.size <= 128) {
            const version = (await pointer.readFile("utf8")).trim();
            if (VERSION.test(version)) currentVersion = version;
          }
        }
      } else filesystemCheckSupported = false;
    } catch {
      // Missing, redirected, unreadable, or unwritable roots are an observation,
      // not an instruction to create or repair anything on the target host.
    } finally {
      await pointer?.close().catch(() => {});
      await releaseDirectory?.close().catch(() => {});
    }
    const unitExists = systemdAvailable && loadState === "loaded";
    const stableActiveStates = new Set(["active", "inactive"]);
    const enabled = unitExists && unitFileState !== "unknown"
      ? ["enabled", "enabled-runtime"].includes(unitFileState) : "unknown";
    const ready = filesystemCheckSupported && systemdAvailable && unitExists && stableActiveStates.has(activeState)
      && !["masked", "masked-runtime"].includes(unitFileState)
      && releaseDirectoryExists && releaseDirectoryWritable;
    return {
      health: { healthy: true },
      preflight: {
        provider: "systemd", ready, systemd_available: systemdAvailable, unit_exists: unitExists,
        active_state: activeState, enabled, unit_file_state: unitFileState, release_directory_exists: releaseDirectoryExists,
        filesystem_check_supported: filesystemCheckSupported,
        release_directory_writable: releaseDirectoryWritable, current_version: currentVersion,
        observed_at: this.now().toISOString(), preflight_id: action.preflightID,
        target_revision: action.targetRevision,
      },
    };
  }
  private async health(check: HealthCheck, target: ExecutorTarget, signal: AbortSignal) {
    if (check.kind === "systemd-active") {
      if (check.unit !== target.unit) throw Object.assign(Error("health unit is not target"), { code: "capability_denied" });
      try { await this.runCommand("systemctl", ["is-active", "--quiet", check.unit], 15000, signal); return { healthy: true }; } catch { return { healthy: false }; }
    }
    if (check.kind === "http") {
      const url = new URL(check.url);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) throw Object.assign(Error("health URL is invalid"), { code: "invalid_target" });
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(check.timeoutMs ?? 5000, 30000))]) });
      await response.body?.cancel();
      return { healthy: response.status === (check.expectedStatus ?? 200), status: response.status };
    }
    if (check.kind === "tcp") {
      if (!Number.isInteger(check.port) || check.port < 1 || check.port > 65535 || !check.host || /[^A-Za-z0-9_.:-]/.test(check.host)) throw Object.assign(Error("health endpoint is invalid"), { code: "invalid_target" });
      return { healthy: await tcpHealth(check.host, check.port, Math.min(check.timeoutMs ?? 5000, 30000), signal) };
    }
    throw Object.assign(Error("health capability denied"), { code: "capability_denied" });
  }
  async execute(job: ExecutorJob, signal: AbortSignal = new AbortController().signal): Promise<ExecutionReceipt> {
    const started = this.now().toISOString();
    try {
      this.validateJob(job);
      await this.event({ phase: "accepted", summary: "Agent accepted the typed deployment job" });
      const snapshot: Record<string, unknown> = {};
      for (const action of job.actions) {
        checkAbort(signal);
        if (Date.parse(job.expires_at) <= this.now().getTime()) throw Object.assign(Error("job expired"), { code: "job_expired" });
        if (action.kind === "stage_artifact") { await this.event({ phase: "staging", summary: "Staging immutable release artifact" }); Object.assign(snapshot, await this.stage(action, job.target, signal)); }
        else if (action.kind === "activate_release") { await this.event({ phase: "activating", summary: "Activating registered release" }); Object.assign(snapshot, await this.activate(action, job.target)); }
        else if (action.kind === "systemd") { await this.event({ phase: "activating", summary: "Applying registered systemd operation" }); Object.assign(snapshot, await this.systemd(action, job.target, signal)); }
        else if (action.kind === "health_check") { await this.event({ phase: "verifying", summary: "Running registered health check" }); const health = await this.health(action.check, job.target, signal); Object.assign(snapshot, { health }); if (!health.healthy) throw Object.assign(Error("health check failed"), { code: "health_check_failed" }); }
        else if (action.kind === "systemd_probe") { await this.event({ phase: "preflighting", summary: "Inspecting registered systemd target" }); Object.assign(snapshot, await this.probeSystemd(action, job.target, signal)); }
      }
      const receipt = { state: "succeeded" as const, summary: "Typed deployment actions completed", snapshot, started_at: started, finished_at: this.now().toISOString() };
      const preflightOnly = job.actions.length === 1 && job.actions[0]?.kind === "systemd_probe";
      await this.event({ phase: "succeeded", summary: receipt.summary, ...(preflightOnly ? {} : { snapshot }) });
      return receipt;
    } catch (error) {
      const e = error as Error & { code?: string };
      const code = signal.aborted ? "execution_cancelled" : e.code ?? "execution_failed";
      const state = code === "unknown_execution_result" || code === "execution_cancelled" ? "unknown" as const : "failed" as const;
      const receipt = { state, code, summary: e.message.slice(0, 1000), snapshot: {}, started_at: started, finished_at: this.now().toISOString() };
      await this.event({ phase: state, code, summary: receipt.summary });
      return receipt;
    }
  }
}
