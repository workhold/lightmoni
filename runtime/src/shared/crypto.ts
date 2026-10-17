import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const id = () => randomBytes(16).toString("hex");
export function masterKey(directory: string): Buffer {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "master.key");
  let master: Buffer;
  try {
    master = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    master = randomBytes(32);
    writeFileSync(path, master, { flag: "wx", mode: 0o600 });
  }
  if (master.length !== 32) throw Error("invalid master key");
  return master;
}
export function cipher(master: Buffer) {
  return {
    encrypt: (value: string) => {
      const nonce = randomBytes(12),
        aes = createCipheriv("aes-256-gcm", master, nonce);
      const ciphertext = Buffer.concat([
        aes.update(value, "utf8"),
        aes.final(),
      ]);
      return Buffer.concat([nonce, ciphertext, aes.getAuthTag()]).toString(
        "base64",
      );
    },
    decrypt: (value: string) => {
      const raw = Buffer.from(value, "base64");
      if (raw.length < 28) throw Error("invalid encrypted value");
      const aes = createDecipheriv("aes-256-gcm", master, raw.subarray(0, 12));
      aes.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([
        aes.update(raw.subarray(12, -16)),
        aes.final(),
      ]).toString("utf8");
    },
  };
}
