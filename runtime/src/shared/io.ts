import {
  openSync,
  closeSync,
  writeFileSync,
  renameSync,
  fsyncSync,
  mkdirSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
export function atomicWrite(
  path: string,
  value: string | Uint8Array,
  mode = 0o600,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp-" + randomBytes(8).toString("hex");
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", mode);
    writeFileSync(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}
export function readJSON<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}
export function atomicJSON(path: string, value: any): void {
  atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
}
export function id(): string {
  return randomBytes(16).toString("hex");
}
