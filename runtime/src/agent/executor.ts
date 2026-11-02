import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { access, lstat, mkdir, readlink, readdir, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize, parse } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { connect as connectTCP } from "node:net";
import type { DeploymentAction, HealthCheck } from "../deployment/types.js";
import { assertReleaseBundleHasNoCredentials, parseReleaseBundle } from "../deployment/release-bundle.js";

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SERVICE_ID = /^[a-f0-9]{32}$/i;
const ARTIFACT_ARCHITECTURES = new Set(["any", "linux-amd64", "linux-arm64"]);
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
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
  downloadArtifact?: (action: Extract<DeploymentAction, { kind: "stage_artifact" }>, signal: AbortSignal) => Promise<Buffer>;
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
const groupCanWrite = (info: { gid: number }) => {
  const groups = new Set([process.getgid?.(), process.getegid?.(), ...(process.getgroups?.() ?? [])].filter((value): value is number => typeof value === "number"));
  return groups.has(info.gid);
};
const openAbsoluteDirectory = async (path: string, create = false, protectReleaseRoot = false): Promise<FileHandle> => {
  if (process.platform !== "linux") throw Object.assign(Error("secure deployment filesystem operations require Linux"), { code: "unsupported_platform" });
  const root = parse(path).root;
  let current = await openDirectory(root);
  try {
    const components = path.slice(root.length).split(/[\\/]/).filter(Boolean);
    for (const [index, component] of components.entries()) {
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
      if (protectReleaseRoot) {
        const info = await next.stat();
        const uid = process.geteuid?.() ?? 0;
        const agentPrimaryGid = process.getegid?.() ?? process.getgid?.() ?? -1;
        const ownerTrusted = info.uid === 0 || info.uid === uid;
        const groupWritable = (info.mode & 0o020) !== 0;
        const otherWritable = (info.mode & 0o002) !== 0;
        const otherReadableTraversable = (info.mode & 0o005) === 0o005;
        const groupWriteTrusted = !groupWritable || groupCanWrite(info);
        const isReleaseRoot = index === components.length - 1;
        const safeStickyAncestor = !isReleaseRoot && (info.mode & 0o1000) !== 0 && ownerTrusted;
        const protectedDirectory = isReleaseRoot
          ? uid === 0 ? info.uid === 0 && (info.mode & 0o022) === 0 : info.uid === 0 && info.gid === agentPrimaryGid && groupWritable && groupCanWrite(info) && !otherWritable && otherReadableTraversable
          : ownerTrusted && ((!otherWritable && groupWriteTrusted) || safeStickyAncestor);
        if (!info.isDirectory() || !protectedDirectory) {
          await next.close().catch(() => {});
          throw Object.assign(Error("release directory or an ancestor has unsafe ownership or permissions"), { code: "invalid_target" });
        }
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
const openFileAt = (directory: FileHandle, name: string, flags: number, mode?: number) => {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw Error("invalid file component");
  return open(join(descriptorPath(directory), name), flags | NOFOLLOW, mode);
};
const renameAt = (directory: FileHandle, from: string, to: string) => rename(
  join(descriptorPath(directory), from), join(descriptorPath(directory), to),
);
const unlinkAt = (directory: FileHandle, name: string) => unlink(join(descriptorPath(directory), name));
const mkdirAt = (directory: FileHandle, name: string, mode: number) => mkdir(join(descriptorPath(directory), name), { mode });
const rmdirAt = (directory: FileHandle, name: string) => rmdir(join(descriptorPath(directory), name));
const statAt = (directory: FileHandle, name: string) => lstat(join(descriptorPath(directory), name));
const readlinkAt = (directory: FileHandle, name: string) => readlink(join(descriptorPath(directory), name));
const symlinkAt = (directory: FileHandle, target: string, name: string) => symlink(target, join(descriptorPath(directory), name));
const exactKeys = (value: object, keys: string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const execStartMatches = (serialized: string, expectedPath: string): boolean => {
  // `systemctl show` renders one ExecStart command as a single brace-delimited
  // object. Requiring that shape and exactly one path/argv field fails closed
  // for multiple commands, drop-ins, missing properties, and escaped paths.
  const match = /^\{\s*([^{}]*)\s*\}$/.exec(serialized.trim());
  if (!match) return false;
  const fields = match[1]!.split(";").map((field) => field.trim()).filter(Boolean);
  const paths = fields.filter((field) => field.startsWith("path=")).map((field) => field.slice("path=".length));
  const argv = fields.filter((field) => field.startsWith("argv[]=")).map((field) => field.slice("argv[]=".length).trim());
  if (paths.length !== 1 || argv.length !== 1 || paths[0] !== expectedPath || !argv[0]) return false;
  // The serialized argv[] value may include later arguments. Either it is the
  // exact executable or it starts with that exact executable plus the argument
  // separator; quoted/escaped forms are rejected rather than guessed.
  return argv[0] === expectedPath || argv[0]!.startsWith(`${expectedPath} `);
};
const currentVersionAt = async (root: FileHandle): Promise<string> => {
  let info;
  try { info = await statAt(root, "current"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  if (!info.isSymbolicLink()) throw Object.assign(Error("current is not a release symlink"), { code: "artifact_conflict" });
  const target = await readlinkAt(root, "current");
  const match = /^releases\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(target);
  if (!match) throw Object.assign(Error("current release symlink is invalid"), { code: "artifact_conflict" });
  let releases: FileHandle | undefined;
  let release: FileHandle | undefined;
  try {
    releases = await openChildDirectory(root, "releases");
    const releasesInfo = await releases.stat();
    if (releasesInfo.uid !== (process.geteuid?.() ?? 0) || (releasesInfo.mode & 0o022) !== 0)
      throw Object.assign(Error("release storage directory has unsafe ownership or permissions"), { code: "artifact_conflict" });
    release = await openChildDirectory(releases, match[1]!);
    const releaseInfo = await release.stat();
    if (releaseInfo.uid !== (process.geteuid?.() ?? 0) || (releaseInfo.mode & 0o022) !== 0)
      throw Object.assign(Error("published release directory has unsafe ownership or permissions"), { code: "artifact_conflict" });
  } catch {
    throw Object.assign(Error("current release target is missing or unsafe"), { code: "artifact_conflict" });
  } finally {
    await release?.close().catch(() => {});
    await releases?.close().catch(() => {});
  }
  return match[1]!;
};

/** Remove a private temporary release using directory descriptors only. */
const removeTreeAt = async (parent: FileHandle, name: string): Promise<void> => {
  let directory: FileHandle;
  try { directory = await openChildDirectory(parent, name); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // A replaced symlink or non-directory is unlinked as an entry; it is never followed.
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      await unlinkAt(parent, name).catch(() => {});
      return;
    }
    throw error;
  }
  try {
    await directory.chmod(0o700).catch(() => {});
    for (const child of await readdir(descriptorPath(directory))) {
      let info;
      try { info = await statAt(directory, child); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await removeTreeAt(directory, child);
        await rmdirAt(directory, child).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      } else await unlinkAt(directory, child).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  } finally {
    await directory.close().catch(() => {});
  }
  await rmdirAt(parent, name).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
};
const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? Error("execution cancelled");
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
  private readonly downloadArtifact?: ExecutorOptions["downloadArtifact"];
  private readonly emit?: ExecutorOptions["emit"];
  constructor(options: ExecutorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.runCommand = options.command ?? defaultCommand;
    this.downloadArtifact = options.downloadArtifact;
    this.emit = options.emit;
  }
  private event(value: ExecutionEvent) { return this.emit?.(value); }
  private validateJob(job: ExecutorJob) {
    if (!job || !job.id || !Array.isArray(job.actions) || !Array.isArray(job.capabilities)) throw Error("invalid agent job");
    if (!job.actions.length) throw Object.assign(Error("deployment plan has no executable actions"), { code: "invalid_plan" });
    if (!safePath(job.target.releaseDirectory) || job.target.releaseDirectory === "/" || !UNIT.test(job.target.unit)) throw Error("invalid deployment target");
    if (Date.parse(job.expires_at) <= this.now().getTime()) throw Object.assign(Error("job expired"), { code: "job_expired" });
    const caps = new Set(job.capabilities);
    for (const cap of caps) if (!CAPABILITIES.has(cap)) throw Object.assign(Error("capability denied"), { code: "capability_denied" });
    for (const action of job.actions) {
      if (!action || typeof action !== "object" || !("kind" in action)) throw Error("invalid deployment action");
      const kind = (action as any).kind;
      if (kind === "stage_artifact") {
        const artifactAction = action as Extract<DeploymentAction, { kind: "stage_artifact" }>;
        if (!exactKeys(artifactAction, ["kind", "release_id", "service_id", "version", "architecture", "destination", "sha256", "size"])
          || typeof artifactAction.release_id !== "string" || !RELEASE_ID.test(artifactAction.release_id)
          || typeof artifactAction.service_id !== "string" || !SERVICE_ID.test(artifactAction.service_id)
          || typeof artifactAction.version !== "string" || !VERSION.test(artifactAction.version)
          || typeof artifactAction.architecture !== "string" || !ARTIFACT_ARCHITECTURES.has(artifactAction.architecture)
          || artifactAction.destination !== `releases/${artifactAction.version}`
          || typeof artifactAction.sha256 !== "string" || !SHA256.test(artifactAction.sha256)
          || !Number.isSafeInteger(artifactAction.size) || artifactAction.size < 1 || artifactAction.size > MAX_ARTIFACT_BYTES)
          throw Object.assign(Error("artifact action is invalid"), { code: "invalid_artifact" });
      } else if (kind === "activate_release") {
        const activationAction = action as Extract<DeploymentAction, { kind: "activate_release" }>;
        if (!exactKeys(activationAction, ["kind", "releaseDirectory", "version", "expectedCurrentVersion"])
          || typeof activationAction.releaseDirectory !== "string" || activationAction.releaseDirectory !== job.target.releaseDirectory
          || typeof activationAction.version !== "string" || !VERSION.test(activationAction.version)
          || typeof activationAction.expectedCurrentVersion !== "string"
          || (activationAction.expectedCurrentVersion !== "" && !VERSION.test(activationAction.expectedCurrentVersion)))
          throw Object.assign(Error("release activation action is invalid"), { code: "invalid_target" });
      }
      const needed = kind === "systemd_probe" ? "systemd.probe" : kind === "stage_artifact" ? "artifact.stage" : kind === "activate_release" ? "artifact.activate_release" : kind === "systemd" ? `systemd.${String((action as any).operation).replace(/-/g, "_")}` : kind === "health_check" ? `health.${(action as any).check?.kind === "systemd-active" ? "systemd" : (action as any).check?.kind}` : "";
      if (!needed || !caps.has(needed)) throw Object.assign(Error("capability denied"), { code: "capability_denied" });
    }
    if (job.actions.some((action) => action.kind === "systemd_probe")
      && (job.actions.length !== 1 || caps.size !== 1 || !caps.has("systemd.probe")))
      throw Object.assign(Error("systemd preflight must be an isolated read-only job"), { code: "capability_denied" });
  }
  private async stage(action: Extract<DeploymentAction, { kind: "stage_artifact" }>, target: ExecutorTarget, signal: AbortSignal) {
    if (process.platform !== "linux") throw Object.assign(Error("artifact staging requires Linux directory-relative filesystem operations"), { code: "unsupported_platform" });
    if (!this.downloadArtifact) throw Object.assign(Error("private artifact download is unavailable"), { code: "artifact_unavailable" });
    if (!safePath(target.releaseDirectory) || action.destination !== `releases/${action.version}`)
      throw Object.assign(Error("artifact destination is invalid"), { code: "invalid_target" });
    if (!SHA256.test(action.sha256) || !Number.isSafeInteger(action.size) || action.size < 1 || action.size > MAX_ARTIFACT_BYTES)
      throw Object.assign(Error("artifact metadata is invalid"), { code: "invalid_artifact" });
    const bytes = await this.downloadArtifact(action, signal);
    checkAbort(signal);
    if (!Buffer.isBuffer(bytes) || bytes.length !== action.size) throw Object.assign(Error("artifact size mismatch"), { code: "size_mismatch" });
    if (createHash("sha256").update(bytes).digest("hex") !== action.sha256.toLowerCase()) throw Object.assign(Error("artifact digest mismatch"), { code: "digest_mismatch" });
    let bundle;
    try { bundle = parseReleaseBundle(bytes); }
    catch { throw Object.assign(Error("release bundle failed validation"), { code: "invalid_artifact" }); }
    try { assertReleaseBundleHasNoCredentials(bundle); }
    catch { throw Object.assign(Error("release bundle contains private credential material"), { code: "invalid_artifact" }); }
    const hostArchitecture = process.arch === "x64" ? "linux-amd64" : process.arch === "arm64" ? "linux-arm64" : "unsupported";
    if (bundle.manifest.service_id.toLowerCase() !== action.service_id.toLowerCase()
      || bundle.manifest.version !== action.version
      || bundle.manifest.architecture !== action.architecture
      || (action.architecture !== "any" && action.architecture !== hostArchitecture))
      throw Object.assign(Error("release manifest does not match the approved service, version, or architecture"), { code: "invalid_artifact" });

    let releaseRoot: FileHandle | undefined;
    let releases: FileHandle | undefined;
    let temporaryRelease: FileHandle | undefined;
    let publishedRelease: FileHandle | undefined;
    let lock: FileHandle | undefined;
    let temporaryCreated = false;
    let published = false;
    let lockCreated = false;
    const temporaryName = `.stage-${action.version}-${process.pid}-${randomUUID()}`;
    const lockName = `.stage-${action.version}.lock`;
    try {
      releaseRoot = await openAbsoluteDirectory(target.releaseDirectory, false, true).catch((error) => {
        if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw Object.assign(Error("release directory traverses a symbolic link"), { code: "invalid_target" });
        throw error;
      });
      releases = await openChildDirectory(releaseRoot, "releases", true).catch((error) => {
        if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw Object.assign(Error("release path traverses a symbolic link"), { code: "invalid_target" });
        throw error;
      });
      lock = await openFileAt(releases, lockName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(Error("release staging is already in progress"), { code: "artifact_conflict" });
        throw error;
      });
      lockCreated = true;
      await lock.sync();
      // A version is immutable: never replace an existing release, even if it
      // is an empty directory left by an earlier interrupted attempt.
      try {
        await statAt(releases, action.version);
        throw Object.assign(Error("release version already exists"), { code: "artifact_conflict" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdirAt(releases, temporaryName, 0o700);
      temporaryCreated = true;
      temporaryRelease = await openChildDirectory(releases, temporaryName);

      const directories = new Set<string>(bundle.directories);
      for (const entry of bundle.files) {
        checkAbort(signal);
        const components = entry.path.split("/");
        const parentPath = components.slice(0, -1).join("/");
        for (let index = 1; index < components.length; index++) directories.add(components.slice(0, index).join("/"));
        if (parentPath) await openRelativeDirectory(temporaryRelease, parentPath, true).then((parent) => parent.close());
        const parent = parentPath ? await openRelativeDirectory(temporaryRelease, parentPath) : await duplicateDirectory(temporaryRelease);
        try {
          const output = await openFileAt(parent, components.at(-1)!, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
          try {
            await output.writeFile(entry.content);
            await output.sync();
          } finally { await output.close(); }
        } finally { await parent.close(); }
      }
      // Create explicit empty directories while the whole temporary tree is
      // still private to the Agent. It remains 0700/0600 until after publish.
      for (const directory of [...directories].sort((a, b) => a.split("/").length - b.split("/").length)) {
        await openRelativeDirectory(temporaryRelease, directory, true).then((handle) => handle.close());
      }
      await temporaryRelease.sync();
      await temporaryRelease.close();
      temporaryRelease = undefined;
      checkAbort(signal);
      // Serialize Agent-side writers and publish with one same-filesystem
      // rename. A pre-existing version is never overwritten.
      await renameAt(releases, temporaryName, action.version);
      temporaryCreated = false;
      published = true;
      publishedRelease = await openChildDirectory(releases, action.version);
      // The service may run under a different User/Group from the Agent. Code
      // and configuration inside the immutable release are therefore
      // read/traverse-only for host users, while the Agent retains write access
      // only through its registered releases parent. Runtime secrets must not
      // be included in a release bundle.
      for (const entry of bundle.files) {
        const components = entry.path.split("/");
        const parentPath = components.slice(0, -1).join("/");
        const parent = parentPath ? await openRelativeDirectory(publishedRelease, parentPath) : await duplicateDirectory(publishedRelease);
        try {
          const file = await openFileAt(parent, components.at(-1)!, constants.O_RDONLY);
          try { await file.chmod((entry.mode & 0o111) !== 0 ? 0o555 : 0o444); }
          finally { await file.close(); }
        } finally { await parent.close(); }
      }
      for (const directory of [...directories].sort((a, b) => b.split("/").length - a.split("/").length)) {
        const handle = await openRelativeDirectory(publishedRelease, directory);
        try { await handle.chmod(0o555); } finally { await handle.close(); }
      }
      await publishedRelease.chmod(0o555);
      await publishedRelease.sync();
      if (((await releases.stat()).mode & 0o001) === 0) await releases.chmod(0o711);
      await releases.sync().catch(() => {});
      await publishedRelease.close();
      publishedRelease = undefined;
      await lock.close();
      lock = undefined;
      await unlinkAt(releases, lockName).catch(() => {});
      lockCreated = false;
      return { release_id: action.release_id, staged_version: action.version, staged_path: action.destination, sha256: action.sha256.toLowerCase(), size: action.size };
    } catch (error) {
      await temporaryRelease?.close().catch(() => {});
      if (temporaryCreated && releases) await removeTreeAt(releases, temporaryName).catch(() => {});
      await publishedRelease?.close().catch(() => {});
      if (published && releases) await removeTreeAt(releases, action.version).catch(() => {});
      await lock?.close().catch(() => {});
      if (lockCreated && releases) await unlinkAt(releases, lockName).catch(() => {});
      if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw Object.assign(Error("artifact destination traverses a symbolic link"), { code: "invalid_target" });
      throw error;
    } finally {
      await releaseRoot?.close().catch(() => {});
      await releases?.close().catch(() => {});
    }
  }
  private async activate(action: Extract<DeploymentAction, { kind: "activate_release" }>, target: ExecutorTarget) {
    if (process.platform !== "linux") throw Object.assign(Error("release activation requires Linux directory-relative filesystem operations"), { code: "unsupported_platform" });
    if (!safePath(action.releaseDirectory) || action.releaseDirectory !== target.releaseDirectory || !VERSION.test(action.version)
      || (action.expectedCurrentVersion !== "" && !VERSION.test(action.expectedCurrentVersion))) throw Object.assign(Error("release activation target is invalid"), { code: "invalid_target" });
    let root: FileHandle | undefined;
    let releases: FileHandle | undefined;
    let release: FileHandle | undefined;
    let runFile: FileHandle | undefined;
    let activationLock: FileHandle | undefined;
    let lockCreated = false;
    let temporaryLinkCreated = false;
    const temporaryName = `current.partial-${process.pid}-${randomUUID()}`;
    const lockName = ".current.activation.lock";
    try {
      root = await openAbsoluteDirectory(target.releaseDirectory, false, true).catch((error) => {
        if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw Object.assign(Error("release directory traverses a symbolic link"), { code: "invalid_target" });
        throw error;
      });
      releases = await openChildDirectory(root, "releases").catch((error) => {
        if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw Object.assign(Error("release path traverses a symbolic link"), { code: "invalid_target" });
        throw error;
      });
      const releasesInfo = await releases.stat();
      if (releasesInfo.uid !== (process.geteuid?.() ?? 0) || (releasesInfo.mode & 0o022) !== 0)
        throw Object.assign(Error("release storage directory has unsafe ownership or permissions"), { code: "invalid_target" });
      release = await openChildDirectory(releases, action.version).catch((error) => {
        if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw Object.assign(Error("release path traverses a symbolic link"), { code: "invalid_target" });
        throw error;
      });
      const releaseInfo = await release.stat();
      if (releaseInfo.uid !== (process.geteuid?.() ?? 0) || (releaseInfo.mode & 0o022) !== 0)
        throw Object.assign(Error("staged release directory has unsafe ownership or permissions"), { code: "artifact_conflict" });
      runFile = await openFileAt(release, "run", constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      const runInfo = await runFile.stat();
      if (!runInfo.isFile() || (runInfo.mode & 0o111) === 0)
        throw Object.assign(Error("staged release entrypoint is not executable"), { code: "artifact_conflict" });
      await runFile.close();
      runFile = undefined;

      // This lock serializes all Agent activation jobs for the service root.
      // A crash leaves it behind and safely blocks a retry until operator
      // inspection, instead of allowing two activations to interleave.
      activationLock = await openFileAt(root, lockName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(Error("release activation is already in progress"), { code: "artifact_conflict" });
        throw error;
      });
      lockCreated = true;
      await activationLock.sync();
      const observedCurrentVersion = await currentVersionAt(root);
      if (observedCurrentVersion !== action.expectedCurrentVersion)
        throw Object.assign(Error("current release changed after the deployment plan was approved"), { code: "artifact_conflict" });
      await symlinkAt(root, `releases/${action.version}`, temporaryName);
      temporaryLinkCreated = true;
      await renameAt(root, temporaryName, "current");
      temporaryLinkCreated = false;
      await root.sync().catch(() => {});
      await activationLock.close();
      activationLock = undefined;
      await unlinkAt(root, lockName).catch(() => {});
      lockCreated = false;
      return { previous_version: observedCurrentVersion, current_version: action.version };
    } catch (error) {
      await runFile?.close().catch(() => {});
      if (activationLock) await activationLock.close().catch(() => {});
      if (temporaryLinkCreated && root) await unlinkAt(root, temporaryName).catch(() => {});
      if (lockCreated && root) await unlinkAt(root, lockName).catch(() => {});
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
    let loadState = "unknown", activeState = "unknown", unitFileState = "unknown", execStart = "";
    try {
      const result = await this.runCommand("systemctl", [
        "show", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=UnitFileState", "--property=ExecStart", action.unit,
      ], 15000, signal);
      if (Buffer.byteLength(result.stdout) > 1024) throw Object.assign(Error("systemd probe response is too large"), { code: "invalid_preflight_result" });
      const properties = new Map<string, string>();
      for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
        const match = /^(LoadState|ActiveState|UnitFileState|ExecStart)=(.*)$/.exec(line);
        if (!match || properties.has(match[1]!)) throw Object.assign(Error("systemd probe response is invalid"), { code: "invalid_preflight_result" });
        properties.set(match[1]!, match[2]!);
      }
      loadState = properties.get("LoadState") ?? "unknown";
      if (!new Set(["loaded", "not-found", "error", "bad-setting", "merged", "masked", "stub"]).has(loadState))
        throw Object.assign(Error("systemd probe load state is invalid"), { code: "invalid_preflight_result" });
      if (loadState === "loaded") {
        activeState = properties.get("ActiveState") ?? "unknown";
        unitFileState = properties.get("UnitFileState") ?? "unknown";
        execStart = properties.get("ExecStart") ?? "";
        if (!new Set(["active", "reloading", "inactive", "failed", "activating", "deactivating", "maintenance", "refreshing"]).has(activeState)
          || !new Set(["enabled", "enabled-runtime", "disabled", "static", "indirect", "masked", "masked-runtime", "linked", "linked-runtime", "alias", "generated", "transient"]).has(unitFileState)
          || !properties.has("ExecStart"))
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
    let releaseDirectoryExists = false, releaseDirectoryWritable = false, currentPointerValid = false, currentVersion = "";
    let releaseDirectory: FileHandle | undefined;
    try {
      if (process.platform === "linux") {
        releaseDirectory = await openAbsoluteDirectory(action.releaseDirectory, false, true);
        const info = await releaseDirectory.stat();
        releaseDirectoryExists = info.isDirectory();
        if (releaseDirectoryExists) {
          await access(descriptorPath(releaseDirectory), constants.W_OK | constants.X_OK);
          releaseDirectoryWritable = true;
          try {
            currentVersion = await currentVersionAt(releaseDirectory);
            currentPointerValid = true;
          } catch { currentPointerValid = false; }
        }
      } else filesystemCheckSupported = false;
    } catch {
      // Missing, redirected, unreadable, or unwritable roots are an observation,
      // not an instruction to create or repair anything on the target host.
    } finally {
      await releaseDirectory?.close().catch(() => {});
    }
    const unitExists = systemdAvailable && loadState === "loaded";
    const expectedEntrypoint = join(action.releaseDirectory, "current", "run");
    const entrypointMatches = unitExists && execStartMatches(execStart, expectedEntrypoint);
    const stableActiveStates = new Set(["active", "inactive"]);
    const enabled = unitExists && unitFileState !== "unknown"
      ? ["enabled", "enabled-runtime"].includes(unitFileState) : "unknown";
    const ready = filesystemCheckSupported && systemdAvailable && unitExists && stableActiveStates.has(activeState)
      && !["masked", "masked-runtime"].includes(unitFileState)
      && releaseDirectoryExists && releaseDirectoryWritable && currentPointerValid && entrypointMatches;
    return {
      health: { healthy: true },
      preflight: {
        provider: "systemd", ready, systemd_available: systemdAvailable, unit_exists: unitExists,
        active_state: activeState, enabled, unit_file_state: unitFileState, release_directory_exists: releaseDirectoryExists,
        filesystem_check_supported: filesystemCheckSupported,
        release_directory_writable: releaseDirectoryWritable, current_version: currentVersion,
        entrypoint_matches: entrypointMatches, current_pointer_valid: currentPointerValid,
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
