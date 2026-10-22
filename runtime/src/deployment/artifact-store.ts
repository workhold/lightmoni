import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export const MAX_RELEASE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;

export class ReleaseArtifactError extends Error {
  constructor(readonly code: "invalid_artifact" | "digest_mismatch" | "artifact_too_large" | "artifact_io") {
    super(code);
  }
}

export interface StoredReleaseArtifact {
  /** Internal storage path. Never return this value in an API response. */
  path: string;
  sha256: string;
  size: number;
}

/** Private immutable content-addressed storage for uploaded service releases. */
export class ReleaseArtifactStore {
  constructor(readonly directory: string) {}

  private contentPath(sha256: string) {
    if (!SHA256.test(sha256)) throw new ReleaseArtifactError("invalid_artifact");
    const digest = sha256.toLowerCase();
    return join(this.directory, "sha256", digest.slice(0, 2), digest);
  }

  private async ensureDirectory(path: string) {
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReleaseArtifactError("artifact_io");
    await chmod(path, 0o700);
  }

  private async ensureContentDirectory(path: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await lstat(this.directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new ReleaseArtifactError("artifact_io");
    await chmod(this.directory, 0o700);
    await this.ensureDirectory(join(this.directory, "sha256"));
    await this.ensureDirectory(path);
  }

  async put(
    source: AsyncIterable<Uint8Array>,
    options: { contentLength: number; expectedSha256: string; signal?: AbortSignal },
  ): Promise<StoredReleaseArtifact> {
    const { contentLength, expectedSha256, signal } = options;
    if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > MAX_RELEASE_ARTIFACT_BYTES)
      throw new ReleaseArtifactError("artifact_too_large");
    if (!SHA256.test(expectedSha256)) throw new ReleaseArtifactError("invalid_artifact");

    const destination = this.contentPath(expectedSha256);
    const directory = dirname(destination);
    await this.ensureContentDirectory(directory);
    const temporary = join(directory, `.upload-${randomUUID()}.partial`);
    let file;
    let created = false;
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      file = await open(temporary, "wx", 0o600);
      created = true;
      for await (const input of source) {
        if (signal?.aborted) throw signal.reason ?? new Error("upload aborted");
        const chunk = Buffer.from(input);
        bytes += chunk.length;
        if (bytes > contentLength || bytes > MAX_RELEASE_ARTIFACT_BYTES)
          throw new ReleaseArtifactError("artifact_too_large");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await file.write(chunk, offset, chunk.length - offset, null);
          if (!result.bytesWritten) throw new ReleaseArtifactError("artifact_io");
          offset += result.bytesWritten;
        }
      }
      if (bytes !== contentLength) throw new ReleaseArtifactError("invalid_artifact");
      const actual = hash.digest("hex");
      if (actual !== expectedSha256.toLowerCase()) throw new ReleaseArtifactError("digest_mismatch");
      await file.sync();
      await file.close();
      file = undefined;

      // link() is create-if-absent on the same filesystem. Unlike rename(), it
      // cannot replace an existing immutable object during a concurrent upload.
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.inspect(actual);
        if (!existing || existing.size !== bytes) throw new ReleaseArtifactError("artifact_io");
      }
      await unlink(temporary);
      created = false;
      return { path: destination, sha256: actual, size: bytes };
    } catch (error) {
      if (file) await file.close().catch(() => {});
      if (created) await unlink(temporary).catch(() => {});
      if (error instanceof ReleaseArtifactError) throw error;
      throw new ReleaseArtifactError("artifact_io");
    }
  }

  async inspect(sha256: string): Promise<StoredReleaseArtifact | undefined> {
    if (!SHA256.test(sha256)) return undefined;
    const digest = sha256.toLowerCase();
    let path = this.contentPath(digest);
    let file;
    try {
      // Walk each ancestor before opening the digest file. Storage roots and
      // their parents must not be replaceable by an untrusted local user.
      const absoluteDirectory = await realpath(resolve(this.directory));
      path = join(absoluteDirectory, "sha256", digest.slice(0, 2), digest);
      const root = parse(absoluteDirectory).root;
      let current = root;
      const directories = absoluteDirectory.slice(root.length).split(/[\\/]/).filter(Boolean).map((part) => current = join(current, part));
      directories.push(
        join(absoluteDirectory, "sha256"),
        join(absoluteDirectory, "sha256", digest.slice(0, 2)),
      );
      const trustedUIDs = new Set([0, process.geteuid?.() ?? -1]);
      for (const directory of directories) {
        const info = await lstat(directory);
        const stickyRootDirectory = info.uid === 0 && (info.mode & 0o1000) !== 0;
        if (!info.isDirectory() || info.isSymbolicLink() || !trustedUIDs.has(info.uid)
          || (!stickyRootDirectory && (info.mode & 0o022) !== 0)) return undefined;
      }
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > MAX_RELEASE_ARTIFACT_BYTES)
        return undefined;
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
      if (hash.digest("hex") !== digest) return undefined;
      return { path, sha256: digest, size: info.size };
    } catch {
      return undefined;
    } finally {
      await file?.close().catch(() => {});
    }
  }

  /** Remove an object that failed bundle validation before it was referenced by a release. */
  async discard(sha256: string): Promise<void> {
    const path = this.contentPath(sha256);
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ReleaseArtifactError("artifact_io");
    }
  }
}
