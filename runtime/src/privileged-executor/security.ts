import * as fs from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class ExecutorError extends Error {
  constructor(readonly code: string) { super(code); }
}
export const refuse = (code: string): never => { throw new ExecutorError(code); };
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function assertRoot(): void {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
    refuse("executor_requires_linux_root");
}

/** Validate every ancestor. Root tasks never load code, keys or intent from an
 * Agent-owned path, even when the final file happens to be root owned. */
export function rootPath(filename: string, kind: "file" | "directory" | "socket" = "file", secret = false): string {
  if (!isAbsolute(filename) || resolve(filename) !== filename || filename.includes("\0")) refuse("unsafe_path");
  let cursor = filename;
  for (;;) {
    const info = fs.lstatSync(cursor);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) refuse("unsafe_root_path");
    if (cursor === filename) {
      if (kind === "file" && !info.isFile() || kind === "directory" && !info.isDirectory() || kind === "socket" && !info.isSocket()) refuse("unsafe_root_path");
      if (secret && (info.mode & 0o077) !== 0) refuse("unsafe_secret_mode");
    }
    if (cursor === "/") break;
    cursor = dirname(cursor);
  }
  return filename;
}

export function boundedFile(filename: string, limit: number, secret = false): Buffer {
  rootPath(filename, "file", secret);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || info.size > limit || (info.mode & 0o022) !== 0 || secret && (info.mode & 0o077) !== 0) refuse("unsafe_file");
    const bytes = fs.readFileSync(fd);
    if (bytes.length > limit) refuse("file_too_large");
    return bytes;
  } finally { fs.closeSync(fd); }
}

export function secureDirectory(filename: string): void {
  const parent = dirname(filename);
  rootPath(parent, "directory");
  try { fs.mkdirSync(filename, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  rootPath(filename, "directory", true);
}

/** No best-effort fsync: a write failure must stop before any side effect. */
export function durableWrite(filename: string, value: string | Uint8Array, mode = 0o600): void {
  const parent = dirname(filename);
  const temporary = filename + ".new-" + process.pid + "-" + randomUUID();
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    fs.fchmodSync(fd, mode); fs.writeFileSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
    const directory = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export interface BootClock { bootID(): string; now(): number }
export const linuxBootClock: BootClock = {
  bootID() {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[a-f0-9-]{36}$/.test(value)) refuse("unreliable_clock");
    return value;
  },
  now() {
    // /proc/uptime includes suspend; unlike wall time it cannot roll backwards.
    const seconds = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ", 1)[0]);
    if (!Number.isFinite(seconds) || seconds < 0) refuse("unreliable_clock");
    return seconds * 1000;
  },
};

export class StartDeadline {
  private readonly boot: string;
  private readonly began: number;
  private last: number;
  private deadline: number;
  constructor(private readonly clock: BootClock, windowMS = 30_000) {
    if (!Number.isFinite(windowMS) || windowMS <= 0 || windowMS > 30_000) refuse("invalid_permit_window");
    this.boot = clock.bootID(); this.began = clock.now(); this.last = this.began; this.deadline = this.began + windowMS;
    if (!this.boot || !Number.isFinite(this.began) || this.began < 0) refuse("unreliable_clock");
  }
  shorten(remainingMS: number): void {
    if (!Number.isFinite(remainingMS) || remainingMS <= 0 || remainingMS > 30_000) refuse("expired_permit");
    this.assert(); this.deadline = Math.min(this.deadline, this.last + remainingMS);
  }
  assert(): void {
    const now = this.clock.now();
    if (!Number.isFinite(now) || this.clock.bootID() !== this.boot || now < this.last || now >= this.deadline) refuse("expired_permit");
    this.last = now;
  }
  snapshot(): { boot_id: string; expires_uptime_ms: number } {
    this.assert(); return { boot_id: this.boot, expires_uptime_ms: this.deadline };
  }
}
